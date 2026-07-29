import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';

import { withPatchedProcessEnv } from './testkit/core/env_scope.mjs';
import { spawnDetachedInlineNodeTestProcess } from './testkit/core/spawn_test_process.mjs';
import { readStackInfoSnapshot, resolveStackComponentRuntime } from './stack/stack_info_snapshot.mjs';
import { createRuntimeSnapshotFixture } from './testkit/runtime_snapshot_testkit.mjs';

test('status preserves live PID/TCP truth when listener ownership discovery is inconclusive', async () => {
  const result = await resolveStackComponentRuntime({
    port: 43123,
    recordedPid: 2222,
    runtimePidAlive: true,
    stackName: 'status-test',
    envPath: '/tmp/status-test/env',
    listListenPidsWithStatusImpl: async () => ({
      status: 'timeout', supported: true, pids: [], reason: 'listener-discovery-timeout',
    }),
    isTcpPortListeningImpl: async () => true,
  });

  assert.equal(result.running, true);
  assert.equal(result.ownershipStatus, 'unknown');
  assert.equal(result.listenerDiscoveryStatus, 'timeout');
});

async function withListeningServer() {
  const server = http.createServer((_req, res) => {
    res.statusCode = 204;
    res.end();
  });
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

async function withHappierHealthServer({ host = '127.0.0.1' } = {}) {
  const server = http.createServer((req, res) => {
    if (req.url === '/health' || req.url === '/ready') {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ status: 'ok', service: 'happier-server' }));
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, resolve);
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

test('readStackInfoSnapshot observes the recorded dev proxy with a candidate-bounded listener lookup', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-info-proxy-owner-'));
  const storageDir = join(tmp, 'storage');
  const stackName = 'dev-proxy-owner';
  const baseDir = join(storageDir, stackName);
  const envPath = join(baseDir, 'env');
  const listener = await withHappierHealthServer();

  await mkdir(baseDir, { recursive: true });
  await writeFile(
    envPath,
    `HAPPIER_STACK_SERVER_PORT=${listener.port}\nHAPPIER_STACK_DAEMON=0\n`,
    'utf-8',
  );
  const proxyProcess = spawnDetachedInlineNodeTestProcess('setInterval(() => {}, 1000)', {
    env: {
      ...process.env,
      HAPPIER_STACK_STACK: stackName,
      HAPPIER_STACK_ENV_FILE: envPath,
      HAPPIER_STACK_CLI_HOME_DIR: join(baseDir, 'cli'),
      HAPPIER_STACK_PROCESS_KIND: 'server-proxy',
    },
  });
  t.after(() => {
    try {
      process.kill(-proxyProcess.pid, 'SIGTERM');
    } catch {
      // ignore
    }
  });
  await waitForProcessAlive(proxyProcess.pid);
  await writeFile(
    join(baseDir, 'stack.runtime.json'),
    JSON.stringify({
      version: 1,
      stackName,
      ownerPid: proxyProcess.pid,
      processes: {
        proxyPid: proxyProcess.pid,
        serverPid: 999_999_999,
      },
      ports: { server: listener.port },
      serverProxy: { enabled: true, mode: 'proxy' },
      serverLifecycle: {
        phase: 'maintenance',
        planned: { mode: 'exclusiveDb', generation: 5, reason: 'prisma_changed' },
        lastCompleted: { mode: 'exclusiveDb', generation: 4 },
        retry: null,
        disposition: null,
      },
    }) + '\n',
    'utf-8',
  );

  const observations = [];
  const restore = withPatchedProcessEnv(t, { HAPPIER_STACK_STORAGE_DIR: storageDir });
  try {
    const out = await readStackInfoSnapshot({
      rootDir: process.cwd(),
      stackName,
      listListenPidsWithStatusImpl: async (_port, options) => {
        observations.push(options?.candidatePids ?? null);
        return options?.candidatePids?.includes(proxyProcess.pid)
          ? { status: 'ok', supported: true, pids: [proxyProcess.pid] }
          : {
              status: 'timeout',
              supported: true,
              pids: [],
              reason: 'listener-discovery-timeout',
            };
      },
    });

    assert.equal(out.runtime.components.server.pid, proxyProcess.pid);
    assert.equal(out.runtime.components.server.pidAlive, true);
    assert.equal(out.runtime.components.server.running, true);
    assert.equal(out.runtime.components.server.ownershipStatus, 'owned');
    assert.equal(out.runtime.serverLifecycle?.phase, 'maintenance');
    assert.equal(out.runtime.health.status, 'healthy');
    assert.deepEqual(out.runtime.health.issues, []);
    assert.deepEqual(observations, [[proxyProcess.pid]]);
  } finally {
    restore();
    await listener.close();
    await rm(tmp, { recursive: true, force: true });
  }
});

test('readStackInfoSnapshot degrades health when only the maintenance proxy remains after a terminal server failure', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-info-proxy-unavailable-'));
  const storageDir = join(tmp, 'storage');
  const stackName = 'dev-proxy-unavailable';
  const baseDir = join(storageDir, stackName);
  const envPath = join(baseDir, 'env');
  const listener = await withListeningServer();

  await mkdir(baseDir, { recursive: true });
  await writeFile(
    envPath,
    `HAPPIER_STACK_SERVER_PORT=${listener.port}\nHAPPIER_STACK_DAEMON=0\n`,
    'utf-8',
  );
  const proxyProcess = spawnDetachedInlineNodeTestProcess('setInterval(() => {}, 1000)', {
    env: {
      ...process.env,
      HAPPIER_STACK_STACK: stackName,
      HAPPIER_STACK_ENV_FILE: envPath,
      HAPPIER_STACK_CLI_HOME_DIR: join(baseDir, 'cli'),
      HAPPIER_STACK_PROCESS_KIND: 'server-proxy',
    },
  });
  t.after(() => {
    try {
      process.kill(-proxyProcess.pid, 'SIGTERM');
    } catch {
      // ignore
    }
  });
  await waitForProcessAlive(proxyProcess.pid);
  await writeFile(
    join(baseDir, 'stack.runtime.json'),
    JSON.stringify({
      version: 1,
      stackName,
      ownerPid: proxyProcess.pid,
      processes: {
        proxyPid: proxyProcess.pid,
        serverPid: null,
        serverWrapperPid: null,
        serverBackendPid: null,
        serverDrainingPid: null,
      },
      ports: { server: listener.port, serverBackend: null },
      serverProxy: { enabled: true, mode: 'proxy' },
      serverLifecycle: {
        phase: 'unavailable',
        planned: { mode: 'exclusiveDb', generation: 5, reason: 'prisma_changed' },
        lastCompleted: { mode: 'exclusiveDb', generation: 4 },
        retry: null,
        disposition: { code: 'restart_failed' },
      },
    }) + '\n',
    'utf-8',
  );

  const restore = withPatchedProcessEnv(t, { HAPPIER_STACK_STORAGE_DIR: storageDir });
  try {
    const out = await readStackInfoSnapshot({
      rootDir: process.cwd(),
      stackName,
      listListenPidsWithStatusImpl: async (_port, options) => (
        options?.candidatePids?.includes(proxyProcess.pid)
          ? { status: 'ok', supported: true, pids: [proxyProcess.pid] }
          : { status: 'ok', supported: true, pids: [] }
      ),
    });

    assert.equal(out.runtime.running, true);
    assert.equal(out.runtime.components.server.running, true);
    assert.equal(out.runtime.components.server.pid, proxyProcess.pid);
    assert.equal(out.runtime.serverLifecycle?.phase, 'unavailable');
    assert.equal(out.runtime.serverLifecycle?.disposition?.code, 'restart_failed');
    assert.equal(out.runtime.health.status, 'degraded');
    assert.deepEqual(out.runtime.health.issues, ['server_down']);
  } finally {
    restore();
    await listener.close();
    await rm(tmp, { recursive: true, force: true });
  }
});

test('readStackInfoSnapshot does not report running from an untrusted live infra pid', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-info-running-process-'));
  const storageDir = join(tmp, 'storage');
  const stackName = 'dev-auth';
  const baseDir = join(storageDir, stackName);
  const serverPort = await reserveUnusedPort();

  await mkdir(baseDir, { recursive: true });
  await writeFile(join(baseDir, 'env'), `HAPPIER_STACK_SERVER_PORT=${serverPort}\n`, 'utf-8');
  await writeFile(
    join(baseDir, 'stack.runtime.json'),
    JSON.stringify({
      version: 1,
      stackName,
      ownerPid: 999_999_999,
      processes: { serverPid: process.pid },
      ports: { server: serverPort },
    }) + '\n',
    'utf-8'
  );

  const restore = withPatchedProcessEnv(t, { HAPPIER_STACK_STORAGE_DIR: storageDir });
  try {
    const out = await readStackInfoSnapshot({ rootDir: process.cwd(), stackName });
    assert.equal(out.runtime.running, false);
    assert.equal(out.runtime.runningPid, null);
    assert.equal(out.runtime.components.server.pidAlive, false);
    assert.equal(out.runtime.components.server.running, false);
    assert.deepEqual(out.runtime.health.issues, ['server_down']);
  } finally {
    restore();
    await rm(tmp, { recursive: true, force: true });
  }
});

test('readStackInfoSnapshot does not report running when only an unrelated server port is occupied', async (t) => {
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
    const out = await readStackInfoSnapshot({ rootDir: process.cwd(), stackName });
    assert.equal(out.runtime.running, false);
    assert.equal(out.runtime.runningPid, null);
    assert.equal(out.runtime.components.server.running, false);
    assert.equal(out.runtime.components.server.portListening, true);
    assert.deepEqual(out.runtime.health.issues, ['server_down']);
  } finally {
    restore();
    await listener.close();
    await rm(tmp, { recursive: true, force: true });
  }
});

test('readStackInfoSnapshot treats a healthy wildcard-bound server endpoint as running', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-info-running-health-'));
  const storageDir = join(tmp, 'storage');
  const stackName = 'dev-auth';
  const baseDir = join(storageDir, stackName);

  await mkdir(baseDir, { recursive: true });

  const listener = await withHappierHealthServer({ host: '0.0.0.0' });
  await writeFile(
    join(baseDir, 'env'),
    `HAPPIER_STACK_SERVER_PORT=${listener.port}\nHAPPIER_STACK_DAEMON=0\n`,
    'utf-8',
  );
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
    const out = await readStackInfoSnapshot({ rootDir: process.cwd(), stackName });
    assert.equal(out.runtime.running, true);
    assert.equal(out.runtime.components.server.running, true);
    assert.equal(out.runtime.components.server.portListening, true);
    assert.equal(out.runtime.health.status, 'healthy');
    assert.deepEqual(out.runtime.health.issues, []);
  } finally {
    restore();
    await listener.close();
    await rm(tmp, { recursive: true, force: true });
  }
});

test('readStackInfoSnapshot exposes the server-served web UI when a runtime snapshot is active and Expo is absent', async (t) => {
  const fixture = await createRuntimeSnapshotFixture(t, { stackName: 'runtime-ui' });
  const listener = await withHappierHealthServer();
  await writeFile(
    join(fixture.stackDir, 'env'),
    `HAPPIER_STACK_SERVER_COMPONENT=happier-server-light\nHAPPIER_STACK_SERVER_PORT=${listener.port}\n`,
    'utf-8',
  );
  await writeFile(
    join(fixture.stackDir, 'stack.runtime.json'),
    JSON.stringify({
      version: 1,
      stackName: fixture.stackName,
      ownerPid: 999_999_999,
      runtimeSnapshotId: 'snap-1',
      processes: { serverPid: 999_999_998 },
      ports: { server: listener.port },
    }) + '\n',
    'utf-8',
  );

  const restore = withPatchedProcessEnv(t, { HAPPIER_STACK_STORAGE_DIR: fixture.storageDir });
  try {
    const out = await readStackInfoSnapshot({ rootDir: process.cwd(), stackName: fixture.stackName });
    assert.equal(out.runtime.components.server.running, true);
    assert.equal(out.runtime.components.ui.running, true);
    assert.equal(out.ports.ui, listener.port);
    assert.ok(out.urls.uiUrl && out.urls.uiUrl.includes(`:${listener.port}`), `expected uiUrl to include server port\nuiUrl=${out.urls.uiUrl}`);
  } finally {
    restore();
    await listener.close();
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
    const fixture = await createRuntimeSnapshotFixture(t, { stackName: `runtime-ui-${scenario.name}` });
    const listener = await withHappierHealthServer();
    const staleUiPort = await reserveUnusedPort();
    await writeFile(
      join(fixture.stackDir, 'env'),
      [
        'HAPPIER_STACK_SERVER_COMPONENT=happier-server-light',
        `HAPPIER_STACK_SERVER_PORT=${listener.port}`,
        'HAPPIER_STACK_DAEMON=0',
        scenario.envLine,
        '',
      ].filter((line) => line !== '').join('\n') + '\n',
      'utf-8',
    );
    await writeFile(
      join(fixture.stackDir, 'stack.runtime.json'),
      JSON.stringify({
        version: 1,
        stackName: fixture.stackName,
        ownerPid: 999_999_999,
        runtimeSnapshotId: 'snap-1',
        ...(typeof scenario.runtimeServeUi === 'boolean' ? { serveUi: scenario.runtimeServeUi } : {}),
        processes: { serverPid: 999_999_998, expoPid: process.pid },
        ports: { server: listener.port },
        expo: { webPort: staleUiPort, webEnabled: true },
      }) + '\n',
      'utf-8',
    );

    const restore = withPatchedProcessEnv(t, { HAPPIER_STACK_STORAGE_DIR: fixture.storageDir });
    try {
      const out = await readStackInfoSnapshot({ rootDir: process.cwd(), stackName: fixture.stackName });
      assert.equal(out.runtime.components.ui.running, false);
      assert.equal(out.runtime.components.ui.pid, null);
      assert.equal(out.ports.ui, null);
      assert.equal(out.urls.uiUrl, null);
      assert.equal(out.runtime.health.issues.includes('ui_down'), false);
    } finally {
      restore();
      await listener.close();
    }
  });
}

test('readStackInfoSnapshot marks UI as down when expo runtime metadata is stale', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-info-ui-stale-'));
  const storageDir = join(tmp, 'storage');
  const stackName = 'dev-auth';
  const baseDir = join(storageDir, stackName);

  await mkdir(baseDir, { recursive: true });

  const serverListener = await withHappierHealthServer();
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
    const out = await readStackInfoSnapshot({ rootDir: process.cwd(), stackName });
    assert.equal(out.runtime.running, true);
    assert.equal(out.runtime.components.server.running, true);
    assert.equal(out.runtime.components.ui.running, false);
    assert.equal(out.runtime.health.status, 'degraded');
    assert.deepEqual(out.runtime.health.issues, ['ui_down', 'daemon_down']);
    assert.equal(out.ports.ui, null);
    assert.equal(out.urls.uiUrl, null);
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

  const serverListener = await withHappierHealthServer();
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
    const out = await readStackInfoSnapshot({ rootDir: process.cwd(), stackName });
    assert.equal(out.runtime.running, true);
    assert.equal(out.runtime.components.ui.pidAlive, false);
    assert.equal(out.runtime.components.ui.running, false);
    assert.equal(out.runtime.health.status, 'degraded');
    assert.deepEqual(out.runtime.health.issues, ['ui_down', 'daemon_down']);
    assert.equal(out.ports.ui, null);
    assert.equal(out.urls.uiUrl, null);
  } finally {
    restore();
    await serverListener.close();
    await rm(tmp, { recursive: true, force: true });
  }
});

test('readStackInfoSnapshot rejects stale Expo UI metadata when an unrelated process occupies the UI port', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-info-ui-port-collision-'));
  const storageDir = join(tmp, 'storage');
  const stackName = 'dev-auth';
  const baseDir = join(storageDir, stackName);

  await mkdir(baseDir, { recursive: true });

  const serverListener = await withHappierHealthServer();
  const unrelatedUiListener = await withListeningServer();
  await writeFile(join(baseDir, 'env'), `HAPPIER_STACK_SERVER_PORT=${serverListener.port}\n`, 'utf-8');
  await writeFile(
    join(baseDir, 'stack.runtime.json'),
    JSON.stringify({
      version: 1,
      stackName,
      ownerPid: 999_999_999,
      processes: { serverPid: process.pid, expoPid: 999_999_998 },
      ports: { server: serverListener.port },
      expo: { webPort: unrelatedUiListener.port, webEnabled: true },
    }) + '\n',
    'utf-8'
  );

  const restore = withPatchedProcessEnv(t, { HAPPIER_STACK_STORAGE_DIR: storageDir });
  try {
    const out = await readStackInfoSnapshot({ rootDir: process.cwd(), stackName });
    assert.equal(out.runtime.running, true);
    assert.equal(out.runtime.components.server.running, true);
    assert.equal(out.runtime.components.ui.running, false);
    assert.equal(out.runtime.health.status, 'degraded');
    assert.deepEqual(out.runtime.health.issues, ['ui_down', 'daemon_down']);
    assert.equal(out.ports.ui, null);
    assert.equal(out.urls.uiUrl, null);
  } finally {
    restore();
    await unrelatedUiListener.close();
    await serverListener.close();
    await rm(tmp, { recursive: true, force: true });
  }
});

test('readStackInfoSnapshot refreshes stale runtime daemonPid from daemon.state.json', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-info-daemon-sync-'));
  const storageDir = join(tmp, 'storage');
  const stackName = 'dev-auth';
  const baseDir = join(storageDir, stackName);
  const cliServerDir = join(baseDir, 'cli', 'servers', 'stack_dev-auth__id_default');
  const envPath = join(baseDir, 'env');
  const daemonControlServer = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/ping' && req.headers['x-happier-daemon-token'] === 'state-token') {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.statusCode = 401;
    res.end();
  });
  await new Promise((resolve) => daemonControlServer.listen(0, '127.0.0.1', resolve));

  await mkdir(cliServerDir, { recursive: true });
  await writeFile(envPath, 'HAPPIER_STACK_SERVER_PORT=3009\n', 'utf-8');
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
      processes: { daemonPid: 111 },
      ports: { server: 3009 },
      serverLifecycle: {
        phase: 'retry-scheduled',
        planned: { mode: 'exclusiveDb', generation: 8, reason: 'prisma_changed' },
        lastCompleted: { mode: 'exclusiveDb', generation: 7 },
        retry: { afterMs: 250 },
        disposition: null,
      },
    }) + '\n',
    'utf-8'
  );
  await writeFile(
    join(cliServerDir, 'daemon.state.json'),
    JSON.stringify({
      pid: daemonProcess.pid,
      httpPort: daemonControlServer.address().port,
      controlToken: 'state-token',
      startedAt: Date.now(),
      startedWithCliVersion: 'test',
    }) + '\n',
    'utf-8',
  );

  const restore = withPatchedProcessEnv(t, {
    HAPPIER_STACK_STORAGE_DIR: storageDir,
    HAPPIER_ACTIVE_SERVER_ID: 'stack_other__id_default',
    HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID: 'stack_other__id_default',
    HAPPIER_STACK_STACK: 'other',
  });
  try {
    const out = await readStackInfoSnapshot({ rootDir: process.cwd(), stackName });
    assert.equal(out.runtime.processes?.daemonPid, daemonProcess.pid);
    assert.equal(out.runtime.components.daemon.running, true);
    assert.equal(out.runtime.components.daemon.source, 'daemon_state');
    assert.equal(out.runtime.health.issues.includes('daemon_down'), false);
    assert.deepEqual(out.runtime.serverLifecycle, {
      phase: 'retry-scheduled',
      planned: { mode: 'exclusiveDb', generation: 8, reason: 'prisma_changed' },
      lastCompleted: { mode: 'exclusiveDb', generation: 7 },
      retry: { afterMs: 250 },
      disposition: null,
    });
  } finally {
    restore();
    await new Promise((resolve) => daemonControlServer.close(resolve));
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
    const out = await readStackInfoSnapshot({ rootDir: process.cwd(), stackName });
    assert.equal(out.runtime.running, true);
    assert.equal(out.runtime.runningPid, daemonProcess.pid);
    assert.equal(out.runtime.components.daemon.running, false);
    assert.equal(out.runtime.components.daemon.pid, daemonProcess.pid);
    assert.equal(out.runtime.components.daemon.pidAlive, true);
    assert.equal(out.runtime.components.daemon.source, 'runtime_pid');
    assert.deepEqual(out.runtime.processes?.daemonPids, [daemonProcess.pid]);
    assert.equal(out.runtime.health.status, 'degraded');
    assert.deepEqual(out.runtime.health.issues, ['daemon_down']);
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

  const serverListener = await withHappierHealthServer();
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
    const out = await readStackInfoSnapshot({ rootDir: process.cwd(), stackName });
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
