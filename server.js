const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 8787);
const rooms = new Map();
const sockets = new Set();
const LEADERBOARD_FILE = path.join(ROOT, "leaderboard.json");
let leaderboard = [];
try {
  const saved = JSON.parse(fs.readFileSync(LEADERBOARD_FILE, "utf8"));
  if (Array.isArray(saved)) leaderboard = saved.filter((entry) => entry && typeof entry.name === "string" && Number.isSafeInteger(entry.score) && entry.score >= 0);
} catch { /* The server creates the score file when the first score is saved. */ }
const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".webmanifest": "application/manifest+json; charset=utf-8", ".svg": "image/svg+xml" };
const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

const server = http.createServer((req, res) => {
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname); }
  catch { res.writeHead(400); res.end("Bad request"); return; }
  if (pathname === "/healthz" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (pathname === "/api/leaderboard") return handleLeaderboard(req, res);
  if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405); res.end("Method not allowed"); return; }
  if (pathname === "/") pathname = "/index.html";
  const file = path.resolve(ROOT, `.${pathname}`);
  if (!file.startsWith(`${ROOT}${path.sep}`) && file !== path.join(ROOT, "index.html")) { res.writeHead(403); res.end("Forbidden"); return; }
  fs.readFile(file, (error, data) => {
    if (error) { res.writeHead(404); res.end("Not found"); return; }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    if (req.method === "HEAD") res.end(); else res.end(data);
  });
});

function handleLeaderboard(req, res) {
  const json = (status, body) => {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    res.end(JSON.stringify(body));
  };
  const sorted = () => leaderboard.slice().sort((a, b) => b.score - a.score || String(a.date || "").localeCompare(String(b.date || "")));
  if (req.method === "GET") { json(200, { scores: sorted().slice(0, 10) }); return; }
  if (req.method !== "POST") { json(405, { error: "Use GET or POST." }); return; }
  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
    if (body.length > 4096) { json(413, { error: "Score entry is too large." }); req.destroy(); }
  });
  req.on("end", () => {
    let submitted;
    try { submitted = JSON.parse(body); } catch { json(400, { error: "Invalid score entry." }); return; }
    const name = String(submitted.name || "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 20);
    const score = Number(submitted.score);
    if (!name || !Number.isSafeInteger(score) || score < 0 || score > 1000000000) { json(400, { error: "Enter a name and a valid score." }); return; }
    const date = new Date().toISOString();
    const existing = leaderboard.find((entry) => entry.name.toLocaleLowerCase() === name.toLocaleLowerCase());
    if (existing) {
      if (score > existing.score) { existing.score = score; existing.date = date; }
    } else leaderboard.push({ name, score, date });
    leaderboard = sorted().slice(0, 100);
    try {
      const temporaryFile = `${LEADERBOARD_FILE}.tmp`;
      fs.writeFileSync(temporaryFile, `${JSON.stringify(leaderboard, null, 2)}\n`, "utf8");
      fs.renameSync(temporaryFile, LEADERBOARD_FILE);
    } catch { json(500, { error: "Could not save the high score." }); return; }
    json(200, { scores: leaderboard.slice(0, 10) });
  });
}

function frame(opcode, payload = Buffer.alloc(0)) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  let header;
  if (body.length < 126) { header = Buffer.from([0x80 | opcode, body.length]); }
  else if (body.length < 65536) { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(body.length, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 127; header.writeBigUInt64BE(BigInt(body.length), 2); }
  return Buffer.concat([header, body]);
}

function send(client, message) {
  if (!client.destroyed) client.write(frame(1, JSON.stringify(message)));
}

function broadcast(room, message, except = null) {
  for (const client of room.players) if (client !== except) send(client, message);
}

function makeCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code;
  do { code = Array.from({ length: 6 }, () => chars[crypto.randomInt(chars.length)]).join(""); } while (rooms.has(code));
  return code;
}

function leave(client) {
  sockets.delete(client);
  if (!client.room) return;
  const room = rooms.get(client.room);
  if (!room) { client.room = null; return; }
  room.players.delete(client);
  broadcast(room, { type: "opponentLeft" });
  if (!room.players.size) rooms.delete(room.code);
  client.room = null;
}

function dispatch(client, message) {
  if (!message || typeof message.type !== "string") return;
  if (message.type === "create") {
    leave(client);
    const code = makeCode();
    const room = { code, players: new Set([client]), started: false };
    rooms.set(code, room); client.room = code;
    send(client, { type: "created", code });
    return;
  }
  if (message.type === "join") {
    leave(client);
    const code = String(message.code || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
    const room = rooms.get(code);
    if (!room) { send(client, { type: "error", message: "That room code was not found. Ask your friend to create a new room." }); return; }
    if (room.players.size >= 2) { send(client, { type: "error", message: "That room is full. DD Tetris rooms hold two players for now." }); return; }
    const host = Array.from(room.players)[0];
    room.players.add(client); client.room = code;
    send(client, { type: "joined", code, opponent: host.name || "Friend" });
    send(host, { type: "playerJoined", name: client.name || "Friend" });
    room.started = true;
    broadcast(room, { type: "start" });
    return;
  }
  const room = client.room && rooms.get(client.room);
  if (!room) { send(client, { type: "error", message: "Create or join a room first." }); return; }
  if (message.type === "state") {
    if (!message.snapshot || !Array.isArray(message.snapshot.board) || message.snapshot.board.length !== 20) return;
    broadcast(room, { type: "state", snapshot: message.snapshot, name: client.name || "Friend" }, client);
  } else if (message.type === "attack") {
    const retaliable = Boolean(message.retaliable);
    const lines = retaliable ? 1 : Math.max(1, Math.min(8, Number(message.lines) || 1));
    broadcast(room, { type: "attack", lines, retaliable }, client);
  } else if (message.type === "returnAttack") {
    broadcast(room, { type: "returnAttack" }, client);
  } else if (message.type === "ended") {
    broadcast(room, { type: "opponentEnded", score: Number(message.score) || 0 }, client);
  }
}

server.on("upgrade", (req, socket) => {
  if (req.url !== "/ws" || !req.headers["sec-websocket-key"]) { socket.destroy(); return; }
  const accept = crypto.createHash("sha1").update(req.headers["sec-websocket-key"] + GUID).digest("base64");
  socket.write(["HTTP/1.1 101 Switching Protocols", "Upgrade: websocket", "Connection: Upgrade", `Sec-WebSocket-Accept: ${accept}`, "", ""].join("\r\n"));
  socket.room = null; socket.name = "Friend"; socket.wsBuffer = Buffer.alloc(0); sockets.add(socket);
  socket.on("data", (data) => {
    socket.wsBuffer = Buffer.concat([socket.wsBuffer, data]);
    while (socket.wsBuffer.length >= 2) {
      const first = socket.wsBuffer[0]; const second = socket.wsBuffer[1];
      const opcode = first & 0x0f; const masked = (second & 0x80) !== 0;
      let length = second & 0x7f; let offset = 2;
      if (length === 126) { if (socket.wsBuffer.length < 4) return; length = socket.wsBuffer.readUInt16BE(2); offset = 4; }
      else if (length === 127) {
        if (socket.wsBuffer.length < 10) return;
        const largeLength = socket.wsBuffer.readBigUInt64BE(2);
        if (largeLength > 1048576n) { socket.destroy(); return; }
        length = Number(largeLength); offset = 10;
      }
      const maskOffset = offset;
      if (masked) offset += 4;
      if (socket.wsBuffer.length < offset + length) return;
      const payload = Buffer.from(socket.wsBuffer.subarray(offset, offset + length));
      if (masked) { const mask = socket.wsBuffer.subarray(maskOffset, maskOffset + 4); for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4]; }
      socket.wsBuffer = socket.wsBuffer.subarray(offset + length);
      if (opcode === 8) { socket.end(frame(8)); leave(socket); return; }
      if (opcode === 9) { socket.write(frame(10, payload)); continue; }
      if (opcode !== 1 || payload.length > 524288) continue;
      try {
        const message = JSON.parse(payload.toString("utf8"));
        if (message.type === "create" || message.type === "join") socket.name = String(message.name || "Friend").slice(0, 20);
        dispatch(socket, message);
      } catch { send(socket, { type: "error", message: "Couldn’t read that game message." }); }
    }
  });
  socket.on("close", () => leave(socket));
  socket.on("error", () => leave(socket));
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`DD Tetris is ready at http://localhost:${PORT}`);
  console.log("For friends on the same Wi-Fi, share this computer's local network address and the room code.");
  console.log("For play over the internet, host behind HTTPS/WSS on a trusted server.");
});
