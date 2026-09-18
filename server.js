require('dotenv').config();
const express = require('express');
const multer = require('multer');
const QRCode = require('qrcode');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD; // change this!
// Where the FRONTEND is hosted. The QR code points to <FRONTEND_URL>/review.html?id=...
// Use your LAN IP (not localhost) if people will scan the QR with their phones.
const FRONTEND_URL = (process.env.FRONTEND_URL);
// Which origin may call this API from a browser ('*' = any origin)
const CORS_ORIGIN = process.env.CORS_ORIGIN;

const DATA_DIR = path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const DB_FILE = path.join(DATA_DIR, 'db.json');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

/* ---------- tiny JSON "database" ---------- */
function readDB() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch { return { sessions: [], reviews: [] }; }
}
function writeDB(db) { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }

/* ---------- admin auth (simple token) ---------- */
const tokens = new Set();
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}
function requireAdmin(req, res, next) {
  if (tokens.has(req.get('x-admin-token'))) return next();
  res.status(401).json({ error: 'Admin login required' });
}

/* ---------- image upload ---------- */
const EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' };
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => cb(null, crypto.randomBytes(12).toString('hex') + EXT[file.mimetype])
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(EXT[file.mimetype] ? null : new Error('Only JPG, PNG, WEBP or GIF images are allowed'), !!EXT[file.mimetype])
}).single('image');

/* ---------- helpers ---------- */
const reviewUrl = id => `${FRONTEND_URL}/review.html?id=${id}`;
const makeQR = url => QRCode.toDataURL(url, { width: 480, margin: 2, color: { dark: '#0b1226', light: '#ffffff' } });

function stats(reviews) {
  const count = reviews.length;
  const avg = count ? reviews.reduce((s, r) => s + r.rating, 0) / count : 0;
  return { count, average: Math.round(avg * 10) / 10 };
}

const app = express();

/* ---------- CORS (lets the separately hosted frontend call this API) ---------- */
app.use((req, res, next) => {
  res.set({
    'Access-Control-Allow-Origin': CORS_ORIGIN,
    'Access-Control-Allow-Headers': 'Content-Type, x-admin-token',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Cross-Origin-Resource-Policy': 'cross-origin'   // allow <img> from the frontend origin
  });
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.json({ limit: '50kb' }));
app.use('/uploads', express.static(UPLOAD_DIR));
app.get('/', (req, res) => res.json({ status: 'ok', service: 'session-review-api' }));

/* ---------- admin API ---------- */
app.post('/api/admin/login', (req, res) => {
  if (!safeEqual(req.body.password || '', ADMIN_PASSWORD)) return res.status(401).json({ error: 'Wrong password' });
  const token = crypto.randomBytes(24).toString('hex');
  tokens.add(token);
  res.json({ token });
});

app.post('/api/sessions', requireAdmin, (req, res) => {
  upload(req, res, async err => {
    if (err) return res.status(400).json({ error: err.message });
    const name = (req.body.name || '').trim();
    const description = (req.body.description || '').trim();
    if (!name || !description || !req.file) {
      if (req.file) fs.unlink(req.file.path, () => {});
      return res.status(400).json({ error: 'Image, session name and description are all required' });
    }
    const session = {
      id: crypto.randomBytes(5).toString('hex'),
      name: name.slice(0, 120),
      description: description.slice(0, 2000),
      image: req.file.filename,
      createdAt: new Date().toISOString()
    };
    const db = readDB();
    db.sessions.unshift(session);
    writeDB(db);
    const url = reviewUrl(session.id);
    res.status(201).json({ session, reviewUrl: url, qr: await makeQR(url) });
  });
});

app.get('/api/sessions', requireAdmin, (req, res) => {
  const db = readDB();
  res.json(db.sessions.map(s => ({
    ...s, imageUrl: `/uploads/${s.image}`,
    ...stats(db.reviews.filter(r => r.sessionId === s.id))
  })));
});

app.get('/api/sessions/:id/qr', requireAdmin, async (req, res) => {
  const s = readDB().sessions.find(x => x.id === req.params.id);
  if (!s) return res.status(404).json({ error: 'Session not found' });
  const url = reviewUrl(s.id);
  res.json({ reviewUrl: url, qr: await makeQR(url) });
});

app.get('/api/sessions/:id/reviews', requireAdmin, (req, res) => {
  const db = readDB();
  const s = db.sessions.find(x => x.id === req.params.id);
  if (!s) return res.status(404).json({ error: 'Session not found' });
  const reviews = db.reviews.filter(r => r.sessionId === s.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  res.json({ session: { ...s, imageUrl: `/uploads/${s.image}` }, ...stats(reviews), reviews });
});

app.delete('/api/sessions/:id', requireAdmin, (req, res) => {
  const db = readDB();
  const s = db.sessions.find(x => x.id === req.params.id);
  if (!s) return res.status(404).json({ error: 'Session not found' });
  db.sessions = db.sessions.filter(x => x.id !== s.id);
  db.reviews = db.reviews.filter(r => r.sessionId !== s.id);
  writeDB(db);
  fs.unlink(path.join(UPLOAD_DIR, s.image), () => {});
  res.json({ ok: true });
});

/* ---------- public API (what the QR page uses) ---------- */
app.get('/api/public/sessions/:id', (req, res) => {
  const s = readDB().sessions.find(x => x.id === req.params.id);
  if (!s) return res.status(404).json({ error: 'This session does not exist' });
  res.json({ id: s.id, name: s.name, description: s.description, imageUrl: `/uploads/${s.image}` });
});

app.post('/api/public/sessions/:id/reviews', (req, res) => {
  const db = readDB();
  if (!db.sessions.some(x => x.id === req.params.id)) return res.status(404).json({ error: 'This session does not exist' });
  const rating = Number(req.body.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) return res.status(400).json({ error: 'Please choose a rating from 1 to 5 stars' });
  const comment = String(req.body.comment || '').trim().slice(0, 1000); // optional
  db.reviews.push({ id: crypto.randomBytes(6).toString('hex'), sessionId: req.params.id, rating, comment, createdAt: new Date().toISOString() });
  writeDB(db);
  res.status(201).json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Review API running on http://localhost:${PORT}`);
  console.log(`QR codes will point to ${FRONTEND_URL}/review.html?id=...`);
  console.log('Admin password loaded from .env');
});
