import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { sanitizeStackTestRunnerEnv } from './test_env.mjs';

test('sanitizeStackTestRunnerEnv removes live stack and server scope from inherited test env', () => {
  const env = sanitizeStackTestRunnerEnv({
    PATH: '/bin',
    HOME: '/Users/alice',
    HAPPIER_STACK_STACK: 'repo-live',
    HAPPIER_STACK_ENV_FILE: '/Users/alice/.happier/stacks/repo-live/env',
    HAPPIER_STACK_SERVER_PORT: '52753',
    HAPPIER_HOME_DIR: '/Users/alice/.happier/stacks/repo-live/cli',
    HAPPIER_SERVER_URL: 'http://127.0.0.1:52753',
    HAPPIER_WEBAPP_URL: 'http://happier-repo-live.localhost:18829',
    HAPPIER_ACTIVE_SERVER_ID: 'stack_repo_live__id_default',
    HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID: 'stack_repo_live__id_default',
    HAPPIER_CLI_SUBPROCESS_DIST_ENTRYPOINT: '/Users/alice/live-stack-repo/apps/cli/dist/index.mjs',
    HAPPIER_CLI_SUBPROCESS_STACK_RUNTIME_STATE_PATH: '/Users/alice/.happier/stacks/repo-live/stack.runtime.json',
    HAPPIER_CLI_SUBPROCESS_DAEMON_DIST_CLOSURE_FINGERPRINT: 'live-fingerprint',
    HAPPIER_CLI_SUBPROCESS_RUNTIME_BACKED: '1',
    HAPPIER_FEATURE_POLICY_ENV: '',
    HAPPIER_TEST_FEATURES_DENY: 'voice',
  });

  assert.deepEqual(env, {
    PATH: '/bin',
    HOME: '/Users/alice',
    HAPPIER_FEATURE_POLICY_ENV: '',
    HAPPIER_TEST_FEATURES_DENY: 'voice',
  });
  assert.equal(env.HAPPIER_STACK_TEST_ISOLATED_ROOT, undefined);
  assert.equal(env.HAPPIER_STACK_TEST_REPO_DIR, undefined);
});

test('sanitizeStackTestRunnerEnv can seed isolated stack roots for runner subprocesses', () => {
  const env = sanitizeStackTestRunnerEnv(
    {
      PATH: '/bin',
      HOME: '/Users/alice',
      HAPPIER_STACK_CANONICAL_HOME_DIR: '/Users/alice/.happier-stack',
      HAPPIER_STACK_HOME_DIR: '/Users/alice/.happier-stack',
      HAPPIER_STACK_STORAGE_DIR: '/Users/alice/.happier/stacks',
    },
    {
      isolatedStackRoot: '/tmp/happier-stack-test-root',
    },
  );

  assert.equal(env.HAPPIER_STACK_HOME_DIR, '/tmp/happier-stack-test-root/home');
  assert.equal(env.HAPPIER_STACK_STORAGE_DIR, '/tmp/happier-stack-test-root/stacks');
  assert.equal(env.HAPPIER_STACK_WORKSPACE_DIR, '/tmp/happier-stack-test-root/workspace');
  assert.equal(env.HAPPIER_STACK_RUNTIME_DIR, '/tmp/happier-stack-test-root/runtime');
  assert.equal(env.HAPPIER_STACK_CANONICAL_HOME_DIR, '/tmp/happier-stack-test-root/canonical-home');
  assert.equal(env.HOME, '/Users/alice');
});

test('sanitizeStackTestRunnerEnv can seed the repo checkout without restoring live stack scope', () => {
  const env = sanitizeStackTestRunnerEnv(
    {
      PATH: '/bin',
      HAPPIER_STACK_STACK: 'repo-live',
      HAPPIER_STACK_REPO_DIR: '/Users/alice/live-stack-repo',
    },
    {
      isolatedStackRoot: '/tmp/happier-stack-test-root',
      repoDir: '/workspace/happier',
    },
  );

  assert.equal(env.HAPPIER_STACK_STACK, undefined);
  assert.equal(env.HAPPIER_STACK_REPO_DIR, '/workspace/happier');
});

test('sanitizeStackTestRunnerEnv preserves sanitizer-owned isolation across nested calls', () => {
  const root = '/tmp/happier-stack-nested-root';
  const first = sanitizeStackTestRunnerEnv(
    {
      HOME: '/Users/alice',
      HAPPIER_STACK_CANONICAL_HOME_DIR: '/Users/alice/.happier-stack',
      HAPPIER_STACK_HOME_DIR: '/Users/alice/.happier-stack',
      HAPPIER_STACK_STORAGE_DIR: '/Users/alice/.happier/stacks',
      HAPPIER_STACK_RUNTIME_DIR: '/Users/alice/.happier-stack/runtime',
      HAPPIER_STACK_REPO_DIR: '/Users/alice/live-repo',
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
  assert.equal(nested.HOME, '/Users/alice');
});
