import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { writeArtifactManifest } from '../runtime/shared/artifact_manifest.mjs';
import { writeRuntimeManifest, writeRuntimePointer } from '../runtime/shared/runtime_manifest.mjs';
import { pruneComponentArtifacts, pruneRuntimeSnapshots, resolveRuntimeRetentionPolicy } from './runtime_retention.mjs';

async function writeRuntimeSnapshot(stackBaseDir, snapshotId, createdAt) {
  const snapshotDir = join(stackBaseDir, 'runtime', 'builds', snapshotId);
  await mkdir(join(snapshotDir, 'ui'), { recursive: true });
  await mkdir(join(snapshotDir, 'server'), { recursive: true });
  await mkdir(join(snapshotDir, 'cli'), { recursive: true });
  await writeFile(join(snapshotDir, 'ui', 'index.html'), `<html>${snapshotId}</html>`);
  await writeFile(join(snapshotDir, 'server', 'happier-server'), `server ${snapshotId}\n`);
  await writeFile(join(snapshotDir, 'cli', 'happier'), `daemon ${snapshotId}\n`);
  await writeRuntimeManifest({
    manifestPath: join(snapshotDir, 'manifest.json'),
    manifest: {
      version: 1,
      snapshotId,
      sourceFingerprint: `source-${snapshotId}`,
      createdAt,
      components: {
        web: { artifactFingerprint: `web-${snapshotId}`, entrypoint: 'ui/index.html' },
        server: { artifactFingerprint: `server-${snapshotId}`, entrypoint: 'server/happier-server' },
        daemon: { artifactFingerprint: `daemon-${snapshotId}`, entrypoint: 'cli/happier' },
      },
    },
  });
  return snapshotDir;
}

async function writeArtifact(stackBaseDir, component, fingerprint, createdAt) {
  const artifactDir = join(stackBaseDir, 'artifacts', component, fingerprint);
  const payloadDir = join(artifactDir, 'payload');
  await mkdir(payloadDir, { recursive: true });
  const entrypoint =
    component === 'web'
      ? 'index.html'
      : component === 'server'
        ? 'happier-server'
        : 'happier';
  await writeFile(join(payloadDir, entrypoint), `${component}:${fingerprint}\n`);
  await writeArtifactManifest({
    artifactDir,
    manifest: {
      version: 1,
      component,
      artifactFingerprint: fingerprint,
      sourceFingerprint: `source-${fingerprint}`,
      createdAt,
      payloadDir: 'payload',
      entrypoint,
    },
  });
  return artifactDir;
}

test('resolveRuntimeRetentionPolicy defaults to keeping current plus previous runtime and artifacts', () => {
  assert.deepEqual(resolveRuntimeRetentionPolicy({ env: {} }), {
    runtimeSnapshotKeepCount: 2,
    artifactKeepCount: 2,
  });
});

test('pruneRuntimeSnapshots keeps the active snapshot plus the newest previous snapshot and removes invalid directories', async () => {
  const stackBaseDir = await mkdtemp(join(tmpdir(), 'runtime-retention-runtime-'));

  try {
    const oldest = await writeRuntimeSnapshot(stackBaseDir, 'snapshot-1', '2026-03-07T10:00:00.000Z');
    const previous = await writeRuntimeSnapshot(stackBaseDir, 'snapshot-2', '2026-03-07T11:00:00.000Z');
    const current = await writeRuntimeSnapshot(stackBaseDir, 'snapshot-3', '2026-03-07T12:00:00.000Z');
    const invalid = join(stackBaseDir, 'runtime', 'builds', 'snapshot-broken');
    await mkdir(invalid, { recursive: true });
    await writeFile(join(invalid, 'README.txt'), 'broken\n');
    await writeRuntimePointer({
      currentPath: join(stackBaseDir, 'runtime', 'current.json'),
      pointer: {
        version: 1,
        snapshotId: 'snapshot-3',
        snapshotPath: current,
        sourceFingerprint: 'source-snapshot-3',
        updatedAt: '2026-03-07T12:00:00.000Z',
      },
    });

    const result = await pruneRuntimeSnapshots({ stackBaseDir, keepCount: 2, preserveSnapshotIds: ['snapshot-3'] });

    assert.deepEqual(result.keptSnapshotIds.sort(), ['snapshot-2', 'snapshot-3']);
    assert.deepEqual(result.removedEntries.sort(), ['snapshot-1', 'snapshot-broken']);
    await assert.rejects(() => readFile(join(oldest, 'manifest.json'), 'utf8'), /ENOENT/);
    assert.equal(await readFile(join(previous, 'manifest.json'), 'utf8').then(Boolean), true);
    assert.equal(await readFile(join(current, 'manifest.json'), 'utf8').then(Boolean), true);
  } finally {
    await rm(stackBaseDir, { recursive: true, force: true });
  }
});

test('pruneRuntimeSnapshots preserves the snapshot referenced by current.json by default', async () => {
  const stackBaseDir = await mkdtemp(join(tmpdir(), 'runtime-retention-current-pointer-'));

  try {
    const active = await writeRuntimeSnapshot(stackBaseDir, 'snapshot-active', '2026-03-07T10:00:00.000Z');
    const newer = await writeRuntimeSnapshot(stackBaseDir, 'snapshot-newer', '2026-03-07T11:00:00.000Z');
    await writeRuntimePointer({
      currentPath: join(stackBaseDir, 'runtime', 'current.json'),
      pointer: {
        version: 1,
        snapshotId: 'snapshot-active',
        snapshotPath: active,
        sourceFingerprint: 'source-snapshot-active',
        updatedAt: '2026-03-07T11:30:00.000Z',
      },
    });

    const result = await pruneRuntimeSnapshots({ stackBaseDir, keepCount: 1 });

    assert.deepEqual(result.keptSnapshotIds.sort(), ['snapshot-active']);
    assert.deepEqual(result.removedEntries.sort(), ['snapshot-newer']);
    assert.equal(await readFile(join(active, 'manifest.json'), 'utf8').then(Boolean), true);
    await assert.rejects(() => readFile(join(newer, 'manifest.json'), 'utf8'), /ENOENT/);
  } finally {
    await rm(stackBaseDir, { recursive: true, force: true });
  }
});

test('pruneRuntimeSnapshots preserves transitive snapshot references declared by the active manifest', async () => {
  const stackBaseDir = await mkdtemp(join(tmpdir(), 'runtime-retention-reused-snapshot-'));

  try {
    const reused = await writeRuntimeSnapshot(stackBaseDir, 'snapshot-reused', '2026-03-07T10:00:00.000Z');
    const active = await writeRuntimeSnapshot(stackBaseDir, 'snapshot-active', '2026-03-07T11:00:00.000Z');
    const activeManifestPath = join(active, 'manifest.json');
    const activeManifest = JSON.parse(await readFile(activeManifestPath, 'utf8'));
    activeManifest.reusedSnapshotIds = ['snapshot-reused'];
    await writeFile(activeManifestPath, JSON.stringify(activeManifest, null, 2) + '\n', 'utf8');
    await writeRuntimePointer({
      currentPath: join(stackBaseDir, 'runtime', 'current.json'),
      pointer: {
        version: 1,
        snapshotId: 'snapshot-active',
        snapshotPath: active,
        sourceFingerprint: 'source-snapshot-active',
        updatedAt: '2026-03-07T11:30:00.000Z',
      },
    });

    const result = await pruneRuntimeSnapshots({ stackBaseDir, keepCount: 1 });

    assert.deepEqual(result.keptSnapshotIds.sort(), ['snapshot-active', 'snapshot-reused']);
    assert.deepEqual(result.removedEntries, []);
    assert.equal(await readFile(join(active, 'manifest.json'), 'utf8').then(Boolean), true);
    assert.equal(await readFile(join(reused, 'manifest.json'), 'utf8').then(Boolean), true);
  } finally {
    await rm(stackBaseDir, { recursive: true, force: true });
  }
});

test('pruneComponentArtifacts keeps the newest artifacts for a component and removes invalid directories', async () => {
  const stackBaseDir = await mkdtemp(join(tmpdir(), 'runtime-retention-artifacts-'));

  try {
    const oldest = await writeArtifact(stackBaseDir, 'web', 'web-1', '2026-03-07T10:00:00.000Z');
    const previous = await writeArtifact(stackBaseDir, 'web', 'web-2', '2026-03-07T11:00:00.000Z');
    const current = await writeArtifact(stackBaseDir, 'web', 'web-3', '2026-03-07T12:00:00.000Z');
    const invalid = join(stackBaseDir, 'artifacts', 'web', 'web-broken');
    await mkdir(invalid, { recursive: true });
    await writeFile(join(invalid, 'README.txt'), 'broken\n');

    const result = await pruneComponentArtifacts({ stackBaseDir, component: 'web', keepCount: 2 });

    assert.deepEqual(result.keptFingerprints.sort(), ['web-2', 'web-3']);
    assert.deepEqual(result.removedEntries.sort(), ['web-1', 'web-broken']);
    await assert.rejects(() => readFile(join(oldest, 'manifest.json'), 'utf8'), /ENOENT/);
    assert.equal(await readFile(join(previous, 'manifest.json'), 'utf8').then(Boolean), true);
    assert.equal(await readFile(join(current, 'manifest.json'), 'utf8').then(Boolean), true);
  } finally {
    await rm(stackBaseDir, { recursive: true, force: true });
  }
});
