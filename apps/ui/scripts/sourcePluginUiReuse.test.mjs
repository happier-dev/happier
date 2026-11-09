// @happier-test-preparation source
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createTempFixture } from '../../stack/scripts/testkit/core/temp_fixture.mjs';
import { runCommandSync } from '../../stack/scripts/utils/test/test_process.mjs';

test('unchanged captured plugin UI inputs run zero graph or artifact compilers', async t => {
  const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
  if (process.env.HAPPIER_UI_REUSE_COST_CHILD !== '1') {
    const result = runCommandSync(process.execPath, ['--experimental-test-module-mocks',
      '--conditions=happier-source', '--import', join(repoRoot, 'packages/cli-common/registerSourceRuntime.mjs'),
      '--test', fileURLToPath(import.meta.url)], {
      cwd: repoRoot, env: { ...process.env, NODE_TEST_CONTEXT: undefined, HAPPIER_UI_REUSE_COST_CHILD: '1' },
      stdio: 'pipe', encoding: 'utf8',
    });
    t.diagnostic(result.stdout);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return;
  }
  const fixture = await createTempFixture(t, { prefix: 'happier-ui-input-reuse-' });
  const sourceRoot = fixture.path('source');
  const write = async (path, bytes) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
  };
  const plugins = ['alpha', 'beta'].map(directory => ({ directory, manifest: {
    schemaVersion: 2, id: `happier.${directory}`, version: '0.0.0', displayName: directory,
    runtime: { apiVersion: 1 }, contributes: { ui: {
      renderers: [{ id: 'panel', kind: 'reactNative', artifact: 'panel' }],
      views: [{ id: 'panel', container: 'appPage', target: { kind: 'app' }, renderer: 'panel', title: directory }],
    } },
  } }));
  await write(join(sourceRoot, 'apps/ui/package.json'), JSON.stringify({ name: '@fixture/ui' }));
  for (const { directory } of plugins) {
    const root = join(sourceRoot, 'packages/plugins', directory);
    await write(join(root, 'package.json'), JSON.stringify({ name: `@happier-dev/plugins-${directory}`,
      version: '0.0.0', exports: { './happier-plugin-ui/panel': { 'happier-source': './src/ui.ts' } } }));
    await write(join(root, 'src/ui.ts'), 'export { renderSurface } from "./panel";');
    await write(join(root, 'src/panel/index.ts'), 'export function renderSurface() { return "original-panel"; }');
  }
  // Count the genuine external compiler service while preserving both its
  // graph discovery and the canonical artifact compiler's real output.
  const esbuild = await import('esbuild');
  const originalBuild = esbuild.build;
  const counts = { graphs: 0, artifacts: 0 };
  const build = async options => {
    if (options.plugins?.some(plugin => plugin.name === 'source-plugin-ui-inputs')) counts.graphs += 1;
    return originalBuild(options);
  };
  const boundary = mock.module('esbuild', { namedExports: { ...esbuild, build },
    defaultExport: { ...esbuild.default, build } });
  t.after(() => boundary.restore());
  const originalWriteFile = fs.promises.writeFile;
  t.mock.method(fs.promises, 'writeFile', (path, ...args) => {
    if (String(path).startsWith(fixture.root) && /[\\/]preparation[\\/](alpha|beta)\.json$/.test(String(path))) counts.artifacts += 1;
    return originalWriteFile(path, ...args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const { readSourcePluginUiBuildInputs, readSourcePluginUiBuildInputRecord } = await import('../../stack/scripts/utils/fs/workspaceBuildInputs.mjs');
  await write(join(sourceRoot, 'apps/ui/scripts/prepareSourcePluginUiArtifacts.mjs'), 'export const compiler = true;');
  const compilerFiles = await readSourcePluginUiBuildInputs({ repoDir: sourceRoot, compiler: true });
  const compilerInputs = await readSourcePluginUiBuildInputRecord({ repoDir: sourceRoot, files: compilerFiles });
  await write(join(sourceRoot, 'apps/ui/sources/unrelated.ts'), 'export const unrelated = true;');
  counts.graphs = 0;
  await readSourcePluginUiBuildInputs({ repoDir: sourceRoot, compiler: true, retainedInputs: compilerInputs });
  assert.equal(counts.graphs, 0, 'unconsumed source directories do not invalidate the scripts-only compiler graph');
  const { prepareSourcePluginUiArtifacts } = await import('./prepareSourcePluginUiArtifacts.mjs');
  const prepare = async (capture, retainedInventoryPath, sourceImportConditions) => {
    const capturedRoot = fixture.path(capture, 'workspace');
    await cp(sourceRoot, capturedRoot, { recursive: true });
    const outputDir = fixture.path(capture, 'preparation');
    const artifactOutputDirs = Object.fromEntries(plugins.map(({ directory }) => [directory,
      fixture.path(capture, 'runtime/plugins', directory, 'dist/happier-plugin-ui')]));
    const result = await prepareSourcePluginUiArtifacts({ repoRoot: capturedRoot, outputDir, plugins,
      outputPath: fixture.path(capture, 'runtime/inventory.js'), artifactOutputDirs, retainedInventoryPath, sourceImportConditions });
    assert.deepEqual(result.pluginFailures, []);
    return result;
  };
  const first = await prepare('first');
  assert.ok(counts.graphs > 0);
  assert.equal(counts.artifacts, 2);
  counts.graphs = counts.artifacts = 0;
  const second = await prepare('second', first.outputPath);
  t.diagnostic(`unchanged capture graphs=${counts.graphs} artifacts=${counts.artifacts}`);
  assert.deepEqual(counts, { graphs: 0, artifacts: 0 }, 'unchanged authored inputs need no compiler work');
  const original = await readFile(join(second.artifactRoots.alpha, 'react-native/panel/entry.cjs.bundle'), 'utf8');
  const { WORKSPACE_PACKAGE_BUILD_INPUT_RECORD } = await import('../../../packages/cli-common/packageBuildOutputTargets.mjs');
  for (const root of Object.values(second.artifactRoots)) {
    const path = join(root, WORKSPACE_PACKAGE_BUILD_INPUT_RECORD);
    const { compilerInputs, sourceInputs, ...legacy } = JSON.parse(await readFile(path, 'utf8'));
    await writeFile(path, JSON.stringify(legacy));
  }
  counts.graphs = counts.artifacts = 0;
  const legacy = await prepare('legacy', second.outputPath);
  assert.ok(counts.graphs > 0, 'legacy records rediscover input graphs without optional retained metadata');
  assert.equal(counts.artifacts, 0, 'legacy records retain valid artifacts');

  // New source membership can change resolution without editing any previously
  // consumed file: ./panel.ts wins over ./panel/index.ts.
  await write(join(sourceRoot, 'packages/plugins/alpha/src/panel.ts'),
    'export function renderSurface() { return "new-source-panel"; }');
  counts.graphs = counts.artifacts = 0;
  const changed = await prepare('changed', legacy.outputPath);
  assert.ok(counts.graphs > 0, 'new input membership must rediscover import resolution');
  assert.equal(counts.artifacts, 1, 'only the changed UI graph needs artifact compilation');
  const changedBytes = await readFile(join(changed.artifactRoots.alpha, 'react-native/panel/entry.cjs.bundle'), 'utf8');
  assert.match(changedBytes, /new-source-panel/);
  assert.notEqual(changedBytes, original);

  await write(join(sourceRoot, 'packages/plugins/alpha/src/panel/index.ts'),
    'export function renderSurface() { return "unused-old-source"; }');
  counts.graphs = counts.artifacts = 0;
  const unchanged = await prepare('unconsumed', changed.outputPath);
  assert.deepEqual(counts, { graphs: 0, artifacts: 0 }, 'an unconsumed source edit needs no compiler work');

  await rm(join(unchanged.artifactRoots.alpha, 'react-native/panel/entry.cjs.bundle'));
  counts.graphs = counts.artifacts = 0;
  const repaired = await prepare('repaired', unchanged.outputPath);
  assert.equal(counts.artifacts, 1, 'input reuse must still repair an incomplete retained artifact graph');
  assert.equal(await readFile(join(repaired.artifactRoots.alpha, 'react-native/panel/entry.cjs.bundle'), 'utf8'), changedBytes);

  counts.graphs = counts.artifacts = 0;
  const differentConditions = await prepare('conditions', repaired.outputPath, ['browser']);
  assert.ok(counts.graphs > 0, 'changed resolver conditions must rediscover the graph');
  assert.equal(counts.artifacts, 2, 'resolver conditions are compiler inputs for both plugins');
  counts.graphs = counts.artifacts = 0;
  await prepare('same-conditions', differentConditions.outputPath, ['browser']);
  assert.deepEqual(counts, { graphs: 0, artifacts: 0 }, 'unchanged resolver conditions retain zero compiler work');
});
