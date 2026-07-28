const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const port = 4100 + Math.floor(Math.random() * 1000);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lip-reading-game-"));
const baseUrl = `http://127.0.0.1:${port}`;

const child = spawn(process.execPath, ["server.js"], {
  cwd: path.join(__dirname, ".."),
  env: {
    ...process.env,
    PORT: String(port),
    DATA_DIR: dataDir
  },
  stdio: ["ignore", "pipe", "pipe"]
});

let output = "";
child.stdout.on("data", (chunk) => {
  output += chunk.toString();
});
child.stderr.on("data", (chunk) => {
  output += chunk.toString();
});

run()
  .then(() => {
    child.kill();
    fs.rmSync(dataDir, { recursive: true, force: true });
    console.log("Smoke test passed");
  })
  .catch((error) => {
    child.kill();
    fs.rmSync(dataDir, { recursive: true, force: true });
    console.error(output);
    console.error(error);
    process.exitCode = 1;
  });

async function run() {
  await waitForServer();

  let state = await getJson("/api/state");
  assert.equal(state.controller.everConnected, false);
  assert.equal(state.questions.count, 0);

  const qr = await fetch(`${baseUrl}/qr.svg`).then((response) => response.text());
  assert.match(qr, /<svg/);

  await fetch(`${baseUrl}/control`);
  state = await getJson("/api/state");
  assert.equal(state.controller.everConnected, true);

  state = await postJson("/api/questions", {
    questions: [
      "Q1",
      "Q2",
      "Q3",
      "Q4",
      "Q5",
      "Q6",
      "Q7",
      "Q8",
      "Q9",
      "Q1"
    ].join("\n")
  });
  assert.equal(state.questions.sourceCount, 9);
  assert.equal(state.questions.count, 3);
  assert.equal(state.rounds.count, 3);
  assert.deepEqual(state.rounds.items.map((round) => round.count), [3, 3, 3]);
  assertNoRoundCollisions(state);
  const savedQuestions = JSON.parse(fs.readFileSync(path.join(dataDir, "questions.json"), "utf8"));
  assert.equal(Array.isArray(savedQuestions), true);
  assert.equal(savedQuestions.length, 9);
  assert.equal(savedQuestions.rounds, undefined);
  assert.notEqual(state.teams[0].currentQuestion, state.teams[1].currentQuestion);

  state = await postJson("/api/action", { type: "start" });
  assert.equal(state.timer.status, "running");

  const beforeCorrect = state.teams[0].currentQuestion;
  state = await postJson("/api/action", { type: "correct", team: "A" });
  assert.equal(state.teams[0].score, 1);
  assert.notEqual(state.teams[0].currentQuestion, beforeCorrect);

  state = await postJson("/api/action", { type: "score", team: "B", delta: 1 });
  assert.equal(state.teams[1].score, 1);

  state = await postJson("/api/action", { type: "undo" });
  assert.equal(state.teams[1].score, 0);

  state = await postJson("/api/action", { type: "switchRound", round: 2 });
  assert.equal(state.rounds.active, 2);
  assert.equal(state.rounds.items[0].timerStatus, "paused");
  assert.equal(state.teams[0].score, 0);
  assert.equal(state.questions.count, 3);

  state = await postJson("/api/action", { type: "score", team: "B", delta: 1 });
  assert.equal(state.teams[1].score, 1);

  state = await postJson("/api/action", { type: "switchRound", round: 1 });
  assert.equal(state.rounds.active, 1);
  assert.equal(state.teams[0].score, 1);

  state = await postJson("/api/action", { type: "reset" });
  assert.equal(state.rounds.active, 1);
  assert.deepEqual(state.rounds.items.map((round) => round.count), [3, 3, 3]);
  assert.deepEqual(state.rounds.items.map((round) => round.timerStatus), ["idle", "idle", "idle"]);
  assert.deepEqual(state.rounds.items.map((round) => round.scores), [
    { A: 0, B: 0 },
    { A: 0, B: 0 },
    { A: 0, B: 0 }
  ]);
  assertNoRoundCollisions(state);

  state = await postJson("/api/action", { type: "pass", team: "B" });
  assert.equal(state.teams[1].score, 0);

  for (let index = 0; index < 3; index += 1) {
    state = await postJson("/api/action", { type: "pass", team: "B" });
  }
  assert.equal(state.teams[1].exhausted, true);

  state = await postJson("/api/action", { type: "start" });
  assert.equal(state.timer.status, "running");
  state = await postJson("/api/action", { type: "pause" });
  assert.equal(state.timer.status, "paused");

  state = await postJson("/api/questions", {
    questions: ["A1", "A2", "B1", "B2", "C1", "C2"].join("\n")
  });
  assert.deepEqual(state.rounds.items.map((round) => round.count), [2, 2, 2]);
  assert.notEqual(state.teams[0].currentQuestion, state.teams[1].currentQuestion);
  const pinnedQuestion = state.teams[0].currentQuestion;
  state = await postJson("/api/action", { type: "pass", team: "B" });
  assert.notEqual(state.teams[1].currentQuestion, pinnedQuestion);
}

function assertNoRoundCollisions(state) {
  const seen = new Set();
  for (const round of state.rounds.items) {
    for (const question of round.questions) {
      assert.equal(seen.has(question), false, `Duplicate round question: ${question}`);
      seen.add(question);
    }
  }
}

async function waitForServer() {
  const started = Date.now();
  while (Date.now() - started < 6000) {
    try {
      await getJson("/api/state");
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error("Server did not start");
}

async function getJson(pathname) {
  const response = await fetch(`${baseUrl}${pathname}`);
  if (!response.ok) {
    throw new Error(`${pathname} returned ${response.status}`);
  }
  return response.json();
}

async function postJson(pathname, body) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    throw new Error(`${pathname} returned ${response.status}`);
  }
  return response.json();
}
