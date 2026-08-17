import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

async function read(relativePath) {
  return await readFile(new URL(relativePath, import.meta.url), 'utf8');
}

test('declares a public-only daemon database Background Indexer', async () => {
  const packageJson = JSON.parse(await read('../package.json'));
  const manifest = JSON.parse(await read('../.happier-plugin/plugin.json'));
  const source = await read('../src/index.ts');

  assert.equal(packageJson.name, '@example/happier-background-indexer');
  assert.deepEqual(Object.keys(packageJson.dependencies), ['@happier-dev/plugin-sdk']);
  assert.equal(manifest.id, 'examples.background-indexer');
  assert.equal(manifest.entrypoints.daemon, './dist/index.js');
  assert.deepEqual(manifest.contributes.daemonDatabases, [{
    id: 'workspace-index',
    migrations: [{ version: 1, id: 'create-workspace-index' }],
    incumbentQueryFixtureId: 'workspace-index-v1',
  }]);
  assert.deepEqual(manifest.contributes.backgroundServices, [{
    id: 'workspace-indexer',
    title: 'Index workspace documents',
  }]);
  assert.match(source, /from '@happier-dev\/plugin-sdk';/u);
  assert.match(source, /from '@happier-dev\/plugin-sdk\/background-services';/u);
  assert.match(source, /storage\.daemon\.database\(/u);
  assert.match(source, /backgroundServices\.register\('workspace-indexer'/u);
  assert.match(source, /context\.signal/u);
  assert.doesNotMatch(source, /(?:apps\/cli|node:sqlite|bun:sqlite|setInterval|setTimeout|Worker)/u);
});
