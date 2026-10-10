import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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

test('source snapshot info never depends on native selection and hides stopped loaded identities', async t => {
  const fixture = await createRuntimeSnapshotFixture(t, { stackName: 'source-info' });
  await writeFile(join(fixture.stackDir, 'env'), 'HAPPIER_STACK_RUNTIME_MODE=source-snapshot\nHAPPIER_STACK_DAEMON=0\nHAPPIER_STACK_SERVE_UI=0\n');
  await writeFile(join(fixture.stackDir, 'stack.runtime.json'), JSON.stringify({ version: 1, stackName: fixture.stackName,
    ownerPid: 999999999, runtimeSnapshotId: null,
    sourceRuntimeIdentities: { server: { selected: 'new-code', loaded: 'old-code' } },
  }));
  const restore = withPatchedProcessEnv(t, { HAPPIER_STACK_STORAGE_DIR: fixture.storageDir });
  try {
    const out = await readStackInfoSnapshot({ rootDir: process.cwd(), stackName: fixture.stackName });
    assert.equal(out.runtime.mode, 'source-snapshot');
    assert.equal(out.runtime.selectedSnapshotId, null);
    assert.equal(out.runtime.loadedSnapshotId, null);
    assert.deepEqual(out.runtime.sourceRuntimeIdentities, { server: { selected: 'new-code', loaded: null } });
    assert.equal(out.runtime.pendingManualRestart, false);
  } finally { restore(); }
});

test('remote-only info reports the recorded running role and an incomplete stop instead of stopped', async t => {
  const fixture = await createRuntimeSnapshotFixture(t, { stackName: 'remote-stop-info' });
  await writeFile(join(fixture.stackDir, 'env'), 'HAPPIER_STACK_RUNTIME_MODE=source-snapshot\nHAPPIER_STACK_DAEMON=1\nHAPPIER_STACK_SERVE_UI=0\n');
  withPatchedProcessEnv(t, { HAPPIER_STACK_STORAGE_DIR: fixture.storageDir });
  const runtimePath = join(fixture.stackDir, 'stack.runtime.json');
  const state = { version: 1, stackName: fixture.stackName, ownerPid: null, sourceRuntimeIdentities: {},
    placement: { daemon: 'linux1' }, remoteTargets: { linux1: { services: { daemon: true }, status: 'running', serviceStatus: { daemon: 'running' } } } };
  await writeFile(runtimePath, JSON.stringify(state));
  const running = await readStackInfoSnapshot({ rootDir: process.cwd(), stackName: fixture.stackName });
  assert.equal(running.runtime.components.daemon.running, true);
  assert.equal(running.runtime.running, true, 'aggregate must include remote daemon ownership');
  assert.notEqual(running.runtime.health.status, 'stopped');
  await writeFile(runtimePath, JSON.stringify({ ...state, stopRequest: { requestedAt: '2026-10-09T00:00:00.000Z' },
    remoteTargets: { linux1: { services: { daemon: true }, status: 'failed', phase: 'stop', serviceStatus: { daemon: 'failed' } } } }));
  const failed = await readStackInfoSnapshot({ rootDir: process.cwd(), stackName: fixture.stackName });
  assert.equal(failed.runtime.components.daemon.running, false, 'failure is not proof of running');
  assert.equal(failed.runtime.health.status, 'degraded');
  assert.ok(failed.runtime.health.issues.includes('stop_cleanup_incomplete'));
  await writeFile(runtimePath, JSON.stringify({ ...state,
    remoteTargets: { linux1: { services: { daemon: true }, status: 'failed', phase: 'stop', serviceStatus: { daemon: 'failed' } } } }));
  const ownerFailed = await readStackInfoSnapshot({ rootDir: process.cwd(), stackName: fixture.stackName });
  assert.equal(ownerFailed.runtime.health.status, 'degraded', 'owner-initiated failed retirement also preserves remote custody');
});

test('source snapshot info uses its recorded UI choice rather than implicitly borrowing a configured Expo producer', async t => {
  const fixture = await createRuntimeSnapshotFixture(t, { stackName: 'source-ui-info' });
  const producerStackName = 'source-ui-producer';
  await writeFile(join(fixture.stackDir, 'env'), `HAPPIER_STACK_RUNTIME_MODE=source-snapshot\nHAPPIER_STACK_DAEMON=0\nHAPPIER_STACK_EXPO_SOURCE_STACK=${producerStackName}\n`);
  await mkdir(join(fixture.storageDir, producerStackName), { recursive: true });
  await writeFile(join(fixture.storageDir, producerStackName, 'stack.runtime.json'), JSON.stringify({ expo: {}, processes: {} }));
  withPatchedProcessEnv(t, { HAPPIER_STACK_STORAGE_DIR: fixture.storageDir });
  const sourceUiLaunch = { uiDir: '/remote/server/source-export/ui' };
  for (const sourceUi of [undefined, 'borrowed', 'disabled']) {
    await writeFile(join(fixture.stackDir, 'stack.runtime.json'), JSON.stringify({ version: 1, stackName: fixture.stackName,
      sourceRuntimeIdentities: {}, sourceUi, sourceUiLaunch,
    }));
    const out = await readStackInfoSnapshot({ rootDir: process.cwd(), stackName: fixture.stackName });
    assert.equal(Boolean(out.runtime.borrowedExpo), sourceUi === 'borrowed');
    assert.equal(out.runtime.sourceUi, sourceUi ?? 'export');
    assert.deepEqual(out.runtime.sourceUiLaunch, sourceUi === 'borrowed' || sourceUi === 'disabled' ? null : sourceUiLaunch);
    if (sourceUi === 'borrowed') assert.equal(out.runtime.borrowedExpo.producerStackName, producerStackName);
    if (sourceUi === 'disabled') assert.equal(out.runtime.components.ui.running, false);
  }
});

test('stack info exposes the foreign server pin but rejects a shared database consumer without admitted component placement', async (t) => {
  const fixture = await createRuntimeSnapshotFixture(t, { stackName: 'qa-shared-info' });
  const manifestPath = join(fixture.snapshotDir, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.target = { platform: 'darwin', arch: 'arm64' };
  manifest.components = { server: manifest.components.server };
  await writeFile(manifestPath, JSON.stringify(manifest));
  await rm(join(fixture.snapshotDir, 'cli'), { recursive: true, force: true });
  await rm(join(fixture.snapshotDir, 'ui'), { recursive: true, force: true });
  await writeFile(join(fixture.stackDir, 'env'), 'HAPPIER_STACK_SERVER_COMPONENT=happier-server-light\nHAPPIER_STACK_SHARED_DB_SOURCE_STACK=dev\n');
  const restore = withPatchedProcessEnv(t, { HAPPIER_STACK_STORAGE_DIR: fixture.storageDir });
  try {
    const out = await readStackInfoSnapshot({ rootDir: process.cwd(), stackName: fixture.stackName });
    assert.equal(out.runtime.valid, false);
    assert.match(out.runtime.errors.join('; '), /target is incompatible/);
    assert.match(out.runtime.errors.join('; '), /daemon snapshot.*placement host/);
    assert.equal(out.runtime.selectedSnapshotId, 'snap-1');
    assert.deepEqual(Object.keys(out.runtime.snapshotComponents), ['server']);
  } finally { restore(); }
});

test('stack info reports stale packages from the selected snapshot', async (t) => {
  const fixture = await createRuntimeSnapshotFixture(t, { stackName: 'qa-last-green-info' });
  const manifestPath = join(fixture.snapshotDir, 'manifest.json');
  const { readFile } = await import('node:fs/promises');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const stalePackages = [
    { packageName: '@happier-dev/example', outputIdentity: 'prior-output', diagnosticSummary: 'error TS2322' },
    { packageName: '@happier-dev/cli', reason: 'typecheck', errorCount: 1, files: ['src/index.ts'], diagnosticSummary: 'src/index.ts(1,1): error TS2322: fixture' },
  ];
  manifest.components.daemon.stalePackages = stalePackages;
  await writeFile(manifestPath, JSON.stringify(manifest));
  const restore = withPatchedProcessEnv(t, { HAPPIER_STACK_STORAGE_DIR: fixture.storageDir });
  try {
    const out = await readStackInfoSnapshot({ rootDir: process.cwd(), stackName: fixture.stackName });
    assert.deepEqual(out.runtime.snapshotComponents.daemon.stalePackages, stalePackages);
  } finally { restore(); }
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
