import assert from 'node:assert/strict';
import test from 'node:test';
import { access, readFile } from 'node:fs/promises';

test('retains the portable React Native package contract', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const manifest = JSON.parse(await readFile(new URL('../.happier-plugin/plugin.json', import.meta.url), 'utf8'));

  assert.ok(packageJson.dependencies['@happier-dev/plugin-ui']);
  assert.equal(manifest.id, 'examples.react-native-installed');
  const { views, renderers } = manifest.contributes.ui;
  const native = renderers.find(renderer => renderer.id === views[0].renderer);
  assert.equal(native?.kind, 'reactNative');
  assert.deepEqual(views[0].fallbackRenderers.map(id => renderers.find(renderer => renderer.id === id)?.kind), ['declarative']);
  const entry = packageJson.exports[`./happier-plugin-ui/${native.artifact}`];
  assert.equal(typeof entry, 'string');
  await access(new URL(entry, new URL('../', import.meta.url)));
});
