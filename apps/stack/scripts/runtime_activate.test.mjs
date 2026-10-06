import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';

import { activateRuntimeForAuthority } from './runtime_activate.mjs';

test('runtime activation discovers artifacts outside the snapshot lock and commits only under that lock', async () => {
  const events = [];
  let snapshotLockHeld = false;
  let publicationLockHeld = false;
  const authority = {
    consumerStackName: 'qa-consumer',
    consumerStackBaseDir: '/stacks/qa-consumer',
    producerStackName: 'repo-producer',
    producerStackBaseDir: '/stacks/repo-producer',
  };

  const result = await activateRuntimeForAuthority({
    rootDir: '/repo',
    stackName: 'qa-consumer',
    selectedComponents: { web: false, server: true, daemon: false },
    authority,
    env: {},
    retentionPolicy: { runtimeSnapshotKeepCount: 2, artifactKeepCount: 2 },
    collectBuildSourceMetadataImpl: async () => {
      assert.equal(snapshotLockHeld, false);
      events.push('source-metadata');
      return {
        sourceFingerprint: 'provenance-only',
        builtAt: '2026-08-16T12:00:00.000Z',
        serverComponent: 'happier-server-light',
        dbProvider: 'sqlite',
      };
    },
    resolveLatestComponentArtifactImpl: async ({ component }) => {
      assert.equal(component, 'server');
      events.push(snapshotLockHeld ? 'resolve-server-at-commit' : 'resolve-server');
      return {
        artifactDir: '/stacks/repo-producer/artifacts/server/server-new',
        manifest: { artifactFingerprint: 'server-new' },
      };
    },
    withWorkspaceBundleLockImpl: async (fn, options) => {
      if (options.lockPath === join(authority.producerStackBaseDir, 'runtime', 'publication.lock')) {
        publicationLockHeld = true;
        try { return await fn({ waited: false }); } finally { publicationLockHeld = false; }
      }
      assert.equal(publicationLockHeld, true);
      assert.equal(options.lockPath, join(authority.producerStackBaseDir, 'runtime', 'build.lock'));
      snapshotLockHeld = true;
      try {
        return await fn({ waited: false });
      } finally {
        snapshotLockHeld = false;
      }
    },
    inspectActiveRuntimeSnapshotImpl: async () => {
      assert.equal(snapshotLockHeld, true);
      events.push('validate-current');
      return {
        valid: true,
        manifest: {
          components: {
            web: { artifactFingerprint: 'web-current' },
            server: { artifactFingerprint: 'server-current' },
            daemon: { artifactFingerprint: 'daemon-current' },
          },
        },
      };
    },
    publishRuntimeSnapshotImpl: async (input) => {
      assert.equal(snapshotLockHeld, true);
      assert.equal(input.pruneAfterPublish, false);
      events.push('publish-manifest');
      return {
        snapshotId: input.snapshotId,
        snapshotPath: `/stacks/repo-producer/runtime/builds/${input.snapshotId}`,
        reused: false,
      };
    },
    selectRuntimeSnapshotImpl: async (input) => {
      assert.equal(snapshotLockHeld, true);
      events.push(input.consumerStackBaseDir === authority.producerStackBaseDir ? 'select-producer' : 'select-consumer');
      return {
        snapshotId: input.snapshotId,
        snapshotPath: `/stacks/repo-producer/runtime/builds/${input.snapshotId}`,
        currentPath: `${input.consumerStackBaseDir}/runtime/current.json`,
      };
    },
    pruneRuntimeSnapshotsImpl: async () => {
      assert.equal(snapshotLockHeld, false);
      assert.equal(publicationLockHeld, true);
      events.push('retention');
    },
    ensureStackRuntimeModePreferImpl: async () => {
      assert.equal(snapshotLockHeld, false);
      events.push('runtime-mode');
    },
  });

  assert.deepEqual(events, [
    'source-metadata',
    'resolve-server',
    'validate-current',
    'publish-manifest',
    'select-producer',
    'retention',
    'select-consumer',
    'runtime-mode',
  ]);
  assert.equal(result.runtime.consumerStackName, 'qa-consumer');
  assert.equal(result.runtime.producerStackName, 'repo-producer');
});

test('runtime activation discovers artifacts after publication admission and retains them through commit', async () => {
  let snapshotLockHeld = false;
  let publicationLockHeld = false;
  let resolveCount = 0;
  const authority = {
    consumerStackName: 'qa-consumer',
    consumerStackBaseDir: '/stacks/qa-consumer',
    producerStackName: 'repo-producer',
    producerStackBaseDir: '/stacks/repo-producer',
  };

  const result = await activateRuntimeForAuthority({
    rootDir: '/repo',
    stackName: 'qa-consumer',
    selectedComponents: { web: false, server: true, daemon: false },
    authority,
    env: {},
    retentionPolicy: { runtimeSnapshotKeepCount: 2, artifactKeepCount: 2 },
    collectBuildSourceMetadataImpl: async () => ({
      sourceFingerprint: 'provenance-only',
      builtAt: '2026-08-17T12:00:00.000Z',
      serverComponent: 'happier-server-light',
      dbProvider: 'sqlite',
    }),
    resolveLatestComponentArtifactImpl: async ({ component }) => {
      assert.equal(component, 'server');
      assert.equal(publicationLockHeld, true);
      assert.equal(snapshotLockHeld, false);
      resolveCount += 1;
      return {
        artifactDir: '/stacks/repo-producer/artifacts/server/server-new',
        manifest: { artifactFingerprint: 'server-new' },
      };
    },
    withWorkspaceBundleLockImpl: async (fn, options) => {
      if (options.lockPath.endsWith('publication.lock')) {
        publicationLockHeld = true;
        try { return await fn({ waited: true }); } finally { publicationLockHeld = false; }
      }
      snapshotLockHeld = true;
      try {
        return await fn({ waited: true });
      } finally {
        snapshotLockHeld = false;
      }
    },
    inspectActiveRuntimeSnapshotImpl: async () => ({
      valid: true,
      manifest: {
        components: {
          web: { artifactFingerprint: 'web-current' },
          server: { artifactFingerprint: 'server-new' },
          daemon: { artifactFingerprint: 'daemon-current' },
        },
      },
    }),
    publishRuntimeSnapshotImpl: async (input) => {
      assert.equal(input.artifacts.server.manifest.artifactFingerprint, 'server-new');
      return {
        snapshotId: input.snapshotId,
        snapshotPath: `/stacks/repo-producer/runtime/builds/${input.snapshotId}`,
        reused: false,
      };
    },
    selectRuntimeSnapshotImpl: async (input) => ({
      snapshotId: input.snapshotId,
      snapshotPath: `/stacks/repo-producer/runtime/builds/${input.snapshotId}`,
      currentPath: `${input.consumerStackBaseDir}/runtime/current.json`,
    }),
    pruneRuntimeSnapshotsImpl: async () => {},
    ensureStackRuntimeModePreferImpl: async () => {},
  });

  assert.equal(resolveCount, 1);
  assert.equal(result.artifacts.server.manifest.artifactFingerprint, 'server-new');
});
