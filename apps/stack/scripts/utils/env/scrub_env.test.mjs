import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SANDBOX_PRESERVE_KEYS,
  STACK_WRAPPER_PRESERVE_KEYS,
  scrubHappierStackEnv,
} from './scrub_env.mjs';

test('scrubHappierStackEnv removes non-preserved HAPPIER_STACK_* vars and clears selected unprefixed keys', () => {
  const env = {
    PATH: '/bin',
    HAPPIER_STACK_VERBOSE: '1',
    HAPPIER_STACK_FOO: 'bar',
    HAPPIER_HOME_DIR: '/tmp/happier-home',
    HAPPIER_SERVER_URL: 'http://example.com',
  };

  const scrubbed = scrubHappierStackEnv(env, {
    keepHappierStackKeys: SANDBOX_PRESERVE_KEYS,
    clearUnprefixedKeys: ['HAPPIER_HOME_DIR', 'HAPPIER_SERVER_URL'],
  });

  assert.equal(scrubbed.PATH, '/bin');
  assert.equal(scrubbed.HAPPIER_STACK_VERBOSE, '1');
  assert.equal(scrubbed.HAPPIER_STACK_FOO, undefined);
  assert.equal(scrubbed.HAPPIER_HOME_DIR, undefined);
  assert.equal(scrubbed.HAPPIER_SERVER_URL, undefined);
});

test('scrubHappierStackEnv keeps runtime-critical non-HAPPIER env keys', () => {
  const env = {
    PATH: '/bin:/usr/bin',
    HOME: '/tmp/home',
    TMPDIR: '/tmp',
    SHELL: '/bin/zsh',
    HAPPIER_STACK_SECRET: 'drop-me',
  };

  const scrubbed = scrubHappierStackEnv(env, {
    keepHappierStackKeys: [],
    clearUnprefixedKeys: [],
  });

  assert.equal(scrubbed.PATH, '/bin:/usr/bin');
  assert.equal(scrubbed.HOME, '/tmp/home');
  assert.equal(scrubbed.TMPDIR, '/tmp');
  assert.equal(scrubbed.SHELL, '/bin/zsh');
  assert.equal(scrubbed.HAPPIER_STACK_SECRET, undefined);
});

test('scrubHappierStackEnv preserves only explicitly kept HAPPIER_STACK keys', () => {
  const env = {
    HAPPIER_STACK_VERBOSE: '1',
    HAPPIER_STACK_SANDBOX_DIR: '/tmp/sandbox',
    HAPPIER_STACK_SECRET: 'drop-me',
  };
  const scrubbed = scrubHappierStackEnv(env, {
    keepHappierStackKeys: [' HAPPIER_STACK_SANDBOX_DIR ', ''],
    clearUnprefixedKeys: [],
  });

  assert.equal(scrubbed.HAPPIER_STACK_SANDBOX_DIR, '/tmp/sandbox');
  assert.equal(scrubbed.HAPPIER_STACK_VERBOSE, undefined);
  assert.equal(scrubbed.HAPPIER_STACK_SECRET, undefined);
});

test('scrubHappierStackEnv trims and de-duplicates clearUnprefixedKeys', () => {
  const env = {
    PATH: '/bin',
    HAPPIER_HOME_DIR: '/tmp/home',
    HAPPIER_SERVER_URL: 'http://localhost:3000',
    HAPPIER_STACK_KEEP: 'keep',
  };
  const scrubbed = scrubHappierStackEnv(env, {
    keepHappierStackKeys: ['HAPPIER_STACK_KEEP'],
    clearUnprefixedKeys: [' HAPPIER_HOME_DIR ', 'HAPPIER_SERVER_URL', 'HAPPIER_SERVER_URL'],
  });

  assert.equal(scrubbed.PATH, '/bin');
  assert.equal(scrubbed.HAPPIER_HOME_DIR, undefined);
  assert.equal(scrubbed.HAPPIER_SERVER_URL, undefined);
  assert.equal(scrubbed.HAPPIER_STACK_KEEP, 'keep');
});

test('scrubHappierStackEnv preserves HAPPIER_STACK_TUI in stack wrapper mode', () => {
  const env = {
    PATH: '/bin',
    HAPPIER_STACK_TUI: '1',
    HAPPIER_STACK_VERBOSE: '1',
    HAPPIER_STACK_SECRET: 'drop-me',
  };
  const scrubbed = scrubHappierStackEnv(env, {
    keepHappierStackKeys: STACK_WRAPPER_PRESERVE_KEYS,
    clearUnprefixedKeys: [],
  });

  assert.equal(scrubbed.PATH, '/bin');
  assert.equal(scrubbed.HAPPIER_STACK_TUI, '1');
  assert.equal(scrubbed.HAPPIER_STACK_VERBOSE, '1');
  assert.equal(scrubbed.HAPPIER_STACK_SECRET, undefined);
});
