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
  assert.equal(env.HAPPIER_STACK_TEST_ISOLATED_ROOT, undefined);
  assert.equal(env.HAPPIER_STACK_TEST_REPO_DIR, undefined);
});

test('sanitizeStackTestRunnerEnv seeds isolated stack roots when requested', () => {
  const root = '/tmp/happier-stack-unit-abc';
  const env = sanitizeStackTestRunnerEnv(
    {
      HOME: '/Users/example',
      HAPPIER_STACK_CANONICAL_HOME_DIR: '/Users/example/.happier-stack',
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
  assert.equal(env.HAPPIER_STACK_CANONICAL_HOME_DIR, join(root, 'canonical-home'));
  assert.equal(env.HOME, '/Users/example');
  assert.equal(env.HAPPIER_STACK_CLI_ROOT_DISABLE, '1');
});

test('sanitizeStackTestRunnerEnv preserves admitted execution identity while isolating stack state and caches', () => {
  const root = '/tmp/happier-stack-unit-abc';
  const env = sanitizeStackTestRunnerEnv(
    {
      HAPPIER_DEV_TARGET_EXECUTION: '1',
      HAPPIER_PREFERRED_EXECUTION: 'remote',
      HAPPIER_HEAVYWEIGHT_ADMISSION_TOKEN: 'pid:token',
      HAPPIER_HEAVYWEIGHT_ADMISSION_ROOT: '/live/admission',
      HAPPIER_HEAVYWEIGHT_ADMISSION_MACHINE: 'mac3-linux',
      HAPPIER_HSTACK_DISPATCH_CONTROL: '1',
      HAPPIER_HSTACK_EXECUTION: 'remote',
      YARN_CACHE_FOLDER: '/live/yarn-cache',
      npm_config_cache: '/live/npm-cache',
      npm_execpath: '/live/yarn.js',
      npm_node_execpath: '/live/node',
    },
    { isolatedStackRoot: root },
  );

  assert.equal(env.HAPPIER_DEV_TARGET_EXECUTION, '1');
  assert.equal(env.HAPPIER_PREFERRED_EXECUTION, undefined);
  assert.equal(env.HAPPIER_HEAVYWEIGHT_ADMISSION_TOKEN, 'pid:token');
  assert.equal(env.HAPPIER_HEAVYWEIGHT_ADMISSION_ROOT, '/live/admission');
  assert.equal(env.HAPPIER_HEAVYWEIGHT_ADMISSION_MACHINE, 'mac3-linux');
  assert.equal(env.HAPPIER_HSTACK_DISPATCH_CONTROL, undefined);
  assert.equal(env.HAPPIER_HSTACK_EXECUTION, undefined);
  assert.equal(env.YARN_CACHE_FOLDER, join(root, 'cache', 'yarn'));
  assert.equal(env.npm_config_cache, join(root, 'cache', 'npm'));
  assert.equal(env.npm_execpath, undefined);
  assert.equal(env.npm_node_execpath, undefined);
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

test('sanitizeStackTestRunnerEnv preserves sanitizer-owned isolation across nested calls', () => {
  const root = '/tmp/happier-stack-nested-root';
  const first = sanitizeStackTestRunnerEnv(
    {
      HOME: '/Users/example',
      HAPPIER_STACK_CANONICAL_HOME_DIR: '/Users/example/.happier-stack',
      HAPPIER_STACK_HOME_DIR: '/Users/example/.happier-stack',
      HAPPIER_STACK_STORAGE_DIR: '/Users/example/.happier/stacks',
      HAPPIER_STACK_RUNTIME_DIR: '/Users/example/.happier-stack/runtime',
      HAPPIER_STACK_REPO_DIR: '/Users/example/live-repo',
    },
    { isolatedStackRoot: root, repoDir: '/workspace/happier' },
  );

  const nested = sanitizeStackTestRunnerEnv(first);

  assert.equal(nested.HAPPIER_STACK_CANONICAL_HOME_DIR, join(root, 'canonical-home'));
  assert.equal(nested.HAPPIER_STACK_HOME_DIR, join(root, 'home'));
  assert.equal(nested.HAPPIER_STACK_STORAGE_DIR, join(root, 'stacks'));
  assert.equal(nested.HAPPIER_STACK_WORKSPACE_DIR, join(root, 'workspace'));
  assert.equal(nested.HAPPIER_STACK_RUNTIME_DIR, join(root, 'runtime'));
  assert.equal(nested.HAPPIER_STACK_REPO_DIR, '/workspace/happier');
  assert.equal(nested.HOME, '/Users/example');
});
