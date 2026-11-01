import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createTempFixture } from './testkit/core/temp_fixture.mjs';
import { withPatchedProcessEnv } from './testkit/core/env_scope.mjs';
import { resolveDevTargetMutagenRuntime } from './utils/dev_targets/mutagen_runtime.mjs';
import { pickNextFreeTcpPort } from './utils/net/ports.mjs';

import * as stackEnvRunner from './stack/run_script_with_stack_env.mjs';

for (const scriptPath of ['run.mjs', 'dev.mjs']) {
  test(`${scriptPath} restart refuses unavailable placement/sync before replacing incumbent state`, async t => {
    const fixture = await createTempFixture(t, { prefix: 'hstack-restart-preflight-' });
    const storageDir = fixture.path('stacks');
    const rootDir = fixture.path('repo');
    const stackName = 'restart-preflight';
    const baseDir = join(storageDir, stackName);
    const runtimeStatePath = join(baseDir, 'stack.runtime.json');
    const markerPath = fixture.path('replacement-started');
    withPatchedProcessEnv(t, { HAPPIER_STACK_STORAGE_DIR: storageDir,
      HAPPIER_STACK_REPO_DIR: rootDir });
    const env = {
      HAPPIER_STACK_REPO_DIR: rootDir,
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      HAPPIER_STACK_RUNTIME_BUILD_AUTHORITY_STACK: 'producer',
      HAPPIER_STACK_RUNTIME_MODE: 'source-snapshot',
      HAPPIER_STACK_SERVER_COMPONENT: 'happier-server-light',
      HAPPIER_STACK_DAEMON: '0',
    };
    const config = { version: 3,
      targets: [{ name: 'remote', platform: 'posix', ssh: 'fixture.invalid',
        repoDir: '/mirror', cliHomeDir: '/state' }],
      runtimePlacement: { server: { mode: 'prefer-target', target: 'remote', fallback: 'local' },
        daemon: { mode: 'local' } }, commandExecution: { mode: 'local' },
    };
    for (const path of [baseDir, join(storageDir, 'producer'), join(rootDir, 'scripts'),
      ...['cli', 'server', 'ui'].map(app => join(rootDir, 'apps', app))]) await mkdir(path, { recursive: true });
    await writeFile(join(rootDir, 'package.json'), '{"private":true}\n');
    for (const app of ['cli', 'server', 'ui']) {
      await writeFile(join(rootDir, 'apps', app, 'package.json'), '{"private":true}\n');
    }
    await writeFile(join(baseDir, 'env'), Object.entries(env).map(([key, value]) => `${key}=${value}`).join('\n'));
    for (const name of [stackName, 'producer']) {
      await writeFile(join(storageDir, name, 'dev-targets.json'), JSON.stringify(config));
    }
    // This is an inert runner fixture, not a stack/server. No fixture process
    // needs signaling: a successful dispatch writes the marker and exits itself.
    await writeFile(join(rootDir, 'scripts', scriptPath),
      `import {writeFile} from 'node:fs/promises'; await writeFile(${JSON.stringify(markerPath)}, 'started');`);
    const sync = resolveDevTargetMutagenRuntime({ stackBaseDir: baseDir, sourceDir: rootDir, env });
    await mkdir(dirname(sync.projectFile), { recursive: true });
    await writeFile(sync.projectFile, '# disposable existing producer project\n');
    // A recorded port selects the real restart path without creating any live
    // process to stop. Invalid owner identity deliberately forbids signals.
    const incumbent = { version: 1, stackName, ownerPid: null,
      startedAt: '2026-10-21T10:00:00.000Z', ports: { server: await pickNextFreeTcpPort(49191) },
      sentinel: 'incumbent', processes: {} };
    await writeFile(runtimeStatePath, JSON.stringify(incumbent));
    const probes = [];
    const observe = async kind => {
      probes.push(kind);
      assert.deepEqual(JSON.parse(await readFile(runtimeStatePath, 'utf8')), incumbent,
        'readiness must observe the incumbent before any stop/publication');
    };
    await assert.rejects(stackEnvRunner.runStackScriptWithStackEnv({
      rootDir, stackName, scriptPath,
      args: ['--restart', '--no-daemon', '--no-ui', '--no-browser'],
      // Prepared source admission is not fresh placement/sync readiness.
      extraEnv: { HAPPIER_STACK_PREPARED_SOURCE_RELOAD: '1' },
    }, {
      // Only external command boundaries are simulated; configuration,
      // placement selection, sync admission and outer restart wiring are real.
      runCaptureResult: async () => {
        await observe('placement');
        return { ok: false, exitCode: 1, err: 'fixture sync conflict' };
      },
      runProcess: async ({ args }) => {
        await observe(`sync:${args[1]}`);
        if (args[1] === 'flush') return { code: 1, out: '', err: 'fixture sync conflict' };
        return { code: 0, out: JSON.stringify([{ name: args[2], paused: false,
          status: 'watching', successfulCycles: 1,
          alpha: { connected: true, scanned: true }, beta: { connected: true, scanned: true } }]) };
      },
    }), scriptPath === 'run.mjs' ? /fixture sync conflict/ : /Mutagen initial flush failed/);
    assert.equal(probes.length > 0, true);
    await assert.rejects(readFile(markerPath), { code: 'ENOENT' });
    assert.deepEqual(JSON.parse(await readFile(runtimeStatePath, 'utf8')), incumbent);

    // The same restart proceeds after the external readiness boundary recovers;
    // the correction must not simply disable replacement launches.
    probes.length = 0;
    await stackEnvRunner.runStackScriptWithStackEnv({
      rootDir, stackName, scriptPath,
      args: ['--restart', '--no-daemon', '--no-ui', '--no-browser'],
      extraEnv: { HAPPIER_STACK_PREPARED_SOURCE_RELOAD: '1' },
    }, {
      runCaptureResult: async () => {
        await observe('placement');
        return { ok: true, out: 'HSTACK_QA_HOST={"platform":"linux","arch":"x64","remote":true}\n', err: '' };
      },
      runProcess: async ({ args }) => {
        await observe(`sync:${args[1]}`);
        return { code: 0, out: JSON.stringify([{ name: args[2], paused: false,
          status: 'watching', successfulCycles: 1,
          alpha: { connected: true, scanned: true }, beta: { connected: true, scanned: true } }]) };
      },
    });
    assert.equal(await readFile(markerPath, 'utf8'), 'started');
    assert.deepEqual(probes, scriptPath === 'run.mjs' ? ['placement'] : ['sync:list', 'sync:list', 'sync:flush']);
  });
}

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
    finalizeStackRuntimeOwnerShutdownImpl: async (_path, expected) => {
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
    finalizeStackRuntimeOwnerShutdownImpl: async () => { calls.push(['state-delete']); },
  });
  assert.deepEqual(calls, [], 'missing pre-existing identity must not delete runtime state');

  calls.length = 0;
  const unconfirmed = await stackEnvRunner.terminateSpawnedRunnerForBootFailure(child, {
    runtimeStatePath: 'C:\\stack\\stack.runtime.json',
    killProcessTreeImpl: async () => ({ ok: false, reason: 'tree_unconfirmed' }),
    finalizeStackRuntimeOwnerShutdownImpl: async () => { calls.push(['state-delete']); },
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

test('source reload preserves an omitted daemon and retires a requested remote replacement', () => {
  const incumbentRuntimeState = { remoteTargets: { nl3: {
    services: { daemon: true }, status: 'running', serviceStatus: { daemon: 'running' },
  } } };
  assert.equal(
    stackEnvRunner.shouldPreserveDaemonForRestart({
      args: ['--restart', '--no-daemon'],
      preparedSourceRuntimeReload: { remote: true, remoteDaemon: true },
      incumbentRuntimeState,
    }),
    true,
    'a server-only restart must preserve the incumbent remote daemon',
  );
  assert.equal(
    stackEnvRunner.shouldPreserveDaemonForRestart({
      env: { HAPPIER_STACK_DAEMON: '0' },
      preparedSourceRuntimeReload: { remote: true, remoteDaemon: true },
      incumbentRuntimeState,
    }),
    true,
    'the canonical environment-based daemon opt-out has the same preservation contract',
  );
  assert.equal(
    stackEnvRunner.shouldPreserveDaemonForRestart({
      preparedSourceRuntimeReload: { remoteDaemon: true },
    }),
    false,
  );
  assert.equal(
    stackEnvRunner.shouldPreserveDaemonForRestart({
      preparedSourceRuntimeReload: { remote: true, remoteDaemon: false },
    }),
    true,
    'a remote server alone does not transfer daemon retirement ownership',
  );
  assert.equal(
    stackEnvRunner.shouldPreserveDaemonForRestart({
      preparedSourceRuntimeReload: { remote: false, remoteDaemon: false },
      incumbentRuntimeState,
    }),
    false,
    'an incumbent remote daemon is retired even when replacement placement changed',
  );
  assert.equal(stackEnvRunner.shouldPreserveDaemonForRestart(), true);
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
