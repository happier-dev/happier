import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

import { completeInterruptedStackStopBeforeStart, stopStackServiceWithEnv, stopStackWithEnv } from './utils/stack/stop.mjs';
import { isAlive, spawnOwnedSleep, waitForProcessAlive, waitForProcessExit } from './testkit/stack_stop_sweeps_testkit.mjs';
import {
  recordStackRuntimeStopRequest,
  withStackRuntimeStartClaim,
} from './utils/stack/runtime_state.mjs';

async function createStopFixture(t, { stackName = 'test-stack' } = {}) {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-stop-daemon-pid-set-'));
  const repoRoot = join(tmp, 'repo');
  const baseDir = join(tmp, 'stack');
  const envPath = join(baseDir, 'env');
  const cliHomeDir = join(baseDir, 'cli');

  await mkdir(join(repoRoot, 'apps', 'ui'), { recursive: true });
  await mkdir(join(repoRoot, 'apps', 'cli'), { recursive: true });
  await mkdir(join(repoRoot, 'apps', 'server'), { recursive: true });
  await writeFile(join(repoRoot, 'apps', 'ui', 'package.json'), '{}\n', 'utf8');
  await writeFile(join(repoRoot, 'apps', 'cli', 'package.json'), '{}\n', 'utf8');
  await writeFile(join(repoRoot, 'apps', 'server', 'package.json'), '{}\n', 'utf8');

  await mkdir(cliHomeDir, { recursive: true });
  await writeFile(
    envPath,
    [
      `HAPPIER_STACK_STACK=${stackName}`,
      'HAPPIER_STACK_SERVER_COMPONENT=happier-server-light',
      `HAPPIER_STACK_CLI_HOME_DIR=${cliHomeDir}`,
      `HAPPIER_STACK_REPO_DIR=${repoRoot}`,
      '',
    ].join('\n'),
    'utf8',
  );

  const children = [];
  t.after(async () => {
    for (const child of children) {
      const pid = child?.pid;
      if (!pid || !isAlive(pid)) continue;
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        // ignore
      }
    }
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  });

  const spawnDaemon = async (label) => {
    const child = spawnOwnedSleep({
      env: {
        ...process.env,
        HAPPIER_STACK_STACK: stackName,
        HAPPIER_STACK_ENV_FILE: envPath,
        HAPPIER_STACK_CLI_HOME_DIR: cliHomeDir,
        HAPPIER_HOME_DIR: cliHomeDir,
        HAPPIER_STACK_PROCESS_KIND: 'infra',
        HAPPIER_TEST_LABEL: label,
      },
    });
    children.push(child);
    assert.ok(Number(child.pid) > 1, `expected ${label} pid`);
    await waitForProcessAlive({ pid: child.pid, timeoutMs: 2_000, intervalMs: 25, label });
    return child;
  };

  const spawnScript = async (script, label, { owned = true } = {}) => {
    const child = spawn(process.execPath, ['-e', script], { detached: process.platform !== 'win32', stdio: 'ignore', env: owned ? { ...process.env, HAPPIER_STACK_STACK: stackName, HAPPIER_STACK_ENV_FILE: envPath, HAPPIER_STACK_CLI_HOME_DIR: cliHomeDir, HAPPIER_HOME_DIR: cliHomeDir, HAPPIER_STACK_PROCESS_KIND: 'infra', HAPPIER_TEST_LABEL: label } : { PATH: process.env.PATH, HAPPIER_TEST_LABEL: label } });
    children.push(child);
    await waitForProcessAlive({ pid: child.pid, timeoutMs: 2_000, intervalMs: 25, label });
    return child;
  };

  return {
    rootDir,
    repoRoot,
    baseDir,
    cliHomeDir,
    envPath,
    stackName,
    runtimeStatePath: join(baseDir, 'stack.runtime.json'),
    spawnDaemon,
    spawnScript,
  };
}

async function writeRuntimeState(path, state) {
  await writeFile(path, JSON.stringify({
    startedAt: '2026-07-17T08:00:00.000Z',
    ...state,
  }, null, 2) + '\n', 'utf8');
}

async function waitForFile(path) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { await access(path); return; } catch { await new Promise((resolve) => setTimeout(resolve, 10)); }
  }
  await access(path);
}

test('explicit-stop fallback applies canonical grace only to persisted server process roles', async (t) => {
  const fixture = await createStopFixture(t, { stackName: 'server-role-grace' });
  const serverKeys = [
    'serverPid',
    'serverWrapperPid',
    'happierServerBackendPid',
    'serverBackendPid',
    'serverDrainingPid',
  ];
  const genericKeys = [
    'daemonPid',
    'uiGatewayPid',
    'expoPid',
    'expoTailscaleForwarderPid',
    'tauriPid',
    'watcherPid',
  ];
  const processes = {};
  for (const key of [...serverKeys, ...genericKeys]) {
    // eslint-disable-next-line no-await-in-loop
    const child = await fixture.spawnDaemon(`grace-${key}`);
    processes[key] = child.pid;
  }
  await writeRuntimeState(fixture.runtimeStatePath, {
    version: 1,
    stackName: fixture.stackName,
    ownerPid: 999_999,
    processes,
  });

  const terminationOptions = new Map();
  await stopStackWithEnv({
    rootDir: fixture.repoRoot,
    stackName: fixture.stackName,
    baseDir: fixture.baseDir,
    env: {
      ...process.env,
      HAPPIER_STACK_STACK: fixture.stackName,
      HAPPIER_STACK_ENV_FILE: fixture.envPath,
      HAPPIER_STACK_CLI_HOME_DIR: fixture.cliHomeDir,
      HAPPIER_SERVER_SHUTDOWN_DEADLINE_MS: '1200',
    },
    json: true,
    noDocker: true,
    autoSweep: false,
  }, {
    killProcessGroupOwnedByStackImpl: async (_pid, options) => {
      terminationOptions.set(options.label, options);
      return { killed: true, reason: 'killed_pgid' };
    },
  });

  for (const key of serverKeys) {
    assert.equal(terminationOptions.get(key)?.graceMs, 1450, `${key} must consume canonical server grace`);
  }
  for (const key of genericKeys) {
    assert.equal(terminationOptions.has(key), true, `${key} must reach fallback termination`);
    assert.equal(terminationOptions.get(key)?.graceMs, undefined, `${key} must retain generic termination policy`);
  }
});

test('stop cleanup attempts a runtime-recorded Expo pid only once when Expo state repeats it', async (t) => {
  const fixture = await createStopFixture(t, { stackName: 'dedupe-runtime-expo-pid' });
  const expo = await fixture.spawnDaemon('dedupe-runtime-expo-pid');
  await writeRuntimeState(fixture.runtimeStatePath, {
    version: 1,
    stackName: fixture.stackName,
    ownerPid: 999_999,
    processes: { expoPid: expo.pid },
  });
  const expoStatePath = join(fixture.baseDir, 'expo-dev', 'ui', 'expo.state.json');
  await mkdir(dirname(expoStatePath), { recursive: true });
  await writeFile(expoStatePath, JSON.stringify({ pid: expo.pid }) + '\n', 'utf8');

  const attempts = [];
  const result = await stopStackWithEnv({
    rootDir: fixture.repoRoot,
    stackName: fixture.stackName,
    baseDir: fixture.baseDir,
    env: {
      ...process.env,
      HAPPIER_STACK_STACK: fixture.stackName,
      HAPPIER_STACK_ENV_FILE: fixture.envPath,
      HAPPIER_STACK_CLI_HOME_DIR: fixture.cliHomeDir,
    },
    json: true,
    noDocker: true,
    autoSweep: false,
  }, {
    killProcessGroupOwnedByStackImpl: async (pid, options) => {
      attempts.push({ pid, label: options.label });
      return attempts.length === 1
        ? { killed: true, reason: 'killed_pgid' }
        : { killed: false, reason: 'not_owned' };
    },
  });

  assert.deepEqual(attempts, [{ pid: expo.pid, label: 'expoPid' }]);
  assert.equal(result.finalization?.reason, 'deleted');
});

test('stopStackWithEnv reclaims only a fully identified legacy dev-target tunnel', async (t) => {
  const fixture = await createStopFixture(t, { stackName: 'legacy-dev-target-tunnel' });
  const opensshConfigPath = join(fixture.baseDir, 'mutagen', 'openssh', 'config');
  const legacyTunnelPid = 42001;
  const unrelatedListenerPid = 42002;
  const expectedTunnelLine = [
    `${legacyTunnelPid} ssh -T -F ${opensshConfigPath}`,
    '-o ControlMaster=no',
    '-o BatchMode=yes',
    '-o ExitOnForwardFailure=yes',
    '-o ServerAliveInterval=15',
    '-o ServerAliveCountMax=3',
    '-R 127.0.0.1:55133:127.0.0.1:53288',
    '-L 0.0.0.0:19364:localhost:21209',
    '-N happier-dev-target-mac',
  ].join(' ');
  const terminated = [];

  const result = await stopStackWithEnv({
    rootDir: fixture.repoRoot,
    stackName: fixture.stackName,
    baseDir: fixture.baseDir,
    env: {
      ...process.env,
      HAPPIER_STACK_STACK: fixture.stackName,
      HAPPIER_STACK_ENV_FILE: fixture.envPath,
      HAPPIER_STACK_CLI_HOME_DIR: fixture.cliHomeDir,
      HAPPIER_STACK_SERVER_PORT: '53288',
      HAPPIER_STACK_EXPO_DEV_PORT: '19364',
    },
    json: true,
    noDocker: true,
    sweepOwned: true,
  }, {
    loadDevTargetsConfigImpl: async () => ({
      path: join(fixture.baseDir, 'dev-targets.json'),
      config: { targets: [{ ssh: 'happier-dev-target-mac' }] },
    }),
    listListenPidsWithStatusImpl: async (port) => {
      assert.equal(port, 19364);
      return { status: 'ok', supported: true, pids: [legacyTunnelPid, unrelatedListenerPid] };
    },
    observePsEnvLineImpl: async (pid) => ({
      status: 'ok',
      line: pid === legacyTunnelPid
        ? expectedTunnelLine
        : `${unrelatedListenerPid} ssh -T -F ${opensshConfigPath} -L 0.0.0.0:19365:localhost:21209 -N happier-dev-target-mac`,
    }),
    killProcessGroupOwnedByStackImpl: async (pid, options) => {
      assert.equal(typeof options.resolvePidStackOwnershipImpl, 'function');
      const ownership = await options.resolvePidStackOwnershipImpl(pid);
      if (!ownership.owned) {
        return { killed: false, reason: ownership.reason };
      }
      terminated.push(pid);
      return { killed: true, reason: 'killed_legacy_dev_target_tunnel' };
    },
  });

  assert.deepEqual(terminated, [legacyTunnelPid]);
  assert.deepEqual(result.sweep?.pids, [{
    pid: legacyTunnelPid,
    reason: 'killed_legacy_dev_target_tunnel',
    pgid: null,
  }]);
  assert.deepEqual(result.sweep?.skipped, [{
    pid: unrelatedListenerPid,
    reason: 'process_identity_mismatch',
  }]);
});

test('stale Expo state pointing at a definitively unowned reused pid does not block finalization', async (t) => {
  const fixture = await createStopFixture(t, { stackName: 'stale-expo-pid-reuse' });
  const unrelated = await fixture.spawnScript('setInterval(() => {}, 1000)', 'stale-expo-pid-reuse', { owned: false });
  await writeRuntimeState(fixture.runtimeStatePath, {
    version: 1, stackName: fixture.stackName, ownerPid: 999_999, processes: {},
  });
  const expoStatePath = join(fixture.baseDir, 'expo-dev', 'ui', 'expo.state.json');
  await mkdir(dirname(expoStatePath), { recursive: true });
  await writeFile(expoStatePath, JSON.stringify({ pid: unrelated.pid }) + '\n', 'utf8');

  const result = await stopStackWithEnv({
    rootDir: fixture.repoRoot, stackName: fixture.stackName, baseDir: fixture.baseDir,
    env: { ...process.env, HAPPIER_STACK_STACK: fixture.stackName, HAPPIER_STACK_ENV_FILE: fixture.envPath, HAPPIER_STACK_SERVER_COMPONENT: 'happier-server' },
    json: true, noDocker: true, autoSweep: false,
  }, {
    killProcessGroupOwnedByStackImpl: async () => ({ killed: false, reason: 'not_owned' }),
  });

  assert.equal(result.finalization?.reason, 'deleted');
  assert.equal(isAlive(unrelated.pid), true);
});

test('startup waits for active canonical cleanup and does not execute cleanup twice', async (t) => {
  const fixture = await createStopFixture(t, { stackName: 'active-cleanup-wait' });
  const ownerPid = 999_999;
  const ownerStartedAt = '2026-07-17T08:00:00.000Z';
  await writeRuntimeState(fixture.runtimeStatePath, { version: 1, stackName: fixture.stackName, ownerPid, startedAt: ownerStartedAt, processes: {} });
  let releaseCleanup;
  const cleanupRelease = new Promise((resolve) => { releaseCleanup = resolve; });
  let cleanupEntered;
  const entered = new Promise((resolve) => { cleanupEntered = resolve; });
  let cleanupCalls = 0;
  const stopPromise = stopStackWithEnv({
    rootDir: fixture.repoRoot, stackName: fixture.stackName, baseDir: fixture.baseDir,
    env: { ...process.env, HAPPIER_STACK_STACK: fixture.stackName, HAPPIER_STACK_ENV_FILE: fixture.envPath, HAPPIER_STACK_SERVER_COMPONENT: 'happier-server' },
    json: true, noDocker: false, autoSweep: false, expectedOwnerPid: ownerPid, expectedOwnerStartedAt: ownerStartedAt,
  }, { stopHappyServerManagedInfraImpl: async () => { cleanupCalls += 1; cleanupEntered(); await cleanupRelease; return { ok: true }; } });
  await entered;
  let startupCompleted = false;
  const startupPromise = completeInterruptedStackStopBeforeStart({
    rootDir: fixture.repoRoot, stackName: fixture.stackName, baseDir: fixture.baseDir,
    env: { ...process.env, HAPPIER_STACK_STACK: fixture.stackName, HAPPIER_STACK_ENV_FILE: fixture.envPath, HAPPIER_STACK_SERVER_COMPONENT: 'happier-server' },
    json: true, noDocker: false, autoSweep: false,
  }, { stopHappyServerManagedInfraImpl: async () => { cleanupCalls += 1; return { ok: true }; } })
    .then((result) => { startupCompleted = true; return result; });
  await new Promise((resolve) => setTimeout(resolve, 75));
  assert.equal(startupCompleted, false);
  assert.equal(cleanupCalls, 1);
  releaseCleanup();
  const [stopResult, startupResult] = await Promise.all([stopPromise, startupPromise]);
  assert.equal(stopResult.finalization?.reason, 'deleted');
  assert.equal(startupResult.reason, 'completed_by_active_cleanup');
  assert.equal(cleanupCalls, 1);
});

test('startup reclaims an abandoned cleanup executor and finalizes before ordinary start claim', async (t) => {
  const fixture = await createStopFixture(t, { stackName: 'abandoned-cleanup-reclaim' });
  const ownerPid = 999_999;
  const ownerStartedAt = '2026-07-17T08:00:00.000Z';
  await writeRuntimeState(fixture.runtimeStatePath, {
    version: 1, stackName: fixture.stackName, ownerPid, startedAt: ownerStartedAt, processes: {},
    stopRequest: { signal: 'SIGTERM', requestedBy: 'owner death watchdog', reason: 'owner exited', preserveDaemon: false, requestedAt: new Date().toISOString() },
  });
  await writeFile(join(fixture.baseDir, 'stack.cleanup-executor.lock'), JSON.stringify({ pid: 999_998, createdAtMs: Date.now(), updatedAtMs: Date.now() }), 'utf8');
  let cleanupCalls = 0;
  const result = await completeInterruptedStackStopBeforeStart({
    rootDir: fixture.repoRoot, stackName: fixture.stackName, baseDir: fixture.baseDir,
    env: { ...process.env, HAPPIER_STACK_STACK: fixture.stackName, HAPPIER_STACK_ENV_FILE: fixture.envPath, HAPPIER_STACK_SERVER_COMPONENT: 'happier-server' },
    json: true, noDocker: false, autoSweep: false,
  }, { stopHappyServerManagedInfraImpl: async () => { cleanupCalls += 1; return { ok: true }; } });
  assert.equal(result.finalization?.reason, 'deleted');
  assert.equal(cleanupCalls, 1);
  await withStackRuntimeStartClaim(fixture.runtimeStatePath, { stackName: fixture.stackName }, async ({ recordStart }) => {
    await recordStart({ stackName: fixture.stackName, script: 'successor', ownerPid: process.pid, ports: {} });
  });
  assert.equal(JSON.parse(await readFile(fixture.runtimeStatePath, 'utf8')).ownerPid, process.pid);
});

test('startup completes an interrupted ownerless stop transaction without mistaking it for a successor', async (t) => {
  const fixture = await createStopFixture(t, { stackName: 'ownerless-stop-continuation' });
  const requestedAt = '2026-07-24T14:37:26.614Z';
  await writeRuntimeState(fixture.runtimeStatePath, {
    version: 1,
    stackName: fixture.stackName,
    ownerPid: null,
    startedAt: undefined,
    processes: {
      expoPid: null,
      expoTailscaleForwarderPid: null,
    },
    stopRequest: {
      signal: 'SIGTERM',
      requestedBy: 'stack stop',
      reason: 'explicit stack stop',
      preserveDaemon: false,
      requestedAt,
    },
  });

  const result = await completeInterruptedStackStopBeforeStart({
    rootDir: fixture.repoRoot,
    stackName: fixture.stackName,
    baseDir: fixture.baseDir,
    env: {
      ...process.env,
      HAPPIER_STACK_STACK: fixture.stackName,
      HAPPIER_STACK_ENV_FILE: fixture.envPath,
      HAPPIER_STACK_SERVER_COMPONENT: 'happier-server',
    },
    json: true,
    noDocker: false,
    autoSweep: false,
  }, {
    stopHappyServerManagedInfraImpl: async () => ({ ok: true }),
  });

  assert.equal(result.finalization?.reason, 'deleted');
  await assert.rejects(access(fixture.runtimeStatePath), { code: 'ENOENT' });
});

test('startup leaves failed or inconclusive canonical cleanup fenced', async (t) => {
  for (const reason of ['simulated_failure', 'ownership_inconclusive']) {
    // eslint-disable-next-line no-await-in-loop
    const fixture = await createStopFixture(t, { stackName: `cleanup-${reason}` });
    const ownerPid = 999_999;
    const ownerStartedAt = '2026-07-17T08:00:00.000Z';
    // eslint-disable-next-line no-await-in-loop
    await writeRuntimeState(fixture.runtimeStatePath, {
      version: 1, stackName: fixture.stackName, ownerPid, startedAt: ownerStartedAt, processes: {},
      stopRequest: { signal: 'SIGTERM', requestedBy: 'test', reason, preserveDaemon: false, requestedAt: new Date().toISOString() },
    });
    // eslint-disable-next-line no-await-in-loop
    await assert.rejects(
      () => completeInterruptedStackStopBeforeStart({
        rootDir: fixture.repoRoot, stackName: fixture.stackName, baseDir: fixture.baseDir,
        env: { ...process.env, HAPPIER_STACK_STACK: fixture.stackName, HAPPIER_STACK_ENV_FILE: fixture.envPath, HAPPIER_STACK_SERVER_COMPONENT: 'happier-server' },
        json: true, noDocker: false, autoSweep: false,
      }, { stopHappyServerManagedInfraImpl: async () => ({ ok: false, reason }) }),
      (error) => error?.code === 'ESTACKRUNTIMECLEANUPINCOMPLETE',
    );
    // eslint-disable-next-line no-await-in-loop
    assert.equal((await readFile(fixture.runtimeStatePath, 'utf8')).includes('stopRequest'), true);
  }
});

test('ordinary startup without a stop marker does not acquire the cleanup executor lock', async (t) => {
  const fixture = await createStopFixture(t, { stackName: 'ordinary-start-no-cleanup-lock' });
  await writeRuntimeState(fixture.runtimeStatePath, { version: 1, stackName: fixture.stackName, ownerPid: null, processes: {}, stopRequest: null });
  await writeFile(join(fixture.baseDir, 'stack.cleanup-executor.lock'), JSON.stringify({ pid: process.pid, createdAtMs: Date.now(), updatedAtMs: Date.now() }), 'utf8');
  const result = await completeInterruptedStackStopBeforeStart({
    rootDir: fixture.repoRoot, stackName: fixture.stackName, baseDir: fixture.baseDir,
    env: { ...process.env, HAPPIER_STACK_STACK: fixture.stackName, HAPPIER_STACK_ENV_FILE: fixture.envPath },
    json: true, noDocker: true,
  }, { cleanupExecutorLockOptions: { timeoutMs: 30, pollIntervalMs: 5 } });
  assert.deepEqual(result, { completed: false, reason: 'no_stop_request' });
});

test('service termination and canonical cleanup share one cleanup executor', async (t) => {
  const fixture = await createStopFixture(t, { stackName: 'service-cleanup-executor' });
  await writeRuntimeState(fixture.runtimeStatePath, {
    version: 1, stackName: fixture.stackName, ownerPid: 999_999, processes: {},
  });
  let serviceStops = 0;
  const result = await stopStackServiceWithEnv({
    rootDir: fixture.repoRoot, stackName: fixture.stackName, baseDir: fixture.baseDir,
    env: { ...process.env, HAPPIER_STACK_STACK: fixture.stackName, HAPPIER_STACK_ENV_FILE: fixture.envPath },
    json: true, noDocker: true, autoSweep: false,
    stopAttribution: { requestedBy: 'service stop', reason: 'test service stop' },
  }, async () => {
    serviceStops += 1;
    assert.equal((await readFile(fixture.runtimeStatePath, 'utf8')).includes('stopRequest'), true);
    await access(join(fixture.baseDir, 'stack.cleanup-executor.lock'));
  });
  assert.equal(serviceStops, 1);
  assert.equal(result.finalization?.reason, 'deleted');
});

test('watchdog stop fails successor admission closed during cleanup and permits retry after finalization', async (t) => {
  const fixture = await createStopFixture(t, { stackName: 'watchdog-stop-start-claim' });
  const staleOwnerPid = 999_999;
  const staleOwnerStartedAt = '2026-07-17T08:00:00.000Z';
  await writeRuntimeState(fixture.runtimeStatePath, {
    version: 1,
    stackName: fixture.stackName,
    ownerPid: staleOwnerPid,
    startedAt: staleOwnerStartedAt,
    processes: {},
  });

  let successor = null;
  let successorStart = null;
  let successorAdmissionError = null;
  const result = await stopStackWithEnv({
    rootDir: fixture.repoRoot,
    stackName: fixture.stackName,
    baseDir: fixture.baseDir,
    env: {
      ...process.env,
      HAPPIER_STACK_STACK: fixture.stackName,
      HAPPIER_STACK_ENV_FILE: fixture.envPath,
      HAPPIER_STACK_CLI_HOME_DIR: fixture.cliHomeDir,
      HAPPIER_STACK_SERVER_COMPONENT: 'happier-server',
    },
    json: true,
    autoSweep: true,
    expectedOwnerPid: staleOwnerPid,
    expectedOwnerStartedAt: staleOwnerStartedAt,
  }, {
    stopHappyServerManagedInfraImpl: async () => {
      successorStart = withStackRuntimeStartClaim(
        fixture.runtimeStatePath,
        { stackName: fixture.stackName },
        async ({ recordStart }) => {
          successor = await fixture.spawnDaemon('successor-owner');
          await recordStart({
            stackName: fixture.stackName,
            script: 'successor',
            ephemeral: true,
            ownerPid: successor.pid,
            ports: {},
            processes: { serverPid: successor.pid },
          });
        },
      ).catch((error) => { successorAdmissionError = error; });
      await new Promise((resolve) => setTimeout(resolve, 75));
      return { ok: true };
    },
  });

  await successorStart;
  assert.match(successorAdmissionError?.message ?? '', /stop cleanup is incomplete/i);
  assert.equal(result.finalization?.reason, 'deleted');
  await withStackRuntimeStartClaim(
    fixture.runtimeStatePath,
    { stackName: fixture.stackName },
    async ({ recordStart }) => {
      successor = await fixture.spawnDaemon('successor-owner');
      await recordStart({
        stackName: fixture.stackName,
        script: 'successor',
        ephemeral: true,
        ownerPid: successor.pid,
        ports: {},
        processes: { serverPid: successor.pid },
      });
    },
  );
  assert.ok(successor && isAlive(successor.pid), 'successor infra must start after cleanup and remain alive');
  const current = JSON.parse(await readFile(fixture.runtimeStatePath, 'utf8'));
  assert.equal(current.ownerPid, successor.pid);
  assert.equal(current.processes.serverPid, successor.pid);
  assert.equal(current.stopRequest, null);
});

test('watchdog stale preserveDaemon false cannot downgrade a fresher true stop request', async (t) => {
  const fixture = await createStopFixture(t, { stackName: 'watchdog-preserve-daemon-monotonic' });
  const staleOwnerPid = 999_998;
  const staleOwnerStartedAt = '2026-07-17T08:01:00.000Z';
  const daemon = await fixture.spawnDaemon('preserved-daemon');
  await writeRuntimeState(fixture.runtimeStatePath, {
    version: 1,
    stackName: fixture.stackName,
    ownerPid: staleOwnerPid,
    startedAt: staleOwnerStartedAt,
    processes: { daemonPid: daemon.pid, daemonPids: [daemon.pid] },
    daemon: { distClosureFingerprint: 'preserved-fingerprint' },
  });
  const fresh = await recordStackRuntimeStopRequest(fixture.runtimeStatePath, {
    requestedBy: 'fresh restart',
    reason: 'preserve daemon for successor',
    preserveDaemon: true,
  });
  let requestDuringCleanup = null;

  const result = await stopStackWithEnv({
    rootDir: fixture.repoRoot,
    stackName: fixture.stackName,
    baseDir: fixture.baseDir,
    env: {
      ...process.env,
      HAPPIER_STACK_STACK: fixture.stackName,
      HAPPIER_STACK_ENV_FILE: fixture.envPath,
      HAPPIER_STACK_CLI_HOME_DIR: fixture.cliHomeDir,
      HAPPIER_STACK_SERVER_COMPONENT: 'happier-server',
    },
    json: true,
    preserveDaemon: false,
    expectedOwnerPid: staleOwnerPid,
    expectedOwnerStartedAt: staleOwnerStartedAt,
  }, {
    stopHappyServerManagedInfraImpl: async () => {
      requestDuringCleanup = JSON.parse(await readFile(fixture.runtimeStatePath, 'utf8')).stopRequest;
      return { ok: true };
    },
  });

  assert.equal(result.preserveDaemon, true);
  assert.deepEqual(requestDuringCleanup, fresh.runtimeState.stopRequest);
  assert.deepEqual(result.processes?.killed ?? [], []);
  assert.equal(isAlive(daemon.pid), true);
  const preserved = JSON.parse(await readFile(fixture.runtimeStatePath, 'utf8'));
  assert.equal(preserved.ownerPid, null);
  assert.deepEqual(preserved.processes, { daemonPid: daemon.pid, daemonPids: [daemon.pid] });
  assert.equal(preserved.stopRequest, null);
});

test('watchdog cleanup failure retains exact owner-death attribution', async (t) => {
  const fixture = await createStopFixture(t, { stackName: 'watchdog-stop-attribution' });
  const staleOwnerPid = 999_997;
  const staleOwnerStartedAt = '2026-07-17T08:02:00.000Z';
  const stopAttribution = {
    requestedBy: 'owner death watchdog',
    reason: 'lifecycle owner exited; sweeping stack-owned runtime',
  };
  await writeRuntimeState(fixture.runtimeStatePath, {
    version: 1,
    stackName: fixture.stackName,
    ownerPid: staleOwnerPid,
    startedAt: staleOwnerStartedAt,
    processes: {},
  });

  const result = await stopStackWithEnv({
    rootDir: fixture.repoRoot,
    stackName: fixture.stackName,
    baseDir: fixture.baseDir,
    env: {
      ...process.env,
      HAPPIER_STACK_STACK: fixture.stackName,
      HAPPIER_STACK_ENV_FILE: fixture.envPath,
      HAPPIER_STACK_CLI_HOME_DIR: fixture.cliHomeDir,
      HAPPIER_STACK_SERVER_COMPONENT: 'happier-server',
    },
    json: true,
    expectedOwnerPid: staleOwnerPid,
    expectedOwnerStartedAt: staleOwnerStartedAt,
    stopAttribution,
  }, {
    stopHappyServerManagedInfraImpl: async () => ({ ok: false, reason: 'simulated cleanup failure' }),
  });

  assert.deepEqual(result.stopAttribution, stopAttribution);
  assert.equal(result.finalization?.reason, 'cleanup_incomplete');
  const retained = JSON.parse(await readFile(fixture.runtimeStatePath, 'utf8'));
  assert.equal(retained.stopRequest.requestedBy, stopAttribution.requestedBy);
  assert.equal(retained.stopRequest.reason, stopAttribution.reason);
  assert.equal(retained.stopRequest.preserveDaemon, false);
  assert.equal(typeof retained.stopRequest.requestedAt, 'string');
});

test('stopStackWithEnv stops every recorded daemon pid in daemonPids', async (t) => {
  const fixture = await createStopFixture(t);
  const first = await fixture.spawnDaemon('daemon-a');
  const second = await fixture.spawnDaemon('daemon-b');

  await writeRuntimeState(fixture.runtimeStatePath, {
    version: 1,
    stackName: fixture.stackName,
    ownerPid: 999999,
    processes: {
      daemonPid: first.pid,
      daemonPids: [first.pid, second.pid],
    },
  });

  const res = await stopStackWithEnv({
    rootDir: fixture.repoRoot,
    stackName: fixture.stackName,
    baseDir: fixture.baseDir,
    env: {
      ...process.env,
      HAPPIER_STACK_STACK: fixture.stackName,
      HAPPIER_STACK_ENV_FILE: fixture.envPath,
      HAPPIER_STACK_CLI_HOME_DIR: fixture.cliHomeDir,
      HAPPIER_STACK_REPO_DIR: fixture.repoRoot,
    },
    json: true,
    noDocker: true,
  });

  const killedPids = new Set((res.processes?.killed ?? []).map((entry) => Number(entry.pid)));
  assert.equal(killedPids.has(first.pid), true);
  assert.equal(killedPids.has(second.pid), true);

  await waitForProcessExit({ pid: first.pid, timeoutMs: 10_000, intervalMs: 50, label: 'first daemon pid' });
  await waitForProcessExit({ pid: second.pid, timeoutMs: 10_000, intervalMs: 50, label: 'second daemon pid' });
  await assert.rejects(access(fixture.runtimeStatePath), { code: 'ENOENT' });
});

test('stopStackWithEnv requests the lifecycle owner before fallback child termination', async (t) => {
  const fixture = await createStopFixture(t, { stackName: 'owner-first-stop' });
  const ownerMarker = join(fixture.baseDir, 'owner-stopping');
  const childObservation = join(fixture.baseDir, 'child-observation');
  const ownerReady = join(fixture.baseDir, 'owner-ready');
  const childReady = join(fixture.baseDir, 'child-ready');
  const owner = await fixture.spawnScript(`const { writeFileSync } = require('node:fs'); process.on('SIGTERM', () => { writeFileSync(${JSON.stringify(ownerMarker)}, 'owner-first'); process.exit(0); }); writeFileSync(${JSON.stringify(ownerReady)}, 'ready'); setInterval(() => {}, 1000);`, 'lifecycle-owner');
  const child = await fixture.spawnScript(`const { existsSync, writeFileSync } = require('node:fs'); process.on('SIGTERM', () => { writeFileSync(${JSON.stringify(childObservation)}, existsSync(${JSON.stringify(ownerMarker)}) ? 'owner-first' : 'child-first'); process.exit(0); }); writeFileSync(${JSON.stringify(childReady)}, 'ready'); setInterval(() => {}, 1000);`, 'server-child');
  await Promise.all([waitForFile(ownerReady), waitForFile(childReady)]);
  await writeRuntimeState(fixture.runtimeStatePath, { version: 1, stackName: fixture.stackName, ownerPid: owner.pid, processes: { serverPid: child.pid } });
  await stopStackWithEnv({ rootDir: fixture.repoRoot, stackName: fixture.stackName, baseDir: fixture.baseDir, env: { ...process.env, HAPPIER_STACK_STACK: fixture.stackName, HAPPIER_STACK_ENV_FILE: fixture.envPath, HAPPIER_STACK_CLI_HOME_DIR: fixture.cliHomeDir }, json: true, noDocker: true });
  await waitForProcessExit({ pid: child.pid, timeoutMs: 5_000, intervalMs: 25, label: 'server child' });
  assert.equal(await readFile(childObservation, 'utf8'), 'owner-first');
});

test('stopStackWithEnv retains runtime state and reports cleanup_incomplete when owned cleanup times out', async (t) => {
  const fixture = await createStopFixture(t, { stackName: 'cleanup-timeout' });
  const child = await fixture.spawnDaemon('cleanup-timeout-child');
  await writeRuntimeState(fixture.runtimeStatePath, {
    version: 1,
    stackName: fixture.stackName,
    ownerPid: 999999,
    processes: { serverPid: child.pid },
  });

  const result = await stopStackWithEnv({
    rootDir: fixture.repoRoot,
    stackName: fixture.stackName,
    baseDir: fixture.baseDir,
    env: {
      ...process.env,
      HAPPIER_STACK_STACK: fixture.stackName,
      HAPPIER_STACK_ENV_FILE: fixture.envPath,
      HAPPIER_STACK_CLI_HOME_DIR: fixture.cliHomeDir,
    },
    json: true,
    noDocker: true,
    autoSweep: false,
  }, {
    killProcessGroupOwnedByStackImpl: async () => ({ killed: false, reason: 'kill_timeout' }),
  });

  assert.equal(isAlive(child.pid), true);
  await access(fixture.runtimeStatePath);
  assert.equal(result.finalization?.finalized, false);
  assert.equal(result.finalization?.reason, 'cleanup_incomplete');
  assert.equal(result.errors.some((error) => error.step === 'runtime-finalization' && error.reason === 'cleanup_incomplete'), true);
});

test('stopStackWithEnv finalizes when a reused lifecycle-owner pid is definitively unowned', async (t) => {
  const fixture = await createStopFixture(t, { stackName: 'owner-cleanup-unconfirmed' });
  const owner = await fixture.spawnScript('setInterval(() => {}, 1000);', 'foreign-owner', { owned: false });
  await writeRuntimeState(fixture.runtimeStatePath, {
    version: 1,
    stackName: fixture.stackName,
    ownerPid: owner.pid,
    processes: {},
    processInstances: {
      owner: { pid: owner.pid, fingerprint: 'stale-owner-incarnation' },
      processes: {},
    },
  });

  const result = await stopStackWithEnv({
    rootDir: fixture.repoRoot,
    stackName: fixture.stackName,
    baseDir: fixture.baseDir,
    env: { ...process.env, HAPPIER_STACK_STACK: fixture.stackName, HAPPIER_STACK_ENV_FILE: fixture.envPath, HAPPIER_STACK_CLI_HOME_DIR: fixture.cliHomeDir },
    json: true,
    noDocker: true,
    autoSweep: false,
  });

  assert.equal(isAlive(owner.pid), true);
  await assert.rejects(() => access(fixture.runtimeStatePath), (error) => error?.code === 'ENOENT');
  assert.equal(result.runner.stopped, false);
  assert.equal(result.finalization?.reason, 'deleted');
});

test('stopStackWithEnv finalizes past definitively unowned reused runtime member pids', async (t) => {
  const fixture = await createStopFixture(t, { stackName: 'member-cleanup-unowned' });
  const server = await fixture.spawnScript('setInterval(() => {}, 1000);', 'foreign-server', { owned: false });
  const watcher = await fixture.spawnScript('setInterval(() => {}, 1000);', 'foreign-watcher', { owned: false });
  await writeRuntimeState(fixture.runtimeStatePath, {
    version: 1,
    stackName: fixture.stackName,
    ownerPid: 999_999,
    processes: { serverPid: server.pid, watcherPid: watcher.pid },
    processInstances: {
      processes: {
        serverPid: { pid: server.pid, fingerprint: 'stale-server-incarnation' },
        watcherPid: { pid: watcher.pid, fingerprint: 'stale-watcher-incarnation' },
      },
    },
  });

  const result = await stopStackWithEnv({
    rootDir: fixture.repoRoot,
    stackName: fixture.stackName,
    baseDir: fixture.baseDir,
    env: {
      ...process.env,
      HAPPIER_STACK_STACK: fixture.stackName,
      HAPPIER_STACK_ENV_FILE: fixture.envPath,
      HAPPIER_STACK_CLI_HOME_DIR: fixture.cliHomeDir,
    },
    json: true,
    noDocker: true,
    autoSweep: false,
  });

  assert.equal(isAlive(server.pid), true);
  assert.equal(isAlive(watcher.pid), true);
  assert.deepEqual(result.processes?.killed ?? [], []);
  assert.equal(result.finalization?.reason, 'deleted');
  await assert.rejects(() => access(fixture.runtimeStatePath), (error) => error?.code === 'ENOENT');
});

test('stopStackWithEnv keeps inconclusive runtime member ownership fenced', async (t) => {
  const fixture = await createStopFixture(t, { stackName: 'member-cleanup-inconclusive' });
  const member = await fixture.spawnScript('setInterval(() => {}, 1000);', 'inconclusive-member', { owned: false });
  await writeRuntimeState(fixture.runtimeStatePath, {
    version: 1,
    stackName: fixture.stackName,
    ownerPid: 999_999,
    processes: { serverPid: member.pid },
  });

  const result = await stopStackWithEnv({
    rootDir: fixture.repoRoot,
    stackName: fixture.stackName,
    baseDir: fixture.baseDir,
    env: {
      ...process.env,
      HAPPIER_STACK_STACK: fixture.stackName,
      HAPPIER_STACK_ENV_FILE: fixture.envPath,
      HAPPIER_STACK_CLI_HOME_DIR: fixture.cliHomeDir,
    },
    json: true,
    noDocker: true,
    autoSweep: false,
  }, {
    killProcessGroupOwnedByStackImpl: async () => ({ killed: false, reason: 'ownership_inconclusive' }),
  });

  assert.equal(isAlive(member.pid), true);
  await access(fixture.runtimeStatePath);
  assert.equal(result.finalization?.reason, 'cleanup_incomplete');
});

test('stopStackWithEnv keeps an inconclusive lifecycle-owner cleanup fenced', async (t) => {
  const fixture = await createStopFixture(t, { stackName: 'owner-cleanup-inconclusive' });
  const owner = await fixture.spawnScript('setInterval(() => {}, 1000);', 'inconclusive-owner');
  await writeRuntimeState(fixture.runtimeStatePath, {
    version: 1, stackName: fixture.stackName, ownerPid: owner.pid, processes: {},
  });
  const result = await stopStackWithEnv({
    rootDir: fixture.repoRoot, stackName: fixture.stackName, baseDir: fixture.baseDir,
    env: { ...process.env, HAPPIER_STACK_STACK: fixture.stackName, HAPPIER_STACK_ENV_FILE: fixture.envPath },
    json: true, noDocker: true, autoSweep: false,
  }, {
    requestLifecycleOwnerShutdownImpl: async () => ({ killed: false, reason: 'ownership_inconclusive' }),
  });
  assert.equal(isAlive(owner.pid), true);
  await access(fixture.runtimeStatePath);
  assert.equal(result.finalization?.reason, 'cleanup_incomplete');
});

test('stopStackWithEnv finalizes only after managed-infra and owned-sweep cleanup succeed', async (t) => {
  const fixture = await createStopFixture(t, { stackName: 'late-cleanup-boundary' });
  const sweptChild = await fixture.spawnDaemon('late-sweep-child');
  await writeRuntimeState(fixture.runtimeStatePath, { version: 1, stackName: fixture.stackName, ownerPid: 999999, processes: {} });

  const result = await stopStackWithEnv({
    rootDir: fixture.repoRoot,
    stackName: fixture.stackName,
    baseDir: fixture.baseDir,
    env: {
      ...process.env,
      HAPPIER_STACK_STACK: fixture.stackName,
      HAPPIER_STACK_ENV_FILE: fixture.envPath,
      HAPPIER_STACK_CLI_HOME_DIR: fixture.cliHomeDir,
      HAPPIER_STACK_SERVER_COMPONENT: 'happier-server',
    },
    json: true,
    autoSweep: true,
  }, {
    killProcessGroupOwnedByStackImpl: async () => ({ killed: false, reason: 'kill_timeout' }),
    stopHappyServerManagedInfraImpl: async () => ({ ok: false, reason: 'docker_unavailable' }),
  });

  assert.equal(isAlive(sweptChild.pid), true);
  await access(fixture.runtimeStatePath);
  assert.equal(result.finalization?.reason, 'cleanup_incomplete');
  assert.equal(result.finalization.cleanupResults.some((entry) => entry.step === 'infra' && entry.ok === false), true);
  assert.equal(result.finalization.cleanupResults.some((entry) => entry.step === 'sweep' && entry.ok === false), true);
});

test('stopStackWithEnv deletes state when owned sweep confirms a previously timed-out pid', async (t) => {
  const fixture = await createStopFixture(t, { stackName: 'cleanup-retry-success' });
  const child = await fixture.spawnDaemon('cleanup-retry-child');
  await writeRuntimeState(fixture.runtimeStatePath, { version: 1, stackName: fixture.stackName, ownerPid: 999999, processes: { serverPid: child.pid } });
  let attempts = 0;

  const result = await stopStackWithEnv({
    rootDir: fixture.repoRoot,
    stackName: fixture.stackName,
    baseDir: fixture.baseDir,
    env: { ...process.env, HAPPIER_STACK_STACK: fixture.stackName, HAPPIER_STACK_ENV_FILE: fixture.envPath, HAPPIER_STACK_CLI_HOME_DIR: fixture.cliHomeDir },
    json: true,
    noDocker: true,
    autoSweep: true,
  }, {
    killProcessGroupOwnedByStackImpl: async (pid) => {
      attempts += 1;
      if (attempts === 1) return { killed: false, reason: 'kill_timeout' };
      process.kill(process.platform === 'win32' ? pid : -pid, 'SIGKILL');
      return { killed: true, reason: 'killed_retry' };
    },
  });

  assert.equal(attempts, 2);
  assert.equal(result.finalization?.reason, 'deleted');
  await assert.rejects(access(fixture.runtimeStatePath), { code: 'ENOENT' });
  await waitForProcessExit({ pid: child.pid, timeoutMs: 5_000, intervalMs: 25, label: 'retried cleanup child' });
});

test('stopStackWithEnv preserveDaemon preserves daemonPids and keeps runtime state while they are alive', async (t) => {
  const fixture = await createStopFixture(t);
  const first = await fixture.spawnDaemon('daemon-preserve-a');
  const second = await fixture.spawnDaemon('daemon-preserve-b');

  await writeRuntimeState(fixture.runtimeStatePath, {
    version: 1,
    stackName: fixture.stackName,
    ownerPid: 999999,
    processes: {
      daemonPid: second.pid,
      daemonPids: [first.pid, second.pid],
    },
    daemon: { distClosureFingerprint: 'preserved-fingerprint' },
  });

  const res = await stopStackWithEnv({
    rootDir: fixture.repoRoot,
    stackName: fixture.stackName,
    baseDir: fixture.baseDir,
    env: {
      ...process.env,
      HAPPIER_STACK_STACK: fixture.stackName,
      HAPPIER_STACK_ENV_FILE: fixture.envPath,
      HAPPIER_STACK_CLI_HOME_DIR: fixture.cliHomeDir,
      HAPPIER_STACK_REPO_DIR: fixture.repoRoot,
    },
    json: true,
    noDocker: true,
    preserveDaemon: true,
  });

  assert.deepEqual(res.processes?.killed ?? [], []);
  assert.equal(isAlive(first.pid), true);
  assert.equal(isAlive(second.pid), true);
  await access(fixture.runtimeStatePath);
  const preserved = JSON.parse(await readFile(fixture.runtimeStatePath, 'utf8'));
  assert.equal(preserved.ownerPid, null);
  assert.deepEqual(preserved.processes, { daemonPid: second.pid, daemonPids: [first.pid, second.pid] });
  assert.equal(preserved.daemon.distClosureFingerprint, 'preserved-fingerprint');
});
