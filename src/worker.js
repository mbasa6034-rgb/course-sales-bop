/* =====================================================================
 *  COURSE SALES BOT + ADMIN PANEL  (single file: src/worker.js)
 *  Telegram + Cloudflare Workers + KV
 *  Delivery: private group invite + direct link to the subject topic
 * ===================================================================== */

// ----------------------------- DEFAULTS --------------------------------
// Used only the first time. After that, admins edit everything from Telegram
// and the live data is stored in KV under the key "catalog".

const DEFAULT_CATALOG = {
  currency: "ETB",
  payment: {
    bank: "CBE — 1000XXXXXXXX (Account Holder Name)",
    telebirr: "09XXXXXXXX (Account Holder Name)",
  },
  texts: {
    welcome:
      "👋 <b>Welcome to Course Store</b>\n\nBrowse our course packs, preview a sample, and pay securely. " +
      "Your access is delivered here once your payment is verified.",
    help:
      "<b>How it works</b>\n\n1️⃣ Browse courses\n2️⃣ Preview a sample\n3️⃣ Choose your field\n" +
      "4️⃣ Pay using the details shown\n5️⃣ Send your payment screenshot here\n6️⃣ Receive your group link once verified",
  },
  courses: [
    {
      id: "math",
      title: "Engineering Mathematics",
      description: "Full notes, worked examples and past exam questions.",
      sample: { type: "document", fileId: "", text: "Chapter 1: Limits and Continuity (preview)" },
      fields: {
        social: { label: "Social", price: 300, groupId: "", topicId: "", deliveryFileId: "", deliveryText: "" },
        natural: { label: "Natural", price: 350, groupId: "", topicId: "", deliveryFileId: "", deliveryText: "" },
      },
    },
  ],
};

const SESSION_HOURS = 12;
const MAX_FAILED_LOGINS = 5;
const LOCK_MINUTES = 15;
const INVITE_EXPIRY_DAYS = 7;

const LABELS = {
  title: "title",
  description: "description",
  sampleText: "sample text",
  label: "field name",
  price: "price (numbers only)",
  deliveryText: "delivery text",
  groupId: "group ID (starts with -100)",
  topicId: "topic ID (a number, or 0 to clear)",
  bank: "bank details",
  telebirr: "Telebirr details",
  welcome: "welcome message",
  help: "help message",
};

// ------------------------------ ENTRY ----------------------------------

export default {
  async fetch(request, env) {
    if (request.method !== "POST") return new Response("OK");
    if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WEBHOOK_SECRET) {
      return new Response("Forbidden", { status: 403 });
    }
    const update = await request.json().catch(() => null);
    if (!update) return new Response("Bad Request", { status: 400 });

    try {
      if (update.callback_query) await onCallback(update.callback_query, env);
      else if (update.message) await onMessage(update.message, env);
    } catch (err) {
      console.error("Unhandled error:", err);
    }
    return new Response("OK"); // always 200 so Telegram does not retry
  },
};

// --------------------------- TELEGRAM API ------------------------------

async function tg(env, method, payload) {
  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({ ok: false, description: "bad json" }));
  if (!data.ok) console.error(`${method} failed:`, data.description);
  return data;
}

const send = (env, chat_id, text, extra = {}) =>
  tg(env, "sendMessage", { chat_id, text, parse_mode: "HTML", disable_web_page_preview: true, ...extra });

const answer = (env, callback_query_id, text = "", show_alert = false) =>
  tg(env, "answerCallbackQuery", { callback_query_id, text, show_alert });

const deleteMsg = (env, chat_id, message_id) => tg(env, "deleteMessage", { chat_id, message_id });

const kb = (rows) => ({ inline_keyboard: rows });

async function render(env, chatId, msgId, text, markup) {
  if (msgId) {
    return tg(env, "editMessageText", {
      chat_id: chatId,
      message_id: msgId,
      text,
      parse_mode: "HTML",
      reply_markup: markup,
      disable_web_page_preview: true,
    });
  }
  return send(env, chatId, text, { reply_markup: markup });
}

// ------------------------------ STORAGE --------------------------------

const getJSON = async (env, key) => {
  const v = await env.DB.get(key);
  return v ? JSON.parse(v) : null;
};
const putJSON = (env, key, value, ttl) =>
  env.DB.put(key, JSON.stringify(value), ttl ? { expirationTtl: ttl } : undefined);
const delKey = (env, key) => env.DB.delete(key);

const getCatalog = async (env) => (await getJSON(env, "catalog")) || structuredClone(DEFAULT_CATALOG);
const saveCatalog = (env, cat) => putJSON(env, "catalog", cat);

// ------------------------------ HELPERS --------------------------------

const esc = (s = "") => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const adminIds = (env) => env.ADMIN_IDS.split(",").map((s) => Number(s.trim())).filter(Boolean);
const isAdmin = (env, uid) => adminIds(env).includes(uid);
const findCourse = (cat, id) => cat.courses.find((c) => c.id === id);
const newId = () => crypto.randomUUID().slice(0, 6);
const slug = (s) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 20) || newId();

// Direct link to a topic inside a private supergroup: t.me/c/<id without -100>/<topic id>
const topicLink = (field) =>
  `https://t.me/c/${String(field.groupId).replace(/^-100/, "")}/${field.topicId}`;

async function hasSession(env, uid) {
  const s = await getJSON(env, `asess:${uid}`);
  return Boolean(s && s.exp > Date.now());
}
const setState = (env, uid, state) => putJSON(env, `astate:${uid}`, state, 900);
const getState = (env, uid) => getJSON(env, `astate:${uid}`);
const clearState = (env, uid) => delKey(env, `astate:${uid}`);

async function ask(env, chatId, uid, state, prompt) {
  await setState(env, uid, state);
  return send(env, chatId, `${prompt}\n\nSend /cancel to stop.`);
}

// ============================ CUSTOMER SIDE ============================

async function showMain(env, chatId, msgId) {
  const cat = await getCatalog(env);
  return render(env, chatId, msgId, cat.texts.welcome, kb([
    [{ text: "📚 Browse courses", callback_data: "courses" }],
    [{ text: "❓ How it works", callback_data: "help" }],
  ]));
}

async function showHelp(env, chatId, msgId) {
  const cat = await getCatalog(env);
  return render(env, chatId, msgId, cat.texts.help, kb([[{ text: "⬅️ Back", callback_data: "menu" }]]));
}

async function showCourses(env, chatId, msgId, cat) {
  const rows = cat.courses.map((c) => [{ text: `📘 ${c.title}`, callback_data: `course:${c.id}` }]);
  if (!rows.length) rows.push([{ text: "No courses yet", callback_data: "menu" }]);
  rows.push([{ text: "⬅️ Back", callback_data: "menu" }]);
  return render(env, chatId, msgId, "<b>Select a course:</b>", kb(rows));
}

async function showCourse(env, chatId, msgId, cat, course) {
  const fields = Object.values(course.fields);
  const prices = fields.length
    ? fields.map((f) => `• ${esc(f.label)}: <b>${f.price} ${cat.currency}</b>`).join("\n")
    : "<i>Coming soon</i>";
  const text = `📘 <b>${esc(course.title)}</b>\n\n${esc(course.description)}\n\n<b>Price by field:</b>\n${prices}`;
  const rows = [[{ text: "👀 Preview sample", callback_data: `sample:${course.id}` }]];
  if (fields.length) rows.push([{ text: "🛒 Buy this course", callback_data: `buy:${course.id}` }]);
  rows.push([{ text: "⬅️ Back", callback_data: "courses" }]);
  return render(env, chatId, msgId, text, kb(rows));
}

async function showFields(env, chatId, msgId, cat, course) {
  const rows = Object.entries(course.fields).map(([key, f]) => [{
    text: `${f.label} — ${f.price} ${cat.currency}`,
    callback_data: `field:${course.id}:${key}`,
  }]);
  rows.push([{ text: "⬅️ Back", callback_data: `course:${course.id}` }]);
  return render(env, chatId, msgId, `Choose your field for <b>${esc(course.title)}</b>:`, kb(rows));
}

async function sendSample(env, chatId, course) {
  const s = course.sample;
  if (s.fileId) {
    const method = s.type === "photo" ? "sendPhoto" : "sendDocument";
    const key = s.type === "photo" ? "photo" : "document";
    return tg(env, method, { chat_id: chatId, [key]: s.fileId, caption: `👀 Sample — ${course.title}\n${s.text || ""}` });
  }
  return send(env, chatId, `👀 <b>Sample — ${esc(course.title)}</b>\n\n${esc(s.text)}`);
}

async function startOrder(env, chatId, msgId, cat, course, fieldKey) {
  const field = course.fields[fieldKey];
  if (!field) return;

  const id = crypto.randomUUID().slice(0, 8).toUpperCase();
  const order = {
    id,
    chatId,
    courseId: course.id,
    courseTitle: course.title,
    field: fieldKey,
    fieldLabel: field.label,
    amount: field.price,
    currency: cat.currency,
    status: "awaiting_proof",
    createdAt: Date.now(),
    customer: null,
    proof: null,
    adminMessages: [],
  };
  await putJSON(env, `order:${id}`, order);
  await putJSON(env, `user:${chatId}`, { orderId: id });

  const text =
    `🧾 <b>Order #${id}</b>\n` +
    `📘 ${esc(course.title)} — ${esc(field.label)}\n` +
    `💰 Amount: <b>${field.price} ${cat.currency}</b>\n\n` +
    `<b>Payment details</b>\n` +
    `🏦 Bank: ${esc(cat.payment.bank)}\n` +
    `📱 Telebirr: ${esc(cat.payment.telebirr)}\n\n` +
    `⚠️ Use <b>#${id}</b> as the payment reference.\n\n` +
    `After paying, send your <b>payment screenshot</b> here as a photo.`;

  return render(env, chatId, msgId, text, kb([[{ text: "⬅️ Back to menu", callback_data: "menu" }]]));
}

// ----------------------------- PAYMENT PROOF ---------------------------

async function handleProof(msg, env) {
  const chatId = msg.chat.id;
  const session = await getJSON(env, `user:${chatId}`);
  const order = session ? await getJSON(env, `order:${session.orderId}`) : null;

  if (!order || order.status !== "awaiting_proof") {
    return send(env, chatId, "Please choose a course first 👉 /start");
  }

  const isPhoto = Boolean(msg.photo);
  const isImageDoc = msg.document?.mime_type?.startsWith("image/");
  if (!isPhoto && !isImageDoc) {
    return send(env, chatId, "Please send your payment screenshot as an image.");
  }

  const fileId = isPhoto ? msg.photo.at(-1).file_id : msg.document.file_id;
  const kind = isPhoto ? "photo" : "document";
  const u = msg.from;

  order.status = "pending_review";
  order.proof = { type: kind, fileId };
  order.submittedAt = Date.now();
  order.customer = {
    name: [u.first_name, u.last_name].filter(Boolean).join(" "),
    username: u.username || null,
    id: u.id,
  };

  order.adminMessages = [];
  for (const adminId of adminIds(env)) {
    const r = await tg(env, kind === "photo" ? "sendPhoto" : "sendDocument", {
      chat_id: adminId,
      [kind]: fileId,
      caption: adminCaption(order, "⏳ Pending review"),
      parse_mode: "HTML",
      reply_markup: kb([[
        { text: "✅ Approve", callback_data: `ok:${order.id}` },
        { text: "❌ Reject", callback_data: `no:${order.id}` },
      ]]),
    });
    if (r.ok) order.adminMessages.push({ chatId: adminId, messageId: r.result.message_id });
  }

  await putJSON(env, `order:${order.id}`, order);
  await delKey(env, `user:${chatId}`);

  return send(env, chatId,
    `✅ Screenshot received for order <b>#${order.id}</b>.\n` +
    `Our team will verify it shortly. Your access will be sent here once approved.`);
}

function adminCaption(order, status) {
  const c = order.customer || {};
  const handle = c.username ? ` (@${esc(c.username)})` : "";
  return (
    `🧾 <b>Order #${order.id}</b>\n` +
    `👤 ${esc(c.name || "")}${handle}\n` +
    `📘 ${esc(order.courseTitle)} — ${esc(order.fieldLabel)}\n` +
    `💰 ${order.amount} ${order.currency}\n` +
    `Status: ${status}`
  );
}

async function handleDecision(cb, env, data) {
  const [prefix, orderId] = data.split(":");
  const approved = prefix === "ok";

  if (!isAdmin(env, cb.from.id)) return answer(env, cb.id, "Not authorized", true);

  const order = await getJSON(env, `order:${orderId}`);
  if (!order) return answer(env, cb.id, "Order not found", true);
  if (order.status !== "pending_review") return answer(env, cb.id, `Already ${order.status}`, true);

  order.status = approved ? "approved" : "rejected";
  order.reviewedBy = cb.from.first_name;
  order.reviewedAt = Date.now();
  await putJSON(env, `order:${order.id}`, order);

  const cat = await getCatalog(env);
  const course = findCourse(cat, order.courseId);
  const field = course?.fields[order.field];

  if (approved) {
    if (field) await deliver(env, order.chatId, order, course, field);
    else await send(env, order.chatId, "⚠️ There was a delivery issue. Our team will contact you shortly.");
  } else {
    await send(env, order.chatId,
      `❌ We could not verify payment for order <b>#${order.id}</b>.\nPlease contact support with your receipt.`);
  }

  const label = approved
    ? `✅ Approved by ${esc(cb.from.first_name)}`
    : `❌ Rejected by ${esc(cb.from.first_name)}`;

  for (const m of order.adminMessages) {
    await tg(env, "editMessageCaption", {
      chat_id: m.chatId,
      message_id: m.messageId,
      caption: adminCaption(order, label),
      parse_mode: "HTML",
    });
  }
  return answer(env, cb.id, approved ? "Approved ✅" : "Rejected ❌");
}

// Delivery order: 1) private group invite (+ topic link), 2) uploaded file, 3) text
async function deliver(env, chatId, order, course, field) {
  await send(env, chatId, `🎉 <b>Payment verified!</b> Order <b>#${order.id}</b>. Thank you.`);

  if (field.groupId) {
    const link = await tg(env, "createChatInviteLink", {
      chat_id: field.groupId,
      name: `order-${order.id}`.slice(0, 32),
      member_limit: 1,
      expire_date: Math.floor(Date.now() / 1000) + INVITE_EXPIRY_DAYS * 24 * 3600,
    });

    if (link.ok) {
      const topicLine = field.topicId
        ? `\n\n🧵 <b>Your subject topic</b> (open it after you join):\n${topicLink(field)}`
        : "";
      return send(env, chatId,
        `📦 <b>${esc(course.title)} — ${esc(field.label)}</b>\n\n` +
        `1️⃣ Join your private group with this link. It works once and expires in ${INVITE_EXPIRY_DAYS} days:\n` +
        `${link.result.invite_link}\n\n` +
        `2️⃣ Do not share this link.${topicLine}`);
    }

    console.error("Invite link failed:", link.description);
    await send(env, chatId, "⚠️ We couldn't create your group link right now. Our team will send it shortly.");
  }

  if (field.deliveryFileId) {
    return tg(env, "sendDocument", {
      chat_id: chatId,
      document: field.deliveryFileId,
      caption: `${course.title} — ${field.label}`,
    });
  }

  if (field.deliveryText) {
    return send(env, chatId, `📦 <b>${esc(course.title)} — ${esc(field.label)}</b>\n\n${esc(field.deliveryText)}`);
  }

  return send(env, chatId, "📦 Your access is being prepared. Our team will contact you shortly.");
}

// ============================= ADMIN PANEL =============================

async function adminMenu(env, chatId, msgId) {
  return render(env, chatId, msgId,
    "🛠 <b>Admin panel</b>\n\nEverything customers see can be edited here. Changes go live immediately.",
    kb([
      [{ text: "📚 Courses", callback_data: "a:courses" }],
      [{ text: "💳 Payment details", callback_data: "a:payment" }],
      [{ text: "📝 Welcome & help text", callback_data: "a:texts" }],
      [{ text: "🔓 Logout", callback_data: "a:logout" }],
    ]));
}

async function adminCourses(env, chatId, msgId, cat) {
  const rows = cat.courses.map((c) => [{ text: `📘 ${c.title}`, callback_data: `a:course:${c.id}` }]);
  rows.push([{ text: "➕ Add course", callback_data: "a:addcourse" }]);
  rows.push([{ text: "⬅️ Back", callback_data: "a:menu" }]);
  return render(env, chatId, msgId, "<b>Courses</b>\nSelect one to edit:", kb(rows));
}

async function adminCourse(env, chatId, msgId, cat, id) {
  const c = findCourse(cat, id);
  if (!c) return send(env, chatId, "Course not found.");
  const text =
    `📘 <b>${esc(c.title)}</b>\n\n` +
    `<b>Description:</b> ${esc(c.description)}\n` +
    `<b>Sample text:</b> ${esc(c.sample.text)}\n` +
    `<b>Sample file:</b> ${c.sample.fileId ? "✅ set" : "❌ not set"}\n` +
    `<b>Fields:</b> ${Object.keys(c.fields).length}`;
  return render(env, chatId, msgId, text, kb([
    [
      { text: "✏️ Title", callback_data: `a:ec:${id}:title` },
      { text: "📝 Description", callback_data: `a:ec:${id}:description` },
    ],
    [
      { text: "👀 Sample text", callback_data: `a:ec:${id}:sampleText` },
      { text: "📎 Sample file", callback_data: `a:sf:${id}` },
    ],
    [{ text: "🧩 Fields & prices", callback_data: `a:fields:${id}` }],
    [{ text: "🗑 Delete course", callback_data: `a:cdel:${id}` }],
    [{ text: "⬅️ Courses", callback_data: "a:courses" }],
  ]));
}

async function adminConfirmDelete(env, chatId, msgId, cat, id) {
  const c = findCourse(cat, id);
  if (!c) return send(env, chatId, "Course not found.");
  return render(env, chatId, msgId,
    `⚠️ Delete <b>${esc(c.title)}</b>? Existing orders are kept, but customers can no longer buy it.`,
    kb([
      [{ text: "⚠️ Yes, delete", callback_data: `a:cdelok:${id}` }],
      [{ text: "⬅️ Cancel", callback_data: `a:course:${id}` }],
    ]));
}

async function adminFields(env, chatId, msgId, cat, id) {
  const c = findCourse(cat, id);
  if (!c) return send(env, chatId, "Course not found.");
  const rows = Object.entries(c.fields).map(([k, f]) => [{
    text: `${f.label} — ${f.price} ${cat.currency}`,
    callback_data: `a:field:${id}:${k}`,
  }]);
  rows.push([{ text: "➕ Add field", callback_data: `a:addfield:${id}` }]);
  rows.push([{ text: "⬅️ Back", callback_data: `a:course:${id}` }]);
  return render(env, chatId, msgId, `🧩 <b>${esc(c.title)}</b> — fields & prices`, kb(rows));
}

async function adminField(env, chatId, msgId, cat, id, fk) {
  const c = findCourse(cat, id);
  const f = c?.fields[fk];
  if (!f) return send(env, chatId, "Field not found.");
  const text =
    `🧩 <b>${esc(c.title)}</b> — <b>${esc(f.label)}</b>\n\n` +
    `💰 Price: ${f.price} ${cat.currency}\n` +
    `👥 Private group: ${f.groupId ? `✅ ${esc(f.groupId)}` : "❌ not set"}\n` +
    `🧵 Topic ID: ${f.topicId ? `✅ ${esc(f.topicId)}` : "❌ not set"}\n` +
    `📎 Delivery file: ${f.deliveryFileId ? "✅ set" : "❌ not set"}\n` +
    `📝 Delivery text: ${esc(f.deliveryText) || "—"}`;
  return render(env, chatId, msgId, text, kb([
    [
      { text: "✏️ Name", callback_data: `a:ef:${id}:${fk}:label` },
      { text: "💰 Price", callback_data: `a:ef:${id}:${fk}:price` },
    ],
    [
      { text: "👥 Group ID", callback_data: `a:ef:${id}:${fk}:groupId` },
      { text: "🧵 Topic ID", callback_data: `a:ef:${id}:${fk}:topicId` },
    ],
    [
      { text: "📝 Delivery text", callback_data: `a:ef:${id}:${fk}:deliveryText` },
      { text: "📎 Delivery file", callback_data: `a:df:${id}:${fk}` },
    ],
    [{ text: "🗑 Delete field", callback_data: `a:fdel:${id}:${fk}` }],
    [{ text: "⬅️ Back", callback_data: `a:fields:${id}` }],
  ]));
}

async function adminPayment(env, chatId, msgId, cat) {
  return render(env, chatId, msgId,
    `💳 <b>Payment details</b>\n\n🏦 Bank: ${esc(cat.payment.bank)}\n📱 Telebirr: ${esc(cat.payment.telebirr)}`,
    kb([
      [{ text: "✏️ Edit bank", callback_data: "a:ep:bank" }],
      [{ text: "✏️ Edit Telebirr", callback_data: "a:ep:telebirr" }],
      [{ text: "⬅️ Back", callback_data: "a:menu" }],
    ]));
}

async function adminTexts(env, chatId, msgId) {
  return render(env, chatId, msgId,
    "📝 <b>Welcome & help text</b>\n\nChoose which message to edit. HTML is allowed: &lt;b&gt;, &lt;i&gt;, &lt;code&gt;.",
    kb([
      [{ text: "✏️ Welcome message", callback_data: "a:et:welcome" }],
      [{ text: "✏️ Help message", callback_data: "a:et:help" }],
      [{ text: "⬅️ Back", callback_data: "a:menu" }],
    ]));
}

// ------------------------ ADMIN LOGIN (password) -------------------------

async function adminEntry(env, chatId, uid) {
  if (await hasSession(env, uid)) {
    await clearState(env, uid);
    return adminMenu(env, chatId);
  }
  await setState(env, uid, { action: "login" });
  return send(env, chatId, "🔐 Enter the admin password.");
}

async function adminLogin(env, msg) {
  const chatId = msg.chat.id;
  const uid = msg.from.id;
  const text = (msg.text || "").trim();

  await deleteMsg(env, chatId, msg.message_id);

  const lock = await getJSON(env, `alock:${uid}`);
  if (lock && lock.until > Date.now()) {
    return send(env, chatId, "⛔ Too many failed attempts. Try again in a few minutes.");
  }

  const expected = env.ADMIN_PASSWORD ?? "88";
  if (text === expected) {
    await putJSON(env, `asess:${uid}`, { exp: Date.now() + SESSION_HOURS * 3600e3 }, SESSION_HOURS * 3600);
    await delKey(env, `alock:${uid}`);
    await clearState(env, uid);
    await send(env, chatId, "✅ Logged in.");
    return adminMenu(env, chatId);
  }

  const count = (lock?.count || 0) + 1;
  if (count >= MAX_FAILED_LOGINS) {
    await putJSON(env, `alock:${uid}`, { count, until: Date.now() + LOCK_MINUTES * 60e3 }, LOCK_MINUTES * 60);
    return send(env, chatId, `⛔ Too many wrong attempts. Locked for ${LOCK_MINUTES} minutes.`);
  }
  await putJSON(env, `alock:${uid}`, { count, until: 0 }, 3600);
  return send(env, chatId, `❌ Wrong password. ${MAX_FAILED_LOGINS - count} attempts left.`);
}

// --------------------- ADMIN CALLBACKS (edit actions) --------------------

async function onAdminCallback(cb, env, data) {
  const uid = cb.from.id;
  const chatId = cb.message.chat.id;
  const msgId = cb.message.message_id;
  const [, action, a, b, c] = data.split(":");
  await answer(env, cb.id);
  const cat = await getCatalog(env);

  switch (action) {
    case "menu":     return adminMenu(env, chatId, msgId);
    case "courses":  return adminCourses(env, chatId, msgId, cat);
    case "course":   return adminCourse(env, chatId, msgId, cat, a);

    case "addcourse":
      return ask(env, chatId, uid, { action: "add_course" }, "Send the <b>course title</b>.");
    case "ec":
      return ask(env, chatId, uid,
        { action: "edit_course", courseId: a, key: b },
        `Send the new ${LABELS[b]}.`);
    case "sf":
      return ask(env, chatId, uid,
        { action: "set_sample_file", courseId: a },
        "Send the <b>sample</b> as a photo or document.");
    case "cdel":
      return adminConfirmDelete(env, chatId, msgId, cat, a);
    case "cdelok": {
      cat.courses = cat.courses.filter((x) => x.id !== a);
      await saveCatalog(env, cat);
      return adminCourses(env, chatId, msgId, cat);
    }

    case "fields":   return adminFields(env, chatId, msgId, cat, a);
    case "field":    return adminField(env, chatId, msgId, cat, a, b);
    case "addfield":
      return ask(env, chatId, uid,
        { action: "add_field", courseId: a },
        "Send the field as <code>Label|Price</code>, for example <code>Natural|350</code>.");
    case "ef":
      return ask(env, chatId, uid,
        { action: "edit_field", courseId: a, fieldKey: b, key: c },
        `Send the new ${LABELS[c]}.`);
    case "df":
      return ask(env, chatId, uid,
        { action: "set_delivery_file", courseId: a, fieldKey: b },
        "Send the <b>full file</b> customers will receive (PDF or document).");
    case "fdel": {
      const course = findCourse(cat, a);
      if (course) delete course.fields[b];
      await saveCatalog(env, cat);
      return adminFields(env, chatId, msgId, cat, a);
    }

    case "payment":  return adminPayment(env, chatId, msgId, cat);
    case "ep":
      return ask(env, chatId, uid, { action: "edit_payment", key: a },
        `Send the new ${LABELS[a]}.`);
    case "texts":    return adminTexts(env, chatId, msgId);
    case "et":
      return ask(env, chatId, uid, { action: "edit_text", key: a },
        `Send the new ${LABELS[a]}. HTML is allowed.`);

    case "logout":
      await delKey(env, `asess:${uid}`);
      await clearState(env, uid);
      return send(env, chatId, "🔓 Logged out. Send /admin to log in again.");

    case "cancel":
      await clearState(env, uid);
      return adminMenu(env, chatId, msgId);
  }
}

// ----------------------- ADMIN INPUT (text & files) ----------------------

async function handleAdminInput(msg, env, state) {
  const chatId = msg.chat.id;
  const uid = msg.from.id;
  const text = (msg.text || "").trim();
  const fileId = msg.photo ? msg.photo.at(-1).file_id : (msg.document?.file_id || "");
  const fileKind = msg.photo ? "photo" : "document";
  const cat = await getCatalog(env);

  const fileActions = ["set_sample_file", "set_delivery_file"];
  if (fileActions.includes(state.action)) {
    if (!fileId) return send(env, chatId, "Please send a file or photo, or /cancel.");
  } else if (!text) {
    return send(env, chatId, "Please send text, or /cancel.");
  }

  const course = state.courseId ? findCourse(cat, state.courseId) : null;
  let done;

  switch (state.action) {
    case "add_course": {
      const c = {
        id: newId(),
        title: text,
        description: "",
        sample: { type: "document", fileId: "", text: "" },
        fields: {},
      };
      cat.courses.push(c);
      done = () => adminCourse(env, chatId, null, cat, c.id);
      break;
    }

    case "edit_course": {
      if (!course) return send(env, chatId, "Course not found.");
      if (state.key === "sampleText") course.sample.text = text;
      else if (["title", "description"].includes(state.key)) course[state.key] = text;
      done = () => adminCourse(env, chatId, null, cat, course.id);
      break;
    }

    case "set_sample_file": {
      if (!course) return send(env, chatId, "Course not found.");
      course.sample.type = fileKind;
      course.sample.fileId = fileId;
      done = () => adminCourse(env, chatId, null, cat, course.id);
      break;
    }

    case "add_field": {
      if (!course) return send(env, chatId, "Course not found.");
      const [label, priceRaw] = text.split("|").map((s) => s.trim());
      const price = Number(priceRaw);
      if (!label || !Number.isFinite(price) || price <= 0) {
        return send(env, chatId, "Format: <code>Label|Price</code>, for example <code>Natural|350</code>.");
      }
      let key = slug(label);
      if (course.fields[key]) key = `${key}-${newId().slice(0, 3)}`;
      course.fields[key] = { label, price, groupId: "", topicId: "", deliveryFileId: "", deliveryText: "" };
      done = () => adminFields(env, chatId, null, cat, course.id);
      break;
    }

    case "edit_field": {
      const field = course?.fields[state.fieldKey];
      if (!field) return send(env, chatId, "Field not found.");

      if (state.key === "price") {
        const p = Number(text);
        if (!Number.isFinite(p) || p <= 0) return send(env, chatId, "Price must be a positive number.");
        field.price = p;
      } else if (state.key === "label") {
        field.label = text;
      } else if (state.key === "deliveryText") {
        field.deliveryText = text;
      } else if (state.key === "groupId") {
        if (!/^-100\d+$/.test(text)) {
          return send(env, chatId, "The group ID must start with -100 and contain only numbers. Try again or /cancel.");
        }
        field.groupId = text;
      } else if (state.key === "topicId") {
        if (text === "0") field.topicId = "";
        else if (/^\d+$/.test(text)) field.topicId = text;
        else return send(env, chatId, "Topic ID must be a number, or 0 to clear. Try again or /cancel.");
      }

      done = () => adminField(env, chatId, null, cat, course.id, state.fieldKey);
      break;
    }

    case "set_delivery_file": {
      const field = course?.fields[state.fieldKey];
      if (!field) return send(env, chatId, "Field not found.");
      field.deliveryFileId = fileId;
      done = () => adminField(env, chatId, null, cat, course.id, state.fieldKey);
      break;
    }

    case "edit_payment": {
      cat.payment[state.key] = text;
      done = () => adminPayment(env, chatId, null, cat);
      break;
    }

    case "edit_text": {
      cat.texts[state.key] = text;
      done = () => adminTexts(env, chatId, null);
      break;
    }

    default:
      await clearState(env, uid);
      return;
  }

  await saveCatalog(env, cat);
  await clearState(env, uid);
  await send(env, chatId, "✅ Saved. Changes are live now.");
  return done();
}

// ============================ ROUTING ==================================

async function onMessage(msg, env) {
  const chatId = msg.chat.id;
  const uid = msg.from?.id;
  const text = (msg.text || "").trim();
  const cmd = text.split(/\s+/)[0].toLowerCase();

  if (cmd === "/start") return showMain(env, chatId);
  if (cmd === "/help") return showHelp(env, chatId);

  if (isAdmin(env, uid)) {
    if (cmd === "/admin") return adminEntry(env, chatId, uid);
    if (cmd === "/cancel") {
      await clearState(env, uid);
      return send(env, chatId, "Cancelled.");
    }
    if (cmd === "/fileid") {
      const r = msg.reply_to_message;
      const fid = r?.photo?.at(-1)?.file_id || r?.document?.file_id;
      return send(env, chatId, fid
        ? `<code>${fid}</code>`
        : "Reply to a photo or document with /fileid to get its file_id.");
    }

    const state = await getState(env, uid);
    if (state) {
      if (state.action === "login") return adminLogin(env, msg);
      if (await hasSession(env, uid)) return handleAdminInput(msg, env, state);
      return send(env, chatId, "Session expired. Send /admin to log in.");
    }
  }

  if (msg.photo || msg.document) return handleProof(msg, env);
  return showMain(env, chatId);
}

async function onCallback(cb, env) {
  const data = cb.data || "";
  const chatId = cb.message?.chat?.id;
  const msgId = cb.message?.message_id;

  // Admin panel
  if (data.startsWith("a:")) {
    if (!isAdmin(env, cb.from.id)) return answer(env, cb.id, "Not authorized", true);
    if (!(await hasSession(env, cb.from.id))) return answer(env, cb.id, "Session expired. Send /admin", true);
    return onAdminCallback(cb, env, data);
  }

  // Admin approve / reject
  if (data.startsWith("ok:") || data.startsWith("no:")) return handleDecision(cb, env, data);

  // Customer
  await answer(env, cb.id);
  if (!chatId) return;

  const cat = await getCatalog(env);
  const [action, a, b] = data.split(":");
  const course = findCourse(cat, a);

  switch (action) {
    case "menu":    return showMain(env, chatId, msgId);
    case "help":    return showHelp(env, chatId, msgId);
    case "courses": return showCourses(env, chatId, msgId, cat);
    case "course":  return course && showCourse(env, chatId, msgId, cat, course);
    case "buy":     return course && showFields(env, chatId, msgId, cat, course);
    case "sample":  return course && sendSample(env, chatId, course);
    case "field":   return course && startOrder(env, chatId, msgId, cat, course, b);
  }
}
