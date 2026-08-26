import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseWorkspaceBuildArgs,
  runWorkspacePackageBuild,
} from './ensureWorkspacePackagesBuiltCli.mjs';

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

test('the root package-build adapter prepares component dependency closures through the canonical owner', async () => {
  const calls = [];
  const result = await runWorkspacePackageBuild({
    repoRoot: '/repo',
    componentDirs: ['apps/cli', 'apps/server', 'apps/cli'],
    ensureWorkspacePackagesBuiltForComponentImpl: async (componentDir, options) => {
      calls.push({ componentDir, options });
      return { ok: true, built: [componentDir.split('/').at(-1)], skipped: [] };
    },
  });

  assert.deepEqual(calls, [
    { componentDir: '/repo/apps/cli', options: { publicationMode: 'live' } },
    { componentDir: '/repo/apps/server', options: { publicationMode: 'live' } },
  ]);
  assert.deepEqual(result, { ok: true, built: ['cli', 'server'], skipped: [] });
});

test('the root package-build CLI separates package names from component preparation paths', () => {
  assert.deepEqual(parseWorkspaceBuildArgs([
    '@happier-dev/protocol',
    '--for-component=apps/cli',
    '--for-component=apps/server',
  ]), {
    packageNames: ['@happier-dev/protocol'],
    componentDirs: ['apps/cli', 'apps/server'],
  });
});
