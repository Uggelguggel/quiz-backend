// server.js
const express = require("express");
const cors = require("cors");
const Database = require("better-sqlite3");

const app = express();

/**
 * === CORS ===
 * - localhost erlaubt (Dev)
 * - deine Netlify-URL erlaubt (Prod)
 * - optional: alle *.netlify.app Preview-Deploys erlauben
 */
const NETLIFY_ORIGIN = "https://projekt-kernfusion-10e-mathe.netlify.app"; // <-- HIER EINTRAGEN (ohne / am Ende)
const allowedOrigins = new Set([
  "http://localhost:3000",
  "http://localhost:5173",
  NETLIFY_ORIGIN,
]);

app.use(
  cors({
    origin: (origin, cb) => {
      // Requests ohne Origin (z.B. curl / Server-to-server) erlauben:
      if (!origin) return cb(null, true);

      // exakt erlaubte Origins
      if (allowedOrigins.has(origin)) return cb(null, true);

      // optional: Netlify Preview Deploys zulassen (z.B. https://xyz--site.netlify.app)
      if (/^https:\/\/.*\.netlify\.app$/.test(origin)) return cb(null, true);

      return cb(new Error("Not allowed by CORS"));
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "x-admin-key"],
  })
);

app.use(express.json());

// CORS-Fehler schön ausgeben (statt Browser-Chaos)
app.use((err, req, res, next) => {
  if (err && err.message === "Not allowed by CORS") {
    return res.status(403).json({ error: "CORS_BLOCKED", origin: req.headers.origin });
  }
  next(err);
});

/**
 * === DB ===
 * better-sqlite3 ist synchron. Das ist ok für kleine Projekte.
 * WAL (Write-Ahead Logging) wird oft empfohlen. [1](https://www.npmjs.com/package/better-sqlite3)[2](https://deepwiki.com/WiseLibs/better-sqlite3/3.4-wal-mode-and-performance-tuning)
 */
const DB_PATH = process.env.SQLITE_PATH || "./leaderboard.db";
const db = new Database(DB_PATH);

// pragmas (optional aber sinnvoll)
try {
  db.pragma("journal_mode = WAL");   // [2](https://deepwiki.com/WiseLibs/better-sqlite3/3.4-wal-mode-and-performance-tuning)
  db.pragma("foreign_keys = ON");
} catch (e) {
  console.warn("PRAGMA warning:", e.message);
}

// Tabelle anlegen
db.exec(`
  CREATE TABLE IF NOT EXISTS runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    score INTEGER NOT NULL,
    time_cs INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

function isGuest(name) {
  return !name || String(name).trim().toLowerCase() === "gast";
}

app.get("/", (req, res) => {
  res.send("Backend läuft ✅ (better-sqlite3 aktiv)");
});

/**
 * === Prepared Statements ===
 */
const insertRunStmt = db.prepare(
  "INSERT INTO runs (name, score, time_cs) VALUES (?, ?, ?)"
);

// Leaderboard: Bestwert pro Spieler (name normalisiert), sortiert nach score desc, time asc
const leaderboardStmt = db.prepare(`
  SELECT name, score, time_cs, created_at
  FROM (
    SELECT
      name, score, time_cs, created_at,
      ROW_NUMBER() OVER (
        PARTITION BY lower(trim(name))
        ORDER BY score DESC, time_cs ASC, created_at ASC
      ) AS rn
    FROM runs
    WHERE lower(trim(name)) <> 'gast'
  )
  WHERE rn = 1
  ORDER BY score DESC, time_cs ASC, created_at ASC
  LIMIT ?
`);

// Rank: Rang + Gesamtspieler in einem Query
const rankStmt = db.prepare(`
  WITH best AS (
    SELECT
      lower(trim(name)) AS key,
      name, score, time_cs, created_at,
      ROW_NUMBER() OVER (
        PARTITION BY lower(trim(name))
        ORDER BY score DESC, time_cs ASC, created_at ASC
      ) AS rn
    FROM runs
    WHERE lower(trim(name)) <> 'gast'
  ),
  uniq AS (
    SELECT key, name, score, time_cs, created_at
    FROM best
    WHERE rn = 1
  ),
  ranked AS (
    SELECT
      key, name, score, time_cs, created_at,
      ROW_NUMBER() OVER (
        ORDER BY score DESC, time_cs ASC, created_at ASC
      ) AS rank
    FROM uniq
  )
  SELECT
    (SELECT rank FROM ranked WHERE key = ?) AS rank,
    (SELECT COUNT(*) FROM uniq) AS totalPlayers
`);

// Global states: Top 3 pro Spieler (best, second, third)
const globalStatesStmt = db.prepare(`
  SELECT name, score, time_cs, created_at
  FROM (
    SELECT
      name, score, time_cs, created_at,
      ROW_NUMBER() OVER (
        PARTITION BY lower(trim(name))
        ORDER BY score DESC, time_cs ASC, created_at ASC
      ) AS rn
    FROM runs
    WHERE lower(trim(name)) <> 'gast'
  )
  WHERE rn <= ?
  ORDER BY lower(trim(name)) ASC, rn ASC
`);

/**
 * === Routes ===
 */

app.post("/api/run", (req, res) => {
  const { name, score, time_cs } = req.body || {};

  if (isGuest(name)) return res.status(400).json({ error: "Gast wird nicht gespeichert." });
  if (!Number.isInteger(score) || !Number.isInteger(time_cs)) {
    return res.status(400).json({ error: "score und time_cs müssen Integer sein." });
  }

  try {
    const info = insertRunStmt.run(String(name), score, time_cs);
    return res.status(201).json({ saved: true, id: info.lastInsertRowid });
  } catch (err) {
    return res.status(500).json({ error: "DB Fehler", details: err.message });
  }
});

app.get("/api/leaderboard", (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 5, 50);

  try {
    const rows = leaderboardStmt.all(limit);
    return res.json(rows || []);
  } catch (err) {
    console.error(err);
    return res.status(500).json([]);
  }
});

app.get("/api/rank/:name", (req, res) => {
  const rawName = String(req.params.name || "");
  const key = rawName.trim().toLowerCase();

  if (!key || key === "gast") {
    return res.json({ error: "NO_RANK" });
  }

  try {
    const row = rankStmt.get(key);

    // Wenn rank null ist, existiert kein Eintrag für diesen Namen
    if (!row || !row.rank) {
      return res.json({ error: "NO_RANK" });
    }

    return res.json({
      rank: row.rank,
      totalPlayers: row.totalPlayers,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "DB_ERROR" });
  }
});

app.get("/api/global/states", (req, res) => {
  const limitPlayers = Math.min(Number(req.query.limit) || 23, 50);
  const topN = 3;

  try {
    const rows = globalStatesStmt.all(topN);

    // gruppieren nach normalisiertem Namen
    const map = new Map();
    for (const r of rows || []) {
      const key = String(r.name).trim().toLowerCase();
      if (!map.has(key)) map.set(key, { name: r.name, runs: [] });

      map.get(key).runs.push({
        score: r.score,
        time_cs: r.time_cs,
        created_at: r.created_at,
      });
    }

    const result = Array.from(map.values()).slice(0, limitPlayers);
    return res.json(result);
  } catch (err) {
    console.error(err);
    return res.status(500).json([]);
  }
});

app.post("/api/admin/reset-db", (req, res) => {
  const adminPassword = req.headers["x-admin-key"];
  const SECRET = process.env.ADMIN_KEY || "GeneralNocreen"; // besser als Klartext im Code

  if (!adminPassword || adminPassword !== SECRET) {
    return res.status(401).json({ error: "Nicht autorisiert" });
  }

  try {
    const delInfo = db.prepare("DELETE FROM runs").run();
    // Reset Autoincrement
    db.prepare("DELETE FROM sqlite_sequence WHERE name='runs'").run();

    return res.json({
      success: true,
      message: "Leaderboard wurde geleert.",
      deletedRows: delInfo.changes,
    });
  } catch (err) {
    return res.status(500).json({ error: "Fehler beim Löschen", details: err.message });
  }
});

/**
 * Graceful shutdown
 */
function shutdown() {
  try {
    db.close();
  } catch {}
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server läuft auf Port", PORT));