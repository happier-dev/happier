import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  readRuntimeManifest,
  readRuntimePointer,
  resolveRuntimeManifestEntrypoint,
  validateRuntimeManifest,
  writeRuntimeManifest,
  writeRuntimePointer,
} from './runtime_manifest.mjs';

async function withTempRoot(t) {
  const root = await mkdtemp(join(tmpdir(), 'hstack-runtime-manifest-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  return root;
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

test('resolveRuntimeManifestEntrypoint normalizes contained paths and rejects escaping paths', () => {
  assert.equal(
    resolveRuntimeManifestEntrypoint({
      snapshotPath: '/tmp/runtime/builds/snap-1',
      manifest: {
        components: {
          server: { entrypoint: './server/../server/happier-server' },
        },
      },
      component: 'server',
    }),
    '/tmp/runtime/builds/snap-1/server/happier-server',
  );

  assert.equal(
    resolveRuntimeManifestEntrypoint({
      snapshotPath: '/tmp/runtime/builds/snap-1',
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
