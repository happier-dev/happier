import assert from 'node:assert/strict';
import test from 'node:test';

import {
  REMOTE_INITIAL_DEPENDENCY_INSTALL_ARGS,
  bootstrapRemoteDependencies,
} from './remote_dependency_bootstrap.mjs';

test('0.2 remote bootstrap installs without lifecycle scripts before loading the workspace dependency owner', async () => {
  assert.deepEqual(REMOTE_INITIAL_DEPENDENCY_INSTALL_ARGS, [
    'install', '--production=false', '--ignore-engines', '--ignore-scripts', '--pure-lockfile',
  ]);
  const calls = [];
  await bootstrapRemoteDependencies({
    repoDir: '/remote/0.2',
    env: { HAPPIER_STACK_PM_CACHE_BASE_DIR: '/remote/cache' },
    packageExists: () => false,
    withDependencyRefresh: async (_options, refresh) => await refresh(),
    installInitialDependencies: async () => calls.push('install'),
    loadWorkspaceBuildOwner: async () => ({
      ensureWorkspacePackagesBuiltByName: async () => calls.push('build-owner'),
    }),
    loadDependencyOwner: async () => {
      calls.push('load-owner');
      return { ensureDepsInstalled: async () => calls.push('ensure') };
    },
  });
  assert.deepEqual(calls, ['install', 'build-owner', 'load-owner', 'ensure']);
});
