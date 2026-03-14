import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { activateRuntimeSnapshot } from './activate_runtime_snapshot.mjs';
import { writeArtifactManifest } from '../runtime/shared/artifact_manifest.mjs';

function createSourceMetadata() {
  return {
    repoDir: '/tmp/repo',
    commitSha: 'abc123',
    dirtyHash: 'dirty456',
    builtAt: '2026-03-07T12:00:00.000Z',
    sourceFingerprint: 'source-fingerprint',
    serverComponent: 'happier-server-light',
    dbProvider: 'sqlite',
  };
}

async function createArtifact(rootDir, component, files) {
  const artifactDir = join(rootDir, component);
  const payloadDir = join(artifactDir, 'payload');
  await mkdir(payloadDir, { recursive: true });
  for (const [relativePath, content] of Object.entries(files)) {
    const targetPath = join(payloadDir, relativePath);
    await mkdir(join(targetPath, '..'), { recursive: true });
    await writeFile(targetPath, content);
  }
  await writeArtifactManifest({
    artifactDir,
    manifest: {
      version: 1,
      component,
      artifactFingerprint: `${component}-fingerprint`,
      sourceFingerprint: 'source-fingerprint',
      createdAt: '2026-03-07T12:00:00.000Z',
      source: createSourceMetadata(),
      payloadDir: 'payload',
      entrypoint:
        component === 'web'
          ? 'index.html'
          : component === 'server'
            ? 'happier-server'
            : 'happier',
    },
  });
  return {
    artifactDir,
    manifest: JSON.parse(await readFile(join(artifactDir, 'manifest.json'), 'utf8')),
  };
}

async function createSnapshotPayload(stackBaseDir, snapshotId, filesByComponent, createdAt = '2026-03-07T12:00:00.000Z') {
  const snapshotDir = join(stackBaseDir, 'runtime', 'builds', snapshotId);
  for (const [componentDir, files] of Object.entries(filesByComponent)) {
    for (const [relativePath, content] of Object.entries(files)) {
      const targetPath = join(snapshotDir, componentDir, relativePath);
      await mkdir(join(targetPath, '..'), { recursive: true });
      await writeFile(targetPath, content);
    }
  }
  await writeFile(
    join(snapshotDir, 'manifest.json'),
    JSON.stringify({
      version: 1,
      snapshotId,
      sourceFingerprint: 'source-fingerprint',
      createdAt,
      source: createSourceMetadata(),
      components: {
        web: { artifactFingerprint: 'web-old', entrypoint: 'ui/index.html' },
        server: { artifactFingerprint: 'server-old', entrypoint: 'server/happier-server' },
        daemon: { artifactFingerprint: 'daemon-old', entrypoint: 'cli/happier' },
      },
    }, null, 2) + '\n',
    'utf8',
  );
  await writeFile(
    join(stackBaseDir, 'runtime', 'current.json'),
    JSON.stringify({
      version: 1,
      snapshotId,
      snapshotPath: snapshotDir,
      sourceFingerprint: 'source-fingerprint',
    }, null, 2) + '\n',
    'utf8',
  );
}

test('activateRuntimeSnapshot assembles a complete runtime and updates current.json', async () => {
  const stackBaseDir = await mkdtemp(join(tmpdir(), 'activate-runtime-snapshot-'));

  try {
    const artifactsRoot = join(stackBaseDir, 'artifacts-fixture');
    const web = await createArtifact(artifactsRoot, 'web', { 'index.html': '<html></html>' });
    const server = await createArtifact(artifactsRoot, 'server', { 'happier-server': '#!/bin/sh\necho server\n' });
    const daemon = await createArtifact(artifactsRoot, 'daemon', { 'happier': '#!/bin/sh\necho daemon\n' });

    const runtime = await activateRuntimeSnapshot({
      stackBaseDir,
      snapshotId: 'snapshot-1',
      sourceMetadata: createSourceMetadata(),
      artifacts: { web, server, daemon },
    });

    const current = JSON.parse(await readFile(join(stackBaseDir, 'runtime', 'current.json'), 'utf8'));
    const manifest = JSON.parse(await readFile(join(runtime.snapshotPath, 'manifest.json'), 'utf8'));

    assert.equal(current.snapshotId, 'snapshot-1');
    assert.equal(current.snapshotPath, runtime.snapshotPath);
    assert.equal(manifest.snapshotId, 'snapshot-1');
    assert.equal(manifest.components.web.entrypoint, 'ui/index.html');
    assert.equal(manifest.components.server.entrypoint, 'server/happier-server');
    assert.equal(manifest.components.daemon.entrypoint, 'cli/happier');
    assert.equal(await readFile(join(runtime.snapshotPath, 'ui', 'index.html'), 'utf8'), '<html></html>');
    assert.equal(await readFile(join(runtime.snapshotPath, 'server', 'happier-server'), 'utf8'), '#!/bin/sh\necho server\n');
    assert.equal(await readFile(join(runtime.snapshotPath, 'cli', 'happier'), 'utf8'), '#!/bin/sh\necho daemon\n');
    assert.equal(await readFile(join(stackBaseDir, 'runtime', 'current', 'ui', 'index.html'), 'utf8'), '<html></html>');
    assert.equal(await readFile(join(stackBaseDir, 'runtime', 'current', 'server', 'happier-server'), 'utf8'), '#!/bin/sh\necho server\n');
    assert.equal(await readFile(join(stackBaseDir, 'runtime', 'current', 'cli', 'happier'), 'utf8'), '#!/bin/sh\necho daemon\n');
  } finally {
    await rm(stackBaseDir, { recursive: true, force: true });
  }
});

test('activateRuntimeSnapshot rejects artifacts whose declared entrypoints are missing', async () => {
  const stackBaseDir = await mkdtemp(join(tmpdir(), 'activate-runtime-snapshot-invalid-'));

  try {
    const artifactsRoot = join(stackBaseDir, 'artifacts-fixture');
    const web = await createArtifact(artifactsRoot, 'web', { 'index.html': '<html></html>' });
    const server = await createArtifact(artifactsRoot, 'server', { 'other-file': '#!/bin/sh\necho server\n' });
    const daemon = await createArtifact(artifactsRoot, 'daemon', { 'happier': '#!/bin/sh\necho daemon\n' });

    await assert.rejects(
      async () =>
        activateRuntimeSnapshot({
          stackBaseDir,
          snapshotId: 'snapshot-invalid',
          sourceMetadata: createSourceMetadata(),
          artifacts: { web, server, daemon },
        }),
      /artifact entrypoint is missing/i,
    );
  } finally {
    await rm(stackBaseDir, { recursive: true, force: true });
  }
});

test('activateRuntimeSnapshot can partially activate web by reusing server and daemon from the current snapshot', async () => {
  const stackBaseDir = await mkdtemp(join(tmpdir(), 'activate-runtime-snapshot-partial-'));

  try {
    await createSnapshotPayload(stackBaseDir, 'snapshot-old', {
      ui: { 'index.html': '<html>old web</html>' },
      server: { 'happier-server': '#!/bin/sh\necho old server\n' },
      cli: { 'happier': '#!/bin/sh\necho old daemon\n' },
    }, '2026-03-07T11:00:00.000Z');

    const artifactsRoot = join(stackBaseDir, 'artifacts-fixture');
    const web = await createArtifact(artifactsRoot, 'web', { 'index.html': '<html>new web</html>' });

    const runtime = await activateRuntimeSnapshot({
      stackBaseDir,
      snapshotId: 'snapshot-new',
      sourceMetadata: createSourceMetadata(),
      artifacts: { web },
    });
    const previousSnapshotDir = join(stackBaseDir, 'runtime', 'builds', 'snapshot-old');

    assert.equal(await readFile(join(runtime.snapshotPath, 'ui', 'index.html'), 'utf8'), '<html>new web</html>');
    assert.equal(await readFile(join(runtime.snapshotPath, 'server', 'happier-server'), 'utf8'), '#!/bin/sh\necho old server\n');
    assert.equal(await readFile(join(runtime.snapshotPath, 'cli', 'happier'), 'utf8'), '#!/bin/sh\necho old daemon\n');
    assert.equal(await realpath(join(runtime.snapshotPath, 'server')), await realpath(join(previousSnapshotDir, 'server')));
    assert.equal(await realpath(join(runtime.snapshotPath, 'cli')), await realpath(join(previousSnapshotDir, 'cli')));

    assert.equal(await readFile(join(stackBaseDir, 'runtime', 'current', 'ui', 'index.html'), 'utf8'), '<html>new web</html>');
    assert.equal(await readFile(join(stackBaseDir, 'runtime', 'current', 'server', 'happier-server'), 'utf8'), '#!/bin/sh\necho old server\n');
    assert.equal(await readFile(join(stackBaseDir, 'runtime', 'current', 'cli', 'happier'), 'utf8'), '#!/bin/sh\necho old daemon\n');
    assert.equal(await realpath(join(stackBaseDir, 'runtime', 'current', 'server')), await realpath(join(runtime.snapshotPath, 'server')));
    assert.equal(await realpath(join(stackBaseDir, 'runtime', 'current', 'cli')), await realpath(join(runtime.snapshotPath, 'cli')));
  } finally {
    await rm(stackBaseDir, { recursive: true, force: true });
  }
});

test('activateRuntimeSnapshot fails closed when partial activation would reuse a runtime server from another flavor', async () => {
  const stackBaseDir = await mkdtemp(join(tmpdir(), 'activate-runtime-snapshot-server-flavor-mismatch-'));

  try {
    await createSnapshotPayload(stackBaseDir, 'snapshot-old', {
      ui: { 'index.html': '<html>old web</html>' },
      server: { 'happier-server': '#!/bin/sh\necho old server\n' },
      cli: { 'happier': '#!/bin/sh\necho old daemon\n' },
    });

    const previousManifestPath = join(stackBaseDir, 'runtime', 'builds', 'snapshot-old', 'manifest.json');
    const previousManifest = JSON.parse(await readFile(previousManifestPath, 'utf8'));
    previousManifest.source = {
      ...createSourceMetadata(),
      serverComponent: 'happier-server',
      dbProvider: 'postgres',
    };
    await writeFile(previousManifestPath, JSON.stringify(previousManifest, null, 2) + '\n', 'utf8');

    const artifactsRoot = join(stackBaseDir, 'artifacts-fixture');
    const web = await createArtifact(artifactsRoot, 'web', { 'index.html': '<html>new web</html>' });

    await assert.rejects(
      async () =>
        activateRuntimeSnapshot({
          stackBaseDir,
          snapshotId: 'snapshot-new',
          sourceMetadata: createSourceMetadata(),
          artifacts: { web },
        }),
      /cannot reuse the active runtime server artifact across server flavors/i,
    );
  } finally {
    await rm(stackBaseDir, { recursive: true, force: true });
  }
});

test('activateRuntimeSnapshot prunes older runtime snapshots after activation', async () => {
  const stackBaseDir = await mkdtemp(join(tmpdir(), 'activate-runtime-snapshot-retention-'));

  try {
    await createSnapshotPayload(stackBaseDir, 'snapshot-1', {
      ui: { 'index.html': '<html>oldest web</html>' },
      server: { 'happier-server': '#!/bin/sh\necho oldest server\n' },
      cli: { 'happier': '#!/bin/sh\necho oldest daemon\n' },
    }, '2026-03-07T10:00:00.000Z');
    await createSnapshotPayload(stackBaseDir, 'snapshot-2', {
      ui: { 'index.html': '<html>previous web</html>' },
      server: { 'happier-server': '#!/bin/sh\necho previous server\n' },
      cli: { 'happier': '#!/bin/sh\necho previous daemon\n' },
    }, '2026-03-07T11:00:00.000Z');

    const artifactsRoot = join(stackBaseDir, 'artifacts-fixture');
    const web = await createArtifact(artifactsRoot, 'web', { 'index.html': '<html>new web</html>' });
    const server = await createArtifact(artifactsRoot, 'server', { 'happier-server': '#!/bin/sh\necho new server\n' });
    const daemon = await createArtifact(artifactsRoot, 'daemon', { 'happier': '#!/bin/sh\necho new daemon\n' });

    const runtime = await activateRuntimeSnapshot({
      stackBaseDir,
      snapshotId: 'snapshot-3',
      sourceMetadata: createSourceMetadata(),
      artifacts: { web, server, daemon },
      runtimeSnapshotKeepCount: 2,
    });

    await assert.rejects(() => readFile(join(stackBaseDir, 'runtime', 'builds', 'snapshot-1', 'manifest.json'), 'utf8'), /ENOENT/);
    assert.equal(await readFile(join(stackBaseDir, 'runtime', 'builds', 'snapshot-2', 'manifest.json'), 'utf8').then(Boolean), true);
    assert.equal(await readFile(join(runtime.snapshotPath, 'manifest.json'), 'utf8').then(Boolean), true);
  } finally {
    await rm(stackBaseDir, { recursive: true, force: true });
  }
});
