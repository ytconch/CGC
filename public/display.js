const waitScreen = document.querySelector("#waitScreen");
const stageScreen = document.querySelector("#stageScreen");
const waitUrl = document.querySelector("#waitUrl");
const timerEl = document.querySelector("#timer");
const teamAEl = document.querySelector("#teamA");
const teamBEl = document.querySelector("#teamB");
const roundBadge = document.querySelector("#roundBadge");
const statusLine = document.querySelector("#statusLine");
const questionCount = document.querySelector("#questionCount");
const reconnectQr = document.querySelector("#reconnectQr");
const questionsButton = document.querySelector("#questionsButton");
const soundButton = document.querySelector("#soundButton");
const dialog = document.querySelector("#questionsDialog");
const questionsInput = document.querySelector("#questionsInput");
const roundSummary = document.querySelector("#roundSummary");
const saveQuestions = document.querySelector("#saveQuestions");
const saveStatus = document.querySelector("#saveStatus");

let state = null;
let lastTimeUpSeq = 0;
let audioContext = null;
let audioEnabled = false;

connectEvents();
loadState();

questionsButton?.addEventListener("click", () => {
  questionsInput.value = state?.questions?.text || "";
  saveStatus.textContent = "";
  renderRoundSummary();
  dialog.showModal();
});

soundButton?.addEventListener("click", async () => {
  audioContext = audioContext || new AudioContext();
  await audioContext.resume();
  audioEnabled = true;
  soundButton.textContent = "音效已開";
  playTone(520, 0.08);
});

saveQuestions.addEventListener("click", async () => {
  saveQuestions.disabled = true;
  saveStatus.textContent = "建置中";
  try {
    const nextState = await postJson("/api/questions", { questions: questionsInput.value });
    updateState(nextState);
    renderRoundSummary();
    saveStatus.textContent = "已建置三回合";
  } catch {
    saveStatus.textContent = "建置失敗";
  } finally {
    saveQuestions.disabled = false;
  }
});

function connectEvents() {
  const events = new EventSource("/events?role=display");
  events.addEventListener("state", (event) => {
    updateState(JSON.parse(event.data));
  });
  events.addEventListener("error", () => {
    statusLine.textContent = "重新連線中";
  });
}

async function loadState() {
  updateState(await fetchJson("/api/state"));
}

function updateState(nextState) {
  state = nextState;
  waitUrl.textContent = state.server.controlUrl;

  const hasController = state.controller.everConnected;
  waitScreen.classList.toggle("hidden", hasController);
  stageScreen.classList.toggle("hidden", !hasController);
  reconnectQr.classList.toggle("hidden", !hasController || state.controller.activeCount > 0);

  renderTimer();
  renderTeam(teamAEl, state.teams[0]);
  renderTeam(teamBEl, state.teams[1]);
  roundBadge.textContent = `第 ${state.rounds.active} 回合`;
  questionCount.textContent = `本回合 ${state.questions.count} 題 / 全部 ${state.questions.sourceCount} 題`;
  statusLine.textContent = getStatusLine();

  if (state.timer.timeUpSeq > lastTimeUpSeq) {
    playTimeUp();
    lastTimeUpSeq = state.timer.timeUpSeq;
  }
}

function renderTimer() {
  timerEl.textContent = formatTime(state.timer.remainingMs);
  timerEl.classList.toggle("time-up", state.timer.status === "ended");
}

function renderTeam(root, team) {
  const empty = !team.currentQuestion;
  const text = team.exhausted ? "題目結束" : team.currentQuestion || "等待題庫";
  root.innerHTML = `
    <div class="team-top">
      <h2 class="team-name">${escapeHtml(team.id)} 隊</h2>
      <div class="score">${team.score}</div>
    </div>
    <div class="question-progress">${team.total === 0 ? "0 / 0" : `${team.index} / ${team.total}`}</div>
    <div class="question-text ${empty ? "empty" : ""}">${escapeHtml(text)}</div>
    <div class="question-progress">${team.exhausted ? "完成" : "進行中"}</div>
  `;
}

function getStatusLine() {
  if (state.questions.count === 0) {
    return "尚未設定題庫";
  }
  if (state.timer.status === "running") {
    return state.lastAction || "計時中";
  }
  if (state.timer.status === "paused") {
    return "暫停中";
  }
  if (state.timer.status === "ended") {
    return "時間到";
  }
  return state.lastAction || "待開始";
}

function renderRoundSummary() {
  if (!roundSummary || !state?.rounds?.items) {
    return;
  }
  roundSummary.innerHTML = state.rounds.items.map((round) => `
    <div class="round-summary-item ${round.isActive ? "active" : ""}">
      <strong>第 ${round.id} 回合</strong>
      <span>${round.count} 題</span>
    </div>
  `).join("");
}

function playTimeUp() {
  timerEl.animate(
    [
      { transform: "scale(1)" },
      { transform: "scale(1.035)" },
      { transform: "scale(1)" }
    ],
    { duration: 520, iterations: 3 }
  );
  playTone(880, 0.16);
  window.setTimeout(() => playTone(660, 0.18), 180);
}

function playTone(frequency, duration) {
  if (!audioEnabled || !audioContext) {
    return;
  }
  const oscillator = audioContext.createOscillator();
  const gain = audioContext.createGain();
  oscillator.frequency.value = frequency;
  oscillator.type = "sine";
  gain.gain.setValueAtTime(0.001, audioContext.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.18, audioContext.currentTime + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.001, audioContext.currentTime + duration);
  oscillator.connect(gain);
  gain.connect(audioContext.destination);
  oscillator.start();
  oscillator.stop(audioContext.currentTime + duration + 0.02);
}

function formatTime(ms) {
  const totalSeconds = Math.ceil(Math.max(0, ms) / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }
  return response.json();
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }
  return response.json();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
