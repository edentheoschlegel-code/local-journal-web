/* Local Journal — a private journal that stays on your device.
 *
 * Entries live in this browser's IndexedDB, under keys namespaced "localjournal".
 * There is no server, no account, and no network call anywhere in this file —
 * the only fetch() is the service worker caching the app's own files.
 *
 * SECURITY: every dynamic string — entry text, titles, tags, file names, error
 * text — is written with textContent, never interpolated into innerHTML. The
 * el() helper's `html` parameter takes only constant, developer-authored markup
 * (icons, static labels); anything user-derived goes through txt() or
 * textContent. Hold this line.
 */
"use strict";

/* ── Platform ────────────────────────────────────────────────────────────
   True only inside the Capacitor iOS/Android shell; false in every browser,
   including a browser opened at localhost. Two things differ on native and
   nothing else does:

     1. Exports. A plain <a download> anchor does nothing inside a WKWebView —
        there is no browser downloads UI for it to reach. LocalResume shipped
        that bug; the fix is to write the bytes and hand the file to the
        system share sheet (see shareBytes below).
     2. Copy. Sentences that say "this browser", "your downloads" or "clear
        this site's data" are true on the web and false in an app. nat() swaps
        them for the on-device truth.

   Every native branch is written as `IS_NATIVE ? native : <the exact existing
   web string/behaviour>`, so the web build runs the same code and shows the
   same words it did before this file was wrapped. */
const IS_NATIVE = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
// Picks the platform's wording. On the web this returns the original string
// unchanged — that is the whole contract.
const nat = (web, native) => (IS_NATIVE ? native : web);

/* ── Storage keys ────────────────────────────────────────────────────────
   Every key is prefixed "localjournal." so two Eden Apps siblings open in the
   same browser can never collide. */

// The IndexedDB database holding entries and the lock configuration.
const DB_NAME = "localjournal";
const DB_VERSION = 1;
const STORE_ENTRIES = "entries";
const STORE_META = "meta";

// Theme preference. Read by theme-boot.js before first paint, written here.
const THEME_KEY = "localjournal.theme";
// When the last backup was taken. Device-local by intent: it describes THIS
// machine, so it lives outside the entry data and an imported backup can never
// overwrite it.
const LAST_BACKUP_KEY = "localjournal.last_backup";
// Transient set/remove probe — a private window accepts writes it will not keep.
const STORAGE_PROBE_KEY = "localjournal.storage_probe";
// Synchronous crash-safety mirror of the entry being edited. Written on
// pagehide, where an IndexedDB write may not finish but a localStorage write
// will. Only used while the passcode lock is OFF — see the note in
// mirrorDraft(): with the lock on, writing plaintext here would defeat it.
const DRAFT_MIRROR_KEY = "localjournal.draft_mirror";

// Stamped into every backup so a sibling app's export cannot be imported here,
// and this app's export cannot be imported there.
const VAULT_APP_ID = "localjournal";
const BACKUP_FORMAT = 1;

// PBKDF2 work factor for the optional passcode. Written into the lock record so
// a future change can raise it without stranding journals encrypted at the old
// value.
const KDF_ITERATIONS = 310000;
const VERIFIER_PLAINTEXT = "localjournal.unlock.v1";

// How many rows the list renders before the "Show more" button. Keeps a
// several-thousand-entry journal responsive: filtering is a linear scan over
// cached lowercase strings, but building thousands of DOM rows is not free.
const PAGE_SIZE = 60;

/* ── DOM helpers ─────────────────────────────────────────────────────────
   el()'s `html` argument is for constant, developer-authored markup only
   (icons, static labels). Anything user- or file-derived goes through txt(). */
const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
};
const txt = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
// Decorative icon. `paths` is constant developer-authored path data — never a
// user- or file-derived string.
function svgIcon(paths, cls) {
  const n = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  n.setAttribute("viewBox", "0 0 24 24");
  n.setAttribute("fill", "none");
  n.setAttribute("stroke", "currentColor");
  n.setAttribute("stroke-width", "2");
  n.setAttribute("stroke-linecap", "round");
  n.setAttribute("stroke-linejoin", "round");
  n.setAttribute("aria-hidden", "true");
  if (cls) n.setAttribute("class", cls);
  n.innerHTML = paths;
  return n;
}

/* ── Screen-reader announcements ─────────────────────────────────────── */
function announce(message, assertive) {
  const region = $(assertive ? "#srAssertive" : "#srPolite");
  if (!region) return;
  region.textContent = "";
  // Re-setting the same string does not re-announce; the empty tick forces it.
  window.setTimeout(() => { region.textContent = String(message || ""); }, 30);
}

/* ── Error copy ──────────────────────────────────────────────────────────
   Raw library/DOM messages can carry user text and internals. Throw sentinel
   codes inside, map to a plain sentence at the edge. */
function friendly(e) {
  const name = (e && e.name) || "";
  const m = (e && e.message) || String(e || "");
  if (name === "QuotaExceededError" || /quota/i.test(m)) {
    return "This device is out of space for the journal, so that entry wasn't saved. Free some space, or export a backup and remove older entries, then try again.";
  }
  if (m === "BAD_PASSCODE") return "That passcode didn't match. There's no reset. The entries can only be opened with the passcode that locked them.";
  if (m === "NO_CRYPTO") return nat(
    "This browser doesn't offer the encryption this needs. The passcode lock needs a secure page (https, or localhost).",
    "This device isn't offering the encryption the passcode lock needs, so the lock can't be turned on here.");
  if (m === "NOT_JSON") return "Couldn't read that file as a backup. It isn't valid JSON.";
  if (m === "WRONG_APP") return "That backup was made by a different app, so it can't be imported here.";
  if (m === "NO_ENTRIES") return "That file is a valid backup but has no entries in it.";
  if (m === "READ_FAILED") return "Couldn't read that file from your device.";
  if (m === "NO_DB") return nat(
    "This browser isn't letting the app store data, so entries will only last until you close the tab.",
    "The app isn't able to store data on this device, so entries will only last until you close it.");
  if (m === "PDFLIB_FAILED") return "Couldn't load the PDF engine. Reload the page and try the export again.";
  if (/cannot encode/i.test(m) || /WinAnsi/i.test(m)) {
    return "The PDF fonts can't draw some of the characters in your entries. Your entries are unharmed. The Markdown or JSON export keeps every character.";
  }
  if (m === "LOCKED_NO_KEY") {
    return "The passcode lock is on but this page doesn't have it open, so nothing was written. Reload and enter your passcode. Anything still in the editor is safe to copy out first.";
  }
  if (m === "LOCK_UNKNOWN") {
    return "Couldn't check whether the passcode lock is on, so nothing was written rather than risk saving unprotected. Reload to try again. Your text stays in the editor meanwhile.";
  }
  return "Couldn't finish that. The data may be corrupt or in an unexpected format.";
}

/* ── Formatting ──────────────────────────────────────────────────────── */
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];
const DOW_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function pad2(n) { return String(n).padStart(2, "0"); }

// Local calendar date, deliberately not toISOString() — that returns UTC and
// would roll the date over for anyone east or west of Greenwich late in the day.
function todayISO(d) {
  const t = d || new Date();
  return `${t.getFullYear()}-${pad2(t.getMonth() + 1)}-${pad2(t.getDate())}`;
}
function parseISODate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ""));
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const dt = new Date(y, mo - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
  return dt;
}
function isValidISODate(s) { return parseISODate(s) !== null; }
function fmtLongDate(iso) {
  const d = parseISODate(iso);
  if (!d) return iso || "";
  return `${DOW_SHORT[d.getDay()]}, ${d.getDate()} ${MONTH_NAMES[d.getMonth()]} ${d.getFullYear()}`;
}
function fmtShortDate(iso) {
  const d = parseISODate(iso);
  if (!d) return iso || "";
  return `${d.getDate()} ${MONTH_NAMES[d.getMonth()].slice(0, 3)}`;
}
function monthKey(iso) { return String(iso || "").slice(0, 7); }
function fmtMonth(key) {
  const m = /^(\d{4})-(\d{2})$/.exec(key || "");
  if (!m) return key || "";
  return `${MONTH_NAMES[+m[2] - 1]} ${m[1]}`;
}
function countWords(s) {
  const t = String(s || "").trim();
  if (!t) return 0;
  return t.split(/\s+/).length;
}
function plural(n, one, many) { return `${n} ${n === 1 ? one : many}`; }
function fmtBytes(n) {
  if (!(n > 0)) return "0 KB";
  const KB = 1024, MB = KB * 1024, GB = MB * 1024, TB = GB * 1024;
  if (n < MB) return `${Math.max(1, Math.round(n / KB))} KB`;
  if (n < GB) return `${(n / MB).toFixed(1)} MB`;
  // A browser storage quota is measured in gigabytes or terabytes; without
  // these tiers it printed as a seven-digit megabyte figure.
  if (n < TB) return `${(n / GB).toFixed(1)} GB`;
  return `${(n / TB).toFixed(1)} TB`;
}

/* ── Moods ───────────────────────────────────────────────────────────────
   Five fixed markers, deliberately descriptive rather than graded — none of
   them is a "good" or "bad" score. Each carries its own glyph so the marker
   never depends on colour alone.

   The order here is the render order for the chip row and the Mood filter, and
   it has to stay monotonic against the saturation ramp the tokens encode
   (styles.css: low → bright, ascending saturation). Reversed, that is
   bright → low; warm before bright darkened at position two and lightened
   from there. */
const MOODS = [
  /* Order is Eden's call (2026-08-07): Warm leads. A review pass once reordered
     these to make the chip saturation ramp monotonic — that is an aesthetic
     preference and it does not outrank her instruction. Do not "fix" it again. */
  { id: "warm", label: "Warm", cls: "mood-warm", glyph: '<circle cx="12" cy="12" r="4"/><path d="M12 4v2M12 18v2M4 12h2M18 12h2"/>' },
  { id: "bright", label: "Bright", cls: "mood-bright", glyph: '<circle cx="12" cy="12" r="3.5"/><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M5 5l1.8 1.8M17.2 17.2 19 19M19 5l-1.8 1.8M6.8 17.2 5 19"/>' },
  { id: "steady", label: "Steady", cls: "mood-steady", glyph: '<path d="M4 9h16"/><path d="M4 15h16"/>' },
  { id: "quiet", label: "Quiet", cls: "mood-quiet", glyph: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>' },
  { id: "low", label: "Low", cls: "mood-low", glyph: '<path d="M12 5v14"/><path d="m5 12 7 7 7-7"/>' }
];
const MOOD_BY_ID = {};
MOODS.forEach((m) => { MOOD_BY_ID[m.id] = m; });
function moodOf(id) { return MOOD_BY_ID[id] || null; }

/* ── Entry shape + sanitizing ────────────────────────────────────────────
   Anything arriving from storage or a backup file is coerced field by field.
   A corrupt record must produce a valid entry or be dropped — never a crash. */
function newId() {
  try {
    const a = new Uint8Array(9);
    crypto.getRandomValues(a);
    return Array.from(a).map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch (e) {
    return `${Date.now().toString(16)}${Math.random().toString(16).slice(2, 10)}`;
  }
}
function blankEntry(dateISO) {
  const now = Date.now();
  return {
    id: newId(),
    date: dateISO || todayISO(),
    title: "",
    body: "",
    mood: null,
    tags: [],
    createdAt: now,
    updatedAt: now
  };
}
function cleanTag(t) {
  return String(t == null ? "" : t).trim().replace(/\s+/g, " ").slice(0, 32).toLowerCase();
}
function sanitizeEntry(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = typeof raw.id === "string" && raw.id.length >= 4 && raw.id.length <= 64 ? raw.id : newId();
  const date = isValidISODate(raw.date) ? raw.date : todayISO();
  const title = String(raw.title == null ? "" : raw.title).slice(0, 300);
  const body = String(raw.body == null ? "" : raw.body).slice(0, 500000);
  const mood = moodOf(raw.mood) ? raw.mood : null;
  const seen = Object.create(null);
  const tags = [];
  if (Array.isArray(raw.tags)) {
    for (const t of raw.tags) {
      const c = cleanTag(t);
      if (c && !seen[c] && tags.length < 12) { seen[c] = 1; tags.push(c); }
    }
  }
  const num = (v, fb) => (typeof v === "number" && isFinite(v) && v > 0 ? v : fb);
  const createdAt = num(raw.createdAt, Date.now());
  return { id, date, title, body, mood, tags, createdAt, updatedAt: num(raw.updatedAt, createdAt) };
}
function isEmptyEntry(e) {
  return !e.title.trim() && !e.body.trim() && !e.mood && e.tags.length === 0;
}
// Cached lowercase haystack — rebuilt whenever an entry is saved. This is what
// keeps search over a few thousand entries a fast linear scan.
function hayOf(e) {
  if (e._hay == null) {
    e._hay = `${e.title}\n${e.body}\n${e.tags.join(" ")}`.toLowerCase();
  }
  return e._hay;
}

/* ── State ───────────────────────────────────────────────────────────── */
let entries = [];            // in memory, always sorted newest first
let db = null;               // IDBDatabase, or null when storage is unavailable
let storageBlocked = false;  // true once we know writes will not persist
let lockConfig = null;       // { enabled, salt, iterations, verifier } or null
let sessionKey = null;       // CryptoKey, in memory only, never persisted
let locked = false;          // true when the journal is encrypted and not open
let lockStateUnknown = false; // true when the lock record could not be read at all
let lastSaveError = null;

function sortEntries() {
  entries.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.createdAt - a.createdAt));
}
function findEntry(id) { return entries.find((e) => e.id === id) || null; }

/* ── IndexedDB ───────────────────────────────────────────────────────── */
function openDb() {
  return new Promise((resolve, reject) => {
    let req;
    try { req = indexedDB.open(DB_NAME, DB_VERSION); }
    catch (e) { reject(new Error("NO_DB")); return; }
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains(STORE_ENTRIES)) d.createObjectStore(STORE_ENTRIES, { keyPath: "id" });
      if (!d.objectStoreNames.contains(STORE_META)) d.createObjectStore(STORE_META, { keyPath: "key" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("NO_DB"));
    req.onblocked = () => reject(new Error("NO_DB"));
  });
}
// Runs fn(tx) and resolves when the whole transaction commits, so a caller
// awaiting it knows the data is durable — not merely queued.
function idbRun(stores, mode, fn) {
  return new Promise((resolve, reject) => {
    if (!db) { reject(new Error("NO_DB")); return; }
    let tx;
    try { tx = db.transaction(stores, mode); }
    catch (e) { reject(e); return; }
    let result;
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error || new Error("TX_FAILED"));
    tx.onabort = () => reject(tx.error || new Error("TX_ABORTED"));
    try { result = fn(tx); } catch (e) { try { tx.abort(); } catch (e2) {} reject(e); }
  });
}
function idbGetAll(store) {
  return new Promise((resolve, reject) => {
    if (!db) { reject(new Error("NO_DB")); return; }
    try {
      const tx = db.transaction([store], "readonly");
      const req = tx.objectStore(store).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error || new Error("TX_FAILED"));
    } catch (e) { reject(e); }
  });
}
function idbGet(store, key) {
  return new Promise((resolve, reject) => {
    if (!db) { reject(new Error("NO_DB")); return; }
    try {
      const tx = db.transaction([store], "readonly");
      const req = tx.objectStore(store).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error || new Error("TX_FAILED"));
    } catch (e) { reject(e); }
  });
}

// A private window accepts localStorage writes it will not keep. One gentle
// heads-up beats silently losing the theme preference and the draft mirror.
function storageProbeOk() {
  try {
    localStorage.setItem(STORAGE_PROBE_KEY, "1");
    localStorage.removeItem(STORAGE_PROBE_KEY);
    return true;
  } catch (e) { return false; }
}

/* ── Crypto (optional passcode lock) ─────────────────────────────────────
   PBKDF2-HMAC-SHA256 over the passcode with a per-journal random salt, into an
   AES-GCM-256 key. The key exists only in memory for the session; nothing
   derived from the passcode is ever written to disk except the salt, the
   iteration count, and a verifier blob. There is no recovery path, by design:
   with no server there is nobody to reset anything. */
function subtle() {
  if (!window.crypto || !window.crypto.subtle) throw new Error("NO_CRYPTO");
  return window.crypto.subtle;
}
async function deriveKey(passcode, salt, iterations) {
  const base = await subtle().importKey(
    "raw", new TextEncoder().encode(String(passcode)), "PBKDF2", false, ["deriveKey"]);
  return subtle().deriveKey(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}
async function encryptBytes(key, bytes) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle().encrypt({ name: "AES-GCM", iv }, key, bytes);
  return { iv, ct };
}
async function decryptBytes(key, iv, ct) {
  return new Uint8Array(await subtle().decrypt({ name: "AES-GCM", iv: new Uint8Array(iv) }, key, ct));
}
async function encryptJson(key, obj) {
  return encryptBytes(key, new TextEncoder().encode(JSON.stringify(obj)));
}
async function decryptJson(key, iv, ct) {
  return JSON.parse(new TextDecoder().decode(await decryptBytes(key, iv, ct)));
}

// Storage record ⇄ entry. With the lock on, only the record id stays in the
// clear (it is random and carries no content); date, title, body, mood and tags
// are all inside the ciphertext.
// opts.plain is the one deliberate way to produce an unencrypted record: it is
// used only by disableLock(), where writing the plain form is the whole point.
async function toRecord(entry, opts) {
  const plain = {
    date: entry.date, title: entry.title, body: entry.body,
    mood: entry.mood, tags: entry.tags,
    createdAt: entry.createdAt, updatedAt: entry.updatedAt
  };
  if (opts && opts.plain) return Object.assign({ id: entry.id, enc: 0 }, plain);
  if (sessionKey) {
    const { iv, ct } = await encryptJson(sessionKey, plain);
    return { id: entry.id, enc: 1, iv, ct };
  }
  // No key in hand. Writing the plain form here would silently downgrade a
  // locked journal — which is reachable from an undo clicked after "Lock now",
  // from a tab that was open before the lock was turned on, and from a boot
  // where the lock record could not be read. Refuse instead.
  if (lockConfig) throw new Error("LOCKED_NO_KEY");
  if (lockStateUnknown) throw new Error("LOCK_UNKNOWN");
  return Object.assign({ id: entry.id, enc: 0 }, plain);
}
async function fromRecord(rec) {
  if (!rec || typeof rec !== "object") return null;
  if (rec.enc === 1) {
    if (!sessionKey) return null;
    try {
      const plain = await decryptJson(sessionKey, rec.iv, rec.ct);
      return sanitizeEntry(Object.assign({ id: rec.id }, plain));
    } catch (e) { return null; }
  }
  return sanitizeEntry(rec);
}

// Three states, not two. "Could not read the lock record" is not the same as
// "there is no lock": answering the first with the second would run the app
// unlocked and write plaintext into a journal the user had locked.
async function readLockRecord() {
  try {
    const rec = await idbGet(STORE_META, "lock");
    if (rec && rec.enabled && rec.salt && rec.verifier) return { state: "present", rec };
    return { state: "absent", rec: null };
  } catch (e) {
    return { state: "unknown", rec: null };
  }
}
async function loadLockConfig() {
  if (!db) { lockStateUnknown = false; return null; }
  const { state, rec } = await readLockRecord();
  lockStateUnknown = (state === "unknown");
  return state === "present" ? rec : null;
}

// Called before any write made without a session key. The cached lockConfig is
// read once at boot; another tab may have turned the lock on since.
async function refreshLockBeforeWrite() {
  if (sessionKey || !db) return;
  const { state, rec } = await readLockRecord();
  if (state === "present") {
    if (!lockConfig) lockConfig = rec;
    lockStateUnknown = false;
    clearDraftMirror();
  } else if (state === "unknown") {
    lockStateUnknown = true;
    clearDraftMirror();
  } else {
    lockStateUnknown = false;
  }
}

/* ── Persisting ──────────────────────────────────────────────────────────
   A pending debounced save is the only copy of the last few keystrokes, so
   every exit path flushes it: blur, pagehide, beforeunload, and the tab going
   hidden. */
let saveTimer = null;
let pendingEntry = null;
// "Saving…" appears only if a write is still outstanding after 600ms — a long
// entry being encrypted. A normal local write is single-digit milliseconds, and
// flashing "Saving…" on every keystroke invents doubt that is not there.
let savingLabelTimer = null;
let lastSaveAnnounce = 0;
let announcedSaveOnce = false;

function scheduleSave(entry) {
  pendingEntry = entry;
  mirrorDraft(entry);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { persistNow(); }, 400);
  if (!savingLabelTimer) {
    savingLabelTimer = setTimeout(() => {
      savingLabelTimer = null;
      if (!pendingEntry) return;
      const note = $("#saveNote");
      if (note) { note.textContent = "Saving…"; note.className = "savenote"; }
    }, 600);
  }
}
function clearSavingLabelTimer() {
  if (savingLabelTimer) { clearTimeout(savingLabelTimer); savingLabelTimer = null; }
}
function flushPendingSave() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  if (pendingEntry) persistNow();
}
function savedLabel(at) {
  const d = at ? new Date(at) : new Date();
  return `Saved ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
// First save of the session is announced; after that, at most once every two
// minutes. Failure is always announced, and assertively.
function announceSaved() {
  const now = Date.now();
  if (!announcedSaveOnce || now - lastSaveAnnounce > 120000) {
    announcedSaveOnce = true;
    lastSaveAnnounce = now;
    announce("Saved on this device.");
  }
}
async function persistNow() {
  const entry = pendingEntry;
  if (!entry) return;
  pendingEntry = null;
  clearTimeout(saveTimer); saveTimer = null;
  entry.updatedAt = Date.now();
  entry._hay = null;
  try {
    if (!db) throw new Error("NO_DB");
    await refreshLockBeforeWrite();
    const rec = await toRecord(entry);
    await idbRun([STORE_ENTRIES], "readwrite", (tx) => { tx.objectStore(STORE_ENTRIES).put(rec); });
    lastSaveError = null;
    clearDraftMirror();
    setSaveNote(true);
    hideBanner();
  } catch (e) {
    lastSaveError = e;
    setSaveNote(false);
    // Never silent: a save that did not happen gets a visible, persistent
    // banner, and the text stays in the editor so it can be copied out.
    showBanner(friendly(e), true);
  }
}
function setSaveNote(ok) {
  clearSavingLabelTimer();
  const note = $("#saveNote");
  if (!note) return;
  // The resting state carries the time and never disappears — feedback that
  // vanishes makes people doubt it happened. Never "All changes saved!", and
  // never a spinner: there is nothing to wait for.
  note.textContent = ok ? savedLabel() : "Couldn't save";
  note.className = ok ? "savenote" : "savenote err";
  if (ok) announceSaved();
}

// Synchronous crash-safety copy of the entry being edited. localStorage writes
// complete during pagehide where an IndexedDB write may not. Skipped entirely
// when the passcode lock is on: mirroring plaintext would undo the encryption.
function mirrorDraft(entry) {
  if (lockConfig || lockStateUnknown) return;
  // _hay is a lowercased duplicate of title + body + tags, built for searching.
  // Dropping it keeps the mirror from holding the text twice over.
  try {
    localStorage.setItem(DRAFT_MIRROR_KEY,
      JSON.stringify(entry, (k, v) => (k === "_hay" ? undefined : v)));
  } catch (e) { /* private browsing */ }
}
function clearDraftMirror() {
  try { localStorage.removeItem(DRAFT_MIRROR_KEY); } catch (e) {}
}
async function recoverDraftMirror() {
  if (lockConfig || lockStateUnknown) return;
  let raw = null;
  try { raw = localStorage.getItem(DRAFT_MIRROR_KEY); } catch (e) { return; }
  if (!raw) return;
  let candidate = null;
  try { candidate = sanitizeEntry(JSON.parse(raw)); } catch (e) { candidate = null; }
  clearDraftMirror();
  if (!candidate || isEmptyEntry(candidate)) return;
  const existing = findEntry(candidate.id);
  if (existing && existing.updatedAt >= candidate.updatedAt &&
      existing.body === candidate.body && existing.title === candidate.title) return;
  if (existing) Object.assign(existing, candidate, { _hay: null });
  else { entries.push(candidate); sortEntries(); }
  try {
    const rec = await toRecord(candidate);
    await idbRun([STORE_ENTRIES], "readwrite", (tx) => { tx.objectStore(STORE_ENTRIES).put(rec); });
    announce("Recovered the entry you were writing when the tab closed.");
  } catch (e) { /* surfaced by the next save attempt */ }
}

// The editor's auto-grow, held in one slot and re-pointed on each render (see
// renderWriteView) so the resize listener below is registered exactly once.
let activeComposerGrow = null;
window.addEventListener("resize", () => {
  if (activeComposerGrow && document.getElementById("entryBody")) activeComposerGrow();
});
// Coming back to a tab that grew while it was hidden: re-measure once, so the
// field is never shorter than the text it holds.
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && activeComposerGrow && document.getElementById("entryBody")) activeComposerGrow();
});

window.addEventListener("pagehide", flushPendingSave);
window.addEventListener("beforeunload", flushPendingSave);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") flushPendingSave();
});

/* ── Banner + toast ──────────────────────────────────────────────────── */
function showBanner(message, isProblem) {
  const bar = $("#topBanner");
  if (!bar) return;
  bar.textContent = "";
  bar.hidden = false;
  bar.appendChild(txt("span", null, message));
  bar.style.background = isProblem ? "var(--err-bg)" : "var(--amber-bg)";
  bar.style.color = isProblem ? "var(--err-ink)" : "var(--amber-ink)";
  bar.style.borderBottomColor = isProblem ? "var(--err-border)" : "var(--amber-border)";
  announce(message, !!isProblem);
}
function hideBanner() {
  const bar = $("#topBanner");
  if (bar) { bar.hidden = true; bar.textContent = ""; }
}

// Toasts stack rather than replace one another. Delete has no confirm dialog by
// design, so a toast holding an Undo is that entry's only way back: a second
// delete must not take the first one's Undo off the screen.
const MAX_TOASTS = 4;
// The exit animation runs on top of a state that is already committed: the
// node is scheduled for removal here and a setTimeout is the safety net,
// because transitionend can be skipped when an element is hidden or scrolled
// out. An exit that stops at opacity: 0 would leave an invisible, focusable,
// screen-readable element in the tab order.
function dismissToast(toast) {
  if (!toast) return;
  if (toast._timer) { clearTimeout(toast._timer); toast._timer = null; }
  if (toast._leaving) return;
  toast._leaving = true;
  toast.classList.remove("is-shown");
  toast.classList.add("is-leaving");
  const done = () => { if (toast.parentNode) toast.remove(); };
  toast.addEventListener("transitionend", done, { once: true });
  setTimeout(done, 400);
}
function dismissAllToasts() {
  const host = $("#toastHost");
  if (!host) return;
  Array.from(host.children).forEach((t) => { if (t._timer) clearTimeout(t._timer); });
  host.textContent = "";
}
function showToast(message, actionLabel, onAction, ms) {
  const host = $("#toastHost");
  if (!host) return;
  const toast = el("div", "toast");
  toast.appendChild(txt("span", null, message));
  if (actionLabel && onAction) {
    const b = txt("button", null, actionLabel);
    b.type = "button";
    b.onclick = () => { dismissToast(toast); onAction(); };
    toast.appendChild(b);
  }
  host.appendChild(toast);
  // Two frames: the first commits the pre-transition state, the second flips it,
  // so the entrance actually animates instead of being coalesced away. In a
  // hidden tab rAF does not run, so the state is committed straight away — a
  // toast must never be stuck at opacity 0 waiting for a frame that is not
  // coming.
  if (document.hidden) toast.classList.add("is-shown");
  else requestAnimationFrame(() => requestAnimationFrame(() => toast.classList.add("is-shown")));
  while (host.children.length > MAX_TOASTS) dismissToast(host.firstElementChild);
  toast._timer = setTimeout(() => { dismissToast(toast); }, ms || 8000);
  announce(message);
  return toast;
}

/* ── Modal with a focus trap ─────────────────────────────────────────────
   Focuses immediately and again on the next frame (rAF is throttled in a
   backgrounded tab), traps Tab, restores the previously focused element, and
   tears itself down when the backdrop leaves the DOM by any close path. */
function makeModalAccessible(backdrop, modal, opts) {
  const options = opts || {};
  const previous = document.activeElement;
  const focusables = () => Array.from(modal.querySelectorAll(
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
  )).filter((n) => n.offsetParent !== null || n === document.activeElement);
  // options.initial may be an element or a function returning one — the modal's
  // buttons are built after openModal() is called, so the safe choice often
  // does not exist yet at the call site.
  const initialEl = () => (typeof options.initial === "function" ? options.initial() : options.initial);
  const focusFirst = () => {
    const f = focusables();
    const want = initialEl();
    (want && want.isConnected ? want : f[0] || modal).focus();
  };
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");
  // Every modal builds an <h3> title; name the dialog with it so a screen
  // reader announces more than "dialog".
  const heading = modal.querySelector("h3");
  if (heading && !modal.hasAttribute("aria-label") && !modal.hasAttribute("aria-labelledby")) {
    if (!heading.id) heading.id = `modalTitle_${Math.random().toString(36).slice(2, 9)}`;
    modal.setAttribute("aria-labelledby", heading.id);
  }
  if (!modal.hasAttribute("tabindex")) modal.setAttribute("tabindex", "-1");
  focusFirst();
  requestAnimationFrame(focusFirst);

  function onKey(e) {
    if (e.key === "Escape" && options.escCloses !== false) {
      e.preventDefault();
      if (options.onClose) options.onClose(); else backdrop.remove();
      return;
    }
    if (e.key !== "Tab") return;
    const f = focusables();
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
  document.addEventListener("keydown", onKey, true);
  backdrop.addEventListener("mousedown", (e) => {
    if (e.target === backdrop && options.backdropCloses !== false) {
      if (options.onClose) options.onClose(); else backdrop.remove();
    }
  });
  const observer = new MutationObserver(() => {
    if (!backdrop.isConnected) {
      document.removeEventListener("keydown", onKey, true);
      observer.disconnect();
      if (previous && previous.isConnected && previous.focus) previous.focus();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
}
function openModal(build, opts) {
  const backdrop = el("div", "modal-backdrop");
  const modal = el("div", (opts && opts.wide) ? "modal wide" : "modal");
  backdrop.appendChild(modal);
  const close = () => backdrop.remove();
  build(modal, close);
  document.body.appendChild(backdrop);
  makeModalAccessible(backdrop, modal, Object.assign({ onClose: close }, opts || {}));
  return { backdrop, modal, close };
}

/* ── Theme ───────────────────────────────────────────────────────────── */
const themeMedia = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
const SUN = '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>';
const MOON = '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>';

function readThemePref() {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === "light" || v === "dark" || v === "system" ? v : "system";
  } catch (e) { return "system"; }
}
function applyTheme(pref) {
  const dark = pref === "dark" || (pref === "system" && themeMedia && themeMedia.matches);
  document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
  // One theme-color tag, updated here rather than two media-gated tags in the
  // head — those cannot follow an in-app override. Values are
  // --surface-chrome-solid in each theme, so the browser bar matches the topbar.
  const tc = document.getElementById("themeColorMeta");
  if (tc) tc.setAttribute("content", dark ? "#17161a" : "#fffdfb");
  const btn = $("#themeToggle");
  if (btn) {
    // The icon shows what is rendered now; the label says what the preference
    // is, which is what a screen-reader user needs to know before clicking.
    btn.textContent = "";
    btn.appendChild(svgIcon(dark ? MOON : SUN));
    const label = pref === "system" ? "Theme: following your system. Switch theme."
      : pref === "dark" ? "Theme: dark. Switch theme."
        : "Theme: light. Switch theme.";
    btn.setAttribute("aria-label", label);
    btn.title = label;
  }
}
function cycleTheme() {
  const cur = readThemePref();
  const renderedDark = document.documentElement.getAttribute("data-theme") === "dark";
  // From "system" the first click flips to the opposite of what is on screen,
  // so it is never a no-op when the OS already matches.
  const next = cur === "system" ? (renderedDark ? "light" : "dark")
    : cur === "dark" ? "light"
      : "system";
  try { localStorage.setItem(THEME_KEY, next); } catch (e) { /* private browsing — session only */ }
  applyTheme(next);
  announce(`Theme: ${next === "system" ? "follow system" : next}`);
}

/* ── Search + filtering ──────────────────────────────────────────────── */
let filterState = { q: "", tag: null, mood: null, day: null };
let searchTimer = null;      // debounce for the entries search box
function clearSearchTimer() {
  if (searchTimer) { clearTimeout(searchTimer); searchTimer = null; }
}

function searchTerms(q) {
  return String(q || "").toLowerCase().split(/\s+/).map((t) => t.trim()).filter(Boolean).slice(0, 8);
}
function filteredEntries() {
  const terms = searchTerms(filterState.q);
  const { tag, mood, day } = filterState;
  const out = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (day && e.date !== day) continue;
    if (mood && e.mood !== mood) continue;
    if (tag && e.tags.indexOf(tag) === -1) continue;
    if (terms.length) {
      const hay = hayOf(e);
      let all = true;
      for (let t = 0; t < terms.length; t++) { if (hay.indexOf(terms[t]) === -1) { all = false; break; } }
      if (!all) continue;
    }
    out.push(e);
  }
  return out;
}
function allTags() {
  const counts = Object.create(null);
  for (const e of entries) for (const t of e.tags) counts[t] = (counts[t] || 0) + 1;
  return Object.keys(counts).sort((a, b) => counts[b] - counts[a] || a.localeCompare(b))
    .map((t) => ({ tag: t, count: counts[t] }));
}

// Appends `text` to `node`, wrapping any search-term match in a <mark>. Every
// piece is a text node — nothing here can inject markup.
function highlightInto(node, text, terms) {
  const s = String(text || "");
  if (!terms || !terms.length) { node.appendChild(document.createTextNode(s)); return; }
  const lower = s.toLowerCase();
  const ranges = [];
  for (const t of terms) {
    if (!t) continue;
    let i = 0;
    while ((i = lower.indexOf(t, i)) !== -1) { ranges.push([i, i + t.length]); i += t.length; }
  }
  if (!ranges.length) { node.appendChild(document.createTextNode(s)); return; }
  ranges.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  let pos = 0;
  for (const [a, b] of merged) {
    if (a > pos) node.appendChild(document.createTextNode(s.slice(pos, a)));
    node.appendChild(txt("mark", null, s.slice(a, b)));
    pos = b;
  }
  if (pos < s.length) node.appendChild(document.createTextNode(s.slice(pos)));
}
// One readable preview line: the text around the first match when searching,
// otherwise the opening of the entry.
function previewText(entry, terms) {
  const body = entry.body.replace(/\s+/g, " ").trim();
  if (!body) return "";
  if (terms && terms.length) {
    const idx = body.toLowerCase().indexOf(terms[0]);
    if (idx > 60) {
      const start = Math.max(0, idx - 40);
      return `…${body.slice(start, start + 220)}`;
    }
  }
  return body.slice(0, 220);
}

/* ── Views ───────────────────────────────────────────────────────────── */
function currentRoute() {
  const h = (location.hash || "").replace(/^#/, "");
  if (h.startsWith("/entry/")) return { name: "write", id: h.slice(7) };
  if (h.startsWith("/write/")) return { name: "write", date: h.slice(7) };
  if (h.startsWith("/entries")) return { name: "entries" };
  if (h.startsWith("/calendar")) return { name: "calendar" };
  if (h.startsWith("/settings")) return { name: "settings" };
  return { name: "write" };
}
function markNav(name) {
  const links = document.querySelectorAll("#sideNav .nav-item");
  links.forEach((a) => {
    const on = a.dataset.route === name;
    a.classList.toggle("active", on);
    if (on) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
  });
}

function buildApp() {
  const root = $("#app");
  if (!root) return;
  flushPendingSave();
  clearSearchTimer(); // the view about to be discarded owns it
  root.textContent = "";
  if (locked) {
    markNav("");
    document.querySelector(".shell").classList.add("is-locked");
    renderLockScreen(root);
    return;
  }
  document.querySelector(".shell").classList.remove("is-locked");
  const route = currentRoute();
  // A route-shaped hash the router does not know ("#/backup", a typo, a route
  // renamed since someone bookmarked it) renders Write. Put the address bar
  // back in step with the screen, or the bookmark and every reload after it
  // describe a page the user is not on. replaceState, not assignment: no
  // hashchange, and the Back button is not given an entry to step through.
  // Only "#/…" hashes are corrected — a bare fragment is not a route claim
  // (see the hashchange listener and the skip link, which rely on that).
  if (route.name === "write" && !route.id && !route.date &&
      location.hash.startsWith("#/") && location.hash !== "#/write") {
    try { history.replaceState(null, "", "#/write"); } catch (e) { /* older engines: leave it */ }
  }
  markNav(route.name);
  if (route.name === "entries") renderEntriesView(root);
  else if (route.name === "calendar") renderCalendarView(root);
  else if (route.name === "settings") renderSettingsView(root);
  else renderWriteView(root, route.id, route.date);
}

/* ── Write view ──────────────────────────────────────────────────────── */
function pageHead(root, title, sub) {
  const head = el("div", "page-head");
  head.appendChild(txt("h1", null, title));
  if (sub) head.appendChild(txt("p", null, sub));
  root.appendChild(head);
  return head;
}

function renderWriteView(root, id, dateHint) {
  let entry = id ? findEntry(id) : null;
  const isNew = !entry;
  if (!entry) entry = blankEntry(isValidISODate(dateHint) ? dateHint : null);
  let inStore = !isNew;

  pageHead(root, isNew ? "New entry" : "Entry",
    "Everything you type is saved on this device as you write.");

  const panel = el("div", "panel");
  root.appendChild(panel);

  // Date + title
  const row = el("div", "field-row");
  const dateField = el("div", "field");
  const dateLabel = txt("label", null, "Date");
  dateLabel.htmlFor = "entryDate";
  const dateInput = el("input");
  dateInput.type = "date";
  dateInput.id = "entryDate";
  dateInput.value = entry.date;
  dateInput.autocomplete = "off";
  dateField.appendChild(dateLabel);
  dateField.appendChild(dateInput);
  row.appendChild(dateField);

  const titleField = el("div", "field");
  const titleLabel = txt("label", null, "Title (optional)");
  titleLabel.htmlFor = "entryTitle";
  const titleInput = el("input");
  titleInput.type = "text";
  titleInput.id = "entryTitle";
  titleInput.value = entry.title;
  titleInput.placeholder = "A few words, if you want them";
  titleInput.maxLength = 300;
  // Browsers default to spellcheck="true", and an enhanced spell checker sends
  // the field's text to the browser maker's servers. That path is outside the
  // page's CSP, so the attribute is the only thing that closes it.
  titleInput.spellcheck = false;
  titleInput.autocomplete = "off";
  titleInput.setAttribute("autocorrect", "off");
  titleField.appendChild(titleLabel);
  titleField.appendChild(titleInput);
  row.appendChild(titleField);
  panel.appendChild(row);

  // Body
  const bodyField = el("div", "field");
  const bodyLabel = txt("label", null, "Entry");
  bodyLabel.htmlFor = "entryBody";
  const bodyInput = el("textarea", "editor-body");
  bodyInput.id = "entryBody";
  bodyInput.value = entry.body;
  // "Today…" — not "Start writing…" (imperative), not "What's on your mind?"
  // (a prompt nobody asked for), not "Write your entry here" (a form label).
  bodyInput.placeholder = "Today…";
  bodyInput.setAttribute("aria-describedby", "wordCount");
  // Same reason as the title field: entry text must not be handed to a remote
  // spell-checking service.
  bodyInput.spellcheck = false;
  bodyInput.autocomplete = "off";
  bodyInput.setAttribute("autocorrect", "off");
  bodyField.appendChild(bodyLabel);
  bodyField.appendChild(bodyInput);
  panel.appendChild(bodyField);

  // Auto-grow: the panel scrolls, not the field. Batched into one rAF and the
  // page's scroll position is restored, so the caret never jumps a line while
  // the height changes underneath it.
  let growQueued = false;
  function applyGrow() {
    const y = window.scrollY;
    bodyInput.style.height = "auto";
    // Always write the measured value back: leaving the field on "auto" after a
    // no-change measurement is harmless today but is one CSS edit away from a
    // field that no longer tracks its text.
    bodyInput.style.height = bodyInput.scrollHeight + "px";
    if (window.scrollY !== y) window.scrollTo(0, y);
  }
  function growComposer() {
    // requestAnimationFrame does not run in a hidden tab, and the field has
    // overflow: hidden — text typed (or restored) while hidden would be clipped
    // with no scrollbar to reveal it. So measure synchronously in that case.
    if (document.hidden) { applyGrow(); return; }
    if (growQueued) return;
    growQueued = true;
    requestAnimationFrame(() => { growQueued = false; applyGrow(); });
  }

  const meta = el("div", "editor-meta");
  const wc = txt("span", "wordcount", "");
  wc.id = "wordCount";
  // The visible pill is aria-hidden; announcements are rate-limited through
  // #srPolite (see announceSaved). A polite region firing "Saved" every eight
  // seconds makes the app unusable with VoiceOver.
  const note = txt("span", "savenote", inStore ? savedLabel() : "");
  note.id = "saveNote";
  note.setAttribute("aria-hidden", "true");
  meta.appendChild(wc);
  meta.appendChild(note);
  panel.appendChild(meta);

  // First run has no chrome to explain and nothing to browse, so the one thing
  // it says is what happens to the words.
  if (!entries.length && isNew) {
    const foot = txt("p", "first-run-note",
      "Everything you write stays on this device. No account, nothing uploaded.");
    panel.appendChild(foot);
  }

  function updateWordCount() {
    const n = countWords(bodyInput.value);
    wc.textContent = n === 0 ? "No words yet" : plural(n, "word", "words");
  }
  updateWordCount();

  // Mood
  const moodPanel = el("div", "panel");
  // H2, not H3: the page's only H1 is the view title above it, and a heading
  // list that jumps H1 → H3 reads as a missing level to anyone navigating by
  // heading. The class keeps the smaller panel-subhead size.
  moodPanel.appendChild(txt("h2", "panel-subhead", "How the day felt (optional)"));
  moodPanel.appendChild(txt("p", "panel-sub", "A marker for your own reference. Nothing is scored."));
  const moodRow = el("div", "mood-row");
  moodRow.setAttribute("role", "group");
  moodRow.setAttribute("aria-label", "Mood marker");
  MOODS.forEach((m) => {
    const b = el("button", `mood-chip ${m.cls}`);
    b.type = "button";
    b.appendChild(svgIcon(m.glyph, "mood-glyph"));
    b.appendChild(document.createTextNode(m.label));
    b.setAttribute("aria-pressed", entry.mood === m.id ? "true" : "false");
    b.onclick = () => {
      entry.mood = entry.mood === m.id ? null : m.id;
      Array.from(moodRow.children).forEach((c, i) => {
        c.setAttribute("aria-pressed", entry.mood === MOODS[i].id ? "true" : "false");
      });
      touch();
      announce(entry.mood ? `Marked ${m.label}` : "Marker cleared");
    };
    moodRow.appendChild(b);
  });
  moodPanel.appendChild(moodRow);

  // Tags
  const tagField = el("div", "field");
  tagField.style.marginTop = "18px";
  const tagLabel = txt("label", null, "Tags (optional)");
  tagLabel.htmlFor = "tagInput";
  const tagInput = el("input");
  tagInput.type = "text";
  tagInput.id = "tagInput";
  tagInput.placeholder = "work, garden, sleep";
  // Tags are entry content too — a name, a place, a word someone would not want
  // leaving the device. Same reason as the title and body fields: an enhanced
  // spell checker posts field text to the browser maker's servers, which is a
  // path the page's CSP does not reach.
  tagInput.spellcheck = false;
  tagInput.autocomplete = "off";
  tagInput.setAttribute("autocorrect", "off");
  tagInput.setAttribute("aria-describedby", "tagHint");
  const tagHint = txt("p", "hint", "Press Enter or comma to add a tag.");
  tagHint.id = "tagHint";
  const chips = el("div", "tag-chips");
  chips.id = "tagChips";
  tagField.appendChild(tagLabel);
  tagField.appendChild(tagInput);
  tagField.appendChild(tagHint);
  tagField.appendChild(chips);
  moodPanel.appendChild(tagField);
  root.appendChild(moodPanel);

  function renderChips() {
    chips.textContent = "";
    entry.tags.forEach((t) => {
      const chip = el("span", "tag-chip");
      chip.appendChild(txt("span", null, t));
      const x = txt("button", null, "×");
      x.type = "button";
      x.setAttribute("aria-label", `Remove tag ${t}`);
      x.onclick = () => {
        entry.tags = entry.tags.filter((v) => v !== t);
        renderChips();
        touch();
        announce(`Removed tag ${t}`);
      };
      chip.appendChild(x);
      chips.appendChild(chip);
    });
  }
  renderChips();
  function commitTags(list) {
    let added = 0;
    for (const raw of list) {
      const p = cleanTag(raw);
      if (!p) continue;
      if (entry.tags.length >= 12) break;
      if (entry.tags.indexOf(p) === -1) { entry.tags.push(p); added++; }
    }
    if (added) { renderChips(); touch(); announce(`Added ${plural(added, "tag", "tags")}`); }
    return added;
  }
  function addTagFromInput() {
    const list = tagInput.value.split(",");
    tagInput.value = "";
    commitTags(list);
  }
  tagInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); addTagFromInput(); }
  });
  // A comma is committed from the input event, not from keydown: software
  // keyboards and IMEs frequently report no usable key for punctuation, and
  // this path also handles a pasted "a, b, c".
  tagInput.addEventListener("input", () => {
    if (tagInput.value.indexOf(",") === -1) return;
    const parts = tagInput.value.split(",");
    const remainder = parts.pop();
    tagInput.value = remainder;
    commitTags(parts);
  });
  tagInput.addEventListener("blur", addTagFromInput);

  // Actions
  const actions = el("div", "btn-row");
  actions.style.marginBottom = "18px";
  const doneBtn = txt("button", "btn", "Done");
  doneBtn.type = "button";
  doneBtn.onclick = () => { flushPendingSave(); location.hash = "#/entries"; };
  actions.appendChild(doneBtn);
  const newBtn = txt("button", "btn ghost", "Start another entry");
  newBtn.type = "button";
  newBtn.onclick = () => {
    flushPendingSave();
    if (location.hash === "#/write") buildApp();
    else location.hash = "#/write";
  };
  actions.appendChild(newBtn);
  // Present from the start, revealed the moment the entry actually exists —
  // so a just-written entry can be removed without going to the list first.
  const delBtn = txt("button", "btn quiet", "Delete entry");
  delBtn.type = "button";
  if (isNew) delBtn.classList.add("hidden");
  delBtn.onclick = () => { deleteEntry(entry.id, () => { location.hash = "#/entries"; }); };
  actions.appendChild(delBtn);
  root.appendChild(actions);

  // ── Autosave wiring ──────────────────────────────────────────────────
  // An untouched blank entry is never written, so opening "Write" and walking
  // away does not litter the journal with empty days.
  function touch() {
    entry.date = isValidISODate(dateInput.value) ? dateInput.value : entry.date;
    entry.title = titleInput.value;
    entry.body = bodyInput.value;
    if (isEmptyEntry(entry) && !inStore) { note.textContent = ""; return; }
    if (!inStore) {
      entries.push(entry);
      sortEntries();
      inStore = true;
      delBtn.classList.remove("hidden");
      try { history.replaceState(null, "", `#/entry/${entry.id}`); } catch (e) {}
    }
    // No "Saving…" here: scheduleSave shows it only if the write is still
    // outstanding after 600ms. Nothing animates or flickers during typing.
    scheduleSave(entry);
  }
  const onInput = () => { growComposer(); updateWordCount(); touch(); };
  bodyInput.addEventListener("input", onInput);
  titleInput.addEventListener("input", touch);
  // A changed date moves the entry in the list, so the in-memory order is
  // re-established here rather than on every keystroke.
  dateInput.addEventListener("change", () => { touch(); sortEntries(); });
  // Blur is the second guarantee: a debounce that has not fired yet is written
  // the moment the field loses focus.
  bodyInput.addEventListener("blur", () => { touch(); flushPendingSave(); });
  titleInput.addEventListener("blur", () => { touch(); flushPendingSave(); });
  dateInput.addEventListener("blur", () => { touch(); flushPendingSave(); });

  // Size the field to the text it already holds, before anything is typed.
  // activeComposerGrow is a single slot, not a new listener per render — the
  // editor is rebuilt on every route change and per-render listeners would
  // accumulate for the life of the tab.
  activeComposerGrow = growComposer;
  growComposer();

  // preventScroll: focusing a tall textarea would otherwise jump the page past
  // the header the moment the editor opens. Only on a fine pointer: iOS largely
  // refuses programmatic focus outside a user gesture, so on touch it either
  // does nothing or throws the keyboard up before the screen has been read.
  const finePointer = !window.matchMedia || window.matchMedia("(pointer: fine)").matches;
  if (isNew && finePointer) {
    setTimeout(() => {
      try { bodyInput.focus({ preventScroll: true }); } catch (e) { try { bodyInput.focus(); } catch (e2) {} }
    }, 0);
  }
}

/* ── Entries view ────────────────────────────────────────────────────── */
let listLimit = PAGE_SIZE;

function renderEntriesView(root) {
  pageHead(root, "Entries", "Newest first, grouped by month.");

  const filters = el("div", "panel");
  const bar = el("div", "filter-bar");

  const searchWrap = el("div", "search-wrap");
  searchWrap.appendChild(svgIcon('<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>'));
  const search = el("input");
  search.type = "search";
  search.id = "entrySearch";
  search.placeholder = "Search titles, entries and tags…";
  search.setAttribute("aria-label", "Search your entries");
  search.autocomplete = "off";
  search.spellcheck = false;
  search.value = filterState.q;
  searchWrap.appendChild(search);
  bar.appendChild(searchWrap);

  const moodField = el("div", "field");
  const moodLabel = txt("label", null, "Mood");
  moodLabel.htmlFor = "moodFilter";
  const moodSel = el("select");
  moodSel.id = "moodFilter";
  const anyOpt = txt("option", null, "Any mood");
  anyOpt.value = "";
  moodSel.appendChild(anyOpt);
  MOODS.forEach((m) => {
    const o = txt("option", null, m.label);
    o.value = m.id;
    moodSel.appendChild(o);
  });
  moodSel.value = filterState.mood || "";
  moodField.appendChild(moodLabel);
  moodField.appendChild(moodSel);
  moodField.style.flex = "0 0 160px";
  bar.appendChild(moodField);

  const newBtn = txt("a", "btn", "New entry");
  newBtn.href = "#/write";
  newBtn.style.flex = "none";
  bar.appendChild(newBtn);
  filters.appendChild(bar);

  const tags = allTags();
  if (tags.length) {
    const pills = el("div", "filter-pills");
    pills.setAttribute("role", "group");
    pills.setAttribute("aria-label", "Filter by tag");
    tags.slice(0, 24).forEach(({ tag, count }) => {
      const b = el("button", "filter-pill");
      b.type = "button";
      b.appendChild(document.createTextNode(`${tag} (${count})`));
      b.setAttribute("aria-pressed", filterState.tag === tag ? "true" : "false");
      b.onclick = () => {
        filterState.tag = filterState.tag === tag ? null : tag;
        listLimit = PAGE_SIZE;
        buildApp();
      };
      pills.appendChild(b);
    });
    filters.appendChild(pills);
  }
  root.appendChild(filters);

  const listHost = el("div");
  listHost.id = "listHost";
  root.appendChild(listHost);

  function paint() {
    listHost.textContent = "";
    const terms = searchTerms(filterState.q);
    const list = filteredEntries();

    const countLine = el("p", "list-count");
    countLine.id = "listCount";
    countLine.setAttribute("role", "status");
    const active = [];
    if (filterState.q) active.push(`matching “${filterState.q}”`);
    if (filterState.tag) active.push(`tagged ${filterState.tag}`);
    if (filterState.mood) active.push(`marked ${moodOf(filterState.mood).label}`);
    if (filterState.day) active.push(`on ${fmtLongDate(filterState.day)}`);
    countLine.textContent = entries.length === 0 ? ""
      : `${plural(list.length, "entry", "entries")}${active.length ? " " + active.join(", ") : ""}`;
    listHost.appendChild(countLine);

    if (active.length) {
      const clear = txt("button", "linkish", "Clear filters");
      clear.type = "button";
      clear.onclick = () => {
        filterState = { q: "", tag: null, mood: null, day: null };
        listLimit = PAGE_SIZE;
        buildApp();
      };
      listHost.appendChild(clear);
    }

    if (!entries.length) {
      listHost.appendChild(emptyState(
        "Nothing here right now",
        "Your journal is empty. Whenever you're ready, start a new entry.",
        { label: "Write an entry", href: "#/write" }));
      return;
    }
    if (!list.length) {
      // Not the user's doing, so the art goes neutral as well as the words. A
      // state is not a fault.
      const q = String(filterState.q || "").trim();
      const es = q
        ? emptyState(`No entries match “${q.slice(0, 24)}”`,
          "Search looks through the words in your entries and their tags. Searching happens only on this device.")
        : emptyState("Nothing matches those filters",
          "Try a different word, or clear the filters to see everything again.");
      es.classList.add("is-neutral");
      listHost.appendChild(es);
      return;
    }

    const shown = list.slice(0, listLimit);
    let currentMonth = null;
    let group = null;
    let groupList = null;
    shown.forEach((e) => {
      const mk = monthKey(e.date);
      if (mk !== currentMonth) {
        currentMonth = mk;
        group = el("section", "month-group");
        const head = el("div", "month-head");
        // A <section> is a landmark; an unnamed one is announced as a bare
        // "region", so a year of entries would list twelve identical landmarks.
        // H2: these sit directly under the view's H1, so H3 would skip a rank.
        const monthHeading = txt("h2", null, fmtMonth(mk));
        monthHeading.id = `monthHead_${mk}`;
        group.setAttribute("aria-labelledby", monthHeading.id);
        head.appendChild(monthHeading);
        const inMonth = list.filter((x) => monthKey(x.date) === mk).length;
        head.appendChild(txt("span", "month-count", plural(inMonth, "entry", "entries")));
        group.appendChild(head);
        groupList = el("div", "entry-list");
        group.appendChild(groupList);
        listHost.appendChild(group);
      }
      groupList.appendChild(entryRow(e, terms));
    });

    if (list.length > shown.length) {
      const more = txt("button", "btn quiet", `Show ${Math.min(PAGE_SIZE, list.length - shown.length)} more`);
      more.type = "button";
      more.onclick = () => { listLimit += PAGE_SIZE; paint(); };
      listHost.appendChild(more);
    }
  }

  // The handle is module-scoped so a view rebuild can cancel it. Left running,
  // it would set filterState.q against a detached input after the new view had
  // already read the old (empty) value, and the list would narrow silently on
  // the next interaction.
  clearSearchTimer();
  search.addEventListener("input", () => {
    clearSearchTimer();
    searchTimer = setTimeout(() => {
      searchTimer = null;
      filterState.q = search.value;
      listLimit = PAGE_SIZE;
      paint();
    }, 120);
  });
  moodSel.addEventListener("change", () => {
    filterState.mood = moodSel.value || null;
    listLimit = PAGE_SIZE;
    paint();
  });

  paint();
}

function entryRow(e, terms) {
  const row = el("div", "entry-row");
  const open = el("button", "entry-open");
  open.type = "button";
  open.setAttribute("aria-label", `Open entry from ${fmtLongDate(e.date)}`);
  open.onclick = () => { location.hash = `#/entry/${e.id}`; };

  const top = el("div", "entry-top");
  top.appendChild(txt("span", "entry-date", fmtLongDate(e.date)));
  const title = el("span", e.title.trim() ? "entry-title" : "entry-title untitled");
  if (e.title.trim()) highlightInto(title, e.title, terms);
  else title.textContent = "Untitled";
  top.appendChild(title);
  const m = moodOf(e.mood);
  if (m) {
    const dot = el("span", `mood-dot ${m.cls}`);
    dot.appendChild(svgIcon(m.glyph));
    dot.appendChild(document.createTextNode(m.label));
    top.appendChild(dot);
  }
  open.appendChild(top);

  const prev = el("p", "entry-preview");
  const p = previewText(e, terms);
  if (p) highlightInto(prev, p, terms);
  else prev.textContent = "No text in this entry yet.";
  open.appendChild(prev);

  if (e.tags.length) {
    const tagRow = el("div", "entry-tags");
    e.tags.forEach((t) => {
      const chip = el("span", "tag-chip");
      highlightInto(chip, t, terms);
      tagRow.appendChild(chip);
    });
    open.appendChild(tagRow);
  }
  row.appendChild(open);

  const actions = el("div", "entry-actions");
  const del = el("button", "icon-btn danger");
  del.type = "button";
  del.setAttribute("aria-label", `Delete entry from ${fmtLongDate(e.date)}`);
  del.appendChild(svgIcon('<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/>'));
  del.onclick = () => deleteEntry(e.id, () => buildApp());
  actions.appendChild(del);
  row.appendChild(actions);
  return row;
}

function emptyState(title, message, action) {
  const wrap = el("div", "empty-state");
  const art = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  art.setAttribute("viewBox", "0 0 84 84");
  art.setAttribute("class", "empty-state-art");
  art.setAttribute("aria-hidden", "true");
  art.innerHTML =
    '<circle class="es-halo" cx="42" cy="42" r="34"/>' +
    '<rect class="es-page" x="26" y="20" width="34" height="44" rx="4" fill="none" stroke-width="2"/>' +
    '<path class="es-line" d="M33 32h20M33 40h20M33 48h12" stroke-width="2.4" stroke-linecap="round" fill="none"/>';
  wrap.appendChild(art);
  wrap.appendChild(txt("p", "empty-state-title", title));
  wrap.appendChild(txt("p", "empty-state-msg", message));
  if (action) {
    const a = txt("a", "btn", action.label);
    a.href = action.href;
    a.style.marginTop = "12px";
    wrap.appendChild(a);
  }
  return wrap;
}

/* ── Delete, with an undo window rather than a confirm dialog ─────────── */
async function deleteEntry(id, after) {
  const idx = entries.findIndex((e) => e.id === id);
  if (idx === -1) return;
  const removed = entries[idx];
  // Cancel any debounced save for this entry first, or the flush that a route
  // change triggers would write it straight back after the delete.
  if (pendingEntry && pendingEntry.id === id) {
    pendingEntry = null;
    clearTimeout(saveTimer);
    saveTimer = null;
    clearDraftMirror();
  }
  entries.splice(idx, 1);
  if (after) after();
  try {
    if (db) await idbRun([STORE_ENTRIES], "readwrite", (tx) => { tx.objectStore(STORE_ENTRIES).delete(id); });
  } catch (e) { showBanner(friendly(e), true); }
  showToast(`Deleted the entry from ${fmtLongDate(removed.date)}.`, "Undo", async () => {
    entries.push(removed);
    sortEntries();
    try {
      if (db) {
        const rec = await toRecord(removed);
        await idbRun([STORE_ENTRIES], "readwrite", (tx) => { tx.objectStore(STORE_ENTRIES).put(rec); });
      }
      announce("Entry restored.");
    } catch (e) { showBanner(friendly(e), true); }
    buildApp();
  }, 9000);
}

/* ── Calendar view ───────────────────────────────────────────────────── */
let calMonth = null; // {y, m} — m is 0-based

function renderCalendarView(root) {
  const now = new Date();
  if (!calMonth) calMonth = { y: now.getFullYear(), m: now.getMonth() };
  // "It's a record, not a target" is doing real work: it tells the user up
  // front that nothing on this screen will chase them.
  pageHead(root, "Calendar", "Which days you've written on. It's a record, not a target.");

  // cal-panel is a hook for the narrow-screen rule that reclaims its own
  // horizontal padding so a day cell can still reach the 44px touch minimum at
  // 375px. See the @media (max-width: 420px) block in styles.css.
  const panel = el("div", "panel cal-panel");
  const head = el("div", "cal-head");
  const prev = el("button", "icon-btn");
  prev.type = "button";
  prev.setAttribute("aria-label", "Previous month");
  prev.appendChild(svgIcon('<path d="m15 18-6-6 6-6"/>'));
  prev.onclick = () => {
    calMonth.m--; if (calMonth.m < 0) { calMonth.m = 11; calMonth.y--; }
    buildApp();
  };
  const next = el("button", "icon-btn");
  next.type = "button";
  next.setAttribute("aria-label", "Next month");
  next.appendChild(svgIcon('<path d="m9 18 6-6-6-6"/>'));
  next.onclick = () => {
    calMonth.m++; if (calMonth.m > 11) { calMonth.m = 0; calMonth.y++; }
    buildApp();
  };
  head.appendChild(prev);
  head.appendChild(txt("h2", "cal-title", `${MONTH_NAMES[calMonth.m]} ${calMonth.y}`));
  head.appendChild(next);
  panel.appendChild(head);

  // days-with-entries for this month
  const mk = `${calMonth.y}-${pad2(calMonth.m + 1)}`;
  const byDay = Object.create(null);
  for (const e of entries) {
    if (monthKey(e.date) !== mk) continue;
    byDay[e.date] = (byDay[e.date] || 0) + 1;
  }
  const grid = el("div", "cal-grid");
  DOW_SHORT.forEach((d) => {
    const h = txt("div", "cal-dow", d);
    h.setAttribute("aria-hidden", "true");
    grid.appendChild(h);
  });
  const first = new Date(calMonth.y, calMonth.m, 1);
  const daysInMonth = new Date(calMonth.y, calMonth.m + 1, 0).getDate();
  for (let i = 0; i < first.getDay(); i++) {
    const cell = el("div", "cal-cell");
    cell.appendChild(el("div", "cal-day blank"));
    grid.appendChild(cell);
  }
  const todayStr = todayISO();
  for (let d = 1; d <= daysInMonth; d++) {
    const iso = `${calMonth.y}-${pad2(calMonth.m + 1)}-${pad2(d)}`;
    const count = byDay[iso] || 0;
    const cell = el("div", "cal-cell");
    const btn = el("button", `cal-day${count ? " has" : ""}${iso === todayStr ? " today" : ""}`);
    btn.type = "button";
    btn.appendChild(document.createTextNode(String(d)));
    btn.appendChild(el("span", "cal-mark"));
    btn.setAttribute("aria-label", count
      ? `${fmtLongDate(iso)}, ${plural(count, "entry", "entries")}. Show them.`
      : `${fmtLongDate(iso)}, no entries. Write one.`);
    btn.onclick = () => {
      if (count) {
        filterState = { q: "", tag: null, mood: null, day: iso };
        listLimit = PAGE_SIZE;
        location.hash = "#/entries";
      } else {
        // Route by date rather than creating a record here: an untouched blank
        // entry must never end up in the journal.
        location.hash = `#/write/${iso}`;
      }
    };
    cell.appendChild(btn);
    grid.appendChild(cell);
  }
  panel.appendChild(grid);

  const daysWritten = Object.keys(byDay).length;
  const entriesThisMonth = Object.keys(byDay).reduce((s, k) => s + byDay[k], 0);
  const note = el("p", "cal-note");
  // A month you did not write in is not a problem to solve: one quiet line, no
  // illustration and no button.
  note.appendChild(txt("span", null,
    daysWritten === 0
      ? `Nothing written in ${MONTH_NAMES[calMonth.m]} ${calMonth.y}.`
      : `You have written ${plural(daysWritten, "day", "days")} this month.`));
  if (daysWritten > 0) {
    note.appendChild(txt("span", "cal-note-sub",
      `${plural(entriesThisMonth, "entry", "entries")} in ${MONTH_NAMES[calMonth.m]}.`));
  }
  panel.appendChild(note);
  root.appendChild(panel);

  const stats = el("div", "panel");
  stats.appendChild(txt("h3", null, "Your journal so far"));
  const row = el("div", "stat-row");
  const totalDays = new Set(entries.map((e) => e.date)).size;
  const totalWords = entries.reduce((s, e) => s + countWords(e.body), 0);
  [
    [String(entries.length), entries.length === 1 ? "entry in total" : "entries in total"],
    [String(totalDays), totalDays === 1 ? "day written on" : "days written on"],
    [totalWords.toLocaleString(), totalWords === 1 ? "word written" : "words written"]
  ].forEach(([v, l]) => {
    const tile = el("div", "stat-tile");
    tile.appendChild(txt("div", "stat-value", v));
    tile.appendChild(txt("div", "stat-label", l));
    row.appendChild(tile);
  });
  stats.appendChild(row);
  root.appendChild(stats);
}

/* ── Export ──────────────────────────────────────────────────────────── */
function stamp() { return todayISO(); }

// Filesystem.writeFile takes base64, not bytes. Chunked so a large journal
// doesn't blow the argument limit of String.fromCharCode.apply.
function bytesToBase64(bytes) {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  return btoa(bin);
}

/* NATIVE export delivery. Inside a WKWebView the <a download> anchor in
   downloadBytes() silently does nothing — there is no browser downloads UI for
   it to reach. Write the bytes into the app's own cache directory instead and
   hand that file to the system share sheet, where the user picks Files, Mail,
   or anywhere else. This path is unreachable on the web. */
async function shareBytes(bytes, filename) {
  // Directory is a plain JS enum exported from the @capacitor/filesystem
  // *package*, not a "plugin" — it is never present on
  // window.Capacitor.Plugins in this no-bundler, plain-<script>-tag app, so
  // destructuring it from there yields undefined and `directory: undefined.Cache`
  // throws. "CACHE" is that enum's underlying string value, used directly.
  const { Filesystem, Share } = window.Capacitor.Plugins;
  const { uri } = await Filesystem.writeFile({ path: filename, data: bytesToBase64(bytes), directory: "CACHE" });
  try {
    await Share.share({ title: filename, files: [uri] });
  } finally {
    // That cache copy is the same unencrypted file, so it should not outlive
    // the share sheet. iOS settles the share promise once the chosen app has
    // taken the file — and a dismissal settles it too — so either way there is
    // nothing left to wait for. A cleanup that misses is not the user's
    // problem: it stays quiet and changes nothing about what the share itself
    // reported, success or failure. The launch sweep below catches strays.
    try { await Filesystem.deleteFile({ path: filename, directory: "CACHE" }); } catch (e) {}
  }
  try { localStorage.setItem(LAST_BACKUP_KEY, new Date().toISOString()); } catch (e) {}
}

/* An export can still be left behind — the app killed while the share sheet is
   open, or a delete that didn't land. Each start clears what it finds, matching
   only the names this app gives its own exports. Never the whole directory:
   that folder belongs to the system as much as to us. */
const OWN_EXPORT_NAME_RE = /^(local-journal-backup-\d{4}-\d{2}-\d{2}\.json|local-journal-\d{4}-\d{2}-\d{2}\.(md|pdf))$/;

async function sweepStaleExports() {
  const { Filesystem } = window.Capacitor.Plugins || {};
  if (!Filesystem || typeof Filesystem.readdir !== "function") return;
  const res = await Filesystem.readdir({ path: "", directory: "CACHE" });
  // Capacitor 7 returns file objects; older shapes returned bare names.
  for (const f of (res && res.files) || []) {
    const name = typeof f === "string" ? f : (f && f.name);
    if (!name || !OWN_EXPORT_NAME_RE.test(name)) continue;
    try { await Filesystem.deleteFile({ path: name, directory: "CACHE" }); } catch (e) {}
  }
}

// Dismissing the iOS share sheet rejects the promise. That is a choice, not a
// fault, so it must not come back as a red error.
function isShareCancel(e) {
  const m = (e && e.message) || String(e || "");
  return /cancel/i.test(m) || /abort/i.test(m);
}

/* The one place an export becomes a file the user has.

   WEB: unchanged — downloadBytes() clicks the anchor synchronously and the
   caller's message appears immediately, exactly as it did before.
   NATIVE: the share sheet is asynchronous, so the message waits for it. */
function deliverExport(bytes, filename, host, webMsg, nativeMsg, tone, after) {
  if (!IS_NATIVE) {
    downloadBytes(bytes, filename);
    status(host, webMsg, tone);
    if (after) after();
    return;
  }
  shareBytes(bytes, filename).then(() => {
    status(host, nativeMsg, tone);
    if (after) after();
  }).catch((e) => {
    if (isShareCancel(e)) { status(host, "Export cancelled. The file wasn't shared anywhere.", "note"); return; }
    status(host, friendly(e), "err");
  });
}

function downloadBytes(bytes, filename) {
  // Safari treats a blob: URL typed application/pdf or text/* as viewable and
  // opens its own viewer, ignoring <a download> — the file never reaches
  // Downloads. application/octet-stream has no viewer, so every browser saves
  // it; the filename extension is what makes it open correctly afterwards.
  const blob = new Blob([bytes], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  try { localStorage.setItem(LAST_BACKUP_KEY, new Date().toISOString()); } catch (e) {}
}

function buildBackupJson() {
  return JSON.stringify({
    app: VAULT_APP_ID,
    format: BACKUP_FORMAT,
    exportedAt: new Date().toISOString(),
    entryCount: entries.length,
    entries: entries.map((e) => ({
      id: e.id, date: e.date, title: e.title, body: e.body,
      mood: e.mood, tags: e.tags, createdAt: e.createdAt, updatedAt: e.updatedAt
    }))
  }, null, 2);
}
function buildMarkdown() {
  const lines = [];
  lines.push("# Local Journal");
  lines.push("");
  lines.push(`Exported ${stamp()} · ${plural(entries.length, "entry", "entries")}`);
  lines.push("");
  let month = null;
  for (const e of entries) {
    const mk = monthKey(e.date);
    if (mk !== month) { month = mk; lines.push(""); lines.push(`## ${fmtMonth(mk)}`); lines.push(""); }
    lines.push(`### ${fmtLongDate(e.date)}${e.title.trim() ? ` — ${e.title.trim()}` : ""}`);
    const meta = [];
    const m = moodOf(e.mood);
    if (m) meta.push(`Mood: ${m.label}`);
    if (e.tags.length) meta.push(`Tags: ${e.tags.join(", ")}`);
    if (meta.length) { lines.push(""); lines.push(`*${meta.join(" · ")}*`); }
    lines.push("");
    lines.push(e.body.trim() || "_(no text)_");
    lines.push("");
    lines.push("---");
  }
  return lines.join("\n");
}

// pdf-lib is loaded on demand (first PDF export). The promise is memoised so
// concurrent callers share one load, and nulled on error so a retry can retry.
let _pdfLibPromise = null;
function ensurePdfLib() {
  if (window.PDFLib) return Promise.resolve();
  if (!_pdfLibPromise) {
    _pdfLibPromise = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "lib/pdf-lib.min.js";
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => { _pdfLibPromise = null; reject(new Error("PDFLIB_FAILED")); };
      document.head.appendChild(s);
    });
  }
  return _pdfLibPromise;
}
// pdf-lib's standard fonts cover WinAnsi only; strip anything outside it so
// drawText never throws on an emoji pasted into an entry.
// The typographic characters below are written as \u escapes on purpose: as
// literals they are easy to retype as their ASCII lookalikes, which silently
// turns the curly quotes into a no-op and deletes them from every PDF.
// U+2013/U+2014 en and em dash, U+2018/U+2019 single curly quotes,
// U+201C/U+201D double curly quotes, U+2022 bullet, U+2026 ellipsis.
// A newline is deliberately NOT in this set — pdfSafe() runs on single drawText
// lines, which must stay newline-free. wrapForPdf() splits on \n before it
// sanitises, so line breaks survive that path.
const PDF_SAFE_RE = /[^\x20-\x7E\xA0-\xFF\u2013\u2014\u2018\u2019\u201C\u201D\u2022\u2026]/g;
// Characters dropped by pdfSafe during the current export, so the success
// message can say that something was left out instead of losing it silently.
let pdfDroppedChars = 0;
const pdfSafe = (s) => String(s == null ? "" : s).replace(PDF_SAFE_RE, () => { pdfDroppedChars++; return ""; });
function wrapForPdf(font, text, size, maxWidth) {
  const out = [];
  // Split first, sanitise second. pdfSafe() deletes \n along with everything
  // else outside WinAnsi, so sanitising first would leave nothing to split on
  // and glue the last word of each paragraph to the first word of the next.
  // Cleaned here, not only at draw time: widthOfTextAtSize() runs the string
  // through the same WinAnsi encoder as drawText and throws on the first
  // character outside it, which would abort the whole export.
  const paragraphs = String(text == null ? "" : text).split(/\n/).map(pdfSafe);
  for (const para of paragraphs) {
    const words = para.split(/\s+/).filter(Boolean);
    if (!words.length) { out.push(""); continue; }
    let line = "";
    for (const w of words) {
      const test = line ? `${line} ${w}` : w;
      if (font.widthOfTextAtSize(test, size) <= maxWidth) { line = test; continue; }
      if (line) out.push(line);
      // A single word longer than the column is broken by character rather than
      // allowed to run off the page.
      if (font.widthOfTextAtSize(w, size) > maxWidth) {
        let chunk = "";
        for (const ch of w) {
          if (font.widthOfTextAtSize(chunk + ch, size) > maxWidth) { out.push(chunk); chunk = ch; }
          else chunk += ch;
        }
        line = chunk;
      } else line = w;
    }
    if (line) out.push(line);
  }
  return out;
}
async function exportPdf(statusHost) {
  if (!entries.length) { status(statusHost, "There are no entries to export yet.", "note"); return; }
  status(statusHost, "Building your PDF on your device…", "info");
  pdfDroppedChars = 0;
  await ensurePdfLib();
  const { PDFDocument, rgb, StandardFonts } = window.PDFLib;
  const pdf = await PDFDocument.create();
  const reg = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.10, 0.10, 0.18);
  const soft = rgb(0.42, 0.45, 0.50);
  const W = 612, H = 792, M = 56, COL = W - M * 2;
  let page = null, y = 0, pageNo = 0;

  function newPage() {
    page = pdf.addPage([W, H]);
    pageNo++;
    y = H - M;
    page.drawText(pdfSafe(`Local Journal · page ${pageNo}`), { x: M, y: 30, size: 8, font: reg, color: soft });
  }
  function space(n) { if (!page || y - n < M + 24) newPage(); }
  function line(text, size, font, color, gap) {
    space(size + 4);
    page.drawText(pdfSafe(text), { x: M, y, size, font: font || reg, color: color || ink });
    y -= size + (gap == null ? 4 : gap);
  }

  newPage();
  line("Local Journal", 24, bold, ink, 8);
  line(`${plural(entries.length, "entry", "entries")} · exported ${stamp()}`, 11, reg, soft, 18);

  for (const e of entries) {
    space(70);
    y -= 8;
    line(fmtLongDate(e.date), 10, bold, rgb(0.58, 0.29, 0.03), 4);
    if (e.title.trim()) line(e.title.trim(), 15, bold, ink, 5);
    const meta = [];
    const m = moodOf(e.mood);
    if (m) meta.push(m.label);
    if (e.tags.length) meta.push(e.tags.join(", "));
    if (meta.length) line(meta.join(" · "), 9.5, reg, soft, 8);
    const body = e.body.trim();
    if (body) {
      for (const l of wrapForPdf(reg, body, 11, COL)) {
        if (l === "") { y -= 7; continue; }
        line(l, 11, reg, ink, 4.5);
      }
    } else {
      line("(no text)", 11, reg, soft, 4.5);
    }
    y -= 10;
  }
  const bytes = await pdf.save();
  // The PDF fonts cover WinAnsi only, so anything outside it (Japanese,
  // Cyrillic, emoji…) is left out of the printable copy. Say so rather than
  // let a page come out silently short — the entries themselves are untouched.
  const dropped = pdfDroppedChars;
  const head = `Saved a ${pdf.getPageCount()}-page PDF (${fmtBytes(bytes.length)}).`;
  let tail = "";
  if (dropped > 0) {
    tail = ` ${plural(dropped, "character", "characters")} these PDF fonts can't draw ${dropped === 1 ? "was" : "were"} left out. The Markdown or JSON export keeps every character.`;
  }
  deliverExport(bytes, `local-journal-${stamp()}.pdf`, statusHost,
    `${head} Check your downloads.${tail}`,
    `${head} It went where you chose to send it.${tail}`,
    dropped > 0 ? "warn" : "ok");
}

function status(host, message, tone) {
  if (!host) return;
  host.textContent = "";
  const box = txt("div", `status ${tone || "info"}`, message);
  host.appendChild(box);
  announce(message, tone === "err");
}

/* ── Import ──────────────────────────────────────────────────────────── */
function parseBackup(text) {
  let data;
  try { data = JSON.parse(text); } catch (e) { throw new Error("NOT_JSON"); }
  if (!data || typeof data !== "object") throw new Error("NOT_JSON");
  if (data.app !== VAULT_APP_ID) throw new Error("WRONG_APP");
  if (!Array.isArray(data.entries) || !data.entries.length) throw new Error("NO_ENTRIES");
  const clean = [];
  for (const raw of data.entries) {
    const e = sanitizeEntry(raw);
    if (e) clean.push(e);
  }
  if (!clean.length) throw new Error("NO_ENTRIES");
  return clean;
}
// What a merge would actually do, computed before anything is written so the
// preview shown to the user is the real outcome, not a guess.
function planMerge(incoming) {
  const byId = Object.create(null);
  for (const e of entries) byId[e.id] = e;
  let added = 0, updated = 0, unchanged = 0;
  for (const inc of incoming) {
    const cur = byId[inc.id];
    if (!cur) { added++; continue; }
    if (inc.updatedAt > cur.updatedAt) updated++; else unchanged++;
  }
  return { added, updated, unchanged, total: incoming.length };
}
async function applyImport(incoming, mode) {
  let next;
  if (mode === "replace") {
    next = incoming.slice();
  } else {
    const byId = Object.create(null);
    for (const e of entries) byId[e.id] = e;
    for (const inc of incoming) {
      const cur = byId[inc.id];
      if (!cur || inc.updatedAt > cur.updatedAt) byId[inc.id] = inc;
    }
    next = Object.keys(byId).map((k) => byId[k]);
  }
  // All the encryption happens first: an IndexedDB transaction closes the
  // moment it yields to a non-IDB promise, so nothing may be awaited between
  // opening it and the last put.
  const records = [];
  for (const e of next) records.push(await toRecord(e));
  if (db) {
    await idbRun([STORE_ENTRIES], "readwrite", (tx) => {
      const store = tx.objectStore(STORE_ENTRIES);
      if (mode === "replace") store.clear();
      for (const r of records) store.put(r);
    });
  }
  entries = next.map((e) => { e._hay = null; return e; });
  sortEntries();
}

/* ── Passcode lock: enable, disable, unlock ──────────────────────────── */
async function enableLock(passcode) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveKey(passcode, salt, KDF_ITERATIONS);
  const verifier = await encryptBytes(key, new TextEncoder().encode(VERIFIER_PLAINTEXT));
  const prevKey = sessionKey;
  sessionKey = key;
  let records;
  try {
    records = [];
    for (const e of entries) records.push(await toRecord(e));
  } catch (e) { sessionKey = prevKey; throw e; }
  const lockRec = {
    key: "lock", enabled: true, salt, iterations: KDF_ITERATIONS,
    algo: "PBKDF2-SHA256 → AES-GCM-256", verifier, createdAt: Date.now()
  };
  try {
    // Entries and the lock record land in ONE transaction: either the journal
    // is fully encrypted and marked locked, or neither happened.
    await idbRun([STORE_ENTRIES, STORE_META], "readwrite", (tx) => {
      const store = tx.objectStore(STORE_ENTRIES);
      for (const r of records) store.put(r);
      tx.objectStore(STORE_META).put(lockRec);
    });
  } catch (e) { sessionKey = prevKey; throw e; }
  lockConfig = lockRec;
  lockStateUnknown = false;
  clearDraftMirror();
  syncLockButton();
  tellOtherTabs("lock-enabled");
}
async function disableLock(passcode) {
  if (!lockConfig) return;
  const key = await deriveKey(passcode, lockConfig.salt, lockConfig.iterations || KDF_ITERATIONS);
  try {
    const got = await decryptBytes(key, lockConfig.verifier.iv, lockConfig.verifier.ct);
    if (new TextDecoder().decode(got) !== VERIFIER_PLAINTEXT) throw new Error("BAD_PASSCODE");
  } catch (e) { throw new Error("BAD_PASSCODE"); }
  // The key stays in hand until the write has landed: if the transaction
  // fails, the journal is still locked and still readable in this session.
  const records = [];
  for (const e of entries) records.push(await toRecord(e, { plain: true }));
  await idbRun([STORE_ENTRIES, STORE_META], "readwrite", (tx) => {
    const store = tx.objectStore(STORE_ENTRIES);
    for (const r of records) store.put(r);
    tx.objectStore(STORE_META).delete("lock");
  });
  sessionKey = null;
  lockConfig = null;
  lockStateUnknown = false;
  syncLockButton();
}
async function unlockWith(passcode) {
  if (!lockConfig) return;
  const key = await deriveKey(passcode, lockConfig.salt, lockConfig.iterations || KDF_ITERATIONS);
  try {
    const got = await decryptBytes(key, lockConfig.verifier.iv, lockConfig.verifier.ct);
    if (new TextDecoder().decode(got) !== VERIFIER_PLAINTEXT) throw new Error("BAD_PASSCODE");
  } catch (e) { throw new Error("BAD_PASSCODE"); }
  sessionKey = key;
  await loadEntriesFromDb();
  locked = false;
}
function lockNow() {
  flushPendingSave(); // still holds the key here, so the flush is encrypted
  applyLockedState();
}
// Everything that has to be true the moment the journal closes. The toasts go
// with it: an Undo pending from before the lock cannot be honoured — restoring
// it without the key would write the entry back in the clear — and the toast
// host sits outside #app, so rebuilding the view does not remove it.
function applyLockedState() {
  dismissAllToasts();
  clearSearchTimer();
  sessionKey = null;
  entries = [];
  locked = true;
  filterState = { q: "", tag: null, mood: null, day: null };
  buildApp();
  syncLockButton();
  announce("Journal locked.", true);
}
function syncLockButton() {
  const btn = $("#lockNowBtn");
  if (!btn) return;
  btn.classList.toggle("hidden", !lockConfig || locked);
}

/* ── Other tabs ──────────────────────────────────────────────────────────
   A tab that was open before the lock was turned on would otherwise keep a
   stale "no lock" flag for its whole life. The write path re-reads the lock
   record before every keyless write, so nothing plaintext can land either way;
   this channel is what makes the other tab close promptly rather than at its
   next save. Same-origin only, and it carries no entry content. */
let lockChannel = null;
try { lockChannel = new BroadcastChannel("localjournal"); } catch (e) { lockChannel = null; }
function tellOtherTabs(kind) {
  try { if (lockChannel) lockChannel.postMessage({ kind }); } catch (e) {}
}
if (lockChannel) {
  lockChannel.onmessage = async (ev) => {
    const kind = ev && ev.data && ev.data.kind;
    if (kind !== "lock-enabled" || locked) return;
    // Drop the pending save rather than flushing it: this tab has no key, so a
    // flush could only be refused, and the text stays in the editor regardless.
    pendingEntry = null;
    clearTimeout(saveTimer); saveTimer = null;
    clearDraftMirror();
    try { lockConfig = await loadLockConfig(); } catch (e) { lockStateUnknown = true; }
    applyLockedState();
  };
}

function renderLockScreen(root) {
  const wrap = el("div", "lock-screen");
  const card = el("div", "lock-card");
  card.appendChild(svgIcon('<rect x="4" y="10" width="16" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>', "lock-ico"));
  // H1: the lock screen replaces the whole view, so this is the page's only
  // heading. As an H2 the screen had no H1 at all.
  card.appendChild(txt("h1", null, "Your journal is locked"));
  card.appendChild(txt("p", null, "Enter your passcode to open it. It is checked on this device. There is nowhere else to check it."));

  const label = txt("label", "sr-only", "Passcode");
  label.htmlFor = "unlockInput";
  const input = el("input");
  input.type = "password";
  input.id = "unlockInput";
  input.autocomplete = "current-password";
  input.setAttribute("aria-describedby", "unlockStatus");
  const btn = txt("button", "btn", "Unlock");
  btn.type = "button";
  const statusHost = el("div");
  statusHost.id = "unlockStatus";

  async function attempt() {
    const pass = input.value;
    if (!pass) { status(statusHost, "Enter your passcode to continue.", "note"); return; }
    btn.disabled = true;
    btn.textContent = "Checking…";
    try {
      await unlockWith(pass);
      input.value = "";
      syncLockButton();
      buildApp();
      announce("Journal unlocked.");
    } catch (e) {
      status(statusHost, friendly(e), "err");
      btn.disabled = false;
      btn.textContent = "Unlock";
      input.select();
    }
  }
  btn.onclick = attempt;
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); attempt(); } });

  card.appendChild(label);
  card.appendChild(input);
  card.appendChild(btn);
  card.appendChild(statusHost);
  wrap.appendChild(card);
  root.appendChild(wrap);
  setTimeout(() => { try { input.focus(); } catch (e) {} }, 0);
}

/* ── Settings view ───────────────────────────────────────────────────── */
function renderSettingsView(root) {
  pageHead(root, "Backup & lock", nat(
    "A backup is how your journal gets to another device, or back, if this browser's data is ever cleared.",
    "A backup is how your journal gets to another device, or back, if the app is ever deleted."));

  /* Export */
  const ex = el("div", "panel");
  ex.appendChild(txt("h2", null, "Export"));
  ex.appendChild(txt("p", "panel-sub", nat(
    "Files are built on your device and saved straight to your downloads.",
    "Files are built on your device, then handed to the share sheet so you choose where they go.")));
  const exStatus = el("div");
  const exRow = el("div", "btn-row");

  const jsonBtn = txt("button", "btn", "Full backup (JSON)");
  jsonBtn.type = "button";
  jsonBtn.onclick = () => {
    if (!entries.length) { status(exStatus, "There are no entries to export yet.", "note"); return; }
    try {
      deliverExport(new TextEncoder().encode(buildBackupJson()), `local-journal-backup-${stamp()}.json`, exStatus,
        `Saved a backup of ${plural(entries.length, "entry", "entries")}. This file is not encrypted. Keep it somewhere you trust.`,
        `Backed up ${plural(entries.length, "entry", "entries")} to the place you chose. This file is not encrypted. Keep it somewhere you trust.`,
        "ok", renderSettingsMeta);
    } catch (e) { status(exStatus, friendly(e), "err"); }
  };
  exRow.appendChild(jsonBtn);

  const mdBtn = txt("button", "btn ghost", "Readable copy (Markdown)");
  mdBtn.type = "button";
  mdBtn.onclick = () => {
    if (!entries.length) { status(exStatus, "There are no entries to export yet.", "note"); return; }
    try {
      deliverExport(new TextEncoder().encode(buildMarkdown()), `local-journal-${stamp()}.md`, exStatus,
        `Saved ${plural(entries.length, "entry", "entries")} as Markdown.`,
        `Exported ${plural(entries.length, "entry", "entries")} as Markdown to the place you chose.`,
        "ok");
    } catch (e) { status(exStatus, friendly(e), "err"); }
  };
  exRow.appendChild(mdBtn);

  const pdfBtn = txt("button", "btn ghost", "Printable copy (PDF)");
  pdfBtn.type = "button";
  pdfBtn.dataset.label = "Printable copy (PDF)";
  pdfBtn.onclick = async () => {
    pdfBtn.disabled = true;
    pdfBtn.textContent = "Building…";
    try { await exportPdf(exStatus); }
    catch (e) { status(exStatus, friendly(e), "err"); }
    pdfBtn.disabled = false;
    pdfBtn.textContent = pdfBtn.dataset.label;
  };
  exRow.appendChild(pdfBtn);
  ex.appendChild(exRow);
  ex.appendChild(exStatus);
  const metaLine = txt("p", "hint", "");
  metaLine.style.marginTop = "12px";
  ex.appendChild(metaLine);
  root.appendChild(ex);

  function renderSettingsMeta() {
    let last = null;
    try { last = localStorage.getItem(LAST_BACKUP_KEY); } catch (e) {}
    const d = last ? new Date(last) : null;
    metaLine.textContent = d && !isNaN(d.getTime())
      ? `Last export from this device: ${todayISO(d)}.`
      : "No export taken from this device yet.";
  }
  renderSettingsMeta();

  /* Import */
  const im = el("div", "panel");
  im.appendChild(txt("h2", null, "Import a backup"));
  im.appendChild(txt("p", "panel-sub", "Choose a Local Journal JSON backup. You'll see exactly what will change before anything is written."));
  const imStatus = el("div");
  const fileInput = el("input");
  fileInput.type = "file";
  fileInput.accept = ".json,application/json";
  fileInput.id = "importFile";
  fileInput.className = "sr-only";
  fileInput.tabIndex = -1;
  fileInput.setAttribute("aria-hidden", "true");
  // A real button rather than a <label for>: a label is not keyboard-focusable,
  // so the picker would be unreachable without a mouse.
  const pickBtn = txt("button", "btn ghost", "Choose a backup file");
  pickBtn.type = "button";
  pickBtn.onclick = () => fileInput.click();
  im.appendChild(pickBtn);
  im.appendChild(fileInput);
  im.appendChild(imStatus);
  root.appendChild(im);

  fileInput.addEventListener("change", async () => {
    const file = fileInput.files && fileInput.files[0];
    fileInput.value = "";
    if (!file) return;
    let text;
    try { text = await file.text(); }
    catch (e) { status(imStatus, friendly(new Error("READ_FAILED")), "err"); return; }
    let incoming;
    try { incoming = parseBackup(text); }
    catch (e) { status(imStatus, friendly(e), "err"); return; }
    showImportPreview(incoming, imStatus);
  });

  /* Passcode lock */
  const lk = el("div", "panel");
  lk.appendChild(txt("h2", null, "Passcode lock"));
  lk.appendChild(txt("p", "panel-sub", lockConfig
    ? "Your entries are encrypted on this device. They are readable only after you enter the passcode."
    : nat(
      "Off. Entries are stored on this device in plain form, readable by anything that can read this browser's storage.",
      "Off. Entries are stored on this device in plain form, readable by anything that can read this app's storage.")));

  const warn = txt("div", "status warn",
    "There is no reset. The passcode never leaves this device and is not stored anywhere, so if you forget it the entries cannot be opened again, not by you, not by anyone. Keep an exported backup somewhere safe.");
  lk.appendChild(warn);

  const lkRow = el("div", "btn-row");
  lkRow.style.marginTop = "14px";
  if (!lockConfig) {
    const on = txt("button", "btn", "Turn on the passcode lock");
    on.type = "button";
    on.onclick = () => showEnableLockModal();
    lkRow.appendChild(on);
  } else {
    const off = txt("button", "btn quiet", "Turn off the passcode lock");
    off.type = "button";
    off.onclick = () => showDisableLockModal();
    lkRow.appendChild(off);
    const now = txt("button", "btn ghost", "Lock now");
    now.type = "button";
    now.onclick = lockNow;
    lkRow.appendChild(now);
  }
  lk.appendChild(lkRow);
  const algoNote = txt("p", "hint",
    `When on: PBKDF2-HMAC-SHA256, ${KDF_ITERATIONS.toLocaleString()} iterations over a 16-byte random salt, into an AES-GCM-256 key held only in memory for the session.`);
  algoNote.style.marginTop = "12px";
  lk.appendChild(algoNote);
  root.appendChild(lk);

  /* Storage */
  const st = el("div", "panel");
  st.appendChild(txt("h2", null, "Storage on this device"));
  const stLine = txt("p", "panel-sub", "Checking…");
  st.appendChild(stLine);
  const dangerRow = el("div", "btn-row");
  const wipe = txt("button", "btn quiet", "Delete everything on this device");
  wipe.type = "button";
  wipe.onclick = () => showWipeModal();
  dangerRow.appendChild(wipe);
  st.appendChild(dangerRow);
  root.appendChild(st);

  (async () => {
    const parts = [`${plural(entries.length, "entry", "entries")} in this journal.`];
    try {
      if (navigator.storage && navigator.storage.estimate) {
        const est = await navigator.storage.estimate();
        if (est && est.usage != null && est.quota) {
          parts.push(nat(
            `This site is using about ${fmtBytes(est.usage)} of the ${fmtBytes(est.quota)} the browser allows it.`,
            `The journal is using about ${fmtBytes(est.usage)} of the ${fmtBytes(est.quota)} this device allows it.`));
        }
      }
    } catch (e) { /* estimate is a nicety, not a requirement */ }
    if (storageBlocked) parts.push(nat(
      "This browser is not keeping data between sessions, so entries will last only until the tab closes.",
      "The app is not keeping data between sessions, so entries will last only until you close it."));
    stLine.textContent = parts.join(" ");
  })();
}

function showImportPreview(incoming, statusHost) {
  const plan = planMerge(incoming);
  openModal((modal, close) => {
    modal.appendChild(txt("h3", null, "Import this backup?"));
    modal.appendChild(txt("p", null,
      `The file holds ${plural(plan.total, "entry", "entries")}. Your journal currently holds ${plural(entries.length, "entry", "entries")}.`));

    modal.appendChild(txt("p", "micro-label", "If you merge"));
    const ul = el("ul", "preview-list");
    ul.appendChild(txt("li", null, `${plural(plan.added, "entry", "entries")} would be added.`));
    ul.appendChild(txt("li", null, `${plural(plan.updated, "entry", "entries")} would be replaced by a newer version from the file.`));
    ul.appendChild(txt("li", null, `${plural(plan.unchanged, "entry", "entries")} would be left as they are.`));
    ul.appendChild(txt("li", null, "Nothing already in your journal is removed."));
    modal.appendChild(ul);

    modal.appendChild(txt("p", "micro-label", "If you replace"));
    const ul2 = el("ul", "preview-list");
    ul2.appendChild(txt("li", null, `All ${plural(entries.length, "entry", "entries")} here are deleted first.`));
    // The verb has to agree with the count as well as the noun — plural()
    // inflects the noun only, so a one-entry file read "The 1 entry … become".
    ul2.appendChild(txt("li", null,
      `The ${plural(plan.total, "entry", "entries")} from the file ${plan.total === 1 ? "becomes" : "become"} your whole journal.`));
    modal.appendChild(ul2);

    const actions = el("div", "modal-actions");
    const merge = txt("button", "btn", "Merge");
    merge.type = "button";
    const replace = txt("button", "btn quiet", "Replace everything");
    replace.type = "button";
    const cancel = txt("button", "btn ghost", "Cancel");
    cancel.type = "button";
    cancel.onclick = () => { close(); status(statusHost, "Nothing was imported.", "note"); };

    async function run(mode) {
      merge.disabled = replace.disabled = cancel.disabled = true;
      merge.textContent = mode === "merge" ? "Merging…" : "Merge";
      replace.textContent = mode === "replace" ? "Replacing…" : "Replace everything";
      try {
        await applyImport(incoming, mode);
        close();
        listLimit = PAGE_SIZE;
        // A toast, not an inline status: buildApp() rebuilds the whole view
        // below, which would take an inline message down with it.
        buildApp();
        showToast(mode === "merge"
          ? `Merged. Your journal now holds ${plural(entries.length, "entry", "entries")}.`
          : `Replaced. Your journal now holds ${plural(entries.length, "entry", "entries")}.`);
      } catch (e) {
        close();
        status(statusHost, friendly(e), "err");
      }
    }
    merge.onclick = () => run("merge");
    replace.onclick = () => run("replace");
    actions.appendChild(merge);
    actions.appendChild(replace);
    modal.appendChild(actions);
    const cancelRow = el("div", "modal-actions");
    cancelRow.appendChild(cancel);
    modal.appendChild(cancelRow);
  }, { wide: true });
}

function showEnableLockModal() {
  openModal((modal, close) => {
    modal.appendChild(txt("h3", null, "Turn on the passcode lock"));
    modal.appendChild(txt("p", null,
      nat(
        "From now on your entries are stored encrypted on this device, and you'll need this passcode every time you open the journal. Existing entries are rewritten encrypted too, though the browser reclaims the space the earlier copies used in its own time, to be certain those are gone, export a backup and then clear this site's data.",
        "From now on your entries are stored encrypted on this device, and you'll need this passcode every time you open the journal. Existing entries are rewritten encrypted too, though the system reclaims the space the earlier copies used in its own time, to be certain those are gone, export a backup and then delete and reinstall the app.")));
    const warnBox = txt("div", "status warn",
      "There is no reset and no recovery. Nothing about the passcode is stored, if you forget it, the entries stay encrypted for good. Export a backup first if you'd like a readable copy.");
    modal.appendChild(warnBox);

    const f1 = el("div", "field");
    f1.style.marginTop = "16px";
    const l1 = txt("label", null, "Passcode");
    l1.htmlFor = "lockPass1";
    const i1 = el("input"); i1.type = "password"; i1.id = "lockPass1"; i1.autocomplete = "new-password";
    i1.setAttribute("aria-describedby", "lockPassHint");
    const h1 = txt("p", "hint", "At least 6 characters. Longer is meaningfully stronger here.");
    h1.id = "lockPassHint";
    f1.appendChild(l1); f1.appendChild(i1); f1.appendChild(h1);
    modal.appendChild(f1);

    const f2 = el("div", "field");
    const l2 = txt("label", null, "Passcode again");
    l2.htmlFor = "lockPass2";
    const i2 = el("input"); i2.type = "password"; i2.id = "lockPass2"; i2.autocomplete = "new-password";
    f2.appendChild(l2); f2.appendChild(i2);
    modal.appendChild(f2);

    const ackWrap = el("label", "field");
    ackWrap.style.display = "flex";
    ackWrap.style.gap = "9px";
    ackWrap.style.alignItems = "flex-start";
    const ack = el("input");
    ack.type = "checkbox";
    ack.id = "lockAck";
    ack.style.width = "auto";
    ack.style.marginTop = "3px";
    ackWrap.appendChild(ack);
    ackWrap.appendChild(txt("span", null, "I understand a forgotten passcode cannot be reset, and the entries cannot be recovered."));
    modal.appendChild(ackWrap);

    const inner = el("div");
    modal.appendChild(inner);

    const actions = el("div", "modal-actions");
    const go = txt("button", "btn", "Turn it on");
    go.type = "button";
    const cancel = txt("button", "btn ghost", "Cancel");
    cancel.type = "button";
    cancel.onclick = close;
    go.onclick = async () => {
      const p1 = i1.value, p2 = i2.value;
      if (p1.length < 6) { status(inner, "Use at least 6 characters.", "note"); i1.focus(); return; }
      if (p1 !== p2) { status(inner, "The two passcodes don't match.", "note"); i2.focus(); return; }
      if (!ack.checked) { status(inner, "Please confirm you understand there is no reset.", "note"); ack.focus(); return; }
      go.disabled = true; cancel.disabled = true;
      go.textContent = "Encrypting…";
      try {
        await enableLock(p1);
        close();
        buildApp();
        showToast(`The passcode lock is on. ${plural(entries.length, "entry", "entries")} are now stored encrypted on this device.`, null, null, 9000);
      } catch (e) {
        go.disabled = false; cancel.disabled = false;
        go.textContent = "Turn it on";
        status(inner, friendly(e), "err");
      }
    };
    actions.appendChild(go);
    actions.appendChild(cancel);
    modal.appendChild(actions);
  }, { wide: true });
}

function showDisableLockModal() {
  openModal((modal, close) => {
    modal.appendChild(txt("h3", null, "Turn off the passcode lock"));
    modal.appendChild(txt("p", null,
      "Enter your passcode to confirm. Your entries are re-saved unencrypted on this device, and the journal opens without a passcode from then on."));
    const f = el("div", "field");
    const l = txt("label", null, "Passcode");
    l.htmlFor = "unlockOffPass";
    const i = el("input"); i.type = "password"; i.id = "unlockOffPass"; i.autocomplete = "current-password";
    f.appendChild(l); f.appendChild(i);
    modal.appendChild(f);
    const inner = el("div");
    modal.appendChild(inner);
    const actions = el("div", "modal-actions");
    const go = txt("button", "btn", "Turn it off");
    go.type = "button";
    const cancel = txt("button", "btn ghost", "Cancel");
    cancel.type = "button";
    cancel.onclick = close;
    go.onclick = async () => {
      if (!i.value) { status(inner, "Enter your passcode to continue.", "note"); return; }
      go.disabled = true; cancel.disabled = true;
      go.textContent = "Working…";
      try {
        await disableLock(i.value);
        close();
        buildApp();
        showToast("The passcode lock is off. Entries are stored unencrypted on this device again.", null, null, 9000);
      } catch (e) {
        go.disabled = false; cancel.disabled = false;
        go.textContent = "Turn it off";
        status(inner, friendly(e), "err");
      }
    };
    actions.appendChild(go);
    actions.appendChild(cancel);
    modal.appendChild(actions);
  });
}

function showWipeModal() {
  let keepBtn = null;
  openModal((modal, close) => {
    modal.appendChild(txt("h3", null, "Delete everything on this device?"));
    modal.appendChild(txt("p", null,
      nat(
        `This removes all ${plural(entries.length, "entry", "entries")} and any passcode lock from this browser. There is no server copy, so an exported backup is the only way back. The browser reclaims the space in its own time; to be certain nothing lingers in its storage files, clear this site's data afterwards.`,
        `This removes all ${plural(entries.length, "entry", "entries")} and any passcode lock from this app on this device. There is no server copy, so an exported backup is the only way back. The system reclaims the space in its own time; to be certain nothing lingers in the app's storage files, delete and reinstall the app afterwards.`)));
    const inner = el("div");
    modal.appendChild(inner);
    const actions = el("div", "modal-actions");
    const go = txt("button", "btn danger", "Delete everything");
    go.type = "button";
    const cancel = txt("button", "btn ghost", "Keep my journal");
    cancel.type = "button";
    cancel.onclick = close;
    keepBtn = cancel; // opening focus goes to the safe choice, not the delete
    go.onclick = async () => {
      go.disabled = true; cancel.disabled = true;
      go.textContent = "Deleting…";
      try {
        if (db) {
          await idbRun([STORE_ENTRIES, STORE_META], "readwrite", (tx) => {
            tx.objectStore(STORE_ENTRIES).clear();
            tx.objectStore(STORE_META).clear();
          });
        }
        entries = [];
        lockConfig = null;
        sessionKey = null;
        locked = false;
        clearDraftMirror();
        syncLockButton();
        close();
        buildApp();
        showToast("Everything on this device has been deleted.");
      } catch (e) {
        go.disabled = false; cancel.disabled = false;
        go.textContent = "Delete everything";
        status(inner, friendly(e), "err");
      }
    };
    // Safe choice first in DOM order as well as in focus order.
    actions.appendChild(cancel);
    actions.appendChild(go);
    modal.appendChild(actions);
  }, { initial: () => keepBtn });
}

/* ── Loading ─────────────────────────────────────────────────────────── */
async function loadEntriesFromDb() {
  entries = [];
  if (!db) return;
  let recs = [];
  try { recs = await idbGetAll(STORE_ENTRIES); }
  catch (e) { showBanner(friendly(e), true); return; }
  let unreadable = 0;
  for (const r of recs) {
    const e = await fromRecord(r);
    if (e) entries.push(e); else unreadable++;
  }
  sortEntries();
  if (unreadable) {
    showBanner(`${plural(unreadable, "entry", "entries")} on this device couldn't be read and were left untouched.`, false);
  }
}

/* ── Boot ────────────────────────────────────────────────────────────── */
applyTheme(readThemePref());
(function initTheme() {
  const btn = $("#themeToggle");
  if (btn) btn.onclick = cycleTheme;
  if (themeMedia) {
    const onChange = () => { if (readThemePref() === "system") applyTheme("system"); };
    if (themeMedia.addEventListener) themeMedia.addEventListener("change", onChange);
    else if (themeMedia.addListener) themeMedia.addListener(onChange); // older Safari
  }
})();

try { $("#lockNowBtn").onclick = lockNow; } catch (e) {}

// "Skip to content" moves focus; it must not navigate. The app is a hash
// router, so letting the browser set location.hash to "#mainContent" would
// send a keyboard user from wherever they were back to the Write view — the
// opposite of what the first tab stop on the page should do.
(function wireSkipLink() {
  const skip = document.querySelector(".skip-link");
  const main = document.getElementById("mainContent");
  if (!skip || !main) return;
  skip.addEventListener("click", (ev) => {
    ev.preventDefault();
    main.focus();
    // main already fills the scroll area, so focus() alone would not move the
    // page. Scroll to its top the way the anchor used to; :root's
    // scroll-padding-top keeps it clear of the sticky topbar.
    try { main.scrollIntoView({ block: "start" }); } catch (e) { window.scrollTo(0, 0); }
  });
})();

window.addEventListener("hashchange", () => {
  // Only the app's own routes rebuild the view. A bare fragment such as
  // "#mainContent" from an in-page anchor is not a route, and falling through
  // to the default route would throw away the screen the user was on.
  const h = location.hash || "";
  if (h && !h.startsWith("#/")) return;
  buildApp();
});

/* The one sentence that is baked into index.html rather than built here says
   "in this browser", which is true on the web and false in the app. Rewrite it
   on native only; the web build never enters this branch, so its markup renders
   exactly as authored. */
if (IS_NATIVE) {
  const sidePrivacy = $(".side-privacy-text");
  /* sidebar privacy card removed 2026-08-08 (Eden: privacy was overly repeated) —
     the topbar pill carries the promise; nothing to rewrite natively anymore */
}

(async function boot() {
  if (!storageProbeOk()) {
    storageBlocked = true;
    showBanner(nat(
      "This browser isn't saving data between sessions, so entries will only last until you close the tab. Export a backup if you want to keep them.",
      "The app isn't saving data between sessions, so entries will only last until you close it. Export a backup if you want to keep them."), false);
  }
  try { db = await openDb(); }
  catch (e) {
    db = null;
    storageBlocked = true;
    showBanner(friendly(new Error("NO_DB")), true);
  }
  try { lockConfig = await loadLockConfig(); }
  catch (e) { lockConfig = null; lockStateUnknown = true; }
  if (lockStateUnknown) {
    showBanner("Couldn't check whether the passcode lock is on, so nothing new will be saved on this page. Reload to try again. Anything you type meanwhile can still be copied out.", true);
  }
  if (lockConfig) {
    locked = true;
  } else {
    await loadEntriesFromDb();
    await recoverDraftMirror();
  }
  syncLockButton();
  try { buildApp(); } catch (e) { showBanner("Couldn't draw the page. Reloading may fix it.", true); }
})();

// Tidy up any export left in the cache folder by an earlier run. Native only —
// the web has no such folder and never enters this branch. Started after boot
// and never awaited, so it cannot delay the journal appearing, and every
// failure is swallowed: housekeeping is not worth a message.
if (IS_NATIVE) {
  try { sweepStaleExports().catch(() => {}); } catch (e) { /* housekeeping only */ }
}

// Offline shell caching. Registered last so a failure here cannot stop anything
// above it from running.
(function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  // The native shell already has every file inside the app, so there is nothing
  // for a service worker to make available offline — and Capacitor serves from
  // capacitor://localhost, which would otherwise satisfy the localhost test
  // below. Left ungated it could also pin an old app version's files across an
  // App Store update. Web behaviour is unchanged: IS_NATIVE is false there.
  if (IS_NATIVE) return;
  if (location.protocol !== "https:" && location.hostname !== "localhost" && location.hostname !== "127.0.0.1") return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => { /* offline caching is a nicety, not a requirement */ });
  });
})();

// Opening the on-screen keyboard pans the visual viewport down to reveal the
// focused field without moving the layout viewport underneath it. The header is
// stuck to the layout viewport, so it rides up out of sight and the status bar
// comes down on whatever is underneath instead. Publishing the pan lets the
// stylesheet hold the header against the top of what the reader can actually
// see. Browsers with no visualViewport resize the layout viewport rather than
// panning, which never separates the two, so the 0px default is right there.
// Last in the file for the same reason the block above it is: nothing after
// this depends on it.
(function trackViewportPan() {
  const vv = window.visualViewport;
  if (!vv) return;
  const root = document.documentElement;
  let lastPan = null;
  let lastHeight = null;
  const sync = () => {
    // Pinch-zoom offsets and shrinks the visual viewport as well, and the old
    // behaviour is the right one there: a header that rode along would sit at
    // zoom scale on top of the very thing the reader zoomed in to look at, and a
    // dialog sized to the zoomed view would be a slot rather than a dialog. Zero
    // means "no useful measurement" and lets the stylesheet's own fallback win.
    const measured = vv.scale > 1 ? null : vv;
    const pan = measured ? Math.max(0, Math.round(measured.offsetTop)) : 0;
    const height = measured ? Math.round(measured.height) : 0;
    if (pan !== lastPan) {
      lastPan = pan;
      root.style.setProperty("--viewport-pan", pan + "px");
    }
    if (height !== lastHeight) {
      lastHeight = height;
      if (height) root.style.setProperty("--viewport-height", height + "px");
      else root.style.removeProperty("--viewport-height");
    }
  };
  vv.addEventListener("resize", sync);
  vv.addEventListener("scroll", sync);
  sync();
})();
