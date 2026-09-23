/**
 * ELYSIA B2 proxy worker.
 * Browser -> this Worker -> Backblaze B2 (private bucket).
 * Direct browser-to-B2 uploads fail due to CORS, so every B2 call is proxied here.
 *
 * Required secrets (wrangler secret put <NAME>):
 *   B2_KEY_ID          Backblaze application key ID
 *   B2_APP_KEY         Backblaze application key
 *   APP_TOKEN          Shared secret the app must send as X-App-Token
 *
 * Required vars (wrangler.toml [vars]):
 *   B2_BUCKET_ID       Bucket ID
 *   B2_BUCKET_NAME     Bucket name
 *
 * Endpoints (all require header "X-App-Token: <APP_TOKEN>"):
 *   GET    /api/file?key=<path>          -> streams the object
 *   PUT    /api/file?key=<path>          -> body = raw bytes, Content-Type header preserved
 *   DELETE /api/file?key=<path>          -> deletes the object (all versions)
 *   GET    /api/list?prefix=<prefix>     -> [{fileName, contentType, size}]
 */

// In-memory cache, reused across warm invocations of the same isolate.
let accountAuth = null; // { apiUrl, downloadUrl, authorizationToken, expiresAt }
let uploadAuth = null;  // { uploadUrl, authorizationToken }

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-App-Token',
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

    const token = req.headers.get('X-App-Token');
    if (!env.APP_TOKEN || token !== env.APP_TOKEN) {
      return new Response('Unauthorized', { status: 401, headers: cors });
    }

    try {
      if (url.pathname === '/api/list' && req.method === 'GET') {
        const prefix = url.searchParams.get('prefix') || '';
        const files = await b2List(env, prefix);
        return new Response(JSON.stringify(files), {
          headers: { ...cors, 'Content-Type': 'application/json' },
        });
      }

      const key = url.searchParams.get('key');
      if (url.pathname === '/api/file') {
        if (!key) return new Response('Missing key', { status: 400, headers: cors });

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
