import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';

import { resolveLocalServerPortForStack } from './resolve_stack_server_port.mjs';
import { createListenerOwnershipCommandScope } from './listener_ownership.mjs';
import { resolvePidStackOwnership } from '../proc/ownership.mjs';

test('pinned stack port retries typed bind availability without requiring listener discovery', async () => {
  let waitOptions = null;
  const port = await reserveUnusedPort();
  const selected = await resolveLocalServerPortForStack({
    env: { HAPPIER_STACK_SERVER_PORT: String(port) },
    stackMode: true,
    stackName: 'repo-test-abc',
    runtimeStatePath: null,
    listenerObservationScope: {
      checkPortFree: async () => ({
        status: 'inconclusive',
        observation: { status: 'timeout', reason: 'listener-discovery-timeout' },
      }),
    },
    waitForTcpPortFreeImpl: async (_port, options) => {
      waitOptions = options;
      return { status: 'free' };
    },
  });

  assert.equal(selected, port);
  assert.equal(waitOptions?.host, '127.0.0.1');
  assert.ok(waitOptions?.timeoutMs >= 1_000);
});

test('pinned stack port reports unresolved availability without claiming another process owns it', async () => {
  const port = await reserveUnusedPort();
  await assert.rejects(
    () => resolveLocalServerPortForStack({
      env: { HAPPIER_STACK_SERVER_PORT: String(port) },
      stackMode: true,
      stackName: 'repo-test-abc',
      runtimeStatePath: null,
      listenerObservationScope: {
        checkPortFree: async () => ({ status: 'inconclusive' }),
      },
      waitForTcpPortFreeImpl: async () => ({
        status: 'inconclusive',
        reason: 'port-availability-deadline-exceeded',
      }),
    }),
    (error) => error?.code === 'EPORTSELECTIONINCONCLUSIVE'
      && /could not determine whether/.test(error.message)
      && !/in use by another process/.test(error.message),
  );
});

function createProcessIdentityFixtureScope(linesByPid = new Map(), pidsByPort) {
  return createListenerOwnershipCommandScope({
    ...(pidsByPort
      ? {
          listListenPidsWithStatusImpl: async (port) => ({
            status: 'ok',
            supported: true,
            pids: pidsByPort.get(Number(port)) ?? [],
          }),
        }
      : {}),
    resolvePidStackOwnershipImpl: async (pid, context, options) => resolvePidStackOwnership(
      pid,
      context,
      {
        ...options,
        observePsEnvLineImpl: async () => ({
          status: 'ok',
          line: linesByPid.get(Number(pid)) ?? `${pid} node HAPPIER_STACK_STACK=other-stack`,
          reason: 'fixture-ps-boundary',
        }),
      },
    ),
  });
}

function stackOwnedProcessLine(pid, { stackName, envPath }) {
  return `${pid} node HAPPIER_STACK_STACK=${stackName} HAPPIER_STACK_ENV_FILE=${envPath} HAPPIER_STACK_PROCESS_KIND=server`;
}

async function reserveUnusedPort() {
  const server = createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function listenHealthServer() {
  const server = createServer((req, res) => {
    if (req.url === '/health') {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ service: 'happier-server', status: 'ok' }));
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : null;
  if (!port) throw new Error('failed to bind health server');
  return { server, port };
}

async function listenNonHealthServer() {
  const server = createServer((req, res) => {
    if (req.url === '/health') {
      res.statusCode = 404;
      res.end('not happier');
      return;
    }
    res.statusCode = 200;
    res.end('ok');
  });
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : null;
  if (!port) throw new Error('failed to bind non-health server');
  return { server, port };
}

async function listenMaintenanceHealthServer() {
  const server = createServer((req, res) => {
    if (req.url === '/health') {
      res.statusCode = 503;
      res.setHeader('content-type', 'text/plain; charset=utf-8');
      res.setHeader('x-happier-retry-reason', 'server_restarting');
      res.end('Server reload in progress\n');
      return;
    }
    res.statusCode = 503;
    res.end('maintenance\n');
  });
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : null;
  if (!port) throw new Error('failed to bind maintenance server');
  return { server, port };
}

async function listenUnrelatedHealthServer() {
  const server = createServer((req, res) => {
    if (req.url === '/health') {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ status: 'ok', service: 'other-service' }));
      return;
    }
    res.statusCode = 200;
    res.end('ok');
  });
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : null;
  if (!port) throw new Error('failed to bind unrelated health server');
  return { server, port };
}

async function spawnStackOwnedIdleProcess({ stackName, envPath }) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 10000)'], {
    env: {
      ...process.env,
      HAPPIER_STACK_STACK: stackName,
      HAPPIER_STACK_ENV_FILE: envPath,
      HAPPIER_STACK_PROCESS_KIND: 'server',
    },
    stdio: 'ignore',
  });
  if (!child.pid) throw new Error('failed to spawn stack-owned idle process');
  await delay(50);
  return child;
}

async function spawnStackOwnedMaintenanceServer({ stackName, envPath }) {
  const child = spawn(process.execPath, ['-e', `
    const { createServer } = require('node:http');
    const server = createServer((req, res) => {
      if (req.url === '/health') {
        res.statusCode = 503;
        res.setHeader('content-type', 'text/plain; charset=utf-8');
        res.setHeader('x-happier-retry-reason', 'server_restarting');
        res.end('Server reload in progress\\n');
        return;
      }
      res.statusCode = 503;
      res.end('maintenance\\n');
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      process.stdout.write(String(addr.port) + '\\n');
    });
    setInterval(() => {}, 10000);
  `], {
    env: {
      ...process.env,
      HAPPIER_STACK_STACK: stackName,
      HAPPIER_STACK_ENV_FILE: envPath,
      HAPPIER_STACK_PROCESS_KIND: 'server',
    },
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (!child.pid || !child.stdout) throw new Error('failed to spawn stack-owned maintenance server');
  const port = await new Promise((resolvePromise, reject) => {
    let buffer = '';
    const timeout = setTimeout(() => reject(new Error('timed out waiting for maintenance server port')), 2000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      const line = buffer.split(/\r?\n/).find(Boolean);
      const parsed = Number(line);
      if (Number.isInteger(parsed) && parsed > 0) {
        clearTimeout(timeout);
        resolvePromise(parsed);
      }
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      reject(new Error(`maintenance server exited before reporting port (code=${code}, signal=${signal})`));
    });
  });
  await delay(50);
  return { child, port };
}

async function spawnStackOwnedHealthServer({ stackName, envPath }) {
  const child = spawn(process.execPath, ['-e', `
    const { createServer } = require('node:http');
    const server = createServer((req, res) => {
      if (req.url === '/health') {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ service: 'happier-server', status: 'ok' }));
        return;
      }
      res.statusCode = 404;
      res.end('not found');
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      process.stdout.write(String(addr.port) + '\\n');
    });
    setInterval(() => {}, 10000);
  `], {
    env: {
      ...process.env,
      HAPPIER_STACK_STACK: stackName,
      HAPPIER_STACK_ENV_FILE: envPath,
      HAPPIER_STACK_PROCESS_KIND: 'server',
    },
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (!child.pid || !child.stdout) throw new Error('failed to spawn stack-owned health server');
  const port = await new Promise((resolvePromise, reject) => {
    let buffer = '';
    const timeout = setTimeout(() => reject(new Error('timed out waiting for health server port')), 2000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      const line = buffer.split(/\r?\n/).find(Boolean);
      const parsed = Number(line);
      if (Number.isInteger(parsed) && parsed > 0) {
        clearTimeout(timeout);
        resolvePromise(parsed);
      }
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      reject(new Error(`health server exited before reporting port (code=${code}, signal=${signal})`));
    });
  });
  await delay(50);
  return { child, port };
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolvePromise) => {
    child.once('exit', resolvePromise);
    child.kill('SIGTERM');
  });
}

test('non-main stack reuses runtime port when a stack-owned server is already running there', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-port-'));
  const runtimeStatePath = join(tmp, 'stack.runtime.json');
  const stackName = 'repo-test-abc';
  const envPath = join(tmp, 'env');
  const { child, port } = await spawnStackOwnedHealthServer({ stackName, envPath });
  try {
    const listenerObservationScope = createProcessIdentityFixtureScope(new Map([
      [child.pid, stackOwnedProcessLine(child.pid, { stackName, envPath })],
    ]), new Map([[port, [child.pid]]]));
    await writeFile(runtimeStatePath, JSON.stringify({ stackName, ports: { server: port } }), 'utf-8');
    const out = await resolveLocalServerPortForStack({
      env: { HAPPIER_STACK_ENV_FILE: envPath },
      stackMode: true,
      stackName,
      runtimeStatePath,
      defaultPort: 3005,
      listenerObservationScope,
    });
    assert.equal(out, port);
  } finally {
    await stopChild(child);
  }
});

test('non-main stack does not reuse a healthy runtime port without stack-owned listener proof', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-port-unowned-health-'));
  const runtimeStatePath = join(tmp, 'stack.runtime.json');
  const { server, port } = await listenHealthServer();
  try {
    const listenerObservationScope = createProcessIdentityFixtureScope(
      new Map(),
      new Map([[port, [process.pid]]]),
    );
    await writeFile(runtimeStatePath, JSON.stringify({ stackName: 'repo-test-abc', ports: { server: port } }), 'utf-8');
    const out = await resolveLocalServerPortForStack({
      env: {
        HAPPIER_STACK_SERVER_PORT_BASE: String(port),
        HAPPIER_STACK_SERVER_PORT_RANGE: '10',
      },
      stackMode: true,
      stackName: 'repo-test-abc',
      runtimeStatePath,
      defaultPort: 3005,
      listenerObservationScope,
      waitForTcpPortFreeImpl: async () => ({ status: 'occupied', reason: 'address-in-use' }),
    });

    assert.notEqual(out, port);
  } finally {
    await new Promise((resolvePromise) => server.close(resolvePromise));
  }
});

test('non-main stack fails closed when a real listener has inconclusive process identity', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-port-inconclusive-identity-'));
  const runtimeStatePath = join(tmp, 'stack.runtime.json');
  const { server, port } = await listenHealthServer();
  let bindProbes = 0;
  try {
    await writeFile(runtimeStatePath, JSON.stringify({
      stackName: 'repo-test-abc',
      ports: { server: port },
    }), 'utf-8');
    const listenerObservationScope = createListenerOwnershipCommandScope({
      totalTimeoutMs: 500,
      listListenPidsWithStatusImpl: async () => ({
        status: 'ok',
        supported: true,
        pids: [process.pid],
      }),
      resolvePidStackOwnershipImpl: async () => ({
        status: 'inconclusive',
        owned: null,
        reason: 'process-identity-unavailable',
      }),
      probeTcpPortBindingImpl: async () => {
        bindProbes += 1;
        return { status: 'free' };
      },
    });

    await assert.rejects(
      () => resolveLocalServerPortForStack({
        env: {
          HAPPIER_STACK_SERVER_PORT_BASE: String(port),
          HAPPIER_STACK_SERVER_PORT_RANGE: '10',
        },
        stackMode: true,
        stackName: 'repo-test-abc',
        runtimeStatePath,
        defaultPort: 3005,
        listenerObservationScope,
      }),
      (error) => error?.code === 'ELISTENERDISCOVERYINCONCLUSIVE'
        && error?.observation?.reason === 'process-identity-unavailable',
    );
    assert.equal(bindProbes, 0, 'inconclusive identity must not launch alternate-port selection');
  } finally {
    await new Promise((resolvePromise) => server.close(resolvePromise));
    await rm(tmp, { recursive: true, force: true });
  }
});

test('non-main stack rejects a pinned healthy server port without stack-owned listener proof', async () => {
  const { server, port } = await listenHealthServer();
  try {
    const listenerObservationScope = createProcessIdentityFixtureScope(
      new Map(),
      new Map([[port, [process.pid]]]),
    );
    await assert.rejects(
      () =>
        resolveLocalServerPortForStack({
          env: { HAPPIER_STACK_SERVER_PORT: String(port) },
          stackMode: true,
          stackName: 'repo-test-abc',
          runtimeStatePath: null,
          defaultPort: 3005,
          listenerObservationScope,
        }),
      /HAPPIER_STACK_SERVER_PORT/
    );
  } finally {
    await new Promise((resolvePromise) => server.close(resolvePromise));
  }
});

test('non-main stack accepts pinned stable port during dev proxy maintenance when runtime owns the proxy', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-port-maintenance-'));
  const runtimeStatePath = join(tmp, 'stack.runtime.json');
  const stackName = 'repo-test-abc';
  const envPath = join(tmp, 'env');
  const { child: proxyProcess, port } = await spawnStackOwnedMaintenanceServer({ stackName, envPath });
  try {
    const listenerObservationScope = createProcessIdentityFixtureScope(new Map([
      [proxyProcess.pid, stackOwnedProcessLine(proxyProcess.pid, { stackName, envPath })],
    ]), new Map([[port, [proxyProcess.pid]]]));
    await writeFile(
      runtimeStatePath,
      JSON.stringify({
        version: 1,
        stackName,
        ports: { server: port },
        processes: { proxyPid: proxyProcess.pid },
        serverProxy: { enabled: true, mode: 'proxy', restartMode: 'exclusiveDb' },
      }),
      'utf-8'
    );

    const out = await resolveLocalServerPortForStack({
      env: { HAPPIER_STACK_SERVER_PORT: String(port), HAPPIER_STACK_ENV_FILE: envPath },
      stackMode: true,
      stackName,
      runtimeStatePath,
      defaultPort: 3005,
      listenerObservationScope,
    });

    assert.equal(out, port);
  } finally {
    await stopChild(proxyProcess);
  }
});

test('pinned startup adopts the exact runtime proxy without a broad listener scan under load', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-port-targeted-proxy-'));
  const runtimeStatePath = join(tmp, 'stack.runtime.json');
  const stackName = 'repo-test-targeted-proxy';
  const envPath = join(tmp, 'env');
  const proxyProcess = await spawnStackOwnedIdleProcess({ stackName, envPath });
  const observations = [];
  try {
    await writeFile(runtimeStatePath, JSON.stringify({
      version: 1,
      stackName,
      ports: { server: 52753 },
      processes: { proxyPid: proxyProcess.pid },
      serverProxy: { enabled: true, mode: 'proxy' },
    }), 'utf-8');
    const listenerObservationScope = createListenerOwnershipCommandScope({
      listListenPidsWithStatusImpl: async (_port, options) => {
        observations.push(options?.candidatePids ?? null);
        if (options?.candidatePids?.includes(proxyProcess.pid)) {
          return { status: 'ok', supported: true, pids: [proxyProcess.pid] };
        }
        return {
          status: 'timeout',
          supported: true,
          pids: [],
          reason: 'listener-discovery-timeout',
        };
      },
      resolvePidStackOwnershipImpl: async (pid, context, options) => resolvePidStackOwnership(
        pid,
        context,
        {
          ...options,
          observePsEnvLineImpl: async () => ({
            status: 'ok',
            line: stackOwnedProcessLine(pid, { stackName, envPath }),
            reason: 'fixture-ps-boundary',
          }),
        },
      ),
    });

    const out = await resolveLocalServerPortForStack({
      env: { HAPPIER_STACK_SERVER_PORT: '52753', HAPPIER_STACK_ENV_FILE: envPath },
      stackMode: true,
      stackName,
      runtimeStatePath,
      listenerObservationScope,
      waitForTcpPortFreeImpl: async () => ({ status: 'occupied' }),
    });

    assert.equal(out, 52753);
    assert.deepEqual(observations, [[proxyProcess.pid]]);
  } finally {
    await stopChild(proxyProcess);
    await rm(tmp, { recursive: true, force: true });
  }
});

test('non-main stack reuses runtime stable port during dev proxy maintenance when runtime owns the proxy', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-port-runtime-maintenance-'));
  const runtimeStatePath = join(tmp, 'stack.runtime.json');
  const stackName = 'repo-test-abc';
  const envPath = join(tmp, 'env');
  const { child: proxyProcess, port } = await spawnStackOwnedMaintenanceServer({ stackName, envPath });
  try {
    const listenerObservationScope = createProcessIdentityFixtureScope(new Map([
      [proxyProcess.pid, stackOwnedProcessLine(proxyProcess.pid, { stackName, envPath })],
    ]), new Map([[port, [proxyProcess.pid]]]));
    await writeFile(
      runtimeStatePath,
      JSON.stringify({
        version: 1,
        stackName,
        ports: { server: port },
        processes: { proxyPid: proxyProcess.pid },
        serverProxy: { enabled: true, mode: 'proxy', restartMode: 'exclusiveDb' },
      }),
      'utf-8'
    );

    const out = await resolveLocalServerPortForStack({
      env: { HAPPIER_STACK_ENV_FILE: envPath },
      stackMode: true,
      stackName,
      runtimeStatePath,
      defaultPort: 3005,
      listenerObservationScope,
    });

    assert.equal(out, port);
  } finally {
    await stopChild(proxyProcess);
  }
});

for (const [projectionName, serverProxy] of [
  ['missing', undefined],
  ['stale', { enabled: false, mode: 'direct' }],
]) {
  test(`strict resolver accepts an exact proxy pid during maintenance when proxy metadata is ${projectionName}`, async () => {
    const tmp = await mkdtemp(join(tmpdir(), `hstack-port-${projectionName}-proxy-maintenance-`));
    const runtimeStatePath = join(tmp, 'stack.runtime.json');
    const stackName = 'repo-test-abc';
    const envPath = join(tmp, 'env');
    const { child: proxyProcess, port } = await spawnStackOwnedMaintenanceServer({ stackName, envPath });
    try {
      const listenerObservationScope = createProcessIdentityFixtureScope(new Map([
        [proxyProcess.pid, stackOwnedProcessLine(proxyProcess.pid, { stackName, envPath })],
      ]), new Map([[port, [proxyProcess.pid]]]));
      await writeFile(runtimeStatePath, JSON.stringify({
        version: 1,
        stackName,
        ports: { server: port },
        processes: { proxyPid: proxyProcess.pid },
        ...(serverProxy ? { serverProxy } : {}),
      }), 'utf-8');

      const out = await resolveLocalServerPortForStack({
        env: { HAPPIER_STACK_SERVER_PORT: String(port), HAPPIER_STACK_ENV_FILE: envPath },
        stackMode: true,
        stackName,
        runtimeStatePath,
        defaultPort: 3005,
        listenerObservationScope,
        waitForTcpPortFreeImpl: async () => ({ status: 'occupied' }),
      });

      assert.equal(out, port);
    } finally {
      await stopChild(proxyProcess);
      await rm(tmp, { recursive: true, force: true });
    }
  });
}

test('non-main stack rejects runtime dev proxy maintenance port when proxy pid is not the listener', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-port-stale-proxy-maintenance-'));
  const runtimeStatePath = join(tmp, 'stack.runtime.json');
  const stackName = 'repo-test-abc';
  const envPath = join(tmp, 'env');
  const { server, port } = await listenMaintenanceHealthServer();
  const staleProxyProcess = await spawnStackOwnedIdleProcess({ stackName, envPath });
  try {
    const listenerObservationScope = createProcessIdentityFixtureScope(new Map([
      [staleProxyProcess.pid, stackOwnedProcessLine(staleProxyProcess.pid, { stackName, envPath })],
    ]), new Map([[port, [process.pid]]]));
    await writeFile(
      runtimeStatePath,
      JSON.stringify({
        version: 1,
        stackName,
        ports: { server: port },
        processes: { proxyPid: staleProxyProcess.pid },
        serverProxy: { enabled: true, mode: 'proxy', restartMode: 'exclusiveDb' },
      }),
      'utf-8'
    );

    const out = await resolveLocalServerPortForStack({
      env: { HAPPIER_STACK_ENV_FILE: envPath },
      stackMode: true,
      stackName,
      runtimeStatePath,
      defaultPort: 3005,
      listenerObservationScope,
      waitForTcpPortFreeImpl: async () => ({ status: 'occupied' }),
    });

    assert.notEqual(out, port);
  } finally {
    await stopChild(staleProxyProcess);
    await new Promise((resolvePromise) => server.close(resolvePromise));
  }
});

test('non-main stack ignores runtime port when it falls outside the configured stable port range', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-port-'));
  const runtimeStatePath = join(tmp, 'stack.runtime.json');
  await writeFile(
    runtimeStatePath,
    JSON.stringify({ ports: { server: 3009 }, processes: { serverPid: process.pid } }),
    'utf-8'
  );

  const out = await resolveLocalServerPortForStack({
    env: {
      HAPPIER_STACK_SERVER_PORT_BASE: '52005',
      HAPPIER_STACK_SERVER_PORT_RANGE: '2000',
    },
    stackMode: true,
    stackName: 'repo-test-abc',
    runtimeStatePath,
    defaultPort: 3005,
    listenerObservationScope: createProcessIdentityFixtureScope(new Map(), new Map()),
  });

  assert.ok(out >= 52005 && out < 52005 + 2000, `expected stable-range port, got ${out}`);
  assert.notEqual(out, 3009);
});

test('non-main stack does not reuse runtime port with only a live pid and non-happier listener', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-port-live-pid-'));
  const runtimeStatePath = join(tmp, 'stack.runtime.json');
  const { server, port } = await listenNonHealthServer();
  try {
    const listenerObservationScope = createProcessIdentityFixtureScope(
      new Map(),
      new Map([[port, [process.pid]]]),
    );
    await writeFile(
      runtimeStatePath,
      JSON.stringify({ ports: { server: port }, processes: { serverPid: process.pid } }),
      'utf-8'
    );

    const out = await resolveLocalServerPortForStack({
      env: {
        HAPPIER_STACK_SERVER_PORT_BASE: String(port),
        HAPPIER_STACK_SERVER_PORT_RANGE: '10',
      },
      stackMode: true,
      stackName: 'repo-test-abc',
      runtimeStatePath,
      defaultPort: 3005,
      listenerObservationScope,
      waitForTcpPortFreeImpl: async () => ({ status: 'occupied' }),
    });

    assert.notEqual(out, port);
    assert.ok(Number.isFinite(out) && out > 0, `expected valid replacement port, got ${out}`);
  } finally {
    await new Promise((resolvePromise) => server.close(resolvePromise));
  }
});

test('non-main stack errors when pinned server port is occupied by a non-happier process', async () => {
  const { server, port } = await listenNonHealthServer();
  try {
    const listenerObservationScope = createProcessIdentityFixtureScope(
      new Map(),
      new Map([[port, [process.pid]]]),
    );
    await assert.rejects(
      () =>
        resolveLocalServerPortForStack({
          env: { HAPPIER_STACK_SERVER_PORT: String(port) },
          stackMode: true,
          stackName: 'repo-test-abc',
          runtimeStatePath: null,
          defaultPort: 3005,
          listenerObservationScope,
          waitForTcpPortFreeImpl: async () => ({ status: 'occupied' }),
        }),
      /HAPPIER_STACK_SERVER_PORT/
    );
  } finally {
    await new Promise((resolvePromise) => server.close(resolvePromise));
  }
});

test('non-main stack errors when pinned server port health responds 200 for another service', async () => {
  const { server, port } = await listenUnrelatedHealthServer();
  try {
    const listenerObservationScope = createProcessIdentityFixtureScope(
      new Map(),
      new Map([[port, [process.pid]]]),
    );
    await assert.rejects(
      () =>
        resolveLocalServerPortForStack({
          env: { HAPPIER_STACK_SERVER_PORT: String(port) },
          stackMode: true,
          stackName: 'repo-test-abc',
          runtimeStatePath: null,
          defaultPort: 3005,
          listenerObservationScope,
          waitForTcpPortFreeImpl: async () => ({ status: 'occupied' }),
        }),
      /HAPPIER_STACK_SERVER_PORT/
    );
  } finally {
    await new Promise((resolvePromise) => server.close(resolvePromise));
  }
});

test('non-main stack picks a stable free port when no runtime port exists', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-port-'));
  const runtimeStatePath = join(tmp, 'missing.runtime.json');
  const out = await resolveLocalServerPortForStack({
    env: {
      HAPPIER_STACK_SERVER_PORT_BASE: '31200',
      HAPPIER_STACK_SERVER_PORT_RANGE: '1',
    },
    stackMode: true,
    stackName: 'repo-test-abc',
    runtimeStatePath,
    defaultPort: 3005,
    listenerObservationScope: createProcessIdentityFixtureScope(new Map(), new Map()),
  });
  assert.ok(Number.isFinite(out) && out >= 31200);
});

test('non-main fresh selection uses authoritative bind evidence when listener discovery is unsupported', async () => {
  const port = await reserveUnusedPort();
  let discoveryAttempts = 0;
  const listenerObservationScope = createListenerOwnershipCommandScope({
    listListenPidsWithStatusImpl: async () => {
      discoveryAttempts += 1;
      return {
        status: 'unsupported',
        supported: false,
        pids: [],
        reason: 'listener-discovery-unsupported',
      };
    },
  });

  const out = await resolveLocalServerPortForStack({
    env: {
      HAPPIER_STACK_SERVER_PORT_BASE: String(port),
      HAPPIER_STACK_SERVER_PORT_RANGE: '1',
    },
    stackMode: true,
    stackName: 'repo-test-fresh-bind-proof',
    runtimeStatePath: null,
    defaultPort: 3005,
    listenerObservationScope,
  });

  assert.equal(out, port);
  assert.equal(discoveryAttempts, 0, 'fresh allocation must not depend on listener discovery');
});

test('non-main stack skips occupied stable port and picks the next free port', async () => {
  const { server, port } = await listenHealthServer();
  try {
    const listenerObservationScope = createProcessIdentityFixtureScope(
      new Map(),
      new Map([[port, [process.pid]]]),
    );
    // Keep the chosen stable start port occupied.
    const out = await resolveLocalServerPortForStack({
      env: {
        HAPPIER_STACK_SERVER_PORT_BASE: String(port),
        HAPPIER_STACK_SERVER_PORT_RANGE: '1',
      },
      stackMode: true,
      stackName: 'repo-test-abc',
      runtimeStatePath: null,
      defaultPort: 3005,
      listenerObservationScope,
    });
    assert.ok(out > port, `expected resolver to skip occupied port ${port}, got ${out}`);
  } finally {
    await new Promise((resolvePromise) => server.close(resolvePromise));
  }
});

test('main stack preserves legacy port selection via HAPPIER_SERVER_URL', async () => {
  const out = await resolveLocalServerPortForStack({
    env: { HAPPIER_SERVER_URL: 'http://127.0.0.1:3999' },
    stackMode: true,
    stackName: 'main',
    runtimeStatePath: null,
    defaultPort: 3005,
  });
  assert.equal(out, 3999);
});

test('runtime free-port fallback reuses the command listener verdict before bind proof', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-port-single-free-verdict-'));
  const binDir = join(tmp, 'bin');
  const countPath = join(tmp, 'lsof-count');
  const runtimeStatePath = join(tmp, 'stack.runtime.json');
  const envPath = join(tmp, 'env');
  const port = await reserveUnusedPort();
  let idleProcess;
  await mkdir(binDir, { recursive: true });
  await writeFile(join(binDir, 'lsof'), '#!/bin/sh\nprintf x >> "$FAKE_LSOF_COUNT"\nexit 0\n', 'utf-8');
  await chmod(join(binDir, 'lsof'), 0o755);
  await writeFile(envPath, 'HAPPIER_STACK_STACK=repo-test-single-verdict\n', 'utf-8');
  idleProcess = await spawnStackOwnedIdleProcess({ stackName: 'repo-test-single-verdict', envPath });
  await writeFile(runtimeStatePath, JSON.stringify({
    stackName: 'repo-test-single-verdict',
    ports: { server: port },
    processes: { proxyPid: idleProcess.pid },
    serverProxy: { enabled: true, mode: 'proxy' },
  }), 'utf-8');
  const previousPath = process.env.PATH;
  const previousCount = process.env.FAKE_LSOF_COUNT;
  process.env.PATH = `${binDir}:${previousPath}`;
  process.env.FAKE_LSOF_COUNT = countPath;
  try {
    const listenerObservationScope = createProcessIdentityFixtureScope(new Map([
      [idleProcess.pid, stackOwnedProcessLine(idleProcess.pid, {
        stackName: 'repo-test-single-verdict',
        envPath,
      })],
    ]));
    const selected = await resolveLocalServerPortForStack({
      env: { PATH: process.env.PATH, HAPPIER_STACK_ENV_FILE: envPath },
      stackMode: true,
      stackName: 'repo-test-single-verdict',
      runtimeStatePath,
      listenerObservationScope,
    });
    assert.equal(selected, port);
    assert.equal((await readFile(countPath, 'utf-8')).length, 1);
  } finally {
    process.env.PATH = previousPath;
    if (previousCount === undefined) delete process.env.FAKE_LSOF_COUNT;
    else process.env.FAKE_LSOF_COUNT = previousCount;
    await stopChild(idleProcess);
    await rm(tmp, { recursive: true, force: true });
  }
});
