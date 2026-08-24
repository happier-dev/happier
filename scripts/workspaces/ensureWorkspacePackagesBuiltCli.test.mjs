import assert from 'node:assert/strict';
import test from 'node:test';

import { runWorkspacePackageBuild } from './ensureWorkspacePackagesBuiltCli.mjs';

test('the root package-build adapter delegates one package set to the canonical currentness owner', async () => {
  const calls = [];
  const result = await runWorkspacePackageBuild({
    repoRoot: '/repo',
    packageNames: ['alpha', 'beta', 'alpha'],
    ensureWorkspacePackagesBuiltByNameImpl: async (repoRoot, packageNames, options) => {
      calls.push({ repoRoot, packageNames, options });
      return { ok: true, built: ['beta'], skipped: [] };
    },
  });

  assert.deepEqual(calls, [{
    repoRoot: '/repo',
    packageNames: ['alpha', 'beta'],
    options: { publicationMode: 'live' },
  }]);
  assert.deepEqual(result, { ok: true, built: ['beta'], skipped: [] });
});

test('the root package-build adapter rejects an empty package selection', async () => {
  await assert.rejects(
    runWorkspacePackageBuild({ repoRoot: '/repo', packageNames: [] }),
    /requires at least one workspace package name/,
  );
});
