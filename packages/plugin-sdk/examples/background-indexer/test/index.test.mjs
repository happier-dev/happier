import assert from 'node:assert/strict';
import test from 'node:test';
import { access, readFile } from 'node:fs/promises';

async function read(relativePath) {
  return await readFile(new URL(relativePath, import.meta.url), 'utf8');
}

async function exists(relativePath) {
  try {
    await access(new URL(relativePath, import.meta.url));
    return true;
  } catch {
    return false;
  }
}

// These assertions describe the authoring contract, not one exact database
// generation: the packed migration/reload gate rewrites this same source into
// successor versions and reruns this test against each of them.
test('declares a public-only daemon database Background Indexer through definePlugin', async () => {
  const packageJson = JSON.parse(await read('../package.json'));
  const source = await read('../src/index.ts');

  assert.equal(packageJson.name, '@example/happier-background-indexer');
  assert.deepEqual(Object.keys(packageJson.dependencies), ['@happier-dev/plugin-sdk']);
  assert.equal(packageJson.happier.manifest, '.happier-plugin/plugin.json');
  assert.deepEqual(packageJson.files, ['dist']);

  // The cold manifest is projected by the author build from this one source
  // module; a hand-maintained second spelling must not come back.
  assert.equal(await exists('../.happier-plugin/plugin.json'), false);

  assert.match(source, /from '@happier-dev\/plugin-sdk';/u);
  assert.match(source, /from '@happier-dev\/plugin-sdk\/background-services';/u);
  assert.match(source, /export const \{ manifest, activate \} = definePlugin\(\{/u);
  assert.match(source, /id: 'examples\.background-indexer'/u);
  assert.match(source, /entrypoints: \{ daemon: '\.\/dist\/index\.js' \}/u);
  assert.match(source, /version: 1,\n\s+id: 'create-workspace-index'/u);
  assert.match(source, /incumbentQueryFixture: Object\.freeze\(\{\n\s+id: 'workspace-index-v\d/u);
  assert.match(source, /title: 'Index workspace documents'/u);
  assert.match(source, /runner: runWorkspaceIndexer,/u);
  assert.match(source, /storage\.daemon\.database\(/u);
  assert.match(source, /context\.signal/u);
  assert.doesNotMatch(source, /(?:apps\/cli|node:sqlite|bun:sqlite|setInterval|setTimeout|Worker)/u);
});
