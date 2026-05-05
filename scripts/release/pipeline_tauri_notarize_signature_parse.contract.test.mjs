import test from 'node:test';
import assert from 'node:assert/strict';

import { extractTauriUpdaterSignature } from '../pipeline/tauri/notarize-macos-artifacts.mjs';

test('extractTauriUpdaterSignature picks the base64 signature out of noisy tauri output', () => {
  const sig = `${'A'.repeat(86)}==`;
  const out = [
    'tauri signer sign v2.0.0',
    'some warning that includes base64-ish stuff: AAAA',
    `Signature: ${sig}`,
    'done',
    '',
  ].join('\n');

  assert.equal(extractTauriUpdaterSignature(out), sig);
});

test('extractTauriUpdaterSignature preserves a standalone long signature line', () => {
  const sig = Buffer.from(
    [
      'untrusted comment: signature from tauri secret key',
      `${'A'.repeat(88)}==`,
      'trusted comment: timestamp:1775372442\tfile:Happier.app.tar.gz',
      `${'B'.repeat(88)}==`,
      '',
    ].join('\n'),
    'utf8',
  ).toString('base64');
  assert.ok(sig.length > 256);

  const out = [
    'tauri signer sign v2.0.0',
    'Signature:',
    sig,
    '',
  ].join('\n');

  assert.equal(extractTauriUpdaterSignature(out), sig);
});
