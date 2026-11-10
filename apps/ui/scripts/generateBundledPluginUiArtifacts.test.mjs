// @happier-test-preparation source
// Preparation imports authored SDK TypeScript, as the source child does.
import '../../../packages/cli-common/registerSourceRuntime.mjs';
import './bundledPluginUiMembership.test.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs, { writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { runInNewContext } from 'node:vm';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { withPatchedProcessEnv } from '../../stack/scripts/testkit/core/env_scope.mjs';
import { readBundledPluginUiDeclarationSource } from './bundledPluginUiDeclarationSource.mjs';
import { decodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { pluginPackageNameToPackageId, readBundledPluginPackageNames } from '../../cli/scripts/build-owned/bundledPluginMembership.ts';

import {
  computePluginUiArtifactFileSetSha256DigestV1,
  computePluginUiArtifactSha256DigestV1,
} from '@happier-dev/protocol/plugins/ui';

import {
  generateBundledPluginUiArtifacts,
  listBundledPluginUiArtifactExports,
  reapBundledPluginUiArtifactStore,
  retainBundledPluginUiArtifactsInventory,
  resolveBundledPluginUiArtifactsInputPaths,
  resolveBundledPluginUiArtifactsOutputPath,
  resolveBundledPluginUiArtifactsRetainedRoots,
} from './generateBundledPluginUiArtifacts.mjs';

const execFileAsync = promisify(execFile);
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

test('Metro resolves freshly published retained declarations and assets on native and web', { timeout: 15000 }, async t => {
  const fixture = await createFixture();
  let graph;
  t.after(async () => {
    if (graph) await graph.end();
    await rm(fixture.repoRoot, { recursive: true, force: true });
  });
  const consumerRoot = join(fixture.repoRoot, 'consumer');
  const inventoryPath = join(consumerRoot, 'inventory.js');
  await mkdir(consumerRoot);
  withPatchedProcessEnv(t, { HAPPIER_UI_PLUGIN_ARTIFACT_INVENTORY: inventoryPath });
  const require = createRequire(join(packageRoot, 'package.json'));
  const configPath = join(packageRoot, 'metro.config.js');
  delete require.cache[require.resolve(configPath)];
  t.after(() => { delete require.cache[require.resolve(configPath)]; });
  const config = require(configPath);
  config.projectRoot = join(fixture.repoRoot, 'apps/ui');
  config.watchFolders = [consumerRoot];
  config.resolver.useWatchman = false;
  config.maxWorkers = 1;
  config.fileMapCacheDirectory = join(fixture.repoRoot, 'cache');
  await mkdir(config.fileMapCacheDirectory);
  config.reporter = { update() {} };
  const Graph = require('metro/private/node-haste/DependencyGraph').default;
  graph = new Graph(config, { watch: true });
  await graph.ready();
  let paths;
  let check;
  const indexed = new Promise((resolveIndexed, reject) => {
    check = () => { if (paths?.every(path => graph.doesFileExist(path))) resolveIndexed(); };
    graph.on('change', check);
    t.after(() => graph.off('change', check));
    t.signal.addEventListener('abort', () => reject(new Error('published inventory inputs never entered Metro file map')), { once: true });
  });
  await generateBundledPluginUiArtifacts({ repoRoot: fixture.repoRoot, outputPath: inventoryPath,
    artifactRoots: { fixture: fixture.artifactRoot }, artifactStoreDir: join(consumerRoot, 'artifacts') });
  paths = resolveBundledPluginUiArtifactsInputPaths(inventoryPath).slice(1);
  assert.ok(paths.some(path => path.endsWith('/declaration.json.bundle')));
  check();
  await indexed;
  for (const platform of ['ios', 'android', 'web']) {
    for (const asset of paths) {
      const resolved = graph.resolveDependency(inventoryPath, {
        name: asset, data: { key: asset, asyncType: null, isESMImport: false, locs: [] },
      }, platform, { dev: true });
      assert.equal(resolved.filePath, asset);
      assert.ok((await graph.getOrComputeSha1(asset)).sha1);
    }
  }
});

test('Metro bundle admission serves last-good during source preparation and ignores unrelated workspace changes', async t => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.repoRoot, { recursive: true, force: true }));
  const inventoryPath = join(fixture.repoRoot, 'consumer/inventory.js');
  await generateBundledPluginUiArtifacts({ repoRoot: fixture.repoRoot, outputPath: inventoryPath,
    artifactRoots: { fixture: fixture.artifactRoot }, artifactStoreDir: join(fixture.repoRoot, 'consumer/artifacts') });
  const incumbent = await readFile(inventoryPath, 'utf8');
  withPatchedProcessEnv(t, { HAPPIER_UI_PLUGIN_ARTIFACT_INVENTORY: inventoryPath });
  const uiRoot = fileURLToPath(new URL('..', import.meta.url));
  const require = createRequire(join(uiRoot, 'package.json'));
  const configPath = join(uiRoot, 'metro.config.js');
  delete require.cache[require.resolve(configPath)];
  const config = require(configPath);
  t.after(() => { delete require.cache[require.resolve(configPath)]; });
  const watcher = new EventEmitter();
  const graph = new EventEmitter();
  graph.doesFileExist = path => fs.existsSync(path);
  const metroServer = { getWatchFolders: () => config.watchFolders,
    getBundler: () => ({ getBundler: () => ({ getWatcher: () => watcher, getDependencyGraph: async () => graph }) }),
    async end() {} };
  let compilerStarted;
  let compilerFailed;
  const started = new Promise((resolveStarted, rejectStarted) => { compilerStarted = resolveStarted; compilerFailed = rejectStarted; });
  void started.catch(() => {});
  const children = [];
  // Hold only the OS compiler process boundary. Input selection, queueing,
  // inventory admission and the production request middleware remain real.
  t.mock.method(childProcess, 'fork', () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    children.push(child);
    compilerStarted();
    return child;
  });
  syncBuiltinESMExports();
  const errors = [];
  t.mock.method(console, 'error', (...args) => {
    errors.push(args);
    if (children.length === 0) compilerFailed(args.find(value => value instanceof Error) ?? new Error('Source inventory failed before compiler admission'));
  });
  const middleware = config.server.enhanceMiddleware((_req, res) => {
    res.statusCode = 200;
    res.end(fs.readFileSync(inventoryPath, 'utf8'));
  }, metroServer);
  t.after(async () => {
    for (const child of children) child.emit('close', 1, null);
    await metroServer.end();
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  const request = () => new Promise((resolveResponse, reject) => {
    const response = { statusCode: 0, end(body) { resolveResponse({ status: this.statusCode, body }); } };
    middleware({ url: '/apps/ui/index.ts.bundle?platform=web', headers: {} }, response, reject);
  });
  assert.deepEqual(await request(), { status: 200, body: incumbent });
  const repoRoot = resolve(uiRoot, '../..');
  // Prime the actual watcher input census and reach a held preparation first.
  watcher.emit('change', { eventsQueue: [{ filePath: join(uiRoot, 'scripts/prepareSourcePluginUiArtifacts.mjs'), type: 'change' }] });
  await started;
  assert.equal(children.length, 1);
  assert.deepEqual(await request(), { status: 200, body: incumbent }, 'a pending compiler cannot replace last-good request readiness');
  for (let revision = 0; revision < 76; revision++) watcher.emit('change', { eventsQueue: [
    { filePath: join(uiRoot, 'sources/app/unrelated.tsx'), type: 'change' },
    { filePath: join(repoRoot, 'apps/stack/scripts/utils/dev/expo_dev.mjs'), type: 'change' },
    { filePath: join(repoRoot, '.project/notes.md'), type: 'change' },
    { filePath: join(repoRoot, 'packages/cli-common/src/machines/managed/provisioners.ts'), type: 'change' },
    { filePath: inventoryPath, type: 'change' },
  ] });
  // The request's real filesystem admission is also an asynchronous boundary
  // after the queued change handlers; no debounce clock decides the assertion.
  assert.deepEqual(await request(), { status: 200, body: incumbent });
  children[0].emit('close', 1, null);
  await t.waitFor(() => assert.equal(errors.length, 1));
  assert.equal(children.length, 1, '76 unrelated batches must admit zero trailing preparations');
  assert.deepEqual(await request(), { status: 200, body: incumbent }, 'failed preparation also leaves last-good served');
});

test('cold declaration inventory defers full manifests and loads only the demanded plugin in a compiled bundle', async () => {
  const fixture = await createFixture();
  try {
    await addSecondPlugin(fixture.repoRoot);
    const secondManifest = join(fixture.repoRoot, 'packages/plugins/second/.happier-plugin/plugin.json');
    await writeFile(secondManifest, JSON.stringify({ schemaVersion: 2, id: 'happier.second', version: '0.0.0',
      displayName: 'Second', runtime: { apiVersion: 1 }, contributes: {} }));
    const result = await generateBundledPluginUiArtifacts({ repoRoot: fixture.repoRoot });
    const output = await readFile(result.outputPath, 'utf8');
    const inventory = readEmittedPluginUiInventory(output);
    assert.equal(inventory.BUNDLED_PLUGIN_UI_APP_DECLARATIONS.length, 2);
    for (const declaration of inventory.BUNDLED_PLUGIN_UI_APP_DECLARATIONS) {
      assert.equal(Object.hasOwn(declaration, 'normalizedManifest'), false,
        'the initial module must carry discovery facts without full manifests');
      assert.equal(typeof declaration.loadDeclaration, 'function');
    }
    const { build } = await import('esbuild');
    const outdir = join(fixture.repoRoot, 'compiled');
    const built = await build({ entryPoints: [result.outputPath], outdir, bundle: true, splitting: true,
      format: 'esm', platform: 'neutral', outExtension: { '.js': '.mjs' }, metafile: true,
      plugins: [{ name: 'packaged-assets', setup(build) {
        build.onResolve({ filter: /\.bundle$/ }, args => ({ path: args.path, namespace: 'asset' }));
        build.onLoad({ filter: /.*/, namespace: 'asset' }, () => ({ contents: 'export default 1', loader: 'js' }));
      } }] });
    const { pathToFileURL } = await import('node:url');
    const compiled = await import(pathToFileURL(join(outdir, 'generatedBundledPluginUiArtifacts.mjs')).href);
    const first = compiled.BUNDLED_PLUGIN_UI_APP_DECLARATIONS.find(row => row.pluginId === 'happier.fixture');
    const declaration = await first.loadDeclaration();
    assert.equal(declaration.normalizedManifest.id, 'happier.fixture');
    assert.ok(Object.keys(declaration.entriesById).length > 0);
    const compiledEntry = await readFile(join(outdir, 'generatedBundledPluginUiArtifacts.mjs'), 'utf8');
    assert.doesNotMatch(compiledEntry, /normalizedManifest/);
    const chunks = Object.values(built.metafile.outputs).filter(output => Object.keys(output.inputs)
      .some(input => /[/\\]declarations[/\\][a-f0-9]+[/\\]declaration\.js$/.test(input)));
    assert.equal(chunks.length, 2, 'each plugin has one independent declaration chunk');
    assert.ok(chunks.every(output => Object.keys(output.inputs)
      .filter(input => /[/\\]declaration\.js$/.test(input)).length === 1));
  } finally { await rm(fixture.repoRoot, { recursive: true, force: true }); }
});

test('conditional portable source exports publish executable graphs through source preparation', async () => {
  const fixture = await createFixture();
  try {
    const root = join(fixture.repoRoot, 'packages/plugins/fixture');
    const packageJson = { name: '@happier-dev/plugins-fixture', version: '0.0.0', exports: {
      './happier-plugin-ui/fixture-card': {
        'happier-source': './src/card.ts', default: './dist/card.js',
      },
    } };
    await writeFile(join(root, 'package.json'), JSON.stringify(packageJson));
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src/card.ts'), 'export function renderSurface() { return null; }');
    const manifest = JSON.parse(await readFile(join(root, '.happier-plugin/plugin.json'), 'utf8'));
    const { prepareSourcePluginUiArtifacts } = await import('./prepareSourcePluginUiArtifacts.mjs');
    const result = await prepareSourcePluginUiArtifacts({ repoRoot: fixture.repoRoot,
      outputDir: join(fixture.repoRoot, 'source-preparation'),
      // The source host uses the same package membership decision.
      plugins: [{ directory: 'fixture', manifest,
        uiArtifacts: listBundledPluginUiArtifactExports(packageJson).length > 0 }],
    });
    assert.deepEqual(result.pluginFailures, []);
    const inventory = readEmittedPluginUiInventory(await readFile(result.outputPath, 'utf8'));
    assert.equal(inventory.BUNDLED_PLUGIN_UI_APP_ARTIFACTS.length, 1,
      'a conditional portable source must reach the compiler rather than publish metadata alone');
    const declaration = inventory.BUNDLED_PLUGIN_UI_APP_DECLARATIONS[0];
    assert.equal(declaration.artifactGraphs.length, 1);
  } finally { await rm(fixture.repoRoot, { recursive: true, force: true }); }
});

test('declaration data stays outside Metro JavaScript as schema fields grow', async t => {
  const fixture = await createFixture();
  try {
    const manifestPath = join(fixture.repoRoot, 'packages/plugins/fixture/.happier-plugin/plugin.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.contributes.actions = [{ id: 'read', title: 'Read', scopes: ['global'], surfaces: ['ui'],
      placementBindings: [], dangerLevel: 'safe', execution: { target: 'daemon' },
      inputSchema: { type: 'object', properties: {} } }];
    const require = createRequire(join(packageRoot, 'package.json'));
    const config = require('@expo/metro-config').getDefaultConfig(packageRoot);
    const worker = require(config.transformerPath);
    const counts = [];
    for (const size of [1, 1000]) {
      manifest.contributes.actions[0].inputSchema.properties = Object.fromEntries(
        Array.from({ length: size }, (_, index) => [`field${index}`, { type: 'string', description: `Value ${index}` }]),
      );
      await writeFile(manifestPath, JSON.stringify(manifest));
      const generated = await generateBundledPluginUiArtifacts({ repoRoot: fixture.repoRoot });
      const output = await readFile(generated.outputPath, 'utf8');
      const declarationPath = resolveBundledPluginUiArtifactsInputPaths(generated.outputPath)
        .find(path => path.endsWith('/declaration.json.bundle'));
      assert.ok(declarationPath, 'full declarations must be packaged assets, not transitive JavaScript modules');
      const inventory = readEmittedPluginUiInventory(output);
      const declaration = await inventory.BUNDLED_PLUGIN_UI_APP_DECLARATIONS[0].loadDeclaration();
      assert.deepEqual(declaration.normalizedManifest.contributes.actions[0].inputSchema.properties,
        manifest.contributes.actions[0].inputSchema.properties);
      const source = await readFile(declarationPath);
      assert.deepEqual(readBundledPluginUiDeclarationSource(source.toString()), declaration);
      assert.deepEqual(readBundledPluginUiDeclarationSource(`export const declaration = ${JSON.stringify(declaration)};`), declaration,
        'a previously served literal declaration remains available to last-good retention');
      const transformed = await worker.transform(config.transformer, packageRoot, declarationPath,
        source, { dev: true, hot: false, minify: false, inlineRequires: false,
          platform: 'web', type: 'asset', unstable_transformProfile: 'hermes-stable', customTransformOptions: {} });
      assert.equal(transformed.output.some(({ data }) => data.code?.includes('Value 999')), false,
        'the compiled root receives an asset descriptor without schema contents');
      counts.push(transformed.output.reduce((sum, output) => sum + (output.data.map?.length ?? 0), 0));
    }
    t.diagnostic(`Metro mappings: one schema field=${counts[0]}, one thousand fields=${counts[1]}`);
    assert.equal(counts[1], counts[0], 'declaration JSON fields must not multiply retained Metro source-map tuples');
  } finally { await rm(fixture.repoRoot, { recursive: true, force: true }); }
});

test('first-paint declaration bytes depend on discovery facts, not closed-surface schemas or copy', async () => {
  const fixture = await createFixture();
  try {
    const path = join(fixture.repoRoot, 'packages/plugins/fixture/.happier-plugin/plugin.json');
    const manifest = JSON.parse(await readFile(path, 'utf8'));
    manifest.contributes.ui.views[0].title = { key: 'nav.title', fallback: 'Fixture' };
    manifest.contributes.ui.renderers.push({ id: 'closed-body', kind: 'declarative', root: { kind: 'text', text: 'small' } });
    manifest.contributes.ui.views.push({ ...manifest.contributes.ui.views[0], id: 'closed-page', renderer: 'closed-body' });
    manifest.contributes.actions = [{ id: 'read', title: 'Read', scopes: ['global'], surfaces: ['ui'],
      placementBindings: [], dangerLevel: 'safe', execution: { target: 'daemon' }, inputSchema: { type: 'string', description: 'small' } }];
    manifest.contributes.ui.translations = [{ locale: 'en', messages: { 'nav.title': 'Fixture page', body: 'small' } }];
    await writeFile(path, JSON.stringify(manifest));
    const first = await generateBundledPluginUiArtifacts({ repoRoot: fixture.repoRoot });
    const small = await readFile(first.outputPath, 'utf8');
    manifest.contributes.actions[0].inputSchema.description = 'closed-schema-sentinel'.repeat(10000);
    manifest.contributes.ui.translations[0].messages.body = 'closed-copy-sentinel'.repeat(10000);
    manifest.contributes.ui.renderers.at(-1).root.text = 'closed-body-sentinel'.repeat(10000);
    await writeFile(path, JSON.stringify(manifest));
    const second = await generateBundledPluginUiArtifacts({ repoRoot: fixture.repoRoot });
    const large = await readFile(second.outputPath, 'utf8');
    assert.equal(Buffer.byteLength(large), Buffer.byteLength(small));
    assert.doesNotMatch(large, /closed-schema-sentinel|closed-copy-sentinel|closed-body-sentinel/);
    const index = readEmittedPluginUiInventory(large).BUNDLED_PLUGIN_UI_APP_DECLARATIONS[0];
    assert.equal(index.entriesById['translations:happier.fixture'].bundles.en['nav.title'], 'Fixture page');
    const declaration = await index.loadDeclaration();
    assert.equal(declaration.normalizedManifest.contributes.actions[0].inputSchema.description.length,
      manifest.contributes.actions[0].inputSchema.description.length);
    assert.equal(declaration.normalizedManifest.contributes.ui.renderers.at(-1).root.text,
      manifest.contributes.ui.renderers.at(-1).root.text);
    assert.equal(declaration.entriesById['translations:happier.fixture'].bundles.en.body,
      manifest.contributes.ui.translations[0].messages.body);
  } finally { await rm(fixture.repoRoot, { recursive: true, force: true }); }
});

let declarationAssetReader;
function readEmittedPluginUiInventory(output, requireAsset = () => 1) {
  if (!declarationAssetReader) {
    const require = createRequire(import.meta.url);
    const { buildSync } = require('esbuild');
    const compiled = buildSync({
      entryPoints: [join(packageRoot, 'sources/sync/domains/plugins/availability/bundledPluginUiArtifactAssetReader.ts')],
      bundle: true, packages: 'external', platform: 'node', format: 'cjs', write: false,
      alias: { '@': join(packageRoot, 'sources') },
    });
    const module = { exports: {} };
    runInNewContext(compiled.outputFiles[0].text, {
      module, exports: module.exports, JSON, Uint8Array, TextDecoder, fetch,
      require: name => name === 'expo-asset' ? {
        // Expo's packaged-asset lookup is the platform boundary. The reader and JSON decode stay real.
        Asset: { fromModule: asset => ({
          uri: `data:application/json;base64,${fs.readFileSync(asset).toString('base64')}`,
          downloadAsync: async () => {},
        }) },
      } : require(name),
    });
    declarationAssetReader = module.exports.readBundledPluginUiDeclarationAsset;
  }
  // Native assets are the external boundary; the generated data stays real.
  const source = output.replace(/^import \{ readBundledPluginUiDeclarationAsset \} from .+;$/m, '')
    .replace(/^import \{ decodeBase64 \} from .+;$/m, '');
  return runInNewContext(`${source.replaceAll('export const ', 'const ').replaceAll('import(', 'loadDeclarationModule(')}\n({ BUNDLED_PLUGIN_UI_APP_DECLARATIONS, BUNDLED_PLUGIN_UI_APP_ARTIFACTS, BUNDLED_PLUGIN_BRAND_MARKS, BUNDLED_PLUGIN_PACKAGED_RESOURCES: typeof BUNDLED_PLUGIN_PACKAGED_RESOURCES === 'undefined' ? [] : BUNDLED_PLUGIN_PACKAGED_RESOURCES });`, {
    require: asset => asset.endsWith('/declaration.json.bundle') ? asset : requireAsset(asset),
    readBundledPluginUiDeclarationAsset: declarationAssetReader,
    decodeBase64,
    Uint8Array, loadDeclarationModule: specifier => import(pathToFileURL(specifier).href),
  });
}

async function createFixture() {
  const repoRoot = await mkdtemp(join(tmpdir(), 'happier-ui-preseed-'));
  const uiDir = join(repoRoot, 'apps', 'ui');
  const packageRoot = join(repoRoot, 'packages', 'plugins', 'fixture');
  const artifactRoot = join(packageRoot, 'dist', 'happier-plugin-ui');
  const relativePath = 'react-native/fixture-card/entry.cjs.bundle';
  const bytes = new TextEncoder().encode('module.exports = { fixture: true };\n');
  const fileDigest = computePluginUiArtifactSha256DigestV1(bytes);
  const artifactDigest = computePluginUiArtifactFileSetSha256DigestV1([{ relativePath, bytes }]);

  await mkdir(join(artifactRoot, 'react-native', 'fixture-card'), { recursive: true });
  await mkdir(join(packageRoot, '.happier-plugin'), { recursive: true });
  await mkdir(uiDir, { recursive: true });
  await writeFile(join(uiDir, 'package.json'), `${JSON.stringify({
    dependencies: { '@happier-dev/plugins-fixture': '0.0.0' },
  }, null, 2)}\n`);
  await writeFile(join(packageRoot, 'package.json'), `${JSON.stringify({
    name: '@happier-dev/plugins-fixture',
    version: '0.0.0',
  }, null, 2)}\n`);
  await writeFile(join(packageRoot, '.happier-plugin', 'plugin.json'), `${JSON.stringify({
    schemaVersion: 2, id: 'happier.fixture', version: '0.0.0', displayName: 'Fixture', runtime: { apiVersion: 1 },
    contributes: { ui: { renderers: [{ id: 'fixture', kind: 'reactNative', artifact: 'fixture-card' }],
      views: [{ id: 'fixture', container: 'appPage', target: { kind: 'app' }, renderer: 'fixture', title: 'Fixture' }] } },
  }, null, 2)}\n`);
  await writeFile(join(artifactRoot, relativePath), bytes);
  await writeFile(join(artifactRoot, 'ui-artifacts.json'), `${JSON.stringify({
    version: 2,
    entries: [{
      artifactId: 'fixture-card',
      tier: 'reactNative',
      entry: relativePath,
      files: [{ relativePath, digest: fileDigest, byteSize: bytes.byteLength }],
      digest: artifactDigest,
      builtWith: { bundler: 'esbuild', version: '1.0.0' },
      executable: { exports: ['renderSurface'] },
      hostUiApiRange: '^1.0.0',
    }],
  }, null, 2)}\n`);

  return { repoRoot, artifactRoot, relativePath };
}

async function addSecondPlugin(repoRoot) {
  const packageRoot = join(repoRoot, 'packages', 'plugins', 'second');
  const artifactRoot = join(packageRoot, 'dist', 'happier-plugin-ui');
  const relativePath = 'react-native/second-card/entry.cjs.bundle';
  const bytes = new TextEncoder().encode('module.exports = { second: true };\n');
  await mkdir(join(artifactRoot, 'react-native', 'second-card'), { recursive: true });
  await mkdir(join(packageRoot, '.happier-plugin'), { recursive: true });
  const uiPackagePath = join(repoRoot, 'apps', 'ui', 'package.json');
  const uiPackage = JSON.parse(await readFile(uiPackagePath, 'utf8'));
  uiPackage.dependencies['@happier-dev/plugins-second'] = '0.0.0';
  await writeFile(uiPackagePath, `${JSON.stringify(uiPackage)}\n`);
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({
    name: '@happier-dev/plugins-second', version: '0.0.0',
  }));
  await writeFile(join(packageRoot, '.happier-plugin', 'plugin.json'), JSON.stringify({
    id: 'happier.second',
  }));
  await writeFile(join(artifactRoot, relativePath), bytes);
  await writeFile(join(artifactRoot, 'ui-artifacts.json'), JSON.stringify({
    version: 2,
    entries: [{
      artifactId: 'second-card', tier: 'reactNative', entry: relativePath,
      files: [{
        relativePath,
        digest: computePluginUiArtifactSha256DigestV1(bytes),
        byteSize: bytes.byteLength,
      }],
      digest: computePluginUiArtifactFileSetSha256DigestV1([{ relativePath, bytes }]),
      builtWith: { bundler: 'esbuild', version: '1.0.0' },
      executable: { exports: ['renderSurface'] },
      hostUiApiRange: '^1.0.0',
    }],
  }));
}

test('built RN artifacts resolve without package exports and with Channels-style bundle exports', async () => {
  const fixture = await createFixture();
  try {
    await addSecondPlugin(fixture.repoRoot);
    const modules = join(fixture.repoRoot, 'apps/ui/node_modules/@happier-dev');
    await mkdir(modules, { recursive: true });
    for (const [plugin, relativePath, exports] of [
      ['fixture', fixture.relativePath, { './happier-plugin-ui/fixture-card': './src/ui/card.tsx' }],
      ['second', 'react-native/second-card/entry.cjs.bundle', {
        './happier-plugin-ui/react-native/second-card/entry.cjs.bundle':
          './dist/happier-plugin-ui/react-native/second-card/entry.cjs.bundle',
      }],
    ]) {
      const root = join(fixture.repoRoot, 'packages/plugins', plugin);
      await writeFile(join(root, 'package.json'), JSON.stringify({
        name: `@happier-dev/plugins-${plugin}`, version: '0.0.0', exports,
      }));
      await symlink(root, join(modules, `plugins-${plugin}`), process.platform === 'win32' ? 'junction' : 'dir');
      assert.ok(await stat(join(root, 'dist/happier-plugin-ui', relativePath)));
    }
    const result = await generateBundledPluginUiArtifacts({ repoRoot: fixture.repoRoot });
    assert.deepEqual(result.pluginFailures, []);
    const inventory = readEmittedPluginUiInventory(await readFile(result.outputPath, 'utf8'), specifier => specifier);
    const specifiers = Array.from(inventory.BUNDLED_PLUGIN_UI_APP_ARTIFACTS,
      artifact => artifact.files[0].asset);
    // This is a packaged consumer, without the preparation process's authored
    // workspace resolver. Exercise Node's real package exports in a child.
    const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '--eval', [
      'import { createRequire } from "node:module";',
      `import { resolveBundledPluginUiArtifactsInputPaths } from ${JSON.stringify(pathToFileURL(resolve(packageRoot, 'scripts/generateBundledPluginUiArtifacts.mjs')).href)};`,
      `const require = createRequire(${JSON.stringify(result.outputPath)});`,
      `console.log(JSON.stringify({ resolved: ${JSON.stringify(specifiers)}.map(specifier => require.resolve(specifier)), inputPaths: resolveBundledPluginUiArtifactsInputPaths(${JSON.stringify(result.outputPath)}) }));`,
    ].join('\n')], { env: { ...process.env, NODE_OPTIONS: '' } });
    const consumer = JSON.parse(stdout);
    assert.deepEqual(consumer.resolved, [
      join(fixture.artifactRoot, fixture.relativePath),
      join(fixture.repoRoot, 'packages/plugins/second/dist/happier-plugin-ui/react-native/second-card/entry.cjs.bundle'),
    ]);
    assert.ok(consumer.inputPaths?.includes(
      join(fixture.artifactRoot, fixture.relativePath)));
  } finally { await rm(fixture.repoRoot, { recursive: true, force: true }); }
});

async function addFixtureBrand(fixture) {
  const pluginRoot = join(fixture.repoRoot, 'packages/plugins/fixture');
  const bytes = await readFile(resolve(packageRoot, '../../packages/plugins/inspector/assets/brand.png'));
  await mkdir(join(pluginRoot, 'assets'), { recursive: true });
  await writeFile(join(pluginRoot, 'assets/brand.png'), bytes);
  const existing = JSON.parse(await readFile(join(pluginRoot, '.happier-plugin/plugin.json'), 'utf8'));
  const manifest = {
    ...existing, brand: { iconResourceId: 'brand-icon', monochrome: true },
    contributes: { ...existing.contributes, resources: [{ id: 'brand-icon', kind: 'asset', path: 'assets/brand.png', contentType: 'image/png' }] },
  };
  await writeFile(join(pluginRoot, '.happier-plugin/plugin.json'), JSON.stringify(manifest));
  return { bytes, manifest };
}

async function addFixtureTranslationResources(fixture) {
  const root = join(fixture.repoRoot, 'packages/plugins/fixture');
  const manifestPath = join(root, '.happier-plugin/plugin.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const bytes = Buffer.from('{"label":"resource-only-sentinel"}\n');
  await mkdir(join(root, 'assets/i18n'), { recursive: true });
  await writeFile(join(root, 'assets/i18n/en.json'), bytes);
  manifest.contributes.resources = [
    ...(manifest.contributes.resources ?? []),
    { id: 'locale/en', kind: 'asset', path: 'assets/i18n/en.json', contentType: 'application/json' },
    { id: 'same-file-alias', kind: 'asset', path: 'assets/i18n/en.json', contentType: 'application/json' },
  ];
  manifest.contributes.ui.translations = [{ locale: 'en', resourceId: 'locale/en' }];
  await writeFile(manifestPath, JSON.stringify(manifest));
  return { root, manifestPath, manifest, bytes };
}

test('historical artifact retention settles unavailable process observations across plugin groups', { skip: typeof process.getuid !== 'function' }, async t => {
  const fixture = await createFixture();
  try {
    const artifactStoreDir = join(fixture.repoRoot, 'consumer/artifacts');
    const outputPath = join(fixture.repoRoot, 'consumer/inventory.js');
    await generateBundledPluginUiArtifacts({ repoRoot: fixture.repoRoot,
      artifactRoots: { fixture: fixture.artifactRoot }, artifactStoreDir, outputPath });
    const stages = ['fixture', 'second'].map(plugin => join(artifactStoreDir, plugin, '.happier-plugin-ui-stage-orphan'));
    const historical = new Date(Date.now() - 48 * 60 * 60 * 1000);
    for (const stage of stages) {
      await mkdir(stage, { recursive: true });
      await utimes(stage, historical, historical);
    }
    const procRoot = join(fixture.repoRoot, 'unavailable-proc');
    await mkdir(join(procRoot, '123'), { recursive: true });
    const missingStatus = join(procRoot, '123/status');
    let censusAttempts = 0;
    const readFile = fs.readFileSync;
    // Observe the real OS read boundary; retain the complete internal census.
    t.mock.method(fs, 'readFileSync', (path, ...args) => {
      if (path === missingStatus) censusAttempts++;
      return readFile(path, ...args);
    });
    syncBuiltinESMExports();
    try {
      const result = reapBundledPluginUiArtifactStore({ artifactStoreDir, inventoryPaths: [outputPath], procRoot });
      assert.equal(result.reclaimedRoots, 0);
      assert.ok(result.observationUnavailable);
      assert.equal(censusAttempts, 1, 'one unavailable global process observation settles the complete artifact-store sweep');
      for (const stage of stages) assert.ok(await stat(stage));
    } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  } finally { await rm(fixture.repoRoot, { recursive: true, force: true }); }
});

test('historical artifact retention preserves current, last-green and delayed serving graphs', { skip: typeof process.getuid !== 'function' }, async t => {
  const fixture = await createFixture();
  try {
    const artifactStoreDir = join(fixture.repoRoot, 'consumer/artifacts');
    const outputPath = join(fixture.repoRoot, 'consumer/inventory.js');
    const retainedPath = join(fixture.repoRoot, 'consumer/last-green.js');
    const legacyInventoryPath = join(fixture.repoRoot, 'consumer/legacy-retained.js');
    const options = { repoRoot: fixture.repoRoot, artifactRoots: { fixture: fixture.artifactRoot }, artifactStoreDir, outputPath };
    const legacyKept = join(dirname(artifactStoreDir), 'preparation-KEEP00');
    const legacyDiscarded = join(dirname(artifactStoreDir), 'preparation-OLD000');
    await generateBundledPluginUiArtifacts({ ...options, outputPath: legacyInventoryPath,
      artifactOutputDirs: { fixture: join(legacyKept, 'inputs/fixture/happier-plugin-ui') } });
    await mkdir(legacyDiscarded);
    const publish = async label => {
      const bytes = Buffer.from(`module.exports = { label: ${JSON.stringify(label)} };`);
      const manifestPath = join(fixture.artifactRoot, 'ui-artifacts.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      const entry = manifest.entries[0];
      entry.files[0].digest = computePluginUiArtifactSha256DigestV1(bytes);
      entry.files[0].byteSize = bytes.byteLength;
      entry.digest = computePluginUiArtifactFileSetSha256DigestV1([{ relativePath: fixture.relativePath, bytes }]);
      await writeFile(join(fixture.artifactRoot, fixture.relativePath), bytes);
      await writeFile(manifestPath, JSON.stringify(manifest));
      return (await generateBundledPluginUiArtifacts(options)).artifactRoots.fixture;
    };
    const superseded = (await generateBundledPluginUiArtifacts(options)).artifactRoots.fixture;
    const supersededInventory = await readFile(outputPath, 'utf8');
    const lastGreen = await publish('last-green');
    assert.equal(await retainBundledPluginUiArtifactsInventory({ inventoryPath: outputPath, outputPath: retainedPath }), true);
    const current = await publish('current');
    const stage = join(artifactStoreDir, 'fixture/.happier-plugin-ui-stage-orphan');
    await mkdir(stage);
    const procRoot = join(fixture.repoRoot, 'empty-proc');
    await mkdir(procRoot);
    const historical = new Date(Date.now() - 48 * 60 * 60 * 1000);
    const ageTree = async directory => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await ageTree(path);
        await utimes(path, historical, historical);
      }
      await utimes(directory, historical, historical);
    };
    await ageTree(artifactStoreDir);
    await ageTree(legacyKept);
    await ageTree(legacyDiscarded);
    const reap = extra => reapBundledPluginUiArtifactStore({ artifactStoreDir,
      inventoryPaths: [outputPath, retainedPath, legacyInventoryPath], procRoot, ...extra });
    const getuid = Object.getOwnPropertyDescriptor(process, 'getuid');
    try {
      Object.defineProperty(process, 'getuid', { value: undefined, configurable: true });
      const unsupported = reap({ retainCandidate: () => false });
      assert.equal(unsupported.reclaimedRoots, 0);
      assert.ok(unsupported.observationUnavailable, 'unsupported ownership observation retains without breaking publication');
    } finally { Object.defineProperty(process, 'getuid', getuid); }
    const serving = reap();
    assert.equal(serving.reclaimedRoots, 1, 'only abandoned staging can be reaped without retirement evidence');
    assert.ok(await stat(superseded), 'old browser/native URLs remain readable while their Expo may serve');
    assert.ok(await stat(legacyDiscarded), 'legacy preparation roots may also contain delayed serving graphs');
    assert.equal(reap({ retainCandidate: () => undefined }).reclaimedRoots, 0,
      'an unknown lifecycle observation cannot authorize graph deletion');
    const aliasParent = join(fixture.repoRoot, 'consumer-alias');
    await symlink(dirname(artifactStoreDir), aliasParent, 'dir');
    const aliasStore = join(aliasParent, 'artifacts');
    const aliasInventory = join(aliasParent, 'inventory.js');
    // The process boundary is a real procfs-shaped fixture. A detached Metro
    // need not hold an artifact fd while a browser delays its asset request.
    const detached = join(procRoot, '123');
    await mkdir(join(detached, 'fd'), { recursive: true });
    const uid = process.getuid();
    await writeFile(join(detached, 'status'), `State:\tS\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\n`);
    await writeFile(join(detached, 'maps'), '');
    await symlink(fixture.repoRoot, join(detached, 'cwd'), 'dir');
    for (const [inventoryPath, binding] of [[aliasInventory, outputPath], [outputPath, aliasInventory]]) {
      await writeFile(join(detached, 'environ'), `HAPPIER_UI_PLUGIN_ARTIFACT_INVENTORY=${binding}\0`);
      assert.equal(reap({ inventoryPaths: [inventoryPath, retainedPath, legacyInventoryPath],
        retainCandidate: () => false }).reclaimedRoots, 0,
      'a live inventory binding protects detached serving graphs through either path alias');
      assert.ok(await stat(superseded));
    }
    await writeFile(join(detached, 'environ'), `HAPPIER_UI_PLUGIN_ARTIFACT_INVENTORY=${outputPath}\0`);
    const currentInventory = await readFile(outputPath, 'utf8');
    const readProcessFile = fs.readFileSync;
    // A publisher replaces the inventory after the census observes the live
    // binding's inode, but before the candidate's final retention check.
    t.mock.method(fs, 'readFileSync', (path, ...args) => {
      if (path === join(detached, 'maps')) {
        const replacement = `${outputPath}.atomic-publication`;
        writeFileSync(replacement, currentInventory);
        fs.renameSync(replacement, outputPath);
      }
      return readProcessFile(path, ...args);
    });
    syncBuiltinESMExports();
    try {
      assert.equal(reap({ inventoryPaths: [aliasInventory, retainedPath, legacyInventoryPath],
        retainCandidate: () => false }).reclaimedRoots, 0,
      'an atomic inventory publication preserves a live binding across path aliases');
      assert.ok(await stat(superseded));
    } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
    await rm(detached, { recursive: true });
    const retainedInventory = await readFile(retainedPath, 'utf8');
    await writeFile(retainedPath, 'invalid inventory');
    const unavailable = reap({ retainCandidate: () => false });
    assert.equal(unavailable.reclaimedRoots, 0, 'unreadable last-green membership cannot authorize graph deletion');
    assert.ok(unavailable.observationUnavailable);
    await writeFile(retainedPath, retainedInventory);
    const republished = reap({ artifactStoreDir: aliasStore, retainCandidate(directory) {
      if (directory !== superseded && directory !== superseded.replace(artifactStoreDir, aliasStore)) return true;
      writeFileSync(retainedPath, supersededInventory.replaceAll(artifactStoreDir, aliasStore));
      return false;
    } });
    assert.equal(republished.reclaimedRoots, 0, 'a selection published through a path alias during observation is rechecked before deletion');
    assert.ok(await stat(superseded));
    await writeFile(retainedPath, retainedInventory);
    const preview = reap({ dryRun: true, retainCandidate: () => false });
    assert.equal(preview.reclaimableRoots, 2);
    assert.equal(preview.reclaimedRoots, 0);
    assert.ok(await stat(superseded));
    const retired = reap({ retainCandidate: () => false });
    assert.equal(retired.reclaimedRoots, 2, 'a retired serving runtime releases only superseded graphs');
    await assert.rejects(stat(superseded), { code: 'ENOENT' });
    await assert.rejects(stat(legacyDiscarded), { code: 'ENOENT' });
    assert.ok(await stat(legacyKept), 'inventory references protect legacy preparation subtrees');
    assert.ok(await stat(lastGreen), 'a separately retained per-plugin last-green graph outlives reclamation');
    assert.ok(await stat(current));
    // A failed new compilation still consumes the inventory's last-green graph.
    const { prepareSourcePluginUiArtifacts } = await import('./prepareSourcePluginUiArtifacts.mjs');
    const failed = await prepareSourcePluginUiArtifacts({ repoRoot: fixture.repoRoot,
      outputDir: join(fixture.repoRoot, 'failed-preparation'), outputPath: join(fixture.repoRoot, 'consumer/recovered.js'),
      artifactStoreDir, retainedInventoryPath: retainedPath,
      plugins: [{ directory: 'fixture', loadManifest() { throw new Error('authored manifest is invalid'); } }] });
    assert.equal(failed.pluginFailures.length, 0);
    assert.equal(failed.diagnostics.length, 1);
    assert.equal(failed.artifactRoots.fixture, lastGreen);
  } finally { await rm(fixture.repoRoot, { recursive: true, force: true }); }
});

for (const sourceStore of [false, true]) {
  test(`packaged JSON Resources use exact raw Metro assets through the existing publication graph (source store: ${sourceStore})`, async () => {
    const fixture = await createFixture();
    try {
      const resource = await addFixtureTranslationResources(fixture);
      if (!sourceStore) {
        await writeFile(join(resource.root, 'package.json'), JSON.stringify({ name: '@happier-dev/plugins-fixture', version: '0.0.0',
          exports: { [`./happier-plugin-ui/${fixture.relativePath}`]: `./dist/happier-plugin-ui/${fixture.relativePath}` } }));
        await mkdir(join(fixture.repoRoot, 'node_modules/@happier-dev'), { recursive: true });
        await symlink(resource.root, join(fixture.repoRoot, 'node_modules/@happier-dev/plugins-fixture'), 'dir');
      }
      const options = { repoRoot: fixture.repoRoot, ...(sourceStore ? {
        artifactRoots: { fixture: fixture.artifactRoot }, artifactStoreDir: join(fixture.repoRoot, 'consumer/artifacts'),
        outputPath: join(fixture.repoRoot, 'consumer/inventory.js'),
      } : {}) };
      const result = await generateBundledPluginUiArtifacts(options);
      assert.deepEqual(result.pluginFailures, []);
      const output = await readFile(result.outputPath, 'utf8');
      const imports = [];
      const emitted = readEmittedPluginUiInventory(output, path => { imports.push(path); return path; });
      const resources = emitted.BUNDLED_PLUGIN_PACKAGED_RESOURCES;
      assert.equal(resources.length, 2);
      assert.deepEqual(Array.from(resources, row => ({ pluginId: row.pluginId, resourceId: row.resourceId,
        releaseVersion: row.releaseVersion, digest: row.digest })), ['locale/en', 'same-file-alias'].map(resourceId => ({
        pluginId: 'happier.fixture', resourceId, releaseVersion: '0.0.0', digest: computePluginUiArtifactSha256DigestV1(resource.bytes),
      })));
      assert.equal(resources[0].asset, resources[1].asset, 'Resource aliases share the same physical Metro asset');
      assert.ok(resources[0].asset.endsWith(join('packaged-resources', 'assets', 'i18n', 'en.json.bundle')));
      assert.deepEqual(await readFile(resources[0].asset), resource.bytes);
      assert.equal(imports.filter(path => path.endsWith('.json.bundle')).length, 1, 'one physical asset import per declared file');
      assert.ok(imports.every(path => !path.endsWith('.json')), 'JSON values never enter an executable require');
      assert.doesNotMatch(output, /resource-only-sentinel/);
      assert.equal(emitted.BUNDLED_PLUGIN_UI_APP_ARTIFACTS[0].digest,
        JSON.parse(await readFile(join(fixture.artifactRoot, 'ui-artifacts.json'), 'utf8')).entries[0].digest);
      // Installed exports resolve in a packaged Node environment. The source
      // preparation loader above deliberately knows only the real repository's
      // first-party workspaces, not this external package filesystem fixture.
      const inventory = sourceStore ? {
        paths: resolveBundledPluginUiArtifactsInputPaths(result.outputPath),
        roots: [...resolveBundledPluginUiArtifactsRetainedRoots(result.outputPath)],
      }
        : JSON.parse((await execFileAsync(process.execPath, [
          '--conditions=happier-source', '--import', 'tsx', '--input-type=module', '--eval', `
            import { resolveBundledPluginUiArtifactsInputPaths, resolveBundledPluginUiArtifactsRetainedRoots } from ${JSON.stringify(new URL('./generateBundledPluginUiArtifacts.mjs', import.meta.url).href)};
            process.stdout.write(JSON.stringify({ paths: resolveBundledPluginUiArtifactsInputPaths(process.argv[1]),
              roots: [...resolveBundledPluginUiArtifactsRetainedRoots(process.argv[1])] }));
          `, result.outputPath,
        ], { env: { ...process.env, NODE_OPTIONS: '' } })).stdout);
      assert.ok(inventory.paths?.includes(resources[0].asset));
      assert.equal(new Map(inventory.roots).get('happier.fixture'), result.artifactRoots.fixture);
      const first = await stat(resources[0].asset);
      await generateBundledPluginUiArtifacts(options);
      assert.equal((await stat(resources[0].asset)).ino, first.ino, 'unchanged Resource bytes do not republish a physical asset');
      if (sourceStore) {
        const changed = Buffer.from('{"label":"updated-resource-sentinel"}\n');
        await writeFile(join(resource.root, 'assets/i18n/en.json'), changed);
        await generateBundledPluginUiArtifacts(options);
        const next = readEmittedPluginUiInventory(await readFile(result.outputPath, 'utf8'), path => path);
        assert.notEqual(next.BUNDLED_PLUGIN_PACKAGED_RESOURCES[0].asset, resources[0].asset);
        assert.deepEqual(await readFile(next.BUNDLED_PLUGIN_PACKAGED_RESOURCES[0].asset), changed);
        assert.deepEqual(await readFile(resources[0].asset), resource.bytes, 'delayed consumers retain the previous raw bytes');
        assert.equal(next.BUNDLED_PLUGIN_UI_APP_ARTIFACTS[0].digest, emitted.BUNDLED_PLUGIN_UI_APP_ARTIFACTS[0].digest);
      } else {
        await generateBundledPluginUiArtifacts({ ...options, mode: 'check' });
      }
    } finally { await rm(fixture.repoRoot, { recursive: true, force: true }); }
  });
}

for (const sourceStore of [false, true]) test(`source preparation publishes Resource-only plugins without executable UI artifacts or package dist writes (source store: ${sourceStore})`, async () => {
  const fixture = await createFixture();
  try {
    const resource = await addFixtureTranslationResources(fixture);
    resource.manifest.contributes.ui = { translations: resource.manifest.contributes.ui.translations };
    await rm(fixture.artifactRoot, { recursive: true });
    const { prepareSourcePluginUiArtifacts } = await import('./prepareSourcePluginUiArtifacts.mjs');
    const outputDir = join(fixture.repoRoot, 'private-inputs');
    const artifactStoreDir = join(fixture.repoRoot, 'consumer/artifacts');
    const result = await prepareSourcePluginUiArtifacts({ repoRoot: fixture.repoRoot, outputDir,
      ...(sourceStore ? { artifactStoreDir } : {}),
      plugins: [{ directory: 'fixture', manifest: resource.manifest, uiArtifacts: false }] });
    assert.deepEqual(result.pluginFailures, []);
    const emitted = readEmittedPluginUiInventory(await readFile(result.outputPath, 'utf8'), path => path);
    assert.equal(emitted.BUNDLED_PLUGIN_UI_APP_ARTIFACTS.length, 0);
    assert.equal(emitted.BUNDLED_PLUGIN_PACKAGED_RESOURCES.length, 2);
    const asset = emitted.BUNDLED_PLUGIN_PACKAGED_RESOURCES[0].asset;
    assert.ok(asset.startsWith(`${sourceStore ? join(artifactStoreDir, 'fixture') : join(outputDir, 'fixture/happier-plugin-ui')}${sep}`));
    assert.deepEqual(await readFile(asset), resource.bytes);
    assert.ok(resolveBundledPluginUiArtifactsInputPaths(result.outputPath).includes(asset));
    assert.equal(resolveBundledPluginUiArtifactsRetainedRoots(result.outputPath).get('happier.fixture'), result.artifactRoots.fixture);
    if (sourceStore) {
      await rm(join(outputDir, 'fixture'), { recursive: true, force: true });
      assert.deepEqual(await readFile(asset), resource.bytes, 'live Resource bytes outlive compiler scratch');
    }
    await assert.rejects(stat(fixture.artifactRoot), { code: 'ENOENT' });
  } finally { await rm(fixture.repoRoot, { recursive: true, force: true }); }
});

for (const invalid of ['missing', 'escape', 'symlink']) {
  test(`invalid packaged Resource bytes are diagnosed per plugin (${invalid})`, async () => {
    const fixture = await createFixture();
    try {
      const resource = await addFixtureTranslationResources(fixture);
      await addSecondPlugin(fixture.repoRoot);
      if (invalid === 'missing') await rm(join(resource.root, 'assets/i18n/en.json'));
      else if (invalid === 'escape') {
        for (const entry of resource.manifest.contributes.resources) entry.path = '../outside.json';
        await writeFile(resource.manifestPath, JSON.stringify(resource.manifest));
      } else {
        await rm(join(resource.root, 'assets/i18n'), { recursive: true });
        const outside = join(fixture.repoRoot, 'outside-resource');
        await mkdir(outside);
        await writeFile(join(outside, 'en.json'), resource.bytes);
        await symlink(outside, join(resource.root, 'assets/i18n'), 'dir');
      }
      const result = await generateBundledPluginUiArtifacts({ repoRoot: fixture.repoRoot });
      assert.deepEqual(result.pluginFailures.map(row => row.pluginId), ['happier.fixture']);
      const emitted = readEmittedPluginUiInventory(await readFile(result.outputPath, 'utf8'));
      assert.equal(emitted.BUNDLED_PLUGIN_PACKAGED_RESOURCES.length, 0);
      assert.deepEqual(Array.from(emitted.BUNDLED_PLUGIN_UI_APP_ARTIFACTS, row => row.pluginId), ['happier.second']);
    } finally { await rm(fixture.repoRoot, { recursive: true, force: true }); }
  });
}

test('the UI prebuild owns one universal exact app-preseed registry from canonical artifact manifests', async () => {
  const fixture = await createFixture();
  try {
    const manifestPath = join(fixture.repoRoot, 'packages/plugins/fixture/.happier-plugin/plugin.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const collection = { id: 'notes', schemaVersion: 1,
      schema: { type: 'object', properties: { id: { type: 'string', maxLength: 256 } }, required: ['id'], additionalProperties: false },
      rowIdField: 'id', serverReadable: ['id'], indexes: [], uiQueries: [], relations: [], readableSchemaVersions: [1] };
    manifest.contributes.accountCollections = [collection];
    manifest.contributes.actions = [{ id: 'read', title: 'Read', scopes: ['global'], surfaces: ['ui'],
      placementBindings: [], dangerLevel: 'safe', execution: { target: 'daemon' } }];
    manifest.contributes.pluginContributionPoints = [{ id: 'providers', maxContributionsPerContributor: 1,
      protocols: [{ id: 'acme.fixture/providers', version: 1, operations: { read: { required: true,
        input: { kind: 'contributorDefined' }, resultSchema: { type: 'object' },
        action: { surfaces: ['plugin', 'ui'], dangerLevel: 'safe' } } } }] }];
    const { PluginPortableReleaseManifestV1Schema } = await import('@happier-dev/protocol/plugins/availability');
    // Keep fixture drift distinguishable from a missing compiled declaration.
    PluginPortableReleaseManifestV1Schema.parse(manifest);
    await writeFile(manifestPath, JSON.stringify(manifest));
    await generateBundledPluginUiArtifacts({ repoRoot: fixture.repoRoot, mode: 'write' });

    const outputPath = resolveBundledPluginUiArtifactsOutputPath(fixture.repoRoot);
    assert.match(outputPath, /generatedBundledPluginUiArtifacts\.js$/);
    const output = await readFile(outputPath, 'utf8');
    assert.doesNotMatch(output, /import type|\]\) satisfies/);
    assert.match(output, /@satisfies \{import\('\.\/bundledPluginUiArtifactInventory'\)\.BundledPluginUiAppArtifactInventory\}/);
    assert.match(output, /apps\/ui\/scripts\/generateBundledPluginUiArtifacts\.mjs/);
    assert.ok(output.includes(`require(${JSON.stringify(join(fixture.artifactRoot, fixture.relativePath))})`));
    assert.match(output, /pluginId: "happier\.fixture"/);
    assert.match(output, /artifactId: "fixture-card"/);
    const graph = JSON.parse(output.match(/    artifactGraph: .*\*\/ \((.+)\),/)[1]);
    assert.equal(graph.artifactId, 'fixture-card');
    assert.equal(graph.digest, JSON.parse(await readFile(join(fixture.artifactRoot, 'ui-artifacts.json'), 'utf8')).entries[0].digest);
    // Native asset loading is the only substituted boundary. Evaluate the real
    // emitted declarations and inventory together, as the app imports them.
    const emitted = readEmittedPluginUiInventory(output);
    assert.equal(emitted.BUNDLED_PLUGIN_UI_APP_DECLARATIONS.length, 1);
    assert.ok(emitted.BUNDLED_PLUGIN_UI_APP_ARTIFACTS.every(row => !Object.hasOwn(row, 'uiDeclaration')));
    const declaration = JSON.parse(JSON.stringify(await emitted.BUNDLED_PLUGIN_UI_APP_DECLARATIONS[0].loadDeclaration()));
    assert.equal(declaration.pluginId, 'happier.fixture');
    assert.equal(declaration.packageName, '@happier-dev/plugins-fixture');
    assert.equal(declaration.normalizedManifest.id, manifest.id);
    assert.deepEqual(declaration.normalizedManifest.contributes.actions, manifest.contributes.actions);
    assert.deepEqual(declaration.artifactGraphs, JSON.parse(await readFile(join(fixture.artifactRoot, 'ui-artifacts.json'), 'utf8')).entries);
    assert.equal(Object.hasOwn(declaration, 'accountCustody'), false);
    assert.deepEqual(declaration.declaredExecution, { daemonActions: true, contributionPoints: true });
    const { normalizePluginAccountCollectionContractV1 } = await import('@happier-dev/protocol/plugins/data/collectionsV1');
    const compiled = normalizePluginAccountCollectionContractV1({ pluginId: manifest.id, contribution: collection });
    assert.deepEqual(declaration.collectionContracts, [{ pluginId: manifest.id, collectionId: collection.id,
      schemaVersion: collection.schemaVersion, contractDigest: compiled.contractDigest }]);
    assert.equal(declaration.entriesById['reactNativeBundle:happier.fixture:fixture'].artifactGraph.digest, graph.digest);
    assert.equal(declaration.entriesById['surfacePlacement:happier.fixture:fixture'].availability.state, 'available');
    assert.doesNotMatch(output, /uiDeclaration:/);
    assert.doesNotMatch(output, /platform:/);

    manifest.contributes.actions = [{ ...manifest.contributes.actions[0], execution: { target: 'client',
      client: { artifactId: 'fixture-card', exportName: 'activate' }, platforms: ['web'] } }];
    manifest.contributes.pluginContributionPoints = [];
    await writeFile(manifestPath, JSON.stringify(manifest));
    await generateBundledPluginUiArtifacts({ repoRoot: fixture.repoRoot, mode: 'write' });
    const clientOnlyOutput = await readFile(outputPath, 'utf8');
    const clientOnlyDeclaration = JSON.parse(clientOnlyOutput.match(/const BUNDLED_PLUGIN_UI_APP_DECLARATION_0 = (.+);/)[1]);
    assert.equal(Object.hasOwn(clientOnlyDeclaration, 'accountCustody'), false);
    assert.deepEqual(clientOnlyDeclaration.declaredExecution, { daemonActions: false, contributionPoints: false });

    await generateBundledPluginUiArtifacts({ repoRoot: fixture.repoRoot, mode: 'check' });
    await writeFile(outputPath, '// stale\n');
    await assert.rejects(
      () => generateBundledPluginUiArtifacts({ repoRoot: fixture.repoRoot, mode: 'check' }),
      /out of date/i,
    );
  } finally {
    await rm(fixture.repoRoot, { recursive: true, force: true });
  }
});

test('UI declaration text containing require syntax does not become an app asset import', async () => {
  const fixture = await createFixture();
  try {
    const path = join(fixture.repoRoot, 'packages/plugins/fixture/.happier-plugin/plugin.json');
    const manifest = JSON.parse(await readFile(path, 'utf8'));
    manifest.contributes.ui.views[0].title = 'How require("react") works';
    await writeFile(path, JSON.stringify(manifest));
    await generateBundledPluginUiArtifacts({ repoRoot: fixture.repoRoot, artifactRoots: { fixture: fixture.artifactRoot } });
    const output = resolveBundledPluginUiArtifactsOutputPath(fixture.repoRoot);
    assert.ok(resolveBundledPluginUiArtifactsInputPaths(output)?.includes(join(fixture.artifactRoot, fixture.relativePath)));
  } finally { await rm(fixture.repoRoot, { recursive: true, force: true }); }
});

test('semantic declaration publication refuses non-JSON schema data without repairing its meaning', async () => {
  const fixture = await createFixture();
  try {
    const path = join(fixture.repoRoot, 'packages/plugins/fixture/.happier-plugin/plugin.json');
    const manifest = JSON.parse(await readFile(path, 'utf8'));
    const inputSchema = { type: 'string', enum: undefined };
    manifest.contributes.pluginContributionPoints = [{ id: 'point', protocols: [{
      id: 'detail', version: 1, operations: {},
      surfaces: { detail: { required: true, presentation: 'content', inputSchema } },
    }] }];
    const { PluginPortableReleaseManifestV1Schema } = await import('@happier-dev/protocol/plugins/availability');
    // This is accepted by the declaration grammar, but cannot cross JSON
    // publication: omitting enum would turn unsupported input into a string.
    PluginPortableReleaseManifestV1Schema.parse(manifest);
    const invalid = await generateBundledPluginUiArtifacts({ repoRoot: fixture.repoRoot,
      pluginManifests: { fixture: manifest } });
    assert.deepEqual(invalid.pluginFailures.map(failure => failure.pluginId), ['happier.fixture']);
    assert.doesNotMatch(await readFile(invalid.outputPath, 'utf8'), /const BUNDLED_PLUGIN_UI_APP_DECLARATION_0 =/);

    // Unsupported but serializable point semantics still retain the plugin.
    manifest.contributes.pluginContributionPoints[0].protocols[0].surfaces.detail.inputSchema = { not: { type: 'null' } };
    const supportedBytes = await generateBundledPluginUiArtifacts({ repoRoot: fixture.repoRoot,
      pluginManifests: { fixture: manifest } });
    assert.deepEqual(supportedBytes.pluginFailures, []);
    const output = await readFile(supportedBytes.outputPath, 'utf8');
    const declaration = await readEmittedPluginUiInventory(output).BUNDLED_PLUGIN_UI_APP_DECLARATIONS[0].loadDeclaration();
    assert.deepEqual(declaration.normalizedManifest.contributes.pluginContributionPoints[0]
      .protocols[0].surfaces.detail.inputSchema, { not: { type: 'null' } });

    // Canonical package manifests can omit native optional members normally;
    // their serialized representation remains a supported producer input.
    const { serializeCanonicalPluginManifest } = await import('../../cli/src/plugins/manifest/serialize.ts');
    const optional = JSON.parse(serializeCanonicalPluginManifest(PluginPortableReleaseManifestV1Schema.parse({
      ...manifest, description: undefined,
    })));
    assert.equal(Object.hasOwn(optional, 'description'), false);
    const omittedOptional = await generateBundledPluginUiArtifacts({ repoRoot: fixture.repoRoot,
      pluginManifests: { fixture: optional } });
    assert.deepEqual(omittedOptional.pluginFailures, []);
  } finally { await rm(fixture.repoRoot, { recursive: true, force: true }); }
});

test('the UI byte publisher projects declared packaged brand marks, including packages without UI entries', async () => {
  const fixture = await createFixture();
  try {
    const { bytes, manifest } = await addFixtureBrand(fixture);
    delete manifest.contributes.ui;
    manifest.contributes.actions = [{ id: 'read', title: 'Read', scopes: ['global'], surfaces: ['ui'],
      placementBindings: [], dangerLevel: 'safe', execution: { target: 'daemon' } }];
    await writeFile(join(fixture.repoRoot, 'packages/plugins/fixture/.happier-plugin/plugin.json'), JSON.stringify(manifest));
    await writeFile(join(fixture.artifactRoot, 'ui-artifacts.json'), JSON.stringify({ version: 2, entries: [] }));
    // Daemon-only bundled plugins (including machine provisioners) have brands
    // without an app dependency or an executable UI graph.
    await writeFile(join(fixture.repoRoot, 'apps/ui/package.json'), JSON.stringify({ dependencies: {} }));
    const result = await generateBundledPluginUiArtifacts({ repoRoot: fixture.repoRoot, publicationMode: 'artifact' });
    const output = await readFile(result.outputPath, 'utf8');
    assert.match(output, /export const BUNDLED_PLUGIN_BRAND_MARKS/);
    assert.match(output, /resourceId: "brand-icon"/);
    assert.match(output, /monochrome: true/);
    assert.ok(!/bytes: Uint8Array\.from\(\[/.test(output), 'brand bytes must avoid numeric-array expansion');
    assert.ok(output.includes(`digest: ${JSON.stringify(computePluginUiArtifactSha256DigestV1(bytes))}`));
    assert.doesNotMatch(output, /require\([^)]*brand\.png/);
    const emitted = readEmittedPluginUiInventory(output);
    assert.deepEqual(emitted.BUNDLED_PLUGIN_BRAND_MARKS[0].bytes, new Uint8Array(bytes));
    assert.equal(emitted.BUNDLED_PLUGIN_UI_APP_ARTIFACTS.length, 0);
    assert.equal(emitted.BUNDLED_PLUGIN_UI_APP_DECLARATIONS.length, 1);
    assert.equal(emitted.BUNDLED_PLUGIN_UI_APP_DECLARATIONS[0].declaredExecution.daemonActions, true);
    const privateResult = await generateBundledPluginUiArtifacts({
      repoRoot: fixture.repoRoot, publicationMode: 'artifact', artifactRoots: {},
      pluginManifests: { fixture: manifest }, outputPath: join(fixture.repoRoot, 'private/inventory.js'),
    });
    assert.match(await readFile(privateResult.outputPath, 'utf8'), /resourceId: "brand-icon"/);
    assert.equal(readEmittedPluginUiInventory(await readFile(privateResult.outputPath, 'utf8'))
      .BUNDLED_PLUGIN_UI_APP_DECLARATIONS.length, 1);
  } finally {
    await rm(fixture.repoRoot, { recursive: true, force: true });
  }
});

test('all packaged brand marks retain exact runtime bytes without numeric-array payload expansion', async () => {
  const fixture = await createFixture();
  try {
    await rm(join(fixture.repoRoot, 'packages/plugins/fixture'), { recursive: true });
    await writeFile(join(fixture.repoRoot, 'apps/ui/package.json'), JSON.stringify({ dependencies: {} }));
    const repoRoot = resolve(packageRoot, '../..');
    const expected = new Map();
    for (const name of readBundledPluginPackageNames(repoRoot, { requireManifestSource: true })) {
      const directory = pluginPackageNameToPackageId(name);
      const sourceRoot = join(repoRoot, 'packages/plugins', directory);
      const manifest = JSON.parse(await readFile(join(sourceRoot, '.happier-plugin/plugin.json'), 'utf8'));
      if (!manifest.brand) continue;
      const resource = manifest.contributes.resources.find(row => row.id === manifest.brand.iconResourceId);
      const bytes = await readFile(join(sourceRoot, resource.path));
      expected.set(manifest.id, new Uint8Array(bytes));
      const targetRoot = join(fixture.repoRoot, 'packages/plugins', directory);
      // Preserve canonical brand inputs; UI execution is outside this byte-encoding contract.
      await mkdir(join(targetRoot, '.happier-plugin'), { recursive: true });
      await mkdir(dirname(join(targetRoot, resource.path)), { recursive: true });
      await mkdir(join(targetRoot, 'dist/happier-plugin-ui'), { recursive: true });
      await writeFile(join(targetRoot, resource.path), bytes);
      await writeFile(join(targetRoot, 'package.json'), await readFile(join(sourceRoot, 'package.json')));
      await writeFile(join(targetRoot, '.happier-plugin/plugin.json'), JSON.stringify({
        ...manifest, contributes: { resources: [resource] },
      }));
      await writeFile(join(targetRoot, 'dist/happier-plugin-ui/ui-artifacts.json'), JSON.stringify({ version: 2, entries: [] }));
    }
    assert.ok(expected.size > 0);
    const result = await generateBundledPluginUiArtifacts({ repoRoot: fixture.repoRoot, publicationMode: 'artifact' });
    const output = await readFile(result.outputPath, 'utf8');
    assert.ok(!/bytes: Uint8Array\.from\(\[/.test(output), 'brand bytes must avoid numeric-array expansion');
    const marks = readEmittedPluginUiInventory(output).BUNDLED_PLUGIN_BRAND_MARKS;
    assert.equal(marks.length, expected.size);
    for (const mark of marks) {
      assert.deepEqual(mark.bytes, expected.get(mark.pluginId), mark.pluginId);
      assert.equal(mark.digest, computePluginUiArtifactSha256DigestV1(mark.bytes));
    }
    const numericArrayBytes = [...expected.values()].reduce((total, bytes) => total + Buffer.byteLength(JSON.stringify([...bytes])), 0);
    const emittedBrandBytes = Buffer.byteLength(output.slice(output.indexOf('export const BUNDLED_PLUGIN_BRAND_MARKS')));
    assert.ok(emittedBrandBytes < numericArrayBytes,
      `brand payload ${emittedBrandBytes} bytes must be smaller than numeric arrays alone (${numericArrayBytes})`);
  } finally { await rm(fixture.repoRoot, { recursive: true, force: true }); }
});

test('source preparation projects private artifacts without touching package dist or the live inventory', async () => {
  const fixture = await createFixture();
  try {
    const privateRoot = join(fixture.repoRoot, 'private-inputs');
    const privateArtifacts = join(privateRoot, 'fixture', 'happier-plugin-ui');
    const { cp } = await import('node:fs/promises');
    await cp(fixture.artifactRoot, privateArtifacts, { recursive: true });
    await rm(fixture.artifactRoot, { recursive: true });
    // Daemon and native CLI packages carry plugins the app does not bundle.
    const uiPackagePath = join(fixture.repoRoot, 'apps', 'ui', 'package.json');
    await writeFile(uiPackagePath, JSON.stringify({ ...JSON.parse(await readFile(uiPackagePath, 'utf8')), dependencies: {} }));
    const outputPath = join(privateRoot, 'inventory.js');
    await generateBundledPluginUiArtifacts({
      repoRoot: fixture.repoRoot, publicationMode: 'artifact', outputPath,
      artifactRoots: { fixture: privateArtifacts },
      pluginManifests: { fixture: { id: 'happier.authored-fixture' } },
    });
    const output = await readFile(outputPath, 'utf8');
    assert.match(output, /happier\.authored-fixture/);
    assert.ok(output.includes(JSON.stringify(join(privateArtifacts, fixture.relativePath))));
    await assert.rejects(stat(resolveBundledPluginUiArtifactsOutputPath(fixture.repoRoot)), { code: 'ENOENT' });
    await assert.rejects(stat(fixture.artifactRoot), { code: 'ENOENT' });

    // The same compiler emits a valid empty graph for daemon-only plugins.
    await writeFile(join(privateArtifacts, 'ui-artifacts.json'), JSON.stringify({ version: 2, entries: [] }));
    const empty = await generateBundledPluginUiArtifacts({
      repoRoot: fixture.repoRoot, publicationMode: 'artifact', outputPath,
      artifactRoots: { fixture: privateArtifacts },
      pluginManifests: { fixture: { id: 'happier.authored-fixture' } },
    });
    assert.deepEqual(empty.pluginFailures, []);
    assert.doesNotMatch(await readFile(outputPath, 'utf8'), /happier\.authored-fixture/);
  } finally {
    await rm(fixture.repoRoot, { recursive: true, force: true });
  }
});

test('live and packaged app inventories require their nonempty plugin graphs to be app dependencies', async () => {
  const fixture = await createFixture();
  try {
    await writeFile(join(fixture.repoRoot, 'apps', 'ui', 'package.json'), JSON.stringify({ dependencies: {} }));
    await assert.rejects(
      generateBundledPluginUiArtifacts({ repoRoot: fixture.repoRoot, publicationMode: 'artifact' }),
      /apps\/ui must depend on bundled Plugin UI package/,
    );
    const live = await generateBundledPluginUiArtifacts({ repoRoot: fixture.repoRoot });
    assert.deepEqual(live.diagnostics.map(({ pluginId, code }) => ({ pluginId, code })), [
      { pluginId: 'happier.fixture', code: 'plugin_ui_artifact_invalid' },
    ]);
    const emitted = readEmittedPluginUiInventory(await readFile(live.outputPath, 'utf8'));
    assert.equal(emitted.BUNDLED_PLUGIN_UI_APP_ARTIFACTS.length, 0);
    assert.deepEqual(Array.from(emitted.BUNDLED_PLUGIN_UI_APP_DECLARATIONS, declaration => declaration.pluginId), ['happier.fixture']);
  } finally {
    await rm(fixture.repoRoot, { recursive: true, force: true });
  }
});

test('the emitted JavaScript and committed declaration satisfy the inventory contract', async () => {
  const fixture = await createFixture();
  try {
    await addFixtureBrand(fixture);
    await addFixtureTranslationResources(fixture);
    await generateBundledPluginUiArtifacts({ repoRoot: fixture.repoRoot, mode: 'write' });
    const outputPath = resolveBundledPluginUiArtifactsOutputPath(fixture.repoRoot);
    const fixtureDir = dirname(outputPath);
    const contractDir = join(packageRoot, 'sources', 'sync', 'domains', 'plugins', 'availability');
    await writeFile(join(fixtureDir, 'generatedBundledPluginUiArtifacts.d.ts'),
      await readFile(join(contractDir, 'generatedBundledPluginUiArtifacts.d.ts')));
    // Resolve the real inventory contract at its owner, including relative imports.
    // Copying that source file alone severs its ../ui/projection dependency.
    await writeFile(join(fixtureDir, 'bundledPluginUiArtifactInventory.ts'),
      `export type * from ${JSON.stringify(join(contractDir, 'bundledPluginUiArtifactInventory'))};\n`);
    const ambientPath = join(fixtureDir, 'asset-boundaries.d.ts');
    // Compile against the actual Protocol declarations; only the native asset
    // module is synthetic in this disposable output tree.
    await symlink(resolve(packageRoot, '../../node_modules'), join(fixture.repoRoot, 'node_modules'), 'dir');
    await writeFile(ambientPath, [
      "declare module 'expo-asset' { export class Asset { static fromModule(id: number): number; } }",
      "declare module '*.bundle' { const asset: number; export = asset; }",
      '',
    ].join('\n'));
    const consumerPath = join(fixtureDir, 'consumer.ts');
    await writeFile(consumerPath, [
      "import { BUNDLED_PLUGIN_UI_APP_ARTIFACTS, BUNDLED_PLUGIN_UI_APP_DECLARATIONS, BUNDLED_PLUGIN_BRAND_MARKS, BUNDLED_PLUGIN_PACKAGED_RESOURCES } from './generatedBundledPluginUiArtifacts';",
      "import type { BundledPluginUiAppArtifactInventory, PluginHostBundledUiDeclaration, BundledPluginBrandMark, BundledPluginPackagedResource } from './bundledPluginUiArtifactInventory';",
      'const inventory: BundledPluginUiAppArtifactInventory = BUNDLED_PLUGIN_UI_APP_ARTIFACTS;',
      'const declarations: readonly PluginHostBundledUiDeclaration[] = BUNDLED_PLUGIN_UI_APP_DECLARATIONS;',
      'const brands: readonly BundledPluginBrandMark[] = BUNDLED_PLUGIN_BRAND_MARKS;',
      'const resources: readonly BundledPluginPackagedResource[] = BUNDLED_PLUGIN_PACKAGED_RESOURCES;',
      'void inventory;',
      'void declarations;',
      'void brands;',
      'void resources;',
      '',
    ].join('\n'));
    const compiler = resolve(packageRoot, '..', '..', 'scripts', 'workspaces', 'runTypeScriptCli.mjs');
    const configPath = join(fixtureDir, 'tsconfig.contract.json');
    const writeContractConfig = files => writeFile(configPath, JSON.stringify({
      compilerOptions: { allowJs: true, checkJs: true, noEmit: true, strict: true, skipLibCheck: true,
        moduleResolution: 'bundler', module: 'esnext', target: 'es2022',
        paths: { '@/*': [join(packageRoot, 'sources/*')] } },
      files, include: [],
    }));
    await writeContractConfig([outputPath, consumerPath, ambientPath]);
    const compilerArguments = [compiler, '--project', configPath];
    await execFileAsync(process.execPath, compilerArguments);
    const validOutput = await readFile(outputPath, 'utf8');
    await writeFile(outputPath, validOutput.replace('    releaseVersion: "0.0.0",\n', ''));
    await assert.rejects(
      execFileAsync(process.execPath, compilerArguments),
      (error) => {
        assert.match(error.stdout, /releaseVersion/);
        return true;
      },
    );
    await rm(outputPath);
    await writeContractConfig([consumerPath, ambientPath]);
    await execFileAsync(process.execPath, compilerArguments);
  } finally {
    await rm(fixture.repoRoot, { recursive: true, force: true });
  }
});

test('unchanged Plugin UI artifact inputs preserve the generated compiler input', async () => {
  const fixture = await createFixture();
  try {
    await generateBundledPluginUiArtifacts({ repoRoot: fixture.repoRoot, mode: 'write' });
    const outputPath = resolveBundledPluginUiArtifactsOutputPath(fixture.repoRoot);
    const first = await stat(outputPath);

    await generateBundledPluginUiArtifacts({ repoRoot: fixture.repoRoot, mode: 'write' });
    const unchanged = await stat(outputPath);
    assert.equal(unchanged.ino, first.ino);
    assert.equal(unchanged.mtimeMs, first.mtimeMs);

    const packageJsonPath = join(fixture.repoRoot, 'packages', 'plugins', 'fixture', 'package.json');
    const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'));
    await writeFile(packageJsonPath, JSON.stringify({ ...packageJson, version: '0.0.1' }));
    const uiPackageJsonPath = join(fixture.repoRoot, 'apps', 'ui', 'package.json');
    const uiPackageJson = JSON.parse(await readFile(uiPackageJsonPath, 'utf8'));
    await writeFile(uiPackageJsonPath, JSON.stringify({
      ...uiPackageJson,
      dependencies: { ...uiPackageJson.dependencies, '@happier-dev/plugins-fixture': '0.0.1' },
    }));
    await generateBundledPluginUiArtifacts({ repoRoot: fixture.repoRoot, mode: 'write' });
    const changedOutput = await readFile(outputPath, 'utf8');
    assert.match(changedOutput, /releaseVersion: "0\.0\.1"/);
    const declaration = JSON.parse(changedOutput.match(/const BUNDLED_PLUGIN_UI_APP_DECLARATION_0 = (.+);/)[1]);
    assert.equal(declaration.entriesById['reactNativeBundle:happier.fixture:fixture'].pluginVersion, '0.0.1');
  } finally {
    await rm(fixture.repoRoot, { recursive: true, force: true });
  }
});

test('invalid plugin bytes retain semantic declarations while healthy byte sources remain usable', async () => {
  const fixture = await createFixture();
  try {
    await addSecondPlugin(fixture.repoRoot);
    const artifactPath = join(fixture.artifactRoot, fixture.relativePath);
    for (const missing of [false, true]) {
      if (missing) await rm(artifactPath);
      else await writeFile(artifactPath, 'tampered bytes');
      const result = await generateBundledPluginUiArtifacts({ repoRoot: fixture.repoRoot, mode: 'write' });
      const output = await readFile(resolveBundledPluginUiArtifactsOutputPath(fixture.repoRoot), 'utf8');
      const emitted = readEmittedPluginUiInventory(output);
      assert.deepEqual(Array.from(emitted.BUNDLED_PLUGIN_UI_APP_DECLARATIONS, declaration => declaration.pluginId), ['happier.fixture']);
      assert.deepEqual(Array.from(emitted.BUNDLED_PLUGIN_UI_APP_ARTIFACTS, artifact => artifact.pluginId), ['happier.second']);
      assert.deepEqual(result.diagnostics.map(({ pluginId, code }) => ({ pluginId, code })), [
        { pluginId: 'happier.fixture', code: 'plugin_ui_artifact_invalid' },
      ]);
      assert.match(result.diagnostics[0].message, missing ? /Missing bundled Plugin UI artifact file/ : /digest mismatch/);
    }
    await rm(join(fixture.artifactRoot, 'ui-artifacts.json'));
    const noMetadata = await generateBundledPluginUiArtifacts({ repoRoot: fixture.repoRoot });
    const declaration = await readEmittedPluginUiInventory(await readFile(noMetadata.outputPath, 'utf8'))
      .BUNDLED_PLUGIN_UI_APP_DECLARATIONS[0].loadDeclaration();
    assert.equal(declaration.pluginId, 'happier.fixture');
    assert.equal(declaration.artifactGraphs.length, 0);
  } finally {
    await rm(fixture.repoRoot, { recursive: true, force: true });
  }
});

test('a package publication failure excludes only that plugin and retains the same diagnostic result', async () => {
  const fixture = await createFixture();
  try {
    await addSecondPlugin(fixture.repoRoot);
    const failure = Object.freeze({
      packageName: '@happier-dev/plugins-fixture',
      pluginId: 'happier.fixture',
      diagnostic: Object.freeze({ code: 'plugin_package_build_failed', message: 'missing staged export' }),
    });
    const result = await generateBundledPluginUiArtifacts({
      repoRoot: fixture.repoRoot,
      mode: 'write',
      pluginFailures: [failure],
    });
    assert.equal(result.pluginFailures[0], failure);
    const output = await readFile(resolveBundledPluginUiArtifactsOutputPath(fixture.repoRoot), 'utf8');
    assert.match(output, /pluginId: "happier\.second"/);
    assert.doesNotMatch(output, /pluginId: "happier\.fixture"/);
  } finally {
    await rm(fixture.repoRoot, { recursive: true, force: true });
  }
});

test('the UI byte publisher reads the CLI failure set from ignored runtime output', async () => {
  const fixture = await createFixture();
  try {
    await addSecondPlugin(fixture.repoRoot);
    const failure = {
      packageName: '@happier-dev/plugins-fixture',
      pluginId: 'happier.fixture',
      diagnostic: { code: 'plugin_package_build_failed', message: 'missing staged export' },
    };
    const failurePath = join(
      fixture.repoRoot, 'apps', 'cli', '.project', 'tmp', 'bundled-plugin-publication', 'failures.json',
    );
    await mkdir(dirname(failurePath), { recursive: true });
    await writeFile(failurePath, `${JSON.stringify([failure])}\n`);
    const result = await generateBundledPluginUiArtifacts({ repoRoot: fixture.repoRoot, mode: 'write' });
    const output = await readFile(resolveBundledPluginUiArtifactsOutputPath(fixture.repoRoot), 'utf8');
    assert.match(output, /pluginId: "happier\.second"/);
    assert.doesNotMatch(output, /pluginId: "happier\.fixture"/);
    assert.deepEqual(result.pluginFailures, [failure]);
  } finally {
    await rm(fixture.repoRoot, { recursive: true, force: true });
  }
});

test('a declared bundle export without an artifact manifest is diagnosed per plugin', async () => {
  const fixture = await createFixture();
  try {
    await addSecondPlugin(fixture.repoRoot);
    const packagePath = join(fixture.repoRoot, 'packages', 'plugins', 'fixture', 'package.json');
    const packageJson = JSON.parse(await readFile(packagePath, 'utf8'));
    packageJson.exports = {
      './happier-plugin-ui/react-native/fixture-card/entry.cjs.bundle':
        './dist/happier-plugin-ui/react-native/fixture-card/entry.cjs.bundle',
    };
    await writeFile(packagePath, JSON.stringify(packageJson));
    await rm(join(fixture.artifactRoot, 'ui-artifacts.json'));

    const result = await generateBundledPluginUiArtifacts({ repoRoot: fixture.repoRoot, mode: 'write' });
    assert.deepEqual(result.diagnostics.map(({ pluginId, code }) => ({ pluginId, code })), [
      { pluginId: 'happier.fixture', code: 'plugin_ui_artifact_invalid' },
    ]);
    const output = await readFile(resolveBundledPluginUiArtifactsOutputPath(fixture.repoRoot), 'utf8');
    assert.match(output, /pluginId: "happier\.second"/);
    assert.doesNotMatch(output, /pluginId: "happier\.fixture"/);
  } finally {
    await rm(fixture.repoRoot, { recursive: true, force: true });
  }
});
