import test from 'node:test';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const assert = require('node:assert/strict');
const { mkdtemp, mkdir, writeFile, rm } = require('node:fs/promises');
const { join, dirname } = require('node:path');
const { tmpdir } = require('node:os');
const { pathToFileURL } = require('node:url');
const vm = require('node:vm');
const { performance } = require('node:perf_hooks');
test('Metro watcher and HTTP/HMR readers consume completed installs and stop on close', { timeout: 60_000 }, async () => {
  let root, metro, http, release;
  try {
  const repo = process.cwd();
  const ownerPath = join(repo, 'apps/stack/scripts/utils/proc/dependency_refresh.mjs');
  const owner = await import(pathToFileURL(ownerPath));
  root = await mkdtemp(join(tmpdir(), 'metro-consumption-c2-'));
  const env = { ...process.env, HAPPIER_STACK_SKIP_REFRESH_DEPS: '0', HAPPIER_STACK_DISABLE_REFRESH_DEPS: '0', HAPPIER_STACK_HOME_DIR: join(root, 'stack-home'), HAPPIER_STACK_STORAGE_DIR: join(root, 'stacks') };
  delete env.HAPPIER_STACK_ENV_FILE;
  delete env.HAPPIER_STACK_STACK;
  for (const app of ['ui', 'cli', 'server']) {
    await mkdir(join(root, 'apps', app), { recursive: true });
    await writeFile(join(root, 'apps', app, 'package.json'), JSON.stringify({ name: 'fixture-' + app }));
  }
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'fixture-root', private: true }));
  await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages:\n - apps/*\n');
  await writeFile(join(root, 'pnpm-lock.yaml'), '# fixture\n');
  const packageDir = join(root, 'node_modules/fixture-engine');
  await mkdir(packageDir, { recursive: true });
  await writeFile(join(packageDir, 'package.json'), JSON.stringify({ name: 'fixture-engine', main: 'generated.js' }));
  const generated = join(packageDir, 'generated.js');
  await writeFile(generated, 'module.exports = "before";');
  const entry = join(root, 'index.js');
  await writeFile(entry, 'globalThis.installedValue = require("fixture-engine");');
  await owner.withDependencyRefresh({ installDir: root, env, force: true }, async () => {});
  const config = await require('metro-config').getDefaultConfig(root);
  config.resolver.useWatchman = false;
  config.resolver.nodeModulesPaths = [join(repo, 'node_modules')];
  config.maxWorkers = 1;
  config.watchFolders = [root, dirname(require.resolve('metro-runtime/package.json'))];
  config.fileMapCacheDirectory = join(root, 'filemap'); await mkdir(config.fileMapCacheDirectory);
  config.cacheStores = [new (require('metro-cache').FileStore)({ root: join(root, 'transforms') })];
  config.reporter = { update() {} };
  const { processMetroDependencyChanges } = require('./metroDependencyConsumption.cjs');
  config.watcher.unstable_processFileChanges = (processChanges, signal) =>
    processMetroDependencyChanges(root, processChanges, signal);
  metro = new (require('metro/private/Server').default)(config, { watch: true });
  const uiConfig = require('../metro.config.js');
  const originalProjectRoot = uiConfig.projectRoot;
  uiConfig.projectRoot = root;
  const enhanced = uiConfig.server.enhanceMiddleware(metro.processRequest, metro);
  uiConfig.projectRoot = originalProjectRoot;
  const bundler = metro.getBundler(); await bundler.ready();
  const transform = { dev: true, minify: false, platform: 'web', type: 'module', customTransformOptions: {} };
  const resolve = { dev: true, customResolverOptions: {} };
  let { revision } = await bundler.initializeGraph(entry, transform, resolve, { lazy: false, shallow: false });
  const watcher = bundler.getBundler().getWatcher();
  const changed = (file, type) => new Promise(resolve => {
    const listener = event => {
      if (event.eventsQueue.some(entry => entry.filePath === file && (!type || entry.type === type))) { watcher.off('change', listener); resolve(); }
    }; watcher.on('change', listener);
  });
  const { createMetroMiddleware } = require(join(dirname(require.resolve('@expo/cli/package.json')), 'build/src/start/server/metro/dev-server/createMetroMiddleware.js'));
  const { middleware } = createMetroMiddleware(config, { getMetroBundler: () => bundler.getBundler() });
  middleware.use(enhanced);
  http = require('node:http').createServer(middleware);
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  let partialEvents = 0;
  const onChange = () => { partialEvents++; };
  watcher.on('change', onChange);
  const publication = changed(generated, 'change');
  const held = new Promise(resolve => { release = resolve; });
  let enter; const entered = new Promise(resolve => { enter = resolve; });
  const writer = owner.withDependencyRefresh({ installDir: root, env, force: true }, async () => {
    await rm(generated);
    enter(); await held;
    await writeFile(generated, 'module.exports = "after";');
  });
  await entered;
  const readResults = [];
  const reads = [
    ['warm-update', () => bundler.updateGraph(revision, false)],
    ['cold-graph', () => bundler.buildGraph(entry, transform, resolve, { lazy: false, shallow: false })],
    ['dependency-query', () => bundler.getDependencies([entry], transform, resolve, { lazy: false, shallow: false })],
  ].map(([name, read]) => read().then(result => { readResults.push({ name, status: 'fulfilled' }); return result; }, error => {
    readResults.push({ name, status: 'rejected', error: error.name }); throw error;
  }));
  for (const read of reads) void read.catch(() => {});
  const start = performance.now();
  assert.equal(await (await fetch(`http://127.0.0.1:${http.address().port}/status`)).text(), 'packager-status:running');
  const statusMs = performance.now() - start;
  // Diagnostic checkpoint while the writer is explicitly held. No runtime
  // timer or retry participates in protecting package consumption.
  await new Promise(resolve => setTimeout(resolve, 200));
  const during = [...readResults];
  assert.equal(partialEvents, 0, 'partial installs must not invalidate graphs or publish transient missing exports');
  release(); await writer;
  await publication; watcher.off('change', onChange);
  const settled = await Promise.allSettled(reads);
  console.log(JSON.stringify({ phase: 'dependency-consumption', statusMs, during, after: readResults }));
  assert.deepEqual(during, [], 'all graph entry points must wait while the installer has removed a generated module');
  assert.ok(settled.every(result => result.status === 'fulfilled'), 'all graph reads recover after successful publication');
  const output = await metro.build({ entryFile: entry, dev: true, minify: false, platform: 'web', runModule: true });
  const sandbox = {}; vm.runInNewContext(output.code, sandbox);
  assert.equal(sandbox.installedValue, 'after');
  console.log(JSON.stringify({ phase: 'fresh-executable-bundle', value: sandbox.installedValue }));
  await assert.rejects(owner.withDependencyRefresh({ installDir: root, env, force: true }, async () => {
    await writeFile(generated, 'module.exports = "unfinished";');
    throw new Error('fixture installer failure');
  }), { code: 'HAPPIER_DEPENDENCY_REFRESH_FAILED' });
  await assert.rejects(bundler.getDependencies([entry], transform, resolve, { lazy: false, shallow: false }),
    { code: 'HAPPIER_DEPENDENCY_REFRESH_FAILED' });
  const recovered = changed(generated, 'change');
  await owner.withDependencyRefresh({ installDir: root, env, force: true }, () =>
    writeFile(generated, 'module.exports = "recovered";'));
  await recovered;
  const recoveredOutput = await metro.build({ entryFile: entry, dev: true, minify: false, platform: 'web', runModule: true });
  const recoveredSandbox = {}; vm.runInNewContext(recoveredOutput.code, recoveredSandbox);
  assert.equal(recoveredSandbox.installedValue, 'recovered');
  let closeEntered;
  const closing = new Promise(resolve => { closeEntered = resolve; });
  const heldAtClose = new Promise(resolve => { release = resolve; });
  const closingWriter = owner.withDependencyRefresh({ installDir: root, env, force: true }, async () => {
    await writeFile(generated, 'module.exports = "closing";');
    closeEntered(); await heldAtClose;
  });
  await closing;
  const waiting = bundler.getDependencies([entry], transform, resolve, { lazy: false, shallow: false });
  void waiting.catch(() => {});
  await new Promise(resolve => setTimeout(resolve, 200));
  const ended = metro.end();
  await assert.rejects(waiting, { name: 'AbortError' });
  await ended; metro = null;
  release(); await closingWriter;
  } finally {
    release?.(); await metro?.end(); if (http) await new Promise(resolve => http.close(resolve));
    if (root) await rm(root, { recursive: true, force: true });
  }
});

test('fallback watcher retains package edits after an install replaces directories', { timeout: 60_000 }, async context => {
  const { EventEmitter, on } = require('node:events');
  const { rename, readFile } = require('node:fs/promises');
  const FallbackWatcher = require(join(dirname(require.resolve('metro-file-map/package.json')), 'src/watchers/FallbackWatcher.js')).default;
  const root = await mkdtemp(join(tmpdir(), 'metro-replaced-package-'));
  const packageRoot = join(root, 'engine');
  const file = join(packageRoot, 'lib', 'index.js');
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, 'module.exports = 1;');
  const watcher = new FallbackWatcher(root, { globs: ['**/*.js'], dot: true });
  const events = new EventEmitter();
  const off = watcher.onFileEvent(change => events.emit('file', change));
  const errors = [];
  watcher.onError(error => errors.push(error));
  const nextEdit = async () => {
    for await (const [change] of on(events, 'file', { signal: context.signal })) {
      if (change.event === 'touch' && change.relativePath === join('engine', 'lib', 'index.js')) return change;
    }
  };
  try {
    await watcher.startWatching();
    const replacement = nextEdit();
    await rename(packageRoot, join(root, 'retired'));
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, 'module.exports = 2;');
    await replacement;
    const edited = nextEdit();
    await writeFile(file, 'module.exports = 3;');
    await edited;
    assert.equal(await readFile(file, 'utf8'), 'module.exports = 3;');
    assert.deepEqual(errors, []);
  } finally {
    off(); await watcher.stopWatching();
    await rm(root, { recursive: true, force: true });
  }
});
