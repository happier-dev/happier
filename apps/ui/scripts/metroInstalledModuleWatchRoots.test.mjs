import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, rmSync, realpathSync, writeFileSync, unlinkSync, promises as fsPromises } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
const require = createRequire(import.meta.url);
const uiRoot = path.resolve(import.meta.dirname, '..');
const { resolveInstalledModuleWatchRoots } = require('./metroInstalledModuleWatchRoots.cjs');
const { waitForMetroFileMap } = await import('./ensureWorkspacePackagesBuilt.mjs');

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


test('Metro admits a newly generated locale bundle before its index is published', async () => {
  const fixture = realpathSync(mkdtempSync(path.join(tmpdir(), 'metro-locale-admission-')));
  try {
    const locales = path.join(fixture, 'apps/ui/.expo/hstack/locales');
    mkdirSync(locales, { recursive: true });
    const asset = path.join(locales, `${'b'.repeat(64)}.locale.bundle`);
    const config = await require('metro-config').getDefaultConfig(path.join(fixture, 'apps/ui'));
    config.projectRoot = path.join(fixture, 'apps/ui');
    config.watchFolders = [config.projectRoot];
    config.resolver.assetExts = [...config.resolver.assetExts, 'bundle'];
    config.resolver.useWatchman = false;
    config.watcher = { ...(config.watcher ?? {}), useWatchman: false };
    config.maxWorkers = 1;
    config.resetCache = true;
    config.fileMapCacheDirectory = path.join(fixture, 'cache');
    mkdirSync(config.fileMapCacheDirectory, { recursive: true });
    config.reporter = { update() {} };
    const Graph = require('metro/private/node-haste/DependencyGraph').default;
    const graph = new Graph(config, { watch: true });
    try {
      await graph.ready();
      const admission = waitForMetroFileMap({ graph, watcher: graph.getWatcher(), paths: [asset] });
      await fsPromises.writeFile(asset, 'module.exports = {};');
      await admission;
      assert.equal(graph.doesFileExist(asset), true);
    } finally { await graph.end(); }
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});


test('replacement Metro serves the published generation without resolving through its predecessor', async () => {
  const fixture = realpathSync(mkdtempSync(path.join(tmpdir(), 'metro-generation-replacement-')));
  const generationStore = path.join(fixture, '.happier/deps/node_modules');
  const generationA = path.join(generationStore, 'gA');
  const generationB = path.join(generationStore, 'gB');
  const rootModules = path.join(fixture, 'node_modules');
  const ui = path.join(fixture, 'apps/ui');
  const entry = path.join(ui, 'entry.js');
  const asyncRequire = path.join(ui, 'asyncRequire.js');
  const configPath = path.resolve(uiRoot, 'metro.config.js');
  const runtimeRoot = path.dirname(require.resolve('metro-runtime/package.json'));
  const originalGenerationRoot = process.env.HAPPIER_UI_METRO_GENERATION_ROOT;
  try {
    for (const generation of [generationA, generationB]) {
      mkdirSync(path.join(generation, 'node_modules/dep'), { recursive: true });
      mkdirSync(path.join(generation, 'apps/ui/node_modules'), { recursive: true });
      writeFileSync(path.join(generation, 'node_modules/dep/package.json'), '{"name":"dep","main":"index.js"}');
      writeFileSync(path.join(generation, 'node_modules/dep/index.js'), `module.exports = ${JSON.stringify(path.basename(generation))};\n`);
    }
    mkdirSync(rootModules, { recursive: true });
    mkdirSync(ui, { recursive: true });
    writeFileSync(entry, 'module.exports = require("dep");\n');
    writeFileSync(asyncRequire, 'module.exports = {};\n');
    const selectGeneration = generation => {
      const link = path.join(rootModules, 'dep');
      try { unlinkSync(link); } catch {}
      symlinkSync(path.join(generation, 'node_modules/dep'), link, 'junction');
    };
    const loadConfig = generation => {
      process.env.HAPPIER_UI_METRO_GENERATION_ROOT = generation;
      delete require.cache[require.resolve(configPath)];
      const configured = require(configPath);
      configured.projectRoot = ui;
      configured.watchFolders = [ui,
        path.join(generation, 'node_modules'), path.join(generation, 'apps/ui/node_modules'), runtimeRoot];
      configured.resolver.useWatchman = false;
      configured.watcher = { ...(configured.watcher ?? {}), useWatchman: false };
      configured.fileMapCacheDirectory = path.join(fixture, 'filemap');
      mkdirSync(configured.fileMapCacheDirectory, { recursive: true });
      configured.cacheStores = [];
      configured.maxWorkers = 1;
      configured.reporter = { update() {} };
      configured.transformer = { ...configured.transformer, asyncRequireModulePath: asyncRequire };
      configured.serializer = { ...configured.serializer,
        getModulesRunBeforeMainModule: () => [], getPolyfills: () => [] };
      return configured;
    };
    const build = async generation => {
      selectGeneration(generation);
      const configured = loadConfig(generation);
      const { default: Server } = require('metro/private/Server');
      const server = new Server(configured, { watch: true });
      try {
        return await server.build({ ...Server.DEFAULT_BUNDLE_OPTIONS,
          entryFile: entry, platform: 'web', dev: true, minify: false, lazy: false });
      } finally { await server.end(); }
    };
    const before = await build(generationA);
    assert.match(before.code, /gA/);
    assert.doesNotMatch(before.code, /gB/);
    const after = await build(generationB);
    assert.match(after.code, /gB/);
    assert.doesNotMatch(after.code, /gA/);
    assert.doesNotMatch(after.code, /metro-two-generation-replacement/);
  } finally {
    if (originalGenerationRoot === undefined) delete process.env.HAPPIER_UI_METRO_GENERATION_ROOT;
    else process.env.HAPPIER_UI_METRO_GENERATION_ROOT = originalGenerationRoot;
    delete require.cache[require.resolve(configPath)];
    rmSync(fixture, { recursive: true, force: true });
  }
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
