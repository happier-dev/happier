// Preparation imports authored SDK TypeScript, as the source child does.
import '../../../packages/cli-common/registerSourceRuntime.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { runInNewContext } from 'node:vm';

import {
  computePluginUiArtifactFileSetSha256DigestV1,
  computePluginUiArtifactSha256DigestV1,
} from '@happier-dev/protocol/plugins/ui';

import {
  generateBundledPluginUiArtifacts,
  listBundledPluginUiArtifactExports,
  resolveBundledPluginUiArtifactsInputPaths,
  resolveBundledPluginUiArtifactsOutputPath,
} from './generateBundledPluginUiArtifacts.mjs';

const execFileAsync = promisify(execFile);
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

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

function readEmittedPluginUiInventory(output, requireAsset = () => 1) {
  // Native assets are the external boundary; the generated data stays real.
  return runInNewContext(`${output.replaceAll('export const ', 'const ').replaceAll('import(', 'loadDeclarationModule(')}\n({ BUNDLED_PLUGIN_UI_APP_DECLARATIONS, BUNDLED_PLUGIN_UI_APP_ARTIFACTS, BUNDLED_PLUGIN_PACKAGED_RESOURCES: typeof BUNDLED_PLUGIN_PACKAGED_RESOURCES === 'undefined' ? [] : BUNDLED_PLUGIN_PACKAGED_RESOURCES });`, {
    require: requireAsset, Uint8Array, loadDeclarationModule: specifier => import(pathToFileURL(specifier).href),
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
    const declaration = inventory.BUNDLED_PLUGIN_UI_APP_DECLARATIONS[0].loadDeclaration();
    assert.equal(declaration.artifactGraphs.length, 1);
  } finally { await rm(fixture.repoRoot, { recursive: true, force: true }); }
});

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
    assert.match(
      output,
      /require\("@happier-dev\/plugins-fixture\/happier-plugin-ui\/react-native\/fixture-card\/entry\.cjs\.bundle"\)/,
    );
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
    assert.ok(output.includes(`bytes: Uint8Array.from(${JSON.stringify([...bytes])})`));
    assert.ok(output.includes(`digest: ${JSON.stringify(computePluginUiArtifactSha256DigestV1(bytes))}`));
    assert.doesNotMatch(output, /require\([^)]*brand\.png/);
    const emitted = readEmittedPluginUiInventory(output);
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
      "import { BUNDLED_PLUGIN_UI_APP_ARTIFACTS, BUNDLED_PLUGIN_UI_APP_DECLARATIONS, BUNDLED_PLUGIN_BRAND_MARKS } from './generatedBundledPluginUiArtifacts';",
      "import type { BundledPluginUiAppArtifactInventory, PluginHostBundledUiDeclaration, BundledPluginBrandMark } from './bundledPluginUiArtifactInventory';",
      'const inventory: BundledPluginUiAppArtifactInventory = BUNDLED_PLUGIN_UI_APP_ARTIFACTS;',
      'const declarations: readonly PluginHostBundledUiDeclaration[] = BUNDLED_PLUGIN_UI_APP_DECLARATIONS;',
      'const brands: readonly BundledPluginBrandMark[] = BUNDLED_PLUGIN_BRAND_MARKS;',
      'void inventory;',
      'void declarations;',
      'void brands;',
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
