const express  = require('express');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const db       = require('./db');

const router     = express.Router();
const JWT_SECRET = process.env.JWT_SECRET; // never falls back — server.js exits if missing

// ─── Auth middleware (inline for this router) ──────────────────────────────
function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'No token provided.' });
  const token = authHeader.split(' ')[1];
  try {
    const decoded  = jwt.verify(token, JWT_SECRET);
    req.userId     = decoded.userId;
    req.userEmail  = decoded.email;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token.' });
  }
}

// ─── POST /auth/signup ─────────────────────────────────────────────────────
router.post('/signup', async (req, res) => {
  const name     = req.body.name?.toString().trim();
  const email    = req.body.email?.toString().trim().toLowerCase();
  const password = req.body.password?.toString();

  if (!name || !email || !password) {
    return res.status(400).json({ error: 'All fields are required.' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  }
  // Basic email format check
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Invalid email format.' });
  }

  try {
    const [existing] = await db.query('SELECT id FROM users WHERE email = ?', [email]);
    if (existing.length > 0) {
      return res.status(409).json({ error: 'An account with this email already exists.' });
    }

    const hashedPassword = await bcrypt.hash(password, 12); // 12 rounds = more secure
    const [result] = await db.query(
      'INSERT INTO users (name, email, password) VALUES (?, ?, ?)',
      [name, email, hashedPassword]
    );

    const token = jwt.sign({ userId: result.insertId, email }, JWT_SECRET, { expiresIn: '7d' });

    res.status(201).json({
      message: 'Account created successfully!',
      token,
      user: { id: result.insertId, name, email },
    });
  } catch (err) {
    console.error('Signup error:', err.message);
    res.status(500).json({ error: 'Signup failed. Please try again.' });
  }
});

// ─── POST /auth/login ──────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  const email    = req.body.email?.toString().trim().toLowerCase();
  const password = req.body.password?.toString();

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }

  try {
    const [rows] = await db.query('SELECT * FROM users WHERE email = ?', [email]);
    if (rows.length === 0) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const user    = rows[0];
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const token = jwt.sign({ userId: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });

    res.json({
      message: 'Login successful!',
      token,
      user: { id: user.id, name: user.name, email: user.email },
    });
  } catch (err) {
    console.error('Login error:', err.message);
    res.status(500).json({ error: 'Login failed. Please try again.' });
  }
});

// ─── GET /auth/me ─────────────────────────────────────────────────────────
router.get('/me', requireAuth, async (req, res) => {
  try {
    const [rows] = await db.query(
      'SELECT id, name, email, created_at FROM users WHERE id = ?',
      [req.userId]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'User not found.' });
    res.json({ user: rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch user.' });
  }
});

// ─── PUT /auth/change-password ─────────────────────────────────────────────
router.put('/change-password', requireAuth, async (req, res) => {
  const currentPassword = req.body.currentPassword?.toString();
  const newPassword     = req.body.newPassword?.toString();

  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Both current and new password are required.' });
  }
  if (newPassword.length < 6) {
    return res.status(400).json({ error: 'New password must be at least 6 characters.' });
  }

  try {
    const [rows] = await db.query('SELECT password FROM users WHERE id = ?', [req.userId]);
    if (rows.length === 0) return res.status(404).json({ error: 'User not found.' });

    const isMatch = await bcrypt.compare(currentPassword, rows[0].password);
    if (!isMatch) {
      return res.status(401).json({ error: 'Current password is incorrect.' });
    }

    const hashed = await bcrypt.hash(newPassword, 12);
    await db.query('UPDATE users SET password = ? WHERE id = ?', [hashed, req.userId]);

    res.json({ message: 'Password updated successfully.' });
  } catch (err) {
    console.error('Password change error:', err.message);
    res.status(500).json({ error: 'Failed to update password.' });
  }
});

module.exports = router;