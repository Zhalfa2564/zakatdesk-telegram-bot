// ZakatDesk Telegram Bot (Vercel) - Upstash REST langsung (tanpa @vercel/kv)
// Versi: Santai + Emoji + Rapi (HTML parse mode)

// ===== Upstash REST helpers (pakai env Vercel KV) =====
function kvBase() {
  const base = (process.env.KV_REST_API_URL || "").trim();
  if (!base) throw new Error("KV_REST_API_URL missing");
  return base.replace(/\/+$/, "");
}

function kvToken() {
  const token = (process.env.KV_REST_API_TOKEN || "").trim();
  if (!token) throw new Error("KV_REST_API_TOKEN missing");
  return token;
}

async function upstash(cmd, ...args) {
  const path = [cmd, ...args.map(a => encodeURIComponent(String(a)))].join("/");
  const url = `${kvBase()}/${path}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${kvToken()}` } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Upstash HTTP ${r.status}: ${JSON.stringify(j)}`);
  if (j.error) throw new Error(`Upstash error: ${j.error}`);
  return j.result;
}

async function kvGet(key) {
  const res = await upstash("get", key);
  return res ?? null;
}

async function kvSetEx(key, ttlSec, value) {
  // SETEX key ttl value
  await upstash("setex", key, ttlSec, value);
}

async function kvDel(key) {
  await upstash("del", key);
}

// ===== Telegram handler =====
export default async function handler(req, res) {
  // health check
  if (req.method === "GET") return res.status(200).send("ok");
  if (req.method !== "POST") return res.status(200).send("ok");

  // verify secret token (anti orang iseng nembak endpoint)
  const secret = req.headers["x-telegram-bot-api-secret-token"] || "";
  if (process.env.WEBHOOK_SECRET && secret !== process.env.WEBHOOK_SECRET) {
    return res.status(401).send("unauthorized");
  }

  // body kadang sudah object, kadang string (jarang), kita amanin
  let update = req.body;
  if (typeof update === "string") {
    try { update = JSON.parse(update); } catch { update = {}; }
  }

  try {
    if (update?.message) await handleMessage(update.message);
    if (update?.callback_query) await handleCallback(update.callback_query);
  } catch (e) {
    console.log("BOT_ERR:", String(e));
    // tetep 200 biar Telegram nggak retry spam
  }

  return res.status(200).send("ok");
}

function env(name) {
  return (process.env[name] || "").trim();
}

function isAllowed(userId) {
  const raw = (process.env.ALLOWED_USER_IDS || "").trim();
  if (!raw) return true;
  const set = new Set(raw.split(",").map(s => s.trim()).filter(Boolean));
  return set.has(String(userId));
}

// ===== Draft store (Upstash) =====
async function getDraft(userId) {
  const raw = await kvGet(`draft:${userId}`);
  return raw ? JSON.parse(raw) : null;
}
async function setDraft(userId, draft) {
  await kvSetEx(`draft:${userId}`, 1800, JSON.stringify(draft)); // TTL 30 menit
}
async function deleteDraft(userId) {
  await kvDel(`draft:${userId}`);
}

function freshDraft(from) {
  const uname = from.username ? `@${from.username}` : (from.first_name || "Panitia");
  return {
    txid: `TX-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    nama: "",
    alamat: "",
    pembayaran: "",
    jiwa: 0,
    maal: 0,
    fidyah: 0,
    infak: 0,
    amil: uname,
    state: "IDLE",
    pendingAdd: "",
    blok: "",
    nomorBlok: 0,
    nomorRumah: 0,
    rumahPage: 1
  };
}

// ===== Telegram API =====
async function tg(method, payload) {
  const token = env("TELEGRAM_TOKEN");
  if (!token) throw new Error("TELEGRAM_TOKEN missing");

  const url = `https://api.telegram.org/bot${token}/${method}`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) console.log("TG_ERR:", j);
  return j;
}

// escape HTML untuk input user biar aman
function h(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function tgSend(chatId, html, opts = {}) {
  return tg("sendMessage", {
    chat_id: chatId,
    text: html,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...opts
  });
}

async function tgEdit(chatId, messageId, html, opts = {}) {
  return tg("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text: html,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...opts
  });
}

async function tgAck(cbId, text) {
  // callback query text jangan HTML (cukup plain)
  return tg("answerCallbackQuery", { callback_query_id: cbId, text, show_alert: false });
}

// ===== Keyboards =====
function mainMenuKeyboard() {
  // ini reply keyboard → biarin polos biar mapping aman
  return {
    keyboard: [
      ["Nama", "Alamat", "Pembayaran"],
      ["Jiwa", "Tambahan", "Lihat"],
      ["OK", "Cancel"]
    ],
    resize_keyboard: true
  };
}

function blokKeyboard() {
  const row1 = ["A","B","C","D","E"].map(x => ({ text: x, callback_data: `blk:${x}` }));
  const row2 = ["F","G","H","I"].map(x => ({ text: x, callback_data: `blk:${x}` }));
  return { inline_keyboard: [row1, row2] };
}

function nomorBlokKeyboard() {
  const rows = [];
  let row = [];
  for (let i = 1; i <= 24; i++) {
    row.push({ text: String(i), callback_data: `nb:${i}` });
    if (row.length === 6) { rows.push(row); row = []; }
  }
  if (row.length) rows.push(row);
  return { inline_keyboard: rows };
}

function rumahKeyboard(page) {
  const perPage = 10;
  const start = (page - 1) * perPage + 1;
  const end = Math.min(start + perPage - 1, 50);

  const rows = [];
  let row = [];
  for (let n = start; n <= end; n++) {
    row.push({ text: String(n), callback_data: `nr:${n}` });
    if (row.length === 5) { rows.push(row); row = []; }
  }
  if (row.length) rows.push(row);

  const nav = [];
  if (page > 1) nav.push({ text: "⬅ Prev", callback_data: `nrp:${page - 1}` });
  if (page < 5) nav.push({ text: "Next ➡", callback_data: `nrp:${page + 1}` });
  if (nav.length) rows.push(nav);

  return { inline_keyboard: rows };
}

function pembayaranKeyboard() {
  return {
    inline_keyboard: [[
      { text: "💵 Uang", callback_data: "pay:UANG" },
      { text: "🌾 Beras (Ltr)", callback_data: "pay:LTR" },
      { text: "⚖️ Beras (Kg)", callback_data: "pay:KG" }
    ]]
  };
}

function jiwaKeyboard() {
  const rows = [];
  let row = [];
  for (let i = 1; i <= 10; i++) {
    row.push({ text: String(i), callback_data: `jw:${i}` });
    if (row.length === 5) { rows.push(row); row = []; }
  }
  if (row.length) rows.push(row);
  return { inline_keyboard: rows };
}

function tambahanKeyboard() {
  return {
    inline_keyboard: [[
      { text: "💰 Maal", callback_data: "add:MAAL" },
      { text: "🧾 Fidyah", callback_data: "add:FIDYAH" },
      { text: "🎁 Infak", callback_data: "add:INFAK" }
    ]]
  };
}

function okCancelInline() {
  return {
    inline_keyboard: [[
      { text: "✅ OK Simpan", callback_data: "do:ok" },
      { text: "❌ Batal", callback_data: "do:cancel" }
    ]]
  };
}

// ===== Helpers =====
function parseMoney(s) {
  const cleaned = String(s).replace(/[^\d]/g, "");
  if (!cleaned) return null;
  const n = parseInt(cleaned, 10);
  return Number.isFinite(n) ? n : null;
}

function missingFields(d) {
  const miss = [];
  if (!d.nama) miss.push("Nama");
  if (!d.alamat) miss.push("Alamat");
  if (!d.pembayaran) miss.push("Pembayaran");
  if (!d.jiwa) miss.push("Jiwa");
  return miss;
}

function rupiah(n) {
  return Number(n || 0).toLocaleString("id-ID");
}

function shortTx(txid) {
  const s = String(txid || "");
  return s.length > 14 ? s.slice(0, 14) + "…" : s;
}

function labelTambah(code) {
  return code === "MAAL" ? "Maal" : code === "FIDYAH" ? "Fidyah" : "Infak";
}

// ===== Text pack (Santai + Rapi) =====
const TXT = {
  start: () =>
    `👋 <b>Assistant Zakat AL-Hikam</b>\n` +
    `Aku bantu input zakat biar kamu nggak pegal jadi admin Excel 😄\n\n` +
    `Mulai transaksi: <code>/input</code>\n` +
    `Cek draft: <code>/lihat</code>`,

  draftCreated: (d) =>
    `🧾 <b>Draft dibuka!</b>\n` +
    `TxID: <code>${h(shortTx(d.txid))}</code>\n\n` +
    `Gas isi nama: <code>/nama</code>`,

  askName: () =>
    `✍️ <b>Nama muzaki</b>\n` +
    `Ketik nama aja ya.\n` +
    `Contoh: <i>Ahmad</i>`,

  nameSaved: (nama) =>
    `✅ <b>Nama tersimpan</b>\n` +
    `Nama: <b>${h(nama)}</b>\n\n` +
    `Lanjut pilih alamat: <code>/alamat</code>`,

  askBlok: () =>
    `📍 <b>Pilih alamat</b>\n` +
    `Pilih <b>Blok</b> dulu (A–I):`,

  askNomorBlok: (blok) =>
    `📍 <b>Alamat</b>\n` +
    `Blok: <b>${h(blok)}</b>\n` +
    `Sekarang pilih <b>nomor blok</b> (1–24):`,

  askRumah: (blok, nomorBlok) =>
    `📍 <b>Alamat</b>\n` +
    `Blok: <b>${h(blok)}</b>\n` +
    `No Blok: <b>${h(nomorBlok)}</b>\n` +
    `Sekarang pilih <b>nomor rumah</b> (1–50):`,

  alamatSaved: (alamat) =>
    `📍 <b>Alamat tersimpan</b>\n` +
    `Alamat: <code>${h(alamat)}</code>\n\n` +
    `Lanjut pembayaran: <code>/pembayaran</code>`,

  askPay: () =>
    `💳 <b>Pembayaran zakat fitrah</b>\n` +
    `Pilih metode pembayaran:`,

  paySaved: (p) =>
    `✅ <b>Pembayaran dipilih</b>\n` +
    `Metode: <b>${h(p)}</b>\n\n` +
    `Lanjut jumlah jiwa: <code>/jiwa</code>`,

  askJiwa: () =>
    `👨‍👩‍👧‍👦 <b>Jumlah jiwa</b>\n` +
    `Pilih jumlah jiwa:`,

  jiwaSaved: (n) =>
    `✅ <b>Jiwa tersimpan</b>\n` +
    `Jiwa: <b>${n}</b>\n\n` +
    `Ada tambahan? <code>/tambahan</code>\n` +
    `Kalau udah: <code>/lihat</code>`,

  askTambah: () =>
    `➕ <b>Tambahan (opsional)</b>\n` +
    `Pilih jenis tambahan:`,

  askNominalTambah: (label) =>
    `➕ <b>${h(label)}</b>\n` +
    `Ketik nominal (angka aja).\n` +
    `Contoh: <code>25000</code>`,

  tambahSaved: (label, amount) =>
    `✅ <b>${h(label)} tersimpan</b>\n` +
    `Nominal: <b>Rp ${rupiah(amount)}</b>\n\n` +
    `Cek ringkasan: <code>/lihat</code>`,

  summary: (d) => {
    const miss = missingFields(d);
    return (
      `🧾 <b>Ringkasan Draft</b>\n` +
      `Nama: <b>${h(d.nama || "-")}</b>\n` +
      `Alamat: <code>${h(d.alamat || "-")}</code>\n` +
      `Pembayaran: <b>${h(d.pembayaran || "-")}</b>\n` +
      `Jiwa: <b>${d.jiwa || "-"}</b>\n\n` +
      `💰 Maal: <b>Rp ${rupiah(d.maal || 0)}</b>\n` +
      `🧾 Fidyah: <b>Rp ${rupiah(d.fidyah || 0)}</b>\n` +
      `🎁 Infak: <b>Rp ${rupiah(d.infak || 0)}</b>\n` +
      `👤 Amil: <i>${h(d.amil || "-")}</i>\n\n` +
      (miss.length
        ? `⚠️ Status: <b>BELUM LENGKAP</b>\nKurang: <b>${h(miss.join(", "))}</b>`
        : `✅ Status: <b>SIAP DISIMPAN</b>`)
    );
  },

  needFields: (miss) =>
    `⚠️ <b>Belum bisa simpan</b>\n` +
    `Masih kurang: <b>${h(miss.join(", "))}</b>\n\n` +
    `Cek: <code>/lihat</code>`,

  saved: (row) =>
    `✅ <b>Tersimpan!</b>\n` +
    `Baris: <code>${row}</code>\n\n` +
    `Mau input lagi? <code>/input</code>`,

  canceled: () =>
    `🗑️ <b>Draft dibatalkan</b>\n` +
    `Kalau mau mulai lagi: <code>/input</code>`,

  noDraft: () =>
    `😄 Draft kamu belum ada.\n` +
    `Mulai dulu ya: <code>/input</code>`,

  unknown: () =>
    `🤖 Aku agak bingung itu maksudnya apa 😄\n` +
    `Mulai: <code>/input</code>\n` +
    `Cek draft: <code>/lihat</code>`
};

// ===== Bot flows =====
async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  if (!isAllowed(userId)) {
    await tgSend(chatId, "⛔ <b>Akses ditolak</b>\nAkun ini belum terdaftar sebagai panitia.");
    return;
  }

  const textRaw = (msg.text || "").trim();
  const normalized = textRaw.toLowerCase();

  // mapping dari reply keyboard ke command
  const text =
    normalized === "nama" ? "/nama" :
    normalized === "alamat" ? "/alamat" :
    normalized === "pembayaran" ? "/pembayaran" :
    normalized === "jiwa" ? "/jiwa" :
    normalized === "tambahan" ? "/tambahan" :
    normalized === "lihat" ? "/lihat" :
    normalized === "ok" ? "/ok" :
    normalized === "cancel" ? "/cancel" :
    textRaw;

  let draft = await getDraft(userId);

  if (text === "/start") {
    await tgSend(chatId, TXT.start(), { reply_markup: mainMenuKeyboard() });
    return;
  }

  if (text === "/input") {
    draft = freshDraft(msg.from);
    await setDraft(userId, draft);
    await tgSend(chatId, TXT.draftCreated(draft), { reply_markup: mainMenuKeyboard() });
    return;
  }

  if (!draft) {
    await tgSend(chatId, TXT.noDraft(), { reply_markup: mainMenuKeyboard() });
    return;
  }

  if (draft.state === "WAIT_NAME") {
    draft.nama = textRaw;
    draft.state = "IDLE";
    await setDraft(userId, draft);
    await tgSend(chatId, TXT.nameSaved(draft.nama), { reply_markup: mainMenuKeyboard() });
    return;
  }

  if (draft.state === "WAIT_ADD_AMOUNT") {
    const amount = parseMoney(textRaw);
    if (amount === null) {
      await tgSend(chatId, `⚠️ <b>Nominal harus angka</b>\nContoh: <code>25000</code>`);
      return;
    }

    const pending = draft.pendingAdd;
    const label = labelTambah(pending);

    if (pending === "MAAL") draft.maal = amount;
    if (pending === "FIDYAH") draft.fidyah = amount;
    if (pending === "INFAK") draft.infak = amount;

    draft.pendingAdd = "";
    draft.state = "IDLE";
    await setDraft(userId, draft);

    await tgSend(chatId, TXT.tambahSaved(label, amount), { reply_markup: mainMenuKeyboard() });
    return;
  }

  if (text === "/nama") {
    draft.state = "WAIT_NAME";
    await setDraft(userId, draft);
    await tgSend(chatId, TXT.askName(), { reply_markup: mainMenuKeyboard() });
    return;
  }

  if (text === "/alamat") {
    draft.rumahPage = 1;
    await setDraft(userId, draft);
    await tgSend(chatId, TXT.askBlok(), { reply_markup: blokKeyboard() });
    return;
  }

  if (text === "/pembayaran") {
    await tgSend(chatId, TXT.askPay(), { reply_markup: pembayaranKeyboard() });
    return;
  }

  if (text === "/jiwa") {
    await tgSend(chatId, TXT.askJiwa(), { reply_markup: jiwaKeyboard() });
    return;
  }

  if (text === "/tambahan") {
    await tgSend(chatId, TXT.askTambah(), { reply_markup: tambahanKeyboard() });
    return;
  }

  if (text === "/lihat") {
    await tgSend(chatId, TXT.summary(draft), { reply_markup: okCancelInline() });
    return;
  }

  if (text === "/cancel") {
    await deleteDraft(userId);
    await tgSend(chatId, TXT.canceled(), { reply_markup: mainMenuKeyboard() });
    return;
  }

  if (text === "/ok") {
    const miss = missingFields(draft);
    if (miss.length) {
      await tgSend(chatId, TXT.needFields(miss), { reply_markup: mainMenuKeyboard() });
      return;
    }

    const appsUrl = env("APPS_SCRIPT_URL");
    const appsKey = env("APPS_API_KEY");
    if (!appsUrl) throw new Error("APPS_SCRIPT_URL missing");
    if (!appsKey) throw new Error("APPS_API_KEY missing");

    const body = {
      api_key: appsKey,
      txid: draft.txid,
      nama: draft.nama,
      alamat: draft.alamat,
      pembayaran: draft.pembayaran, // Uang / Beras (Ltr) / Beras (Kg)
      jiwa: draft.jiwa,
      maal: draft.maal || 0,
      fidyah: draft.fidyah || 0,
      infak: draft.infak || 0,
      amil: draft.amil
    };

    const r = await fetch(appsUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      redirect: "follow"
    });

    const out = await r.json().catch(() => null);
    if (!out || out.ok !== true) {
      console.log("AppsScript fail:", out);
      await tgSend(chatId, "⚠️ <b>Gagal simpan ke sheet</b>\nCoba klik <code>OK</code> lagi ya.", { reply_markup: mainMenuKeyboard() });
      return;
    }

    await deleteDraft(userId);
    await tgSend(chatId, TXT.saved(out.row), { reply_markup: mainMenuKeyboard() });
    return;
  }

  await tgSend(chatId, TXT.unknown(), { reply_markup: mainMenuKeyboard() });
}

async function handleCallback(cb) {
  const chatId = cb.message.chat.id;
  const userId = cb.from.id;

  if (!isAllowed(userId)) {
    await tgAck(cb.id, "Akses ditolak.");
    return;
  }

  const data = cb.data || "";
  let draft = await getDraft(userId);

  if (!draft) {
    await tgAck(cb.id, "Draft kosong. /input dulu.");
    return;
  }

  if (data === "do:ok") {
    await tgAck(cb.id, "Sip ✅");
    await handleMessage({ chat: { id: chatId }, from: cb.from, text: "/ok" });
    return;
  }
  if (data === "do:cancel") {
    await tgAck(cb.id, "Dibatalkan ❌");
    await handleMessage({ chat: { id: chatId }, from: cb.from, text: "/cancel" });
    return;
  }

  // alamat flow
  if (data.startsWith("blk:")) {
    draft.blok = data.split(":")[1];
    await setDraft(userId, draft);
    await tgAck(cb.id, `Blok ${draft.blok}`);
    await tgSend(chatId, TXT.askNomorBlok(draft.blok), { reply_markup: nomorBlokKeyboard() });
    return;
  }

  if (data.startsWith("nb:")) {
    draft.nomorBlok = parseInt(data.split(":")[1], 10);
    draft.rumahPage = 1;
    await setDraft(userId, draft);
    await tgAck(cb.id, `No Blok ${draft.nomorBlok}`);
    await tgSend(chatId, TXT.askRumah(draft.blok, draft.nomorBlok), { reply_markup: rumahKeyboard(draft.rumahPage) });
    return;
  }

  if (data.startsWith("nrp:")) {
    draft.rumahPage = parseInt(data.split(":")[1], 10);
    await setDraft(userId, draft);
    await tgAck(cb.id, `Hal ${draft.rumahPage}`);
    await tgEdit(chatId, cb.message.message_id, TXT.askRumah(draft.blok, draft.nomorBlok), { reply_markup: rumahKeyboard(draft.rumahPage) });
    return;
  }

  if (data.startsWith("nr:")) {
    draft.nomorRumah = parseInt(data.split(":")[1], 10);
    draft.alamat = `${draft.blok}${draft.nomorBlok}/${draft.nomorRumah}`;
    await setDraft(userId, draft);
    await tgAck(cb.id, `Rumah ${draft.nomorRumah}`);
    await tgSend(chatId, TXT.alamatSaved(draft.alamat), { reply_markup: mainMenuKeyboard() });
    return;
  }

  // pembayaran
  if (data.startsWith("pay:")) {
    const code = data.split(":")[1];
    draft.pembayaran =
      code === "UANG" ? "Uang" :
      code === "LTR" ? "Beras (Ltr)" :
      "Beras (Kg)";
    await setDraft(userId, draft);
    await tgAck(cb.id, "Oke ✅");
    await tgSend(chatId, TXT.paySaved(draft.pembayaran), { reply_markup: mainMenuKeyboard() });
    return;
  }

  // jiwa
  if (data.startsWith("jw:")) {
    draft.jiwa = parseInt(data.split(":")[1], 10);
    await setDraft(userId, draft);
    await tgAck(cb.id, `Jiwa ${draft.jiwa}`);
    await tgSend(chatId, TXT.jiwaSaved(draft.jiwa), { reply_markup: mainMenuKeyboard() });
    return;
  }

  // tambahan
  if (data.startsWith("add:")) {
    draft.pendingAdd = data.split(":")[1];
    draft.state = "WAIT_ADD_AMOUNT";
    await setDraft(userId, draft);

    const label = labelTambah(draft.pendingAdd);
    await tgAck(cb.id, label);
    await tgSend(chatId, TXT.askNominalTambah(label), { reply_markup: mainMenuKeyboard() });
    return;
  }

  await tgAck(cb.id, "Oke");
}
