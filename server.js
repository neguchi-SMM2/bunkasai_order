const express  = require("express");
const http     = require("http");
const { Server } = require("socket.io");
const { Pool }   = require("pg");

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);

app.use(express.static("public"));
app.use(express.json());

// ════════════════════════════════
//  PostgreSQL 接続
//  Render では DATABASE_URL 環境変数が自動設定される
// ════════════════════════════════
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

async function query(text, params) {
  const client = await pool.connect();
  try    { return await client.query(text, params); }
  finally { client.release(); }
}

// ════════════════════════════════
//  テーブル初期化
// ════════════════════════════════
async function initDB() {
  await query(`
    CREATE TABLE IF NOT EXISTS orders (
      id          BIGINT PRIMARY KEY,
      item        TEXT    NOT NULL,
      quantity    INTEGER NOT NULL,
      slot        TEXT    NOT NULL,
      paid        BOOLEAN NOT NULL DEFAULT FALSE,
      received    BOOLEAN NOT NULL DEFAULT FALSE,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS device_orders (
      fingerprint TEXT NOT NULL,
      order_date  TEXT NOT NULL,
      count       INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (fingerprint, order_date)
    );

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS slot_config (
      id            INTEGER PRIMARY KEY DEFAULT 1,
      start_hour    INTEGER NOT NULL DEFAULT 9,
      start_minute  INTEGER NOT NULL DEFAULT 0,
      end_hour      INTEGER NOT NULL DEFAULT 15,
      end_minute    INTEGER NOT NULL DEFAULT 0,
      interval_min  INTEGER NOT NULL DEFAULT 10,
      default_cap   INTEGER NOT NULL DEFAULT 100
    );

    INSERT INTO slot_config (id) VALUES (1)
      ON CONFLICT (id) DO NOTHING;

    INSERT INTO settings VALUES ('daily_limit_アイス', '500')
      ON CONFLICT (key) DO NOTHING;
    INSERT INTO settings VALUES ('daily_limit_ラムネ', '500')
      ON CONFLICT (key) DO NOTHING;
  `);
}

// ════════════════════════════════
//  スロット管理（メモリ上で保持）
// ════════════════════════════════
const MAX_QTY_PER_ORDER  = 5;
const MAX_ORDERS_PER_DAY = 2;
const slots = {};

async function getSlotConfig() {
  const r = await query("SELECT * FROM slot_config WHERE id=1");
  return r.rows[0];
}

async function initSlots() {
  Object.keys(slots).forEach(k => delete slots[k]);
  const cfg = await getSlotConfig();
  let h = cfg.start_hour, m = cfg.start_minute;
  while (h < cfg.end_hour || (h === cfg.end_hour && m <= cfg.end_minute)) {
    const key = `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}`;
    slots[key] = { capacity: cfg.default_cap, reserved: 0 };
    m += cfg.interval_min;
    if (m >= 60) { h += Math.floor(m/60); m = m%60; }
  }
  // 既存注文のreserved数を復元
  const r = await query(
    "SELECT slot, SUM(quantity)::int AS total FROM orders WHERE received=FALSE GROUP BY slot"
  );
  r.rows.forEach(row => { if (slots[row.slot]) slots[row.slot].reserved = row.total; });
}

// ════════════════════════════════
//  ヘルパー
// ════════════════════════════════
function todayStr() {
  return new Date().toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo" })
    .replace(/\//g, "-");
}

async function getSetting(key) {
  const r = await query("SELECT value FROM settings WHERE key=$1", [key]);
  return r.rows[0]?.value ?? null;
}

async function getDailySoldQty(item) {
  const r = await query(
    "SELECT COALESCE(SUM(quantity),0)::int AS total FROM orders WHERE item=$1 AND created_at::date = NOW()::date",
    [item]
  );
  return r.rows[0].total;
}

async function getDeviceOrderCount(fp) {
  const today = todayStr();
  const r = await query(
    "SELECT count FROM device_orders WHERE fingerprint=$1 AND order_date=$2",
    [fp, today]
  );
  return r.rows[0]?.count ?? 0;
}

async function incrementDeviceCount(fp) {
  const today = todayStr();
  await query(`
    INSERT INTO device_orders (fingerprint, order_date, count)
    VALUES ($1, $2, 1)
    ON CONFLICT (fingerprint, order_date) DO UPDATE SET count = device_orders.count + 1
  `, [fp, today]);
}

// ════════════════════════════════
//  API
// ════════════════════════════════
app.get("/api/slots",  (req, res) => res.json(slots));

app.get("/api/orders", async (req, res) => {
  try {
    const r = await query("SELECT * FROM orders ORDER BY id");
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/daily-stock", async (req, res) => {
  try {
    const items = ["アイス","ラムネ"];
    const result = {};
    for (const item of items) {
      const limit = parseInt(await getSetting("daily_limit_"+item) || "500");
      const sold  = await getDailySoldQty(item);
      result[item] = { limit, sold, remain: Math.max(0, limit-sold) };
    }
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/check-limit", async (req, res) => {
  const { fingerprint } = req.body;
  if (!fingerprint) return res.status(400).json({ error: "fingerprint required" });
  try {
    const count = await getDeviceOrderCount(fingerprint);
    res.json({ count, remaining: Math.max(0, MAX_ORDERS_PER_DAY - count) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/order", async (req, res) => {
  const { item, quantity, slot, fingerprint } = req.body;

  if (!slots[slot])
    return res.status(400).json({ error: "無効な時間帯です" });
  if (!item || !["アイス","ラムネ"].includes(item))
    return res.status(400).json({ error: "無効な商品です" });
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QTY_PER_ORDER)
    return res.status(400).json({ error: `個数は1〜${MAX_QTY_PER_ORDER}個で指定してください` });
  if (slots[slot].reserved + quantity > slots[slot].capacity)
    return res.status(400).json({ error: "この時間帯は満席です" });

  try {
    const dailyLimit = parseInt(await getSetting("daily_limit_"+item) || "500");
    const dailySold  = await getDailySoldQty(item);
    if (dailySold + quantity > dailyLimit)
      return res.status(400).json({ error: `${item}は売り切れました。` });

    if (fingerprint) {
      const count = await getDeviceOrderCount(fingerprint);
      if (count >= MAX_ORDERS_PER_DAY)
        return res.status(429).json({ error: `1日${MAX_ORDERS_PER_DAY}回までしか予約できません` });
    }

    const id = Date.now() + Math.floor(Math.random()*1000);
    await query(
      "INSERT INTO orders (id, item, quantity, slot) VALUES ($1,$2,$3,$4)",
      [id, item, quantity, slot]
    );
    slots[slot].reserved += quantity;
    if (fingerprint) await incrementDeviceCount(fingerprint);

    io.emit("update");
    res.json({ id, item, quantity, slot, paid: false, received: false });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/receive/:id", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    const r = await query("UPDATE orders SET received=TRUE WHERE id=$1 RETURNING *", [id]);
    if (!r.rows.length) return res.status(404).json({ error: "注文が見つかりません" });
    io.emit("update");
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── スロット設定 ──
app.get("/api/slot-config", async (req, res) => {
  try {
    const cfg = await getSlotConfig();
    res.json({
      startHour: cfg.start_hour, startMinute: cfg.start_minute,
      endHour:   cfg.end_hour,   endMinute:   cfg.end_minute,
      intervalMin: cfg.interval_min, defaultCapacity: cfg.default_cap
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/slot-config", async (req, res) => {
  const { startHour, startMinute, endHour, endMinute, intervalMin, defaultCapacity } = req.body;
  if (typeof startHour !== "number" || typeof endHour !== "number")
    return res.status(400).json({ error: "invalid config" });
  try {
    await query(`
      UPDATE slot_config SET
        start_hour=$1, start_minute=$2, end_hour=$3, end_minute=$4,
        interval_min=$5, default_cap=$6
      WHERE id=1
    `, [startHour, startMinute||0, endHour, endMinute||0, intervalMin||10, defaultCapacity||100]);
    await initSlots();
    io.emit("slots-updated");
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/slots/:slot/capacity", (req, res) => {
  const { slot } = req.params;
  const { capacity } = req.body;
  if (!slots[slot]) return res.status(404).json({ error: "slot not found" });
  if (!Number.isInteger(capacity) || capacity < 0)
    return res.status(400).json({ error: "invalid capacity" });
  slots[slot].capacity = capacity;
  io.emit("update");
  res.json(slots[slot]);
});

// ── 商品ごとの1日販売上限 ──
app.get("/api/daily-limits", async (req, res) => {
  try {
    res.json({
      アイス: parseInt(await getSetting("daily_limit_アイス") || "500"),
      ラムネ: parseInt(await getSetting("daily_limit_ラムネ") || "500")
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/daily-limits", async (req, res) => {
  const { アイス, ラムネ } = req.body;
  try {
    if (Number.isInteger(アイス) && アイス > 0)
      await query("INSERT INTO settings VALUES ($1,$2) ON CONFLICT(key) DO UPDATE SET value=$2",
        ["daily_limit_アイス", String(アイス)]);
    if (Number.isInteger(ラムネ) && ラムネ > 0)
      await query("INSERT INTO settings VALUES ($1,$2) ON CONFLICT(key) DO UPDATE SET value=$2",
        ["daily_limit_ラムネ", String(ラムネ)]);
    io.emit("update");
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════
//  起動
// ════════════════════════════════
const PORT = process.env.PORT || 3000;

initDB()
  .then(() => initSlots())
  .then(() => {
    server.listen(PORT, () => console.log(`running on port ${PORT}`));
  })
  .catch(err => {
    console.error("DB init failed:", err);
    process.exit(1);
  });