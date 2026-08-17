import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, realpath, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  activateRuntimeSnapshot,
  composeRuntimePublicationResult,
  publishRuntimeSnapshot,
  selectActiveProducerRuntimeSnapshot,
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
import { writeRuntimeManifest } from '../runtime/shared/runtime_manifest.mjs';
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
  {
    includeDaemonNodeRuntime = component === 'daemon',
    artifactFingerprint = `${component}-fingerprint`,
    artifactDir = join(rootDir, component, artifactFingerprint),
    extraManifest = {},
  } = {},
) {
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
      artifactFingerprint,
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
      ...extraManifest,
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
    const artifactsRoot = join(stackBaseDir, 'artifacts');
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

test('runtime snapshots reference canonical component payloads instead of cloning them', async () => {
  const stackBaseDir = await mkdtemp(join(tmpdir(), 'activate-runtime-snapshot-references-'));

  try {
    const artifactsRoot = join(stackBaseDir, 'artifacts');
    const web = await createArtifact(artifactsRoot, 'web', { 'index.html': '<html>shared</html>' });
    const server = await createArtifact(artifactsRoot, 'server', { 'happier-server': '#!/bin/sh\necho shared server\n' });
    const daemon = await createArtifact(artifactsRoot, 'daemon', { 'happier': '#!/bin/sh\necho shared daemon\n' });

    const published = await publishRuntimeSnapshot({
      producerStackBaseDir: stackBaseDir,
      snapshotId: 'snapshot-references',
      sourceMetadata: createSourceMetadata(),
      artifacts: { web, server, daemon },
    });

    for (const [snapshotComponent, artifact] of [
      ['ui', web],
      ['server', server],
      ['cli', daemon],
    ]) {
      assert.equal(
        await realpath(join(published.snapshotPath, snapshotComponent)),
        await realpath(join(artifact.artifactDir, 'payload')),
        `${snapshotComponent} must directly reference its canonical artifact payload`,
      );
    }
  } finally {
    await rm(stackBaseDir, { recursive: true, force: true });
  }
});

test('snapshot publication rejects a component payload outside its canonical producer artifact path', async () => {
  const stackBaseDir = await mkdtemp(join(tmpdir(), 'activate-runtime-snapshot-canonical-reference-'));

  try {
    const artifactsRoot = join(stackBaseDir, 'artifacts');
    const web = await createArtifact(artifactsRoot, 'web', { 'index.html': '<html>shared</html>' });
    const daemon = await createArtifact(artifactsRoot, 'daemon', { 'happier': '#!/bin/sh\necho daemon\n' });
    const untrustedServer = await createArtifact(
      join(stackBaseDir, 'untrusted-artifacts'),
      'server',
      { 'happier-server': '#!/bin/sh\necho server\n' },
    );

    await assert.rejects(
      publishRuntimeSnapshot({
        producerStackBaseDir: stackBaseDir,
        snapshotId: 'snapshot-untrusted-reference',
        sourceMetadata: createSourceMetadata(),
        artifacts: { web, server: untrustedServer, daemon },
      }),
      /canonical producer artifact path/i,
    );
  } finally {
    await rm(stackBaseDir, { recursive: true, force: true });
  }
});

test('selection rejects an artifact fingerprint that traverses outside its managed component store', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'runtime-snapshot-artifact-fingerprint-containment-'));
  const producerStackBaseDir = join(storageRoot, 'producer');
  const consumerStackBaseDir = join(storageRoot, 'consumer');

  try {
    const artifactsRoot = join(producerStackBaseDir, 'artifacts');
    const web = await createArtifact(artifactsRoot, 'web', { 'index.html': '<html>trusted</html>' });
    const server = await createArtifact(artifactsRoot, 'server', { 'happier-server': '#!/bin/sh\necho server\n' });
    const daemon = await createArtifact(artifactsRoot, 'daemon', { happier: '#!/bin/sh\necho daemon\n' });
    const escapedWeb = await createArtifact(artifactsRoot, 'web', { 'index.html': '<html>escaped</html>' }, {
      artifactFingerprint: '../../escaped-web',
      artifactDir: join(producerStackBaseDir, 'escaped-web'),
    });
    await assert.rejects(
      publishRuntimeSnapshot({
        producerStackBaseDir,
        snapshotId: 'snapshot-publish-escaped-artifact-fingerprint',
        sourceMetadata: createSourceMetadata(),
        artifacts: { web: escapedWeb, server, daemon },
      }),
      /invalid web artifact manifest.*artifact fingerprint.*path segment/i,
    );
    const published = await publishRuntimeSnapshot({
      producerStackBaseDir,
      snapshotId: 'snapshot-escaped-artifact-fingerprint',
      sourceMetadata: createSourceMetadata(),
      artifacts: { web, server, daemon },
    });
    await selectRuntimeSnapshot({
      consumerStackBaseDir: producerStackBaseDir,
      producerStackBaseDir,
      snapshotId: published.snapshotId,
    });
    const manifestPath = join(published.snapshotPath, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.components.web.artifactFingerprint = escapedWeb.manifest.artifactFingerprint;
    await writeRuntimeManifest({ manifestPath, manifest });
    await unlink(join(published.snapshotPath, 'ui'));
    await symlink(
      join(escapedWeb.artifactDir, 'payload'),
      join(published.snapshotPath, 'ui'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    const inspection = await inspectActiveRuntimeSnapshot({ stackBaseDir: producerStackBaseDir });
    assert.equal(inspection.valid, false);
    assert.match(inspection.errors.join('\n'), /web artifact fingerprint.*path segment/i);

    await assert.rejects(
      selectRuntimeSnapshot({
        consumerStackBaseDir,
        producerStackBaseDir,
        producerStackName: 'producer',
        snapshotId: published.snapshotId,
      }),
      /artifact fingerprint.*path segment/i,
    );
  } finally {
    await rm(storageRoot, { recursive: true, force: true });
  }
});

test('a consumer cannot select a runtime snapshot built for another platform', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'runtime-snapshot-target-'));
  const producerStackBaseDir = join(storageRoot, 'producer');
  const consumerStackBaseDir = join(storageRoot, 'consumer');

  try {
    const artifactsRoot = join(producerStackBaseDir, 'artifacts');
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

test('a self-contained v1 snapshot stays readable when matching canonical artifacts exist', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'runtime-snapshot-v1-self-contained-'));
  const producerStackBaseDir = join(storageRoot, 'producer');
  const consumerStackBaseDir = join(storageRoot, 'consumer');

  try {
    const artifactsRoot = join(producerStackBaseDir, 'artifacts');
    await createArtifact(artifactsRoot, 'web', { 'index.html': '<html>canonical web</html>' }, {
      artifactFingerprint: 'web-old',
    });
    await createArtifact(artifactsRoot, 'server', { 'happier-server': '#!/bin/sh\necho canonical server\n' }, {
      artifactFingerprint: 'server-old',
    });
    await createArtifact(artifactsRoot, 'daemon', { happier: '#!/bin/sh\necho canonical daemon\n' }, {
      artifactFingerprint: 'daemon-old',
    });
    await createSnapshotPayload(producerStackBaseDir, 'snapshot-v1-self-contained', {
      ui: { 'index.html': '<html>v1 web</html>' },
      server: { 'happier-server': '#!/bin/sh\necho v1 server\n' },
      cli: { happier: '#!/bin/sh\necho v1 daemon\n' },
    });

    const inspection = await inspectActiveRuntimeSnapshot({ stackBaseDir: producerStackBaseDir });
    assert.equal(inspection.valid, true, inspection.errors.join('\n'));

    const selected = await selectRuntimeSnapshot({
      consumerStackBaseDir,
      producerStackBaseDir,
      producerStackName: 'producer',
      snapshotId: 'snapshot-v1-self-contained',
    });
    assert.equal(selected.snapshotId, 'snapshot-v1-self-contained');
    assert.equal(
      await readFile(join(consumerStackBaseDir, 'runtime', 'current', 'ui', 'index.html'), 'utf8'),
      '<html>v1 web</html>',
    );
  } finally {
    await rm(storageRoot, { recursive: true, force: true });
  }
});

test('partial publication reuses a retained self-contained v1 component when its matching artifact still exists', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'runtime-snapshot-v1-partial-reuse-'));
  const producerStackBaseDir = join(storageRoot, 'producer');
  const consumerStackBaseDir = join(storageRoot, 'consumer');

  try {
    const artifactsRoot = join(producerStackBaseDir, 'artifacts');
    await createArtifact(artifactsRoot, 'web', { 'index.html': '<html>canonical old web</html>' }, {
      artifactFingerprint: 'web-old',
    });
    await createArtifact(artifactsRoot, 'server', { 'happier-server': '#!/bin/sh\necho canonical old server\n' }, {
      artifactFingerprint: 'server-old',
    });
    await createArtifact(artifactsRoot, 'daemon', { happier: '#!/bin/sh\necho canonical old daemon\n' }, {
      artifactFingerprint: 'daemon-old',
    });
    const webNew = await createArtifact(artifactsRoot, 'web', { 'index.html': '<html>new web</html>' }, {
      artifactFingerprint: 'web-new',
    });
    await createSnapshotPayload(producerStackBaseDir, 'snapshot-v1-current', {
      ui: { 'index.html': '<html>v1 old web</html>' },
      server: { 'happier-server': '#!/bin/sh\necho v1 old server\n' },
      cli: { happier: '#!/bin/sh\necho v1 old daemon\n' },
    });

    const published = await publishRuntimeSnapshot({
      producerStackBaseDir,
      snapshotId: 'snapshot-v1-partial',
      sourceMetadata: createSourceMetadata(),
      artifacts: { web: webNew },
    });
    const selected = await selectRuntimeSnapshot({
      consumerStackBaseDir,
      producerStackBaseDir,
      producerStackName: 'producer',
      snapshotId: published.snapshotId,
    });

    assert.equal(selected.snapshotId, 'snapshot-v1-partial');
    assert.equal(
      await readFile(join(consumerStackBaseDir, 'runtime', 'current', 'ui', 'index.html'), 'utf8'),
      '<html>new web</html>',
    );
    assert.equal(
      await readFile(join(consumerStackBaseDir, 'runtime', 'current', 'server', 'happier-server'), 'utf8'),
      '#!/bin/sh\necho v1 old server\n',
    );
    const inspection = await inspectActiveRuntimeSnapshot({
      stackBaseDir: consumerStackBaseDir,
      env: { HAPPIER_STACK_STORAGE_DIR: storageRoot },
    });
    assert.equal(inspection.valid, true, inspection.errors.join('\n'));
  } finally {
    await rm(storageRoot, { recursive: true, force: true });
  }
});

test('partial publication follows a retained self-contained v1 component reference chain', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'runtime-snapshot-v1-partial-chain-'));
  const producerStackBaseDir = join(storageRoot, 'producer');
  const consumerStackBaseDir = join(storageRoot, 'consumer');

  try {
    const artifactsRoot = join(producerStackBaseDir, 'artifacts');
    await createArtifact(artifactsRoot, 'web', { 'index.html': '<html>canonical old web</html>' }, {
      artifactFingerprint: 'web-old',
    });
    await createArtifact(artifactsRoot, 'server', { 'happier-server': '#!/bin/sh\necho canonical old server\n' }, {
      artifactFingerprint: 'server-old',
    });
    await createArtifact(artifactsRoot, 'daemon', { happier: '#!/bin/sh\necho canonical old daemon\n' }, {
      artifactFingerprint: 'daemon-old',
    });
    const webNew = await createArtifact(artifactsRoot, 'web', { 'index.html': '<html>new web</html>' }, {
      artifactFingerprint: 'web-new',
    });
    const baseSnapshotPath = await createSnapshotPayload(producerStackBaseDir, 'snapshot-v1-base', {
      ui: { 'index.html': '<html>v1 base web</html>' },
      server: { 'happier-server': '#!/bin/sh\necho v1 base server\n' },
      cli: { happier: '#!/bin/sh\necho v1 base daemon\n' },
    });
    const currentSnapshotPath = await createSnapshotPayload(producerStackBaseDir, 'snapshot-v1-current', {
      ui: { 'index.html': '<html>v1 current web</html>' },
      server: { 'happier-server': '#!/bin/sh\necho v1 replaced server\n' },
      cli: { happier: '#!/bin/sh\necho v1 replaced daemon\n' },
    });
    for (const componentDirectory of ['server', 'cli']) {
      await rm(join(currentSnapshotPath, componentDirectory), { recursive: true, force: true });
      await symlink(
        join(baseSnapshotPath, componentDirectory),
        join(currentSnapshotPath, componentDirectory),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    }
    const currentManifestPath = join(currentSnapshotPath, 'manifest.json');
    const currentManifest = JSON.parse(await readFile(currentManifestPath, 'utf8'));
    currentManifest.reusedSnapshotIds = ['snapshot-v1-base'];
    await writeRuntimeManifest({ manifestPath: currentManifestPath, manifest: currentManifest });

    const published = await publishRuntimeSnapshot({
      producerStackBaseDir,
      snapshotId: 'snapshot-v1-after-upgrade',
      sourceMetadata: createSourceMetadata(),
      artifacts: { web: webNew },
    });
    const selected = await selectRuntimeSnapshot({
      consumerStackBaseDir,
      producerStackBaseDir,
      producerStackName: 'producer',
      snapshotId: published.snapshotId,
    });

    assert.equal(selected.snapshotId, 'snapshot-v1-after-upgrade');
    assert.equal(
      await readFile(join(consumerStackBaseDir, 'runtime', 'current', 'server', 'happier-server'), 'utf8'),
      '#!/bin/sh\necho v1 base server\n',
    );
    assert.equal(
      await readFile(join(consumerStackBaseDir, 'runtime', 'current', 'cli', 'happier'), 'utf8'),
      '#!/bin/sh\necho v1 base daemon\n',
    );
    const inspection = await inspectActiveRuntimeSnapshot({
      stackBaseDir: consumerStackBaseDir,
      env: { HAPPIER_STACK_STORAGE_DIR: storageRoot },
    });
    assert.equal(inspection.valid, true, inspection.errors.join('\n'));
  } finally {
    await rm(storageRoot, { recursive: true, force: true });
  }
});

test('partial v1 reuse does not accept a retained component symlinked outside the producer snapshot', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'runtime-snapshot-v1-partial-contained-'));
  const producerStackBaseDir = join(storageRoot, 'producer');
  const consumerStackBaseDir = join(storageRoot, 'consumer');

  try {
    const artifactsRoot = join(producerStackBaseDir, 'artifacts');
    await createArtifact(artifactsRoot, 'web', { 'index.html': '<html>canonical old web</html>' }, {
      artifactFingerprint: 'web-old',
    });
    await createArtifact(artifactsRoot, 'server', { 'happier-server': '#!/bin/sh\necho canonical old server\n' }, {
      artifactFingerprint: 'server-old',
    });
    await createArtifact(artifactsRoot, 'daemon', { happier: '#!/bin/sh\necho canonical old daemon\n' }, {
      artifactFingerprint: 'daemon-old',
    });
    const webNew = await createArtifact(artifactsRoot, 'web', { 'index.html': '<html>new web</html>' }, {
      artifactFingerprint: 'web-new',
    });
    const v1SnapshotPath = await createSnapshotPayload(producerStackBaseDir, 'snapshot-v1-current', {
      ui: { 'index.html': '<html>v1 old web</html>' },
      server: { 'happier-server': '#!/bin/sh\necho v1 old server\n' },
      cli: { happier: '#!/bin/sh\necho v1 old daemon\n' },
    });
    const published = await publishRuntimeSnapshot({
      producerStackBaseDir,
      snapshotId: 'snapshot-v1-partial',
      sourceMetadata: createSourceMetadata(),
      artifacts: { web: webNew },
    });

    const externalServerPath = join(storageRoot, 'external-server');
    await mkdir(externalServerPath, { recursive: true });
    await writeFile(join(externalServerPath, 'happier-server'), '#!/bin/sh\necho untrusted server\n');
    const retainedServerPath = join(v1SnapshotPath, 'server');
    await rename(retainedServerPath, `${retainedServerPath}-physical`);
    await symlink(externalServerPath, retainedServerPath, process.platform === 'win32' ? 'junction' : 'dir');

    await assert.rejects(
      selectRuntimeSnapshot({
        consumerStackBaseDir,
        producerStackBaseDir,
        producerStackName: 'producer',
        snapshotId: published.snapshotId,
      }),
      /canonical artifact payload/i,
    );
  } finally {
    await rm(storageRoot, { recursive: true, force: true });
  }
});

test('publishing an existing valid snapshot identity reuses its artifact references despite changed provenance', async () => {
  const stackBaseDir = await mkdtemp(join(tmpdir(), 'runtime-snapshot-immutable-'));
  try {
    const artifactsRoot = join(stackBaseDir, 'artifacts');
    const web = await createArtifact(artifactsRoot, 'web', { 'index.html': '<html>first</html>' });
    const server = await createArtifact(artifactsRoot, 'server', { 'happier-server': '#!/bin/sh\necho first\n' });
    const daemon = await createArtifact(artifactsRoot, 'daemon', { happier: '#!/bin/sh\necho first\n' });
    const first = await publishRuntimeSnapshot({
      producerStackBaseDir: stackBaseDir,
      snapshotId: 'snapshot-immutable',
      sourceMetadata: createSourceMetadata(),
      artifacts: { web, server, daemon },
    });
    const second = await publishRuntimeSnapshot({
      producerStackBaseDir: stackBaseDir,
      snapshotId: 'snapshot-immutable',
      sourceMetadata: {
        ...createSourceMetadata(),
        commitSha: 'different-checkout-provenance',
        dirtyHash: 'unrelated-concurrent-work',
        sourceFingerprint: 'moving-checkout-fingerprint',
      },
      artifacts: { web, server, daemon },
    });

    assert.equal(second.reused, true);
    assert.equal(first.snapshotPath, second.snapshotPath);
    assert.equal(
      await realpath(join(second.snapshotPath, 'ui')),
      await realpath(join(web.artifactDir, 'payload')),
    );
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
    const artifactsRoot = join(producerStackBaseDir, 'artifacts');
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

test('two consumers select the valid current producer snapshot while a newer publication is incomplete', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'shared-runtime-snapshot-in-flight-'));
  const producerStackName = 'repo-happier-producer';
  const producerStackBaseDir = join(storageRoot, producerStackName);
  const firstConsumerStackBaseDir = join(storageRoot, 'qa-one');
  const secondConsumerStackBaseDir = join(storageRoot, 'qa-two');

  try {
    const artifactsRoot = join(producerStackBaseDir, 'artifacts');
    const web = await createArtifact(artifactsRoot, 'web', { 'index.html': '<html>shared</html>' });
    const server = await createArtifact(artifactsRoot, 'server', { 'happier-server': '#!/bin/sh\necho shared server\n' });
    const daemon = await createArtifact(artifactsRoot, 'daemon', { 'happier': '#!/bin/sh\necho shared daemon\n' });
    const published = await activateRuntimeSnapshot({
      stackBaseDir: producerStackBaseDir,
      snapshotId: 'snapshot-current',
      sourceMetadata: createSourceMetadata(),
      artifacts: { web, server, daemon },
    });
    await mkdir(join(producerStackBaseDir, 'runtime', 'builds', 'snapshot-publishing', 'ui'), { recursive: true });

    const [firstSelection, secondSelection] = await Promise.all([
      selectActiveProducerRuntimeSnapshot({
        consumerStackBaseDir: firstConsumerStackBaseDir,
        producerStackBaseDir,
        producerStackName,
        consumerStackName: 'qa-one',
      }),
      selectActiveProducerRuntimeSnapshot({
        consumerStackBaseDir: secondConsumerStackBaseDir,
        producerStackBaseDir,
        producerStackName,
        consumerStackName: 'qa-two',
      }),
    ]);

    assert.equal(firstSelection.snapshotId, published.snapshotId);
    assert.equal(secondSelection.snapshotId, published.snapshotId);
    assert.equal(
      await realpath(join(firstConsumerStackBaseDir, 'runtime', 'current', 'ui')),
      await realpath(join(web.artifactDir, 'payload')),
    );
    assert.equal(
      await realpath(join(secondConsumerStackBaseDir, 'runtime', 'current', 'ui')),
      await realpath(join(web.artifactDir, 'payload')),
    );
    assert.notEqual(
      await realpath(join(firstConsumerStackBaseDir, 'runtime', 'current')),
      await realpath(join(secondConsumerStackBaseDir, 'runtime', 'current')),
      'consumer selection mirrors remain independent from shared producer artifacts',
    );
  } finally {
    await rm(storageRoot, { recursive: true, force: true });
  }
});

test('selection rejects a published snapshot when its canonical support reference disappears', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'shared-runtime-snapshot-removed-support-'));
  const producerStackName = 'repo-happier-producer';
  const producerStackBaseDir = join(storageRoot, producerStackName);
  const consumerStackBaseDir = join(storageRoot, 'qa-consumer');

  try {
    const web = await createArtifact('', 'web', { 'index.html': '<html>shared</html>' }, {
      artifactDir: join(producerStackBaseDir, 'artifacts', 'web', 'web-shared'),
      artifactFingerprint: 'web-shared',
    });
    const server = await createArtifact('', 'server', { 'happier-server': '#!/bin/sh\necho shared server\n' }, {
      artifactDir: join(producerStackBaseDir, 'artifacts', 'server', 'server-shared'),
      artifactFingerprint: 'server-shared',
    });
    const support = await createArtifact('', 'daemon-support', { happier: '#!/bin/sh\necho support\n' }, {
      artifactDir: join(producerStackBaseDir, 'artifacts', 'daemon-support', 'daemon-support-shared'),
      artifactFingerprint: 'daemon-support-shared',
      includeDaemonNodeRuntime: false,
    });
    const daemon = await createArtifact('', 'daemon', { happier: '#!/bin/sh\necho shared daemon\n' }, {
      artifactDir: join(producerStackBaseDir, 'artifacts', 'daemon', 'daemon-shared'),
      artifactFingerprint: 'daemon-shared',
      extraManifest: { daemonSupportArtifactFingerprint: 'daemon-support-shared' },
    });
    const published = await activateRuntimeSnapshot({
      stackBaseDir: producerStackBaseDir,
      snapshotId: 'snapshot-shared',
      sourceMetadata: createSourceMetadata(),
      artifacts: { web, server, daemon },
    });
    await rm(support.artifactDir, { recursive: true, force: true });

    const inspection = await inspectActiveRuntimeSnapshot({ stackBaseDir: producerStackBaseDir });
    assert.equal(inspection.valid, false);
    assert.match(inspection.errors.join('\n'), /daemon support artifact.*missing|missing.*daemon support artifact/i);

    await assert.rejects(
      selectRuntimeSnapshot({
        consumerStackBaseDir,
        producerStackBaseDir,
        producerStackName,
        snapshotId: published.snapshotId,
      }),
      /daemon support artifact.*missing|missing.*daemon support artifact/i,
    );
    await assert.rejects(
      readFile(join(consumerStackBaseDir, 'runtime', 'current.json'), 'utf8'),
      { code: 'ENOENT' },
    );
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
    const artifactsRoot = join(producerStackBaseDir, 'artifacts');
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
    const artifactsRoot = join(stackBaseDir, 'artifacts');
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

test('activateRuntimeSnapshot refuses a component whose declared support artifact is missing before current changes', async () => {
  const stackBaseDir = await mkdtemp(join(tmpdir(), 'activate-runtime-snapshot-missing-support-'));

  try {
    const artifactsRoot = join(stackBaseDir, 'artifacts');
    const web = await createArtifact(artifactsRoot, 'web', { 'index.html': '<html></html>' });
    const server = await createArtifact(artifactsRoot, 'server', { 'happier-server': '#!/bin/sh\necho server\n' });
    const daemon = await createArtifact(artifactsRoot, 'daemon', { 'happier': '#!/bin/sh\necho daemon\n' });
    await writeArtifactManifest({
      artifactDir: daemon.artifactDir,
      manifest: {
        ...daemon.manifest,
        daemonSupportArtifactFingerprint: 'daemon-support-missing',
      },
    });
    daemon.manifest = JSON.parse(await readFile(join(daemon.artifactDir, 'manifest.json'), 'utf8'));

    await assert.rejects(
      activateRuntimeSnapshot({
        stackBaseDir,
        snapshotId: 'snapshot-missing-support',
        sourceMetadata: createSourceMetadata(),
        artifacts: { web, server, daemon },
      }),
      /daemon support artifact.*missing|missing.*daemon support artifact/i,
    );
    await assert.rejects(
      readFile(join(stackBaseDir, 'runtime', 'current.json'), 'utf8'),
      { code: 'ENOENT' },
    );
  } finally {
    await rm(stackBaseDir, { recursive: true, force: true });
  }
});

test('activateRuntimeSnapshot rejects daemon artifacts that flatten the node runtime beside the binary', async () => {
  const stackBaseDir = await mkdtemp(join(tmpdir(), 'activate-runtime-snapshot-flat-daemon-'));

  try {
    const artifactsRoot = join(stackBaseDir, 'artifacts');
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

    const artifactsRoot = join(stackBaseDir, 'artifacts');
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

test('repeated modern partial activations retain only the requested snapshot count', async () => {
  const stackBaseDir = await mkdtemp(join(tmpdir(), 'activate-runtime-snapshot-modern-retention-'));

  try {
    const artifactsRoot = join(stackBaseDir, 'artifacts');
    const web0 = await createArtifact(
      artifactsRoot,
      'web',
      { 'index.html': '<html>modern web 0</html>' },
      { artifactFingerprint: 'web-modern-0' },
    );
    const web1 = await createArtifact(
      artifactsRoot,
      'web',
      { 'index.html': '<html>modern web 1</html>' },
      { artifactFingerprint: 'web-modern-1' },
    );
    const web2 = await createArtifact(
      artifactsRoot,
      'web',
      { 'index.html': '<html>modern web 2</html>' },
      { artifactFingerprint: 'web-modern-2' },
    );
    const server = await createArtifact(
      artifactsRoot,
      'server',
      { 'happier-server': '#!/bin/sh\necho modern server\n' },
      { artifactFingerprint: 'server-modern' },
    );
    const daemon = await createArtifact(
      artifactsRoot,
      'daemon',
      { happier: '#!/bin/sh\necho modern daemon\n' },
      { artifactFingerprint: 'daemon-modern' },
    );

    await activateRuntimeSnapshot({
      stackBaseDir,
      snapshotId: 'modern-0',
      sourceMetadata: createSourceMetadata(),
      artifacts: { web: web0, server, daemon },
      runtimeSnapshotKeepCount: 2,
    });
    await activateRuntimeSnapshot({
      stackBaseDir,
      snapshotId: 'modern-1',
      sourceMetadata: createSourceMetadata(),
      artifacts: { web: web1 },
      runtimeSnapshotKeepCount: 2,
    });
    await activateRuntimeSnapshot({
      stackBaseDir,
      snapshotId: 'modern-2',
      sourceMetadata: createSourceMetadata(),
      artifacts: { web: web2 },
      runtimeSnapshotKeepCount: 2,
    });

    await assert.rejects(
      readFile(join(stackBaseDir, 'runtime', 'builds', 'modern-0', 'manifest.json'), 'utf8'),
      { code: 'ENOENT' },
    );
    const [modern1Manifest, modern2Manifest] = await Promise.all([
      readFile(join(stackBaseDir, 'runtime', 'builds', 'modern-1', 'manifest.json'), 'utf8').then(JSON.parse),
      readFile(join(stackBaseDir, 'runtime', 'builds', 'modern-2', 'manifest.json'), 'utf8').then(JSON.parse),
    ]);
    assert.deepEqual(modern1Manifest.reusedSnapshotIds, []);
    assert.deepEqual(modern2Manifest.reusedSnapshotIds, []);
    assert.equal(
      await realpath(join(stackBaseDir, 'runtime', 'builds', 'modern-2', 'server')),
      await realpath(join(server.artifactDir, 'payload')),
    );
    assert.equal(
      await realpath(join(stackBaseDir, 'runtime', 'builds', 'modern-2', 'cli')),
      await realpath(join(daemon.artifactDir, 'payload')),
    );
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

    const artifactsRoot = join(stackBaseDir, 'artifacts');
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

    const artifactsRoot = join(stackBaseDir, 'artifacts');
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
