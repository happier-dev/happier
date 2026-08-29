import assert from 'node:assert/strict';
import test from 'node:test';

import { prepareRemoteValidationWorkspace } from './remote_validation_preparation.mjs';

test('remote validation preparation delegates component dependency outputs to the canonical workspace owner', async () => {
  const calls = [];
  const publicationCalls = [];
  const result = await prepareRemoteValidationWorkspace({
    repoDir: '/remote/happier',
    componentRelativeDir: 'apps/cli',
    env: { TEST_ENV: '1' },
    loadWorkspaceBuildOwner: async () => ({
      ensureWorkspacePackagesBuiltForComponent: async (...args) => {
        calls.push(args);
        return { ok: true, built: ['@happier-dev/plugins-codex'], skipped: [] };
      },
    }),
    loadCliBuildOwner: async () => ({
      resolveCliBundledWorkspacePackageNames: (options) => {
        assert.deepEqual(options, { repoRoot: '/remote/happier' });
        // Exact mixed CLI bundled selection shape: host workspaces plus bundled
        // plugins, as produced by the canonical bundled workspace resolver.
        return ['protocol', 'agents', 'plugins-codex', 'plugins-claude'];
      },
      publishBundledPluginArtifactsAfterWorkspaceBuild: async (options) => {
        publicationCalls.push(options);
        return true;
      },
    }),
  });

  assert.deepEqual(calls, [[
    '/remote/happier/apps/cli',
    { env: { TEST_ENV: '1' } },
  ]]);
  assert.deepEqual(result, {
    ok: true,
    built: ['@happier-dev/plugins-codex'],
    skipped: [],
  });
  assert.deepEqual(publicationCalls, [{
    repoRoot: '/remote/happier',
    workspaceNames: ['protocol', 'agents', 'plugins-codex', 'plugins-claude'],
    env: { TEST_ENV: '1' },
    bundledPluginArtifactPublication: { mode: 'write' },
  }]);
});

test('remote validation preparation does not publish CLI projections for unrelated components', async () => {
  let loadedCliOwner = false;
  await prepareRemoteValidationWorkspace({
    repoDir: '/remote/happier',
    componentRelativeDir: 'packages/protocol',
    loadWorkspaceBuildOwner: async () => ({
      ensureWorkspacePackagesBuiltForComponent: async () => ({ ok: true, built: [], skipped: [] }),
    }),
    loadCliBuildOwner: async () => {
      loadedCliOwner = true;
      throw new Error('unrelated component must not load the CLI publisher');
    },
  });
  assert.equal(loadedCliOwner, false);
});

test('remote UI validation prepares the complete CLI plugin closure before publishing replica artifacts', async () => {
  const events = [];
  await prepareRemoteValidationWorkspace({
    repoDir: '/remote/happier',
    componentRelativeDir: 'apps/ui',
    loadWorkspaceBuildOwner: async () => ({
      ensureWorkspacePackagesBuiltForComponent: async (componentDir) => {
        events.push(`prepare:${componentDir}`);
        return { ok: true, built: [], skipped: [] };
      },
    }),
    loadCliBuildOwner: async () => ({
      resolveCliBundledWorkspacePackageNames: () => ['protocol', 'plugins-codex'],
      publishBundledPluginArtifactsAfterWorkspaceBuild: async () => {
        events.push('publish');
        return true;
      },
    }),
  });
  assert.deepEqual(events, [
    'prepare:/remote/happier/apps/ui',
    'prepare:/remote/happier/apps/cli',
    'publish',
  ]);
});

test('remote validation preparation rejects paths outside the synchronized repository', async () => {
  await assert.rejects(
    prepareRemoteValidationWorkspace({
      repoDir: '/remote/happier',
      componentRelativeDir: '../outside',
    }),
    /inside the synchronized repository/i,
  );
});
