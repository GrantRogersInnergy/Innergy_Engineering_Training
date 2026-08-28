/**
 * innergy-training-links worker (v2)
 *
 * Gated by Microsoft Entra ID (Innergy 365 accounts only). Every request must
 * carry a valid Bearer ID token issued to CLIENT_ID by TENANT_ID; the Worker
 * verifies the token's signature against Microsoft's JWKS before doing
 * anything. Reads and writes both go through here — the frontend never talks
 * to GitHub directly.
 *
 * Endpoints:
 *   GET  /links   -> current links.json content
 *   POST /add     -> { id, label, url } add a URL link
 *   POST /upload  -> { id, label, filename, contentBase64 } commit a file into
 *                    the repo under uploads/ and add it as a link
 *   POST /delete  -> { id, entryId } remove a link, only if the caller's
 *                    email matches the entry's addedByEmail
 *
 * Required secret: GITHUB_TOKEN (fine-grained PAT scoped to this repo only,
 * Contents: Read and write)
 */

import { jwtVerify, createRemoteJWKSet } from 'jose';

const OWNER = 'GrantRogersInnergy';
const REPO = 'Innergy_Engineering_Training';
const FILE_PATH = 'links.json';
const UPLOADS_PREFIX = 'uploads';
const PAGES_BASE = 'https://grantrogersinnergy.github.io/Innergy_Engineering_Training';
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024; // 8MB, comfortably inside GitHub's Contents API limits

// --- Fill these in from the Entra ID app registration ---
const TENANT_ID = 'REPLACE_WITH_TENANT_ID';
const CLIENT_ID = 'REPLACE_WITH_CLIENT_ID';
// ----------------------------------------------------------

const JWKS = createRemoteJWKSet(
  new URL(`https://login.microsoftonline.com/${TENANT_ID}/discovery/v2.0/keys`)
);

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

async function verifyToken(request) {
  const auth = request.headers.get('Authorization') || '';
  const match = auth.match(/^Bearer (.+)$/);
  if (!match) return null;
  try {
    const { payload } = await jwtVerify(match[1], JWKS, {
      issuer: `https://login.microsoftonline.com/${TENANT_ID}/v2.0`,
      audience: CLIENT_ID,
    });
    const email = (payload.preferred_username || payload.email || '').toLowerCase();
    if (!email) return null;
    return { email, name: payload.name || email };
  } catch (e) {
    return null;
  }
}

function ghHeaders(env) {
  return {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'innergy-training-links-worker',
  };
}

async function ghGetFile(path, env) {
  const url = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${path}`;
  const res = await fetch(url, { headers: ghHeaders(env) });
  if (res.status === 404) return { sha: null, json: null };
  if (!res.ok) throw new Error(`GitHub GET ${path} failed: ${res.status}`);
  const data = await res.json();
  const decoded = atob(data.content.replace(/\n/g, ''));
  return { sha: data.sha, text: decoded };
}

async function ghPutFile(path, contentBase64, message, sha, env) {
  const url = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${path}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: { ...ghHeaders(env), 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, content: contentBase64, ...(sha ? { sha } : {}) }),
  });
  if (!res.ok) throw new Error(`GitHub PUT ${path} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function ghDeleteFile(path, message, sha, env) {
  const url = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${path}`;
  await fetch(url, {
    method: 'DELETE',
    headers: { ...ghHeaders(env), 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, sha }),
  });
}

async function loadLinks(env) {
  const { sha, text } = await ghGetFile(FILE_PATH, env);
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch (e) { data = {}; }
  return { sha, data };
}

async function saveLinks(data, sha, message, env) {
  const content = btoa(unescape(encodeURIComponent(JSON.stringify(data, null, 2))));
  return ghPutFile(FILE_PATH, content, message, sha, env);
}

function sanitizeFilename(name) {
  return String(name).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'file';
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const user = await verifyToken(request);
    if (!user) {
      return json({ error: 'Sign in with your Innergy Microsoft account required' }, 401);
    }

    try {
      if (url.pathname === '/links' && request.method === 'GET') {
        const { data } = await loadLinks(env);
        return json(data);
      }

      if (url.pathname === '/add' && request.method === 'POST') {
        const body = await request.json().catch(() => null);
        const { id, label, url: linkUrl } = body || {};
        if (typeof id !== 'string' || !/^[A-J](0[1-9]|1[0-9])$/.test(id)) {
          return json({ error: 'Invalid competency id' }, 400);
        }
        if (typeof linkUrl !== 'string' || !/^https?:\/\/.+/i.test(linkUrl) || linkUrl.length > 500) {
          return json({ error: 'Invalid URL — must start with http:// or https://' }, 400);
        }
        const { sha, data } = await loadLinks(env);
        data[id] = data[id] || [];
        const entry = {
          entryId: crypto.randomUUID(),
          label: String(label || linkUrl).slice(0, 150),
          url: linkUrl,
          addedByEmail: user.email,
          addedByName: user.name,
          addedAt: new Date().toISOString(),
        };
        data[id].push(entry);
        await saveLinks(data, sha, `Add link for ${id} (${user.email})`, env);
        return json({ success: true, entry });
      }

      if (url.pathname === '/upload' && request.method === 'POST') {
        const body = await request.json().catch(() => null);
        const { id, label, filename, contentBase64 } = body || {};
        if (typeof id !== 'string' || !/^[A-J](0[1-9]|1[0-9])$/.test(id)) {
          return json({ error: 'Invalid competency id' }, 400);
        }
        if (typeof contentBase64 !== 'string' || !contentBase64) {
          return json({ error: 'Missing file content' }, 400);
        }
        const approxBytes = Math.floor(contentBase64.length * 0.75);
        if (approxBytes > MAX_UPLOAD_BYTES) {
          return json({ error: 'File too large — 8MB max' }, 400);
        }
        const safeName = sanitizeFilename(filename);
        const path = `${UPLOADS_PREFIX}/${id}/${Date.now()}-${safeName}`;
        await ghPutFile(path, contentBase64, `Upload ${safeName} for ${id} (${user.email})`, null, env);

        const { sha, data } = await loadLinks(env);
        data[id] = data[id] || [];
        const entry = {
          entryId: crypto.randomUUID(),
          label: String(label || safeName).slice(0, 150),
          url: `${PAGES_BASE}/${path}`,
          filePath: path,
          isUpload: true,
          addedByEmail: user.email,
          addedByName: user.name,
          addedAt: new Date().toISOString(),
        };
        data[id].push(entry);
        await saveLinks(data, sha, `Add uploaded doc for ${id} (${user.email})`, env);
        return json({ success: true, entry });
      }

      if (url.pathname === '/delete' && request.method === 'POST') {
        const body = await request.json().catch(() => null);
        const { id, entryId } = body || {};
        if (typeof id !== 'string' || typeof entryId !== 'string') {
          return json({ error: 'Missing id or entryId' }, 400);
        }
        const { sha, data } = await loadLinks(env);
        const list = data[id] || [];
        const entry = list.find(e => e.entryId === entryId);
        if (!entry) return json({ error: 'Link not found' }, 404);
        if (entry.addedByEmail !== user.email) {
          return json({ error: 'You can only delete links you added' }, 403);
        }
        data[id] = list.filter(e => e.entryId !== entryId);
        await saveLinks(data, sha, `Delete link for ${id} (${user.email})`, env);
        if (entry.isUpload && entry.filePath) {
          const { sha: fileSha } = await ghGetFile(entry.filePath, env);
          if (fileSha) await ghDeleteFile(entry.filePath, `Delete uploaded doc for ${id} (${user.email})`, fileSha, env);
        }
        return json({ success: true });
      }

      return json({ error: 'Not found' }, 404);
    } catch (e) {
      return json({ error: 'Server error', detail: String(e) }, 500);
    }
  },
};
