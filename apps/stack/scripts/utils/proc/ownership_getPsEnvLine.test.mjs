import test from 'node:test';
import assert from 'node:assert/strict';

import { getPsEnvLine, observePsEnvLine, resolvePidStackOwnership } from './ownership.mjs';

test('CLI home ownership prefers the process home over the stack default home', async () => {
  const stackName = 'identity-scope';
  const cliHomeDir = '/stack/cli';
  for (const [bindings, owned] of [
    ['HAPPIER_HOME_DIR=/stack/cli-identities/account-b HAPPIER_STACK_CLI_HOME_DIR=/stack/cli', false],
    ['HAPPIER_HOME_DIR=/stack/cli HAPPIER_STACK_CLI_HOME_DIR=/stack/base', true],
    ['HAPPIER_STACK_CLI_HOME_DIR=/stack/cli', true],
  ]) {
    const result = await resolvePidStackOwnership(424242, { stackName, cliHomeDir }, {
      observePsEnvLineImpl: async () => ({ status: 'ok', line: `424242 HAPPIER_STACK_STACK=${stackName} ${bindings}` }),
    });
    assert.equal(result.owned, owned, bindings);
  }
});

test('real process identity adapter preserves Windows unsupported evidence as inconclusive', async () => {
  const observation = await observePsEnvLine(424242, { platform: 'win32' });
  assert.deepEqual(observation, {
    status: 'inconclusive',
    line: null,
    reason: 'process-identity-unsupported',
  });
  const ownership = await resolvePidStackOwnership(
    424242,
    { stackName: 'test', envPath: 'C:\\happier\\test.env' },
    { platform: 'win32' },
  );
  assert.equal(ownership.status, 'inconclusive');
  assert.equal(ownership.owned, null);
  assert.equal(ownership.reason, 'process-identity-unsupported');
});

test('real process identity adapter preserves unavailable and timed-out ps evidence as inconclusive', async () => {
  for (const code of ['ENOENT', 'ETIMEDOUT']) {
    const error = Object.assign(new Error(code), { code });
    const observation = await observePsEnvLine(424242, {
      platform: 'darwin',
      runCaptureImpl: async () => { throw error; },
      observePidLivenessImpl: () => ({ status: 'alive', reason: 'test' }),
    });
    assert.equal(observation.status, 'inconclusive');
    assert.equal(observation.reason, code === 'ETIMEDOUT' ? 'process-identity-timeout' : 'process-identity-unavailable');
  }
});

test('ownership maps real adapter observations to owned, not-owned, and inconclusive verdicts', async () => {
  const context = { stackName: 'test', envPath: '/tmp/test.env' };
  const owned = await resolvePidStackOwnership(424242, context, {
    platform: 'darwin',
    runCaptureImpl: async () => 'PID COMMAND\n424242 node HAPPIER_STACK_STACK=test HAPPIER_STACK_ENV_FILE=/tmp/test.env\n',
  });
  const mismatch = await resolvePidStackOwnership(424242, context, {
    platform: 'darwin',
    runCaptureImpl: async () => 'PID COMMAND\n424242 node HAPPIER_STACK_STACK=foreign HAPPIER_STACK_ENV_FILE=/tmp/foreign.env\n',
  });
  const inconclusive = await resolvePidStackOwnership(424242, context, {
    platform: 'darwin',
    runCaptureImpl: async () => { throw Object.assign(new Error('missing ps'), { code: 'ENOENT' }); },
    observePidLivenessImpl: () => ({ status: 'alive', reason: 'test' }),
  });

  assert.deepEqual(owned, { status: 'owned', owned: true, reason: 'env_file' });
  assert.deepEqual(mismatch, { status: 'not_owned', owned: false, reason: 'stack_name_mismatch' });
  assert.equal(inconclusive.status, 'inconclusive');
  assert.equal(inconclusive.owned, null);
});

test('getPsEnvLine retries transient ps failures before failing closed', async () => {
  let attempts = 0;
  const delays = [];
  const line = await getPsEnvLine(424242, {
    platform: 'darwin',
    maxAttempts: 3,
    retryDelayMs: 7,
    runCaptureImpl: async () => {
      attempts += 1;
      if (attempts < 3) {
        throw new Error('transient ps failure');
      }
      return 'PID COMMAND\n424242 node HAPPIER_STACK_STACK=t HAPPIER_STACK_ENV_FILE=/tmp/t.env\n';
    },
    observePidLivenessImpl: () => ({ status: 'alive', reason: 'test' }),
    delayImpl: async (ms) => {
      delays.push(ms);
    },
  });

  assert.equal(line, '424242 node HAPPIER_STACK_STACK=t HAPPIER_STACK_ENV_FILE=/tmp/t.env');
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [7, 7]);
});

test('getPsEnvLine stops retrying after a successful ps read', async () => {
  let attempts = 0;
  const line = await getPsEnvLine(424242, {
    platform: 'darwin',
    maxAttempts: 3,
    runCaptureImpl: async () => {
      attempts += 1;
      return 'PID COMMAND\n424242 node HAPPIER_STACK_STACK=t\n';
    },
    delayImpl: async () => {
      assert.fail('successful reads must not wait for another attempt');
    },
  });

  assert.equal(line, '424242 node HAPPIER_STACK_STACK=t');
  assert.equal(attempts, 1);
});
