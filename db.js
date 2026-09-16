// Parental Shield — user store
//
// Primary backend: MySQL (via mysql2/promise). Enabled whenever DB_HOST (or
// MYSQL_URL) is provided. Tables are created automatically on boot.
//
// Fallback backend: a small JSON file (data/users.json) so the panel still runs
// in development / on hosts without a MySQL server. The public API is identical,
// so nothing else in the app needs to know which backend is active.

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, 'data');
const FILE_DB = path.join(DATA_DIR, 'users.json');

const DB_HOST = process.env.DB_HOST || '';
const DB_PORT = Number(process.env.DB_PORT) || 3306;
const DB_USER = process.env.DB_USER || 'root';
const DB_PASSWORD = process.env.DB_PASSWORD || '';
const DB_NAME = process.env.DB_NAME || 'shield';
const DB_SSL = String(process.env.DB_SSL || '').toLowerCase() === 'true';

let pool = null;
let mode = 'file'; // 'mysql' | 'file'
let fileCache = null;

// ── password hashing ─────────────────────────────────────────────────────
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `scrypt:${salt}:${hash}`;
}

function verifyPassword(user, password) {
  if (!user || !user.passwordHash) return false;
  const parts = String(user.passwordHash).split(':');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  try {
    const hash = crypto.scryptSync(String(password), parts[1], 64);
    const expected = Buffer.from(parts[2], 'hex');
    return hash.length === expected.length && crypto.timingSafeEqual(hash, expected);
  } catch (_) {
    return false;
  }
}

function normalizeUsername(u) {
  return String(u || '').trim().toLowerCase();
}

function isValidUsername(u) {
  return /^[a-z0-9_-]{2,32}$/.test(normalizeUsername(u));
}

<<<<<<< HEAD
=======
// ── 6-digit pairing codes ────────────────────────────────────────────────
// A pairing code lets a device bind to an account without typing a full
// WebSocket URL + token. `pairingCode` is the permanent code created with the
// account; `tempCode` is an optional short-lived code the admin can generate.
function randomPairingCode() {
  let code = '';
  for (let i = 0; i < 6; i++) code += String(crypto.randomInt(0, 10));
  return code;
}

function normalizeCode(code) {
  return String(code || '').replace(/\D/g, '').slice(0, 6);
}

function isValidCode(code) {
  return /^\d{6}$/.test(normalizeCode(code));
}

>>>>>>> 50114e5 (Initial upload)
// ── file backend ─────────────────────────────────────────────────────────
function loadFile() {
  if (fileCache) return fileCache;
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(FILE_DB)) {
      fileCache = JSON.parse(fs.readFileSync(FILE_DB, 'utf8'));
    } else {
      fileCache = { users: [] };
    }
  } catch (e) {
    console.error('[DB] Failed to read file store, starting empty:', e.message);
    fileCache = { users: [] };
  }
  return fileCache;
}

function saveFile() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FILE_DB, JSON.stringify(fileCache, null, 2));
  } catch (e) {
    console.error('[DB] Failed to write file store:', e.message);
  }
}

function fileRowToUser(r) {
  if (!r) return null;
  return {
    username: r.username,
    passwordHash: r.passwordHash,
    displayName: r.displayName || r.username,
    adminTgId: r.adminTgId || '',
    deviceToken: r.deviceToken || '',
    botToken: r.botToken || '',
<<<<<<< HEAD
=======
    pairingCode: r.pairingCode || '',
    tempCode: r.tempCode || '',
    tempCodeExp: Number(r.tempCodeExp) || 0,
>>>>>>> 50114e5 (Initial upload)
    isActive: r.isActive !== false,
    createdAt: r.createdAt || 0,
    lastLogin: r.lastLogin || 0,
  };
}

// ── mysql backend ────────────────────────────────────────────────────────
async function initMysql() {
  const mysql = require('mysql2/promise');

  // Connect without a database first so we can create it if missing.
  const bootConn = await mysql.createConnection({
    host: DB_HOST, port: DB_PORT, user: DB_USER, password: DB_PASSWORD,
    ssl: DB_SSL ? { rejectUnauthorized: true } : undefined,
    connectTimeout: 10000,
  });
  await bootConn.query(`CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await bootConn.end();

  pool = mysql.createPool({
    host: DB_HOST, port: DB_PORT, user: DB_USER, password: DB_PASSWORD,
    database: DB_NAME,
    ssl: DB_SSL ? { rejectUnauthorized: true } : undefined,
    waitForConnections: true, connectionLimit: 10, queueLimit: 0,
    charset: 'utf8mb4_unicode_ci',
  });

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      username      VARCHAR(64)  NOT NULL PRIMARY KEY,
      password_hash VARCHAR(255) NOT NULL,
      display_name  VARCHAR(128) NOT NULL DEFAULT '',
      admin_tg_id   VARCHAR(32)  NOT NULL DEFAULT '',
      device_token  VARCHAR(128) NOT NULL DEFAULT '',
      bot_token     VARCHAR(255) NOT NULL DEFAULT '',
<<<<<<< HEAD
=======
      pairing_code  VARCHAR(12)  NOT NULL DEFAULT '',
      temp_code     VARCHAR(12)  NOT NULL DEFAULT '',
      temp_code_exp BIGINT       NOT NULL DEFAULT 0,
>>>>>>> 50114e5 (Initial upload)
      is_active     TINYINT(1)   NOT NULL DEFAULT 1,
      created_at    BIGINT       NOT NULL DEFAULT 0,
      last_login    BIGINT       NOT NULL DEFAULT 0
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
<<<<<<< HEAD
=======
  // Upgrade older installs that predate the pairing-code columns.
  for (const ddl of [
    "ALTER TABLE users ADD COLUMN pairing_code VARCHAR(12) NOT NULL DEFAULT '' AFTER bot_token",
    "ALTER TABLE users ADD COLUMN temp_code VARCHAR(12) NOT NULL DEFAULT '' AFTER pairing_code",
    "ALTER TABLE users ADD COLUMN temp_code_exp BIGINT NOT NULL DEFAULT 0 AFTER temp_code",
  ]) {
    try { await pool.query(ddl); } catch (e) { if (e.code !== 'ER_DUP_FIELDNAME') throw e; }
  }
>>>>>>> 50114e5 (Initial upload)
  mode = 'mysql';
}

async function init() {
  if (!DB_HOST) {
    mode = 'file';
    loadFile();
    console.log('[DB] DB_HOST not set — using JSON file store (data/users.json)');
    return mode;
  }
  try {
    await initMysql();
    console.log(`[DB] MySQL connected: ${DB_USER}@${DB_HOST}:${DB_PORT}/${DB_NAME}`);
  } catch (e) {
    mode = 'file';
    loadFile();
    console.error(`[DB] MySQL unavailable (${e.message}) — falling back to JSON file store`);
  }
  // Seed the legacy super-admin bot chat as a "master" convenience is handled in server.js.
  return mode;
}

function rowToUser(r) {
  if (!r) return null;
  return {
    username: r.username,
    passwordHash: r.password_hash,
    displayName: r.display_name || r.username,
    adminTgId: r.admin_tg_id || '',
    deviceToken: r.device_token || '',
    botToken: r.bot_token || '',
<<<<<<< HEAD
=======
    pairingCode: r.pairing_code || '',
    tempCode: r.temp_code || '',
    tempCodeExp: Number(r.temp_code_exp) || 0,
>>>>>>> 50114e5 (Initial upload)
    isActive: Number(r.is_active) !== 0,
    createdAt: Number(r.created_at) || 0,
    lastLogin: Number(r.last_login) || 0,
  };
}

async function listUsers() {
  if (mode === 'mysql') {
    const [rows] = await pool.query('SELECT * FROM users ORDER BY created_at ASC');
    return rows.map(rowToUser);
  }
  return loadFile().users.map(fileRowToUser);
}

async function getUser(username) {
  const u = normalizeUsername(username);
  if (!u) return null;
  if (mode === 'mysql') {
    const [rows] = await pool.query('SELECT * FROM users WHERE username = ? LIMIT 1', [u]);
    return rowToUser(rows[0]);
  }
  return fileRowToUser(loadFile().users.find(x => x.username === u));
}

async function getUserByAdminTgId(tgId) {
  const id = String(tgId || '');
  if (!id) return null;
  if (mode === 'mysql') {
    const [rows] = await pool.query('SELECT * FROM users WHERE admin_tg_id = ? AND is_active = 1 LIMIT 1', [id]);
    return rowToUser(rows[0]);
  }
  return fileRowToUser(loadFile().users.find(x => String(x.adminTgId) === id && x.isActive !== false));
}

async function getUserByBotToken(botToken) {
  const t = String(botToken || '');
  if (!t) return null;
  if (mode === 'mysql') {
    const [rows] = await pool.query('SELECT * FROM users WHERE bot_token = ? LIMIT 1', [t]);
    return rowToUser(rows[0]);
  }
  return fileRowToUser(loadFile().users.find(x => x.botToken === t));
}

<<<<<<< HEAD
=======
/**
 * Finds the active user that a 6-digit code belongs to, checking the permanent
 * pairing code first and then any un-expired temporary code.
 */
async function getUserByPairingCode(code) {
  const c = normalizeCode(code);
  if (!isValidCode(c)) return null;
  const now = Date.now();
  const match = (u) => u && u.isActive && (
    u.pairingCode === c || (u.tempCode === c && Number(u.tempCodeExp) > now)
  );

  if (mode === 'mysql') {
    const [rows] = await pool.query(
      'SELECT * FROM users WHERE is_active = 1 AND (pairing_code = ? OR (temp_code = ? AND temp_code_exp > ?)) LIMIT 1',
      [c, c, now]
    );
    return rowToUser(rows[0]);
  }
  return fileRowToUser(loadFile().users.find(match));
}

/** Generates a fresh unique permanent pairing code, avoiding collisions. */
async function allocatePairingCode() {
  for (let i = 0; i < 25; i++) {
    const c = randomPairingCode();
    if (!(await getUserByPairingCode(c))) return c;
  }
  throw new Error('Could not allocate a unique pairing code, please retry');
}

/** Issues a short-lived temporary pairing code (default 30 minutes). */
async function setTempCode(username, ttlMs = 30 * 60 * 1000) {
  const u = normalizeUsername(username);
  const user = await getUser(u);
  if (!user) throw new Error('User not found');
  const code = await (async () => {
    for (let i = 0; i < 25; i++) {
      const c = randomPairingCode();
      if (c !== user.pairingCode && !(await getUserByPairingCode(c))) return c;
    }
    throw new Error('Could not allocate a unique code, please retry');
  })();
  const exp = Date.now() + ttlMs;
  await updateUser(u, { tempCode: code, tempCodeExp: exp });
  return { code, expiresAt: exp };
}

>>>>>>> 50114e5 (Initial upload)
async function createUser(fields) {
  const username = normalizeUsername(fields.username);
  if (!isValidUsername(username)) throw new Error('Invalid username (use a-z, 0-9, _ or -, 2-32 chars)');
  const existing = await getUser(username);
  if (existing) throw new Error('Username already exists');

  const row = {
    username,
    passwordHash: hashPassword(fields.password || crypto.randomBytes(6).toString('hex')),
    displayName: fields.displayName || username,
    adminTgId: String(fields.adminTgId || ''),
    deviceToken: fields.deviceToken || crypto.randomBytes(12).toString('hex'),
    botToken: fields.botToken || '',
<<<<<<< HEAD
=======
    pairingCode: normalizeCode(fields.pairingCode) || await allocatePairingCode(),
    tempCode: '',
    tempCodeExp: 0,
>>>>>>> 50114e5 (Initial upload)
    isActive: fields.isActive !== false,
    createdAt: Date.now(),
    lastLogin: 0,
  };

  if (mode === 'mysql') {
    await pool.query(
<<<<<<< HEAD
      `INSERT INTO users (username,password_hash,display_name,admin_tg_id,device_token,bot_token,is_active,created_at,last_login)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [row.username, row.passwordHash, row.displayName, row.adminTgId, row.deviceToken,
       row.botToken, row.isActive ? 1 : 0, row.createdAt, row.lastLogin]
=======
      `INSERT INTO users (username,password_hash,display_name,admin_tg_id,device_token,bot_token,pairing_code,temp_code,temp_code_exp,is_active,created_at,last_login)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [row.username, row.passwordHash, row.displayName, row.adminTgId, row.deviceToken,
       row.botToken, row.pairingCode, row.tempCode, row.tempCodeExp, row.isActive ? 1 : 0,
       row.createdAt, row.lastLogin]
>>>>>>> 50114e5 (Initial upload)
    );
  } else {
    const db = loadFile();
    db.users.push({
      username: row.username, passwordHash: row.passwordHash, displayName: row.displayName,
      adminTgId: row.adminTgId, deviceToken: row.deviceToken, botToken: row.botToken,
<<<<<<< HEAD
=======
      pairingCode: row.pairingCode, tempCode: row.tempCode, tempCodeExp: row.tempCodeExp,
>>>>>>> 50114e5 (Initial upload)
      isActive: row.isActive, createdAt: row.createdAt, lastLogin: row.lastLogin,
    });
    saveFile();
  }
  return getUser(username);
}

async function updateUser(username, fields) {
  const u = normalizeUsername(username);
  const user = await getUser(u);
  if (!user) throw new Error('User not found');

  const sets = [];
  const vals = [];
  const push = (col, val) => { sets.push(`${col} = ?`); vals.push(val); };

  if (fields.password) push('password_hash', hashPassword(fields.password));
  if (fields.displayName !== undefined) push('display_name', fields.displayName);
  if (fields.adminTgId !== undefined) push('admin_tg_id', String(fields.adminTgId));
  if (fields.deviceToken !== undefined) push('device_token', fields.deviceToken);
  if (fields.botToken !== undefined) push('bot_token', fields.botToken);
<<<<<<< HEAD
=======
  if (fields.pairingCode !== undefined) push('pairing_code', normalizeCode(fields.pairingCode));
  if (fields.tempCode !== undefined) push('temp_code', normalizeCode(fields.tempCode));
  if (fields.tempCodeExp !== undefined) push('temp_code_exp', Number(fields.tempCodeExp) || 0);
>>>>>>> 50114e5 (Initial upload)
  if (fields.isActive !== undefined) push('is_active', fields.isActive ? 1 : 0);
  if (fields.lastLogin !== undefined) push('last_login', fields.lastLogin);

  if (mode === 'mysql') {
    if (sets.length) {
      vals.push(u);
      await pool.query(`UPDATE users SET ${sets.join(', ')} WHERE username = ?`, vals);
    }
  } else {
    const db = loadFile();
    const row = db.users.find(x => x.username === u);
    if (!row) throw new Error('User not found');
    if (fields.password) row.passwordHash = hashPassword(fields.password);
    if (fields.displayName !== undefined) row.displayName = fields.displayName;
    if (fields.adminTgId !== undefined) row.adminTgId = String(fields.adminTgId);
    if (fields.deviceToken !== undefined) row.deviceToken = fields.deviceToken;
    if (fields.botToken !== undefined) row.botToken = fields.botToken;
<<<<<<< HEAD
=======
    if (fields.pairingCode !== undefined) row.pairingCode = normalizeCode(fields.pairingCode);
    if (fields.tempCode !== undefined) row.tempCode = normalizeCode(fields.tempCode);
    if (fields.tempCodeExp !== undefined) row.tempCodeExp = Number(fields.tempCodeExp) || 0;
>>>>>>> 50114e5 (Initial upload)
    if (fields.isActive !== undefined) row.isActive = fields.isActive;
    if (fields.lastLogin !== undefined) row.lastLogin = fields.lastLogin;
    saveFile();
  }
  return getUser(u);
}

async function deleteUser(username) {
  const u = normalizeUsername(username);
  if (mode === 'mysql') {
    await pool.query('DELETE FROM users WHERE username = ?', [u]);
  } else {
    const db = loadFile();
    db.users = db.users.filter(x => x.username !== u);
    saveFile();
  }
  return true;
}

module.exports = {
  init,
  getMode: () => mode,
  isValidUsername,
  normalizeUsername,
<<<<<<< HEAD
=======
  randomPairingCode,
  normalizeCode,
  isValidCode,
>>>>>>> 50114e5 (Initial upload)
  hashPassword,
  verifyPassword,
  listUsers,
  getUser,
  getUserByAdminTgId,
  getUserByBotToken,
<<<<<<< HEAD
=======
  getUserByPairingCode,
  allocatePairingCode,
  setTempCode,
>>>>>>> 50114e5 (Initial upload)
  createUser,
  updateUser,
  deleteUser,
};
