const express = require("express");
const cors = require("cors");
const sqlite3 = require("sqlite3").verbose();

const app = express();

app.use(cors());
app.use(express.json());

// 1) Datenbank öffnen/erstellen (Datei)
const db = new sqlite3.Database("./leaderboard.db");

// 2) Tabelle + Indizes anlegen (falls noch nicht da)
db.exec(`
  CREATE TABLE IF NOT EXISTS runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    score INTEGER NOT NULL,
    time_cs INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_runs_order
    ON runs(score DESC, time_cs ASC, created_at ASC);

  CREATE INDEX IF NOT EXISTS idx_runs_name
    ON runs(name);
`);

function isGuest(name) {
  return !name || String(name).trim().toLowerCase() === "gast";
}

// Startseite zum Testen
app.get("/", (req, res) => {
  res.send("Backend läuft ✅ (SQLite aktiv)");
});

// 3) Score speichern
app.post("/api/run", (req, res) => {
  const { name, score, time_cs } = req.body || {};

  if (isGuest(name)) return res.status(400).json({ error: "Gast wird nicht gespeichert." });
  if (!Number.isInteger(score) || !Number.isInteger(time_cs)) {
    return res.status(400).json({ error: "score und time_cs müssen Integer sein." });
  }
  if (score < 0 || score > 5 || time_cs < 0) {
    return res.status(400).json({ error: "Ungültige Werte (score 0..5, time_cs >= 0)." });
  }

  const insert = db.prepare("INSERT INTO runs (name, score, time_cs) VALUES (?, ?, ?)");
  const info = insert.run(String(name), score, time_cs);

  res.status(201).json({ saved: true, id: info.lastInsertRowid });
});

// 4) Leaderboard
app.get("/api/leaderboard", (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 5, 50);

  const rows = db.prepare(`
    SELECT name, score, time_cs, created_at
    FROM (
      SELECT
        name, score, time_cs, created_at,
        ROW_NUMBER() OVER (
          PARTITION BY name
          ORDER BY score DESC, time_cs ASC, created_at ASC
        ) AS rn
      FROM runs
      WHERE lower(name) <> 'gast'
    )
    WHERE rn = 1
    ORDER BY score DESC, time_cs ASC, created_at ASC
    LIMIT ?
  `).all(limit);

  res.json(rows);
});

// 5) Platzierung eines Nutzers
app.get("/api/rank/:name", (req, res) => {
  const name = String(req.params.name || "");
  if (isGuest(name)) return res.status(400).json({ error: "Gast hat keine Platzierung." });

  const row = db.prepare(`
    WITH best_runs AS (
      SELECT
        name, score, time_cs, created_at,
        ROW_NUMBER() OVER (
          PARTITION BY name
          ORDER BY score DESC, time_cs ASC, created_at ASC
        ) AS rn
      FROM runs
      WHERE lower(name) <> 'gast'
    ),
    ranked AS (
      SELECT
        name, score, time_cs, created_at,
        DENSE_RANK() OVER (ORDER BY score DESC, time_cs ASC) AS rnk
      FROM best_runs
      WHERE rn = 1
    )
    SELECT
      rnk AS rank,
      (SELECT COUNT(*) FROM ranked) AS totalPlayers,
      score, time_cs, created_at
    FROM ranked
    WHERE name = ?
  `).get(name);

  if (!row) return res.status(404).json({ error: "Noch kein Ergebnis gespeichert." });
  res.json(row);
});

// ✅ Nur EINMAL listen – und zwar auf process.env.PORT
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server läuft auf Port", PORT));