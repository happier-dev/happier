import test from 'node:test';
import assert from 'node:assert/strict';

import { loadSecrets } from './load-secrets.mjs';

test('loadSecrets (auto) falls back to env when Keychain is unavailable', () => {
  const previousPath = process.env.PATH;
  try {
    // Force `execFileSync('security', ...)` to behave like it would on Linux runners (ENOENT).
    process.env.PATH = '';

    const baseEnv = { FOO: 'bar' };
    const { env, usedKeychain } = loadSecrets({
      baseEnv,
      secretsSource: 'auto',
      keychainService: 'happier/pipeline',
      keychainAccount: undefined,
    });

    assert.deepEqual(env, baseEnv);
    assert.equal(usedKeychain, false);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
});

test('loadSecrets (keychain) errors with a clear message when Keychain is unavailable', () => {
  const previousPath = process.env.PATH;
  try {
    process.env.PATH = '';

    assert.throws(() => {
      loadSecrets({
        baseEnv: {},
        secretsSource: 'keychain',
        keychainService: 'happier/pipeline',
        keychainAccount: undefined,
      });
    }, /keychain|security|macos/i);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
});

