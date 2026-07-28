const controlTimer = document.querySelector("#controlTimer");
const timerButton = document.querySelector("#timerButton");
const undoButton = document.querySelector("#undoButton");
const resetButton = document.querySelector("#resetButton");
const roundControls = document.querySelector("#roundControls");
const teamsRoot = document.querySelector("#controlTeams");
const controlStatus = document.querySelector("#controlStatus");

let state = null;
let busy = false;

connectEvents();
loadState();

timerButton.addEventListener("click", () => {
  if (!state) {
    return;
  }
  if (state.timer.status === "running") {
    sendAction({ type: "pause" });
  } else if (state.timer.status === "paused") {
    sendAction({ type: "resume" });
  } else {
    sendAction({ type: "start" });
  }
});

undoButton.addEventListener("click", () => sendAction({ type: "undo" }));

resetButton.addEventListener("click", () => {
  if (window.confirm("重置全部回合、分數、計時，並重新分配題目？")) {
    sendAction({ type: "reset" });
  }
});

roundControls.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-round]");
  if (!button) {
    return;
  }
  sendAction({ type: "switchRound", round: Number(button.dataset.round) });
});

teamsRoot.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) {
    return;
  }
  const action = button.dataset.action;
  const team = button.dataset.team;
  if (action === "score") {
    sendAction({ type: "score", team, delta: Number(button.dataset.delta) });
    return;
  }
  sendAction({ type: action, team });
});

function connectEvents() {
  const events = new EventSource("/events?role=control");
  events.addEventListener("state", (event) => {
    updateState(JSON.parse(event.data));
  });
  events.addEventListener("open", () => {
    controlStatus.textContent = "已連線";
  });
  events.addEventListener("error", () => {
    controlStatus.textContent = "重新連線中";
  });
}

async function loadState() {
  updateState(await fetchJson("/api/state"));
}

function updateState(nextState) {
  state = nextState;
  busy = false;
  render();
}

function render() {
  controlTimer.textContent = formatTime(state.timer.remainingMs);
  controlTimer.classList.toggle("time-up", state.timer.status === "ended");
  timerButton.textContent = getTimerButtonText();
  undoButton.disabled = !state.history.canUndo || busy;
  timerButton.disabled = busy;
  resetButton.disabled = busy;
  roundControls.innerHTML = state.rounds.items.map(renderRoundButton).join("");
  teamsRoot.innerHTML = state.teams.map(renderTeam).join("");
  controlStatus.textContent = getStatusLine();
}

function renderRoundButton(round) {
  const active = round.isActive ? "active" : "";
  return `
    <button class="round-button ${active}" data-round="${round.id}" type="button" ${busy ? "disabled" : ""}>
      <span>第 ${round.id} 回合</span>
      <small>${round.count} 題 · A ${round.scores.A} / B ${round.scores.B}</small>
    </button>
  `;
}

function renderTeam(team) {
  const hasQuestion = Boolean(team.currentQuestion);
  const questionText = team.exhausted ? "題目結束" : team.currentQuestion || "等待題庫";
  return `
    <article class="control-team">
      <header>
        <h2>${escapeHtml(team.id)} 隊</h2>
        <div class="control-score">${team.score}</div>
      </header>
      <div class="control-question">${escapeHtml(questionText)}</div>
      <div class="team-actions">
        <button class="correct-button" data-action="correct" data-team="${team.id}" ${hasQuestion ? "" : "disabled"}>答對</button>
        <button class="pass-button" data-action="pass" data-team="${team.id}" ${hasQuestion ? "" : "disabled"}>Pass</button>
      </div>
      <div class="score-actions">
        <button class="minus-button" data-action="score" data-team="${team.id}" data-delta="-1">-1</button>
        <button class="plus-button" data-action="score" data-team="${team.id}" data-delta="1">+1</button>
      </div>
    </article>
  `;
}

function getTimerButtonText() {
  if (state.timer.status === "running") {
    return "暫停";
  }
  if (state.timer.status === "paused") {
    return "繼續";
  }
  if (state.timer.status === "ended") {
    return "重新計時";
  }
  return "開始";
}

function getStatusLine() {
  if (state.questions.count === 0) {
    return "本回合尚未分配題目";
  }
  if (state.timer.status === "running") {
    return state.lastAction || "計時中";
  }
  if (state.timer.status === "paused") {
    return "暫停中";
  }
  if (state.timer.status === "ended") {
    return "時間到，仍可計分";
  }
  return state.lastAction || "待開始";
}

async function sendAction(payload) {
  if (busy) {
    return;
  }
  busy = true;
  render();
  if (navigator.vibrate) {
    navigator.vibrate(18);
  }
  try {
    updateState(await postJson("/api/action", payload));
  } catch {
    busy = false;
    controlStatus.textContent = "操作失敗";
    render();
  }
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
