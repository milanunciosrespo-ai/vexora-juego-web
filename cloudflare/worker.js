const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Cache-Control": "no-store",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
    if (url.pathname === "/health") return json({ ok: true, service: "VEXORA online", version: "0.0.4" });
    if (!url.pathname.startsWith("/api/") && url.pathname !== "/ws") return json({ error: "Ruta no encontrada" }, 404);
    const id = env.VEXORA_ROOM.idFromName("global-room");
    return env.VEXORA_ROOM.get(id).fetch(request);
  },
};

export class VexoraRoom {
  constructor(ctx) {
    this.ctx = ctx;
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS rankings (
      player_id TEXT NOT NULL,
      game TEXT NOT NULL,
      name TEXT NOT NULL,
      time REAL NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (player_id, game)
    )`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS chat (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      player_id TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS players (
      player_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      last_seen INTEGER NOT NULL
    )`);
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/ws") return this.connect(request);
    if (request.method === "GET" && url.pathname === "/api/rankings") {
      const game = url.searchParams.get("game") || "";
      if (!this.validGame(game)) return json({ error: "Modo no válido" }, 400);
      const entries = this.sql.exec(
        "SELECT player_id AS id, name, game, time FROM rankings WHERE game = ? ORDER BY time ASC LIMIT 100",
        game,
      ).toArray();
      return json({ entries });
    }
    if (request.method === "POST" && url.pathname === "/api/rankings") {
      const body = await this.readBody(request);
      if (!body) return json({ error: "Petición no válida" }, 400);
      const { id, name, game, time } = body;
      if (!this.validId(id) || !this.validName(name) || !this.validGame(game) ||
          typeof time !== "number" || !Number.isFinite(time) || time <= 0 || time > 3600) {
        return json({ error: "Récord no válido" }, 400);
      }
      this.sql.exec(
        `INSERT INTO rankings (player_id, game, name, time, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(player_id, game) DO UPDATE SET
         name = excluded.name, time = MIN(rankings.time, excluded.time), updated_at = excluded.updated_at`,
        id, game, name.trim().slice(0, 16), time, Date.now(),
      );
      return json({ ok: true });
    }
    if (request.method === "POST" && url.pathname === "/api/name") {
      const body = await this.readBody(request);
      if (!body || !this.validId(body.id) || !this.validName(body.name)) return json({ error: "Nombre no válido" }, 400);
      this.sql.exec("UPDATE rankings SET name = ?, updated_at = ? WHERE player_id = ?", body.name.trim().slice(0, 16), Date.now(), body.id);
      return json({ ok: true });
    }
    if (request.method === "GET" && url.pathname === "/api/chat") {
      return json(this.chatSnapshot());
    }
    if (request.method === "POST" && url.pathname === "/api/chat") {
      const body = await this.readBody(request);
      if (!body || !this.validId(body.id) || !this.validName(body.name)) return json({ error: "Perfil no válido" }, 400);
      this.touchPlayer(body.id, body.name);
      let sent = "";
      if (typeof body.text === "string" && body.text.trim()) {
        const text = body.text.trim().slice(0, 240);
        sent = typeof body.nonce === "string" ? body.nonce.slice(0, 80) : "";
        this.storeMessage(body.id, body.name, text);
        this.broadcast({ type: "message", message: { id: body.id, name: body.name.trim().slice(0, 16), text, createdAt: new Date().toISOString() } });
      }
      return json({ ...this.chatSnapshot(), sent });
    }
    return json({ error: "Ruta no encontrada" }, 404);
  }

  connect(request) {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return json({ error: "WebSocket requerido" }, 426);
    const origin = request.headers.get("Origin") || "";
    if (origin && origin !== "https://milanunciosrespo-ai.github.io" &&
        !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
      return json({ error: "Origen no permitido" }, 403);
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    const messages = this.sql.exec("SELECT player_id AS id, name, text, created_at AS createdAt FROM chat ORDER BY id DESC LIMIT 50").toArray().reverse();
    server.send(JSON.stringify({ type: "history", messages }));
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(socket, raw) {
    if (typeof raw !== "string" || raw.length > 2048) return;
    let body;
    try { body = JSON.parse(raw); } catch { return; }
    if (body.type === "presence") {
      if (this.validId(body.id) && this.validName(body.name)) {
        this.touchPlayer(body.id, body.name);
        socket.send(JSON.stringify({ type: "presence", ok: true }));
      }
      return;
    }
    if (!this.validId(body.id) || !this.validName(body.name) || typeof body.text !== "string") return;
    const name = body.name.trim().slice(0, 16);
    const text = body.text.trim().slice(0, 240);
    if (!text) return;
    this.touchPlayer(body.id, name);
    const message = { id: body.id, name, text, createdAt: new Date().toISOString() };
    this.storeMessage(body.id, name, text, message.createdAt);
    this.broadcast({ type: "message", message });
  }

  touchPlayer(id, name) {
    this.sql.exec("INSERT INTO players (player_id, name, last_seen) VALUES (?, ?, ?) ON CONFLICT(player_id) DO UPDATE SET name = excluded.name, last_seen = excluded.last_seen", id, name.trim().slice(0, 16), Date.now());
  }

  storeMessage(id, name, text, createdAt = new Date().toISOString()) {
    this.sql.exec("INSERT INTO chat (player_id, name, text, created_at) VALUES (?, ?, ?, ?)", id, name.trim().slice(0, 16), text, createdAt);
    this.sql.exec("DELETE FROM chat WHERE id NOT IN (SELECT id FROM chat ORDER BY id DESC LIMIT 200)");
  }

  broadcast(message) {
    const payload = JSON.stringify(message);
    for (const peer of this.ctx.getWebSockets()) {
      try { peer.send(payload); } catch { /* Closed clients are removed by the platform. */ }
    }
  }

  chatSnapshot() {
    const messages = this.sql.exec("SELECT player_id AS id, name, text, created_at AS createdAt FROM chat ORDER BY id DESC LIMIT 50").toArray().reverse();
    const users = this.sql.exec("SELECT player_id AS id, name FROM players WHERE last_seen > ? ORDER BY name LIMIT 100", Date.now() - 90000).toArray();
    return { messages, users };
  }

  webSocketClose() {}

  async readBody(request) {
    const length = Number(request.headers.get("Content-Length") || 0);
    if (length > 4096) return null;
    try { return await request.json(); } catch { return null; }
  }

  validId(value) { return typeof value === "string" && /^[a-zA-Z0-9_-]{3,80}$/.test(value); }
  validName(value) { return typeof value === "string" && value.trim().length > 0 && value.trim().length <= 32; }
  validGame(value) { return ["level-1", "level-2", "cells", "drone-rush"].includes(value); }
}
