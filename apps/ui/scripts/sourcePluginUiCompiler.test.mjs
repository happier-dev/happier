// @happier-test-preparation source
import '../../../packages/cli-common/registerSourceRuntime.mjs';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { dirname, join } from 'node:path';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { createTempFixture } from '../../stack/scripts/testkit/core/temp_fixture.mjs';

test('source Plugin UI compilation succeeds with the SDK dist compiler unavailable', async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-ui-source-compiler-' });
  const repoRoot = fixture.path('repo');
  const write = async (path, bytes) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
  };
  await write(join(repoRoot, 'apps/ui/package.json'), JSON.stringify({ name: '@fixture/ui' }));
  await write(join(repoRoot, 'packages/plugin-sdk/package.json'), JSON.stringify({
    name: '@happier-dev/plugin-sdk', exports: { '.': './src/index.ts' },
  }));
  await write(join(repoRoot, 'packages/plugin-sdk/src/index.ts'), 'export const host = true;');
  const projectRoot = join(repoRoot, 'packages/plugins/alpha');
  await write(join(projectRoot, 'package.json'), JSON.stringify({
    name: '@happier-dev/plugins-alpha', version: '0.0.0', exports: {
      './manifest': './src/manifest.ts',
      './happier-plugin-ui/panel': { 'happier-source': './src/ui.ts' },
    },
  }));
  await write(join(projectRoot, 'src/manifest.ts'), 'export const PLUGIN_MANIFEST = {};');
  await write(join(projectRoot, 'src/ui.ts'),
    'export async function renderSurface() { await Promise.resolve(); return "source-only"; }');
  const manifest = {
    schemaVersion: 2, id: 'happier.alpha', version: '0.0.0', displayName: 'alpha',
    runtime: { apiVersion: 1 }, contributes: { ui: {
      renderers: [{ id: 'panel', kind: 'reactNative', artifact: 'panel' }],
      views: [{ id: 'panel', container: 'appPage', target: { kind: 'app' }, renderer: 'panel', title: 'alpha' }],
    } },
  };
  // The module resolver is an OS/runtime boundary. Leave the real compiler,
  // graph discovery, artifact validation and publication beneath it intact.
  const hook = registerHooks({ resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    if (resolved.url.includes('/packages/plugin-sdk/dist/ui/build/')) {
      throw Object.assign(new Error('Fixture SDK dist compiler is unavailable'), { code: 'ENOENT' });
    }
    return resolved;
  } });
  t.after(() => hook.deregister());
  const { prepareSourcePluginUiArtifacts } = await import('./prepareSourcePluginUiArtifacts.mjs');
  const result = await prepareSourcePluginUiArtifacts({ repoRoot, outputDir: fixture.path('output'),
    plugins: [{ directory: 'alpha', manifest }] });
  assert.deepEqual(result.pluginFailures, []);
  const bundle = await readFile(join(result.artifactRoots.alpha, 'react-native/panel/entry.cjs.bundle'), 'utf8');
  assert.doesNotMatch(bundle, /\basync\s+function\b/u, 'the current compiler lowers async for native guests');
  const module = { exports: {} };
  runInNewContext(bundle, { module, exports: module.exports });
  assert.equal(await module.exports.renderSurface(), 'source-only');
});
