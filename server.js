const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const ROOT_DIR = __dirname;
const PUBLIC_DIR = path.join(ROOT_DIR, "public");
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT_DIR, "data");
const STORE_FILE = path.join(DATA_DIR, "questions.json");
const DEFAULT_DURATION_MS = 5 * 60 * 1000;
const ROUND_COUNT = 3;
const MAX_BODY_BYTES = 1024 * 1024;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
  ".ico": "image/x-icon"
};

const stored = loadStore();
let sourceQuestions = stored.sourceQuestions;
let rounds = createRoundStates(stored.roundQuestions || distributeQuestions(sourceQuestions));
let activeRoundIndex = 0;
let controllerEverConnected = false;
let timeUpSeq = 0;

const clients = new Set();

const server = http.createServer((req, res) => {
  route(req, res).catch((error) => {
    console.error(error);
    sendJson(res, 500, { error: "server_error" });
  });
});

server.listen(PORT, HOST, () => {
  const urls = getLanUrls();
  console.log(`Ready on http://127.0.0.1:${PORT}`);
  for (const url of urls) {
    console.log(`LAN display: ${url.displayUrl}`);
    console.log(`LAN control: ${url.controlUrl}`);
  }
});

setInterval(() => {
  const changed = refreshTimer(activeRound());
  if (activeRound().timer.status === "running" || changed) {
    broadcastState();
  }
}, 500);

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (req.method === "GET" && url.pathname === "/") {
    return servePublicFile(res, "index.html");
  }

  if (req.method === "GET" && url.pathname === "/control") {
    markControllerSeen();
    return servePublicFile(res, "control.html");
  }

  if (req.method === "GET" && url.pathname === "/events") {
    return openEventStream(req, res, url.searchParams.get("role") || "display");
  }

  if (req.method === "GET" && url.pathname === "/api/state") {
    return sendJson(res, 200, getPublicState(req));
  }

  if (req.method === "POST" && url.pathname === "/api/questions") {
    const body = await readJson(req);
    buildQuestionRounds(normalizeQuestions(body.questions ?? body.text ?? ""));
    broadcastState();
    return sendJson(res, 200, getPublicState(req));
  }

  if (req.method === "POST" && url.pathname === "/api/action") {
    const body = await readJson(req);
    handleAction(body);
    broadcastState();
    return sendJson(res, 200, getPublicState(req));
  }

  if (req.method === "GET" && url.pathname === "/qr.svg") {
    const controlUrl = getBestUrls(req).controlUrl;
    const svg = createQrSvg(controlUrl);
    res.writeHead(200, {
      "Content-Type": MIME_TYPES[".svg"],
      "Cache-Control": "no-store"
    });
    return res.end(svg);
  }

  if (req.method === "GET") {
    return serveStaticAsset(res, url.pathname);
  }

  sendJson(res, 404, { error: "not_found" });
}

function createTimer() {
  return {
    status: "idle",
    durationMs: DEFAULT_DURATION_MS,
    remainingMs: DEFAULT_DURATION_MS,
    endsAt: null
  };
}

function createTeam() {
  return {
    score: 0,
    order: [],
    index: 0
  };
}

function createRoundState(id, questions) {
  const round = {
    id,
    questions: normalizeQuestions(questions),
    timer: createTimer(),
    teams: {
      A: createTeam(),
      B: createTeam()
    },
    history: [],
    lastAction: ""
  };
  prepareRound(round, { resetTimer: true, clearHistory: true, resetScores: true });
  return round;
}

function createRoundStates(roundQuestions) {
  return Array.from({ length: ROUND_COUNT }, (_, index) => (
    createRoundState(index + 1, roundQuestions[index] || [])
  ));
}

function normalizeQuestions(input) {
  const lines = Array.isArray(input) ? input : String(input).split(/\r?\n/);
  const seen = new Set();
  const questions = [];
  for (const line of lines) {
    const question = String(line).trim();
    if (!question || seen.has(question)) {
      continue;
    }
    seen.add(question);
    questions.push(question);
  }
  return questions;
}

function loadStore() {
  try {
    if (!fs.existsSync(STORE_FILE)) {
      return { sourceQuestions: [], roundQuestions: null };
    }

    const parsed = JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
    if (Array.isArray(parsed)) {
      return { sourceQuestions: normalizeQuestions(parsed), roundQuestions: null };
    }

    const legacyRounds = Array.isArray(parsed?.rounds) ? parsed.rounds.flat() : [];
    const source = normalizeQuestions(parsed?.questions ?? parsed?.sourceQuestions ?? legacyRounds);
    return { sourceQuestions: source, roundQuestions: null };
  } catch (error) {
    console.warn("Could not load saved questions:", error.message);
    return { sourceQuestions: [], roundQuestions: null };
  }
}

function saveStore() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(
    STORE_FILE,
    `${JSON.stringify(sourceQuestions, null, 2)}\n`,
    "utf8"
  );
}

function distributeQuestions(items) {
  const buckets = Array.from({ length: ROUND_COUNT }, () => []);
  const shuffled = shuffleCopy(items);
  shuffled.forEach((question, index) => {
    buckets[index % ROUND_COUNT].push(question);
  });
  return buckets;
}

function buildQuestionRounds(items) {
  sourceQuestions = items;
  rounds = createRoundStates(distributeQuestions(sourceQuestions));
  activeRoundIndex = 0;
  activeRound().lastAction = "已建置三回合題庫";
  saveStore();
}

function resetAllRounds() {
  rounds = createRoundStates(distributeQuestions(sourceQuestions));
  activeRoundIndex = 0;
  activeRound().lastAction = "已重置全部回合並重新分配題目";
}

function handleAction(body) {
  const round = activeRound();
  refreshTimer(round);
  const type = String(body.type || "");
  const teamId = body.team === "A" || body.team === "B" ? body.team : null;

  if (type === "switchRound") {
    switchRound(Number(body.round));
    return;
  }

  if (type === "start") {
    ensureRoundPrepared(round);
    if (round.timer.status === "idle" || round.timer.status === "paused" || round.timer.status === "ended") {
      if (round.timer.remainingMs <= 0) {
        round.timer.remainingMs = round.timer.durationMs;
      }
      round.timer.status = "running";
      round.timer.endsAt = Date.now() + round.timer.remainingMs;
      round.lastAction = `第 ${round.id} 回合計時開始`;
    }
    return;
  }

  if (type === "pause") {
    if (round.timer.status === "running") {
      refreshTimer(round);
      round.timer.status = "paused";
      round.timer.endsAt = null;
      round.lastAction = `第 ${round.id} 回合計時暫停`;
    }
    return;
  }

  if (type === "resume") {
    if (round.timer.status === "paused") {
      round.timer.status = "running";
      round.timer.endsAt = Date.now() + round.timer.remainingMs;
      round.lastAction = `第 ${round.id} 回合計時繼續`;
    }
    return;
  }

  if (type === "reset") {
    resetAllRounds();
    return;
  }

  if (type === "undo") {
    undoLastMutation(round);
    return;
  }

  if (!teamId) {
    throw new Error("team_required");
  }

  if (type === "correct") {
    if (!hasCurrentQuestion(round, teamId)) {
      return;
    }
    pushHistory(round);
    round.teams[teamId].score += 1;
    advanceTeam(round, teamId);
    round.lastAction = `第 ${round.id} 回合 ${teamId} 答對`;
    return;
  }

  if (type === "pass") {
    if (!hasCurrentQuestion(round, teamId)) {
      return;
    }
    pushHistory(round);
    advanceTeam(round, teamId);
    round.lastAction = `第 ${round.id} 回合 ${teamId} Pass`;
    return;
  }

  if (type === "score") {
    const delta = Number(body.delta || 0);
    if (!Number.isFinite(delta) || delta === 0) {
      return;
    }
    pushHistory(round);
    round.teams[teamId].score = Math.max(0, round.teams[teamId].score + delta);
    round.lastAction = `第 ${round.id} 回合 ${teamId} ${delta > 0 ? "+" : ""}${delta}`;
    return;
  }

  throw new Error("unknown_action");
}

function activeRound() {
  return rounds[activeRoundIndex] || rounds[0];
}

function switchRound(roundNumber) {
  if (!Number.isInteger(roundNumber) || roundNumber < 1 || roundNumber > ROUND_COUNT) {
    return;
  }

  const current = activeRound();
  if (current.id === roundNumber) {
    current.lastAction = `目前是第 ${roundNumber} 回合`;
    return;
  }

  refreshTimer(current);
  if (current.timer.status === "running") {
    current.timer.status = "paused";
    current.timer.endsAt = null;
    current.lastAction = `第 ${current.id} 回合已暫停`;
  }

  activeRoundIndex = roundNumber - 1;
  activeRound().lastAction = `切換到第 ${roundNumber} 回合`;
}

function ensureRoundPrepared(round) {
  if (round.questions.length === 0) {
    return;
  }
  if (round.teams.A.order.length === 0 || round.teams.B.order.length === 0) {
    prepareRound(round, { resetTimer: false, clearHistory: true, resetScores: true });
  }
}

function prepareRound(round, { resetTimer, clearHistory, resetScores }) {
  if (resetScores) {
    round.teams.A.score = 0;
    round.teams.B.score = 0;
  }
  round.teams.A.index = 0;
  round.teams.B.index = 0;
  round.teams.A.order = shuffledIndexes(round.questions.length);
  round.teams.B.order = shuffledIndexes(round.questions.length);
  avoidMatchingOrder(round);
  avoidCurrentCollision(round, "B");

  if (resetTimer) {
    round.timer.status = "idle";
    round.timer.remainingMs = round.timer.durationMs;
    round.timer.endsAt = null;
  }

  if (clearHistory) {
    round.history.length = 0;
  }
}

function shuffleCopy(items) {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = crypto.randomInt(index + 1);
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }
  return copy;
}

function shuffledIndexes(length) {
  return shuffleCopy(Array.from({ length }, (_, index) => index));
}

function avoidMatchingOrder(round) {
  if (round.questions.length < 2) {
    return;
  }
  const sameOrder = round.teams.A.order.every((value, index) => value === round.teams.B.order[index]);
  if (sameOrder) {
    const first = round.teams.B.order.shift();
    round.teams.B.order.push(first);
  }
}

function advanceTeam(round, teamId) {
  round.teams[teamId].index += 1;
  avoidCurrentCollision(round, teamId);
}

function avoidCurrentCollision(round, teamId) {
  const otherId = teamId === "A" ? "B" : "A";
  const team = round.teams[teamId];
  const other = round.teams[otherId];

  while (team.index < team.order.length && other.index < other.order.length) {
    const otherQuestion = round.questions[other.order[other.index]];
    if (round.questions[team.order[team.index]] !== otherQuestion) {
      return;
    }

    let swapped = false;
    for (let index = team.index + 1; index < team.order.length; index += 1) {
      if (round.questions[team.order[index]] !== otherQuestion) {
        [team.order[team.index], team.order[index]] = [team.order[index], team.order[team.index]];
        swapped = true;
        break;
      }
    }

    if (swapped) {
      return;
    }

    team.index += 1;
  }
}

function hasCurrentQuestion(round, teamId) {
  const team = round.teams[teamId];
  return team.index < team.order.length && round.questions.length > 0;
}

function getCurrentQuestion(round, teamId) {
  if (!hasCurrentQuestion(round, teamId)) {
    return null;
  }
  return round.questions[round.teams[teamId].order[round.teams[teamId].index]];
}

function pushHistory(round) {
  round.history.push({
    A: cloneTeam(round.teams.A),
    B: cloneTeam(round.teams.B),
    lastAction: round.lastAction
  });
  if (round.history.length > 50) {
    round.history.shift();
  }
}

function cloneTeam(team) {
  return {
    score: team.score,
    order: [...team.order],
    index: team.index
  };
}

function undoLastMutation(round) {
  const previous = round.history.pop();
  if (!previous) {
    round.lastAction = "沒有可復原的動作";
    return;
  }
  round.teams.A.score = previous.A.score;
  round.teams.A.order = previous.A.order;
  round.teams.A.index = previous.A.index;
  round.teams.B.score = previous.B.score;
  round.teams.B.order = previous.B.order;
  round.teams.B.index = previous.B.index;
  round.lastAction = "已復原上一個動作";
}

function refreshTimer(round) {
  if (round.timer.status !== "running") {
    return false;
  }
  round.timer.remainingMs = Math.max(0, round.timer.endsAt - Date.now());
  if (round.timer.remainingMs === 0) {
    round.timer.status = "ended";
    round.timer.endsAt = null;
    round.lastAction = `第 ${round.id} 回合時間到`;
    timeUpSeq += 1;
    return true;
  }
  return false;
}

function getPublicState(req) {
  const round = activeRound();
  refreshTimer(round);
  const urls = getBestUrls(req);
  return {
    server: {
      port: PORT,
      displayUrl: urls.displayUrl,
      controlUrl: urls.controlUrl,
      lanUrls: getLanUrls()
    },
    controller: {
      everConnected: controllerEverConnected,
      activeCount: [...clients].filter((client) => client.role === "control").length
    },
    questions: {
      count: round.questions.length,
      sourceCount: sourceQuestions.length,
      text: sourceQuestions.join("\n"),
      roundText: round.questions.join("\n")
    },
    rounds: {
      active: round.id,
      count: ROUND_COUNT,
      items: rounds.map((item) => ({
        id: item.id,
        count: item.questions.length,
        isActive: item.id === round.id,
        timerStatus: item.timer.status,
        scores: {
          A: item.teams.A.score,
          B: item.teams.B.score
        },
        questions: item.questions
      }))
    },
    timer: {
      status: round.timer.status,
      durationMs: round.timer.durationMs,
      remainingMs: round.timer.remainingMs,
      timeUpSeq
    },
    teams: [
      serializeTeam(round, "A"),
      serializeTeam(round, "B")
    ],
    history: {
      canUndo: round.history.length > 0
    },
    lastAction: round.lastAction,
    now: Date.now()
  };
}

function serializeTeam(round, id) {
  const team = round.teams[id];
  return {
    id,
    score: team.score,
    index: Math.min(team.index + 1, team.order.length),
    total: team.order.length,
    exhausted: round.questions.length > 0 && team.index >= team.order.length,
    currentQuestion: getCurrentQuestion(round, id)
  };
}

function markControllerSeen() {
  if (!controllerEverConnected) {
    controllerEverConnected = true;
  }
  broadcastState();
}

function openEventStream(req, res, role) {
  if (role === "control") {
    markControllerSeen();
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });

  const client = { id: crypto.randomUUID(), role, res };
  clients.add(client);
  writeEvent(client, "state", getPublicState(req));
  broadcastState();

  const keepAlive = setInterval(() => {
    writeRawEvent(res, "ping", String(Date.now()));
  }, 15000);

  req.on("close", () => {
    clearInterval(keepAlive);
    clients.delete(client);
    broadcastState();
  });
}

function broadcastState() {
  const state = getPublicState();
  for (const client of clients) {
    writeEvent(client, "state", state);
  }
}

function writeEvent(client, event, data) {
  writeRawEvent(client.res, event, JSON.stringify(data));
}

function writeRawEvent(res, event, data) {
  res.write(`event: ${event}\n`);
  for (const line of String(data).split(/\r?\n/)) {
    res.write(`data: ${line}\n`);
  }
  res.write("\n");
}

function servePublicFile(res, filename) {
  return sendFile(res, path.join(PUBLIC_DIR, filename));
}

function serveStaticAsset(res, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return sendJson(res, 400, { error: "bad_path" });
  }
  const target = path.normalize(path.join(PUBLIC_DIR, decoded));
  if (!target.startsWith(PUBLIC_DIR)) {
    return sendJson(res, 403, { error: "forbidden" });
  }
  return sendFile(res, target);
}

function sendFile(res, filePath) {
  fs.readFile(filePath, (error, data) => {
    if (error) {
      sendJson(res, 404, { error: "not_found" });
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
      "Cache-Control": "no-store"
    });
    res.end(data);
  });
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": MIME_TYPES[".json"],
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
        reject(new Error("body_too_large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!body.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function getBestUrls(req) {
  const host = req?.headers?.host;
  if (host && !host.startsWith("127.0.0.1") && !host.startsWith("localhost")) {
    return {
      displayUrl: `http://${host}/`,
      controlUrl: `http://${host}/control`
    };
  }

  const address = getLocalAddresses()[0] || "127.0.0.1";
  return {
    displayUrl: `http://${address}:${PORT}/`,
    controlUrl: `http://${address}:${PORT}/control`
  };
}

function getLanUrls() {
  const addresses = getLocalAddresses();
  if (addresses.length === 0) {
    addresses.push("127.0.0.1");
  }
  return addresses.map((address) => ({
    displayUrl: `http://${address}:${PORT}/`,
    controlUrl: `http://${address}:${PORT}/control`
  }));
}

function getLocalAddresses() {
  const addresses = [];
  const interfaces = os.networkInterfaces();
  for (const details of Object.values(interfaces)) {
    for (const item of details || []) {
      if (item.family === "IPv4" && !item.internal) {
        addresses.push(item.address);
      }
    }
  }
  return [...new Set(addresses)];
}

function createQrSvg(text) {
  const modules = createQrModules(text);
  const quietZone = 4;
  const size = modules.length;
  const viewSize = size + quietZone * 2;
  const paths = [];

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (modules[y][x]) {
        paths.push(`M${x + quietZone} ${y + quietZone}h1v1h-1z`);
      }
    }
  }

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${viewSize} ${viewSize}" shape-rendering="crispEdges" role="img" aria-label="控制頁 QR Code">`,
    `<rect width="${viewSize}" height="${viewSize}" fill="#fff"/>`,
    `<path fill="#111" d="${paths.join("")}"/>`,
    "</svg>"
  ].join("");
}

function createQrModules(text) {
  const version = 4;
  const size = version * 4 + 17;
  const dataCodewords = 80;
  const eccCodewords = 20;
  const mask = 0;
  const bytes = [...Buffer.from(text, "utf8")];

  if (bytes.length > 78) {
    throw new Error("qr_text_too_long");
  }

  const data = makeQrDataCodewords(bytes, dataCodewords);
  const ecc = makeReedSolomonRemainder(data, eccCodewords);
  const codewords = [...data, ...ecc];
  const modules = Array.from({ length: size }, () => Array(size).fill(false));
  const isFunction = Array.from({ length: size }, () => Array(size).fill(false));

  function setFunction(x, y, dark) {
    modules[y][x] = dark;
    isFunction[y][x] = true;
  }

  drawFinderPattern(3, 3);
  drawFinderPattern(size - 4, 3);
  drawFinderPattern(3, size - 4);
  drawAlignmentPattern(26, 26);

  for (let index = 8; index < size - 8; index += 1) {
    setFunction(index, 6, index % 2 === 0);
    setFunction(6, index, index % 2 === 0);
  }

  setFunction(8, size - 8, true);
  reserveFormatAreas();
  drawCodewords();
  drawFormatBits();
  return modules;

  function drawFinderPattern(centerX, centerY) {
    for (let dy = -4; dy <= 4; dy += 1) {
      for (let dx = -4; dx <= 4; dx += 1) {
        const x = centerX + dx;
        const y = centerY + dy;
        if (x < 0 || y < 0 || x >= size || y >= size) {
          continue;
        }
        const distance = Math.max(Math.abs(dx), Math.abs(dy));
        setFunction(x, y, distance !== 2 && distance !== 4);
      }
    }
  }

  function drawAlignmentPattern(centerX, centerY) {
    for (let dy = -2; dy <= 2; dy += 1) {
      for (let dx = -2; dx <= 2; dx += 1) {
        const distance = Math.max(Math.abs(dx), Math.abs(dy));
        setFunction(centerX + dx, centerY + dy, distance !== 1);
      }
    }
  }

  function reserveFormatAreas() {
    for (let index = 0; index < 9; index += 1) {
      if (index !== 6) {
        isFunction[8][index] = true;
        isFunction[index][8] = true;
      }
    }
    for (let index = 0; index < 8; index += 1) {
      isFunction[8][size - 1 - index] = true;
      isFunction[size - 1 - index][8] = true;
    }
  }

  function drawCodewords() {
    const bits = [];
    for (const codeword of codewords) {
      for (let bit = 7; bit >= 0; bit -= 1) {
        bits.push(((codeword >>> bit) & 1) === 1);
      }
    }

    let bitIndex = 0;
    let upward = true;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) {
        right -= 1;
      }

      for (let vertical = 0; vertical < size; vertical += 1) {
        const y = upward ? size - 1 - vertical : vertical;
        for (let dx = 0; dx < 2; dx += 1) {
          const x = right - dx;
          if (isFunction[y][x]) {
            continue;
          }
          const bit = bits[bitIndex] || false;
          const masked = bit !== ((x + y) % 2 === 0);
          modules[y][x] = masked;
          bitIndex += 1;
        }
      }
      upward = !upward;
    }
  }

  function drawFormatBits() {
    const bits = getFormatBits(1, mask);
    for (let i = 0; i <= 5; i += 1) {
      setFunction(8, i, getBit(bits, i));
    }
    setFunction(8, 7, getBit(bits, 6));
    setFunction(8, 8, getBit(bits, 7));
    setFunction(7, 8, getBit(bits, 8));
    for (let i = 9; i < 15; i += 1) {
      setFunction(14 - i, 8, getBit(bits, i));
    }
    for (let i = 0; i < 8; i += 1) {
      setFunction(size - 1 - i, 8, getBit(bits, i));
    }
    for (let i = 8; i < 15; i += 1) {
      setFunction(8, size - 15 + i, getBit(bits, i));
    }
    setFunction(8, size - 8, true);
  }
}

function makeQrDataCodewords(bytes, capacity) {
  const bits = [];
  appendBits(bits, 0b0100, 4);
  appendBits(bits, bytes.length, 8);
  for (const byte of bytes) {
    appendBits(bits, byte, 8);
  }

  const capacityBits = capacity * 8;
  appendBits(bits, 0, Math.min(4, capacityBits - bits.length));
  while (bits.length % 8 !== 0) {
    bits.push(0);
  }

  const data = [];
  for (let index = 0; index < bits.length; index += 8) {
    let value = 0;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value << 1) | bits[index + bit];
    }
    data.push(value);
  }

  for (let padIndex = 0; data.length < capacity; padIndex += 1) {
    data.push(padIndex % 2 === 0 ? 0xec : 0x11);
  }

  return data;
}

function appendBits(bits, value, length) {
  for (let index = length - 1; index >= 0; index -= 1) {
    bits.push((value >>> index) & 1);
  }
}

function getFormatBits(errorCorrectionLevel, mask) {
  const data = (errorCorrectionLevel << 3) | mask;
  let bits = data << 10;
  const generator = 0x537;
  for (let index = 14; index >= 10; index -= 1) {
    if (((bits >>> index) & 1) !== 0) {
      bits ^= generator << (index - 10);
    }
  }
  return ((data << 10) | bits) ^ 0x5412;
}

function getBit(value, index) {
  return ((value >>> index) & 1) !== 0;
}

const GF_EXP = Array(512);
const GF_LOG = Array(256);
let gfValue = 1;
for (let index = 0; index < 255; index += 1) {
  GF_EXP[index] = gfValue;
  GF_LOG[gfValue] = index;
  gfValue <<= 1;
  if ((gfValue & 0x100) !== 0) {
    gfValue ^= 0x11d;
  }
}
for (let index = 255; index < 512; index += 1) {
  GF_EXP[index] = GF_EXP[index - 255];
}

function gfMultiply(left, right) {
  if (left === 0 || right === 0) {
    return 0;
  }
  return GF_EXP[GF_LOG[left] + GF_LOG[right]];
}

function makeReedSolomonRemainder(data, degree) {
  const generator = makeReedSolomonGenerator(degree);
  const remainder = Array(degree).fill(0);

  for (const byte of data) {
    const factor = byte ^ remainder.shift();
    remainder.push(0);
    for (let index = 0; index < degree; index += 1) {
      remainder[index] ^= gfMultiply(generator[index + 1], factor);
    }
  }

  return remainder;
}

function makeReedSolomonGenerator(degree) {
  let coefficients = [1];
  for (let index = 0; index < degree; index += 1) {
    const next = Array(coefficients.length + 1).fill(0);
    for (let offset = 0; offset < coefficients.length; offset += 1) {
      next[offset] ^= coefficients[offset];
      next[offset + 1] ^= gfMultiply(coefficients[offset], GF_EXP[index]);
    }
    coefficients = next;
  }
  return coefficients;
}
