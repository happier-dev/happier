import { readSourceReloadRefusal, parseSourceReloadRefusalLine } from '../runtime/shared/source_reload_refusal.mjs';
import { projectStackReloadVerification } from '../stack/reload_verdict.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmod, cp, mkdtemp, mkdir, writeFile, readFile, realpath, rename, symlink, rm, access, readdir, stat, utimes, open } from 'node:fs/promises';
import fs, { existsSync, readFileSync, watch } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createHash } from 'node:crypto';
import { withPatchedProcessEnv } from '../testkit/core/env_scope.mjs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { createServer } from 'node:http';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildSourceRuntimeBundle as buildSourceRuntimeBundleOwner, captureSourceWebBuildInputs, admitSourceRuntimeReload, setBundleReadOnly, withSourceBundlePublication } from './build_source_runtime.mjs';
import { beginPendingSourceStart } from '../runtime/shared/pending_source_start.mjs';
import { prepareSourceRuntimeReload } from '../runtime/launch/prepareSourceRuntimeReload.mjs';
import { prepareSourceComponent, resolveSourceComponentWatchPaths } from '../utils/dev/devReloadCoordinator.mjs';
import { runSourceBuildCommand } from '../utils/proc/runSourceBuildCommand.mjs';
import { applyServerHostDatabaseProviderEnv } from '../utils/server/apply_runtime_server_database_env.mjs';
import { createTempFixture } from '../testkit/core/temp_fixture.mjs';
import { installSourceAdmissionFixture, installSourcePreparationInputs, sourceProducerFixtureOptions } from '../testkit/core/source_runtime_fixture.mjs';
import { buildNativeAdmissionFixtureEnv, holdNativeAdmissionFixtureMemory, installNativeAdmissionFixture } from '../testkit/core/native_admission_fixture.mjs';
import { relocateSourceOwnerImports } from '../testkit/core/source_web_fixture.mjs';
import { runServerRuntimeMigration } from '../runtime/launch/runServerRuntimeMigration.mjs';
import { resolveServerRuntimeLaunchSpec } from '../runtime/launch/resolveServerRuntimeLaunchSpec.mjs';
import { resolveCliRuntimeLaunchSpec } from '../runtime/launch/resolveCliRuntimeLaunchSpec.mjs';
import { prepareDevDaemonSourceRuntime, startDevDaemon } from '../utils/dev/daemon.mjs';
import { buildStackServerProfileSetArgs } from '../utils/stack/server_profile_reconciliation.mjs';
import { appendBoundedTail, run } from '../utils/proc/proc.mjs';
import { matchesNativeTypeScriptInputVersion, resolveTypeScriptCliInvocation } from '../../../../scripts/workspaces/resolveTypeScriptCliInvocation.mjs';
import { resolveWorkspaceBundleLockPath, withWorkspaceBundleLock, isWorkspaceBundleLockActive } from '../../../../packages/cli-common/workspaceBundleLock.mjs';
import { isJsonOwnerFileLockActive } from '../utils/proc/jsonOwnerFileLock.mjs';
import { readWorkspaceBuildInputs, readSourceComponentBuildInputs } from '../utils/fs/workspaceBuildInputs.mjs';
import { readCliSourceEntries, readWorkspacePackages, createWorkspaceSourceResolver } from '../../../../packages/cli-common/sourceRuntimeEntries.mjs';
import { captureBuildInputFiles, readBuildInputDependencies, withBuildInputDependencies } from '../../../../scripts/workspaces/buildInputConvergence.mjs';
import { markDependencyMutation, resolveDependencyRefreshLockPath, resolveDependencyRefreshMarkerPath, withDependencyRefresh } from '../utils/proc/dependency_refresh.mjs';

// This suite owns compiler/cache behavior. Name the requested fixture Stack as
// producer; adoption-only QA requests live in source_runtime_producer.test.mjs.
const buildSourceRuntimeBundle = options => buildSourceRuntimeBundleOwner(sourceProducerFixtureOptions(options));

test('source launch waits for an active dependency writer, loads its bundled guard and preserves cancellation', async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-source-launch-writer-' });
  const repoDir = fixture.path('repo');
  const cliDir = fixture.path('runtime/apps/cli');
  const entrypoint = join(cliDir, 'src/index.mjs');
  const markerPath = join(repoDir, 'node_modules/.happier-stack-dependencies-ready');
  const env = { ...process.env, HAPPIER_STACK_HOME_DIR: fixture.path('home') };
  await mkdir(dirname(markerPath), { recursive: true });
  await mkdir(join(repoDir, 'apps'), { recursive: true });
  await symlink(fileURLToPath(new URL('../../', import.meta.url)), join(repoDir, 'apps/stack'),
    process.platform === 'win32' ? 'junction' : 'dir');
  await writeFile(join(repoDir, 'package.json'), JSON.stringify({ private: true, workspaces: ['apps/*'] }));
  await mkdir(dirname(entrypoint), { recursive: true });
  await writeFile(entrypoint, 'process.stdout.write("launched");');
  await writeFile(markerPath, JSON.stringify({ identity: 'same-content' }));
  const generationPath = `${resolveDependencyRefreshLockPath(repoDir, env)}.generation`;
  await mkdir(dirname(generationPath), { recursive: true });
  await writeFile(generationPath, JSON.stringify({ generation: 'before', completedGeneration: 'before' }));
  await writeFile(fixture.path('runtime/source-bundle.json'), JSON.stringify({
    dependencyPublication: { identity: 'same-content', writerActive: false, markerPath, generationPath },
  }));
  // Exercise the emitted dynamic-import path as consumed by a bundled daemon,
  // while the real writer is active, without mutating installed dependencies.
  const compiledGuard = fixture.path('compiled-guard.mjs');
  const { build } = createRequire(new URL('../../../cli/package.json', import.meta.url))('esbuild');
  await build({ stdin: { contents: `
    import { assertSourceRuntimeDependenciesCurrent } from ${JSON.stringify(fileURLToPath(new URL('../../../../packages/cli-common/sourceRuntimeDependencies.mjs', import.meta.url)))};
    process.stderr.write('guard-started');
    await assertSourceRuntimeDependenciesCurrent({ entrypoint: ${JSON.stringify(entrypoint)} });
    process.stdout.write('launched');
  `, resolveDir: fixture.root }, outfile: compiledGuard, bundle: true, platform: 'node', format: 'esm' });
  let release, started;
  const released = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { started = resolve; });
  const writer = withDependencyRefreshLock({ installDir: repoDir, env }, async () => {
    await markDependencyMutation({ installDir: repoDir, env });
    started();
    await released;
  });
  await ready;
  const bundledChild = promisify(execFile)(process.execPath, [compiledGuard], { env, signal: t.signal });
  void bundledChild.catch(() => {});
  const bundledStarted = new Promise((resolve, reject) => {
    bundledChild.child.stderr.once('data', resolve);
    bundledChild.child.once('error', reject);
  });
  let settled = false;
  const launch = Promise.resolve().then(async () => await resolveCliRuntimeLaunchSpec({
    sourceRuntimeLaunch: { cliDir, entrypoint, env },
  }));
  void launch.then(() => { settled = true; }, () => { settled = true; });
  try {
    await bundledStarted;
    await new Promise(setImmediate);
    assert.equal(settled, false, 'active dependency writer must delay launch rather than refuse it');
  } finally { release(); await writer; }
  assert.equal((await bundledChild).stdout, 'launched');
  const spec = await launch;
  const child = await promisify(execFile)(spec.command, spec.args, { cwd: spec.cliDir, env });
  assert.equal(child.stdout, 'launched');

  let releaseCancelled, startedCancelled;
  const cancelledRelease = new Promise(resolve => { releaseCancelled = resolve; });
  const cancelledReady = new Promise(resolve => { startedCancelled = resolve; });
  const cancelledWriter = withDependencyRefreshLock({ installDir: repoDir, env }, async () => {
    await markDependencyMutation({ installDir: repoDir, env });
    startedCancelled();
    await cancelledRelease;
  });
  await cancelledReady;
  const controller = new AbortController();
  const cancelledLaunch = resolveCliRuntimeLaunchSpec({ sourceRuntimeLaunch: { cliDir, entrypoint, env }, signal: controller.signal });
  const reason = new Error('launch superseded');
  try {
    await new Promise(setImmediate);
    controller.abort(reason);
    await assert.rejects(cancelledLaunch, error => error === reason);
  } finally { releaseCancelled(); await cancelledWriter; }
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

test('selected source runtime refuses refreshed dependencies before probing its removed imports', async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-runtime-stale-dependencies-' });
  const repoDir = fixture.path('repo');
  const stackBaseDir = fixture.path('stacks/consumer');
  const outputDir = fixture.path('stacks/source-bundles/runtime-selected');
  const runtimeDir = join(outputDir, 'apps/cli');
  const entrypoint = join(runtimeDir, 'src/index.mjs');
  const markerPath = join(repoDir, 'node_modules/.happier-stack-dependencies-ready');
  const witness = fixture.path('import-probed');
  await mkdir(dirname(entrypoint), { recursive: true });
  await mkdir(dirname(markerPath), { recursive: true });
  await mkdir(join(stackBaseDir, 'source-runtime'), { recursive: true });
  const env = { ...process.env, HAPPIER_STACK_HOME_DIR: fixture.path('home') };
  await writeFile(markerPath, JSON.stringify({ identity: 'installed-before-refresh' }));
  const dependencyPublication = { ...await readBuildInputDependencies({ sourceDir: repoDir, env }),
    markerPath, generationPath: `${resolveDependencyRefreshLockPath(repoDir, env)}.generation` };
  await writeFile(entrypoint, `import { writeFileSync } from 'node:fs';
    writeFileSync(${JSON.stringify(witness)}, 'probed');`);
  await writeFile(join(outputDir, 'source-bundle.json'), JSON.stringify({
    identity: 'selected-runtime', entrypoint, runtimeDir, cliDir: runtimeDir, dependencyPublication,
  }));
  const selected = JSON.stringify({ entrypoint });
  await writeFile(join(stackBaseDir, 'source-runtime/selected-daemon.json'), selected);
  const options = { repoDir, stackBaseDir, component: 'daemon', env, reuseSelected: true };
  assert.equal((await buildSourceRuntimeBundle(options)).entrypoint, entrypoint);
  await rm(witness);

  // A completed reinstall with the same dependency content does not invalidate
  // the graph. An unfinished refresh still cannot be consumed during launch.
  await mkdir(dirname(dependencyPublication.generationPath), { recursive: true });
  await writeFile(dependencyPublication.generationPath, JSON.stringify({
    generation: 'same-content-reinstall', completedGeneration: 'same-content-reinstall',
  }));
  const retained = await buildSourceRuntimeBundle(options);
  assert.equal((await resolveCliRuntimeLaunchSpec({ sourceRuntimeLaunch: retained })).entrypoint, entrypoint);
  await rm(witness);
  await writeFile(dependencyPublication.generationPath, JSON.stringify({
    generation: 'unfinished-refresh', completedGeneration: 'same-content-reinstall',
  }));
  await assert.rejects(buildSourceRuntimeBundle(options), { code: 'SOURCE_RUNTIME_RELOAD_REQUIRED' });
  await writeFile(dependencyPublication.generationPath, JSON.stringify({
    generation: 'unfinished-refresh', completedGeneration: 'unfinished-refresh',
  }));

  // The same consumed module was moved by the dependency publisher. The
  // preparation identity must refuse before a fresh process links that import.
  await writeFile(markerPath, JSON.stringify({ identity: 'installed-after-refresh' }));
  await writeFile(entrypoint, 'import "./removed-dependency.mjs";');
  await assert.rejects(buildSourceRuntimeBundle(options), {
    code: 'SOURCE_RUNTIME_RELOAD_REQUIRED', phase: 'dependencies', retryable: false,
  });
  await assert.rejects(readFile(witness), { code: 'ENOENT' });
  const refusal = JSON.parse(await readFile(join(stackBaseDir, 'source-runtime/reload.json'), 'utf8'));
  assert.equal(refusal.code, 'SOURCE_RUNTIME_RELOAD_REQUIRED');
  assert.equal(refusal.phase, 'dependencies');
  assert.equal(await readFile(join(stackBaseDir, 'source-runtime/selected-daemon.json'), 'utf8'), selected);
  // A retained source capture without its publication binding cannot attest
  // freshness either; only an explicit reload can prepare that older graph.
  await writeFile(join(outputDir, 'source-bundle.json'), JSON.stringify({
    identity: 'older-runtime', entrypoint, runtimeDir, cliDir: runtimeDir,
  }));
  await assert.rejects(buildSourceRuntimeBundle(options), { code: 'SOURCE_RUNTIME_RELOAD_REQUIRED' });
});

test('dependency publication rejects source completion before writing or selecting a spanned graph', async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-runtime-dependency-publication-', registerCleanup: false });
  t.after(async () => { await makeFixtureWritable(fixture.root); await fixture.cleanup(); });
  const repoDir = fixture.path('repo');
  const stackBaseDir = fixture.path('stacks/consumer');
  const outputDir = fixture.path('stacks/source-bundles/runtime-candidate');
  await mkdir(repoDir);
  await mkdir(outputDir, { recursive: true });
  const env = { ...process.env, HAPPIER_STACK_HOME_DIR: fixture.path('home') };
  const generationPath = `${resolveDependencyRefreshLockPath(repoDir, env)}.generation`;
  await mkdir(dirname(generationPath), { recursive: true });
  let published = false;
  await assert.rejects(withBuildInputDependencies({ sourceDir: repoDir, env }, async (_env, publication) => {
    await writeFile(generationPath, JSON.stringify({ generation: 'writer-started-and-failed' }));
    return await withSourceBundlePublication({ stackBaseDir, outputDir, dependencySourceDir: repoDir, dependencyEnv: env,
      record: { component: 'server', dependencyPublication: publication?.state } }, async () => { published = true; });
  }), { code: 'BUILD_INPUTS_CHANGED' });
  assert.equal(published, false);
  await assert.rejects(readFile(join(outputDir, 'source-bundle.json')), { code: 'ENOENT' });
});

test('reload recaptures retryable dependency drift before activating the replacement', { skip: process.platform !== 'linux' }, async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-reload-dependency-recapture-', registerCleanup: false });
  t.after(async () => { await makeFixtureWritable(fixture.root); await fixture.cleanup(); });
  const repoDir = await createReloadDaemonRepo(fixture, 'export const ready = true;');
  const native = await installSourceAdmissionFixture(fixture.root);
  const env = { ...process.env, ...native.env, HAPPIER_STACK_HOME_DIR: fixture.path('home'),
    HAPPIER_STACK_DAEMON: '1', HAPPIER_SERVER_URL: 'http://fixture.invalid' };
  const generationPath = `${resolveDependencyRefreshLockPath(repoDir, env)}.generation`;
  await mkdir(dirname(generationPath), { recursive: true });
  await writeFile(generationPath, JSON.stringify({ generation: 'initial', completedGeneration: 'initial' }));
  const witness = fixture.path('drifted-once');
  await writeFile(join(repoDir, 'apps/cli/src/index.ts'), `import { existsSync, writeFileSync } from 'node:fs';
    if (!existsSync(${JSON.stringify(witness)})) {
      writeFileSync(${JSON.stringify(witness)}, 'drifted');
      writeFileSync(${JSON.stringify(generationPath)}, JSON.stringify({ generation: 'replacement', completedGeneration: 'replacement' }));
    }
    export const ready = true;`);
  const stackBaseDir = fixture.path('stacks/consumer');
  await native.prepareReload({ stackName: 'consumer', repoDir, stackBaseDir, env, onHost: true,
    args: ['--no-server', '--no-ui', `--source-after=${new Date().toISOString()}`] });
  assert.equal(await readFile(witness, 'utf8'), 'drifted');
  const selected = JSON.parse(await readFile(join(stackBaseDir, 'source-runtime/selected-daemon.json'), 'utf8'));
  assert.equal((await import(pathToFileURL(selected.entrypoint))).ready, true);
});

test('dependency drift preserves its refusal while removing read-only captured author packages', { skip: process.platform !== 'linux' }, async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-runtime-readonly-refusal-', registerCleanup: false });
  t.after(async () => { await makeFixtureWritable(fixture.root); await fixture.cleanup(); });
  const repoDir = await createReloadDaemonRepo(fixture, 'export const ready = true;');
  const native = await installSourceAdmissionFixture(fixture.root);
  const env = { ...process.env, ...native.env, HAPPIER_STACK_HOME_DIR: fixture.path('home') };
  const generationPath = `${resolveDependencyRefreshLockPath(repoDir, env)}.generation`;
  await mkdir(dirname(generationPath), { recursive: true });
  await writeFile(generationPath, JSON.stringify({ generation: 'initial', completedGeneration: 'initial' }));
  const outputDir = fixture.path('runtime');
  const authorPackage = join(outputDir, 'apps/cli/authoring/node_modules/@happier-dev/brand/dist');
  // The real runtime probe observes an installed-input writer after compilation.
  await writeFile(join(repoDir, 'apps/cli/src/index.ts'), `import { writeFileSync, mkdirSync, chmodSync } from 'node:fs';
    const root = ${JSON.stringify(authorPackage)};
    mkdirSync(root + '/.happier-source', { recursive: true });
    writeFileSync(root + '/.happier-source/input.ts', 'export const captured = true;');
    chmodSync(root + '/.happier-source', 0o555); chmodSync(root, 0o555);
    const generation = 'changed-' + Date.now();
    writeFileSync(${JSON.stringify(generationPath)}, JSON.stringify({ generation, completedGeneration: generation }));
    export const ready = true;`);
  await assert.rejects(native.build({ repoDir, outputDir, component: 'daemon', env, waitForSourceChanges: false }), { code: 'BUILD_INPUTS_CHANGED' });
  await assert.rejects(access(outputDir), { code: 'ENOENT' });
});

test('source runtime reload rebuilds a dependency capture after published content changes', async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-runtime-refresh-recovery-', registerCleanup: false });
  t.after(async () => { await makeFixtureWritable(fixture.root); await fixture.cleanup(); });
  const repoDir = await createReloadDaemonRepo(fixture, 'export const ready = true;');
  const native = process.platform === 'linux' ? await installSourceAdmissionFixture(fixture.root) : null;
  const env = { ...process.env, ...native?.env, HAPPIER_STACK_HOME_DIR: fixture.path('home') };
  const options = { repoDir, stackBaseDir: fixture.path('stacks/consumer'), component: 'daemon', env,
    waitForSourceChanges: false };
  const build = native?.build ?? buildSourceRuntimeBundle;
  const first = await build(options);
  const generationPath = `${resolveDependencyRefreshLockPath(repoDir, env)}.generation`;
  await mkdir(dirname(generationPath), { recursive: true });
  await mkdir(dirname(first.dependencyPublication.markerPath), { recursive: true });
  await writeFile(first.dependencyPublication.markerPath, JSON.stringify({ identity: 'changed-dependency-content' }));
  await writeFile(generationPath, JSON.stringify({ generation: 'completed-refresh', completedGeneration: 'completed-refresh' }));
  const second = await build(options);
  assert.notEqual(second.entrypoint, first.entrypoint, 'reload must replace the old installed-tree binding');
  assert.equal((await import(pathToFileURL(second.entrypoint))).ready, true);
  assert.equal((await build({ ...options, reuseSelected: true })).entrypoint, second.entrypoint);
});

test('source runtime reload repairs an older selected dependency capture before launch', async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-runtime-older-capture-', registerCleanup: false });
  t.after(async () => { await makeFixtureWritable(fixture.root); await fixture.cleanup(); });
  const repoDir = await createReloadDaemonRepo(fixture, 'export const ready = true;');
  const native = process.platform === 'linux' ? await installSourceAdmissionFixture(fixture.root) : null;
  const env = { ...process.env, ...native?.env, HAPPIER_STACK_HOME_DIR: fixture.path('home') };
  const options = { repoDir, stackBaseDir: fixture.path('stacks/consumer'), component: 'daemon', env,
    waitForSourceChanges: false };
  const build = native?.build ?? buildSourceRuntimeBundle;
  const first = await build(options);
  const outputDir = resolve(dirname(first.entrypoint), '../../..');
  const recordPath = join(outputDir, 'source-bundle.json');
  await setBundleReadOnly(outputDir, false);
  const record = JSON.parse(await readFile(recordPath, 'utf8'));
  delete record.dependencyPublication.markerPath;
  delete record.dependencyPublication.generationPath;
  await writeFile(recordPath, JSON.stringify(record));
  await setBundleReadOnly(outputDir, true);

  // Reading an incumbent also serves recovery. Only consuming its graph may
  // refuse; explicit reload must replace the pre-locator completion instead.
  const refreshed = await build(options);
  const launch = await resolveCliRuntimeLaunchSpec({ sourceRuntimeLaunch: refreshed });
  assert.equal(launch.entrypoint, refreshed.entrypoint);
  assert.equal((await import(pathToFileURL(launch.entrypoint))).ready, true);
  assert.equal((await build({ ...options, reuseSelected: true })).entrypoint, refreshed.entrypoint);
  const freshRecord = JSON.parse(await readFile(join(resolve(dirname(refreshed.entrypoint), '../../..'), 'source-bundle.json'), 'utf8'));
  assert.equal(typeof freshRecord.dependencyPublication.markerPath, 'string');
  assert.equal(typeof freshRecord.dependencyPublication.generationPath, 'string');
});

test('dependency publication preserves a preexisting private output when rejected consumption overlaps a writer', async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-runtime-dependency-unowned-' });
  const repoDir = fixture.path('repo');
  const server = join(repoDir, 'apps/server');
  const outputDir = fixture.path('output');
  await mkdir(join(server, 'sources'), { recursive: true });
  await mkdir(join(server, 'scripts'));
  await mkdir(join(server, 'node_modules'));
  await mkdir(outputDir);
  await writeFile(join(server, 'package.json'), JSON.stringify({ name: '@happier-dev/server', type: 'module' }));
  await writeFile(join(server, 'tsconfig.json'), '{}');
  await writeFile(join(server, 'sources/main.light.ts'), 'export const ready = true;');
  await writeFile(join(server, 'scripts/migrate.sqlite.deploy.ts'), 'export async function runSqliteMigrationDeploy() {}');
  await symlink(dirname(createRequire(import.meta.url).resolve('esbuild/package.json')), join(server, 'node_modules/esbuild'),
    process.platform === 'win32' ? 'junction' : 'dir');
  await writeFile(join(outputDir, 'sentinel'), 'preexisting output');
  const env = { ...process.env, HAPPIER_STACK_HOME_DIR: fixture.path('home') };
  const generationPath = `${resolveDependencyRefreshLockPath(repoDir, env)}.generation`;
  await mkdir(dirname(generationPath), { recursive: true });
  await writeFile(generationPath, JSON.stringify({ generation: 'before' }));
  const observer = fixture.path('observe-output.mjs');
  // Instrument real directory reads at the OS boundary. Both attempts still
  // observe and reject the same caller-owned nonempty output directory.
  await writeFile(observer, `
    import fs from 'node:fs/promises';
    import { syncBuiltinESMExports } from 'node:module';
    import { resolve } from 'node:path';
    const readdir = fs.readdir;
    fs.readdir = async (...args) => {
      const result = await readdir(...args);
      if (resolve(String(args[0])) === ${JSON.stringify(outputDir)})
        await fs.writeFile(${JSON.stringify(generationPath)}, JSON.stringify({ generation: 'overlapping-writer' }));
      return result;
    };
    syncBuiltinESMExports();
  `);
  await assert.rejects(buildSourceRuntimeBundle({ repoDir, outputDir, component: 'server',
    env: { ...env, NODE_OPTIONS: `${env.NODE_OPTIONS ?? ''} --import=${pathToFileURL(observer).href}`.trim() } }), /Source preparation failed/);
  assert.equal(await readFile(join(outputDir, 'sentinel'), 'utf8'), 'preexisting output');
});

test('dependency publication source worker discards an emitted graph across the real process boundary', async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-runtime-dependency-worker-' });
  const repoDir = fixture.path('repo');
  const server = join(repoDir, 'apps/server');
  await mkdir(join(server, 'sources'), { recursive: true });
  await mkdir(join(server, 'scripts'));
  await mkdir(join(server, 'node_modules/esbuild'), { recursive: true });
  await writeFile(join(server, 'package.json'), JSON.stringify({ name: '@happier-dev/server', type: 'module' }));
  await writeFile(join(server, 'tsconfig.json'), '{}');
  await writeFile(join(server, 'sources/main.light.ts'), 'export const ready = true;');
  await writeFile(join(server, 'scripts/migrate.sqlite.deploy.ts'), 'export async function runSqliteMigrationDeploy() {}');
  const env = { ...process.env, HAPPIER_STACK_HOME_DIR: fixture.path('home') };
  const generationPath = `${resolveDependencyRefreshLockPath(repoDir, env)}.generation`;
  await mkdir(dirname(generationPath), { recursive: true });
  await writeFile(generationPath, JSON.stringify({ generation: 'before' }));
  const emissions = fixture.path('emissions.json');
  const writerStarted = fixture.path('writer-started');
  await writeFile(join(server, 'node_modules/esbuild/package.json'), JSON.stringify({ name: 'esbuild', main: './index.cjs' }));
  // Instrument the genuine external compiler boundary and still execute its
  // real build. The one failed-writer generation occurs inside its first read.
  await writeFile(join(server, 'node_modules/esbuild/index.cjs'), `
    const fs = require('node:fs');
    const compiler = require(${JSON.stringify(createRequire(import.meta.url).resolve('esbuild'))});
    module.exports = { ...compiler, async build(options) {
      const count = fs.existsSync(${JSON.stringify(emissions)}) ? JSON.parse(fs.readFileSync(${JSON.stringify(emissions)}, 'utf8')) : 0;
      fs.writeFileSync(${JSON.stringify(emissions)}, JSON.stringify(count + 1));
      if (!fs.existsSync(${JSON.stringify(writerStarted)})) {
        fs.writeFileSync(${JSON.stringify(writerStarted)}, 'started');
        fs.writeFileSync(${JSON.stringify(generationPath)}, JSON.stringify({ generation: 'failed-writer' }));
      }
      return await compiler.build(options);
    } };
  `);
  const outputDir = fixture.path('output');
  const built = await buildSourceRuntimeBundle({ repoDir, outputDir, component: 'server', env });
  assert.equal(JSON.parse(await readFile(emissions, 'utf8')), 2, 'one spanned emission requires exactly one rebuild');
  assert.equal((await import(pathToFileURL(built.entrypoint))).ready, true);
  const completed = JSON.parse(await readFile(join(outputDir, 'source-bundle.json'), 'utf8'));
  assert.equal(completed.dependencyPublication.generation, 'failed-writer');
});
import { withDependencyRefreshLock } from '../utils/proc/dependency_refresh.mjs';
import { withJsonOwnerFileLock } from '../utils/proc/jsonOwnerFileLock.mjs';
import { startDevServer, createDevServerReloadExecutor } from '../utils/dev/server.mjs';
import { resolveHeavyweightMemoryFloorKiB } from '../utils/dev_targets/remote_commands.mjs';
import { execPnpm } from '../../../../scripts/workspaces/execPnpmCommand.mjs';

test('publication reaps superseded private web exports and preserves selected, last green, pending and running stacks',
  { skip: process.platform !== 'linux' }, async t => {
    const { root } = await createTempFixture(t, { prefix: 'hstack-private-source-retention-' });
    const stacksRoot = join(root, 'stacks');
    await mkdir(join(stacksRoot, 'source-bundles'), { recursive: true });
    const stopped = join(stacksRoot, 'stopped');
    const running = join(stacksRoot, 'running');
    const pending = join(stacksRoot, 'pending');
    const old = new Date(Date.now() - 72 * 3600000);
    const newer = new Date(Date.now() - 48 * 3600000);
    for (const [stack, names] of [[stopped, ['web-obsolete', 'web-selected', 'web-green', 'web-held', 'web-incomplete']],
      [running, ['web-old', 'web-green']], [pending, ['web-preparing', 'web-green']]]) {
      for (const name of names) {
        const directory = join(stack, 'source-runtime', name);
        await mkdir(join(directory, 'export'), { recursive: true });
        await writeFile(join(directory, 'export/index.html'), name === 'web-incomplete'
          ? '<script src="missing.js"></script>' : '<!doctype html>');
        const when = name === 'web-incomplete' ? new Date(newer.getTime() + 3600000)
          : name === 'web-green' ? newer : old;
        for (const path of [join(directory, 'export/index.html'), join(directory, 'export'), directory]) {
          await utimes(path, when, when);
        }
      }
    }
    await writeFile(join(stopped, 'source-runtime/selected-ui.json'), JSON.stringify({
      uiDir: join(stopped, 'source-runtime/web-selected/export'),
    }));
    await writeFile(join(running, 'stack.runtime.json'), JSON.stringify({ ownerPid: process.pid }));
    await writeFile(join(pending, 'source-runtime/start.pending.json'), JSON.stringify({ pid: process.pid }));
    const selection = await readFile(join(stopped, 'source-runtime/selected-ui.json'), 'utf8');
    const held = await open(join(stopped, 'source-runtime/web-held/export/index.html'));
    t.after(() => held.close());
    await withSourceBundlePublication({ stackBaseDir: stopped }, async () => {});
    await assert.rejects(access(join(stopped, 'source-runtime/web-obsolete')), { code: 'ENOENT' });
    for (const path of [join(stopped, 'source-runtime/web-selected'), join(stopped, 'source-runtime/web-green'),
      join(stopped, 'source-runtime/web-held'), join(running, 'source-runtime/web-old'),
      join(pending, 'source-runtime/web-preparing')]) await access(path);
    await assert.rejects(access(join(stopped, 'source-runtime/web-incomplete')), { code: 'ENOENT' });
    assert.equal(await readFile(join(stopped, 'source-runtime/selected-ui.json'), 'utf8'), selection);
    const late = join(stopped, 'source-runtime/web-late/export');
    await mkdir(late, { recursive: true });
    await writeFile(join(late, 'index.html'), '<!doctype html>');
    for (const path of [join(late, 'index.html'), late, dirname(late)]) await utimes(path, old, old);
    const originalRead = fs.readFileSync;
    let activated = false;
    // The procfs read is the OS boundary: another Stack starts after
    // nomination but before the reaper's final ownership/reference check.
    t.mock.method(fs, 'readFileSync', (path, ...args) => {
      if (!activated && typeof path === 'string' && path.startsWith('/proc/') && path.endsWith('/environ')) {
        activated = true;
        fs.writeFileSync(join(stopped, 'stack.runtime.json'), JSON.stringify({ ownerPid: process.pid }));
      }
      return originalRead(path, ...args);
    });
    syncBuiltinESMExports();
    t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
    await withSourceBundlePublication({ stackBaseDir: stopped }, async () => {});
    assert.equal(activated, true);
    await access(late);
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
    const channelsEntry = channels.files.find(file => file.relativePath.endsWith('/entry.cjs.bundle'));
    const channelsPath = [...readFileSync(inventoryPath, 'utf8').matchAll(/require\(("(?:[^"\\]|\\.)*")\)/g)]
      .map(match => JSON.parse(match[1])).find(path => path.replaceAll('\\', '/').endsWith(`/${channelsEntry.relativePath}`));
    assert.ok(channelsPath);
    // Execute the emitted CommonJS module with real Node globals. A partial VM
    // realm lacks structuredClone, while borrowing it creates foreign objects.
    const contract = require(channelsPath).renderSurface();
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
  await t.test('a failed manifest keeps last-green UI and heals through the existing Metro change feed', async () => {
    const { resolveBundledPluginUiArtifactsRetainedRoots } = await import(pathToFileURL(join(uiPackageDir, 'scripts/generateBundledPluginUiArtifacts.mjs')));
    const { WORKSPACE_PACKAGE_BUILD_INPUT_RECORD } = await import('../../../../packages/cli-common/packageBuildOutputTargets.mjs');
    const retainedRoot = resolveBundledPluginUiArtifactsRetainedRoots(inventoryPath).get('happier.inspector');
    await rm(join(retainedRoot, WORKSPACE_PACKAGE_BUILD_INPUT_RECORD));
    const incumbent = consumeInventory().find(entry => entry.artifactId === 'inspector-app-native');
    const diagnostics = [];
    const writeStderr = process.stderr.write;
    t.mock.method(process.stderr, 'write', function(chunk, ...args) {
      diagnostics.push(String(chunk));
      return Reflect.apply(writeStderr, this, [chunk, ...args]);
    });
    const manifestPath = join(repoRoot, 'packages/plugins/inspector/src/manifest.ts');
    const manifest = await readFile(manifestPath, 'utf8');
    await writeFile(manifestPath, 'throw new Error("live manifest dependency unavailable");\n' + manifest);
    await writeFile(join(repoRoot, 'packages/plugins/channels/src/ui/renderSurface.tsx'),
      'export function renderSurface() { return "healthy-during-failure"; }');
    await t.waitFor(() => {
      assert.ok(diagnostics.some(line => line.includes('live manifest dependency unavailable') && line.includes('serving last-green UI')));
      const entries = consumeInventory();
      assert.equal(entries.find(entry => entry.artifactId === 'inspector-app-native').artifactGraph.digest, incumbent.artifactGraph.digest);
      assert.ok(entries.find(entry => entry.artifactId === 'channels-app-native').files.some(file => file.asset.includes('healthy-during-failure')));
    }, { timeout: 120_000, interval: 100 });
    await writeFile(manifestPath, manifest);
    await writeFile(source, 'export function renderSurface() { return "live-manifest-healed"; }');
    await t.waitFor(() => assert.ok(consumeInventory().find(entry => entry.artifactId === 'inspector-app-native')
      .files.some(file => file.asset.includes('live-manifest-healed'))), { timeout: 120_000, interval: 100 });
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
  // Selection reads acquire publication custody themselves. Hold only the
  // workspace compilation lock while proving the retained runtime can start.
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
    await assert.rejects(executor.build(), { code: 'source_runtime_producer_failed' });
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
    plugins.push({ directory, manifest: { schemaVersion: 2, id: `happier.${directory}`, version: '0.0.0',
      displayName: directory, runtime: { apiVersion: 1 }, contributes: {
      ui: { renderers: [{ id: 'panel', kind: 'reactNative', artifact: 'panel' }] },
    } } });
  }
  const entry = directory => join(repoRoot, 'packages/plugins', directory, 'src/panel.ts');
  return { fixture, repoRoot, plugins, entry };
}

test('source UI repair watcher observes the preparation launcher and source loader inputs', async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-ui-repair-inputs-' });
  const owners = ['apps/stack/scripts/build/build_source_web_ui.mjs', 'packages/cli-common/registerSourceRuntime.mjs'];
  for (const owner of owners) {
    await mkdir(dirname(fixture.path(owner)), { recursive: true });
    await writeFile(fixture.path(owner), 'export const source = true;');
  }
  const { readSourcePluginUiBuildInputs } = await import('../utils/fs/workspaceBuildInputs.mjs');
  const compiler = await readSourcePluginUiBuildInputs({ repoDir: fixture.root, compiler: true, includeDirectories: true });
  for (const owner of owners) {
    assert.ok(compiler.includes(owner), `${owner} repairs must trigger the existing source inventory watcher`);
  }
});

test('source plugin UI preparation uses source-only SDK and Protocol exports despite stale dist', async t => {
  const sourceRepo = fileURLToPath(new URL('../../../../', import.meta.url));
  const fixture = await createTempFixture(t, { prefix: 'happier-plugin-ui-source-exports-' });
  const repoRoot = fixture.path('repo');
  await captureSourceWebBuildInputs({ repoDir: sourceRepo, outputDir: repoRoot });
  await cp(join(sourceRepo, 'apps/stack/bin'), join(repoRoot, 'apps/stack/bin'), { recursive: true });
  const cliPath = join(repoRoot, 'apps/cli/package.json');
  const cli = JSON.parse(await readFile(cliPath, 'utf8'));
  await writeFile(cliPath, JSON.stringify({ ...cli, bundledDependencies: ['@happier-dev/plugins-inspector'] }));
  for (const directory of ['plugin-sdk', 'protocol']) {
    const packageRoot = join(repoRoot, 'packages', directory);
    const packagePath = join(packageRoot, 'package.json');
    const manifest = JSON.parse(await readFile(packagePath, 'utf8'));
    manifest.exports['./uiartsrc-evidence'] = {
      'happier-source': './src/uiartsrc-evidence.ts', default: './dist/uiartsrc-evidence.js',
    };
    manifest.exports['./uiartsrc-evidence-leaf'] = {
      'happier-source': './src/uiartsrc-evidence-leaf.ts', default: './dist/uiartsrc-evidence.js',
    };
    await writeFile(packagePath, JSON.stringify(manifest));
    await mkdir(join(packageRoot, 'dist'), { recursive: true });
    await writeFile(join(packageRoot, 'dist/uiartsrc-evidence.js'), 'export const stale = true;');
    // The live Expo cwd has declaration-only SDK paths. tsx can map these
    // declarations to their stale JS siblings inside a synchronous graph.
    await mkdir(join(packageRoot, 'dist/uiartsrc-evidence-leaf'), { recursive: true });
    await writeFile(join(packageRoot, 'dist/uiartsrc-evidence-leaf/index.d.ts'), 'export declare const stale: boolean;');
    await writeFile(join(packageRoot, 'dist/uiartsrc-evidence-leaf/index.js'), 'export const stale = true;');
    await writeFile(join(packageRoot, 'src/uiartsrc-evidence-leaf.ts'), 'export const sourceEvidence = "source-' + directory + '";');
    // ESM loader hooks do not govern Node's synchronous require(esm) graph.
    // The source child must select the same condition for that path too.
    await writeFile(join(packageRoot, 'src/uiartsrc-evidence.ts'),
      'import { createRequire } from "node:module";\n'
      + `const leaf = createRequire(import.meta.url)("${manifest.name}/uiartsrc-evidence-leaf");\n`
      + `if (leaf.sourceEvidence !== "source-${directory}") throw new Error("stale ${directory} dependency");\n`
      + (directory === 'protocol' ? 'export const sourceEvidence = leaf.sourceEvidence;'
        : 'export { sourceEvidence } from "@happier-dev/protocol/uiartsrc-evidence";'));
  }
  const manifestPath = join(repoRoot, 'packages/plugins/inspector/src/manifest.ts');
  const original = await readFile(manifestPath, 'utf8');
  const staleSessions = join(repoRoot, 'packages/plugin-sdk/dist/sessions');
  await mkdir(staleSessions, { recursive: true });
  await writeFile(join(staleSessions, 'index.d.ts'), 'export declare const stale: boolean;');
  await writeFile(join(staleSessions, 'index.js'), 'export const stale = true;');
  await writeFile(manifestPath, 'import { SessionInputForgeEvidenceV1Schema } from "@happier-dev/plugin-sdk/sessions";\n'
    + 'if (!SessionInputForgeEvidenceV1Schema) throw new Error("missing source schema");\n'
    + 'import { sourceEvidence } from "@happier-dev/plugin-sdk/uiartsrc-evidence";\n'
    + 'if (sourceEvidence !== "source-protocol") throw new Error("stale manifest dependencies");\n' + original);
  await writeFile(join(repoRoot, 'packages/plugins/inspector/src/ui/renderSurface.tsx'),
    'import { sourceEvidence as sdk } from "@happier-dev/plugin-sdk/uiartsrc-evidence-leaf";\n'
    + 'import { sourceEvidence as protocol } from "@happier-dev/protocol/uiartsrc-evidence-leaf";\n'
    + 'export function renderSurface() { return sdk + "/" + protocol; }');
  const outputDir = fixture.path('preparation');
  await mkdir(outputDir);
  const inventoryPath = fixture.path('inventory.js');
  const { prepareSourcePluginUiInventory } = await import('./build_source_web_ui.mjs');
  await prepareSourcePluginUiInventory({ repoDir: repoRoot, outputDir, inventoryPath });
  const { resolveBundledPluginUiArtifactsRetainedRoots } = await import('../../../ui/scripts/generateBundledPluginUiArtifacts.mjs');
  const root = resolveBundledPluginUiArtifactsRetainedRoots(inventoryPath).get('happier.inspector');
  assert.ok(root, 'the manifest and UI must compile without the missing dist export');
  const graph = JSON.parse(await readFile(join(root, 'ui-artifacts.json'), 'utf8'));
  const renderer = graph.entries.find(entry => entry.executable?.exports.includes('renderSurface'));
  assert.ok(renderer);
  const compiled = await readFile(join(root, renderer.entry), 'utf8');
  const module = { exports: {} };
  runInNewContext(compiled, { module, exports: module.exports, require: createRequire(import.meta.url) });
  assert.equal(module.exports.renderSurface(), 'source-plugin-sdk/source-protocol');
  assert.equal(await readFile(join(staleSessions, 'index.js'), 'utf8'), 'export const stale = true;');
  for (const directory of ['plugin-sdk', 'protocol']) {
    assert.equal(await readFile(join(repoRoot, 'packages', directory, 'dist/uiartsrc-evidence.js'), 'utf8'),
      'export const stale = true;', 'source preparation must not repair dist');
  }
});

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
  // A previously published inventory remains last-green even when its bytes
  // predate the optional compiler-input reuse record.
  const { resolveBundledPluginUiArtifactsRetainedRoots } = await import('../../../ui/scripts/generateBundledPluginUiArtifacts.mjs');
  const { WORKSPACE_PACKAGE_BUILD_INPUT_RECORD } = await import('../../../../packages/cli-common/packageBuildOutputTargets.mjs');
  const retainedRoot = resolveBundledPluginUiArtifactsRetainedRoots(outputPath).get('happier.openai');
  await rm(join(retainedRoot, WORKSPACE_PACKAGE_BUILD_INPUT_RECORD));
  plugins[0].loadManifest = async () => { throw new Error('source manifest dependency unavailable'); };
  await writeFile(entry('healthy'), valid('healthy-v3'));
  const retained = await prepare();
  assert.deepEqual(retained.pluginFailures, [], 'a manifest failure must retain admitted inventory bytes without a compiler reuse record');
  assert.ok(retained.diagnostics.some(row => row.pluginId === 'happier.openai' && row.code === 'plugin_ui_artifact_invalid'),
    'serving stale bytes must retain the preparation diagnostic');
  assert.deepEqual(await load(), new Map([['happier.healthy', 'healthy-v3'], ['happier.openai', 'broken-v2']]));
  delete plugins[0].loadManifest;
  await writeFile(entry('openai'), valid('broken-v3'));
  assert.deepEqual((await prepare()).diagnostics, []);
  assert.deepEqual(await load(), new Map([['happier.healthy', 'healthy-v3'], ['happier.openai', 'broken-v3']]));
});

test('source plugin UI preparation reuses unchanged plugins and rebuilds only changed inputs', async t => {
  await import('../../../../packages/cli-common/registerSourceRuntime.mjs');
  const { SOURCE_PLUGIN_UI_IMPORT_CONDITIONS } = await import('../../../../scripts/workspaces/sourcePluginUiBuildOptions.mjs');
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
  // Observe filesystem boundaries without mutating the compiler checkout's
  // admitted dependencies or replacing any internal identity/compiler logic.
  const markerPath = join(compilerRoot, 'node_modules/.happier-stack-dependencies-ready');
  let dependencyMarker = { identity: { packageManager: 'fixture', nodeVersion: process.version },
    inputs: [{ path: 'install:pnpm-lock.yaml', kind: 'file', digest: 'dependencies-v1', size: 1 }],
    stacksNeedingRestart: [] };
  const originalReadFile = fs.promises.readFile;
  const originalExists = fs.existsSync;
  const originalWriteFile = fs.promises.writeFile;
  const originalReaddirSync = fs.readdirSync;
  const manifestWrites = [];
  let sharedInputEnumerations = 0;
  t.mock.method(fs, 'readdirSync', (path, ...args) => {
    if (String(path) === join(repoRoot, 'packages/shared-ui-input/src')) sharedInputEnumerations++;
    return originalReaddirSync(path, ...args);
  });
  t.mock.method(fs, 'existsSync', path => String(path) === markerPath || originalExists(path));
  t.mock.method(fs.promises, 'readFile', (path, ...args) => String(path) === markerPath
    ? Promise.resolve(JSON.stringify(dependencyMarker)) : originalReadFile(path, ...args));
  t.mock.method(fs.promises, 'writeFile', (path, ...args) => {
    const match = String(path).startsWith(fixture.path('preparation-')) && String(path).match(/[\\/](alpha|beta)\.json$/u);
    if (match) {
      manifestWrites.push(path);
      compiled.push(match[1]);
      duringCompile?.();
    }
    return originalWriteFile(path, ...args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const betaPackagePath = join(repoRoot, 'packages/plugins/beta/package.json');
  const betaPackage = JSON.parse(await readFile(betaPackagePath, 'utf8'));
  betaPackage.devDependencies = { '@happier-dev/cli': '0.0.0', '@fixture/ui-helper': '0.0.0', '@fixture/shared-ui-input': '0.0.0' };
  await writeFile(betaPackagePath, JSON.stringify(betaPackage));
  const helperRoot = join(repoRoot, 'packages/ui-helper');
  await mkdir(join(helperRoot, 'src'), { recursive: true });
  await writeFile(join(helperRoot, 'package.json'), JSON.stringify({ name: '@fixture/ui-helper', version: '0.0.0' }));
  await writeFile(join(helperRoot, 'src/value.ts'), 'export const value = "v1";');
  const alphaPackagePath = join(repoRoot, 'packages/plugins/alpha/package.json');
  const alphaPackage = JSON.parse(await readFile(alphaPackagePath, 'utf8'));
  alphaPackage.devDependencies = { '@fixture/shared-ui-input': '0.0.0' };
  await writeFile(alphaPackagePath, JSON.stringify(alphaPackage));
  const sharedRoot = join(repoRoot, 'packages/shared-ui-input');
  await mkdir(join(sharedRoot, 'src'), { recursive: true });
  await writeFile(join(sharedRoot, 'package.json'), JSON.stringify({ name: '@fixture/shared-ui-input', version: '0.0.0' }));
  await writeFile(join(sharedRoot, 'src/value.ts'), 'export const shared = true;');
  const compiled = [];
  for (const { directory } of plugins) {
    await writeFile(entry(directory), `import {value} from "fixture-ui-${directory}"; export function renderSurface(){return value;}`);
    await writeFile(join(repoRoot, 'packages/plugins', directory, 'src/value.ts'), 'export const value = "v1";');
  }
  await writeFile(join(repoRoot, 'packages/plugins/beta/src/value.ts'), 'export {value} from "@fixture/ui-helper";');
  const outputPath = fixture.path('consumer/inventory.js');
  const artifactStoreDir = fixture.path('consumer/artifacts');
  let preparation = 0;
  let duringCompile;
  const prepare = (sourceImportConditions) => prepareSourcePluginUiArtifacts({ repoRoot, plugins, outputPath, artifactStoreDir, sourceImportConditions,
    outputDir: fixture.path(`preparation-${preparation++}`), resolveSourceImport(specifier) {
      if (specifier === '@fixture/ui-helper') return join(helperRoot, 'src/value.ts');
      if (!specifier.startsWith('fixture-ui-')) return undefined;
      const directory = specifier.slice('fixture-ui-'.length);
      return join(repoRoot, 'packages/plugins', directory, 'src/value.ts');
    } });
  await prepare();
  assert.deepEqual(compiled, ['alpha', 'beta']);
  assert.equal(sharedInputEnumerations, 0,
    'unused workspace dependencies must not enumerate source membership');
  const firstPaths = resolveBundledPluginUiArtifactsInputPaths(outputPath).slice(1);
  assert.ok(firstPaths.every(path => path.startsWith(`${artifactStoreDir}${sep}`)),
    'published source assets must be independent of disposable preparation paths');
  const firstStats = await Promise.all(firstPaths.map(path => stat(path)));
  for (const path of firstPaths) await setBundleReadOnly(join(dirname(path), '../..'), true);
  compiled.length = 0;
  manifestWrites.length = 0;
  sharedInputEnumerations = 0;
  const unchangedPreparationStarted = performance.now();
  await prepare(SOURCE_PLUGIN_UI_IMPORT_CONDITIONS);
  console.error(`[reload-cost] scenario=unchanged-plugin-ui elapsedMs=${Math.round(performance.now() - unchangedPreparationStarted)} compilers=${compiled.length}`);
  assert.deepEqual(compiled, [], 'unchanged plugins must not enter the compiler');
  assert.equal(sharedInputEnumerations, 0, 'warm preparation must not enumerate unused workspace dependencies');
  await t.test('warm reuse writes zero manifests', () => {
    assert.deepEqual(manifestWrites, [], 'warm reuse must perform zero compiler manifest writes');
  });
  for (const path of firstPaths) await setBundleReadOnly(join(dirname(path), '../..'), false);
  dependencyMarker = { ...dependencyMarker, stacksNeedingRestart: ['another-running-stack'] };
  await prepare();
  await t.test('restart advice causes zero compiles', () => {
    assert.deepEqual(compiled, [], 'restart advice alone must cause zero plugin compiles');
  });
  compiled.length = 0;
  manifestWrites.length = 0;
  // An install refresh for an unrelated package rewrites the marker. Installed
  // packages a plugin bundles key it by content instead (sourcePluginUiCompiler.test.mjs).
  dependencyMarker = { ...dependencyMarker, inputs: [{ ...dependencyMarker.inputs[0], digest: 'dependencies-v2' }] };
  await prepare();
  assert.deepEqual(compiled, [], 'an install marker change alone is not a plugin UI input');
  compiled.length = 0;
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
  const backendPreparationStarted = performance.now();
  await prepare();
  console.error(`[reload-cost] scenario=backend-only-plugin-edit elapsedMs=${Math.round(performance.now() - backendPreparationStarted)} compilers=${compiled.length}`);
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
  compiled.length = 0;
  await writeFile(join(repoRoot, 'packages/plugins/alpha/src/value.ts'), 'export const value = "v3";');
  duringCompile = () => {
    duringCompile = undefined;
    fs.writeFileSync(join(sharedRoot, 'src/addedDuringCompile.ts'), 'export const added = true;');
  };
  await prepare();
  compiled.length = 0;
  await prepare();
  assert.deepEqual(compiled, [],
    'an added file in an unused workspace dependency must not invalidate either plugin');
  compiled.length = 0;
  await prepare();
  assert.deepEqual(compiled, [], 'settled shared membership must return to zero compiles');
});

test('source plugin UI preparation retains empty compiler graphs across disposable preparation roots', async t => {
  await import('../../../../packages/cli-common/registerSourceRuntime.mjs');
  const { prepareSourcePluginUiArtifacts } = await import('../../../ui/scripts/prepareSourcePluginUiArtifacts.mjs');
  const { readBundledPluginUiArtifactsRetainedInventory, reapBundledPluginUiArtifactStore,
    resolveBundledPluginUiArtifactsInputPaths } = await import('../../../ui/scripts/generateBundledPluginUiArtifacts.mjs');
  const { fixture, repoRoot, plugins } = await createSourcePluginUiFixture(t, ['empty']);
  plugins[0].manifest.contributes = {};
  await writeFile(join(repoRoot, 'packages/plugins/empty/package.json'), JSON.stringify({
    name: '@happier-dev/plugins-empty', version: '0.0.0', exports: {},
  }));
  const outputPath = fixture.path('consumer/inventory.js');
  const artifactStoreDir = fixture.path('consumer/artifacts');
  const writes = [];
  const write = fs.promises.writeFile;
  t.mock.method(fs.promises, 'writeFile', (path, ...args) => {
    if (String(path).endsWith(`${sep}empty.json`)) writes.push(path);
    return write(path, ...args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  let generation = 0;
  const prepare = async () => {
    const outputDir = fixture.path(`preparation-${generation++}`);
    const result = await prepareSourcePluginUiArtifacts({ repoRoot, plugins, outputPath, artifactStoreDir, outputDir });
    await rm(outputDir, { recursive: true });
    assert.deepEqual(result.pluginFailures, []);
    return result;
  };
  await prepare();
  assert.equal(writes.length, 1, 'the cold empty graph still enters the canonical compiler');
  writes.length = 0;
  await mkdir(join(repoRoot, 'apps/ui/sources'), { recursive: true });
  await writeFile(join(repoRoot, 'apps/ui/sources/unrelated.ts'), 'export const revision = 1;');
  await prepare();
  assert.equal(writes.length, 0, 'an unrelated UI edit must compile zero unchanged empty graphs');
  const retainedRoot = readBundledPluginUiArtifactsRetainedInventory(outputPath).roots.get('happier.empty');
  assert.ok(retainedRoot);
  await t.test('empty compiler metadata preserves byte admission and inventory lifetime', async () => {
    const inventory = await readFile(outputPath, 'utf8');
    const byteInputs = resolveBundledPluginUiArtifactsInputPaths(outputPath);
    await writeFile(outputPath, inventory.replace(/^\/\/ BUNDLED_PLUGIN_UI_ARTIFACT_ROOTS = .+;$/m,
      '// BUNDLED_PLUGIN_UI_ARTIFACT_ROOTS = {;'));
    assert.deepEqual(resolveBundledPluginUiArtifactsInputPaths(outputPath), byteInputs,
      'damaged optional compiler metadata must not withdraw admitted bytes');
    await writeFile(outputPath, inventory);
    const historical = new Date(Date.now() - 48 * 60 * 60 * 1000);
    for (const file of await readdir(retainedRoot)) await utimes(join(retainedRoot, file), historical, historical);
    await utimes(retainedRoot, historical, historical);
    const procRoot = fixture.path('empty-proc');
    await mkdir(procRoot);
    assert.equal(reapBundledPluginUiArtifactStore({ artifactStoreDir, inventoryPaths: [outputPath], procRoot,
      retainCandidate: () => false }).reclaimedRoots, 0, 'the current empty compiler root is owned by its inventory lifetime');
    assert.ok(await stat(retainedRoot));
  });
  await writeFile(join(repoRoot, 'packages/plugins/empty/src/changed.ts'), 'export const revision = 2;');
  await prepare();
  assert.equal(writes.length, 0, 'an unused plugin source must not recompile its empty UI graph');
  plugins[0].manifest.displayName = 'Updated empty plugin';
  await prepare();
  assert.equal(writes.length, 1, 'a changed admitted manifest must compile its empty graph once');
});

for (const startup of [false, true]) test(startup
  ? 'stack run/start source preparation bypasses validation capacity admission on its runtime host'
  : 'validation source preparation leaves dependencies available while waiting for native admission', {
  skip: process.platform !== 'linux', timeout: 30000,
}, async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-stack-source-dependency-order-', registerCleanup: false });
  const native = await installSourceAdmissionFixture(fixture.root);
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
  await installSourcePreparationInputs(repoDir, 'server');
  const prepare = native.build;
  const pressure = await holdNativeAdmissionFixtureMemory(t, native, { totalKiB: 33554432, availableKiB: 5242880 });
  const env = { ...native.env, HAPPIER_STACK_HOME_DIR: fixture.path('home'),
    HAPPIER_STACK_RUNTIME_BUILD_AUTHORITY_STACK: 'consumer' };
  for (const key of Object.keys(env)) if (key.startsWith('HAPPIER_HEAVYWEIGHT_ADMISSION_')
    || key.startsWith('HAPPIER_WORKSPACE_DIST_BUILD_LOCK_')) delete env[key];
  const phases = [];
  const pending = await beginPendingSourceStart({ stackBaseDir: fixture.path('stacks/consumer'), onPhase: phase => phases.push(phase) });
  let reportQueued;
  const observed = new Promise(resolve => { reportQueued = resolve; });
  let preparation;
  t.after(async () => {
    pending.abort(new Error('source preparation fixture cleanup'));
    await pending.dispose();
    await Promise.allSettled([preparation]);
    await setBundleReadOnly(fixture.root, false);
    await fixture.cleanup();
  });
  preparation = prepare({ repoDir, component: 'server', env,
    ...(startup ? { stackBaseDir: fixture.path('stacks/consumer'), pending }
      : { outputDir: fixture.path('finite-output'), devStartup: false }),
    signal: AbortSignal.any([pending.signal, t.signal]),
    stderrStream:{write(chunk) { if (String(chunk).includes('waiting for admission')) reportQueued(); }} });
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
  await withDependencyRefreshLock({ installDir: repoDir, env, signal: t.signal }, async () => {});
  await pressure.release();
  const built = await preparation;
  assert.equal((await import(pathToFileURL(built.entrypoint))).ready, true);
  assert.deepEqual(await readdir(join(native.admissionRoot, 'owners')).catch(error =>
    error.code === 'ENOENT' ? [] : Promise.reject(error)), []);
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

test('captured server runtime retains its generated Prisma support after capture retirement and regeneration', async t => {
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
  // Generated Prisma belongs to this captured graph, independently of later
  // generation in the installed checkout or retirement of temporary inputs.
  await writeFile(join(server, 'generated/sqlite-client/index.js'), 'export const installedMarker = "installed-support";');
  await symlink(dirname(createRequire(import.meta.url).resolve('esbuild/package.json')), join(server, 'node_modules/esbuild'), process.platform === 'win32' ? 'junction' : 'dir');
  const native = process.platform === 'linux' ? await installSourceAdmissionFixture(fixture.root) : null;
  const built = await (native?.build ?? buildSourceRuntimeBundle)({ repoDir, outputDir: fixture.path('output'),
    component: 'server', env: native?.env ?? process.env });
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
  await writeFile(join(server, 'generated/sqlite-client/index.js'), 'export const installedMarker = "later-generation";');
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

test('retained source maps resolve server and daemon TypeScript after capture retirement and participate in identity', async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-source-maps-' });
  const repoDir = await createReloadDaemonRepo(fixture,
    "export async function crash() { return (await import('./crash')).crash(); }\n");
  await writeFile(join(repoDir, 'apps/cli/scripts/process_tree.cjs'), 'module.exports = { ready: true };\n');
  const server = join(repoDir, 'apps/server');
  for (const directory of ['sources', 'scripts', 'node_modules']) await mkdir(join(server, directory), { recursive: true });
  await writeFile(join(server, 'package.json'), JSON.stringify({ name: '@happier-dev/server', type: 'module' }));
  await writeFile(join(server, 'tsconfig.json'), '{}');
  await writeFile(join(server, 'sources/main.light.ts'), "export async function crash() { return (await import('./crash')).crash(); }\n");
  await writeFile(join(server, 'scripts/migrate.sqlite.deploy.ts'), 'export async function runSqliteMigrationDeploy() {}');
  await symlink(dirname(createRequire(import.meta.url).resolve('esbuild/package.json')), join(server, 'node_modules/esbuild'),
    process.platform === 'win32' ? 'junction' : 'dir');
  const native = process.platform === 'linux' ? await installSourceAdmissionFixture(fixture.root) : null;
  for (const component of ['server', 'daemon']) {
    const sourcePath = component === 'server' ? 'apps/server/sources/crash.ts' : 'apps/cli/src/crash.ts';
    const source = "export function crash(): never {\n  throw new Error('mapped-source-failure');\n}\n";
    await writeFile(join(repoDir, sourcePath), source);
    const outputDir = fixture.path(component);
    const runtime = await (native?.build ?? buildSourceRuntimeBundle)({ repoDir, outputDir, component, env: native?.env ?? process.env });
    await assert.rejects(access(join(outputDir, 'workspace')), { code: 'ENOENT' });
    const metafile = JSON.parse(await readFile(join(runtime.runtimeDir, 'metafile.json'), 'utf8'));
    const emitted = Object.keys(metafile.outputs).map(path => resolve(outputDir, 'workspace', path));
    const javascript = emitted.filter(path => /\.[cm]?js$/.test(path));
    let retainedSource = false;
    for (const path of javascript) {
      const contents = await readFile(path, 'utf8');
      const reference = /\/\/# sourceMappingURL=(.+)/.exec(contents)?.[1];
      assert.ok(reference && !reference.startsWith('data:'), `external map reference required: ${relative(outputDir, path)}`);
      const mapPath = resolve(dirname(path), reference);
      assert.ok(emitted.includes(mapPath), 'source map belongs to the emitted identity inventory');
      const map = JSON.parse(await readFile(mapPath, 'utf8'));
      const index = map.sources.findIndex(path => path.endsWith(sourcePath));
      if (index >= 0) {
        assert.equal(map.sourcesContent[index], source, 'captured TypeScript is retained without reopening live source');
        retainedSource = true;
      }
    }
    assert.equal(retainedSource, true, 'lazy TypeScript source is available to the profiler');
    const hash = createHash('sha256');
    const wrappers = component === 'server'
      ? [join(runtime.runtimeDir, 'sources/main.mjs'), join(runtime.runtimeDir, 'scripts/migrate.mjs')]
      : [runtime.entrypoint];
    for (const path of [...emitted, ...wrappers].sort()) {
      hash.update(relative(runtime.runtimeDir, path));
      hash.update(await readFile(path));
    }
    assert.equal(hash.digest('hex').slice(0, 16), runtime.identity, 'retained map bytes participate in runtime identity');
    await writeFile(join(repoDir, sourcePath), 'export function crash() { throw new Error("moving-source"); }');
    const child = spawnSync(process.execPath, ['--enable-source-maps', '--input-type=module', '--eval',
      `const runtime = await import(${JSON.stringify(pathToFileURL(runtime.entrypoint).href)}); await runtime.crash();`],
    { cwd: outputDir, env: { ...process.env, ...runtime.env, NODE_OPTIONS: '' }, encoding: 'utf8' });
    assert.equal(child.status, 1, child.stderr);
    assert.match(child.stderr, /mapped-source-failure/);
    assert.ok(child.stderr.replaceAll('\\', '/').includes(`${sourcePath}:2:`), 'real runtime stack resolves captured TypeScript line');
  }
});

test('source CLI profile reconciliation runs a staged nonexecutable entry through the admitted launcher', async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-source-cli-profile-', registerCleanup: false });
  t.after(async () => { await makeFixtureWritable(fixture.root); await fixture.cleanup(); });
  const repoDir = await createReloadDaemonRepo(fixture, `
    import { writeFileSync } from 'node:fs';
    if (process.argv[2] === 'server') {
      writeFileSync(process.env.PROFILE_ARGS_PATH, JSON.stringify(process.argv.slice(2)));
    }
  `);
  const runtime = await buildSourceRuntimeBundle({ repoDir, outputDir: fixture.path('output'), component: 'daemon' });
  assert.equal((await stat(runtime.entrypoint)).mode & 0o111, 0);
  const launch = await resolveCliRuntimeLaunchSpec({ sourceRuntimeLaunch: runtime });
  const args = buildStackServerProfileSetArgs({ serverId: 'source-profile',
    internalServerUrl: 'http://127.0.0.1:4301', publicServerUrl: 'http://source-profile.localhost:4301' });
  const capturedArgs = fixture.path('profile-args.json');
  await run(launch.command, [...launch.args, ...args], {
    cwd: fixture.root, env: { ...process.env, ...runtime.env, PROFILE_ARGS_PATH: capturedArgs }, stdio: 'ignore',
  });
  assert.deepEqual(JSON.parse(await readFile(capturedArgs, 'utf8')), args);
});

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
  const sourceToolsDir = join(repoDir, 'packages/cli-common');
  await mkdir(sourceToolsDir, { recursive: true });
  await writeFile(join(sourceToolsDir, 'package.json'), JSON.stringify({
    name: '@happier-dev/cli-common', type: 'module', files: ['*.mjs'],
  }));
  await mkdir(join(sourceToolsDir, 'node_modules'), { recursive: true });
  await symlink(dirname(createRequire(import.meta.url).resolve('tsx/package.json')),
    join(sourceToolsDir, 'node_modules/tsx'), process.platform === 'win32' ? 'junction' : 'dir');
  for (const name of ['registerSourceRuntime.mjs', 'sourceRuntimeEntries.mjs', 'sourceRuntimeDependencies.mjs', 'cliRuntimeSidecars.mjs']) {
    await cp(new URL('../../../../packages/cli-common/' + name, import.meta.url), join(sourceToolsDir, name));
  }
  await writeFile(join(pluginDir, 'src/value.ts'), 'export const value = 42;');
  await writeFile(join(pluginDir, 'src/imports.ts'), "export { value } from './value.js';");
  // This subprocess is the external build-tool boundary, not a replacement
  // for the builder's input capture, compilation, cache, or publication logic.
  await writeFile(checker, `
    import assert from 'node:assert/strict';
    import '../../../../packages/cli-common/registerSourceRuntime.mjs';
    import { value } from '../../../../packages/plugins/fixture/src/imports.ts';
    import {readFileSync} from 'node:fs';
    import {resolveWorkspaceBundleLockPath,withWorkspaceBundleLock} from ${JSON.stringify(new URL('../../../../packages/cli-common/workspaceBundleLock.mjs', import.meta.url).href)};
    assert.equal(process.argv[2], '--daemon-projections');
    assert.equal(process.argv[3], '--daemon-output-root');
    assert.equal(value, 42);
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
    await assert.rejects(native.build(options), { code: 'source_runtime_producer_failed' });
  }, { lockPath: resolveWorkspaceBundleLockPath(repoDir) });
  assert.match(diagnostics.join(''), /Canonical projection generator failed/);
  assert.equal(await readFile(input, 'utf8'), '{"module":"engine"}');
  assert.deepEqual(JSON.parse(await readFile(join(stackBaseDir, 'source-runtime/selected-daemon.json'), 'utf8')),
    { entrypoint: incumbent.entrypoint });
  assert.equal((await import(pathToFileURL(incumbent.entrypoint))).ready, true);
  await writeFile(join(repoDir, 'apps/cli/src/index.ts'), 'export const ready = true;');
  await writeFile(authoredManifest, 'export const locator = "engine";');
  await rm(checker);
  await assert.rejects(native.build(options), { code: 'source_runtime_producer_failed' });
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

test('source bundle refusal identifies the compiler failing module across the finite worker', async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-source-refusal-module-' });
  const repoDir = await createReloadDaemonRepo(fixture, 'import "./refusal-broken";');
  const probeWitness = fixture.path('unexpected-entry-probe');
  await mkdir(join(repoDir, 'apps/cli/src/daemon'), { recursive: true });
  await writeFile(join(repoDir, 'apps/cli/src/daemon/startDaemon.ts'),
    `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(probeWitness)}, 'loaded');`);
  await writeFile(join(repoDir, 'apps/cli/src/refusal-broken.ts'), 'export const missing = ;');
  await assert.rejects(buildSourceRuntimeBundle({ repoDir, outputDir: fixture.path('candidate'), component: 'daemon' }), error => {
    assert.ok(error.firstFailingModule?.replaceAll('\\', '/').endsWith('apps/cli/src/refusal-broken.ts'),
      `refusal must identify the compiler module; received ${error.firstFailingModule}`);
    assert.equal(error.entryGraph, 'daemon');
    return true;
  });
  await assert.rejects(access(probeWitness), { code: 'ENOENT' });
  await writeFile(join(repoDir, 'apps/cli/src/refusal-broken.ts'), 'export const ready = true;');
  await buildSourceRuntimeBundle({ repoDir, outputDir: fixture.path('green-candidate'), component: 'daemon' });
  await assert.rejects(access(probeWitness), { code: 'ENOENT' }, 'successful preparation must execute zero entry-graph diagnostics');
});

test('source preparation preserves a missing loader code across the real finite worker', async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-source-loader-code-' });
  const repoDir = await createReloadDaemonRepo(fixture, 'export const ready = true;');
  const importer = join(repoDir, 'packages/cli-common/registerSourceRuntime.mjs');
  await mkdir(dirname(importer), { recursive: true });
  await writeFile(importer, "import 'constructed-missing-preparation-loader';\n");
  await assert.rejects(buildSourceRuntimeBundle({ repoDir, outputDir: fixture.path('candidate'), component: 'daemon' }), error => {
    assert.equal(error.code, 'ERR_MODULE_NOT_FOUND');
    assert.equal(error.firstFailingModule, importer);
    assert.equal(error.entryGraph, 'daemon');
    return true;
  });
  await assert.rejects(access(fixture.path('candidate/source-bundle.json')), { code: 'ENOENT' });
});

for (const failures of [1, 2]) {
test(`source reload retries adoption of the same capture after ${failures} readiness failures`, async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-source-adopt-retry-', registerCleanup: false });
  t.after(async () => { await makeFixtureWritable(fixture.root); await fixture.cleanup(); });
  const native = await installSourceAdmissionFixture(fixture.root);
  const witness = fixture.path('probe-attempts');
  const fail = fixture.path('fail-probe');
  const repoDir = await createReloadDaemonRepo(fixture, `
    import { existsSync, appendFileSync, readFileSync, writeFileSync } from 'node:fs';
    if (existsSync(${JSON.stringify(fail)})) {
      const remaining = Number(readFileSync(${JSON.stringify(fail)}, 'utf8'));
      appendFileSync(${JSON.stringify(witness)}, import.meta.url + '\\n');
      writeFileSync(${JSON.stringify(fail)}, String(remaining - 1));
      if (remaining === 1 && ${failures} === 2) throw new TypeError('adopt-readiness-second-failure');
      if (remaining > 0) throw new ReferenceError('adopt-readiness-unavailable');
    }
    export const ready = true;
  `);
  const stackBaseDir = fixture.path('stacks/qa');
  const bundleRoot = fixture.path('stacks/source-bundles');
  let captures;
  const options = { stackName: 'qa', stackBaseDir, repoDir, onHost: true,
    args: ['--no-server', '--no-ui'],
    env: { ...process.env, ...native.env, HAPPIER_STACK_DAEMON: '1', HAPPIER_SERVER_URL: 'http://fixture.invalid' },
    onPhase: phase => {
      if (phase.phase !== 'checking') return;
      captures = fs.readdirSync(bundleRoot).filter(name => name.startsWith('runtime-')).sort();
      fs.writeFileSync(fail, String(failures));
    } };
  if (failures === 1) {
    await native.prepareReload(options);
    const selected = JSON.parse(await readFile(join(stackBaseDir, 'source-runtime/selected-daemon.json'), 'utf8'));
    assert.ok(selected.entrypoint);
  } else {
    await assert.rejects(native.prepareReload(options), error => {
      assert.equal(error.loadError?.name, 'TypeError');
      assert.equal(error.entryGraph, 'daemon');
      return true;
    });
    const refusal = JSON.parse(await readFile(join(stackBaseDir, 'source-runtime/reload.json'), 'utf8'));
    assert.equal(refusal.status, 'failed');
    assert.equal(refusal.entryGraph, 'daemon');
    assert.ok(refusal.firstFailingModule);
    await assert.rejects(access(join(stackBaseDir, 'source-runtime/selected-daemon.json')), { code: 'ENOENT' });
  }
  const attempts = (await readFile(witness, 'utf8')).trim().split('\n');
  assert.equal(attempts.length, 2, 'one readiness failure permits exactly one adoption retry');
  assert.equal(new Set(attempts).size, 1, 'both probes import the same finished capture');
  assert.deepEqual((await readdir(bundleRoot)).filter(name => name.startsWith('runtime-')).sort(), captures,
    'readiness failure must not allocate a fresh producer build');
});
}

test('source reload refusal publishes the failing module and preserves incumbent selection', async t => {
  const graph = await reloadFixtureGraph(t, 'export {};');
  graph.old.entrypoint = graph.daemon.entrypoint;
  await writeFile(graph.selectedPath, JSON.stringify(graph.old));
  const repoDir = await createReloadDaemonRepo(graph.fixture, 'throw new ReferenceError("reload-refusal-leaf");');
  await assert.rejects(prepareSourceRuntimeReload({ stackName: 'qa', stackBaseDir: graph.stackBaseDir, repoDir,
    args: ['--no-server', '--no-ui'], onHost: true,
    env: { ...process.env, HAPPIER_STACK_DAEMON: '1', HAPPIER_SERVER_URL: ['http:', '', '127.0.0.1:12345'].join('/') } }), error => {
    assert.equal(error.entryGraph, 'daemon');
    assert.ok(error.firstFailingModule);
    return true;
  });
  const refusal = JSON.parse(await readFile(join(graph.stackBaseDir, 'source-runtime/reload.json'), 'utf8'));
  assert.equal(refusal.status, 'failed');
  assert.equal(refusal.entryGraph, 'daemon');
  assert.ok(refusal.firstFailingModule);
  assert.match(await readFile(refusal.logPath, 'utf8'), /firstFailingModule=/);
  assert.deepEqual(JSON.parse(await readFile(graph.selectedPath, 'utf8')), graph.old);
  assert.deepEqual(JSON.parse(await readFile(graph.runtimePath, 'utf8')), graph.runtime);
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
      const completion = JSON.parse(await readFile(join(resolve(dirname(selected.entrypoint), '../../..'), 'source-bundle.json'), 'utf8'));
      const reload = JSON.parse(await readFile(join(graph.stackBaseDir, 'source-runtime/reload.json'), 'utf8'));
      assert.equal(reload.sourceTimes?.daemon, completion.sourceCapture.capturedAt,
        'reload readiness reports the selected capture time, not completion or activation time');
      assert.deepEqual(reload.sourceCaptures?.daemon, completion.sourceCapture);
      const log = await readFile(reload.logPath, 'utf8');
      assert.ok(log.includes(`sourceTime daemon=${completion.sourceCapture.capturedAt}`));
      assert.ok(log.includes(`inputIdentity daemon=${completion.sourceCapture.inputIdentity}`));
      for (const phase of ['entry-preparation', 'esbuild-main', 'publication']) {
        assert.match(log, new RegExp(`^\\[source-bundle\\] phase=${phase} .*component=daemon`, 'm'),
          `the reload log retains the daemon producer's ${phase} diagnostic`);
      }
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
  const native = process.platform === 'linux' ? await installSourceAdmissionFixture(graph.fixture.root)
    : { build: buildSourceRuntimeBundle, prepareReload: prepareSourceRuntimeReload, env: process.env };
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
  const env = { ...native.env, HAPPIER_STACK_SERVER_COMPONENT: 'happier-server-light', HAPPIER_STACK_DAEMON: '1' };
  const incumbent = await native.build({ repoDir, stackBaseDir: graph.stackBaseDir, component: 'daemon', env });
  await native.build({ repoDir, stackBaseDir: graph.stackBaseDir, component: 'server', env });
  const serverSelectionPath = join(graph.stackBaseDir, 'source-runtime/selected-server.json');
  const incumbentServer = JSON.parse(await readFile(serverSelectionPath, 'utf8'));
  assert.equal((await import(pathToFileURL(incumbent.entrypoint))).ready, 1);
  const loaded = { ...graph.runtime, sourceRuntimeIdentities: { daemon: { selected: incumbent.identity, loaded: incumbent.identity } } };
  await writeFile(graph.runtimePath, JSON.stringify(loaded));
  const incumbentSelection = JSON.parse(await readFile(graph.selectedPath, 'utf8'));
  await writeFile(join(repoDir, 'apps/cli/src/index.ts'), 'export const ready = 2;');
  const options = { stackName: 'qa', stackBaseDir: graph.stackBaseDir, repoDir, env,
    args: ['--no-ui'], onHost: true };
  await writeFile(join(serverDir, 'sources/main.light.ts'), `${reloadHttpServerSource}\nexport const replacement = true;`);
  const processes = (await import('node:child_process')).default;
  const spawnProcess = processes.spawn;
  const forkProcess = processes.fork;
  const preparationStartedAt = Date.now();
  const preparationSpans = [];
  const componentPreparations = new Map();
  let preparationsOverlapped = false;
  const readComponent = args => {
    for (const value of args ?? []) {
      let request;
      try { request = JSON.parse(value); } catch { continue; }
      if (request?.component === 'server' || request?.component === 'daemon') return request.component;
      const nested = readComponent(request?.args);
      if (nested) return nested;
    }
    return null;
  };
  const observeProcess = (launch, command, args, ...rest) => {
    // POSIX foreground custody forks its real adapter before launching the
    // requested command. Observe both OS forms; retain the actual processes.
    const component = readComponent(args);
    if (component) preparationsOverlapped ||= [...componentPreparations]
      .some(([other, child]) => other !== component && child.exitCode === null && child.signalCode === null);
    const child = launch(command, args, ...rest);
    if (component) {
      const span = { component, startMs: Date.now() - preparationStartedAt };
      preparationSpans.push(span);
      child.once('close', () => { span.elapsedMs = Date.now() - preparationStartedAt - span.startMs; });
    }
    if (component) componentPreparations.set(component, child);
    return child;
  };
  t.mock.method(processes, 'spawn', (...args) => observeProcess(spawnProcess, ...args));
  t.mock.method(processes, 'fork', (...args) => observeProcess(forkProcess, ...args));
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  await native.prepareReload({ ...options, onPrepared: async () => {
    assert.equal(JSON.parse(await readFile(join(graph.stackBaseDir, 'source-runtime/start.pending.json'), 'utf8')).phase, 'prepared',
      'completed smoke waiting for activation is prepared, not still checking');
    assert.deepEqual(JSON.parse(await readFile(graph.selectedPath, 'utf8')), incumbentSelection,
      'preparation and smoke do not replace the incumbent selection');
    assert.deepEqual(JSON.parse(await readFile(serverSelectionPath, 'utf8')), incumbentServer);
  } });
  t.diagnostic(`reload-preparation-measurement ${JSON.stringify({ wallMs: Date.now() - preparationStartedAt,
    spans: preparationSpans })}`);
  assert.equal(componentPreparations.size, 2, 'the OS observer must see both real finite producers');
  assert.equal(preparationsOverlapped, true,
    'server and daemon preparation must overlap before either replacement is selected');
  t.mock.restoreAll();
  syncBuiltinESMExports();
  const first = JSON.parse(await readFile(graph.selectedPath, 'utf8'));
  const firstServer = JSON.parse(await readFile(serverSelectionPath, 'utf8'));
  assert.equal((await import(pathToFileURL(first.entrypoint))).ready, 2);
  await native.prepareReload({ ...options, onPrepared: async () => {
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

test('source reload and required startup reuse agree on a shared Postgres provider', {
  skip: process.env.HAPPIER_DB_PROVIDER !== 'postgres'
    || !/^[a-f0-9]{64}$/.test(process.env.HAPPIER_DB_CONTRACT_CONTAINER_ID ?? '')
    || !/^\d+$/.test(process.env.VITEST_POOL_ID ?? ''),
}, async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-source-reload-shared-postgres-', registerCleanup: false });
  t.after(async () => { await makeFixtureWritable(fixture.root); await fixture.cleanup(); });
  const native = process.platform === 'linux' ? await installSourceAdmissionFixture(fixture.root)
    : { prepareReload: prepareSourceRuntimeReload, env: process.env };
  const sourceAfter = new Date().toISOString();
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
  const canonicalRepo = fileURLToPath(new URL('../../../../', import.meta.url));
  // Shared launch readiness must observe a real applied ledger. This case runs
  // under the existing ephemeral Postgres contract owner, never a retained DB.
  const database = new URL(process.env.DATABASE_URL);
  assert.equal(database.pathname, `/happier_contract_${process.env.VITEST_POOL_ID}`);
  await symlink(join(canonicalRepo, 'node_modules'), join(repoDir, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir');
  const canonicalMigrations = join(canonicalRepo, 'apps/server/prisma/migrations');
  const appliedMigration = (await readdir(canonicalMigrations, { withFileTypes: true }))
    .filter(entry => entry.isDirectory()).map(entry => entry.name).sort()[0];
  assert.ok(appliedMigration);
  const migrationDir = join(serverDir, 'prisma/migrations', appliedMigration);
  await mkdir(migrationDir, { recursive: true });
  await cp(join(canonicalMigrations, appliedMigration, 'migration.sql'), join(migrationDir, 'migration.sql'));

  const sourceEnvPath = fixture.path('producer/env');
  await mkdir(dirname(sourceEnvPath), { recursive: true });
  await writeFile(sourceEnvPath, [
    'HAPPIER_DB_PROVIDER=postgres',
    `DATABASE_URL=${process.env.DATABASE_URL}`,
    'HANDY_MASTER_SECRET=fixture-only-master-secret',
    `HAPPIER_SERVER_LIGHT_DATA_DIR=${fixture.path('producer/server-light')}`,
  ].join('\n'));

  // Exercise real preparation, canonical Postgres smoke skip and activation.
  // The smoke suite separately proves sqlite/pglite isolated health admission.
  const stackBaseDir = fixture.path('stacks/consumer');
  const { env } = sourceProducerFixtureOptions({ stackBaseDir, env: { ...native.env,
    HAPPIER_STACK_REPO_DIR: repoDir,
    HAPPIER_STACK_SERVER_COMPONENT: 'happier-server-light',
    HAPPIER_STACK_DAEMON: '0',
    HAPPIER_DB_PROVIDER: 'sqlite',
    HAPPIER_STACK_SHARED_DB_SOURCE_STACK: 'producer',
    HAPPIER_STACK_SHARED_DB_SOURCE_ENV_FILE: sourceEnvPath,
  } });
  await native.prepareReload({ stackName: 'consumer', stackBaseDir, repoDir,
    args: ['--no-daemon', '--no-ui', `--source-after=${sourceAfter}`], env, onHost: true });

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

async function readFixtureDependencyPublication(repoDir) {
  return {
    ...await readBuildInputDependencies({ sourceDir: repoDir }),
    markerPath: resolveDependencyRefreshMarkerPath(repoDir),
    generationPath: `${resolveDependencyRefreshLockPath(repoDir)}.generation`,
  };
}

async function reloadFixtureGraph(t, source) {
  const fixture = await createTempFixture(t, { prefix: 'hstack-source-reload-selection-', registerCleanup: false });
  const stackBaseDir = fixture.path('stacks/qa');
  const sourceRoot = join(stackBaseDir, 'source-runtime');
  await mkdir(sourceRoot, { recursive: true });
  const candidateRoot = fixture.path('candidate');
  const runtimeDir = join(candidateRoot, 'apps/cli');
  await mkdir(join(runtimeDir, 'src'), { recursive: true });
  const daemon = { identity: 'candidate', runtimeDir, cliDir: runtimeDir, entrypoint: join(runtimeDir, 'src/index.mjs'),
    dependencyPublication: await readFixtureDependencyPublication(fixture.root) };
  await writeFile(daemon.entrypoint, source);
  await writeFile(join(candidateRoot, 'source-bundle.json'), JSON.stringify(daemon));
  const candidateFailures = join(runtimeDir, '.project/tmp/bundled-plugin-publication/failures.json');
  await mkdir(dirname(candidateFailures), { recursive: true });
  await writeFile(candidateFailures, '[]');
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
  t.after(async () => {
    try { await pending.dispose(); }
    finally { await makeFixtureWritable(fixture.root); await fixture.cleanup(); }
  });
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
    dependencyPublication: await readFixtureDependencyPublication(fixture.root),
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
  const env = { ...process.env, HAPPIER_STACK_REPO_DIR: fileURLToPath(new URL('../../../../', import.meta.url)) };
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
    stackBaseDir, components: { server: currentServer }, pending: serverPending, env,
  });
  await serverAdmission.activate();
  assert.equal(
    JSON.parse(await readFile(join(sourceRoot, 'selected-server.json'), 'utf8')).entrypoint,
    currentServer.entrypoint,
  );

  const daemonPending = await beginPendingSourceStart({ stackBaseDir });
  t.after(() => daemonPending.dispose());
  const daemonAdmission = await admitSourceRuntimeReload({
    stackBaseDir, components: { daemon: currentDaemon }, pending: daemonPending, env,
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

async function createProtocolReloadRepo(fixture, { protocolFileCount = 700 } = {}) {
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
  await Promise.all(Array.from({ length: protocolFileCount }, (_, index) => writeFile(
    join(dirname(protocolPath), `shared-${index}-${'x'.repeat(96)}.ts`),
    `export const shared${index} = ${index};`,
  )));
  await writeFile(join(repoDir, 'package.json'), JSON.stringify({ workspaces: ['apps/*', 'packages/*'] }));
  await writeFile(join(repoDir, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n  - packages/*\n');
  await installSourcePreparationInputs(repoDir, 'server');
  await writeFile(join(repoDir, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n  - packages/*\n');
  return { repoDir, stackBaseDir, protocolPath, sharedProtocolSource };
}

test('fresh source restart converges when protocol source changes between server and daemon captures',
  { timeout: 90000 }, async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-source-reload-converges-', registerCleanup: false });
  t.after(async () => { await makeFixtureWritable(fixture.root); await fixture.cleanup(); });
  const { repoDir, stackBaseDir, protocolPath, sharedProtocolSource } = await createProtocolReloadRepo(fixture);

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
  assert.ok(Number.isFinite(Date.parse(selected[0].sourceCapture?.capturedAt)));
  assert.equal(selected[0].sourceCapture.capturedAt, selected[1].sourceCapture?.capturedAt,
    'component copies preserve the one shared capture time instead of their later build times');
});

test('source reload pins complete component inputs until next demand and retains daemon-only reuse',
  { timeout: 90000 }, async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-source-pinned-reload-', registerCleanup: false });
  let incumbentProcess;
  let incumbentExit;
  t.after(async () => {
    incumbentProcess?.kill();
    await incumbentExit;
    await makeFixtureWritable(fixture.root); await fixture.cleanup();
  });
  // Phase observation fixes the edit after capture; this case needs no padding
  // to widen the older between-captures test's timing window.
  const { repoDir, stackBaseDir, protocolPath } = await createProtocolReloadRepo(fixture, { protocolFileCount: 0 });
  const installed = join(repoDir, 'apps/server/node_modules/capture-fixture-dependency');
  await mkdir(installed, { recursive: true });
  await writeFile(join(installed, 'package.json'), JSON.stringify({ name: 'capture-fixture-dependency', main: './index.cjs' }));
  await writeFile(join(installed, 'index.cjs'), 'exports.marker = "installed-dependency";');
  await writeFile(join(repoDir, 'apps/server/sources/main.light.ts'),
    `import * as protocol from '@happier-dev/protocol';\nimport { marker } from 'capture-fixture-dependency';\n${reloadHttpServerSource.replace(
      '.listen(Number(process.env.PORT),process.env.HOST);',
      '.listen(Number(process.env.PORT),process.env.HOST,function(){process.send?.({port:this.address().port});});',
    )}\nexport { protocol, marker };`);
  const env = { ...process.env, HAPPIER_STACK_SERVER_COMPONENT: 'happier-server-light', HAPPIER_STACK_DAEMON: '1' };
  const options = { stackName: 'qa', stackBaseDir, repoDir, args: ['--no-ui'], onHost: true, env };
  const sourceRoot = join(stackBaseDir, 'source-runtime');
  const selections = () => Promise.all(['server', 'daemon'].map(async component => {
    const selection = JSON.parse(await readFile(join(sourceRoot, `selected-${component}.json`), 'utf8'));
    return JSON.parse(await readFile(resolve(dirname(selection.entrypoint), '../../../source-bundle.json'), 'utf8'));
  }));
  await prepareSourceRuntimeReload(options);
  const incumbent = await selections();
  incumbentProcess = spawn(process.execPath, [incumbent[0].entrypoint], {
    env: { ...env, ...incumbent[0].env, HOST: '127.0.0.1', PORT: '0',
      DATABASE_URL: pathToFileURL(fixture.path('incumbent.sqlite')).href },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'], signal: t.signal,
  });
  incumbentExit = new Promise(resolve => incumbentProcess.once('exit', resolve));
  const { port } = await new Promise((resolve, reject) => {
    incumbentProcess.once('message', resolve);
    incumbentProcess.once('error', reject);
    incumbentProcess.once('exit', code => reject(new Error(`incumbent exited before readiness (${code})`)));
  });
  const assertIncumbentHealthy = async () => {
    assert.equal(incumbentProcess.exitCode, null);
    assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 200);
  };
  await assertIncumbentHealthy();
  const cliPath = join(repoDir, 'apps/cli/src/index.ts');
  const replacementSource = 'export const version = "shared-capture"; export const added = "new-export";';
  let attempts = 0;
  await prepareSourceRuntimeReload({ ...options, onPrepared: assertIncumbentHealthy, onPhase: phase => {
    if (phase.phase !== 'preparing' || phase.component !== 'daemon') return;
    attempts += 1;
    assert.equal(incumbentProcess.exitCode, null, 'the loaded incumbent survives every replacement attempt');
    if (attempts === 1) {
      fs.writeFileSync(protocolPath, replacementSource);
      fs.writeFileSync(cliPath, 'import { added } from "@happier-dev/protocol"; export const ready = added;');
    }
    assert.deepEqual(['server', 'daemon'].map(component => {
      const selection = JSON.parse(fs.readFileSync(join(sourceRoot, `selected-${component}.json`), 'utf8'));
      return JSON.parse(fs.readFileSync(resolve(dirname(selection.entrypoint), '../../../source-bundle.json'), 'utf8')).identity;
    }), incumbent.map(record => record.identity),
      'both incumbent selections stay active throughout failed and replacement preparation');
  } });
  const pinned = await selections();
  assert.equal(attempts, 1, 'later imports belong to the next demand, without retrying the captured pair');
  assert.deepEqual(pinned.map(record => record.identity), incumbent.map(record => record.identity));
  assert.deepEqual(pinned.map(record => record.entrypoint), incumbent.map(record => record.entrypoint),
    'unchanged captured inputs reuse the existing product, including installed dependency inputs');
  await prepareSourceRuntimeReload(options);
  const replaced = await selections();
  assert.equal((await import(pathToFileURL(replaced[1].entrypoint))).ready, 'new-export');
  const digest = createHash('sha256').update(replacementSource).digest('hex');
  for (const record of replaced) assert.equal(record.sourceInputDigests['packages/protocol/src/shared.ts'], digest);
  assert.notEqual(replaced[0].identity, incumbent[0].identity);

  await writeFile(cliPath, 'import { added } from "@happier-dev/protocol"; export const ready = added + "-daemon-only";');
  await prepareSourceRuntimeReload(options);
  const daemonOnly = await selections();
  assert.equal(daemonOnly[0].identity, replaced[0].identity, 'unchanged Protocol reuses the server product');
  assert.notEqual(daemonOnly[1].identity, replaced[1].identity);
  assert.equal((await import(pathToFileURL(daemonOnly[1].entrypoint))).ready, 'new-export-daemon-only');
});

test('completed source runtime lookup reads one candidate and verifies outside publication custody', async t => {
  const graph = await reloadFixtureGraph(t, 'export {};');
  // This is a cold-build/adoption test, not a broken-incumbent recovery test.
  // The shared reload fixture intentionally seeds a nonexistent incumbent.
  await rm(graph.selectedPath);
  const repoDir = await createReloadDaemonRepo(graph.fixture, 'export const ready = 1;');
  const native = process.platform === 'linux' ? await installSourceAdmissionFixture(graph.fixture.root) : null;
  const build = native?.build ?? buildSourceRuntimeBundle;
  const options = { repoDir, stackBaseDir: graph.stackBaseDir, component: 'daemon', env: native?.env ?? process.env };
  const publicationLock = join(graph.stackBaseDir, '../source-bundles/publication.lock');
  const bundleRoot = dirname(publicationLock);
  const observerPath = graph.fixture.path('observe-cold-retention.mjs');
  const observerLoaded = graph.fixture.path('cold-observer-loaded');
  const allocationStarted = graph.fixture.path('cold-allocation-started');
  const coldInventories = graph.fixture.path('cold-inventories');
  // The admitted worker is a real child process. Observe its OS filesystem
  // boundary, allowing normal maintenance after its output allocation while
  // forbidding a store-wide retention pass for the read-only incumbent lookup.
  await writeFile(observerPath, `
    import fs from 'node:fs/promises';
    import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
    import { basename, dirname, resolve } from 'node:path';
    import { syncBuiltinESMExports } from 'node:module';
    const bundleRoot = ${JSON.stringify(bundleRoot)};
    const allocated = ${JSON.stringify(allocationStarted)};
    const readdir = fs.readdir;
    const mkdtemp = fs.mkdtemp;
    writeFileSync(${JSON.stringify(observerLoaded)}, 'loaded');
    fs.readdir = async (path, ...args) => {
      if (resolve(String(path)) === bundleRoot && !existsSync(allocated))
        appendFileSync(${JSON.stringify(coldInventories)}, 'inventory\\n');
      return await readdir(path, ...args);
    };
    fs.mkdtemp = async (...args) => {
      const path = await mkdtemp(...args);
      if (dirname(path) === bundleRoot && basename(path).startsWith('runtime-')) writeFileSync(allocated, 'allocated');
      return path;
    };
    syncBuiltinESMExports();
  `);
  const first = await build({ ...options, env: { ...options.env,
    NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${pathToFileURL(observerPath).href}`].filter(Boolean).join(' ') } });
  assert.equal(await readFile(observerLoaded, 'utf8'), 'loaded', 'the cold worker must execute the filesystem observer');
  const coldInventoryReads = (await readFile(coldInventories, 'utf8').catch(error => {
    if (error.code === 'ENOENT') return '';
    throw error;
  })).trim().split('\n').filter(Boolean).length;
  t.diagnostic(`coldPreallocationInventoryReads=${coldInventoryReads}`);
  assert.equal(coldInventoryReads, 0, 'read-only incumbent lookup must not run store-wide retention before allocation');
  const completionPath = join(first.runtimeDir, '../../source-bundle.json');
  const completed = JSON.parse(await readFile(completionPath, 'utf8'));
  assert.equal(Object.hasOwn(first, 'captureFingerprint'), false);
  assert.equal(Object.hasOwn(completed, 'captureFingerprint'), false, 'capture lookup metadata stays private to the finite producer');
  await rm(join(graph.stackBaseDir, 'source-runtime/selected-daemon.json'));
  for (let index = 0; index < 128; index += 1) {
    const directory = join(bundleRoot, `bundle-unrelated-${index}`);
    await mkdir(directory);
    await writeFile(join(directory, 'source-bundle.json'), JSON.stringify({ ...completed,
      dependencyPublication: { ...completed.dependencyPublication, identity: `unrelated-${index}` } }));
  }
  // Observe real filesystem and process boundaries. Retained unrelated
  // products must not be enumerated to answer one warm candidate lookup.
  const fs = (await import('node:fs/promises')).default;
  const childProcess = (await import('node:child_process')).default;
  const { syncBuiltinESMExports } = await import('node:module');
  const original = fs.readFile;
  const originalLstat = fs.lstat;
  const originalReaddir = fs.readdir;
  const originalSpawn = childProcess.spawn;
  let completionReads = 0;
  let protectedCompletionReads = 0;
  let inventoryReads = 0;
  let probes = 0;
  let probesUnderPublication = 0;
  let hashingUnderPublication = 0;
  fs.readFile = async (path, ...args) => {
    if (basename(String(path)) === 'source-bundle.json') {
      completionReads += 1;
      if (isJsonOwnerFileLockActive(publicationLock)) protectedCompletionReads += 1;
    }
    if (String(path).startsWith(repoDir) && isJsonOwnerFileLockActive(publicationLock)) hashingUnderPublication += 1;
    return await original(path, ...args);
  };
  fs.lstat = async (path, ...args) => {
    if (String(path).startsWith(repoDir) && isJsonOwnerFileLockActive(publicationLock)) hashingUnderPublication += 1;
    return await originalLstat(path, ...args);
  };
  fs.readdir = async (path, ...args) => {
    if (resolve(String(path)) === bundleRoot) inventoryReads += 1;
    return await originalReaddir(path, ...args);
  };
  childProcess.spawn = (...args) => {
    if (args[1]?.[0] === first.entrypoint) {
      probes += 1;
      if (isJsonOwnerFileLockActive(publicationLock)) probesUnderPublication += 1;
    }
    return originalSpawn(...args);
  };
  syncBuiltinESMExports();
  try {
    assert.equal((await build(options)).entrypoint, first.entrypoint);
    t.diagnostic(`retained=128 inventoryReads=${inventoryReads} completionReads=${completionReads} probesUnderPublication=${probesUnderPublication}`);
    assert.equal(inventoryReads, 0, 'warm lookup must not scan N retained bundle directories');
    assert.equal(completionReads, 2, 'only the chosen record and its final selection are read');
    assert.equal(protectedCompletionReads, 2, 'short completion admission and final selection both exclude retirement');
    assert.equal(hashingUnderPublication, 0);
    assert.equal(probes, 1);
    assert.equal(probesUnderPublication, 0, 'the real daemon import probe must run outside publication custody');
    assert.deepEqual(JSON.parse(await readFile(join(graph.stackBaseDir, 'source-runtime/selected-daemon.json'), 'utf8')),
      { entrypoint: first.entrypoint }, 'publication selection pins the completed candidate');
  } finally {
    fs.readFile = original;
    fs.lstat = originalLstat;
    fs.readdir = originalReaddir;
    childProcess.spawn = originalSpawn;
    syncBuiltinESMExports();
  }
});

test('source reload failing daemon leaves incumbent selection and loaded runtime intact', async t => {
  const graph = await reloadFixtureGraph(t, 'throw new ReferenceError("candidate-loader-broken");');
  await assert.rejects(admitSourceRuntimeReload({ stackBaseDir: graph.stackBaseDir,
    components: { daemon: graph.daemon }, pending: graph.pending }), error => {
    assert.match(error.message, /candidate-loader-broken/);
    assert.equal(error.entryGraph, 'daemon');
    assert.ok(error.firstFailingModule);
    return true;
  });
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

test('source reload refuses a lost prepared product before changing the incumbent', async t => {
  const graph = await reloadFixtureGraph(t, 'export {};');
  const admitted = await admitSourceRuntimeReload({ stackBaseDir: graph.stackBaseDir,
    components: { daemon: graph.daemon }, pending: graph.pending });
  await rm(graph.daemon.entrypoint);
  await assert.rejects(admitted.activate(), { code: 'source_bundle_unavailable', component: 'daemon', entryGraph: 'daemon',
    phase: 'activation', retryable: false });
  assert.deepEqual(JSON.parse(await readFile(graph.selectedPath, 'utf8')), graph.old);
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
  const probeDeadlines = [];
  const setTimeout = globalThis.setTimeout;
  // Source preparation belongs to the pending request's cancellation owner;
  // installed CLI probes retain their independent default deadline.
  t.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => {
    probeDeadlines.push(delay);
    return setTimeout(callback, delay, ...args);
  });
  const loading = admitSourceRuntimeReload({ stackBaseDir: graph.stackBaseDir,
    components: { daemon: graph.daemon }, pending: graph.pending });
  void loading.catch(() => {});
  let replacement;
  try {
    await Promise.race([entered, loading.then(() => { throw new Error('loader exited before interruption'); })]);
    assert.deepEqual(probeDeadlines, [], 'source command loads must not schedule a subordinate default deadline');
    replacement = await beginPendingSourceStart({ stackBaseDir: graph.stackBaseDir });
    await assert.rejects(loading, { code: 'ESOURCESTARTSUPERSEDED' });
    assert.deepEqual(JSON.parse(await readFile(graph.selectedPath, 'utf8')), graph.old);
    assert.deepEqual(JSON.parse(await readFile(graph.runtimePath, 'utf8')), graph.runtime);
  } finally {
    observer.close();
    graph.pending.abort(new Error('source probe fixture finished'));
    await loading.catch(() => {});
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

test('shared source daemon preparation uses joint admission and surfaces a genuine order refusal once',
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
  const available = fixture.path('available-memory');
  await writeFile(available, '16777216');
  await writeFile(fixture.path('bin/awk'), `#!/bin/sh
case "$*" in
  */proc/meminfo*)
    available=$(/bin/cat '${available}')
    printf '%s 16777216\\n' "$available"
    ;;
  */proc/loadavg*|*/proc/pressure/*) printf '0\\n' ;;
  *) exec /usr/bin/awk "$@" ;;
esac
`);
  let diagnostic = '';
  const stderrWrite = process.stderr.write;
  process.stderr.write = function(chunk, ...args) {
    diagnostic += String(chunk);
    return stderrWrite.call(this, chunk, ...args);
  };
  context.after(() => { process.stderr.write = stderrWrite; });
  // The source fingerprint lease and nested native compilation use the real
  // joint owner; ordinary composition needs no consumer-level replay.
  const built = await native.build({ repoDir, stackBaseDir: fixture.path('stacks/consumer'), component: 'daemon', env, signal: context.signal });
  assert.doesNotMatch(diagnostic, /HSTACK_WORKSPACE_ADMISSION_ORDER:|re-invoking joint workspace admission/);
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
  diagnostic = '';
  await withWorkspaceBundleLock(async ({ heldLockValue }) => {
    await assert.rejects(native.build({ repoDir, stackBaseDir: fixture.path('stacks/consumer'), component: 'daemon',
      env: { ...env, HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD: heldLockValue }, signal: context.signal }),
      { code: 1, sourceDrift: false }, 'a live inherited lease cannot wait for unavailable admission');
  }, { lockPath: fixture.path('unadmitted.lock') });
  assert.equal((diagnostic.match(/^HSTACK_WORKSPACE_ADMISSION_ORDER:/gm) ?? []).length, 1,
    'a genuine native refusal must surface once without replaying the producer');
  assert.doesNotMatch(diagnostic, /re-invoking joint workspace admission/);
  assert.deepEqual(await readdir(join(native.admissionRoot, 'owners')), []);
  assert.deepEqual(await readdir(join(native.admissionRoot, 'waiters')), []);
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

test('finite source web preparation waits for source repair and preserves cancellation', { timeout: 30000 }, async context => {
  const fixture = await createTempFixture(context, {prefix:'happier-source-start-drift-', registerCleanup:false});
  context.after(async () => { await makeFixtureWritable(fixture.root); await fixture.cleanup(); });
  const repoDir = fixture.path('repo');
  await installSourcePreparationInputs(repoDir, 'expo');
  const native = process.platform === 'linux' ? await installSourceAdmissionFixture(fixture.root) : null;
  const abort = new AbortController();
  context.after(() => abort.abort());
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

test('source author JavaScript failure reaches the bundle caller with package and source diagnostics', async context => {
  const fixture = await createTempFixture(context, {prefix:'happier-source-author-failure-'});
  const {build, env} = await installSourceAdmissionFixture(fixture.root);
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
    type:'module',main:'./dist/index.js',types:'./dist/index.js',
    exports:{'.':{'happier-source':'./src/index.ts',types:'./dist/index.js',default:'./dist/index.js'}},
    happier:{publicSdkRelease:{posture:'developer_preview'}}}));
  await writeFile(join(sdkDir, 'tsconfig.json'), JSON.stringify({compilerOptions:{target:'ES2022',
    module:'NodeNext',moduleResolution:'NodeNext',rootDir:'src',outDir:'dist',declaration:true},include:['src/**/*.ts']}));
  await writeFile(join(sdkDir, 'src/index.ts'), 'export const broken = ;');
  await symlink(sdkDir, join(repoDir, 'node_modules/@happier-dev/plugin-sdk'),
    process.platform === 'win32' ? 'junction' : 'dir');
  await symlink(dirname(createRequire(import.meta.url).resolve('esbuild/package.json')), join(cliDir, 'node_modules/esbuild'),
    process.platform === 'win32' ? 'junction' : 'dir');
  await installSourcePreparationInputs(repoDir, 'daemon');
  for (const location of [{outputDir:fixture.path('output')},
    {stackBaseDir:fixture.path('stacks/failure'),waitForSourceChanges:false}]) {
    await assert.rejects(build({repoDir,...location,component:'daemon',env}), error => {
      assert.equal(error.code, 'WORKSPACE_PACKAGE_BUILD_FAILED');
      assert.match(error.message, /phase=author-packages/);
      assert.match(error.message, /package=@happier-dev\/plugin-sdk/);
      assert.match(error.message, /src[/\\]index\.ts/);
      assert.match(error.message, /Unexpected/);
      return true;
    });
  }
  await writeFile(join(sdkDir, 'src/index.ts'), 'export const repaired = true;');
  const recovered = await build({repoDir,stackBaseDir:fixture.path('stacks/failure'),component:'daemon',env});
  assert.match(await readFile(join(recovered.runtimeDir, 'authoring/node_modules/@happier-dev/plugin-sdk/dist/index.js'), 'utf8'),
    /repaired = true/, 'a repaired package must emit and publish normally after a terminal refusal');
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
  const externalDir = join(repoDir, 'node_modules/.pnpm/author-external/node_modules/author-external');
  const transitiveDir = join(dirname(externalDir), 'author-types');
  await mkdir(join(externalDir, 'dist'), {recursive:true});
  await symlink(externalDir, join(sdkDir, 'node_modules/author-external'), process.platform === 'win32' ? 'junction' : 'dir');
  await mkdir(transitiveDir, {recursive:true});
  await writeFile(join(transitiveDir, 'package.json'), JSON.stringify({name:'author-types',version:'1.0.0',
    type:'module',main:'./index.js',types:'./index.d.ts'}));
  await writeFile(join(transitiveDir, 'index.d.ts'), 'export declare function createValue(value: string): { value: string };');
  await writeFile(join(transitiveDir, 'index.js'), 'export function createValue(value) { return {value}; }');
  await writeFile(join(externalDir, 'package.json'), JSON.stringify({name:'author-external',version:'1.0.0',
    type:'module',types:'./dist/index.d.ts'}));
  await writeFile(join(externalDir, 'dist/index.d.ts'), "export {createValue as createAuthorValue} from 'author-types';");
  await writeFile(join(externalDir, 'dist/index.js'), "export {createValue as createAuthorValue} from 'author-types';");
  await writeFile(join(externalDir, 'package.json'), JSON.stringify({name:'author-external',version:'1.0.0',
    type:'module',main:'./dist/index.js',types:'./dist/index.d.ts',dependencies:{'author-types':'1.0.0'}}));
  await writeFile(join(sdkDir, 'src/authorValue.ts'), 'export const authorValue = "package-alias";');
  await writeFile(join(sdkDir, 'src/index.ts'), "/// <reference path='../node_modules/author-external/dist/index.d.ts' />\nimport {marker} from '@happier-dev/protocol';\nexport {marker};\nexport const canonicalMarker = marker;\nimport {authorValue} from '#author-value';\nexport const canonicalAlias = authorValue;\nimport {createAuthorValue} from 'author-external';\nexport function echo(value: string) { return createAuthorValue(value).value; }\n");
  await symlink(dirname(createRequire(import.meta.url).resolve('esbuild/package.json')), join(cliDir, 'node_modules/esbuild'),
    process.platform === 'win32' ? 'junction' : 'dir');
  const env = process.env;
  const stackBaseDir = fixture.path('stacks/author');
  await installSourcePreparationInputs(repoDir, 'daemon');
  let declarationCompilers = 0;
  const originalSpawn = childProcess.spawn;
  childProcess.spawn = function(command, args, ...options) {
    if (args?.some(arg => arg === '--project' || arg === '-p')) declarationCompilers++;
    return originalSpawn.call(this, command, args, ...options);
  };
  syncBuiltinESMExports();
  context.after(() => { childProcess.spawn = originalSpawn; syncBuiltinESMExports(); });
  let runtime = await buildSourceRuntimeBundle({repoDir, stackBaseDir, component:'daemon', env});
  const compilerCount = async () => declarationCompilers;
  assert.equal(await compilerCount(), 0, 'ordinary source preparation launches no declaration compilers');
  const {build: buildAuthorOwner} = createRequire(new URL('../../../cli/package.json', import.meta.url))('esbuild');
  const declarationOwner = fixture.path('author-declarations.mjs');
  await buildAuthorOwner({entryPoints:[fileURLToPath(new URL('../../../cli/src/plugins/authoring/sourceDeclarations.ts', import.meta.url))],
    outfile:declarationOwner,bundle:true,platform:'node',format:'esm',conditions:['happier-source'],logLevel:'silent'});
  const {emitSourceAuthorDeclarations} = await import(pathToFileURL(declarationOwner).href);
  const readAuthorDeclarations = async runtimeDir => {
    const root = await mkdtemp(fixture.path('materialized-author-'));
    await cp(join(runtimeDir,'authoring'),root,{recursive:true});
    await makeFixtureWritable(root);
    const sdk = join(root,'node_modules/@happier-dev/plugin-sdk');
    await emitSourceAuthorDeclarations([sdk],async projectPath => {
      const args = ['-p',projectPath];
      const invocation = resolveTypeScriptCliInvocation({args,workspaceDir:repoDir,admissionClass:'source-bundle',invocationKind:'build'});
      await promisify(execFile)(invocation.command,[...invocation.argsPrefix,...args],{cwd:repoDir,env});
    });
    return await readFile(join(sdk,'dist/index.d.ts'),'utf8');
  };
  const record = JSON.parse(await readFile(join(runtime.runtimeDir, '../../source-bundle.json'), 'utf8'));
  const sdkInput = Object.entries(record.sourceInputDigests).find(([path]) => path.endsWith('packages/plugin-sdk/src/index.ts'));
  assert.match(sdkInput?.[1], /^[a-f0-9]{64}$/,
    'settled compiler source bytes must remain eligible for normal source-bundle reuse');
  assert.equal(Object.keys(record.sourceInputDigests).some(path => path.includes('node_modules/@happier-dev/protocol/')), false,
    'author inputs must resolve canonical workspace source rather than a stale installed shadow');
  const warm = await buildSourceRuntimeBundle({repoDir, stackBaseDir, component:'daemon'});
  assert.equal(warm.entrypoint, runtime.entrypoint, 'settled public author closure reuses the existing source bundle');
  assert.equal(await compilerCount(), 0,
    'unchanged preparation performs zero author-package compiler emissions');
  const authorBytes = async root => {
    const files = {};
    const visit = async directory => {
      for (const entry of await readdir(directory, {withFileTypes:true})) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await visit(path);
        else if (entry.isFile()) files[relative(root, path)] = createHash('sha256').update(await readFile(path)).digest('hex');
      }
    };
    await visit(root);
    return files;
  };
  const originalAuthorBytes = await authorBytes(join(runtime.runtimeDir, 'authoring'));
  await writeFile(join(cliDir, 'src/index.ts'), 'export const ready = "host-only-change";');
  const hostOnly = await buildSourceRuntimeBundle({repoDir, stackBaseDir, component:'daemon', env});
  assert.notEqual(hostOnly.entrypoint, runtime.entrypoint, 'the daemon must consume its changed host source');
  assert.equal(await compilerCount(), 0,
    'a host-only change performs zero unchanged author-package compiler emissions');
  assert.deepEqual(await authorBytes(join(hostOnly.runtimeDir, 'authoring')), originalAuthorBytes,
    'unchanged authoring inputs retain a byte-identical served package closure');
  runtime = hostOnly;
  // Workspace-only wiring changes the installation publication without
  // changing any installed external/compiler input to the author closure.
  const dependencyOnlyStarted = performance.now();
  const unrelatedDir = join(repoDir, 'packages/unrelated');
  await mkdir(unrelatedDir, {recursive:true});
  await writeFile(join(unrelatedDir, 'package.json'), JSON.stringify({name:'@happier-dev/unrelated',version:'0.0.0'}));
  const cliManifest = JSON.parse(await readFile(join(cliDir, 'package.json'), 'utf8'));
  cliManifest.dependencies['@happier-dev/unrelated'] = 'workspace:*';
  cliManifest.bundledDependencies.push('@happier-dev/unrelated');
  await writeFile(join(cliDir, 'package.json'), JSON.stringify(cliManifest));
  await writeFile(join(repoDir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n# workspace-only wiring\n');
  await writeFile(resolveDependencyRefreshMarkerPath(repoDir), JSON.stringify({identity:'workspace-only-install'}));
  const previousAuthorPackages = new Map(await Promise.all(['plugin-sdk', 'protocol'].map(async name =>
    [name, await authorBytes(join(runtime.runtimeDir, 'authoring/node_modules/@happier-dev', name))])));
  const dependencyOnly = await buildSourceRuntimeBundle({repoDir, stackBaseDir, component:'daemon', env});
  assert.notEqual(dependencyOnly.entrypoint, runtime.entrypoint, 'the daemon must bind the new dependency publication');
  assert.equal(await compilerCount(), 0,
    'workspace-only dependency changes perform zero unchanged author-package compiler emissions');
  for (const name of ['plugin-sdk', 'protocol']) {
    assert.deepEqual(await authorBytes(join(dependencyOnly.runtimeDir, 'authoring/node_modules/@happier-dev', name)),
      previousAuthorPackages.get(name));
  }
  assert.equal(JSON.parse(await readFile(join(dependencyOnly.runtimeDir,
    'authoring/node_modules/@happier-dev/unrelated/package.json'), 'utf8')).name, '@happier-dev/unrelated',
  'unchanged author compilation must not hide changed host bundle membership');
  context.diagnostic(`dependency-only rebuild: compilers=${await compilerCount()-0} elapsedMs=${Math.round(performance.now()-dependencyOnlyStarted)}`);
  delete cliManifest.dependencies['@happier-dev/unrelated'];
  cliManifest.bundledDependencies = cliManifest.bundledDependencies.filter(name => name !== '@happier-dev/unrelated');
  await writeFile(join(cliDir, 'package.json'), JSON.stringify(cliManifest));
  await writeFile(resolveDependencyRefreshMarkerPath(repoDir), JSON.stringify({identity:'workspace-only-removal'}));
  runtime = await buildSourceRuntimeBundle({repoDir, stackBaseDir, component:'daemon', env});
  assert.equal(await compilerCount(), 0, 'removing unrelated workspace wiring needs no author compilation');
  await assert.rejects(access(join(runtime.runtimeDir, 'authoring/node_modules/@happier-dev/unrelated')), {code:'ENOENT'},
    'removed host bundles must not survive through the retained author closure');
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
  await assert.rejects(access(join(sdkRoot, 'dist/index.d.ts')), {code:'ENOENT'}, 'runtime preparation leaves declarations to author materialization');
  const declarations = await readAuthorDeclarations(runtime.runtimeDir);
  assert.match(declarations, /echo\(value: string\): string/);
  assert.match(declarations, /canonicalMarker = "current-source"/);
  assert.match(declarations, /canonicalAlias = "package-alias"/);
  const nestedRuntime = await buildSourceRuntimeBundle({repoDir, outputDir:join(cliDir, '.source-output'), component:'daemon'});
  assert.match(await readAuthorDeclarations(nestedRuntime.runtimeDir),
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
  await writeFile(join(protocolDir, 'src/index.ts'), 'export const marker = "current-source";');
  const originalProtocolBytes = await authorBytes(join(runtime.runtimeDir, 'authoring/node_modules/@happier-dev/protocol'));
  const beforeAuthorChange = await compilerCount();
  // author-sdk-reuse-1107: a package-local edit must not recompile an
  // unchanged dependency. Count real compiler launches, retaining the real
  // capture, package copier and SDK consumer above.
  await writeFile(join(sdkDir, 'src/authorValue.ts'), 'export const authorValue = "changed-package-alias";');
  const sdkOnly = await buildSourceRuntimeBundle({repoDir, stackBaseDir, component:'daemon', env});
  assert.equal(await compilerCount() - beforeAuthorChange, 0,
    'one changed SDK package emits JavaScript without declaration compilation');
  assert.deepEqual(await authorBytes(join(sdkOnly.runtimeDir, 'authoring/node_modules/@happier-dev/protocol')),
    originalProtocolBytes,
    'unchanged dependency output remains byte-identical');
  assert.match(await readAuthorDeclarations(sdkOnly.runtimeDir),
    /canonicalAlias = "changed-package-alias"/);
  await writeFile(join(protocolDir, 'src/index.ts'), 'export const marker = "moving-source";');
  const beforeDependencyChange = await compilerCount();
  const changedAuthor = await buildSourceRuntimeBundle({repoDir, stackBaseDir, component:'daemon', env});
  assert.equal(await compilerCount() - beforeDependencyChange, 0,
    'a changed workspace dependency emits JavaScript without declaration compilation');
  assert.match(await readAuthorDeclarations(changedAuthor.runtimeDir),
    /canonicalMarker = "moving-source"/, 'changed dependency source reaches the served author SDK');
  assert.notDeepEqual(await authorBytes(join(changedAuthor.runtimeDir, 'authoring')), originalAuthorBytes);
  await writeFile(join(protocolDir, 'native/resource.bin'), new Uint8Array([255, 0, 23]));
  const beforeResourceChange = await compilerCount();
  const changedResource = await buildSourceRuntimeBundle({repoDir, stackBaseDir, component:'daemon', env});
  assert.equal(await compilerCount() - beforeResourceChange, 0,
    'a packaged resource change needs no declaration compilation');
  assert.deepEqual(new Uint8Array(await readFile(join(changedResource.runtimeDir,
    'authoring/node_modules/@happier-dev/protocol/native/resource.bin'))), new Uint8Array([255, 0, 23]),
  'changed packaged resources must invalidate author-closure reuse');
  if (process.platform !== 'win32') {
    await chmod(join(protocolDir, 'native/resource.bin'), 0o755);
    const changedMode = await buildSourceRuntimeBundle({repoDir, stackBaseDir, component:'daemon', env});
    assert.equal((await stat(join(changedMode.runtimeDir,
      'authoring/node_modules/@happier-dev/protocol/native/resource.bin'))).mode & 0o111, 0o111,
    'a shipped resource mode change must reach the physical author package');
  }
  const beforeExternalChange = await compilerCount();
  await writeFile(join(transitiveDir, 'index.d.ts'), 'export declare function createValue(value: string): { value: number };');
  await writeFile(join(transitiveDir, 'index.js'), 'export function createValue(value) { return {value:value.length}; }');
  await writeFile(resolveDependencyRefreshMarkerPath(repoDir), JSON.stringify({identity:'external-install-change'}));
  const changedExternal = await buildSourceRuntimeBundle({repoDir, stackBaseDir, component:'daemon', env});
  assert.equal(await compilerCount() - beforeExternalChange, 0,
    'changed external declaration inputs are captured without compiling declarations');
  assert.match(await readAuthorDeclarations(changedExternal.runtimeDir), /echo\(value: string\): number/,
  'the served author SDK must consume the changed external declaration');
  const changedSdkUrl = pathToFileURL(join(changedExternal.runtimeDir,
    'authoring/node_modules/@happier-dev/plugin-sdk/dist/index.js')).href;
  const changedAuthorExecution = await promisify(execFile)(process.execPath,
    ['--input-type=module', '--eval', `import {echo} from ${JSON.stringify(changedSdkUrl)}; console.log(echo('four'));`],
    {env:{...process.env,...changedExternal.env}});
  assert.equal(changedAuthorExecution.stdout.trim(), '4', 'the emitted SDK serves changed transitive runtime dependency bytes');
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
  const captureStarted = Date.now();
  const first = await build(options);
  assert.equal((await import(pathToFileURL(first.entrypoint))).ready, 1, 'entry discovery and compilation must consume the same captured view');
  const firstRecord = JSON.parse(await readFile(resolve(dirname(first.entrypoint), '../../../source-bundle.json'), 'utf8'));
  assert.ok(Date.parse(first.sourceCapture?.capturedAt) >= captureStarted);
  assert.match(first.sourceCapture?.inputIdentity ?? '', /^[a-f0-9]{64}$/);
  assert.deepEqual(firstRecord.sourceCapture, first.sourceCapture, 'activation metadata describes the exact completed captured graph');
  await writeFile(entry, original);
  const warm = await build(options);
  assert.equal(warm.entrypoint, first.entrypoint, 'unconsumed live churn must preserve a completed captured graph');
  assert.deepEqual(warm.sourceCapture, first.sourceCapture, 'reuse preserves capture identity and time instead of claiming a new capture');
  assert.equal((await readFile(builds, 'utf8')).trim().split('\n').length, 1);
  await writeFile(entry, 'import {value} from "./added.js"; export const ready = value;');
  await writeFile(join(cliDir, 'src/added.ts'), 'export const value = 3;');
  const added = await build(options);
  assert.equal((await import(pathToFileURL(added.entrypoint))).ready, 3, 'new transitive imports change the captured graph');
  await writeFile(entry, 'import {value} from "./added.js"; export const ready = value;');
  await rm(join(cliDir, 'src/added.ts'));
  await assert.rejects(build(options), { code: 'source_runtime_producer_failed' });
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
  const unconsumed = join(cliDir, 'src/unconsumed.ts');
  await writeFile(unconsumed, 'export const unused = true;');
  const stacks = [join(root, 'stacks/a'), join(root, 'stacks/b')];
  await installSourcePreparationInputs(repoDir, 'daemon');
  const native = process.platform === 'linux' ? await installSourceAdmissionFixture(root) : null;
  const build = native?.build ?? buildSourceRuntimeBundle;
  const buildEnv = { ...(native?.env ?? process.env) };
  const runtimeUrl = native ? pathToFileURL(native.runtimePath).href : new URL('./build_source_runtime.mjs',import.meta.url).href;
  const script = `import {buildSourceRuntimeBundle} from ${JSON.stringify(runtimeUrl)}; console.log(JSON.stringify(await buildSourceRuntimeBundle({repoDir:process.argv[1],stackBaseDir:process.argv[2],component:'daemon'})));`;
  const results = await Promise.all(stacks.map(async stackBaseDir => {
    const {stdout} = await promisify(execFile)(process.execPath, ['--input-type=module', '--eval', script, repoDir, stackBaseDir],
      {env:{...buildEnv,HAPPIER_STACK_RUNTIME_BUILD_AUTHORITY_STACK:basename(stackBaseDir)}});
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
  const filesystem = (await import('node:fs/promises')).default;
  const originalRename = filesystem.rename;
  filesystem.rename = async (from, to, ...args) => {
    if (dirname(String(to)) === join(root, 'stacks/source-bundles') && basename(String(to)).startsWith('candidate-')) {
      throw Object.assign(new Error('ENOSPC adopting captured source'), { code: 'ENOSPC' });
    }
    return await originalRename(from, to, ...args);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(build({ repoDir, stackBaseDir: stacks[0], component: 'daemon', env: buildEnv, waitForSourceChanges: false }),
      { code: 'ENOSPC' });
    assert.deepEqual(JSON.parse(await readFile(join(stacks[0], 'source-runtime/selected-daemon.json'), 'utf8')),
      { entrypoint: fourth.entrypoint }, 'failed current-hint publication preserves the incumbent selection');
  } finally { filesystem.rename = originalRename; syncBuiltinESMExports(); }
  const readopted = await build({repoDir, stackBaseDir:stacks[0], component:'daemon',env:buildEnv, waitForSourceChanges: false});
  assert.equal(readopted.entrypoint, results[0].entrypoint);
  const originalLstat = filesystem.lstat;
  let unconsumedFingerprintReads = 0;
  filesystem.lstat = async (path, ...args) => {
    if (resolve(String(path)) === unconsumed) unconsumedFingerprintReads += 1;
    return await originalLstat(path, ...args);
  };
  syncBuiltinESMExports();
  try {
    assert.equal((await build({ repoDir, stackBaseDir: stacks[0], component: 'daemon', env: buildEnv, waitForSourceChanges: false })).entrypoint, readopted.entrypoint);
    assert.equal(unconsumedFingerprintReads, 0, 'a restored product becomes the current hint without another full fingerprint');
  } finally { filesystem.lstat = originalLstat; syncBuiltinESMExports(); }
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
  const remoteState = { runtimeMode: 'source-snapshot', placement: { daemon: 'remote-host' },
    remoteTargets: { 'remote-host': { services: { daemon: true }, runtimeMode: 'source-snapshot' } },
    sourceRuntimeLaunch: { entrypoint: pending.entrypoint, cliDir: dirname(pending.entrypoint) },
    sourceRuntimeIdentities: { daemon: { selected: 'remote-code', loaded: 'remote-code' } } };
  const controller = await resolveStackRuntimeLaunchContext({ argv: ['--runtime=source'], env,
    activeRuntimeState: remoteState });
  // The controller CLI follows the target's retained source publication so
  // auth and other stack commands use the same capture as the loaded daemon.
  assert.equal(controller.runtimeMode.mode, 'source-snapshot');
  assert.equal(controller.cliLaunchSpec.entrypoint, pending.entrypoint);
  assert.equal(await readFile(selectionPath, 'utf8'), selection);
  const localController = await resolveStackRuntimeLaunchContext({ argv: ['--runtime=source'], env,
    activeRuntimeState: { ...remoteState, placement: { daemon: 'local' } } });
  assert.equal(localController.cliLaunchSpec.entrypoint, pending.entrypoint,
    'a retained source publication is valid for local placement as well');
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
  // becomes reclaimable at a later publication; warm adoption does not run GC.
  await native.build(options);
  await writeFile(entry, 'export const ready = 3;');
  await native.build(options);
  await assert.rejects(access(pending.entrypoint), { code: 'ENOENT' });
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
    { code: 'source_runtime_producer_failed', reason: 'ENOSPC' });
  assert.equal(await readFile(selectionPath,'utf8'),priorSelection,
    'failed completion publication must preserve the previous coherent selection');
  const recovered = await native.build({...options,reuseSelected:true});
  assert.equal(recovered.entrypoint,prior.entrypoint);
  assert.equal((await import(pathToFileURL(recovered.entrypoint))).ready,1);
  assert.equal((await readdir(fixture.path('stacks/source-bundles'))).filter(name=>/^(bundle|runtime)-/.test(name)).length,1);
});

test('different source fingerprints serialize at the producer and retention preserves an unfinished graph',
  {skip:process.platform !== 'linux',timeout:30000}, async context => {
  const fixture = await createTempFixture(context, {prefix:'happier-source-independent-',registerCleanup:false});
  context.after(async () => { await makeFixtureWritable(fixture.root); await rm(fixture.root,{recursive:true,force:true}); });
  const native = await installSourceAdmissionFixture(fixture.root);
  // Resource headroom must not bypass the repository producer's serial lease.
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
  let waiting;
  const queued = new Promise(resolve => { waiting = resolve; });
  const secondRequest = native.build({repoDir:repos[1],stackBaseDir:fixture.path('stacks/b'),component:'daemon',
    env:native.env,signal:context.signal,stderrStream:{write(chunk) {
      if (String(chunk).includes('build-producer.lock')) waiting();
    }}});
  await queued;
  const { reclaimSourceBundles } = await import(pathToFileURL(native.runtimePath));
  const bundleRoot = fixture.path('stacks/source-bundles');
  const unfinished = (await readdir(bundleRoot)).find(name => name.startsWith('runtime-'));
  assert.ok(unfinished);
  await reclaimSourceBundles({ stacksRoot: fixture.path('stacks'), dryRun: false });
  await access(join(bundleRoot, unfinished));
  await writeFile(release,'release');
  const outcome = await completion;
  if(outcome.error) throw outcome.error;
  assert.equal((await import(pathToFileURL(outcome.built.entrypoint))).ready,0);
  const second = await secondRequest;
  assert.equal((await import(pathToFileURL(second.entrypoint))).ready,1);
  await access(outcome.built.entrypoint);
});

test('source producer waiting retains no fingerprint or publication custody and selected recovery bypasses admission',
  {skip:process.platform !== 'linux',timeout:30000}, async context => {
  const fixture = await createTempFixture(context, {prefix:'happier-source-joint-admission-',registerCleanup:false});
  context.after(async () => { await makeFixtureWritable(fixture.root); await rm(fixture.root,{recursive:true,force:true}); });
  const native = await installSourceAdmissionFixture(fixture.root);
  const repoDir = await createReloadDaemonRepo(fixture, 'export const ready = 1;');
  const stackBaseDir = fixture.path('stacks/consumer');
  const options = {repoDir,stackBaseDir,component:'daemon',env:native.env};
  const selected = await native.build(options);
  await writeFile(join(repoDir,'apps/cli/src/index.ts'),'export const ready = 2;');
  const { sourceRuntimeProducerBuildLockPath } = await import(pathToFileURL(native.runtimePath));
  const controller = new AbortController();
  let completion;
  context.after(async () => { controller.abort(); if (completion) await completion; });
  await withWorkspaceBundleLock(async () => {
    let waiting;
    const queued = new Promise(resolve => { waiting = resolve; });
    completion = native.build({...options,signal:AbortSignal.any([controller.signal,context.signal]),
      stderrStream:{write(chunk) { if (String(chunk).includes('build-producer.lock')) waiting(); }}})
      .then(built => ({built}),error => ({error}));
    await queued;
    const bundleRoot = fixture.path('stacks/source-bundles');
    const names = await readdir(bundleRoot);
    assert.deepEqual(names.filter(name => /^build-[a-f0-9]{64}\.lock$/.test(name)), [],
      'producer waiting must not retain a captured graph lease');
    assert.equal(names.includes('publication.lock'), false);
    const recovered = await native.build({...options,reuseSelected:'if-available',signal:context.signal});
    assert.equal(recovered.entrypoint,selected.entrypoint);
    assert.deepEqual((await readdir(bundleRoot)).filter(name => /^(bundle|runtime)-/.test(name)),
      names.filter(name => /^(bundle|runtime)-/.test(name)), 'selected recovery allocates no replacement');
  }, {lockPath:sourceRuntimeProducerBuildLockPath(stackBaseDir),signal:context.signal});
  const next = await completion;
  if(next.error) throw next.error;
  assert.notEqual(next.built.entrypoint,selected.entrypoint);
  assert.equal((await import(pathToFileURL(next.built.entrypoint))).ready,2);
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
  for (const file of ['registerSourceRuntime.mjs', 'sourceRuntimeEntries.mjs', 'sourceRuntimeDependencies.mjs', 'cliRuntimeSidecars.mjs']) {
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
  // Published consumers do not inherit the source tool's workspace resolver.
  // Resolve the public export in the same fresh product process boundary.
  const { stdout: publicLibraryValue } = await promisify(execFile)(process.execPath,
    ['--input-type=module', '--eval', `import {createRequire} from 'node:module';
      import {pathToFileURL} from 'node:url';
      const library=createRequire(${JSON.stringify(join(result.cliDir, 'package.json'))}).resolve('@happier-dev/cli/lib');
      console.log((await import(pathToFileURL(library))).value);`],
    { env: { ...process.env, NODE_OPTIONS: '' } });
  assert.equal(publicLibraryValue.trim(), 'frozen-library');
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
    const {build, env} = await installSourceAdmissionFixture(fixture.root);
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
    const pending = build({repoDir,outputDir:fixture.path('output'),component:'daemon',
      signal:AbortSignal.any([controller.signal,context.signal]),env:{...env,
        NODE_OPTIONS:`${env.NODE_OPTIONS??''} --import=${pathToFileURL(observer).href}`.trim()}});
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


for (const publicationCase of ['changed', 'empty', 'unchanged']) {
  test(`source reload bundled publication ${publicationCase} preserves the admitted plugin failure contract`, async t => {
    const graph = await reloadFixtureGraph(t, 'export {};');
    const failure = { packageName: '@happier-dev/plugins-example', pluginId: 'example',
      diagnostic: { code: 'plugin_manifest_invalid', message: 'Manifest rejected' } };
    const incumbentFailures = [failure];
    const replacementFailures = publicationCase === 'empty' ? []
      : publicationCase === 'unchanged' ? incumbentFailures
      : [{ ...failure, diagnostic: { ...failure.diagnostic, message: '/private/plugin-path/manifest.json rejected' } }];
    const artifactPath = '.project/tmp/bundled-plugin-publication/failures.json';
    for (const [cliDir, failures] of [[dirname(dirname(graph.old.entrypoint)), incumbentFailures],
      [graph.daemon.runtimeDir, replacementFailures]]) {
      const path = join(cliDir, artifactPath);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, JSON.stringify(failures));
    }
    const admission = admitSourceRuntimeReload({ stackBaseDir: graph.stackBaseDir,
      components: { daemon: graph.daemon }, pending: graph.pending });
    if (publicationCase === 'changed') {
      await assert.rejects(admission, error => {
        assert.equal(error.code, 'ESOURCERELOADNOTREADY');
        assert.equal(error.reason, 'bundled_plugin_failures_changed');
        const pluginFailures = [{ pluginId: 'example', diagnostic: { code: 'plugin_manifest_invalid' } }];
        assert.deepEqual(error.pluginFailures, pluginFailures);
        assert.match(error.message, /example.*plugin_manifest_invalid/);
        assert.ok(!error.message.includes('/private/plugin-path'));
        const transported = parseSourceReloadRefusalLine('HSTACK_SOURCE_RELOAD_REFUSAL='
          + JSON.stringify(readSourceReloadRefusal(error)));
        assert.equal(transported.phase, 'bundled-plugin-publication');
        assert.equal(transported.component, 'daemon');
        assert.deepEqual(transported.pluginFailures, pluginFailures);
        assert.ok(!JSON.stringify(transported).includes('/private/plugin-path'));
        assert.deepEqual(projectStackReloadVerification({ failure: { check: 'start', error: transported } }), {
          status: 'NOT_READY', check: 'start', baseline: 'unavailable',
          evidence: { code: 'ESOURCERELOADNOTREADY', reason: 'bundled_plugin_failures_changed', pluginFailures },
        });
        return true;
      });
    } else {
      await (await admission).activate();
      assert.deepEqual(JSON.parse(await readFile(graph.selectedPath, 'utf8')), { entrypoint: graph.daemon.entrypoint });
    }
    if (publicationCase === 'changed') {
      assert.deepEqual(JSON.parse(await readFile(graph.selectedPath, 'utf8')), graph.old);
    }
    assert.deepEqual(JSON.parse(await readFile(graph.runtimePath, 'utf8')), graph.runtime);
  });
}


for (const artifactCase of ['missing', 'malformed']) {
  test(`source reload bundled publication ${artifactCase} refuses an unknown replacement`, async t => {
    const graph = await reloadFixtureGraph(t, 'export {};');
    const artifact = join(graph.daemon.runtimeDir, '.project/tmp/bundled-plugin-publication/failures.json');
    if (artifactCase === 'missing') await rm(artifact);
    else await writeFile(artifact, '{}');
    await assert.rejects(admitSourceRuntimeReload({ stackBaseDir: graph.stackBaseDir,
      components: { daemon: graph.daemon }, pending: graph.pending }), error => {
      assert.equal(error.code, 'ESOURCERELOADNOTREADY');
      assert.equal(error.reason, 'bundled_plugin_failures_unavailable');
      return true;
    });
    assert.deepEqual(JSON.parse(await readFile(graph.selectedPath, 'utf8')), graph.old);
    assert.deepEqual(JSON.parse(await readFile(graph.runtimePath, 'utf8')), graph.runtime);
  });
}
