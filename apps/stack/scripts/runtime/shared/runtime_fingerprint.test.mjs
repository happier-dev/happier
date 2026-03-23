import test from 'node:test';
import assert from 'node:assert/strict';

import { createRuntimeFingerprint } from './runtime_fingerprint.mjs';

test('createRuntimeFingerprint is stable for identical inputs', () => {
  const a = createRuntimeFingerprint({
    repoDir: '/repo/dev',
    commitSha: 'abcdef1234567890',
    dirtyHash: 'dirty-1',
    serverComponent: 'happier-server-light',
    dbProvider: 'sqlite',
    components: ['web', 'server', 'daemon'],
  });
  const b = createRuntimeFingerprint({
    repoDir: '/repo/dev',
    commitSha: 'abcdef1234567890',
    dirtyHash: 'dirty-1',
    serverComponent: 'happier-server-light',
    dbProvider: 'sqlite',
    components: ['web', 'server', 'daemon'],
  });

  assert.equal(a, b);
});

test('createRuntimeFingerprint changes when any source input changes', () => {
  const base = createRuntimeFingerprint({
    repoDir: '/repo/dev',
    commitSha: 'abcdef1234567890',
    dirtyHash: 'dirty-1',
    serverComponent: 'happier-server-light',
    dbProvider: 'sqlite',
    components: ['web', 'server', 'daemon'],
  });
  const changed = createRuntimeFingerprint({
    repoDir: '/repo/dev',
    commitSha: 'abcdef1234567890',
    dirtyHash: 'dirty-2',
    serverComponent: 'happier-server-light',
    dbProvider: 'sqlite',
    components: ['web', 'server', 'daemon'],
  });

  assert.notEqual(base, changed);
});

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
