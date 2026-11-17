import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, rmSync, realpathSync, writeFileSync, unlinkSync, promises as fsPromises } from 'node:fs';
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


for (const race of [false, true]) test(`Metro excludes mutable package-manager state beside generation links (${race ? 'link replaced by file' : 'regular file'})`, async () => {
  const fixture = realpathSync(mkdtempSync(path.join(tmpdir(), 'metro-package-state-')));
  try {
    const modules = path.join(fixture, 'node_modules');
    const installed = path.join(fixture, '.happier/deps/node_modules/selected/node_modules');
    mkdirSync(path.join(installed, 'dependency'), { recursive: true });
    mkdirSync(modules);
    symlinkSync(path.join(installed, 'dependency'), path.join(modules, 'dependency'), 'junction');
    const source = path.join(installed, 'dependency/index.js');
    writeFileSync(source, 'module.exports = {};');
    const state = path.join(modules, '.pnpm-workspace-state-v1.json');
    writeFileSync(state, '{}');
    const readlink = fsPromises.readlink;
    if (race) {
      unlinkSync(state);
      symlinkSync(source, state);
      // Filesystem boundary: reproduce pnpm replacing its discovered link
      // with a regular state file before Metro's deferred readlink syscall.
      fsPromises.readlink = async (candidate, ...args) => {
        if (candidate === state) { unlinkSync(state); writeFileSync(state, '{}'); }
        return readlink(candidate, ...args);
      };
    }
    try {
      const config = await require('metro-config').getDefaultConfig(fixture);
      config.resolver.blockList = require('../metro.config.js').resolver.blockList;
      config.watchFolders = [fixture, ...resolveInstalledModuleWatchRoots([modules])];
      config.resolver.useWatchman = false;
      config.maxWorkers = 1;
      config.resetCache = true;
      config.fileMapCacheDirectory = path.join(fixture, 'cache');
      mkdirSync(config.fileMapCacheDirectory);
      config.reporter = { update() {} };
      const Graph = require('metro/private/node-haste/DependencyGraph').default;
      const graph = new Graph(config, { watch: false });
      try {
        await graph.ready();
        assert.equal(graph.doesFileExist(source), true);
        assert.equal(graph.doesFileExist(state), false,
          'mutable package-manager state must never enter Metro symlink/file processing');
      } finally { await graph.end(); }
    } finally { fsPromises.readlink = readlink; }
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});
