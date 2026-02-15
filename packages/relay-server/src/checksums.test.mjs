import test from 'node:test';
import assert from 'node:assert/strict';

import { lookupSha256 } from '@happier-dev/release-runtime/checksums';

test('lookupSha256 returns sha256 for matching filename', () => {
  const text = [
    'aaaabbbb  file-one.tar.gz',
    '1234abcd  happier-server-v0.1.0-linux-x64.tar.gz',
    '',
  ].join('\n');
  assert.equal(lookupSha256({ checksumsText: text, filename: 'happier-server-v0.1.0-linux-x64.tar.gz' }), '1234abcd');
});

test('lookupSha256 throws when filename not present', () => {
  assert.throws(() => lookupSha256({ checksumsText: 'aaaa  other', filename: 'missing' }));
});
