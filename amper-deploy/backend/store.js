// Хранилище документов: Postgres (если задан DATABASE_URL) или локальный SQLite-файл (для проверки на своём компьютере).
const path = require('path'), fs = require('fs');

async function makeStore() {
  if (process.env.DATABASE_URL) {
    const { Pool } = require('pg');
    const ssl = /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL) ? false : { rejectUnauthorized: false };
    const pool = process.env.__PG_POOL || new Pool({ connectionString: process.env.DATABASE_URL, ssl, max: 5 });
    await pool.query('CREATE TABLE IF NOT EXISTS docs (path TEXT PRIMARY KEY, json TEXT NOT NULL, updated BIGINT NOT NULL)');
    return {
      kind: 'postgres',
      get: async p => { const r = await pool.query('SELECT json FROM docs WHERE path = $1', [p]); return r.rows[0] ? r.rows[0].json : null; },
      set: async (p, j) => { await pool.query('INSERT INTO docs (path, json, updated) VALUES ($1, $2, $3) ON CONFLICT (path) DO UPDATE SET json = EXCLUDED.json, updated = EXCLUDED.updated', [p, j, Date.now()]); },
      del: async p => { await pool.query('DELETE FROM docs WHERE path = $1', [p]); },
      col: async c => (await pool.query('SELECT path, json FROM docs WHERE path LIKE $1 ORDER BY path', [c + '/%'])).rows
    };
  }
  const { DatabaseSync } = require('node:sqlite');
  const dir = process.env.DATA_DIR || path.join(__dirname, 'data'); fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, 'amper.db'));
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS docs (path TEXT PRIMARY KEY, json TEXT NOT NULL, updated INTEGER NOT NULL)');
  const g = db.prepare('SELECT json FROM docs WHERE path = ?'), s = db.prepare('INSERT INTO docs (path, json, updated) VALUES (?, ?, ?) ON CONFLICT(path) DO UPDATE SET json = excluded.json, updated = excluded.updated'),
    d = db.prepare('DELETE FROM docs WHERE path = ?'), c = db.prepare('SELECT path, json FROM docs WHERE path LIKE ? ORDER BY path');
  return {
    kind: 'sqlite',
    get: async p => { const r = g.get(p); return r ? r.json : null; },
    set: async (p, j) => { s.run(p, j, Date.now()); },
    del: async p => { d.run(p); },
    col: async col => c.all(col + '/%')
  };
}
module.exports = { makeStore };
