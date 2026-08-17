import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

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

test('fresh non-restart allocation excludes a stale recorded port held by a foreign listener', async () => {
  const staleForeignPort = 3012;
  const reservedPorts = new Set();
  const pickedPorts = [];
  const availabilityChecks = [];

  const selected = await stackEnvRunner.allocateFreshEphemeralServerPort({
    startPort: staleForeignPort,
    staleRuntimeServerPort: staleForeignPort,
    reservedPorts,
    pickNextFreeTcpPortImpl: async (_startPort, { reservedPorts: observedReservedPorts }) => {
      assert.ok(observedReservedPorts.has(staleForeignPort), 'stale runtime state must not select the foreign port');
      pickedPorts.push(3013);
      return 3013;
    },
    isTcpPortFreeImpl: async (port) => {
      availabilityChecks.push(port);
      return port === 3013;
    },
  });

  assert.equal(selected, 3013);
  assert.deepEqual(pickedPorts, [3013]);
  assert.deepEqual(availabilityChecks, [3013]);
  assert.ok(!availabilityChecks.includes(staleForeignPort), 'allocation must not claim the foreign listener');
  assert.ok(reservedPorts.has(3012));
});

test('fresh non-restart allocation retries one racy candidate', async () => {
  const reservedPorts = new Set();
  const pickedPorts = [];
  const availabilityChecks = [];
  const candidates = [3013, 3014];

  const selected = await stackEnvRunner.allocateFreshEphemeralServerPort({
    startPort: 3012,
    staleRuntimeServerPort: 3012,
    reservedPorts,
    pickNextFreeTcpPortImpl: async () => {
      const next = candidates.shift();
      pickedPorts.push(next);
      return next;
    },
    isTcpPortFreeImpl: async (port) => {
      availabilityChecks.push(port);
      return port === 3014;
    },
  });

  assert.equal(selected, 3014);
  assert.deepEqual(pickedPorts, [3013, 3014]);
  assert.deepEqual(availabilityChecks, [3013, 3014]);
  assert.ok(reservedPorts.has(3013));
});

test('fresh non-restart allocation fails closed after its one bounded replacement', async () => {
  const pickedPorts = [];
  const candidates = [3013, 3014, 3015];

  await assert.rejects(
    () => stackEnvRunner.allocateFreshEphemeralServerPort({
      startPort: 3012,
      staleRuntimeServerPort: 3012,
      reservedPorts: new Set(),
      pickNextFreeTcpPortImpl: async () => {
        const next = candidates.shift();
        pickedPorts.push(next);
        return next;
      },
      isTcpPortFreeImpl: async () => false,
    }),
    /unable to allocate a free server port after a bounded retry/,
  );

  assert.deepEqual(pickedPorts, [3013, 3014]);
});

test('stopped-stack restart cannot authorize the outer destructive stop path', async () => {
  assert.equal(
    stackEnvRunner.shouldReuseRuntimePortsOnRestart({ wantsRestart: true, runtimeState: null, wasRunning: false }),
    false,
  );

  const source = await readFile(new URL('./stack/run_script_with_stack_env.mjs', import.meta.url), 'utf8');
  const decisionBoundary = source.indexOf('const isTrueRestart =');
  const stopBoundary = source.indexOf('await stopObservedStackForRestart({', decisionBoundary);
  const stopGuardBoundary = source.lastIndexOf('if (isTrueRestart)', stopBoundary);
  assert.ok(
    decisionBoundary >= 0 && stopGuardBoundary > decisionBoundary && stopBoundary > stopGuardBoundary,
    'the canonical true-restart decision must guard the destructive outer stop',
  );
  assert.equal(
    (source.match(/await stopObservedStackForRestart\(/g) ?? []).length,
    2,
    'both restart cleanup paths must use the observed lifecycle fence',
  );
  assert.doesNotMatch(
    source,
    /listListenPids\([^)]*\)[\s\S]{0,1200}killProcessGroupOwnedByStack\(/,
    'restart wrappers must never select a termination target from a listening port',
  );
});

test('restart cleanup is fenced to the originally observed lifecycle', async () => {
  const baseDir = await mkdtemp(join(tmpdir(), 'hstack-restart-successor-'));
  const runtimeStatePath = join(baseDir, 'stack.runtime.json');
  const observedRuntimeState = {
    version: 1,
    stackName: 'restart-successor-fence',
    ownerPid: 999_999,
    startedAt: '2026-08-13T08:00:00.000Z',
    processes: {},
  };
  const successorRuntimeState = {
    ...observedRuntimeState,
    startedAt: '2026-08-13T08:00:00.001Z',
    sentinel: 'successor-must-survive',
  };

  try {
    await mkdir(join(baseDir, 'cli'), { recursive: true });
    await writeFile(runtimeStatePath, `${JSON.stringify(successorRuntimeState)}\n`, 'utf8');

    const result = await stackEnvRunner.stopObservedStackForRestart({
      rootDir: baseDir,
      stackName: observedRuntimeState.stackName,
      baseDir,
      env: {
        HAPPIER_STACK_STACK: observedRuntimeState.stackName,
        HAPPIER_STACK_ENV_FILE: join(baseDir, 'env'),
        HAPPIER_STACK_CLI_HOME_DIR: join(baseDir, 'cli'),
        HAPPIER_STACK_SERVER_COMPONENT: 'happier-server-light',
      },
      incumbentRuntimeState: observedRuntimeState,
    });

    assert.deepEqual(result.stopAuthorization, {
      authorized: false,
      reason: 'successor_owner_incarnation',
      expectedOwnerPid: observedRuntimeState.ownerPid,
      expectedOwnerStartedAt: observedRuntimeState.startedAt,
      currentOwnerPid: successorRuntimeState.ownerPid,
      currentOwnerStartedAt: successorRuntimeState.startedAt,
    });
    assert.deepEqual(JSON.parse(await readFile(runtimeStatePath, 'utf8')), successorRuntimeState);
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
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
