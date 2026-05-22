const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const PORT = Number(process.env.PORT || 8001);
const ROOT = __dirname;
const players = new Map();

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
  ".css": "text/css; charset=utf-8"
};

const server = http.createServer((request, response) => {
  const requestUrl = new URL(request.url, `http://${request.headers.host}`);
  const pathname = requestUrl.pathname === "/" ? "/Maliks_Game_ijy.html" : requestUrl.pathname;
  const filePath = path.normalize(path.join(ROOT, pathname));

  if (!filePath.startsWith(ROOT)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, contents) => {
    if (error) {
      response.writeHead(404);
      response.end("Not found");
      return;
    }

    response.writeHead(200, {
      "Content-Type": mimeTypes[path.extname(filePath)] || "application/octet-stream"
    });
    response.end(contents);
  });
});

server.on("upgrade", (request, socket) => {
  if (request.url !== "/multiplayer") {
    socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
    return;
  }

  const key = request.headers["sec-websocket-key"];
  const accept = crypto
    .createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");

  socket.write([
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${accept}`,
    "",
    ""
  ].join("\r\n"));

  const id = crypto.randomUUID();
  const player = {
    id,
    name: "Player",
    jumpHeight: 0,
    runStep: 0,
    stars: 0,
    score: 0,
    level: 1,
    running: false
  };

  players.set(id, { socket, player, buffer: Buffer.alloc(0) });
  send(socket, {
    type: "welcome",
    id,
    players: [...players.values()].map((entry) => entry.player)
  });

  socket.on("data", (buffer) => {
    const entry = players.get(id);

    if (!entry) {
      return;
    }

    const parsed = parseFrames(Buffer.concat([entry.buffer, buffer]));
    entry.buffer = parsed.remaining;

    for (const message of parsed.messages) {
      handleMessage(id, message);
    }
  });

  socket.on("close", () => removePlayer(id));
  socket.on("error", () => removePlayer(id));
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Malik's Star Run multiplayer server: http://localhost:${PORT}`);
});

function handleMessage(id, message) {
  const entry = players.get(id);

  if (!entry) {
    return;
  }

  if (message.type === "join") {
    entry.player.name = cleanName(message.name);
  }

  if (message.type === "state") {
    entry.player = {
      ...entry.player,
      name: cleanName(message.name),
      jumpHeight: clamp(Number(message.jumpHeight) || 0, 0, 220),
      runStep: Number(message.runStep) || 0,
      stars: clamp(Math.floor(Number(message.stars) || 0), 0, 999),
      score: clamp(Math.floor(Number(message.score) || 0), 0, 999999),
      level: clamp(Math.floor(Number(message.level) || 1), 1, 999),
      running: Boolean(message.running)
    };
  }

  broadcast({
    type: "player_update",
    player: entry.player
  }, id);
}

function removePlayer(id) {
  const entry = players.get(id);

  if (!entry) {
    return;
  }

  players.delete(id);
  entry.socket.destroy();
  broadcast({
    type: "player_leave",
    id
  });
}

function broadcast(message, exceptId = null) {
  const data = encodeFrame(JSON.stringify(message));

  for (const [id, entry] of players) {
    if (id !== exceptId) {
      entry.socket.write(data);
    }
  }
}

function send(socket, message) {
  socket.write(encodeFrame(JSON.stringify(message)));
}

function parseFrames(buffer) {
  const messages = [];
  let offset = 0;

  while (offset + 2 <= buffer.length) {
    const frameStart = offset;
    const firstByte = buffer[offset];
    const secondByte = buffer[offset + 1];
    const opcode = firstByte & 0x0f;
    const masked = (secondByte & 0x80) === 0x80;
    let length = secondByte & 0x7f;
    offset += 2;

    if (length === 126) {
      if (offset + 2 > buffer.length) {
        offset = frameStart;
        break;
      }
      length = buffer.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      if (offset + 8 > buffer.length) {
        offset = frameStart;
        break;
      }
      length = Number(buffer.readBigUInt64BE(offset));
      offset += 8;
    }

    if (!masked || offset + 4 + length > buffer.length) {
      offset = frameStart;
      break;
    }

    const mask = buffer.subarray(offset, offset + 4);
    offset += 4;

    const payload = buffer.subarray(offset, offset + length);
    offset += length;

    if (opcode === 8) {
      continue;
    }

    const decoded = Buffer.alloc(length);
    for (let index = 0; index < length; index += 1) {
      decoded[index] = payload[index] ^ mask[index % 4];
    }

    try {
      messages.push(JSON.parse(decoded.toString("utf8")));
    } catch {
      // Ignore malformed messages.
    }
  }

  return {
    messages,
    remaining: buffer.subarray(offset)
  };
}

function encodeFrame(message) {
  const payload = Buffer.from(message);
  const length = payload.length;

  if (length < 126) {
    return Buffer.concat([Buffer.from([0x81, length]), payload]);
  }

  if (length < 65536) {
    const header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
    return Buffer.concat([header, payload]);
  }

  const header = Buffer.alloc(10);
  header[0] = 0x81;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(length), 2);
  return Buffer.concat([header, payload]);
}

function cleanName(name) {
  return String(name || "Player")
    .replace(/[^\w ]/g, "")
    .slice(0, 14) || "Player";
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
