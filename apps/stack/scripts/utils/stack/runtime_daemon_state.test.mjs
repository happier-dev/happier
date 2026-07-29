import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  getObservedStackDaemonAsync,
  getObservedStackDaemon,
  readStackRuntimeStateWithDaemonSync,
  recordStackRuntimeDaemonPid,
  startStackRuntimeDaemonPidReconciler,
  syncStackRuntimeDaemonPidFromDaemonState,
} from './runtime_daemon_state.mjs';
import { finalizeStackRuntimeStop, recordStackRuntimeStopRequest } from './runtime_state.mjs';

const acceptAllStackOwnership = async () => ({ owned: true, reason: 'test_owned' });

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

for (const order of ['first-second', 'second-first']) {
  test(`recordStackRuntimeDaemonPid commits concurrent add/add membership in ${order} order`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'hstack-runtime-daemon-add-add-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const statePath = join(root, 'stack.runtime.json');
    await writeFile(statePath, JSON.stringify({ processes: {} }) + '\n', 'utf8');
    const firstPid = order === 'first-second' ? 101 : 202;
    const secondPid = firstPid === 101 ? 202 : 101;
    const entered = deferred();
    const release = deferred();
    const eligible = async (pid) => {
      if (pid === firstPid) { entered.resolve(); await release.promise; }
      return true;
    };
    const first = recordStackRuntimeDaemonPid(statePath, firstPid, { daemonDistFingerprint: `fingerprint-${firstPid}`, isPidAliveImpl: () => true, isDaemonPidEligibleImpl: eligible });
    await entered.promise;
    const second = recordStackRuntimeDaemonPid(statePath, secondPid, { daemonDistFingerprint: `fingerprint-${secondPid}`, isPidAliveImpl: () => true, isDaemonPidEligibleImpl: eligible });
    release.resolve();
    await Promise.all([first, second]);
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    assert.deepEqual(new Set(state.processes.daemonPids), new Set([101, 202]));
    assert.equal(state.processes.daemonPid, secondPid);
    assert.equal(state.daemon.distClosureFingerprint, `fingerprint-${secondPid}`);
  });
}

for (const order of ['clear-add', 'add-clear']) {
  test(`recordStackRuntimeDaemonPid commits concurrent ${order} membership without stale resurrection`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'hstack-runtime-daemon-clear-add-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const statePath = join(root, 'stack.runtime.json');
    await writeFile(statePath, JSON.stringify({ processes: { daemonPid: 101, daemonPids: [101] }, daemon: { distClosureFingerprint: 'fingerprint-101' } }) + '\n', 'utf8');
    const entered = deferred();
    const release = deferred();
    let firstOperation = true;
    const eligible = async (pid) => {
      if (pid === 101 && firstOperation) { firstOperation = false; entered.resolve(); await release.promise; }
      return true;
    };
    const optionsFor = (fingerprint) => ({ daemonDistFingerprint: fingerprint, isPidAliveImpl: () => true, isDaemonPidEligibleImpl: eligible });
    const first = order === 'clear-add' ? recordStackRuntimeDaemonPid(statePath, null, optionsFor(null)) : recordStackRuntimeDaemonPid(statePath, 202, optionsFor('fingerprint-202'));
    await entered.promise;
    const second = order === 'clear-add' ? recordStackRuntimeDaemonPid(statePath, 202, optionsFor('fingerprint-202')) : recordStackRuntimeDaemonPid(statePath, null, optionsFor(null));
    release.resolve();
    await Promise.all([first, second]);
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    if (order === 'clear-add') {
      assert.deepEqual(state.processes.daemonPids, [202]);
      assert.equal(state.processes.daemonPid, 202);
      assert.equal(state.daemon.distClosureFingerprint, 'fingerprint-202');
    } else {
      assert.deepEqual(state.processes.daemonPids, []);
      assert.equal(state.processes.daemonPid, null);
      assert.equal(state.daemon.distClosureFingerprint, null);
    }
  });
}

test('stop finalizer racing daemon reconciliation preserves replacement membership', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-runtime-finalizer-reconcile-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const statePath = join(root, 'stack.runtime.json');
  await writeFile(statePath, JSON.stringify({ ownerPid: 500, processes: { daemonPid: 101, daemonPids: [101] }, daemon: { distClosureFingerprint: 'fingerprint-101' } }) + '\n', 'utf8');
  const stop = await recordStackRuntimeStopRequest(statePath, {});
  const entered = deferred();
  const release = deferred();
  const replacement = recordStackRuntimeDaemonPid(statePath, 202, { daemonDistFingerprint: 'fingerprint-202', isPidAliveImpl: () => true, isDaemonPidEligibleImpl: async (pid) => { if (pid === 101) { entered.resolve(); await release.promise; } return true; } });
  await entered.promise;
  const finalizer = finalizeStackRuntimeStop(statePath, { expected: stop.expected });
  release.resolve();
  await replacement;
  const result = await finalizer;
  assert.equal(result.finalized, false);
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(state.processes.daemonPid, 202);
  assert.equal(state.daemon.distClosureFingerprint, 'fingerprint-202');
});

test('getObservedStackDaemon prefers daemon.state over stale runtime daemon pid', () => {
  const observed = getObservedStackDaemon(
    {
      cliHomeDir: '/tmp/stack-cli-home',
      internalServerUrl: 'http://127.0.0.1:3009',
      runtimeDaemonPid: 111,
      env: {},
    },
    {
      checkDaemonStateImpl: () => ({ status: 'running', pid: 222 }),
      isPidAliveImpl: (pid) => Number(pid) === 111,
    },
  );

  assert.equal(observed.running, true);
  assert.equal(observed.pid, 222);
  assert.equal(observed.source, 'daemon_state');
});

test('getObservedStackDaemon treats dead runtime daemon pid as stopped when daemon state is not running', () => {
  const observed = getObservedStackDaemon(
    {
      cliHomeDir: '/tmp/stack-cli-home',
      internalServerUrl: 'http://127.0.0.1:3009',
      runtimeDaemonPid: 333,
      env: {},
    },
    {
      checkDaemonStateImpl: () => ({ status: 'stopped', pid: null }),
      isPidAliveImpl: () => false,
    },
  );

  assert.equal(observed.running, false);
  assert.equal(observed.pid, null);
  assert.equal(observed.status, 'stopped');
});

test('getObservedStackDaemon preserves a live unreachable daemon.state pid without claiming it is running', () => {
  const observed = getObservedStackDaemon(
    {
      cliHomeDir: '/tmp/stack-cli-home',
      internalServerUrl: 'http://127.0.0.1:3009',
      runtimeDaemonPid: null,
      env: {},
    },
    {
      checkDaemonStateImpl: () => ({ status: 'unreachable', pid: 444 }),
      isPidAliveImpl: (pid) => Number(pid) === 444,
    },
  );

  assert.equal(observed.running, false);
  assert.equal(observed.pid, 444);
  assert.equal(observed.status, 'unreachable');
  assert.equal(observed.source, 'daemon_state');
});

test('getObservedStackDaemonAsync does not treat runtime pids as running when ping-aware state is stopped', async () => {
  const observed = await getObservedStackDaemonAsync(
    {
      cliHomeDir: '/tmp/stack-cli-home',
      internalServerUrl: 'http://127.0.0.1:3009',
      runtimeDaemonPid: 111,
      env: {},
    },
    {
      checkDaemonStateImpl: async () => ({ status: 'stopped', pid: null }),
      isPidAliveImpl: (pid) => Number(pid) === 111,
    },
  );

  assert.equal(observed.running, false);
  assert.equal(observed.pid, 111);
  assert.equal(observed.source, 'runtime_pid');
  assert.equal(observed.status, 'stopped');
});

test('getObservedStackDaemon reports live runtime daemonPids entries without marking them running', () => {
  const observed = getObservedStackDaemon(
    {
      cliHomeDir: '/tmp/stack-cli-home',
      internalServerUrl: 'http://127.0.0.1:3009',
      runtimeDaemonPid: null,
      runtimeDaemonPids: [111, 222],
      env: {},
    },
    {
      checkDaemonStateImpl: () => ({ status: 'stopped', pid: null }),
      isPidAliveImpl: (pid) => Number(pid) === 222,
    },
  );

  assert.equal(observed.running, false);
  assert.equal(observed.pid, 222);
  assert.equal(observed.source, 'runtime_pid');
  assert.equal(observed.status, 'stopped');
});

test('syncStackRuntimeDaemonPidFromDaemonState records the live daemon pid and dist fingerprint without disturbing sibling process metadata', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-runtime-daemon-state-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const runtimeStatePath = join(root, 'stack.runtime.json');
  await mkdir(root, { recursive: true });
  await writeFile(
    runtimeStatePath,
    JSON.stringify({
      version: 1,
      stackName: 'dev',
      processes: {
        serverPid: 1234,
        daemonPid: 111,
      },
      daemon: {
        distClosureFingerprint: 'fingerprint-before',
      },
    }) + '\n',
    'utf-8',
  );

  const result = await syncStackRuntimeDaemonPidFromDaemonState(
    {
      runtimeStatePath,
      cliHomeDir: join(root, 'cli'),
      internalServerUrl: 'http://127.0.0.1:3009',
      daemonDistFingerprint: 'fingerprint-after',
      env: {},
    },
    {
      checkDaemonStateImpl: () => ({ status: 'running', pid: 222 }),
      isPidAliveImpl: (pid) => Number(pid) === 222,
      resolvePidStackOwnershipImpl: acceptAllStackOwnership,
    },
  );

  assert.equal(result.running, true);
  assert.equal(result.pid, 222);

  const runtime = JSON.parse(await readFile(runtimeStatePath, 'utf-8'));
  assert.equal(runtime?.processes?.serverPid, 1234);
  assert.equal(runtime?.processes?.daemonPid, 222);
  assert.deepEqual(runtime?.processes?.daemonPids, [222]);
  assert.equal(runtime?.daemon?.distClosureFingerprint, 'fingerprint-after');
});

test('syncStackRuntimeDaemonPidFromDaemonState prefers authenticated daemon identity over an empty caller hint', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-runtime-daemon-authenticated-fingerprint-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const runtimeStatePath = join(root, 'stack.runtime.json');
  await mkdir(root, { recursive: true });
  await writeFile(
    runtimeStatePath,
    JSON.stringify({
      version: 1,
      stackName: 'dev',
      processes: { daemonPid: 111 },
      daemon: { distClosureFingerprint: null },
    }) + '\n',
    'utf-8',
  );

  const result = await syncStackRuntimeDaemonPidFromDaemonState(
    {
      runtimeStatePath,
      cliHomeDir: join(root, 'cli'),
      internalServerUrl: 'http://127.0.0.1:3009',
      daemonDistFingerprint: null,
      env: {},
    },
    {
      checkDaemonStateImpl: () => ({
        status: 'running',
        pid: 222,
        distClosureFingerprint: 'authenticated-fingerprint',
      }),
      isPidAliveImpl: (pid) => Number(pid) === 222,
      resolvePidStackOwnershipImpl: acceptAllStackOwnership,
    },
  );

  assert.equal(result.daemonDistFingerprint, 'authenticated-fingerprint');
  const runtime = JSON.parse(await readFile(runtimeStatePath, 'utf-8'));
  assert.equal(runtime?.daemon?.distClosureFingerprint, 'authenticated-fingerprint');
});

test('syncStackRuntimeDaemonPidFromDaemonState prefers authenticated daemon identity over a stale caller hint', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-runtime-daemon-stale-fingerprint-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const runtimeStatePath = join(root, 'stack.runtime.json');
  await mkdir(root, { recursive: true });
  await writeFile(
    runtimeStatePath,
    JSON.stringify({
      version: 1,
      stackName: 'dev',
      processes: { daemonPid: 111 },
      daemon: { distClosureFingerprint: 'previous-fingerprint' },
    }) + '\n',
    'utf-8',
  );

  const result = await syncStackRuntimeDaemonPidFromDaemonState(
    {
      runtimeStatePath,
      cliHomeDir: join(root, 'cli'),
      internalServerUrl: 'http://127.0.0.1:3009',
      daemonDistFingerprint: 'new-build-fingerprint',
      env: {},
    },
    {
      checkDaemonStateImpl: () => ({
        status: 'running',
        pid: 222,
        distClosureFingerprint: 'authenticated-running-fingerprint',
      }),
      isPidAliveImpl: (pid) => Number(pid) === 222,
      resolvePidStackOwnershipImpl: acceptAllStackOwnership,
    },
  );

  assert.equal(result.daemonDistFingerprint, 'authenticated-running-fingerprint');
  const runtime = JSON.parse(await readFile(runtimeStatePath, 'utf-8'));
  assert.equal(runtime?.daemon?.distClosureFingerprint, 'authenticated-running-fingerprint');
});

test('syncStackRuntimeDaemonPidFromDaemonState prunes stale daemon pid set entries and adds observed daemon pid', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-runtime-daemon-pid-set-prune-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const runtimeStatePath = join(root, 'stack.runtime.json');
  await mkdir(root, { recursive: true });
  await writeFile(
    runtimeStatePath,
    JSON.stringify({
      version: 1,
      stackName: 'dev',
      processes: {
        serverPid: 1234,
        daemonPid: 111,
        daemonPids: [111, 222, 333],
      },
    }) + '\n',
    'utf-8',
  );

  const result = await syncStackRuntimeDaemonPidFromDaemonState(
    {
      runtimeStatePath,
      cliHomeDir: join(root, 'cli'),
      internalServerUrl: 'http://127.0.0.1:3009',
      runtimeDaemonPid: 111,
      runtimeDaemonPids: [111, 222, 333],
      env: {},
    },
    {
      checkDaemonStateImpl: () => ({ status: 'running', pid: 444 }),
      isPidAliveImpl: (pid) => [222, 444].includes(Number(pid)),
      resolvePidStackOwnershipImpl: acceptAllStackOwnership,
    },
  );

  assert.equal(result.running, true);
  assert.equal(result.pid, 444);

  const runtime = JSON.parse(await readFile(runtimeStatePath, 'utf-8'));
  assert.equal(runtime?.processes?.daemonPid, 444);
  assert.deepEqual(runtime?.processes?.daemonPids, [222, 444]);
});

test('syncStackRuntimeDaemonPidFromDaemonState reads runtime daemonPids when caller omits pid candidates', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-runtime-daemon-pid-set-read-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const runtimeStatePath = join(root, 'stack.runtime.json');
  await mkdir(root, { recursive: true });
  await writeFile(
    runtimeStatePath,
    JSON.stringify({
      version: 1,
      stackName: 'dev',
      processes: {
        daemonPids: [111, 222],
      },
    }) + '\n',
    'utf-8',
  );

  const result = await syncStackRuntimeDaemonPidFromDaemonState(
    {
      runtimeStatePath,
      cliHomeDir: join(root, 'cli'),
      internalServerUrl: 'http://127.0.0.1:3009',
      env: {},
    },
    {
      checkDaemonStateImpl: () => ({ status: 'stopped', pid: null }),
      isPidAliveImpl: (pid) => Number(pid) === 222,
      resolvePidStackOwnershipImpl: acceptAllStackOwnership,
    },
  );

  assert.equal(result.running, false);
  assert.equal(result.pid, 222);
  assert.equal(result.source, 'runtime_pid');

  const runtime = JSON.parse(await readFile(runtimeStatePath, 'utf-8'));
  assert.equal(runtime?.processes?.daemonPid, 222);
  assert.deepEqual(runtime?.processes?.daemonPids, [222]);
});

test('syncStackRuntimeDaemonPidFromDaemonState prunes live daemon pid set entries that belong to another stack', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-runtime-daemon-cross-stack-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const runtimeStatePath = join(root, 'stack.runtime.json');
  const cliHomeDir = join(root, 'cli');
  await mkdir(root, { recursive: true });
  await writeFile(
    runtimeStatePath,
    JSON.stringify({
      version: 1,
      stackName: 'remote-dev',
      processes: {
        daemonPid: 111,
        daemonPids: [111],
      },
    }) + '\n',
    'utf-8',
  );

  const ownershipCalls = [];
  const result = await syncStackRuntimeDaemonPidFromDaemonState(
    {
      runtimeStatePath,
      cliHomeDir,
      internalServerUrl: 'http://127.0.0.1:3009',
      env: {},
    },
    {
      checkDaemonStateImpl: () => ({ status: 'running', pid: 222 }),
      isPidAliveImpl: (pid) => Number(pid) === 111 || Number(pid) === 222,
      resolvePidStackOwnershipImpl: async (pid, ctx) => {
        ownershipCalls.push({ pid: Number(pid), ctx });
        return { owned: Number(pid) === 222, reason: Number(pid) === 222 ? 'env_file' : 'stack_name_mismatch' };
      },
    },
  );

  assert.equal(result.running, true);
  assert.equal(result.pid, 222);
  assert.ok(ownershipCalls.some((call) => call.pid === 111));
  assert.ok(ownershipCalls.some((call) => call.pid === 222));
  for (const call of ownershipCalls) {
    assert.equal(call.ctx.stackName, 'remote-dev');
    assert.equal(call.ctx.envPath, join(root, 'env'));
    assert.equal(call.ctx.cliHomeDir, cliHomeDir);
  }

  const runtime = JSON.parse(await readFile(runtimeStatePath, 'utf-8'));
  assert.equal(runtime?.processes?.daemonPid, 222);
  assert.deepEqual(runtime?.processes?.daemonPids, [222]);
});

test('syncStackRuntimeDaemonPidFromDaemonState prefers the runtime state env file over leaked parent env', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-runtime-daemon-env-context-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const runtimeStatePath = join(root, 'stack.runtime.json');
  const cliHomeDir = join(root, 'cli');
  await mkdir(root, { recursive: true });
  await writeFile(
    runtimeStatePath,
    JSON.stringify({
      version: 1,
      stackName: 'remote-dev',
      processes: {
        daemonPid: 111,
      },
    }) + '\n',
    'utf-8',
  );

  const ownershipCalls = [];
  const result = await syncStackRuntimeDaemonPidFromDaemonState(
    {
      runtimeStatePath,
      cliHomeDir,
      internalServerUrl: 'http://127.0.0.1:52753',
      env: {
        HAPPIER_STACK_STACK: 'remote-dev',
        HAPPIER_STACK_ENV_FILE: '/tmp/other-stack/env',
      },
    },
    {
      checkDaemonStateImpl: async () => ({ status: 'running', pid: 222 }),
      isPidAliveImpl: (pid) => Number(pid) === 222,
      resolvePidStackOwnershipImpl: async (pid, ctx) => {
        ownershipCalls.push({ pid: Number(pid), ctx });
        return { owned: ctx.envPath === join(root, 'env'), reason: 'test' };
      },
    },
  );

  assert.equal(result.running, true);
  assert.equal(result.pid, 222);
  assert.equal(ownershipCalls.length > 0, true);
  for (const call of ownershipCalls) {
    assert.equal(call.ctx.stackName, 'remote-dev');
    assert.equal(call.ctx.envPath, join(root, 'env'));
    assert.equal(call.ctx.cliHomeDir, cliHomeDir);
  }

  const runtime = JSON.parse(await readFile(runtimeStatePath, 'utf-8'));
  assert.equal(runtime?.processes?.daemonPid, 222);
  assert.deepEqual(runtime?.processes?.daemonPids, [222]);
});

test('syncStackRuntimeDaemonPidFromDaemonState adopts and persists an authenticated Windows daemon identity', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-runtime-daemon-windows-bootstrap-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const runtimeStatePath = join(root, 'stack.runtime.json');
  const cliHomeDir = join(root, 'cli');
  await writeFile(runtimeStatePath, JSON.stringify({
    version: 1,
    stackName: 'remote-windows',
    processes: {},
  }) + '\n', 'utf8');

  const ownershipCalls = [];
  const resolvePidStackOwnershipImpl = async (pid, context) => {
    ownershipCalls.push({ pid, context });
    return context.processInstanceFingerprint === 'win32-cim:stable'
      ? { owned: true, reason: 'process_instance' }
      : { owned: null, reason: 'process-identity-unsupported' };
  };

  const first = await syncStackRuntimeDaemonPidFromDaemonState(
    {
      runtimeStatePath,
      cliHomeDir,
      internalServerUrl: 'http://127.0.0.1:3009',
      authenticatedProcessInstanceFingerprint: 'win32-cim:stable',
      env: {},
    },
    {
      checkDaemonStateImpl: () => ({ status: 'running', pid: 4242 }),
      isPidAliveImpl: () => true,
      resolvePidStackOwnershipImpl,
    },
  );

  assert.equal(first.running, true);
  assert.equal(first.pid, 4242);
  assert.ok(ownershipCalls.some((call) => (
    call.pid === 4242
    && call.context.processInstanceFingerprint === 'win32-cim:stable'
  )));

  const persisted = JSON.parse(await readFile(runtimeStatePath, 'utf8'));
  assert.equal(persisted.processes.daemonPid, 4242);
  assert.equal(
    persisted.processInstances.processes.daemonPid.fingerprint,
    'win32-cim:stable',
  );

  ownershipCalls.length = 0;
  const second = await syncStackRuntimeDaemonPidFromDaemonState(
    {
      runtimeStatePath,
      cliHomeDir,
      internalServerUrl: 'http://127.0.0.1:3009',
      env: {},
    },
    {
      checkDaemonStateImpl: () => ({ status: 'running', pid: 4242 }),
      isPidAliveImpl: () => true,
      resolvePidStackOwnershipImpl,
    },
  );

  assert.equal(second.running, true);
  assert.ok(ownershipCalls.some((call) => (
    call.pid === 4242
    && call.context.processInstanceFingerprint === 'win32-cim:stable'
  )));
});

test('syncStackRuntimeDaemonPidFromDaemonState accepts an authenticated Windows daemon when env inspection is unsupported', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-runtime-daemon-windows-authenticated-fallback-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const runtimeStatePath = join(root, 'stack.runtime.json');
  const cliHomeDir = join(root, 'cli');
  await writeFile(runtimeStatePath, JSON.stringify({
    version: 1,
    stackName: 'remote-windows',
    processes: {},
  }) + '\n', 'utf8');

  const result = await syncStackRuntimeDaemonPidFromDaemonState(
    {
      runtimeStatePath,
      cliHomeDir,
      internalServerUrl: 'http://127.0.0.1:3009',
      env: {},
    },
    {
      checkDaemonStateImpl: () => ({
        status: 'running',
        pid: 4242,
        processInstanceFingerprint: 'win32-cim:authenticated',
        distClosureFingerprint: '0123456789abcdef',
      }),
      isPidAliveImpl: () => true,
      resolvePidStackOwnershipImpl: async () => ({
        status: 'inconclusive',
        owned: null,
        reason: 'process-identity-unsupported',
      }),
      readProcessInstanceFingerprintSyncImpl: () => 'win32-cim:authenticated',
    },
  );

  assert.equal(result.running, true);
  assert.equal(result.pid, 4242);
  assert.equal(result.daemonDistFingerprint, '0123456789abcdef');

  const persisted = JSON.parse(await readFile(runtimeStatePath, 'utf8'));
  assert.equal(persisted.processes.daemonPid, 4242);
  assert.equal(
    persisted.processInstances.processes.daemonPid.fingerprint,
    'win32-cim:authenticated',
  );
});

test('syncStackRuntimeDaemonPidFromDaemonState gives the ping-aware observer the runtime stack identity', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-runtime-daemon-observer-stack-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const runtimeStatePath = join(root, 'stack.runtime.json');
  const cliHomeDir = join(root, 'cli');
  await writeFile(runtimeStatePath, JSON.stringify({
    version: 1,
    stackName: 'remote-windows',
    processes: {},
  }) + '\n', 'utf8');

  const observedOptions = [];
  const result = await syncStackRuntimeDaemonPidFromDaemonState(
    {
      runtimeStatePath,
      cliHomeDir,
      internalServerUrl: 'http://127.0.0.1:3009',
      env: {},
    },
    {
      checkDaemonStateImpl: (_homeDir, options) => {
        observedOptions.push(options);
        return options.stackName === 'remote-windows'
          ? {
              status: 'running',
              pid: 4242,
              processInstanceFingerprint: 'win32-cim:stable',
            }
          : { status: 'unreachable', pid: 4242, reason: 'daemon_not_owned' };
      },
      isPidAliveImpl: () => true,
      resolvePidStackOwnershipImpl: async (_pid, context) => (
        context.processInstanceFingerprint === 'win32-cim:stable'
          ? { owned: true, reason: 'process_instance' }
          : { owned: null, reason: 'process-identity-unsupported' }
      ),
    },
  );

  assert.equal(observedOptions[0]?.stackName, 'remote-windows');
  assert.equal(result.running, true);
  assert.equal(result.pid, 4242);
});

test('syncStackRuntimeDaemonPidFromDaemonState rejects unowned daemon.state pid and preserves owned runtime pid without marking it running', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-runtime-daemon-unowned-state-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const runtimeStatePath = join(root, 'stack.runtime.json');
  const cliHomeDir = join(root, 'cli');
  await mkdir(root, { recursive: true });
  await writeFile(
    runtimeStatePath,
    JSON.stringify({
      version: 1,
      stackName: 'remote-dev',
      processes: {
        daemonPid: 111,
        daemonPids: [111],
      },
    }) + '\n',
    'utf-8',
  );

  const result = await syncStackRuntimeDaemonPidFromDaemonState(
    {
      runtimeStatePath,
      cliHomeDir,
      internalServerUrl: 'http://127.0.0.1:3009',
      env: {},
    },
    {
      checkDaemonStateImpl: () => ({ status: 'running', pid: 222 }),
      isPidAliveImpl: (pid) => Number(pid) === 111 || Number(pid) === 222,
      resolvePidStackOwnershipImpl: async (pid) => ({
        owned: Number(pid) === 111,
        reason: Number(pid) === 111 ? 'cli_home' : 'stack_name_mismatch',
      }),
    },
  );

  assert.equal(result.running, false);
  assert.equal(result.pid, 111);
  assert.equal(result.source, 'runtime_pid');

  const runtime = JSON.parse(await readFile(runtimeStatePath, 'utf-8'));
  assert.equal(runtime?.processes?.daemonPid, 111);
  assert.deepEqual(runtime?.processes?.daemonPids, [111]);
});

test('syncStackRuntimeDaemonPidFromDaemonState records an owned live unreachable daemon.state pid', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-runtime-daemon-unreachable-state-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const runtimeStatePath = join(root, 'stack.runtime.json');
  await writeFile(
    runtimeStatePath,
    JSON.stringify({
      version: 1,
      stackName: 'remote-dev',
      processes: { daemonPid: null, daemonPids: [] },
      daemon: { distClosureFingerprint: 'fingerprint-before' },
    }) + '\n',
    'utf8',
  );

  const result = await syncStackRuntimeDaemonPidFromDaemonState(
    {
      runtimeStatePath,
      cliHomeDir: join(root, 'cli'),
      internalServerUrl: 'http://127.0.0.1:3009',
      env: {},
    },
    {
      checkDaemonStateImpl: () => ({ status: 'unreachable', pid: 444 }),
      isPidAliveImpl: (pid) => Number(pid) === 444,
      resolvePidStackOwnershipImpl: acceptAllStackOwnership,
    },
  );

  assert.equal(result.running, false);
  assert.equal(result.pid, 444);
  assert.equal(result.status, 'unreachable');
  assert.equal(result.source, 'daemon_state');
  assert.equal(result.daemonDistFingerprint, 'fingerprint-before');

  const runtime = JSON.parse(await readFile(runtimeStatePath, 'utf8'));
  assert.equal(runtime.processes.daemonPid, 444);
  assert.deepEqual(runtime.processes.daemonPids, [444]);
  assert.equal(runtime.daemon.distClosureFingerprint, 'fingerprint-before');
});

test('syncStackRuntimeDaemonPidFromDaemonState clears stale runtime daemon pid when daemon is stopped', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-runtime-daemon-clear-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const runtimeStatePath = join(root, 'stack.runtime.json');
  await mkdir(root, { recursive: true });
  await writeFile(
    runtimeStatePath,
    JSON.stringify({
      version: 1,
      stackName: 'dev',
      processes: {
        daemonPid: 999,
      },
      daemon: {
        distClosureFingerprint: 'fingerprint-before',
      },
    }) + '\n',
    'utf-8',
  );

  const result = await syncStackRuntimeDaemonPidFromDaemonState(
    {
      runtimeStatePath,
      cliHomeDir: join(root, 'cli'),
      internalServerUrl: 'http://127.0.0.1:3009',
      env: {},
    },
    {
      checkDaemonStateImpl: () => ({ status: 'stopped', pid: null }),
      isPidAliveImpl: () => false,
      resolvePidStackOwnershipImpl: acceptAllStackOwnership,
    },
  );

  assert.equal(result.running, false);
  assert.equal(result.pid, null);

  const runtime = JSON.parse(await readFile(runtimeStatePath, 'utf-8'));
  assert.equal(runtime?.processes?.daemonPid, null);
  assert.deepEqual(runtime?.processes?.daemonPids, []);
  assert.equal(runtime?.daemon?.distClosureFingerprint, null);
});

test('syncStackRuntimeDaemonPidFromDaemonState preserves the recorded dist fingerprint when daemon state omits a new fingerprint', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-runtime-daemon-preserve-fingerprint-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const runtimeStatePath = join(root, 'stack.runtime.json');
  await mkdir(root, { recursive: true });
  await writeFile(
    runtimeStatePath,
    JSON.stringify({
      version: 1,
      stackName: 'dev',
      processes: {
        daemonPid: 111,
      },
      daemon: {
        distClosureFingerprint: 'fingerprint-before',
      },
    }) + '\n',
    'utf-8',
  );

  const result = await syncStackRuntimeDaemonPidFromDaemonState(
    {
      runtimeStatePath,
      cliHomeDir: join(root, 'cli'),
      internalServerUrl: 'http://127.0.0.1:3009',
      env: {},
    },
    {
      checkDaemonStateImpl: () => ({ status: 'running', pid: 222 }),
      isPidAliveImpl: (pid) => Number(pid) === 222,
      resolvePidStackOwnershipImpl: acceptAllStackOwnership,
    },
  );

  assert.equal(result.running, true);
  assert.equal(result.pid, 222);
  assert.equal(result.daemonDistFingerprint, 'fingerprint-before');

  const runtime = JSON.parse(await readFile(runtimeStatePath, 'utf-8'));
  assert.equal(runtime?.processes?.daemonPid, 222);
  assert.deepEqual(runtime?.processes?.daemonPids, [222]);
  assert.equal(runtime?.daemon?.distClosureFingerprint, 'fingerprint-before');
});

test('daemon sync rejects fingerprint and running observation when the authenticated pid dies before publication', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-runtime-daemon-publication-race-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const runtimeStatePath = join(root, 'stack.runtime.json');
  await mkdir(root, { recursive: true });
  await writeFile(
    runtimeStatePath,
    JSON.stringify({
      version: 1,
      stackName: 'dev',
      processes: { daemonPid: null, daemonPids: [] },
      daemon: { distClosureFingerprint: 'fingerprint-before-sync' },
    }) + '\n',
    'utf-8',
  );

  let livenessChecks = 0;
  const result = await syncStackRuntimeDaemonPidFromDaemonState(
    {
      runtimeStatePath,
      cliHomeDir: join(root, 'cli'),
      internalServerUrl: 'http://127.0.0.1:3009',
      daemonDistFingerprint: 'fingerprint-for-dead-pid',
      env: {},
    },
    {
      checkDaemonStateImpl: () => ({ status: 'running', pid: 222 }),
      isPidAliveImpl: () => ++livenessChecks === 1,
      resolvePidStackOwnershipImpl: acceptAllStackOwnership,
    },
  );

  assert.equal(livenessChecks, 2);
  assert.equal(result.running, false);
  assert.equal(result.pid, null);
  assert.equal(result.daemonDistFingerprint, null);

  const runtime = JSON.parse(await readFile(runtimeStatePath, 'utf-8'));
  assert.equal(runtime?.processes?.daemonPid, null);
  assert.deepEqual(runtime?.processes?.daemonPids, []);
  assert.equal(runtime?.daemon?.distClosureFingerprint, null);
});

test('recordStackRuntimeDaemonPid clears daemon pid when requested explicitly', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-runtime-daemon-record-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const runtimeStatePath = join(root, 'stack.runtime.json');
  await mkdir(root, { recursive: true });
  await writeFile(
    runtimeStatePath,
    JSON.stringify({
      version: 1,
      stackName: 'dev',
      processes: {
        daemonPid: 444,
      },
    }) + '\n',
    'utf-8',
  );

  await recordStackRuntimeDaemonPid(runtimeStatePath, null);

  const runtime = JSON.parse(await readFile(runtimeStatePath, 'utf-8'));
  assert.equal(runtime?.processes?.daemonPid, null);
  assert.deepEqual(runtime?.processes?.daemonPids, []);
});

test('recordStackRuntimeDaemonPid clears daemon pid even when the previous pid still appears live', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-runtime-daemon-record-live-clear-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const runtimeStatePath = join(root, 'stack.runtime.json');
  await mkdir(root, { recursive: true });
  await writeFile(
    runtimeStatePath,
    JSON.stringify({
      version: 1,
      stackName: 'dev',
      processes: {
        daemonPid: 444,
        daemonPids: [444, 555],
      },
    }) + '\n',
    'utf-8',
  );

  await recordStackRuntimeDaemonPid(
    runtimeStatePath,
    null,
    { isPidAliveImpl: () => true, isDaemonPidEligibleImpl: async () => true },
  );

  const runtime = JSON.parse(await readFile(runtimeStatePath, 'utf-8'));
  assert.equal(runtime?.processes?.daemonPid, null);
  assert.deepEqual(runtime?.processes?.daemonPids, []);
});

test('readStackRuntimeStateWithDaemonSync returns the refreshed daemon pid after syncing from daemon.state', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-runtime-daemon-read-sync-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const runtimeStatePath = join(root, 'stack.runtime.json');
  await mkdir(root, { recursive: true });
  await writeFile(
    runtimeStatePath,
    JSON.stringify({
      version: 1,
      stackName: 'dev',
      processes: {
        serverPid: 1234,
        daemonPid: 111,
      },
    }) + '\n',
    'utf-8',
  );

  const runtime = await readStackRuntimeStateWithDaemonSync(
    {
      runtimeStatePath,
      cliHomeDir: join(root, 'cli'),
      internalServerUrl: 'http://127.0.0.1:3009',
      env: {},
    },
    {
      checkDaemonStateImpl: () => ({ status: 'running', pid: 222 }),
      isPidAliveImpl: (pid) => Number(pid) === 222,
      resolvePidStackOwnershipImpl: acceptAllStackOwnership,
    },
  );

  assert.equal(runtime?.processes?.serverPid, 1234);
  assert.equal(runtime?.processes?.daemonPid, 222);
  assert.deepEqual(runtime?.processes?.daemonPids, [222]);
});

test('startStackRuntimeDaemonPidReconciler refreshes stale runtime identity after daemon self-restart', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-runtime-daemon-reconcile-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const runtimeStatePath = join(root, 'stack.runtime.json');
  await mkdir(root, { recursive: true });
  await writeFile(
    runtimeStatePath,
    JSON.stringify({
      version: 1,
      stackName: 'remote-dev',
      processes: {
        serverPid: 1234,
        daemonPid: 42158,
        daemonPids: [42158],
      },
    }) + '\n',
    'utf-8',
  );

  const intervals = [];
  const clearCalls = [];
  const reconciler = startStackRuntimeDaemonPidReconciler(
    {
      runtimeStatePath,
      cliHomeDir: join(root, 'cli'),
      internalServerUrl: 'http://127.0.0.1:52753',
      env: {},
      intervalMs: 1000,
    },
    {
      checkDaemonStateImpl: async () => ({
        status: 'running',
        pid: 76071,
        distClosureFingerprint: 'fingerprint-after-restart',
      }),
      isPidAliveImpl: (pid) => Number(pid) === 76071,
      resolvePidStackOwnershipImpl: acceptAllStackOwnership,
      setIntervalImpl: (fn, intervalMs) => {
        intervals.push({ fn, intervalMs });
        return { unref() {} };
      },
      clearIntervalImpl: (timer) => clearCalls.push(timer),
    },
  );

  await reconciler.syncNow();

  const runtime = JSON.parse(await readFile(runtimeStatePath, 'utf-8'));
  assert.equal(runtime?.processes?.serverPid, 1234);
  assert.equal(runtime?.processes?.daemonPid, 76071);
  assert.deepEqual(runtime?.processes?.daemonPids, [76071]);
  assert.equal(runtime?.daemon?.distClosureFingerprint, 'fingerprint-after-restart');
  assert.equal(intervals.length, 1);
  assert.equal(intervals[0]?.intervalMs, 1000);

  reconciler.close();
  assert.equal(clearCalls.length, 1);
});
