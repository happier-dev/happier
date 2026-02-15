import test from 'node:test';
import assert from 'node:assert/strict';

import { verifyMinisign, DEFAULT_MINISIGN_PUBLIC_KEY } from '../dist/minisign.js';

test('verifyMinisign validates bundled minisign public key format', () => {
  assert.match(DEFAULT_MINISIGN_PUBLIC_KEY, /minisign public key/i);
  assert.match(DEFAULT_MINISIGN_PUBLIC_KEY, /^RW/m);
});

test('verifyMinisign returns false for invalid signature payload', () => {
  assert.equal(
    verifyMinisign({
      message: Buffer.from('hello'),
      pubkeyFile: DEFAULT_MINISIGN_PUBLIC_KEY,
      sigFile: 'bad\nsig\nfile\n',
    }),
    false,
  );
});

