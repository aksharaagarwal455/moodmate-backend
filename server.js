const express    = require('express');
const cors       = require('cors');
const axios      = require('axios');
const jwt        = require('jsonwebtoken');
const rateLimit  = require('express-rate-limit');
require('dotenv').config();

const { getAdvice } = require('./gptController');
const authRoutes    = require('./authRoutes');
const db            = require('./db');

const app = express();

// ─── CORS — only allow your frontend ──────────────────────────────────────
const allowedOrigins = [
  'http://localhost:3000',
  'https://moodmate-lilac.vercel.app',  // ← yeh add karo
  process.env.FRONTEND_URL,
].filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (e.g. mobile apps, curl, Postman)
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error(`CORS: origin ${origin} not allowed`));
  },
  credentials: true,
}));

app.use(express.json());

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('FATAL: JWT_SECRET not set in .env — refusing to start.');
  process.exit(1);
}

// ─── Rate limiting ─────────────────────────────────────────────────────────
// Auth endpoints: strict (5 requests / 15 min per IP)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: 'Too many attempts. Please try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// General API: lenient (100 requests / 15 min per IP)
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Too many requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
});

app.use('/auth/login',  authLimiter);
app.use('/auth/signup', authLimiter);
app.use('/tracks',      apiLimiter);
app.use('/advice',      apiLimiter);

// ─── Auth middleware ───────────────────────────────────────────────────────
function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'No token provided.' });
  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.userId;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token.' });
  }
}

// ─── Auth routes ───────────────────────────────────────────────────────────
app.use('/auth', authRoutes);

// ─── Mood → iTunes search terms ────────────────────────────────────────────
const VALID_MOODS = new Set(['happy','sad','angry','surprised','disgusted','fearful','neutral','calm']);

const moodToSearchTerm = {
  happy:     'happy upbeat pop',
  sad:       'sad emotional acoustic',
  angry:     'intense rock energy',
  surprised: 'exciting upbeat',
  disgusted: 'calming ambient chill',
  fearful:   'soothing peaceful instrumental',
  neutral:   'lofi chill beats',
  calm:      'calm peaceful ambient',
};

// ─── GET /tracks/:mood ─────────────────────────────────────────────────────
app.get('/tracks/:mood', async (req, res) => {
  const mood = req.params.mood.toLowerCase().trim();

  if (!VALID_MOODS.has(mood)) {
    return res.status(400).json({ error: `Unknown mood: "${mood}". Valid: ${[...VALID_MOODS].join(', ')}` });
  }

  try {
    const response = await axios.get('https://itunes.apple.com/search', {
      params: { term: moodToSearchTerm[mood], media: 'music', limit: 9, entity: 'song' },
      timeout: 8000,
    });

    const items = response.data.results;
    if (!items || items.length === 0) {
      return res.status(404).json({ error: 'No songs found for this mood.' });
    }

    const tracks = items.map(item => ({
      id:      item.trackId,
      name:    item.trackName,
      artist:  item.artistName,
      img:     item.artworkUrl100?.replace('100x100', '300x300'),
      preview: item.previewUrl   || null,
      link:    item.trackViewUrl || null,
    }));

    res.json({ tracks, playlist: null });
  } catch (error) {
    console.error('iTunes API error:', error.message);
    res.status(500).json({ error: 'Failed to fetch tracks.' });
  }
});

// ─── GET /advice/:mood ─────────────────────────────────────────────────────
app.get('/advice/:mood', async (req, res) => {
  const mood = req.params.mood.toLowerCase().trim();
  if (!VALID_MOODS.has(mood)) {
    return res.status(400).json({ error: 'Unknown mood.' });
  }
  try {
    const advice = await getAdvice(mood);
    res.json({ advice });
  } catch (error) {
    console.error('Advice route error:', error.message);
    res.status(500).json({ error: 'Failed to get advice.' });
  }
});

// ─── POST /mood/log ────────────────────────────────────────────────────────
app.post('/mood/log', authMiddleware, async (req, res) => {
  const mood = req.body.mood?.toString().toLowerCase().trim();

  if (!mood) return res.status(400).json({ error: 'Mood is required.' });
  if (!VALID_MOODS.has(mood)) return res.status(400).json({ error: 'Invalid mood value.' });

  try {
    await db.query('INSERT INTO mood_logs (user_id, mood) VALUES (?, ?)', [req.userId, mood]);
    res.json({ message: 'Mood logged successfully.' });
  } catch (err) {
    console.error('Mood log error:', err.message);
    res.status(500).json({ error: 'Failed to log mood.' });
  }
});

// ─── GET /mood/history ─────────────────────────────────────────────────────
app.get('/mood/history', authMiddleware, async (req, res) => {
  try {
    const [rows] = await db.query(
      'SELECT mood, logged_at FROM mood_logs WHERE user_id = ? ORDER BY logged_at DESC LIMIT 50',
      [req.userId]
    );
    res.json({ history: rows });
  } catch (err) {
    console.error('History error:', err.message);
    res.status(500).json({ error: 'Failed to fetch history.' });
  }
});

// ─── GET /mood/stats ───────────────────────────────────────────────────────
app.get('/mood/stats', authMiddleware, async (req, res) => {
  try {
    const [rows]  = await db.query(
      'SELECT mood, COUNT(*) as count FROM mood_logs WHERE user_id = ? GROUP BY mood ORDER BY count DESC',
      [req.userId]
    );
    const [total] = await db.query(
      'SELECT COUNT(*) as total FROM mood_logs WHERE user_id = ?',
      [req.userId]
    );
    res.json({ stats: rows, total: total[0].total });
  } catch (err) {
    console.error('Stats error:', err.message);
    res.status(500).json({ error: 'Failed to fetch stats.' });
  }
});

// ─── PUT /auth/update ─────────────────────────────────────────────────────
app.put('/auth/update', authMiddleware, async (req, res) => {
  const name  = req.body.name?.toString().trim();
  const email = req.body.email?.toString().trim().toLowerCase();

  if (!name || !email) return res.status(400).json({ error: 'Name and email are required.' });

  try {
    const [existing] = await db.query(
      'SELECT id FROM users WHERE email = ? AND id != ?', [email, req.userId]
    );
    if (existing.length > 0) {
      return res.status(409).json({ error: 'Email already in use by another account.' });
    }
    await db.query('UPDATE users SET name = ?, email = ? WHERE id = ?', [name, email, req.userId]);
    res.json({ message: 'Profile updated.', user: { name, email } });
  } catch (err) {
    console.error('Profile update error:', err.message);
    res.status(500).json({ error: 'Failed to update profile.' });
  }
});

// ─── GET /mood/streak ─────────────────────────────────────────────────────
app.get('/mood/streak', authMiddleware, async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT DATE(logged_at) as day
       FROM mood_logs
       WHERE user_id = ?
       GROUP BY DATE(logged_at)
       ORDER BY day DESC
       LIMIT 30`,
      [req.userId]
    );

    if (rows.length === 0) return res.json({ streak: 0 });

    let streak = 0;
    let expected = new Date();
    expected.setHours(0, 0, 0, 0);

    for (const row of rows) {
      const rowDay = new Date(row.day);
      rowDay.setHours(0, 0, 0, 0);
      const diff = Math.round((expected - rowDay) / (1000 * 60 * 60 * 24));

      if (diff <= 1) {
        streak++;
        expected = rowDay;
      } else {
        break;
      }
    }

    res.json({ streak });
  } catch (err) {
    console.error('Streak error:', err.message);
    res.status(500).json({ error: 'Failed to fetch streak.' });
  }
});

// ─── Global error handler ──────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err.message);
  res.status(500).json({ error: 'Something went wrong.' });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`MoodMate backend running on port ${PORT}`));