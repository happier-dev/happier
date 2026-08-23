import assert from 'node:assert/strict';
import test from 'node:test';

import { bundleWorkspacePackageDependencies } from './bundleWorkspacePackageDependencies.mjs';

test('one root owner resolves, admits, and publishes a package workspace closure under the shared lock', async () => {
  const events = [];

  await bundleWorkspacePackageDependencies({
    repoRoot: '/repo',
    hostPackageDir: '/repo/packages/example',
    publicationMode: 'artifact',
    quiet: true,
    lockPath: '/repo/.project/tmp/workspace-bundle.lock',
    withWorkspaceBundleLock: async (publish, options) => {
      events.push(['lock', options.lockPath]);
      return await publish({ heldLockValue: 'held-by-test' });
    },
    ensureWorkspacePackagesBuiltByName: async (repoRoot, packageNames, options) => {
      events.push(['admit', repoRoot, packageNames, options.force, options.quiet]);
      return { ok: true, built: packageNames, skipped: [] };
    },
    loadCliCommonWorkspacesModule: async (_repoRoot, childEnv, admit, options) => {
      assert.equal(childEnv.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD, 'held-by-test');
      assert.equal(options.publicationMode, 'artifact');
      await admit('/repo', ['@happier-dev/cli-common'], options);
      return {
        resolveWorkspaceBundlesFromPackageJson: ({ hostPackageDir }) => {
          events.push(['resolve', hostPackageDir]);
          return [
            { packageName: '@happier-dev/protocol' },
            { packageName: '@happier-dev/agents' },
            { packageName: '@happier-dev/protocol' },
          ];
        },
        bundleWorkspacePackagesWithRuntimeDependencies: ({ bundles, publicationMode }) => {
          events.push(['publish', bundles.length, publicationMode]);
        },
      };
    },
  });

  assert.deepEqual(events, [
    ['lock', '/repo/.project/tmp/workspace-bundle.lock'],
    ['admit', '/repo', ['@happier-dev/cli-common'], true, true],
    ['resolve', '/repo/packages/example'],
    ['admit', '/repo', ['@happier-dev/protocol', '@happier-dev/agents'], true, true],
    ['publish', 3, 'artifact'],
  ]);
});

test('live publication remains incremental and preserves an already-held lock identity', async () => {
  const admissions = [];

  await bundleWorkspacePackageDependencies({
    repoRoot: '/repo',
    hostPackageDir: '/repo/packages/example',
    publicationMode: 'live',
    heldLockValue: 'outer-owner',
    withWorkspaceBundleLock: async (publish, options) => {
      assert.equal(options.heldLockValue, 'outer-owner');
      return await publish({ heldLockValue: 'outer-owner' });
    },
    ensureWorkspacePackagesBuiltByName: async (_root, packageNames, options) => {
      admissions.push({ packageNames, force: options.force });
      return { ok: true, built: [], skipped: packageNames };
    },
    loadCliCommonWorkspacesModule: async (_root, _env, admit, options) => {
      await admit('/repo', ['@happier-dev/cli-common'], options);
      return {
        resolveWorkspaceBundlesFromPackageJson: () => [{ packageName: '@happier-dev/protocol' }],
        bundleWorkspacePackagesWithRuntimeDependencies: () => {},
      };
    },
  });

  assert.deepEqual(admissions, [
    { packageNames: ['@happier-dev/cli-common'], force: false },
    { packageNames: ['@happier-dev/protocol'], force: undefined },
  ]);
});
