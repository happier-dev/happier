import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { prepareServerWorkspacePrerequisites } from './buildSharedDeps.mjs';

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const adapterSource = await readFile(new URL('./buildSharedDeps.mjs', import.meta.url), 'utf8');

test('server shared prerequisites delegate to the canonical stale-only workspace owner', () => {
  assert.match(adapterSource, /ensureWorkspacePackagesBuiltForComponent/);
  assert.doesNotMatch(adapterSource, /\bexecFileSync\b|\brunTsc\b/);
});

test('server shared prerequisite adapter passes its package root and caller environment to the canonical owner', async () => {
  const calls = [];
  const env = { CI: '1' };
  const result = await prepareServerWorkspacePrerequisites({
    env,
    quiet: true,
    ensureWorkspacePackagesBuiltForComponent: async (...args) => {
      calls.push(args);
      return { ok: true, built: [], skipped: [] };
    },
  });

  assert.equal(calls.length, 1);
  assert.match(String(calls[0][0]), /apps\/server$/);
  assert.deepEqual(calls[0][1], { env, quiet: true });
  assert.deepEqual(result, { ok: true, built: [], skipped: [] });
});

test('server lifecycle retains shared runtime preparation and schema verification for executing tests', () => {
  assert.match(packageJson.scripts.pretest, /\bbuild:shared\b/);
  assert.match(packageJson.scripts.pretest, /\bschema:sync:check\b/);
  assert.match(packageJson.scripts['typecheck:runtime'], /\bbuild:shared\b/);
});
