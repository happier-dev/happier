import test from 'node:test';
import assert from 'node:assert/strict';

import { pickNewestFile } from './notarize-macos-artifacts.mjs';

test('pickNewestFile picks the newest signature when multiple matches exist', () => {
  const sigs = [
    '/tmp/target/release/bundle/macos/Happier Dev.app.tar.gz.sig',
    '/tmp/target/release/bundle/macos/Happier (dev).app.tar.gz.sig',
  ];

  const picked = pickNewestFile(sigs, {
    statSync: (p) => {
      if (p.includes('Happier Dev')) return { mtimeMs: 2000 };
      return { mtimeMs: 1000 };
    },
  });

  assert.equal(picked, sigs[0]);
});

test('pickNewestFile uses a stable winner when mtimes are equal (prefers later entries)', () => {
  const sigs = [
    '/tmp/b.sig',
    '/tmp/a.sig',
  ];

  const picked = pickNewestFile(sigs, {
    statSync: () => ({ mtimeMs: 1234 }),
  });

  assert.equal(picked, '/tmp/a.sig');
});
