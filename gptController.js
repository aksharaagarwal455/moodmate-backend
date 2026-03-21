// gptController.js - OpenRouter with smart fallback
const axios = require('axios');
require('dotenv').config();

// Fallback advice if API key is missing or call fails
const fallbackAdvice = {
  happy:     "Ride this wave of joy — share it with someone who needs it today!",
  sad:       "It's okay to feel sad. Give yourself grace, and know this feeling will pass.",
  angry:     "Take a deep breath. Channel this energy into something productive.",
  surprised: "Embrace the unexpected — the best moments are the ones we never planned.",
  disgusted: "Trust your instincts. Your discomfort is pointing you toward something important.",
  fearful:   "Courage isn't the absence of fear — it's taking the next small step anyway.",
  neutral:   "Sometimes stillness is exactly what you need. Be present in the moment.",
};

async function getAdvice(mood) {
  // If no API key configured, return fallback immediately
  if (!process.env.OPENROUTER_API_KEY || process.env.OPENROUTER_API_KEY === 'your_key_here') {
    console.log('ℹ️  No OpenRouter key found, using fallback advice.');
    return fallbackAdvice[mood] || "Take it one moment at a time. You've got this.";
  }

  try {
    const response = await axios.post(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        model: 'openai/gpt-4o',
        messages: [
          { role: 'system', content: 'You are a warm, empathetic mood advisor. Keep responses to one impactful sentence.' },
          { role: 'user', content: `Give a short one-line piece of advice for someone feeling ${mood}.` }
        ]
      },
      {
        headers: {
          'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'http://localhost:3000',
          'X-Title': 'MoodMate-AI'
        },
        timeout: 8000,
      }
    );

    return response.data.choices[0].message.content;

  } catch (error) {
    console.error('❌ OpenRouter error, using fallback:', error.message);
    // Always return fallback — never crash the route
    return fallbackAdvice[mood] || "Take it one moment at a time. You've got this.";
  }
}

module.exports = { getAdvice };