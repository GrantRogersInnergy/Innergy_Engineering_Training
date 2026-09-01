/**
 * innergy-training-links worker
 *
 * Receives requests from the training matrix page and reads/writes
 * links.json (and uploaded documents) in the GitHub Pages repo, using a
 * GitHub token stored as a Worker secret (never exposed to the browser).
 * Open access — anyone with the page URL can add, upload, or delete a link.
 *
 * Endpoints:
 *   POST /add          -> { id, label, url, addedBy } add a URL link
 *   POST /upload       -> { id, label, filename, contentBase64, addedBy }
 *                         commit a file into the repo under uploads/ and add
 *                         it as a link
 *   POST /delete       -> { id, entryId } remove a link
 *   POST /notes/add    -> { text, addedBy } add a general note
 *   POST /notes/delete -> { entryId } remove a general note
 *
 * Required secret: GITHUB_TOKEN (fine-grained PAT scoped to this repo only,
 * Contents: Read and write)
 */

const BUILD = 'commits-to-github-v2';
const OWNER = 'GrantRogersInnergy';
const REPO = 'Innergy_Engineering_Training';
const FILE_PATH = 'links.json';
const NOTES_FILE_PATH = 'notes.json';
const UPLOADS_PREFIX = 'uploads';
const PAGES_BASE = 'https://grantrogersinnergy.github.io/Innergy_Engineering_Training';
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024; // 8MB, comfortably inside GitHub's Contents API limits

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
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
  if (res.status === 404) return { sha: null, text: null };
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
  const res = await fetch(url, {
    method: 'DELETE',
    headers: { ...ghHeaders(env), 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, sha }),
  });
  if (!res.ok) throw new Error(`GitHub DELETE ${path} failed: ${res.status}`);
}

async function loadLinks(env) {
  const { sha, text } = await ghGetFile(FILE_PATH, env);
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch (e) { data = {}; }
  return { sha, data };
}

async function saveLinks(data, sha, message, env) {
  const content = btoa(unescape(encodeURIComponent(JSON.stringify(data, null, 2))));
  const res = await ghPutFile(FILE_PATH, content, message, sha, env);
  return res && res.commit && res.commit.sha;
}

async function loadNotes(env) {
  const { sha, text } = await ghGetFile(NOTES_FILE_PATH, env);
  let data = [];
  try { data = text ? JSON.parse(text) : []; } catch (e) { data = []; }
  return { sha, data };
}

async function saveNotes(data, sha, message, env) {
  const content = btoa(unescape(encodeURIComponent(JSON.stringify(data, null, 2))));
  const res = await ghPutFile(NOTES_FILE_PATH, content, message, sha, env);
  return res && res.commit && res.commit.sha;
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

    try {
      // A deploy whose token has expired answers every write with success
      // while nothing reaches the repo. Check the token directly.
      if (url.pathname === '/health') {
        if (!env.GITHUB_TOKEN) {
          return json({ ok: false, error: 'GITHUB_TOKEN secret is not set on this Worker' }, 500);
        }
        const probe = await fetch(
          `https://api.github.com/repos/${OWNER}/${REPO}/contents/${FILE_PATH}`,
          { headers: ghHeaders(env) }
        );
        if (!probe.ok) {
          return json({
            ok: false,
            error: `GitHub rejected the token: ${probe.status}`,
            hint: 'Issue a new fine-grained PAT scoped to this repo with Contents: Read and write, then re-run `wrangler secret put GITHUB_TOKEN` and `wrangler deploy`.',
          }, 500);
        }
        return json({ ok: true, build: BUILD, repo: `${OWNER}/${REPO}`, pagesBase: PAGES_BASE });
      }

      if (url.pathname === '/add' && request.method === 'POST') {
        const body = await request.json().catch(() => null);
        const { id, label, url: linkUrl, addedBy } = body || {};
        if (typeof id !== 'string' || !/^[A-J](0[1-9]|1[0-9])$/.test(id)) {
          return json({ error: 'Invalid competency id' }, 400);
        }
        if (typeof linkUrl !== 'string' || !/^https?:\/\/.+/i.test(linkUrl) || linkUrl.length > 500) {
          return json({ error: 'Invalid URL — must start with http:// or https://' }, 400);
        }
        const safeAddedBy = String(addedBy || 'anonymous').slice(0, 80);
        const { sha, data } = await loadLinks(env);
        data[id] = data[id] || [];
        const entry = {
          entryId: crypto.randomUUID(),
          label: String(label || linkUrl).slice(0, 150),
          url: linkUrl,
          addedBy: safeAddedBy,
          addedAt: new Date().toISOString(),
        };
        data[id].push(entry);
        const commit = await saveLinks(data, sha, `Add link for ${id} via training matrix page${safeAddedBy !== 'anonymous' ? ` (${safeAddedBy})` : ''}`, env);
        return json({ success: true, entry, commit });
      }

      if (url.pathname === '/upload' && request.method === 'POST') {
        const body = await request.json().catch(() => null);
        const { id, label, filename, contentBase64, addedBy } = body || {};
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
        const safeAddedBy = String(addedBy || 'anonymous').slice(0, 80);
        const safeName = sanitizeFilename(filename);
        const path = `${UPLOADS_PREFIX}/${id}/${Date.now()}-${safeName}`;
        await ghPutFile(path, contentBase64, `Upload ${safeName} for ${id} via training matrix page${safeAddedBy !== 'anonymous' ? ` (${safeAddedBy})` : ''}`, null, env);

        const { sha, data } = await loadLinks(env);
        data[id] = data[id] || [];
        const entry = {
          entryId: crypto.randomUUID(),
          label: String(label || safeName).slice(0, 150),
          url: `${PAGES_BASE}/${path}`,
          filePath: path,
          isUpload: true,
          addedBy: safeAddedBy,
          addedAt: new Date().toISOString(),
        };
        data[id].push(entry);
        const commit = await saveLinks(data, sha, `Add uploaded doc for ${id} via training matrix page${safeAddedBy !== 'anonymous' ? ` (${safeAddedBy})` : ''}`, env);
        return json({ success: true, entry, commit });
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
        data[id] = list.filter(e => e.entryId !== entryId);
        await saveLinks(data, sha, `Delete link for ${id} via training matrix page`, env);
        if (entry.isUpload && entry.filePath) {
          const { sha: fileSha } = await ghGetFile(entry.filePath, env);
          if (fileSha) await ghDeleteFile(entry.filePath, `Delete uploaded doc for ${id} via training matrix page`, fileSha, env);
        }
        return json({ success: true });
      }

      if (url.pathname === '/notes/add' && request.method === 'POST') {
        const body = await request.json().catch(() => null);
        const { text, addedBy } = body || {};
        if (typeof text !== 'string' || !text.trim()) {
          return json({ error: 'Note text is required' }, 400);
        }
        const safeAddedBy = String(addedBy || 'anonymous').slice(0, 80);
        const { sha, data } = await loadNotes(env);
        const entry = {
          entryId: crypto.randomUUID(),
          text: text.trim().slice(0, 2000),
          addedBy: safeAddedBy,
          addedAt: new Date().toISOString(),
        };
        data.push(entry);
        const commit = await saveNotes(data, sha, `Add note via training matrix page${safeAddedBy !== 'anonymous' ? ` (${safeAddedBy})` : ''}`, env);
        return json({ success: true, entry, commit });
      }

      if (url.pathname === '/notes/delete' && request.method === 'POST') {
        const body = await request.json().catch(() => null);
        const { entryId } = body || {};
        if (typeof entryId !== 'string') {
          return json({ error: 'Missing entryId' }, 400);
        }
        const { sha, data } = await loadNotes(env);
        if (!data.some(e => e.entryId === entryId)) {
          return json({ error: 'Note not found' }, 404);
        }
        const filtered = data.filter(e => e.entryId !== entryId);
        await saveNotes(filtered, sha, `Delete note via training matrix page`, env);
        return json({ success: true });
      }

      return json({ error: 'Not found' }, 404);
    } catch (e) {
      return json({ error: 'Server error', detail: String(e) }, 500);
    }
  },
};
