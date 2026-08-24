import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { validateSdkMethodRows } from './generateActions.ts';

test('consumes the built exported Action owner instead of Protocol source internals', async () => {
  const generatorPath = fileURLToPath(new URL('./generateActions.ts', import.meta.url));
  const source = await readFile(generatorPath, 'utf8');
  assert.doesNotMatch(source, /protocol\/src\/actions\/actionSpecs/u);
  assert.match(source, /protocol\/dist\/actions\/index\.js/u);
});

test('uses the Action owner public projection rather than re-deriving eligibility', async () => {
  const generatorPath = fileURLToPath(new URL('./generateActions.ts', import.meta.url));
  const source = await readFile(generatorPath, 'utf8');

  assert.match(source, /PUBLIC_ACTION_IDS/u);
  assert.doesNotMatch(source, /isInternalActionId|isPluginProvenanceOnlyActionId/u);
});

test('force-prepares the Protocol artifact before importing the built Action owner', async () => {
  const generatorPath = fileURLToPath(new URL('./generateActions.ts', import.meta.url));
  const source = await readFile(generatorPath, 'utf8');

  assert.match(
    source,
    /ensureWorkspacePackagesBuiltByName\(repoRoot, \['@happier-dev\/protocol'\], \{[\s\S]*?force: true,[\s\S]*?publicationMode: 'artifact',[\s\S]*?\}\);[\s\S]*?import\('\.\.\/\.\.\/protocol\/dist\/actions\/index\.js'\)/u,
  );
});

test('composed typecheck reuses the governance build and checks only the test project afterward', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(
    packageJson.scripts['typecheck:local'],
    'yarn -s check:api-governance && node ../../scripts/workspaces/runTypeScriptCli.mjs --noEmit -p tsconfig.tests.json',
  );
});

test('rejects reserved generated roots', () => {
  assert.throws(
    () => validateSdkMethodRows([{ actionId: 'safe.action', methodPath: 'execute.now' }]),
    /reserved SDK root/,
  );
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
