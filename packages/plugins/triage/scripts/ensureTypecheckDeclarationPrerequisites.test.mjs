import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('source typecheck admits only the declarations its package boundary consumes', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

  assert.equal(packageJson.scripts.pretypecheck, undefined);
  assert.equal(
    packageJson.scripts['typecheck:local'],
    'node ./scripts/ensureTypecheckDeclarationPrerequisites.mjs && node ../../../scripts/workspaces/runTypeScriptCli.mjs --noEmit -p tsconfig.json',
  );
  assert.doesNotMatch(packageJson.scripts['typecheck:local'], /buildSharedDeps|prepare:declarations|syncBundled/u);
});

test('the declaration prerequisite delegates the exact source-typecheck closure to the package build owner', async () => {
  const { ensureTypecheckDeclarationPrerequisites } = await import(
    new URL('./ensureTypecheckDeclarationPrerequisites.mjs', import.meta.url),
  );
  const calls = [];
  const env = { HAPPIER_SOURCE_TYPECHECK: '1' };

  const result = await ensureTypecheckDeclarationPrerequisites({
    repoRoot: '/repo',
    env,
    quiet: true,
    ensureWorkspacePackagesBuiltByName: async (...args) => {
      calls.push(args);
      return { ok: true, built: ['@happier-dev/triage-protocol'], skipped: [] };
    },
  });

  assert.deepEqual(calls, [[
    '/repo',
    [
      '@happier-dev/plugin-sdk',
      '@happier-dev/plugin-ui',
      '@happier-dev/triage-protocol',
    ],
    {
      env,
      includeDevDependencies: false,
      quiet: true,
    },
  ]]);
  assert.deepEqual(result, {
    ok: true,
    built: ['@happier-dev/triage-protocol'],
    skipped: [],
  });
});
