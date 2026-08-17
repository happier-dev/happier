import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

test('retains the portable hosted-web package contract', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const manifest = JSON.parse(await readFile(new URL('../.happier-plugin/plugin.json', import.meta.url), 'utf8'));
  const hostedSurface = await readFile(new URL('../ui/panel.web.tsx', import.meta.url), 'utf8');
  const hostedRenderer = manifest.contributes.ui.renderers.find((renderer) => renderer.id === 'panel-web');

  assert.equal(packageJson.scripts['build:ui'], 'happier-plugin-build-ui --project-root .');
  assert.equal(manifest.id, 'examples.hosted-web');
  assert.deepEqual(hostedRenderer?.requiredHostMethods, ['context', 'executeAction']);
  const capabilityDiscoveryMethods = new Set(['version', 'watchContext']);
  const directHostMethods = new Set(
    [...hostedSurface.matchAll(/\bcontext\.hostApi\.(\w+)\s*\(/gu)]
      .map(([, method]) => method)
      .filter((method) => !capabilityDiscoveryMethods.has(method)),
  );
  for (const method of directHostMethods) {
    assert.ok(
      hostedRenderer?.requiredHostMethods.includes(method),
      `panel-web must declare direct host method ${method}`,
    );
  }
  assert.match(
    hostedSurface,
    /watchContext\(\(surface\) => applyContext\(root, surface\), \{ signal: context\.signal \}\)/u,
  );
  assert.match(
    hostedSurface,
    /executeAction\('save-note', \{ note: 'Hosted web example' \}, \{ signal: context\.signal \}\)/u,
  );
});
