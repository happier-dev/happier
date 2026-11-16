import assert from 'node:assert/strict';
import test from 'node:test';
import { formatDevAuthKeyBackup, normalizeDevAuthKeyInputToBytes } from './dev_key.mjs';

test('normalizes the same account key from raw, backup and canonical key-file stdin', () => {
  const key = Buffer.from(Array.from({ length: 32 }, (_, index) => index));
  const inputs = [
    key.toString('base64url'),
    formatDevAuthKeyBackup(key.toString('base64url')),
    JSON.stringify({ token: 'fixture-bearer', secret: key.toString('base64') }),
    JSON.stringify({ v: 1, secretKeyBase64Url: key.toString('base64url') }),
    JSON.stringify({ secretKey: key.toString('base64url') }),
    JSON.stringify({ key: key.toString('base64url') }),
  ];
  for (const input of inputs) {
    assert.deepEqual(normalizeDevAuthKeyInputToBytes(input), new Uint8Array(key));
  }
});

test('refuses malformed or keyless credential JSON instead of interpreting other credential material as an account key', () => {
  const key = Buffer.alloc(32, 7).toString('base64');
  for (const input of [
    '{"secret":',
    JSON.stringify({ token: key }),
    JSON.stringify({ token: 'fixture-bearer', encryption: { publicKey: key, machineKey: key } }),
    JSON.stringify({ secret: { secret: key } }),
    JSON.stringify({ secret: 'invalid' }),
  ]) {
    assert.equal(normalizeDevAuthKeyInputToBytes(input), null);
  }
});
