import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

test('retains the portable production hosted-reference package contract', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const manifest = JSON.parse(await readFile(new URL('../.happier-plugin/plugin.json', import.meta.url), 'utf8'));
  const definitionSource = await readFile(new URL('../definition.ts', import.meta.url), 'utf8');
  const daemonSource = await readFile(new URL('../daemon.ts', import.meta.url), 'utf8');
  const hostedSurface = await readFile(new URL('../ui/reviewPanel.web.ts', import.meta.url), 'utf8');
  const hostedRenderer = manifest.contributes.ui.renderers.find((renderer) => renderer.id === 'review-hosted');

  assert.equal(packageJson.scripts['build:ui'], 'happier-plugin-build-ui --project-root .');
  assert.ok(packageJson.files.includes('assets'));
  assert.ok(packageJson.files.includes('resources'));
  assert.equal(manifest.id, 'examples.production-hosted-reference');
  assert.match(definitionSource, /definePlugin\s*\(/u);
  assert.doesNotMatch(daemonSource, /api\.actions\.register/u);
  assert.deepEqual(manifest.brand, { iconResourceId: 'brand-icon' });
  assert.deepEqual(
    manifest.contributes.resources.find((resource) => resource.id === 'brand-icon'),
    {
      id: 'brand-icon',
      source: 'packaged',
      kind: 'asset',
      path: 'assets/brand.png',
      contentType: 'image/png',
    },
  );
  assert.deepEqual(hostedRenderer.requiredHostMethods, ['context', 'executeAction', 'readResource', 'openSurface']);
  assert.match(hostedSurface, /readResource\('review-guide'/u);
  assert.match(hostedSurface, /context\.subPath/u);
  assert.match(hostedSurface, /context\.launchInput/u);
  assert.match(hostedSurface, /openSurface\(\s*'review-dashboard'/u);
  assert.match(hostedSurface, /context\.signal\.addEventListener\('abort'/u);
  assert.match(hostedSurface, /watchContext/u);
  assert.match(hostedSurface, /executeAction\(\s*'refresh-review'/u);
  assert.doesNotMatch(hostedSurface, /(?:createObjectURL|data:image|<img)/u);
  assert.doesNotMatch(hostedSurface, /(?:window\.parent|location\.(?:search|hash)|URLSearchParams)/u);
});
