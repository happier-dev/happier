import test from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';

import { expandHome, getCanonicalHomeDirFromEnv, getCanonicalHomeEnvPathFromEnv } from './canonical_home.mjs';

test('expandHome expands ~/ paths', () => {
  assert.equal(expandHome('~/x'), `${homedir()}/x`);
});

test('expandHome expands ~\\ paths (Windows)', () => {
  assert.equal(expandHome('~\\x'), `${homedir()}\\x`);
});

test('expandHome leaves non-home-prefixed paths unchanged', () => {
  assert.equal(expandHome('~user/x'), '~user/x');
  assert.equal(expandHome('/tmp/x'), '/tmp/x');
});

test('getCanonicalHomeDirFromEnv expands override and defaults to ~/.happier-stack', () => {
  assert.equal(getCanonicalHomeDirFromEnv({ HAPPIER_STACK_CANONICAL_HOME_DIR: '~/custom-home' }), `${homedir()}/custom-home`);
  assert.equal(getCanonicalHomeDirFromEnv({}), `${homedir()}/.happier-stack`);
});

test('getCanonicalHomeEnvPathFromEnv resolves .env under canonical home', () => {
  const envPath = getCanonicalHomeEnvPathFromEnv({ HAPPIER_STACK_CANONICAL_HOME_DIR: '~/custom-home' });
  assert.equal(envPath, `${homedir()}/custom-home/.env`);
});
