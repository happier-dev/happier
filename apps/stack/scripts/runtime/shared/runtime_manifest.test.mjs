import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  isRetainedLegacyRuntimeSnapshotComponentReference,
  readRuntimeManifest,
  readRuntimePointer,
  resolveRuntimeManifestEntrypoint,
  validateRuntimeManifest,
  writeRuntimeManifest,
  writeRuntimePointer,
} from './runtime_manifest.mjs';
import { writeRuntimeSnapshotLayout } from '../../testkit/core/runtime_snapshot_layout.mjs';

async function withTempRoot(t) {
  const root = await mkdtemp(join(tmpdir(), 'hstack-runtime-manifest-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

async function replaceSnapshotComponentWithReference({
  snapshotPath,
  componentDirectory,
  targetPath,
  reusedSnapshotIds,
}) {
  await rm(join(snapshotPath, componentDirectory), { recursive: true, force: true });
  await symlink(targetPath, join(snapshotPath, componentDirectory), process.platform === 'win32' ? 'junction' : 'dir');
  const manifestPath = join(snapshotPath, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.reusedSnapshotIds = reusedSnapshotIds;
  await writeRuntimeManifest({ manifestPath, manifest });
}

test('runtime manifest round-trips through disk', async (t) => {
  const root = await withTempRoot(t);
  const manifestPath = join(root, 'manifest.json');
  const manifest = {
    version: 1,
    snapshotId: 'snap-1',
    sourceFingerprint: 'src-1',
    components: {
      web: { artifactFingerprint: 'web-1', entrypoint: 'ui/index.html' },
      server: { artifactFingerprint: 'srv-1', entrypoint: 'server/happier-server' },
      daemon: { artifactFingerprint: 'cli-1', entrypoint: 'cli/happier' },
    },
  };

  await writeRuntimeManifest({ manifestPath, manifest });
  const readBack = await readRuntimeManifest({ manifestPath });

  assert.deepEqual(readBack, manifest);
});

test('runtime pointer round-trips through disk', async (t) => {
  const root = await withTempRoot(t);
  const currentPath = join(root, 'current.json');

  await writeRuntimePointer({
    currentPath,
    pointer: { version: 1, snapshotId: 'snap-1', snapshotPath: '/tmp/snap-1', sourceFingerprint: 'src-1' },
  });
  const pointer = await readRuntimePointer({ currentPath });

  assert.deepEqual(pointer, {
    version: 1,
    snapshotId: 'snap-1',
    snapshotPath: '/tmp/snap-1',
    sourceFingerprint: 'src-1',
  });
});

test('validateRuntimeManifest requires web, server, and daemon entrypoints', () => {
  const result = validateRuntimeManifest({
    version: 1,
    snapshotId: 'snap-1',
    sourceFingerprint: 'src-1',
    components: {
      web: { artifactFingerprint: 'web-1', entrypoint: 'ui/index.html' },
      server: { artifactFingerprint: 'srv-1', entrypoint: '' },
      daemon: { artifactFingerprint: 'cli-1', entrypoint: 'cli/happier' },
    },
  });

  assert.equal(result.ok, false);
  assert.match(result.errors[0] ?? '', /server entrypoint/i);
});

test('validateRuntimeManifest rejects component entrypoints that escape the snapshot root', () => {
  const result = validateRuntimeManifest({
    version: 1,
    snapshotId: 'snap-1',
    sourceFingerprint: 'src-1',
    components: {
      web: { artifactFingerprint: 'web-1', entrypoint: 'ui/index.html' },
      server: { artifactFingerprint: 'srv-1', entrypoint: '../outside-server' },
      daemon: { artifactFingerprint: 'cli-1', entrypoint: 'cli/happier' },
    },
  });

  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /server entrypoint must stay within the snapshot root/i);
});

test('validateRuntimeManifest rejects snapshot ids that can escape a runtime builds directory', () => {
  for (const snapshotId of ['../escaped', '/absolute-snapshot', 'nested/snapshot', 'nested\\snapshot']) {
    const result = validateRuntimeManifest({
      version: 1,
      snapshotId,
      sourceFingerprint: 'src-1',
      components: {
        web: { artifactFingerprint: 'web-1', entrypoint: 'ui/index.html' },
        server: { artifactFingerprint: 'srv-1', entrypoint: 'server/happier-server' },
        daemon: { artifactFingerprint: 'cli-1', entrypoint: 'cli/happier' },
      },
    });

    assert.equal(result.ok, false, snapshotId);
    assert.match(result.errors.join('\n'), /snapshot id.*path segment/i);
  }
});

test('validateRuntimeManifest rejects component artifact fingerprints that can escape a managed artifact store', () => {
  for (const artifactFingerprint of ['../../escaped-web', '/absolute-artifact', 'nested/artifact', 'nested\\artifact']) {
    const result = validateRuntimeManifest({
      version: 1,
      snapshotId: 'snap-1',
      sourceFingerprint: 'src-1',
      components: {
        web: { artifactFingerprint, entrypoint: 'ui/index.html' },
        server: { artifactFingerprint: 'srv-1', entrypoint: 'server/happier-server' },
        daemon: { artifactFingerprint: 'cli-1', entrypoint: 'cli/happier' },
      },
    });

    assert.equal(result.ok, false, artifactFingerprint);
    assert.match(result.errors.join('\n'), /web artifact fingerprint.*path segment/i);
  }
});

test('legacy component traversal follows only declared contained predecessor references', async (t) => {
  const stackBaseDir = await withTempRoot(t);
  const base = await writeRuntimeSnapshotLayout({ stackDir: stackBaseDir, snapshotId: 'legacy-base' });
  const middle = await writeRuntimeSnapshotLayout({ stackDir: stackBaseDir, snapshotId: 'legacy-middle' });
  await replaceSnapshotComponentWithReference({
    snapshotPath: middle.snapshotDir,
    componentDirectory: 'server',
    targetPath: join(base.snapshotDir, 'server'),
    reusedSnapshotIds: ['legacy-base'],
  });
  const current = await writeRuntimeSnapshotLayout({ stackDir: stackBaseDir, snapshotId: 'legacy-current' });
  await replaceSnapshotComponentWithReference({
    snapshotPath: current.snapshotDir,
    componentDirectory: 'server',
    targetPath: join(middle.snapshotDir, 'server'),
    reusedSnapshotIds: ['legacy-middle'],
  });

  assert.equal(await isRetainedLegacyRuntimeSnapshotComponentReference({
    producerStackBaseDir: stackBaseDir,
    componentPath: join(current.snapshotDir, 'server'),
    component: 'server',
    reusedSnapshotIds: ['legacy-middle'],
  }), true);

  const external = await writeRuntimeSnapshotLayout({ stackDir: stackBaseDir, snapshotId: 'legacy-external' });
  const externalPayload = join(stackBaseDir, 'external-server');
  await mkdir(externalPayload, { recursive: true });
  await writeFile(join(externalPayload, 'happier-server'), '#!/bin/sh\necho external\n');
  await rm(join(external.snapshotDir, 'server'), { recursive: true, force: true });
  await symlink(externalPayload, join(external.snapshotDir, 'server'), process.platform === 'win32' ? 'junction' : 'dir');
  const externalManifestPath = join(external.snapshotDir, 'manifest.json');
  const externalManifest = JSON.parse(await readFile(externalManifestPath, 'utf8'));
  externalManifest.reusedSnapshotIds = ['legacy-base'];
  await writeRuntimeManifest({ manifestPath: externalManifestPath, manifest: externalManifest });
  const externalCurrent = await writeRuntimeSnapshotLayout({ stackDir: stackBaseDir, snapshotId: 'legacy-external-current' });
  await replaceSnapshotComponentWithReference({
    snapshotPath: externalCurrent.snapshotDir,
    componentDirectory: 'server',
    targetPath: join(external.snapshotDir, 'server'),
    reusedSnapshotIds: ['legacy-external'],
  });

  assert.equal(await isRetainedLegacyRuntimeSnapshotComponentReference({
    producerStackBaseDir: stackBaseDir,
    componentPath: join(externalCurrent.snapshotDir, 'server'),
    component: 'server',
    reusedSnapshotIds: ['legacy-external'],
  }), false);

  const externalAlias = join(stackBaseDir, 'external-base-server-alias');
  await symlink(join(base.snapshotDir, 'server'), externalAlias, process.platform === 'win32' ? 'junction' : 'dir');
  const aliased = await writeRuntimeSnapshotLayout({ stackDir: stackBaseDir, snapshotId: 'legacy-aliased' });
  await replaceSnapshotComponentWithReference({
    snapshotPath: aliased.snapshotDir,
    componentDirectory: 'server',
    targetPath: externalAlias,
    reusedSnapshotIds: ['legacy-base'],
  });
  const aliasedCurrent = await writeRuntimeSnapshotLayout({ stackDir: stackBaseDir, snapshotId: 'legacy-aliased-current' });
  await replaceSnapshotComponentWithReference({
    snapshotPath: aliasedCurrent.snapshotDir,
    componentDirectory: 'server',
    targetPath: join(aliased.snapshotDir, 'server'),
    reusedSnapshotIds: ['legacy-aliased'],
  });

  assert.equal(await isRetainedLegacyRuntimeSnapshotComponentReference({
    producerStackBaseDir: stackBaseDir,
    componentPath: join(aliasedCurrent.snapshotDir, 'server'),
    component: 'server',
    reusedSnapshotIds: ['legacy-aliased'],
  }), false);

  const traversal = await writeRuntimeSnapshotLayout({ stackDir: stackBaseDir, snapshotId: 'legacy-traversal' });
  await replaceSnapshotComponentWithReference({
    snapshotPath: traversal.snapshotDir,
    componentDirectory: 'server',
    targetPath: join(base.snapshotDir, 'server'),
    reusedSnapshotIds: ['../escaped'],
  });
  const traversalCurrent = await writeRuntimeSnapshotLayout({ stackDir: stackBaseDir, snapshotId: 'legacy-traversal-current' });
  await replaceSnapshotComponentWithReference({
    snapshotPath: traversalCurrent.snapshotDir,
    componentDirectory: 'server',
    targetPath: join(traversal.snapshotDir, 'server'),
    reusedSnapshotIds: ['legacy-traversal'],
  });

  assert.equal(await isRetainedLegacyRuntimeSnapshotComponentReference({
    producerStackBaseDir: stackBaseDir,
    componentPath: join(traversalCurrent.snapshotDir, 'server'),
    component: 'server',
    reusedSnapshotIds: ['legacy-traversal'],
  }), false);

  const cycleA = await writeRuntimeSnapshotLayout({ stackDir: stackBaseDir, snapshotId: 'legacy-cycle-a' });
  const cycleB = await writeRuntimeSnapshotLayout({ stackDir: stackBaseDir, snapshotId: 'legacy-cycle-b' });
  await replaceSnapshotComponentWithReference({
    snapshotPath: cycleA.snapshotDir,
    componentDirectory: 'server',
    targetPath: join(base.snapshotDir, 'server'),
    reusedSnapshotIds: ['legacy-cycle-b'],
  });
  await replaceSnapshotComponentWithReference({
    snapshotPath: cycleB.snapshotDir,
    componentDirectory: 'server',
    targetPath: join(base.snapshotDir, 'server'),
    reusedSnapshotIds: ['legacy-cycle-a'],
  });

  assert.equal(await isRetainedLegacyRuntimeSnapshotComponentReference({
    producerStackBaseDir: stackBaseDir,
    componentPath: join(cycleA.snapshotDir, 'server'),
    component: 'server',
    reusedSnapshotIds: ['legacy-cycle-b'],
  }), false);
});

test('resolveRuntimeManifestEntrypoint normalizes contained paths and rejects escaping paths', () => {
  const snapshotPath = join('tmp', 'runtime', 'builds', 'snap-1');
  assert.equal(
    resolveRuntimeManifestEntrypoint({
      snapshotPath,
      manifest: {
        components: {
          server: { entrypoint: './server/../server/happier-server' },
        },
      },
      component: 'server',
    }),
    join(snapshotPath, 'server', 'happier-server'),
  );

  assert.equal(
    resolveRuntimeManifestEntrypoint({
      snapshotPath,
      manifest: {
        components: {
          server: { entrypoint: '../outside-server' },
        },
      },
      component: 'server',
    }),
    '',
  );
});
