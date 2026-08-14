import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  activateRuntimeSnapshot,
  composeRuntimePublicationResult,
  publishRuntimeSnapshot,
  selectRuntimeSnapshot,
} from './activate_runtime_snapshot.mjs';

test('composeRuntimePublicationResult exposes producer, consumer, reuse, and selection state', () => {
  assert.deepEqual(
    composeRuntimePublicationResult({
      consumerStackName: 'qa-one',
      producerStackName: 'repo-happier-producer',
      published: {
        snapshotId: 'snapshot-shared',
        snapshotPath: '/stacks/repo-happier-producer/runtime/builds/snapshot-shared',
        reused: true,
      },
      selectedRuntime: {
        snapshotId: 'snapshot-shared',
        snapshotPath: '/stacks/repo-happier-producer/runtime/builds/snapshot-shared',
        currentPath: '/stacks/qa-one/runtime/current.json',
        producerStackName: 'repo-happier-producer',
      },
    }),
    {
      consumerStackName: 'qa-one',
      producerStackName: 'repo-happier-producer',
      snapshotId: 'snapshot-shared',
      snapshotPath: '/stacks/repo-happier-producer/runtime/builds/snapshot-shared',
      currentPath: '/stacks/qa-one/runtime/current.json',
      reused: true,
      selected: true,
    },
  );
});
import { writeArtifactManifest } from '../runtime/shared/artifact_manifest.mjs';
import { inspectActiveRuntimeSnapshot } from '../runtime/launch/inspectActiveRuntimeSnapshot.mjs';
import { resolveStackRuntimePaths } from '../runtime/shared/runtime_paths.mjs';
import { writeRuntimeSnapshotLayout } from '../testkit/core/runtime_snapshot_layout.mjs';

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

async function createArtifact(
  rootDir,
  component,
  files,
  { includeDaemonNodeRuntime = component === 'daemon' } = {},
) {
  const artifactDir = join(rootDir, component);
  const payloadDir = join(artifactDir, 'payload');
  await mkdir(payloadDir, { recursive: true });
  const payloadFiles = {
    ...(includeDaemonNodeRuntime
      ? {
          'package-dist/index.mjs': "console.log('daemon node runtime');\n",
          'package-dist/.build-manifest.json': JSON.stringify({ fingerprint: '0123456789abcdef' }) + '\n',
        }
      : {}),
    ...files,
  };
  for (const [relativePath, content] of Object.entries(payloadFiles)) {
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
  const { snapshotDir } = await writeRuntimeSnapshotLayout({
    stackDir: stackBaseDir,
    snapshotId,
    sourceFingerprint: 'source-fingerprint',
    createdAt,
    writeCurrentMirror: true,
    source: createSourceMetadata(),
    web: {
      content: filesByComponent.ui?.['index.html'] ?? '<html></html>',
      artifactFingerprint: 'web-old',
    },
    server: {
      content: filesByComponent.server?.['happier-server'] ?? '#!/bin/sh\necho old server\n',
      artifactFingerprint: 'server-old',
    },
    daemon: {
      content: filesByComponent.cli?.['happier'] ?? '#!/bin/sh\necho old daemon\n',
      artifactFingerprint: 'daemon-old',
      nodeEntrypoint: 'cli/package-dist/index.mjs',
      nodeContent: filesByComponent.cli?.['package-dist/index.mjs'] ?? "console.log('old daemon');\n",
    },
  });
  return snapshotDir;
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
    assert.deepEqual(manifest.target, { platform: process.platform, arch: process.arch });
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

test('a consumer cannot select a runtime snapshot built for another platform', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'runtime-snapshot-target-'));
  const producerStackBaseDir = join(storageRoot, 'producer');
  const consumerStackBaseDir = join(storageRoot, 'consumer');

  try {
    const artifactsRoot = join(storageRoot, 'artifacts-fixture');
    const web = await createArtifact(artifactsRoot, 'web', { 'index.html': '<html></html>' });
    const server = await createArtifact(artifactsRoot, 'server', { 'happier-server': '#!/bin/sh\n' });
    const daemon = await createArtifact(artifactsRoot, 'daemon', { happier: '#!/bin/sh\n' });
    await publishRuntimeSnapshot({
      producerStackBaseDir,
      snapshotId: 'snapshot-foreign',
      sourceMetadata: createSourceMetadata(),
      artifacts: { web, server, daemon },
      platform: 'foreign-os',
      arch: 'foreign-arch',
    });

    await assert.rejects(
      selectRuntimeSnapshot({
        consumerStackBaseDir,
        producerStackBaseDir,
        producerStackName: 'producer',
        snapshotId: 'snapshot-foreign',
      }),
      /targets foreign-os\/foreign-arch/i,
    );
  } finally {
    await rm(storageRoot, { recursive: true, force: true });
  }
});

test('publishing an existing valid snapshot identity reuses its immutable bytes', async () => {
  const stackBaseDir = await mkdtemp(join(tmpdir(), 'runtime-snapshot-immutable-'));
  try {
    const artifactsRoot = join(stackBaseDir, 'artifacts-fixture');
    const web = await createArtifact(artifactsRoot, 'web', { 'index.html': '<html>first</html>' });
    const server = await createArtifact(artifactsRoot, 'server', { 'happier-server': '#!/bin/sh\necho first\n' });
    const daemon = await createArtifact(artifactsRoot, 'daemon', { happier: '#!/bin/sh\necho first\n' });
    const first = await publishRuntimeSnapshot({
      producerStackBaseDir: stackBaseDir,
      snapshotId: 'snapshot-immutable',
      sourceMetadata: createSourceMetadata(),
      artifacts: { web, server, daemon },
    });
    await writeFile(join(web.artifactDir, 'payload', 'index.html'), '<html>mutated source artifact</html>', 'utf8');

    const second = await publishRuntimeSnapshot({
      producerStackBaseDir: stackBaseDir,
      snapshotId: 'snapshot-immutable',
      sourceMetadata: createSourceMetadata(),
      artifacts: { web, server, daemon },
    });

    assert.equal(second.reused, true);
    assert.equal(first.snapshotPath, second.snapshotPath);
    assert.equal(await readFile(join(second.snapshotPath, 'ui', 'index.html'), 'utf8'), '<html>first</html>');
  } finally {
    await rm(stackBaseDir, { recursive: true, force: true });
  }
});

test('published runtime snapshot can be selected by another managed stack without copying payloads', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'shared-runtime-snapshot-'));
  const producerStackName = 'repo-happier-producer';
  const producerStackBaseDir = join(storageRoot, producerStackName);
  const consumerStackBaseDir = join(storageRoot, 'qa-consumer');

  try {
    const artifactsRoot = join(storageRoot, 'artifacts-fixture');
    const web = await createArtifact(artifactsRoot, 'web', { 'index.html': '<html>shared</html>' });
    const server = await createArtifact(artifactsRoot, 'server', { 'happier-server': '#!/bin/sh\necho shared server\n' });
    const daemon = await createArtifact(artifactsRoot, 'daemon', { 'happier': '#!/bin/sh\necho shared daemon\n' });

    const published = await publishRuntimeSnapshot({
      producerStackBaseDir,
      snapshotId: 'snapshot-shared',
      sourceMetadata: createSourceMetadata(),
      artifacts: { web, server, daemon },
    });
    const selected = await selectRuntimeSnapshot({
      consumerStackBaseDir,
      producerStackBaseDir,
      producerStackName,
      snapshotId: published.snapshotId,
    });

    const current = JSON.parse(await readFile(join(consumerStackBaseDir, 'runtime', 'current.json'), 'utf8'));
    assert.equal(current.producerStackName, producerStackName);
    assert.equal(current.snapshotPath, published.snapshotPath);
    await assert.rejects(readFile(join(consumerStackBaseDir, 'runtime', 'builds', 'snapshot-shared', 'manifest.json'), 'utf8'), { code: 'ENOENT' });

    const inspection = await inspectActiveRuntimeSnapshot({
      stackBaseDir: consumerStackBaseDir,
      env: { HAPPIER_STACK_STORAGE_DIR: storageRoot },
    });
    assert.equal(inspection.valid, true, inspection.errors.join('\n'));
    assert.equal(inspection.snapshotPath, published.snapshotPath);
    assert.equal(inspection.snapshot.producerStackName, producerStackName);
    assert.equal(selected.snapshotPath, published.snapshotPath);
  } finally {
    await rm(storageRoot, { recursive: true, force: true });
  }
});

test('selectRuntimeSnapshot rejects a snapshot root symlink outside the producer builds directory', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'shared-runtime-external-snapshot-'));
  const producerStackBaseDir = join(storageRoot, 'producer');
  const consumerStackBaseDir = join(storageRoot, 'consumer');
  const snapshotId = 'snapshot-external';
  const externalSnapshotDir = join(storageRoot, 'external-snapshot');

  try {
    const snapshotDir = await createSnapshotPayload(producerStackBaseDir, snapshotId, {});
    await rename(snapshotDir, externalSnapshotDir);
    await symlink(externalSnapshotDir, snapshotDir, process.platform === 'win32' ? 'junction' : 'dir');

    await assert.rejects(
      selectRuntimeSnapshot({
        consumerStackBaseDir,
        producerStackBaseDir,
        producerStackName: 'producer',
        snapshotId,
      }),
      /snapshot.*outside.*runtime builds/i,
    );
    await assert.rejects(
      readFile(join(consumerStackBaseDir, 'runtime', 'current.json'), 'utf8'),
      { code: 'ENOENT' },
    );
  } finally {
    await rm(storageRoot, { recursive: true, force: true });
  }
});

test('cross-stack selection and inspection reject non-canonical producer stack names', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'shared-runtime-untrusted-producer-'));
  const producerStackBaseDir = join(storageRoot, 'repo-producer');
  const consumerStackBaseDir = join(storageRoot, 'qa-consumer');

  try {
    const artifactsRoot = join(storageRoot, 'artifacts-fixture');
    const web = await createArtifact(artifactsRoot, 'web', { 'index.html': '<html>shared</html>' });
    const server = await createArtifact(artifactsRoot, 'server', { 'happier-server': '#!/bin/sh\necho shared server\n' });
    const daemon = await createArtifact(artifactsRoot, 'daemon', { 'happier': '#!/bin/sh\necho shared daemon\n' });
    const published = await publishRuntimeSnapshot({
      producerStackBaseDir,
      snapshotId: 'snapshot-untrusted',
      sourceMetadata: createSourceMetadata(),
      artifacts: { web, server, daemon },
    });

    await assert.rejects(
      selectRuntimeSnapshot({
        consumerStackBaseDir,
        producerStackBaseDir,
        producerStackName: '../outside',
        snapshotId: published.snapshotId,
      }),
      /invalid producer stack name/i,
    );

    const consumerPaths = resolveStackRuntimePaths({ stackBaseDir: consumerStackBaseDir });
    await mkdir(consumerPaths.runtimeDir, { recursive: true });
    await writeFile(
      consumerPaths.currentPath,
      JSON.stringify({
        version: 1,
        snapshotId: published.snapshotId,
        snapshotPath: published.snapshotPath,
        producerStackName: '../outside',
        sourceFingerprint: 'source-fingerprint',
      }),
      'utf8',
    );
    const inspection = await inspectActiveRuntimeSnapshot({
      stackBaseDir: consumerStackBaseDir,
      env: { HAPPIER_STACK_STORAGE_DIR: storageRoot },
    });
    assert.equal(inspection.valid, false);
    assert.match(inspection.errors.join('\n'), /invalid producer stack name/i);
  } finally {
    await rm(storageRoot, { recursive: true, force: true });
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

test('activateRuntimeSnapshot rejects daemon artifacts that flatten the node runtime beside the binary', async () => {
  const stackBaseDir = await mkdtemp(join(tmpdir(), 'activate-runtime-snapshot-flat-daemon-'));

  try {
    const artifactsRoot = join(stackBaseDir, 'artifacts-fixture');
    const web = await createArtifact(artifactsRoot, 'web', { 'index.html': '<html></html>' });
    const server = await createArtifact(artifactsRoot, 'server', { 'happier-server': '#!/bin/sh\necho server\n' });
    const daemon = await createArtifact(
      artifactsRoot,
      'daemon',
      {
        'happier': '#!/bin/sh\necho daemon\n',
        'index.mjs': "console.log('flattened daemon node runtime');\n",
      },
      { includeDaemonNodeRuntime: false },
    );

    await assert.rejects(
      async () =>
        activateRuntimeSnapshot({
          stackBaseDir,
          snapshotId: 'snapshot-flat-daemon',
          sourceMetadata: createSourceMetadata(),
          artifacts: { web, server, daemon },
        }),
      /daemon artifact node entrypoint is missing.*package-dist[/\\]index\.mjs/i,
    );
    await assert.rejects(
      readFile(join(stackBaseDir, 'runtime', 'current.json'), 'utf8'),
      { code: 'ENOENT' },
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
