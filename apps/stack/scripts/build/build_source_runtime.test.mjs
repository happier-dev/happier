import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmod, cp, mkdtemp, mkdir, writeFile, readFile, realpath, rename, symlink, rm, access, readdir, stat, utimes } from 'node:fs/promises';
import fs, { existsSync, readFileSync, watch } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createHash } from 'node:crypto';
import { withPatchedProcessEnv } from '../testkit/core/env_scope.mjs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';
import childProcess from 'node:child_process';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildSourceRuntimeBundle, captureSourceWebBuildInputs, admitSourceRuntimeReload, setBundleReadOnly } from './build_source_runtime.mjs';
import { beginPendingSourceStart } from '../runtime/shared/pending_source_start.mjs';
import { prepareSourceRuntimeReload } from '../runtime/launch/prepareSourceRuntimeReload.mjs';
import { prepareSourceComponent, resolveSourceComponentWatchPaths } from '../utils/dev/devReloadCoordinator.mjs';
import { runSourceBuildCommand } from '../utils/proc/runSourceBuildCommand.mjs';
import { applyServerHostDatabaseProviderEnv } from '../utils/server/apply_runtime_server_database_env.mjs';
import { createTempFixture } from '../testkit/core/temp_fixture.mjs';
import { buildNativeAdmissionFixtureEnv, installNativeAdmissionFixture } from '../testkit/core/native_admission_fixture.mjs';
import { relocateSourceOwnerImports } from '../testkit/core/source_web_fixture.mjs';
import { resolveCliRuntimeLaunchSpec } from '../runtime/launch/resolveCliRuntimeLaunchSpec.mjs';
import { prepareDevDaemonSourceRuntime, startDevDaemon } from '../utils/dev/daemon.mjs';
import { runServerRuntimeMigration } from '../runtime/launch/runServerRuntimeMigration.mjs';
import { resolveServerRuntimeLaunchSpec } from '../runtime/launch/resolveServerRuntimeLaunchSpec.mjs';
import { matchesNativeTypeScriptInputVersion, resolveTypeScriptCliInvocation } from '../../../../scripts/workspaces/resolveTypeScriptCliInvocation.mjs';
import { resolveWorkspaceBundleLockPath, withWorkspaceBundleLock } from '../../../../packages/cli-common/workspaceBundleLock.mjs';
import { isJsonOwnerFileLockActive } from '../utils/proc/jsonOwnerFileLock.mjs';
import { readWorkspaceBuildInputs, readSourceComponentBuildInputs } from '../utils/fs/workspaceBuildInputs.mjs';
import { readCliSourceEntries, readWorkspacePackages, createWorkspaceSourceResolver } from '../../../../packages/cli-common/sourceRuntimeEntries.mjs';
import { captureBuildInputFiles } from '../../../../scripts/workspaces/buildInputConvergence.mjs';
import { withDependencyRefreshLock, withDependencyRefresh } from '../utils/proc/dependency_refresh.mjs';
import { withJsonOwnerFileLock } from '../utils/proc/jsonOwnerFileLock.mjs';
import { startDevServer, createDevServerReloadExecutor } from '../utils/dev/server.mjs';
import { resolveHeavyweightMemoryFloorKiB } from '../utils/dev_targets/remote_commands.mjs';
import { execPnpm } from '../../../../scripts/workspaces/execPnpmCommand.mjs';

test('explicit dev daemon restart prepares current dependencies instead of refusing a stale retained generation', async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-dev-restart-dependencies-', registerCleanup: false });
  t.after(async () => { await makeFixtureWritable(fixture.root); await fixture.cleanup(); });
  const repoDir = await createReloadDaemonRepo(fixture, 'import value from "restart-input"; console.log(value);');
  const dependency = join(repoDir, 'apps/cli/node_modules/restart-input');
  await mkdir(dependency, { recursive: true });
  await mkdir(join(repoDir, 'node_modules'), { recursive: true });
  await writeFile(join(dependency, 'package.json'), JSON.stringify({ name: 'restart-input', main: 'index.cjs' }));
  await writeFile(join(dependency, 'index.cjs'), 'module.exports = 1;');
  const native = process.platform === 'linux' ? await installSourceAdmissionFixture(fixture.root) : null;
  const env = { ...process.env, ...native?.env, HAPPIER_STACK_HOME_DIR: fixture.path('home'),
    HAPPIER_STACK_SKIP_REFRESH_DEPS: '0', HAPPIER_STACK_DISABLE_REFRESH_DEPS: '0' };
  await mkdir(join(repoDir, 'apps/stack/scripts/build'), { recursive: true });
  const identityOwner = new URL('./source_author_inputs.mjs', import.meta.url);
  await writeFile(join(repoDir, 'apps/stack/scripts/build/source_author_inputs.mjs'),
    relocateSourceOwnerImports(await readFile(identityOwner, 'utf8'), identityOwner));
  await withDependencyRefresh({ installDir: repoDir, env, force: true }, async () => {
    await writeFile(join(dependency, 'index.cjs'), 'module.exports = 1;');
  });
  const build = native?.build ?? buildSourceRuntimeBundle;
  const stackBaseDir = fixture.path('stacks/consumer');
  const sourceRuntimeOptions = { repoDir, stackBaseDir };
  await build({ ...sourceRuntimeOptions, component: 'daemon', env });
  await withDependencyRefresh({ installDir: repoDir, env, force: true }, async () => {
    await writeFile(join(dependency, 'index.cjs'), 'module.exports = 2;');
  });
  const runtimeStatePath = join(stackBaseDir, 'stack.runtime.json');
  // Keep the actual lifecycle owner active while preventing a fixture from
  // starting a real daemon: a deliberate owner stop is its natural boundary.
  await writeFile(runtimeStatePath, JSON.stringify({ daemon: { desiredStateByIdentity: { default: 'stopped' } } }));
  const result = await startDevDaemon({ startDaemon: true, restart: true, env, runtimeStatePath,
    cliHomeDir: fixture.path('cli-home'), sourceRuntimeOptions }, {
    // Linux fixtures relocate the genuine build/admission owner, without
    // replacing any preparation, selection or daemon lifecycle decisions.
    prepareDevDaemonSourceRuntimeImpl: options => prepareDevDaemonSourceRuntime(options,
      { buildSourceRuntimeBundleImpl: build }),
  });
  assert.equal(result.reason, undefined, 'restart must get past stale dependency admission');
  const selected = await build({ ...sourceRuntimeOptions, component: 'daemon', env, reuseSelected: true });
  const spec = await resolveCliRuntimeLaunchSpec({ sourceRuntimeLaunch: selected });
  assert.equal((await promisify(execFile)(spec.command, spec.args, { cwd: spec.cliDir, env })).stdout.trim(), '2');
});

test('source CLI launches across unrelated dependency refreshes and refuses changed transitive runtime inputs', async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-cli-dependency-closure-', registerCleanup: false });
  t.after(async () => { await makeFixtureWritable(fixture.root); await fixture.cleanup(); });
  const repoDir = await createReloadDaemonRepo(fixture,
    'import runtime from "freshness-root"; console.log(runtime.value);');
  await writeFile(join(repoDir, 'apps/cli/scripts/claude_local_launcher.cjs'),
    'module.exports = require("./claude_version_utils.cjs");');
  await writeFile(join(repoDir, 'apps/cli/scripts/claude_version_utils.cjs'),
    'module.exports = { retained: true };');
  const identityOwner = new URL('./source_author_inputs.mjs', import.meta.url);
  // The scratch checkout supplies the real launch-time preparation owner, just
  // as the installed checkout does; relocate imports without replacing logic.
  await writeFile(join(repoDir, 'apps/stack/scripts/build/source_author_inputs.mjs'),
    relocateSourceOwnerImports(await readFile(identityOwner, 'utf8'), identityOwner));
  const virtualModules = join(repoDir, 'node_modules/.pnpm/freshness-root/node_modules');
  const root = join(virtualModules, 'freshness-root');
  const leaf = join(virtualModules, 'freshness-leaf');
  const peer = join(virtualModules, 'freshness-peer');
  await mkdir(root, { recursive: true });
  await mkdir(leaf);
  await mkdir(peer);
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'freshness-root', main: 'index.cjs',
    dependencies: { 'freshness-leaf': '1.0.0' } }));
  await writeFile(join(root, 'index.cjs'), 'exports.value = require("freshness-leaf").value;');
  await writeFile(join(leaf, 'package.json'), JSON.stringify({ name: 'freshness-leaf', main: 'index.cjs',
    peerDependencies: { 'freshness-peer': '1.0.0' } }));
  await writeFile(join(leaf, 'index.cjs'), 'exports.value = require("freshness-peer").value;');
  await writeFile(join(peer, 'package.json'), JSON.stringify({ name: 'freshness-peer', main: 'index.cjs' }));
  await writeFile(join(peer, 'index.cjs'), 'exports.value = 1;');
  await symlink(root, join(repoDir, 'apps/cli/node_modules/freshness-root'), process.platform === 'win32' ? 'junction' : 'dir');
  const native = process.platform === 'linux' ? await installSourceAdmissionFixture(fixture.root) : null;
  const env = { ...process.env, ...native?.env, HAPPIER_STACK_HOME_DIR: fixture.path('home') };
  const build = native?.build ?? buildSourceRuntimeBundle;
  const retained = await build({ repoDir, stackBaseDir: fixture.path('stacks/consumer'), component: 'daemon', env });
  assert.deepEqual(createRequire(import.meta.url)(join(retained.cliDir, 'scripts/claude_local_launcher.cjs')),
    { retained: true }, 'relative sidecar imports load from the retained bundle');
  const launch = async () => {
    const spec = await resolveCliRuntimeLaunchSpec({ sourceRuntimeLaunch: retained });
    return (await promisify(execFile)(spec.command, spec.args, { cwd: spec.cliDir, env })).stdout.trim();
  };
  assert.equal(await launch(), '1');
  await writeFile(join(repoDir, 'apps/ui/package.json'), JSON.stringify({ name: '@happier-dev/ui', dependencies: { 'ui-only': '1.0.0' } }));
  await mkdir(join(repoDir, 'patches'));
  await writeFile(join(repoDir, 'patches/metro.patch'), 'unrelated Metro patch');
  await mkdir(join(repoDir, 'apps/ui/node_modules/ui-only'), { recursive: true });
  await writeFile(join(repoDir, 'apps/ui/node_modules/ui-only/index.js'), 'export const ui = 2;');
  await writeFile(join(repoDir, 'pnpm-lock.yaml'), 'unrelated workspace wiring');
  // pnpm can replace or touch shared installed files while adding unrelated
  // workspace links. The retained runtime depends on their bytes, not inodes.
  await writeFile(join(peer, 'index.cjs'), 'exports.value = 1;');
  await writeFile(retained.dependencyPublication.markerPath, JSON.stringify({ identity: 'unrelated-ui-refresh' }));
  assert.equal(await launch(), '1', 'unrelated workspace and Metro dependency changes must not invalidate the selected CLI');
  const compiledGuard = fixture.path('compiled-closure-guard.mjs');
  const { build: compile } = createRequire(new URL('../../../cli/package.json', import.meta.url))('esbuild');
  await compile({ stdin: { contents: `
    import { assertSourceRuntimeDependenciesCurrent } from ${JSON.stringify(fileURLToPath(new URL('../../../../packages/cli-common/sourceRuntimeDependencies.mjs', import.meta.url)))};
    try {
      await assertSourceRuntimeDependenciesCurrent({ entrypoint: ${JSON.stringify(retained.entrypoint)}, component: 'cli' });
      console.log(JSON.stringify({current:true}));
    } catch ({code,phase,retryable}) { console.log(JSON.stringify({code,phase,retryable})); }
  `, resolveDir: fixture.root }, outfile: compiledGuard, bundle: true, platform: 'node', format: 'esm' });
  const bundledCheck = async () => JSON.parse((await promisify(execFile)(process.execPath, [compiledGuard], { env })).stdout);
  assert.deepEqual(await bundledCheck(), { current: true }, 'the emitted guard must load the real installed-input owner');
  await writeFile(join(peer, 'index.cjs'), 'exports.value = 2;');
  await writeFile(retained.dependencyPublication.markerPath, JSON.stringify({ identity: 'runtime-leaf-refresh' }));
  await assert.rejects(launch(), { code: 'SOURCE_RUNTIME_RELOAD_REQUIRED', phase: 'dependencies', retryable: false });
  assert.deepEqual(await bundledCheck(), { code: 'SOURCE_RUNTIME_RELOAD_REQUIRED', phase: 'dependencies', retryable: false });
});

test('captured source workspaces run pnpm tasks with private real task state', async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-source-pnpm-state-' });
  const repoDir = await createReloadDaemonRepo(fixture, 'export const ready = true;');
  await writeFile(join(repoDir, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n');
  await writeFile(join(repoDir, 'apps/cli/package.json'), JSON.stringify({
    name: '@happier-dev/cli', type: 'module', exports: {},
    scripts: { 'managed-runtime:build': 'node -e "require(\'fs\').appendFileSync(\'built.txt\', \'built\\n\')"' },
  }));
  const stateName = '.pnpm-task-run-state-v1';
  // Both workspace and root installs can already contain pnpm's mutable state.
  for (const directory of ['', 'apps/cli']) {
    const modules = join(repoDir, directory, 'node_modules');
    await mkdir(join(modules, stateName), { recursive: true });
    await writeFile(join(modules, stateName, 'sentinel'), 'source state');
  }
  const tool = join(repoDir, 'node_modules/fixture-tool');
  await mkdir(tool);
  await writeFile(join(tool, 'index.js'), 'module.exports = 42;');
  const outputDir = fixture.path('capture');
  await captureSourceWebBuildInputs({ repoDir, outputDir, component: 'daemon' });
  for (let run = 0; run < 2; run += 1) {
    // Use the actual installed pnpm safety check, not a duplicate validator.
    execPnpm(['--filter', '@happier-dev/cli', 'run', 'managed-runtime:build'], {
      cwd: outputDir, encoding: 'utf8', stdio: 'pipe', preferPath: true,
    });
  }
  assert.equal(await readFile(join(outputDir, 'apps/cli/built.txt'), 'utf8'), 'built\nbuilt\n');
  assert.equal(existsSync(join(repoDir, 'apps/cli/built.txt')), false);
  const capturedState = join(outputDir, 'node_modules', stateName);
  assert.equal((await fs.promises.lstat(capturedState)).isDirectory(), true);
  assert.equal((await fs.promises.lstat(capturedState)).isSymbolicLink(), false);
  for (const directory of ['', 'apps/cli']) {
    const source = join(repoDir, directory, 'node_modules', stateName);
    const captured = join(outputDir, directory, 'node_modules', stateName);
    assert.deepEqual(await readdir(source), ['sentinel']);
    assert.equal(await readFile(join(source, 'sentinel'), 'utf8'), 'source state');
    if (existsSync(captured)) {
      assert.equal((await fs.promises.lstat(captured)).isSymbolicLink(), false);
      assert.notEqual(await realpath(captured), await realpath(source));
      assert.equal(existsSync(join(captured, 'sentinel')), false);
    }
  }
  assert.equal(await realpath(join(outputDir, 'node_modules/fixture-tool')), await realpath(tool),
    'installed dependency payloads remain linked rather than copied');
});

test('every component captures the projection path owner imported by source tooling', async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-source-projection-owner-' });
  const repoDir = await createReloadDaemonRepo(fixture, 'export const ready = true;');
  const owner = 'apps/cli/scripts/build-owned/bundledPlugins/projectionPaths.mjs';
  await mkdir(dirname(join(repoDir, owner)), { recursive: true });
  await cp(new URL('../../../cli/scripts/build-owned/bundledPlugins/projectionPaths.mjs', import.meta.url), join(repoDir, owner));
  for (const component of ['daemon', 'expo', 'server']) {
    const outputDir = fixture.path(component);
    await captureSourceWebBuildInputs({ repoDir, outputDir, component });
    const loaded = await import(pathToFileURL(join(outputDir, owner)));
    assert.equal(loaded.resolveGeneratorHostProjectionOutPaths(outputDir).cliManifestOutPath,
      join(outputDir, 'apps/cli/src/plugins/projection/registry/sources/generatedBundledPluginManifests.ts'));
  }
});

test('daemon capture includes canonical generated UI projections without unrelated UI source', async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-source-ui-projections-' });
  const repoDir = await createReloadDaemonRepo(fixture, 'export const ready = true;');
  const uiDir = join(repoDir, 'apps/ui');
  const projections = [
    'sources/agents/registry/generatedBundledPluginEntries.ts',
    'sources/voice/registry/generatedBundledVoiceRuntimeEntries.ios.ts',
    'sources/text/bundledPluginTranslations/en.generated.ts',
  ];
  for (const path of [...projections, 'sources/agents/registry/unrelated.ts']) {
    await mkdir(dirname(join(uiDir, path)), { recursive: true });
    await writeFile(join(uiDir, path), 'export {};');
  }
  const inputs = await readSourceComponentBuildInputs({ repoDir, component: 'daemon' });
  for (const path of projections) assert.ok(inputs.files.includes(`apps/ui/${path}`), path);
  assert.equal(inputs.files.includes('apps/ui/sources/agents/registry/unrelated.ts'), false);
});

test('component capture includes newly discovered bundled plugins and their workspace dependencies', async t => {
  const { build, transform } = createRequire(import.meta.url)('esbuild');
  const fixture = await createTempFixture(t, { prefix: 'happier-source-plugin-inputs-' });
  const repoDir = fixture.path('repo');
  const cliDir = join(repoDir, 'apps/cli');
  const locatorDir = join(cliDir, 'src/plugins/projection/registry/sources');
  await mkdir(locatorDir, { recursive: true });
  // The generated catalog has admitted a plugin absent from CLI dependencies.
  await writeFile(join(cliDir, 'package.json'), JSON.stringify({ name: '@happier-dev/cli' }));
  await writeFile(join(cliDir, 'src/index.ts'), 'export const cli = true;');
  await writeFile(join(repoDir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
  await writeFile(join(repoDir, 'pnpm-workspace.yaml'), 'packages: []\n');
  for (const [directory, manifest] of [
    ['packages/plugins/new-plugin', { name: '@happier-dev/plugins-new-plugin',
      exports: { '.': { 'happier-source': './src/index.ts' } },
      dependencies: { '@happier-dev/plugin-support': '0.0.0' } }],
    ['packages/plugin-support', { name: '@happier-dev/plugin-support',
      exports: { '.': { 'happier-source': './src/index.ts' } } }],
    ['packages/plugins/reserved', { name: '@happier-dev/plugins-reserved',
      happier: { pluginScaffold: { shipping: 'reservation_only' } } }],
  ]) {
    const root = join(repoDir, directory);
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'package.json'), JSON.stringify(manifest));
    await writeFile(join(root, 'src/index.ts'), 'export const value = 1;');
  }
  await writeFile(join(repoDir, 'packages/plugins/new-plugin/src/manifest.ts'), 'export const manifest = {};');
  await writeFile(join(repoDir, 'packages/plugins/new-plugin/src/index.ts'), 'export { value } from "@happier-dev/plugin-support";');
  await writeFile(join(locatorDir, 'generatedBundledPluginManifests.ts'),
    `export const BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS = ${JSON.stringify([{
      sourceSpec: { locator: '@happier-dev/plugins-new-plugin' },
      daemonEntryPath: null, manifest: { runtime: {} },
    }])};`);

  for (const component of ['daemon', 'expo']) {
    const inputs = await readSourceComponentBuildInputs({ repoDir, component });
    assert.ok(inputs.files.includes('pnpm-lock.yaml'), 'capture includes dependency resolution');
    assert.ok(inputs.files.includes('pnpm-workspace.yaml'), 'capture includes package-manager policy');
    assert.ok(inputs.watchPaths.includes(join(repoDir, 'pnpm-workspace.yaml')), 'policy changes invalidate the source runtime');
    assert.ok(inputs.files.includes('packages/plugins/new-plugin/src/index.ts'), component);
    assert.ok(inputs.files.includes('packages/plugin-support/src/index.ts'), 'plugin dependency closure');
    assert.ok(inputs.watchPaths.includes(join(repoDir, 'packages/plugins/new-plugin/src')), 'watcher shares capture membership');
    assert.equal(inputs.files.includes('packages/plugins/reserved/src/index.ts'), false, 'reservation-only packages stay excluded');
    const captureDir = fixture.path(component);
    await captureBuildInputFiles({ sourceDir: repoDir, captureDir, readPaths: async () => inputs.files });
    if (component === 'daemon') {
      const { entries } = await readCliSourceEntries({ repoDir: captureDir, manifest: {}, transform });
      for (const path of Object.values(entries)) {
        assert.ok((await readFile(path, 'utf8')).length, `captured entry: ${relative(captureDir, path)}`);
      }
      const bundled = await build({ entryPoints: entries, outdir: fixture.path('bundled'),
        bundle: true, write: false, platform: 'node', format: 'esm', metafile: true,
        plugins: [createWorkspaceSourceResolver({
          workspacePackages: await readWorkspacePackages(captureDir),
          requireFromProject: createRequire(join(captureDir, 'apps/cli/package.json')),
        })] });
      assert.ok(Object.keys(bundled.metafile.inputs).some(path => path.endsWith('/packages/plugin-support/src/index.ts')));
    }
    assert.equal(await readFile(join(captureDir, 'packages/plugin-support/src/index.ts'), 'utf8'), 'export const value = 1;');
  }
  const serverInputs = await readSourceComponentBuildInputs({ repoDir, component: 'server' });
  assert.equal(serverInputs.files.includes('packages/plugins/new-plugin/src/index.ts'), false, 'server has no bundled CLI plugin consumer');
});

test('source plugin UI publication admits complete directories to real Metro', {
  skip: process.platform === 'darwin', // macOS selects Metro's recursive native watcher, not this fallback boundary.
}, async t => {
  let metro;
  t.after(async () => { t.mock.restoreAll(); syncBuiltinESMExports(); await metro?.end(); });
  await import('../../../../packages/cli-common/registerSourceRuntime.mjs');
  const { prepareSourcePluginUiArtifacts } = await import('../../../ui/scripts/prepareSourcePluginUiArtifacts.mjs');
  const { generateBundledPluginUiArtifacts, resolveBundledPluginUiArtifactsInputPaths } = await import('../../../ui/scripts/generateBundledPluginUiArtifacts.mjs');
  const { fixture, repoRoot, plugins, entry } = await createSourcePluginUiFixture(t, ['alpha']);
  await writeFile(entry('alpha'), 'export function renderSurface() { return "complete-graph"; }');
  const compiled = await prepareSourcePluginUiArtifacts({ repoRoot, plugins, outputDir: fixture.path('compiled') });
  const consumer = fixture.path('consumer');
  const artifactStoreDir = join(consumer, 'artifacts');
  await mkdir(artifactStoreDir, { recursive: true });
  const inventoryPath = join(consumer, 'inventory.js');
  const require = createRequire(new URL('../../../ui/package.json', import.meta.url));
  const config = await require('metro-config').getDefaultConfig(repoRoot);
  config.watchFolders = [repoRoot, consumer];
  config.resolver.useWatchman = false;
  config.resolver.assetExts.push('bundle', 'map');
  config.resolver.blockList = /[\\/]\.happier-plugin-ui-stage-[^\\/]*(?:[\\/]|$)/;
  config.maxWorkers = 1;
  config.fileMapCacheDirectory = fixture.path('cache');
  await mkdir(config.fileMapCacheDirectory);
  config.reporter = { update() {} };
  metro = await require('metro').createConnectMiddleware(config, { watch: true, waitForBundler: true });
  const graph = await metro.metroServer.getBundler().getBundler().getDependencyGraph();
  // Widen the real OS read-directory → attach-watch gap. No Metro method is
  // mocked: an empty directory listing is captured, the publisher populates it,
  // then the fallback watcher receives that earlier listing and attaches late.
  const originalMkdir = fs.promises.mkdir;
  const originalReaddir = fs.readdir;
  let listingObserved;
  const listing = new Promise(resolveListing => { listingObserved = resolveListing; });
  let publicationFinished;
  const published = new Promise(resolvePublication => { publicationFinished = resolvePublication; });
  const isNewGraph = path => typeof path === 'string' && dirname(path) === join(artifactStoreDir, 'alpha')
    && /^[a-f0-9]{64}$/.test(basename(path));
  t.mock.method(fs.promises, 'mkdir', async (path, options) => {
    const result = await originalMkdir(path, options);
    if (isNewGraph(path)) await listing;
    return result;
  });
  t.mock.method(fs, 'readdir', (path, ...args) => {
    const callback = args.pop();
    return originalReaddir(path, ...args, (error, files) => {
      if (!error && isNewGraph(path) && files.length === 0) {
        listingObserved();
        void published.then(() => callback(error, files));
      } else callback(error, files);
    });
  });
  syncBuiltinESMExports();
  t.after(() => { publicationFinished(); t.mock.restoreAll(); syncBuiltinESMExports(); });
  try {
    await generateBundledPluginUiArtifacts({ repoRoot, outputPath: inventoryPath, publicationMode: 'source',
      pluginManifests: { alpha: plugins[0].manifest }, artifactRoots: compiled.artifactRoots, artifactStoreDir });
  } finally { publicationFinished(); }
  const paths = resolveBundledPluginUiArtifactsInputPaths(inventoryPath).slice(1);
  assert.ok(paths.length > 0);
  await t.waitFor(() => {
    for (const path of paths) assert.equal(graph.doesFileExist(path), true,
      `published graph must reach Metro's actual file map: ${path}`);
  }, { timeout: 10_000, interval: 20 });
  for (const path of paths) {
    assert.equal(graph.resolveDependency(inventoryPath, {
      name: path, data: { key: path, asyncType: null, isESMImport: false, locs: [] },
    }, 'web', { dev: true }).filePath, path);
  }
  await t.test('unchanged graphs keep their mtimes and a removed subtree is repaired', async () => {
    const publish = () => generateBundledPluginUiArtifacts({ repoRoot, outputPath: inventoryPath, publicationMode: 'source',
      pluginManifests: { alpha: plugins[0].manifest }, artifactRoots: compiled.artifactRoots, artifactStoreDir });
    const before = await Promise.all(paths.map(path => stat(path)));
    await publish();
    assert.deepEqual((await Promise.all(paths.map(path => stat(path)))).map(info => info.mtimeMs), before.map(info => info.mtimeMs));
    await rm(dirname(paths[0]), { recursive: true });
    await t.waitFor(() => assert.equal(graph.doesFileExist(paths[0]), false), { timeout: 10_000, interval: 20 });
    await publish();
    await t.waitFor(() => assert.ok(paths.every(path => graph.doesFileExist(path))), { timeout: 10_000, interval: 20 });
  });
  await t.test('readiness refuses a missing file and a symlink whose target is unwatched', { timeout: 10_000 }, async t => {
    const { watchUiSourcePluginInventory } = await import('../../../ui/scripts/ensureWorkspacePackagesBuilt.mjs');
    await mkdir(join(repoRoot, 'apps/cli'), { recursive: true });
    await writeFile(join(repoRoot, 'apps/cli/package.json'), JSON.stringify({ bundledDependencies: [] }));
    const outside = fixture.path('outside/entry.cjs.bundle');
    await mkdir(dirname(outside), { recursive: true });
    await writeFile(outside, await readFile(paths[0]));
    const linked = join(consumer, 'linked.cjs.bundle');
    await symlink(outside, linked);
    const inventory = await readFile(inventoryPath, 'utf8');
    const invalidInventoryPath = join(consumer, 'invalid-inventory.js');
    const failures = [];
    const owner = watchUiSourcePluginInventory({ metroServer: metro.metroServer, metroConfig: config,
      uiPackageDir: join(repoRoot, 'apps/ui'), env: { ...process.env, HAPPIER_UI_PLUGIN_ARTIFACT_INVENTORY: invalidInventoryPath },
      logger: { error: (...args) => failures.push(args) } });
    t.after(() => owner.close());
    for (const path of [join(consumer, 'missing.cjs.bundle'), linked]) {
      await writeFile(invalidInventoryPath, inventory.replace(JSON.stringify(paths[0]), JSON.stringify(path)));
      await assert.rejects(owner.ready(), error => error.code === 'plugin_ui_inventory_unindexable' && error.message.includes(path));
    }
    assert.deepEqual(failures, []);
  });
});

for (const lifecycle of ['startup', 'refresh', 'finite']) test(lifecycle === 'finite'
  ? 'finite Plugin UI preparation retains capacity admission'
  : `Expo Plugin UI ${lifecycle} uses dev-runtime admission without validation capacity`, async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-plugin-ui-admission-' });
  const repoDir = fixture.path('repo');
  const uiPackageDir = join(repoDir, 'apps/ui');
  for (const app of ['cli', 'ui']) {
    await mkdir(join(repoDir, 'apps', app), { recursive: true });
    await writeFile(join(repoDir, 'apps', app, 'package.json'), JSON.stringify({
      name: `@fixture/${app}`, bundledDependencies: [] }));
  }
  await writeFile(join(repoDir, 'package.json'), JSON.stringify({ private: true, workspaces: ['apps/*'] }));
  const env = { ...process.env, HAPPIER_WORKSPACE_BUILD_STARTUP: '', HAPPIER_STACK_HOME_DIR: fixture.path('home'),
    HAPPIER_UI_PLUGIN_ARTIFACT_INVENTORY: fixture.path('inventory.js') };
  const { prepareUiSourcePluginInventory, watchUiSourcePluginInventory } =
    await import('../../../ui/scripts/ensureWorkspacePackagesBuilt.mjs');
  const boundaryStop = new Error('compiler process boundary reached');
  const nativeSpawn = childProcess.spawn;
  const nativeFork = childProcess.fork;
  // Only the OS spawn is replaced. Exercise the real Expo owner, source runner
  // and admission decision, then stop before running an expensive compiler.
  const inspectCompilerInvocation = args => {
    if (args.some(arg => typeof arg === 'string' && basename(arg) === 'build_source_web_ui.mjs')) {
      if (lifecycle === 'finite') {
        assert.ok(!args.includes('--dev-startup'), 'finite preparation must retain its existing admission');
        assert.ok(args.includes(process.platform === 'win32' ? '--standalone' : '--heavyweight-admission'));
      } else {
        assert.ok(args.includes('--dev-startup'), 'Expo Plugin UI construction must use dev-startup admission');
        assert.ok(!args.includes('--heavyweight-admission'), 'Expo Plugin UI must not request validation capacity');
      }
      throw boundaryStop;
    }
  };
  t.mock.method(childProcess, 'fork', (modulePath, args, options) => {
    if (basename(modulePath) === 'proc.mjs') inspectCompilerInvocation(JSON.parse(args[1]).args);
    return nativeFork(modulePath, args, options);
  });
  t.mock.method(childProcess, 'spawn', (command, args, options) => {
    inspectCompilerInvocation(args);
    return nativeSpawn(command, args, options);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  if (lifecycle !== 'refresh') {
    const { prepareSourcePluginUiInventory } = await import('./build_source_web_ui.mjs');
    const preparation = lifecycle === 'finite'
      ? prepareSourcePluginUiInventory({ repoDir, outputDir: fixture.path('output'), env })
      : prepareUiSourcePluginInventory({ uiPackageDir, env });
    await assert.rejects(preparation, error => error === boundaryStop);
    return;
  }
  const events = new EventEmitter();
  const bundler = { getWatcher: () => events, getDependencyGraph: async () => ({}) };
  const metroServer = { getBundler: () => ({ getBundler: () => bundler }) };
  let resolveRefresh;
  const refreshed = new Promise(resolve => { resolveRefresh = resolve; });
  const owner = watchUiSourcePluginInventory({ uiPackageDir, env, metroServer,
    logger: { error: (_message, error) => resolveRefresh(error) } });
  t.after(() => owner.close());
  events.emit('change', { eventsQueue: [{ filePath: join(repoDir, 'apps/cli/package.json'), type: 'change' }] });
  assert.equal(await refreshed, boundaryStop);
});

test('source edits refresh the inventory module consumed by a running Metro', async (t) => {
  const sourceRepo = fileURLToPath(new URL('../../../../', import.meta.url));
  const require = createRequire(join(sourceRepo, 'apps/ui/package.json'));
  const fixture = await createTempFixture(t, { prefix: 'happier-plugin-ui-live-', registerCleanup: false });
  let metro;
  t.after(async () => {
    await metro?.end();
    await fixture.cleanup();
  });
  const repoRoot = fixture.path('repo');
  await captureSourceWebBuildInputs({ repoDir: sourceRepo, outputDir: repoRoot });
  await import('../../../../packages/cli-common/registerSourceRuntime.mjs');
  const { CHANNEL_STATE_COLLECTION } = await import(pathToFileURL(join(repoRoot, 'packages/plugins/channels/src/collections.ts')));
  await cp(join(sourceRepo, 'apps/ui/tools'), join(repoRoot, 'apps/ui/tools'), { recursive: true });
  // This fixture also runs interactive UI preparation, whose real dependency
  // verifier reads the root patch inputs declared by pnpm-workspace.yaml.
  await cp(join(sourceRepo, 'patches'), join(repoRoot, 'patches'), { recursive: true });
  await cp(join(sourceRepo, 'apps/stack/bin'), join(repoRoot, 'apps/stack/bin'), { recursive: true });
  const cliManifestPath = join(repoRoot, 'apps/cli/package.json');
  const cliManifest = JSON.parse(await readFile(cliManifestPath, 'utf8'));
  await writeFile(cliManifestPath, JSON.stringify({ ...cliManifest,
    bundledDependencies: ['@happier-dev/plugins-inspector', '@happier-dev/plugins-channels'] }));
  const uiPackageDir = join(repoRoot, 'apps/ui');
  const source = join(repoRoot, 'packages/plugins/inspector/src/ui/renderSurface.tsx');
  await writeFile(source, 'export function renderSurface() { return "live-before"; }\n');
  // Keep the current Channels collection definition real; only the fixture's
  // presentation is reduced so the compiled consumer can expose its contract.
  await writeFile(join(repoRoot, 'packages/plugins/channels/src/ui/renderSurface.tsx'),
    'import { CHANNEL_STATE_COLLECTION } from "../collections.js";\nexport function renderSurface() { return CHANNEL_STATE_COLLECTION; }\n');
  const inventoryPath = fixture.path('consumer/inventory.js');
  withPatchedProcessEnv(t, {
    HAPPIER_UI_PLUGIN_ARTIFACT_INVENTORY: inventoryPath,
    HAPPIER_UI_VENDOR_WEB_ASSETS: '0',
    HAPPIER_STACK_DEV_AUTO_REFRESH_DEPS: '1',
    HAPPIER_WORKSPACE_BUILD_MODE: null,
    HAPPIER_UI_POSTINSTALL_DEPENDENCIES_ONLY: null,
    npm_lifecycle_event: null,
  });
  const { ensureUiWorkspacePackagesBuilt, prepareUiSourcePluginInventory } = await import(pathToFileURL(join(uiPackageDir, 'scripts/ensureWorkspacePackagesBuilt.mjs')));
  // Compile a real graph whose digest is excluded by the Metro fixture below.
  // Its next source edit must fail admission, rather than hold the serial queue.
  const rejectedInventory = fixture.path('rejected/inventory.js');
  await writeFile(source, 'export function renderSurface() { return "live-rejected"; }\n');
  await prepareUiSourcePluginInventory({ uiPackageDir, env: { ...process.env,
    HAPPIER_UI_PLUGIN_ARTIFACT_INVENTORY: rejectedInventory } });
  const rejectedAsset = [...(await readFile(rejectedInventory, 'utf8')).matchAll(/require\(("(?:[^"\\]|\\.)*")\)/g)]
    .map(match => JSON.parse(match[1])).find(path => path.includes(`${sep}inspector${sep}`));
  const rejectedDigest = rejectedAsset.split(sep)[rejectedAsset.split(sep).indexOf('inspector') + 1];
  await writeFile(source, 'export function renderSurface() { return "live-before"; }\n');
  await ensureUiWorkspacePackagesBuilt({ uiPackageDir, source: true });
  const consumeInventory = () => {
    const module = { exports: {} };
    const { code } = require('esbuild').transformSync(readFileSync(inventoryPath, 'utf8'), { format: 'cjs' });
    runInNewContext(code, { module, exports: module.exports, require: asset => readFileSync(asset, 'utf8') });
    return module.exports.BUNDLED_PLUGIN_UI_APP_ARTIFACTS;
  };
  const before = consumeInventory().find(entry => entry.artifactId === 'inspector-app-native');
  assert.ok(before);
  const config = require(join(uiPackageDir, 'metro.config.js'));
  config.projectRoot = uiPackageDir;
  config.watchFolders = [join(repoRoot, 'packages'), dirname(inventoryPath)];
  config.resolver.blockList = [...[config.resolver.blockList].flat(), new RegExp(rejectedDigest)];
  config.maxWorkers = 2;
  config.fileMapCacheDirectory = fixture.path('cache');
  await mkdir(config.fileMapCacheDirectory);
  config.reporter = { update() {} };
  // Delay only the OS watch adapter's asset notifications. The real file map,
  // resolver, compiler and publication run unchanged. This models a watcher
  // discovering a freshly populated directory after its parent inventory.
  const publicationFailures = [];
  const incumbentInventory = await readFile(inventoryPath, 'utf8');
  const { Watcher } = require('metro-file-map/private/Watcher');
  const watchChanges = Watcher.prototype.watch;
  let holdingAssets = true;
  const heldAssets = [];
  let sawCandidate = false;
  let explicitPublication = false;
  t.mock.method(Watcher.prototype, 'watch', function(onChange) {
    return watchChanges.call(this, change => {
      const path = resolve(change.root, change.relativePath);
      const consumer = path.startsWith(`${dirname(inventoryPath)}${sep}`);
      if (holdingAssets && consumer && /\.(bundle|map)$/.test(path)) {
        heldAssets.push(() => onChange(change));
        return;
      }
      onChange(change);
    });
  });
  metro = await require('metro').createConnectMiddleware(config, { watch: true, waitForBundler: true });
  const graph = await metro.metroServer.getBundler().getBundler().getDependencyGraph();
  const indexedAsset = (asset, platform) => graph.resolveDependency(inventoryPath, {
    name: asset, data: { key: asset, asyncType: null, isESMImport: false, locs: [] },
  }, platform, { dev: true }).filePath;
  // Observe the producer through the OS as well: compiler scratch is correctly
  // excluded from Metro, while its candidate still determines when to release
  // the delayed asset notifications into the real file map.
  const inventoryObserver = watch(dirname(inventoryPath), { recursive: true }, (_event, filename) => {
    try {
      const path = resolve(dirname(inventoryPath), String(filename ?? ''));
      if (holdingAssets && !explicitPublication && path.endsWith(`${sep}inventory.js`) && existsSync(path)) {
        const candidate = readFileSync(path, 'utf8');
        if (!candidate.includes(before.artifactGraph.digest)) {
          sawCandidate = true;
          if (readFileSync(inventoryPath, 'utf8') !== incumbentInventory) {
            publicationFailures.push('inventory changed before delayed asset notifications entered the file map');
          }
          holdingAssets = false;
          for (const release of heldAssets.splice(0)) release();
        }
      }
      const source = readFileSync(inventoryPath, 'utf8');
      if (source.includes(before.artifactGraph.digest)) return;
      for (const [, encoded] of source.matchAll(/require\(("(?:[^"\\]|\\.)*")\)/g)) {
        const asset = JSON.parse(encoded);
        for (const platform of ['web', 'android']) assert.equal(indexedAsset(asset, platform), asset);
      }
    } catch (error) { publicationFailures.push(error.message.split('\n')[0]); }
  });
  t.after(() => inventoryObserver.close());
  await writeFile(source, 'export function renderSurface() { return "live-after"; }\n');
  await t.waitFor(() => {
    const entries = consumeInventory();
    const after = entries.find(entry => entry.artifactId === 'inspector-app-native');
    assert.notEqual(after.artifactGraph.digest, before.artifactGraph.digest,
      'editing plugin source must replace the running consumer inventory');
    for (const file of after.files) {
      const asset = [...readFileSync(inventoryPath, 'utf8').matchAll(/require\(("(?:[^"\\]|\\.)*")\)/g)]
        .map(match => JSON.parse(match[1])).find(path => path.replaceAll('\\', '/').endsWith(file.relativePath));
      for (const platform of ['web', 'android']) assert.equal(indexedAsset(asset, platform), asset);
    }
    assert.ok(after.files.some(file => file.asset.includes('live-after')));
    const channels = entries.find(entry => entry.artifactId === 'channels-app-native');
    const channelsModule = { exports: {} };
    runInNewContext(channels.files.find(file => file.relativePath.endsWith('/entry.cjs.bundle')).asset,
      { module: channelsModule, exports: channelsModule.exports, require, TextEncoder, TextDecoder });
    const contract = channelsModule.exports.renderSurface();
    assert.equal(contract.id, 'channel-state');
    assert.equal(contract.schemaVersion, CHANNEL_STATE_COLLECTION.schemaVersion,
      'the refreshed Channels consumer must carry the captured writer contract');
  }, { timeout: 120_000, interval: 100 });
  await t.test('published inventory is immediately resolvable by Metro', () => {
    assert.equal(sawCandidate, true, 'the real watcher must observe the replacement candidate');
    assert.deepEqual(publicationFailures, [], 'an inventory must never reference assets absent from the serving file map');
  });
  await t.test('Metro asset requests wait for externally published inventory assets to enter the real file map', async () => {
    await import('../../../../packages/cli-common/registerSourceRuntime.mjs');
    const { generateBundledPluginUiArtifacts, resolveBundledPluginUiArtifactsRetainedRoots, retainBundledPluginUiArtifactsInventory } = await import(
      pathToFileURL(join(uiPackageDir, 'scripts/generateBundledPluginUiArtifacts.mjs')));
    const servingInventoryPath = fixture.path('incumbent-inventory.js');
    await writeFile(servingInventoryPath, await readFile(inventoryPath));
    const roots = resolveBundledPluginUiArtifactsRetainedRoots(inventoryPath);
    const pluginManifests = {};
    for (const directory of ['channels', 'inspector']) {
      pluginManifests[directory] = (await import(pathToFileURL(join(repoRoot, 'packages/plugins', directory, 'src/manifest.ts')))).PLUGIN_MANIFEST;
    }
    holdingAssets = true;
    explicitPublication = true;
    heldAssets.length = 0;
    await generateBundledPluginUiArtifacts({ repoRoot, outputPath: inventoryPath, publicationMode: 'source', pluginManifests,
      artifactRoots: { channels: roots.get('happier.channels'), inspector: roots.get('happier.inspector') },
      artifactOutputDirs: { channels: fixture.path('consumer/explicit/channels'), inspector: fixture.path('consumer/explicit/inspector') } });
    await t.waitFor(() => assert.ok(heldAssets.length > 0), { timeout: 120_000, interval: 100 });
    const baseline = graph.listenerCount('change');
    const server = createServer((req, res) => metro.middleware(req, res, error => {
      res.statusCode = error ? 500 : 404;
      res.end(error?.message ?? 'not found');
    }));
    await new Promise(resolveListening => server.listen(0, '127.0.0.1', resolveListening));
    let response;
    const assetUrl = path => `http://127.0.0.1:${server.address().port}/assets/?${new URLSearchParams({
      unstable_path: relative(uiPackageDir, path).split(sep).join('/'), platform: 'web',
    })}`;
    const request = fetch(assetUrl(fixture.path('consumer/explicit/inspector/react-native/inspector-app-native/entry.cjs.bundle')))
      .then(value => { response = value; return value; });
    try {
      // A waiting request binds to the real graph. Without admission it instead
      // reaches HTTP completion; no guessed sleep determines which occurred.
      await t.waitFor(() => assert.ok(response || graph.listenerCount('change') > baseline), { timeout: 120_000, interval: 100 });
      assert.equal(response, undefined, 'the HTTP asset request must stay pending while its inventory assets are unindexed');
      holdingAssets = false;
      for (const release of heldAssets.splice(0)) release();
      const completed = await request;
      const body = await completed.text();
      assert.equal(completed.status, 200, body);
      assert.match(body, /live-after/);
      const originalPath = [...incumbentInventory.matchAll(/require\(("(?:[^"\\]|\\.)*")\)/g)]
        .map(match => JSON.parse(match[1])).find(path => path.includes('inspector-app-native'));
      const original = await fetch(assetUrl(originalPath));
      assert.equal(original.status, 200);
      assert.match(await original.text(), /live-before/, 'a delayed old asset URL must still serve its original bytes');
    } finally {
      holdingAssets = false;
      for (const release of heldAssets.splice(0)) release();
      await request.catch(() => {});
      await new Promise(resolveClosed => server.close(resolveClosed));
      await retainBundledPluginUiArtifactsInventory({ inventoryPath: servingInventoryPath, outputPath: inventoryPath });
    }
  });
  await t.test('completed preparations do not retain compiler scratch or duplicate unchanged assets', async () => {
    const preparations = async () => (await readdir(dirname(inventoryPath)))
      .filter(name => name.startsWith('preparation-') || name.startsWith('.happier-plugin-ui-stage-'));
    const before = await readFile(inventoryPath, 'utf8');
    await prepareUiSourcePluginInventory({ uiPackageDir });
    assert.ok(await readFile(inventoryPath, 'utf8') === before, 'unchanged source keeps exactly the same asset paths');
    assert.deepEqual(await preparations(), [], 'completed compiler scratch must not accumulate beside served assets');
  });
  await t.test('an unindexable candidate keeps last-good and releases the refresh queue for the next edit', async () => {
    const failures = [];
    const report = console.error;
    t.mock.method(console, 'error', (...args) => { failures.push(args); report(...args); });
    const incumbent = await readFile(inventoryPath, 'utf8');
    await writeFile(source, 'export function renderSurface() { return "live-rejected"; }\n');
    await t.waitFor(() => assert.ok(failures.some(args => args.some(error =>
      error?.code === 'plugin_ui_inventory_unindexable' && error.message.includes(rejectedDigest))),
    'an impossible Metro wait must report its offending candidate path'), { timeout: 120_000, interval: 100 });
    assert.equal(await readFile(inventoryPath, 'utf8'), incumbent, 'failed admission preserves last-good');
    await writeFile(source, 'export function renderSurface() { return "live-recovered"; }\n');
    await t.waitFor(() => assert.ok(consumeInventory().find(entry => entry.artifactId === 'inspector-app-native')
      .files.some(file => file.asset.includes('live-recovered')),
    'the next source edit must advance through the same refresh queue'), { timeout: 120_000, interval: 100 });
    const { resolveBundledPluginUiArtifactsInputPaths } = await import(pathToFileURL(join(uiPackageDir, 'scripts/generateBundledPluginUiArtifacts.mjs')));
    for (const asset of resolveBundledPluginUiArtifactsInputPaths(inventoryPath).slice(1)) {
      assert.ok(asset.startsWith(`${fixture.path('consumer/artifacts')}${sep}`));
      assert.equal(indexedAsset(asset, 'web'), asset);
    }
  });
});

test('development server starts the retained coherent graph while source and workspace publication advance', { timeout: 30000 }, async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-dev-server-skew-', registerCleanup: false });
  const children = [];
  t.after(async () => {
    for (const child of children) {
      child.kill('SIGTERM');
      await child.completion;
    }
    await setBundleReadOnly(fixture.root, false);
    await fixture.cleanup();
  });
  const repoDir = fixture.path('repo');
  const serverDir = join(repoDir, 'apps/server');
  const protocolDir = join(repoDir, 'packages/protocol');
  await Promise.all(['sources', 'scripts', 'node_modules'].map(dir => mkdir(join(serverDir, dir), { recursive: true })));
  await mkdir(join(protocolDir, 'src'), { recursive: true });
  await writeFile(join(repoDir, 'package.json'), JSON.stringify({ private: true, workspaces: ['apps/*', 'packages/*'] }));
  await writeFile(join(serverDir, 'package.json'), JSON.stringify({ name: '@happier-dev/server', type: 'module',
    dependencies: { '@happier-dev/protocol': '0.0.0' }, scripts: { start: 'node --experimental-strip-types sources/main.ts' } }));
  await writeFile(join(serverDir, 'tsconfig.json'), '{}');
  await writeFile(join(serverDir, 'scripts/migrate.full.deploy.ts'), 'export const migration = true;');
  await writeFile(join(protocolDir, 'package.json'), JSON.stringify({ name: '@happier-dev/protocol', type: 'module',
    exports: { '.': { 'happier-source': './src/index.ts', default: './dist/index.js' } } }));
  await writeFile(join(protocolDir, 'src/index.ts'), 'export const value = "green-v1";');
  await mkdir(join(protocolDir, 'dist'));
  await writeFile(join(protocolDir, 'dist/index.js'), 'export const value = "old-dist";');
  await mkdir(join(serverDir, 'node_modules/@happier-dev'), { recursive: true });
  await symlink(protocolDir, join(serverDir, 'node_modules/@happier-dev/protocol'), process.platform === 'win32' ? 'junction' : 'dir');
  const entry = join(serverDir, 'sources/main.ts');
  const serverSource = `import {createServer} from 'node:http'; import {value} from '@happier-dev/protocol';
    createServer((_req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({status:'ok',service:'happier-server',value}));}).listen(Number(process.env.PORT),'127.0.0.1');`;
  await writeFile(entry, serverSource);
  await symlink(dirname(createRequire(import.meta.url).resolve('esbuild/package.json')), join(serverDir, 'node_modules/esbuild'), process.platform === 'win32' ? 'junction' : 'dir');
  await installSourcePreparationInputs(repoDir, 'server');
  const native = process.platform === 'linux' ? await installSourceAdmissionFixture(fixture.root) : null;
  const build = native?.build ?? buildSourceRuntimeBundle;
  const env = { ...(native?.env ?? process.env), HAPPIER_DB_PROVIDER: 'postgres',
    DATABASE_URL: 'postgresql://fixture:fixture@127.0.0.1:5432/fixture',
    HAPPIER_STACK_SHARED_DB_SOURCE_STACK: '', HAPPIER_STACK_SHARED_DB_SOURCE_ENV_FILE: '' };
  const stackBaseDir = fixture.path('stacks/server');
  const first = await build({ repoDir, stackBaseDir, component: 'server', serverComponent: 'happier-server', dbProvider: 'postgres', env });
  assert.equal(first.serverComponent, 'happier-server');
  assert.equal(first.dbProvider, 'postgres');
  await writeFile(entry, 'import {missingNewExport} from "@happier-dev/protocol"; export const broken = missingNewExport();');
  const { pickNextFreeTcpPort } = await import('../utils/net/ports.mjs');
  const port = await pickNextFreeTcpPort(32000);
  let started;
  await withJsonOwnerFileLock(async () => {
    const retained = await buildSourceRuntimeBundle({ repoDir, stackBaseDir, component: 'server',
      serverComponent: 'happier-server', dbProvider: 'postgres', env, devStartup: true,
      reuseSelected: 'if-available', signal: t.signal });
    assert.equal(retained.entrypoint, first.entrypoint);
    await withWorkspaceBundleLock(async () => {
      started = await startDevServer({ serverComponentName: 'happier-server', serverDir,
        sourceRuntimeOptions: { repoDir, stackBaseDir, signal: t.signal }, autostart: { baseDir: stackBaseDir },
        baseEnv: { ...env, HAPPIER_STACK_MANAGED_INFRA: '0', HAPPIER_STACK_PRISMA_MIGRATE: '0',
          HAPPIER_WORKSPACE_DIST_BUILD_LOCK_WAIT_ALLOWED: '0' },
        serverPort: port, internalServerUrl: `http://127.0.0.1:${port}`, publicServerUrl: `http://127.0.0.1:${port}`,
        serverAlreadyRunning: false, restart: false, admitPriorBuildsImmediately: true, children, quiet: true },
      { assertServerPortOwnedBySpawnedProcessGroupImpl: async () => null });
      assert.equal(started.bootstrapSource, 'source-bundle');
      assert.equal((await (await fetch(`http://127.0.0.1:${port}/health`)).json()).value, 'green-v1');
    }, { lockPath: join(repoDir, '.project/tmp/cli-dist-build.lock') });
  }, { lockPath: join(stackBaseDir, '../source-bundles/publication.lock') });
  assert.equal(first.entrypoint, JSON.parse(await readFile(join(stackBaseDir, 'source-runtime/selected-server.json'), 'utf8')).entrypoint);
  const ref = { current: started.serverProc };
  const liveFixturePids = () => children.filter(child => child.exitCode === null && child.signalCode === null).map(child => child.pid);
  const executor = createDevServerReloadExecutor({ enabled: true, stackMode: false,
    serverComponentName: 'happier-server', serverDir, serverEnv: started.serverEnv, serverPort: port,
    serverProcRef: ref, children, sourceRuntimeOptions: { repoDir, stackBaseDir, signal: t.signal },
    sourceRuntimeLaunchSpec: started.sourceRuntimeLaunchSpec }, {
    // Replace OS ownership/termination observations only; compilation, reload
    // planning, readiness and HTTP traffic use the actual production path.
    listListenPidsImpl: async () => liveFixturePids(),
    listListenPidsWithStatusImpl: async () => ({ status: 'ok', supported: true, pids: liveFixturePids() }),
    getProcessGroupIdImpl: async pid => pid,
    killProcessGroupOwnedByStackImpl: async pid => {
      const child = children.find(value => value.pid === pid);
      assert.ok(child, 'only this fixture owns termination authority');
      child.kill('SIGTERM'); await child.completion;
      return { killed: true };
    },
  });
  await t.test('a failed capture retains the serving generation and selection', async () => {
    await assert.rejects(executor.build(), /Source preparation failed/);
    assert.equal((await (await fetch(`http://127.0.0.1:${port}/health`)).json()).value, 'green-v1');
    assert.equal(JSON.parse(await readFile(join(stackBaseDir, 'source-runtime/selected-server.json'), 'utf8')).entrypoint, first.entrypoint);
  });
  await t.test('reload builds a coherent replacement before retiring the serving generation', async () => {
    await writeFile(entry, serverSource);
    await writeFile(join(protocolDir, 'src/index.ts'), 'export const value = "green-v2";');
    await executor.build();
    assert.equal((await (await fetch(`http://127.0.0.1:${port}/health`)).json()).value, 'green-v1');
    await executor.restart();
    assert.equal((await (await fetch(`http://127.0.0.1:${port}/health`)).json()).value, 'green-v2');
    assert.match(await readFile(join(protocolDir, 'dist/index.js'), 'utf8'), /old-dist/);
  });
});

async function createSourcePluginUiFixture(t, directories) {
  const fixture = await createTempFixture(t, { prefix: 'happier-plugin-ui-isolation-', registerCleanup: false });
  t.after(async () => {
    await setBundleReadOnly(fixture.root, false);
    await fixture.cleanup();
  });
  const repoRoot = fixture.path('repo');
  await mkdir(join(repoRoot, 'apps/ui'), { recursive: true });
  await writeFile(join(repoRoot, 'apps/ui/package.json'), '{}');
  const plugins = [];
  for (const directory of directories) {
    const root = join(repoRoot, 'packages/plugins', directory);
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'package.json'), JSON.stringify({
      name: `@happier-dev/plugins-${directory}`, version: '0.0.0',
      exports: { './happier-plugin-ui/panel': './src/panel.ts' },
    }));
    plugins.push({ directory, manifest: { id: `happier.${directory}`, contributes: {
      ui: { renderers: [{ id: 'panel', kind: 'reactNative', artifact: 'panel' }] },
    } } });
  }
  const entry = directory => join(repoRoot, 'packages/plugins', directory, 'src/panel.ts');
  return { fixture, repoRoot, plugins, entry };
}

test('source plugin UI preparation isolates manifest evaluation and syntax failures while refreshing healthy peers', async t => {
  const sourceRepo = fileURLToPath(new URL('../../../../', import.meta.url));
  const fixture = await createTempFixture(t, { prefix: 'happier-plugin-manifest-isolation-', registerCleanup: false });
  t.after(() => fixture.cleanup());
  const repoRoot = fixture.path('repo');
  await captureSourceWebBuildInputs({ repoDir: sourceRepo, outputDir: repoRoot });
  await cp(join(sourceRepo, 'apps/stack/bin'), join(repoRoot, 'apps/stack/bin'), { recursive: true });
  const cliPath = join(repoRoot, 'apps/cli/package.json');
  const cli = JSON.parse(await readFile(cliPath, 'utf8'));
  await writeFile(cliPath, JSON.stringify({ ...cli, bundledDependencies: ['@happier-dev/plugins-inspector', '@happier-dev/plugins-channels'] }));
  const inspector = join(repoRoot, 'packages/plugins/inspector/src/ui/renderSurface.tsx');
  const channels = join(repoRoot, 'packages/plugins/channels/src/ui/renderSurface.tsx');
  const manifestPath = join(repoRoot, 'packages/plugins/inspector/src/manifest.ts');
  const originalManifest = await readFile(manifestPath, 'utf8');
  const diagnostics = [];
  const writeStderr = process.stderr.write;
  t.mock.method(process.stderr, 'write', function(chunk, ...args) {
    diagnostics.push(String(chunk));
    return Reflect.apply(writeStderr, this, [chunk, ...args]);
  });
  const outputPath = fixture.path('consumer/inventory.js');
  const artifactStoreDir = fixture.path('consumer/artifacts');
  const { prepareSourcePluginUiInventory } = await import('./build_source_web_ui.mjs');
  const { resolveBundledPluginUiArtifactsRetainedRoots, resolveBundledPluginUiArtifactsOutputPath } = await import('../../../ui/scripts/generateBundledPluginUiArtifacts.mjs');
  // A source capture can inherit the checkout's producer inventory. This case
  // starts cold; warm retained-graph recovery is exercised below instead.
  await rm(resolveBundledPluginUiArtifactsOutputPath(repoRoot), { force: true });
  let attempt = 0;
  const prepare = async () => {
    const chunks = [];
    const outputDir = fixture.path(`prepare-${attempt++}`);
    await mkdir(outputDir);
    await prepareSourcePluginUiInventory({ repoDir: repoRoot, outputDir,
      inventoryPath: outputPath, retainedInventoryPath: outputPath, artifactStoreDir,
      stdoutStream: { write(chunk) { chunks.push(String(chunk)); } } });
    return chunks.join('');
  };
  const content = async pluginId => {
    const root = resolveBundledPluginUiArtifactsRetainedRoots(outputPath).get(pluginId);
    if (!root) return undefined;
    const graph = JSON.parse(await readFile(join(root, 'ui-artifacts.json'), 'utf8'));
    const renderer = graph.entries.find(entry => entry.executable?.exports.includes('renderSurface'));
    assert.ok(renderer, 'the retained graph must contain its declared renderer');
    return await readFile(join(root, renderer.entry), 'utf8');
  };
  await writeFile(inspector, 'export function renderSurface() { return "inspector-green"; }');
  await writeFile(channels, 'export function renderSurface() { return "channels-one"; }');
  await writeFile(manifestPath, 'throw new Error("fixture manifest evaluation failed");\n' + originalManifest);
  await prepare();
  assert.equal(await content('happier.inspector'), undefined, 'a cold broken manifest is isolated');
  assert.match(await content('happier.channels'), /channels-one/);
  assert.match(diagnostics.join(''), /\[plugin:happier.inspector\] plugin_ui_artifact_invalid:.*fixture manifest evaluation failed/);
  await writeFile(manifestPath, originalManifest);
  await prepare();
  assert.match(await content('happier.inspector'), /inspector-green/);
  diagnostics.length = 0;
  await writeFile(manifestPath, 'export const malformed = ;\n' + originalManifest);
  await writeFile(channels, 'export function renderSurface() { return "channels-two"; }');
  await prepare();
  assert.match(await content('happier.inspector'), /inspector-green/, 'manifest failure retains the complete prior graph and declaration');
  assert.match(await content('happier.channels'), /channels-two/, 'the healthy peer advances');
  assert.match(diagnostics.join(''), /\[plugin:happier.inspector\] plugin_ui_artifact_invalid:/);
  assert.match(diagnostics.join(''), /serving last-green UI/);
  await writeFile(manifestPath, originalManifest);
  await writeFile(inspector, 'export function renderSurface() { return "inspector-recovered"; }');
  await prepare();
  assert.match(await content('happier.inspector'), /inspector-recovered/);
});

test('source plugin UI preparation isolates cold failure, retains green bytes and recovers independently', async t => {
  const { runInNewContext } = await import('node:vm');
  await import('../../../../packages/cli-common/registerSourceRuntime.mjs');
  const { prepareSourcePluginUiArtifacts } = await import('../../../ui/scripts/prepareSourcePluginUiArtifacts.mjs');
  const { resolveBundledPluginUiArtifactsInputPaths } = await import('../../../ui/scripts/generateBundledPluginUiArtifacts.mjs');
  // A required daemon package can still have an independently unavailable UI.
  // This is an isolated fixture, not the repository's OpenAI plugin.
  const { fixture, repoRoot, plugins, entry } = await createSourcePluginUiFixture(t, ['openai', 'healthy']);
  const invalid = 'import { readFile } from "node:fs/promises"; export function renderSurface() { return readFile("fixture"); }';
  const valid = value => `export function renderSurface() { return ${JSON.stringify(value)}; }`;
  await writeFile(entry('openai'), invalid);
  await writeFile(entry('healthy'), valid('healthy-v1'));
  const outputPath = fixture.path('consumer/inventory.js');
  let preparation = 0;
  const prepare = (artifactOutputDirs = {}) => prepareSourcePluginUiArtifacts({ repoRoot, plugins, outputPath, artifactOutputDirs,
    outputDir: fixture.path(`preparation-${preparation++}`) });
  const load = async () => {
    const source = (await readFile(outputPath, 'utf8')).replaceAll('export const ', 'const ');
    const { artifacts } = runInNewContext(`${source}\n({artifacts:BUNDLED_PLUGIN_UI_APP_ARTIFACTS})`, { require: path => path });
    const result = new Map();
    for (const artifact of artifacts) {
      const module = { exports: {} };
      runInNewContext(await readFile(artifact.files[0].asset, 'utf8'), { module, exports: module.exports });
      result.set(artifact.pluginId, module.exports.renderSurface());
    }
    return result;
  };
  const coldNative = fixture.path('cold-native/openai');
  const cold = await prepare({ openai: coldNative });
  assert.match(cold.diagnostics.find(row => row.pluginId === 'happier.openai').message, /node:fs\/promises/);
  assert.deepEqual(cold.pluginFailures.map(row => row.pluginId), ['happier.openai']);
  assert.deepEqual(await readdir(coldNative), [], 'the finite runtime can collect an unavailable plugin without failing');
  assert.deepEqual(await load(), new Map([['happier.healthy', 'healthy-v1']]));
  await writeFile(entry('openai'), valid('broken-v1'));
  assert.deepEqual((await prepare()).diagnostics, []);
  await writeFile(entry('openai'), invalid);
  await writeFile(entry('healthy'), valid('healthy-v2'));
  const warmNative = fixture.path('warm-native/openai');
  const warm = await prepare({ openai: warmNative });
  assert.match(warm.diagnostics.find(row => row.pluginId === 'happier.openai').message, /node:fs\/promises/);
  assert.deepEqual(warm.pluginFailures, [], 'a validated last-green UI remains available');
  const nativeGraph = JSON.parse(await readFile(join(warmNative, 'ui-artifacts.json'), 'utf8'));
  assert.match(await readFile(join(warmNative, nativeGraph.entries[0].entry), 'utf8'), /broken-v1/,
    'the native runtime receives its own retained graph before temporary preparation is retired');
  assert.deepEqual(await load(), new Map([['happier.healthy', 'healthy-v2'], ['happier.openai', 'broken-v1']]));
  const brokenPath = resolveBundledPluginUiArtifactsInputPaths(outputPath).slice(1).find(path => path.includes(`${sep}openai${sep}`));
  assert.ok(brokenPath);
  await rm(brokenPath);
  const damaged = await prepare();
  assert.deepEqual(damaged.pluginFailures.map(row => row.pluginId), ['happier.openai']);
  assert.deepEqual(await load(), new Map([['happier.healthy', 'healthy-v2']]));
  await writeFile(entry('openai'), valid('broken-v2'));
  assert.deepEqual((await prepare()).diagnostics, []);
  assert.deepEqual(await load(), new Map([['happier.healthy', 'healthy-v2'], ['happier.openai', 'broken-v2']]));
});

test('source plugin UI preparation reuses unchanged plugins and rebuilds only changed inputs', async t => {
  await import('../../../../packages/cli-common/registerSourceRuntime.mjs');
  const { resolveBundledPluginUiArtifactsInputPaths } = await import('../../../ui/scripts/generateBundledPluginUiArtifacts.mjs');
  const { fixture, repoRoot, plugins, entry } = await createSourcePluginUiFixture(t, ['alpha', 'beta']);
  // This test changes plugin inputs while holding compiler inputs constant.
  // Bundle the real compiler into the fixture: unrelated shared-checkout tool
  // edits must not turn a zero-work case into a legitimate compiler rebuild.
  const compilerRoot = fixture.path('compiler');
  const compilerPath = join(compilerRoot, 'apps/ui/scripts/prepareSourcePluginUiArtifacts.mjs');
  const sourceRepo = fileURLToPath(new URL('../../../../', import.meta.url));
  await mkdir(dirname(compilerPath), { recursive: true });
  await symlink(join(sourceRepo, 'node_modules'), join(compilerRoot, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  await createRequire(import.meta.url)('esbuild').build({
    entryPoints: [join(sourceRepo, 'apps/ui/scripts/prepareSourcePluginUiArtifacts.mjs')],
    outfile: compilerPath, bundle: true, platform: 'node', format: 'esm', packages: 'external',
    conditions: ['happier-source'], logLevel: 'silent',
    banner: { js: "import { createRequire as fixtureCreateRequire } from 'node:module'; const require = fixtureCreateRequire(import.meta.url);" },
  });
  const { prepareSourcePluginUiArtifacts } = await import(pathToFileURL(compilerPath));
  const betaPackagePath = join(repoRoot, 'packages/plugins/beta/package.json');
  const betaPackage = JSON.parse(await readFile(betaPackagePath, 'utf8'));
  betaPackage.devDependencies = { '@happier-dev/cli': '0.0.0', '@fixture/ui-helper': '0.0.0' };
  await writeFile(betaPackagePath, JSON.stringify(betaPackage));
  const helperRoot = join(repoRoot, 'packages/ui-helper');
  await mkdir(join(helperRoot, 'src'), { recursive: true });
  await writeFile(join(helperRoot, 'package.json'), JSON.stringify({ name: '@fixture/ui-helper', version: '0.0.0' }));
  await writeFile(join(helperRoot, 'src/value.ts'), 'export const value = "v1";');
  const compiled = [];
  const originalWriteFile = fs.promises.writeFile;
  t.mock.method(fs.promises, 'writeFile', (path, ...args) => {
    const match = String(path).startsWith(fixture.path('preparation-')) && String(path).match(/[\\/](alpha|beta)\.json$/u);
    if (match) {
      compiled.push(match[1]);
    }
    return originalWriteFile(path, ...args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  for (const { directory } of plugins) {
    await writeFile(entry(directory), `import {value} from "fixture-ui-${directory}"; export function renderSurface(){return value;}`);
    await writeFile(join(repoRoot, 'packages/plugins', directory, 'src/value.ts'), 'export const value = "v1";');
  }
  await writeFile(join(repoRoot, 'packages/plugins/beta/src/value.ts'), 'export {value} from "@fixture/ui-helper";');
  const outputPath = fixture.path('consumer/inventory.js');
  const artifactStoreDir = fixture.path('consumer/artifacts');
  let preparation = 0;
  const prepare = () => prepareSourcePluginUiArtifacts({ repoRoot, plugins, outputPath, artifactStoreDir,
    outputDir: fixture.path(`preparation-${preparation++}`), resolveSourceImport(specifier) {
      if (specifier === '@fixture/ui-helper') return join(helperRoot, 'src/value.ts');
      if (!specifier.startsWith('fixture-ui-')) return undefined;
      const directory = specifier.slice('fixture-ui-'.length);
      return join(repoRoot, 'packages/plugins', directory, 'src/value.ts');
    } });
  await prepare();
  assert.deepEqual(compiled, ['alpha', 'beta']);
  const firstPaths = resolveBundledPluginUiArtifactsInputPaths(outputPath).slice(1);
  assert.ok(firstPaths.every(path => path.startsWith(`${artifactStoreDir}${sep}`)),
    'published source assets must be independent of disposable preparation paths');
  const firstStats = await Promise.all(firstPaths.map(path => stat(path)));
  for (const path of firstPaths) await setBundleReadOnly(join(dirname(path), '../..'), true);
  compiled.length = 0;
  await prepare();
  assert.deepEqual(compiled, [], 'unchanged plugins must not enter the compiler');
  assert.deepEqual(resolveBundledPluginUiArtifactsInputPaths(outputPath).slice(1), firstPaths);
  assert.deepEqual((await Promise.all(firstPaths.map(path => stat(path)))).map(value => value.mtimeMs), firstStats.map(value => value.mtimeMs),
    'reusing identical content must not rewrite served files or invalidate Metro');
  await mkdir(join(repoRoot, 'apps/cli/src'), { recursive: true });
  await writeFile(join(repoRoot, 'apps/cli/package.json'), JSON.stringify({ name: '@happier-dev/cli', version: '0.0.0',
    dependencies: { '@happier-dev/plugins-alpha': '0.0.0', '@happier-dev/plugins-beta': '0.0.0' } }));
  await writeFile(join(repoRoot, 'apps/cli/src/host.ts'), 'export const changedCliOnly = true;');
  await prepare();
  assert.deepEqual(compiled, [], 'a CLI-only edit is not a plugin UI input');
  for (const path of firstPaths.filter(path => path.includes(`${sep}alpha${sep}`))) {
    await setBundleReadOnly(join(dirname(path), '../..'), false);
  }
  await writeFile(join(repoRoot, 'packages/plugins/alpha/src/notImported.ts'), 'export const unused = true;');
  await prepare();
  assert.deepEqual(compiled, [], 'an unconsumed plugin source addition must compile zero unchanged UI graphs');
  assert.deepEqual(resolveBundledPluginUiArtifactsInputPaths(outputPath).slice(1), firstPaths,
    'recompiled identical byte graphs must reuse their content paths');
  assert.deepEqual((await Promise.all(firstPaths.map(path => stat(path)))).map(value => value.mtimeMs), firstStats.map(value => value.mtimeMs));
  compiled.length = 0;
  await writeFile(join(repoRoot, 'packages/plugins/alpha/src/value.ts'), 'export const value = "v2";');
  await prepare();
  assert.deepEqual(compiled, ['alpha']);
  const nextPaths = resolveBundledPluginUiArtifactsInputPaths(outputPath).slice(1);
  assert.notEqual(nextPaths.find(path => path.includes(`${sep}alpha${sep}`)), firstPaths.find(path => path.includes(`${sep}alpha${sep}`)));
  assert.equal(nextPaths.find(path => path.includes(`${sep}beta${sep}`)), firstPaths.find(path => path.includes(`${sep}beta${sep}`)));
  compiled.length = 0;
  await writeFile(join(helperRoot, 'src/value.ts'), 'export const value = "helper-v2";');
  await prepare();
  assert.deepEqual(compiled, ['beta'], 'a bundled build dependency is an input even when declared as a development dependency');
  compiled.length = 0;
  const currentBeta = resolveBundledPluginUiArtifactsInputPaths(outputPath).slice(1).find(path => path.includes(`${sep}beta${sep}`));
  await setBundleReadOnly(join(dirname(currentBeta), '../..'), false);
  await rm(currentBeta);
  await prepare();
  assert.deepEqual(compiled, ['beta'], 'damaged output must rebuild even when its inputs did not change');
});

for (const startup of [false, true]) test(startup
  ? 'stack run/start source preparation bypasses validation capacity admission on its runtime host'
  : 'validation source preparation leaves dependencies available while waiting for native admission', {
  skip: process.platform !== 'linux', timeout: 30000,
}, async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-stack-source-dependency-order-', registerCleanup: false });
  const native = await installNativeAdmissionFixture({ root: fixture.root });
  const repoDir = fixture.path('repo');
  const server = join(repoDir, 'apps/server');
  for (const app of ['server', 'cli', 'ui']) {
    await mkdir(join(repoDir, 'apps', app), { recursive: true });
    await writeFile(join(repoDir, 'apps', app, 'package.json'), JSON.stringify({ name: `@fixture/${app}`, type: 'module' }));
  }
  await writeFile(join(repoDir, 'package.json'), JSON.stringify({ private: true, workspaces: ['apps/*'] }));
  await mkdir(join(server, 'sources'));
  await mkdir(join(server, 'scripts'));
  await mkdir(join(server, 'node_modules'));
  await writeFile(join(server, 'tsconfig.json'), '{}');
  await writeFile(join(server, 'sources/main.light.ts'), 'export const ready = true;');
  await writeFile(join(server, 'scripts/migrate.sqlite.deploy.ts'), 'export async function runSqliteMigrationDeploy() {}');
  await symlink(dirname(createRequire(import.meta.url).resolve('esbuild/package.json')), join(server, 'node_modules/esbuild'));
  const sourceUrl = new URL('./build_source_runtime.mjs', import.meta.url);
  const ownerPath = fixture.path('runtime.mjs');
  // Remap only the physical admission host; use the real Stack source producer,
  // pending-start retention, capture, compiler and publication owners.
  await writeFile(ownerPath, (await readFile(sourceUrl, 'utf8'))
    .replaceAll("fileURLToPath(new URL('../../bin/hstack-exec', import.meta.url))", JSON.stringify(native.launcher))
    .replace(/^(import|export) ([^\n]*) from '(\.[^']+)'/gm,
      (_match, declaration, clause, specifier) => `${declaration} ${clause} from ${JSON.stringify(new URL(specifier, sourceUrl).href)}`));
  const { buildSourceRuntimeBundle: prepare } = await import(pathToFileURL(ownerPath));
  const available = fixture.path('available');
  const pressured = fixture.path('pressure-observed');
  await writeFile(available, '5242880');
  await mkdir(fixture.path('bin'));
  await writeFile(fixture.path('bin/awk'), `#!/bin/sh
case "$*" in
  */proc/meminfo*) value=$(/bin/cat '${available}'); printf '%s 33554432\\n' "$value"; [ "$value" -ne 5242880 ] || printf observed > '${pressured}' ;;
  */proc/loadavg*|*/proc/pressure/*) printf '0\\n' ;;
  *) exec /usr/bin/awk "$@" ;;
esac
`);
  await chmod(fixture.path('bin/awk'), 0o755);
  const env = { ...process.env, PATH: `${fixture.path('bin')}:/usr/bin:/bin`, HAPPIER_DEV_TARGET_EXECUTION: '1',
    HAPPIER_STACK_HOME_DIR: fixture.path('home') };
  for (const key of Object.keys(env)) if (key.startsWith('HAPPIER_HEAVYWEIGHT_ADMISSION_')
    || key.startsWith('HAPPIER_WORKSPACE_DIST_BUILD_LOCK_') || key === 'HAPPIER_BUILD_DEPENDENCY_CUSTODY') delete env[key];
  const phases = [];
  const pending = await beginPendingSourceStart({ stackBaseDir: fixture.path('stacks/consumer'), onPhase: phase => phases.push(phase) });
  const observer = watch(fixture.root);
  const observed = new Promise((resolveObserved, rejectObserved) => {
    observer.on('error', rejectObserved);
    observer.on('change', (_event, file) => { if (file === 'pressure-observed') resolveObserved(); });
  });
  let preparation;
  t.after(async () => {
    observer.close();
    pending.abort(new Error('source preparation fixture cleanup'));
    await pending.dispose();
    await Promise.allSettled([preparation]);
    await setBundleReadOnly(fixture.root, false);
    await fixture.cleanup();
  });
  preparation = prepare({ repoDir, stackBaseDir: fixture.path('stacks/consumer'), component: 'server', env,
    ...(startup ? {} : { devStartup: false }),
    pending, signal: AbortSignal.any([pending.signal, t.signal]) });
  void preparation.catch(() => {});
  if (startup) {
    const outcome = await Promise.race([preparation.then(built => ({ built })), observed.then(() => ({ queued: true }))]);
    assert.equal(outcome.queued, undefined, 'QA runtime startup must not enter validation capacity admission');
    assert.equal((await import(pathToFileURL(outcome.built.entrypoint))).ready, true);
    assert.ok(phases.some(value => value.phase === 'building' && value.component === 'server'));
    assert.deepEqual(await readdir(join(native.admissionRoot, 'waiters')).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error)), []);
    return;
  }
  await observed;
  assert.equal(JSON.parse(await readFile(fixture.path('stacks/consumer/source-runtime/start.pending.json'), 'utf8')).phase, 'queued');
  await withDependencyRefreshLock({ installDir: repoDir, env, signal: t.signal }, async () => {});
  await writeFile(available, '33554432');
  const built = await preparation;
  assert.ok(phases.some(value => value.phase === 'building' && value.component === 'server'), 'the admitted producer reports actual building, not just queued');
  assert.equal((await import(pathToFileURL(built.entrypoint))).ready, true);
  assert.deepEqual(await readdir(join(native.admissionRoot, 'owners')), []);
});

test('source web capture rejects a missing installed package entry before plugin preparation or Metro', { timeout: 10_000 }, async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-source-web-package-gap-' });
  const repoDir = fixture.path('repo');
  const uiDir = join(repoDir, 'apps/ui');
  const reactDir = join(uiDir, 'node_modules/react');
  await mkdir(reactDir, { recursive: true });
  await writeFile(join(repoDir, 'package.json'), JSON.stringify({ workspaces: ['apps/*'] }));
  await writeFile(join(uiDir, 'package.json'), JSON.stringify({ name: '@happier-dev/ui', dependencies: { react: '1.0.0' } }));
  await writeFile(join(reactDir, 'package.json'), JSON.stringify({ name: 'react', main: './index.js' }));
  await assert.rejects(captureSourceWebBuildInputs({ repoDir, outputDir: fixture.path('broken') }), error => {
    assert.equal(error.code, 'HAPPIER_EXPO_DEPENDENCIES_NOT_READY');
    assert.match(error.message, /react/);
    return true;
  });
  const { resolveDependencyRefreshMarkerPath } = await import('../utils/proc/dependency_refresh.mjs');
  const abort = new AbortController();
  let reportFailure;
  const failed = new Promise(resolve => { reportFailure = resolve; });
  let passes = 0;
  const preparing = prepareSourceComponent({ repoDir, target: 'expo', signal: abort.signal,
    env: { HAPPIER_STACK_DEV_RELOAD_POLL_MS: '50' },
    logger: { log() {}, warn() {}, error() { reportFailure(); } },
    prepare: () => captureSourceWebBuildInputs({ repoDir, outputDir: fixture.path(`recovery-${++passes}`) }),
  });
  t.after(async () => { abort.abort(); await preparing.catch(() => {}); });
  await failed;
  // A legitimate subpath-only package has no Node root export to validate.
  const subpaths = join(uiDir, 'node_modules/subpath-only');
  await mkdir(subpaths, { recursive: true });
  await writeFile(join(subpaths, 'package.json'), JSON.stringify({ name: 'subpath-only', exports: { './feature': './feature.js' } }));
  await writeFile(join(subpaths, 'feature.js'), 'module.exports = true;');
  await writeFile(join(uiDir, 'package.json'), JSON.stringify({ name: '@happier-dev/ui', dependencies: { react: '1.0.0', 'subpath-only': '1.0.0' } }));
  await writeFile(join(reactDir, 'index.js'), 'module.exports = { ready: true };');
  const marker = resolveDependencyRefreshMarkerPath(repoDir);
  await mkdir(dirname(marker), { recursive: true });
  await writeFile(marker, 'dependency refresh complete');
  const captured = await preparing;
  const fromCapture = createRequire(join(captured.uiProjectDir, 'package.json'));
  assert.equal(fromCapture('react').ready, true);
  assert.equal(await realpath(fromCapture.resolve('react')), await realpath(join(reactDir, 'index.js')));
});

test('source server recovery observes copied Prisma inputs and extended build configuration', async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-source-input-membership-' });
  const repoDir = fixture.path('repo');
  const server = join(repoDir, 'apps/server');
  await mkdir(join(server, 'prisma/sqlite/migrations/change'), { recursive: true });
  await installSourcePreparationInputs(repoDir, 'server');
  await writeFile(join(repoDir, 'package.json'), '{}');
  await writeFile(join(server, 'package.json'), JSON.stringify({ name: '@happier-dev/server' }));
  await writeFile(join(server, 'tsconfig.json'), '{"extends":"../../tsconfig.base.json"}');
  await writeFile(join(repoDir, 'tsconfig.base.json'), '{}');
  await writeFile(join(server, 'prisma/sqlite/migrations/change/migration.sql'), 'select 1;');
  const paths = await resolveSourceComponentWatchPaths({ repoDir, target: 'server' });
  assert.ok(paths.includes(join(server, 'prisma')), 'recovery must observe additions to copied migration membership');
  assert.ok(paths.includes(join(repoDir, 'tsconfig.base.json')), 'resolver configuration remains an input');
});

test('captured server runtime keeps generated Prisma support on its installed host after capture retirement', async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-captured-prisma-support-' });
  const repoDir = fixture.path('repo');
  const server = join(repoDir, 'apps/server');
  await mkdir(join(server, 'sources'), { recursive: true });
  await mkdir(join(server, 'scripts'));
  await mkdir(join(server, 'generated/sqlite-client'), { recursive: true });
  await mkdir(join(server, 'node_modules'));
  await writeFile(join(server, 'package.json'), JSON.stringify({ name: '@happier-dev/server', type: 'module' }));
  await writeFile(join(server, 'tsconfig.json'), '{}');
  await writeFile(join(server, 'sources/main.light.ts'), `
    export { installedMarker } from '../generated/sqlite-client/index.js';
    export { loadGeneratedClient } from './storage/generatedClient';
  `);
  await mkdir(join(server, 'sources/storage'));
  // The real server imports this same literal from both its entrypoint and
  // migration graph, causing esbuild to emit a shared chunk after capture.
  await writeFile(join(server, 'sources/storage/generatedClient.ts'), `
    export async function loadGeneratedClient() { return await import('../../generated/sqlite-client/index.js'); }
  `);
  await writeFile(join(server, 'scripts/migrate.sqlite.deploy.ts'), `
    import { loadGeneratedClient } from '../sources/storage/generatedClient';
    export async function runSqliteMigrationDeploy() {
      if ((await loadGeneratedClient()).installedMarker !== 'installed-support') throw new Error('generated support unavailable');
    }
  `);
  // Generated Prisma is installed third-party support; source capture must
  // preserve its existing host lifetime rather than point into retired inputs.
  await writeFile(join(server, 'generated/sqlite-client/index.js'), 'export const installedMarker = "installed-support";');
  await symlink(dirname(createRequire(import.meta.url).resolve('esbuild/package.json')), join(server, 'node_modules/esbuild'), process.platform === 'win32' ? 'junction' : 'dir');
  const built = await buildSourceRuntimeBundle({ repoDir, outputDir: fixture.path('output'), component: 'server' });
  await assert.rejects(access(fixture.path('output/workspace')), { code: 'ENOENT' });
  assert.ok((await readdir(join(built.runtimeDir, 'src/chunks'))).length > 0, 'the regression exercises emitted shared chunks');
  const checkRuntimeFiles = async directory => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await checkRuntimeFiles(path);
      else if (entry.isFile() && /\.[cm]?js$/.test(entry.name)) {
        const code = await readFile(path, 'utf8');
        const captureRoot = fixture.path('output/workspace');
        assert.equal([captureRoot, JSON.stringify(captureRoot).slice(1, -1), pathToFileURL(captureRoot).href]
          .some(reference => code.includes(reference)), false,
          'emitted runtime cannot reference its retired captured input root');
      }
    }
  };
  await checkRuntimeFiles(built.runtimeDir);
  // Model installed SDK support retained at the publication root after its
  // original workspace locator retires. This is the real filesystem boundary,
  // not a replacement Prisma/path resolver or a consumer-side rewrite.
  await rename(join(server, 'generated'), fixture.path('retained-generated'));
  await rm(join(built.runtimeDir, 'generated'), { recursive: true });
  await rename(fixture.path('retained-generated'), join(built.runtimeDir, 'generated'));
  const loaded = await import(pathToFileURL(built.entrypoint));
  assert.equal(loaded.installedMarker, 'installed-support');
  assert.equal((await loaded.loadGeneratedClient()).installedMarker, 'installed-support');
  await runServerRuntimeMigration({ serverLaunchSpec: resolveServerRuntimeLaunchSpec({ sourceRuntimeLaunch: built }),
    env: process.env, children: [], isCancellationRequested: () => false });
});

test('source web capture retains consumed publication policy and authored packaged brand bytes', async context => {
  const fixture = await createTempFixture(context, { prefix: 'happier-source-web-build-closure-' });
  const repoDir = fixture.path('repo');
  await mkdir(repoDir);
  await writeFile(join(repoDir, 'package.json'), JSON.stringify({ private: true, workspaces: ['apps/*', 'packages/plugins/*'] }));
  for (const name of ['cli', 'stack', 'ui']) {
    await mkdir(join(repoDir, 'apps', name, 'scripts'), { recursive: true });
    await writeFile(join(repoDir, 'apps', name, 'package.json'), JSON.stringify({ name: `@happier-dev/${name}`, type: 'module',
      ...(name === 'cli' ? { bundledDependencies: ['@happier-dev/plugins-fixture'] } : {}) }));
  }
  const publicationPath = 'apps/cli/scripts/buildPublication.mjs';
  const publicationSource = await readFile(new URL('../../../../' + publicationPath, import.meta.url), 'utf8');
  await writeFile(join(repoDir, publicationPath), publicationSource);
  await mkdir(join(repoDir, 'apps/cli/src'));
  await writeFile(join(repoDir, 'apps/cli/src/index.ts'), 'export const unrelatedCliSource = true;');
  const pluginRoot = join(repoDir, 'packages/plugins/fixture');
  await mkdir(join(pluginRoot, 'assets'), { recursive: true });
  await mkdir(join(pluginRoot, 'src'), { recursive: true });
  await mkdir(join(pluginRoot, '.happier-plugin'), { recursive: true });
  await writeFile(join(pluginRoot, 'package.json'), JSON.stringify({
    name: '@happier-dev/plugins-fixture', type: 'module', files: ['assets', '.happier-plugin'],
    exports: { './manifest': './src/manifest.ts' },
  }));
  const manifest = {
    brand: { iconResourceId: 'brand-icon' },
    contributes: { resources: [{ id: 'brand-icon', kind: 'asset', contentType: 'image/png', path: 'assets/brand.png' }] },
  };
  await writeFile(join(pluginRoot, 'src/manifest.ts'), `export const PLUGIN_MANIFEST = ${JSON.stringify(manifest)};`);
  await writeFile(join(pluginRoot, '.happier-plugin/plugin.json'), JSON.stringify(manifest));
  const brandBytes = new Uint8Array([137, 80, 78, 71]);
  await writeFile(join(pluginRoot, 'assets/brand.png'), brandBytes);
  await writeFile(join(pluginRoot, '.happier-plugin/daemon.js'), 'generated runtime output');
  const captured = await captureSourceWebBuildInputs({ repoDir, outputDir: fixture.path('capture') });
  assert.equal(await readFile(join(captured.repoDir, publicationPath), 'utf8'), publicationSource);
  const { resolveCliPublicationBuildSteps } = await import(pathToFileURL(join(captured.repoDir, publicationPath)));
  assert.deepEqual(resolveCliPublicationBuildSteps({ repoRoot: captured.repoDir }).map(step => step.name), ['shared-deps', 'dist']);
  await assert.rejects(access(join(captured.repoDir, 'apps/cli/src/index.ts')), { code: 'ENOENT' });
  const capturedPluginRoot = join(captured.repoDir, 'packages/plugins/fixture');
  const { PLUGIN_MANIFEST } = await import(pathToFileURL(join(capturedPluginRoot, 'src/manifest.ts')));
  const resource = PLUGIN_MANIFEST.contributes.resources.find(entry => entry.id === PLUGIN_MANIFEST.brand.iconResourceId);
  assert.deepEqual(new Uint8Array(await readFile(join(capturedPluginRoot, resource.path))), brandBytes);
  await assert.rejects(access(join(capturedPluginRoot, '.happier-plugin/plugin.json')), { code: 'ENOENT' });
  await assert.rejects(access(join(captured.repoDir, 'packages/plugins/fixture/.happier-plugin/daemon.js')), { code: 'ENOENT' });
});

async function linkCanonicalServerWorkspace(repoDir) {
  const canonicalRepo = fileURLToPath(new URL('../../../../', import.meta.url));
  // The real migration owner imports real workspace packages. Preserve that
  // source graph rather than replacing its internal dependencies with fixtures.
  for (const directory of ['packages', 'node_modules']) {
    await symlink(join(canonicalRepo, directory), join(repoDir, directory),
      process.platform === 'win32' ? 'junction' : 'dir');
  }
  // Capture follows declared workspace dependencies. These fixtures re-export
  // the real migration owner, so they must declare its real runtime closure.
  const { name, type, dependencies } = JSON.parse(await readFile(join(canonicalRepo, 'apps/server/package.json'), 'utf8'));
  await mkdir(join(repoDir, 'apps/server'), { recursive: true });
  await writeFile(join(repoDir, 'apps/server/package.json'), JSON.stringify({ name, type, dependencies }));
  const installedDependencies = join(canonicalRepo, 'apps/server/node_modules');
  if (existsSync(installedDependencies)) await symlink(installedDependencies, join(repoDir, 'apps/server/node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir');
}

test('cold source CLI loader retains the production stack-debug graph without CLI testkit inputs', async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-cold-cli-production-loader-' });
  const canonicalRepo = fileURLToPath(new URL('../../../../', import.meta.url));
  const canonicalCli = join(canonicalRepo, 'apps/cli');
  const repoDir = fixture.path('repo');
  const cliDir = join(repoDir, 'apps/cli');
  await captureBuildInputFiles({ sourceDir: canonicalCli, captureDir: cliDir,
    readPaths: () => readWorkspaceBuildInputs(canonicalCli, { sourceRoots: ['src'] }) });
  const canonicalManifest = JSON.parse(await readFile(join(canonicalCli, 'package.json'), 'utf8'));
  await writeFile(join(repoDir, 'package.json'), JSON.stringify({ workspaces: ['apps/*', 'packages/*', 'packages/plugins/*'] }));
  await writeFile(join(cliDir, 'package.json'), JSON.stringify({
    name: canonicalManifest.name, type: 'module', dependencies: canonicalManifest.dependencies,
  }));
  await writeFile(join(cliDir, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
    paths: { '@/*': ['./src/*'] },
  } }));
  await writeFile(join(cliDir, 'src/index.ts'),
    "export { resolveStackDebugDirectPeerStartServer } from './daemon/startup/resolveStackDebugDirectPeerStartServer';\n");
  // This focused host declares no bundled plugins. Its projection must agree
  // with that manifest, rather than adding the checkout's unrelated UI graph.
  await rm(join(cliDir, 'src/plugins/projection/registry/sources/generatedBundledPluginManifests.ts'));
  for (const directory of ['packages', 'node_modules']) await symlink(join(canonicalRepo, directory), join(repoDir, directory),
    process.platform === 'win32' ? 'junction' : 'dir');
  await symlink(join(canonicalCli, 'node_modules'), join(cliDir, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir');
  await installSourcePreparationInputs(repoDir, 'daemon');
  await assert.rejects(access(join(cliDir, 'src/testkit')), { code: 'ENOENT' });

  // Reproduce the historical production import in this private input fixture;
  // the public builder must reject it even when the runtime flag is disabled.
  const resolverPath = join(cliDir, 'src/daemon/startup/resolveStackDebugDirectPeerStartServer.ts');
  const resolverSource = await readFile(resolverPath, 'utf8');
  const missingTestkitImport = '@/testkit/transfers/startStackDebugDirectPeerTransferServer';
  assert.ok(resolverSource.includes("import('./startStackDebugDirectPeerTransferServer')"));
  await writeFile(resolverPath, resolverSource.replace("import('./startStackDebugDirectPeerTransferServer')",
    `import('${missingTestkitImport}')`));
  await assert.rejects(buildSourceRuntimeBundle({ repoDir, outputDir: fixture.path('missing-testkit'), component: 'daemon' }),
    error => {
      assert.match(error.message, /Could not resolve "@\/testkit\/transfers\/startStackDebugDirectPeerTransferServer"/);
      return true;
    });
  await writeFile(resolverPath, resolverSource);
  const runtime = await buildSourceRuntimeBundle({ repoDir, outputDir: fixture.path('output'), component: 'daemon' });
  const metafile = JSON.parse(await readFile(join(runtime.runtimeDir, 'metafile.json'), 'utf8'));
  const inputs = Object.keys(metafile.inputs).map(path => path.replaceAll('\\', '/'));
  assert.ok(inputs.some(path => path.endsWith('/startStackDebugDirectPeerTransferServer.ts')));
  assert.ok(inputs.some(path => path.endsWith('/transferFinalizeRecoveryFault.ts')));
  assert.equal(inputs.some(path => /(?:^|\/)apps\/cli\/src\/testkit\//.test(path)), false);
  await assert.rejects(access(fixture.path('output/workspace')), { code: 'ENOENT' });
  // The source graph has retired before a fresh product process reaches the
  // real lazy import. No source preload or injected module can hide a gap.
  await rm(join(cliDir, 'src'), { recursive: true });
  const loaded = spawnSync(process.execPath, ['--input-type=module', '--eval', `
    import assert from 'node:assert/strict';
    const owner = await import(${JSON.stringify(pathToFileURL(runtime.entrypoint).href)});
    assert.equal(await owner.resolveStackDebugDirectPeerStartServer({ env: {} }), undefined);
    assert.equal(typeof await owner.resolveStackDebugDirectPeerStartServer({
      env: { HAPPIER_STACK_TRANSFER_RECOVERY_TESTKIT: '1' },
    }), 'function');
  `], { cwd: fixture.root, env: { ...process.env, ...runtime.env, NODE_OPTIONS: '' }, encoding: 'utf8' });
  assert.equal(loaded.status, 0, loaded.stderr);
});

async function makeFixtureWritable(directory) {
  await chmod(directory, 0o755);
  for (const entry of await readdir(directory, {withFileTypes:true})) {
    if (entry.isDirectory()) await makeFixtureWritable(join(directory, entry.name));
    else if (!entry.isSymbolicLink()) await chmod(join(directory, entry.name), 0o644);
  }
}

async function installSourcePreparationInputs(repoDir, component) {
  // Model the checkout inputs watched by the real preparation owner. Missing
  // fixture roots must not replace the source failure each test exercises.
  await mkdir(join(repoDir, 'scripts/workspaces'), { recursive: true });
  await mkdir(join(repoDir, 'apps/stack/scripts/build'), { recursive: true });
  if (!existsSync(join(repoDir, 'pnpm-lock.yaml'))) await writeFile(join(repoDir, 'pnpm-lock.yaml'), '');
  await writeFile(join(repoDir, 'pnpm-workspace.yaml'), 'packages: []\n');
  if (component !== 'daemon') return;
  const sdk = join(repoDir, 'packages/plugin-sdk/package.json');
  if (existsSync(sdk) && JSON.parse(await readFile(sdk, 'utf8')).happier?.publicSdkRelease) {
    const canonicalRoot = fileURLToPath(new URL('../../../../packages/cli-common/', import.meta.url));
    const sharedPackages = await realpath(join(repoDir, 'packages')) === await realpath(dirname(canonicalRoot));
    // Native-admission fixtures borrow the canonical packages through a link.
    // Capturing onto that same authority would unlink its source files.
    if (!sharedPackages) {
      await captureBuildInputFiles({ sourceDir: canonicalRoot, captureDir: join(repoDir, 'packages/cli-common'),
        readPaths: () => readWorkspaceBuildInputs(canonicalRoot) });
      await mkdir(join(repoDir, 'packages/cli-common/node_modules'), { recursive: true });
      await symlink(dirname(createRequire(import.meta.url).resolve('semver/package.json')),
        join(repoDir, 'packages/cli-common/node_modules/semver'), process.platform === 'win32' ? 'junction' : 'dir');
    }
  }
  await mkdir(join(repoDir, 'apps/ui/scripts'), { recursive: true });
  // The fixture models the canonical publisher's process boundary. Its actual
  // authored-source drift semantics are covered by sourceGenerator.test.ts.
  const pluginChecker = join(repoDir, 'apps/cli/scripts/build-owned/generateBundledPluginEntries.ts');
  await mkdir(dirname(pluginChecker), { recursive: true });
  if (!existsSync(pluginChecker)) await writeFile(pluginChecker, `
    import {cpSync,existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
    import {join,dirname} from 'node:path';
    const root = process.argv[process.argv.indexOf('--daemon-output-root') + 1];
    const source = 'apps/cli/src/plugins/projection/registry/sources/generatedBundledPluginManifests.ts';
    const locator = join(root, source);
    mkdirSync(dirname(locator), {recursive:true});
    writeFileSync(locator, existsSync(source) ? readFileSync(source) : 'export const BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS = [];');
    if (existsSync('apps/cli/assets')) cpSync('apps/cli/assets', join(root,'apps/cli/assets'), {recursive:true});
    const failures = join(root,'apps/cli/.project/tmp/bundled-plugin-publication/failures.json');
    mkdirSync(dirname(failures), {recursive:true});
    writeFileSync(failures,'[]');
  `);
  for (const [path, contents] of [
    ['apps/ui/package.json', JSON.stringify({ name: '@happier-dev/ui' })],
    ['apps/ui/scripts/prepareSourcePluginUiArtifacts.mjs', ''],
    ['apps/ui/scripts/generateBundledPluginUiArtifacts.mjs', ''],
  ]) if (!existsSync(join(repoDir, path))) await writeFile(join(repoDir, path), contents);
}

test('source exports keep host dependency resolution through nested-to-hoisted relayouts', async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-export-dependency-relayout-', registerCleanup: false });
  t.after(async () => { await makeFixtureWritable(fixture.root); await fixture.cleanup(); });
  const repoDir = await createReloadDaemonRepo(fixture,
    'import runtime from "relayout-package"; console.log(runtime.value);');
  const nested = join(repoDir, 'apps/cli/node_modules/relayout-package');
  await mkdir(nested);
  await mkdir(join(repoDir, 'node_modules'), { recursive: true });
  await writeFile(join(nested, 'package.json'), JSON.stringify({ name: 'relayout-package', main: 'index.cjs' }));
  await writeFile(join(nested, 'index.cjs'), 'exports.value = 1;');
  const native = process.platform === 'linux' ? await installSourceAdmissionFixture(fixture.root) : null;
  const env = { ...process.env, ...native?.env };
  const build = native?.build ?? buildSourceRuntimeBundle;
  const runtime = await build({ repoDir, outputDir: fixture.path('export'), component: 'daemon', env });
  const launch = async () => (await promisify(execFile)(process.execPath, [runtime.entrypoint], { env })).stdout.trim();
  const pluginLaunch = async () => (await promisify(execFile)(process.execPath, ['--input-type=module', '-e', `
import { createRequire } from 'node:module';
console.log(createRequire(${JSON.stringify(resolve(runtime.runtimeDir, '../../packages/plugins/probe/dist/index.js'))})('relayout-package').value);
`], { env })).stdout.trim();
  assert.equal(await launch(), '1');
  assert.equal(await pluginLaunch(), '1', 'plugin entries must share the host lookup chain before relayout');
  await rename(nested, join(repoDir, 'node_modules/relayout-package'));
  assert.equal(await launch(), '1', 'the built CLI must resolve the hoisted dependency without rebuilding');
  assert.equal(await pluginLaunch(), '1', 'plugin entries must fall back to the hoisted tree after relayout');
});

async function createReloadDaemonRepo(fixture, source) {
  const repoDir = fixture.path('repo');
  const cliDir = join(repoDir, 'apps/cli');
  await mkdir(join(cliDir, 'src'), { recursive: true });
  await mkdir(join(cliDir, 'node_modules'));
  await writeFile(join(repoDir, 'package.json'), JSON.stringify({ workspaces: ['apps/*'] }));
  await writeFile(join(cliDir, 'package.json'), JSON.stringify({ name: '@happier-dev/cli', type: 'module', exports: {} }));
  await writeFile(join(cliDir, 'tsconfig.json'), '{}');
  await writeFile(join(cliDir, 'src/index.ts'), source);
  await symlink(dirname(createRequire(import.meta.url).resolve('esbuild/package.json')), join(cliDir, 'node_modules/esbuild'),
    process.platform === 'win32' ? 'junction' : 'dir');
  await installSourcePreparationInputs(repoDir, 'daemon');
  return repoDir;
}

test('source daemon rejects a failed projection generator before replacing its working bundle',
  { skip: process.platform !== 'linux', timeout: 30000 }, async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-source-plugin-projection-', registerCleanup: false });
  t.after(async () => { await makeFixtureWritable(fixture.root); await fixture.cleanup(); });
  const native = await installSourceAdmissionFixture(fixture.root);
  const repoDir = await createReloadDaemonRepo(fixture, 'export const ready = true;');
  const checker = join(repoDir, 'apps/cli/scripts/build-owned/generateBundledPluginEntries.ts');
  const locatorDir = join(repoDir, 'apps/cli/src/plugins/projection/registry/sources');
  const pluginDir = join(repoDir, 'packages/plugins/fixture');
  await mkdir(locatorDir, { recursive: true });
  await mkdir(join(pluginDir, 'src'), { recursive: true });
  await writeFile(join(pluginDir, 'package.json'), JSON.stringify({
    name: '@happier-dev/plugins-fixture', exports: { '.': { 'happier-source': './src/index.ts' } },
  }));
  await writeFile(join(pluginDir, 'src/index.ts'), 'export const activate = () => {};');
  const authoredManifest = join(pluginDir, 'src/manifest.ts');
  await writeFile(authoredManifest, 'export const locator = "engine";');
  await writeFile(join(locatorDir, 'generatedBundledPluginManifests.ts'),
    `export const BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS = ${JSON.stringify([{
      sourceSpec: { locator: '@happier-dev/plugins-fixture' }, daemonEntryPath: null,
      manifest: { runtime: {} },
    }])};`);
  const input = join(repoDir, 'apps/cli/assets/bundled-plugin-manifests/fixture.json');
  await mkdir(dirname(input), { recursive: true });
  await writeFile(input, '{"module":"engine"}');
  // This subprocess is the external build-tool boundary, not a replacement
  // for the builder's input capture, compilation, cache, or publication logic.
  await writeFile(checker, `
    import assert from 'node:assert/strict';
    import {readFileSync} from 'node:fs';
    import {resolveWorkspaceBundleLockPath,withWorkspaceBundleLock} from ${JSON.stringify(new URL('../../../../packages/cli-common/workspaceBundleLock.mjs', import.meta.url).href)};
    assert.equal(process.argv[2], '--daemon-projections');
    assert.equal(process.argv[3], '--daemon-output-root');
    await withWorkspaceBundleLock(async () => {
      const authored = readFileSync(new URL('../../../../packages/plugins/fixture/src/manifest.ts', import.meta.url), 'utf8');
      if (authored.includes('factory')) {
        throw new Error('Canonical projection generator failed');
      }
    }, {lockPath:resolveWorkspaceBundleLockPath(process.cwd()),wait:false});
  `);
  const stackBaseDir = fixture.path('stacks/qa');
  const options = { repoDir, stackBaseDir, component: 'daemon', env: native.env };
  const generator = await readFile(checker, 'utf8');
  await rm(checker);
  await installSourcePreparationInputs(repoDir, 'daemon');
  const incumbent = await native.build(options);
  await writeFile(checker, generator);
  await writeFile(authoredManifest, 'export const locator = "factory";');
  await writeFile(join(repoDir, 'apps/cli/src/index.ts'), 'export const = ;');
  const diagnostics = [];
  const writeStderr = process.stderr.write;
  t.mock.method(process.stderr, 'write', function(chunk, ...args) {
    diagnostics.push(String(chunk));
    return Reflect.apply(writeStderr, this, [chunk, ...args]);
  });
  await withWorkspaceBundleLock(async () => {
    await assert.rejects(native.build(options), /Source preparation failed \(exit 1\)/);
  }, { lockPath: resolveWorkspaceBundleLockPath(repoDir) });
  assert.match(diagnostics.join(''), /Canonical projection generator failed/);
  assert.equal(await readFile(input, 'utf8'), '{"module":"engine"}');
  assert.deepEqual(JSON.parse(await readFile(join(stackBaseDir, 'source-runtime/selected-daemon.json'), 'utf8')),
    { entrypoint: incumbent.entrypoint });
  assert.equal((await import(pathToFileURL(incumbent.entrypoint))).ready, true);
  await writeFile(join(repoDir, 'apps/cli/src/index.ts'), 'export const ready = true;');
  await writeFile(authoredManifest, 'export const locator = "engine";');
  await rm(checker);
  await assert.rejects(native.build(options), /Source preparation failed/u);
  assert.match(diagnostics.join(''), /Cannot find module.*generateBundledPluginEntries/u);
  assert.deepEqual(JSON.parse(await readFile(join(stackBaseDir, 'source-runtime/selected-daemon.json'), 'utf8')),
    { entrypoint: incumbent.entrypoint });
});

test('QA startup reads last green without producer custody and prepares current source in background',
  { skip: process.platform !== 'linux', timeout: 30000 }, async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-qa-last-green-', registerCleanup: false });
  const native = await installSourceAdmissionFixture(fixture.root);
  const repoDir = await createReloadDaemonRepo(fixture, 'export const ready = 1;');
  const locator = join(repoDir, 'apps/cli/src/plugins/projection/registry/sources');
  await mkdir(locator, { recursive: true });
  const compiled = fixture.path('compiled');
  await writeFile(join(locator, 'generatedBundledPluginManifests.ts'),
    `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(compiled)}, 'compiled'); export const BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS=[];`);
  const cancellation = new AbortController();
  const options = { repoDir, stackBaseDir: fixture.path('stacks/qa'), component: 'daemon', env: native.env,
    signal: AbortSignal.any([cancellation.signal, t.signal]) };
  let startup;
  let pending;
  const observer = watch(fixture.root);
  t.after(async () => {
    cancellation.abort(); observer.close();
    await Promise.allSettled([startup]);
    await pending?.dispose();
    await makeFixtureWritable(fixture.root); await fixture.cleanup();
  });
  const first = await native.build(options);
  await rm(compiled);
  const backgroundCompiled = new Promise((resolve, reject) => {
    observer.on('error', reject);
    observer.on('change', (_event, name) => { if (name === 'compiled') resolve(); });
  });
  await writeFile(join(repoDir, 'apps/cli/src/index.ts'), 'export const ready = 2;');
  let queued;
  const producerEntered = new Promise(resolve => { queued = resolve; });
  pending = await beginPendingSourceStart({ stackBaseDir: options.stackBaseDir,
    onPhase: phase => { if (phase.phase === 'queued') queued(); } });
  await withDependencyRefreshLock({ installDir: repoDir, env: native.env, signal: options.signal }, async () => {
    startup = native.build({ ...options, preparation: pending });
    void startup.catch(() => {});
    const outcome = await Promise.race([startup.then(built => ({ built })), producerEntered.then(() => ({ queued: true }))]);
    assert.equal(outcome.queued, undefined, 'a warm QA startup must read its selected graph without entering the producer path');
    assert.equal(outcome.built.entrypoint, first.entrypoint);
    assert.equal((await import(pathToFileURL(outcome.built.entrypoint))).ready, 1);
  });
  await pending.publish(async () => {});
  await backgroundCompiled;
  const reload = await beginPendingSourceStart({ stackBaseDir: options.stackBaseDir });
  try {
    const current = await native.build({ ...options, pending: reload });
    assert.equal((await import(pathToFileURL(current.entrypoint))).ready, 2);
    assert.equal(JSON.parse(await readFile(join(options.stackBaseDir, 'source-runtime/selected-daemon.json'), 'utf8')).entrypoint,
      first.entrypoint, 'background preparation must not activate a new QA graph');
  } finally { await reload.dispose(); }
});

test('source daemon rejects a broken command loader before publishing its bundle', async context => {
  const fixture = await createTempFixture(context, { prefix: 'hstack-source-reload-loader-' });
  const repoDir = await createReloadDaemonRepo(fixture, 'throw new ReferenceError("reload-command-loader-broken");');
  const outputDir = fixture.path('candidate');
  await assert.rejects(buildSourceRuntimeBundle({ repoDir, outputDir, component: 'daemon' }), /reload-command-loader-broken/);
  await assert.rejects(access(join(outputDir, 'source-bundle.json')), { code: 'ENOENT' });
});

for (const activate of [false, true]) {
test(`source reload preparation ${activate ? 'selects only after activation' : 'keeps the incumbent when activation is cancelled'}`, async t => {
  const graph = await reloadFixtureGraph(t, 'export {};');
  // Preparation may borrow the incumbent's plugin UI inventory. Seed a real
  // completed incumbent; the missing selection belongs to refusal coverage.
  graph.old.entrypoint = graph.daemon.entrypoint;
  await writeFile(graph.selectedPath, JSON.stringify(graph.old));
  const repoDir = await createReloadDaemonRepo(graph.fixture, 'export const ready = true;');
  let decide;
  const activation = new Promise(resolve => { decide = resolve; });
  let prepared;
  const ready = new Promise(resolve => { prepared = resolve; });
  const preparation = prepareSourceRuntimeReload({ stackName: 'qa', stackBaseDir: graph.stackBaseDir, repoDir,
    args: ['--no-server', '--server-url=http://fixture.invalid', '--no-ui'],
    env: { ...process.env, HAPPIER_STACK_SERVER_COMPONENT: 'happier-server-light', HAPPIER_STACK_DAEMON: '1' }, onHost: true,
    activation, onPrepared: prepared });
  void preparation.catch(() => {});
  try {
    await Promise.race([ready, preparation.then(() => { throw new Error('preparation exited before activation'); })]);
    assert.deepEqual(JSON.parse(await readFile(graph.selectedPath, 'utf8')), graph.old);
    assert.deepEqual(JSON.parse(await readFile(graph.runtimePath, 'utf8')), graph.runtime);
    decide(activate);
    if (activate) {
      await preparation;
      const selected = JSON.parse(await readFile(graph.selectedPath, 'utf8'));
      assert.notEqual(selected.entrypoint, graph.old.entrypoint);
      assert.equal(await runCaptureSourceEntrypoint(selected.entrypoint), 0);
    } else {
      await assert.rejects(preparation, /cancelled before selection/);
      assert.deepEqual(JSON.parse(await readFile(graph.selectedPath, 'utf8')), graph.old);
      assert.equal(JSON.parse(await readFile(join(graph.stackBaseDir, 'source-runtime/reload.json'), 'utf8')).status, 'failed');
    }
    assert.deepEqual(JSON.parse(await readFile(graph.runtimePath, 'utf8')), graph.runtime);
  } finally { decide(false); await preparation.catch(() => {}); }
});
}

async function runCaptureSourceEntrypoint(entrypoint) {
  return await new Promise((resolve, reject) => {
    execFile(process.execPath, [entrypoint, 'daemon', '--help'], error => {
      if (error) reject(error); else resolve(0);
    });
  });
}

test('source reload reuses completed runtime products while deferring selection until smoke and activation', async t => {
  const graph = await reloadFixtureGraph(t, 'export {};');
  // This cold preparation has no incumbent yet. The shared fixture's missing
  // incumbent belongs to refusal tests; the first build below selects a real one.
  await rm(graph.selectedPath);
  const repoDir = await createReloadDaemonRepo(graph.fixture, 'export const ready = 1;');
  const serverDir = join(repoDir, 'apps/server');
  await mkdir(join(serverDir, 'sources'), { recursive: true });
  await mkdir(join(serverDir, 'scripts'));
  await mkdir(join(serverDir, 'node_modules'));
  await writeFile(join(serverDir, 'package.json'), JSON.stringify({ name: '@happier-dev/server', type: 'module' }));
  await writeFile(join(serverDir, 'tsconfig.json'), '{}');
  await writeFile(join(serverDir, 'sources/main.light.ts'), reloadHttpServerSource);
  await writeFile(join(serverDir, 'scripts/migrate.sqlite.deploy.ts'), 'export async function runSqliteMigrationDeploy() {}');
  await symlink(dirname(createRequire(import.meta.url).resolve('esbuild/package.json')), join(serverDir, 'node_modules/esbuild'),
    process.platform === 'win32' ? 'junction' : 'dir');
  const env = { ...process.env, HAPPIER_STACK_SERVER_COMPONENT: 'happier-server-light', HAPPIER_STACK_DAEMON: '1' };
  const incumbent = await buildSourceRuntimeBundle({ repoDir, stackBaseDir: graph.stackBaseDir, component: 'daemon', env });
  await buildSourceRuntimeBundle({ repoDir, stackBaseDir: graph.stackBaseDir, component: 'server', env });
  const serverSelectionPath = join(graph.stackBaseDir, 'source-runtime/selected-server.json');
  const incumbentServer = JSON.parse(await readFile(serverSelectionPath, 'utf8'));
  assert.equal((await import(pathToFileURL(incumbent.entrypoint))).ready, 1);
  const loaded = { ...graph.runtime, sourceRuntimeIdentities: { daemon: { selected: incumbent.identity, loaded: incumbent.identity } } };
  await writeFile(graph.runtimePath, JSON.stringify(loaded));
  const incumbentSelection = JSON.parse(await readFile(graph.selectedPath, 'utf8'));
  await writeFile(join(repoDir, 'apps/cli/src/index.ts'), 'export const ready = 2;');
  const options = { stackName: 'qa', stackBaseDir: graph.stackBaseDir, repoDir, env,
    args: ['--no-ui'], onHost: true };
  await prepareSourceRuntimeReload({ ...options, onPrepared: async () => {
    assert.equal(JSON.parse(await readFile(join(graph.stackBaseDir, 'source-runtime/start.pending.json'), 'utf8')).phase, 'prepared',
      'completed smoke waiting for activation is prepared, not still checking');
    assert.deepEqual(JSON.parse(await readFile(graph.selectedPath, 'utf8')), incumbentSelection,
      'preparation and smoke do not replace the incumbent selection');
    assert.deepEqual(JSON.parse(await readFile(serverSelectionPath, 'utf8')), incumbentServer);
  } });
  const first = JSON.parse(await readFile(graph.selectedPath, 'utf8'));
  const firstServer = JSON.parse(await readFile(serverSelectionPath, 'utf8'));
  assert.equal((await import(pathToFileURL(first.entrypoint))).ready, 2);
  await prepareSourceRuntimeReload({ ...options, onPrepared: async () => {
    assert.deepEqual(JSON.parse(await readFile(graph.selectedPath, 'utf8')), first);
    assert.deepEqual(JSON.parse(await readFile(serverSelectionPath, 'utf8')), firstServer);
  } });
  const second = JSON.parse(await readFile(graph.selectedPath, 'utf8'));
  assert.equal(second.entrypoint, first.entrypoint, 'unchanged blue-green reload consumes the same completed shared product');
  assert.deepEqual(JSON.parse(await readFile(serverSelectionPath, 'utf8')), firstServer,
    'unchanged server reload consumes its completed shared product too');
  assert.deepEqual(JSON.parse(await readFile(graph.runtimePath, 'utf8')), loaded,
    'selection never claims that an incumbent process loaded replacement code');
  assert.deepEqual((await readdir(join(graph.stackBaseDir, 'source-runtime'))).filter(name => name.startsWith('bundle-reload-')), [],
    'reload has no private runtime rebuild path');
});

test('source reload and required startup reuse agree on a shared Postgres provider', async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-source-reload-shared-postgres-', registerCleanup: false });
  t.after(async () => { await makeFixtureWritable(fixture.root); await fixture.cleanup(); });
  const repoDir = fixture.path('repo');
  const serverDir = join(repoDir, 'apps/server');
  await Promise.all(['sources', 'scripts', 'node_modules'].map(path => mkdir(join(serverDir, path), { recursive: true })));
  await writeFile(join(repoDir, 'package.json'), JSON.stringify({ private: true, workspaces: ['apps/*'] }));
  await writeFile(join(serverDir, 'package.json'), JSON.stringify({ name: '@happier-dev/server', type: 'module' }));
  await writeFile(join(serverDir, 'tsconfig.json'), '{}');
  await writeFile(join(serverDir, 'sources/main.light.ts'), 'export const ready = true;');
  await writeFile(join(serverDir, 'scripts/migrate.full.deploy.ts'), 'export const migration = true;');
  await writeFile(join(serverDir, 'scripts/migrate.sqlite.deploy.ts'), 'export async function runSqliteMigrationDeploy() {}');
  await symlink(dirname(createRequire(import.meta.url).resolve('esbuild/package.json')), join(serverDir, 'node_modules/esbuild'),
    process.platform === 'win32' ? 'junction' : 'dir');
  await installSourcePreparationInputs(repoDir, 'server');

  const sourceEnvPath = fixture.path('producer/env');
  await mkdir(dirname(sourceEnvPath), { recursive: true });
  await writeFile(sourceEnvPath, [
    'HAPPIER_DB_PROVIDER=postgres',
    'DATABASE_URL=postgresql://fixture:fixture-password@private-host/dev',
    'HANDY_MASTER_SECRET=fixture-only-master-secret',
    `HAPPIER_SERVER_LIGHT_DATA_DIR=${fixture.path('producer/server-light')}`,
  ].join('\n'));

  // Exercise real preparation, canonical Postgres smoke skip and activation.
  // The smoke suite separately proves sqlite/pglite isolated health admission.
  const stackBaseDir = fixture.path('stacks/consumer');
  const env = { ...process.env,
    HAPPIER_STACK_REPO_DIR: repoDir,
    HAPPIER_STACK_SERVER_COMPONENT: 'happier-server-light',
    HAPPIER_STACK_DAEMON: '0',
    HAPPIER_DB_PROVIDER: 'sqlite',
    HAPPIER_STACK_SHARED_DB_SOURCE_STACK: 'producer',
    HAPPIER_STACK_SHARED_DB_SOURCE_ENV_FILE: sourceEnvPath,
  };
  await prepareSourceRuntimeReload({ stackName: 'consumer', stackBaseDir, repoDir,
    args: ['--no-daemon', '--no-ui'], env, onHost: true });

  const selection = JSON.parse(await readFile(join(stackBaseDir, 'source-runtime/selected-server.json'), 'utf8'));
  const selectedBundle = JSON.parse(await readFile(resolve(dirname(selection.entrypoint), '../../../source-bundle.json'), 'utf8'));
  const startupEnv = { ...env };
  const requestedProvider = applyServerHostDatabaseProviderEnv({
    serverComponentName: 'happier-server-light', env: startupEnv,
  });
  const reused = await buildSourceRuntimeBundle({ repoDir, stackBaseDir, component: 'server',
    serverComponent: 'happier-server-light', dbProvider: requestedProvider, env: startupEnv, reuseSelected: true });
  assert.equal(requestedProvider, 'postgres');
  assert.equal(selectedBundle.dbProvider, requestedProvider);
  assert.equal(reused.entrypoint, selection.entrypoint, 'required startup reuse consumes the prepared selection without a mismatch');
});

async function reloadFixtureGraph(t, source) {
  const fixture = await createTempFixture(t, { prefix: 'hstack-source-reload-selection-', registerCleanup: false });
  const stackBaseDir = fixture.path('stacks/qa');
  const sourceRoot = join(stackBaseDir, 'source-runtime');
  await mkdir(sourceRoot, { recursive: true });
  const candidateRoot = fixture.path('candidate');
  const runtimeDir = join(candidateRoot, 'apps/cli');
  await mkdir(join(runtimeDir, 'src'), { recursive: true });
  const daemon = { identity: 'candidate', runtimeDir, cliDir: runtimeDir, entrypoint: join(runtimeDir, 'src/index.mjs') };
  await writeFile(daemon.entrypoint, source);
  await writeFile(join(candidateRoot, 'source-bundle.json'), JSON.stringify(daemon));
  const incumbentRoot = fixture.path('incumbent');
  const incumbentRuntimeDir = join(incumbentRoot, 'apps/cli');
  const old = { entrypoint: join(incumbentRuntimeDir, 'src/index.mjs') };
  await mkdir(dirname(old.entrypoint), { recursive: true });
  await writeFile(old.entrypoint, 'export {};');
  await writeFile(join(incumbentRoot, 'source-bundle.json'), JSON.stringify({
    identity: 'incumbent', component: 'daemon', runtimeDir: incumbentRuntimeDir,
    cliDir: incumbentRuntimeDir, entrypoint: old.entrypoint,
  }));
  const selectedPath = join(sourceRoot, 'selected-daemon.json');
  await writeFile(selectedPath, JSON.stringify(old));
  const runtimePath = join(stackBaseDir, 'stack.runtime.json');
  const runtime = { ownerPid: process.pid, sourceRuntimeIdentities: { daemon: { selected: 'incumbent', loaded: 'incumbent' } } };
  await writeFile(runtimePath, JSON.stringify(runtime));
  const pending = await beginPendingSourceStart({ stackBaseDir });
  t.after(async () => { await pending.dispose(); await makeFixtureWritable(fixture.root); await fixture.cleanup(); });
  return { fixture, stackBaseDir, selectedPath, runtimePath, runtime, old, daemon, pending };
}

async function installCoherenceRuntimeBundle(fixture, {
  name, component, sharedDigest, sharedPath = 'packages/protocol/src/shared.ts',
}) {
  const bundleRoot = fixture.path(`stacks/source-bundles/${name}`);
  const runtimeDir = join(bundleRoot, 'apps', component === 'daemon' ? 'cli' : 'server');
  const entrypoint = join(runtimeDir, component === 'daemon' ? 'src/index.mjs' : 'sources/main.mjs');
  await mkdir(dirname(entrypoint), { recursive: true });
  await writeFile(entrypoint, component === 'daemon' ? 'export {};' : reloadHttpServerSource);
  const built = {
    identity: name,
    component,
    runtimeDir,
    entrypoint,
    ...(component === 'daemon'
      ? { cliDir: runtimeDir }
      : { serverDir: runtimeDir, dbProvider: 'sqlite', env: { HAPPIER_DB_PROVIDER: 'sqlite' }, migration: { mode: 'disabled' } }),
  };
  await writeFile(join(bundleRoot, 'source-bundle.json'), JSON.stringify({
    ...built,
    sourceInputDigests: { [sharedPath]: sharedDigest },
    inputIdentity: `${name}-inputs`,
  }));
  return built;
}

test('source startup refuses selected server and daemon bundles with conflicting shared inputs', async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-source-selected-skew-' });
  const stackBaseDir = fixture.path('stacks/qa');
  const sourceRoot = join(stackBaseDir, 'source-runtime');
  await mkdir(sourceRoot, { recursive: true });
  const server = await installCoherenceRuntimeBundle(fixture, {
    name: 'server-current', component: 'server', sharedDigest: 'current',
  });
  const daemon = await installCoherenceRuntimeBundle(fixture, {
    name: 'daemon-stale', component: 'daemon', sharedDigest: 'stale',
  });
  await writeFile(join(sourceRoot, 'selected-server.json'), JSON.stringify({ entrypoint: server.entrypoint }));
  await writeFile(join(sourceRoot, 'selected-daemon.json'), JSON.stringify({ entrypoint: daemon.entrypoint }));

  await assert.rejects(
    buildSourceRuntimeBundle({ stackBaseDir, component: 'server', reuseSelected: true,
      requireCoherentSelection: true }),
    error => error?.code === 'source_runtime_input_skew'
      && error.components?.server === 'server-current'
      && error.components?.daemon === 'daemon-stale'
      && error.message.includes('--restart'),
  );
});

test('source startup ignores non-protocol input drift between otherwise reusable selections', async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-source-non-protocol-drift-' });
  const stackBaseDir = fixture.path('stacks/qa');
  const sourceRoot = join(stackBaseDir, 'source-runtime');
  await mkdir(sourceRoot, { recursive: true });
  const server = await installCoherenceRuntimeBundle(fixture, {
    name: 'server-current', component: 'server', sharedDigest: 'older', sharedPath: 'apps/bootstrap/package.json',
  });
  const daemon = await installCoherenceRuntimeBundle(fixture, {
    name: 'daemon-current', component: 'daemon', sharedDigest: 'newer', sharedPath: 'apps/bootstrap/package.json',
  });
  await writeFile(join(sourceRoot, 'selected-server.json'), JSON.stringify({ entrypoint: server.entrypoint }));
  await writeFile(join(sourceRoot, 'selected-daemon.json'), JSON.stringify({ entrypoint: daemon.entrypoint }));

  assert.equal((await buildSourceRuntimeBundle({ stackBaseDir, component: 'server', reuseSelected: true,
    requireCoherentSelection: true })).identity, 'server-current');
});

test('daemon-only startup ignores an inactive stale local server selection', async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-source-split-placement-' });
  const stackBaseDir = fixture.path('stacks/qa');
  const sourceRoot = join(stackBaseDir, 'source-runtime');
  await mkdir(sourceRoot, { recursive: true });
  const server = await installCoherenceRuntimeBundle(fixture, {
    name: 'inactive-server', component: 'server', sharedDigest: 'stale',
  });
  const daemon = await installCoherenceRuntimeBundle(fixture, {
    name: 'local-daemon', component: 'daemon', sharedDigest: 'current',
  });
  await writeFile(join(sourceRoot, 'selected-server.json'), JSON.stringify({ entrypoint: server.entrypoint }));
  await writeFile(join(sourceRoot, 'selected-daemon.json'), JSON.stringify({ entrypoint: daemon.entrypoint }));

  assert.equal((await buildSourceRuntimeBundle({ stackBaseDir, component: 'daemon', reuseSelected: true })).identity,
    'local-daemon');
});

test('plain source start reuses a coherent older pinned pair while current protocol source has moved', async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-source-coherent-last-green-' });
  const repoDir = fixture.path('repo');
  const protocolPath = join(repoDir, 'packages/protocol/src/shared.ts');
  const stackBaseDir = fixture.path('stacks/qa');
  const sourceRoot = join(stackBaseDir, 'source-runtime');
  await mkdir(dirname(protocolPath), { recursive: true });
  await mkdir(sourceRoot, { recursive: true });
  await writeFile(protocolPath, 'export const version = "current";');
  const server = await installCoherenceRuntimeBundle(fixture, {
    name: 'server-last-green', component: 'server', sharedDigest: 'older-pinned',
  });
  const daemon = await installCoherenceRuntimeBundle(fixture, {
    name: 'daemon-last-green', component: 'daemon', sharedDigest: 'older-pinned',
  });
  await writeFile(join(sourceRoot, 'selected-server.json'), JSON.stringify({ entrypoint: server.entrypoint }));
  await writeFile(join(sourceRoot, 'selected-daemon.json'), JSON.stringify({ entrypoint: daemon.entrypoint }));

  const selected = await buildSourceRuntimeBundle({ repoDir, stackBaseDir, component: 'server',
    preparation: { prepareInBackground() {} }, requireCoherentSelection: true });
  assert.equal(selected.identity, 'server-last-green');
});

test('deferred source restart publishes the server before its matching daemon companion', async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-source-deferred-companion-' });
  const stackBaseDir = fixture.path('stacks/qa');
  const sourceRoot = join(stackBaseDir, 'source-runtime');
  await mkdir(sourceRoot, { recursive: true });
  const staleDaemon = await installCoherenceRuntimeBundle(fixture, {
    name: 'daemon-stale', component: 'daemon', sharedDigest: 'stale',
  });
  const currentServer = await installCoherenceRuntimeBundle(fixture, {
    name: 'server-current', component: 'server', sharedDigest: 'current',
  });
  const currentDaemon = await installCoherenceRuntimeBundle(fixture, {
    name: 'daemon-current', component: 'daemon', sharedDigest: 'current',
  });
  await writeFile(join(sourceRoot, 'selected-daemon.json'), JSON.stringify({ entrypoint: staleDaemon.entrypoint }));

  const serverPending = await beginPendingSourceStart({ stackBaseDir });
  t.after(() => serverPending.dispose());
  const serverAdmission = await admitSourceRuntimeReload({
    stackBaseDir, components: { server: currentServer }, pending: serverPending,
  });
  await serverAdmission.activate();
  assert.equal(
    JSON.parse(await readFile(join(sourceRoot, 'selected-server.json'), 'utf8')).entrypoint,
    currentServer.entrypoint,
  );

  const daemonPending = await beginPendingSourceStart({ stackBaseDir });
  t.after(() => daemonPending.dispose());
  const daemonAdmission = await admitSourceRuntimeReload({
    stackBaseDir, components: { daemon: currentDaemon }, pending: daemonPending,
  });
  await daemonAdmission.activate();
  assert.equal(
    JSON.parse(await readFile(join(sourceRoot, 'selected-daemon.json'), 'utf8')).entrypoint,
    currentDaemon.entrypoint,
  );
  assert.equal(
    (await buildSourceRuntimeBundle({ stackBaseDir, component: 'server', reuseSelected: true })).identity,
    'server-current',
  );
});

test('fresh source restart converges when protocol source changes between server and daemon captures',
  { timeout: 90000 }, async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-source-reload-converges-', registerCleanup: false });
  t.after(async () => { await makeFixtureWritable(fixture.root); await fixture.cleanup(); });
  const repoDir = await createReloadDaemonRepo(fixture, 'export const ready = true;');
  const stackBaseDir = fixture.path('stacks/qa');
  const serverDir = join(repoDir, 'apps/server');
  await Promise.all(['sources', 'scripts', 'node_modules'].map(path => mkdir(join(serverDir, path), { recursive: true })));
  await writeFile(join(serverDir, 'package.json'), JSON.stringify({
    name: '@happier-dev/server', type: 'module', dependencies: { '@happier-dev/protocol': 'workspace:*' },
  }));
  await writeFile(join(serverDir, 'tsconfig.json'), '{}');
  await writeFile(join(serverDir, 'sources/main.light.ts'), reloadHttpServerSource);
  await writeFile(join(serverDir, 'scripts/migrate.sqlite.deploy.ts'), 'export async function runSqliteMigrationDeploy() {}');
  await symlink(dirname(createRequire(import.meta.url).resolve('esbuild/package.json')), join(serverDir, 'node_modules/esbuild'),
    process.platform === 'win32' ? 'junction' : 'dir');
  const cliManifestPath = join(repoDir, 'apps/cli/package.json');
  await writeFile(cliManifestPath, JSON.stringify({
    ...JSON.parse(await readFile(cliManifestPath, 'utf8')),
    dependencies: { '@happier-dev/protocol': 'workspace:*' },
  }));
  const protocolPath = join(repoDir, 'packages/protocol/src/shared.ts');
  await mkdir(dirname(protocolPath), { recursive: true });
  await writeFile(join(repoDir, 'packages/protocol/package.json'), JSON.stringify({
    name: '@happier-dev/protocol', type: 'module', exports: { '.': { 'happier-source': './src/shared.ts' } },
  }));
  const sharedProtocolSource = 'export const version = "shared-capture";';
  await writeFile(protocolPath, sharedProtocolSource);
  await Promise.all(Array.from({ length: 700 }, (_, index) => writeFile(
    join(dirname(protocolPath), `shared-${index}-${'x'.repeat(96)}.ts`),
    `export const shared${index} = ${index};`,
  )));
  await writeFile(join(repoDir, 'package.json'), JSON.stringify({ workspaces: ['apps/*', 'packages/*'] }));
  await writeFile(join(repoDir, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n  - packages/*\n');
  await installSourcePreparationInputs(repoDir, 'server');
  await writeFile(join(repoDir, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n  - packages/*\n');

  let changed = false;
  await prepareSourceRuntimeReload({ stackName: 'qa', stackBaseDir, repoDir, args: ['--no-ui'], onHost: true,
    env: { ...process.env, HAPPIER_STACK_SERVER_COMPONENT: 'happier-server-light', HAPPIER_STACK_DAEMON: '1' },
    onPhase: phase => {
      if (!changed && phase.phase === 'preparing' && phase.component === 'daemon') {
        changed = true;
        fs.writeFileSync(protocolPath, 'export const version = "daemon-capture";');
      }
    } });

  assert.equal(changed, true);
  const sourceRoot = join(stackBaseDir, 'source-runtime');
  const selected = await Promise.all(['server', 'daemon'].map(async component => {
    const selection = JSON.parse(await readFile(join(sourceRoot, `selected-${component}.json`), 'utf8'));
    return JSON.parse(await readFile(resolve(dirname(selection.entrypoint), '../../../source-bundle.json'), 'utf8'));
  }));
  assert.equal(selected[0].sourceInputDigests['packages/protocol/src/shared.ts'],
    selected[1].sourceInputDigests['packages/protocol/src/shared.ts']);
  assert.equal(selected[0].sourceInputDigests['packages/protocol/src/shared.ts'],
    createHash('sha256').update(sharedProtocolSource).digest('hex'),
    'both components consume the one shared Protocol capture taken before either build');
});

test('completed source runtime lookup keeps publication custody through adoption', async t => {
  const graph = await reloadFixtureGraph(t, 'export {};');
  // This is a cold-build/adoption test, not a broken-incumbent recovery test.
  // The shared reload fixture intentionally seeds a nonexistent incumbent.
  await rm(graph.selectedPath);
  const repoDir = await createReloadDaemonRepo(graph.fixture, 'export const ready = 1;');
  const options = { repoDir, stackBaseDir: graph.stackBaseDir, component: 'daemon' };
  const first = await buildSourceRuntimeBundle(options);
  const completionPath = join(first.runtimeDir, '../../source-bundle.json');
  const publicationLock = join(graph.stackBaseDir, '../source-bundles/publication.lock');
  // Observe the real filesystem boundary, not the reuse or publication owner.
  // A fingerprint lease alone cannot exclude another fingerprint's reclaimer.
  const fs = (await import('node:fs/promises')).default;
  const { syncBuiltinESMExports } = await import('node:module');
  const original = fs.readFile;
  let observed = false;
  fs.readFile = async (path, ...args) => {
    if (String(path) === join(completionPath)) {
      observed = true;
      assert.equal(isJsonOwnerFileLockActive(publicationLock), true,
        'completed runtime lookup must exclude publication reclamation before reading its record');
      assert.deepEqual((await readdir(dirname(publicationLock))).filter(name => /^build-[a-f0-9]+\.lock$/.test(name)), [],
        'completed runtime adoption must not hold a producer lease while taking publication custody');
    }
    return await original(path, ...args);
  };
  syncBuiltinESMExports();
  try {
    assert.equal((await buildSourceRuntimeBundle(options)).entrypoint, first.entrypoint);
    assert.equal(observed, true);
  } finally { fs.readFile = original; syncBuiltinESMExports(); }
});

test('source reload failing daemon leaves incumbent selection and loaded runtime intact', async t => {
  const graph = await reloadFixtureGraph(t, 'throw new ReferenceError("candidate-loader-broken");');
  await assert.rejects(admitSourceRuntimeReload({ stackBaseDir: graph.stackBaseDir,
    components: { daemon: graph.daemon }, pending: graph.pending }), /candidate-loader-broken/);
  assert.deepEqual(JSON.parse(await readFile(graph.selectedPath, 'utf8')), graph.old);
  assert.deepEqual(JSON.parse(await readFile(graph.runtimePath, 'utf8')), graph.runtime);
});

test('source reload passing daemon selects the validated graph without claiming a new loaded process', async t => {
  const graph = await reloadFixtureGraph(t, 'if (process.argv.slice(2).join(" ") !== "daemon --help") process.exit(2);');
  const admitted = await admitSourceRuntimeReload({ stackBaseDir: graph.stackBaseDir,
    components: { daemon: graph.daemon }, pending: graph.pending });
  assert.deepEqual(JSON.parse(await readFile(graph.selectedPath, 'utf8')), graph.old);
  await admitted.activate();
  assert.deepEqual(JSON.parse(await readFile(graph.selectedPath, 'utf8')), { entrypoint: graph.daemon.entrypoint });
  assert.deepEqual(JSON.parse(await readFile(graph.runtimePath, 'utf8')), graph.runtime);
});

test('source reload interrupted preparation cannot select a completed candidate', async t => {
  const graph = await reloadFixtureGraph(t, 'export {};');
  const admitted = await admitSourceRuntimeReload({ stackBaseDir: graph.stackBaseDir,
    components: { daemon: graph.daemon }, pending: graph.pending });
  const replacement = await beginPendingSourceStart({ stackBaseDir: graph.stackBaseDir });
  try {
    await assert.rejects(admitted.activate(), { code: 'ESOURCESTARTSUPERSEDED' });
    assert.deepEqual(JSON.parse(await readFile(graph.selectedPath, 'utf8')), graph.old);
    assert.deepEqual(JSON.parse(await readFile(graph.runtimePath, 'utf8')), graph.runtime);
  } finally { await replacement.dispose(); }
});

test('source recovery refuses a selected daemon whose command loader is broken', async t => {
  const graph = await reloadFixtureGraph(t, 'throw new ReferenceError("selected-daemon-loader-broken");');
  await writeFile(graph.selectedPath, JSON.stringify({ entrypoint: graph.daemon.entrypoint }));
  await assert.rejects(buildSourceRuntimeBundle({ stackBaseDir: graph.stackBaseDir, component: 'daemon', reuseSelected: true }),
    /selected-daemon-loader-broken/);
});

test('source reload cancellation during command load preserves selection and the canonical interruption reason', async t => {
  const graph = await reloadFixtureGraph(t, 'export {};');
  const started = graph.fixture.path('loader-started');
  await writeFile(graph.daemon.entrypoint, `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(started)}, 'yes'); setInterval(() => {}, 60000);`);
  let observeStarted;
  const entered = new Promise(resolve => { observeStarted = resolve; });
  const observer = watch(graph.fixture.root, (_event, name) => { if (name === 'loader-started') observeStarted(); });
  const loading = admitSourceRuntimeReload({ stackBaseDir: graph.stackBaseDir,
    components: { daemon: graph.daemon }, pending: graph.pending });
  void loading.catch(() => {});
  let replacement;
  try {
    await Promise.race([entered, loading.then(() => { throw new Error('loader exited before interruption'); })]);
    replacement = await beginPendingSourceStart({ stackBaseDir: graph.stackBaseDir });
    await assert.rejects(loading, { code: 'ESOURCESTARTSUPERSEDED' });
    assert.deepEqual(JSON.parse(await readFile(graph.selectedPath, 'utf8')), graph.old);
    assert.deepEqual(JSON.parse(await readFile(graph.runtimePath, 'utf8')), graph.runtime);
  } finally {
    observer.close();
    await replacement?.dispose();
  }
});

async function reloadServerGraph(graph, source) {
  const outputDir = graph.fixture.path('server-candidate');
  const runtimeDir = join(outputDir, 'apps/server');
  await mkdir(join(runtimeDir, 'sources'), { recursive: true });
  const server = { identity: 'server-candidate', runtimeDir, serverDir: runtimeDir,
    entrypoint: join(runtimeDir, 'sources/main.mjs'), dbProvider: 'sqlite', env: { HAPPIER_DB_PROVIDER: 'sqlite' },
    migration: { mode: 'disabled' } };
  await writeFile(server.entrypoint, source);
  await writeFile(join(outputDir, 'source-bundle.json'), JSON.stringify(server));
  return server;
}

const reloadHttpServerSource = `
  import {createServer} from 'node:http';
  import {readFile, mkdir, writeFile} from 'node:fs/promises';
  import {dirname, join} from 'node:path';
  import {fileURLToPath} from 'node:url';
  const database = fileURLToPath(process.env.DATABASE_URL);
  await mkdir(dirname(database), {recursive:true});
  await writeFile(database, 'scratch-only');
  createServer(async (request, response) => {
    if (request.url === '/health') {
      response.setHeader('content-type','application/json');
      response.end(JSON.stringify({status:'ok',service:'happier-server'}));
      return;
    }
    try {
      const asset = request.url === '/' ? 'index.html' : 'entry.js';
      response.setHeader('content-type', asset.endsWith('.js') ? 'text/javascript' : 'text/html');
      response.end(await readFile(join(process.env.HAPPIER_SERVER_UI_DIR,asset)));
    } catch { response.statusCode=404; response.end(); }
  }).listen(Number(process.env.PORT),process.env.HOST);
`;

test('source reload validates replacement health on scratch data while preserving incumbent data and loaded state', async t => {
  const graph = await reloadFixtureGraph(t, 'export {};');
  const server = await reloadServerGraph(graph, reloadHttpServerSource);
  const incumbent = graph.fixture.path('incumbent.sqlite');
  await writeFile(incumbent, 'retained-incumbent-data');
  const childProcess = (await import('node:child_process')).default;
  const queueRefusal = Object.assign(new Error('fixture validation queue is saturated'), { code: 'EFIXTUREADMISSION' });
  let admissionRequests = 0;
  // Process launch is the system boundary: retain the real smoke child,
  // server boot and health read, but make validation admission unavailable.
  for (const method of ['spawn', 'fork']) {
    const original = childProcess[method];
    t.mock.method(childProcess, method, (command, args, options) => {
      if (args.some(argument => argument.includes('--heavyweight-admission'))) {
        admissionRequests += 1;
        throw queueRefusal;
      }
      return original(command, args, options);
    });
  }
  syncBuiltinESMExports();
  let admitted;
  try {
    const repoDir = fileURLToPath(new URL('../../../../', import.meta.url));
    await assert.rejects(runSourceBuildCommand({ repoDir, command: process.execPath, args: ['-e', ''],
      env: { ...process.env, HAPPIER_WORKSPACE_BUILD_STARTUP: '' }, signal: t.signal }), { code: 'EFIXTUREADMISSION' });
    assert.equal(admissionRequests, 1, 'ordinary lane validation retains its capacity admission');
    admitted = await admitSourceRuntimeReload({ stackBaseDir: graph.stackBaseDir, components: { server, daemon: graph.daemon }, pending: graph.pending,
    env: { ...process.env, HAPPIER_STACK_REPO_DIR: fileURLToPath(new URL('../../../../', import.meta.url)),
      HAPPIER_SERVER_LIGHT_DATA_DIR: graph.fixture.root, DATABASE_URL: pathToFileURL(incumbent).href } });
    assert.equal(admissionRequests, 1, 'replacement service lifecycle adds zero validation admission requests');
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
  assert.equal(await readFile(incumbent, 'utf8'), 'retained-incumbent-data');
  assert.deepEqual(JSON.parse(await readFile(graph.runtimePath, 'utf8')), graph.runtime);
  await admitted.activate();
  assert.deepEqual(JSON.parse(await readFile(join(graph.stackBaseDir, 'source-runtime/selected-server.json'), 'utf8')),
    { entrypoint: server.entrypoint });
});

for (const provider of ['sqlite', 'postgres']) {
test(`source reload rejects a ${provider} replacement server that exits before health without changing the loaded runtime`, async t => {
  const graph = await reloadFixtureGraph(t, 'export {};');
  const server = await reloadServerGraph(graph, 'throw new ReferenceError("reload-server-boot-broken");');
  server.dbProvider = provider;
  server.env.HAPPIER_DB_PROVIDER = provider;
  await assert.rejects(admitSourceRuntimeReload({ stackBaseDir: graph.stackBaseDir, components: { server }, pending: graph.pending,
    env: { ...process.env, HAPPIER_STACK_REPO_DIR: fileURLToPath(new URL('../../../../', import.meta.url)) } }), /reload-server-boot-broken/);
  assert.deepEqual(JSON.parse(await readFile(graph.runtimePath, 'utf8')), graph.runtime);
  await assert.rejects(access(join(graph.stackBaseDir, 'source-runtime/selected-server.json')), { code: 'ENOENT' });
});
}

for (const broken of [false, true]) {
test(`source reload browser boot ${broken ? 'rejects entry exceptions' : 'admits rendered entry content'}`, async t => {
  if (spawnSync('agent-browser', ['--version'], { encoding: 'utf8' }).status !== 0) {
    t.skip('AUTO host has no agent-browser; named-Stack browser smoke remains a reload validation prerequisite');
    return;
  }
  const graph = await reloadFixtureGraph(t, 'export {};');
  const server = await reloadServerGraph(graph, reloadHttpServerSource);
  const uiDir = graph.fixture.path('web');
  await mkdir(uiDir);
  await writeFile(join(uiDir, 'index.html'), '<html><body><div id="root"></div><script src="/entry.js"></script></body></html>');
  await writeFile(join(uiDir, 'entry.js'), broken ? 'throw new ReferenceError("reload-web-entry-broken");'
    : 'document.getElementById("root").textContent="Fixture root rendered";');
  const loading = admitSourceRuntimeReload({ stackBaseDir: graph.stackBaseDir, components: { server },
    ui: { uiDir, entrypoint: 'index.html' }, pending: graph.pending,
    env: { ...process.env, HAPPIER_STACK_REPO_DIR: fileURLToPath(new URL('../../../../', import.meta.url)) } });
  if (broken) {
    await assert.rejects(loading, /reload-web-entry-broken/);
    await assert.rejects(access(join(graph.stackBaseDir, 'source-runtime/selected-ui.json')), { code: 'ENOENT' });
  } else {
    const admitted = await loading;
    await admitted.activate();
    assert.deepEqual(JSON.parse(await readFile(join(graph.stackBaseDir, 'source-runtime/selected-ui.json'), 'utf8')),
      { uiDir, entrypoint: 'index.html' });
  }
  assert.deepEqual(JSON.parse(await readFile(graph.runtimePath, 'utf8')), graph.runtime);
});
}

async function installSourceAdmissionFixture(root) {
  const native = await installNativeAdmissionFixture({root});
  const adapterSource = new URL('../utils/proc/runSourceBuildCommand.mjs',import.meta.url);
  const adapter = join(root,'native-owner/apps/stack/scripts/utils/proc/runSourceBuildCommand.mjs');
  await writeFile(adapter,(await readFile(adapterSource,'utf8')).replace(
    "from '../dev/devReloadCoordinator.mjs'",`from ${JSON.stringify(new URL('../dev/devReloadCoordinator.mjs',adapterSource).href)}`));
  const runtimeSource = new URL('./build_source_runtime.mjs',import.meta.url);
  const runtimePath = join(root,'native-owner/apps/stack/scripts/build/build_source_runtime.mjs');
  await mkdir(dirname(runtimePath),{recursive:true});
  // Install the genuine owner beside the fixture's genuine native launcher.
  // Remap imports only, preserving real selection/build/retention decisions.
  await writeFile(runtimePath,(await readFile(runtimeSource,'utf8')).replace(/^((?:import|export) [^\n]*from )'(\.[^']+)'/gm,(match,prefix,path)=> {
    if(path==='../utils/proc/runSourceBuildCommand.mjs' || path==='../utils/proc/workspace_build_admission.mjs') return match;
    return `${prefix}${JSON.stringify(new URL(path,runtimeSource).href)}`;
  }));
  const {buildSourceRuntimeBundle:build} = await import(pathToFileURL(runtimePath));
  const {runSourceBuildCommand:runSourceCommand} = await import(pathToFileURL(adapter));
  await mkdir(join(root,'bin'));
  await writeFile(join(root,'bin/awk'),`#!/bin/sh\ncase "$*" in\n  */proc/meminfo*) printf '16777216 16777216\\n' ;;\n  */proc/loadavg*|*/proc/pressure/*) printf '0\\n' ;;\n  *) exec /usr/bin/awk "$@" ;;\nesac\n`);
  await chmod(join(root,'bin/awk'),0o755);
  const env = {...buildNativeAdmissionFixtureEnv(),PATH:`${join(root,'bin')}:/usr/bin:/bin`,HAPPIER_DEV_TARGET_EXECUTION:'1'};
  return {...native,runtimePath,build,runSourceCommand,env};
}

test('source daemon stages current native custody source instead of borrowing stale checkout tools', async context => {
  const fixture = await createTempFixture(context, { prefix: 'happier-source-native-custody-' });
  const repoDir = fixture.path('repo');
  const canonicalRepo = fileURLToPath(new URL('../../../../', import.meta.url));
  const cliDir = join(repoDir, 'apps/cli');
  await mkdir(join(cliDir, 'src'), { recursive: true });
  await mkdir(join(cliDir, 'tools/unpacked'), { recursive: true });
  await writeFile(join(cliDir, 'package.json'), JSON.stringify({ name: '@happier-dev/cli', type: 'module', exports: {} }));
  await writeFile(join(cliDir, 'tsconfig.json'), '{}');
  await writeFile(join(cliDir, 'src/index.ts'), 'export const ready = true;');
  for (const name of ['packages', 'node_modules']) await symlink(join(canonicalRepo, name), join(repoDir, name), process.platform === 'win32' ? 'junction' : 'dir');
  await cp(join(canonicalRepo, 'apps/cli/native/processcustody'), join(cliDir, 'native/processcustody'), { recursive: true });
  await installSourcePreparationInputs(repoDir, 'daemon');
  const name = `happier-process-custody${process.platform === 'win32' ? '.exe' : ''}`;
  const stale = join(cliDir, 'tools/unpacked', name);
  await writeFile(stale, 'stale helper lacking disk-measure');
  const built = await buildSourceRuntimeBundle({ repoDir, outputDir: fixture.path('runtime'), component: 'daemon' });
  const helper = join(built.runtimeDir, 'tools/unpacked', name);
  assert.notEqual(await realpath(helper), await realpath(stale));
  const stdout = await new Promise((resolve, reject) => {
    const child = execFile(helper, ['disk-measure'], (error, stdout) => error ? reject(error) : resolve(stdout));
    child.stdin.end(JSON.stringify({ paths: [] }));
  });
  const measured = JSON.parse(stdout);
  assert.equal(measured.v, 1);
  assert.deepEqual(measured.perPath, []);
  assert.equal(await readFile(stale, 'utf8'), 'stale helper lacking disk-measure');
});

test('source daemon stages its bundled CPX executable from captured current source without installed tools', async context => {
  const fixture = await createTempFixture(context, { prefix: 'happier-source-cpx-', registerCleanup: false });
  context.after(async () => { await setBundleReadOnly(fixture.root, false); await fixture.cleanup(); });
  const repoDir = await createReloadDaemonRepo(fixture, 'export const ready = true;');
  const canonicalRepo = fileURLToPath(new URL('../../../../', import.meta.url));
  const cliDir = join(repoDir, 'apps/cli');
  const pluginDir = join(repoDir, 'packages/plugins/cliproxyapi');
  const nativeDir = join(pluginDir, 'managed-runtime');
  const managedBuildScript = JSON.parse(await readFile(join(canonicalRepo, 'packages/plugins/cliproxyapi/package.json'), 'utf8'))
    .scripts['managed-runtime:build'];
  await writeFile(join(repoDir, 'package.json'), JSON.stringify({ private: true, workspaces: ['apps/*', 'packages/*', 'packages/plugins/*'] }));
  await writeFile(join(repoDir, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n  - packages/*\n  - packages/plugins/*\n');
  await symlink(join(canonicalRepo, 'node_modules'), join(repoDir, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const commonRoot = join(canonicalRepo, 'packages/cli-common');
  await captureBuildInputFiles({ sourceDir: commonRoot, captureDir: join(repoDir, 'packages/cli-common'),
    readPaths: () => readWorkspaceBuildInputs(commonRoot) });
  await mkdir(join(pluginDir, 'src'), { recursive: true });
  await mkdir(join(nativeDir, 'cmd/happier-cliproxyapi-managed'), { recursive: true });
  await mkdir(join(nativeDir, 'tools/build'), { recursive: true });
  await mkdir(join(nativeDir, 'licenses'), { recursive: true });
  await writeFile(join(cliDir, 'package.json'), JSON.stringify({ name: '@happier-dev/cli', type: 'module', exports: {},
    bundledDependencies: ['@happier-dev/plugins-cliproxyapi'] }));
  await writeFile(join(pluginDir, 'package.json'), JSON.stringify({ name: '@happier-dev/plugins-cliproxyapi', version: '0.0.0',
    type: 'module', exports: { '.': { 'happier-source': './src/index.ts', default: './dist/index.js' } },
    scripts: { 'managed-runtime:build': managedBuildScript } }));
  await writeFile(join(pluginDir, 'src/index.ts'), 'export function activate() {}');
  await writeFile(join(pluginDir, 'src/manifest.ts'), 'export const PLUGIN_MANIFEST = {};');
  await mkdir(join(cliDir, 'src/plugins/projection/registry/sources'), { recursive: true });
  await writeFile(join(cliDir, 'src/plugins/projection/registry/sources/generatedBundledPluginManifests.ts'),
    `export const BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS=${JSON.stringify([{ daemonEntryPath: './dist/index.js',
      sourceSpec: { locator: '@happier-dev/plugins-cliproxyapi' }, manifest: { id: 'happier.provider.cliproxyapi', runtime: { apiVersion: 1 }, entrypoints: { daemon: './dist/index.js' } } }])};`);
  // Native compilation is the real OS boundary. This fixture's tiny module
  // follows the package build CLI while keeping upstream network/servers out.
  await writeFile(join(nativeDir, 'go.mod'), 'module fixture\n\ngo 1.20\n');
  await writeFile(join(nativeDir, 'go.sum'), '');
  await writeFile(join(nativeDir, 'licenses/CLIProxyAPI-LICENSE'), 'fixture license');
  await writeFile(join(nativeDir, 'licenses/THIRD-PARTY-NOTICES'), 'fixture notices');
  await writeFile(join(nativeDir, 'tools/build/main.go'), `package main
import ("flag"; "os"; "os/exec"; "strings")
func main() { target:=flag.String("target","",""); output:=flag.String("output","",""); flag.Parse(); parts:=strings.Split(*target,"-"); command:=exec.Command("go","build","-trimpath","-buildvcs=false","-o",*output,"./cmd/happier-cliproxyapi-managed"); command.Env=append(os.Environ(),"CGO_ENABLED=0","GOOS="+parts[0],"GOARCH="+parts[1]); command.Stdout=os.Stdout; command.Stderr=os.Stderr; if err:=command.Run();err!=nil { panic(err) } }
`);
  const entry = join(nativeDir, 'cmd/happier-cliproxyapi-managed/main.go');
  const writeVersion = version => writeFile(entry, `package main\nimport "fmt"\nfunc main() { fmt.Print(${JSON.stringify(version)}) }\n`);
  await writeVersion('current-source-v1');
  const native = process.platform === 'linux' ? await installSourceAdmissionFixture(fixture.root) : null;
  const build = native?.build ?? buildSourceRuntimeBundle;
  const options = { repoDir, stackBaseDir: fixture.path('stacks/consumer'), component: 'daemon',
    env: native ? { ...native.env, PATH: `${native.env.PATH}:${process.env.PATH}` } : process.env };
  const first = await build(options);
  const executable = join(first.runtimeDir, 'tools/unpacked', `happier-cliproxyapi-managed${process.platform === 'win32' ? '.exe' : ''}`);
  const { stdout } = await promisify(execFile)(executable, []);
  assert.equal(stdout, 'current-source-v1');
  const consumingRoot = fixture.path('consumer/apps/cli');
  const resolverPath = join(consumingRoot, 'src/chunks/source-executable-resolver.mjs');
  const consumedExecutable = join(consumingRoot, 'tools/unpacked', basename(executable));
  await mkdir(dirname(consumedExecutable), { recursive: true });
  await cp(executable, consumedExecutable);
  await writeFile(join(consumingRoot, 'package.json'), JSON.stringify({ name: '@happier-dev/cli', type: 'module' }));
  await createRequire(import.meta.url)('esbuild').build({
    entryPoints: [join(canonicalRepo, 'apps/cli/src/providers/lifecycle/resolveManagedProviderRuntimeLaunch.ts')],
    outfile: resolverPath, bundle: true, platform: 'node', format: 'esm', conditions: ['happier-source'],
    tsconfig: join(canonicalRepo, 'apps/cli/tsconfig.runtime.json'), logLevel: 'silent',
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  });
  const previousRoot = process.env.HAPPIER_STACK_CLI_ROOT_DIR;
  try {
    process.env.HAPPIER_STACK_CLI_ROOT_DIR = consumingRoot;
    const { resolveManagedProviderRuntimeExecutable } = await import(pathToFileURL(resolverPath));
    assert.equal(await resolveManagedProviderRuntimeExecutable({ kind: 'packaged-runtime-binary',
      directorySegments: ['tools', 'unpacked'], executableBaseName: 'happier-cliproxyapi-managed' }), await realpath(consumedExecutable));
  } finally {
    if (previousRoot === undefined) delete process.env.HAPPIER_STACK_CLI_ROOT_DIR;
    else process.env.HAPPIER_STACK_CLI_ROOT_DIR = previousRoot;
  }
  const firstRecord = JSON.parse(await readFile(join(first.runtimeDir, '../../source-bundle.json'), 'utf8'));
  for (const path of ['go.mod', 'go.sum', 'tools/build/main.go', 'cmd/happier-cliproxyapi-managed/main.go', 'licenses/CLIProxyAPI-LICENSE', 'licenses/THIRD-PARTY-NOTICES']) {
    assert.match(firstRecord.sourceInputDigests[`packages/plugins/cliproxyapi/managed-runtime/${path}`] ?? '', /^[a-f0-9]{64}$/);
  }
  await assert.rejects(access(join(cliDir, 'tools/unpacked/happier-cliproxyapi-managed')), { code: 'ENOENT' });
  assert.equal((await build(options)).entrypoint, first.entrypoint, 'unchanged current native inputs reuse their source graph');
  await writeVersion('current-source-v2');
  const second = await build(options);
  assert.notEqual(first.entrypoint, second.entrypoint, 'native source edits invalidate the retained runtime');
  assert.notEqual(first.identity, second.identity);
  assert.equal((await promisify(execFile)(join(second.runtimeDir, 'tools/unpacked', basename(executable)), [])).stdout, 'current-source-v2');
});

test('shared source daemon preparation rejoins joint admission after a queued launcher cutover',
  { skip: process.platform !== 'linux' }, async context => {
  const fixture = await createTempFixture(context, { prefix: 'happier-source-native-admission-', registerCleanup: false });
  context.after(async () => { await makeFixtureWritable(fixture.root); await rm(fixture.root, { recursive: true, force: true }); });
  const native = await installSourceAdmissionFixture(fixture.root);
  const repoDir = fixture.path('repo');
  const canonicalRepo = fileURLToPath(new URL('../../../../', import.meta.url));
  const cliDir = join(repoDir, 'apps/cli');
  await mkdir(join(cliDir, 'src'), { recursive: true });
  await writeFile(join(cliDir, 'package.json'), JSON.stringify({ name: '@happier-dev/cli', type: 'module', exports: {} }));
  await writeFile(join(cliDir, 'tsconfig.json'), '{}');
  await writeFile(join(cliDir, 'src/index.ts'), 'export const ready = true;');
  await writeFile(join(repoDir, 'pnpm-lock.yaml'), '');
  await writeFile(join(repoDir, 'pnpm-workspace.yaml'), 'packages: []\n');
  for (const name of ['packages', 'node_modules']) await symlink(join(canonicalRepo, name), join(repoDir, name), 'dir');
  await cp(join(canonicalRepo, 'apps/cli/native/processcustody'), join(cliDir, 'native/processcustody'), { recursive: true });
  await installSourcePreparationInputs(repoDir, 'daemon');
  // Warm reuse requires unchanged authored inputs. Keep installed tools shared,
  // but own package sources so unrelated lanes cannot invalidate this fixture.
  const inputsDir = fixture.path('captured-inputs');
  await captureSourceWebBuildInputs({ repoDir, outputDir: inputsDir, component: 'daemon' });
  await rm(join(repoDir, 'packages'));
  await symlink(join(inputsDir, 'packages'), join(repoDir, 'packages'), 'dir');
  const env = { ...native.env, PATH: `${native.env.PATH}:${process.env.PATH}` };
  const statePath = fixture.path('native-owner/apps/stack/scripts/utils/proc/native_host_admission_state.sh');
  const currentState = await readFile(statePath, 'utf8');
  const legacyRoot = fixture.path('legacy-admission');
  await writeFile(statePath, currentState.replace(native.admissionRoot, legacyRoot));
  const available = fixture.path('available-memory');
  const observed = fixture.path('memory-observed');
  await writeFile(available, '5242880');
  await writeFile(fixture.path('bin/awk'), `#!/bin/sh
case "$*" in
  */proc/meminfo*)
    available=$(/bin/cat '${available}')
    printf '%s 16777216\\n' "$available"
    [ "$available" -ne 5242880 ] || printf observed > '${observed}'
    ;;
  */proc/loadavg*|*/proc/pressure/*) printf '0\\n' ;;
  *) exec /usr/bin/awk "$@" ;;
esac
`);
  const watcher = watch(fixture.root);
  context.after(() => watcher.close());
  const pressure = new Promise((resolve, reject) => {
    watcher.on('error', reject);
    watcher.on('change', (_event, name) => { if (name === 'memory-observed') { watcher.close(); resolve(); } });
  });
  await mkdir(native.admissionRoot, { recursive: true });
  const mutex = spawn('flock', [join(native.admissionRoot, 'lock'), process.execPath, '-e',
    'process.stdout.write("locked\\n"); process.stdin.resume();'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const mutexClosed = new Promise(resolve => mutex.once('close', resolve));
  context.after(async () => { mutex.stdin.end(); await mutexClosed; });
  await new Promise((resolve, reject) => { mutex.stdout.once('data', resolve); mutex.once('error', reject); });
  let diagnostic = '';
  const stderrWrite = process.stderr.write;
  process.stderr.write = function(chunk, ...args) {
    diagnostic += String(chunk);
    if (diagnostic.includes('HSTACK_WORKSPACE_ADMISSION_ORDER:')) mutex.stdin.end();
    return stderrWrite.call(this, chunk, ...args);
  };
  context.after(() => { process.stderr.write = stderrWrite; });
  const pending = native.build({ repoDir, stackBaseDir: fixture.path('stacks/consumer'), component: 'daemon', env, signal: context.signal });
  const completion = pending.then(built => ({ built }), error => ({ error }));
  await pressure;
  // The parent has parsed the old root while queued; its newly launched
  // preparation children read the current root and find its mutex occupied.
  await writeFile(`${statePath}.next`, currentState);
  await rename(`${statePath}.next`, statePath);
  await writeFile(available, '16777216');
  const outcome = await completion;
  assert.equal(outcome.error, undefined);
  assert.match(diagnostic, /HSTACK_WORKSPACE_ADMISSION_ORDER:/);
  const built = outcome.built;
  const helper = join(built.runtimeDir, 'tools/unpacked/happier-process-custody');
  const stdout = await new Promise((resolve, reject) => {
    const child = execFile(helper, ['disk-measure'], (error, stdout) => error ? reject(error) : resolve(stdout));
    child.stdin.end(JSON.stringify({ paths: [] }));
  });
  assert.deepEqual(JSON.parse(stdout).perPath, []);
  const reused = await native.build({ repoDir, stackBaseDir: fixture.path('stacks/consumer'), component: 'daemon', env, signal: context.signal });
  assert.equal(reused.entrypoint, built.entrypoint, 'a fresh preparation retains ordinary bundle reuse');
  await writeFile(join(cliDir, 'src/index.ts'), 'export const ready = "requires-build";');
  await writeFile(available, '5242880');
  await withWorkspaceBundleLock(async ({ heldLockValue }) => {
    await assert.rejects(native.build({ repoDir, stackBaseDir: fixture.path('stacks/consumer'), component: 'daemon',
      env: { ...env, HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD: heldLockValue }, signal: context.signal }),
      { code: 1, sourceDrift: false }, 're-invocation cannot bypass a live inherited lease or unavailable admission');
  }, { lockPath: fixture.path('unadmitted.lock') });
  assert.deepEqual(await readdir(join(native.admissionRoot, 'owners')), []);
  assert.deepEqual(await readdir(join(native.admissionRoot, 'waiters')), []);
  assert.deepEqual(await readdir(join(legacyRoot, 'owners')), []);
  assert.deepEqual(await readdir(join(legacyRoot, 'waiters')), []);
});

test('source daemon owns its UI graph and bytes after checkout artifacts change', async context => {
  const { resolveBundledPluginUiArtifactsRetainedRoots } = await import('../../../ui/scripts/generateBundledPluginUiArtifacts.mjs');
  const fixture = await createTempFixture(context, {prefix:'happier-source-ui-custody-', registerCleanup:false});
  let live;
  context.after(async () => {
    if (live && live.exitCode === null) {
      const retired = new Promise(resolve => live.once('exit', resolve));
      live.kill();
      await retired;
    }
    await makeFixtureWritable(fixture.root);
    await rm(fixture.root, {recursive:true,force:true});
  });
  const repoDir = fixture.path('repo');
  const canonicalRepo = fileURLToPath(new URL('../../../../', import.meta.url));
  await captureSourceWebBuildInputs({ repoDir: canonicalRepo, outputDir: repoDir });
  // Characterize the genuine compiler-process boundary: its containing build
  // must forward dependency custody, not queue the child behind its own lock.
  const uiCompiler = join(repoDir, 'apps/ui/scripts/prepareSourcePluginUiArtifacts.mjs');
  const compilerSource = await readFile(uiCompiler, 'utf8');
  await writeFile(uiCompiler, `if (!process.env.HAPPIER_BUILD_DEPENDENCY_CUSTODY) throw new Error('missing-containing-build-dependency-custody');\n${compilerSource}`);
  const cliDir = join(repoDir,'apps/cli');
  const pluginDir = join(repoDir,'packages/plugins/fixture');
  // This fixture replaces the complete plugin census with its UI-only plugin;
  // model successful canonical declaration admission at the process boundary.
  await rm(join(cliDir, 'scripts/build-owned/generateBundledPluginEntries.ts'), {force:true});
  await installSourcePreparationInputs(repoDir, 'daemon');
  await mkdir(join(cliDir,'src/plugins/projection/registry/sources'),{recursive:true});
  await mkdir(join(repoDir,'apps/ui'),{recursive:true});
  await mkdir(join(pluginDir,'src'),{recursive:true});
  await writeFile(join(cliDir,'package.json'),JSON.stringify({name:'@happier-dev/cli',type:'module',exports:{},
    dependencies:{'@happier-dev/plugins-fixture':'0.0.0','@happier-dev/plugin-sdk':'0.0.0'},
    bundledDependencies:['@happier-dev/plugins-fixture']}));
  await writeFile(join(cliDir,'tsconfig.json'),'{}');
  await writeFile(join(cliDir,'src/index.ts'),'export const ready = true; if (process.env.HAPPIER_TEST_RETAIN_SOURCE_UI === "1") { console.log("ready"); setInterval(() => {}, 1000); }');
  const manifest = {schemaVersion:2,id:'happier.fixture',version:'0.0.0',displayName:'Fixture',runtime:{apiVersion:1},hostAccess:{required:[],optional:[]},
    entrypoints:{daemon:'./dist/index.js'},contributes:{ui:{renderers:[{id:'panel',kind:'reactNative',artifact:'panel'}]}}};
  await writeFile(join(pluginDir, 'src/manifest.ts'), `export const PLUGIN_MANIFEST = ${JSON.stringify(manifest)};`);
  await writeFile(join(pluginDir,'package.json'),JSON.stringify({name:'@happier-dev/plugins-fixture',version:'0.0.0',type:'module',exports:{
    '.':{'happier-source':'./src/index.ts',default:'./dist/index.js'},
    './happier-plugin-ui/panel':{'happier-source':'./src/panel.ts',default:'./dist/happier-plugin-ui/react-native/panel/entry.cjs.bundle'},
    './happier-plugin-ui/panel/entry.cjs.bundle':{'happier-source':'./src/panel.ts',default:'./dist/happier-plugin-ui/react-native/panel/entry.cjs.bundle'},
  }}));
  await writeFile(join(pluginDir,'src/index.ts'),'export function activate() {}');
  await mkdir(join(pluginDir, 'src/collections'));
  await writeFile(join(pluginDir, 'src/collections/migrate.ts'), 'export const migrationMarker = "migration-v1";');
  await writeFile(join(pluginDir,'src/panel.ts'),'import {migrationMarker} from "./collections/migrate"; export function renderSurface() { return "retained-source-panel" + migrationMarker; }');
  await writeFile(join(repoDir,'apps/ui/package.json'),JSON.stringify({name:'@happier-dev/app',dependencies:{'@happier-dev/plugins-fixture':'0.0.0'}}));
  await writeFile(join(cliDir,'src/plugins/projection/registry/sources/generatedBundledPluginManifests.ts'),
    `export const BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS=${JSON.stringify([{daemonEntryPath:'./dist/index.js',sourceSpec:{locator:'@happier-dev/plugins-fixture'},manifest}])};`);
  const stackBaseDir = fixture.path('stacks/consumer');
  const runtime = await buildSourceRuntimeBundle({repoDir,stackBaseDir,component:'daemon'});
  live = spawn(process.execPath, [runtime.entrypoint], {
    env: { ...process.env, ...runtime.env, HAPPIER_TEST_RETAIN_SOURCE_UI: '1' }, stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve, reject) => {
    live.once('error', reject);
    live.stdout.once('data', resolve);
    live.once('exit', code => reject(new Error(`source runtime exited before readiness (${code})`)));
  });
  const retainedRoot = join(runtime.runtimeDir,'../../packages/plugins/fixture/dist/happier-plugin-ui');
  const graph = JSON.parse(await readFile(join(retainedRoot,'ui-artifacts.json'),'utf8')).entries[0];
  const retainedBytes = await readFile(join(retainedRoot,graph.entry));
  assert.ok(retainedBytes.includes('retained-source-panel'));
  const retainedPluginUiInventoryPath = join(runtime.runtimeDir, 'plugin-ui-inventory.js');
  assert.ok(existsSync(retainedPluginUiInventoryPath), 'the native graph retains the canonical UI inventory for its next preparation');
  assert.equal(resolveBundledPluginUiArtifactsRetainedRoots(retainedPluginUiInventoryPath).get(manifest.id), retainedRoot);
  await writeFile(join(pluginDir, 'src/panel.ts'), 'import {readFile} from "node:fs/promises"; export function renderSurface() { return readFile("fixture"); }');
  const broken = await buildSourceRuntimeBundle({ repoDir, stackBaseDir, component: 'daemon' });
  const brokenRoot = join(broken.runtimeDir, '../../packages/plugins/fixture/dist/happier-plugin-ui');
  assert.deepEqual(await readFile(join(brokenRoot, graph.entry)), retainedBytes, 'a native UI compiler failure serves the incumbent plugin graph');
  assert.equal(resolveBundledPluginUiArtifactsRetainedRoots(join(broken.runtimeDir, 'plugin-ui-inventory.js')).get(manifest.id), brokenRoot,
    'the next build owns its retained inventory and assets independently of the incumbent');
  assert.equal((await buildSourceRuntimeBundle({ repoDir, stackBaseDir, component: 'daemon' })).entrypoint, broken.entrypoint,
    'unchanged broken source reuses its validated last-green graph');
  await writeFile(join(pluginDir,'src/panel.ts'),'import {migrationMarker} from "./collections/migrate"; export function renderSurface() { return "retained-source-panel" + migrationMarker; }');
  const record = JSON.parse(await readFile(join(runtime.runtimeDir, '../../source-bundle.json'), 'utf8'));
  for (const path of ['packages/plugins/fixture/src/panel.ts', 'packages/plugins/fixture/src/collections/migrate.ts']) {
    assert.match(record.sourceInputDigests[path] ?? '', /^[a-f0-9]{64}$/,
      'separately compiled Plugin UI and migration inputs participate in source reuse');
  }
  assert.equal(retainedBytes.length,graph.files[0].byteSize);
  await mkdir(join(pluginDir,'dist/happier-plugin-ui',dirname(graph.entry)),{recursive:true});
  await writeFile(join(pluginDir,'dist/happier-plugin-ui',graph.entry),'changed checkout artifact');
  assert.deepEqual(await readFile(join(retainedRoot,graph.entry)),retainedBytes);
  assert.deepEqual(JSON.parse(await readFile(join(retainedRoot,'ui-artifacts.json'),'utf8')).entries[0],graph);

  // The plugin's daemon module did not change. UI-only changes must still
  // select different emitted code, while the incumbent's bytes remain intact.
  await writeFile(join(pluginDir,'src/panel.ts'),'export function renderSurface() { return "new-source-panel"; }');
  const newer = await buildSourceRuntimeBundle({repoDir,stackBaseDir,component:'daemon'});
  const newerRoot = join(newer.runtimeDir,'../../packages/plugins/fixture/dist/happier-plugin-ui');
  const newerGraph = JSON.parse(await readFile(join(newerRoot,'ui-artifacts.json'),'utf8')).entries[0];
  assert.notEqual(newer.identity,runtime.identity);
  assert.notEqual(newerGraph.digest,graph.digest);
  assert.ok((await readFile(join(newerRoot,newerGraph.entry))).includes('new-source-panel'));
  assert.deepEqual(await readFile(join(retainedRoot,graph.entry)),retainedBytes);

});

test('source snapshot startup stays pending on a missing source import and rebuilds after its creation', { timeout: 30000 }, async context => {
  const fixture = await createTempFixture(context, {prefix:'happier-source-start-drift-', registerCleanup:false});
  context.after(async () => {
    await makeFixtureWritable(fixture.root);
    await rm(fixture.root, {recursive:true, force:true});
  });
  const repoDir = fixture.path('repo');
  const serverDir = join(repoDir, 'apps/server');
  await mkdir(join(serverDir, 'sources'), {recursive:true});
  await mkdir(join(serverDir, 'scripts'));
  await mkdir(join(serverDir, 'node_modules'));
  await writeFile(join(serverDir, 'package.json'), JSON.stringify({name:'@happier-dev/server',type:'module'}));
  await writeFile(join(serverDir, 'tsconfig.json'), '{}');
  await writeFile(join(serverDir, 'sources/main.ts'), 'export {value} from "./createdLater";');
  await writeFile(join(serverDir, 'scripts/migrate.full.deploy.ts'), 'export const migrate = true;');
  await symlink(dirname(createRequire(import.meta.url).resolve('esbuild/package.json')), join(serverDir, 'node_modules/esbuild'),
    process.platform === 'win32' ? 'junction' : 'dir');
  const abort = new AbortController();
  context.after(() => abort.abort());
  let reportDrift;
  const reported = new Promise(resolve => { reportDrift = resolve; });
  let failures = 0;
  const stackBaseDir = fixture.path('stacks/lane');
  await installSourcePreparationInputs(repoDir, 'server');
  const native = process.platform === 'linux' ? await installSourceAdmissionFixture(fixture.root) : null;
  const options = {repoDir, stackBaseDir, component:'server', serverComponent:'happier-server', dbProvider:'postgres',
    signal:abort.signal, ...(native ? {env:native.env} : {}), logger:{log() {}, warn() {}, error(message) {
      if (message.includes('will retry when affected inputs change')) { failures++; reportDrift(); }
    }}};
  const pending = (native?.build ?? buildSourceRuntimeBundle)(options);
  const completion = pending.then(built => ({built}), error => ({error}));
  context.after(async () => { abort.abort(); await completion; });
  assert.equal(await Promise.race([reported.then(() => 'waiting'), completion.then(() => 'exited')]), 'waiting',
    'a missing authored import must leave source startup pending');
  await assert.rejects(access(join(stackBaseDir, 'source-runtime/selected-server.json')), {code:'ENOENT'});
  await writeFile(fixture.path('unrelated.ts'), 'export const unrelated = true;');
  await new Promise(resolve => setTimeout(resolve, 600));
  assert.equal(failures, 1, 'unrelated edits must not rebuild the source snapshot');
  await writeFile(join(serverDir, 'sources/createdLater.ts'), 'export const value = "recovered";');
  const {built, error} = await completion;
  assert.equal(error, undefined);
  assert.equal((await import(pathToFileURL(built.entrypoint))).value, 'recovered');
  assert.equal(JSON.parse(await readFile(join(stackBaseDir, 'source-runtime/selected-server.json'), 'utf8')).entrypoint,
    built.entrypoint);
  await assert.rejects((native?.build ?? buildSourceRuntimeBundle)({...options, dbProvider:'invalid'}), /Source preparation failed \(exit 1\)/,
    'configuration errors must still fail fast');

  // Simulate only Metro's external process boundary, including its real numeric
  // exit/diagnostic shape. Its wait and input observation use the same owner.
  const uiDir = join(repoDir, 'apps/ui');
  await mkdir(join(uiDir, 'sources'), {recursive:true});
  await mkdir(join(uiDir, 'assets'));
  await mkdir(join(uiDir, 'public'));
  await writeFile(join(uiDir, 'package.json'), JSON.stringify({name:'@happier-dev/ui'}));
  const metro = fixture.path('metro.mjs');
  const hero = join(uiDir, 'sources/HomeHero.tsx');
  await writeFile(metro, `import {existsSync} from 'node:fs';
    if (!existsSync(${JSON.stringify(hero)})) { console.error('Unable to resolve module ./HomeHero from HomeHub.tsx'); process.exit(1); }
    console.log('exported');`);
  let reportMetro;
  const metroWaiting = new Promise(resolve => { reportMetro = resolve; });
  const webOptions = {repoDir, target:'expo', signal:abort.signal,
    logger:{log() {}, warn() {}, error() { reportMetro(); }},
    prepare: () => (native?.runSourceCommand ?? runSourceBuildCommand)({repoDir, scriptPath:metro, signal:abort.signal,
      ...(native ? {env:native.env} : {})})};
  const web = prepareSourceComponent(webOptions);
  const webCompletion = web.then(value => ({value}), error => ({error}));
  context.after(async () => { abort.abort(); await webCompletion; });
  assert.equal(await Promise.race([metroWaiting.then(() => 'waiting'), webCompletion.then(() => 'exited')]), 'waiting');
  await writeFile(hero, 'export const HomeHero = true;');
  assert.deepEqual(await webCompletion, {value:'exported\n'});
  await writeFile(metro, 'console.error("Missing credentials"); process.exit(1);');
  await assert.rejects(prepareSourceComponent(webOptions), /Source preparation failed \(exit 1\)/);
  await writeFile(metro, 'console.error("Unable to resolve module @/components/missing from Sidebar.tsx"); process.exit(1);');
  const cancellation = new AbortController();
  const waitingOnCancel = new Promise(resolve => { reportMetro = resolve; });
  const cancelled = prepareSourceComponent({...webOptions, signal:cancellation.signal});
  const rejection = assert.rejects(cancelled, {name:'AbortError'});
  await waitingOnCancel;
  cancellation.abort();
  await rejection;
});

test('native author input versions accept settled text and refuse changed bytes', async context => {
  const fixture = await createTempFixture(context, {prefix:'happier-native-author-input-'});
  const texts = ['export const marker = "ascii";\n', 'export const marker = "雪😀";\n',
    '\uFEFFexport const marker = "BOM";\r\n',
    await readFile(fileURLToPath(new URL('../../../../packages/plugin-sdk/src/index.ts', import.meta.url)), 'utf8')];
  await mkdir(fixture.path('src'));
  for (const [index, text] of texts.entries()) await writeFile(fixture.path(`src/vector${index}.ts`), text);
  const project = fixture.path('tsconfig.json');
  await writeFile(project, JSON.stringify({compilerOptions:{target:'ES2022',module:'NodeNext',moduleResolution:'NodeNext',
    incremental:true,noResolve:true,noCheck:true,declaration:true,rootDir:'src',outDir:'emitted',
    tsBuildInfoFile:'build.tsbuildinfo'},include:['src/*.ts']}));
  const args = ['-p',project];
  const invocation = resolveTypeScriptCliInvocation({args,admissionClass:'source-bundle'});
  await promisify(execFile)(invocation.command, [...invocation.argsPrefix,...args]);
  const info = JSON.parse(await readFile(fixture.path('build.tsbuildinfo'), 'utf8'));
  for (const [index,text] of texts.entries()) {
    const sourceIndex = info.fileNames.findIndex(path => path.endsWith(`/src/vector${index}.ts`));
    assert.notEqual(sourceIndex, -1);
    const fileInfo = info.fileInfos[sourceIndex];
    const version = typeof fileInfo === 'string' ? fileInfo : fileInfo.version;
    assert.equal(await matchesNativeTypeScriptInputVersion(Buffer.from(text), version), true);
    assert.equal(await matchesNativeTypeScriptInputVersion(Buffer.from(`${text}\n// changed`), version), false,
      'a graph consumed from different bytes must not be reused under restored source');
  }
});

test('source daemon owns a usable public author SDK closure without workspace dist', async context => {
  const fixture = await createTempFixture(context, {prefix:'happier-source-author-sdk-', registerCleanup:false});
  context.after(async () => {
    await makeFixtureWritable(fixture.root);
    await rm(fixture.root, {recursive:true, force:true});
  });
  const repoDir = fixture.path('repo');
  const cliDir = join(repoDir, 'apps/cli');
  const sdkDir = join(repoDir, 'packages/plugin-sdk');
  const protocolDir = join(repoDir, 'packages/protocol');
  for (const directory of [join(cliDir, 'src'), join(cliDir, 'node_modules'), join(sdkDir, 'src'),
    join(protocolDir, 'src'), join(repoDir, 'node_modules/@happier-dev')]) {
    await mkdir(directory, {recursive:true});
  }
  await writeFile(join(cliDir, 'package.json'), JSON.stringify({name:'@happier-dev/cli', type:'module',
    dependencies:{'@happier-dev/plugin-sdk':'0.0.0'},
    bundledDependencies:['@happier-dev/plugin-sdk','@happier-dev/protocol'], exports:{}}));
  await writeFile(join(cliDir, 'tsconfig.json'), '{}');
  await writeFile(join(cliDir, 'src/index.ts'), 'export const ready = true;');
  for (const [name, directory] of [['plugin-sdk', sdkDir], ['protocol', protocolDir]]) {
    await writeFile(join(directory, 'package.json'), JSON.stringify({name:`@happier-dev/${name}`,version:'0.0.0',type:'module',
      main:'./dist/index.js',types:'./dist/index.d.ts',
      files:['dist','README.md','native'],
      exports:{'.':{'happier-source':'./src/index.ts',types:'./dist/index.d.ts',default:'./dist/index.js'}},
      ...(name === 'plugin-sdk' ? {happier:{publicSdkRelease:{posture:'developer_preview'}},
        imports:{'#author-value':{'happier-source':'./src/authorValue.ts',default:'./dist/authorValue.js'}},
        dependencies:{'@happier-dev/protocol':'0.0.0','author-external':'1.0.0'},bundledDependencies:['@happier-dev/protocol']} : {})}));
    await writeFile(join(directory, 'tsconfig.json'), JSON.stringify({compilerOptions:{target:'ES2022',
      module:'NodeNext',moduleResolution:'NodeNext',rootDir:'src',outDir:'dist',declaration:true,
      ...(name === 'plugin-sdk' ? {paths:{'#author-value':['./src/authorValue.ts']}} : {})},include:['src/**/*.ts']}));
    await symlink(directory, join(repoDir, 'node_modules/@happier-dev', name), process.platform === 'win32' ? 'junction' : 'dir');
    await writeFile(join(directory, 'README.md'), `${name} authored package documentation`);
    await mkdir(join(directory, 'native'));
    await writeFile(join(directory, 'native/resource.bin'), new Uint8Array([0, 255, 17]));
  }
  await writeFile(join(protocolDir, 'src/index.ts'), 'export const marker = "current-source";');
  await mkdir(join(protocolDir, 'dist'));
  await writeFile(join(protocolDir, 'dist/index.js'), 'export const marker = "stale-dist";');
  await writeFile(join(protocolDir, 'dist/index.d.ts'), 'export declare const marker: "stale-dist";');
  const shadowProtocolDir = join(sdkDir, 'node_modules/@happier-dev/protocol');
  await mkdir(join(shadowProtocolDir, 'src'), {recursive:true});
  await cp(join(protocolDir, 'package.json'), join(shadowProtocolDir, 'package.json'));
  await writeFile(join(shadowProtocolDir, 'src/index.ts'), 'export const marker = "stale-installed-source";');
  // A third-party package may legitimately own dist declarations beneath a
  // workspace's node_modules. These are compiler inputs, not first-party code.
  const externalDir = join(sdkDir, 'node_modules/author-external');
  await mkdir(join(externalDir, 'dist'), {recursive:true});
  await writeFile(join(externalDir, 'package.json'), JSON.stringify({name:'author-external',version:'1.0.0',
    type:'module',types:'./dist/index.d.ts'}));
  await writeFile(join(externalDir, 'dist/index.d.ts'), 'export declare function createAuthorValue(value: string): { value: string };');
  await writeFile(join(externalDir, 'dist/index.js'), 'export function createAuthorValue(value) { return {value}; }');
  await writeFile(join(externalDir, 'package.json'), JSON.stringify({name:'author-external',version:'1.0.0',
    type:'module',main:'./dist/index.js',types:'./dist/index.d.ts'}));
  await writeFile(join(sdkDir, 'src/authorValue.ts'), 'export const authorValue = "package-alias";');
  await writeFile(join(sdkDir, 'src/index.ts'), "/// <reference path='../node_modules/author-external/dist/index.d.ts' />\nimport {marker} from '@happier-dev/protocol';\nexport {marker};\nexport const canonicalMarker = marker;\nimport {authorValue} from '#author-value';\nexport const canonicalAlias = authorValue;\nimport {createAuthorValue} from 'author-external';\nexport function echo(value: string) { return createAuthorValue(value).value; }\n");
  await symlink(dirname(createRequire(import.meta.url).resolve('esbuild/package.json')), join(cliDir, 'node_modules/esbuild'),
    process.platform === 'win32' ? 'junction' : 'dir');
  const compilerCommands = fixture.path('author-compiler-commands.jsonl');
  const compilerObserver = fixture.path('observe-author-compiler.mjs');
  // Observe the real OS launch without replacing compiler or domain logic.
  // Native parallel checkers replicate the declaration graph per host CPU.
  await writeFile(compilerObserver, `
    import {createRequire,syncBuiltinESMExports} from 'node:module';
    import {appendFileSync,readFileSync} from 'node:fs';
    const childProcess=createRequire(import.meta.url)('node:child_process');
    const spawn=childProcess.spawn;
    childProcess.spawn=function(command,args,...options) {
      const child=spawn.call(this,command,args,...options);
      if (args?.includes('--noCheck') && args.some(arg=>arg.endsWith('tsconfig.dist.json')))
        child.once('exit',code=>{
          if (code !== 0) return;
          const info=JSON.parse(readFileSync(args[args.indexOf('--tsBuildInfoFile')+1],'utf8'));
          appendFileSync(${JSON.stringify(compilerCommands)},JSON.stringify({args,files:info.fileNames})+'\\n');
        });
      return child;
    };
    syncBuiltinESMExports();
  `);
  const env = {...process.env,
    NODE_OPTIONS:`${process.env.NODE_OPTIONS ?? ''} --import=${pathToFileURL(compilerObserver).href}`.trim()};
  const stackBaseDir = fixture.path('stacks/author');
  await installSourcePreparationInputs(repoDir, 'daemon');
  const runtime = await buildSourceRuntimeBundle({repoDir, stackBaseDir, component:'daemon', env});
  const authorCommands = (await readFile(compilerCommands, 'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  assert.ok(authorCommands.length > 0, 'the real public author compiler was observed');
  for (const {args} of authorCommands) assert.ok(args.includes('--singleThreaded'),
    'author declaration emission must not replicate its checker graph with host CPU count');
  const sdkCompiler = authorCommands.find(({args})=>args.some(arg=>arg.replaceAll('\\','/').includes('/plugin-sdk/tsconfig.dist.json')));
  assert.ok(sdkCompiler, 'the SDK declaration compiler was observed');
  assert.equal(sdkCompiler.files.some(path=>path.replaceAll('\\','/').endsWith('/protocol/src/index.ts')), false,
    'dependent author packages must consume the already emitted current-source declaration, not re-emit its source');
  const record = JSON.parse(await readFile(join(runtime.runtimeDir, '../../source-bundle.json'), 'utf8'));
  const sdkInput = Object.entries(record.sourceInputDigests).find(([path]) => path.endsWith('packages/plugin-sdk/src/index.ts'));
  assert.match(sdkInput?.[1], /^[a-f0-9]{64}$/,
    'settled compiler source bytes must remain eligible for normal source-bundle reuse');
  assert.equal(Object.keys(record.sourceInputDigests).some(path => path.includes('node_modules/@happier-dev/protocol/')), false,
    'author declarations must resolve canonical workspace source rather than a stale installed shadow');
  const warm = await buildSourceRuntimeBundle({repoDir, stackBaseDir, component:'daemon'});
  assert.equal(warm.entrypoint, runtime.entrypoint, 'settled public author closure reuses the existing source bundle');
  // The running source CLI must serve the real public resolver without looking
  // for a repository around the emitted runtime or reopening its moving input.
  const canonicalRepo = fileURLToPath(new URL('../../../../', import.meta.url));
  const resolverUrl = pathToFileURL(join(canonicalRepo, 'apps/cli/src/plugins/authoring/hostSdkResolution.ts')).href;
  const {stdout} = await promisify(execFile)(process.execPath, ['--import',
    pathToFileURL(join(canonicalRepo, 'packages/cli-common/registerSourceRuntime.mjs')).href,
    '--input-type=module', '--eval', `import {resolveHostPluginSdkPackageRoot} from ${JSON.stringify(resolverUrl)};
      console.log(resolveHostPluginSdkPackageRoot({runtimeModuleUrl:${JSON.stringify(pathToFileURL(runtime.entrypoint).href)}}));`],
    {cwd:join(canonicalRepo, 'apps/cli'), env:{...process.env,...runtime.env}});
  const sdkRoot = stdout.trim();
  assert.equal(relative(await realpath(runtime.runtimeDir), sdkRoot).startsWith('..'), false);
  for (const name of ['plugin-sdk', 'protocol']) {
    const emittedPackage = join(runtime.runtimeDir, 'authoring/node_modules/@happier-dev', name);
    assert.equal(await readFile(join(emittedPackage, 'README.md'), 'utf8'), `${name} authored package documentation`);
    assert.deepEqual(new Uint8Array(await readFile(join(emittedPackage, 'native/resource.bin'))), new Uint8Array([0, 255, 17]));
  }
  const declarations = await readFile(join(sdkRoot, 'dist/index.d.ts'), 'utf8');
  assert.match(declarations, /echo\(value: string\): string/);
  assert.match(declarations, /canonicalMarker = "current-source"/);
  assert.match(declarations, /canonicalAlias = "package-alias"/);
  const nestedRuntime = await buildSourceRuntimeBundle({repoDir, outputDir:join(cliDir, '.source-output'), component:'daemon'});
  assert.match(await readFile(join(nestedRuntime.runtimeDir, 'authoring/node_modules/@happier-dev/plugin-sdk/dist/index.d.ts'), 'utf8'),
    /canonicalMarker = "current-source"/, 'private current-build declarations remain valid even when output is inside the checkout');
  await writeFile(join(protocolDir, 'src/index.ts'), 'export const marker = "moving-source";');
  // Earlier source-tool tests register a workspace loader for this process.
  // Authors consume the emitted SDK in their own process, without that loader
  // redirecting its bare imports back into the canonical checkout.
  const { stdout: authorOutput } = await promisify(execFile)(process.execPath,
    ['--input-type=module', '--eval', `import * as author from ${JSON.stringify(pathToFileURL(join(sdkRoot, 'dist/index.js')).href)};
      console.log(JSON.stringify({marker:author.marker,echo:author.echo('author-value'),canonicalAlias:author.canonicalAlias}));`],
    { env: { ...process.env, ...runtime.env } });
  const author = JSON.parse(authorOutput);
  assert.equal(author.marker, 'current-source');
  assert.equal(author.echo, 'author-value');
  assert.equal(author.canonicalAlias, 'package-alias');
  await assert.rejects(access(join(sdkDir, 'dist')), {code:'ENOENT'});
  assert.match(await readFile(join(protocolDir, 'dist/index.js'), 'utf8'), /stale-dist/);
  await writeFile(join(sdkDir, 'src/index.ts'), "export {marker} from '../../protocol/dist/index.js';");
  await writeFile(join(cliDir, 'src/index.ts'), "import {marker} from '@happier-dev/plugin-sdk'; export const ready = marker;");
  await assert.rejects(buildSourceRuntimeBundle({repoDir,outputDir:fixture.path('forbidden-dist'),component:'daemon'}),
    /Source preparation failed \(exit 1\)/);
});

for (const consumed of [false, true]) {
  test(`moving source preparation succeeds when an ${consumed ? 'actually consumed' : 'unconsumed'} input changes without caching it under stale source`, async context => {
    const fixture = await createTempFixture(context, {prefix:'happier-moving-source-', registerCleanup:false});
    context.after(async () => {
      await makeFixtureWritable(fixture.root);
      await rm(fixture.root, {recursive:true, force:true});
    });
    const repoDir = fixture.path('repo');
    const cliDir = join(repoDir, 'apps/cli');
    const locatorDir = join(cliDir, 'src/plugins/projection/registry/sources');
    await mkdir(locatorDir, {recursive:true});
    await mkdir(join(cliDir, 'node_modules'));
    await writeFile(join(cliDir, 'package.json'), JSON.stringify({name:'@happier-dev/cli', type:'module', exports:{}}));
    await writeFile(join(cliDir, 'tsconfig.json'), '{}');
    await symlink(dirname(createRequire(import.meta.url).resolve('esbuild/package.json')), join(cliDir, 'node_modules/esbuild'), process.platform === 'win32' ? 'junction' : 'dir');
    const original = 'export const ready = 1;';
    const entry = join(cliDir, 'src/index.ts');
    const changedFile = consumed ? entry : join(cliDir, 'src/unconsumed.ts');
    await writeFile(entry, consumed ? 'export const ready = 2;' : original);
    await writeFile(changedFile, consumed ? 'export const ready = 2;' : original);
    const builds = fixture.path('builds');
    // The real entry-discovery transform runs after cache admission and before
    // esbuild reads the graph. Its fixture edits exactly once, with no timers.
    await writeFile(join(locatorDir, 'generatedBundledPluginManifests.ts'), `
      import {existsSync,writeFileSync,appendFileSync} from 'node:fs';
      if (${!consumed} && !existsSync(${JSON.stringify(builds)})) writeFileSync(${JSON.stringify(changedFile)},'export const ready = 2;');
      appendFileSync(${JSON.stringify(builds)},'built\\n');
      export const BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS=[];
    `);
    const native = process.platform === 'linux' ? await installSourceAdmissionFixture(fixture.root) : null;
    await installSourcePreparationInputs(repoDir, 'daemon');
    const build = native?.build ?? buildSourceRuntimeBundle;
    const env = {...(native?.env ?? process.env)};
    if (consumed) {
      const observer = fixture.path('observe-read.mjs');
      // Observe real filesystem IO: return the bytes actually read, then model
      // an editor undo before preparation finishes. No bundler/domain mock.
      await writeFile(observer, `
        import {createRequire,syncBuiltinESMExports} from 'node:module';
        const fs=createRequire(import.meta.url)('node:fs/promises');
        const read=fs.readFile;
        const physicalEntry=await fs.realpath(${JSON.stringify(entry)});
        fs.readFile=async (...args)=>{
          const contents=await read(...args);
          if (String(args[0]).replaceAll('\\\\','/').endsWith('/workspace/apps/cli/src/index.ts') && String(contents)==='export const ready = 2;')
            await fs.writeFile(${JSON.stringify(entry)},${JSON.stringify(original)});
          return contents;
        };
        syncBuiltinESMExports();
      `);
      env.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ''} --import=${pathToFileURL(observer).href}`.trim();
    }
    const stackBaseDir = fixture.path('stacks/consumer');
    const first = await build({repoDir, stackBaseDir, component:'daemon', env});
    assert.equal((await import(pathToFileURL(first.entrypoint))).ready, consumed ? 2 : 1);
    if (consumed) assert.equal(await readFile(entry, 'utf8'), original,
      'the editor undo occurred after the consumed bytes were read, before completion');
    const graph = JSON.parse(await readFile(join(first.runtimeDir, 'metafile.json'), 'utf8'));
    assert.equal(Object.keys(graph.inputs).includes('apps/cli/src/unconsumed.ts'), false);
    // Restoring the initial source must not adopt a result that consumed the
    // intervening bytes. Simply removing the old rejection fails this check.
    await writeFile(changedFile, original);
    const second = await build({repoDir, stackBaseDir, component:'daemon', env});
    assert.equal((await import(pathToFileURL(second.entrypoint))).ready, 1);
    if (consumed) assert.notEqual(first.identity, second.identity);
    else assert.equal(first.identity, second.identity, 'unconsumed edits cannot change emitted code identity');
    const stable = await build({repoDir, stackBaseDir, component:'daemon', env});
    assert.equal(stable.entrypoint, second.entrypoint, 'settled inputs retain warm reuse');
    assert.equal((await readFile(builds, 'utf8')).trim().split('\n').length, consumed ? 2 : 1);
  });
}

test('shared source runtime compiles one captured view and reuses it after live input churn', async context => {
  const fixture = await createTempFixture(context, { prefix: 'happier-captured-source-runtime-', registerCleanup: false });
  context.after(async () => { await makeFixtureWritable(fixture.root); await rm(fixture.root, { recursive: true, force: true }); });
  const repoDir = fixture.path('repo');
  const cliDir = join(repoDir, 'apps/cli');
  const locatorDir = join(cliDir, 'src/plugins/projection/registry/sources');
  await mkdir(locatorDir, { recursive: true });
  await mkdir(join(cliDir, 'node_modules'));
  await writeFile(join(cliDir, 'package.json'), JSON.stringify({ name: '@happier-dev/cli', type: 'module', exports: {} }));
  await writeFile(join(cliDir, 'tsconfig.json'), '{}');
  await symlink(dirname(createRequire(import.meta.url).resolve('esbuild/package.json')), join(cliDir, 'node_modules/esbuild'), process.platform === 'win32' ? 'junction' : 'dir');
  const entry = join(cliDir, 'src/index.ts');
  const builds = fixture.path('builds');
  const original = 'export const ready = 1;';
  await writeFile(entry, original);
  await writeFile(join(cliDir, 'src/unconsumed.ts'), original);
  await writeFile(join(locatorDir, 'generatedBundledPluginManifests.ts'), `
    import {writeFileSync,appendFileSync} from 'node:fs';
    writeFileSync(${JSON.stringify(entry)}, 'export const ready = 2;');
    writeFileSync(${JSON.stringify(join(cliDir, 'src/unconsumed.ts'))}, 'export const ready = 2;');
    appendFileSync(${JSON.stringify(builds)}, 'built\\n');
    export const BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS=[];
  `);
  await installSourcePreparationInputs(repoDir, 'daemon');
  const native = process.platform === 'linux' ? await installSourceAdmissionFixture(fixture.root) : null;
  const build = native?.build ?? buildSourceRuntimeBundle;
  const options = { repoDir, stackBaseDir: fixture.path('stacks/a'), component: 'daemon', env: native?.env ?? process.env };
  const first = await build(options);
  assert.equal((await import(pathToFileURL(first.entrypoint))).ready, 1, 'entry discovery and compilation must consume the same captured view');
  await writeFile(entry, original);
  const warm = await build(options);
  assert.equal(warm.entrypoint, first.entrypoint, 'unconsumed live churn must preserve a completed captured graph');
  assert.equal((await readFile(builds, 'utf8')).trim().split('\n').length, 1);
  await writeFile(entry, 'import {value} from "./added.js"; export const ready = value;');
  await writeFile(join(cliDir, 'src/added.ts'), 'export const value = 3;');
  const added = await build(options);
  assert.equal((await import(pathToFileURL(added.entrypoint))).ready, 3, 'new transitive imports change the captured graph');
  await writeFile(entry, 'import {value} from "./added.js"; export const ready = value;');
  await rm(join(cliDir, 'src/added.ts'));
  const controller = new AbortController();
  let reportFailure;
  const failure = new Promise(resolve => { reportFailure = resolve; });
  const failed = build({ ...options, signal: controller.signal,
    logger: { log() {}, warn() {}, error() { reportFailure(); } } });
  // The preparation owner waits for source repair on a missing import. Cancel
  // that real recovery path, then prove failed publication kept the incumbent.
  await failure;
  controller.abort();
  await assert.rejects(failed);
  assert.equal(JSON.parse(await readFile(join(options.stackBaseDir, 'source-runtime/selected-daemon.json'), 'utf8')).entrypoint, added.entrypoint);
});

test('concurrent stacks share one read-only source bundle and retain selected bundles across source changes', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-source-dedupe-'));
  let live;
  context.after(async () => {
    if (live && live.exitCode === null) {
      const retired = new Promise(resolve => live.once('exit', resolve));
      live.kill();
      await retired;
    }
    await makeFixtureWritable(root);
    await rm(root, { recursive: true, force: true });
  });
  const repoDir = join(root, 'repo');
  const cliDir = join(repoDir, 'apps/cli');
  const locatorDir = join(cliDir, 'src/plugins/projection/registry/sources');
  await mkdir(locatorDir, { recursive: true });
  await mkdir(join(cliDir, 'node_modules'));
  await writeFile(join(cliDir, 'package.json'), JSON.stringify({ name: '@happier-dev/cli', type: 'module', exports: {} }));
  await writeFile(join(cliDir, 'tsconfig.json'), '{}');
  await writeFile(join(cliDir, 'src/index.ts'), 'export const ready = 1;');
  await symlink(dirname(createRequire(import.meta.url).resolve('esbuild/package.json')), join(cliDir, 'node_modules/esbuild'), process.platform === 'win32' ? 'junction' : 'dir');
  const builds = join(root, 'builds');
  await writeFile(join(locatorDir, 'generatedBundledPluginManifests.ts'), `import {appendFileSync} from 'node:fs'; appendFileSync(${JSON.stringify(builds)}, 'built\\n'); export const BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS=[];`);
  const stacks = [join(root, 'stacks/a'), join(root, 'stacks/b')];
  await installSourcePreparationInputs(repoDir, 'daemon');
  const native = process.platform === 'linux' ? await installSourceAdmissionFixture(root) : null;
  const build = native?.build ?? buildSourceRuntimeBundle;
  const buildEnv = {...(native ? buildNativeAdmissionFixtureEnv() : process.env)};
  if(native) {
    buildEnv.PATH = native.env.PATH;
    buildEnv.HAPPIER_DEV_TARGET_EXECUTION = native.env.HAPPIER_DEV_TARGET_EXECUTION;
  }
  const runtimeUrl = native ? pathToFileURL(native.runtimePath).href : new URL('./build_source_runtime.mjs',import.meta.url).href;
  const script = `import {buildSourceRuntimeBundle} from ${JSON.stringify(runtimeUrl)}; console.log(JSON.stringify(await buildSourceRuntimeBundle({repoDir:process.argv[1],stackBaseDir:process.argv[2],component:'daemon'})));`;
  const results = await Promise.all(stacks.map(async stackBaseDir => {
    const {stdout} = await promisify(execFile)(process.execPath, ['--input-type=module', '--eval', script, repoDir, stackBaseDir], {env:buildEnv});
    return JSON.parse(stdout);
  }));
  assert.equal(results[0].entrypoint, results[1].entrypoint);
  assert.equal((await readFile(builds, 'utf8')).trim().split('\n').length, 1);
  if (process.platform !== 'win32') assert.equal((await stat(results[0].entrypoint)).mode & 0o222, 0);
  await writeFile(join(cliDir, 'src/index.ts'), 'export const ready = 1;');
  const unchanged = await build({repoDir, stackBaseDir:stacks[0], component:'daemon',env:buildEnv});
  assert.equal(unchanged.entrypoint, results[0].entrypoint, 'content, not write time, owns reuse');
  assert.equal((await readFile(builds, 'utf8')).trim().split('\n').length, 1);
  await writeFile(join(cliDir, 'src/index.ts'), 'export const ready = 2;');
  const recovered = await build({repoDir, stackBaseDir: stacks[0], component:'daemon', reuseSelected:true,env:buildEnv});
  assert.equal(recovered.entrypoint, results[0].entrypoint, 'in-run recovery keeps the selected emitted graph despite moving source');
  assert.equal(recovered.identity, results[0].identity);
  assert.equal((await readFile(builds, 'utf8')).trim().split('\n').length, 1);
  const second = await build({repoDir, stackBaseDir: stacks[0], component:'daemon',env:buildEnv});
  assert.notEqual(second.entrypoint, results[0].entrypoint);
  await access(results[0].entrypoint); // Other stack still selects this bundle.
  await writeFile(join(cliDir, 'src/index.ts'), 'export const ready = 3; if (!process.argv.includes("--help")) { console.log("ready"); setInterval(()=>{},1000); }');
  const third = await build({repoDir, stackBaseDir: stacks[0], component:'daemon',env:buildEnv});
  if (process.platform === 'win32') await access(second.entrypoint); // No authoritative process observation: retain.
  else await assert.rejects(access(second.entrypoint), {code:'ENOENT'});
  await access(results[0].entrypoint);
  await access(third.entrypoint);
  await assert.rejects(build({repoDir, stackBaseDir: join(root, 'stacks/unselected'), component:'daemon', reuseSelected:true,env:buildEnv}),
    /selected source daemon bundle.*unavailable/i, 'recovery cannot silently build current source when selection is missing');
  assert.equal((await readdir(join(root, 'stacks/source-bundles'))).filter(name => /^(bundle|runtime)-/.test(name)).length, process.platform === 'win32' ? 3 : 2);
  live = spawn(process.execPath, [third.entrypoint], {env:{...process.env,...third.env},stdio:['ignore','pipe','inherit']});
  await new Promise((resolve,reject) => { live.once('error',reject);live.stdout.once('data',resolve);live.once('exit',code=>reject(new Error(`source runtime exited before readiness (${code})`))); });
  await writeFile(join(cliDir, 'src/index.ts'), 'export const ready = 4;');
  const fourth = await build({repoDir, stackBaseDir:stacks[0], component:'daemon',env:buildEnv});
  await access(third.entrypoint); // Live runtime retains its old launch independently of selection.
  await writeFile(join(cliDir, 'src/index.ts'), 'export const ready = 1;');
  const retentionBasis = await Promise.all([results[0], third, fourth].map(async built => {
    const directory = resolve(dirname(built.entrypoint), '../../..');
    const recordPath = join(directory, 'source-bundle.json');
    return { directory, directoryMtime: (await stat(directory)).mtimeMs,
      completionMtime: (await stat(recordPath)).mtimeMs,
      component: JSON.parse(await readFile(recordPath, 'utf8')).component };
  }));
  // Allocation-directory timestamps are mutable OS metadata, not completion
  // order. Re-adoption must preserve the newest immutable completion record.
  const directoryTouchTime = new Date(Math.max(...retentionBasis.flatMap(item => [item.directoryMtime, item.completionMtime])) + 1);
  await utimes(retentionBasis[0].directory, directoryTouchTime, directoryTouchTime);
  retentionBasis[0].directoryMtime = (await stat(retentionBasis[0].directory)).mtimeMs;
  const readopted = await build({repoDir, stackBaseDir:stacks[0], component:'daemon',env:buildEnv});
  assert.equal(readopted.entrypoint, results[0].entrypoint);
  try {
    await access(fourth.entrypoint); // The newest built bundle survives adopting an older selected bundle.
  } catch (error) {
    context.diagnostic(`Source retention basis before adoption: ${JSON.stringify(retentionBasis)}`);
    throw error;
  }
});

test('source CLI commands preserve a pending start selection across source changes and peer reclamation',
  { skip: process.platform !== 'linux' }, async context => {
  const fixture = await createTempFixture(context, { prefix: 'happier-source-cli-selection-', registerCleanup: false });
  context.after(async () => { await makeFixtureWritable(fixture.root); await rm(fixture.root, { recursive: true, force: true }); });
  const native = await installSourceAdmissionFixture(fixture.root);
  const repoDir = fixture.path('repo');
  const cliDir = join(repoDir, 'apps/cli');
  await mkdir(join(cliDir, 'src'), { recursive: true });
  await mkdir(join(cliDir, 'node_modules'));
  await writeFile(join(cliDir, 'package.json'), JSON.stringify({ name: '@happier-dev/cli', type: 'module', exports: {} }));
  await writeFile(join(cliDir, 'tsconfig.json'), '{}');
  const entry = join(cliDir, 'src/index.ts');
  await writeFile(entry, 'export const ready = 1;');
  await symlink(dirname(createRequire(import.meta.url).resolve('esbuild/package.json')), join(cliDir, 'node_modules/esbuild'), 'dir');
  await installSourcePreparationInputs(repoDir, 'daemon');
  const stackBaseDir = fixture.path('stacks/consumer');
  const options = { repoDir, stackBaseDir, component: 'daemon', env: native.env, signal: context.signal };
  const pending = await native.build(options);
  const selectionPath = join(stackBaseDir, 'source-runtime/selected-daemon.json');
  const selection = await readFile(selectionPath, 'utf8');

  // Install the real launch-context owner beside the fixture launcher. Only
  // import locations change; CLI resolution, selection and reclamation stay real.
  const contextSource = new URL('../runtime/launch/resolveStackRuntimeLaunchContext.mjs', import.meta.url);
  const contextPath = fixture.path('native-owner/apps/stack/scripts/runtime/launch/resolveStackRuntimeLaunchContext.mjs');
  await mkdir(dirname(contextPath), { recursive: true });
  await writeFile(contextPath, (await readFile(contextSource, 'utf8'))
    .replace(/(from )'(\.[^']+)'/g, (_match, prefix, path) => `${prefix}${JSON.stringify(new URL(path, contextSource).href)}`));
  const { resolveStackRuntimeLaunchContext } = await import(pathToFileURL(contextPath));
  const env = { ...native.env, HAPPIER_STACK_REPO_DIR: repoDir,
    HAPPIER_STACK_STORAGE_DIR: fixture.path('stacks'), HAPPIER_STACK_STACK: 'consumer' };
  await writeFile(entry, 'export const ready = 2;');
  // The start has selected its graph but has not published runtime state or
  // launched a process yet (for example, it is still exporting the web UI).
  const command = await resolveStackRuntimeLaunchContext({ argv: ['--runtime=source'], env });
  assert.equal(command.cliLaunchSpec.entrypoint, pending.entrypoint);
  assert.equal(await readFile(selectionPath, 'utf8'), selection);
  const remoteState = { placement: { daemon: 'remote-host' },
    remoteTargets: { 'remote-host': { services: { daemon: true } } },
    sourceRuntimeIdentities: { daemon: { selected: 'remote-code', loaded: 'remote-code' } } };
  const controller = await resolveStackRuntimeLaunchContext({ argv: ['--runtime=source'], env,
    activeRuntimeState: remoteState });
  assert.equal(controller.cliLaunchSpec.entrypoint, pending.entrypoint,
    'a remote daemon identity must not prevent controller CLI selection');
  assert.equal(await readFile(selectionPath, 'utf8'), selection);
  await assert.rejects(resolveStackRuntimeLaunchContext({ argv: ['--runtime=source'], env,
    activeRuntimeState: { ...remoteState, placement: { daemon: 'local' } } }), /loaded source CLI.*unavailable/i,
    'stale remote-target metadata must not bypass the local loaded-daemon guard');
  const peer = await native.build({ ...options, stackBaseDir: fixture.path('stacks/peer') });
  await access(pending.entrypoint);
  assert.equal((await import(pathToFileURL(command.cliLaunchSpec.entrypoint))).ready, 1);

  // A CLI-only stack can still bootstrap when it has never selected a graph.
  const bootstrap = await resolveStackRuntimeLaunchContext({ argv: ['--runtime=source'],
    env: { ...env, HAPPIER_STACK_STACK: 'bootstrap' } });
  assert.equal(bootstrap.cliLaunchSpec.entrypoint, peer.entrypoint);
  const unavailableSelection = JSON.stringify({ entrypoint: fixture.path('missing/apps/cli/src/index.mjs') });
  const bootstrapSelection = fixture.path('stacks/bootstrap/source-runtime/selected-daemon.json');
  await writeFile(bootstrapSelection, unavailableSelection);
  await assert.rejects(resolveStackRuntimeLaunchContext({ argv: ['--runtime=source'],
    env: { ...env, HAPPIER_STACK_STACK: 'bootstrap' }, activeRuntimeState: { sourceRuntimeLaunch: null } }),
    /selected source daemon bundle.*unavailable/i);
  assert.equal(await readFile(bootstrapSelection, 'utf8'), unavailableSelection,
    'an unavailable selected graph must fail closed instead of replacing its pin');
  // Once the real startup replaces the selection, the old unlaunched graph
  // becomes reclaimable; command resolution must not create a permanent pin.
  await native.build(options);
  await assert.rejects(access(pending.entrypoint), { code: 'ENOENT' });
});

test('a cold source CLI bootstrap adopts a selection published during its build',
  { skip: process.platform !== 'linux' }, async context => {
  const fixture = await createTempFixture(context, { prefix: 'happier-source-cli-cold-selection-', registerCleanup: false });
  context.after(async () => { await makeFixtureWritable(fixture.root); await rm(fixture.root, { recursive: true, force: true }); });
  const native = await installSourceAdmissionFixture(fixture.root);
  // Admit the two tiny real graphs independently, as in the existing
  // unfinished-producer test; the OS resource observation is the only seam.
  await writeFile(fixture.path('bin/awk'), `#!/bin/sh\ncase "$*" in\n */proc/meminfo*) printf '67108864 67108864\\n' ;;\n */proc/loadavg*|*/proc/pressure/*) printf '0\\n' ;;\n *) exec /usr/bin/awk "$@" ;;\nesac\n`);
  const started = fixture.path('started');
  const release = fixture.path('release');
  const watcher = watch(fixture.root);
  context.after(() => watcher.close());
  const active = new Promise((resolve, reject) => {
    watcher.on('error', reject);
    watcher.on('change', (_event, name) => { if (name === 'started') resolve(); });
  });
  const repos = [fixture.path('command-repo'), fixture.path('start-repo')];
  for (const [index, repoDir] of repos.entries()) {
    const cliDir = join(repoDir, 'apps/cli');
    const locator = join(cliDir, 'src/plugins/projection/registry/sources');
    await mkdir(locator, { recursive: true });
    await mkdir(join(cliDir, 'node_modules'));
    await writeFile(join(cliDir, 'package.json'), JSON.stringify({ name: '@happier-dev/cli', type: 'module', exports: {} }));
    await writeFile(join(cliDir, 'tsconfig.json'), '{}');
    await writeFile(join(cliDir, 'src/index.ts'), `export const ready = ${index};`);
    await symlink(dirname(createRequire(import.meta.url).resolve('esbuild/package.json')), join(cliDir, 'node_modules/esbuild'), 'dir');
    await writeFile(join(locator, 'generatedBundledPluginManifests.ts'), (index === 0
      ? `import {writeFileSync,existsSync} from 'node:fs'; writeFileSync(${JSON.stringify(started)},'ready'); while(!existsSync(${JSON.stringify(release)})) await new Promise(resolve=>setTimeout(resolve,10)); ` : '')
      + 'export const BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS=[];');
    await installSourcePreparationInputs(repoDir, 'daemon');
  }
  const controller = new AbortController();
  const options = { stackBaseDir: fixture.path('stacks/consumer'), component: 'daemon', env: native.env,
    signal: AbortSignal.any([controller.signal, context.signal]) };
  const command = native.build({ ...options, repoDir: repos[0], reuseSelected: 'if-available' });
  const completion = command.then(built => ({ built }), error => ({ error }));
  context.after(async () => { controller.abort(); await completion; });
  await active;
  const pending = await native.build({ ...options, repoDir: repos[1] });
  await writeFile(release, 'release');
  const outcome = await completion;
  if (outcome.error) throw outcome.error;
  assert.equal(outcome.built.entrypoint, pending.entrypoint);
  assert.equal(JSON.parse(await readFile(join(options.stackBaseDir, 'source-runtime/selected-daemon.json'), 'utf8')).entrypoint,
    pending.entrypoint);
  assert.equal((await import(pathToFileURL(pending.entrypoint))).ready, 1);
});

test('failed source completion publication preserves the previous coherent selection',
  {skip:process.platform !== 'linux',timeout:30000}, async context => {
  const fixture = await createTempFixture(context, {prefix:'happier-source-publication-failure-',registerCleanup:false});
  context.after(async () => { await makeFixtureWritable(fixture.root); await rm(fixture.root,{recursive:true,force:true}); });
  const native = await installSourceAdmissionFixture(fixture.root);
  const repoDir = fixture.path('repo');
  const cliDir = join(repoDir,'apps/cli');
  await mkdir(join(cliDir,'src'),{recursive:true});
  await mkdir(join(cliDir,'node_modules'));
  await writeFile(join(cliDir,'package.json'),JSON.stringify({name:'@happier-dev/cli',type:'module',exports:{}}));
  await writeFile(join(cliDir,'tsconfig.json'),'{}');
  await writeFile(join(cliDir,'src/index.ts'),'export const ready = 1;');
  await symlink(dirname(createRequire(import.meta.url).resolve('esbuild/package.json')),join(cliDir,'node_modules/esbuild'),'dir');
  await installSourcePreparationInputs(repoDir,'daemon');
  const options = {repoDir,stackBaseDir:fixture.path('stacks/consumer'),component:'daemon',env:native.env,signal:context.signal};
  const prior = await native.build(options);
  const selectionPath = join(options.stackBaseDir,'source-runtime/selected-daemon.json');
  const priorSelection = await readFile(selectionPath,'utf8');
  await writeFile(join(cliDir,'src/index.ts'),'export const ready = 2;');
  const preload = fixture.path('filesystem-fault.mjs');
  // Only the real filesystem completion-rename boundary fails; all graph,
  // admission, selection and retention logic stays real.
  await writeFile(preload, `import fs from 'node:fs/promises'; import {syncBuiltinESMExports} from 'node:module';
    import {basename} from 'node:path'; const rename=fs.rename;
    fs.rename=async(from,to)=>{if(basename(to)==='source-bundle.json')throw Object.assign(new Error('ENOSPC at source-bundle completion publication'),{code:'ENOSPC'});return rename(from,to)};
    syncBuiltinESMExports();`);
  await assert.rejects(native.build({...options,env:{...native.env,
    NODE_OPTIONS:[native.env.NODE_OPTIONS,`--import=${pathToFileURL(preload).href}`].filter(Boolean).join(' ')}}),
    /Source preparation failed \(exit 1\)/);
  assert.equal(await readFile(selectionPath,'utf8'),priorSelection,
    'failed completion publication must preserve the previous coherent selection');
  const recovered = await native.build({...options,reuseSelected:true});
  assert.equal(recovered.entrypoint,prior.entrypoint);
  assert.equal((await import(pathToFileURL(recovered.entrypoint))).ready,1);
  assert.equal((await readdir(fixture.path('stacks/source-bundles'))).filter(name=>/^(bundle|runtime)-/.test(name)).length,1);
});

test('different source fingerprints compile independently and retention preserves an unfinished graph',
  {skip:process.platform !== 'linux',timeout:30000}, async context => {
  const fixture = await createTempFixture(context, {prefix:'happier-source-independent-',registerCleanup:false});
  context.after(async () => { await makeFixtureWritable(fixture.root); await rm(fixture.root,{recursive:true,force:true}); });
  const native = await installSourceAdmissionFixture(fixture.root);
  // Two tiny real esbuild graphs fit; report enough host memory to admit both.
  await writeFile(fixture.path('bin/awk'), `#!/bin/sh\ncase "$*" in\n */proc/meminfo*) printf '67108864 67108864\\n' ;;\n */proc/loadavg*|*/proc/pressure/*) printf '0\\n' ;;\n *) exec /usr/bin/awk "$@" ;;\nesac\n`);
  const started = fixture.path('started');
  const release = fixture.path('release');
  const watcher = watch(fixture.root);
  context.after(() => watcher.close());
  const active = new Promise((resolve,reject) => {
    watcher.on('error',reject);
    watcher.on('change',(_event,name) => { if(name==='started') resolve(); });
  });
  const repos = [fixture.path('repo-a'),fixture.path('repo-b')];
  for (const [index,repoDir] of repos.entries()) {
    const cliDir = join(repoDir,'apps/cli');
    const locator = join(cliDir,'src/plugins/projection/registry/sources');
    await mkdir(locator,{recursive:true});
    await mkdir(join(cliDir,'node_modules'));
    await writeFile(join(cliDir,'package.json'),JSON.stringify({name:'@happier-dev/cli',type:'module',exports:{}}));
    await writeFile(join(cliDir,'tsconfig.json'),'{}');
    await writeFile(join(cliDir,'src/index.ts'),`export const ready = ${index};`);
    await symlink(dirname(createRequire(import.meta.url).resolve('esbuild/package.json')),join(cliDir,'node_modules/esbuild'),'dir');
    await writeFile(join(locator,'generatedBundledPluginManifests.ts'), (index===0
      ? `import {writeFileSync,existsSync} from 'node:fs'; writeFileSync(${JSON.stringify(started)},'ready'); while(!existsSync(${JSON.stringify(release)})) await new Promise(resolve=>setTimeout(resolve,10)); ` : '')
      + 'export const BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS=[];');
    await installSourcePreparationInputs(repoDir,'daemon');
  }
  const controller = new AbortController();
  const first = native.build({repoDir:repos[0],stackBaseDir:fixture.path('stacks/a'),component:'daemon',
    env:native.env,signal:AbortSignal.any([controller.signal,context.signal])});
  const completion = first.then(built=>({built}),error=>({error}));
  context.after(async () => { controller.abort(); await completion; });
  await active;
  const second = await native.build({repoDir:repos[1],stackBaseDir:fixture.path('stacks/b'),component:'daemon',
    env:native.env,signal:context.signal});
  assert.equal((await import(pathToFileURL(second.entrypoint))).ready,1);
  await writeFile(release,'release');
  const outcome = await completion;
  if(outcome.error) throw outcome.error;
  assert.equal((await import(pathToFileURL(outcome.built.entrypoint))).ready,0);
  await access(second.entrypoint);
});

test('shared source preparation releases its build lock while queued and selected recovery does not need build admission',
  {skip:process.platform !== 'linux',timeout:30000}, async context => {
  const fixture = await createTempFixture(context, {prefix:'happier-source-joint-admission-',registerCleanup:false});
  context.after(async () => { await makeFixtureWritable(fixture.root); await rm(fixture.root,{recursive:true,force:true}); });
  const native = await installSourceAdmissionFixture(fixture.root);
  const {build} = native;
  const available = fixture.path('available-memory');
  const observed = fixture.path('memory-observed');
  await writeFile(available,'16777216');
  await writeFile(fixture.path('bin/awk'),`#!/bin/sh
case "$*" in
  */proc/meminfo*)
    available=$(/bin/cat '${available}')
    printf '%s 16777216\\n' "$available"
    [ "$available" -ne 5242880 ] || printf observed > '${observed}'
    ;;
  */proc/loadavg*|*/proc/pressure/*) printf '0\\n' ;;
  *) exec /usr/bin/awk "$@" ;;
esac
`);
  await chmod(fixture.path('bin/awk'),0o755);
  const env = {...buildNativeAdmissionFixtureEnv(),PATH:`${fixture.path('bin')}:/usr/bin:/bin`,HAPPIER_DEV_TARGET_EXECUTION:'1'};
  const repoDir = fixture.path('repo');
  const cliDir = join(repoDir,'apps/cli');
  await mkdir(join(cliDir,'src'),{recursive:true});
  await mkdir(join(cliDir,'node_modules'));
  await writeFile(join(cliDir,'package.json'),JSON.stringify({name:'@happier-dev/cli',type:'module',exports:{}}));
  await writeFile(join(cliDir,'tsconfig.json'),'{}');
  await writeFile(join(cliDir,'src/index.ts'),'export const ready = 1;');
  await symlink(dirname(createRequire(import.meta.url).resolve('esbuild/package.json')),join(cliDir,'node_modules/esbuild'),'dir');
  const stackBaseDir = fixture.path('stacks/consumer');
  await installSourcePreparationInputs(repoDir, 'daemon');
  const options = {repoDir,stackBaseDir,component:'daemon',env};
  const selected = await build(options);
  // A queued launcher may have parsed the preceding worker payload before
  // source changes. Exercise that actual process boundary, not a mock caller.
  const priorPayload = JSON.parse(await native.runSourceCommand({repoDir,scriptPath:native.runtimePath,
    args:[JSON.stringify({repoDir,stackBaseDir,component:'daemon',serverComponent:'happier-server-light'})],env,signal:context.signal,
    admissionClass:'source-bundle'}));
  assert.equal(priorPayload.entrypoint,selected.entrypoint,'a queued preceding launcher still receives its runtime');
  await writeFile(available,'5242880');
  const warm = await build({...options,signal:context.signal});
  assert.equal(warm.entrypoint,selected.entrypoint,'unchanged inputs reuse a bundle without compiler memory admission');
  await writeFile(available,'16777216');
  await writeFile(join(cliDir,'src/index.ts'),'export const ready = 2;');
  const buildLockPath = fixture.path('stacks/source-bundles/build.lock');
  let lockDiagnostic = '';
  const stderrWrite = process.stderr.write;
  process.stderr.write = function(chunk,...args) {
    lockDiagnostic += String(chunk);
    return stderrWrite.call(this,chunk,...args);
  };
  context.after(()=> { process.stderr.write=stderrWrite; });
  await withWorkspaceBundleLock(async () => {
    const independent = await build({...options,signal:context.signal});
    assert.equal((await import(pathToFileURL(independent.entrypoint))).ready,2,
      'an unrelated legacy global build lock cannot serialize current fingerprints');
  }, {lockPath:buildLockPath,signal:context.signal});
  const afterLockWait = await build({...options,signal:context.signal});
  assert.notEqual(afterLockWait.entrypoint,selected.entrypoint);
  assert.equal((await import(pathToFileURL(afterLockWait.entrypoint))).ready,2);
  await writeFile(join(cliDir,'src/index.ts'),'export const ready = 3;');
  await writeFile(available,'5242880');
  const watcher = watch(fixture.root);
  context.after(()=>watcher.close());
  const pressure = new Promise((resolve,reject)=> {
    watcher.on('error',reject);
    watcher.on('change',(_event,name)=> { if(name==='memory-observed') { watcher.close(); resolve(); } });
  });
  const controller = new AbortController();
  let waiting;
  const queued = new Promise(resolve=> { waiting=resolve; });
  const admissionDiagnosticWrite = process.stderr.write;
  process.stderr.write = function(chunk,...args) {
    lockDiagnostic += String(chunk);
    if(lockDiagnostic.includes('[preferred-execution] waiting for heavyweight admission')) waiting();
    return admissionDiagnosticWrite.call(this,chunk,...args);
  };
  const pending = build({...options,signal:AbortSignal.any([controller.signal,context.signal])});
  const completion = pending.then(built=>({built}),error=>({error}));
  context.after(async()=> { controller.abort(); await completion; });
  await Promise.all([pressure,queued]);
  const currentLeases = (await readdir(fixture.path('stacks/source-bundles')))
    .filter(name => /^build-[a-f0-9]{64}\.lock$/.test(name));
  assert.deepEqual(currentLeases, [], 'capacity waiting releases every current fingerprint lease');
  await assert.rejects(access(fixture.path('stacks/source-bundles/publication.lock')), {code:'ENOENT'},
    'capacity waiting must not retain shared publication custody');
  const beforeRecovery = (await readdir(fixture.path('stacks/source-bundles')))
    .filter(name => /^(bundle|runtime)-/.test(name)).sort();
  // CLI launch resolution uses this mode for read-only commands such as server
  // list, even while startup has selected code and source has since changed.
  const recovered = await build({...options,reuseSelected:'if-available',signal:context.signal});
  assert.equal(recovered.entrypoint,afterLockWait.entrypoint,'selected CLI commands bypass heavyweight admission');
  assert.deepEqual((await readdir(fixture.path('stacks/source-bundles')))
    .filter(name => /^(bundle|runtime)-/.test(name)).sort(),beforeRecovery,
    'a valid selected CLI bundle must not allocate or build another graph');
  await writeFile(available,'16777216');
  const next = await completion;
  if(next.error) throw next.error;
  assert.notEqual(next.built.entrypoint,afterLockWait.entrypoint);
  assert.equal((await import(pathToFileURL(next.built.entrypoint))).ready,3);
  assert.deepEqual(await readdir(join(native.admissionRoot,'owners')),[]);
  assert.deepEqual(await readdir(join(native.admissionRoot,'waiters')),[]);
});

test('one-shot source builds retire their real preparation process after success and failure', async (context) => {
  const repoDir = await mkdtemp(join(tmpdir(), 'happier-source-service-'));
  context.after(() => rm(repoDir, { recursive: true, force: true }));
  await linkCanonicalServerWorkspace(repoDir);
  const serverDir = join(repoDir, 'apps/server');
  await mkdir(join(serverDir, 'sources'), { recursive: true });
  await writeFile(join(serverDir, 'tsconfig.json'), JSON.stringify({
    extends:fileURLToPath(new URL('../../../server/tsconfig.json', import.meta.url)),
  }));
  await writeFile(join(serverDir, 'sources/main.light.ts'), 'export const ready = true;');
  await mkdir(join(serverDir, 'scripts'));
  await writeFile(join(serverDir, 'scripts/migrate.sqlite.deploy.ts'),
    `export {runSqliteMigrationDeploy} from ${JSON.stringify(fileURLToPath(new URL('../../../server/scripts/migrate.sqlite.deploy.ts', import.meta.url)))};`);
  // Preparation runs beneath foreground custody. Observe the real spawn
  // boundary in every descendant, not only the long-lived caller.
  const observedProcessesPath = join(repoDir, 'observed-processes.jsonl');
  const observerPath = join(repoDir, 'observe-processes.cjs');
  await writeFile(observerPath, `
    const cp=require('node:child_process'), fs=require('node:fs');
    const spawn=cp.spawn;
    cp.spawn=function(command,args,options){
      const child=spawn.call(this,command,args,options);
      const preparation=args?.some(arg=>arg.endsWith('build_source_runtime.mjs'));
      const service=args?.some(arg=>arg.startsWith('--service='));
      if((preparation || service) && child.pid) {
        fs.appendFileSync(${JSON.stringify(observedProcessesPath)},
          JSON.stringify({pid:child.pid,preparation})+'\\n');
      }
      return child;
    };
    require('node:module').syncBuiltinESMExports();
  `);
  const script = `
    import {createRequire} from 'node:module';
    import {readFile,writeFile} from 'node:fs/promises';
    import {join} from 'node:path';
    const {buildSourceRuntimeBundle}=await import(${JSON.stringify(new URL('./build_source_runtime.mjs', import.meta.url).href)});
    const {observeProcessLivenessSync}=await import(${JSON.stringify(new URL('../../../../packages/cli-common/processInstance.mjs', import.meta.url).href)});
    const repoDir=process.argv[1], results=[];
    const readObserved=async()=>(await readFile(${JSON.stringify(observedProcessesPath)},'utf8')
      .catch(error=>{if(error.code==='ENOENT')return '';throw error;})).trim().split('\\n').filter(Boolean).map(line=>JSON.parse(line));
    try {
      for(const failure of [false,true]) {
        if(failure) await writeFile(join(repoDir,'apps/server/sources/main.light.ts'),'import "./missing-source";');
        const before=(await readObserved()).length;
        let rejected=false;
        try {await buildSourceRuntimeBundle({repoDir,outputDir:join(repoDir,failure?'failure':'success'),component:'server'});}
        catch(error){if(!failure) throw error; rejected=true;}
        const observed=(await readObserved()).slice(before);
        if(!observed.some(child=>child.preparation))
          throw new Error('real source preparation process was not observed');
        const retired=observed.every(child=>observeProcessLivenessSync(child.pid).status==='dead');
        if(!retired) throw new Error('observed preparation children: '+JSON.stringify(observed.map(event=>
          ({...event,liveness:observeProcessLivenessSync(event.pid)}))));
        results.push({failure,rejected,retired});
      }
      console.log(JSON.stringify(results));
    } finally {createRequire(join(repoDir,'apps/server/package.json'))('esbuild').stop();}
  `;
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '--eval', script, repoDir], {
    env: { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require ${JSON.stringify(observerPath)}` },
  });
  assert.deepEqual(JSON.parse(stdout.trim()), [
    { failure: false, rejected: false, retired: true },
    { failure: true, rejected: true, retired: true },
  ]);
});

test('source bundle freezes source exports and a lazy entry without consuming dist', async (context) => {
  const repoDir = await mkdtemp(join(tmpdir(), 'happier-source-runtime-'));
  context.after(() => rm(repoDir, { recursive: true, force: true }));
  const cliDir = join(repoDir, 'apps/cli');
  const packageDir = join(repoDir, 'packages/example');
  const unscopedDir = join(repoDir, 'packages/unscoped');
  const sdkDir = join(repoDir, 'packages/sdk');
  const protocolDir = join(repoDir, 'packages/protocol');
  await Promise.all([mkdir(join(cliDir, 'src'), { recursive: true }), mkdir(join(packageDir, 'src'), { recursive: true }), mkdir(join(repoDir, 'node_modules/@happier-dev'), { recursive: true })]);
  await writeFile(join(cliDir, 'package.json'), JSON.stringify({ name: '@happier-dev/cli', type: 'module',
    dependencies: { '@happier-dev/example': '0.0.0', '@happier-dev/sdk': '0.0.0', 'unscoped-first-party': '0.0.0' },
    exports: { './lib': { 'happier-source': './src/library.ts', default: './dist/lib.mjs' } } }));
  await writeFile(join(cliDir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { paths: { '@/*': ['./src/*'] } } }));
  await writeFile(join(packageDir, 'package.json'), JSON.stringify({ name: '@happier-dev/example', type: 'module', exports: { '.': { 'happier-source': './src/index.ts', default: './dist/index.js' } } }));
  const unicodeLicense = '/*! @license Fixture 日本語 © 2026 */';
  await writeFile(join(packageDir, 'src/index.ts'), "export { value, unicode, namedUnicodeFailure } from './雪';\n");
  await writeFile(join(packageDir, 'src/雪.ts'), `${unicodeLicense}
export const value = 'frozen';
export const unicode = { literal: '雪 😀', raw: String.raw\`雪\\n\`, pattern: /\\u96ea/u.test('雪') };
export function namedUnicodeFailure() { throw new Error('雪 😀'); }
`);
  await mkdir(join(unscopedDir, 'src'), { recursive: true });
  await mkdir(join(unscopedDir, 'dist'), { recursive: true });
  await writeFile(join(unscopedDir, 'package.json'), JSON.stringify({ name: 'unscoped-first-party', type: 'module', exports: { import: { 'happier-source': './src/index.ts', default: './dist/index.js' } } }));
  await writeFile(join(unscopedDir, 'src/index.ts'), "export const value = '-unscoped';\n");
  await writeFile(join(unscopedDir, 'dist/index.js'), "export const value = '-stale-dist';\n");
  await symlink(unscopedDir, join(repoDir, 'node_modules/unscoped-first-party'), process.platform === 'win32' ? 'junction' : 'dir');
  await mkdir(join(sdkDir, 'src'), { recursive: true });
  await mkdir(join(protocolDir, 'src'), { recursive: true });
  await writeFile(join(sdkDir, 'package.json'), JSON.stringify({ name: '@happier-dev/sdk', type: 'module',
    dependencies: { '@happier-dev/protocol': '0.0.0' },
    exports: { '.': { 'happier-source': './src/index.ts', default: './dist/index.js' } }, imports: { '#http': { 'happier-source': './src/http.ts', default: './dist/http.js' } } }));
  await writeFile(join(sdkDir, 'src/index.ts'), "export { value } from '#http';\n");
  await writeFile(join(sdkDir, 'src/http.ts'), "export { value } from '@happier-dev/protocol';\n");
  await writeFile(join(protocolDir, 'package.json'), JSON.stringify({ name: '@happier-dev/protocol', type: 'module', exports: { '.': { 'happier-source': './src/index.ts', default: './dist/index.js' } } }));
  await writeFile(join(protocolDir, 'src/index.ts'), "export { value } from './authored';\n");
  await writeFile(join(protocolDir, 'src/authored.ts'), "export const value = '-canonical-protocol';\n");
  // A public bundled SDK dependency can retain a source condition while lacking
  // the authored transitive source. Native source builds must use the workspace
  // authority, not this nearer installed copy or its stale emitted fallback.
  const shadowProtocolDir = join(sdkDir, 'node_modules/@happier-dev/protocol');
  await mkdir(join(shadowProtocolDir, 'src'), { recursive: true });
  await writeFile(join(shadowProtocolDir, 'package.json'), JSON.stringify({ name: '@happier-dev/protocol', type: 'module', exports: { '.': { 'happier-source': './src/index.ts', default: './dist/index.js' } } }));
  await writeFile(join(shadowProtocolDir, 'src/index.ts'), "export { value } from './missing-bundled-source';\n");
  await symlink(sdkDir, join(repoDir, 'node_modules/@happier-dev/sdk'), process.platform === 'win32' ? 'junction' : 'dir');
  await symlink(protocolDir, join(repoDir, 'node_modules/@happier-dev/protocol'), process.platform === 'win32' ? 'junction' : 'dir');
  await writeFile(join(cliDir, 'src/index.ts'), "import {value} from '@happier-dev/example'; export {unicode,namedUnicodeFailure} from '@happier-dev/example'; import {value as unscoped} from 'unscoped-first-party'; import {value as sdk} from '@happier-dev/sdk'; export const read = async () => value + (await import('./lazy')).value + unscoped + sdk;\n");
  await writeFile(join(cliDir, 'src/lazy.ts'), "export const value = '-lazy';\n");
  await writeFile(join(cliDir, 'src/library.ts'), "export const value = 'frozen-library';\n");
  await mkdir(join(cliDir, 'scripts'), { recursive: true });
  await writeFile(join(cliDir, 'scripts/process_tree.cjs'), "exports.read = async () => (await import('@happier-dev/example')).value;\n");
  await writeFile(join(cliDir, 'scripts/statusline_forwarder.cjs'), `${unicodeLicense}\nexports.read = () => String.raw\`雪\\n\`;`);
  await symlink(packageDir, join(repoDir, 'node_modules/@happier-dev/example'), process.platform === 'win32' ? 'junction' : 'dir');
  await symlink(dirname(createRequire(import.meta.url).resolve('esbuild/package.json')), join(repoDir, 'node_modules/esbuild'), process.platform === 'win32' ? 'junction' : 'dir');
  await symlink(dirname(createRequire(import.meta.url).resolve('tsx/package.json')), join(repoDir, 'node_modules/tsx'), process.platform === 'win32' ? 'junction' : 'dir');
  const sourceToolsDir = join(repoDir, 'packages/cli-common');
  await mkdir(sourceToolsDir, { recursive: true });
  for (const file of ['registerSourceRuntime.mjs', 'sourceRuntimeEntries.mjs', 'cliRuntimeSidecars.mjs']) {
    await cp(new URL('../../../../packages/cli-common/' + file, import.meta.url), join(sourceToolsDir, file));
  }
  const { stdout: sdkSourceValue } = await promisify(execFile)(process.execPath, [
    '--import', pathToFileURL(join(sourceToolsDir, 'registerSourceRuntime.mjs')).href,
    '--input-type=module', '--eval', "console.log((await import('@happier-dev/sdk')).value)",
  ], { cwd: repoDir });
  assert.equal(sdkSourceValue.trim(), '-canonical-protocol', 'Node source tools also bypass the SDK installed Protocol shadow');
  const admissionEvidence = join(repoDir, 'admission.json');
  await mkdir(join(cliDir, 'src/plugins/projection/registry/sources'), { recursive: true });
  await writeFile(join(cliDir, 'src/plugins/projection/registry/sources/generatedBundledPluginManifests.ts'), `
    import {writeFileSync,readFileSync} from 'node:fs';
    import {join} from 'node:path';
    const token=process.env.HAPPIER_HEAVYWEIGHT_ADMISSION_TOKEN;
    const root=process.env.HAPPIER_HEAVYWEIGHT_ADMISSION_ROOT;
    const admissionClass=token && root ? readFileSync(join(root,'owners',token.replace(':','-'),'class'),'utf8').trim() : null;
    writeFileSync(${JSON.stringify(admissionEvidence)},JSON.stringify({pid:process.pid,admissionClass,token}));
    export const BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS=[];
  `);
  // The builder escalates an authenticated parent reservation in place.
  // Removing that identity queues another source-bundle reservation behind
  // the enclosing test runner's reservation.
  const buildEnv = {...process.env};
  const result = await buildSourceRuntimeBundle({ repoDir, outputDir: join(repoDir, 'output'), component: 'daemon', env:buildEnv });
  const admitted = JSON.parse(await readFile(admissionEvidence, 'utf8'));
  assert.notEqual(admitted.pid, process.pid, 'source preparation is finite, not part of the long-lived caller');
  if (process.platform === 'linux') {
    assert.equal(typeof admitted.admissionClass, 'string');
    assert.ok(resolveHeavyweightMemoryFloorKiB(admitted.admissionClass)
      >= resolveHeavyweightMemoryFloorKiB('source-bundle'), 'the reservation must cover the source bundle envelope');
    if (buildEnv.HAPPIER_HEAVYWEIGHT_ADMISSION_TOKEN) assert.equal(admitted.token,
      buildEnv.HAPPIER_HEAVYWEIGHT_ADMISSION_TOKEN, 'finite source preparation reuses its authenticated containing reservation');
  }
  await writeFile(join(packageDir, 'src/index.ts'), "export { unicode, namedUnicodeFailure } from './雪'; export const value = 'changed';\n");
  await writeFile(join(cliDir, 'src/lazy.ts'), "throw new Error('moving source was loaded');\n");
  await writeFile(join(unscopedDir, 'src/index.ts'), "throw new Error('moving unscoped source was loaded');\n");
  assert.equal(await (await import(pathToFileURL(result.entrypoint).href)).read(), 'frozen-lazy-unscoped-canonical-protocol');
  assert.equal(await createRequire(import.meta.url)(join(result.cliDir, 'scripts/process_tree.cjs')).read(), 'frozen');
  const publicLibrary = createRequire(join(result.cliDir, 'package.json')).resolve('@happier-dev/cli/lib');
  assert.equal((await import(pathToFileURL(publicLibrary).href)).value, 'frozen-library');
  assert.match(result.identity, /^[a-f0-9]{16}$/);
  const metafile = JSON.parse(await readFile(join(result.runtimeDir, 'metafile.json'), 'utf8'));
  assert.equal(Object.keys(metafile.inputs).some((file) => file.includes('/dist/')), false);
  const emitted = await import(pathToFileURL(result.entrypoint).href);
  assert.deepEqual(emitted.unicode, { literal: '雪 😀', raw: '雪\\n', pattern: true });
  const standaloneSidecar = join(result.cliDir, 'scripts/statusline_forwarder.cjs');
  assert.equal(createRequire(import.meta.url)(standaloneSidecar).read(), '雪\\n');
  assert.doesNotMatch(await readFile(standaloneSidecar, 'utf8'), /[^\x00-\xFF]/u);
  assert.throws(emitted.namedUnicodeFailure, error => {
    assert.equal(error.message, '雪 😀');
    assert.match(error.stack, /namedUnicodeFailure .*\.js:\d+:\d+/);
    return true;
  });
  const outputPaths = Object.keys(metafile.outputs).map(path => resolve(repoDir, 'output/workspace', path));
  for (const path of outputPaths.filter(path => /\.[cm]?js$/.test(path))) {
    assert.doesNotMatch(await readFile(path, 'utf8'), /[^\x00-\xFF]/u,
      `emitted JavaScript must retain one-byte V8 source strings: ${path}`);
  }
  const notices = await Promise.all(outputPaths.filter(path => path.endsWith('.LEGAL.txt')).map(path => readFile(path, 'utf8')));
  assert.ok(notices.some(text => text.includes(unicodeLicense)), 'retain the exact Unicode license outside executable source');
  // The emitted-import probe refuses the deliberately throwing live graph.
  // Repair it before testing adoption of a different valid source view.
  await writeFile(join(cliDir, 'src/lazy.ts'), "export const value = '-changed-lazy';\n");
  await writeFile(join(unscopedDir, 'src/index.ts'), "export const value = '-changed-unscoped';\n");
  const rebuilt = await buildSourceRuntimeBundle({ repoDir, outputDir: join(repoDir, 'output-two'), component: 'daemon', env:buildEnv });
  assert.notEqual(rebuilt.identity, result.identity);
  assert.equal(await (await import(pathToFileURL(rebuilt.entrypoint).href)).read(), 'changed-changed-lazy-changed-unscoped-canonical-protocol');
});

test('source server refuses reuse of copied SQL consumed during an editor undo', async context => {
  const fixture = await createTempFixture(context, { prefix: 'happier-source-sql-undo-', registerCleanup: false });
  context.after(async () => { await makeFixtureWritable(fixture.root); await fixture.cleanup(); });
  const repoDir = fixture.path('repo');
  const serverDir = join(repoDir, 'apps/server');
  await Promise.all(['sources', 'scripts', 'prisma/migrations/example', 'node_modules']
    .map(name => mkdir(join(serverDir, name), { recursive: true })));
  await writeFile(join(serverDir, 'package.json'), JSON.stringify({ name: '@happier-dev/server', type: 'module' }));
  await writeFile(join(serverDir, 'tsconfig.json'), '{}');
  await writeFile(join(serverDir, 'sources/main.ts'), 'export const ready = true;');
  await writeFile(join(serverDir, 'scripts/migrate.full.deploy.ts'), 'export const migration = true;');
  const prisma = join(serverDir, 'prisma');
  const sql = join(prisma, 'migrations/example/migration.sql');
  await writeFile(sql, 'SELECT 2;\n');
  await symlink(dirname(createRequire(import.meta.url).resolve('esbuild/package.json')), join(serverDir, 'node_modules/esbuild'),
    process.platform === 'win32' ? 'junction' : 'dir');
  const observer = fixture.path('observe-sql-copy.mjs');
  const marker = fixture.path('edited');
  // Intercept filesystem IO only. The public builder, fingerprint, consumed
  // input recorder and reuse/adoption all remain real.
  await writeFile(observer, `
    import {createRequire,syncBuiltinESMExports} from 'node:module';
    const fs=createRequire(import.meta.url)('node:fs/promises');
    const read=fs.readFile, write=fs.writeFile;
    fs.readFile=async (...args)=>{
      const contents=await read(...args);
      if (String(args[0]).replaceAll('\\\\','/').endsWith('/workspace/apps/server/prisma/migrations/example/migration.sql') && String(contents)==='SELECT 2;\\n')
        await write(${JSON.stringify(sql)},'SELECT 1;\\n');
      return contents;
    };
    syncBuiltinESMExports();
  `);
  const native = process.platform === 'linux' ? await installSourceAdmissionFixture(fixture.root) : null;
  const build = native?.build ?? buildSourceRuntimeBundle;
  const env = { ...(native?.env ?? process.env), NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${pathToFileURL(observer).href}`.trim() };
  await installSourcePreparationInputs(repoDir, 'server');
  const options = { repoDir, stackBaseDir: fixture.path('stacks/server'), component: 'server',
    serverComponent: 'happier-server', dbProvider: 'postgres', env };
  const first = await build(options);
  assert.equal(await readFile(join(first.serverDir, 'prisma/migrations/example/migration.sql'), 'utf8'), 'SELECT 2;\n');
  assert.equal(await readFile(sql, 'utf8'), 'SELECT 1;\n', 'source was restored before reuse admission');
  const second = await build(options);
  assert.equal(await readFile(join(second.serverDir, 'prisma/migrations/example/migration.sql'), 'utf8'), 'SELECT 1;\n',
    'the restored source must not adopt the bundle containing transient SQL');
  assert.notEqual(second.entrypoint, first.entrypoint);
  assert.equal((await build(options)).entrypoint, second.entrypoint, 'settled SQL keeps warm reuse');
});

test('source server retains the shipped public-profile fonts after source inputs retire', async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-source-public-profile-fonts-' });
  const repoDir = fixture.path('repo');
  const server = join(repoDir, 'apps/server');
  const renderer = 'sources/app/account/profile/render/publicProfileFonts.ts';
  await Promise.all(['sources/app/account/profile/render', 'scripts', 'node_modules'].map(path => mkdir(join(server, path), { recursive: true })));
  await writeFile(join(server, 'package.json'), JSON.stringify({ name: '@happier-dev/server', type: 'module' }));
  await writeFile(join(server, 'tsconfig.json'), '{}');
  await cp(fileURLToPath(new URL(`../../../server/${renderer}`, import.meta.url)), join(server, renderer));
  await writeFile(join(server, 'sources/main.ts'), `export { readPublicProfileFont, PUBLIC_PROFILE_FONT_FILES } from './app/account/profile/render/publicProfileFonts';`);
  await writeFile(join(server, 'scripts/migrate.full.deploy.ts'), `export { readPublicProfileFont } from '../sources/app/account/profile/render/publicProfileFonts';`);
  await cp(fileURLToPath(new URL('../../../server/assets/public-profile', import.meta.url)), join(server, 'assets/public-profile'), { recursive: true });
  const fonts = join(repoDir, 'apps/ui/sources/assets/fonts');
  await mkdir(fonts, { recursive: true });
  for (const name of ['Inter-Regular.ttf', 'Inter-Medium.ttf', 'Inter-SemiBold.ttf']) {
    await cp(fileURLToPath(new URL(`../../../ui/sources/assets/fonts/${name}`, import.meta.url)), join(fonts, name));
  }
  const expectedBytes = new Map();
  for (const directory of [fonts, join(server, 'assets/public-profile')]) {
    for (const name of await readdir(directory)) expectedBytes.set(name, await readFile(join(directory, name)));
  }
  await symlink(dirname(createRequire(import.meta.url).resolve('esbuild/package.json')), join(server, 'node_modules/esbuild'), process.platform === 'win32' ? 'junction' : 'dir');
  const runtime = await buildSourceRuntimeBundle({ repoDir, outputDir: fixture.path('output'), component: 'server', serverComponent: 'happier-server', dbProvider: 'postgres' });
  assert.ok((await readdir(join(runtime.runtimeDir, 'src/chunks'))).some(name => name.startsWith('chunk-')),
    'the physical reader also works from the shared chunk used by both entrypoints');
  await rename(join(server, 'assets'), fixture.path('retired-server-assets'));
  await rename(fonts, fixture.path('retired-ui-fonts'));
  const loaded = await import(pathToFileURL(runtime.entrypoint));
  for (const face of ['regular', 'medium', 'semiBold', 'cjk', 'arabic', 'emoji']) {
    const font = await loaded.readPublicProfileFont(face);
    assert.deepEqual(font.bytes, expectedBytes.get(loaded.PUBLIC_PROFILE_FONT_FILES[face]),
      `exact shipped ${face} remains readable without source assets`);
    assert.ok(font.path.startsWith(runtime.runtimeDir + sep), 'physical font path belongs to the retained runtime');
  }
  for (const name of ['LICENSE-Inter.txt', 'LICENSE-NotoSansCJK.txt', 'LICENSE-NotoSansArabic.txt', 'LICENSE-NotoEmoji.txt']) {
    assert.match(await readFile(join(runtime.runtimeDir, 'assets/public-profile', name), 'utf8'), /SIL OPEN FONT LICENSE/);
  }
});

test('source server retains migration source assets without copying checkout database files', async (context) => {
  const repoDir = await mkdtemp(join(tmpdir(), 'happier-source-runtime-'));
  context.after(() => rm(repoDir, { recursive: true, force: true }));
  const serverDir = join(repoDir, 'apps/server');
  await Promise.all(['sources', 'scripts', 'prisma/migrations/example', 'node_modules'].map((name) => mkdir(join(serverDir, name), { recursive: true })));
  await writeFile(join(serverDir, 'package.json'), JSON.stringify({ name: '@happier-dev/server', type: 'module' }));
  await writeFile(join(serverDir, 'tsconfig.json'), JSON.stringify({ compilerOptions: {} }));
  await writeFile(join(serverDir, 'sources/main.ts'), 'export const ready = true;\n');
  await writeFile(join(serverDir, 'scripts/migrate.full.deploy.ts'), 'export const migration = true;\n');
  await writeFile(join(serverDir, 'prisma/schema.prisma'), 'datasource db {}\n');
  await writeFile(join(serverDir, 'prisma/migrations/migration_lock.toml'), 'provider = "postgresql"\n');
  await writeFile(join(serverDir, 'prisma/migrations/example/migration.sql'), 'SELECT 1;\n');
  await writeFile(join(serverDir, 'prisma/development.db'), 'private retained checkout data');
  await symlink(dirname(createRequire(import.meta.url).resolve('esbuild/package.json')), join(serverDir, 'node_modules/esbuild'), process.platform === 'win32' ? 'junction' : 'dir');
  const runtime = await buildSourceRuntimeBundle({ repoDir, outputDir: join(repoDir, 'output'), component: 'server', serverComponent: 'happier-server', dbProvider: 'postgres' });
  const stackBaseDir = join(repoDir, 'stacks/server');
  await mkdir(join(stackBaseDir, 'source-runtime'), {recursive:true});
  await writeFile(join(stackBaseDir, 'source-runtime/selected-server.json'), JSON.stringify({entrypoint:runtime.entrypoint}));
  await writeFile(join(serverDir, 'sources/main.ts'), 'import "./missing-moving-source";');
  const recovered = await buildSourceRuntimeBundle({repoDir, stackBaseDir, component:'server', reuseSelected:true});
  assert.deepEqual(recovered, runtime, 'server recovery preserves emitted code, environment and migration launch together');
  assert.equal(await readFile(join(runtime.serverDir, 'prisma/schema.prisma'), 'utf8'), 'datasource db {}\n');
  assert.equal(await readFile(join(runtime.serverDir, 'prisma/migrations/example/migration.sql'), 'utf8'), 'SELECT 1;\n');
  assert.equal(await readFile(join(runtime.serverDir, 'prisma/migrations/migration_lock.toml'), 'utf8'), 'provider = "postgresql"\n');
  await assert.rejects(access(join(runtime.serverDir, 'prisma/development.db')), { code: 'ENOENT' });
});

test('Node source-light runs the canonical SQLite migration before startup without losing retained data', async context => {
  const fixture = await createTempFixture(context, {prefix:'happier-source-light-migration-', registerCleanup:false});
  context.after(async () => {
    await makeFixtureWritable(fixture.root);
    await rm(fixture.root, {recursive:true, force:true});
  });
  await mkdir(fixture.path('repo'));
  await linkCanonicalServerWorkspace(fixture.path('repo'));
  const serverDir = fixture.path('repo/apps/server');
  const migrationName = '20260927010000_add_home_settings_and_administration_events';
  const canonicalDeploy = fileURLToPath(new URL('../../../server/scripts/migrate.sqlite.deploy.ts', import.meta.url));
  const canonicalMigrations = fileURLToPath(new URL('../../../server/prisma/sqlite/migrations', import.meta.url));
  await Promise.all(['sources', 'scripts', `prisma/sqlite/migrations/${migrationName}`]
    .map(name => mkdir(join(serverDir, name), {recursive:true})));
  await writeFile(join(serverDir, 'tsconfig.json'), JSON.stringify({
    extends:fileURLToPath(new URL('../../../server/tsconfig.json', import.meta.url)),
  }));
  await writeFile(join(serverDir, 'sources/main.light.ts'), 'export const ready = true;');
  // Re-export the actual deployment owner; no migration-domain logic is mocked.
  await writeFile(join(serverDir, 'scripts/migrate.sqlite.deploy.ts'),
    `export {runSqliteMigrationDeploy} from ${JSON.stringify(canonicalDeploy)};`);
  await cp(canonicalMigrations, join(serverDir, 'prisma/sqlite/migrations'), {recursive:true});
  await installSourcePreparationInputs(fixture.path('repo'), 'server');
  const runtime = await buildSourceRuntimeBundle({repoDir:fixture.path('repo'), stackBaseDir:fixture.path('stacks/consumer'),
    component:'server', serverComponent:'happier-server-light', dbProvider:'sqlite'});
  assert.equal(runtime.migration.mode, 'external', 'Node cannot perform the Bun-only in-process migration');
  const dataDir = fixture.path('retained-data');
  await mkdir(dataDir);
  const databasePath = join(dataDir, 'retained.sqlite');
  const execute = promisify(execFile);
  await execute(process.execPath, ['--input-type=module', '-e', `
    import {DatabaseSync} from 'node:sqlite';
    const db=new DatabaseSync(process.argv[1]);
    db.exec("CREATE TABLE Retained (value TEXT NOT NULL); INSERT INTO Retained VALUES ('keep');");db.close();
  `, databasePath]);
  const env = {...process.env, ...runtime.env, HAPPIER_SERVER_LIGHT_DATA_DIR:dataDir,
    DATABASE_URL:`file:${databasePath}`};
  const serverLaunchSpec = resolveServerRuntimeLaunchSpec({sourceRuntimeLaunch:runtime});
  const children = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    await runServerRuntimeMigration({serverLaunchSpec, env, children});
  }
  assert.deepEqual(children, []);
  const observed = await execute(process.execPath, ['--input-type=module', '-e', `
    import {DatabaseSync} from 'node:sqlite';
    const db=new DatabaseSync(process.argv[1]);
    console.log(JSON.stringify({retained:db.prepare('SELECT value FROM Retained').get().value,
      homeSettings:db.prepare('SELECT count(*) AS count FROM HomeSettings').get().count,
      migrations:db.prepare('SELECT count(*) AS count FROM _prisma_migrations WHERE migration_name=?').get(process.argv[2]).count}));
    db.close();
  `, databasePath, migrationName]);
  assert.deepEqual(JSON.parse(observed.stdout), {retained:'keep', homeSettings:0, migrations:1});
});

test('cancelling source author emission retires its declaration compiler',
  { skip: process.platform !== 'linux', timeout: 20000 }, async context => {
    const fixture = await createTempFixture(context, {prefix:'happier-source-author-cancel-'});
    const repoDir = fixture.path('repo');
    const cliDir = join(repoDir, 'apps/cli');
    const sdkDir = join(repoDir, 'packages/plugin-sdk');
    for (const directory of [join(cliDir, 'src'), join(cliDir, 'node_modules'),
      join(sdkDir, 'src'), join(repoDir, 'node_modules/@happier-dev')]) {
      await mkdir(directory, {recursive:true});
    }
    await writeFile(join(cliDir, 'package.json'), JSON.stringify({name:'@happier-dev/cli',type:'module',
      dependencies:{'@happier-dev/plugin-sdk':'0.0.0'},bundledDependencies:['@happier-dev/plugin-sdk'],exports:{}}));
    await writeFile(join(cliDir, 'tsconfig.json'), '{}');
    await writeFile(join(cliDir, 'src/index.ts'), 'export const ready=true;');
    await writeFile(join(sdkDir, 'package.json'), JSON.stringify({name:'@happier-dev/plugin-sdk',version:'0.0.0',
      type:'module',main:'./dist/index.js',types:'./dist/index.d.ts',
      exports:{'.':{'happier-source':'./src/index.ts',types:'./dist/index.d.ts',default:'./dist/index.js'}},
      happier:{publicSdkRelease:{posture:'developer_preview'}}}));
    await writeFile(join(sdkDir, 'tsconfig.json'), JSON.stringify({compilerOptions:{target:'ES2022',
      module:'NodeNext',moduleResolution:'NodeNext',rootDir:'src',outDir:'dist',declaration:true},include:['src/**/*.ts']}));
    await writeFile(join(sdkDir, 'src/index.ts'), 'export const author=true;');
    await symlink(sdkDir, join(repoDir, 'node_modules/@happier-dev/plugin-sdk'));
    await symlink(dirname(createRequire(import.meta.url).resolve('esbuild/package.json')), join(cliDir, 'node_modules/esbuild'));
    const ready = fixture.path('active-compiler.json');
    const heldCompiler = fixture.path('held-compiler.mjs');
    // Only the external compiler tool is substituted. Keep source preparation,
    // admission and foreground process custody on their real internal paths.
    await writeFile(heldCompiler, `import {writeFileSync,renameSync} from 'node:fs';
      writeFileSync(${JSON.stringify(ready+'.tmp')},JSON.stringify({pid:process.pid}));
      renameSync(${JSON.stringify(ready+'.tmp')},${JSON.stringify(ready)});
      setInterval(()=>{},1000);`);
    const compilerPath = resolveTypeScriptCliInvocation({args:[]}).compilerPath;
    const observer = fixture.path('hold-compiler.mjs');
    await writeFile(observer, `import {createRequire,syncBuiltinESMExports} from 'node:module';
      const childProcess=createRequire(import.meta.url)('node:child_process');
      const spawn=childProcess.spawn;
      childProcess.spawn=function(command,args,...options) {
        return spawn.call(this,command,args?.map(arg=>arg===${JSON.stringify(compilerPath)}?${JSON.stringify(heldCompiler)}:arg),...options);
      };
      syncBuiltinESMExports();`);
    let compilerPid;
    context.after(() => {
      // A RED result must not leak this test's deliberately held OS process.
      if (compilerPid) {
        try { process.kill(compilerPid, 'SIGKILL'); }
        catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
    });
    const watcher = watch(fixture.root);
    context.after(() => watcher.close());
    const active = new Promise((resolve,reject) => {
      watcher.on('error',reject);
      watcher.on('change',(_event,filename) => { if (filename==='active-compiler.json') resolve(); });
    });
    const controller = new AbortController();
    await installSourcePreparationInputs(repoDir, 'daemon');
    const pending = buildSourceRuntimeBundle({repoDir,outputDir:fixture.path('output'),component:'daemon',
      signal:AbortSignal.any([controller.signal,context.signal]),env:{...process.env,
        NODE_OPTIONS:`${process.env.NODE_OPTIONS??''} --import=${pathToFileURL(observer).href}`.trim()}});
    const cancelled = assert.rejects(pending,{name:'AbortError'});
    await active;
    compilerPid = JSON.parse(await readFile(ready,'utf8')).pid;
    controller.abort();
    await cancelled;
    let alive = true;
    for (let attempt=0;attempt<100;attempt++) {
      try { alive=!(await readFile(`/proc/${compilerPid}/status`,'utf8')).match(/^State:\s+Z/m); }
      catch (error) { if (error.code!=='ENOENT') throw error; alive=false; }
      if (!alive) break;
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    assert.equal(alive,false,'the declaration compiler survived source preparation cancellation');
  });

for (const shared of [false,true]) test(`cancelling ${shared ? 'shared' : 'admitted'} source preparation retires its active worker and native service`,
  { skip: process.platform !== 'linux', timeout: 20000 }, async (context) => {
    const repoDir = await mkdtemp(join(tmpdir(), 'happier-source-cancel-'));
    let worker;
    context.after(async () => {
      // A failing cancellation assertion must not leave this fixture's real
      // builder/service alive. Authenticate its fixture command before killing.
      if(worker) {
        try {
          if((await readFile(`/proc/${worker.pid}/cmdline`,'utf8')).includes(repoDir)) process.kill(worker.pid,'SIGTERM');
        } catch(error) { if(error.code!=='ENOENT' && error.code!=='ESRCH') throw error; }
      }
      await makeFixtureWritable(repoDir);
      await rm(repoDir, {recursive:true,force:true});
    });
    const cliDir = join(repoDir, 'apps/cli');
    const locatorDir = join(cliDir, 'src/plugins/projection/registry/sources');
    await mkdir(locatorDir, { recursive: true });
    await mkdir(join(cliDir, 'node_modules'));
    await writeFile(join(cliDir, 'package.json'), JSON.stringify({ name: '@happier-dev/cli', type: 'module', exports: {} }));
    await writeFile(join(cliDir, 'tsconfig.json'), '{}');
    await writeFile(join(cliDir, 'src/index.ts'), 'export const ready=true;');
    await symlink(dirname(createRequire(import.meta.url).resolve('esbuild/package.json')), join(cliDir, 'node_modules/esbuild'));
    const ready = join(repoDir, 'active-worker.json');
    // The canonical locator transform has already started the real esbuild
    // service. Hold its fixture module so cancellation reaches an active build.
    await writeFile(join(locatorDir, 'generatedBundledPluginManifests.ts'), `
      import {writeFileSync,readFileSync,renameSync} from 'node:fs';
      setInterval(()=>{},1000);
      writeFileSync(${JSON.stringify(ready + '.tmp')},JSON.stringify({pid:process.pid,children:readFileSync('/proc/'+process.pid+'/task/'+process.pid+'/children','utf8').trim().split(/\\s+/).filter(Boolean).map(Number)}));
      renameSync(${JSON.stringify(ready + '.tmp')},${JSON.stringify(ready)});
      await new Promise(()=>{});
      export const BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS=[];
    `);
    const watcher = watch(repoDir);
    context.after(() => watcher.close());
    const active = new Promise((resolve, reject) => {
      watcher.on('error', reject);
      watcher.on('change', (_event, filename) => { if (filename === 'active-worker.json') resolve(); });
    });
    const controller = new AbortController();
    const native = await installSourceAdmissionFixture(repoDir);
    const pending = native.build({ repoDir,
      ...(shared ? {stackBaseDir:join(repoDir,'stacks/consumer')} : {outputDir:join(repoDir,'output')}),
      component:'daemon', env:native.env, signal:controller.signal });
    const cancelled = assert.rejects(pending, { name: 'AbortError' });
    await active;
    worker = JSON.parse(await readFile(ready, 'utf8'));
    assert.notEqual(worker.pid, process.pid);
    assert.ok(worker.children.length, 'the worker has started its real native service');
    controller.abort();
    await cancelled;
    // Wait only for the kernel to expose the already-requested child exit.
    for (const pid of [worker.pid, ...worker.children]) {
      let alive = true;
      for (let attempt = 0; attempt < 100; attempt++) {
        try { alive = !(await readFile(`/proc/${pid}/status`, 'utf8')).match(/^State:\s+Z/m); }
        catch (error) { if (error.code !== 'ENOENT') throw error; alive = false; }
        if (!alive) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(alive, false, `source preparation child ${pid} survived cancellation`);
    }
    if(shared) await assert.rejects(access(join(repoDir,'stacks/source-bundles/build.lock')),{code:'ENOENT'});
    assert.deepEqual(await readdir(join(native.admissionRoot,'owners')),[]);
    assert.deepEqual(await readdir(join(native.admissionRoot,'waiters')),[]);
    if(shared) {
      await writeFile(join(locatorDir,'generatedBundledPluginManifests.ts'),
        'export const BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS=[];');
      const replacement = await native.build({repoDir,stackBaseDir:join(repoDir,'stacks/consumer'),
        component:'daemon',env:native.env,signal:context.signal});
      assert.equal((await import(pathToFileURL(replacement.entrypoint))).ready,true);
      assert.equal((await readdir(join(repoDir,'stacks/source-bundles'))).filter(name=>/^(bundle|runtime)-/.test(name)).length,1,
        'a later publication reclaims the cancelled producer without reclaiming active producers');
    }
  });
