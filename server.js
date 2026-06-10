const express  = require("express");
const http     = require("http");
const { Server } = require("socket.io");
const Database = require("better-sqlite3");
const path     = require("path");
const crypto   = require("crypto");

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);

app.use(express.static("public"));
app.use(express.json());

// ════════════════════════════════
//  SQLite 初期化
// ════════════════════════════════
const DB_PATH = path.join(__dirname, "data.db");
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS orders (
    id          INTEGER PRIMARY KEY,
    item        TEXT    NOT NULL,
    quantity    INTEGER NOT NULL,
    slot        TEXT    NOT NULL,
    paid        INTEGER NOT NULL DEFAULT 0,
    received    INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS device_orders (
    fingerprint TEXT NOT NULL,
    ls_key      TEXT NOT NULL,
    order_date  TEXT NOT NULL,
    count       INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (fingerprint, order_date)
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS slot_config (
    start_hour    INTEGER NOT NULL DEFAULT 9,
    start_minute  INTEGER NOT NULL DEFAULT 0,
    end_hour      INTEGER NOT NULL DEFAULT 15,
    end_minute    INTEGER NOT NULL DEFAULT 0,
    interval_min  INTEGER NOT NULL DEFAULT 10,
    default_cap   INTEGER NOT NULL DEFAULT 100,
    id            INTEGER PRIMARY KEY DEFAULT 1
  );

  INSERT OR IGNORE INTO slot_config (id) VALUES (1);

  -- 商品ごとの1日販売上限
  INSERT OR IGNORE INTO settings VALUES ('daily_limit_アイス', '500');
  INSERT OR IGNORE INTO settings VALUES ('daily_limit_ラムネ', '500');
`);

// ════════════════════════════════
//  スロット管理（メモリ上で保持、起動時にDBから再構築）
// ════════════════════════════════
const MAX_QTY_PER_ORDER = 5;
const MAX_ORDERS_PER_DAY = 2;
const slots = {};

function getSlotConfig() {
  return db.prepare("SELECT * FROM slot_config WHERE id=1").get();
}

function initSlots() {
  Object.keys(slots).forEach(k => delete slots[k]);
  const cfg = getSlotConfig();
  let h = cfg.start_hour, m = cfg.start_minute;
  while (h < cfg.end_hour || (h === cfg.end_hour && m <= cfg.end_minute)) {
    const key = `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}`;
    slots[key] = { capacity: cfg.default_cap, reserved: 0 };
    m += cfg.interval_min;
    if (m >= 60) { h += Math.floor(m/60); m = m%60; }
  }
  // 既存注文のreserved数をDBから復元
  const rows = db.prepare(
    "SELECT slot, SUM(quantity) as total FROM orders WHERE received=0 GROUP BY slot"
  ).all();
  rows.forEach(r => { if (slots[r.slot]) slots[r.slot].reserved = r.total; });
}
initSlots();

// ════════════════════════════════
//  ヘルパー
// ════════════════════════════════
function todayStr() {
  return new Date().toLocaleDateString("ja-JP",{timeZone:"Asia/Tokyo"}).replace(/\//g,"-");
}

function getSetting(key) {
  const row = db.prepare("SELECT value FROM settings WHERE key=?").get(key);
  return row ? row.value : null;
}

function getDailySoldQty(item) {
  const today = todayStr();
  const row = db.prepare(
    "SELECT SUM(quantity) as total FROM orders WHERE item=? AND DATE(created_at)=DATE('now','localtime')"
  ).get(item);
  return row?.total || 0;
}

function getDeviceOrderCount(fingerprint) {
  const today = todayStr();
  const row = db.prepare(
    "SELECT count FROM device_orders WHERE fingerprint=? AND order_date=?"
  ).get(fingerprint, today);
  return row?.count || 0;
}

function incrementDeviceCount(fingerprint, lsKey) {
  const today = todayStr();
  db.prepare(`
    INSERT INTO device_orders (fingerprint, ls_key, order_date, count)
    VALUES (?, ?, ?, 1)
    ON CONFLICT(fingerprint, order_date) DO UPDATE SET count=count+1
  `).run(fingerprint, lsKey, today);
}

// ════════════════════════════════
//  API
// ════════════════════════════════

app.get("/api/slots", (req, res) => res.json(slots));

app.get("/api/orders", (req, res) => {
  const rows = db.prepare("SELECT * FROM orders ORDER BY id").all();
  res.json(rows.map(r => ({ ...r, paid: !!r.paid, received: !!r.received })));
});

// 商品ごとの販売残数
app.get("/api/daily-stock", (req, res) => {
  const items = ["アイス","ラムネ"];
  const result = {};
  items.forEach(item => {
    const limit = parseInt(getSetting("daily_limit_"+item)||"500");
    const sold  = getDailySoldQty(item);
    result[item] = { limit, sold, remain: Math.max(0, limit-sold) };
  });
  res.json(result);
});

// デバイスの今日の注文回数確認
app.post("/api/check-limit", (req, res) => {
  const { fingerprint } = req.body;
  if (!fingerprint) return res.status(400).json({ error: "fingerprint required" });
  const count = getDeviceOrderCount(fingerprint);
  res.json({ count, remaining: Math.max(0, MAX_ORDERS_PER_DAY - count) });
});

app.post("/api/order", (req, res) => {
  const { item, quantity, slot, fingerprint, lsKey } = req.body;

  // ── バリデーション ──
  if (!slots[slot])
    return res.status(400).json({ error: "無効な時間帯です" });
  if (!item || !["アイス","ラムネ"].includes(item))
    return res.status(400).json({ error: "無効な商品です" });
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QTY_PER_ORDER)
    return res.status(400).json({ error: `個数は1〜${MAX_QTY_PER_ORDER}個で指定してください` });
  if (slots[slot].reserved + quantity > slots[slot].capacity)
    return res.status(400).json({ error: "この時間帯は満席です" });

  // ── 1日の販売上限チェック ──
  const dailyLimit = parseInt(getSetting("daily_limit_"+item)||"500");
  const dailySold  = getDailySoldQty(item);
  if (dailySold + quantity > dailyLimit)
    return res.status(400).json({ error: `${item}の本日の販売上限(${dailyLimit}個)に達しました` });

  // ── デバイスごとの注文回数チェック ──
  if (fingerprint) {
    const count = getDeviceOrderCount(fingerprint);
    if (count >= MAX_ORDERS_PER_DAY)
      return res.status(429).json({ error: `1日${MAX_ORDERS_PER_DAY}回までしか予約できません` });
  }

  // ── 注文登録 ──
  const id = Date.now() + Math.floor(Math.random()*1000);
  db.prepare(
    "INSERT INTO orders (id, item, quantity, slot) VALUES (?, ?, ?, ?)"
  ).run(id, item, quantity, slot);

  slots[slot].reserved += quantity;

  // デバイスカウント更新
  if (fingerprint) incrementDeviceCount(fingerprint, lsKey||"");

  io.emit("update");
  res.json({ id, item, quantity, slot, paid: false, received: false });
});

app.post("/api/receive/:id", (req, res) => {
  const id = parseInt(req.params.id, 10);
  const order = db.prepare("SELECT * FROM orders WHERE id=?").get(id);
  if (!order) return res.status(404).json({ error: "注文が見つかりません" });
  db.prepare("UPDATE orders SET received=1 WHERE id=?").run(id);
  io.emit("update");
  res.json({ ...order, received: true });
});

// ── スロット設定 ──
app.get("/api/slot-config", (req, res) => {
  const cfg = getSlotConfig();
  res.json({
    startHour: cfg.start_hour, startMinute: cfg.start_minute,
    endHour:   cfg.end_hour,   endMinute:   cfg.end_minute,
    intervalMin: cfg.interval_min, defaultCapacity: cfg.default_cap
  });
});

app.post("/api/slot-config", (req, res) => {
  const { startHour, startMinute, endHour, endMinute, intervalMin, defaultCapacity } = req.body;
  if (typeof startHour!=="number"||typeof endHour!=="number")
    return res.status(400).json({ error: "invalid config" });
  db.prepare(`
    UPDATE slot_config SET
      start_hour=?, start_minute=?, end_hour=?, end_minute=?,
      interval_min=?, default_cap=?
    WHERE id=1
  `).run(startHour, startMinute||0, endHour, endMinute||0, intervalMin||10, defaultCapacity||100);
  initSlots();
  io.emit("slots-updated");
  res.json({ ok: true });
});

app.post("/api/slots/:slot/capacity", (req, res) => {
  const { slot } = req.params;
  const { capacity } = req.body;
  if (!slots[slot]) return res.status(404).json({ error: "slot not found" });
  if (!Number.isInteger(capacity)||capacity<0) return res.status(400).json({ error: "invalid capacity" });
  slots[slot].capacity = capacity;
  io.emit("update");
  res.json(slots[slot]);
});

// ── 商品ごとの1日販売上限設定 ──
app.get("/api/daily-limits", (req, res) => {
  res.json({
    アイス: parseInt(getSetting("daily_limit_アイス")||"500"),
    ラムネ: parseInt(getSetting("daily_limit_ラムネ")||"500")
  });
});

app.post("/api/daily-limits", (req, res) => {
  const { アイス, ラムネ } = req.body;
  if (Number.isInteger(アイス) && アイス > 0)
    db.prepare("INSERT OR REPLACE INTO settings VALUES (?,?)").run("daily_limit_アイス", String(アイス));
  if (Number.isInteger(ラムネ) && ラムネ > 0)
    db.prepare("INSERT OR REPLACE INTO settings VALUES (?,?)").run("daily_limit_ラムネ", String(ラムネ));
  io.emit("update");
  res.json({ ok: true });
});

server.listen(3000, () => console.log("running on http://localhost:3000"));