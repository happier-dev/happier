#!/usr/bin/env node
/* eslint-disable no-console */

const { randomBytes } = require('node:crypto');
const { mkdirSync, writeFileSync, chmodSync } = require('node:fs');
const { join } = require('node:path');
const { createHash, createHmac, createPrivateKey, createPublicKey, generateKeyPairSync, sign } = require('node:crypto');

// The app publishes the Account content key at sign-in (apps/ui/sources/auth/flows/getToken.ts);
// approval verifies retained key material against it. Same derivation as @happier-dev/protocol.
function deriveContentKeyFromSeed(seed) {
  let I = createHmac('sha512', Buffer.from('Happy EnCoder Master Seed', 'utf8')).update(seed).digest();
  I = createHmac('sha512', I.subarray(32)).update(Buffer.concat([Buffer.from([0]), Buffer.from('content', 'utf8')])).digest();
  return I.subarray(0, 32);
}

function contentPublicKeyFromSeed(seed) {
  // crypto_box_seed_keypair: secret scalar = SHA-512(contentSeed)[0..32], public = X25519 base point multiple.
  const scalar = createHash('sha512').update(deriveContentKeyFromSeed(seed)).digest().subarray(0, 32);
  const pkcs8 = Buffer.concat([Buffer.from('302e020100300506032b656e04220420', 'hex'), scalar]);
  const spki = createPublicKey(createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' })).export({ type: 'spki', format: 'der' });
  return spki.subarray(spki.length - 32);
}

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
  const pkcs8Der = privateKey.export({ type: 'pkcs8', format: 'der' });
  const signingSeed = Buffer.from(pkcs8Der.subarray(pkcs8Der.length - 32));
  const contentPublicKey = contentPublicKeyFromSeed(signingSeed);
  const contentBinding = Buffer.concat([Buffer.from('Happy content key v1\u0000', 'utf8'), contentPublicKey]);

  const authRes = await postJson(`${serverUrl}/v1/auth`, {
    publicKey: publicKeyRaw.toString('base64'),
    challenge: challenge.toString('base64'),
    signature: Buffer.from(signature).toString('base64'),
    contentPublicKey: contentPublicKey.toString('base64'),
    contentPublicKeySig: Buffer.from(sign(null, contentBinding, privateKey)).toString('base64'),
  });

  const token = String(authRes?.token ?? '').trim();
  if (!token) {
    throw new Error('missing token from /v1/auth response');
  }

  // 2) Write legacy credentials for `happier auth approve`. The legacy secret is the
  // Account's Ed25519 signing seed, so approval can verify it still owns this Account.
  const secret = signingSeed.toString('base64');
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

