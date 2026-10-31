import test from 'node:test';
import assert from 'node:assert/strict';

import { createRuntimeFingerprint } from './runtime_fingerprint.mjs';

test('createRuntimeFingerprint includes build inputs in the hash', () => {
  const base = createRuntimeFingerprint({
    repoDir: '/repo/dev',
    commitSha: 'abcdef1234567890',
    dirtyHash: 'dirty-1',
    serverComponent: 'happier-server-light',
    dbProvider: 'sqlite',
    components: ['server'],
    buildInputs: ['bunExternals=redis'],
  });
  const changed = createRuntimeFingerprint({
    repoDir: '/repo/dev',
    commitSha: 'abcdef1234567890',
    dirtyHash: 'dirty-1',
    serverComponent: 'happier-server-light',
    dbProvider: 'sqlite',
    components: ['server'],
    buildInputs: ['bunExternals='],
  });

  assert.notEqual(base, changed);
});
