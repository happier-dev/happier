import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';

import { readStackInfoSnapshot } from './stack/stack_info_snapshot.mjs';

function withStorageDir(storageDir) {
  const prev = process.env.HAPPIER_STACK_STORAGE_DIR;
  process.env.HAPPIER_STACK_STORAGE_DIR = storageDir;
  return () => {
    if (typeof prev === 'undefined') {
      delete process.env.HAPPIER_STACK_STORAGE_DIR;
    } else {
      process.env.HAPPIER_STACK_STORAGE_DIR = prev;
    }
  };
}

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

test('readStackInfoSnapshot reports running when owner pid is stale but an infra pid is alive', async () => {
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

  const restore = withStorageDir(storageDir);
  try {
    const out = await readStackInfoSnapshot({ rootDir: process.cwd(), stackName });
    assert.equal(out.runtime.running, true);
    assert.equal(out.runtime.runningPid, process.pid);
  } finally {
    restore();
    await rm(tmp, { recursive: true, force: true });
  }
});

test('readStackInfoSnapshot reports running when owner pid is stale but stack server port is occupied', async () => {
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

  const restore = withStorageDir(storageDir);
  try {
    const out = await readStackInfoSnapshot({ rootDir: process.cwd(), stackName });
    assert.equal(out.runtime.running, true);
    assert.equal(out.runtime.runningPid, null);
  } finally {
    restore();
    await listener.close();
    await rm(tmp, { recursive: true, force: true });
  }
});

test('readStackInfoSnapshot marks UI as down when expo runtime metadata is stale', async () => {
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

  const restore = withStorageDir(storageDir);
  try {
    const out = await readStackInfoSnapshot({ rootDir: process.cwd(), stackName });
    assert.equal(out.runtime.running, true);
    assert.equal(out.runtime.components.server.running, true);
    assert.equal(out.runtime.components.ui.running, false);
    assert.equal(out.runtime.health.status, 'degraded');
    assert.deepEqual(out.runtime.health.issues, ['ui_down']);
  } finally {
    restore();
    await serverListener.close();
    await rm(tmp, { recursive: true, force: true });
  }
});

test('readStackInfoSnapshot requires UI port reachability even when expo pid is alive', async () => {
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

  const restore = withStorageDir(storageDir);
  try {
    const out = await readStackInfoSnapshot({ rootDir: process.cwd(), stackName });
    assert.equal(out.runtime.running, true);
    assert.equal(out.runtime.components.ui.pidAlive, true);
    assert.equal(out.runtime.components.ui.running, false);
    assert.equal(out.runtime.health.status, 'degraded');
    assert.deepEqual(out.runtime.health.issues, ['ui_down']);
  } finally {
    restore();
    await serverListener.close();
    await rm(tmp, { recursive: true, force: true });
  }
});
