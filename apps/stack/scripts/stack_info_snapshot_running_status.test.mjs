import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';

import { filterEnvForSpawn, withPatchedProcessEnv } from './testkit/core/env_scope.mjs';
import { spawnDetachedInlineNodeTestProcess, spawnDetachedTestProcess } from './testkit/core/spawn_test_process.mjs';
import { readStackInfoSnapshot } from './stack/stack_info_snapshot.mjs';
import { listListenPidsWithStatus } from './utils/net/ports.mjs';
import { resolvePidStackOwnership } from './utils/proc/ownership.mjs';
import { createListenerOwnershipObservationScope } from './utils/server/listener_ownership.mjs';
import { startServerWithOwnershipProof } from './utils/server/server_startup_attempt.mjs';
import { stopStackWithEnv } from './utils/stack/stop.mjs';
import { recordStackRuntimeServerPids, recordStackRuntimeUpdate } from './utils/stack/runtime_state.mjs';
import {
  createWindowsOwnershipBoundary,
  expectedWindowsVerifiedInstances,
  writeArmedServerReceipt,
} from './testkit/core/server_ownership_proof.mjs';

const ownedWhen = (isOwned) => async (pid) => (isOwned(pid)
  ? { status: 'owned', owned: true, reason: 'test' }
  : { status: 'not_owned', owned: false, reason: 'not_owned' });

async function withListeningServer() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? Number(addr.port) : 0;
  return {
    port,
    async close() {
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

async function reserveUnusedPort() {
  const listener = await withListeningServer();
  const port = listener.port;
  await listener.close();
  return port;
}

async function waitForJsonFile(path, { timeoutMs = 5_000, intervalMs = 30 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await readFile(path, 'utf-8'));
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
  throw new Error(`timed out waiting for ${path}: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

async function waitForProcessAlive(pid, { timeoutMs = 5_000, intervalMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
  throw new Error(`timed out waiting for pid ${pid}`);
}

async function waitForListenPid(port, expectedPid, { timeoutMs = 5_000, intervalMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastPids = [];
  while (Date.now() < deadline) {
    const status = await listListenPidsWithStatus(port);
    lastPids = Array.isArray(status.pids) ? status.pids : [];
    if (lastPids.includes(expectedPid)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`timed out waiting for pid ${expectedPid} to listen on ${port}; saw [${lastPids.join(', ')}]`);
}

function baseListenerEnv(extraEnv = {}) {
  return {
    ...filterEnvForSpawn(process.env, {
      keepKeys: ['PATH', 'Path', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot', 'ComSpec'],
    }),
    ...extraEnv,
  };
}

async function spawnTcpListener({ readyPath, env }) {
  const child = spawnDetachedTestProcess(
    process.execPath,
    [
      '-e',
      `
const fs = require('node:fs');
const net = require('node:net');

const readyPath = process.argv[1];
const server = net.createServer((socket) => {
  socket.end('ok');
});

server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  fs.writeFileSync(readyPath, JSON.stringify({ pid: process.pid, port: address.port }) + '\\n', 'utf-8');
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
setInterval(() => {}, 1000);
      `,
      readyPath,
    ],
    {
      env,
      stdio: 'ignore',
    },
  );
  const ready = await waitForJsonFile(readyPath);
  return {
    pid: Number(child.pid),
    port: Number(ready.port),
    async close() {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        try {
          process.kill(child.pid, 'SIGKILL');
        } catch {
          // ignore
        }
      }
    },
  };
}

async function spawnProcessGroupTcpListener({ readyPath, env }) {
  if (process.platform === 'win32') {
    throw new Error('process group listener helper is not supported on Windows');
  }

  const child = spawnDetachedTestProcess(
    process.execPath,
    [
      '-e',
      `
const { spawn } = require('node:child_process');
const fs = require('node:fs');

const readyPath = process.argv[1];
const listener = spawn(process.execPath, ['-e', \`
const fs = require('node:fs');
const net = require('node:net');

const readyPath = process.argv[1];
const ownerPid = Number(process.argv[2]);
const server = net.createServer((socket) => {
  socket.end('ok');
});

server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  fs.writeFileSync(
    readyPath,
    JSON.stringify({ ownerPid, listenerPid: process.pid, port: address.port }) + '\\\\n',
    'utf-8',
  );
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
setInterval(() => {}, 1000);
\`, readyPath, String(process.pid)], {
  detached: false,
  stdio: 'ignore',
});

listener.unref();

function shutdown() {
  if (listener.pid) {
    try {
      process.kill(listener.pid, 'SIGTERM');
    } catch {}
  }
  setTimeout(() => process.exit(0), 500).unref();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
setInterval(() => {}, 1000);
      `,
      readyPath,
    ],
    {
      env,
      stdio: 'ignore',
    },
  );
  const ready = await waitForJsonFile(readyPath);
  return {
    ownerPid: Number(child.pid),
    listenerPid: Number(ready.listenerPid),
    port: Number(ready.port),
    async close() {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        try {
          process.kill(child.pid, 'SIGKILL');
        } catch {
          // ignore
        }
      }
    },
  };
}

test('readStackInfoSnapshot reports running when owner pid is stale but an infra pid is alive', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-info-running-process-'));
  const storageDir = join(tmp, 'storage');
  const stackName = 'dev-auth';
  const baseDir = join(storageDir, stackName);

  await mkdir(baseDir, { recursive: true });
  await writeFile(join(baseDir, 'env'), 'HAPPIER_STACK_SERVER_PORT=3009\n', 'utf-8');
  await writeFile(
    join(baseDir, 'stack.runtime.json'),
    JSON.stringify({
      version: 1,
      stackName,
      ownerPid: 999_999_999,
      processes: { serverPid: process.pid },
      ports: { server: 3009 },
    }) + '\n',
    'utf-8'
  );

  const restore = withPatchedProcessEnv(t, { HAPPIER_STACK_STORAGE_DIR: storageDir });
  try {
    const out = await readStackInfoSnapshot({
      rootDir: process.cwd(),
      stackName,
      resolvePidStackOwnershipImpl: async (pid, ownershipContext) => {
        assert.equal(pid, daemonProcess.pid);
        assert.equal(ownershipContext.stackName, stackName);
        assert.equal(ownershipContext.envPath, envPath);
        return { status: 'owned', owned: true, reason: 'test_process' };
      },
    });
    assert.equal(out.runtime.running, true);
    assert.equal(out.runtime.runningPid, process.pid);
  } finally {
    restore();
    await rm(tmp, { recursive: true, force: true });
  }
});

test('readStackInfoSnapshot resolves listener child owned by recorded runtime process group', async (t) => {
  if (process.platform === 'win32') {
    t.skip('process group ownership discovery is not available on Windows');
    return;
  }

  const tmp = await mkdtemp(join(tmpdir(), 'hstack-info-pgid-listener-'));
  const storageDir = join(tmp, 'storage');
  const stackName = 'dev-auth';
  const baseDir = join(storageDir, stackName);
  const readyPath = join(tmp, 'server-ready.json');
  let listener = null;

  await mkdir(baseDir, { recursive: true });

  try {
    listener = await spawnProcessGroupTcpListener({
      readyPath,
      env: baseListenerEnv(),
    });
    await waitForListenPid(listener.port, listener.listenerPid);

    await writeFile(join(baseDir, 'env'), `HAPPIER_STACK_SERVER_PORT=${listener.port}\n`, 'utf-8');
    await writeFile(
      join(baseDir, 'stack.runtime.json'),
      JSON.stringify({
        version: 1,
        stackName,
        ownerPid: 999_999_999,
        processes: { serverPid: listener.ownerPid },
        ports: { server: listener.port },
      }) + '\n',
      'utf-8',
    );

    const restore = withPatchedProcessEnv(t, { HAPPIER_STACK_STORAGE_DIR: storageDir });
    try {
      const out = await readStackInfoSnapshot({
        rootDir: process.cwd(),
        stackName,
        resolvePidStackOwnershipImpl: ownedWhen((pid) => pid === listener.ownerPid),
        getProcessGroupIdImpl: async (pid) => pid === listener.ownerPid || pid === listener.listenerPid
          ? listener.ownerPid
          : null,
      });
      assert.equal(out.runtime.running, true);
      assert.equal(out.runtime.components.server.pid, listener.listenerPid);
      assert.equal(out.runtime.components.server.running, true);
      assert.deepEqual(out.runtime.components.server.ownedListenerPids, [listener.listenerPid]);
    } finally {
      restore();
    }
  } finally {
    await listener?.close();
    await rm(tmp, { recursive: true, force: true });
  }
});

test('readStackInfoSnapshot falls back to live recorded pid and reachable port when listener pid discovery is unsupported', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-info-listener-discovery-unsupported-'));
  const storageDir = join(tmp, 'storage');
  const stackName = 'dev-auth';
  const baseDir = join(storageDir, stackName);
  const port = await reserveUnusedPort();

  await mkdir(baseDir, { recursive: true });
  await writeFile(join(baseDir, 'env'), `HAPPIER_STACK_SERVER_PORT=${port}\nHAPPIER_STACK_DAEMON=0\n`, 'utf-8');
  await writeFile(
    join(baseDir, 'stack.runtime.json'),
    JSON.stringify({
      version: 1,
      stackName,
      ownerPid: 999_999_999,
      processes: { serverPid: process.pid },
      ports: { server: port },
    }) + '\n',
    'utf-8',
  );

  const restore = withPatchedProcessEnv(t, { HAPPIER_STACK_STORAGE_DIR: storageDir });
  try {
    const out = await readStackInfoSnapshot({
      rootDir: process.cwd(),
      stackName,
      listListenPidsWithStatusImpl: async () => ({
        supported: false,
        pids: [],
        reason: 'unsupported-test',
      }),
      isTcpPortListeningImpl: async () => true,
    });
    assert.equal(out.runtime.components.server.running, true);
    assert.equal(out.runtime.components.server.pid, process.pid);
    assert.equal(out.runtime.components.server.portListening, true);
    assert.equal(out.runtime.components.server.listenerDiscoverySupported, false);
    assert.deepEqual(out.runtime.components.server.ownedListenerPids, []);
  } finally {
    restore();
    await rm(tmp, { recursive: true, force: true });
  }
});

test('readStackInfoSnapshot reports ownership_unknown instead of server_down when listener discovery times out', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-info-listener-discovery-timeout-'));
  const storageDir = join(tmp, 'storage');
  const stackName = 'dev-auth';
  const baseDir = join(storageDir, stackName);
  const port = await reserveUnusedPort();

  await mkdir(baseDir, { recursive: true });
  await writeFile(join(baseDir, 'env'), `HAPPIER_STACK_SERVER_PORT=${port}\nHAPPIER_STACK_DAEMON=0\n`, 'utf-8');
  await writeFile(
    join(baseDir, 'stack.runtime.json'),
    JSON.stringify({
      version: 1,
      stackName,
      ownerPid: process.pid,
      processes: { serverPid: process.pid },
      ports: { server: port },
    }) + '\n',
    'utf-8',
  );

  const restore = withPatchedProcessEnv(t, { HAPPIER_STACK_STORAGE_DIR: storageDir });
  try {
    const out = await readStackInfoSnapshot({
      rootDir: process.cwd(),
      stackName,
      listListenPidsWithStatusImpl: async () => ({
        status: 'timeout',
        supported: true,
        pids: [],
        reason: 'listener-discovery-timeout',
      }),
      isTcpPortListeningImpl: async () => true,
    });
    assert.equal(out.runtime.components.server.running, true);
    assert.equal(out.runtime.components.server.ownershipStatus, 'unknown');
    assert.equal(out.runtime.components.server.listenerDiscoveryStatus, 'timeout');
    assert.equal(out.runtime.health.status, 'degraded');
    assert.deepEqual(out.runtime.health.issues, ['ownership_unknown']);
  } finally {
    restore();
    await rm(tmp, { recursive: true, force: true });
  }
});

test('readStackInfoSnapshot shares one listener deadline across server, backend, and UI observations', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-info-shared-listener-deadline-'));
  const storageDir = join(tmp, 'storage');
  const stackName = 'dev-auth';
  const baseDir = join(storageDir, stackName);
  await mkdir(baseDir, { recursive: true });
  await writeFile(
    join(baseDir, 'env'),
    'HAPPIER_STACK_SERVER_PORT=4101\nHAPPIER_STACK_UI_PORT=4103\nHAPPIER_STACK_DAEMON=0\n',
    'utf-8',
  );
  await writeFile(
    join(baseDir, 'stack.runtime.json'),
    JSON.stringify({
      version: 1,
      stackName,
      ownerPid: process.pid,
      processes: { proxyPid: process.pid, serverPid: process.pid, serverBackendPid: process.pid, expoPid: process.pid },
      ports: { server: 4101, serverBackend: 4102 },
      expo: { pid: process.pid, webPort: 4103 },
      serverProxy: { enabled: true, mode: 'proxy' },
    }) + '\n',
    'utf-8',
  );

  const restore = withPatchedProcessEnv(t, { HAPPIER_STACK_STORAGE_DIR: storageDir });
  const attemptBudgetsMs = [];
  try {
    const out = await readStackInfoSnapshot({
      rootDir: process.cwd(),
      stackName,
      listenerObservationTimeoutMs: 40,
      listListenPidsWithStatusImpl: async (_port, { signal, timeoutMs } = {}) => await new Promise((resolve) => {
        attemptBudgetsMs.push(Number(timeoutMs));
        const timer = setTimeout(() => resolve({ status: 'ok', supported: true, pids: [process.pid] }), 120);
        signal?.addEventListener('abort', () => clearTimeout(timer), { once: true });
      }),
      isTcpPortListeningImpl: async () => true,
    });
    assert.ok(
      attemptBudgetsMs.reduce((total, timeoutMs) => total + timeoutMs, 0) <= 45,
      `listener attempts received independent budgets: ${attemptBudgetsMs.join(',')}`,
    );
    assert.equal(out.runtime.components.server.ownershipStatus, 'unknown');
    assert.equal(out.runtime.components.serverBackend.ownershipStatus, 'unknown');
    assert.equal(out.runtime.components.ui.ownershipStatus, 'unknown');
    assert.deepEqual(out.runtime.health.issues, ['ownership_unknown']);
  } finally {
    restore();
    await rm(tmp, { recursive: true, force: true });
  }
});

test('readStackInfoSnapshot reports proxy and active backend separately in proxy mode', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-info-proxy-mode-'));
  const storageDir = join(tmp, 'storage');
  const stackName = 'dev-auth';
  const baseDir = join(storageDir, stackName);

  await mkdir(baseDir, { recursive: true });
  await writeFile(join(baseDir, 'env'), 'HAPPIER_STACK_SERVER_PORT=4101\nHAPPIER_STACK_DAEMON=0\n', 'utf-8');
  await writeFile(
    join(baseDir, 'stack.runtime.json'),
    JSON.stringify({
      version: 1,
      stackName,
      ownerPid: 999_999_999,
      processes: {
        proxyPid: process.pid,
        serverPid: process.pid,
        serverBackendPid: process.pid,
      },
      ports: {
        server: 4101,
        serverBackend: 5101,
      },
      serverProxy: {
        enabled: true,
        mode: 'proxy',
        restartMode: 'exclusiveDb',
      },
      serverLifecycle: {
        phase: 'retry-scheduled',
        planned: { mode: 'exclusiveDb', generation: 8, reason: 'prisma_changed' },
        lastCompleted: { mode: 'exclusiveDb', generation: 7 },
        retry: { afterMs: 250 },
        disposition: null,
      },
    }) + '\n',
    'utf-8',
  );

  const restore = withPatchedProcessEnv(t, { HAPPIER_STACK_STORAGE_DIR: storageDir });
  try {
    const out = await readStackInfoSnapshot({
      rootDir: process.cwd(),
      stackName,
      listListenPidsWithStatusImpl: async () => ({
        supported: false,
        pids: [],
        reason: 'unsupported-test',
      }),
      isTcpPortListeningImpl: async () => true,
    });
    assert.equal(out.runtime.components.server.pid, process.pid);
    assert.equal(out.runtime.components.server.running, true);
    assert.equal(out.runtime.components.serverBackend.pid, process.pid);
    assert.equal(out.runtime.components.serverBackend.running, true);
    assert.equal(out.ports.server, 4101);
    assert.equal(out.ports.serverBackend, 5101);
    assert.deepEqual(out.runtime.serverProxy, {
      enabled: true,
      mode: 'proxy',
      restartMode: 'exclusiveDb',
    });
    assert.deepEqual(out.runtime.serverLifecycle, {
      phase: 'retry-scheduled',
      planned: { mode: 'exclusiveDb', generation: 8, reason: 'prisma_changed' },
      lastCompleted: { mode: 'exclusiveDb', generation: 7 },
      retry: { afterMs: 250 },
      disposition: null,
    });
    assert.equal(out.runtime.health.status, 'degraded');
    assert.deepEqual(out.runtime.health.issues, ['ownership_unknown']);
  } finally {
    restore();
    await rm(tmp, { recursive: true, force: true });
  }
});

test('readStackInfoSnapshot does not report running when stale metadata points at an unrelated server port listener', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-info-running-port-'));
  const storageDir = join(tmp, 'storage');
  const stackName = 'dev-auth';
  const baseDir = join(storageDir, stackName);

  await mkdir(baseDir, { recursive: true });

  const listener = await withListeningServer();
  await writeFile(join(baseDir, 'env'), `HAPPIER_STACK_SERVER_PORT=${listener.port}\n`, 'utf-8');
  await writeFile(
    join(baseDir, 'stack.runtime.json'),
    JSON.stringify({
      version: 1,
      stackName,
      ownerPid: 999_999_999,
      processes: { serverPid: 999_999_998 },
      ports: { server: listener.port },
    }) + '\n',
    'utf-8'
  );

  const restore = withPatchedProcessEnv(t, { HAPPIER_STACK_STORAGE_DIR: storageDir });
  try {
    const out = await readStackInfoSnapshot({
      rootDir: process.cwd(),
      stackName,
      listListenPidsWithStatusImpl: async (port) => ({
        status: 'ok',
        supported: true,
        pids: Number(port) === listener.port ? [process.pid] : [],
      }),
      isTcpPortListeningImpl: async (port) => Number(port) === listener.port,
      resolvePidStackOwnershipImpl: ownedWhen(() => false),
    });
    assert.equal(out.runtime.running, false);
    assert.equal(out.runtime.components.server.running, false);
    assert.equal(out.runtime.components.server.portListening, true);
    assert.equal(out.runtime.health.status, 'stopped');
    assert.deepEqual(out.runtime.health.issues, ['server_down']);
  } finally {
    restore();
    await listener.close();
    await rm(tmp, { recursive: true, force: true });
  }
});

test('readStackInfoSnapshot resolves stale server and UI pids from stack-owned listener pids', async (t) => {
  if (process.platform === 'win32') {
    t.skip('listener pid ownership discovery is not available on Windows');
    return;
  }

  const tmp = await mkdtemp(join(tmpdir(), 'hstack-info-owned-listener-'));
  const storageDir = join(tmp, 'storage');
  const stackName = 'dev-auth';
  const baseDir = join(storageDir, stackName);
  const envPath = join(baseDir, 'env');
  const cliHomeDir = join(baseDir, 'cli');
  const serverReadyPath = join(tmp, 'server-ready.json');
  const uiReadyPath = join(tmp, 'ui-ready.json');
  let serverListener = null;
  let uiListener = null;

  await mkdir(baseDir, { recursive: true });
  await mkdir(cliHomeDir, { recursive: true });

  try {
    const ownedEnv = baseListenerEnv({
      HAPPIER_STACK_STACK: stackName,
      HAPPIER_STACK_ENV_FILE: envPath,
      HAPPIER_STACK_PROCESS_KIND: 'infra',
    });
    serverListener = await spawnTcpListener({ readyPath: serverReadyPath, env: ownedEnv });
    uiListener = await spawnTcpListener({ readyPath: uiReadyPath, env: ownedEnv });

    await writeFile(
      envPath,
      [
        `HAPPIER_STACK_SERVER_PORT=${serverListener.port}`,
        'HAPPIER_STACK_DAEMON=0',
        '',
      ].join('\n'),
      'utf-8',
    );
    await writeFile(
      join(baseDir, 'stack.runtime.json'),
      JSON.stringify({
        version: 1,
        stackName,
        ownerPid: 999_999_999,
        processes: { serverPid: 999_999_998, expoPid: 999_999_997 },
        ports: { server: serverListener.port },
        expo: { webPort: uiListener.port, webEnabled: true },
      }) + '\n',
      'utf-8',
    );

    const restore = withPatchedProcessEnv(t, { HAPPIER_STACK_STORAGE_DIR: storageDir });
    try {
      const ownedPids = new Set([serverListener.pid, uiListener.pid]);
      const out = await readStackInfoSnapshot({
        rootDir: process.cwd(),
        stackName,
        listListenPidsWithStatusImpl: async (port) => ({
          status: 'ok',
          supported: true,
          pids: port === serverListener.port
            ? [serverListener.pid]
            : port === uiListener.port
              ? [uiListener.pid]
              : [],
        }),
        isTcpPortListeningImpl: async (port) => port === serverListener.port || port === uiListener.port,
        resolvePidStackOwnershipImpl: ownedWhen((pid) => ownedPids.has(pid)),
      });
      assert.equal(out.runtime.running, true);
      assert.ok([serverListener.pid, uiListener.pid].includes(out.runtime.runningPid));
      assert.equal(out.runtime.health.status, 'healthy');
      assert.deepEqual(out.runtime.health.issues, []);
      assert.equal(out.runtime.components.server.pid, serverListener.pid);
      assert.equal(out.runtime.components.server.running, true);
      assert.equal(out.runtime.components.server.pidAlive, true);
      assert.equal(out.runtime.components.server.portListening, true);
      assert.equal(out.runtime.components.ui.pid, uiListener.pid);
      assert.equal(out.runtime.components.ui.running, true);
      assert.equal(out.runtime.components.ui.pidAlive, true);
      assert.equal(out.runtime.components.ui.portListening, true);
    } finally {
      restore();
    }
  } finally {
    await serverListener?.close();
    await uiListener?.close();
    await rm(tmp, { recursive: true, force: true });
  }
});

test('readStackInfoSnapshot projects a runtime-backed static UI through the server instead of stale Expo metadata', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-info-runtime-ui-'));
  const storageDir = join(tmp, 'storage');
  const stackName = 'runtime-ui';
  const baseDir = join(storageDir, stackName);

  await mkdir(baseDir, { recursive: true });

  const serverListener = await withListeningServer();
  const staleUiPort = await reserveUnusedPort();
  await writeFile(
    join(baseDir, 'env'),
    `HAPPIER_STACK_SERVER_PORT=${serverListener.port}\nHAPPIER_STACK_RUNTIME_MODE=require\nHAPPIER_STACK_DAEMON=0\n`,
    'utf-8',
  );
  await writeFile(
    join(baseDir, 'stack.runtime.json'),
    JSON.stringify({
      version: 1,
      stackName,
      ownerPid: process.pid,
      runtimeSnapshotId: 'snapshot-1',
      processes: { serverPid: process.pid, expoPid: 999_999_998 },
      ports: { server: serverListener.port },
      expo: { webPort: staleUiPort, webEnabled: true },
    }) + '\n',
    'utf-8',
  );

  const restore = withPatchedProcessEnv(t, { HAPPIER_STACK_STORAGE_DIR: storageDir });
  try {
    const out = await readStackInfoSnapshot({
      rootDir: process.cwd(),
      stackName,
      listListenPidsWithStatusImpl: async (port) => ({
        status: 'ok',
        supported: true,
        pids: port === serverListener.port ? [process.pid] : [],
      }),
      isTcpPortListeningImpl: async (port) => port === serverListener.port,
      resolvePidStackOwnershipImpl: ownedWhen((pid) => pid === process.pid),
    });

    assert.equal(out.runtime.components.server.running, true);
    assert.equal(out.runtime.components.ui.running, true);
    assert.equal(out.runtime.components.ui.pid, process.pid);
    assert.equal(out.ports.ui, serverListener.port);
    assert.equal(out.urls.uiUrl, `http://${out.urls.host}:${serverListener.port}`);
    assert.equal(out.runtime.health.status, 'healthy');
    assert.deepEqual(out.runtime.health.issues, []);
  } finally {
    restore();
    await serverListener.close();
    await rm(tmp, { recursive: true, force: true });
  }
});

for (const scenario of [
  {
    name: 'environment-disabled',
    envLine: 'HAPPIER_STACK_SERVE_UI=0',
    runtimeServeUi: undefined,
  },
  {
    name: 'launch-disabled',
    envLine: '',
    runtimeServeUi: false,
  },
]) {
  test(`readStackInfoSnapshot keeps runtime-backed UI disabled for ${scenario.name} truth despite stale live Expo metadata`, async (t) => {
    const tmp = await mkdtemp(join(tmpdir(), `hstack-info-runtime-ui-${scenario.name}-`));
    const storageDir = join(tmp, 'storage');
    const stackName = `runtime-ui-${scenario.name}`;
    const baseDir = join(storageDir, stackName);

    await mkdir(baseDir, { recursive: true });
    const serverListener = await withListeningServer();
    const staleUiPort = await reserveUnusedPort();
    await writeFile(
      join(baseDir, 'env'),
      [
        `HAPPIER_STACK_SERVER_PORT=${serverListener.port}`,
        'HAPPIER_STACK_RUNTIME_MODE=require',
        'HAPPIER_STACK_DAEMON=0',
        scenario.envLine,
        '',
      ].filter((line) => line !== '').join('\n') + '\n',
      'utf-8',
    );
    await writeFile(
      join(baseDir, 'stack.runtime.json'),
      JSON.stringify({
        version: 1,
        stackName,
        ownerPid: process.pid,
        runtimeSnapshotId: 'snapshot-1',
        ...(typeof scenario.runtimeServeUi === 'boolean' ? { serveUi: scenario.runtimeServeUi } : {}),
        processes: { serverPid: process.pid, expoPid: process.pid },
        ports: { server: serverListener.port },
        expo: { webPort: staleUiPort, webEnabled: true },
      }) + '\n',
      'utf-8',
    );

    const restore = withPatchedProcessEnv(t, { HAPPIER_STACK_STORAGE_DIR: storageDir });
    try {
      const out = await readStackInfoSnapshot({
        rootDir: process.cwd(),
        stackName,
        listListenPidsWithStatusImpl: async (port) => ({
          status: 'ok',
          supported: true,
          pids: port === serverListener.port ? [process.pid] : [],
        }),
        isTcpPortListeningImpl: async (port) => port === serverListener.port,
        resolvePidStackOwnershipImpl: ownedWhen((pid) => pid === process.pid),
      });

      assert.equal(out.runtime.components.ui.running, false);
      assert.equal(out.runtime.components.ui.pid, null);
      assert.equal(out.ports.ui, null);
      assert.equal(out.urls.uiUrl, null);
      assert.equal(out.runtime.health.issues.includes('ui_down'), false);
    } finally {
      restore();
      await serverListener.close();
      await rm(tmp, { recursive: true, force: true });
    }
  });
}

test('readStackInfoSnapshot marks UI as down when expo runtime metadata is stale', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-info-ui-stale-'));
  const storageDir = join(tmp, 'storage');
  const stackName = 'dev-auth';
  const baseDir = join(storageDir, stackName);

  await mkdir(baseDir, { recursive: true });

  const serverListener = await withListeningServer();
  const staleUiPort = await reserveUnusedPort();
  await writeFile(join(baseDir, 'env'), `HAPPIER_STACK_SERVER_PORT=${serverListener.port}\n`, 'utf-8');
  await writeFile(
    join(baseDir, 'stack.runtime.json'),
    JSON.stringify({
      version: 1,
      stackName,
      ownerPid: 999_999_999,
      processes: { serverPid: process.pid, expoPid: 999_999_998 },
      ports: { server: serverListener.port },
      expo: { webPort: staleUiPort, webEnabled: true },
    }) + '\n',
    'utf-8'
  );

  const restore = withPatchedProcessEnv(t, { HAPPIER_STACK_STORAGE_DIR: storageDir });
  try {
    const out = await readStackInfoSnapshot({
      resolvePidStackOwnershipImpl: async () => ({ status: 'owned', owned: true, reason: 'test' }),
      rootDir: process.cwd(),
      stackName,
      listListenPidsWithStatusImpl: async (port) => ({
        status: 'ok',
        supported: true,
        pids: port === serverListener.port ? [process.pid] : [],
      }),
      isTcpPortListeningImpl: async (port) => port === serverListener.port,
    });
    assert.equal(out.runtime.running, true);
    assert.equal(out.runtime.components.server.running, true);
    assert.equal(out.runtime.components.ui.running, false);
    assert.equal(out.runtime.health.status, 'degraded');
    assert.deepEqual(out.runtime.health.issues, ['ui_down', 'daemon_down']);
  } finally {
    restore();
    await serverListener.close();
    await rm(tmp, { recursive: true, force: true });
  }
});

test('readStackInfoSnapshot requires UI port reachability even when expo pid is alive', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-info-ui-unreachable-'));
  const storageDir = join(tmp, 'storage');
  const stackName = 'dev-auth';
  const baseDir = join(storageDir, stackName);

  await mkdir(baseDir, { recursive: true });

  const serverListener = await withListeningServer();
  const staleUiPort = await reserveUnusedPort();
  await writeFile(join(baseDir, 'env'), `HAPPIER_STACK_SERVER_PORT=${serverListener.port}\n`, 'utf-8');
  await writeFile(
    join(baseDir, 'stack.runtime.json'),
    JSON.stringify({
      version: 1,
      stackName,
      ownerPid: 999_999_999,
      processes: { serverPid: process.pid, expoPid: process.pid },
      ports: { server: serverListener.port },
      expo: { webPort: staleUiPort, webEnabled: true },
    }) + '\n',
    'utf-8'
  );

  const restore = withPatchedProcessEnv(t, { HAPPIER_STACK_STORAGE_DIR: storageDir });
  try {
    const out = await readStackInfoSnapshot({
      resolvePidStackOwnershipImpl: async () => ({ status: 'owned', owned: true, reason: 'test' }),
      rootDir: process.cwd(),
      stackName,
      listListenPidsWithStatusImpl: async (port) => ({
        status: 'ok',
        supported: true,
        pids: port === serverListener.port ? [process.pid] : [],
      }),
      isTcpPortListeningImpl: async (port) => port === serverListener.port,
    });
    assert.equal(out.runtime.running, true);
    assert.equal(out.runtime.components.ui.pidAlive, true);
    assert.equal(out.runtime.components.ui.running, false);
    assert.equal(out.runtime.health.status, 'degraded');
    assert.deepEqual(out.runtime.health.issues, ['ui_down', 'daemon_down']);
  } finally {
    restore();
    await serverListener.close();
    await rm(tmp, { recursive: true, force: true });
  }
});

test('readStackInfoSnapshot reports runtime daemonPids without treating them as ping-confirmed running', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-info-daemon-pid-set-'));
  const storageDir = join(tmp, 'storage');
  const stackName = 'dev-auth';
  const baseDir = join(storageDir, stackName);
  const envPath = join(baseDir, 'env');
  await mkdir(baseDir, { recursive: true });
  await writeFile(envPath, 'HAPPIER_STACK_DAEMON=1\n', 'utf-8');
  const daemonProcess = spawnDetachedInlineNodeTestProcess('setInterval(() => {}, 1000)', {
    env: {
      ...process.env,
      HAPPIER_STACK_STACK: stackName,
      HAPPIER_STACK_ENV_FILE: envPath,
      HAPPIER_STACK_PROCESS_KIND: 'daemon',
    },
  });
  t.after(() => {
    try {
      process.kill(-daemonProcess.pid, 'SIGTERM');
    } catch {
      // ignore
    }
  });
  await waitForProcessAlive(daemonProcess.pid);
  await writeFile(
    join(baseDir, 'stack.runtime.json'),
    JSON.stringify({
      version: 1,
      stackName,
      ownerPid: 999_999_999,
      processes: { daemonPid: null, daemonPids: [daemonProcess.pid] },
      ports: {},
    }) + '\n',
    'utf-8'
  );

  const restore = withPatchedProcessEnv(t, { HAPPIER_STACK_STORAGE_DIR: storageDir });
  try {
    const out = await readStackInfoSnapshot({
      rootDir: process.cwd(),
      stackName,
      resolvePidStackOwnershipImpl: async (pid, ownershipContext) => {
        assert.equal(pid, daemonProcess.pid);
        assert.equal(ownershipContext.stackName, stackName);
        assert.equal(ownershipContext.envPath, envPath);
        return { status: 'owned', owned: true, reason: 'test_process' };
      },
    });
    assert.equal(out.runtime.components.daemon.running, false);
    assert.equal(out.runtime.components.daemon.pid, daemonProcess.pid);
    assert.equal(out.runtime.components.daemon.source, 'runtime_pid');
    assert.equal(out.runtime.health.issues.includes('daemon_down'), true);
  } finally {
    restore();
    await rm(tmp, { recursive: true, force: true });
  }
});

test('readStackInfoSnapshot marks daemon as down when stack runtime is otherwise running and daemon is expected', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-info-daemon-down-'));
  const storageDir = join(tmp, 'storage');
  const stackName = 'dev-auth';
  const baseDir = join(storageDir, stackName);

  await mkdir(baseDir, { recursive: true });

  const serverListener = await withListeningServer();
  await writeFile(join(baseDir, 'env'), `HAPPIER_STACK_SERVER_PORT=${serverListener.port}\n`, 'utf-8');
  await writeFile(
    join(baseDir, 'stack.runtime.json'),
    JSON.stringify({
      version: 1,
      stackName,
      ownerPid: 999_999_999,
      processes: { serverPid: process.pid },
      ports: { server: serverListener.port },
    }) + '\n',
    'utf-8'
  );

  const restore = withPatchedProcessEnv(t, { HAPPIER_STACK_STORAGE_DIR: storageDir });
  try {
    const out = await readStackInfoSnapshot({
      rootDir: process.cwd(),
      stackName,
      listListenPidsWithStatusImpl: async (port) => ({
        status: 'ok',
        supported: true,
        pids: Number(port) === serverListener.port ? [process.pid] : [],
      }),
      isTcpPortListeningImpl: async (port) => Number(port) === serverListener.port,
      resolvePidStackOwnershipImpl: ownedWhen((pid) => Number(pid) === process.pid),
    });
    assert.equal(out.runtime.running, true);
    assert.equal(out.runtime.components.server.running, true);
    assert.equal(out.runtime.components.daemon.running, false);
    assert.equal(out.runtime.health.status, 'degraded');
    assert.deepEqual(out.runtime.health.issues, ['daemon_down']);
  } finally {
    restore();
    await serverListener.close();
    await rm(tmp, { recursive: true, force: true });
  }
});

const RECORDED_IDENTITY = { fingerprint: 'win32-cim:recorded', apiInstanceId: 'instance-1' };

async function createRecordedServerStack(t, { identity = RECORDED_IDENTITY, env = 'HAPPIER_STACK_DAEMON=0\n' } = {}) {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-info-recorded-server-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const storageDir = join(tmp, 'storage');
  const stackName = 'recorded-test';
  const baseDir = join(storageDir, stackName);
  const port = await reserveUnusedPort();
  await mkdir(baseDir, { recursive: true });
  await writeFile(join(baseDir, 'env'), `HAPPIER_STACK_SERVER_PORT=${port}\n${env}`, 'utf-8');
  await writeFile(join(baseDir, 'stack.runtime.json'), JSON.stringify({
    version: 1,
    stackName,
    ownerPid: process.pid,
    processes: { serverPid: process.pid },
    processInstances: { processes: { serverPid: identity ? { pid: process.pid, ...identity } : null } },
    ports: { server: port },
  }) + '\n', 'utf-8');
  const restore = withPatchedProcessEnv(t, { HAPPIER_STACK_STORAGE_DIR: storageDir });
  t.after(restore);
  return { stackName, port };
}

const hiddenListener = async () => ({ status: 'ok', supported: true, pids: [] });
const ownedProcess = async (_pid, _context, budget) => {
  assert.ok(budget?.timeoutMs > 0, 'the identity read must run inside the status budget');
  return { status: 'owned', owned: true, reason: 'process_instance' };
};
const answersRecordedInstance = async () => ({ status: 'identity', instanceId: RECORDED_IDENTITY.apiInstanceId });

test('status spends its listener budget on listener discovery, not on daemon work', async (t) => {
  const { stackName } = await createRecordedServerStack(t, { env: '' });
  const out = await readStackInfoSnapshot({
    rootDir: process.cwd(),
    stackName,
    listenerObservationTimeoutMs: 100,
    getObservedStackDaemonImpl: async () => {
      await new Promise((resolve) => setTimeout(resolve, 250));
      return { pid: null, running: false, status: 'stopped', source: 'test' };
    },
    listListenPidsWithStatusImpl: hiddenListener,
    isTcpPortListeningImpl: async () => true,
    resolvePidStackOwnershipImpl: ownedProcess,
    fetchReadyIdentityImpl: answersRecordedInstance,
  });
  assert.equal(out.runtime.components.server.listenerDiscoveryStatus, 'ok');
  assert.equal(out.runtime.components.server.ownershipStatus, 'owned');
});

test('status proves a known-owned server that OS discovery does not list', async (t) => {
  const { stackName, port } = await createRecordedServerStack(t);
  const fingerprints = [];
  const endpoints = [];
  const out = await readStackInfoSnapshot({
    rootDir: process.cwd(),
    stackName,
    listListenPidsWithStatusImpl: hiddenListener,
    isTcpPortListeningImpl: async () => true,
    resolvePidStackOwnershipImpl: async (pid, context, budget) => {
      fingerprints.push(context.processInstanceFingerprint);
      return await ownedProcess(pid, context, budget);
    },
    fetchReadyIdentityImpl: async (request) => {
      endpoints.push(request);
      return await answersRecordedInstance();
    },
  });
  const server = out.runtime.components.server;
  assert.equal(server.listenerDiscoveryStatus, 'ok');
  assert.equal(server.ownershipStatus, 'owned');
  assert.equal(server.running, true);
  assert.equal(server.pid, process.pid);
  assert.deepEqual(server.ownedListenerPids, [process.pid]);
  assert.deepEqual(fingerprints, [RECORDED_IDENTITY.fingerprint]);
  assert.deepEqual([endpoints[0].host, endpoints[0].port], ['127.0.0.1', port]);
  assert.deepEqual(out.runtime.health.issues.filter((issue) => issue.startsWith('server') || issue.startsWith('ownership')), []);
});

const unprovenStatuses = [
  ['another instance answers', { fetchReadyIdentityImpl: async () => ({ status: 'identity', instanceId: 'other' }) }, 'not_owned'],
  ['a legacy server answers', { fetchReadyIdentityImpl: async () => ({ status: 'legacy' }) }, 'not_owned'],
  ['/ready cannot be read', { fetchReadyIdentityImpl: async () => ({ status: 'invalid', reason: 'ready-unavailable' }) }, 'unknown'],
  ['the PID was reused', { resolvePidStackOwnershipImpl: async () => ({ status: 'not_owned', owned: false, reason: 'process_instance_mismatch' }) }, 'not_owned'],
  ['process identity is unavailable', { resolvePidStackOwnershipImpl: async () => ({ status: 'inconclusive', owned: null, reason: 'process-identity-unavailable' }) }, 'unknown'],
  ['no fingerprint is recorded', { identity: { apiInstanceId: 'instance-1' } }, 'not_owned'],
  ['no API instance is recorded', {
    identity: { fingerprint: 'win32-cim:recorded' },
    resolvePidStackOwnershipImpl: async () => assert.fail('nothing can be proven, so nothing should be probed'),
  }, 'not_owned'],
  ['the recorded identity is for another PID', {
    identity: { ...RECORDED_IDENTITY, pid: 4242 },
    resolvePidStackOwnershipImpl: async () => assert.fail('another process identity must not be probed'),
  }, 'not_owned'],
  ['no identity is recorded', { identity: null }, 'not_owned'],
  ['the identity is unverified', { identity: { fingerprint: null, unverified: true, apiInstanceId: 'instance-1' } }, 'not_owned'],
  ['a foreign listener is listed', { listListenPidsWithStatusImpl: async () => ({ status: 'ok', supported: true, pids: [4242] }), resolvePidStackOwnershipImpl: ownedWhen((pid) => pid === process.pid) }, 'not_owned'],
  ['discovery times out', { listListenPidsWithStatusImpl: async () => ({ status: 'timeout', supported: true, pids: [], reason: 'listener-discovery-timeout' }) }, 'unknown'],
  ['discovery errors', { listListenPidsWithStatusImpl: async () => ({ status: 'error', supported: true, pids: [], reason: 'listener-discovery-error' }) }, 'unknown'],
  ['discovery is unsupported', { listListenPidsWithStatusImpl: async () => ({ status: 'unsupported', supported: false, pids: [], reason: 'missing-listener-discovery-command' }) }, 'unknown'],
  ['nothing is listening', { isTcpPortListeningImpl: async () => false }, 'not_owned'],
];

for (const [name, { identity, ...overrides }, ownershipStatus] of unprovenStatuses) {
  test(`status does not claim a recorded server when ${name}`, async (t) => {
    const { stackName } = await createRecordedServerStack(t, { identity: identity === undefined ? RECORDED_IDENTITY : identity });
    const out = await readStackInfoSnapshot({
      rootDir: process.cwd(),
      stackName,
      listListenPidsWithStatusImpl: hiddenListener,
      isTcpPortListeningImpl: async () => true,
      resolvePidStackOwnershipImpl: ownedProcess,
      fetchReadyIdentityImpl: answersRecordedInstance,
      ...overrides,
    });
    const server = out.runtime.components.server;
    assert.equal(server.ownershipStatus, ownershipStatus);
    assert.deepEqual(server.ownedListenerPids, []);
  });
}

test('startup proof, immediate status and stop agree on the same process, and reuse breaks it', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-info-transition-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const storageDir = join(tmp, 'storage');
  const stackName = 'transition-test';
  const baseDir = join(storageDir, stackName);
  const port = await reserveUnusedPort();
  await mkdir(baseDir, { recursive: true });
  const envPath = join(baseDir, 'env');
  await writeFile(envPath, `HAPPIER_STACK_SERVER_PORT=${port}\nHAPPIER_STACK_DAEMON=0\n`, 'utf-8');
  t.after(withPatchedProcessEnv(t, { HAPPIER_STACK_STORAGE_DIR: storageDir }));
  const statePath = join(baseDir, 'stack.runtime.json');

  const server = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  t.after(() => server.kill('SIGKILL'));
  const boundary = createWindowsOwnershipBoundary({ wrapperPid: server.pid, serverPid: server.pid });
  await recordStackRuntimeUpdate(statePath, { stackName, ownerPid: 2147480400, ports: { server: port } });
  // Created after that write, as production creates it after spawn: the write's identity read is slow.
  const scope = createListenerOwnershipObservationScope({
    totalTimeoutMs: 10_000,
    listListenPidsWithStatusImpl: hiddenListener,
  });
  await startServerWithOwnershipProof({
    stackBaseDir: baseDir,
    env: {},
    endpoint: { host: '127.0.0.1', port },
    exactProcess: true,
    spawnServer: async (env) => {
      await writeArmedServerReceipt(env, { port, pid: server.pid });
      return server;
    },
    waitForReady: async () => {},
    recordOwnership: ({ child, proof }) => recordStackRuntimeServerPids(statePath, {
      listenerPid: proof.listenerPid,
      wrapperPid: child.pid,
      serverPort: port,
      clearProxyState: true,
      verifiedProcessInstances: proof.verifiedProcessInstances,
    }),
    terminateServer: async () => assert.fail('a proven server must not be terminated'),
  }, { ownershipBoundary: { ...boundary, observationScope: scope } });

  const readStatus = (runCaptureImpl) => readStackInfoSnapshot({
    rootDir: process.cwd(),
    stackName,
    listListenPidsWithStatusImpl: hiddenListener,
    isTcpPortListeningImpl: async () => true,
    fetchReadyIdentityImpl: boundary.fetchReadyIdentityImpl,
    resolvePidStackOwnershipImpl: (pid, context, budget) => resolvePidStackOwnership(pid, context, {
      ...budget,
      platform: 'win32',
      runCaptureImpl,
    }),
  });

  const status = (await readStatus(boundary.runCaptureImpl)).runtime.components.server;
  assert.equal(status.ownershipStatus, 'owned');
  assert.equal(status.pid, server.pid);

  const reused = (await readStatus(async () => '2026-11-06T23:59:59.0000000Z')).runtime.components.server;
  assert.equal(reused.ownershipStatus, 'not_owned');

  const kills = [];
  await stopStackWithEnv({
    rootDir: process.cwd(),
    stackName,
    baseDir,
    env: { ...process.env, HAPPIER_STACK_ENV_FILE: envPath, HAPPIER_STACK_STACK: stackName },
    json: true,
    noDocker: true,
    autoSweep: false,
    preserveDaemon: true,
  }, {
    killProcessGroupOwnedByStackImpl: async (pid, options) => {
      kills.push({ pid, fingerprint: options.processInstanceFingerprint });
      return { killed: true, reason: 'killed_tree' };
    },
  });
  assert.deepEqual(kills.map((kill) => kill.pid).filter((pid) => pid === server.pid), [server.pid]);
  assert.equal(kills.find((kill) => kill.pid === server.pid).fingerprint, expectedWindowsVerifiedInstances({
    wrapperPid: server.pid,
    serverPid: server.pid,
  }).serverWrapperPid.fingerprint);
});

test('status proves a proxied backend by its own recorded identity', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-info-recorded-backend-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const storageDir = join(tmp, 'storage');
  const stackName = 'recorded-backend-test';
  const baseDir = join(storageDir, stackName);
  await mkdir(baseDir, { recursive: true });
  await writeFile(join(baseDir, 'env'), 'HAPPIER_STACK_SERVER_PORT=4101\nHAPPIER_STACK_DAEMON=0\n', 'utf-8');
  await writeFile(join(baseDir, 'stack.runtime.json'), JSON.stringify({
    version: 1,
    stackName,
    ownerPid: process.pid,
    processes: { proxyPid: process.pid, serverPid: process.pid, serverBackendPid: process.pid },
    processInstances: { processes: { serverBackendPid: { pid: process.pid, ...RECORDED_IDENTITY } } },
    ports: { server: 4101, serverBackend: 4102 },
    serverProxy: { enabled: true, mode: 'proxy' },
  }) + '\n', 'utf-8');
  t.after(withPatchedProcessEnv(t, { HAPPIER_STACK_STORAGE_DIR: storageDir }));
  const ports = [];

  const out = await readStackInfoSnapshot({
    rootDir: process.cwd(),
    stackName,
    listListenPidsWithStatusImpl: hiddenListener,
    isTcpPortListeningImpl: async () => true,
    resolvePidStackOwnershipImpl: ownedProcess,
    fetchReadyIdentityImpl: async (request) => {
      ports.push(request.port);
      return await answersRecordedInstance();
    },
  });

  assert.deepEqual(ports, [4102]);
  assert.equal(out.runtime.components.serverBackend.ownershipStatus, 'owned');
  assert.equal(out.runtime.components.server.ownershipStatus, 'not_owned');
});

const FOREIGN_PID = 5555;
const OWNED_SIBLING_PID = 4242;
const listed = (...pids) => async () => ({ status: 'ok', supported: true, pids });
const ownedOnly = (...pids) => ownedWhen((pid) => pid === process.pid || pids.includes(pid));
const reusedProcess = async () => ({ status: 'not_owned', owned: false, reason: 'process_instance_mismatch' });
const unavailableProcess = async () => ({ status: 'inconclusive', owned: null, reason: 'process-identity-unavailable' });
const unresolvedRow = async (pid) => (pid === process.pid
  ? { status: 'owned', owned: true, reason: 'test' }
  : await unavailableProcess());

const listedListenerCases = [
  ['recorded and foreign rows', { listListenPidsWithStatusImpl: listed(process.pid, FOREIGN_PID), resolvePidStackOwnershipImpl: ownedOnly() }, 'not_owned'],
  ['owned and foreign rows', { listListenPidsWithStatusImpl: listed(OWNED_SIBLING_PID, FOREIGN_PID), resolvePidStackOwnershipImpl: ownedOnly(OWNED_SIBLING_PID) }, 'not_owned'],
  ['a listed recorded PID that was reused', { listListenPidsWithStatusImpl: listed(process.pid), resolvePidStackOwnershipImpl: reusedProcess }, 'not_owned'],
  ['a listed recorded PID with unavailable identity', { listListenPidsWithStatusImpl: listed(process.pid), resolvePidStackOwnershipImpl: unavailableProcess }, 'unknown'],
  ['a listed recorded PID whose identity read throws', {
    listListenPidsWithStatusImpl: listed(process.pid),
    resolvePidStackOwnershipImpl: async () => {
      throw new Error('cim failed');
    },
  }, 'unknown'],
  ['a listed recorded PID with an unverified identity', {
    identity: { fingerprint: null, unverified: true },
    listListenPidsWithStatusImpl: listed(process.pid),
    // Would say owned if asked, so judging this PID at all turns the result into a false positive.
    resolvePidStackOwnershipImpl: async () => ({ status: 'owned', owned: true, reason: 'test' }),
  }, 'unknown'],
  ['a recorded row and an unresolved row', { listListenPidsWithStatusImpl: listed(process.pid, FOREIGN_PID), resolvePidStackOwnershipImpl: unresolvedRow }, 'unknown'],
  ['an unresolved row beside a foreign row', {
    listListenPidsWithStatusImpl: listed(OWNED_SIBLING_PID, FOREIGN_PID),
    resolvePidStackOwnershipImpl: async (pid) => (pid === FOREIGN_PID ? { status: 'not_owned', owned: false, reason: 'not_owned' } : await unresolvedRow(pid)),
  }, 'not_owned'],
  ['only an unresolved row', { listListenPidsWithStatusImpl: listed(FOREIGN_PID), resolvePidStackOwnershipImpl: unresolvedRow }, 'unknown'],
  ['a group member of a reused recorded PID', {
    listListenPidsWithStatusImpl: listed(FOREIGN_PID),
    resolvePidStackOwnershipImpl: reusedProcess,
    getProcessGroupIdImpl: async () => process.pid,
  }, 'not_owned'],
  ['a group member of an unprovable recorded PID', {
    listListenPidsWithStatusImpl: listed(FOREIGN_PID),
    resolvePidStackOwnershipImpl: async (pid) => (pid === process.pid
      ? await unavailableProcess()
      : { status: 'not_owned', owned: false, reason: 'not_owned' }),
    getProcessGroupIdImpl: async () => process.pid,
  }, 'unknown'],
];

for (const [name, { identity, ...overrides }, ownershipStatus] of listedListenerCases) {
  test(`status judges the whole listener set: ${name}`, async (t) => {
    const { stackName } = await createRecordedServerStack(t, { identity: identity === undefined ? RECORDED_IDENTITY : identity });
    const out = await readStackInfoSnapshot({
      rootDir: process.cwd(),
      stackName,
      isTcpPortListeningImpl: async () => true,
      resolvePidStackOwnershipImpl: ownedProcess,
      fetchReadyIdentityImpl: async () => assert.fail('listed rows are judged without the hidden-listener proof'),
      ...overrides,
    });
    const server = out.runtime.components.server;
    assert.equal(server.ownershipStatus, ownershipStatus);
    assert.deepEqual(server.ownedListenerPids, []);
  });
}

test('a listed recorded PID is owned only through a bounded identity read of its recorded fingerprint', async (t) => {
  const { stackName } = await createRecordedServerStack(t);
  const reads = [];
  const out = await readStackInfoSnapshot({
    rootDir: process.cwd(),
    stackName,
    listListenPidsWithStatusImpl: listed(process.pid),
    isTcpPortListeningImpl: async () => true,
    resolvePidStackOwnershipImpl: async (pid, context, budget) => {
      reads.push({ pid, fingerprint: context.processInstanceFingerprint });
      return await ownedProcess(pid, context, budget);
    },
  });
  assert.deepEqual(reads, [{ pid: process.pid, fingerprint: RECORDED_IDENTITY.fingerprint }]);
  assert.equal(out.runtime.components.server.ownershipStatus, 'owned');
  assert.deepEqual(out.runtime.components.server.ownedListenerPids, [process.pid]);
});

test('a complete set of owned rows stays owned, and the recorded process is read once', async (t) => {
  const { stackName } = await createRecordedServerStack(t);
  let reads = 0;
  const out = await readStackInfoSnapshot({
    rootDir: process.cwd(),
    stackName,
    listListenPidsWithStatusImpl: listed(process.pid, OWNED_SIBLING_PID),
    isTcpPortListeningImpl: async () => true,
    getProcessGroupIdImpl: async () => process.pid,
    resolvePidStackOwnershipImpl: async (pid, context, budget) => {
      if (pid !== process.pid) return { status: 'not_owned', owned: false, reason: 'not_owned' };
      reads += 1;
      return await ownedProcess(pid, context, budget);
    },
  });
  assert.equal(out.runtime.components.server.ownershipStatus, 'owned');
  assert.deepEqual(out.runtime.components.server.ownedListenerPids, [process.pid, OWNED_SIBLING_PID]);
  assert.equal(reads, 1);
});

const COMMAND_BUDGET_MS = 150;
const stalled = () => new Promise(() => {});
const OWNED_RESULT = { status: 'owned', owned: true, reason: 'test' };
const NOT_OWNED_RESULT = { status: 'not_owned', owned: false, reason: 'not_owned' };

/** A stall must become an answer: a hang here is the defect, so it reports instead of blocking. */
async function readStatusWithinBudget(t, { identity, ...overrides }) {
  const { stackName } = await createRecordedServerStack(t, { identity: identity === undefined ? RECORDED_IDENTITY : identity });
  const startedAt = Date.now();
  const out = await Promise.race([
    readStackInfoSnapshot({
      rootDir: process.cwd(),
      stackName,
      listenerObservationTimeoutMs: COMMAND_BUDGET_MS,
      isTcpPortListeningImpl: async () => true,
      ...overrides,
    }),
    new Promise((resolve) => setTimeout(() => resolve('still-pending'), 1_500)),
  ]);
  assert.notEqual(out, 'still-pending', 'status outlived its command budget');
  assert.ok(Date.now() - startedAt < 1_500);
  return out.runtime.components.server;
}

const recordedOwnedRowStalls = async (pid) => (pid === process.pid ? OWNED_RESULT : await stalled());

test('a non-recorded row whose ownership read stalls cannot outlive the command budget', async (t) => {
  const server = await readStatusWithinBudget(t, {
    listListenPidsWithStatusImpl: listed(FOREIGN_PID),
    resolvePidStackOwnershipImpl: recordedOwnedRowStalls,
  });
  assert.equal(server.ownershipStatus, 'unknown');
  assert.deepEqual(server.ownedListenerPids, []);
});

test('a row stall beside a proven foreign row still reports the foreign row', async (t) => {
  const server = await readStatusWithinBudget(t, {
    listListenPidsWithStatusImpl: listed(OWNED_SIBLING_PID, FOREIGN_PID),
    resolvePidStackOwnershipImpl: async (pid) => {
      if (pid === process.pid) return OWNED_RESULT;
      return pid === FOREIGN_PID ? NOT_OWNED_RESULT : await stalled();
    },
    getProcessGroupIdImpl: async () => null,
  });
  assert.equal(server.ownershipStatus, 'not_owned');
  assert.deepEqual(server.ownedListenerPids, []);
});

test('row ownership runs through the bounded identity owner with no fingerprint to trust', async (t) => {
  const reads = [];
  const server = await readStatusWithinBudget(t, {
    listListenPidsWithStatusImpl: listed(FOREIGN_PID),
    resolvePidStackOwnershipImpl: async (pid, context, budget) => {
      reads.push({ pid, fingerprint: context.processInstanceFingerprint, timeoutMs: budget?.timeoutMs, signal: budget?.signal });
      return OWNED_RESULT;
    },
  });
  assert.equal(server.ownershipStatus, 'owned');
  assert.equal(reads.length, 1);
  assert.equal(reads[0].pid, FOREIGN_PID);
  assert.equal(reads[0].fingerprint, undefined);
  assert.ok(reads[0].timeoutMs > 0 && reads[0].timeoutMs <= COMMAND_BUDGET_MS);
  assert.equal(reads[0].signal instanceof AbortSignal, true);
});

test('a stalled identity read of the recorded PID cannot outlive the command budget', async (t) => {
  const server = await readStatusWithinBudget(t, {
    listListenPidsWithStatusImpl: listed(process.pid),
    resolvePidStackOwnershipImpl: stalled,
  });
  assert.equal(server.ownershipStatus, 'unknown');
});

test('a stalled process-group read cannot outlive the command budget', async (t) => {
  const server = await readStatusWithinBudget(t, {
    listListenPidsWithStatusImpl: listed(FOREIGN_PID),
    resolvePidStackOwnershipImpl: async (pid) => (pid === process.pid ? OWNED_RESULT : NOT_OWNED_RESULT),
    getProcessGroupIdImpl: stalled,
  });
  assert.equal(server.ownershipStatus, 'unknown');
});

test('a stalled hidden-listener proof cannot outlive the command budget', async (t) => {
  const stalledIdentity = await readStatusWithinBudget(t, {
    listListenPidsWithStatusImpl: hiddenListener,
    resolvePidStackOwnershipImpl: stalled,
    fetchReadyIdentityImpl: answersRecordedInstance,
  });
  assert.equal(stalledIdentity.ownershipStatus, 'unknown');
  const stalledReady = await readStatusWithinBudget(t, {
    listListenPidsWithStatusImpl: hiddenListener,
    resolvePidStackOwnershipImpl: ownedProcess,
    fetchReadyIdentityImpl: stalled,
  });
  assert.equal(stalledReady.ownershipStatus, 'unknown');
});
