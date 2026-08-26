import assert from 'node:assert/strict';
import test from 'node:test';

import { prepareRemoteValidationWorkspace } from './remote_validation_preparation.mjs';

test('remote validation preparation delegates component dependency outputs to the canonical workspace owner', async () => {
  const calls = [];
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
