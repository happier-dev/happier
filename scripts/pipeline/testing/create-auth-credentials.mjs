// @ts-check

import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import nacl from 'tweetnacl';

function fail(message) {
  console.error(message);
  process.exit(1);
}

/**
 * @param {Uint8Array} bytes
 */
function encode64(bytes) {
  return Buffer.from(bytes).toString('base64');
}

/**
 * Deterministic, filesystem-safe id for ad-hoc server URLs.
 * Mirrors `deriveServerIdFromUrl` in `apps/cli/src/configuration.ts` and `packages/tests/src/testkit/cliAuth.ts`.
 *
 * @param {string} rawUrl
 */
function deriveServerIdFromUrl(rawUrl) {
  const normalized = String(rawUrl || '').trim().replace(/\/+$/, '');
  let h = 2166136261;
  for (let i = 0; i < normalized.length; i += 1) {
    h ^= normalized.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `env_${(h >>> 0).toString(16)}`;
}

/**
 * @param {string} rawId
 */
function sanitizeServerId(rawId) {
  const safe = String(rawId || '').trim().replace(/[^a-zA-Z0-9._-]/g, '_');
  return safe || 'cloud';
}

/**
 * @param {URL} url
 * @param {unknown} payload
 * @returns {Promise<{ statusCode: number; statusMessage: string; body: string }>}
 */
function postJson(url, payload) {
  const body = JSON.stringify(payload);
  const client = url.protocol === 'https:' ? https : http;

  return new Promise((resolvePromise, reject) => {
    const req = client.request(
      url,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => {
          resolvePromise({
            statusCode: Number(res.statusCode ?? 0),
            statusMessage: String(res.statusMessage ?? ''),
            body: raw,
          });
        });
      },
    );

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function main() {
  const { values } = parseArgs({
    options: {
      'server-url': { type: 'string', default: '' },
      'home-dir': { type: 'string', default: '' },
      'active-server-id': { type: 'string', default: '' },
      'secret-base64': { type: 'string', default: '' },
    },
    allowPositionals: false,
  });

  const serverUrl =
    String(values['server-url'] ?? '').trim() ||
    String(process.env.HAPPIER_SERVER_URL ?? '').trim() ||
    'http://127.0.0.1:3005';
  const homeDir =
    String(values['home-dir'] ?? '').trim() ||
    String(process.env.HAPPIER_HOME_DIR ?? '').trim() ||
    path.join(os.homedir(), '.happier-dev-test');

  const secretBase64Raw =
    String(values['secret-base64'] ?? '').trim() ||
    Buffer.alloc(32, 7).toString('base64');

  const secretBuf = Buffer.from(secretBase64Raw, 'base64');
  if (secretBuf.length !== 32) {
    fail(`--secret-base64 must decode to 32 bytes (got: ${secretBuf.length})`);
  }

  const url = new URL('/v1/auth', serverUrl);
  if (url.hostname === 'localhost') url.hostname = '127.0.0.1';

  const keyPair = nacl.sign.keyPair();
  const challenge = nacl.randomBytes(32);
  const signature = nacl.sign.detached(challenge, keyPair.secretKey);

  // Use the normal /v1/auth flow to create a real account + token.
  // This keeps the daemon E2E lane closer to the real user experience and catches auth regressions.
  // NOTE: This script is intended for CI + local testing only.
  const res = await postJson(url, {
    publicKey: encode64(keyPair.publicKey),
    challenge: encode64(challenge),
    signature: encode64(signature),
  });

  if (res.statusCode < 200 || res.statusCode >= 300) {
    fail(`Failed to create auth token: ${res.statusCode} ${res.statusMessage} ${res.body}`.trim());
  }

  let data = null;
  try {
    data = JSON.parse(res.body);
  } catch {
    data = null;
  }
  const token = String(data?.token ?? '').trim();
  if (!token) {
    fail(`Auth response missing token (url=${url.toString()})`);
  }

  const activeServerIdRaw =
    String(values['active-server-id'] ?? '').trim() ||
    String(process.env.HAPPIER_ACTIVE_SERVER_ID ?? '').trim() ||
    deriveServerIdFromUrl(serverUrl);
  const activeServerId = sanitizeServerId(activeServerIdRaw);

  fs.mkdirSync(homeDir, { recursive: true });
  const payload = JSON.stringify({ token, secret: secretBase64Raw }, null, 2);

  const scopedDir = path.join(homeDir, 'servers', activeServerId);
  fs.mkdirSync(scopedDir, { recursive: true });

  for (const credentialsPath of [path.join(homeDir, 'access.key'), path.join(scopedDir, 'access.key')]) {
    fs.writeFileSync(credentialsPath, payload, { mode: 0o600 });
  }
}

try {
  await main();
  process.exit(0);
} catch (err) {
  fail(`Auth bootstrap failed: ${err?.message || err}`);
}
