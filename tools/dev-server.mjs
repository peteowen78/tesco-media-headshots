// Local test server — mimics Vercel: serves index.html and runs api/gemini.js.
//
//   node tools/dev-server.mjs                      real Gemini (needs GEMINI_API_KEY)
//   MOCK_IMAGE=exported/some.png node tools/dev-server.mjs
//                                                  no key needed: that file is returned
//                                                  as the "generated" portrait
// Not deployed (see .vercelignore).
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import handler from '../api/gemini.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 5173;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json' };

if (process.env.MOCK_IMAGE) {
  const realFetch = globalThis.fetch;
  process.env.GEMINI_API_KEY ||= 'mock';
  globalThis.fetch = async (url, opts) => {
    if (!String(url).includes('generativelanguage.googleapis.com')) return realFetch(url, opts);
    const file = path.resolve(ROOT, process.env.MOCK_IMAGE);
    const data = (await readFile(file)).toString('base64');
    const mimeType = TYPES[path.extname(file).toLowerCase()] || 'image/png';
    await new Promise(r => setTimeout(r, 1500)); // pretend to think
    return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ inlineData: { data, mimeType } }] } }] }) };
  };
  console.log(`MOCK mode: returning ${process.env.MOCK_IMAGE} instead of calling Gemini`);
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname.startsWith('/api/gemini')) {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    try { req.body = raw ? JSON.parse(raw) : {}; } catch { req.body = {}; }
    res.status = code => { res.statusCode = code; return res; };
    res.json   = body => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body)); return res; };
    return handler(req, res);
  }

  // Static files; anything unknown falls back to index.html (same as vercel.json)
  const rel  = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const file = path.resolve(ROOT, rel);
  try {
    if (!file.startsWith(ROOT + path.sep)) throw new Error('outside root');
    const body = await readFile(file);
    res.setHeader('Content-Type', TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream');
    res.end(body);
  } catch {
    res.setHeader('Content-Type', TYPES['.html']);
    res.end(await readFile(path.join(ROOT, 'index.html')));
  }
}).listen(PORT, () => console.log(`Headshots dev server: http://localhost:${PORT}`));
