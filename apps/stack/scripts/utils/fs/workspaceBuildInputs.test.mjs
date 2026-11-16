// @happier-test-preparation source
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';
import { captureBuildInputFiles, readBuildInputIdentity } from '../../../../../scripts/workspaces/buildInputConvergence.mjs';
import { readSourceComponentBuildInputs, readSourcePluginUiBuildInputs, readSourcePluginUiBuildInputRecord, readWorkspaceBuildInputs, resolveWorkspaceBuildInputWatchPaths } from './workspaceBuildInputs.mjs';
import { SOURCE_UI_ASSET_OUTPUT_PATHS, SOURCE_UI_ASSET_RECORD_FILENAME } from '../../../../ui/scripts/sourceUiAssetPaths.mjs';

test('plugin UI inputs follow consumed workspace files instead of dependency package membership', async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-ui-graph-inputs-' });
  for (const [directory, manifest, sources] of [
    ['packages/plugins/fixture', { name: '@happier-dev/plugins-fixture',
      dependencies: { '@fixture/shared': '*' }, exports: { './manifest': './src/manifest.ts', './happier-plugin-ui/panel': './src/panel.ts' } },
    { 'src/panel.ts': 'import "./sideEffect.js"; export { value } from "@fixture/shared/ui"; export { host } from "@happier-dev/plugin-sdk";',
      'src/sideEffect.ts': 'globalThis.fixtureSideEffect = true;',
      'src/manifest.ts': 'export { host as PLUGIN_MANIFEST } from "@happier-dev/plugin-sdk";',
      'src/daemon.ts': 'export const backend = true;' }],
    ['packages/plugin-sdk', { name: '@happier-dev/plugin-sdk', exports: { '.': './src/index.ts' } },
    { 'src/index.ts': 'export const host = "provided by the app";' }],
    ['packages/shared', { name: '@fixture/shared', exports: {
      './ui': { 'happier-source': './src/ui.ts' } } },
    { 'src/ui.ts': 'export const value = true;', 'src/machines/managed/provisioners.ts': 'export const unrelated = true;' }],
  ]) {
    await mkdir(fixture.path(directory), { recursive: true });
    await writeFile(fixture.path(`${directory}/package.json`), JSON.stringify(manifest));
    for (const [path, source] of Object.entries(sources)) {
      await mkdir(dirname(fixture.path(`${directory}/${path}`)), { recursive: true });
      await writeFile(fixture.path(`${directory}/${path}`), source);
    }
  }
  const options = { repoDir: fixture.root, pluginDirectory: 'fixture' };
  const files = await readSourcePluginUiBuildInputs(options);
  assert.ok(files.includes('packages/shared/src/ui.ts'), 'a real shared UI input remains observable');
  assert.ok(files.includes('packages/shared/package.json'), 'consumed export resolution remains an input');
  assert.ok(files.includes('packages/plugins/fixture/src/panel.ts'), 'code-free reexport ancestors choose executable dependency targets');
  assert.ok(files.includes('packages/plugins/fixture/src/sideEffect.ts'), 'side-effect-only modules remain executable artifact inputs');
  assert.equal(files.includes('packages/plugin-sdk/src/index.ts'), false,
    'host-provided modules and evaluated manifest source are not compiled artifact inputs');
  assert.equal(files.includes('packages/shared/src/machines/managed/provisioners.ts'), false,
    'an unrelated file in a consumed package must not invalidate plugin UI');
  const inventory = await readSourcePluginUiBuildInputs({ ...options, inventory: true });
  assert.ok(inventory.includes('packages/plugins/fixture/src/manifest.ts'), 'inventory observation retains authored manifests');
  assert.ok(inventory.includes('packages/plugin-sdk/src/index.ts'), 'inventory observation retains evaluated manifest dependencies');
  const initial = await readBuildInputIdentity({ sourceDir: fixture.root, files });
  await writeFile(fixture.path('packages/plugins/fixture/src/daemon.ts'), 'export const backend = false;');
  const afterBackendEdit = await readSourcePluginUiBuildInputs(options);
  assert.equal(await readBuildInputIdentity({ sourceDir: fixture.root, files: afterBackendEdit }), initial,
    'a plugin daemon-only edit must not invalidate its unchanged UI graph');
  await writeFile(fixture.path('packages/shared/src/machines/managed/provisioners.ts'), 'export const unrelated = false;');
  assert.equal(await readBuildInputIdentity({ sourceDir: fixture.root, files }), initial);
  await writeFile(fixture.path('packages/shared/src/ui.ts'), 'export const value = false;');
  assert.notEqual(await readBuildInputIdentity({ sourceDir: fixture.root, files }), initial);
});

test('plugin UI compiler identity follows the artifact compiler without inventory-only dependencies', async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-ui-compiler-graph-' });
  const paths = {
    'packages/plugin-sdk/package.json': JSON.stringify({ name: '@happier-dev/plugin-sdk', sideEffects: ['./src/ui/build/policy.ts'] }),
    'apps/ui/package.json': JSON.stringify({ name: '@fixture/ui' }),
    'packages/plugin-sdk/src/ui/build/buildUniversalUiArtifacts.ts': 'export { compile } from "./barrel.js";',
    'packages/plugin-sdk/src/ui/build/barrel.ts': 'export { compile } from "./compiler.js"; export { unused } from "./unused.js"; export { policy } from "./policy.js"; export { optional } from "@fixture/potential-effects"; export { eliminated } from "@fixture/eliminated";',
    'packages/plugin-sdk/src/ui/build/unused.ts': 'export const unused = true;',
    'packages/plugin-sdk/src/ui/build/policy.ts': 'export const policy = true;',
    'packages/plugin-sdk/src/ui/build/compiler.ts': 'export const compile = true;',
    'apps/ui/scripts/prepareSourcePluginUiArtifacts.mjs': 'export { unrelated } from "./inventory-only.mjs";',
    'apps/ui/scripts/inventory-only.mjs': 'export const unrelated = true;',
    'apps/ui/scripts/sourcePluginUiGraph.mjs': 'export const graphPolicy = true;',
    'packages/potential-effects/package.json': JSON.stringify({ name: '@fixture/potential-effects', exports: { '.': './src/index.ts' } }),
    'packages/potential-effects/src/index.ts': 'export const optional = true;',
    'packages/eliminated/package.json': JSON.stringify({ name: '@fixture/eliminated', sideEffects: false, exports: { '.': './src/index.ts' } }),
    'packages/eliminated/src/index.ts': 'globalThis.fixtureIgnoredSideEffect = true; export const eliminated = true;',
  };
  for (const [path, source] of Object.entries(paths)) {
    await mkdir(dirname(fixture.path(path)), { recursive: true });
    await writeFile(fixture.path(path), source);
  }
  const files = await readSourcePluginUiBuildInputs({ repoDir: fixture.root, compiler: true });
  assert.ok(files.includes('packages/plugin-sdk/src/ui/build/compiler.ts'));
  assert.ok(files.includes('packages/plugin-sdk/src/ui/build/barrel.ts'), 'reexport ancestors remain resolver inputs');
  assert.equal(files.includes('packages/plugin-sdk/src/ui/build/unused.ts'), false, 'eliminated-only subtrees are not executable compiler inputs');
  assert.ok(files.includes('packages/potential-effects/src/index.ts'), 'unannotated modules remain inputs because edits can activate top-level effects');
  assert.ok(files.includes('packages/plugin-sdk/src/ui/build/policy.ts'), 'the resolver retains modules named by a sideEffects array');
  assert.equal(files.includes('packages/eliminated/src/index.ts'), false, 'positive resolver annotations permit unused workspace source to be excluded');
  assert.ok(files.includes('packages/eliminated/package.json'), 'eliminated workspace annotations still control executable membership');
  assert.equal(files.includes('apps/ui/scripts/inventory-only.mjs'), false,
    'declaration inventory changes do not rebuild compiler-identical artifact bytes');
  const retainedInputs = await readSourcePluginUiBuildInputRecord({ repoDir: fixture.root, files });
  assert.deepEqual(await readSourcePluginUiBuildInputs({ repoDir: fixture.root, compiler: true, retainedInputs }), files,
    'fresh and retained compiler membership have identical manifest closure');
  const inventory = await readSourcePluginUiBuildInputs({ repoDir: fixture.root, compiler: true, inventory: true });
  assert.ok(inventory.includes('apps/ui/scripts/inventory-only.mjs'), 'inventory observation retains declaration validation dependencies');
  const initial = await readBuildInputIdentity({ sourceDir: fixture.root, files });
  await writeFile(fixture.path('packages/potential-effects/src/index.ts'), 'globalThis.fixtureNewSideEffect = true; export const optional = true;');
  assert.notEqual(await readBuildInputIdentity({ sourceDir: fixture.root, files }), initial,
    'adding a top-level effect to a previously pure unannotated module invalidates reuse');
  await writeFile(fixture.path('packages/potential-effects/src/index.ts'), paths['packages/potential-effects/src/index.ts']);
  await writeFile(fixture.path('packages/eliminated/package.json'), JSON.stringify({ name: '@fixture/eliminated', exports: { '.': './src/index.ts' } }));
  assert.notEqual(await readBuildInputIdentity({ sourceDir: fixture.root, files }), initial,
    'removing a sideEffects annotation invalidates retained membership');
  await writeFile(fixture.path('packages/eliminated/package.json'), paths['packages/eliminated/package.json']);
  await writeFile(fixture.path('apps/ui/scripts/inventory-only.mjs'), 'export const unrelated = false;');
  assert.equal(await readBuildInputIdentity({ sourceDir: fixture.root, files }), initial);
  await writeFile(fixture.path('apps/ui/scripts/sourcePluginUiGraph.mjs'), 'export const graphPolicy = false;');
  assert.notEqual(await readBuildInputIdentity({ sourceDir: fixture.root, files }), initial,
    'the canonical graph policy invalidates retained membership without importing inventory validation');
  await writeFile(fixture.path('apps/ui/scripts/sourcePluginUiGraph.mjs'), paths['apps/ui/scripts/sourcePluginUiGraph.mjs']);
  await writeFile(fixture.path('packages/plugin-sdk/src/ui/build/compiler.ts'), 'export const compile = false;');
  assert.notEqual(await readBuildInputIdentity({ sourceDir: fixture.root, files }), initial);
});

test('component inventory follows undeclared source imports without admitting unrelated packages', async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-source-import-membership-' });
  await writeFile(fixture.path('package.json'), '{}');
  for (const [directory, name, contents] of [
    ['apps/server', '@happier-dev/server', 'export { marker } from "@happier-dev/added";'],
    ['packages/added', '@happier-dev/added', 'export { marker } from "@happier-dev/transitive";'],
    ['packages/transitive', '@happier-dev/transitive', 'export const marker = true;'],
    ['packages/unrelated', '@happier-dev/unrelated', 'export const unused = true;'],
  ]) {
    await mkdir(fixture.path(`${directory}/src`), { recursive: true });
    await writeFile(fixture.path(`${directory}/package.json`), JSON.stringify({ name,
      exports: { '.': { 'happier-source': './src/index.ts' } } }));
    await writeFile(fixture.path(`${directory}/src/index.ts`), contents, { mode: 0o600 });
  }
  await writeFile(fixture.path('packages/added/src/ignored.test.ts'), 'import "@happier-dev/unrelated";');
  const inputs = await readSourceComponentBuildInputs({ repoDir: fixture.root, component: 'server' });
  assert.ok(inputs.files.includes('packages/added/src/index.ts'));
  assert.ok(inputs.files.includes('packages/transitive/src/index.ts'));
  assert.equal(inputs.files.includes('packages/unrelated/src/index.ts'), false);
  assert.equal(inputs.files.includes('packages/added/src/ignored.test.ts'), false);
  assert.ok(inputs.workspaceDirs.includes('packages/added'));
  assert.ok(inputs.watchPaths.includes(fixture.path('packages/added/src')));
});

test('source build inputs capture and watch pnpm dependency resolution and policy', async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-pnpm-build-inputs-' });
  await writeFile(fixture.path('package.json'), '{}');
  for (const name of ['pnpm-lock.yaml', 'pnpm-workspace.yaml']) {
    await writeFile(fixture.path(name), '');
  }
  const inputs = await readSourceComponentBuildInputs({ repoDir: fixture.root, component: 'server' });
  for (const name of ['pnpm-lock.yaml', 'pnpm-workspace.yaml']) {
    assert.ok(inputs.files.includes(name), `${name} must be captured`);
    assert.ok(inputs.watchPaths.includes(join(fixture.root, name)), `${name} must be watched`);
  }
});

test('daemon capture retains the SEA Node pin and invalidates its identity on version changes', async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-sea-capture-input-' });
  const repoDir = fixture.path('repo');
  await mkdir(repoDir);
  await writeFile(join(repoDir, 'package.json'), '{}');
  await writeFile(join(repoDir, '.node-version'), '24.22.1\n');
  const inputs = await readSourceComponentBuildInputs({ repoDir, component: 'daemon' });
  const captureDir = fixture.path('capture');
  await captureBuildInputFiles({ sourceDir: repoDir, captureDir, readPaths: () => inputs.files });
  // The SEA producer reads this path relative to the captured repo, not the live checkout.
  assert.equal(await readFile(join(captureDir, '.node-version'), 'utf8'), '24.22.1\n');
  assert.ok(inputs.watchPaths.includes(join(repoDir, '.node-version')));
  const identity = await readBuildInputIdentity({ sourceDir: repoDir, files: inputs.files });
  await writeFile(join(repoDir, '.node-version'), '24.22.2\n');
  assert.notEqual(await readBuildInputIdentity({ sourceDir: repoDir, files: inputs.files }), identity);
  assert.equal(await readFile(join(captureDir, '.node-version'), 'utf8'), '24.22.1\n');
  for (const component of ['server', 'expo']) {
    const other = await readSourceComponentBuildInputs({ repoDir, component });
    assert.equal(other.files.includes('.node-version'), false, `${component} does not compile the CLI SEA`);
  }
});

test('source component tooling captures and watches the CLI test preparation policy', async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-tool-policy-inputs-' });
  await writeFile(fixture.path('package.json'), '{}');
  const policy = 'apps/cli/scripts/vitestPreparation.mjs';
  await mkdir(dirname(fixture.path(policy)), { recursive: true });
  await writeFile(fixture.path(policy), 'export const policy = true;');
  for (const component of ['expo', 'server', 'daemon']) {
    const inputs = await readSourceComponentBuildInputs({ repoDir: fixture.root, component });
    assert.ok(inputs.files.includes(policy), `${component} tooling imports the CLI test preparation policy`);
    assert.ok(inputs.watchPaths.includes(fixture.path(policy)), `${component} observes policy edits`);
  }
});

test('daemon input identity includes the source producer that supplies its guest CLI metadata', async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-guest-metadata-input-' });
  await writeFile(fixture.path('package.json'), '{}');
  const producer = 'apps/stack/scripts/build/build_source_runtime.mjs';
  await mkdir(dirname(fixture.path(producer)), { recursive: true });
  await writeFile(fixture.path(producer), 'export const metadata = "first";');
  const inputs = await readSourceComponentBuildInputs({ repoDir: fixture.root, component: 'daemon' });
  const before = await readBuildInputIdentity({ sourceDir: fixture.root, files: inputs.files });
  await writeFile(fixture.path(producer), 'export const metadata = "next";');
  assert.notEqual(await readBuildInputIdentity({ sourceDir: fixture.root, files: inputs.files }), before);
  assert.ok(inputs.watchPaths.includes(fixture.path(producer)));
});

test('workspace observation retains manifest corrections while build input admission rejects malformed JSON', async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-malformed-watch-inputs-' });
  await mkdir(fixture.path('src'));
  await writeFile(fixture.path('package.json'), '{');
  assert.throws(() => readWorkspaceBuildInputs(fixture.root), SyntaxError);
  const paths = resolveWorkspaceBuildInputWatchPaths(fixture.root);
  assert.ok(paths.includes(fixture.path('src')));
  assert.ok(paths.includes(fixture.path('package.json')));
  await writeFile(fixture.path('package.json'), JSON.stringify({ scripts: { build: 'node ./build.mjs' } }));
  await writeFile(fixture.path('build.mjs'), 'export {};');
  assert.ok(resolveWorkspaceBuildInputWatchPaths(fixture.root).includes(fixture.path('build.mjs')));
});

test('source web inputs retain dependency patches required by the captured UI preflight', async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-source-web-patch-inputs-' });
  await writeFile(fixture.path('package.json'), '{}');
  await mkdir(fixture.path('patches'));
  const patch = 'patches/dependency.patch';
  await writeFile(fixture.path('pnpm-workspace.yaml'), `patchedDependencies:\n  dependency@1.0.0: ${patch}\n`);
  await writeFile(fixture.path(patch), 'authored patch');
  const inputs = await readSourceComponentBuildInputs({ repoDir: fixture.root, component: 'expo' });
  assert.ok(inputs.files.includes(patch), 'the captured patch declaration must have its authored patch bytes');
  assert.ok(inputs.watchPaths.includes(fixture.path('patches')), 'new patch membership must invalidate preparation');
  const identity = await readBuildInputIdentity({ sourceDir: fixture.root, files: inputs.files });
  await writeFile(fixture.path(patch), 'changed authored patch');
  assert.notEqual(await readBuildInputIdentity({ sourceDir: fixture.root, files: inputs.files }), identity);
});

test('source UI input capture excludes prepared inventories while retaining their authored consumer', async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-source-ui-asset-inputs-' });
  await writeFile(fixture.path('package.json'), '{}');
  await writeFile(fixture.path('pnpm-workspace.yaml'), 'packages:\n  - apps/*\n');
  await mkdir(fixture.path('apps/ui'), { recursive: true });
  await writeFile(fixture.path('apps/ui/package.json'), JSON.stringify({ name: 'fixture-ui' }));
  const consumer = 'sources/text/localeBundleLoaders.web.ts';
  // Worker bundles and the worklet core are prepared from captured sources too;
  // a checkout copy may come from another lane's uncommitted worker edit.
  const outputs = [...new Set([...Object.values(SOURCE_UI_ASSET_OUTPUT_PATHS), `sources/${SOURCE_UI_ASSET_RECORD_FILENAME}`,
    'public/happier-crypto-worker.js', 'public/happier-password-kdf-worker.js', 'public/happier-atmosphere-worker.js',
    'sources/components/atmosphere/backdropWorkletCore.generated.js'])];
  for (const path of [consumer, ...outputs]) {
    await mkdir(dirname(fixture.path('apps/ui', path)), { recursive: true });
    await writeFile(fixture.path('apps/ui', path), 'export {};\n');
  }
  const inputs = await readSourceComponentBuildInputs({ repoDir: fixture.root, component: 'expo' });
  assert.ok(inputs.files.includes(`apps/ui/${consumer}`));
  for (const output of outputs) assert.equal(inputs.files.includes(`apps/ui/${output}`), false,
    'prepared references must be regenerated against the captured project before Expo resolves them');
});

test('source UI preparation captures compiler dependencies and invalidates reuse when they change', async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-ui-declaration-inputs-' });
  await writeFile(fixture.path('package.json'), '{}');
  for (const [owner, watchRoot] of [
    ['apps/cli/scripts/build-owned/bundledPlugins/uiDeclarations.mjs', 'apps/cli/scripts/build-owned/bundledPlugins/uiDeclarations.mjs'],
    ['scripts/workspaces/sourcePluginUiBuildOptions.mjs', 'scripts'],
  ]) {
    await mkdir(dirname(fixture.path(owner)), { recursive: true });
    await writeFile(fixture.path(owner), 'export const input = true;\n');
    const capture = await readSourceComponentBuildInputs({ repoDir: fixture.root, component: 'expo' });
    assert.ok(capture.files.includes(owner), `finite source UI captures ${owner}`);
    assert.ok(capture.watchPaths.includes(join(fixture.root, watchRoot)), `source UI observes ${owner} through ${watchRoot}`);
    const compiler = await readSourcePluginUiBuildInputs({ repoDir: fixture.root, compiler: true });
    assert.ok(compiler.includes(owner), `${owner} participates in the compiler input identity`);
    const identity = await readBuildInputIdentity({ sourceDir: fixture.root, files: compiler });
    await writeFile(fixture.path(owner), 'export const input = false;\n');
    assert.notEqual(await readBuildInputIdentity({ sourceDir: fixture.root, files: compiler }), identity);
  }
});

test('source plugin UI inputs admit shipped author Resources and exclude their generated publication outputs', async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-ui-resource-inputs-' });
  const root = fixture.path('packages/plugins/fixture');
  const manifest = { name: '@happier-dev/plugins-fixture', files: ['assets', 'dist', '.happier-plugin', '.happier-plugin-build', 'package.json'] };
  const paths = ['src/index.ts', 'assets/i18n/en.json', 'dist/happier-plugin-ui/locale.json.bundle',
    '.happier-plugin-build/daemon.js', '.happier-plugin-build/.happier-daemon-outputs.json',
    '.happier-plugin/plugin.json', '.happier-plugin/ui/generated.json', '.happier-plugin/ui/hosted-web/source.html'];
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify(manifest));
  for (const path of paths) { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), '{}'); }
  const options = { repoDir: fixture.root, pluginDirectory: 'fixture', packages: new Map([[manifest.name, { root, manifest }]]) };
  const files = await readSourcePluginUiBuildInputs(options);
  const locale = 'packages/plugins/fixture/assets/i18n/en.json';
  assert.ok(files.includes(locale));
  const watchInputs = await readSourcePluginUiBuildInputs({ ...options, includeDirectories: true });
  assert.ok(watchInputs.includes('packages/plugins/fixture/assets/i18n'));
  assert.ok(files.includes('packages/plugins/fixture/.happier-plugin/ui/hosted-web/source.html'));
  assert.ok(watchInputs.every(path => path !== 'packages/plugins/fixture'
    && !path.startsWith('packages/plugins/fixture/dist')
    && (!path.startsWith('packages/plugins/fixture/.happier-plugin') || path.startsWith('packages/plugins/fixture/.happier-plugin/ui/hosted-web'))));
  const initial = await readBuildInputIdentity({ sourceDir: fixture.root, files });
  await writeFile(join(root, 'assets/i18n/en.json'), '{"label":"changed"}');
  const changed = await readBuildInputIdentity({ sourceDir: fixture.root, files });
  assert.notEqual(changed, initial);
  await writeFile(join(root, 'dist/happier-plugin-ui/locale.json.bundle'), 'generated-output-changed');
  await writeFile(join(root, '.happier-plugin/plugin.json'), 'generated-output-changed');
  await writeFile(join(root, '.happier-plugin-build/daemon.js'), 'daemon-output-changed');
  await writeFile(join(root, '.happier-plugin-build/.happier-daemon-outputs.json'), 'daemon-record-changed');
  assert.equal(await readBuildInputIdentity({ sourceDir: fixture.root, files }), changed);
});
