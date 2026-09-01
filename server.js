// Parental Shield — Unified Server v2.0
// Web Admin Panel + Telegram Bot + Telegram Mini App

require('dotenv').config();

const express = require('express');
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught Exception (server kept alive):', err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled Promise Rejection (server kept alive):', reason);
});

const http        = require('http');
const WebSocket   = require('ws');
const path        = require('path');
const TelegramBot = require('node-telegram-bot-api');

const PORT           = process.env.PORT         || 3000;
const SECURITY_TOKEN = process.env.SHIELD_TOKEN || "GAJARBOTOL80";
const BOT_TOKEN      = process.env.BOT_TOKEN    || "";
const ADMIN_TG_ID    = Number(process.env.ADMIN_TG_ID) || 5197344486;
const PANEL_PASSWORD = process.env.PANEL_PASSWORD || "Shield@2025";
const PUBLIC_URL     = (process.env.PUBLIC_URL  || "").replace(/\/$/, "");

const app = express();
const server = http.createServer(app);
app.use(express.json());

// ── Simple session store (in-memory) ──────────────────────────────────────
const activeSessions = new Set();

function generateToken() {
  return Math.random().toString(36).substring(2) + Date.now().toString(36);
}

app.post('/api/login', (req, res) => {
  const { password } = req.body;
  if (password === PANEL_PASSWORD) {
    const token = generateToken();
    activeSessions.add(token);
    setTimeout(() => activeSessions.delete(token), 24 * 60 * 60 * 1000);
    res.json({ success: true, token });
  } else {
    res.status(401).json({ success: false, message: "Wrong password" });
  }
});

app.post('/api/logout', (req, res) => {
  const token = req.headers['x-shield-token'];
  if (token) activeSessions.delete(token);
  res.json({ success: true });
});

app.get('/api/auth-check', (req, res) => {
  const token = req.headers['x-shield-token'];
  res.json({ valid: token && activeSessions.has(token) });
});

app.get('/api/status', (req, res) => {
  res.json({ devices: childDevices.size, uptime: process.uptime(), botActive: !!bot });
});

app.use(express.static(path.join(__dirname, 'public')));

const wss = new WebSocket.Server({ noServer: true });

// In-memory state
const childDevices = new Map();
const adminSockets = new Set();

// Pending device selections per Telegram chat
const botDeviceSelection = new Map();

// ════════════════════════════════════════════════════════════════════
// TELEGRAM BOT
// ════════════════════════════════════════════════════════════════════

let bot = null;

// Telegram legacy Markdown only treats _ * ` [ as markup.
function escapeMd(text) {
  if (text == null) return '';
  return String(text).replace(/([_*`\[])/g, '\\$1');
}

function escapeMdCode(text) {
  if (text == null) return '';
  return String(text).replace(/`/g, "'");
}

// ════════════════════════════════════════════════════════════════════
// BOT FILE BROWSER HELPERS
// ════════════════════════════════════════════════════════════════════

const STORAGE_ROOT = '/storage/emulated/0';
const BOT_DIR_PAGE_SIZE = 12;

const FOLDER_SHORTCUTS = {
  'download':      '/storage/emulated/0/Download',
  'downloads':     '/storage/emulated/0/Download',
  'dcim':          '/storage/emulated/0/DCIM',
  'dcim/camera':   '/storage/emulated/0/DCIM/Camera',
  'camera':        '/storage/emulated/0/DCIM/Camera',
  'pictures':      '/storage/emulated/0/Pictures',
  'screenshots':   '/storage/emulated/0/Pictures/Screenshots',
  'whatsapp':      '/storage/emulated/0/WhatsApp/Media',
  'documents':     '/storage/emulated/0/Documents',
  'music':         '/storage/emulated/0/Music',
  'videos':        '/storage/emulated/0/Movies',
  'movies':        '/storage/emulated/0/Movies',
  'telegram':      '/storage/emulated/0/Telegram',
  'sdcard':        '/storage/emulated/0',
  'root':          '/storage/emulated/0',
  'home':          '/storage/emulated/0',
};

const PATH_SHORTCUTS = [
  { text: '🏠 Root',      path: '/storage/emulated/0' },
  { text: '⬇️ Download',  path: '/storage/emulated/0/Download' },
  { text: '📷 DCIM',      path: '/storage/emulated/0/DCIM' },
  { text: '📸 Camera',    path: '/storage/emulated/0/DCIM/Camera' },
  { text: '🖼️ Pictures',  path: '/storage/emulated/0/Pictures' },
  { text: '💬 WhatsApp',  path: '/storage/emulated/0/WhatsApp/Media' },
  { text: '📄 Documents', path: '/storage/emulated/0/Documents' },
  { text: '🎵 Music',     path: '/storage/emulated/0/Music' },
  { text: '🎬 Movies',    path: '/storage/emulated/0/Movies' },
  { text: '✈️ Telegram',  path: '/storage/emulated/0/Telegram' },
];

function getFileCategory(filename) {
  const ext = filename.split('.').pop().toLowerCase();
  if (['jpg','jpeg','png','gif','webp','bmp','heic'].includes(ext)) return 'image';
  if (['mp4','mkv','avi','mov','3gp','webm'].includes(ext))         return 'video';
  if (['mp3','m4a','aac','ogg','wav','flac'].includes(ext))         return 'audio';
  if (['pdf','doc','docx','xls','xlsx','ppt','txt','csv'].includes(ext)) return 'doc';
  if (['apk'].includes(ext))                                          return 'apk';
  if (['zip','rar','tar','gz','7z'].includes(ext))                   return 'archive';
  if (filename.startsWith('.trash') || ext === 'trashed' || filename.includes('.trashed')) return 'trashed';
  return 'other';
}

function getCategoryEmoji(cat) {
  return { image:'🖼️', video:'🎬', audio:'🎵', doc:'📄', apk:'📦', archive:'🗜️', trashed:'🗑️', other:'📎' }[cat] || '📎';
}

function formatSize(bytes) {
  if (bytes === 0 || !bytes) return '—';
  if (bytes < 1024)        return bytes + ' B';
  if (bytes < 1024*1024)   return (bytes/1024).toFixed(1) + ' KB';
  if (bytes < 1024**3)     return (bytes/1024/1024).toFixed(1) + ' MB';
  return (bytes/1024/1024/1024).toFixed(2) + ' GB';
}

const pathCache = new Map();
let pathCacheCounter = 1;

function getCachedPathKey(path) {
  if (!path) return '';
  for (const [key, val] of pathCache.entries()) {
    if (val === path) return key;
  }
  if (pathCache.size > 800) {
    const first = pathCache.keys().next().value;
    pathCache.delete(first);
  }
  const key = `p${pathCacheCounter++}`;
  pathCache.set(key, path);
  return key;
}

function decodeCachedPath(key) {
  if (!key) return '';
  if (pathCache.has(key)) return pathCache.get(key);
  if (String(key).startsWith('/')) return key;
  return '';
}

function resolveFolderPath(input) {
  let raw = String(input || '').trim();
  if (!raw) return STORAGE_ROOT;
  const lower = raw.toLowerCase();
  if (FOLDER_SHORTCUTS[lower]) return FOLDER_SHORTCUTS[lower];
  if (lower === '/sdcard' || lower.startsWith('/sdcard/')) {
    raw = STORAGE_ROOT + raw.slice('/sdcard'.length);
  }
  if (raw.startsWith('/')) return raw.replace(/\/+$/, '') || '/';
  return STORAGE_ROOT + '/' + raw.replace(/^\/+/, '');
}

function getParentPath(dirPath) {
  if (!dirPath) return '';
  const p = String(dirPath).replace(/\/+$/, '');
  if (!p || p === '/' || p === STORAGE_ROOT) return '';
  const idx = p.lastIndexOf('/');
  if (idx <= 0) return '/';
  return p.slice(0, idx) || '/';
}

function isDirItem(item) {
  if (!item) return false;
  const flag = item.isDirectory ?? item.isDir ?? item.directory;
  if (flag === true || flag === 1 || flag === '1' || flag === 'true') return true;
  const t = String(item.type || '').toLowerCase();
  return t === 'dir' || t === 'folder' || t === 'directory';
}

function itemFullPath(item, curPath) {
  if (item && item.path) return item.path;
  const base = (curPath || STORAGE_ROOT).replace(/\/+$/, '');
  const name = item && item.name ? String(item.name).replace(/^\/+/, '') : '';
  return name ? base + '/' + name : base;
}

function truncateBtn(str, max) {
  const s = String(str || '');
  if (s.length <= max) return s;
  return s.slice(0, Math.max(1, max - 1)) + '...';
}

const botDirCache = new Map();

function cacheBotDirListing(deviceId, payload) {
  botDirCache.set(deviceId, {
    items: payload.items || [],
    currentPath: payload.currentPath || '',
    parentPath: payload.parentPath || getParentPath(payload.currentPath),
    ts: Date.now()
  });
}

function getCachedBotDir(deviceId, dirPath) {
  const cached = botDirCache.get(deviceId);
  if (!cached) return null;
  if (dirPath && cached.currentPath !== dirPath) return null;
  if (Date.now() - cached.ts > 120000) return null;
  return cached;
}

function buildShortcutRows(deviceId) {
  const rows = [];
  let row = [];
  for (const sc of PATH_SHORTCUTS) {
    row.push({
      text: sc.text,
      callback_data: `fb:nav:${deviceId}:${getCachedPathKey(sc.path)}:all`
    });
    if (row.length === 5) {
      rows.push(row);
      row = [];
    }
  }
  if (row.length) rows.push(row);
  return rows;
}

function buildBreadcrumbRows(deviceId, curPath) {
  const parts = String(curPath || '').replace(/\/+$/, '').split('/').filter(Boolean);
  const crumbs = [];
  let acc = '';
  for (const part of parts) {
    acc += '/' + part;
    crumbs.push({ name: part, path: acc });
  }
  const shown = crumbs.slice(-4);
  if (!shown.length) return [];
  return [shown.map((c, i) => ({
    text: (i === 0 && shown.length < crumbs.length ? '…' : '') +
      (c.path === STORAGE_ROOT ? 'Home' : truncateBtn(c.name, 12)),
    callback_data: `fb:nav:${deviceId}:${getCachedPathKey(c.path)}:all`
  }))];
}

function requestDeviceDir(chatId, msgId, deviceId, dirPath, filterExt, page) {
  if (!dirPath) dirPath = STORAGE_ROOT;
  if (!childDevices.has(deviceId)) {
    if (bot) bot.sendMessage(chatId, 'Device offline.');
    return false;
  }
  const seq = Date.now();
  pendingBotFileRequests.set(deviceId, {
    chatId,
    msgId,
    type: 'list_dir',
    filterExt: filterExt || 'all',
    page: page || 0,
    seq,
    path: dirPath
  });
  const ok = sendCommandToDevice(deviceId, { command: 'list_dir', path: dirPath });
  if (!ok) {
    pendingBotFileRequests.delete(deviceId);
    if (bot) bot.sendMessage(chatId, 'Device e command pathano jaynai.');
    return false;
  }
  setTimeout(() => {
    const pending = pendingBotFileRequests.get(deviceId);
    if (pending && pending.seq === seq && pending.type === 'list_dir') {
      pendingBotFileRequests.delete(deviceId);
      if (bot) bot.sendMessage(chatId, 'Timeout — device respond koreni. App chalu ache?');
    }
  }, 15000);
  return true;
}

function normalizeDirPayload(payload, fallbackPath) {
  const items = payload.items || payload.files || payload.entries || [];
  const currentPath = payload.currentPath || payload.path || fallbackPath || STORAGE_ROOT;
  const parentPath = payload.parentPath || getParentPath(currentPath);
  return { items, currentPath, parentPath };
}

// ── Send file listing to Telegram ────────────────────────────────────────
function handleBotFileListing(chatId, editMsgId, deviceId, payload, filterExt, page) {
  if (!bot) return;
  try {
  const normalized = normalizeDirPayload(payload, payload.currentPath);
  const items    = normalized.items;
  const curPath  = normalized.currentPath || STORAGE_ROOT;
  const parentPath = (payload.parentPath && payload.parentPath !== curPath)
    ? payload.parentPath
    : getParentPath(curPath);
  const devName  = getDeviceName(deviceId);
  const folderName = curPath.split('/').filter(Boolean).pop() || curPath || 'Root';
  const pathKey  = getCachedPathKey(curPath);
  const filter   = filterExt || 'all';
  const pageNum  = Math.max(0, parseInt(page, 10) || 0);

  cacheBotDirListing(deviceId, { items, currentPath: curPath, parentPath });

  const folders = items.filter(i => {
    if (!isDirItem(i)) return false;
    const n = String(i.name || '');
    return n !== '.' && n !== '..';
  }).sort((a, b) =>
    String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base' })
  );
  const files   = items.filter(i => !isDirItem(i)).sort((a, b) =>
    String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base' })
  );

  let filtered = files;
  if (filter && filter !== 'all') {
    if (filter.startsWith('.')) {
      filtered = files.filter(f => String(f.name || '').toLowerCase().endsWith(filter.toLowerCase()));
    } else {
      filtered = files.filter(f => getFileCategory(f.name) === filter);
    }
  }

  const cats = {};
  for (const f of files) {
    const c = getFileCategory(f.name);
    cats[c] = (cats[c] || 0) + 1;
  }
  const catSummary = Object.entries(cats)
    .map(([c, n]) => `${getCategoryEmoji(c)} ${n}`)
    .join('  ');

  const listing = [];
  for (const folder of folders) listing.push({ kind: 'dir', item: folder });
  for (const file of filtered) listing.push({ kind: 'file', item: file });

  const totalPages = Math.max(1, Math.ceil(listing.length / BOT_DIR_PAGE_SIZE));
  const safePage   = Math.min(pageNum, totalPages - 1);
  const slice      = listing.slice(safePage * BOT_DIR_PAGE_SIZE, (safePage + 1) * BOT_DIR_PAGE_SIZE);

  const escFolder = escapeMd(folderName);
  const escDev    = escapeMd(devName);
  const escPath   = escapeMdCode(curPath);

  let text = `*${escFolder}*  (${escDev})\n`;
  text += `\`${escPath}\`\n`;
  text += `${'─'.repeat(26)}\n`;
  text += `Folders: ${folders.length}   Files: ${files.length}`;
  if (catSummary) text += `  ${catSummary}`;
  text += `\n`;
  if (filter !== 'all') {
    text += `Filter: \`${escapeMdCode(filter)}\` → ${filtered.length} file\n`;
  }
  if (totalPages > 1) {
    text += `Page ${safePage + 1}/${totalPages}\n`;
  }
  text += `${'─'.repeat(26)}\n`;

  if (listing.length === 0) {
    text += filter !== 'all'
      ? `"${escapeMd(filter)}" er kono file nai. Filter clear kore folder dekhte paro.`
      : `_Ei folder khali._`;
  } else if (filter === 'all' && folders.length) {
    text += `_Folder e tap kore dhukho. File e tap kore download/delete._`;
  }

  const filterButtons = [];
  const catRow1 = [], catRow2 = [];
  const allCats = ['image', 'video', 'audio', 'doc', 'apk', 'trashed', 'archive'];
  const presentCats = allCats.filter(c => cats[c]);
  for (let i = 0; i < presentCats.length; i++) {
    const c = presentCats[i];
    const active = filter === c ? '* ' : '';
    const btn = {
      text: `${active}${getCategoryEmoji(c)} ${c}`,
      callback_data: `fb:filter:${deviceId}:${pathKey}:${c}`
    };
    if (i < 3) catRow1.push(btn); else catRow2.push(btn);
  }
  if (catRow1.length) filterButtons.push(catRow1);
  if (catRow2.length) filterButtons.push(catRow2);

  filterButtons.push([
    { text: filter === 'all' ? '* All' : 'All', callback_data: `fb:filter:${deviceId}:${pathKey}:all` },
    { text: filter === '.trashed' ? '* .trashed' : '.trashed', callback_data: `fb:filter:${deviceId}:${pathKey}:.trashed` },
  ]);

  const listButtons = [];
  for (const entry of slice) {
    const item = entry.item;
    const full = itemFullPath(item, curPath);
    if (entry.kind === 'dir') {
      const label = `📁 ${truncateBtn(item.name || 'folder', 36)}`;
      listButtons.push([{
        text: label,
        callback_data: `fb:nav:${deviceId}:${getCachedPathKey(full)}:all`
      }]);
    } else {
      const emoji = getCategoryEmoji(getFileCategory(item.name));
      const sizeStr = formatSize(item.size);
      const label = `${emoji} ${truncateBtn(item.name, 28)}  (${sizeStr})`;
      listButtons.push([{
        text: label,
        callback_data: `fb:file:${deviceId}:${getCachedPathKey(full)}`
      }]);
    }
  }

  const pageRow = [];
  if (totalPages > 1) {
    if (safePage > 0) {
      pageRow.push({
        text: '⬅️ Prev',
        callback_data: `fb:pg:${deviceId}:${pathKey}:${filter}:${safePage - 1}`
      });
    }
    pageRow.push({
      text: `${safePage + 1}/${totalPages}`,
      callback_data: 'fb:noop'
    });
    if (safePage < totalPages - 1) {
      pageRow.push({
        text: 'Next ➡️',
        callback_data: `fb:pg:${deviceId}:${pathKey}:${filter}:${safePage + 1}`
      });
    }
  }

  const navRow1 = [];
  if (parentPath) {
    navRow1.push({
      text: '⬆️ Up',
      callback_data: `fb:nav:${deviceId}:${getCachedPathKey(parentPath)}:all`
    });
  }
  navRow1.push({
    text: '🏠 Home',
    callback_data: `fb:nav:${deviceId}:${getCachedPathKey(STORAGE_ROOT)}:all`
  });
  navRow1.push({
    text: '🔄 Refresh',
    callback_data: `fb:nav:${deviceId}:${pathKey}:${filter}`
  });

  const navRow2 = [
    { text: '✏️ Path', callback_data: `fb:custom:${deviceId}` },
    { text: '📥 All here', callback_data: `fb:getall:${deviceId}:${pathKey}` },
    { text: '◀️ Device', callback_data: `sel:${deviceId}` },
  ];

  const keyboard = {
    inline_keyboard: [
      ...buildShortcutRows(deviceId),
      ...buildBreadcrumbRows(deviceId, curPath),
      ...filterButtons,
      ...listButtons,
      ...(pageRow.length ? [pageRow] : []),
      navRow1,
      navRow2
    ]
  };

  const opts = { parse_mode: 'Markdown', reply_markup: keyboard };
  if (editMsgId) {
    bot.editMessageText(text, { chat_id: chatId, message_id: editMsgId, ...opts })
      .catch(() => bot.sendMessage(chatId, text, opts));
  } else {
    bot.sendMessage(chatId, text, opts);
  }
  } catch (err) {
    console.error('[BOT] file listing error:', err.message);
    bot.sendMessage(chatId, 'File list render korte problem hoyeche: ' + err.message);
  }
}

// ── Download file and send to Telegram ──────────────────────────────────
async function handleBotFileDownload(chatId, deviceId, payload) {
  if (!bot) return;
  try {
    const { name, base64 } = payload;
    if (!base64) {
      bot.sendMessage(chatId, `❌ File data পাওয়া যায়নি বা ফাইল রিড করতে কোনো সমস্যা হয়েছে।`);
      return;
    }

    const buffer = Buffer.from(base64, 'base64');
    const ext    = name.split('.').pop().toLowerCase();

    if (buffer.length > 50 * 1024 * 1024) {
      bot.sendMessage(chatId, `⚠️ ফাইল সাইজ (${formatSize(buffer.length)}) অনেক বড় (টেলিগ্রাম বটের লিমিট ৫০এমবি)। অনুগ্রহ করে ওয়েব এডমিন প্যানেল ব্যবহার করে ফাইলটি ডাউনলোড করে নিন!`);
      return;
    }

    await bot.sendMessage(chatId, `Sending: ${name} (${formatSize(buffer.length)})…`);

    const imageExts = ['jpg','jpeg','png','gif','webp','bmp','heic','heif'];
    const videoExts = ['mp4','mkv','avi','mov','3gp','webm'];
    const audioExts = ['mp3','m4a','aac','ogg','wav','flac','opus'];
    const codeExts  = ['html','htm','php','js','ts','mjs','css','json','xml','py','sh','bat','c','cpp','java'];
    const textExts  = ['txt','log','csv','md','ini','cfg','conf','yaml','yml'];
    const archExts  = ['zip','rar','7z','tar','gz','bz2'];

    // Always pass contentType explicitly to avoid: EFATAL: Unsupported Buffer file-type
    // node-telegram-bot-api fails when it cannot detect type from buffer magic bytes
    if (imageExts.includes(ext)) {
      const mime = ext === 'jpg' ? 'image/jpeg' : 'image/' + ext;
      await bot.sendPhoto(chatId, buffer,
        { caption: name },
        { filename: name, contentType: mime }
      ).catch(() =>
        bot.sendDocument(chatId, buffer,
          { caption: name },
          { filename: name, contentType: 'application/octet-stream' }
        )
      );
    } else {
      // All non-image types → sendDocument with octet-stream
      // This works for EVERY extension: .html .php .js .apk .zip .mp4 .mp3 .pdf etc.
      let emoji = '📎';
      if (videoExts.includes(ext))  emoji = '🎬';
      else if (audioExts.includes(ext))  emoji = '🎵';
      else if (ext === 'pdf')            emoji = '📄';
      else if (ext === 'apk')            emoji = '📦';
      else if (archExts.includes(ext))   emoji = '🗜️';
      else if (codeExts.includes(ext))   emoji = '💻';
      else if (textExts.includes(ext))   emoji = '📋';
      await bot.sendDocument(chatId, buffer,
        { caption: emoji + ' ' + name },
        { filename: name, contentType: 'application/octet-stream' }
      );
    }
    console.log(`[BOT] File sent to chat ${chatId}: ${name} (${formatSize(buffer.length)})`);
  } catch (err) {
    console.error('[BOT] File send error:', err.message);
    bot.sendMessage(chatId, 'File send hoyni: ' + (err.message || 'unknown error'));
  }
}

// ── Notify functions ─────────────────────────────────────────────────────
async function notifyAdminPhoto(deviceId, childName, dataUrl, facing) {
  if (!bot) return;
  try {
    const b64 = dataUrl.replace(/^data:image\/\w+;base64,/, '');
    const buf = Buffer.from(b64, 'base64');
    const cap = `📷 *${escapeMd(childName)}* — ${facing === 'front' ? 'Front' : 'Back'} Camera\n${new Date().toLocaleTimeString()}`;
    await bot.sendPhoto(ADMIN_TG_ID, buf, { caption: cap, parse_mode: 'Markdown' }, { filename: 'photo.jpg', contentType: 'image/jpeg' });
  } catch (e) { console.error('[BOT] Photo notify error:', e.message); }
}

async function notifyAdminAudio(deviceId, childName, dataUrl, duration) {
  if (!bot) return;
  try {
    const b64 = dataUrl.replace(/^data:audio\/\w+;base64,/, '');
    const buf = Buffer.from(b64, 'base64');
    await bot.sendAudio(ADMIN_TG_ID, buf,
      { caption: `🎤 *${escapeMd(childName)}* — Ambient Audio`, parse_mode: 'Markdown', title: `ambient_${Date.now()}.m4a` },
      { filename: 'ambient.m4a', contentType: 'audio/m4a' });
  } catch (e) { console.error('[BOT] Audio notify error:', e.message); }
}

function notifyAdminLocation(deviceId, childName, loc) {
  if (!bot) return;
  try {
    bot.sendLocation(ADMIN_TG_ID, loc.lat, loc.lng);
    bot.sendMessage(ADMIN_TG_ID,
      `📍 *${escapeMd(childName)}* Location\n\n` +
      `Accuracy: ±${Math.round(loc.accuracy || 0)}m\n` +
      `Provider: ${loc.provider || 'GPS'}\n` +
      `[Open in Maps](${loc.mapUrl})`,
      { parse_mode: 'Markdown' });
  } catch (e) { console.error('[BOT] Location notify error:', e.message); }
}

function notifyAdminSms(deviceId, childName, sender, body, time) {
  if (!bot) return;
  try {
    const t = new Date(time).toLocaleTimeString();
    notifyAdmin(
      `💬 *Incoming SMS — ${escapeMd(childName)}*\n\n` +
       `From: \`${escapeMdCode(sender)}\`\n` +
      `Time: ${t}\n\n` +
      `"${body.length > 200 ? escapeMd(body.slice(0,200))+'…' : escapeMd(body)}"`,
      { reply_markup: { inline_keyboard: [[{ text: `📱 View ${childName}`, callback_data: `sel:${deviceId}` }]] } }
    );
  } catch (e) { console.error('[BOT] SMS notify error:', e.message); }
}

// ── Generic data result handler (call log / sms list / contacts) ──────────
function handleBotDataResult(chatId, deviceId, payload) {
  if (!bot) return;
  const devName = getDeviceName(deviceId);
  const escDev = escapeMd(devName);
  try {
    if (payload.type === 'call_log_result') {
      const calls = payload.calls || [];
      if (calls.length === 0) { bot.sendMessage(chatId, `📵 No calls found.`); return; }
      let text = `📞 *Call Log — ${escDev}* (${calls.length} entries)\n\n`;
      for (const c of calls.slice(0, 25)) {
        const icons = { incoming:'📲', outgoing:'📤', missed:'🔴', rejected:'⛔' };
        const icon  = icons[c.type] || '📞';
        const dur   = c.duration ? `${Math.floor(c.duration/60)}m${c.duration%60}s` : '—';
        const date  = new Date(c.date).toLocaleDateString('bn-BD');
        const name  = c.name ? ` (${escapeMd(c.name)})` : '';
        text += `${icon} \`${escapeMdCode(c.number)}\`${name} — ${dur} — ${date}\n`;
      }
      if (calls.length > 25) text += `\n_…aro ${calls.length-25} ta call_`;
      bot.sendMessage(chatId, text, { parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: `sel:${deviceId}` }]] } });

    } else if (payload.type === 'sms_result') {
      const msgs = payload.messages || [];
      if (msgs.length === 0) { bot.sendMessage(chatId, `📭 No messages.`); return; }
      let text = `💬 *SMS (${escapeMd(payload.box)}) — ${escDev}* (${msgs.length})\n\n`;
      for (const m of msgs.slice(0, 20)) {
        const date = new Date(m.date).toLocaleDateString('bn-BD');
        const read = m.read ? '' : '🔵 ';
        const body = m.body.length > 80 ? escapeMd(m.body.slice(0,80))+'…' : escapeMd(m.body);
        text += `${read}\`${escapeMdCode(m.from)}\` — ${date}\n_${body}_\n\n`;
      }
      bot.sendMessage(chatId, text, { parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: `sel:${deviceId}` }]] } });

    } else if (payload.type === 'contacts_result') {
      const contacts = payload.contacts || [];
      if (contacts.length === 0) { bot.sendMessage(chatId, `👤 No contacts.`); return; }
      if (contacts.length > 30) {
        const lines = contacts.map(c => `${c.name} — ${c.number}`).join('\n');
        const buf = Buffer.from(lines, 'utf-8');
        bot.sendDocument(chatId, buf, { caption: `👥 ${escDev} — ${contacts.length} contacts` }, { filename: 'contacts.txt', contentType: 'text/plain' });
      } else {
        let text = `👥 *Contacts — ${escDev}* (${contacts.length})\n\n`;
        for (const c of contacts) text += `👤 *${escapeMd(c.name)}*  \`${escapeMdCode(c.number)}\`\n`;
        bot.sendMessage(chatId, text, { parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: `sel:${deviceId}` }]] } });
      }

    } else if (payload.type === 'installed_apps_result') {
      const apps = payload.apps || [];
      if (apps.length === 0) { bot.sendMessage(chatId, `📦 No user apps.`); return; }
      const lines = apps.map(a => `${a.blocked ? '🚫 ' : '✅ '}${a.name} (${a.package})`).join('\n');
      const buf = Buffer.from(lines, 'utf-8');
      bot.sendDocument(chatId, buf,
        { caption: `📦 *${escDev}* — ${apps.length} apps installed` },
        { filename: 'installed_apps.txt', contentType: 'text/plain' });
    }
  } catch (e) { console.error('[BOT] Data result error:', e.message); }
}

// ── Bot initialization ───────────────────────────────────────────────────
function initTelegramBot() {
  if (!BOT_TOKEN) {
    console.warn("[BOT] BOT_TOKEN not set — Telegram bot disabled.");
    return;
  }
  try {
    bot = new TelegramBot(BOT_TOKEN, { polling: true });
    console.log("[BOT] Telegram bot started.");
  } catch (err) {
    console.error("[BOT] Failed to start Telegram bot:", err.message);
    return;
  }

  // ── State management ──────────────────────────────────────────────────
  const chatState = new Map();

  function getState(chatId) {
    if (!chatState.has(chatId)) chatState.set(chatId, { selectedDeviceId: null, awaitingInput: null });
    return chatState.get(chatId);
  }

  function isAdmin(chatId) { return String(chatId) === String(ADMIN_TG_ID); }

  function adminOnly(msg, cb) {
    if (!isAdmin(msg.chat.id)) { bot.sendMessage(msg.chat.id, "⛔ Access denied."); return; }
    cb(msg);
  }

  // ── Keyboard builders ─────────────────────────────────────────────────
  const MAIN_REPLY_KB = {
    keyboard: [
      [{ text: "📱 Devices" }, { text: "🖥️ Full Panel" }],
      [{ text: "📊 Status" },  { text: "⚙️ Settings"  }],
    ],
    resize_keyboard: true,
    persistent: true,
  };

  function deviceListInlineKB() {
    if (childDevices.size === 0) return { inline_keyboard: [] };
    const rows = [];
    for (const [id, dev] of childDevices.entries()) {
      const bat = dev.battery || 0;
      const icon = bat > 60 ? "🟢" : bat > 20 ? "🟡" : "🔴";
      rows.push([{ text: `${icon} ${dev.childName}  •  🔋${bat}%  •  ${dev.activeApp || "Home"}`, callback_data: `sel:${id}` }]);
    }
    return { inline_keyboard: rows };
  }

  function deviceActionInlineKB(deviceId) {
    const miniUrl = PUBLIC_URL ? `${PUBLIC_URL}/?tg=1` : null;
    const rows = [
      [
        { text: "🔒 Lock Screen",  callback_data: `act:lock:${deviceId}` },
        { text: "📳 Vibrate",      callback_data: `act:buzz:${deviceId}` },
      ],
      [
        { text: "🙈 Hide Icon",    callback_data: `act:hide_icon:${deviceId}` },
        { text: "👁️ Show Icon",    callback_data: `act:unhide_icon:${deviceId}` },
      ],
      [
        { text: "⏱️ Screen Time Limit", callback_data: `act:screentime:${deviceId}` },
        { text: "🚫 Block Apps",        callback_data: `act:policy:${deviceId}` },
      ],
      [
        { text: "📷 Camera (Front)", callback_data: `act:photo_front:${deviceId}` },
        { text: "📷 Camera (Back)",  callback_data: `act:photo_back:${deviceId}` },
      ],
      [
        { text: "🎤 Record 30s",     callback_data: `act:record_audio:${deviceId}` },
        { text: "📍 Location",        callback_data: `act:get_location:${deviceId}` },
      ],
      [
        { text: "📞 Call Log",        callback_data: `act:call_log:${deviceId}` },
        { text: "💬 SMS",             callback_data: `act:sms:${deviceId}` },
      ],
      [
        { text: "👥 Contacts",        callback_data: `act:contacts:${deviceId}` },
        { text: "📦 Installed Apps",  callback_data: `act:installed_apps:${deviceId}` },
      ],
      [
        { text: "📂 Files",          callback_data: `act:files:${deviceId}` },
        { text: "📥 Get All Files",  callback_data: `act:get_all_files:${deviceId}` },
      ],
      [
        { text: "🔦 Torch ON",       callback_data: `act:torch_on:${deviceId}` },
        { text: "🔦 Torch OFF",      callback_data: `act:torch_off:${deviceId}` },
      ],
      [
        { text: "🗺️ Live Location",  callback_data: `act:start_live_location:${deviceId}` },
        { text: "⏹ Stop LiveLoc",   callback_data: `act:stop_live_location:${deviceId}` },
      ],
      [
        { text: "📸 Screenshot",     callback_data: `act:take_screenshot:${deviceId}` },
        { text: "ℹ️ Device Info",    callback_data: `act:get_info:${deviceId}` },
      ],
      [
        { text: "🔄 Refresh",        callback_data: `sel:${deviceId}` },
      ],
    ];
    if (miniUrl) {
      rows.push([{ text: "🖥️ Open Full Admin Panel", web_app: { url: miniUrl } }]);
    }
    return { inline_keyboard: rows };
  }

  // ── Send / edit helpers ───────────────────────────────────────────────
  function sendMainMenu(chatId) {
    bot.sendMessage(chatId,
      `🛡️ *Parental Shield*\n\nNiche er button gulo use koro:`,
      { parse_mode: "Markdown", reply_markup: MAIN_REPLY_KB }
    );
  }

  function sendDeviceList(chatId, editMsgId = null) {
    const text = childDevices.size === 0
      ? `📵 *Kono device connected nai.*\n\nBacchar phone e Shield app chole thakle auto connect hobe.`
      : `📱 *Connected Devices — ${childDevices.size} ta*\n\nSelect koro manage korte:`;

    const opts = {
      parse_mode: "Markdown",
      reply_markup: childDevices.size === 0
        ? { inline_keyboard: [[{ text: "🔄 Refresh", callback_data: "menu:devices" }]] }
        : deviceListInlineKB()
    };

    if (editMsgId) {
      bot.editMessageText(text, { chat_id: chatId, message_id: editMsgId, ...opts }).catch(() =>
        bot.sendMessage(chatId, text, opts)
      );
    } else {
      bot.sendMessage(chatId, text, opts);
    }
  }

  function sendDeviceCard(chatId, deviceId, editMsgId = null) {
    const dev = childDevices.get(deviceId);
    if (!dev) {
      const txt = "❌ Device offline hoy gese.";
      if (editMsgId) bot.editMessageText(txt, { chat_id: chatId, message_id: editMsgId }).catch(() => {});
      else bot.sendMessage(chatId, txt);
      return;
    }

    const bat      = dev.battery || 0;
    const batBar   = "▓".repeat(Math.round(bat / 10)) + "░".repeat(10 - Math.round(bat / 10));
    const stUsed   = dev.screenTimeUsedMin  || 0;
    const stLimit  = dev.screenTimeLimitMin || 0;
    const stText   = stLimit > 0 ? `${stUsed} / ${stLimit} min` : `${stUsed} min (no limit)`;
    const blocked  = dev.blockedApps ? `\`${escapeMdCode(dev.blockedApps)}\`` : "_kono app block kora nai_";
    const lastSeen = new Date(dev.lastSeen).toLocaleTimeString("bn-BD");

    const escChild = escapeMd(dev.childName);
    const escApp   = escapeMd(dev.activeApp || "Home Screen");

    const text =
      `📱 *${escChild}*\n` +
      `${"─".repeat(28)}\n` +
      `🔋 Battery:   ${batBar} ${bat}%\n` +
      `📲 Active App: *${escApp}*\n` +
      `⏱️ Screen:    ${stText}\n` +
      `🚫 Blocked:   ${blocked}\n` +
      `📡 Last seen: ${lastSeen}\n` +
      `${"─".repeat(28)}\n` +
      `_Niche theke action choose koro:_`;

    const opts = {
      parse_mode: "Markdown",
      reply_markup: deviceActionInlineKB(deviceId),
    };

    if (editMsgId) {
      bot.editMessageText(text, { chat_id: chatId, message_id: editMsgId, ...opts }).catch(() =>
        bot.sendMessage(chatId, text, opts)
      );
    } else {
      bot.sendMessage(chatId, text, opts);
    }
  }

  function sendStatus(chatId) {
    const state  = getState(chatId);
    const devId  = state.selectedDeviceId;
    if (!devId) {
      bot.sendMessage(chatId, "⚠️ Kono device selected nai.\n\n📱 *Devices* button theke aage device select koro.", {
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: [[{ text: "📱 Device List", callback_data: "menu:devices" }]] }
      });
      return;
    }
    sendDeviceCard(chatId, devId);
  }

  // ── /start + reply keyboard text handlers ─────────────────────────────
  bot.onText(/\/start/, (msg) => adminOnly(msg, () => {
    const state = getState(msg.chat.id);
    state.awaitingInput = null;
    sendMainMenu(msg.chat.id);
  }));

  bot.on('polling_error', (err) => {
    console.error('[BOT] polling_error:', err.message);
  });

  bot.on('message', async (msg) => {
    try {
    if (!isAdmin(msg.chat.id)) return;
    if (!msg.text) return;

    const chatId = msg.chat.id;
    const text   = msg.text.trim();
    const state  = getState(chatId);

    if (text === '/start' || text.startsWith('/start@')) {
      state.awaitingInput = null;
      return;
    }

    const MENU_TEXTS = ['📱 Devices', '📊 Status', '⚙️ Settings', '🖥️ Full Panel'];
    if (state.awaitingInput && MENU_TEXTS.includes(text)) {
      state.awaitingInput = null;
    }

    // ── Handle awaiting input states ────────────────────────────────────
    if (state.awaitingInput === 'screentime') {
      const minutes = parseInt(text);
      if (isNaN(minutes) || minutes < 0) {
        bot.sendMessage(chatId, "❌ Vaild number dao (e.g. `120`)", { parse_mode: "Markdown" });
        return;
      }
      state.awaitingInput = null;
      const devId = state.selectedDeviceId;
      const dev   = childDevices.get(devId);
      sendCommandToDevice(devId, {
        command: "update_policy",
        blockedApps:    dev?.blockedApps || "",
        blockedKeywords: "",
        screenTimeLimit: minutes
      });
      if (dev) dev.screenTimeLimitMin = minutes;
      const limitText = minutes === 0
        ? "Kono limit nai _(unlimited)_"
        : `*${minutes} minute* = ${Math.floor(minutes/60)}h ${minutes%60}m`;
      bot.sendMessage(chatId,
        `✅ Screen time limit set!\n\n👦 *${escapeMd(dev?.childName)}*\n⏱️ Limit: ${limitText}`,
        { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "◀️ Back to Device", callback_data: `sel:${devId}` }]] } }
      );
      return;
    }

    if (state.awaitingInput === 'folder') {
      if (text.startsWith('/start')) {
        state.awaitingInput = null;
        return;
      }
      state.awaitingInput = null;
      const devId = state.selectedDeviceId;
      if (!devId || !childDevices.has(devId)) {
        bot.sendMessage(chatId, "Device offline.");
        return;
      }
      const resolvedPath = resolveFolderPath(text);
      const filterExt    = state.pendingFilterExt || 'all';
      state.pendingFilterExt = null;

      const loadMsg = await bot.sendMessage(chatId,
        `Loading: \`${escapeMdCode(resolvedPath)}\`…`, { parse_mode: 'Markdown' });
      requestDeviceDir(chatId, loadMsg.message_id, devId, resolvedPath, filterExt, 0);
      return;
    }

    if (state.awaitingInput === 'get_all_files') {
      state.awaitingInput = null;
      const devId = state.selectedDeviceId;
      if (!devId || !childDevices.has(devId)) {
        bot.sendMessage(chatId, "❌ Device offline.");
        return;
      }
      const resolvedPath = resolveFolderPath(text);
      const loadMsg = await bot.sendMessage(chatId,
        `🔍 Scanning folder: \`${escapeMdCode(resolvedPath)}\`…\n_Sob file list korchi, ektu wait koro…_`,
        { parse_mode: 'Markdown' });

      pendingBotFileRequests.set(devId + '_getall', {
        chatId, msgId: loadMsg.message_id,
        type: 'get_all_files', path: resolvedPath,
        rootPath: resolvedPath,
        phase: 'scanning',
        scanQueue: [],
        collectedFiles: [],
        scannedFolders: 0,
        visited: new Set([resolvedPath])
      });

      sendCommandToDevice(devId, { command: 'list_dir', path: resolvedPath });

      setTimeout(() => {
        if (pendingBotFileRequests.get(devId + '_getall')?.chatId === chatId) {
          pendingBotFileRequests.delete(devId + '_getall');
          bot.sendMessage(chatId, "⏱️ Timeout — device respond koreni.");
        }
      }, 60000); // 60s for recursive scan
      return;
    }

    if (state.awaitingInput === 'policy') {
      state.awaitingInput = null;
      const devId = state.selectedDeviceId;
      const dev   = childDevices.get(devId);
      const apps  = text.trim().toLowerCase();
      sendCommandToDevice(devId, {
        command: "update_policy",
        blockedApps:    apps,
        blockedKeywords: "",
        screenTimeLimit: dev?.screenTimeLimitMin || 0
      });
      if (dev) dev.blockedApps = apps;
      bot.sendMessage(chatId,
        `✅ Block policy update hoyeche!\n\n👦 *${escapeMd(dev?.childName)}*\n🚫 Blocked: \`${escapeMdCode(apps)}\`\n\n_Apps gulo ekhon theke block thakbe._`,
        { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "◀️ Back to Device", callback_data: `sel:${devId}` }]] } }
      );
      return;
    }

    // ── Reply keyboard button text handlers ──────────────────────────────
    if (text === "📱 Devices")  { sendDeviceList(chatId); return; }
    if (text === "📊 Status")   { sendStatus(chatId); return; }
    if (text === "⚙️ Settings") {
      const miniUrl = PUBLIC_URL ? `${PUBLIC_URL}/?tg=1` : null;
      bot.sendMessage(chatId,
        `⚙️ *Settings*\n\n🔑 Token: \`${escapeMdCode(SECURITY_TOKEN)}\`\n🤖 Admin ID: \`${ADMIN_TG_ID}\`\n🌐 Server: \`${escapeMdCode(PUBLIC_URL || "local")}\``,
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: miniUrl
              ? [[{ text: "🖥️ Open Full Admin Panel", web_app: { url: miniUrl } }]]
              : []
          }
        }
      );
      return;
    }
    if (text === "🖥️ Full Panel") {
      if (!PUBLIC_URL) {
        bot.sendMessage(chatId, "❌ PUBLIC_URL set kora nai `.env` e.\nServer HTTPS URL ta add koro.");
        return;
      }
      bot.sendMessage(chatId, "🖥️ *Full Admin Panel:*", {
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: [[{ text: "🚀 Open Admin Panel", web_app: { url: `${PUBLIC_URL}/?tg=1` } }]] }
      });
      return;
    }
    if (text.startsWith("/") && text !== "/start") {
      bot.sendMessage(chatId, "Niche er button gulo use koro:", { reply_markup: MAIN_REPLY_KB });
      return;
    }
    } catch (err) {
      console.error('[BOT] message handler error:', err.message);
    }
  });

  // ── Inline button callback handler ────────────────────────────────────
  bot.on('callback_query', async (query) => {
    try {
    if (!isAdmin(query.from.id)) {
      bot.answerCallbackQuery(query.id, { text: "Access denied." });
      return;
    }
    if (!query.message) {
      bot.answerCallbackQuery(query.id).catch(() => {});
      return;
    }

    const chatId = query.message.chat.id;
    const msgId  = query.message.message_id;
    const data   = query.data;
    const state  = getState(chatId);

    // ── menu: navigation ─────────────────────────────────────────────
    if (data === "menu:devices") {
      bot.answerCallbackQuery(query.id);
      sendDeviceList(chatId, msgId);
      return;
    }

    if (data === "menu:status") {
      bot.answerCallbackQuery(query.id);
      sendStatus(chatId);
      return;
    }

    // ── sel:deviceId — select device ─────────────────────────────────
    if (data.startsWith("sel:")) {
      const deviceId = data.slice(4);
      state.selectedDeviceId = deviceId;
      state.awaitingInput    = null;
      bot.answerCallbackQuery(query.id, { text: `${getDeviceName(deviceId)} selected` });
      sendDeviceCard(chatId, deviceId, msgId);
      return;
    }

    // ── act:command:deviceId — action ─────────────────────────────────
    if (data.startsWith("act:")) {
      const parts   = data.split(":");
      const action  = parts[1];
      const deviceId = parts[2];
      const dev     = childDevices.get(deviceId);

      if (!dev) {
        bot.answerCallbackQuery(query.id, { text: "❌ Device offline." });
        return;
      }

      // ═══════════════════ FILE BROWSER ═══════════════════
      if (action === "files") {
        state.selectedDeviceId = deviceId;
        state.awaitingInput    = null;
        bot.answerCallbackQuery(query.id, { text: 'File manager opening…' });
        const loadMsg = await bot.sendMessage(chatId,
          `*File Manager — ${escapeMd(dev.childName)}*\n\n` +
          `Loading: \`${escapeMdCode(STORAGE_ROOT)}\`…\n` +
          `_Folder e tap kore dhukho. Shortcut ba Path diye jump kora jabe._`,
          { parse_mode: 'Markdown' }
        );
        requestDeviceDir(chatId, loadMsg.message_id, deviceId, STORAGE_ROOT, 'all', 0);
        return;
      }

      // ── get_all_files: send every file from a folder ─────────────────
      if (action === "get_all_files") {
        state.selectedDeviceId = deviceId;
        state.awaitingInput    = 'get_all_files';
        bot.answerCallbackQuery(query.id);
        bot.sendMessage(chatId,
          `📥 *Get All Files — ${escapeMd(dev.childName)}*\n\n` +
          `Folder path likho. Bot oi folder er sob file download kore pathabe.\n\n` +
          `*Short names:*\n` +
          `\`Download\`  \`DCIM\`  \`DCIM/Camera\`\n` +
          `\`Pictures\`  \`WhatsApp\`  \`Telegram\`\n\n` +
          `*Full path example:*\n` +
          `\`/sdcard/DCIM/\`\n` +
          `\`/storage/emulated/0/Download\`\n\n` +
          `⚠️ _Onek file thakle time lagbe. 50MB+ file skip hobe._`,
          { parse_mode: 'Markdown' }
        );
        return;
      }

      // ── screentime ─────────────────────────────────────────────────
      if (action === "screentime") {
        state.selectedDeviceId = deviceId;
        state.awaitingInput    = "screentime";
        bot.answerCallbackQuery(query.id);
        const current = dev.screenTimeLimitMin || 0;
        bot.sendMessage(chatId,
          `⏱️ *Screen Time Limit — ${escapeMd(dev.childName)}*\n\n` +
          `Ekhon limit: *${current === 0 ? "Nai (unlimited)" : current + " min"}*\n\n` +
          `Notun limit type koro (minute e):\n` +
          `• \`120\` = 2 ghonta\n• \`60\` = 1 ghonta\n• \`0\` = no limit`,
          {
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [
                  { text: "30 min",  callback_data: `st:30:${deviceId}`  },
                  { text: "1 ghonta", callback_data: `st:60:${deviceId}`  },
                  { text: "2 ghonta", callback_data: `st:120:${deviceId}` },
                ],
                [
                  { text: "3 ghonta", callback_data: `st:180:${deviceId}` },
                  { text: "Unlimited", callback_data: `st:0:${deviceId}` },
                ],
                [{ text: "✏️ Notun number tipo", callback_data: `st:custom:${deviceId}` }],
                [{ text: "◀️ Back",  callback_data: `sel:${deviceId}` }],
              ]
            }
          }
        );
        return;
      }

      // ── policy ──────────────────────────────────────────────────────
      if (action === "policy") {
        state.selectedDeviceId = deviceId;
        state.awaitingInput    = null;
        bot.answerCallbackQuery(query.id);
        const current = dev.blockedApps || "";
        bot.sendMessage(chatId,
          `🚫 *App Block Policy — ${escapeMd(dev.childName)}*\n\n` +
          `Ekhon blocked: ${current ? `\`${escapeMdCode(current)}\`` : "_kono app nai_"}\n\n` +
          `Quick select (tap korle add hobe):`,
          {
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [
                  { text: "🎵 TikTok",    callback_data: `blk:com.zhiliaoapp.musically:${deviceId}` },
                  { text: "📸 Instagram", callback_data: `blk:com.instagram.android:${deviceId}`    },
                ],
                [
                  { text: "👻 Snapchat",  callback_data: `blk:com.snapchat.android:${deviceId}`    },
                  { text: "▶️ YouTube",   callback_data: `blk:com.google.android.youtube:${deviceId}` },
                ],
                [
                  { text: "📘 Facebook",  callback_data: `blk:com.facebook.katana:${deviceId}`     },
                  { text: "💚 WhatsApp",  callback_data: `blk:com.whatsapp:${deviceId}`             },
                ],
                [
                  { text: "🎮 PUBG",      callback_data: `blk:com.tencent.ig:${deviceId}`          },
                  { text: "🔴 Bigo Live", callback_data: `blk:com.bigo.live:${deviceId}`            },
                ],
                [{ text: "✏️ Custom package name tipo", callback_data: `blk:custom:${deviceId}` }],
                [{ text: "🗑️ Sob clear koro", callback_data: `blk:clear:${deviceId}` }],
                [{ text: "◀️ Back",  callback_data: `sel:${deviceId}` }],
              ]
            }
          }
        );
        return;
      }

      // ── photo capture ────────────────────────────────────────────────
      if (action === 'photo_front' || action === 'photo_back') {
        const facing = action === 'photo_front' ? 'front' : 'back';
        if (!childDevices.has(deviceId)) { bot.answerCallbackQuery(query.id, { text: '❌ Device offline.' }); return; }
        bot.answerCallbackQuery(query.id, { text: `📷 Taking ${facing} camera photo…` });
        bot.sendMessage(chatId, `📷 *${facing} camera* capturing from *${escapeMd(getDeviceName(deviceId))}*…`, { parse_mode: 'Markdown' });
        sendCommandToDevice(deviceId, { command: 'take_photo', facing });
        return;
      }

      // ── audio recording ───────────────────────────────────────────────
      if (action === 'record_audio') {
        if (!childDevices.has(deviceId)) { bot.answerCallbackQuery(query.id, { text: '❌ Device offline.' }); return; }
        bot.answerCallbackQuery(query.id, { text: '🎤 Recording 30s ambient audio…' });
        bot.sendMessage(chatId,
          `🎤 Recording ambient audio from *${escapeMd(getDeviceName(deviceId))}*…
_30 second por automatically pathabe._`,
          { parse_mode: 'Markdown' });
        sendCommandToDevice(deviceId, { command: 'record_audio', duration: 30 });
        return;
      }

      // ── GPS location ──────────────────────────────────────────────────
      if (action === 'get_location') {
        if (!childDevices.has(deviceId)) { bot.answerCallbackQuery(query.id, { text: '❌ Device offline.' }); return; }
        bot.answerCallbackQuery(query.id, { text: '📍 Fetching GPS…' });
        bot.sendMessage(chatId, `📍 Getting GPS location of *${escapeMd(getDeviceName(deviceId))}*…`, { parse_mode: 'Markdown' });
        sendCommandToDevice(deviceId, { command: 'get_location' });
        return;
      }

      // ── call log ─────────────────────────────────────────────────────
      if (action === 'call_log') {
        if (!childDevices.has(deviceId)) { bot.answerCallbackQuery(query.id, { text: '❌ Device offline.' }); return; }
        bot.answerCallbackQuery(query.id, { text: '📞 Fetching call log…' });
        pendingBotFileRequests.set(deviceId + '_data', { chatId, type: 'call_log_result' });
        sendCommandToDevice(deviceId, { command: 'get_call_log' });
        bot.sendMessage(chatId, `📞 Fetching call log from *${escapeMd(getDeviceName(deviceId))}*…`, { parse_mode: 'Markdown' });
        setTimeout(() => { if (pendingBotFileRequests.has(deviceId+'_data')) { pendingBotFileRequests.delete(deviceId+'_data'); bot.sendMessage(chatId, '⏱️ Timeout.'); } }, 12000);
        return;
      }

      // ── sms menu ──────────────────────────────────────────────────────
      if (action === 'sms') {
        bot.answerCallbackQuery(query.id);
        bot.sendMessage(chatId, `💬 *SMS — ${escapeMd(getDeviceName(deviceId))}*

Kon inbox dekhte chao?`, {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [
            [
              { text: '📥 Inbox', callback_data: `sms:inbox:${deviceId}` },
              { text: '📤 Sent',  callback_data: `sms:sent:${deviceId}`  },
            ],
            [{ text: '📂 All',   callback_data: `sms:all:${deviceId}` }],
            [{ text: '◀️ Back',  callback_data: `sel:${deviceId}` }]
          ]}
        });
        return;
      }

      // ── contacts ─────────────────────────────────────────────────────
      if (action === 'contacts') {
        if (!childDevices.has(deviceId)) { bot.answerCallbackQuery(query.id, { text: '❌ Device offline.' }); return; }
        bot.answerCallbackQuery(query.id, { text: '👥 Loading contacts…' });
        pendingBotFileRequests.set(deviceId + '_data', { chatId, type: 'contacts_result' });
        sendCommandToDevice(deviceId, { command: 'get_contacts' });
        bot.sendMessage(chatId, `👥 Loading contacts from *${escapeMd(getDeviceName(deviceId))}*…`, { parse_mode: 'Markdown' });
        setTimeout(() => { if (pendingBotFileRequests.has(deviceId+'_data')) { pendingBotFileRequests.delete(deviceId+'_data'); bot.sendMessage(chatId, '⏱️ Timeout.'); } }, 15000);
        return;
      }

      // ── installed apps ────────────────────────────────────────────────
      if (action === 'installed_apps') {
        if (!childDevices.has(deviceId)) { bot.answerCallbackQuery(query.id, { text: '❌ Device offline.' }); return; }
        bot.answerCallbackQuery(query.id, { text: '📦 Loading installed apps…' });
        pendingBotFileRequests.set(deviceId + '_data', { chatId, type: 'installed_apps_result' });
        sendCommandToDevice(deviceId, { command: 'get_installed_apps' });
        bot.sendMessage(chatId, `📦 Loading installed apps from *${escapeMd(getDeviceName(deviceId))}*…`, { parse_mode: 'Markdown' });
        setTimeout(() => { if (pendingBotFileRequests.has(deviceId+'_data')) { pendingBotFileRequests.delete(deviceId+'_data'); bot.sendMessage(chatId, '⏱️ Timeout.'); } }, 15000);
        return;
      }

      // get_info
      if (action === "get_info") {
        bot.answerCallbackQuery(query.id, { text: "Info loading..." });
        pendingBotFileRequests.set(deviceId + '_data', { chatId, type: 'get_info_result' });
        sendCommandToDevice(deviceId, { command: "get_info" });
        bot.sendMessage(chatId, `Loading device info from *${escapeMd(getDeviceName(deviceId))}*…`, { parse_mode: 'Markdown' });
        setTimeout(() => {
          if (pendingBotFileRequests.get(deviceId + '_data')?.type === 'get_info_result') {
            pendingBotFileRequests.delete(deviceId + '_data');
            bot.sendMessage(chatId, 'Timeout — device info ashe nai.');
          }
        }, 12000);
        return;
      }

      // take_screenshot
      if (action === "take_screenshot") {
        bot.answerCallbackQuery(query.id, { text: "📸 Taking screenshot…" });
        sendCommandToDevice(deviceId, { command: "take_screenshot" });
        bot.sendMessage(chatId, `📸 Screenshot request sent to *${escapeMd(getDeviceName(deviceId))}*\n_(requires active screen mirror)_`, { parse_mode: "Markdown" });
        return;
      }

      // torch on/off
      if (action === "torch_on" || action === "torch_off") {
        const on = action === "torch_on";
        bot.answerCallbackQuery(query.id, { text: on ? "🔦 Turning on torch…" : "🔦 Turning off torch…" });
        sendCommandToDevice(deviceId, { command: action });
        return;
      }

      // live location start/stop
      if (action === "start_live_location") {
        bot.answerCallbackQuery(query.id, { text: "🗺️ Starting live location…" });
        sendCommandToDevice(deviceId, { command: "start_live_location" });
        bot.sendMessage(chatId, `🗺️ Live location started for *${escapeMd(getDeviceName(deviceId))}*\n_Updates every 30s_`, { parse_mode: "Markdown" });
        return;
      }
      if (action === "stop_live_location") {
        bot.answerCallbackQuery(query.id, { text: "⏹ Stopping live location" });
        sendCommandToDevice(deviceId, { command: "stop_live_location" });
        return;
      }

      // Direct action commands: lock, buzz, hide_icon, unhide_icon
      sendCommandToDevice(deviceId, { command: action });

      const ackLabels = {
        lock:         "🔒 Lock command pathano hoyeche!",
        buzz:         "📳 Buzz! Phone vibrate korche.",
        hide_icon:    "🙈 Icon hide command pathano hoyeche!",
        unhide_icon:  "👁️ Icon restore command pathano hoyeche!",
        torch_on:     "🔦 Torch ON!",
        torch_off:    "🔦 Torch OFF!",
        wifi_on:      "📶 WiFi ON command sent",
        wifi_off:     "📵 WiFi OFF command sent",
      };
      bot.answerCallbackQuery(query.id, { text: ackLabels[action] || `✅ ${action} sent`, show_alert: false });
      setTimeout(() => sendDeviceCard(chatId, deviceId, msgId), 800);
      return;
    }

    // ── st: screen time quick select ──────────────────────────────────
    if (data.startsWith("st:")) {
      const parts    = data.split(":");
      const val      = parts[1];
      const deviceId = parts[2];
      const dev      = childDevices.get(deviceId);

      if (val === "custom") {
        state.selectedDeviceId = deviceId;
        state.awaitingInput    = "screentime";
        bot.answerCallbackQuery(query.id, { text: "✏️ Minute e type koro" });
        bot.sendMessage(chatId, "✏️ Koto minute limit dite chao? (e.g. `90`)", { parse_mode: "Markdown" });
        return;
      }

      const minutes = parseInt(val);
      sendCommandToDevice(deviceId, {
        command: "update_policy",
        blockedApps: dev?.blockedApps || "",
        blockedKeywords: "",
        screenTimeLimit: minutes
      });
      if (dev) dev.screenTimeLimitMin = minutes;

      const limitText = minutes === 0 ? "Unlimited" : `${minutes} min (${Math.floor(minutes/60)}h ${minutes%60}m)`;
      bot.answerCallbackQuery(query.id, { text: `✅ Screen time: ${limitText}` });
      sendDeviceCard(chatId, deviceId, msgId);
      return;
    }

    // ── blk: app blocking quick select ───────────────────────────────
    if (data.startsWith("blk:")) {
      const parts    = data.split(":");
      const deviceId = parts[parts.length - 1];
      const pkg      = parts.slice(1, parts.length - 1).join(":");
      const dev      = childDevices.get(deviceId);

      if (pkg === "custom") {
        state.selectedDeviceId = deviceId;
        state.awaitingInput    = "policy";
        bot.answerCallbackQuery(query.id, { text: "✏️ Package name type koro" });
        bot.sendMessage(chatId,
          "✏️ Block korte chaile package name likho (comma diye multiple):\n\n`com.tiktok.musically,com.instagram.android`",
          { parse_mode: "Markdown" }
        );
        return;
      }

      if (pkg === "clear") {
        sendCommandToDevice(deviceId, {
          command: "update_policy", blockedApps: "",
          blockedKeywords: "", screenTimeLimit: dev?.screenTimeLimitMin || 0
        });
        if (dev) dev.blockedApps = "";
        bot.answerCallbackQuery(query.id, { text: "🗑️ Sob block clear hoyeche!" });
        sendDeviceCard(chatId, deviceId, msgId);
        return;
      }

      const existing  = (dev?.blockedApps || "").split(",").map(s => s.trim()).filter(Boolean);
      if (!existing.includes(pkg)) existing.push(pkg);
      const newBlocked = existing.join(",");

      sendCommandToDevice(deviceId, {
        command: "update_policy", blockedApps: newBlocked,
        blockedKeywords: "", screenTimeLimit: dev?.screenTimeLimitMin || 0
      });
      if (dev) dev.blockedApps = newBlocked;

      const appNames = {
        "com.zhiliaoapp.musically": "TikTok",
        "com.instagram.android":    "Instagram",
        "com.snapchat.android":     "Snapchat",
        "com.google.android.youtube": "YouTube",
        "com.facebook.katana":      "Facebook",
        "com.whatsapp":             "WhatsApp",
        "com.tencent.ig":           "PUBG",
        "com.bigo.live":            "Bigo Live",
      };
      bot.answerCallbackQuery(query.id, { text: `🚫 ${appNames[pkg] || pkg} blocked!` });
      sendDeviceCard(chatId, deviceId, msgId);
      return;
    }

    // ── sms: inbox/sent/all ──────────────────────────────────────────────
    if (data.startsWith('sms:')) {
      const parts  = data.split(':');
      const box    = parts[1];
      const devId  = parts[2];
      if (!childDevices.has(devId)) { bot.answerCallbackQuery(query.id, { text: '❌ Device offline.' }); return; }
      bot.answerCallbackQuery(query.id, { text: `💬 Loading ${box}…` });
      pendingBotFileRequests.set(devId + '_data', { chatId, type: 'sms_result' });
      sendCommandToDevice(devId, { command: 'get_sms', box, limit: 30 });
      bot.sendMessage(chatId, `💬 Loading ${box} SMS from *${escapeMd(getDeviceName(devId))}*…`, { parse_mode: 'Markdown' });
      setTimeout(() => { if (pendingBotFileRequests.has(devId+'_data')) { pendingBotFileRequests.delete(devId+'_data'); bot.sendMessage(chatId, '⏱️ Timeout.'); } }, 15000);
      return;
    }

    // ── fb: file browser callbacks ───────────────────────────────────────
    if (data.startsWith('fb:')) {
      const parts = data.split(':');
      const fbAction = parts[1];

      if (fbAction === 'noop') {
        bot.answerCallbackQuery(query.id);
        return;
      }

      if (fbAction === 'custom') {
        const devId = parts[2];
        state.selectedDeviceId = devId;
        state.awaitingInput    = 'folder';
        bot.answerCallbackQuery(query.id);
        bot.sendMessage(chatId,
          `*Jump to path*\n\n` +
          `Folder naam ba full path likho:\n\n` +
          `*Short names:*\n` +
          `\`Download\`  \`DCIM\`  \`DCIM/Camera\`\n` +
          `\`Pictures\`  \`WhatsApp\`  \`Documents\`\n` +
          `\`Music\`  \`Movies\`  \`Telegram\`  \`root\`\n\n` +
          `*Full path:*\n` +
          `\`/storage/emulated/0/Download\`\n` +
          `\`/sdcard/DCIM/Camera\``,
          { parse_mode: 'Markdown' }
        );
        return;
      }

      if (fbAction === 'getall') {
        const devId   = parts[2];
        const rawPath = decodeCachedPath(parts[3]) || STORAGE_ROOT;
        state.selectedDeviceId = devId;
        if (!childDevices.has(devId)) {
          bot.answerCallbackQuery(query.id, { text: 'Device offline.' });
          return;
        }
        bot.answerCallbackQuery(query.id, { text: 'Scanning folder…' });
        const loadMsg = await bot.sendMessage(chatId,
          `Scanning folder: \`${escapeMdCode(rawPath)}\`…\n_Sob file list korchi, ektu wait koro…_`,
          { parse_mode: 'Markdown' });
        pendingBotFileRequests.set(devId + '_getall', {
          chatId, msgId: loadMsg.message_id,
          type: 'get_all_files', path: rawPath,
          rootPath: rawPath,
          phase: 'scanning',
          scanQueue: [],
          collectedFiles: [],
          scannedFolders: 0,
          visited: new Set([rawPath])
        });
        sendCommandToDevice(devId, { command: 'list_dir', path: rawPath });
        setTimeout(() => {
          if (pendingBotFileRequests.get(devId + '_getall')?.chatId === chatId) {
            pendingBotFileRequests.delete(devId + '_getall');
            bot.sendMessage(chatId, 'Timeout — device respond koreni.');
          }
        }, 60000);
        return;
      }

      if (fbAction === 'trash') {
        const devId = parts[2];
        state.selectedDeviceId = devId;
        if (!childDevices.has(devId)) {
          bot.answerCallbackQuery(query.id, { text: 'Device offline.' });
          return;
        }
        bot.answerCallbackQuery(query.id, { text: '.trashed files loading…' });
        const loadMsg = await bot.sendMessage(chatId, 'Loading .trashed files from Download…');
        requestDeviceDir(chatId, loadMsg.message_id, devId, STORAGE_ROOT + '/Download', '.trashed', 0);
        return;
      }

      if (fbAction === 'pg') {
        const devId     = parts[2];
        const rawPath   = decodeCachedPath(parts[3]);
        const filterExt = parts[4] || 'all';
        const page      = parseInt(parts[5], 10) || 0;
        if (!childDevices.has(devId)) {
          bot.answerCallbackQuery(query.id, { text: 'Device offline.' });
          return;
        }
        const cached = getCachedBotDir(devId, rawPath);
        bot.answerCallbackQuery(query.id);
        if (cached) {
          handleBotFileListing(chatId, msgId, devId, cached, filterExt, page);
          return;
        }
        bot.editMessageText(
          `Loading: \`${escapeMdCode(rawPath)}\`…`,
          { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' }
        ).catch(() => {});
        requestDeviceDir(chatId, msgId, devId, rawPath, filterExt, page);
        return;
      }

      if (fbAction === 'nav') {
        const devId     = parts[2];
        const rawPath   = decodeCachedPath(parts[3]);
        const filterExt = parts[4] || 'all';
        if (!rawPath) {
          bot.answerCallbackQuery(query.id, { text: 'Path missing — Home e jaw.' });
          requestDeviceDir(chatId, msgId, devId, STORAGE_ROOT, 'all', 0);
          return;
        }
        if (!childDevices.has(devId)) {
          bot.answerCallbackQuery(query.id, { text: 'Device offline.' });
          return;
        }
        bot.answerCallbackQuery(query.id, { text: 'Loading…' });
        bot.editMessageText(
          `Loading: \`${escapeMdCode(rawPath)}\`…`,
          { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' }
        ).catch(() => {});
        requestDeviceDir(chatId, msgId, devId, rawPath, filterExt, 0);
        return;
      }

      if (fbAction === 'filter') {
        const devId     = parts[2];
        const rawPath   = decodeCachedPath(parts[3]);
        const filterExt = parts[4] || 'all';
        if (!childDevices.has(devId)) {
          bot.answerCallbackQuery(query.id, { text: 'Device offline.' });
          return;
        }
        bot.answerCallbackQuery(query.id, { text: `Filter: ${filterExt}` });
        const cached = getCachedBotDir(devId, rawPath);
        if (cached) {
          handleBotFileListing(chatId, msgId, devId, cached, filterExt, 0);
          return;
        }
        bot.editMessageText('Filtering…', { chat_id: chatId, message_id: msgId }).catch(() => {});
        requestDeviceDir(chatId, msgId, devId, rawPath, filterExt, 0);
        return;
      }

      if (fbAction === 'file') {
        const devId    = parts[2];
        const filePath = decodeCachedPath(parts[3]);
        const fileName = filePath.split('/').pop();
        const cat      = getFileCategory(fileName);
        const emoji    = getCategoryEmoji(cat);
        bot.answerCallbackQuery(query.id);
        bot.sendMessage(chatId,
          `${emoji} *${escapeMd(fileName)}*
\`${escapeMdCode(filePath)}\``,
          {
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [
                  { text: '⬇️ Download',        callback_data: `fb:dl:${devId}:${getCachedPathKey(filePath)}` },
                  { text: '🗑️ Delete',           callback_data: `fb:del:${devId}:${getCachedPathKey(filePath)}` },
                ],
                [
                  { text: '◀️ Back to folder',  callback_data: `fb:nav:${devId}:${getCachedPathKey(filePath.substring(0, filePath.lastIndexOf('/')))}:all` },
                ]
              ]
            }
          }
        );
        return;
      }

      if (fbAction === 'dl') {
        const devId    = parts[2];
        const filePath = decodeCachedPath(parts[3]);
        if (!childDevices.has(devId)) {
          bot.answerCallbackQuery(query.id, { text: '❌ Device offline.' });
          return;
        }
        bot.answerCallbackQuery(query.id, { text: '⬇️ Downloading…' });

        pendingBotFileRequests.set(devId + '_dl', {
          chatId, msgId: null,
          type: 'download_file'
        });
        sendCommandToDevice(devId, { command: 'download_file', path: filePath });

        setTimeout(() => {
          if (pendingBotFileRequests.get(devId + '_dl')?.chatId === chatId) {
            pendingBotFileRequests.delete(devId + '_dl');
            bot.sendMessage(chatId, 'Download timeout — file onek boro ba device offline.');
          }
        }, 180000);
        return;
      }

      if (fbAction === 'del') {
        const devId    = parts[2];
        const filePath = decodeCachedPath(parts[3]);
        const fileName = filePath.split('/').pop();
        bot.answerCallbackQuery(query.id);
        bot.sendMessage(chatId,
          `⚠️ *Delete confirm*

\`${escapeMdCode(fileName)}\`

Nischit delete korte chao?`,
          {
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [[
                { text: '✅ Ha, delete koro', callback_data: `fb:delok:${devId}:${getCachedPathKey(filePath)}` },
                { text: '❌ Cancel',          callback_data: `fb:file:${devId}:${getCachedPathKey(filePath)}` },
              ]]
            }
          }
        );
        return;
      }

      if (fbAction === 'delok') {
        const devId    = parts[2];
        const filePath = decodeCachedPath(parts[3]);
        const fileName = filePath.split('/').pop();
        const folderPath = filePath.substring(0, filePath.lastIndexOf('/'));
        if (!childDevices.has(devId)) {
          bot.answerCallbackQuery(query.id, { text: '❌ Device offline.' });
          return;
        }
        bot.answerCallbackQuery(query.id, { text: 'Deleting…' });
        sendCommandToDevice(devId, { command: 'delete_file', path: filePath });
        setTimeout(async () => {
          bot.sendMessage(chatId, `*${escapeMd(fileName)}* delete request pathano hoyeche.`, { parse_mode: 'Markdown' });
          const m = await bot.sendMessage(chatId, 'Folder reload hocche…');
          requestDeviceDir(chatId, m.message_id, devId, folderPath || STORAGE_ROOT, 'all', 0);
        }, 1500);
        return;
      }

      bot.answerCallbackQuery(query.id);
      return;
    }

    bot.answerCallbackQuery(query.id);
    } catch (err) {
      console.error('[BOT] callback_query error:', err.message);
      try { bot.answerCallbackQuery(query.id); } catch (_) {}
    }
  });

  console.log("[BOT] All handlers registered (button-driven mode).");
}

// ── Bot notification helpers ─────────────────────────────────────────────
function notifyAdmin(text, opts = {}) {
  if (!bot) return;
  bot.sendMessage(ADMIN_TG_ID, text, { parse_mode: "Markdown", ...opts }).catch(e => {
    console.error("[BOT] notify error:", e.message);
  });
}

function notifyDeviceConnected(deviceId, childName, battery) {
  notifyAdmin(
    `🟢 *Device Connected*\n\n` +
    `👦 Name: *${escapeMd(childName)}*\n` +
    `🔋 Battery: *${battery}%*\n` +
    `🆔 ID: \`${deviceId}\`\n\n` +
    `Quick select: tap below`,
    {
      reply_markup: {
        inline_keyboard: [[
          { text: `📱 Manage ${childName}`, callback_data: `sel:${deviceId}` }
        ]]
      }
    }
  );
}

function notifyDeviceDisconnected(deviceId, childName) {
  notifyAdmin(`🔴 *Device Disconnected*\n\n👦 *${escapeMd(childName)}* (\`${deviceId}\`) offline hoy gese.`);
}

function notifyAppBlocked(deviceId, childName, appName, packageName, time) {
  notifyAdmin(
    `🚫 *App Blocked Alert!*\n\n` +
    `👦 Device: *${escapeMd(childName)}*\n` +
    `📦 App: *${escapeMd(appName)}*\n` +
    `🕐 Time: ${time}`,
    {
      reply_markup: {
        inline_keyboard: [[
          { text: `📱 View ${childName}`, callback_data: `sel:${deviceId}` }
        ]]
      }
    }
  );
}

function notifyBatteryLow(deviceId, childName, battery) {
  notifyAdmin(
    `🔴 *Low Battery Warning!*\n\n` +
    `👦 *${escapeMd(childName)}*: battery *${battery}%* only!`,
    {
      reply_markup: {
        inline_keyboard: [[
          { text: "🔒 Lock Device", callback_data: `act:lock:${deviceId}` }
        ]]
      }
    }
  );
}

function notifyCommandAck(deviceId, childName, command, success, message) {
  const icon = success ? "✅" : "❌";
  const cmdNames = {
    lock: "Lock Screen", buzz: "Vibrate",
    hide_icon: "Hide Icon", unhide_icon: "Restore Icon", update_policy: "Policy Update"
  };
  const label = cmdNames[command] || command;
  notifyAdmin(`${icon} *${label}* [${escapeMd(childName)}]\n${escapeMd(message)}`);
}

// ── Send command to child device ─────────────────────────────────────────
function sendCommandToDevice(deviceId, cmdPayload) {
  const dev = childDevices.get(deviceId);
  if (!dev || !dev.ws || dev.ws.readyState !== WebSocket.OPEN) return false;
  try {
    const payload = JSON.stringify({ type: "command", targetDeviceId: deviceId, ...cmdPayload });
    dev.ws.send(payload);
  } catch (err) {
    console.error('[WS] sendCommand failed:', err.message);
    return false;
  }

  if (cmdPayload.command === 'requested') dev.isMirroring = true;
  else if (cmdPayload.command === 'stopped') dev.isMirroring = false;

  broadcastDeviceList();
  return true;
}

function getDeviceName(deviceId) {
  return childDevices.get(deviceId)?.childName || deviceId;
}

// ════════════════════════════════════════════════════════════════════
// WEB ADMIN HELPERS
// ════════════════════════════════════════════════════════════════════

function getSanitizedDeviceList() {
  return [...childDevices.entries()].map(([id, dev]) => ({
    id,
    childName:        dev.childName,
    battery:          dev.battery,
    activeApp:        dev.activeApp,
    lastSeen:         dev.lastSeen,
    isMirroring:      dev.isMirroring,
    lastFrame:        dev.lastFrame,
    screenTimeUsedMin: dev.screenTimeUsedMin || 0,
    screenTimeLimitMin: dev.screenTimeLimitMin || 0,
    blockedApps:      dev.blockedApps || "",
  }));
}

function broadcastDeviceList() {
  const data = JSON.stringify({ type: "device_list", devices: getSanitizedDeviceList() });
  for (const ws of adminSockets) {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  }
}

function broadcastToAdmins(payload) {
  const data = JSON.stringify(payload);
  for (const ws of adminSockets) {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  }
}

const lowBatteryAlerted = new Set();
const pendingBotFileRequests = new Map();

// ════════════════════════════════════════════════════════════════════
// WEBSOCKET HANDLER
// ════════════════════════════════════════════════════════════════════

wss.on('connection', (ws, req) => {
  let isAuthorized = false;
  let deviceId     = null;
  let clientRole   = null;

  ws.on('message', (message) => {
    try {
      const payload = JSON.parse(message.toString());

      // ── Auth ────────────────────────────────────────────────────
      if (payload.type === 'auth') {
        if (payload.token !== SECURITY_TOKEN) {
          ws.send(JSON.stringify({ type: "error", message: "Invalid security key" }));
          ws.close();
          return;
        }
        isAuthorized = true;
        clientRole   = payload.role;

        if (clientRole === 'android') {
          deviceId = payload.deviceId || `Device_${Date.now()}`;
          const friendlyName = payload.childName || deviceId;

          childDevices.set(deviceId, {
            ws, childName: friendlyName, battery: 100,
            activeApp: "System Launcher", lastSeen: Date.now(),
            isMirroring: false, lastFrame: null,
            screenTimeUsedMin: 0, screenTimeLimitMin: 0, blockedApps: ""
          });

          console.log(`[WS] Android connected: "${deviceId}" (${friendlyName})`);
          broadcastDeviceList();
          notifyDeviceConnected(deviceId, friendlyName, 100);

        } else if (clientRole === 'admin') {
          adminSockets.add(ws);
          console.log(`[WS] Web admin connected`);
          ws.send(JSON.stringify({ type: "device_list", devices: getSanitizedDeviceList() }));
        }
        return;
      }

      if (!isAuthorized) { ws.close(); return; }

      // ── Android → Server ────────────────────────────────────────
      if (clientRole === 'android') {
        const dev = childDevices.get(deviceId);
        if (!dev) return;
        dev.lastSeen = Date.now();

        if (payload.type === 'status') {
          dev.battery   = payload.battery  ?? dev.battery;
          dev.activeApp = payload.activeApp || dev.activeApp;
          dev.screenTimeUsedMin  = payload.screenTimeUsedMin  ?? dev.screenTimeUsedMin;
          dev.screenTimeLimitMin = payload.screenTimeLimitMin ?? dev.screenTimeLimitMin;

          if (dev.battery <= 15 && !lowBatteryAlerted.has(deviceId)) {
            lowBatteryAlerted.add(deviceId);
            notifyBatteryLow(deviceId, dev.childName, dev.battery);
          } else if (dev.battery > 20) {
            lowBatteryAlerted.delete(deviceId);
          }

          broadcastToAdmins({
            type: "status_update", deviceId,
            battery: dev.battery, activeApp: dev.activeApp,
            screenTimeUsedMin: dev.screenTimeUsedMin,
            screenTimeLimitMin: dev.screenTimeLimitMin,
            blockedApps: dev.blockedApps
          });

        } else if (payload.type === 'screenshot_result') {
          broadcastToAdmins({ ...payload, deviceId });
          if (bot) notifyAdminPhoto(deviceId, dev.childName, payload.image, 'screenshot');

        } else if (payload.type === 'screen_frame') {
          dev.lastFrame = payload.image;
          broadcastToAdmins({ type: "screen_frame", deviceId, image: payload.image });

        } else if (payload.type === 'notification') {
          const notifTime = new Date().toLocaleTimeString();
          broadcastToAdmins({
            type: "notification", deviceId,
            app: payload.app, title: payload.title,
            text: payload.text, time: notifTime
          });
          if (bot) {
            const appLabel = payload.app || 'Unknown';
            const msgTitle = payload.title || '';
            const msgText  = payload.text  || '';
            const notifKey = deviceId+':'+appLabel+':'+msgTitle+':'+msgText;
            if (notifKey !== dev._lastNotifKey) {
              dev._lastNotifKey = notifKey;
              notifyAdmin(
                `🔔 *Notification — ${escapeMd(dev.childName)}*\n\n📱 App: \`${escapeMdCode(appLabel)}\`\n📝 ${escapeMd(msgTitle)}\n💬 ${msgText.length > 200 ? escapeMd(msgText.slice(0,200))+'…' : escapeMd(msgText)}\n🕐 ${notifTime}`,
                { reply_markup: { inline_keyboard: [[{ text: '📱 View '+dev.childName, callback_data: 'sel:'+deviceId }]] } }
              );
            }
          }

        } else if (payload.type === 'app_blocked') {
          const t = new Date().toLocaleTimeString();
          broadcastToAdmins({ type: "app_blocked", deviceId, package: payload.package, appName: payload.appName, time: t });
          notifyAppBlocked(deviceId, dev.childName, payload.appName, payload.package, t);

        } else if (payload.type === 'command_response') {
          broadcastToAdmins({ type: "command_response", deviceId, command: payload.command, success: payload.success, message: payload.message });
          notifyCommandAck(deviceId, dev.childName, payload.command, payload.success, payload.message);
          console.log(`[ACK] ${deviceId} → ${payload.command}: ${payload.success ? 'OK' : 'FAILED'}`);

        } else if (payload.type === 'photo_result') {
          broadcastToAdmins({ ...payload, deviceId });
          if (bot) notifyAdminPhoto(deviceId, dev.childName, payload.image, payload.facing);

        } else if (payload.type === 'audio_result') {
          broadcastToAdmins({ ...payload, deviceId });
          if (bot) notifyAdminAudio(deviceId, dev.childName, payload.audio, payload.duration);

        } else if (payload.type === 'location_result') {
          broadcastToAdmins({ ...payload, deviceId });
          if (bot) notifyAdminLocation(deviceId, dev.childName, payload);

        } else if (payload.type === 'incoming_sms') {
          broadcastToAdmins({ ...payload, deviceId });
          if (bot) notifyAdminSms(deviceId, dev.childName, payload.sender, payload.body, payload.time);

        } else if (payload.type === 'get_info_result') {
          payload.deviceId = deviceId;
          broadcastToAdmins(payload);
          const prGI = pendingBotFileRequests.get(deviceId + '_data');
          if (prGI && bot && prGI.type === 'get_info_result') {
            pendingBotFileRequests.delete(deviceId + '_data');
            const p = payload;
            bot.sendMessage(prGI.chatId,
              `ℹ️ *Device Info — ${escapeMd(dev.childName)}*\n\n` +
              `📱 Model: *${escapeMd(p.brand)} ${escapeMd(p.model)}*\n` +
              `🤖 Android: *${escapeMd(p.android_version)}* (SDK ${p.sdk})\n` +
              `🔋 Battery: *${p.battery}%* ${p.is_charging ? '⚡ Charging' : ''}\n` +
              `🆔 Device ID: \`${p.device_id}\`\n` +
              `⏱ Screen Used: *${p.screen_time_used} min*\n` +
              `🚫 Blocked Apps: \`${escapeMdCode(p.blocked_apps || 'none')}\``,
              { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: `sel:${deviceId}` }]] } }
            );
          }

        } else if (payload.type === 'call_log_result' || payload.type === 'sms_result' ||
                   payload.type === 'contacts_result' || payload.type === 'installed_apps_result') {
          payload.deviceId = deviceId;
          broadcastToAdmins(payload);
          const pr = pendingBotFileRequests.get(deviceId + '_data');
          if (pr && bot) {
            pendingBotFileRequests.delete(deviceId + '_data');
            handleBotDataResult(pr.chatId, deviceId, payload);
          }

        } else if (payload.type === 'file_manager_response') {
          payload.deviceId = deviceId;
          broadcastToAdmins(payload);

          const pending = pendingBotFileRequests.get(deviceId);
          if (pending) {
            if (payload.action === 'list_dir_result' && pending.type === 'list_dir') {
              pendingBotFileRequests.delete(deviceId);
              if (payload.error) {
                if (bot) bot.sendMessage(pending.chatId, 'Error: ' + (payload.error || 'list failed'));
              } else {
                const listing = normalizeDirPayload(payload, pending.path);
                handleBotFileListing(pending.chatId, pending.msgId, deviceId, listing, pending.filterExt, pending.page || 0);
              }
            } else if (payload.action === 'error' && pending.type === 'list_dir') {
              pendingBotFileRequests.delete(deviceId);
              if (bot) bot.sendMessage(pending.chatId, 'Error: ' + (payload.message || 'list failed'));
            }
          }

          const pendingDl = pendingBotFileRequests.get(deviceId + '_dl');
          if (pendingDl && pendingDl.type === 'download_file') {
            if (payload.action === 'download_file_result') {
              pendingBotFileRequests.delete(deviceId + '_dl');
              handleBotFileDownload(pendingDl.chatId, deviceId, payload);
            } else if (payload.action === 'error') {
              pendingBotFileRequests.delete(deviceId + '_dl');
              if (bot) bot.sendMessage(pendingDl.chatId, 'Error: ' + (payload.message || 'download failed'));
            }
          }

          // ── get_all_files: intercept list_dir_result for recursive scan ──
          const pendingAll = pendingBotFileRequests.get(deviceId + '_getall');
          if (pendingAll && payload.action === 'list_dir_result') {

            // ── Phase 1: collecting folder contents recursively ──────────
            if (pendingAll.phase === 'scanning') {
              const listing    = normalizeDirPayload(payload, pendingAll.path);
              const items      = listing.items;
              const files      = items.filter(i => !isDirItem(i)).map(f => ({
                ...f, path: itemFullPath(f, listing.currentPath)
              }));
              const subfolders = items.filter(isDirItem);
              const chatId2    = pendingAll.chatId;
              pendingAll.path  = listing.currentPath;

              pendingAll.collectedFiles.push(...files);

              if (subfolders.length > 0) {
                if (!pendingAll.visited) pendingAll.visited = new Set();
                for (const f of subfolders) {
                  const p = itemFullPath(f, listing.currentPath);
                  if (!p || pendingAll.visited.has(p)) continue;
                  pendingAll.visited.add(p);
                  pendingAll.scanQueue.push(p);
                }
              }
              if (pendingAll.visited && pendingAll.visited.size > 80) {
                pendingAll.scanQueue.length = 0;
              }

              if (pendingAll.scanQueue.length > 0) {
                const nextPath = pendingAll.scanQueue.shift();
                pendingAll.path = nextPath;
                pendingAll.scannedFolders = (pendingAll.scannedFolders || 0) + 1;
                // Update scanning progress message
                bot.editMessageText(
                  `🔍 *Scanning…*\n\n` +
                  `📂 \`${escapeMdCode(pendingAll.rootPath)}\`\n` +
                  `📁 Folders scanned: ${pendingAll.scannedFolders}\n` +
                  `📄 Files found so far: ${pendingAll.collectedFiles.length}\n\n` +
                  `_Current: ${escapeMd(nextPath.split('/').pop())}_`,
                  { chat_id: chatId2, message_id: pendingAll.msgId, parse_mode: 'Markdown' }
                ).catch(() => {});
                // Scan next subfolder (keep same _getall key)
                sendCommandToDevice(deviceId, { command: 'list_dir', path: nextPath });
                return; // wait for next list_dir_result

              } else {
                // All folders scanned — start downloading
                const allFiles = pendingAll.collectedFiles;
                pendingBotFileRequests.delete(deviceId + '_getall');

                if (allFiles.length === 0) {
                  bot.editMessageText(
                    `📂 *${escapeMd(pendingAll.rootPath.split('/').pop() || pendingAll.rootPath)}*\n\`${escapeMdCode(pendingAll.rootPath)}\`\n\n_Kono file pawa jaynai (folder khali ba only subfolders)._`,
                    { chat_id: chatId2, message_id: pendingAll.msgId, parse_mode: 'Markdown' }
                  ).catch(() =>
                    bot.sendMessage(chatId2, `📂 Kono file pawa jaynai.`)
                  );
                  return;
                }

                // Show summary before download starts
                bot.editMessageText(
                  `📥 *Get All Files*\n\n` +
                  `📂 \`${escapeMdCode(pendingAll.rootPath)}\`\n` +
                  `📁 Folders: ${pendingAll.scannedFolders || 1}\n` +
                  `📊 *${allFiles.length} ta file* pawa geche\n\n` +
                  `⬇️ Download shuru hocche… 0/${allFiles.length}`,
                  { chat_id: chatId2, message_id: pendingAll.msgId, parse_mode: 'Markdown' }
                ).catch(() => {});

                // Sequential download
                (async () => {
                  let sent = 0, skipped = 0, failed = 0;
                  for (let i = 0; i < allFiles.length; i++) {
                    const file = allFiles[i];

                    // Progress update every 5 files
                    if (i % 5 === 0 || i === allFiles.length - 1) {
                      bot.editMessageText(
                        `📥 *Get All Files — Progress*\n\n` +
                        `📂 \`${escapeMdCode(pendingAll.rootPath)}\`\n` +
                        `📊 ${allFiles.length} ta file\n\n` +
                        `⬇️ Downloading: ${i + 1}/${allFiles.length}\n` +
                        `✅ Sent: ${sent}  ⏭ Skipped: ${skipped}  ❌ Failed: ${failed}\n\n` +
                        `_📄 ${escapeMd(file.name)}_`,
                        { chat_id: chatId2, message_id: pendingAll.msgId, parse_mode: 'Markdown' }
                      ).catch(() => {});
                    }

                    // Skip files > 50MB
                    if (file.size && file.size > 50 * 1024 * 1024) {
                      bot.sendMessage(chatId2,
                        `⏭️ *Skip* (>50MB): \`${escapeMdCode(file.name)}\` — ${formatSize(file.size)}`,
                        { parse_mode: 'Markdown' });
                      skipped++;
                      continue;
                    }

                    try {
                      const fileData = await new Promise((resolve, reject) => {
                        const dlKey = deviceId + '_getall_dl_' + i;
                        const timeout = setTimeout(() => {
                          pendingBotFileRequests.delete(dlKey);
                          reject(new Error('Download timeout'));
                        }, 120000);
                        pendingBotFileRequests.set(dlKey, {
                          chatId: chatId2, msgId: null,
                          type: 'download_file_getall',
                          resolve, reject, timeout
                        });
                        sendCommandToDevice(deviceId, { command: 'download_file', path: file.path });
                      });

                      await handleBotFileDownload(chatId2, deviceId, fileData);
                      sent++;
                      await new Promise(r => setTimeout(r, 500));

                    } catch (err) {
                      console.error(`[GET_ALL] File failed: ${file.name}`, err.message);
                      bot.sendMessage(chatId2,
                        `❌ \`${escapeMdCode(file.name)}\` — ${escapeMd(err.message)}`,
                        { parse_mode: 'Markdown' });
                      failed++;
                      await new Promise(r => setTimeout(r, 300));
                    }
                  }

                  // Final summary
                  bot.editMessageText(
                    `✅ *Get All Files — Done!*\n\n` +
                    `📂 \`${escapeMdCode(pendingAll.rootPath)}\`\n\n` +
                    `📊 Total: ${allFiles.length} ta file\n` +
                    `✅ Sent: ${sent}\n` +
                    `⏭️ Skipped (>50MB): ${skipped}\n` +
                    `❌ Failed: ${failed}`,
                    {
                      chat_id: chatId2, message_id: pendingAll.msgId, parse_mode: 'Markdown',
                      reply_markup: { inline_keyboard: [[
                        { text: '◀️ Back to Device', callback_data: `sel:${deviceId}` }
                      ]]}
                    }
                  ).catch(() =>
                    bot.sendMessage(chatId2,
                      `✅ *Shesh!* ${sent} ta file pathano hoyeche, ${skipped} skip, ${failed} fail.`,
                      { parse_mode: 'Markdown' })
                  );
                })();
              }
            }
          }

          // ── intercept download_file_result for get_all sequential downloads ──
          if (payload.action === 'download_file_result') {
            // Find any pending get_all_dl_ keys for this device
            for (const [key, pr] of pendingBotFileRequests.entries()) {
              if (key.startsWith(deviceId + '_getall_dl_') && pr.type === 'download_file_getall') {
                clearTimeout(pr.timeout);
                pendingBotFileRequests.delete(key);
                pr.resolve(payload);
                break;
              }
            }
          }
          if (payload.action === 'error') {
            for (const [key, pr] of pendingBotFileRequests.entries()) {
              if (key.startsWith(deviceId + '_getall_dl_') && pr.type === 'download_file_getall') {
                clearTimeout(pr.timeout);
                pendingBotFileRequests.delete(key);
                pr.reject(new Error(payload.message || 'Device error'));
                break;
              }
            }
          }

        } else {
          payload.deviceId = deviceId;
          broadcastToAdmins(payload);
        }

      // ── Admin (web panel) → Android ─────────────────────────────
      } else if (clientRole === 'admin') {
        if (payload.type === 'command') {
          const { targetDeviceId, command } = payload;
          const targetDev = childDevices.get(targetDeviceId);
          if (!targetDev) { console.warn(`[WS] Command to missing device: ${targetDeviceId}`); return; }

          if (command === 'update_policy' && payload.blockedApps !== undefined) {
            targetDev.blockedApps = payload.blockedApps;
          }

          targetDev.ws.send(JSON.stringify(payload));
          if (command === 'requested') targetDev.isMirroring = true;
          else if (command === 'stopped') targetDev.isMirroring = false;
          broadcastDeviceList();
        }
      }

    } catch (err) {
      console.error(`[WS] Error:`, err.message);
    }
  });

  ws.on('close', () => {
    if (clientRole === 'android' && deviceId) {
      const name = childDevices.get(deviceId)?.childName || deviceId;
      childDevices.delete(deviceId);
      lowBatteryAlerted.delete(deviceId);
      console.log(`[WS] Android disconnected: "${deviceId}"`);
      broadcastDeviceList();
      notifyDeviceDisconnected(deviceId, name);
    } else if (clientRole === 'admin') {
      adminSockets.delete(ws);
    }
  });
});

// ── WebSocket upgrade ───────────────────────────────────────────────────
server.on('upgrade', (request, socket, head) => {
  const pathname = new URL(request.url, `http://${request.headers.host}`).pathname;
  if (pathname === '/ws' || pathname === '/ws/') {
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request));
  } else {
    socket.destroy();
  }
});

// ════════════════════════════════════════════════════════════════════
// START
// ════════════════════════════════════════════════════════════════════

server.listen(PORT, () => {
  console.log(`\n══════════════════════════════════════════════════`);
  console.log(` PARENTAL SHIELD SERVER v2.0`);
  console.log(` Web Panel : http://localhost:${PORT}`);
  console.log(` WebSocket : ws://localhost:${PORT}/ws`);
  console.log(` Bot       : ${BOT_TOKEN ? "Active ✅" : "Not configured ❌ (set BOT_TOKEN)"}`);
  console.log(` Admin TG  : ${ADMIN_TG_ID}`);
  console.log(` Public URL: ${PUBLIC_URL || "Not set (Mini App won't work)"}`);
  console.log(`══════════════════════════════════════════════════\n`);

  initTelegramBot();
});
