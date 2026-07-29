import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import * as stackEnvRunner from './stack/run_script_with_stack_env.mjs';

test('outer start publication records requested UI truth before the child runner starts', () => {
  const base = {
    stackName: 'runtime-ui',
    scriptPath: 'run.mjs',
    ephemeral: false,
    ownerPid: 4242,
    ports: { server: 4101 },
    runtimeSnapshotId: 'snapshot-1',
  };

  assert.equal(stackEnvRunner.createOuterStackRuntimeStartPublication({ ...base, args: ['--no-ui'], env: {} }).serveUi, false);
  assert.equal(
    stackEnvRunner.createOuterStackRuntimeStartPublication({
      ...base,
      args: [],
      env: { HAPPIER_STACK_SERVE_UI: '0' },
    }).serveUi,
    false,
  );
  assert.equal(stackEnvRunner.createOuterStackRuntimeStartPublication({ ...base, args: [], env: {} }).serveUi, true);
});

test('boot-failure cleanup awaits the canonical process-tree owner', async () => {
  const calls = [];
  const child = { pid: 4242, kill(signal) { calls.push(['leader-kill', signal]); } };
  const expectedRuntimeState = {
    ownerPid: 4242,
    startedAt: '2026-07-17T08:00:00.000Z',
  };

  const result = await stackEnvRunner.terminateSpawnedRunnerForBootFailure(child, {
    runtimeStatePath: 'C:\\stack\\stack.runtime.json',
    expectedRuntimeState,
    killProcessTreeImpl: async (target, signal) => {
      calls.push(['tree-kill', target.pid, signal]);
      return { ok: true, signal };
    },
    deleteStackRuntimeStateIfOwnedByImpl: async (_path, expected) => {
      calls.push(['state-delete', expected]);
      return { deleted: true };
    },
  });

  assert.deepEqual(result, { ok: true, signal: 'SIGTERM' });
  assert.deepEqual(calls, [['tree-kill', 4242, 'SIGTERM'], ['state-delete', expectedRuntimeState]]);

  calls.length = 0;
  await stackEnvRunner.terminateSpawnedRunnerForBootFailure(child, {
    runtimeStatePath: 'C:\\stack\\stack.runtime.json',
    killProcessTreeImpl: async () => ({ ok: true }),
    deleteStackRuntimeStateIfOwnedByImpl: async () => { calls.push(['state-delete']); },
  });
  assert.deepEqual(calls, [], 'missing pre-existing identity must not delete runtime state');

  calls.length = 0;
  const unconfirmed = await stackEnvRunner.terminateSpawnedRunnerForBootFailure(child, {
    runtimeStatePath: 'C:\\stack\\stack.runtime.json',
    killProcessTreeImpl: async () => ({ ok: false, reason: 'tree_unconfirmed' }),
    deleteStackRuntimeStateIfOwnedByImpl: async () => { calls.push(['state-delete']); },
  });
  assert.deepEqual(unconfirmed, { ok: false, reason: 'tree_unconfirmed' });
  assert.deepEqual(calls, []);
});

test('hasRecordedRuntimePortsForRestart requires a positive server port', () => {
  assert.equal(stackEnvRunner.hasRecordedRuntimePortsForRestart(null), false);
  assert.equal(stackEnvRunner.hasRecordedRuntimePortsForRestart({ ports: {} }), false);
  assert.equal(stackEnvRunner.hasRecordedRuntimePortsForRestart({ ports: { server: '0' } }), false);
  assert.equal(stackEnvRunner.hasRecordedRuntimePortsForRestart({ ports: { server: '3010' } }), true);
});

test('shouldReuseRuntimePortsOnRestart reuses runtime ports on stale-owner restarts', () => {
  const runtimeState = { ownerPid: 999_999_999, ports: { server: 3010 } };
  assert.equal(
    stackEnvRunner.shouldReuseRuntimePortsOnRestart({ wantsRestart: true, runtimeState, wasRunning: false }),
    true
  );
});

test('shouldReuseRuntimePortsOnRestart stays false when restart was not requested', () => {
  const runtimeState = { ports: { server: 3010 } };
  assert.equal(
    stackEnvRunner.shouldReuseRuntimePortsOnRestart({ wantsRestart: false, runtimeState, wasRunning: true }),
    false
  );
});

test('stopped-stack restart cannot authorize the outer destructive stop path', async () => {
  assert.equal(
    stackEnvRunner.shouldReuseRuntimePortsOnRestart({ wantsRestart: true, runtimeState: null, wasRunning: false }),
    false,
  );

  const source = await readFile(new URL('./stack/run_script_with_stack_env.mjs', import.meta.url), 'utf8');
  const decisionBoundary = source.indexOf('const isTrueRestart =');
  const stopBoundary = source.indexOf('await stopStackWithEnv({', decisionBoundary);
  const stopGuardBoundary = source.lastIndexOf('if (isTrueRestart)', stopBoundary);
  assert.ok(
    decisionBoundary >= 0 && stopGuardBoundary > decisionBoundary && stopBoundary > stopGuardBoundary,
    'the canonical true-restart decision must guard the destructive outer stop',
  );
  assert.doesNotMatch(
    source,
    /listListenPids\([^)]*\)[\s\S]{0,1200}killProcessGroupOwnedByStack\(/,
    'restart wrappers must never select a termination target from a listening port',
  );
});

test('buildAlreadyRunningMobileMetroArgs preserves Expo Tailscale mode', () => {
  assert.equal(typeof stackEnvRunner.buildAlreadyRunningMobileMetroArgs, 'function');
  assert.deepEqual(
    stackEnvRunner.buildAlreadyRunningMobileMetroArgs(['--mobile', '--expo-tailscale']),
    ['--metro', '--expo-tailscale']
  );
});

test('inspectExistingStartLikeRuntime treats --expo-tailscale as a mobile request', async () => {
  const result = await stackEnvRunner.inspectExistingStartLikeRuntime({
    scriptPath: 'dev.mjs',
    args: ['--expo-tailscale'],
  });

  assert.equal(result.wantsMobile, true);
});
