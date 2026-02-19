import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ensureAscApiKeyFile, normalizeAscPrivateKeyPem } from '../pipeline/expo/ensure-asc-api-key-file.mjs';

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'happier-asc-key-'));
}

test('normalizeAscPrivateKeyPem preserves PEM and ensures trailing newline', () => {
  const pem = '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----';
  assert.equal(normalizeAscPrivateKeyPem(pem), `${pem}\n`);
});

test('normalizeAscPrivateKeyPem decodes base64 (no headers) to PEM', () => {
  const raw = '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n';
  const base64 = Buffer.from(raw, 'utf8').toString('base64');
  assert.equal(normalizeAscPrivateKeyPem(base64), raw);
});

test('ensureAscApiKeyFile writes the key under apps/ui/.eas/keys', () => {
  const dir = makeTempDir();
  const uiDir = path.join(dir, 'apps', 'ui');
  fs.mkdirSync(uiDir, { recursive: true });

  const keyId = 'ABC123DEFG';
  const privateKeyPem = '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n';
  const outPath = ensureAscApiKeyFile({ uiDir, keyId, privateKey: privateKeyPem, dryRun: false });
  assert.ok(outPath.endsWith(path.join('.eas', 'keys', `AuthKey_${keyId}.p8`)));
  assert.equal(fs.readFileSync(outPath, 'utf8'), privateKeyPem);
});

test('ensureAscApiKeyFile supports dry-run without writing', () => {
  const dir = makeTempDir();
  const uiDir = path.join(dir, 'apps', 'ui');
  fs.mkdirSync(uiDir, { recursive: true });

  const keyId = 'ABC123DEFG';
  const privateKeyPem = '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n';
  const outPath = ensureAscApiKeyFile({ uiDir, keyId, privateKey: privateKeyPem, dryRun: true });
  assert.ok(outPath.endsWith(path.join('.eas', 'keys', `AuthKey_${keyId}.p8`)));
  assert.equal(fs.existsSync(outPath), false);
});

