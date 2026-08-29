import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { bundleWorkspacePackageDependencies } from './bundleWorkspacePackageDependencies.mjs';

test('one root owner admits package outputs before taking the shared publication lock', async () => {
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
      assert.equal(childEnv.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD, undefined);
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
    consumePreparedWorkspace: async ({ preparedWorkspaceEnv, bundles }) => {
      assert.equal(preparedWorkspaceEnv.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD, 'held-by-test');
      events.push(['consume', bundles.length]);
    },
  });

  assert.deepEqual(events, [
    ['admit', '/repo', ['@happier-dev/cli-common'], true, true],
    ['resolve', '/repo/packages/example'],
    ['admit', '/repo', ['@happier-dev/protocol', '@happier-dev/agents'], true, true],
    ['lock', '/repo/.project/tmp/workspace-bundle.lock'],
    ['publish', 3, 'artifact'],
    ['consume', 3],
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

test('prepared readers stay inside the shared publication lock and inherit its lease', async () => {
  const observedLeases = [];
  let sharedPublicationLockHeld = false;

  await bundleWorkspacePackageDependencies({
    repoRoot: '/repo',
    hostPackageDir: '/repo/packages/plugin-sdk',
    publicationMode: 'live',
    env: {
      HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD: 'plugin-sdk-package-lease',
      HAPPIER_WORKSPACE_DIST_OUTPUT_DIR: '/tmp/plugin-sdk-stage',
      HAPPIER_WORKSPACE_PACKAGE_PREREQUISITES_READY: '1',
    },
    withWorkspaceBundleLock: async (publish, options) => {
      assert.equal(options.heldLockValue, 'plugin-sdk-package-lease');
      sharedPublicationLockHeld = true;
      try {
        return await publish({ heldLockValue: 'shared-publication-lease' });
      } finally {
        sharedPublicationLockHeld = false;
      }
    },
    ensureWorkspacePackagesBuiltByName: async (_root, packageNames, options) => {
      observedLeases.push([
        `admit:${packageNames.join(',')}`,
        options.env.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD,
      ]);
      return { ok: true, built: [], skipped: packageNames };
    },
    loadCliCommonWorkspacesModule: async (_root, childEnv) => {
      observedLeases.push([
        'load-publication-owner',
        childEnv.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD,
      ]);
      return {
        resolveWorkspaceBundlesFromPackageJson: () => [{ packageName: '@happier-dev/protocol' }],
        bundleWorkspacePackagesWithRuntimeDependencies: (options) => {
          assert.equal(sharedPublicationLockHeld, true);
          assert.equal(options.pruneStale, true);
          observedLeases.push(['publish-shared-dependencies']);
        },
      };
    },
    consumePreparedWorkspace: async ({ preparedWorkspaceEnv }) => {
      assert.equal(
        sharedPublicationLockHeld,
        true,
        'prepared readers must stay inside the dependency publication lock',
      );
      observedLeases.push([
        'consume-prepared-package',
        preparedWorkspaceEnv.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD,
        preparedWorkspaceEnv.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR,
        preparedWorkspaceEnv.HAPPIER_WORKSPACE_PACKAGE_PREREQUISITES_READY,
      ]);
    },
    pruneStale: true,
  });

  assert.deepEqual(observedLeases, [
    ['load-publication-owner', 'plugin-sdk-package-lease'],
    ['admit:@happier-dev/protocol', 'plugin-sdk-package-lease'],
    ['publish-shared-dependencies'],
    ['consume-prepared-package', 'shared-publication-lease', '/tmp/plugin-sdk-stage', '1'],
  ]);
});

test('a nested publication inside the prepared reader reenters the held lock instead of deadlocking', async () => {
  // Uses the real lock so the reentry contract is proven, not simulated. `prepack:prepared`
  // republishes the dependency graph in artifact mode while the outer prepared reader is still
  // running, so the reader's environment must carry the lease that owns the held lock.
  const lockDir = await mkdtemp(join(tmpdir(), 'happier-workspace-bundle-lock-'));
  const lockPath = join(lockDir, 'cli-dist-build.lock');
  const publications = [];
  const createWorkspaceModule = (label) => async () => ({
    resolveWorkspaceBundlesFromPackageJson: () => [{ packageName: '@happier-dev/protocol' }],
    bundleWorkspacePackagesWithRuntimeDependencies: () => publications.push(label),
  });

  try {
    await bundleWorkspacePackageDependencies({
      repoRoot: '/repo',
      hostPackageDir: '/repo/packages/plugin-sdk',
      publicationMode: 'live',
      quiet: true,
      lockPath,
      // A regression must fail fast here rather than blocking the suite for the default timeout.
      lockTimeoutMs: 4_000,
      lockPollIntervalMs: 25,
      env: {},
      ensureWorkspacePackagesBuiltByName: async () => ({ ok: true, built: [], skipped: [] }),
      loadCliCommonWorkspacesModule: createWorkspaceModule('outer'),
      consumePreparedWorkspace: async ({ preparedWorkspaceEnv }) => {
        await bundleWorkspacePackageDependencies({
          repoRoot: '/repo',
          hostPackageDir: '/repo/packages/plugin-sdk',
          publicationMode: 'artifact',
          quiet: true,
          lockPath,
          lockTimeoutMs: 4_000,
          lockPollIntervalMs: 25,
          env: preparedWorkspaceEnv,
          ensureWorkspacePackagesBuiltByName: async () => ({ ok: true, built: [], skipped: [] }),
          loadCliCommonWorkspacesModule: createWorkspaceModule('nested'),
        });
      },
    });
  } finally {
    await rm(lockDir, { recursive: true, force: true });
  }

  assert.deepEqual(publications, ['outer', 'nested']);
});
