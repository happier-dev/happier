import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rename, rm, utimes, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import cliDistBuildManifest from '../cliDistBuildManifest.cjs';
import { CLI_RUNTIME_SIDECAR_ENTRIES } from '../cliRuntimeSidecars.mjs';
import {
  resolveNewestReadyPinnedRunnerSnapshot,
} from '../pinnedRunnerSnapshot.mjs';

async function writeReadySnapshot({ cliDir, workspaceRuntimeIdentity, mtimeMs }) {
  const stagingRoot = join(cliDir, '.runner-snapshots', '.staging');
  const stagingEntrypoint = join(stagingRoot, 'package-dist', 'index.mjs');
  await mkdir(dirname(stagingEntrypoint), { recursive: true });
  await writeFile(stagingEntrypoint, 'export {};\n', 'utf8');
  const writtenManifest = cliDistBuildManifest.writeCliDistBuildManifest(stagingEntrypoint, {
    outputDir: dirname(stagingEntrypoint),
    builtAt: '2026-08-14T00:00:00.000Z',
    workspaceRuntimeIdentity,
  });
  for (const sidecar of CLI_RUNTIME_SIDECAR_ENTRIES) {
    const sidecarPath = join(stagingRoot, 'scripts', ...sidecar);
    if (sidecar.length === 1 && (sidecar[0] === 'runtime' || sidecar[0] === 'shims')) {
      await mkdir(sidecarPath, { recursive: true });
    } else {
      await mkdir(dirname(sidecarPath), { recursive: true });
      await writeFile(sidecarPath, `module.exports = ${JSON.stringify(sidecar.at(-1))};\n`, 'utf8');
    }
  }
  const managedRuntimePath = join(
    stagingRoot,
    'tools',
    'unpacked',
    `happier-cliproxyapi-managed${process.platform === 'win32' ? '.exe' : ''}`,
  );
  await mkdir(dirname(managedRuntimePath), { recursive: true });
  await writeFile(managedRuntimePath, 'managed-runtime\n', 'utf8');
  const runtimeAsset = cliDistBuildManifest.writeCliRuntimeAssetBuildManifest({
    runtimeRoot: stagingRoot,
    entrypoint: stagingEntrypoint,
    relativePath: [
      'tools',
      'unpacked',
      `happier-cliproxyapi-managed${process.platform === 'win32' ? '.exe' : ''}`,
    ].join('/'),
  }).runtimeAsset;
  const runtimeAssetIdentity = createHash('sha256')
    .update('managed-runtime\n')
    .digest('hex');
  assert.equal(runtimeAsset.sha256, runtimeAssetIdentity);
  const fingerprint = writtenManifest.manifest.fingerprint;
  const snapshotIdentity = `${fingerprint}-${runtimeAssetIdentity}-${workspaceRuntimeIdentity}-package-dist-v4`;
  const snapshotRoot = join(cliDir, '.runner-snapshots', snapshotIdentity);
  await rename(stagingRoot, snapshotRoot);
  const snapshotEntrypoint = join(snapshotRoot, 'package-dist', 'index.mjs');
  await writeFile(join(snapshotRoot, '.fingerprint'), `${fingerprint}\n`, 'utf8');
  await writeFile(join(snapshotRoot, '.workspace-runtime-identity'), `${workspaceRuntimeIdentity}\n`, 'utf8');
  await utimes(snapshotRoot, mtimeMs / 1000, mtimeMs / 1000);
  return { fingerprint, snapshotIdentity, snapshotRoot, snapshotEntrypoint };
}

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
  const newerPartialRoot = join(
    cliDir,
    '.runner-snapshots',
    `${'d'.repeat(16)}-${'e'.repeat(64)}-${'f'.repeat(64)}-package-dist-v4`,
  );
  await mkdir(join(newerPartialRoot, 'package-dist'), { recursive: true });
  await writeFile(join(newerPartialRoot, 'package-dist', 'index.mjs'), 'export {};\n', 'utf8');
  await utimes(newerPartialRoot, 2, 2);

  assert.deepEqual(resolveNewestReadyPinnedRunnerSnapshot(mutableEntrypoint), {
    snapshotsDir: join(cliDir, '.runner-snapshots'),
    snapshotIdentity: older.snapshotIdentity,
    snapshotRoot: older.snapshotRoot,
    snapshotEntrypoint: older.snapshotEntrypoint,
    fingerprint: older.fingerprint,
    runtimeAssetIdentity: createHash('sha256').update('managed-runtime\n').digest('hex'),
    workspaceRuntimeIdentity: 'b'.repeat(64),
  });
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
      runtimeAssetIdentity: createHash('sha256').update('managed-runtime\n').digest('hex'),
      workspaceRuntimeIdentity: 'b'.repeat(64),
    },
  );
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
  await writeFile(
    join(
      newer.snapshotRoot,
      'tools',
      'unpacked',
      `happier-cliproxyapi-managed${process.platform === 'win32' ? '.exe' : ''}`,
    ),
    'corrupt-managed-runtime\n',
    'utf8',
  );

  assert.equal(
    resolveNewestReadyPinnedRunnerSnapshot(mutableEntrypoint)?.snapshotEntrypoint,
    older.snapshotEntrypoint,
  );
});
