import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

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
