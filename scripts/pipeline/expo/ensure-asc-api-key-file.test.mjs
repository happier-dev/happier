// @ts-check

import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeAscPrivateKeyPem } from './ensure-asc-api-key-file.mjs';

const PEM_LINES = [
  '-----BEGIN PRIVATE KEY-----',
  'MIGTAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBHkwdwIBAQQgAAAAAAAAAAAAAAAA',
  'AAAAAAAAAAAAAAAAAAAAAAagCgYIKoZIzj0DAQehRANCAAAAAAAAAAAAAAAAAAAA',
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  '-----END PRIVATE KEY-----',
];

test('normalizeAscPrivateKeyPem preserves PEM and ensures trailing newline', () => {
  const pem = `${PEM_LINES.join('\n')}\n`;
  assert.equal(normalizeAscPrivateKeyPem(pem), pem);
});

test('normalizeAscPrivateKeyPem unescapes literal \\\\n sequences for PEM', () => {
  const pemEscaped = `${PEM_LINES.join('\\n')}\\n`;
  assert.equal(normalizeAscPrivateKeyPem(pemEscaped), `${PEM_LINES.join('\n')}\n`);
});

test('normalizeAscPrivateKeyPem decodes base64 PEM and unescapes literal \\\\n sequences', () => {
  const pemEscaped = `${PEM_LINES.join('\\n')}\\n`;
  const base64 = Buffer.from(pemEscaped, 'utf8').toString('base64');
  assert.equal(normalizeAscPrivateKeyPem(base64), `${PEM_LINES.join('\n')}\n`);
});

