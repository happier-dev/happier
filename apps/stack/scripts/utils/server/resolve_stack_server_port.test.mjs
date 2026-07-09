import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';

import { resolveLocalServerPortForStack } from './resolve_stack_server_port.mjs';

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

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolvePromise) => {
    child.once('exit', resolvePromise);
    child.kill('SIGTERM');
  });
}

test('non-main stack prefers runtime port when server is already running there', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-port-'));
  const runtimeStatePath = join(tmp, 'stack.runtime.json');
  const { server, port } = await listenHealthServer();
  try {
    await writeFile(runtimeStatePath, JSON.stringify({ ports: { server: port } }), 'utf-8');
    const out = await resolveLocalServerPortForStack({
      env: {},
      stackMode: true,
      stackName: 'repo-test-abc',
      runtimeStatePath,
      defaultPort: 3005,
    });
    assert.equal(out, port);
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
    await writeFile(
      runtimeStatePath,
      JSON.stringify({
        version: 1,
        stackName,
        ports: { server: port },
        processes: { proxyPid: proxyProcess.pid },
        serverProxy: { enabled: true, mode: 'proxy', restartMode: 'exclusiveDb' },
      }),
      'utf-8',
    );

    const out = await resolveLocalServerPortForStack({
      env: { HAPPIER_STACK_SERVER_PORT: String(port), HAPPIER_STACK_ENV_FILE: envPath },
      stackMode: true,
      stackName,
      runtimeStatePath,
      defaultPort: 3005,
    });

    assert.equal(out, port);
  } finally {
    await stopChild(proxyProcess);
  }
});

test('non-main stack reuses runtime stable port during dev proxy maintenance when runtime owns the proxy', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-port-runtime-maintenance-'));
  const runtimeStatePath = join(tmp, 'stack.runtime.json');
  const stackName = 'repo-test-abc';
  const envPath = join(tmp, 'env');
  const { child: proxyProcess, port } = await spawnStackOwnedMaintenanceServer({ stackName, envPath });
  try {
    await writeFile(
      runtimeStatePath,
      JSON.stringify({
        version: 1,
        stackName,
        ports: { server: port },
        processes: { proxyPid: proxyProcess.pid },
        serverProxy: { enabled: true, mode: 'proxy', restartMode: 'exclusiveDb' },
      }),
      'utf-8',
    );

    const out = await resolveLocalServerPortForStack({
      env: { HAPPIER_STACK_ENV_FILE: envPath },
      stackMode: true,
      stackName,
      runtimeStatePath,
      defaultPort: 3005,
    });

    assert.equal(out, port);
  } finally {
    await stopChild(proxyProcess);
  }
});

test('non-main stack rejects runtime dev proxy maintenance port when proxy pid is not the listener', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-port-stale-proxy-maintenance-'));
  const runtimeStatePath = join(tmp, 'stack.runtime.json');
  const stackName = 'repo-test-abc';
  const envPath = join(tmp, 'env');
  const { server, port } = await listenMaintenanceHealthServer();
  const staleProxyProcess = await spawnStackOwnedIdleProcess({ stackName, envPath });
  try {
    await writeFile(
      runtimeStatePath,
      JSON.stringify({
        version: 1,
        stackName,
        ports: { server: port },
        processes: { proxyPid: staleProxyProcess.pid },
        serverProxy: { enabled: true, mode: 'proxy', restartMode: 'exclusiveDb' },
      }),
      'utf-8',
    );

    const out = await resolveLocalServerPortForStack({
      env: { HAPPIER_STACK_ENV_FILE: envPath },
      stackMode: true,
      stackName,
      runtimeStatePath,
      defaultPort: 3005,
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
  await writeFile(runtimeStatePath, JSON.stringify({ ports: { server: 3009 } }), 'utf-8');

  const out = await resolveLocalServerPortForStack({
    env: {
      HAPPIER_STACK_SERVER_PORT_BASE: '52005',
      HAPPIER_STACK_SERVER_PORT_RANGE: '2000',
    },
    stackMode: true,
    stackName: 'repo-test-abc',
    runtimeStatePath,
    defaultPort: 3005,
  });

  assert.ok(out >= 52005 && out < 52005 + 2000, `expected stable-range port, got ${out}`);
  assert.notEqual(out, 3009);
});

test('non-main stack ignores runtime port outside the stable range even when the recorded server pid is alive', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-port-'));
  const runtimeStatePath = join(tmp, 'stack.runtime.json');
  await writeFile(
    runtimeStatePath,
    JSON.stringify({ ports: { server: 3009 }, processes: { serverPid: process.pid } }),
    'utf-8',
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
  });

  assert.ok(out >= 52005 && out < 52005 + 2000, `expected stable-range port, got ${out}`);
  assert.notEqual(out, 3009);
});

test('non-main stack ignores occupied non-happier runtime port even when the recorded server pid is alive', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-port-'));
  const runtimeStatePath = join(tmp, 'stack.runtime.json');
  const { server, port } = await listenNonHealthServer();
  try {
    await writeFile(
      runtimeStatePath,
      JSON.stringify({ ports: { server: port }, processes: { serverPid: process.pid } }),
      'utf-8',
    );

    const out = await resolveLocalServerPortForStack({
      env: {},
      stackMode: true,
      stackName: 'repo-test-abc',
      runtimeStatePath,
      defaultPort: 3005,
    });

    assert.notEqual(out, port);
  } finally {
    await new Promise((resolvePromise) => server.close(resolvePromise));
  }
});

test('non-main stack errors when pinned server port is occupied by a non-happier process', async () => {
  const { server, port } = await listenNonHealthServer();
  try {
    await assert.rejects(
      () =>
        resolveLocalServerPortForStack({
          env: { HAPPIER_STACK_SERVER_PORT: String(port) },
          stackMode: true,
          stackName: 'repo-test-abc',
          runtimeStatePath: null,
          defaultPort: 3005,
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
    await assert.rejects(
      () =>
        resolveLocalServerPortForStack({
          env: { HAPPIER_STACK_SERVER_PORT: String(port) },
          stackMode: true,
          stackName: 'repo-test-abc',
          runtimeStatePath: null,
          defaultPort: 3005,
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
  });
  assert.ok(Number.isFinite(out) && out >= 31200);
});

test('non-main stack skips occupied stable port and picks the next free port', async () => {
  const { server, port } = await listenHealthServer();
  try {
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
