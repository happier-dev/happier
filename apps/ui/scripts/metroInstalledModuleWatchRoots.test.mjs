import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, rmSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
const require = createRequire(import.meta.url);
const { resolveInstalledModuleWatchRoots } = require('./metroInstalledModuleWatchRoots.cjs');

test('installed watch roots retain the selected generation without crawling retained generations', async () => {
  const fixture = realpathSync(mkdtempSync(path.join(tmpdir(), 'metro-generation-')));
  try {
    const generationStore = path.join(fixture, '.happier/deps/node_modules');
    const selected = path.join(generationStore, 'selected/node_modules');
    const retained = path.join(generationStore, 'retained/node_modules');
    const appModules = path.join(fixture, 'apps/ui/node_modules');
    const authored = path.join(fixture, 'packages/authored');
    for (const dir of [selected, retained, appModules, authored]) mkdirSync(dir, { recursive: true });
    for (const pkg of ['react', '@scope/dependency']) {
      const target = path.join(selected, pkg);
      const link = path.join(appModules, pkg);
      mkdirSync(target, { recursive: true });
      mkdirSync(path.dirname(link), { recursive: true });
      symlinkSync(target, link, 'junction');
    }
    symlinkSync(authored, path.join(appModules, 'authored'), 'junction');
    assert.deepEqual([...resolveInstalledModuleWatchRoots([appModules])], [selected]);
    const entry = path.join(selected, 'react/index.js');
    writeFileSync(entry, 'module.exports = {};');
    const config = await require('metro-config').getDefaultConfig(path.dirname(appModules));
    config.watchFolders = [...resolveInstalledModuleWatchRoots([appModules])];
    config.resolver.useWatchman = false;
    config.maxWorkers = 1;
    config.resetCache = true;
    config.fileMapCacheDirectory = path.join(fixture, 'cache');
    mkdirSync(config.fileMapCacheDirectory);
    config.reporter = { update() {} };
    const Graph = require('metro/private/node-haste/DependencyGraph').default;
    const graph = new Graph(config, { watch: true });
    try {
      await graph.ready();
      assert.equal(graph.doesFileExist(entry), true);
    } finally { await graph.end(); }
    // An ordinary, unlinked tree stays with the existing watch policy.
    assert.deepEqual([...resolveInstalledModuleWatchRoots([selected])], []);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});
