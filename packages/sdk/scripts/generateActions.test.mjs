import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { validateSdkMethodRows } from './generateActions.ts';

test('consumes the canonical Protocol Action source owner without a mutable dist build', async () => {
  const generatorPath = fileURLToPath(new URL('./generateActions.ts', import.meta.url));
  const source = await readFile(generatorPath, 'utf8');
  assert.match(source, /protocol\/src\/actions\/actionSpecs\.js/u);
  assert.doesNotMatch(source, /protocol\/dist|ensureWorkspacePackagesBuiltByName/u);
});

test('uses the Action owner public projection rather than re-deriving eligibility', async () => {
  const generatorPath = fileURLToPath(new URL('./generateActions.ts', import.meta.url));
  const source = await readFile(generatorPath, 'utf8');

  assert.match(source, /PUBLIC_ACTION_IDS/u);
  assert.doesNotMatch(source, /isInternalActionId|isPluginProvenanceOnlyActionId/u);
});

test('does not mutate shared workspace artifacts while resolving Action rows', async () => {
  const generatorPath = fileURLToPath(new URL('./generateActions.ts', import.meta.url));
  const source = await readFile(generatorPath, 'utf8');

  assert.doesNotMatch(source, /ensureWorkspacePackagesBuiltByName|writeFile[^\n]*protocol/u);
  assert.match(source, /return PUBLIC_ACTION_IDS[\s\S]*getActionSpec[\s\S]*resolveActionSdkMethodName/u);
});

test('composed typecheck reuses the governance build and checks only the test project afterward', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(
    packageJson.scripts['typecheck:local'],
    'yarn -s check:api-governance && node ../../scripts/workspaces/runTypeScriptCli.mjs --noEmit -p tsconfig.tests.json',
  );
});

test('rejects reserved generated roots', () => {
  for (const reservedRoot of ['execute', 'get', 'search', 'invoke']) {
    assert.throws(
      () => validateSdkMethodRows([{ actionId: 'safe.action', methodPath: `${reservedRoot}.now` }]),
      /reserved SDK root/,
    );
  }
});

test('rejects exact and namespace-prefix collisions', () => {
  assert.throws(
    () => validateSdkMethodRows([
      { actionId: 'first', methodPath: 'session.open' },
      { actionId: 'second', methodPath: 'session.open' },
    ]),
    /share SDK method path/,
  );
  assert.throws(
    () => validateSdkMethodRows([
      { actionId: 'first', methodPath: 'session.open' },
      { actionId: 'second', methodPath: 'session.open.now' },
    ]),
    /conflict at SDK namespace/,
  );
});
