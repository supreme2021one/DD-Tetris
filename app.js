(() => {
  const COLS = 10;
  const ROWS = 20;
  const CELL = 30;
  const COLORS = ["#75e6c2", "#82a7ff", "#ff83a7", "#ffc66d", "#b28cff", "#62d7ed", "#f58e75"];
  const SHAPES = {
    I: [[1, 1, 1, 1]],
    O: [[1, 1], [1, 1]],
    T: [[0, 1, 0], [1, 1, 1]],
    S: [[0, 1, 1], [1, 1, 0]],
    Z: [[1, 1, 0], [0, 1, 1]],
    J: [[1, 0, 0], [1, 1, 1]],
    L: [[0, 0, 1], [1, 1, 1]],
  };
  const PIECES = Object.keys(SHAPES);
  const $ = (id) => document.getElementById(id);
  const ui = {
    lobby: $("lobby"), game: $("game"), lobbyMessage: $("lobbyMessage"), gameMessage: $("gameMessage"),
    board1: $("board1"), board2: $("board2"), next: $("nextCanvas"), hold: $("holdCanvas"),
    overlay1: $("overlay1"), overlay2: $("overlay2"), opponentPanel: $("opponentPanel"), roomBadge: $("roomBadge"), versusColumn: $("versusColumn"), touchDeck2: $("touchDeck2"),
  };
  const boardEffects = new Map();
  let mode = "solo";
  let game1 = null;
  let game2 = null;
  let opponentSnapshot = null;
  let socket = null;
  let roomCode = "";
  let localPaused = false;
  let running = false;
  let lastFrame = 0;
  let syncElapsed = 0;
  let messageTimer = 0;
  const packagedApp = location.hostname === "appassets.androidplatform.net";

  if (packagedApp) {
    $("serverAddressField").classList.remove("hidden");
    $("onlineDividerLabel").textContent = "PLAY TOGETHER ON TWO PHONES";
    $("createButton").innerHTML = "<span>＋</span> Create room on Phone 1";
    try { $("serverAddress").value = localStorage.getItem("dd-tetris-server-address") || ""; } catch { /* Address can still be entered for this session. */ }
  }

  const emptyBoard = () => Array.from({ length: ROWS }, () => Array(COLS).fill(0));
  const copyMatrix = (matrix) => matrix.map((row) => row.slice());
  const randomBag = () => {
    const bag = PIECES.slice();
    for (let i = bag.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [bag[i], bag[j]] = [bag[j], bag[i]];
    }
    return bag;
  };
  const makePiece = (type) => ({ type, matrix: copyMatrix(SHAPES[type]), color: PIECES.indexOf(type) + 1, x: 0, y: 0 });

  class FallingBlocks {
    constructor(onAttack, onOver, onChange, onClear, onReturnAttack) {
      this.board = emptyBoard();
      this.bag = [];
      this.queue = [];
      this.held = null;
      this.canHold = true;
      this.score = 0;
      this.lines = 0;
      this.level = 1;
      this.gravity = 0;
      this.alive = true;
      this.onAttack = onAttack;
      this.onOver = onOver;
      this.onChange = onChange;
      this.onClear = onClear;
      this.onReturnAttack = onReturnAttack;
      this.garbageRowTags = Array(ROWS).fill(null);
      this.fillQueue();
      this.spawn();
    }

    fillQueue() {
      while (this.queue.length < 6) {
        if (!this.bag.length) this.bag = randomBag();
        this.queue.push(this.bag.shift());
      }
    }

    nextType() {
      this.fillQueue();
      const type = this.queue.shift();
      this.fillQueue();
      return type;
    }

    spawn(type = this.nextType()) {
      this.current = makePiece(type);
      this.current.x = Math.floor((COLS - this.current.matrix[0].length) / 2);
      this.current.y = 0;
      this.canHold = true;
      if (this.collides(this.current.matrix, this.current.x, this.current.y)) this.finish();
      this.onChange?.();
    }

    collides(matrix, x, y) {
      for (let r = 0; r < matrix.length; r += 1) {
        for (let c = 0; c < matrix[r].length; c += 1) {
          if (!matrix[r][c]) continue;
          const bx = x + c;
          const by = y + r;
          if (bx < 0 || bx >= COLS || by >= ROWS) return true;
          if (by >= 0 && this.board[by][bx]) return true;
        }
      }
      return false;
    }

    move(dx, dy) {
      if (!this.alive) return false;
      if (!this.collides(this.current.matrix, this.current.x + dx, this.current.y + dy)) {
        this.current.x += dx;
        this.current.y += dy;
        this.onChange?.();
        return true;
      }
      if (dy > 0) this.lock();
      return false;
    }

    rotate(direction = 1) {
      if (!this.alive) return;
      const matrix = this.current.matrix;
      const rotated = direction > 0
        ? matrix[0].map((_, i) => matrix.map((row) => row[i]).reverse())
        : matrix[0].map((_, i) => matrix.map((row) => row[matrix[0].length - 1 - i]));
      for (const offset of [0, -1, 1, -2, 2]) {
        if (!this.collides(rotated, this.current.x + offset, this.current.y)) {
          this.current.matrix = rotated;
          this.current.x += offset;
          this.onChange?.();
          return;
        }
      }
    }

    hardDrop() {
      if (!this.alive) return;
      let distance = 0;
      while (!this.collides(this.current.matrix, this.current.x, this.current.y + 1)) {
        this.current.y += 1;
        distance += 1;
      }
      this.score += distance * 2;
      this.lock();
    }

    holdPiece() {
      if (!this.alive || !this.canHold) return;
      const currentType = this.current.type;
      if (!this.held) {
        this.held = currentType;
        this.spawn();
      } else {
        const heldType = this.held;
        this.held = currentType;
        this.spawn(heldType);
      }
      this.canHold = false;
      this.onChange?.();
    }

    ghostY() {
      let y = this.current.y;
      while (!this.collides(this.current.matrix, this.current.x, y + 1)) y += 1;
      return y;
    }

    lock() {
      if (!this.alive) return;
      for (let r = 0; r < this.current.matrix.length; r += 1) {
        for (let c = 0; c < this.current.matrix[r].length; c += 1) {
          if (!this.current.matrix[r][c]) continue;
          const y = this.current.y + r;
          const x = this.current.x + c;
          if (y < 0) return this.finish();
          this.board[y][x] = this.current.color;
        }
      }
      let cleared = 0;
      const clearedTags = [];
      const clearedRows = this.board.map((row, index) => row.every(Boolean)
        ? { row: index, colors: row.slice() }
        : null).filter(Boolean);
      for (let r = ROWS - 1; r >= 0;) {
        if (this.board[r].every(Boolean)) {
          if (this.garbageRowTags[r]) clearedTags.push(this.garbageRowTags[r]);
          this.board.splice(r, 1);
          this.board.unshift(Array(COLS).fill(0));
          this.garbageRowTags.splice(r, 1);
          this.garbageRowTags.unshift(null);
          cleared += 1;
        } else r -= 1;
      }
      if (cleared) {
        this.onClear?.(clearedRows, cleared);
        const scores = [0, 100, 300, 500, 800];
        this.score += (scores[cleared] || 1000) * this.level;
        this.lines += cleared;
        this.level = 1 + Math.floor(this.lines / 10);
        const attacks = [0, 0, 1, 2, 4];
        const outgoing = attacks[cleared] || 0;
        if (cleared >= 5) this.onAttack?.(1, { retaliable: true });
        else if (outgoing) this.onAttack?.(outgoing);
        for (const tag of clearedTags) if (tag.expiresAt > Date.now()) this.onReturnAttack?.(tag);
      }
      this.spawn();
      this.onChange?.();
    }

    addGarbage(count, retaliableTag = null) {
      if (!this.alive) return;
      for (let i = 0; i < count; i += 1) {
        if (this.board[0].some(Boolean)) return this.finish();
        const hole = Math.floor(Math.random() * COLS);
        this.board.shift();
        this.garbageRowTags.shift();
        const row = Array(COLS).fill(7);
        row[hole] = 0;
        this.board.push(row);
        this.garbageRowTags.push(i === 0 ? retaliableTag : null);
      }
      this.onChange?.();
    }

    update(dt) {
      if (!this.alive || localPaused) return;
      this.gravity += dt;
      const interval = Math.max(0.085, 0.82 * Math.pow(0.82, this.level - 1));
      if (this.gravity >= interval) {
        this.gravity = 0;
        this.move(0, 1);
      }
    }

    finish() {
      if (!this.alive) return;
      this.alive = false;
      this.onOver?.(this);
      this.onChange?.();
    }

    snapshot() {
      return {
        board: this.board.map((row) => row.slice()),
        active: { matrix: copyMatrix(this.current.matrix), x: this.current.x, y: this.current.y, color: this.current.color },
        score: this.score, lines: this.lines, level: this.level, alive: this.alive,
        garbageRows: this.garbageRowTags.map((tag, row) => tag && tag.expiresAt > Date.now() ? { row, expiresAt: tag.expiresAt } : null).filter(Boolean),
      };
    }
  }

  function roundedRect(ctx, x, y, width, height, radius) {
    const r = Math.min(radius, width / 2, height / 2);
    ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + width, y, x + width, y + height, r);
    ctx.arcTo(x + width, y + height, x, y + height, r); ctx.arcTo(x, y + height, x, y, r);
    ctx.arcTo(x, y, x + width, y, r); ctx.closePath();
  }

  function drawCell(ctx, x, y, size, color, alpha = 1) {
    const inset = 2;
    ctx.globalAlpha = alpha;
    ctx.fillStyle = color;
    roundedRect(ctx, x + inset, y + inset, size - inset * 2, size - inset * 2, 4);
    ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,.16)";
    roundedRect(ctx, x + inset + 2, y + inset + 2, size - inset * 2 - 4, Math.max(3, (size - inset * 2) * .18), 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  function drawBoard(canvas, snapshot, ghost = true) {
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#101a27"; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = "rgba(161,185,207,.075)"; ctx.lineWidth = 1;
    for (let c = 1; c < COLS; c += 1) { ctx.beginPath(); ctx.moveTo(c * CELL, 0); ctx.lineTo(c * CELL, canvas.height); ctx.stroke(); }
    for (let r = 1; r < ROWS; r += 1) { ctx.beginPath(); ctx.moveTo(0, r * CELL); ctx.lineTo(canvas.width, r * CELL); ctx.stroke(); }
    if (!snapshot) return;
    for (let r = 0; r < ROWS; r += 1) for (let c = 0; c < COLS; c += 1) {
      const color = snapshot.board[r][c]; if (color) drawCell(ctx, c * CELL, r * CELL, CELL, COLORS[color - 1]);
    }
    for (const marked of snapshot.garbageRows || []) {
      ctx.save(); ctx.strokeStyle = "#ffd05a"; ctx.lineWidth = 2; ctx.setLineDash([6, 4]);
      ctx.strokeRect(2, marked.row * CELL + 2, canvas.width - 4, CELL - 4); ctx.restore();
    }
    const active = snapshot.active;
    if (!active) return;
    const color = COLORS[active.color - 1];
    if (ghost) {
      let ghostY = active.y;
      const collision = (x, y) => active.matrix.some((row, r) => row.some((value, c) => value && (x + c < 0 || x + c >= COLS || y + r >= ROWS || (y + r >= 0 && snapshot.board[y + r][x + c]))));
      while (!collision(active.x, ghostY + 1)) ghostY += 1;
      if (ghostY !== active.y) active.matrix.forEach((row, r) => row.forEach((value, c) => { if (value && ghostY + r >= 0) drawCell(ctx, (active.x + c) * CELL, (ghostY + r) * CELL, CELL, color, .18); }));
    }
    active.matrix.forEach((row, r) => row.forEach((value, c) => { if (value && active.y + r >= 0) drawCell(ctx, (active.x + c) * CELL, (active.y + r) * CELL, CELL, color); }));
  }

  function drawMini(canvas, type, muted = false) {
    const ctx = canvas.getContext("2d"); ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!type) { ctx.fillStyle = "#647489"; ctx.font = "10px DM Sans, sans-serif"; ctx.textAlign = "center"; ctx.fillText("EMPTY", canvas.width / 2, canvas.height / 2 + 4); return; }
    const matrix = SHAPES[type]; const size = 19;
    const width = matrix[0].length * size; const height = matrix.length * size;
    const ox = (canvas.width - width) / 2; const oy = (canvas.height - height) / 2;
    matrix.forEach((row, r) => row.forEach((v, c) => { if (v) drawCell(ctx, ox + c * size, oy + r * size, size, COLORS[PIECES.indexOf(type)], muted ? .45 : 1); }));
  }

  function setOverlay(which, show, title = "", text = "") {
    const overlay = which === 1 ? ui.overlay1 : ui.overlay2;
    overlay.classList.toggle("hidden", !show);
    if (title) $(`overlay${which}Title`).textContent = title;
    if (text) $(`overlay${which}Text`).textContent = text;
  }

  function setMessage(text, persistent = false) {
    ui.gameMessage.textContent = text;
    clearTimeout(messageTimer);
    if (!persistent && text) messageTimer = setTimeout(() => { ui.gameMessage.textContent = ""; }, 2200);
  }

  function setLobbyMessage(text, error = false) {
    ui.lobbyMessage.textContent = text;
    ui.lobbyMessage.style.color = error ? "#ff9b98" : "#8292a6";
  }

  const submittedScores = new WeakSet();
  function playerName() {
    return $("playerName").value.trim().slice(0, 20) || "Player";
  }

  function displayLeaderboard(scores) {
    const list = $("leaderboardList");
    list.replaceChildren();
    if (!scores.length) {
      const empty = document.createElement("li");
      empty.className = "leaderboard-empty";
      empty.textContent = "No scores yet — set the first record!";
      list.append(empty);
      return;
    }
    for (const entry of scores.slice(0, 10)) {
      const row = document.createElement("li");
      const name = document.createElement("span");
      const score = document.createElement("span");
      name.className = "leaderboard-player";
      score.className = "leaderboard-score";
      name.textContent = entry.name;
      score.textContent = Number(entry.score).toLocaleString();
      row.append(name, score);
      list.append(row);
    }
  }

  function deviceScores() {
    try {
      const saved = JSON.parse(localStorage.getItem("dd-tetris-device-scores") || "[]");
      return Array.isArray(saved) ? saved.filter((entry) => entry && typeof entry.name === "string" && Number.isFinite(entry.score)) : [];
    } catch { return []; }
  }

  function saveDeviceScore(name, score) {
    const scores = deviceScores();
    const existing = scores.find((entry) => entry.name.toLowerCase() === name.toLowerCase());
    if (existing) existing.score = Math.max(existing.score, score);
    else scores.push({ name, score });
    scores.sort((a, b) => b.score - a.score);
    const topTen = scores.slice(0, 10);
    try { localStorage.setItem("dd-tetris-device-scores", JSON.stringify(topTen)); } catch { /* The round still finishes if storage is unavailable. */ }
    displayLeaderboard(topTen);
    $("leaderboardStatus").textContent = `Saved on this device for ${name}.`;
  }

  async function loadLeaderboard() {
    if (packagedApp) {
      displayLeaderboard(deviceScores());
      $("leaderboardStatus").textContent = "Device high scores are saved on this phone.";
      return;
    }
    try {
      const response = await fetch("/api/leaderboard", { cache: "no-store" });
      if (!response.ok) throw new Error("Leaderboard unavailable");
      const data = await response.json();
      displayLeaderboard(Array.isArray(data.scores) ? data.scores : []);
      $("leaderboardStatus").textContent = "Scores are shared by players using this game server.";
    } catch {
      $("leaderboardList").innerHTML = '<li class="leaderboard-empty">Start the game server to load scores.</li>';
      $("leaderboardStatus").textContent = "Scores will appear here when the server is available.";
    }
  }

  async function saveRunScore(player, engine) {
    if (submittedScores.has(engine) || engine.score <= 0) return;
    submittedScores.add(engine);
    const name = playerName() + (mode === "local" ? ` P${player}` : "");
    if (packagedApp) { saveDeviceScore(name, engine.score); return; }
    try {
      const response = await fetch("/api/leaderboard", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, score: engine.score }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not save score");
      displayLeaderboard(Array.isArray(data.scores) ? data.scores : []);
      $("leaderboardStatus").textContent = `Score saved for ${name}.`;
    } catch {
      $("leaderboardStatus").textContent = "Could not save score. Make sure the game server is running.";
    }
  }

  const CLEAR_LABELS = ["", "NICE!", "GREAT!", "SPECTACULAR!", "DD TETRIS!"];

  function attachBoardEffects(canvas, player) {
    const shell = canvas.parentElement;
    const effectCanvas = document.createElement("canvas");
    effectCanvas.className = "board-fx";
    effectCanvas.width = canvas.width;
    effectCanvas.height = canvas.height;
    effectCanvas.setAttribute("aria-hidden", "true");
    const toast = document.createElement("div");
    toast.className = "clear-toast";
    toast.setAttribute("aria-live", "polite");
    shell.append(effectCanvas, toast);
    boardEffects.set(player, { canvas: effectCanvas, ctx: effectCanvas.getContext("2d"), toast, particles: [], animation: 0, toastTimer: 0 });
  }

  function celebrateClear(player, rows, count) {
    const effect = boardEffects.get(player);
    if (!effect) return;
    const ctx = effect.ctx;
    const colors = rows.flatMap(({ row, colors: rowColors }) => rowColors
      .map((color, col) => color ? { color: COLORS[color - 1], x: (col + .5) * CELL, y: (row + .5) * CELL } : null)
      .filter(Boolean));
    for (const block of colors) {
      for (let i = 0; i < 5; i += 1) {
        const angle = Math.random() * Math.PI * 2;
        const speed = 35 + Math.random() * 125;
        effect.particles.push({ x: block.x, y: block.y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed - 25,
          life: .45 + Math.random() * .45, age: 0, size: 2 + Math.random() * 4, color: block.color });
      }
    }
    effect.toast.textContent = CLEAR_LABELS[Math.min(count, CLEAR_LABELS.length - 1)];
    effect.toast.classList.remove("show");
    void effect.toast.offsetWidth;
    effect.toast.classList.add("show");
    clearTimeout(effect.toastTimer);
    effect.toastTimer = setTimeout(() => effect.toast.classList.remove("show"), 1050);
    if (effect.animation) return;
    let previous = performance.now();
    const animate = (now) => {
      const dt = Math.min((now - previous) / 1000, .04);
      previous = now;
      ctx.clearRect(0, 0, effect.canvas.width, effect.canvas.height);
      effect.particles = effect.particles.filter((p) => p.age < p.life);
      for (const p of effect.particles) {
        p.age += dt; p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 230 * dt; p.vx *= .985;
        ctx.globalAlpha = Math.max(0, 1 - p.age / p.life);
        ctx.fillStyle = p.color;
        ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
      }
      ctx.globalAlpha = 1;
      if (effect.particles.length) effect.animation = requestAnimationFrame(animate);
      else { effect.animation = 0; ctx.clearRect(0, 0, effect.canvas.width, effect.canvas.height); }
    };
    effect.animation = requestAnimationFrame(animate);
  }

  function updateStats() {
    const s1 = game1?.snapshot();
    if (s1) {
      $("score1").textContent = String(s1.score).padStart(6, "0");
      $("lines1").textContent = String(s1.lines).padStart(2, "0");
      $("level1").textContent = String(s1.level).padStart(2, "0");
      drawBoard(ui.board1, s1);
      drawMini(ui.next, game1.queue[0]);
      drawMini(ui.hold, game1.held);
    }
    let s2 = null;
    if (mode === "local" && game2) s2 = game2.snapshot();
    if (mode === "online") s2 = opponentSnapshot;
    if (s2) {
      $("score2").textContent = String(s2.score || 0).padStart(6, "0");
      $("lines2").textContent = String(s2.lines || 0).padStart(2, "0");
      $("level2").textContent = String(s2.level || 1).padStart(2, "0");
      drawBoard(ui.board2, s2, false);
    }
  }

  function gameOverFor(player, engine) {
    saveRunScore(player, engine);
    if (mode === "solo") {
      setOverlay(1, true, "Run complete", `Score ${engine.score.toLocaleString()} · Tap menu for another round.`);
      setMessage("Good run! Ready for another?", true);
    } else if (mode === "local") {
      const winner = player === 1 ? "Player 2" : "Player 1";
      setOverlay(player, true, "Top out!", "Your board filled up.");
      setOverlay(player === 1 ? 2 : 1, true, `${winner} wins!`, "Take a breath, then rematch.");
      setMessage(`${winner} wins the duel!`, true);
    } else {
      send({ type: "ended", score: engine.score });
      setOverlay(1, true, "Run complete", "Your board filled up.");
      setMessage("Round over. Head back to the menu for a rematch.", true);
    }
  }

  function createGames() {
    opponentSnapshot = null; localPaused = false;
    game1 = new FallingBlocks((amount, options = {}) => {
      const tag = options.retaliable ? { id: `${Date.now()}-${Math.random()}`, expiresAt: Date.now() + 20000 } : null;
      if (mode === "local") game2?.addGarbage(amount, tag);
      else if (mode === "online") send({ type: "attack", lines: amount, retaliable: Boolean(tag) });
      if (tag) setMessage("DD TETRIS! Clear the marked line within 20 seconds to send it back!");
      else if (amount) setMessage(`Sent ${amount} surprise line${amount > 1 ? "s" : ""}!`);
    }, (engine) => gameOverFor(1, engine), updateStats, (rows, count) => celebrateClear(1, rows, count), () => {
      if (mode === "local") game2?.addGarbage(1);
      else if (mode === "online") send({ type: "returnAttack" });
      setMessage("Returned! Your opponent gets a line!");
    });
    if (mode === "local") game2 = new FallingBlocks((amount, options = {}) => {
      const tag = options.retaliable ? { id: `${Date.now()}-${Math.random()}`, expiresAt: Date.now() + 20000 } : null;
      game1?.addGarbage(amount, tag);
      if (tag) setMessage("DD TETRIS! Clear the marked line within 20 seconds to send it back!");
      else if (amount) setMessage(`Sent ${amount} surprise line${amount > 1 ? "s" : ""}!`);
    }, (engine) => gameOverFor(2, engine), updateStats, (rows, count) => celebrateClear(2, rows, count), () => {
      game1?.addGarbage(1);
      setMessage("Returned! Your opponent gets a line!");
    });
    else game2 = null;
    setOverlay(1, false); setOverlay(2, mode === "online", "Waiting for a player", "Share your room code to invite them.");
    updateStats();
  }

  function openGame(nextMode) {
    mode = nextMode; roomCode = ""; game1 = null; game2 = null; opponentSnapshot = null; localPaused = false;
    document.body.dataset.gameMode = nextMode;
    window.DDTetrisAndroid?.setImmersive(true);
    ui.lobby.classList.add("hidden"); ui.game.classList.remove("hidden");
    ui.opponentPanel.classList.toggle("hidden", nextMode === "solo");
    ui.touchDeck2.classList.toggle("hidden", nextMode !== "local");
    ui.versusColumn.classList.toggle("hidden", nextMode === "solo");
    ui.roomBadge.classList.add("hidden");
    $("modeLabel").textContent = nextMode === "solo" ? "SOLO RUN" : nextMode === "local" ? "LOCAL DUEL" : "ONLINE PARTY";
    $("gameTitle").textContent = nextMode === "solo" ? "Your next best run." : nextMode === "local" ? "Same keyboard. One winner." : "A friend is one code away.";
    $("selfName").textContent = nextMode === "local" ? "Player 1" : "You";
    $("selfStatus").textContent = nextMode === "online" ? "Connecting…" : "Ready when you are";
    $("opponentName").textContent = nextMode === "online" ? "Friend" : "Player 2";
    $("opponentStatus").textContent = nextMode === "online" ? "Waiting to join" : "On the same keyboard";
    $("opponentTag").textContent = nextMode === "local" ? "PLAYER 2" : "OPPONENT";
    $("connectionStatus").innerHTML = `<i></i><span>${nextMode === "online" ? "CONNECTING" : nextMode === "local" ? "LOCAL" : "SOLO"}</span>`;
    $("controlsText").innerHTML = nextMode === "local"
      ? '<div class="control-row"><span>P1 move / rotate</span><span class="keycap">A D W</span></div><div class="control-row"><span>P1 drop / hold</span><span class="keycap">SHIFT Q</span></div><div class="control-row"><span>P2 move / rotate</span><span class="keycap">← → ↑</span></div><div class="control-row"><span>P2 drop / hold</span><span class="keycap">ENTER /</span></div>'
      : '<div class="control-row"><span>Move</span><span class="keycap">← →</span></div><div class="control-row"><span>Rotate</span><span class="keycap">↑ / X</span></div><div class="control-row"><span>Soft / hard drop</span><span class="keycap">↓ SPACE</span></div><div class="control-row"><span>Hold piece</span><span class="keycap">C</span></div>';
    if (nextMode !== "online") {
      createGames();
      running = true;
      lastFrame = performance.now();
    }
  }

  function backToMenu() {
    running = false; localPaused = false;
    delete document.body.dataset.gameMode;
    window.DDTetrisAndroid?.setImmersive(false);
    if (socket) { socket.onclose = null; socket.close(); socket = null; }
    roomCode = ""; game1 = null; game2 = null; opponentSnapshot = null;
    ui.game.classList.add("hidden"); ui.lobby.classList.remove("hidden");
    setLobbyMessage("Online play needs the game server to be running.");
    loadLeaderboard();
  }

  function send(data) {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(data));
  }

  function multiplayerSocketUrl() {
    if (!packagedApp) {
      if (location.protocol === "file:") throw new Error("Open DD Tetris from the game server address to play online.");
      return `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws`;
    }
    const value = $("serverAddress").value.trim();
    if (!value) throw new Error("Enter the same game server address on both phones. Start the DD Tetris server on a computer first.");
    const address = /^[a-z]+:\/\//i.test(value) ? value : `https://${value}`;
    let parsed;
    try { parsed = new URL(address); } catch { throw new Error("Enter a valid secure game server address beginning with https://."); }
    if (!["https:", "wss:"].includes(parsed.protocol) || !parsed.host) {
      throw new Error("The mobile app needs a secure server address beginning with https:// or wss://.");
    }
    return `wss://${parsed.host}/ws`;
  }

  function onlineConnect(action, code = "") {
    let url;
    try { url = multiplayerSocketUrl(); }
    catch (error) { setLobbyMessage(error.message, true); return; }
    if (socket && socket.readyState < WebSocket.CLOSING) { socket.close(); socket = null; }
    openGame("online");
    $("selfStatus").textContent = "Connecting to room…";
    setOverlay(1, true, "Joining the party", "Connecting to the game server…");
    try { socket = new WebSocket(url); } catch {
      backToMenu(); setLobbyMessage("Could not connect. Make sure the game server is running.", true); return;
    }
    const intendedAction = action;
    const intendedCode = code;
    socket.addEventListener("open", () => { send({ type: intendedAction, code: intendedCode, name: playerName() }); });
    socket.addEventListener("message", (event) => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      handleServerMessage(message);
    });
    socket.addEventListener("close", () => {
      if (mode === "online" && running) {
        setMessage("Connection closed. Your round is paused.", true);
        localPaused = true;
      }
    });
    socket.addEventListener("error", () => {
      setOverlay(1, true, "Can’t connect", "Check the server address and try again.");
    });
  }

  function handleServerMessage(message) {
    if (message.type === "created") {
      roomCode = message.code;
      $("roomCodeLabel").textContent = roomCode;
      ui.roomBadge.classList.remove("hidden");
      $("selfStatus").textContent = "Room open — invite a friend";
      setOverlay(2, true, "Waiting for a player", "Share your room code to invite them.");
      $("connectionStatus").innerHTML = "<i></i><span>ROOM OPEN</span>";
      return;
    }
    if (message.type === "joined") {
      roomCode = message.code;
      $("roomCodeLabel").textContent = roomCode;
      ui.roomBadge.classList.remove("hidden");
      $("opponentName").textContent = message.opponent || "Friend";
      $("opponentStatus").textContent = "Connected";
      $("selfStatus").textContent = "Party connected";
      $("connectionStatus").innerHTML = "<i></i><span>CONNECTED</span>";
      setOverlay(2, true, "Party up!", "Starting your round…");
      return;
    }
    if (message.type === "playerJoined") {
      $("opponentName").textContent = message.name || "Friend";
      $("opponentStatus").textContent = "Connected";
      $("selfStatus").textContent = "Party connected";
      $("connectionStatus").innerHTML = "<i></i><span>CONNECTED</span>";
      return;
    }
    if (message.type === "start") {
      createGames(); running = true; localPaused = false; lastFrame = performance.now();
      $("selfStatus").textContent = "You’re in the round";
      $("opponentStatus").textContent = "You’re in the round";
      $("connectionStatus").innerHTML = "<i></i><span>LIVE</span>";
      setOverlay(2, true, "Ready, set…", "Have fun and watch for surprises.");
      setTimeout(() => setOverlay(2, false), 1000);
      setOverlay(1, true, "Ready, set…", "Your round starts now.");
      setTimeout(() => setOverlay(1, false), 1000);
      return;
    }
    if (message.type === "state") {
      opponentSnapshot = message.snapshot;
      if (message.name) $("opponentName").textContent = message.name;
      updateStats();
      return;
    }
    if (message.type === "attack") {
      const retaliable = Boolean(message.retaliable);
      const tag = retaliable ? { id: `${Date.now()}-${Math.random()}`, expiresAt: Date.now() + 20000 } : null;
      game1?.addGarbage(Math.max(1, Math.min(8, Number(message.lines) || 1)), tag);
      setMessage(retaliable ? "DD TETRIS! Clear the marked line within 20 seconds to send it back!" : "Your friend sent a surprise line!");
      return;
    }
    if (message.type === "returnAttack") {
      game1?.addGarbage(1);
      setMessage("Returned! Your friend gets a line!");
      return;
    }
    if (message.type === "opponentEnded") {
      $("opponentStatus").textContent = "Round over";
      setOverlay(2, true, "Friend topped out", "Your round is still going!");
      return;
    }
    if (message.type === "opponentLeft") {
      $("opponentStatus").textContent = "Disconnected";
      setOverlay(2, true, "Friend left", "You can head back to the menu.");
      setMessage("Your friend left the room.", true);
      return;
    }
    if (message.type === "error") {
      backToMenu(); setLobbyMessage(message.message || "Couldn’t join that room.", true);
    }
  }

  function frame(now) {
    requestAnimationFrame(frame);
    if (!running || !game1) return;
    const dt = Math.min((now - lastFrame) / 1000, .05); lastFrame = now;
    game1.update(dt); game2?.update(dt);
    if (mode === "online" && !localPaused) {
      syncElapsed += dt;
      if (syncElapsed > .2) { syncElapsed = 0; send({ type: "state", snapshot: game1.snapshot(), name: "Friend" }); }
    }
  }

  function togglePause() {
    if (!running || !game1) return;
    if (mode === "online") { setMessage("Online rounds keep going while you play.", false); return; }
    localPaused = !localPaused;
    $("pauseButton").innerHTML = localPaused ? "▶ <span>Resume</span>" : "Ⅱ <span>Pause</span>";
    if (localPaused) {
      ui.game.classList.add("paused"); setOverlay(1, true, "Paused", "Take your time.");
      if (mode === "local") setOverlay(2, true, "Paused", "Both boards are paused.");
    } else {
      ui.game.classList.remove("paused"); setOverlay(1, false); if (mode === "local") setOverlay(2, false);
      lastFrame = performance.now();
    }
  }

  function action(engine, actionName) {
    if (!engine || !engine.alive || localPaused) return;
    if (actionName === "left") engine.move(-1, 0);
    else if (actionName === "right") engine.move(1, 0);
    else if (actionName === "down") engine.move(0, 1);
    else if (actionName === "rotate") engine.rotate(1);
    else if (actionName === "rotateBack") engine.rotate(-1);
    else if (actionName === "drop") engine.hardDrop();
    else if (actionName === "hold") engine.holdPiece();
    updateStats();
  }

  window.addEventListener("keydown", (event) => {
    if (!running) return;
    const key = event.code;
    if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Space"].includes(key)) event.preventDefault();
    if (key === "Escape") return togglePause();
    if (mode === "local") {
      const p1 = { KeyA: "left", KeyD: "right", KeyS: "down", KeyW: "rotate", ShiftLeft: "drop", KeyQ: "hold", KeyE: "rotateBack" };
      const p2 = { ArrowLeft: "left", ArrowRight: "right", ArrowDown: "down", ArrowUp: "rotate", Enter: "drop", Slash: "hold", Period: "rotateBack" };
      if (p1[key]) action(game1, p1[key]);
      else if (p2[key]) action(game2, p2[key]);
      return;
    }
    const keys = { ArrowLeft: "left", ArrowRight: "right", ArrowDown: "down", ArrowUp: "rotate", KeyX: "rotate", KeyZ: "rotateBack", Space: "drop", KeyC: "hold" };
    if (keys[key]) action(game1, keys[key]);
  });

  $("soloButton").addEventListener("click", () => openGame("solo"));
  $("localButton").addEventListener("click", () => openGame("local"));
  $("createButton").addEventListener("click", () => onlineConnect("create"));
  $("serverAddress").addEventListener("change", () => {
    try { localStorage.setItem("dd-tetris-server-address", $("serverAddress").value.trim()); } catch { /* Address still works for this session. */ }
  });
  $("joinForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const code = $("roomInput").value.trim().toUpperCase();
    if (code.length !== 6) { setLobbyMessage("Room codes have six characters.", true); return; }
    onlineConnect("join", code);
  });
  $("backButton").addEventListener("click", backToMenu);
  $("pauseButton").addEventListener("click", togglePause);
  document.querySelectorAll(".touch-controls button").forEach((button) => {
    const actionName = button.dataset.action;
    const activeGame = () => button.dataset.player === "2" ? game2 : game1;
    if (["left", "right", "down"].includes(actionName)) {
      let delayTimer = 0;
      let repeatTimer = 0;
      const stopRepeat = () => { clearTimeout(delayTimer); clearInterval(repeatTimer); delayTimer = 0; repeatTimer = 0; };
      button.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        stopRepeat();
        action(activeGame(), actionName);
        button.setPointerCapture(event.pointerId);
        delayTimer = setTimeout(() => { repeatTimer = setInterval(() => action(activeGame(), actionName), 95); }, 210);
      });
      button.addEventListener("pointerup", stopRepeat);
      button.addEventListener("pointercancel", stopRepeat);
      button.addEventListener("lostpointercapture", stopRepeat);
    } else button.addEventListener("click", () => action(activeGame(), actionName));
  });
  $("copyRoomButton").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(roomCode); setMessage("Room code copied!"); }
    catch { setMessage(`Room code: ${roomCode}`, true); }
  });
  try { $("playerName").value = localStorage.getItem("dd-tetris-player-name") || ""; } catch { /* Private browsing can block storage. */ }
  $("playerName").addEventListener("change", () => {
    try { localStorage.setItem("dd-tetris-player-name", playerName()); } catch { /* Name still works for this session. */ }
  });
  window.addEventListener("focus", loadLeaderboard);
  loadLeaderboard();
  let installPrompt = null;
  const installButton = $("installButton");
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    installPrompt = event;
    installButton.hidden = false;
  });
  installButton.addEventListener("click", async () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    await installPrompt.userChoice;
    installPrompt = null;
    installButton.hidden = true;
  });
  window.addEventListener("appinstalled", () => { installButton.hidden = true; });
  if ("serviceWorker" in navigator && location.protocol !== "file:" && !packagedApp) {
    navigator.serviceWorker.register("/service-worker.js").catch(() => {});
  }
  drawMini(ui.next, null); drawMini(ui.hold, null);
  attachBoardEffects(ui.board1, 1);
  attachBoardEffects(ui.board2, 2);
  requestAnimationFrame(frame);
})();
