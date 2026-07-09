import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  createStackDevProxyRuntimePatch,
  createStackServerRuntimeProcessPatch,
  getStackRuntimeProcessEntries,
  readStackRuntimeStateFile,
  recordStackRuntimeServerPids,
  recordStackRuntimeStart,
  recordStackRuntimeStopRequest,
  recordStackRuntimeUpdate,
  resolveTrustedStackRuntimeServerPort,
} from './runtime_state.mjs';

test('recordStackRuntimeStart refreshes startedAt when the owner pid changes', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'happy-stacks-runtime-state-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const statePath = join(dir, 'stack.runtime.json');
  const first = await recordStackRuntimeStart(statePath, {
    stackName: 'dev-built',
    script: 'run.mjs',
    ephemeral: true,
    ownerPid: process.pid,
    ports: { server: 23456 },
  });

  await new Promise((resolve) => setTimeout(resolve, 10));

  const second = await recordStackRuntimeStart(statePath, {
    stackName: 'dev-built',
    script: 'run.mjs',
    ephemeral: true,
    ownerPid: process.pid + 100000,
    ports: { server: 23456 },
  });

  assert.notEqual(second.startedAt, first.startedAt);
});

test('recordStackRuntimeServerPids stores listener and wrapper pids distinctly', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'happy-stacks-runtime-state-server-pids-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const statePath = join(dir, 'stack.runtime.json');
  await recordStackRuntimeStart(statePath, {
    stackName: 'dev-built',
    script: 'run.mjs',
    ephemeral: true,
    ownerPid: process.pid,
    ports: { server: 23456 },
  });

  await recordStackRuntimeServerPids(statePath, { listenerPid: 301, wrapperPid: 201 });

  const state = await readStackRuntimeStateFile(statePath);
  assert.equal(state?.processes?.serverPid, 301);
  assert.equal(state?.processes?.serverWrapperPid, 201);
});

test('createStackServerRuntimeProcessPatch can clear stale dev proxy metadata for direct mode', () => {
  assert.deepEqual(
    createStackServerRuntimeProcessPatch({
      listenerPid: 301,
      wrapperPid: 201,
      serverPort: 4101,
      clearProxyState: true,
    }),
    {
      processes: {
        serverPid: 301,
        serverWrapperPid: 201,
        proxyPid: null,
        serverBackendPid: null,
        serverDrainingPid: null,
      },
      ports: {
        server: 4101,
        serverBackend: null,
      },
      serverProxy: {
        enabled: false,
        mode: 'direct',
        restartMode: null,
        fallbackReason: null,
      },
    },
  );
});

test('createStackDevProxyRuntimePatch records stable and backend proxy state', () => {
  assert.deepEqual(
    createStackDevProxyRuntimePatch({
      stablePort: 4101,
      backendPort: 5102,
      proxyPid: process.pid,
      backendPid: 302,
      drainingPid: null,
      mode: 'proxy',
      restartMode: 'exclusiveDb',
    }),
    {
      processes: {
        proxyPid: process.pid,
        serverBackendPid: 302,
        serverDrainingPid: null,
      },
      ports: {
        server: 4101,
        serverBackend: 5102,
      },
      serverProxy: {
        enabled: true,
        mode: 'proxy',
        restartMode: 'exclusiveDb',
        fallbackReason: null,
      },
    },
  );
});

test('dev proxy runtime patch clears mode-specific metadata across deep merge', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'happy-stacks-runtime-state-proxy-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const statePath = join(dir, 'stack.runtime.json');
  await recordStackRuntimeStart(statePath, {
    stackName: 'dev-built',
    script: 'dev.mjs',
    ephemeral: true,
    ownerPid: process.pid,
    ports: { server: 4101 },
  });

  await recordStackRuntimeUpdate(
    statePath,
    createStackDevProxyRuntimePatch({
      stablePort: 4101,
      backendPort: 5102,
      proxyPid: process.pid,
      backendPid: process.pid + 1,
      drainingPid: null,
      mode: 'proxy',
      restartMode: 'blueGreen',
    }),
  );
  await recordStackRuntimeUpdate(
    statePath,
    createStackDevProxyRuntimePatch({
      stablePort: 4101,
      backendPort: null,
      proxyPid: null,
      backendPid: null,
      drainingPid: null,
      mode: 'directFallback',
      fallbackReason: 'proxy bind failed',
    }),
  );

  const state = await readStackRuntimeStateFile(statePath);
  assert.deepEqual(state?.serverProxy, {
    enabled: true,
    mode: 'directFallback',
    restartMode: null,
    fallbackReason: 'proxy bind failed',
  });
});

test('recordStackRuntimeStart clears dead process pids while preserving live child pids', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'happy-stacks-runtime-state-pids-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const statePath = join(dir, 'stack.runtime.json');
  await writeFile(
    statePath,
    JSON.stringify({
      version: 1,
      stackName: 'dev-built',
      script: 'dev.mjs',
      ephemeral: true,
      ownerPid: 999_999_998,
      ports: { server: 23456 },
      processes: {
        serverPid: 999_999_997,
        daemonPid: process.pid,
      },
    }) + '\n',
    'utf8',
  );

  const next = await recordStackRuntimeStart(
    statePath,
    {
      stackName: 'dev-built',
      script: 'dev.mjs',
      ephemeral: true,
      ownerPid: process.pid,
      ports: { server: 23456 },
    },
    {
      isRuntimeProcessTrustedImpl: async () => true,
    },
  );

  assert.equal(next.processes.serverPid, null);
  assert.equal(next.processes.daemonPid, process.pid);
});

test('recordStackRuntimeStart clears live process pids that fail stack ownership validation', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'happy-stacks-runtime-state-reused-pids-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const statePath = join(dir, 'stack.runtime.json');
  await writeFile(
    statePath,
    JSON.stringify({
      version: 1,
      stackName: 'dev-built',
      script: 'dev.mjs',
      ephemeral: true,
      ownerPid: 999_999_998,
      ports: { server: 23456 },
      processes: {
        serverPid: process.pid,
        daemonPid: process.pid,
      },
    }) + '\n',
    'utf8',
  );

  const next = await recordStackRuntimeStart(
    statePath,
    {
      stackName: 'dev-built',
      script: 'dev.mjs',
      ephemeral: true,
      ownerPid: process.pid,
      ports: { server: 23456 },
    },
    {
      isPidAliveImpl: () => true,
      isRuntimeProcessTrustedImpl: async (_pid, { key }) => key === 'daemonPid',
    },
  );

  assert.equal(next.processes.serverPid, null);
  assert.equal(next.processes.daemonPid, process.pid);
});

test('getStackRuntimeProcessEntries includes pid set arrays without duplicate or invalid pids', () => {
  const entries = getStackRuntimeProcessEntries({
    processes: {
      serverPid: 123,
      daemonPid: 222,
      daemonPids: [222, '333', 0, 'nope', 333],
      unrelated: 444,
      invalidPids: ['x', 1],
    },
  });

  assert.deepEqual(entries, [
    { key: 'serverPid', pid: 123 },
    { key: 'daemonPid', pid: 222 },
    { key: 'daemonPids', pid: 222 },
    { key: 'daemonPids', pid: 333 },
  ]);
});

test('recordStackRuntimeStart prunes untrusted pid set entries while preserving trusted entries', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'happy-stacks-runtime-state-pid-sets-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const statePath = join(dir, 'stack.runtime.json');
  await writeFile(
    statePath,
    JSON.stringify({
      version: 1,
      stackName: 'dev-built',
      script: 'dev.mjs',
      ephemeral: true,
      ownerPid: 999_999_998,
      ports: { server: 23456 },
      processes: {
        daemonPids: [process.pid, process.pid + 100000],
      },
    }) + '\n',
    'utf8',
  );

  const next = await recordStackRuntimeStart(
    statePath,
    {
      stackName: 'dev-built',
      script: 'dev.mjs',
      ephemeral: true,
      ownerPid: process.pid,
      ports: { server: 23456 },
    },
    {
      isPidAliveImpl: (pid) => Number(pid) === process.pid,
      isRuntimeProcessTrustedImpl: async (_pid, { key }) => key === 'daemonPids',
    },
  );

  assert.deepEqual(next.processes.daemonPids, [process.pid]);
});

test('resolveTrustedStackRuntimeServerPort rejects live runtime pids without stack ownership evidence', async () => {
  const port = await resolveTrustedStackRuntimeServerPort(
    {
      ownerPid: process.pid,
      processes: { serverPid: process.pid },
      ports: { server: 23456 },
    },
    { stackName: 'dev-built' },
    {
      isPidAliveImpl: () => true,
      isRuntimeProcessTrustedImpl: async () => false,
    },
  );

  assert.equal(port, null);
});

test('resolveTrustedStackRuntimeServerPort accepts a live trusted runtime component pid', async () => {
  const port = await resolveTrustedStackRuntimeServerPort(
    {
      ownerPid: 999_999_998,
      processes: { serverPid: process.pid },
      ports: { server: 23456 },
    },
    { stackName: 'dev-built' },
    {
      isPidAliveImpl: (pid) => Number(pid) === process.pid,
      isRuntimeProcessTrustedImpl: async (_pid, { key }) => key === 'serverPid',
    },
  );

  assert.equal(port, 23456);
});

test('recordStackRuntimeStopRequest persists stop attribution details', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'happy-stacks-runtime-state-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const statePath = join(dir, 'stack.runtime.json');
  await recordStackRuntimeStart(statePath, {
    stackName: 'dev-built',
    script: 'run.mjs',
    ephemeral: true,
    ownerPid: process.pid,
    ports: { server: 23456 },
  });

  await recordStackRuntimeStopRequest(statePath, {
    signal: 'SIGTERM',
    requestedBy: 'service restart',
    reason: 'explicit restart',
    preserveDaemon: true,
  });

  const state = await readStackRuntimeStateFile(statePath);
  assert.deepEqual(state?.stopRequest, {
    signal: 'SIGTERM',
    requestedBy: 'service restart',
    reason: 'explicit restart',
    preserveDaemon: true,
    requestedAt: state?.stopRequest?.requestedAt,
  });
  assert.equal(typeof state?.stopRequest?.requestedAt, 'string');
});
