import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

test('retains the portable code-defined package contract', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

  assert.equal(packageJson.happier.manifest, '.happier-plugin/plugin.json');
  assert.deepEqual(packageJson.files, ['dist']);
});
