
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const WebSocket = require("ws");

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 10;
const MAX_BOTS = 30;

const rooms = new Map();
const clients = new Map();

const server = http.createServer((req, res) => {
  const pathname = new URL(
    req.url, `http://${req.headers.host || "localhost"}`
  ).pathname;

  if (pathname !== "/") {
    res.writeHead(404);
    return res.end("Not found");
  }

  fs.readFile(path.join(__dirname, "index.html"), (err, data) => {
    if (err) {
      res.writeHead(500);
      return res.end("index.html is missing");
    }

    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8"
    });
    res.end(data);
  });
});

const wss = new WebSocket.Server({ server });

function send(ws, data) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function broadcast(room, data) {
  for (const id of room.players.keys()) {
    const ws = clients.get(id);
    if (ws) send(ws, data);
  }
}

function newCode() {
  let code;
  do {
    code = String(100000 + crypto.randomInt(900000));
  } while (rooms.has(code));
  return code;
}

function makeBot(i) {
  return {
    id: "bot-" + crypto.randomUUID(),
    name: "BOT " + (i + 1),
    team: i % 2 === 0 ? "Blue" : "Red",
    x: 40 + Math.random() * 720,
    y: 40 + Math.random() * 520,
    angle: 0,
    hp: 100,
    score: 0,
    alive: true
  };
}

function state(room) {
  return {
    type: "state",
    code: room.code,
    started: room.started,
    hostId: room.hostId,
    players: [...room.players.values()],
    bots: room.bots
  };
}

function getRoom(ws) {
  const room = rooms.get(ws.roomCode);
  if (!room || !room.players.has(ws.playerId)) return null;
  return room;
}

function removePlayer(ws) {
  if (!ws.playerId) return;

  clients.delete(ws.playerId);
  const room = rooms.get(ws.roomCode);
  if (!room) return;

  room.players.delete(ws.playerId);

  if (room.players.size === 0) {
    rooms.delete(room.code);
    return;
  }

  if (room.hostId === ws.playerId) {
    room.hostId = room.players.keys().next().value;
  }

  broadcast(room, state(room));
}

wss.on("connection", ws => {
  ws.on("message", raw => {
    let msg;

    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return send(ws, {
        type: "error",
        message: "پیام نامعتبر است"
      });
    }

    if (msg.type === "create") {
      if (ws.playerId) {
        return send(ws, {
          type: "error",
          message: "شما قبلاً وارد اتاق شده‌اید"
        });
      }

      const id = crypto.randomUUID();
      const code = newCode();
      const room = {
        code,
        hostId: id,
        started: false,
        players: new Map(),
        bots: []
      };

      room.players.set(id, {
        id,
        name: String(msg.name || "PLAYER").slice(0, 18),
        team: "Red",
        x: 400,
        y: 300,
        angle: 0,
        hp: 100,
        score: 0,
        alive: true
      });

      rooms.set(code, room);
      clients.set(id, ws);
      ws.playerId = id;
      ws.roomCode = code;

      send(ws, { type: "joined", id, code, host: true });
      broadcast(room, state(room));
      return;
    }

    if (msg.type === "join") {
      const room = rooms.get(String(msg.code || ""));

      if (!room) {
        return send(ws, {
          type: "error",
          message: "اتاق پیدا نشد"
        });
      }

      if (room.started || room.players.size >= MAX_PLAYERS) {
        return send(ws, {
          type: "error",
          message: "اتاق شروع شده یا ظرفیت آن پر است"
        });
      }

      if (ws.playerId) return;

      const id = crypto.randomUUID();

      room.players.set(id, {
        id,
        name: String(msg.name || "PLAYER").slice(0, 18),
        team: "Blue",
        x: 100 + Math.random() * 600,
        y: 100 + Math.random() * 400,
        angle: 0,
        hp: 100,
        score: 0,
        alive: true
      });

      clients.set(id, ws);
      ws.playerId = id;
      ws.roomCode = room.code;

      send(ws, { type: "joined", id, code: room.code, host: false });
      broadcast(room, state(room));
      return;
    }

    const room = getRoom(ws);
    if (!room) return;

    const player = room.players.get(ws.playerId);

    if (msg.type === "team" && !room.started) {
      if (msg.team !== "Red" && msg.team !== "Blue") return;
      player.team = msg.team;
      broadcast(room, state(room));
    }

    if (msg.type === "bots" && !room.started &&
        room.hostId === player.id) {
      const count = Math.max(
        0,
        Math.min(MAX_BOTS, Math.floor(Number(msg.count) || 0))
      );

      room.bots = Array.from({ length: count }, (_, i) => makeBot(i));
      broadcast(room, state(room));
    }

    if (msg.type === "start" && room.hostId === player.id) {
      room.started = true;
      broadcast(room, state(room));
    }

    if (msg.type === "move" && room.started && player.alive) {
      const x = Number(msg.x);
      const y = Number(msg.y);
      const angle = Number(msg.angle);

      if (![x, y, angle].every(Number.isFinite)) return;

      // محدودیت سرعت برای جلوگیری از حرکت غیرعادی
      const dx = Math.max(-18, Math.min(18, x - player.x));
      const dy = Math.max(-18, Math.min(18, y - player.y));

      player.x = Math.max(12, Math.min(788, player.x + dx));
      player.y = Math.max(12, Math.min(588, player.y + dy));
      player.angle = angle;
      broadcast(room, state(room));
    }

    if (msg.type === "shoot" && room.started && player.alive) {
      const targetId = String(msg.target || "");
      const target = room.players.get(targetId) ||
        room.bots.find(bot => bot.id === targetId);

      if (!target || !target.alive || target.team === player.team) return;

      const distance = Math.hypot(
        target.x - player.x,
        target.y - player.y
      );

      if (distance > 180) return;

      target.hp = Math.max(0, target.hp - 25);

      if (target.hp === 0) {
        target.alive = false;
        player.score++;
      }

      broadcast(room, state(room));
    }
  });

  ws.on("close", () => removePlayer(ws));
  ws.on("error", () => removePlayer(ws));
});

setInterval(() => {
  for (const room of rooms.values()) {
    if (!room.started) continue;

    const living = [
      ...room.players.values(),
      ...room.bots
    ].filter(p => p.alive);

    for (const bot of room.bots) {
      if (!bot.alive) continue;

      const targets = living.filter(p =>
        p.id !== bot.id && p.team !== bot.team
      );

      if (!targets.length) continue;

      targets.sort((a, b) =>
        Math.hypot(a.x - bot.x, a.y - bot.y) -
        Math.hypot(b.x - bot.x, b.y - bot.y)
      );

      const target = targets[0];
      const dx = target.x - bot.x;
      const dy = target.y - bot.y;
      const distance = Math.hypot(dx, dy) || 1;

      bot.angle = Math.atan2(dy, dx);

      if (distance > 100) {
        bot.x += dx / distance * 1.2;
        bot.y += dy / distance * 1.2;
      } else if (Math.random() < 0.025) {
        target.hp = Math.max(0, target.hp - 10);

        if (target.hp === 0) {
          target.alive = false;
          bot.score++;
        }
      }

      bot.x = Math.max(12, Math.min(788, bot.x));
      bot.y = Math.max(12, Math.min(588, bot.y));
    }

    broadcast(room, state(room));
  }
}, 100);

server.listen(PORT, "0.0.0.0", () => {
  console.log(`DOOM PIXEL server listening on ${PORT}`);
});
