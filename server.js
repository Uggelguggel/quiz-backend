const express = require("express");
const cors = require("cors");
const sqlite3 = require("sqlite3").verbose();

const app = express();

app.use(cors({
  origin: [
    "http://localhost:3000",
    "https://projekt-kernfusion-10e-mathe.netlify.app"
  ],
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type"]
}));
app.use(express.json());

const db = new sqlite3.Database("./leaderboard.db");

// optional:
db.run("PRAGMA journal_mode = WAL");

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
  res.send("Backend läuft ✅ (SQLite aktiv)");
});

app.post("/api/run", (req, res) => {
  const { name, score, time_cs } = req.body || {};

  if (isGuest(name)) return res.status(400).json({ error: "Gast wird nicht gespeichert." });
  if (!Number.isInteger(score) || !Number.isInteger(time_cs)) {
    return res.status(400).json({ error: "score und time_cs müssen Integer sein." });
  }

  db.run(
    "INSERT INTO runs (name, score, time_cs) VALUES (?, ?, ?)",
    [String(name), score, time_cs],
    function (err) {
      if (err) return res.status(500).json({ error: "DB Fehler", details: err.message });
      res.status(201).json({ saved: true, id: this.lastID });
    }
  );
});

app.get("/api/leaderboard", (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 5, 50);

  db.all(
    `
    SELECT name, score, time_cs, created_at
    FROM runs
    WHERE lower(name) <> 'gast'
    ORDER BY score DESC, time_cs ASC, created_at ASC
    LIMIT ?
    `,
    [limit],
    (err, rows) => {
      if (err) {
        console.error(err);
        return res.json([]);     // ✅ IMMER Array zurückgeben
      }
      res.json(rows || []);     // ✅ rows ist ein Array
    }
  );
});

app.get("/api/rank/:name", (req, res) => {
  const name = String(req.params.name);

  db.all(`
    SELECT name, score, time_cs
    FROM (
      SELECT name, score, time_cs,
             ROW_NUMBER() OVER (
               PARTITION BY name
               ORDER BY score DESC, time_cs ASC, created_at ASC
             ) rn
      FROM runs
      WHERE lower(name) <> 'gast'
    )
    WHERE rn = 1
    ORDER BY score DESC, time_cs ASC
  `, [], (err, rows) => {
    if (err) return res.json({ error: "DB_ERROR" });

    const idx = rows.findIndex(r => r.name === name);

    if (idx === -1) {
      return res.json({ error: "NO_RANK" });
    }

    res.json({
      rank: idx + 1,
      totalPlayers: rows.length
    });
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server läuft auf Port", PORT));