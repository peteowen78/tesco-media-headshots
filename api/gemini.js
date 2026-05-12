export default async function handler(req, res) {
  // CORS — allow same-origin requests from Vercel deployment
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'GEMINI_API_KEY is not set on the server.' });

  const { model, imgBase64, imgMime, prompt } = req.body;

  if (!model || !imgBase64 || !prompt) {
    return res.status(400).json({ error: 'Missing required fields: model, imgBase64, prompt' });
  }

  const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  try {
    const geminiRes = await fetch(geminiUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: prompt },
            { inlineData: { mimeType: imgMime || 'image/jpeg', data: imgBase64 } }
          ]
        }],
        generationConfig: { responseModalities: ['IMAGE', 'TEXT'] }
      })
    });

    const data = await geminiRes.json();
    return res.status(geminiRes.status).json(data);
  } catch (err) {
    return res.status(500).json({ error: `Proxy error: ${err.message}` });
  }
}
