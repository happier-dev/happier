import assert from 'node:assert/strict';
import test from 'node:test';
import { access, readFile } from 'node:fs/promises';

test('retains the portable multi-mode package contract', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const manifest = JSON.parse(await readFile(new URL('../.happier-plugin/plugin.json', import.meta.url), 'utf8'));
  const hostedSurface = await readFile(new URL('../ui/panel.web.ts', import.meta.url), 'utf8');

  assert.ok(packageJson.dependencies['@happier-dev/plugin-ui']);
  assert.equal(manifest.id, 'examples.multi-mode-fallback');
  assert.match(
    hostedSurface,
    /watchContext\(\(surface\) => applyContext\(root, surface\), \{ signal: context\.signal \}\)/u,
  );
  const { views, renderers } = manifest.contributes.ui;
  const view = views[0];
  const chain = [view.renderer, ...view.fallbackRenderers]
    .map(id => renderers.find(renderer => renderer.id === id));
  assert.deepEqual(chain.map(renderer => renderer?.kind), ['reactNative', 'hostedWeb', 'declarative']);
  const entry = packageJson.exports[`./happier-plugin-ui/${chain[0].artifact}`];
  assert.equal(typeof entry, 'string');
  await access(new URL(entry, new URL('../', import.meta.url)));
});
