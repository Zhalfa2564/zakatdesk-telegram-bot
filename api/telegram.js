// NOTE: kita sengaja TIDAK import @vercel/kv di paling atas.
// Biar GET /api/telegram nggak crash saat module init.
// KV akan di-load hanya saat dibutuhkan (POST).

let kvClient = null;
async function kv() {
  if (kvClient) return kvClient;
  const mod = await import("@vercel/kv");
  kvClient = mod.kv;
  return kvClient;
}

export default async function handler(req, res) {
  // Health check (biar bisa dicek dari browser)
  if (req.method === "GET") return res.status(200).send("ok");

  if (req.method !== "POST") return res.status(200).send("ok");

  // verifikasi secret webhook Telegram
  const secret = req.headers["x-telegram-bot-api-secret-token"] || "";
  if (process.env.WEBHOOK_SECRET && secret !== process.env.WEBHOOK_SECRET) {
    return res.status(401).send("unauthorized");
  }

  const update = req.body;

  try {
    if (update?.message) await handleMessage(update.message);
    if (update?.callback_query) await handleCallback(update.callback_query);
  } catch (e) {
    console.log("BOT_ERR:", String(e));
    // tetap 200 biar Telegram nggak retry spam
  }

  return res.status(200).send("ok");
}

function isAllowed(userId) {
  const raw = (process.env.ALLOWED_USER_IDS || "").trim();
  if (!raw) return true;
  const set = new Set(raw.split(",").map(s => s.trim()).filter(Boolean));
  return set.has(String(userId));
}

// ===== Draft KV =====
async function getDraft(userId) {
  const k = await kv();
  const raw = await k.get(`draft:${userId}`);
  return raw ? JSON.parse(raw) : null;
}
async function setDraft(userId, draft) {
  const k = await kv();
  await k.set(`draft:${userId}`, JSON.stringify(draft), { ex: 1800 });
}
async function deleteDraft(userId) {
  const k = await kv();
  await k.del(`draft:${userId}`);
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
  const url = `https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/${method}`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  return r.json().catch(() => ({}));
}
async function tgSend(chatId, text, opts = {}) {
  return tg("sendMessage", { chat_id: chatId, text, ...opts });
}
async function tgEdit(chatId, messageId, text, opts = {}) {
  return tg("editMessageText", { chat_id: chatId, message_id: messageId, text, ...opts });
}
async function tgAck(cbId, text) {
  return tg("answerCallbackQuery", { callback_query_id: cbId, text, show_alert: false });
}

// ===== Keyboards =====
function mainMenuKeyboard() {
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
      { text: "Uang", callback_data: "pay:UANG" },
      { text: "Beras (Ltr)", callback_data: "pay:LTR" },
      { text: "Beras (Kg)", callback_data: "pay:KG" }
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
      { text: "Maal", callback_data: "add:MAAL" },
      { text: "Fidyah", callback_data: "add:FIDYAH" },
      { text: "Infak", callback_data: "add:INFAK" }
    ]]
  };
}
function okCancelInline() {
  return {
    inline_keyboard: [[
      { text: "OK Simpan", callback_data: "do:ok" },
      { text: "Cancel", callback_data: "do:cancel" }
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
function draftSummary(d) {
  const miss = missingFields(d);
  return [
    "Ringkasan Draft",
    `Nama: ${d.nama || "-"}`,
    `Alamat: ${d.alamat || "-"}`,
    `Pembayaran: ${d.pembayaran || "-"}`,
    `Jiwa: ${d.jiwa || "-"}`,
    `Maal: ${rupiah(d.maal || 0)}`,
    `Fidyah: ${rupiah(d.fidyah || 0)}`,
    `Infak: ${rupiah(d.infak || 0)}`,
    `Amil: ${d.amil || "-"}`,
    miss.length ? `Status: BELUM LENGKAP (${miss.join(", ")})` : "Status: SIAP DISIMPAN"
  ].join("\n");
}

// ===== Handlers =====
async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  if (!isAllowed(userId)) {
    await tgSend(chatId, "Maaf, akun ini belum terdaftar sebagai panitia.");
    return;
  }

  const textRaw = (msg.text || "").trim();
  const normalized = textRaw.toLowerCase();
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
    await tgSend(chatId, "DKM Zakat Desk siap dipakai.\nMulai transaksi baru: /input", { reply_markup: mainMenuKeyboard() });
    return;
  }

  if (text === "/input") {
    draft = freshDraft(msg.from);
    await setDraft(userId, draft);
    await tgSend(chatId, `Draft baru dibuat.\nTxID: ${draft.txid}\n\nIsi nama: /nama`, { reply_markup: mainMenuKeyboard() });
    return;
  }

  if (!draft) {
    await tgSend(chatId, "Belum ada draft. Ketik /input untuk mulai.", { reply_markup: mainMenuKeyboard() });
    return;
  }

  if (draft.state === "WAIT_NAME") {
    draft.nama = textRaw;
    draft.state = "IDLE";
    await setDraft(userId, draft);
    await tgSend(chatId, `Nama tersimpan: ${draft.nama}\nLanjut: /alamat`, { reply_markup: mainMenuKeyboard() });
    return;
  }

  if (draft.state === "WAIT_ADD_AMOUNT") {
    const amount = parseMoney(textRaw);
    if (amount === null) {
      await tgSend(chatId, "Nominal harus angka. Contoh: 25000");
      return;
    }
    if (draft.pendingAdd === "MAAL") draft.maal = amount;
    if (draft.pendingAdd === "FIDYAH") draft.fidyah = amount;
    if (draft.pendingAdd === "INFAK") draft.infak = amount;

    draft.pendingAdd = "";
    draft.state = "IDLE";
    await setDraft(userId, draft);
    await tgSend(chatId, "Tersimpan. Cek: /lihat", { reply_markup: mainMenuKeyboard() });
    return;
  }

  if (text === "/nama") {
    draft.state = "WAIT_NAME";
    await setDraft(userId, draft);
    await tgSend(chatId, "Ketik nama muzaki:", { reply_markup: mainMenuKeyboard() });
    return;
  }

  if (text === "/alamat") {
    draft.rumahPage = 1;
    await setDraft(userId, draft);
    await tgSend(chatId, "Pilih Blok (A–I):", { reply_markup: blokKeyboard() });
    return;
  }

  if (text === "/pembayaran") {
    await tgSend(chatId, "Pilih pembayaran zakat fitrah:", { reply_markup: pembayaranKeyboard() });
    return;
  }

  if (text === "/jiwa") {
    await tgSend(chatId, "Pilih jumlah jiwa:", { reply_markup: jiwaKeyboard() });
    return;
  }

  if (text === "/tambahan") {
    await tgSend(chatId, "Pilih jenis tambahan:", { reply_markup: tambahanKeyboard() });
    return;
  }

  if (text === "/lihat") {
    await tgSend(chatId, draftSummary(draft), { reply_markup: okCancelInline() });
    return;
  }

  if (text === "/cancel") {
    await deleteDraft(userId);
    await tgSend(chatId, "Draft dibatalkan. Mulai lagi: /input", { reply_markup: mainMenuKeyboard() });
    return;
  }

  if (text === "/ok") {
    const miss = missingFields(draft);
    if (miss.length) {
      await tgSend(chatId, `Belum bisa simpan. Yang belum diisi: ${miss.join(", ")}\nCek: /lihat`, { reply_markup: mainMenuKeyboard() });
      return;
    }

    const body = {
      api_key: process.env.APPS_API_KEY,
      txid: draft.txid,
      nama: draft.nama,
      alamat: draft.alamat,
      pembayaran: draft.pembayaran,
      jiwa: draft.jiwa,
      maal: draft.maal || 0,
      fidyah: draft.fidyah || 0,
      infak: draft.infak || 0,
      amil: draft.amil
    };

    const r = await fetch(process.env.APPS_SCRIPT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      redirect: "follow"
    });

    const out = await r.json().catch(() => null);
    if (!out || out.ok !== true) {
      console.log("AppsScript fail:", out);
      await tgSend(chatId, "Gagal simpan ke sheet. Coba /ok lagi.", { reply_markup: mainMenuKeyboard() });
      return;
    }

    await deleteDraft(userId);
    await tgSend(chatId, `Tersimpan ✅\nBaris: ${out.row}\n\nTransaksi baru: /input`, { reply_markup: mainMenuKeyboard() });
    return;
  }

  await tgSend(chatId, "Perintah tidak dikenali. Mulai: /input", { reply_markup: mainMenuKeyboard() });
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
    await tgAck(cb.id, "Draft tidak ada. /input dulu.");
    return;
  }

  if (data === "do:ok") {
    await tgAck(cb.id, "OK");
    await handleMessage({ chat: { id: chatId }, from: cb.from, text: "/ok" });
    return;
  }
  if (data === "do:cancel") {
    await tgAck(cb.id, "Cancel");
    await handleMessage({ chat: { id: chatId }, from: cb.from, text: "/cancel" });
    return;
  }

  if (data.startsWith("blk:")) {
    draft.blok = data.split(":")[1];
    await setDraft(userId, draft);
    await tgAck(cb.id, `Blok ${draft.blok}`);
    await tgSend(chatId, "Pilih nomor blok (1–24):", { reply_markup: nomorBlokKeyboard() });
    return;
  }

  if (data.startsWith("nb:")) {
    draft.nomorBlok = parseInt(data.split(":")[1], 10);
    draft.rumahPage = 1;
    await setDraft(userId, draft);
    await tgAck(cb.id, `No Blok ${draft.nomorBlok}`);
    await tgSend(chatId, "Pilih nomor rumah (1–50):", { reply_markup: rumahKeyboard(draft.rumahPage) });
    return;
  }

  if (data.startsWith("nrp:")) {
    draft.rumahPage = parseInt(data.split(":")[1], 10);
    await setDraft(userId, draft);
    await tgAck(cb.id, `Hal ${draft.rumahPage}`);
    await tgEdit(chatId, cb.message.message_id, "Pilih nomor rumah (1–50):", { reply_markup: rumahKeyboard(draft.rumahPage) });
    return;
  }

  if (data.startsWith("nr:")) {
    draft.nomorRumah = parseInt(data.split(":")[1], 10);
    draft.alamat = `${draft.blok}${draft.nomorBlok}/${draft.nomorRumah}`;
    await setDraft(userId, draft);
    await tgAck(cb.id, `Rumah ${draft.nomorRumah}`);
    await tgSend(chatId, `Alamat tersimpan: ${draft.alamat}\nLanjut: /pembayaran`, { reply_markup: mainMenuKeyboard() });
    return;
  }

  if (data.startsWith("pay:")) {
    const code = data.split(":")[1];
    draft.pembayaran =
      code === "UANG" ? "Uang" :
      code === "LTR" ? "Beras (Ltr)" :
      "Beras (Kg)";
    await setDraft(userId, draft);
    await tgAck(cb.id, draft.pembayaran);
    await tgSend(chatId, `Pembayaran: ${draft.pembayaran}\nLanjut: /jiwa`, { reply_markup: mainMenuKeyboard() });
    return;
  }

  if (data.startsWith("jw:")) {
    draft.jiwa = parseInt(data.split(":")[1], 10);
    await setDraft(userId, draft);
    await tgAck(cb.id, `Jiwa ${draft.jiwa}`);
    await tgSend(chatId, `Jiwa tersimpan: ${draft.jiwa}\nOpsional: /tambahan\nCek: /lihat`, { reply_markup: mainMenuKeyboard() });
    return;
  }

  if (data.startsWith("add:")) {
    draft.pendingAdd = data.split(":")[1];
    draft.state = "WAIT_ADD_AMOUNT";
    await setDraft(userId, draft);

    const label = draft.pendingAdd === "MAAL" ? "Zakat Mal" : draft.pendingAdd === "FIDYAH" ? "Fidyah" : "Infak";
    await tgAck(cb.id, label);
    await tgSend(chatId, `Ketik nominal ${label} (angka saja, contoh 25000):`, { reply_markup: mainMenuKeyboard() });
    return;
  }

  await tgAck(cb.id, "OK");
}
