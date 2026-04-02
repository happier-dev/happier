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

