import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { sanitizeStackTestRunnerEnv } from './test_env.mjs';

test('sanitizeStackTestRunnerEnv removes live stack and server scope from inherited env', () => {
  const env = sanitizeStackTestRunnerEnv({
    HAPPIER_ACTIVE_SERVER_ID: 'live-server',
    HAPPIER_DAEMON_SERVICE_LABEL: 'live-daemon',
    HAPPIER_DAEMON_STARTUP_SOURCE: 'live-source',
    HAPPIER_HOME_DIR: '/Users/example/.happier',
    HAPPIER_SERVER_URL: 'http://localhost:1234',
    HAPPIER_WEBAPP_URL: 'http://localhost:5678',
    HAPPIER_STACK_HOME_DIR: '/Users/example/.happier-stack',
    HAPPIER_STACK_STORAGE_DIR: '/Users/example/.happier/stacks',
    HAPPIER_STACK_REPO_DIR: '/repo/live',
    KEEP_ME: 'yes',
  });

  assert.equal(env.KEEP_ME, 'yes');
  assert.equal(env.HAPPIER_ACTIVE_SERVER_ID, undefined);
  assert.equal(env.HAPPIER_DAEMON_SERVICE_LABEL, undefined);
  assert.equal(env.HAPPIER_DAEMON_STARTUP_SOURCE, undefined);
  assert.equal(env.HAPPIER_HOME_DIR, undefined);
  assert.equal(env.HAPPIER_SERVER_URL, undefined);
  assert.equal(env.HAPPIER_WEBAPP_URL, undefined);
  assert.equal(env.HAPPIER_STACK_HOME_DIR, undefined);
  assert.equal(env.HAPPIER_STACK_STORAGE_DIR, undefined);
  assert.equal(env.HAPPIER_STACK_REPO_DIR, undefined);
});

test('sanitizeStackTestRunnerEnv seeds isolated stack roots when requested', () => {
  const root = '/tmp/happier-stack-unit-abc';
  const env = sanitizeStackTestRunnerEnv(
    {
      HAPPIER_STACK_HOME_DIR: '/live/home',
      HAPPIER_STACK_STORAGE_DIR: '/live/stacks',
      HAPPIER_STACK_WORKSPACE_DIR: '/live/workspace',
      HAPPIER_STACK_RUNTIME_DIR: '/live/runtime',
    },
    { isolatedStackRoot: root },
  );

  assert.equal(env.HAPPIER_STACK_HOME_DIR, join(root, 'home'));
  assert.equal(env.HAPPIER_STACK_STORAGE_DIR, join(root, 'stacks'));
  assert.equal(env.HAPPIER_STACK_WORKSPACE_DIR, join(root, 'workspace'));
  assert.equal(env.HAPPIER_STACK_RUNTIME_DIR, join(root, 'runtime'));
});

test('sanitizeStackTestRunnerEnv can seed the repo checkout without restoring live stack scope', () => {
  const env = sanitizeStackTestRunnerEnv(
    {
      HAPPIER_STACK_REPO_DIR: '/live/repo',
      HAPPIER_SERVER_URL: 'http://localhost:1234',
    },
    { repoDir: '/repo/test' },
  );

  assert.equal(env.HAPPIER_STACK_REPO_DIR, '/repo/test');
  assert.equal(env.HAPPIER_SERVER_URL, undefined);
});
