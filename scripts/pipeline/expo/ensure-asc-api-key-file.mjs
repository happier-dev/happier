// @ts-check

import fs from 'node:fs';
import path from 'node:path';

function fail(message) {
  throw new Error(message);
}

/**
 * @param {string} raw
 * @returns {string}
 */
export function normalizeAscPrivateKeyPem(raw) {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) fail('Missing App Store Connect private key.');

  if (/BEGIN PRIVATE KEY/.test(trimmed)) {
    return trimmed.endsWith('\n') ? trimmed : `${trimmed}\n`;
  }

  // Some operators store the .p8 PEM as base64 in env vars for easier transport.
  // If no PEM headers are present, treat the value as base64 and decode it.
  try {
    const decoded = Buffer.from(trimmed, 'base64').toString('utf8').trim();
    if (!/BEGIN PRIVATE KEY/.test(decoded)) {
      fail('App Store Connect private key did not contain PEM headers after base64 decoding.');
    }
    return decoded.endsWith('\n') ? decoded : `${decoded}\n`;
  } catch (err) {
    fail(`Invalid App Store Connect private key: expected PEM or base64-encoded PEM. (${String(err?.message ?? err)})`);
  }
}

/**
 * Ensures an App Store Connect API key file exists for EAS submit.
 *
 * @param {{ uiDir: string; keyId: string; privateKey: string; dryRun: boolean }} opts
 * @returns {string} absolute path to the .p8 file
 */
export function ensureAscApiKeyFile(opts) {
  const uiDir = path.resolve(String(opts.uiDir ?? ''));
  const keyId = String(opts.keyId ?? '').trim();
  if (!uiDir) fail('uiDir is required');
  if (!keyId) fail('keyId is required');

  const outPath = path.join(uiDir, '.eas', 'keys', `AuthKey_${keyId}.p8`);
  if (opts.dryRun) return outPath;

  const pem = normalizeAscPrivateKeyPem(opts.privateKey);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, pem, { encoding: 'utf8', mode: 0o600 });
  return outPath;
}

