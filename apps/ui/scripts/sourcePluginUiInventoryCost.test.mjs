// @happier-test-preparation source
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTempFixture } from '../../stack/scripts/testkit/core/temp_fixture.mjs';

test('source inventory discovers every watched input with one compiler graph in flight', async t => {
  const { mock } = await import('node:test');
  const { dirname } = await import('node:path');
  const { runCommandSync } = await import('../../stack/scripts/utils/test/test_process.mjs');
  const file = fileURLToPath(import.meta.url);
  const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
  if (process.env.HAPPIER_UI_GRAPH_COST_CHILD !== '1') {
    const result = runCommandSync(process.execPath, [
      '--experimental-test-module-mocks', '--conditions=happier-source',
      '--import', join(repoRoot, 'packages/cli-common/registerSourceRuntime.mjs'), '--test',
      '--test-name-pattern=source inventory discovers every watched input with one compiler graph in flight', file,
    ], { cwd: repoRoot, env: { ...process.env, NODE_TEST_CONTEXT: undefined, HAPPIER_UI_GRAPH_COST_CHILD: '1' },
      stdio: 'pipe', encoding: 'utf8' });
    t.diagnostic(result.stdout);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return;
  }
  const fixture = await createTempFixture(t, { prefix: 'happier-ui-graph-cost-' });
  const root = fixture.path('source');
  const uiPackageDir = join(root, 'apps/ui');
  const write = async (path, content) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  };
  await write(join(uiPackageDir, 'scripts/prepareSourcePluginUiArtifacts.mjs'), 'export {};');
  await write(join(root, 'apps/cli/package.json'), JSON.stringify({ bundledDependencies: [
    '@happier-dev/plugins-alpha', '@happier-dev/plugins-beta',
  ] }));
  for (const name of ['alpha', 'beta']) {
    await write(join(root, 'packages/plugins', name, 'package.json'), JSON.stringify({
      name: `@happier-dev/plugins-${name}`, exports: {
        './happier-plugin-ui/main': { 'happier-source': './src/ui.ts' },
      },
    }));
    await write(join(root, 'packages/plugins', name, 'src/ui.ts'), 'export const view = 1;');
  }
  let active = 0;
  let peak = 0;
  let completed = 0;
  let finishDiscovery;
  const discovered = new Promise(resolve => { finishDiscovery = resolve; });
  // Observe the external compiler service without replacing its graph logic.
  // Keep the watcher, resolver, graph projection and esbuild compilation real.
  const esbuild = await import('esbuild');
  const graphInputs = new Set();
  const build = async options => {
    active += 1;
    peak = Math.max(peak, active);
    try {
      const result = await esbuild.build(options);
      for (const path of Object.keys(result.metafile.inputs)) graphInputs.add(resolve(options.absWorkingDir, path));
      return result;
    } finally {
      active -= 1;
      completed += 1;
      if (completed === 3) finishDiscovery();
    }
  };
  const boundary = mock.module('esbuild', { namedExports: { ...esbuild, build },
    defaultExport: { ...esbuild.default, build } });
  t.after(() => boundary.restore());
  const { watchUiSourcePluginInventory } = await import('./ensureWorkspacePackagesBuilt.mjs');
  const { EventEmitter } = await import('node:events');
  const watcher = new EventEmitter();
  const metroServer = { getBundler: () => ({ getBundler: () => ({ getWatcher: () => watcher }) }) };
  const subscription = watchUiSourcePluginInventory({ uiPackageDir,
    env: { ...process.env, HAPPIER_STACK_HOME_DIR: fixture.root }, metroServer,
    logger: { error(_message, error) { throw error; } },
  });
  t.after(() => subscription.close());
  await discovered;
  assert.equal(completed, 3, 'compiler and both plugin graphs contribute their watched inputs');
  for (const path of ['apps/ui/scripts/prepareSourcePluginUiArtifacts.mjs',
    'packages/plugins/alpha/src/ui.ts', 'packages/plugins/beta/src/ui.ts']) {
    assert.ok(graphInputs.has(join(root, path)), `real compiler graph includes ${path}`);
  }
  const { readSourcePluginUiBuildInputs } = await import('../../stack/scripts/utils/fs/workspaceBuildInputs.mjs');
  await write(join(root, 'packages/plugins/alpha/src/ui.ts'), 'export { view } from "./detail";');
  await write(join(root, 'packages/plugins/alpha/src/detail.ts'), 'export const view = 2;');
  const beforeEdit = completed;
  const changedInputs = await readSourcePluginUiBuildInputs({ repoDir: root, pluginDirectory: 'alpha' });
  assert.equal(completed - beforeEdit, 1, 'one changed plugin needs one graph rediscovery');
  assert.ok(changedInputs.includes('packages/plugins/alpha/src/detail.ts'), 'rediscovery observes the changed import graph');
  assert.equal(peak, 1, 'the serving process must not overlap full compiler graphs');
  t.diagnostic(`graphs=${beforeEdit} peak=${peak} rediscoveries=${completed - beforeEdit}`);
});
