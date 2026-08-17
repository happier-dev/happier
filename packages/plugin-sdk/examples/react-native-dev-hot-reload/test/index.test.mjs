import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

test('retains the portable development React Native package contract', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const manifest = JSON.parse(await readFile(new URL('../.happier-plugin/plugin.json', import.meta.url), 'utf8'));

  assert.ok(packageJson.dependencies['@happier-dev/plugin-ui']);
  assert.equal(manifest.id, 'examples.react-native-dev-hot-reload');
});
