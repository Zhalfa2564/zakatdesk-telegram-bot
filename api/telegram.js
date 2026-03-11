// Assistant Zakat AL-Hikam (Telegram Bot) - Vercel + Upstash REST
// Full Refactor:
// - Anti webhook retry spam (draft lock + update dedupe)
// - Dynamic input placeholder
// - Animated loading bar saat simpan/PDF
// - Auto-next wizard yang rapih
// - Edit mode beneran edit (balik ke ringkasan, bukan ngulang wizard penuh)
// - Validasi nomor WA
// - Recovery draft kalau state PROCESSING nyangkut
// - /input tidak overwrite draft lama
// - Navigasi alamat lebih enak

// ===================== Constants =====================
const DRAFT_TTL_SEC = 1800;
const UPDATE_DEDUPE_TTL_SEC = 600;
const PROCESSING_STALE_MS = 3 * 60 * 1000;

const TOTAL_RUMAH = 60;
const RUMAH_PER_PAGE = 10;
const RUMAH_PAGES = Math.ceil(TOTAL_RUMAH / RUMAH_PER_PAGE);

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
  const path = [cmd, ...args.map((a) => encodeURIComponent(String(a)))].join("/");
  const url = `${kvBase()}/${path}`;

  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${kvToken()}` }
  });

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
    try {
      update = JSON.parse(update);
    } catch {
      update = {};
    }
  }

  try {
    const updateId = update?.update_id;
    if (updateId !== undefined && updateId !== null) {
      const dup = await isDuplicateUpdate(updateId).catch(() => false);
      if (dup) return res.status(200).send("ok");
    }

    if (update?.message) await handleMessage(update.message);
    if (update?.callback_query) await handleCallback(update.callback_query);
  } catch (e) {
    console.log("BOT_ERR:", String(e));
  }

  return res.status(200).send("ok");
}

async function isDuplicateUpdate(updateId) {
  const key = `upd:${updateId}`;
  const seen = await kvGet(key).catch(() => null);
  if (seen) return true;

  await kvSetEx(key, UPDATE_DEDUPE_TTL_SEC, "1").catch(() => {});
  return false;
}

// ===================== Env / Access =====================
function env(name) {
  return (process.env[name] || "").trim();
}

function isAllowed(userId) {
  const raw = (process.env.ALLOWED_USER_IDS || "").trim();
  if (!raw) return true;

  const set = new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  );

  return set.has(String(userId));
}

// ===================== Draft store (Upstash) =====================
async function getDraft(userId) {
  const raw = await kvGet(`draft:${userId}`);
  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch {
    await kvDel(`draft:${userId}`).catch(() => {});
    return null;
  }
}

async function setDraft(userId, draft) {
  await kvSetEx(`draft:${userId}`, DRAFT_TTL_SEC, JSON.stringify(draft));
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

    state: "IDLE",          // IDLE | WAIT_NAME | WAIT_ALAMAT_MANUAL | WAIT_WA | WAIT_ADD_AMOUNT | PROCESSING
    flowMode: "CREATE",     // CREATE | EDIT
    editingField: "",       // nama | alamat | wa | pay | jiwa | tambahan
    pendingAdd: "",         // MAAL | FIDYAH | INFAK

    blok: "",
    nomorBlok: 0,
    nomorRumah: 0,
    rumahPage: 1,

    processingAt: 0
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
  if (!j.ok) {
    console.log("TG_ERR:", j);
    throw new Error(`Telegram ${method} failed: ${j.description || JSON.stringify(j)}`);
  }

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
  return tg("answerCallbackQuery", {
    callback_query_id: cbId,
    text,
    show_alert: false
  });
}

async function tgDelete(chatId, messageId) {
  return tg("deleteMessage", {
    chat_id: chatId,
    message_id: messageId
  });
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
  const row1 = ["A", "B", "C", "D", "E"].map((x) => ({ text: x, callback_data: `blk:${x}` }));
  const row2 = ["F", "G", "H", "I"].map((x) => ({ text: x, callback_data: `blk:${x}` }));
  const row3 = [{ text: "🌍 Luar Perumahan (Ketik Manual)", callback_data: "blk:MANUAL" }];

  return { inline_keyboard: [row1, row2, row3] };
}

function nomorBlokKeyboard() {
  const rows = [];
  let row = [];

  for (let i = 1; i <= 24; i++) {
    row.push({ text: String(i), callback_data: `nb:${i}` });
    if (row.length === 6) {
      rows.push(row);
      row = [];
    }
  }

  if (row.length) rows.push(row);
  rows.push([{ text: "⬅️ Ganti Blok", callback_data: "nav:back_blok" }]);

  return { inline_keyboard: rows };
}

function rumahKeyboard(page) {
  const start = (page - 1) * RUMAH_PER_PAGE + 1;
  const end = Math.min(start + RUMAH_PER_PAGE - 1, TOTAL_RUMAH);

  const rows = [];
  let row = [];

  for (let n = start; n <= end; n++) {
    row.push({ text: String(n), callback_data: `nr:${n}` });
    if (row.length === 5) {
      rows.push(row);
      row = [];
    }
  }

  if (row.length) rows.push(row);

  const nav = [];
  if (page > 1) nav.push({ text: "⬅ Prev", callback_data: `nrp:${page - 1}` });
  if (page < RUMAH_PAGES) nav.push({ text: "Next ➡", callback_data: `nrp:${page + 1}` });
  if (nav.length) rows.push(nav);

  rows.push([{ text: "⬅️ Ganti No Blok", callback_data: "nav:back_nomor_blok" }]);

  return { inline_keyboard: rows };
}

function pembayaranKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "💵 Uang", callback_data: "pay:UANG" },
        { text: "🌾 Beras (Ltr)", callback_data: "pay:LTR" },
        { text: "⚖️ Beras (Kg)", callback_data: "pay:KG" }
      ]
    ]
  };
}

function jiwaKeyboard() {
  const rows = [];
  let row = [];

  for (let i = 1; i <= 10; i++) {
    row.push({ text: String(i), callback_data: `jw:${i}` });
    if (row.length === 5) {
      rows.push(row);
      row = [];
    }
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
    inline_keyboard: [
      [
        { text: "✅ Simpan", callback_data: "do:ok" },
        { text: "✏️ Edit Data", callback_data: "do:edit" },
        { text: "❌ Batal", callback_data: "do:cancel" }
      ]
    ]
  };
}

function editMenuInline() {
  return {
    inline_keyboard: [
      [
        { text: "✍️ Nama", callback_data: "edit:nama" },
        { text: "📍 Alamat", callback_data: "edit:alamat" }
      ],
      [
        { text: "📱 Nomor WA", callback_data: "edit:wa" },
        { text: "💳 Pembayaran", callback_data: "edit:pay" }
      ],
      [
        { text: "👨‍👩‍👧‍👦 Jiwa", callback_data: "edit:jiwa" },
        { text: "➕ Tambahan", callback_data: "edit:tambahan" }
      ],
      [
        { text: "⬅️ Kembali ke Ringkasan", callback_data: "edit:back" }
      ]
    ]
  };
}

function editTambahanInline() {
  return {
    inline_keyboard: [
      [
        { text: "💰 Set Maal", callback_data: "edit:set:MAAL" },
        { text: "🧾 Set Fidyah", callback_data: "edit:set:FIDYAH" }
      ],
      [
        { text: "🎁 Set Infak", callback_data: "edit:set:INFAK" }
      ],
      [
        { text: "🧹 Hapus Maal", callback_data: "edit:clear:MAAL" },
        { text: "🧹 Hapus Fidyah", callback_data: "edit:clear:FIDYAH" }
      ],
      [
        { text: "🧹 Hapus Infak", callback_data: "edit:clear:INFAK" }
      ],
      [
        { text: "⬅️ Kembali", callback_data: "edit:menu" }
      ]
    ]
  };
}

function existingDraftInline(txid) {
  return {
    inline_keyboard: [
      [
        { text: "🧾 Lihat Draft", callback_data: "do:lihat" },
        { text: "❌ Batalkan Draft Lama", callback_data: "do:cancel" }
      ]
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
  return s.length > 18 ? s.slice(0, 18) + "…" : s;
}

function normalizePhone(input) {
  const raw = String(input || "").trim();
  if (raw === "-") return "-";

  const digits = raw.replace(/[^\d]/g, "");
  if (!digits) return null;

  if (digits.startsWith("0") && digits.length >= 10 && digits.length <= 15) {
    return digits;
  }

  if (digits.startsWith("62") && digits.length >= 11 && digits.length <= 15) {
    return digits;
  }

  return null;
}

function clearEditMode(draft) {
  draft.flowMode = "CREATE";
  draft.editingField = "";
  return draft;
}

function nextStepAfter(field, draft) {
  if (draft.flowMode === "EDIT") {
    clearEditMode(draft);
    return "/lihat";
  }

  if (field === "nama") return "/alamat";
  if (field === "alamat") return "/wa";
  if (field === "wa") return "/pembayaran";
  if (field === "pay") return "/jiwa";
  if (field === "jiwa") return "/tambahan";
  if (field === "tambahan") return "/lihat";
  return "/lihat";
}

async function ensureNotStaleProcessing(userId, draft) {
  if (!draft || draft.state !== "PROCESSING") return draft;

  const ageMs = Date.now() - (draft.processingAt || 0);
  if (ageMs > PROCESSING_STALE_MS) {
    draft.state = "IDLE";
    draft.processingAt = 0;
    await setDraft(userId, draft);
  }

  return draft;
}

function fakeMsg(chatId, from, text) {
  return { chat: { id: chatId }, from, text };
}

// ===================== Text pack =====================
const TXT = {
  start: () =>
    `👋 <b>Assistant Zakat AL-Hikam</b>\n` +
    `Siap membantu input transaksi zakat dengan cepat, rapi, dan aman.\n\n` +
    `Perintah utama:\n` +
    `• <code>/input</code> mulai transaksi baru\n` +
    `• <code>/lihat</code> lihat draft aktif\n` +
    `• <code>/cancel</code> batalkan draft`,

  draftCreated: (d) =>
    `🧾 <b>Draft berhasil dibuat</b>\n` +
    `TxID: <code>${h(shortTx(d.txid))}</code>\n\n` +
    `1/6 • <b>Nama Muzaki</b>\n` +
    `Silakan ketik nama lengkap.\n` +
    `Contoh: <i>Ahmad Fauzi</i>`,

  askName: () =>
    `1/6 • <b>Nama Muzaki</b>\n` +
    `Silakan ketik nama lengkap.\n` +
    `Contoh: <i>Ahmad Fauzi</i>`,

  nameSaved: (nama) =>
    `✅ <b>Nama tersimpan</b>\n` +
    `Nama muzaki: <b>${h(nama)}</b>`,

  askBlok: () =>
    `2/6 • <b>Alamat</b>\n` +
    `Pilih blok terlebih dahulu:`,

  askNomorBlok: (blok) =>
    `2/6 • <b>Alamat</b>\n` +
    `Blok: <b>${h(blok)}</b>\n` +
    `Pilih nomor blok:`,

  askRumah: (blok, nomorBlok) =>
    `2/6 • <b>Alamat</b>\n` +
    `Blok: <b>${h(blok)}</b>\n` +
    `No Blok: <b>${h(nomorBlok)}</b>\n` +
    `Pilih nomor rumah:`,

  askAlamatManual: () =>
    `2/6 • <b>Alamat Luar Perumahan</b>\n` +
    `Silakan ketik alamat lengkap muzaki.\n` +
    `Contoh: <i>Jl. Raya Ciseeng No. 12, RT 01/02</i>`,

  alamatSaved: (alamat) =>
    `✅ <b>Alamat tersimpan</b>\n` +
    `Alamat: <code>${h(alamat)}</code>`,

  askWa: () =>
    `3/6 • <b>Nomor WhatsApp</b>\n` +
    `Masukkan nomor aktif dengan awalan 0 atau 62.\n` +
    `Ketik <code>-</code> jika muzaki tidak memiliki WhatsApp.`,

  waSaved: (wa) =>
    `✅ <b>Nomor WA tersimpan</b>\n` +
    `Nomor: <b>${h(wa)}</b>`,

  askPay: () =>
    `4/6 • <b>Pembayaran Zakat Fitrah</b>\n` +
    `Silakan pilih metode pembayaran:`,

  paySaved: (p) =>
    `✅ <b>Pembayaran dipilih</b>\n` +
    `Metode: <b>${h(p)}</b>`,

  askJiwa: () =>
    `5/6 • <b>Jumlah Jiwa</b>\n` +
    `Silakan pilih jumlah jiwa:`,

  jiwaSaved: (n) =>
    `✅ <b>Jumlah jiwa tersimpan</b>\n` +
    `Jiwa: <b>${n}</b>`,

  askTambah: () =>
    `6/6 • <b>Tambahan</b> <i>(opsional)</i>\n` +
    `Pilih jenis tambahan atau lanjutkan ke ringkasan:`,

  askNominalTambah: (label) =>
    `6/6 • <b>${h(label)}</b>\n` +
    `Silakan ketik nominal dalam angka saja.\n` +
    `Contoh: <code>25000</code>`,

  tambahSaved: (label, amount) =>
    `✅ <b>${h(label)} tersimpan</b>\n` +
    `Nominal: <b>Rp ${rupiah(amount)}</b>`,

  summary: (d) => {
    const miss = missingFields(d);

    return (
      `🧾 <b>Ringkasan Draft</b>\n` +
      `TxID: <code>${h(shortTx(d.txid))}</code>\n\n` +
      `• Nama: <b>${h(d.nama || "-")}</b>\n` +
      `• Alamat: <code>${h(d.alamat || "-")}</code>\n` +
      `• WA: <b>${h(d.nomorWa || "-")}</b>\n` +
      `• Pembayaran: <b>${h(d.pembayaran || "-")}</b>\n` +
      `• Jiwa: <b>${d.jiwa || "-"}</b>\n\n` +
      `• Maal: <b>Rp ${rupiah(d.maal || 0)}</b>\n` +
      `• Fidyah: <b>Rp ${rupiah(d.fidyah || 0)}</b>\n` +
      `• Infak: <b>Rp ${rupiah(d.infak || 0)}</b>\n\n` +
      `Amil: <i>${h(d.amil || "-")}</i>\n\n` +
      (
        miss.length
          ? `⚠️ <b>Belum lengkap</b>\nField yang masih kosong: <b>${h(miss.join(", "))}</b>`
          : `✅ <b>Data lengkap dan siap disimpan</b>`
      )
    );
  },

  needFields: (miss) =>
    `⚠️ <b>Belum bisa disimpan</b>\n` +
    `Masih ada field yang belum lengkap: <b>${h(miss.join(", "))}</b>\n\n` +
    `Silakan cek ringkasan lalu lengkapi data yang kurang.`,

  saved: (row, txid) =>
    `✅ <b>Transaksi berhasil disimpan</b>\n` +
    `Baris sheet: <code>${row}</code>\n` +
    `TxID: <code>${h(shortTx(txid))}</code>\n\n` +
    `Gunakan <code>/input</code> untuk memulai transaksi baru.`,

  canceled: () =>
    `🗑️ <b>Draft dibatalkan</b>\n` +
    `Gunakan <code>/input</code> untuk memulai transaksi baru.`,

  noDraft: () =>
    `📭 <b>Belum ada draft aktif</b>\n` +
    `Gunakan <code>/input</code> untuk memulai transaksi baru.`,

  processing: () =>
    `⏳ <b>Draft sedang diproses</b>\n` +
    `Mohon tunggu sebentar sampai penyimpanan selesai.`,

  unknown: () =>
    `🤖 <b>Perintah belum dikenali</b>\n` +
    `Gunakan <code>/input</code> untuk mulai atau <code>/lihat</code> untuk cek draft.`
};

// ===================== Core flow =====================
async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  if (!isAllowed(userId)) {
    await tgSend(chatId, "⛔ <b>Akses ditolak</b>\nAkun ini belum terdaftar sebagai panitia.");
    return;
  }

  const textRaw = String(msg.text || "").trim();
  if (!textRaw) return;

  const normalized = textRaw.toLowerCase();
  const text =
    normalized === "🧾 lihat ringkasan" ? "/lihat" :
    normalized === "❌ batal transaksi" ? "/cancel" :
    textRaw;

  if (text === "/start" || text === "/menu") {
    await tgSend(chatId, TXT.start(), {
      reply_markup: mainMenuKeyboard("Ketik /input untuk mulai transaksi baru...")
    });
    return;
  }

  if (text === "/input") {
    const existing = await getDraft(userId);

    if (existing) {
      const safeDraft = await ensureNotStaleProcessing(userId, existing);

      if (safeDraft.state === "PROCESSING") {
        await tgSend(chatId, TXT.processing(), {
          reply_markup: mainMenuKeyboard("Tunggu proses penyimpanan selesai...")
        });
        return;
      }

      await tgSend(
        chatId,
        `📝 <b>Kamu masih punya draft aktif</b>\n` +
          `TxID: <code>${h(shortTx(safeDraft.txid))}</code>\n\n` +
          `Silakan lanjutkan draft yang ada atau batalkan dulu.`,
        { reply_markup: existingDraftInline(safeDraft.txid) }
      );
      return;
    }

    const draft = freshDraft(msg.from);
    draft.state = "WAIT_NAME";
    await setDraft(userId, draft);

    await tgSend(chatId, TXT.draftCreated(draft), {
      reply_markup: mainMenuKeyboard("Ketik nama lengkap muzaki...")
    });
    return;
  }

  let draft = await getDraft(userId);
  if (!draft) {
    await tgSend(chatId, TXT.noDraft(), {
      reply_markup: mainMenuKeyboard("Ketik /input untuk mulai transaksi baru...")
    });
    return;
  }

  draft = await ensureNotStaleProcessing(userId, draft);

  // Anti webhook retry spam / anti input saat sedang proses
  if (draft.state === "PROCESSING") {
    return;
  }

  if (text === "/lihat") {
    await tgSend(chatId, TXT.summary(draft), { reply_markup: okCancelInline() });
    return;
  }

  if (text === "/cancel") {
    await deleteDraft(userId);
    await tgSend(chatId, TXT.canceled(), {
      reply_markup: { remove_keyboard: true }
    });
    return;
  }

  if (text === "/alamat") {
    draft.alamat = "";
    draft.blok = "";
    draft.nomorBlok = 0;
    draft.nomorRumah = 0;
    draft.rumahPage = 1;
    draft.state = "IDLE";
    clearEditMode(draft);

    await setDraft(userId, draft);
    await tgSend(chatId, TXT.askBlok(), {
      reply_markup: blokKeyboard()
    });
    return;
  }

  if (text === "/wa") {
    draft.state = "WAIT_WA";
    clearEditMode(draft);

    await setDraft(userId, draft);
    await tgSend(chatId, TXT.askWa(), {
      reply_markup: mainMenuKeyboard("Contoh: 08123456789 atau ketik -")
    });
    return;
  }

  if (text === "/pembayaran") {
    draft.pembayaran = "";
    draft.state = "IDLE";
    clearEditMode(draft);

    await setDraft(userId, draft);
    await tgSend(chatId, TXT.askPay(), {
      reply_markup: pembayaranKeyboard()
    });
    return;
  }

  if (text === "/jiwa") {
    draft.jiwa = 0;
    draft.state = "IDLE";
    clearEditMode(draft);

    await setDraft(userId, draft);
    await tgSend(chatId, TXT.askJiwa(), {
      reply_markup: jiwaKeyboard()
    });
    return;
  }

  if (text === "/tambahan") {
    draft.pendingAdd = "";
    draft.state = "IDLE";
    clearEditMode(draft);

    await setDraft(userId, draft);
    await tgSend(chatId, TXT.askTambah(), {
      reply_markup: tambahanKeyboard()
    });
    return;
  }

  if (text === "/ok") {
    const miss = missingFields(draft);
    if (miss.length) {
      await tgSend(chatId, TXT.needFields(miss), {
        reply_markup: mainMenuKeyboard("Lengkapi data yang masih kosong...")
      });
      return;
    }

    draft.state = "PROCESSING";
    draft.processingAt = Date.now();
    await setDraft(userId, draft);

    let loadMsgId = null;
    const stopSignal = { done: false };

    const animateLoading = async () => {
      const frames = [
        "♻️ <i>Loading [██░░░░░░░░] 20%</i>",
        "♻️ <i>Loading [████░░░░░░] 40%</i>",
        "♻️ <i>Loading [██████░░░░] 60%</i>",
        "♻️ <i>Loading [████████░░] 80%</i>",
        "♻️ <i>Loading [█████████░] 95%</i>"
      ];

      for (const frame of frames) {
        if (stopSignal.done) break;
        await new Promise((r) => setTimeout(r, 1500));
        if (stopSignal.done) break;
        if (loadMsgId) {
          await tgEdit(chatId, loadMsgId, frame).catch(() => {});
        }
      }
    };

    try {
      const loadMsg = await tgSend(chatId, "♻️ <i>Loading [░░░░░░░░░░] 0%</i>");
      loadMsgId = loadMsg?.result?.message_id || null;
      animateLoading();

      const appsUrl = env("APPS_SCRIPT_URL");
      const appsKey = env("APPS_API_KEY");
      if (!appsUrl) throw new Error("APPS_SCRIPT_URL missing");
      if (!appsKey) throw new Error("APPS_API_KEY missing");

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

      stopSignal.done = true;
      if (loadMsgId) {
        await tgDelete(chatId, loadMsgId).catch(() => {});
      }

      if (!r.ok || !out || out.ok !== true) {
        throw new Error("APPS_SCRIPT_SAVE_FAILED");
      }

      await deleteDraft(userId);

      if (out.pdf_url) {
        await tgSend(
          chatId,
          `✅ <b>Transaksi berhasil disimpan</b>\n` +
            `Baris sheet: <code>${out.row}</code>\n` +
            `TxID: <code>${h(shortTx(draft.txid))}</code>\n\n` +
            `Sedang mengirim kwitansi...`
        );

        try {
          await tg("sendDocument", {
            chat_id: chatId,
            document: out.pdf_url,
            caption: `🧾 Kwitansi Zakat (TxID: ${draft.txid})`
          });

          await tgSend(
            chatId,
            `📄 <b>Kwitansi berhasil dikirim</b>\n` +
              `Gunakan <code>/input</code> untuk memulai transaksi baru.`,
            {
              reply_markup: mainMenuKeyboard("Ketik /input untuk mulai transaksi baru...")
            }
          );
        } catch (e) {
          console.log("PDF_SEND_ERR:", String(e));
          await tgSend(
            chatId,
            `⚠️ <b>Data berhasil disimpan, tapi kwitansi belum berhasil dikirim</b>\n` +
              `Silakan cek link PDF dari Apps Script atau ulang kirim manual.`,
            {
              reply_markup: mainMenuKeyboard("Ketik /input untuk mulai transaksi baru...")
            }
          );
        }
      } else {
        await tgSend(chatId, TXT.saved(out.row, draft.txid), {
          reply_markup: mainMenuKeyboard("Ketik /input untuk mulai transaksi baru...")
        });
      }
    } catch (e) {
      console.log("SAVE_ERR:", String(e));

      stopSignal.done = true;
      if (loadMsgId) {
        await tgDelete(chatId, loadMsgId).catch(() => {});
      }

      draft.state = "IDLE";
      draft.processingAt = 0;
      await setDraft(userId, draft).catch(() => {});

      await tgSend(
        chatId,
        `⚠️ <b>Gagal menyimpan data</b>\n` +
          `Silakan buka <code>/lihat</code> lalu coba simpan lagi.`,
        {
          reply_markup: mainMenuKeyboard("Ketik /lihat untuk cek draft aktif...")
        }
      );
    }

    return;
  }

  // ===== Free-text wizard =====
  if (draft.state === "WAIT_NAME") {
    const nama = textRaw.trim();
    if (!nama) {
      await tgSend(chatId, TXT.askName(), {
        reply_markup: mainMenuKeyboard("Ketik nama lengkap muzaki...")
      });
      return;
    }

    draft.nama = nama;
    draft.state = "IDLE";

    const next = nextStepAfter("nama", draft);
    await setDraft(userId, draft);

    await tgSend(chatId, TXT.nameSaved(draft.nama));
    return handleMessage(fakeMsg(chatId, msg.from, next));
  }

  if (draft.state === "WAIT_ALAMAT_MANUAL") {
    const alamat = textRaw.trim();
    if (!alamat || alamat.length < 5) {
      await tgSend(chatId, TXT.askAlamatManual(), {
        reply_markup: mainMenuKeyboard("Contoh: Jl. Raya Ciseeng No. 12")
      });
      return;
    }

    draft.alamat = alamat;
    draft.state = "IDLE";

    const next = nextStepAfter("alamat", draft);
    await setDraft(userId, draft);

    await tgSend(chatId, TXT.alamatSaved(draft.alamat));
    return handleMessage(fakeMsg(chatId, msg.from, next));
  }

  if (draft.state === "WAIT_WA") {
    const wa = normalizePhone(textRaw);
    if (!wa) {
      await tgSend(
        chatId,
        `⚠️ <b>Format nomor WA belum valid</b>\n` +
          `Gunakan awalan <code>0</code> atau <code>62</code>.\n` +
          `Ketik <code>-</code> jika muzaki tidak memiliki WhatsApp.`,
        {
          reply_markup: mainMenuKeyboard("Contoh: 08123456789 atau ketik -")
        }
      );
      return;
    }

    draft.nomorWa = wa;
    draft.state = "IDLE";

    const next = nextStepAfter("wa", draft);
    await setDraft(userId, draft);

    await tgSend(chatId, TXT.waSaved(draft.nomorWa));
    return handleMessage(fakeMsg(chatId, msg.from, next));
  }

  if (draft.state === "WAIT_ADD_AMOUNT") {
    const amount = parseMoney(textRaw);
    if (amount === null || amount <= 0) {
      await tgSend(
        chatId,
        `⚠️ <b>Nominal harus angka dan lebih dari 0</b>\n` +
          `Contoh: <code>25000</code>`,
        {
          reply_markup: mainMenuKeyboard("Ketik nominal angka, contoh 25000")
        }
      );
      return;
    }

    const code = draft.pendingAdd;
    const label = labelTambah(code);

    if (code === "MAAL") draft.maal = amount;
    if (code === "FIDYAH") draft.fidyah = amount;
    if (code === "INFAK") draft.infak = amount;

    draft.pendingAdd = "";
    draft.state = "IDLE";

    const next = nextStepAfter("tambahan", draft);
    await setDraft(userId, draft);

    await tgSend(chatId, TXT.tambahSaved(label, amount));
    return handleMessage(fakeMsg(chatId, msg.from, next));
  }

  await tgSend(chatId, TXT.unknown(), {
    reply_markup: mainMenuKeyboard("Ketik /input untuk mulai transaksi baru...")
  });
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

  draft = await ensureNotStaleProcessing(userId, draft);

  if (draft.state === "PROCESSING") {
    await tgAck(cb.id, "Sabar, lagi diproses... ⏳");
    return;
  }

  if (data === "do:lihat") {
    await tgAck(cb.id, "Ringkasan");
    await tgDelete(chatId, cb.message.message_id).catch(() => {});
    return handleMessage(fakeMsg(chatId, cb.from, "/lihat"));
  }

  if (data === "do:ok") {
    await tgAck(cb.id, "Sedang diproses... ⏳");
    await tg("editMessageReplyMarkup", {
      chat_id: chatId,
      message_id: cb.message.message_id,
      reply_markup: { inline_keyboard: [] }
    }).catch(() => {});
    return handleMessage(fakeMsg(chatId, cb.from, "/ok"));
  }

  if (data === "do:cancel") {
    await tgAck(cb.id, "Dibatalkan");
    return handleMessage(fakeMsg(chatId, cb.from, "/cancel"));
  }

  if (data === "do:edit") {
    await tgAck(cb.id, "Edit draft");
    await tgSend(chatId, "✏️ <b>Edit Draft</b>\nPilih bagian yang ingin diperbarui:", {
      reply_markup: editMenuInline()
    });
    return;
  }

  if (data === "edit:back") {
    await tgAck(cb.id, "Kembali");
    await tgDelete(chatId, cb.message.message_id).catch(() => {});
    return handleMessage(fakeMsg(chatId, cb.from, "/lihat"));
  }

  if (data === "edit:menu") {
    await tgAck(cb.id, "Menu edit");
    await tgEdit(chatId, cb.message.message_id, "✏️ <b>Edit Draft</b>\nPilih bagian yang ingin diperbarui:", {
      reply_markup: editMenuInline()
    });
    return;
  }

  if (data === "edit:nama") {
    draft.state = "WAIT_NAME";
    draft.flowMode = "EDIT";
    draft.editingField = "nama";
    await setDraft(userId, draft);

    await tgAck(cb.id, "Edit nama");
    await tgSend(chatId, TXT.askName(), {
      reply_markup: mainMenuKeyboard("Ketik nama lengkap muzaki...")
    });
    return;
  }

  if (data === "edit:alamat") {
    draft.alamat = "";
    draft.blok = "";
    draft.nomorBlok = 0;
    draft.nomorRumah = 0;
    draft.rumahPage = 1;
    draft.state = "IDLE";
    draft.flowMode = "EDIT";
    draft.editingField = "alamat";
    await setDraft(userId, draft);

    await tgAck(cb.id, "Edit alamat");
    await tgSend(chatId, TXT.askBlok(), {
      reply_markup: blokKeyboard()
    });
    return;
  }

  if (data === "edit:wa") {
    draft.state = "WAIT_WA";
    draft.flowMode = "EDIT";
    draft.editingField = "wa";
    await setDraft(userId, draft);

    await tgAck(cb.id, "Edit nomor WA");
    await tgSend(chatId, TXT.askWa(), {
      reply_markup: mainMenuKeyboard("Contoh: 08123456789 atau ketik -")
    });
    return;
  }

  if (data === "edit:pay") {
    draft.pembayaran = "";
    draft.state = "IDLE";
    draft.flowMode = "EDIT";
    draft.editingField = "pay";
    await setDraft(userId, draft);

    await tgAck(cb.id, "Edit pembayaran");
    await tgSend(chatId, TXT.askPay(), {
      reply_markup: pembayaranKeyboard()
    });
    return;
  }

  if (data === "edit:jiwa") {
    draft.jiwa = 0;
    draft.state = "IDLE";
    draft.flowMode = "EDIT";
    draft.editingField = "jiwa";
    await setDraft(userId, draft);

    await tgAck(cb.id, "Edit jumlah jiwa");
    await tgSend(chatId, TXT.askJiwa(), {
      reply_markup: jiwaKeyboard()
    });
    return;
  }

  if (data === "edit:tambahan") {
    draft.pendingAdd = "";
    draft.state = "IDLE";
    draft.flowMode = "EDIT";
    draft.editingField = "tambahan";
    await setDraft(userId, draft);

    await tgAck(cb.id, "Edit tambahan");
    await tgEdit(chatId, cb.message.message_id, "➕ <b>Edit Tambahan</b>\nPilih bagian yang ingin diubah:", {
      reply_markup: editTambahanInline()
    });
    return;
  }

  if (data.startsWith("edit:clear:")) {
    const code = data.split(":")[2];

    if (code === "MAAL") draft.maal = 0;
    if (code === "FIDYAH") draft.fidyah = 0;
    if (code === "INFAK") draft.infak = 0;

    draft.pendingAdd = "";
    draft.state = "IDLE";
    clearEditMode(draft);

    await setDraft(userId, draft);
    await tgAck(cb.id, "Tambahan dihapus");
    await tgEdit(chatId, cb.message.message_id, "🧹 <b>Tambahan berhasil dihapus</b>");
    return handleMessage(fakeMsg(chatId, cb.from, "/lihat"));
  }

  if (data.startsWith("edit:set:")) {
    const code = data.split(":")[2];
    const label = labelTambah(code);

    draft.pendingAdd = code;
    draft.state = "WAIT_ADD_AMOUNT";
    draft.flowMode = "EDIT";
    draft.editingField = "tambahan";
    await setDraft(userId, draft);

    await tgAck(cb.id, "Set nominal");
    await tgSend(chatId, TXT.askNominalTambah(label), {
      reply_markup: mainMenuKeyboard("Ketik nominal angka, contoh 25000")
    });
    return;
  }

  // ===== Address navigation =====
  if (data === "nav:back_blok") {
    draft.blok = "";
    draft.nomorBlok = 0;
    draft.nomorRumah = 0;
    draft.alamat = "";
    draft.rumahPage = 1;
    await setDraft(userId, draft);

    await tgAck(cb.id, "Kembali ke blok");
    await tgEdit(chatId, cb.message.message_id, TXT.askBlok(), {
      reply_markup: blokKeyboard()
    });
    return;
  }

  if (data === "nav:back_nomor_blok") {
    draft.nomorBlok = 0;
    draft.nomorRumah = 0;
    draft.alamat = "";
    draft.rumahPage = 1;
    await setDraft(userId, draft);

    await tgAck(cb.id, "Kembali ke nomor blok");
    await tgEdit(chatId, cb.message.message_id, TXT.askNomorBlok(draft.blok), {
      reply_markup: nomorBlokKeyboard()
    });
    return;
  }

  if (data.startsWith("blk:")) {
    const blokVal = data.split(":")[1];

    if (blokVal === "MANUAL") {
      draft.state = "WAIT_ALAMAT_MANUAL";
      await setDraft(userId, draft);

      await tgAck(cb.id, "Ketik alamat manual");
      await tgDelete(chatId, cb.message.message_id).catch(() => {});
      await tgSend(chatId, TXT.askAlamatManual(), {
        reply_markup: mainMenuKeyboard("Contoh: Jl. Raya Ciseeng No. 12")
      });
      return;
    }

    draft.blok = blokVal;
    draft.nomorBlok = 0;
    draft.nomorRumah = 0;
    draft.alamat = "";
    draft.rumahPage = 1;
    draft.state = "IDLE";
    await setDraft(userId, draft);

    await tgAck(cb.id, `Blok ${draft.blok}`);
    await tgEdit(chatId, cb.message.message_id, TXT.askNomorBlok(draft.blok), {
      reply_markup: nomorBlokKeyboard()
    });
    return;
  }

  if (data.startsWith("nb:")) {
    draft.nomorBlok = parseInt(data.split(":")[1], 10);
    draft.nomorRumah = 0;
    draft.alamat = "";
    draft.rumahPage = 1;
    draft.state = "IDLE";
    await setDraft(userId, draft);

    await tgAck(cb.id, `No Blok ${draft.nomorBlok}`);
    await tgEdit(chatId, cb.message.message_id, TXT.askRumah(draft.blok, draft.nomorBlok), {
      reply_markup: rumahKeyboard(draft.rumahPage)
    });
    return;
  }

  if (data.startsWith("nrp:")) {
    draft.rumahPage = parseInt(data.split(":")[1], 10);
    await setDraft(userId, draft);

    await tgAck(cb.id, `Hal ${draft.rumahPage}`);
    await tgEdit(chatId, cb.message.message_id, TXT.askRumah(draft.blok, draft.nomorBlok), {
      reply_markup: rumahKeyboard(draft.rumahPage)
    });
    return;
  }

  if (data.startsWith("nr:")) {
    draft.nomorRumah = parseInt(data.split(":")[1], 10);
    draft.alamat = `${draft.blok}${draft.nomorBlok}/${draft.nomorRumah}`;
    draft.state = "IDLE";

    const next = nextStepAfter("alamat", draft);
    await setDraft(userId, draft);

    await tgAck(cb.id, `Rumah ${draft.nomorRumah}`);
    await tgEdit(chatId, cb.message.message_id, TXT.alamatSaved(draft.alamat));
    return handleMessage(fakeMsg(chatId, cb.from, next));
  }

  // ===== Payment / Jiwa / Tambahan =====
  if (data.startsWith("pay:")) {
    const code = data.split(":")[1];

    draft.pembayaran =
      code === "UANG" ? "Uang" :
      code === "LTR" ? "Beras (Ltr)" :
      "Beras (Kg)";
    draft.state = "IDLE";

    const next = nextStepAfter("pay", draft);
    await setDraft(userId, draft);

    await tgAck(cb.id, "Metode dipilih");
    await tgEdit(chatId, cb.message.message_id, TXT.paySaved(draft.pembayaran));
    return handleMessage(fakeMsg(chatId, cb.from, next));
  }

  if (data.startsWith("jw:")) {
    draft.jiwa = parseInt(data.split(":")[1], 10);
    draft.state = "IDLE";

    const next = nextStepAfter("jiwa", draft);
    await setDraft(userId, draft);

    await tgAck(cb.id, `Jiwa ${draft.jiwa}`);
    await tgEdit(chatId, cb.message.message_id, TXT.jiwaSaved(draft.jiwa));
    return handleMessage(fakeMsg(chatId, cb.from, next));
  }

  if (data.startsWith("add:")) {
    draft.pendingAdd = data.split(":")[1];
    draft.state = "WAIT_ADD_AMOUNT";
    await setDraft(userId, draft);

    const label = labelTambah(draft.pendingAdd);

    await tgAck(cb.id, label);
    await tgDelete(chatId, cb.message.message_id).catch(() => {});
    await tgSend(chatId, TXT.askNominalTambah(label), {
      reply_markup: mainMenuKeyboard("Ketik nominal angka, contoh 25000")
    });
    return;
  }

  await tgAck(cb.id, "Oke");
}
