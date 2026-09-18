require('dotenv').config();            // must stay the first line

const express = require('express');
const mongoose = require('mongoose');
const multer = require('multer');
const QRCode = require('qrcode');
const crypto = require('crypto');

/* ---------- config ---------- */
const PORT = process.env.PORT || 3000;
const { ADMIN_PASSWORD, MONGODB_URI } = process.env;
const FRONTEND_URL = (process.env.FRONTEND_URL || 'http://localhost:5500').replace(/\/$/, '');
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';

if (!ADMIN_PASSWORD || !MONGODB_URI) {
  console.error('Missing ADMIN_PASSWORD or MONGODB_URI. Add them to your .env file.');
  process.exit(1);
}

/* ---------- models ---------- */
// Images live in their own collection so listing sessions never loads image bytes.
const Image = mongoose.model('Image', new mongoose.Schema({
  data: { type: Buffer, required: true },
  contentType: { type: String, required: true }
}));

const Session = mongoose.model('Session', new mongoose.Schema({
  sid: { type: String, unique: true, index: true },   // short public id used in the QR link
  name: { type: String, required: true, maxlength: 120 },
  description: { type: String, required: true, maxlength: 2000 },
  imageId: { type: mongoose.Schema.Types.ObjectId, ref: 'Image', required: true },
  createdAt: { type: Date, default: Date.now }
}));

const Review = mongoose.model('Review', new mongoose.Schema({
  sessionId: { type: String, required: true, index: true },   // Session.sid
  name: { type: String, required: true, maxlength: 80 },        // reviewer details (all compulsory)
  department: { type: String, required: true, maxlength: 50 },
  year: { type: Number, required: true, min: 1, max: 4 },
  rollNo: { type: String, required: true, maxlength: 30 },
  rating: { type: Number, required: true, min: 1, max: 5 },   // compulsory
  comment: { type: String, default: '', maxlength: 1000 },     // optional
  createdAt: { type: Date, default: Date.now }
}));

/* ---------- helpers ---------- */
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const reviewUrl = sid => `${FRONTEND_URL}/review.html?id=${sid}`;
const makeQR = url => QRCode.toDataURL(url, { width: 480, margin: 2, color: { dark: '#0b1226', light: '#ffffff' } });
const imageUrl = s => `/api/images/${s.imageId}`;
const publicSession = s => ({ id: s.sid, name: s.name, description: s.description, imageUrl: imageUrl(s), createdAt: s.createdAt });
const round1 = n => Math.round(n * 10) / 10;

/* ---------- admin auth (simple in-memory token) ---------- */
const tokens = new Set();
const safeEqual = (a, b) =>
  crypto.timingSafeEqual(
    crypto.createHash('sha256').update(String(a)).digest(),
    crypto.createHash('sha256').update(String(b)).digest()
  );
function requireAdmin(req, res, next) {
  if (tokens.has(req.get('x-admin-token'))) return next();
  res.status(401).json({ error: 'Admin login required' });
}

/* ---------- image upload (kept in memory, then saved to MongoDB) ---------- */
const ALLOWED = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) =>
    cb(ALLOWED.includes(file.mimetype) ? null : new Error('Only JPG, PNG, WEBP or GIF images are allowed'), ALLOWED.includes(file.mimetype))
}).single('image');

/* ---------- app ---------- */
const app = express();

app.use((req, res, next) => {                       // CORS for the separately hosted frontend
  res.set({
    'Access-Control-Allow-Origin': CORS_ORIGIN,
    'Access-Control-Allow-Headers': 'Content-Type, x-admin-token',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Cross-Origin-Resource-Policy': 'cross-origin'
  });
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.json({ limit: '50kb' }));

app.get('/', (req, res) => res.json({ status: 'ok', service: 'session-review-api' }));

/* ----- images ----- */
app.get('/api/images/:id', wrap(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.sendStatus(404);
  const img = await Image.findById(req.params.id);
  if (!img) return res.sendStatus(404);
  res.set({ 'Content-Type': img.contentType, 'Cache-Control': 'public, max-age=31536000, immutable' });
  res.send(img.data);
}));

/* ----- admin ----- */
app.post('/api/admin/login', (req, res) => {
  if (!safeEqual((req.body && req.body.password) || '', ADMIN_PASSWORD)) return res.status(401).json({ error: 'Wrong password' });
  const token = crypto.randomBytes(24).toString('hex');
  tokens.add(token);
  res.json({ token });
});

app.post('/api/sessions', requireAdmin, (req, res, next) => {
  upload(req, res, wrap(async err => {
    if (err) return res.status(400).json({ error: err.message });
    const name = (req.body.name || '').trim();
    const description = (req.body.description || '').trim();
    if (!name || !description || !req.file) {
      return res.status(400).json({ error: 'Image, session name and description are all required' });
    }
    const img = await Image.create({ data: req.file.buffer, contentType: req.file.mimetype });
    const session = await Session.create({
      sid: crypto.randomBytes(5).toString('hex'),
      name: name.slice(0, 120),
      description: description.slice(0, 2000),
      imageId: img._id
    });
    const url = reviewUrl(session.sid);
    res.status(201).json({ session: publicSession(session), reviewUrl: url, qr: await makeQR(url) });
  }, next));
});

app.get('/api/sessions', requireAdmin, wrap(async (req, res) => {
  const [sessions, agg] = await Promise.all([
    Session.find().sort({ createdAt: -1 }),
    Review.aggregate([{ $group: { _id: '$sessionId', count: { $sum: 1 }, avg: { $avg: '$rating' } } }])
  ]);
  const byId = Object.fromEntries(agg.map(a => [a._id, a]));
  res.json(sessions.map(s => ({
    ...publicSession(s),
    count: byId[s.sid]?.count || 0,
    average: round1(byId[s.sid]?.avg || 0)
  })));
}));

app.get('/api/sessions/:id/qr', requireAdmin, wrap(async (req, res) => {
  const s = await Session.findOne({ sid: req.params.id });
  if (!s) return res.status(404).json({ error: 'Session not found' });
  const url = reviewUrl(s.sid);
  res.json({ reviewUrl: url, qr: await makeQR(url) });
}));

app.get('/api/sessions/:id/reviews', requireAdmin, wrap(async (req, res) => {
  const s = await Session.findOne({ sid: req.params.id });
  if (!s) return res.status(404).json({ error: 'Session not found' });
  const reviews = await Review.find({ sessionId: s.sid }).sort({ createdAt: -1 });
  const count = reviews.length;
  const average = count ? round1(reviews.reduce((sum, r) => sum + r.rating, 0) / count) : 0;
  res.json({
    session: publicSession(s), count, average,
    reviews: reviews.map(r => ({
      id: r._id, name: r.name, department: r.department, year: r.year, rollNo: r.rollNo,
      rating: r.rating, comment: r.comment, createdAt: r.createdAt
    }))
  });
}));

app.delete('/api/sessions/:id', requireAdmin, wrap(async (req, res) => {
  const s = await Session.findOneAndDelete({ sid: req.params.id });
  if (!s) return res.status(404).json({ error: 'Session not found' });
  await Promise.all([Image.findByIdAndDelete(s.imageId), Review.deleteMany({ sessionId: s.sid })]);
  res.json({ ok: true });
}));

/* ----- public (used by the QR page) ----- */
app.get('/api/public/sessions/:id', wrap(async (req, res) => {
  const s = await Session.findOne({ sid: req.params.id });
  if (!s) return res.status(404).json({ error: 'This session does not exist' });
  const { id, name, description, imageUrl } = publicSession(s);
  res.json({ id, name, description, imageUrl });
}));

app.post('/api/public/sessions/:id/reviews', wrap(async (req, res) => {
  if (!(await Session.exists({ sid: req.params.id }))) return res.status(404).json({ error: 'This session does not exist' });

  const clean = v => String(v ?? '').trim().replace(/\s+/g, ' ');
  const name = clean(req.body.name);
  const department = clean(req.body.department);
  const rollNo = clean(req.body.rollNo).toUpperCase();
  const year = Number(req.body.year);
  const rating = Number(req.body.rating);

  // reviewer details are compulsory
  if (name.length < 2 || name.length > 80) return res.status(400).json({ error: 'Please enter your full name' });
  if (!department || department.length > 50) return res.status(400).json({ error: 'Please enter your department' });
  if (![1, 2, 3, 4].includes(year)) return res.status(400).json({ error: 'Please select your year' });
  if (!rollNo || rollNo.length > 30) return res.status(400).json({ error: 'Please enter your roll number' });
  // rating is compulsory, the written review is optional
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return res.status(400).json({ error: 'Please choose a rating from 1 to 5 stars' });
  }
  const comment = String(req.body.comment || '').trim().slice(0, 1000);

  await Review.create({ sessionId: req.params.id, name, department, year, rollNo, rating, comment });
  res.status(201).json({ ok: true });
}));

/* ----- error handler ----- */
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Server error. Please try again.' });
});

/* ---------- start ---------- */
mongoose.connect(MONGODB_URI)
  .then(() => {
    console.log('Connected to MongoDB');
    app.listen(PORT, () => {
      console.log(`Review API running on http://localhost:${PORT}`);
      console.log(`QR codes will point to ${FRONTEND_URL}/review.html?id=...`);
    });
  })
  .catch(err => {
    console.error('MongoDB connection failed:', err.message);
    process.exit(1);
  });