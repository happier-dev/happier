#!/usr/bin/env node
/* eslint-disable no-console */

const { randomBytes } = require('node:crypto');
const { mkdirSync, writeFileSync, chmodSync } = require('node:fs');
const { join } = require('node:path');
const { generateKeyPairSync, sign } = require('node:crypto');

function argvValue(args, name) {
  const idx = args.indexOf(name);
  if (idx === -1) return '';
  const next = args[idx + 1] ?? '';
  if (!next || String(next).startsWith('--')) return '';
  return String(next);
}

function sanitizeServerId(id) {
  const raw = String(id ?? '').trim() || 'smoke';
  const safe = raw.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 64);
  return safe || 'smoke';
}

function normalizeUrl(raw) {
  const s = String(raw ?? '').trim().replace(/\/+$/, '');
  if (!s) return '';
  try {
    // eslint-disable-next-line no-new
    new URL(s);
    return s;
  } catch {
    return '';
  }
}

function extractEd25519PublicKeyRawFromSpkiDer(spkiDer) {
  const buf = Buffer.isBuffer(spkiDer) ? spkiDer : Buffer.from(spkiDer);
  // Ed25519 SPKI commonly ends with:
  //   ... 03 21 00 <32 bytes>
  // where 0x03 = BIT STRING, length 0x21, unused-bits 0x00.
  const marker = Buffer.from([0x03, 0x21, 0x00]);
  const idx = buf.lastIndexOf(marker);
  if (idx === -1) throw new Error('failed to locate SPKI bitstring marker');
  const start = idx + marker.length;
  const pk = buf.subarray(start);
  if (pk.length !== 32) throw new Error(`unexpected ed25519 public key length: ${pk.length}`);
  return pk;
}

async function postJson(url, body, headers = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    const msg = json?.error ? String(json.error) : `http_${res.status}`;
    throw new Error(`request failed: ${url} (${msg})`);
  }
  return json;
}

async function main() {
  const args = process.argv.slice(2);

  const serverUrl = normalizeUrl(argvValue(args, '--server-url') || process.env.HAPPIER_SERVER_URL);
  const homeDir = String(argvValue(args, '--home-dir') || process.env.HAPPIER_HOME_DIR || '').trim();
  const activeServerId = sanitizeServerId(argvValue(args, '--active-server-id') || process.env.HAPPIER_ACTIVE_SERVER_ID);

  if (!serverUrl) {
    console.error('Missing --server-url (or env HAPPIER_SERVER_URL)');
    process.exit(2);
  }
  if (!homeDir) {
    console.error('Missing --home-dir (or env HAPPIER_HOME_DIR)');
    process.exit(2);
  }

  // 1) Create an account (anonymous signup) via key-challenge auth.
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spkiDer = publicKey.export({ type: 'spki', format: 'der' });
  const publicKeyRaw = extractEd25519PublicKeyRawFromSpkiDer(spkiDer);
  const challenge = randomBytes(32);
  const signature = sign(null, challenge, privateKey);

  const authRes = await postJson(`${serverUrl}/v1/auth`, {
    publicKey: publicKeyRaw.toString('base64'),
    challenge: challenge.toString('base64'),
    signature: Buffer.from(signature).toString('base64'),
  });

  const token = String(authRes?.token ?? '').trim();
  if (!token) {
    throw new Error('missing token from /v1/auth response');
  }

  // 2) Write credentials to enable `happier auth approve` (token-only usage).
  const secret = randomBytes(32).toString('base64');
  const serverDir = join(homeDir, 'servers', activeServerId);
  const keyPath = join(serverDir, 'access.key');
  mkdirSync(serverDir, { recursive: true });
  writeFileSync(keyPath, JSON.stringify({ token, secret }, null, 2), { encoding: 'utf8', mode: 0o600 });
  try {
    chmodSync(keyPath, 0o600);
  } catch {
    // ignore
  }

  console.log(JSON.stringify({ ok: true, serverUrl, homeDir, activeServerId, keyPath }));
}

main().catch((err) => {
  console.error(err && err.message ? err.message : String(err));
  process.exit(1);
});

