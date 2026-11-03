import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const { graphToSerialAssetsAsync } = require('@expo/metro-config/build/serializer/serializeChunks');
const { transformSync } = require('esbuild');
const { transformSync: transformFlow } = require('@babel/core');
const expoRoot = path.dirname(require.resolve('expo/package.json'));
const runtimeSource = transformFlow(readFileSync(require.resolve('metro-runtime/src/polyfills/require.js'), 'utf8'), {
  babelrc: false, configFile: false, plugins: [require.resolve('@babel/plugin-transform-flow-strip-types')],
}).code;

function makeModule(name, dependencies = [], body = 'exports.value = 41;') {
  const source = `__d(function(global, require, importDefault, importAll, module, exports, dependencies) { ${body} });`;
  return {
    path: `/serializer-fixture/${name}.js`,
    dependencies: new Map(dependencies.map(([name, asyncType = null], index) => [String(index), {
      absolutePath: `/serializer-fixture/${name}.js`, data: { name, data: { asyncType } },
    }])),
    output: [{ type: 'js/module', data: { code: source, lineCount: 1, map: [] } }],
    getSource: () => Buffer.from(source),
  };
}

function makeFixture({ nested = false, worker = false, sync = false } = {}) {
  const opening = 'exports.openA = () => global.asyncRequire(dependencies[0], dependencies.paths); exports.openB = () => global.asyncRequire(dependencies[1], dependencies.paths);';
  return [
    makeModule('index', nested ? [['library', 'async']] : [['a', 'async'], ['b', 'async'],
      ...(worker ? [['worker', 'worker']] : []), ...(sync ? [['shared']] : [])], nested
      ? 'exports.openLibrary = () => global.asyncRequire(dependencies[0], dependencies.paths);' : opening),
    ...(nested ? [makeModule('library', [['a', 'async'], ['b', 'async']], opening)] : []),
    makeModule('a', [['shared']], 'exports.value = require(dependencies[0]).value + 1;'),
    makeModule('b', [['shared']], 'exports.value = require(dependencies[0]).value + 2;'),
    makeModule('shared'),
    ...(worker ? [makeModule('worker', [['shared']], 'global.workerValue = require(dependencies[0]).value;')] : []),
  ];
}

async function serialize(modules) {
  const ids = new Map();
  const graph = { dependencies: new Map(modules.map(module => [module.path, module])),
    transformOptions: { platform: 'web', dev: false, customTransformOptions: { baseUrl: '/app' } } };
  const options = {
    projectRoot: '/serializer-fixture', serverRoot: '/serializer-fixture', dev: false,
    runModule: true, modulesOnly: false, includeAsyncPaths: false,
    processModuleFilter: () => true, shouldAddToIgnoreList: () => false,
    createModuleId: file => { if (!ids.has(file)) ids.set(file, ids.size); return ids.get(file); },
    getRunModuleStatement: id => `globalThis.entry = __r(${JSON.stringify(id)});`,
    serializerOptions: { splitChunks: true, exporting: true, includeSourceMaps: false },
  };
  return (await graphToSerialAssetsAsync({}, { includeSourceMaps: false, splitChunks: true },
    modules[0].path, [], graph, options)).artifacts.filter(asset => asset.type === 'js');
}

function loadExpoModule(relativePath, runtimeRequire) {
  const source = transformSync(readFileSync(path.join(expoRoot, relativePath), 'utf8'), {
    loader: 'ts', format: 'cjs', target: 'es2022',
  }).code;
  const module = { exports: {} };
  vm.runInNewContext(`(function(module, exports, require) { ${source}\n})`, {
    __DEV__: false, __METRO_GLOBAL_PREFIX__: '',
  })(module, module.exports, runtimeRequire);
  return module.exports;
}

function makeRuntime(scripts, { failCommonOnce = false } = {}) {
  const context = vm.createContext({ __DEV__: false, __METRO_GLOBAL_PREFIX__: '', console });
  context.global = context;
  vm.runInContext(runtimeSource, context);
  const loads = [];
  let commonFailures = failCommonOnce ? 1 : 0;
  const boundary = { loadBundleAsync: async url => {
    loads.push(url);
    if (url.includes('__common') && commonFailures > 0) {
      commonFailures -= 1;
      throw new Error('fixture transport failed');
    }
    const artifact = scripts.find(asset => `/app/${asset.filename}` === url);
    assert.ok(artifact, `requested chunk must exist: ${url}`);
    vm.runInContext(artifact.source, context);
  } };
  const { buildAsyncRequire } = loadExpoModule('src/async-require/buildAsyncRequire.ts', name => {
    assert.equal(name, './loadBundle');
    return boundary;
  });
  context.__loadBundleAsync = buildAsyncRequire();
  // Use the real Expo import/prefetch entry and real Metro module registry;
  // only network delivery is replaced by the in-memory artifact boundary.
  const asyncSource = transformSync(readFileSync(path.join(expoRoot, 'src/async-require/asyncRequireModule.ts'), 'utf8'), {
    loader: 'ts', format: 'cjs', target: 'es2022',
  }).code;
  const asyncModule = { exports: {} };
  context.asyncModule = asyncModule;
  vm.runInContext(`(function(module, exports, require) { ${asyncSource}\n})(asyncModule, asyncModule.exports, __r);`, context);
  context.asyncRequire = asyncModule.exports;
  const loaded = new Set();
  function eagerLoad(artifact) {
    if (loaded.has(artifact.filename)) return;
    for (const filename of artifact.metadata.requires ?? []) eagerLoad(scripts.find(asset => asset.filename === filename));
    vm.runInContext(artifact.source, context);
    loaded.add(artifact.filename);
  }
  for (const artifact of scripts.filter(asset => !asset.metadata.isAsync)) eagerLoad(artifact);
  return { context, loads };
}

for (const nested of [false, true]) {
  test(`async-only shared code downloads once on demand before concurrent consumers (nested=${nested})`, async () => {
    const scripts = await serialize(makeFixture({ nested }));
    const eagerShared = scripts.filter(asset => !asset.metadata.isAsync)
      .flatMap(asset => asset.metadata.modulePaths).filter(file => file.endsWith('/shared.js'));
    assert.equal(eagerShared.length, 0, 'cold entry must download zero async-only shared modules');
    const runtime = makeRuntime(scripts);
    assert.equal(runtime.loads.length, 0, 'cold entry does not fetch lazy chunks');
    const entry = nested ? await runtime.context.entry.openLibrary() : runtime.context.entry;
    if (nested) assert.equal(runtime.loads.some(url => url.includes('__common')), false);
    const [a, b] = await Promise.all([entry.openA(), entry.openB()]);
    assert.equal(a.value, 42);
    assert.equal(b.value, 43);
    assert.equal(runtime.loads.filter(url => url.includes('__common')).length, 1,
      'two consumers download their shared code once');
    await entry.openA();
    assert.equal(runtime.loads.filter(url => url.includes('__common')).length, 1);
  });
}

test('failed common download rejects before consumer download and a user retry succeeds', async () => {
  const scripts = await serialize(makeFixture());
  const runtime = makeRuntime(scripts, { failCommonOnce: true });
  await assert.rejects(runtime.context.entry.openA(), /fixture transport failed/);
  assert.equal(runtime.loads.length, 1, 'consumer is not downloaded after its prerequisite failed');
  assert.equal((await runtime.context.entry.openA()).value, 42);
  assert.equal(runtime.loads.filter(url => url.includes('__common')).length, 2);
});

test('worker URLs stay strings and worker synchronous dependencies remain in its own realm', async () => {
  const scripts = await serialize(makeFixture({ worker: true }));
  const worker = scripts.find(asset => asset.metadata.modulePaths.includes('/serializer-fixture/worker.js'));
  assert.ok(worker.metadata.modulePaths.includes('/serializer-fixture/shared.js'));
  assert.equal(worker.metadata.requires.some(filename => filename.includes('__common')), false);
  const entry = scripts.find(asset => asset.metadata.modulePaths.includes('/serializer-fixture/index.js'));
  const workerMapping = Object.values(entry.metadata.paths).flatMap(paths => Object.values(paths))
    .find(value => typeof value === 'string' && value.endsWith(worker.filename));
  assert.equal(typeof workerMapping, 'string');
  const isolated = makeRuntime([]).context;
  vm.runInContext(worker.source, isolated);
  assert.equal(isolated.workerValue, 41);
});

test('genuinely synchronous shared modules remain eager and ordinary lazy mappings stay strings', async () => {
  const scripts = await serialize(makeFixture({ sync: true }));
  assert.equal(scripts.filter(asset => !asset.metadata.isAsync).flatMap(asset => asset.metadata.modulePaths)
    .filter(file => file.endsWith('/shared.js')).length, 1);
  for (const script of scripts) for (const paths of Object.values(script.metadata.paths)) {
    for (const value of Object.values(paths)) assert.equal(typeof value, 'string');
  }
  const runtime = makeRuntime(scripts);
  assert.equal((await runtime.context.entry.openA()).value, 42);
});
