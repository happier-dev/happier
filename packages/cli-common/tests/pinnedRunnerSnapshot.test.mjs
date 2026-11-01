import cliDistBuildManifest from '../cliDistBuildManifest.cjs';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { publishPinnedRunnerSnapshotFixture } from './pinnedRunnerSnapshot.fixture.mjs';
import { BUNDLED_PLUGIN_PUBLICATION_FAILURES_RELATIVE_PATH } from '../bundledPluginPublicationPolicy.mjs';
import {
  PINNED_RUNNER_LAYOUT_VERSION,
  PINNED_RUNNER_MANAGED_PROVIDER_RUNTIME_RELATIVE_PATH,
  isPinnedRunnerSnapshotReady,
  readPinnedRunnerSnapshotPublicationIdentity,
  resolveNewestReadyPinnedRunnerSnapshot,
  resolvePublishedPinnedRunnerSnapshotById,
} from '../pinnedRunnerSnapshot.mjs';

async function writeReadySnapshot({
  cliDir,
  workspaceRuntimeIdentity,
  mtimeMs,
  layoutVersion = PINNED_RUNNER_LAYOUT_VERSION,
  publicationFailuresBytes = '[]',
  includeManagedRuntime = true,
}) {
  const stagingRoot = join(cliDir, '.runner-snapshots', '.staging');
  const managedRuntimePath = join(stagingRoot, ...PINNED_RUNNER_MANAGED_PROVIDER_RUNTIME_RELATIVE_PATH);
  if (includeManagedRuntime) {
    await mkdir(dirname(managedRuntimePath), { recursive: true });
    await writeFile(managedRuntimePath, 'managed-runtime\n', 'utf8');
  }
  return publishPinnedRunnerSnapshotFixture({
    stagingRoot,
    workspaceRuntimeIdentity,
    publicationFailuresBytes,
    layoutVersion,
    mtimeMs,
  });
}

async function writeBundledPlugin(snapshotRoot, {
  packageName = 'plugins-example',
  resources = [],
} = {}) {
  const packageRoot = join(snapshotRoot, 'node_modules', '@happier-dev', packageName);
  const manifestPath = join(packageRoot, '.happier-plugin', 'plugin.json');
  await mkdir(dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, `${JSON.stringify({
    contributes: { resources },
  })}\n`, 'utf8');
  return packageRoot;
}

test('does not reuse a v4 runner snapshot after its dependency closure layout changes', async (t) => {
  const cliDir = await mkdtemp(join(tmpdir(), 'happier-pinned-runner-legacy-layout-'));
  t.after(async () => rm(cliDir, { recursive: true, force: true }));
  const mutableEntrypoint = join(cliDir, 'dist', 'index.mjs');
  await mkdir(dirname(mutableEntrypoint), { recursive: true });
  await writeFile(mutableEntrypoint, 'export {};\n', 'utf8');

  await writeReadySnapshot({
    cliDir,
    workspaceRuntimeIdentity: 'b'.repeat(64),
    mtimeMs: 1_000,
    layoutVersion: 'package-dist-v4',
  });

  assert.equal(resolveNewestReadyPinnedRunnerSnapshot(mutableEntrypoint), null);
});

test('selects the newest structurally ready immutable runner and ignores a newer partial publication', async (t) => {
  const cliDir = await mkdtemp(join(tmpdir(), 'happier-pinned-runner-selection-'));
  t.after(async () => rm(cliDir, { recursive: true, force: true }));
  const mutableEntrypoint = join(cliDir, 'dist', 'index.mjs');
  await mkdir(dirname(mutableEntrypoint), { recursive: true });
  await writeFile(mutableEntrypoint, 'export {};\n', 'utf8');

  const older = await writeReadySnapshot({
    cliDir,
    workspaceRuntimeIdentity: 'b'.repeat(64),
    mtimeMs: 1_000,
  });
  const newerPartial = await writeReadySnapshot({
    cliDir,
    workspaceRuntimeIdentity: 'f'.repeat(64),
    mtimeMs: 2_000,
  });
  await rm(join(newerPartial.snapshotRoot, '.fingerprint'));

  assert.deepEqual(resolveNewestReadyPinnedRunnerSnapshot(mutableEntrypoint), {
    snapshotsDir: join(cliDir, '.runner-snapshots'),
    snapshotIdentity: older.snapshotIdentity,
    snapshotRoot: older.snapshotRoot,
    snapshotEntrypoint: older.snapshotEntrypoint,
    fingerprint: older.fingerprint,
    runtimeAssetIdentity: older.runtimeAssetIdentity,
    workspaceRuntimeIdentity: 'b'.repeat(64),
  });
});

test('selects the newer of two ready runner snapshots by publication time', async (t) => {
  const cliDir = await mkdtemp(join(tmpdir(), 'happier-pinned-runner-newest-ready-'));
  t.after(async () => rm(cliDir, { recursive: true, force: true }));
  const mutableEntrypoint = join(cliDir, 'dist', 'index.mjs');
  await mkdir(dirname(mutableEntrypoint), { recursive: true });
  await writeFile(mutableEntrypoint, 'export {};\n', 'utf8');

  await writeReadySnapshot({
    cliDir,
    workspaceRuntimeIdentity: 'b'.repeat(64),
    mtimeMs: 1_000,
  });
  const newer = await writeReadySnapshot({
    cliDir,
    workspaceRuntimeIdentity: 'c'.repeat(64),
    mtimeMs: 2_000,
  });

  assert.equal(
    resolveNewestReadyPinnedRunnerSnapshot(mutableEntrypoint)?.snapshotIdentity,
    newer.snapshotIdentity,
  );
});

test('selects ready snapshots from an explicit snapshot store override', async (t) => {
  const mutableCliDir = await mkdtemp(join(tmpdir(), 'happier-pinned-runner-mutable-store-'));
  const snapshotCliDir = await mkdtemp(join(tmpdir(), 'happier-pinned-runner-override-store-'));
  t.after(async () => Promise.all([
    rm(mutableCliDir, { recursive: true, force: true }),
    rm(snapshotCliDir, { recursive: true, force: true }),
  ]));
  const mutableEntrypoint = join(mutableCliDir, 'dist', 'index.mjs');
  await mkdir(dirname(mutableEntrypoint), { recursive: true });
  await writeFile(mutableEntrypoint, 'export {};\n', 'utf8');

  const ready = await writeReadySnapshot({
    cliDir: snapshotCliDir,
    workspaceRuntimeIdentity: 'b'.repeat(64),
    mtimeMs: 1_000,
  });

  assert.equal(resolveNewestReadyPinnedRunnerSnapshot(mutableEntrypoint), null);
  assert.deepEqual(
    resolveNewestReadyPinnedRunnerSnapshot(mutableEntrypoint, {
      snapshotsDir: join(snapshotCliDir, '.runner-snapshots'),
    }),
    {
      snapshotsDir: join(snapshotCliDir, '.runner-snapshots'),
      snapshotIdentity: ready.snapshotIdentity,
      snapshotRoot: ready.snapshotRoot,
      snapshotEntrypoint: ready.snapshotEntrypoint,
      fingerprint: ready.fingerprint,
      runtimeAssetIdentity: ready.runtimeAssetIdentity,
      workspaceRuntimeIdentity: 'b'.repeat(64),
    },
  );
});

test('pinned runner admission requires the publication set and binds its bytes to snapshot identity', async (t) => {
  const cliDir = await mkdtemp(join(tmpdir(), 'happier-pinned-publication-'));
  t.after(async () => rm(cliDir, { recursive: true, force: true }));
  const failures = JSON.stringify([{
    packageName: '@happier-dev/plugins-inspector', pluginId: 'happier.inspector',
    diagnostic: { code: 'plugin_package_build_failed', message: 'optional package failed' },
  }]);
  const location = await writeReadySnapshot({
    cliDir,
    workspaceRuntimeIdentity: 'a'.repeat(64),
    mtimeMs: 1_000,
    publicationFailuresBytes: failures,
    includeManagedRuntime: false,
  });
  const failuresPath = join(location.snapshotRoot, BUNDLED_PLUGIN_PUBLICATION_FAILURES_RELATIVE_PATH);
  await rm(failuresPath);
  assert.equal(readPinnedRunnerSnapshotPublicationIdentity(location.snapshotRoot), null);
  assert.equal(isPinnedRunnerSnapshotReady(location), false, 'missing publication state is unknown');
  await writeFile(failuresPath, '{', 'utf8');
  assert.equal(readPinnedRunnerSnapshotPublicationIdentity(location.snapshotRoot), null);
  assert.equal(isPinnedRunnerSnapshotReady(location), false, 'invalid publication state is unknown');
  await writeFile(failuresPath, failures, 'utf8');
  await writeBundledPlugin(location.snapshotRoot, {
    packageName: 'plugins-inspector',
    resources: [{ path: 'unpublished.png' }],
  });
  assert.equal(isPinnedRunnerSnapshotReady(location), true);
  assert.equal(
    resolvePublishedPinnedRunnerSnapshotById(join(cliDir, 'dist', 'index.mjs'), location.snapshotIdentity)?.snapshotRoot,
    location.snapshotRoot,
  );
  await writeFile(failuresPath, '[]', 'utf8');
  assert.equal(isPinnedRunnerSnapshotReady(location), false, 'different publication bytes cannot reuse the pinned identity');
});

test('rejects a newer snapshot missing a required runtime sidecar', async (t) => {
  const cliDir = await mkdtemp(join(tmpdir(), 'happier-pinned-runner-sidecar-'));
  t.after(async () => rm(cliDir, { recursive: true, force: true }));
  const mutableEntrypoint = join(cliDir, 'dist', 'index.mjs');
  await mkdir(dirname(mutableEntrypoint), { recursive: true });
  await writeFile(mutableEntrypoint, 'export {};\n', 'utf8');

  const older = await writeReadySnapshot({
    cliDir,
    workspaceRuntimeIdentity: 'b'.repeat(64),
    mtimeMs: 1_000,
  });
  const newer = await writeReadySnapshot({
    cliDir,
    workspaceRuntimeIdentity: 'd'.repeat(64),
    mtimeMs: 2_000,
  });
  await rm(join(newer.snapshotRoot, 'scripts', 'node_pty_relay.cjs'));

  assert.equal(
    resolveNewestReadyPinnedRunnerSnapshot(mutableEntrypoint)?.snapshotEntrypoint,
    older.snapshotEntrypoint,
  );
});

test('rejects a newer snapshot whose recorded managed runtime asset is no longer intact', async (t) => {
  const cliDir = await mkdtemp(join(tmpdir(), 'happier-pinned-runner-managed-runtime-'));
  t.after(async () => rm(cliDir, { recursive: true, force: true }));
  const mutableEntrypoint = join(cliDir, 'dist', 'index.mjs');
  await mkdir(dirname(mutableEntrypoint), { recursive: true });
  await writeFile(mutableEntrypoint, 'export {};\n', 'utf8');

  const older = await writeReadySnapshot({
    cliDir,
    workspaceRuntimeIdentity: 'b'.repeat(64),
    mtimeMs: 1_000,
  });
  const newer = await writeReadySnapshot({
    cliDir,
    workspaceRuntimeIdentity: 'd'.repeat(64),
    mtimeMs: 2_000,
  });
  // A Windows payload records the GUI task host alongside its managed wrapper.
  await writeFile(join(newer.snapshotRoot, 'happier-service-launcher.exe'), 'launcher-bytes');
  cliDistBuildManifest.writeCliRuntimeAssetBuildManifest({
    runtimeRoot: newer.snapshotRoot,
    entrypoint: newer.snapshotEntrypoint,
    relativePath: 'happier-service-launcher.exe',
  });
  assert.equal(
    resolveNewestReadyPinnedRunnerSnapshot(mutableEntrypoint)?.snapshotEntrypoint,
    newer.snapshotEntrypoint,
    'a second native asset must preserve the admitted managed wrapper identity',
  );
  await writeFile(
    join(newer.snapshotRoot, ...PINNED_RUNNER_MANAGED_PROVIDER_RUNTIME_RELATIVE_PATH),
    'corrupt-managed-runtime\n',
    'utf8',
  );

  assert.equal(
    resolveNewestReadyPinnedRunnerSnapshot(mutableEntrypoint)?.snapshotEntrypoint,
    older.snapshotEntrypoint,
  );
});

test('rejects a newer snapshot missing bytes declared by a bundled plugin manifest', async (t) => {
  const cliDir = await mkdtemp(join(tmpdir(), 'happier-pinned-runner-plugin-resource-'));
  t.after(async () => rm(cliDir, { recursive: true, force: true }));
  const mutableEntrypoint = join(cliDir, 'dist', 'index.mjs');
  await mkdir(dirname(mutableEntrypoint), { recursive: true });
  await writeFile(mutableEntrypoint, 'export {};\n', 'utf8');

  const older = await writeReadySnapshot({
    cliDir,
    workspaceRuntimeIdentity: 'b'.repeat(64),
    mtimeMs: 1_000,
  });
  const olderPluginRoot = await writeBundledPlugin(older.snapshotRoot, {
    resources: [{ id: 'prompt', path: 'resources/prompt.md' }],
  });
  await mkdir(join(olderPluginRoot, 'resources'), { recursive: true });
  await writeFile(join(olderPluginRoot, 'resources', 'prompt.md'), '# Prompt\n', 'utf8');

  const newer = await writeReadySnapshot({
    cliDir,
    workspaceRuntimeIdentity: 'd'.repeat(64),
    mtimeMs: 2_000,
  });
  await writeBundledPlugin(newer.snapshotRoot, {
    resources: [{ id: 'prompt', path: 'resources/prompt.md' }],
  });

  assert.equal(
    resolveNewestReadyPinnedRunnerSnapshot(mutableEntrypoint)?.snapshotEntrypoint,
    older.snapshotEntrypoint,
  );
});
