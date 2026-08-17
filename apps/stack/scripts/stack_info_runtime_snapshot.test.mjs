import test from 'node:test';
import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import http from 'node:http';

import { withPatchedProcessEnv } from './testkit/core/env_scope.mjs';
import { createRuntimeSnapshotFixture } from './testkit/runtime_snapshot_testkit.mjs';
import { readStackInfoSnapshot } from './stack/stack_info_snapshot.mjs';

async function withHappierHealthServer() {
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
    server.listen(0, '0.0.0.0', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? Number(address.port) : 0;
  return {
    port,
    async close() {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test('readStackInfoSnapshot reports active runtime snapshot metadata', async (t) => {
  const fixture = await createRuntimeSnapshotFixture(t, { stackName: 'prod-dev' });
  const restore = withPatchedProcessEnv(t, { HAPPIER_STACK_STORAGE_DIR: fixture.storageDir });
  try {
    const out = await readStackInfoSnapshot({ rootDir: process.cwd(), stackName: fixture.stackName });
    assert.equal(out.runtime.activeSnapshotId, 'snap-1');
    assert.equal(out.runtime.snapshotPath, fixture.snapshotDir);
    assert.equal(out.runtime.valid, true);
    assert.equal(out.runtime.snapshotComponents.server.entrypoint, 'server/happier-server');
    assert.equal(out.runtime.runtimePublication, null);
  } finally {
    restore();
  }
});

test('readStackInfoSnapshot projects publication status from the existing runtime state', async (t) => {
  const fixture = await createRuntimeSnapshotFixture(t, { stackName: 'runtime-publication-status' });
  const status = {
    phase: 'publishing',
    components: {
      server: { phase: 'publishing', error: null },
      daemon: { phase: 'stale', error: null },
    },
    currentSnapshotId: 'snap-1',
  };
  await writeFile(
    join(fixture.stackDir, 'stack.runtime.json'),
    JSON.stringify({
      version: 1,
      stackName: fixture.stackName,
      ownerPid: 999_999_999,
      runtimePublication: status,
    }) + '\n',
    'utf-8',
  );

  const restore = withPatchedProcessEnv(t, { HAPPIER_STACK_STORAGE_DIR: fixture.storageDir });
  try {
    const out = await readStackInfoSnapshot({ rootDir: process.cwd(), stackName: fixture.stackName });
    assert.deepEqual(out.runtime.runtimePublication, status);
  } finally {
    restore();
  }
});

test('readStackInfoSnapshot does not adopt a healthy endpoint from stale runtime state', async (t) => {
  const fixture = await createRuntimeSnapshotFixture(t, { stackName: 'runtime-foreign-endpoint' });
  const listener = await withHappierHealthServer();
  await writeFile(
    join(fixture.stackDir, 'env'),
    `HAPPIER_STACK_SERVER_COMPONENT=happier-server-light\nHAPPIER_STACK_SERVER_PORT=${listener.port}\nHAPPIER_STACK_DAEMON=0\n`,
    'utf-8',
  );
  await writeFile(
    join(fixture.stackDir, 'stack.runtime.json'),
    JSON.stringify({
      version: 1,
      stackName: fixture.stackName,
      ownerPid: 999_999_999,
      runtimeSnapshotId: 'snap-stale',
      processes: { serverPid: 999_999_998 },
      ports: { server: listener.port },
    }) + '\n',
    'utf-8',
  );

  const restore = withPatchedProcessEnv(t, { HAPPIER_STACK_STORAGE_DIR: fixture.storageDir });
  try {
    const out = await readStackInfoSnapshot({ rootDir: process.cwd(), stackName: fixture.stackName });
    assert.equal(out.runtime.running, false);
    assert.equal(out.runtime.components.server.running, false);
    assert.equal(out.runtime.loadedSnapshotId, null);
    assert.equal(out.urls.internalServerUrl, null);
    assert.equal(out.urls.uiUrl, null);
  } finally {
    restore();
    await listener.close();
  }
});

test('readStackInfoSnapshot reports invalid runtime pointers instead of marking them valid', async (t) => {
  const fixture = await createRuntimeSnapshotFixture(t, { stackName: 'prod-dev' });
  await writeFile(
    join(fixture.stackDir, 'runtime', 'current.json'),
    JSON.stringify({
      version: 1,
      snapshotId: 'snap-1',
      snapshotPath: join(fixture.root, 'escaped-runtime'),
      sourceFingerprint: 'src-1',
    }, null, 2) + '\n',
    'utf-8',
  );

  const restore = withPatchedProcessEnv(t, { HAPPIER_STACK_STORAGE_DIR: fixture.storageDir });
  try {
    const out = await readStackInfoSnapshot({ rootDir: process.cwd(), stackName: fixture.stackName });
    assert.equal(out.runtime.activeSnapshotId, 'snap-1');
    assert.equal(out.runtime.snapshotPath, join(fixture.root, 'escaped-runtime'));
    assert.equal(out.runtime.valid, false);
    assert.match(out.runtime.errors.join('\n'), /outside the stack runtime builds dir/i);
  } finally {
    restore();
  }
});

test('readStackInfoSnapshot reports runtime snapshots with missing daemon node entrypoints as invalid', async (t) => {
  const fixture = await createRuntimeSnapshotFixture(t, { stackName: 'prod-dev' });
  await rm(join(fixture.snapshotDir, 'cli', 'package-dist', 'index.mjs'), { force: true });
  await rm(join(fixture.stackDir, 'runtime', 'current', 'cli', 'package-dist', 'index.mjs'), { force: true });

  const restore = withPatchedProcessEnv(t, { HAPPIER_STACK_STORAGE_DIR: fixture.storageDir });
  try {
    const out = await readStackInfoSnapshot({ rootDir: process.cwd(), stackName: fixture.stackName });
    assert.equal(out.runtime.activeSnapshotId, 'snap-1');
    assert.equal(out.runtime.snapshotPath, fixture.snapshotDir);
    assert.equal(out.runtime.valid, false);
    assert.match(out.runtime.errors.join('\n'), /missing daemon node entrypoint/i);
  } finally {
    restore();
  }
});
