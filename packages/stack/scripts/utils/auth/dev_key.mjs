import { chmod, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { getHappyStacksHomeDir } from '../paths/paths.mjs';

export function getDevAuthKeyPath(env = process.env) {
  return join(getHappyStacksHomeDir(env), 'keys', 'dev-auth.json');
}

function base64UrlToBytes(s) {
  try {
    const raw = String(s ?? '').trim();
    if (!raw) return null;
    const b64 = raw.replace(/-/g, '+').replace(/_/g, '/');
    const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
    return new Uint8Array(Buffer.from(b64 + pad, 'base64'));
  } catch {
    return null;
  }
}

function bytesToBase64Url(bytes) {
  const b64 = Buffer.from(bytes).toString('base64');
  return b64.replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

// Base32 alphabet (RFC 4648)
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function bytesToBase32(bytes) {
  let result = '';
  let buffer = 0;
  let bufferLength = 0;

  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bufferLength += 8;
    while (bufferLength >= 5) {
      bufferLength -= 5;
      result += BASE32_ALPHABET[(buffer >> bufferLength) & 0x1f];
    }
  }
  if (bufferLength > 0) {
    result += BASE32_ALPHABET[(buffer << (5 - bufferLength)) & 0x1f];
  }
  return result;
}

function base32ToBytes(base32) {
  let normalized = String(base32 ?? '')
    .toUpperCase()
    .replace(/0/g, 'O')
    .replace(/1/g, 'I')
    .replace(/8/g, 'B')
    .replace(/9/g, 'G');
  const cleaned = normalized.replace(/[^A-Z2-7]/g, '');
  if (!cleaned) throw new Error('no valid base32 characters');

  const bytes = [];
  let buffer = 0;
  let bufferLength = 0;
  for (const char of cleaned) {
    const value = BASE32_ALPHABET.indexOf(char);
    if (value === -1) throw new Error('invalid base32 character');
    buffer = (buffer << 5) | value;
    bufferLength += 5;
    if (bufferLength >= 8) {
      bufferLength -= 8;
      bytes.push((buffer >> bufferLength) & 0xff);
    }
  }
  return new Uint8Array(bytes);
}

export function normalizeDevAuthKeyInputToBytes(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return null;

  // Match Happy UI behavior:
  // - backup format is base32 and is long (usually grouped with '-' / spaces)
  // - base64url is short (~43 chars) and may contain '-' / '_' legitimately
  //
  // Key point: avoid mis-parsing backup base32 as base64.
  if (raw.length > 50) {
    try {
      const b32 = base32ToBytes(raw);
      return b32.length === 32 ? b32 : null;
    } catch {
      return null;
    }
  }

  const b64 = base64UrlToBytes(raw);
  if (b64 && b64.length === 32) return b64;
  try {
    const b32 = base32ToBytes(raw);
    return b32.length === 32 ? b32 : null;
  } catch {
    return null;
  }
}

export function formatDevAuthKeyBackup(secretKeyBase64Url) {
  const bytes = base64UrlToBytes(secretKeyBase64Url);
  if (!bytes || bytes.length !== 32) throw new Error('invalid secret key (expected base64url 32 bytes)');
  const base32 = bytesToBase32(bytes);
  const groups = [];
  for (let i = 0; i < base32.length; i += 5) groups.push(base32.slice(i, i + 5));
  return groups.join('-');
}

export async function readDevAuthKey({ env = process.env } = {}) {
  if ((env.HAPPY_STACKS_DEV_AUTH_SECRET_KEY ?? '').toString().trim()) {
    const bytes = normalizeDevAuthKeyInputToBytes(env.HAPPY_STACKS_DEV_AUTH_SECRET_KEY);
    if (!bytes) return { ok: false, error: 'invalid_env_key', source: 'env', secretKeyBase64Url: null, backup: null };
    const base64url = bytesToBase64Url(bytes);
    return { ok: true, source: 'env:HAPPY_STACKS_DEV_AUTH_SECRET_KEY', secretKeyBase64Url: base64url, backup: formatDevAuthKeyBackup(base64url) };
  }

  const path = getDevAuthKeyPath(env);
  try {
    if (!existsSync(path)) return { ok: true, source: `file:${path}`, secretKeyBase64Url: null, backup: null, path };
    const raw = await readFile(path, 'utf-8');
    const parsed = JSON.parse(raw);
    const input = parsed?.secretKeyBase64Url ?? parsed?.secretKey ?? parsed?.key ?? null;
    const bytes = normalizeDevAuthKeyInputToBytes(input);
    if (!bytes) return { ok: false, error: 'invalid_file_key', source: `file:${path}`, secretKeyBase64Url: null, backup: null, path };
    const base64url = bytesToBase64Url(bytes);
    return { ok: true, source: `file:${path}`, secretKeyBase64Url: base64url, backup: formatDevAuthKeyBackup(base64url), path };
  } catch (e) {
    return { ok: false, error: 'failed_to_read', source: `file:${path}`, secretKeyBase64Url: null, backup: null, path, details: e instanceof Error ? e.message : String(e) };
  }
}

export async function writeDevAuthKey({ env = process.env, input } = {}) {
  const bytes = normalizeDevAuthKeyInputToBytes(input);
  if (!bytes || bytes.length !== 32) {
    throw new Error('invalid secret key (expected 32 bytes; accept base64url or backup format)');
  }
  const secretKeyBase64Url = bytesToBase64Url(bytes);
  const path = getDevAuthKeyPath(env);
  await mkdir(dirname(path), { recursive: true });
  const payload = {
    v: 1,
    createdAt: new Date().toISOString(),
    secretKeyBase64Url,
  };
  await writeFile(path, JSON.stringify(payload, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 });
  await chmod(path, 0o600).catch(() => {});
  return { ok: true, path, secretKeyBase64Url, backup: formatDevAuthKeyBackup(secretKeyBase64Url) };
}

export async function clearDevAuthKey({ env = process.env } = {}) {
  const path = getDevAuthKeyPath(env);
  try {
    if (!existsSync(path)) return { ok: true, deleted: false, path };
    await unlink(path);
    return { ok: true, deleted: true, path };
  } catch (e) {
    return { ok: false, deleted: false, path, error: e instanceof Error ? e.message : String(e) };
  }
}
