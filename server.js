const express = require('express');
const cors = require('cors');
const axios = require('axios');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const { getAdvice } = require('./gptController');
const authRoutes = require('./authRoutes');
const db = require('./db');

const app = express();
app.use(cors());
app.use(express.json());

const JWT_SECRET = process.env.JWT_SECRET || 'moodmate_secret_change_this';

// ─── Middleware: verify JWT token ──────────────────────────────────────────
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
const moodToSearchTerm = {
  happy:     'happy upbeat pop',
  sad:       'sad emotional acoustic',
  angry:     'intense rock energy',
  surprised: 'exciting upbeat',
  disgusted: 'calming ambient chill',
  fearful:   'soothing peaceful instrumental',
  neutral:   'lofi chill beats',
};

// ─── GET /tracks/:mood ─────────────────────────────────────────────────────
app.get('/tracks/:mood', async (req, res) => {
  const mood = req.params.mood.toLowerCase();
  if (!moodToSearchTerm[mood]) {
    return res.status(400).json({ error: 'Unknown mood.' });
  }
  console.log(`🎧 Mood received: ${mood}`);
  try {
    const response = await axios.get('https://itunes.apple.com/search', {
      params: { term: moodToSearchTerm[mood], media: 'music', limit: 9, entity: 'song' },
    });
    const items = response.data.results;
    if (!items || items.length === 0) {
      return res.status(404).json({ error: 'No songs found for this mood' });
    }
    const tracks = items.map(item => ({
      id: item.trackId,
      name: item.trackName,
      artist: item.artistName,
      img: item.artworkUrl100.replace('100x100', '300x300'),
      preview: item.previewUrl,
      link: item.trackViewUrl,
    }));
    console.log(`✅ Found ${tracks.length} tracks for mood: ${mood}`);
    res.json({ tracks, playlist: null });
  } catch (error) {
    console.error('🔥 iTunes API error:', error.message);
    res.status(500).json({ error: 'Failed to fetch tracks' });
  }
});

// ─── GET /advice/:mood ─────────────────────────────────────────────────────
app.get('/advice/:mood', async (req, res) => {
  const mood = req.params.mood.toLowerCase();
  try {
    const advice = await getAdvice(mood);
    res.json({ advice });
  } catch (error) {
    console.error('Error in /advice route:', error.message);
    res.status(500).json({ error: 'Failed to get advice.' });
  }
});

// ─── POST /mood/log — save mood to MySQL (requires auth) ──────────────────
app.post('/mood/log', authMiddleware, async (req, res) => {
  const { mood } = req.body;
  if (!mood) return res.status(400).json({ error: 'Mood is required.' });
  try {
    await db.query(
      'INSERT INTO mood_logs (user_id, mood) VALUES (?, ?)',
      [req.userId, mood.toLowerCase()]
    );
    console.log(`📝 Mood logged: ${mood} for user ${req.userId}`);
    res.json({ message: 'Mood logged successfully.' });
  } catch (err) {
    console.error('Mood log error:', err.message);
    res.status(500).json({ error: 'Failed to log mood.' });
  }
});

// ─── GET /mood/history — get user mood history from MySQL ─────────────────
app.get('/mood/history', authMiddleware, async (req, res) => {
  try {
    const [rows] = await db.query(
      'SELECT mood, logged_at FROM mood_logs WHERE user_id = ? ORDER BY logged_at DESC LIMIT 50',
      [req.userId]
    );
    res.json({ history: rows });
  } catch (err) {
    console.error('Mood history error:', err.message);
    res.status(500).json({ error: 'Failed to fetch history.' });
  }
});

// ─── GET /mood/stats — mood statistics per user ───────────────────────────
app.get('/mood/stats', authMiddleware, async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT mood, COUNT(*) as count 
       FROM mood_logs WHERE user_id = ? 
       GROUP BY mood ORDER BY count DESC`,
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

// ─── PUT /auth/update — update user profile ───────────────────────────────
app.put('/auth/update', authMiddleware, async (req, res) => {
  const { name, email } = req.body;
  if (!name || !email) return res.status(400).json({ error: 'Name and email required.' });
  try {
    const [existing] = await db.query(
      'SELECT id FROM users WHERE email = ? AND id != ?',
      [email, req.userId]
    );
    if (existing.length > 0) {
      return res.status(409).json({ error: 'Email already in use by another account.' });
    }
    await db.query(
      'UPDATE users SET name = ?, email = ? WHERE id = ?',
      [name, email, req.userId]
    );
    res.json({ message: 'Profile updated successfully.', user: { name, email } });
  } catch (err) {
    console.error('Profile update error:', err.message);
    res.status(500).json({ error: 'Failed to update profile.' });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 MoodMate backend running on port ${PORT}`));