const Database = require("better-sqlite3");

const db = new Database("test.db");

db.exec("CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, name TEXT)");
db.prepare("INSERT INTO t (name) VALUES (?)").run("Hallo");

const rows = db.prepare("SELECT * FROM t").all();
console.log(rows);