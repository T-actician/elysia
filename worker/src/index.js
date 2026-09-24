/**
 * ELYSIA B2 proxy worker — multi-user, no signup.
 * Browser -> this Worker -> Backblaze B2 (private bucket).
 * Direct browser-to-B2 uploads fail due to CORS, so every B2 call is proxied here.
 *
 * Every request carries "X-Device-Id: <uuid>" — a random ID the app generates on first
 * load (no email, no password, no server round trip). Possession of the ID *is* the
 * authorization: the worker namespaces every B2 key under `users/<deviceId>/...`, so one
 * device's requests can never reach another device's files. The ID must be treated like a
 * password by the client — it's never validated against anything, just trusted and scoped.
 *
 * Required secrets (wrangler secret put <NAME>):
 *   B2_KEY_ID          Backblaze application key ID
 *   B2_APP_KEY         Backblaze application key
 *
 * Required vars (wrangler.toml [vars]):
 *   B2_BUCKET_ID       Bucket ID
 *   B2_BUCKET_NAME     Bucket name
 *
 * Endpoints (all require "X-Device-Id: <uuid>"):
 *   GET    /api/file?key=<path>          -> streams the object (path relative to the device's namespace)
 *   PUT    /api/file?key=<path>          -> body = raw bytes, Content-Type header preserved
 *   DELETE /api/file?key=<path>          -> deletes the object (all versions)
 *   POST   /api/large/start?key=<path>   -> {fileId}   (B2 multipart, files > ~90MB)
 *   PUT    /api/large/part?fileId=&n=    -> body = part bytes, header X-Part-Sha1
 *   POST   /api/large/finish             -> JSON {fileId, sha1s:[...]}
 *   GET    /api/list?prefix=<prefix>     -> [{fileName, contentType, size}] (fileName includes the users/<id>/ prefix)
 */
const DEVICE_ID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

// In-memory cache, reused across warm invocations of the same isolate.
let accountAuth = null; // { apiUrl, downloadUrl, authorizationToken, expiresAt }
let uploadAuth = null;  // { uploadUrl, authorizationToken }

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Device-Id, X-Part-Sha1',
    'Access-Control-Max-Age': '86400',
  };
}

async function authorizeAccount(env) {
  const cred = btoa(`${env.B2_KEY_ID}:${env.B2_APP_KEY}`);
  const res = await fetch('https://api.backblazeb2.com/b2api/v3/b2_authorize_account', {
    headers: { Authorization: `Basic ${cred}` },
  });
  if (!res.ok) throw new Error(`b2_authorize_account failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  accountAuth = {
    apiUrl: data.apiInfo.storageApi.apiUrl,
    downloadUrl: data.apiInfo.storageApi.downloadUrl,
    authorizationToken: data.authorizationToken,
    expiresAt: Date.now() + 22 * 60 * 60 * 1000, // refresh well before the ~24h expiry
  };
  uploadAuth = null; // upload URL is tied to the old auth; force refresh
  return accountAuth;
}

async function getAccountAuth(env) {
  if (accountAuth && accountAuth.expiresAt > Date.now()) return accountAuth;
  return authorizeAccount(env);
}

async function getUploadAuth(env) {
  const acc = await getAccountAuth(env);
  if (uploadAuth) return uploadAuth;
  const res = await fetch(`${acc.apiUrl}/b2api/v3/b2_get_upload_url`, {
    method: 'POST',
    headers: { Authorization: acc.authorizationToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ bucketId: env.B2_BUCKET_ID }),
  });
  if (!res.ok) throw new Error(`b2_get_upload_url failed: ${res.status} ${await res.text()}`);
  uploadAuth = await res.json();
  return uploadAuth;
}

async function b2Upload(env, key, body, contentType) {
  let up = await getUploadAuth(env);
  const bytes = new Uint8Array(body);
  const doUpload = async () =>
    fetch(up.uploadUrl, {
      method: 'POST',
      headers: {
        Authorization: up.authorizationToken,
        'X-Bz-File-Name': encodeURIComponent(key),
        'Content-Type': contentType || 'application/octet-stream',
        'X-Bz-Content-Sha1': 'do_not_verify', // skip hashing large audio files on the Worker
        'Content-Length': String(bytes.byteLength),
      },
      body: bytes,
    });
  let res = await doUpload();
  if (res.status === 401 || res.status === 503) {
    // upload URL expired / busy — refresh once and retry
    uploadAuth = null;
    up = await getUploadAuth(env);
    res = await doUpload();
  }
  if (!res.ok) throw new Error(`b2 upload failed: ${res.status} ${await res.text()}`);
  return res.json();
}

// ---- Large files (B2 multipart). Cloudflare caps request bodies at 100MB, so the browser
// slices big files into ~20MB parts: start -> part x N -> finish. ----
async function b2StartLarge(env, key, contentType) {
  const acc = await getAccountAuth(env);
  const res = await fetch(`${acc.apiUrl}/b2api/v3/b2_start_large_file`, {
    method: 'POST',
    headers: { Authorization: acc.authorizationToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ bucketId: env.B2_BUCKET_ID, fileName: key, contentType: contentType || 'application/octet-stream' }),
  });
  if (!res.ok) throw new Error(`b2_start_large_file failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function b2UploadPart(env, fileId, partNumber, bytes, sha1) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const acc = await getAccountAuth(env);
    const urlRes = await fetch(`${acc.apiUrl}/b2api/v3/b2_get_upload_part_url`, {
      method: 'POST',
      headers: { Authorization: acc.authorizationToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileId }),
    });
    if (!urlRes.ok) {
      if (urlRes.status === 401) accountAuth = null;
      if (attempt === 1) throw new Error(`b2_get_upload_part_url failed: ${urlRes.status} ${await urlRes.text()}`);
      continue;
    }
    const up = await urlRes.json();
    const res = await fetch(up.uploadUrl, {
      method: 'POST',
      headers: {
        Authorization: up.authorizationToken,
        'X-Bz-Part-Number': String(partNumber),
        'X-Bz-Content-Sha1': sha1,
        'Content-Length': String(bytes.byteLength),
      },
      body: bytes,
    });
    if (res.ok) return res.json();
    if (attempt === 1) throw new Error(`b2_upload_part failed: ${res.status} ${await res.text()}`);
  }
}

async function b2FinishLarge(env, fileId, sha1s) {
  const acc = await getAccountAuth(env);
  const res = await fetch(`${acc.apiUrl}/b2api/v3/b2_finish_large_file`, {
    method: 'POST',
    headers: { Authorization: acc.authorizationToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileId, partSha1Array: sha1s }),
  });
  if (!res.ok) throw new Error(`b2_finish_large_file failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function b2Download(env, key) {
  const acc = await getAccountAuth(env);
  const url = `${acc.downloadUrl}/file/${env.B2_BUCKET_NAME}/${key.split('/').map(encodeURIComponent).join('/')}`;
  let res = await fetch(url, { headers: { Authorization: acc.authorizationToken } });
  if (res.status === 401) {
    accountAuth = null;
    const acc2 = await getAccountAuth(env);
    res = await fetch(url, { headers: { Authorization: acc2.authorizationToken } });
  }
  return res;
}

async function b2FindFileId(env, key) {
  const acc = await getAccountAuth(env);
  const res = await fetch(`${acc.apiUrl}/b2api/v3/b2_list_file_names`, {
    method: 'POST',
    headers: { Authorization: acc.authorizationToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ bucketId: env.B2_BUCKET_ID, startFileName: key, maxFileCount: 1 }),
  });
  if (!res.ok) throw new Error(`b2_list_file_names failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const match = (data.files || [])[0];
  if (match && match.fileName === key) return match.fileId;
  return null;
}

async function b2Delete(env, key) {
  const fileId = await b2FindFileId(env, key);
  if (!fileId) return { deleted: false };
  const acc = await getAccountAuth(env);
  const res = await fetch(`${acc.apiUrl}/b2api/v3/b2_delete_file_version`, {
    method: 'POST',
    headers: { Authorization: acc.authorizationToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileName: key, fileId }),
  });
  if (!res.ok) throw new Error(`b2_delete_file_version failed: ${res.status} ${await res.text()}`);
  return { deleted: true };
}

async function b2List(env, prefix) {
  const acc = await getAccountAuth(env);
  let startFileName = null;
  const files = [];
  do {
    const res = await fetch(`${acc.apiUrl}/b2api/v3/b2_list_file_names`, {
      method: 'POST',
      headers: { Authorization: acc.authorizationToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bucketId: env.B2_BUCKET_ID,
        prefix,
        maxFileCount: 1000,
        startFileName: startFileName || undefined,
      }),
    });
    if (!res.ok) throw new Error(`b2_list_file_names failed: ${res.status} ${await res.text()}`);
    const data = await res.json();
    for (const f of data.files || []) {
      files.push({ fileName: f.fileName, contentType: f.contentType, size: f.contentLength });
    }
    startFileName = data.nextFileName;
  } while (startFileName);
  return files;
}

export default {
  async fetch(req, env) {
    const origin = req.headers.get('Origin') || '*';
    const cors = corsHeaders(origin);

    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });

    const url = new URL(req.url);
    if (!url.pathname.startsWith('/api/')) return new Response('Not found', { status: 404, headers: cors });

    const deviceId = req.headers.get('X-Device-Id') || '';
    if (!DEVICE_ID_RE.test(deviceId)) return new Response('Unauthorized', { status: 401, headers: cors });
    const userPrefix = `users/${deviceId}/`;

    try {
      if (url.pathname === '/api/list' && req.method === 'GET') {
        const prefix = url.searchParams.get('prefix') || '';
        const files = await b2List(env, userPrefix + prefix);
        return new Response(JSON.stringify(files), {
          headers: { ...cors, 'Content-Type': 'application/json' },
        });
      }

      if (url.pathname === '/api/large/start' && req.method === 'POST') {
        const rawKey = url.searchParams.get('key');
        if (!rawKey) return new Response('Missing key', { status: 400, headers: cors });
        const r = await b2StartLarge(env, userPrefix + rawKey, req.headers.get('Content-Type'));
        return new Response(JSON.stringify({ fileId: r.fileId }), { headers: { ...cors, 'Content-Type': 'application/json' } });
      }
      if (url.pathname === '/api/large/part' && req.method === 'PUT') {
        const fileId = url.searchParams.get('fileId');
        const n = parseInt(url.searchParams.get('n') || '', 10);
        const sha1 = req.headers.get('X-Part-Sha1') || '';
        if (!fileId || !(n >= 1 && n <= 10000) || !/^[a-f0-9]{40}$/i.test(sha1)) {
          return new Response('Bad part request', { status: 400, headers: cors });
        }
        await b2UploadPart(env, fileId, n, new Uint8Array(await req.arrayBuffer()), sha1);
        return new Response(JSON.stringify({ ok: true }), { headers: { ...cors, 'Content-Type': 'application/json' } });
      }
      if (url.pathname === '/api/large/finish' && req.method === 'POST') {
        const { fileId, sha1s } = await req.json();
        if (!fileId || !Array.isArray(sha1s) || !sha1s.length) return new Response('Bad finish request', { status: 400, headers: cors });
        await b2FinishLarge(env, fileId, sha1s);
        return new Response(JSON.stringify({ ok: true }), { headers: { ...cors, 'Content-Type': 'application/json' } });
      }

      const rawKey = url.searchParams.get('key');
      if (url.pathname === '/api/file') {
        if (!rawKey) return new Response('Missing key', { status: 400, headers: cors });
        const key = userPrefix + rawKey; // every file op is confined to this user's namespace

        if (req.method === 'GET') {
          const res = await b2Download(env, key);
          if (!res.ok) return new Response('Not found', { status: 404, headers: cors });
          const headers = new Headers(cors);
          headers.set('Content-Type', res.headers.get('Content-Type') || 'application/octet-stream');
          headers.set('Cache-Control', 'private, max-age=3600');
          return new Response(res.body, { status: 200, headers });
        }

        if (req.method === 'PUT') {
          const body = await req.arrayBuffer();
          const contentType = req.headers.get('Content-Type') || 'application/octet-stream';
          const result = await b2Upload(env, key, body, contentType);
          return new Response(JSON.stringify({ ok: true, fileId: result.fileId }), {
            headers: { ...cors, 'Content-Type': 'application/json' },
          });
        }

        if (req.method === 'DELETE') {
          const result = await b2Delete(env, key);
          return new Response(JSON.stringify(result), {
            headers: { ...cors, 'Content-Type': 'application/json' },
          });
        }
      }

      return new Response('Not found', { status: 404, headers: cors });
    } catch (e) {
      return new Response(JSON.stringify({ error: String(e.message || e) }), {
        status: 500,
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }
  },
};
