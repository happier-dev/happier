import test from 'node:test';
import assert from 'node:assert/strict';

import { readBundledWorkspaceSyncConfig } from './readBundledWorkspaceSyncConfig.mjs';

test('readBundledWorkspaceSyncConfig resolves repo-backed sync metadata for runtime snapshots', () => {
  const config = readBundledWorkspaceSyncConfig({
    snapshot: {
      snapshotPath: '/tmp/stack/runtime/builds/snap-1',
      launchPath: '/tmp/stack/runtime/current',
      manifest: {
        source: {
          repoDir: '/repo',
        },
      },
    },
    existsSync: (candidate) => candidate === '/repo/scripts/workspaces/syncBundledWorkspacePackages.mjs',
  });

  assert.deepEqual(config, {
    repoRoot: '/repo',
    helperPath: '/repo/scripts/workspaces/syncBundledWorkspacePackages.mjs',
    targetPackageRoot: '/tmp/stack/runtime/current/cli',
  });
});

test('readBundledWorkspaceSyncConfig stays disabled when the runtime manifest does not record a repo root', () => {
  const config = readBundledWorkspaceSyncConfig({
    snapshot: {
      snapshotPath: '/tmp/stack/runtime/builds/snap-1',
      manifest: {},
    },
    existsSync: () => true,
  });

  assert.equal(config, null);
});

test('readBundledWorkspaceSyncConfig stays disabled when the sync helper does not exist in the source repo', () => {
  const config = readBundledWorkspaceSyncConfig({
    snapshot: {
      snapshotPath: '/tmp/stack/runtime/builds/snap-1',
      manifest: {
        source: {
          repoDir: '/repo',
        },
      },
    },
    existsSync: () => false,
  });

  assert.equal(config, null);
});
