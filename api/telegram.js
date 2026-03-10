// Assistant Zakat AL-Hikam (Telegram Bot) - Vercel + Upstash REST
// Update:
// - VISUAL 100%: Loading bar dipaksa 100% dengan delay sebelum hilang
// - FIX: Anti Webhook Retry Spam (Kunci state PROCESSING)
// - DYNAMIC INPUT PLACEHOLDER: Teks abu-abu di kolom chat berubah otomatis
// - AUTO-NEXT WIZARD: Flow mengalir tanpa perlu ketik command berulang

// ===================== Upstash REST (Vercel KV env) =====================
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
  await upstash("setex", key, ttlSec, value); 
}
async function kvDel(key) {
  await upstash("del", key);
}

// ===================== Telegram handler =====================
export const maxDuration = 60;
export default async function handler(req, res) {
  if (req.method === "GET") return res.status(200).send("ok");
  if (req.method !== "POST") return res.status(200).send("ok");

  const secret = req.headers["x-telegram-bot-api-secret-token"] || "";
  if (process.env.WEBHOOK_SECRET && secret !== process.env.WEBHOOK_SECRET) {
    return res.status(401).send("unauthorized");
  }

  let update = req.body;
  if (typeof update === "string") {
    try { update = JSON.parse(update); } catch { update = {}; }
  }

  try {
    if (update?.message) await handleMessage(update.message);
    if (update?.callback_query) await handleCallback(update.callback_query);
  } catch (e) {
    console.log("BOT_ERR:", String(e));
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

// ===================== Draft store (Upstash) =====================
async function getDraft(userId) {
  const raw = await kvGet(`draft:${userId}`);
  return raw ? JSON.parse(raw) : null;
}
async function setDraft(userId, draft) {
  await kvSetEx(`draft:${userId}`, 1800, JSON.stringify(draft));
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
    nomorWa: "", 
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

// ===================== Telegram API (HTML) =====================
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
  return tg("answerCallbackQuery", { callback_query_id: cbId, text, show_alert: false });
}

// ===================== Keyboards =====================

function mainMenuKeyboard(placeholder = "Pilih menu atau ketik perintah...") {
  return {
    keyboard: [
      ["🧾 Lihat Ringkasan", "❌ Batal Transaksi"]
    ],
    resize_keyboard: true,
    input_field_placeholder: placeholder 
  };
}

function blokKeyboard() {
  const row1 = ["A","B","C","D","E"].map(x => ({ text: x, callback_data: `blk:${x}` }));
  const row2 = ["F","G","H","I"].map(x => ({ text: x, callback_data: `blk:${x}` }));
  const row3 = [{ text: "🌍 Luar Perumahan (Ketik Manual)", callback_data: "blk:MANUAL" }];
  return { inline_keyboard: [row1, row2, row3] };
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

const TOTAL_RUMAH = 60;
const RUMAH_PER_PAGE = 10;
const RUMAH_PAGES = Math.ceil(TOTAL_RUMAH / RUMAH_PER_PAGE);

function rumahKeyboard(page) {
  const start = (page - 1) * RUMAH_PER_PAGE + 1;
  const end = Math.min(start + RUMAH_PER_PAGE - 1, TOTAL_RUMAH);

  const rows = [];
  let row = [];
  for (let n = start; n <= end; n++) {
    row.push({ text: String(n), callback_data: `nr:${n}` });
    if (row.length === 5) { rows.push(row); row = []; }
  }
  if (row.length) rows.push(row);

  const nav = [];
  if (page > 1) nav.push({ text: "⬅ Prev", callback_data: `nrp:${page - 1}` });
  if (page < RUMAH_PAGES) nav.push({ text: "Next ➡", callback_data: `nrp:${page + 1}` });
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
    inline_keyboard: [
      [
        { text: "💰 Maal", callback_data: "add:MAAL" },
        { text: "🧾 Fidyah", callback_data: "add:FIDYAH" },
        { text: "🎁 Infak", callback_data: "add:INFAK" }
      ],
      [
        { text: "⏩ Lewati & Lihat Ringkasan", callback_data: "do:lihat" }
      ]
    ]
  };
}

function okCancelInline() {
  return {
    inline_keyboard: [[
      { text: "✅ OK Simpan", callback_data: "do:ok" },
      { text: "✏️ Edit", callback_data: "do:edit" },
      { text: "❌ Batal", callback_data: "do:cancel" }
    ]]
  };
}

function editMenuInline() {
  return {
    inline_keyboard: [
      [{ text: "✍️ Nama", callback_data: "edit:nama" }, { text: "📍 Alamat", callback_data: "edit:alamat" }],
      [{ text: "📱 Nomor WA", callback_data: "edit:wa" }, { text: "💳 Pembayaran", callback_data: "edit:pay" }],
      [{ text: "👨‍👩‍👧‍👦 Jiwa", callback_data: "edit:jiwa" }, { text: "➕ Tambahan", callback_data: "edit:tambahan" }],
      [{ text: "⬅️ Kembali ke Ringkasan", callback_data: "edit:back" }]
    ]
  };
}

function editTambahanInline() {
  return {
    inline_keyboard: [
      [{ text: "💰 Set Maal", callback_data: "edit:set:MAAL" }, { text: "🧾 Set Fidyah", callback_data: "edit:set:FIDYAH" }],
      [{ text: "🎁 Set Infak", callback_data: "edit:set:INFAK" }],
      [{ text: "🧹 Hapus Maal", callback_data: "edit:clear:MAAL" }, { text: "🧹 Hapus Fidyah", callback_data: "edit:clear:FIDYAH" }],
      [{ text: "🧹 Hapus Infak", callback_data: "edit:clear:INFAK" }],
      [{ text: "⬅️ Kembali", callback_data: "edit:menu" }]
    ]
  };
}

// ===================== Helpers =====================
function parseMoney(s) {
  const cleaned = String(s).replace(/[^\d]/g, "");
  if (!cleaned) return null;
  const n = parseInt(cleaned, 10);
  return Number.isFinite(n) ? n : null;
}

function rupiah(n) {
  return Number(n || 0).toLocaleString("id-ID");
}

function missingFields(d) {
  const miss = [];
  if (!d.nama) miss.push("Nama");
  if (!d.alamat) miss.push("Alamat");
  if (!d.nomorWa) miss.push("Nomor WA");
  if (!d.pembayaran) miss.push("Pembayaran");
  if (!d.jiwa) miss.push("Jiwa");
  return miss;
}

function labelTambah(code) {
  return code === "MAAL" ? "Maal" : code === "FIDYAH" ? "Fidyah" : "Infak";
}

function shortTx(txid) {
  const s = String(txid || "");
  return s.length > 14 ? s.slice(0, 14) + "…" : s;
}

// ===================== Text pack =====================
const TXT = {
  start: () =>
    `👋 <b>Assistant Zakat AL-Hikam</b>\n` +
    `Aku bantu input zakat biar kamu nggak jadi admin Excel dadakan 😄\n\n` +
    `Mulai transaksi: <code>/input</code>\n` +
    `Cek draft: <code>/lihat</code>`,

  draftCreated: (d) =>
    `🧾 <b>Draft dibuka!</b>\n` +
    `TxID: <code>${h(shortTx(d.txid))}</code>\n\n` +
    `✍️ <b>Nama muzaki</b>\n` +
    `Ketik nama aja ya.\n` +
    `Contoh: <i>Ahmad</i>`,

  askName: () =>
    `✍️ <b>Nama muzaki</b>\n` +
    `Ketik nama aja ya.\n` +
    `Contoh: <i>Ahmad</i>`,

  nameSaved: (nama) =>
    `✅ <b>Nama tersimpan</b>\n` +
    `Nama: <b>${h(nama)}</b>`,

  askBlok: () =>
    `📍 <b>Pilih alamat</b>\n` +
    `Pilih <b>Blok</b> dulu (A–I):`,

  askNomorBlok: (blok) =>
    `📍 <b>Alamat</b>\n` +
    `Blok: <b>${h(blok)}</b>\n` +
    `Pilih <b>nomor blok</b> (1–24):`,

  askRumah: (blok, nomorBlok) =>
    `📍 <b>Alamat</b>\n` +
    `Blok: <b>${h(blok)}</b>\n` +
    `No Blok: <b>${h(nomorBlok)}</b>\n` +
    `Pilih <b>nomor rumah</b> (1–${TOTAL_RUMAH}):`,

  alamatSaved: (alamat) =>
    `📍 <b>Alamat tersimpan</b>\n` +
    `Alamat: <code>${h(alamat)}</code>`,

  askWa: () =>
    `📱 <b>Nomor WA Muzaki</b>\n` +
    `Ketik nomor WA diawali angka 0 atau 62.\n` +
    `Ketik tanda strip "<b>-</b>" kalau dia nggak punya WA.\n` +
    `Contoh: <i>08123456789</i>`,

  waSaved: (wa) =>
    `✅ <b>WA tersimpan</b>\n` +
    `Nomor: <b>${h(wa)}</b>`,

  askPay: () =>
    `💳 <b>Pembayaran zakat fitrah</b>\n` +
    `Pilih metode pembayaran:`,

  paySaved: (p) =>
    `✅ <b>Pembayaran dipilih</b>\n` +
    `Metode: <b>${h(p)}</b>`,

  askJiwa: () =>
    `👨‍👩‍👧‍👦 <b>Jumlah jiwa</b>\n` +
    `Pilih jumlah jiwa:`,

  jiwaSaved: (n) =>
    `✅ <b>Jiwa tersimpan</b>\n` +
    `Jiwa: <b>${n}</b>`,

  askTambah: () =>
    `➕ <b>Tambahan (opsional)</b>\n` +
    `Pilih jenis tambahan (atau klik Lewati):`,

  askNominalTambah: (label) =>
    `➕ <b>${h(label)}</b>\n` +
    `Ketik nominal (angka aja).\n` +
    `Contoh: <code>25000</code>\n\n` +
    `Kalau salah klik: <code>/edit</code>`,

  tambahSaved: (label, amount) =>
    `✅ <b>${h(label)} tersimpan</b>\n` +
    `Nominal: <b>Rp ${rupiah(amount)}</b>`,

  summary: (d) => {
    const miss = missingFields(d);
    return (
      `🧾 <b>Ringkasan Draft</b>\n` +
      `TxID: <code>${h(shortTx(d.txid))}</code>\n` +
      `Nama: <b>${h(d.nama || "-")}</b>\n` +
      `Alamat: <code>${h(d.alamat || "-")}</code>\n` +
      `📱 WA: <b>${h(d.nomorWa || "-")}</b>\n` +
      `Pembayaran: <b>${h(d.pembayaran || "-")}</b>\n` +
      `Jiwa: <b>${d.jiwa || "-"}</b>\n\n` +
      `💰 Maal: <b>Rp ${rupiah(d.maal || 0)}</b>\n` +
      `🧾 Fidyah: <b>Rp ${rupiah(d.fidyah || 0)}</b>\n` +
      `🎁 Infak: <b>Rp ${rupiah(d.infak || 0)}</b>\n` +
      `👤 Amil: <i>${h(d.amil || "-")}</i>\n\n` +
      (miss.length
        ? `⚠️ Status: <b>BELUM LENGKAP</b>\nKurang: <b>${h(miss.join(", "))}</b>\n\nKlik <b>Edit</b> kalau mau benerin.`
        : `✅ Status: <b>SIAP DISIMPAN</b>\nKalau ada yang salah, klik <b>Edit</b> dulu ya 😄`)
    );
  },

  needFields: (miss) =>
    `⚠️ <b>Belum bisa simpan</b>\n` +
    `Masih kurang: <b>${h(miss.join(", "))}</b>\n\n` +
    `Klik tombol "🧾 Lihat Ringkasan" di bawah.`,

  saved: (row) =>
    `✅ <b>Tersimpan!</b>\n` +
    `Baris: <code>${row}</code>\n\n` +
    `Mau input lagi? <code>/input</code>`,

  canceled: () =>
    `🗑️ <b>Draft dibatalkan</b>\n` +
    `Kalau mau mulai lagi: <code>/input</code>`,

  noDraft: () =>
    `😄 Draft kamu belum ada.\nMulai dulu ya: <code>/input</code>`,

  unknown: () =>
    `🤖 Aku agak bingung itu maksudnya apa 😄\n` +
    `Mulai: <code>/input</code>\n` +
    `Cek draft: <code>/lihat</code>`
};

// ===================== Core flow =====================
async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  if (!isAllowed(userId)) {
    await tgSend(chatId, "⛔ <b>Akses ditolak</b>\nAkun ini belum terdaftar sebagai panitia.");
    return;
  }

  const textRaw = (msg.text || "").trim();
  const normalized = textRaw.toLowerCase();

  const text =
    normalized === "🧾 lihat ringkasan" ? "/lihat" :
    normalized === "❌ batal transaksi" ? "/cancel" :
    textRaw;

  if (text === "/start") {
    await tgSend(chatId, TXT.start(), { reply_markup: mainMenuKeyboard("Ketik /input untuk mulai...") });
    return;
  }

  if (text === "/input") {
    const draft = freshDraft(msg.from);
    draft.state = "WAIT_NAME"; 
    await setDraft(userId, draft);
    await tgSend(chatId, TXT.draftCreated(draft), { reply_markup: mainMenuKeyboard("Ketik nama lengkap muzaki...") });
    return;
  }

  let draft = await getDraft(userId);
  if (!draft) {
    await tgSend(chatId, TXT.noDraft(), { reply_markup: mainMenuKeyboard("Ketik /input untuk mulai...") });
    return;
  }

  if (draft.state === "PROCESSING") {
    return; 
  }

  if (text === "/lihat") {
    await tgSend(chatId, TXT.summary(draft), { reply_markup: okCancelInline() });
    return;
  }

  if (text === "/cancel") {
    await deleteDraft(userId);
    await tgSend(chatId, TXT.canceled(), { reply_markup: { remove_keyboard: true } });
    return;
  }

  if (text === "/alamat") {
    draft.blok = "";
    draft.nomorBlok = 0;
    draft.nomorRumah = 0;
    draft.alamat = "";
    draft.rumahPage = 1;
    draft.state = "IDLE";
    await setDraft(userId, draft);
    await tgSend(chatId, TXT.askBlok(), { reply_markup: blokKeyboard() });
    return;
  }

  if (text === "/wa") {
    draft.state = "WAIT_WA";
    await setDraft(userId, draft);
    await tgSend(chatId, TXT.askWa(), { reply_markup: mainMenuKeyboard("Contoh: 081234... atau ketik -") });
    return;
  }

  if (text === "/pembayaran") {
    draft.pembayaran = "";
    draft.state = "IDLE";
    await setDraft(userId, draft);
    await tgSend(chatId, TXT.askPay(), { reply_markup: pembayaranKeyboard() });
    return;
  }

  if (text === "/jiwa") {
    draft.jiwa = 0;
    draft.state = "IDLE";
    await setDraft(userId, draft);
    await tgSend(chatId, TXT.askJiwa(), { reply_markup: jiwaKeyboard() });
    return;
  }

  if (text === "/tambahan") {
    draft.pendingAdd = "";
    draft.state = "IDLE";
    await setDraft(userId, draft);
    await tgSend(chatId, TXT.askTambah(), { reply_markup: tambahanKeyboard() });
    return;
  }

  if (text === "/ok") {
    const miss = missingFields(draft);
    if (miss.length) {
      await tgSend(chatId, TXT.needFields(miss), { reply_markup: mainMenuKeyboard("Lengkapi data yang kurang...") });
      return;
    }

    draft.state = "PROCESSING";
    await setDraft(userId, draft);

    const loadMsg = await tgSend(chatId, "♻️ <i>Loading [░░░░░░░░░░] 0%</i>");
    const loadMsgId = loadMsg?.result?.message_id;

    let stopSignal = { done: false };

    const animateLoading = async () => {
      const frames = [
        "♻️ <i>Loading [██░░░░░░░░] 20%</i>",
        "♻️ <i>Loading [████░░░░░░] 40%</i>",
        "♻️ <i>Loading [██████░░░░] 60%</i>",
        "♻️ <i>Loading [████████░░] 80%</i>",
        "♻️ <i>Loading [█████████░] 95%</i>"
      ];
      for (let frame of frames) {
        if (stopSignal.done) break;
        await new Promise(r => setTimeout(r, 1500)); 
        if (stopSignal.done) break;
        if (loadMsgId) {
          await tgEdit(chatId, loadMsgId, frame).catch(()=>{});
        }
      }
    };

    animateLoading();

    const appsUrl = env("APPS_SCRIPT_URL");
    const appsKey = env("APPS_API_KEY");

    const body = {
      api_key: appsKey,
      txid: draft.txid,
      nama: draft.nama,
      alamat: draft.alamat,
      nomor_wa: draft.nomorWa, 
      pembayaran: draft.pembayaran,
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

    // STOP ANIMASI, PAKSA 100%, KASIH JEDA BIAR KEBACA, LALU HAPUS
    stopSignal.done = true;
    if (loadMsgId) {
      await tgEdit(chatId, loadMsgId, "♻️ <i>Loading [██████████] 100%</i>").catch(()=>{});
      await new Promise(res => setTimeout(res, 800)); // Delay 0.8 detik
      await tg("deleteMessage", { chat_id: chatId, message_id: loadMsgId }).catch(e => {});
    }

    if (!out || out.ok !== true) {
      draft.state = "IDLE";
      await setDraft(userId, draft);
      await tgSend(chatId, "⚠️ <b>Gagal simpan ke sheet</b>\nKlik <code>/lihat</code> lalu OK lagi.");
      return;
    }

    await deleteDraft(userId);
    
    if (out.pdf_url) {
      await tgSend(chatId, `✅ <b>Tersimpan di baris ${out.row}!</b>\nSedang mengirim kwitansi...`);
      await tg("sendDocument", {
        chat_id: chatId,
        document: out.pdf_url,
        caption: `🧾 Kwitansi Zakat (TxID: ${draft.txid})`
      });
      await tgSend(chatId, "Mau input lagi? <code>/input</code>", { reply_markup: mainMenuKeyboard("Ketik /input untuk mulai...") });
    } else {
      await tgSend(chatId, TXT.saved(out.row), { reply_markup: mainMenuKeyboard("Ketik /input untuk mulai...") });
    }
    return;
  }

  // ===== TANGKAPAN FREE-TEXT SEBAGAI AUTO-NEXT WIZARD =====
  if (draft.state === "WAIT_NAME") {
    draft.nama = textRaw;
    draft.state = "IDLE";
    await setDraft(userId, draft);
    await tgSend(chatId, TXT.nameSaved(draft.nama));
    return handleMessage({ chat: { id: chatId }, from: msg.from, text: "/alamat" });
  }

  if (draft.state === "WAIT_ALAMAT_MANUAL") {
    draft.alamat = textRaw;
    draft.state = "IDLE";
    await setDraft(userId, draft);
    await tgSend(chatId, TXT.alamatSaved(draft.alamat));
    return handleMessage({ chat: { id: chatId }, from: msg.from, text: "/wa" });
  }

  if (draft.state === "WAIT_WA") {
    draft.nomorWa = textRaw;
    draft.state = "IDLE";
    await setDraft(userId, draft);
    await tgSend(chatId, TXT.waSaved(draft.nomorWa));
    return handleMessage({ chat: { id: chatId }, from: msg.from, text: "/pembayaran" });
  }

  if (draft.state === "WAIT_ADD_AMOUNT") {
    const amount = parseMoney(textRaw);
    if (amount === null) {
      await tgSend(chatId, `⚠️ <b>Nominal harus angka!</b>\nContoh: <code>25000</code>`);
      return;
    }

    const code = draft.pendingAdd;
    const label = labelTambah(code);

    if (code === "MAAL") draft.maal = amount;
    if (code === "FIDYAH") draft.fidyah = amount;
    if (code === "INFAK") draft.infak = amount;

    draft.pendingAdd = "";
    draft.state = "IDLE";
    await setDraft(userId, draft);

    await tgSend(chatId, TXT.tambahSaved(label, amount));
    return handleMessage({ chat: { id: chatId }, from: msg.from, text: "/tambahan" });
  }

  await tgSend(chatId, TXT.unknown());
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

  if (draft.state === "PROCESSING") {
    await tgAck(cb.id, "Sabar, lagi loading PDF... ⏳");
    return;
  }

  if (data === "do:lihat") {
    await tgAck(cb.id, "Ringkasan");
    await tg("deleteMessage", { chat_id: chatId, message_id: cb.message.message_id }).catch(()=>{});
    return handleMessage({ chat: { id: chatId }, from: cb.from, text: "/lihat" });
  }

  if (data === "do:ok") {
    await tgAck(cb.id, "Sedang diproses... ⏳");
    await tg("editMessageReplyMarkup", {
      chat_id: chatId,
      message_id: cb.message.message_id,
      reply_markup: { inline_keyboard: [] }
    });
    return handleMessage({ chat: { id: chatId }, from: cb.from, text: "/ok" });
  }

  if (data === "do:cancel") {
    await tgAck(cb.id, "Dibatalkan ❌");
    return handleMessage({ chat: { id: chatId }, from: cb.from, text: "/cancel" });
  }

  if (data === "do:edit") {
    await tgAck(cb.id, "Edit ✏️");
    await tgSend(chatId, "✏️ <b>Edit Draft</b>\nPilih bagian yang mau dibenerin:", { reply_markup: editMenuInline() });
    return;
  }

  if (data === "edit:back") {
    await tgAck(cb.id, "Balik");
    await tg("deleteMessage", { chat_id: chatId, message_id: cb.message.message_id }).catch(()=>{});
    return handleMessage({ chat: { id: chatId }, from: cb.from, text: "/lihat" });
  }

  if (data === "edit:menu") {
    await tgAck(cb.id, "Menu");
    await tgEdit(chatId, cb.message.message_id, "✏️ <b>Edit Draft</b>\nPilih bagian yang mau dibenerin:", { reply_markup: editMenuInline() });
    return;
  }

  if (data === "edit:nama") {
    draft.state = "WAIT_NAME";
    await setDraft(userId, draft);
    await tgAck(cb.id, "Nama");
    await tgSend(chatId, TXT.askName(), { reply_markup: mainMenuKeyboard("Ketik nama lengkap muzaki...") });
    return;
  }

  if (data === "edit:alamat") {
    draft.blok = "";
    draft.nomorBlok = 0;
    draft.nomorRumah = 0;
    draft.alamat = "";
    draft.rumahPage = 1;
    draft.state = "IDLE";
    await setDraft(userId, draft);
    await tgAck(cb.id, "Alamat");
    await tgSend(chatId, TXT.askBlok(), { reply_markup: blokKeyboard() });
    return;
  }

  if (data === "edit:wa") {
    draft.state = "WAIT_WA";
    await setDraft(userId, draft);
    await tgAck(cb.id, "Nomor WA");
    await tgSend(chatId, TXT.askWa(), { reply_markup: mainMenuKeyboard("Contoh: 081234... atau ketik -") });
    return;
  }

  if (data === "edit:pay") {
    draft.pembayaran = "";
    draft.state = "IDLE";
    await setDraft(userId, draft);
    await tgAck(cb.id, "Pembayaran");
    await tgSend(chatId, TXT.askPay(), { reply_markup: pembayaranKeyboard() });
    return;
  }

  if (data === "edit:jiwa") {
    draft.jiwa = 0;
    draft.state = "IDLE";
    await setDraft(userId, draft);
    await tgAck(cb.id, "Jiwa");
    await tgSend(chatId, TXT.askJiwa(), { reply_markup: jiwaKeyboard() });
    return;
  }

  if (data === "edit:tambahan") {
    draft.state = "IDLE";
    draft.pendingAdd = "";
    await setDraft(userId, draft);
    await tgAck(cb.id, "Tambahan");
    await tgEdit(chatId, cb.message.message_id, "➕ <b>Edit Tambahan</b>\nMau ubah yang mana?", { reply_markup: editTambahanInline() });
    return;
  }

  if (data.startsWith("edit:clear:")) {
    const code = data.split(":")[2];
    if (code === "MAAL") draft.maal = 0;
    if (code === "FIDYAH") draft.fidyah = 0;
    if (code === "INFAK") draft.infak = 0;
    await setDraft(userId, draft);
    await tgAck(cb.id, "Dihapus 🧹");
    await tgEdit(chatId, cb.message.message_id, "🧹 <b>Oke, sudah dihapus</b>");
    return handleMessage({ chat: { id: chatId }, from: cb.from, text: "/lihat" });
  }

  if (data.startsWith("edit:set:")) {
    const code = data.split(":")[2];
    draft.pendingAdd = code;
    draft.state = "WAIT_ADD_AMOUNT";
    await setDraft(userId, draft);
    await tgAck(cb.id, "Set ✅");
    const label = labelTambah(code);
    await tgSend(chatId, TXT.askNominalTambah(label), { reply_markup: mainMenuKeyboard("Ketik nominal angka...") });
    return;
  }

  // === AUTO NEXT CALLBACKS ===
  if (data.startsWith("blk:")) {
    const blokVal = data.split(":")[1];
    
    if (blokVal === "MANUAL") {
      draft.state = "WAIT_ALAMAT_MANUAL";
      await setDraft(userId, draft);
      await tgAck(cb.id, "Ketik Manual");
      await tg("deleteMessage", { chat_id: chatId, message_id: cb.message.message_id }).catch(()=>{});
      await tgSend(chatId, "📍 <b>Alamat Luar Perumahan</b>\nSilakan ketik alamat lengkap muzaki.\nContoh: <i>Jl. Raya Ciseeng No. 12, RT 01/02</i>", { reply_markup: mainMenuKeyboard("Contoh: Jl. Raya Ciseeng No. 12") });
      return;
    }

    draft.blok = blokVal;
    await setDraft(userId, draft);
    await tgAck(cb.id, `Blok ${draft.blok}`);
    await tgEdit(chatId, cb.message.message_id, TXT.askNomorBlok(draft.blok), { reply_markup: nomorBlokKeyboard() });
    return;
  }

  if (data.startsWith("nb:")) {
    draft.nomorBlok = parseInt(data.split(":")[1], 10);
    draft.rumahPage = 1;
    await setDraft(userId, draft);
    await tgAck(cb.id, `No Blok ${draft.nomorBlok}`);
    await tgEdit(chatId, cb.message.message_id, TXT.askRumah(draft.blok, draft.nomorBlok), { reply,  markup: rumahKeyboard(draft.rumahPage) });
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
    
    await tgEdit(chatId, cb.message.message_id, TXT.alamatSaved(draft.alamat));
    return handleMessage({ chat: { id: chatId }, from: cb.from, text: "/wa" });
  }

  if (data.startsWith("pay:")) {
    const code = data.split(":")[1];
    draft.pembayaran =
      code === "UANG" ? "Uang" :
      code === "LTR" ? "Beras (Ltr)" :
      "Beras (Kg)";
    await setDraft(userId, draft);
    await tgAck(cb.id, "Oke ✅");
    
    await tgEdit(chatId, cb.message.message_id, TXT.paySaved(draft.pembayaran));
    return handleMessage({ chat: { id: chatId }, from: cb.from, text: "/jiwa" });
  }

  if (data.startsWith("jw:")) {
    draft.jiwa = parseInt(data.split(":")[1], 10);
    await setDraft(userId, draft);
    await tgAck(cb.id, `Jiwa ${draft.jiwa}`);
    
    await tgEdit(chatId, cb.message.message_id, TXT.jiwaSaved(draft.jiwa));
    return handleMessage({ chat: { id: chatId }, from: cb.from, text: "/tambahan" });
  }

  if (data.startsWith("add:")) {
    draft.pendingAdd = data.split(":")[1];
    draft.state = "WAIT_ADD_AMOUNT";
    await setDraft(userId, draft);
    const label = labelTambah(draft.pendingAdd);
    await tgAck(cb.id, label);
    
    await tg("deleteMessage", { chat_id: chatId, message_id: cb.message.message_id }).catch(()=>{});
    await tgSend(chatId, TXT.askNominalTambah(label), { reply_markup: mainMenuKeyboard("Ketik nominal angka...") });
    return;
  }

  await tgAck(cb.id, "Oke");
}
