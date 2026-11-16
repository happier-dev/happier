// @happier-test-preparation source-condition
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createServer, get } from 'node:http';
import { retainBundledPluginUiArtifactsInventory } from './generateBundledPluginUiArtifacts.mjs';

const uiRoot = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(join(uiRoot, 'package.json'));

test('an atomic private inventory publication reaches the next bundle of a running Metro', async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), 'happier-plugin-ui-publication-'));
  const projectRoot = join(fixture, 'project');
  const inventoryRoot = join(fixture, 'plugin-ui');
  const inventory = join(inventoryRoot, 'inventory.js');
  const candidate = join(fixture, 'candidate.js');
  const previousInventory = process.env.HAPPIER_UI_PLUGIN_ARTIFACT_INVENTORY;
  let metro;
  let http;
  try {
    await mkdir(projectRoot);
    await mkdir(inventoryRoot);
    const declaration = digest => `export const BUNDLED_PLUGIN_UI_APP_ARTIFACTS = [{ digest: ${JSON.stringify(digest)} }];\n`;
    await writeFile(inventory, declaration('predecessor-6db91'));
    await writeFile(join(projectRoot, 'entry.js'),
      'globalThis.pluginUiInventory = require("@/sync/domains/plugins/availability/generatedBundledPluginUiArtifacts");\n');
    process.env.HAPPIER_UI_PLUGIN_ARTIFACT_INVENTORY = inventory;
    delete require.cache[require.resolve(join(uiRoot, 'metro.config.js'))];
    const authored = require(join(uiRoot, 'metro.config.js'));
    const config = await require('metro-config').getDefaultConfig(projectRoot);
    config.resolver.resolveRequest = authored.resolver.resolveRequest;
    config.resolver.useWatchman = false;
    config.resolver.nodeModulesPaths = [join(uiRoot, 'node_modules'), join(uiRoot, '../../node_modules')];
    config.watchFolders = [projectRoot, inventoryRoot, dirname(require.resolve('metro-runtime/package.json'))];
    config.maxWorkers = 1;
    config.fileMapCacheDirectory = join(fixture, 'file-map-cache');
    await mkdir(config.fileMapCacheDirectory);
    const { createMetroCacheStore } = require('./scripts/metroCache.cjs');
    const { FileStore } = require('metro-cache');
    config.cacheStores = [createMetroCacheStore({ FileStore, root: join(fixture, 'transform-cache') })];
    config.reporter = { update() {} };
    const Server = require('metro/private/Server').default;
    metro = new Server(config, { watch: true });
    await metro.ready();
    const graph = await metro.getBundler().getBundler().getDependencyGraph();
    assert.equal(graph.doesFileExist(join(projectRoot, 'entry.js')), true);
    http = createServer((req, res) => {
      void metro.processRequest(req, res, () => { res.writeHead(404); res.end(); });
    });
    await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
    const bundle = () => new Promise((resolve, reject) => {
      get({ hostname: '127.0.0.1', port: http.address().port,
        path: '/entry.bundle?platform=web&dev=true&minify=false' }, res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode, source: Buffer.concat(chunks).toString() }));
        res.on('error', reject);
      }).on('error', reject);
    });
    const first = await bundle();
    assert.equal(first.status, 200, first.source);
    assert.match(first.source, /predecessor-6db91/);
    const before = (await graph.getOrComputeSha1(inventory)).sha1;
    const watcher = metro.getBundler().getBundler().getWatcher();
    const changed = new Promise((resolve, reject) => {
      const cleanup = () => {
        watcher.off('change', onChange);
        t.signal.removeEventListener('abort', onAbort);
      };
      const onAbort = () => { cleanup(); reject(t.signal.reason); };
      const onChange = ({ eventsQueue }) => {
        if (eventsQueue.some(({ filePath }) => filePath === inventory)) { cleanup(); resolve(); }
      };
      watcher.on('change', onChange);
      t.signal.addEventListener('abort', onAbort, { once: true });
    });
    await writeFile(candidate, declaration('successor-2aae'));
    assert.equal(await retainBundledPluginUiArtifactsInventory({ inventoryPath: candidate, outputPath: inventory }), true);
    await changed;
    assert.notEqual((await graph.getOrComputeSha1(inventory)).sha1, before,
      'the running file map must replace the inventory hash after atomic publication');
    const next = await bundle();
    assert.equal(next.status, 200, next.source);
    assert.match(next.source, /successor-2aae/);
    assert.doesNotMatch(next.source, /predecessor-6db91/,
      'a full reload must not retain the previously transformed inventory');
  } finally {
    if (http) await new Promise(resolve => http.close(resolve));
    if (metro) await metro.end();
    if (previousInventory === undefined) delete process.env.HAPPIER_UI_PLUGIN_ARTIFACT_INVENTORY;
    else process.env.HAPPIER_UI_PLUGIN_ARTIFACT_INVENTORY = previousInventory;
    delete require.cache[require.resolve(join(uiRoot, 'metro.config.js'))];
    await rm(fixture, { recursive: true, force: true });
  }
});

test('Metro crawl and watch exclude installer and QA scratch without invalidating bundles', async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), 'happier-metro-pnpm-state-'));
  let graph;
  try {
    const projectRoot = join(fixture, 'apps/ui');
    const dependencies = join(fixture, 'node_modules');
    const state = join(dependencies, '.pnpm-task-run-state-v1');
    const lock = join(state, 'start.lock', 'owner.js');
    const ordinary = join(dependencies, '.pnpm', 'ordinary', 'index.js');
    const skia = join(dependencies, 'packages/skia/artifacts/skia-android-arm-64');
    const qa = join(projectRoot, '.project/qa');
    const rustTarget = join(fixture, 'packages/iroh-native/rust/target');
    const pacquet = join(dependencies, 'expo-asset_pacquet-stage_3276813_1/tools');
    const scopedPacquet = join(dependencies, '@scope/package_pacquet-stage_3276813_2');
    const pnpmStage = join(dependencies, '.pnpm/ordinary_tmp_3276813');
    const transientRoots = [rustTarget, dirname(pacquet), scopedPacquet, pnpmStage];
    const excluded = [lock, join(skia, 'install.js'), join(qa, 'probe.js'),
      join(rustTarget, 'source-runtime/digest/release/deps/rustc-transient/index.js'),
      join(pacquet, 'index.js'), join(scopedPacquet, 'index.js'), join(pnpmStage, 'index.js')];
    const source = join(projectRoot, 'index.js');
    await mkdir(projectRoot, { recursive: true });
    await mkdir(dirname(lock), { recursive: true });
    await mkdir(dirname(ordinary), { recursive: true });
    await writeFile(lock, 'transient lock contents');
    await writeFile(ordinary, 'module.exports = "ordinary dependency";');
    await writeFile(source, 'module.exports = 1;');
    for (const file of excluded.slice(1)) {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, 'module.exports = "scratch";');
    }
    delete require.cache[require.resolve(join(uiRoot, 'metro.config.js'))];
    // Evaluate the real CommonJS configuration at its filesystem boundary so
    // the existing private predicate is exercised without a production test export.
    const configPath = join(uiRoot, 'metro.config.js');
    const { config, isFileBlockedByMetro } = new Function('require', 'module', '__dirname', '__filename',
      `${await readFile(configPath, 'utf8')}\nreturn { config: module.exports, isFileBlockedByMetro };`)(
      require, { exports: {} }, uiRoot, configPath);
    config.projectRoot = projectRoot;
    config.watchFolders = [projectRoot, dependencies, join(fixture, 'packages')];
    config.resolver.useWatchman = false;
    config.maxWorkers = 1;
    config.fileMapCacheDirectory = join(fixture, 'cache');
    await mkdir(config.fileMapCacheDirectory);
    config.reporter = { update() {} };
    // This is Metro's actual config-to-crawler owner, not a resolver predicate.
    const createFileMap = require('metro/private/node-haste/DependencyGraph/createFileMap').default;
    const { fileMap } = createFileMap(config, { watch: true });
    graph = fileMap;
    const watchedPaths = [];
    const watch = fs.watch;
    t.mock.method(fs, 'watch', (filePath, ...args) => {
      watchedPaths.push(String(filePath));
      return watch(filePath, ...args);
    });
    const { fileSystem } = await fileMap.build();
    for (const file of excluded) {
      assert.equal(fileSystem.exists(file), false, `${file} must be absent from the crawl`);
    }
    assert.equal(fileSystem.exists(ordinary), true, 'the physical dependency store remains a bundle input');
    assert.equal(fileSystem.exists(source), true, 'the source positive control must be watched before mutation');
    const blockList = config.resolver.blockList;
    const ignored = candidate => isFileBlockedByMetro(blockList, candidate);
    for (const cargoRoot of ['packages/iroh-native/rust', 'packages/ssh-native/rust/happier-ssh-native',
      'packages/desktop-native/rust/happier-desktop-native', 'apps/cli/runner-native-shell',
      'apps/ui/src-tauri', 'apps/ui/src-tauri/tests/menu_bar_harness']) {
      const target = join(fixture, cargoRoot, 'target');
      assert.equal(ignored(target), true, 'every current Cargo target directory must be pruned');
      assert.equal(ignored(target.replaceAll('/', '\\')), true, 'Cargo roots must also be pruned on Windows');
    }
    for (const candidate of [state, dirname(lock), lock, dirname(skia), skia, qa, rustTarget,
      dirname(pacquet), pacquet, scopedPacquet, pnpmStage, ...excluded]) {
      assert.equal(ignored(candidate), true, 'the state directory itself must be pruned before recursion');
      assert.equal(ignored(candidate.replaceAll('/', '\\')), true, 'Windows crawl boundaries must also be pruned');
    }
    assert.equal(ignored(join(dependencies, '.pnpm-task-run-state-v1-package', 'index.js')), false,
      'a sibling package with a similar prefix must remain resolvable');
    assert.equal(ignored(join(dependencies, '@shopify/react-native-skia/lib/module/index.js')), false);
    assert.equal(ignored(join(dependencies, 'packages/skia/artifacts-other/index.js')), false);
    assert.equal(ignored(join(projectRoot, '.happier-other/index.js')), false);
    assert.equal(ignored(join(fixture, 'packages/iroh-native/rust/target-platform/src/index.js')), false);
    assert.equal(ignored(join(dependencies, 'expo-asset/tools/index.js')), false);
    assert.equal(ignored(join(dependencies, '@scope/package/index.js')), false);
    assert.equal(ignored(join(fixture, 'packages/protocol/src/browser/target/index.ts')), false,
      'an authored target domain outside Rust projects remains a bundle input');
    assert.equal(ignored(join(fixture, 'home/.happier/stacks/dev/plugin-ui/artifacts/entry.cjs.bundle')), false,
      'retained consumer-owned Plugin UI assets outside the checkout remain hashable');

    let scratchInvalidations = 0;
    const sourceChanged = new Promise((resolve, reject) => {
      t.signal.addEventListener('abort', () => reject(t.signal.reason), { once: true });
      fileMap.on('change', ({ eventsQueue }) => {
        scratchInvalidations += eventsQueue.filter(({ filePath }) => excluded.includes(filePath)).length;
        if (eventsQueue.some(({ filePath }) => filePath === source)) resolve();
      });
    });
    // A scale-shaped burst in watched roots must produce no scratch-driven
    // invalidations. A real source edit is the positive watcher control.
    for (let revision = 0; revision < 100; revision++) {
      await Promise.all(excluded.map(file => writeFile(file, `module.exports = ${revision};`)));
    }
    await writeFile(source, 'module.exports = 2;');
    await sourceChanged;
    assert.equal(scratchInvalidations, 0);
    assert.ok(watchedPaths.includes(projectRoot), 'the real fallback watcher must attach the source root');
    const transientWatches = watchedPaths.filter(candidate => transientRoots.some(root => candidate === root || candidate.startsWith(root + '/'))).length;
    assert.equal(transientWatches, 0, 'blocked directories must be pruned before fs.watch attachment');
    console.log(JSON.stringify({ scratchWrites: excluded.length * 100, scratchInvalidations, transientWatches, sourceIndexed: fileSystem.exists(source) }));
  } finally {
    if (graph) await graph.end();
    delete require.cache[require.resolve(join(uiRoot, 'metro.config.js'))];
    await rm(fixture, { recursive: true, force: true });
  }
});

test('Metro indexes retained private inventory assets before and after its initial crawl', async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), 'happier-plugin-ui-filemap-'));
  const inventoryRoot = join(fixture, 'inputs');
  const projectRoot = join(fixture, 'project');
  const inventory = join(inventoryRoot, 'inventory.js');
  const previousInventory = process.env.HAPPIER_UI_PLUGIN_ARTIFACT_INVENTORY;
  const previousStack = process.env.HAPPIER_STACK_STACK;
  let graph;
  try {
    process.env.HAPPIER_UI_PLUGIN_ARTIFACT_INVENTORY = inventory;
    process.env.HAPPIER_STACK_STACK = 'fixture-plugin-ui-filemap';
    await mkdir(projectRoot);
    const first = join(inventoryRoot, 'preparation-first/channels/happier-plugin-ui/react-native/channel-state-migrations/entry.cjs.bundle');
    await mkdir(dirname(first), { recursive: true });
    await writeFile(first, 'module.exports = {};\n');
    await writeFile(inventory, `export const bytes = require(${JSON.stringify(first)});\n`);
    delete require.cache[require.resolve(join(uiRoot, 'metro.config.js'))];
    const config = require(join(uiRoot, 'metro.config.js'));
    // Keep the private root supplied by the real config. Withholding that
    // root must fail hashing/resolution, rather than being hidden by a crawl
    // of an enclosing fixture or unrelated workspace sources.
    config.projectRoot = projectRoot;
    config.watchFolders = config.watchFolders.filter(folder => folder === inventoryRoot);
    config.maxWorkers = 2;
    config.fileMapCacheDirectory = join(fixture, 'cache');
    await mkdir(config.fileMapCacheDirectory);
    config.reporter = { update() {} };
    const Graph = require('metro/private/node-haste/DependencyGraph').default;
    graph = new Graph(config, { watch: true });
    await graph.ready();
    const resolveAsset = (asset, platform) => graph.resolveDependency(inventory, {
      name: asset, data: { key: asset, asyncType: null, isESMImport: false, locs: [] },
    }, platform, { dev: true });
    for (const platform of ['web', 'android']) {
      assert.equal(resolveAsset(first, platform).filePath, first);
      assert.ok((await graph.getOrComputeSha1(first)).sha1);
    }
    const late = join(inventoryRoot, 'preparation-late/channels/happier-plugin-ui/react-native/channel-state-migrations/entry.cjs.bundle');
    let onChange;
    const indexed = new Promise((resolve, reject) => {
      if (t.signal.aborted) { reject(t.signal.reason); return; }
      const onAbort = () => {
        graph.off('change', onChange);
        reject(t.signal.reason);
      };
      onChange = () => {
        if (graph.doesFileExist(late)) {
          graph.off('change', onChange);
          t.signal.removeEventListener('abort', onAbort);
          resolve();
        }
      };
      t.signal.addEventListener('abort', onAbort, { once: true });
      graph.on('change', onChange);
    });
    await mkdir(dirname(late), { recursive: true });
    await writeFile(late, 'module.exports = { refreshed: true };\n');
    await writeFile(inventory, `export const bytes = require(${JSON.stringify(late)});\n`);
    await indexed;
    for (const platform of ['web', 'android']) {
      assert.equal(resolveAsset(late, platform).filePath, late);
      assert.ok((await graph.getOrComputeSha1(late)).sha1);
    }
  } finally {
    if (graph) await graph.end();
    if (previousInventory === undefined) delete process.env.HAPPIER_UI_PLUGIN_ARTIFACT_INVENTORY;
    else process.env.HAPPIER_UI_PLUGIN_ARTIFACT_INVENTORY = previousInventory;
    if (previousStack === undefined) delete process.env.HAPPIER_STACK_STACK;
    else process.env.HAPPIER_STACK_STACK = previousStack;
    delete require.cache[require.resolve(join(uiRoot, 'metro.config.js'))];
    await rm(fixture, { recursive: true, force: true });
  }
});
