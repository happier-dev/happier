// @happier-test-preparation source-condition
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lstat, access, chmod, cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { watch } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { runInNewContext } from 'node:vm';
import { run } from '../utils/proc/proc.mjs';
import { exportSourceWebUi, withSourceWebUiInputs } from './build_source_web_ui.mjs';
import { createTempFixture } from '../testkit/core/temp_fixture.mjs';
import { startRunningStackOwner } from '../testkit/core/running_stack_owner.mjs';
import { prepareFiniteSourceWebFixture, relocateSourceOwnerImports } from '../testkit/core/source_web_fixture.mjs';
import { buildNativeAdmissionFixtureEnv, holdNativeAdmissionFixtureMemory, installNativeAdmissionFixture } from '../testkit/core/native_admission_fixture.mjs';
import { captureSourceWebBuildInputs, readWorkspacePackages, setBundleReadOnly, withSourceBundlePublication } from './build_source_runtime.mjs';
import { ensureExpoWorkspacePrepared, hasUsableExpoWorkspaceLastGreen, withExpoPreparationEnv } from '../utils/expo/command.mjs';
import { runNodeCapture } from '../testkit/core/run_node_capture.mjs';
import { sourceBuildNodeArgs } from '../utils/proc/runSourceBuildCommand.mjs';
import { sanitizeStackTestRunnerEnv } from '../utils/test/test_env.mjs';
import { recordStackRuntimeStart, readStackRuntimeStateFile } from '../utils/stack/runtime_state.mjs';
import { resolveSourceQaUiMode } from '../runtime/shared/borrowed_expo.mjs';
import { beginPendingSourceStart } from '../runtime/shared/pending_source_start.mjs';
import { inspectDependencyRefresh, resolveDependencyRefreshLockPath, resolveDependencyRefreshMarkerPath, withDependencyRefreshLock } from '../utils/proc/dependency_refresh.mjs';
import { withPatchedProcessEnv } from '../testkit/core/env_scope.mjs';
import { resolveHeavyweightMemoryFloorKiB } from '../utils/dev_targets/remote_commands.mjs';
import { isJsonOwnerFileLockActive } from '../utils/proc/jsonOwnerFileLock.mjs';
import { isWorkspaceBundleLockActive, withWorkspaceBundleLock } from '../../../../packages/cli-common/workspaceBundleLock.mjs';
import { resolveSourceRevisionIdentity, writeSourceRevisionDescriptor } from './source_revision.mjs';
import { resolveSourceTreeRevision, writeSourceRevisionArchive } from './source_revision_tree.mjs';
import { mountCapturedWorkspaceDependencies } from '../../../../scripts/workspaces/buildInputConvergence.mjs';
import { readSourceComponentBuildInputs } from '../utils/fs/workspaceBuildInputs.mjs';

for (const mode of ['fixed', 'old', 'still-broken', 'unnamed']) {
  test(`web producer capture retry: ${mode}`, async t => {
    const fixture = await createTempFixture(t, { prefix: 'web-capture-retry-' });
    const repoDir = fixture.path('repo');
    const { uiInput } = await prepareFiniteSourceWebFixture({ sourceRepo: fileURLToPath(new URL('../../../../', import.meta.url)), repoDir });
    let attempts = 0;
    const build = withSourceWebUiInputs({ repoDir, baseDir: fixture.path('state'),
      env: { ...process.env, EXPO_PUBLIC_DEBUG: '0' } }, async ({ uiProjectDir }) => {
        attempts++;
        if (attempts === 1 || mode === 'still-broken') {
          if (mode !== 'old') await writeFile(uiInput, 'export const repaired = true;');
          throw Object.assign(new Error('fixture compiler failure'), { code: 'source_runtime_producer_failed',
            ...(mode === 'unnamed' ? {} : { firstFailingModule: join(uiProjectDir, 'sources/app/_layout.tsx') }) });
        }
        return await readFile(join(uiProjectDir, 'sources/app/_layout.tsx'), 'utf8');
      });
    if (mode === 'fixed') assert.equal(await build, 'export const repaired = true;');
    else await assert.rejects(build, { code: 'source_runtime_producer_failed' });
    assert.equal(attempts, ['fixed', 'still-broken'].includes(mode) ? 2 : 1);
  });
}

test('a descriptor-only export preserves the typed unavailable revision archive refusal', async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-web-revision-install-' });
  const repoDir = fixture.path('repo');
  await mkdir(join(repoDir, 'apps/ui'), { recursive: true });
  await mkdir(join(repoDir, 'node_modules'));
  await writeFile(join(repoDir, 'package.json'), JSON.stringify({ workspaces: ['apps/*'] }));
  await writeFile(join(repoDir, 'apps/ui/package.json'), JSON.stringify({ name: '@happier-dev/ui' }));
  await writeFile(join(repoDir, 'pnpm-workspace.yaml'), 'packages: [apps/*]\n');
  await writeFile(join(repoDir, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
  await writeFile(join(repoDir, '.gitignore'), 'node_modules\n');
  const git = (...args) => execFileSync('git', ['-C', repoDir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args]);
  git('init', '--quiet');
  git('add', '-A');
  git('commit', '--quiet', '-m', 'selected');
  const identity = await resolveSourceRevisionIdentity({ repoDir, rev: 'HEAD', overlay: [] });
  const descriptorPath = await writeSourceRevisionDescriptor({ repoDir, identity, outputDir: fixture.path('descriptor'), components: ['expo'] });
  const env = { ...process.env, HAPPIER_STACK_SKIP_REFRESH_DEPS: '1' };
  const { installIdentity } = await inspectDependencyRefresh({ installDir: repoDir, env });
  const marker = resolveDependencyRefreshMarkerPath(repoDir);
  const capture = output => captureSourceWebBuildInputs({ repoDir, outputDir: fixture.path(output),
    revision: { descriptorPath }, env });
  const lockfile = join(repoDir, 'pnpm-lock.yaml');
  await writeFile(lockfile, (await readFile(lockfile, 'utf8')) + '\n# another lane\n');
  await writeFile(marker, JSON.stringify({ version: 7, identity: installIdentity }));
  assert.equal((await capture('matching')).revision.revision, identity.revision);
  const changed = await inspectDependencyRefresh({ installDir: repoDir, env });
  assert.notEqual(changed.installIdentity, installIdentity);
  await writeFile(marker, JSON.stringify({ version: 7, identity: changed.installIdentity }));
  await rm(join(repoDir, '.git'), { recursive: true });
  // Stub capacity admission only. Run the actual producer child, stderr
  // transport, refusal mapper, and public export entry point.
  const launcher = fixture.path('launcher.sh');
  await writeFile(launcher, '#!/bin/sh\nwhile [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n');
  const sourceUrl = new URL('./build_source_web_ui.mjs', import.meta.url);
  const publicOwner = fixture.path('export-owner.mjs');
  const source = (await readFile(sourceUrl, 'utf8'))
    .replace("fileURLToPath(new URL('../../bin/hstack-exec', import.meta.url))", JSON.stringify(launcher));
  await writeFile(publicOwner, relocateSourceOwnerImports(source, sourceUrl));
  const { exportSourceWebUi: exportShared } = await import(pathToFileURL(publicOwner));
  const stackBaseDir = fixture.path('stacks/producer');
  const pending = await beginPendingSourceStart({ stackBaseDir });
  t.after(() => pending.dispose());
  await assert.rejects(exportShared({ repoDir, baseDir: fixture.path('state'), stackBaseDir, pending,
    revision: { revision: identity.revision }, sourceRevision: { descriptorPath },
    env: { ...buildNativeAdmissionFixtureEnv(env), HAPPIER_STACK_STACK: 'producer',
      HAPPIER_STACK_RUNTIME_BUILD_AUTHORITY_STACK: 'producer' } }),
  { code: 'HAPPIER_SOURCE_REVISION_DEPENDENCIES_MISMATCH', phase: 'source-producer', sourceStack: 'producer' });
});

test('a clean source tree provides the installed Pierre worker and WASM to Expo public export', async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-web-pierre-worker-' });
  const repoDir = fixture.path('repo');
  await prepareFiniteSourceWebFixture({ sourceRepo: fileURLToPath(new URL('../../../../', import.meta.url)), repoDir });
  const uiDir = join(repoDir, 'apps/ui');
  const uiPackagePath = join(uiDir, 'package.json');
  const uiPackage = JSON.parse(await readFile(uiPackagePath, 'utf8'));
  const version = '7.8.9';
  uiPackage.dependencies['@pierre/diffs'] = version;
  await writeFile(uiPackagePath, JSON.stringify(uiPackage));

  // The installed package is the external boundary. The tree has no postinstall outputs.
  const scope = join(uiDir, 'node_modules/@pierre');
  await rm(scope, { recursive: true, force: true });
  const dist = join(scope, 'diffs/dist/worker');
  await mkdir(dist, { recursive: true });
  await writeFile(join(scope, 'diffs/package.json'), JSON.stringify({ name: '@pierre/diffs', version,
    main: 'dist/worker/worker-portable.js' }));
  await writeFile(join(dist, 'worker-portable.js'), 'import("./wasm-package.js");\n');
  const wasmContents = 'export const packageWasm = true;\n';
  await writeFile(join(dist, 'wasm-package.js'), wasmContents);
  const publicDir = join(uiDir, 'public');
  for (const name of await readdir(publicDir)) {
    if (name.startsWith('pierre-diff-worker')) await rm(join(publicDir, name));
  }

  const worker = `pierre-diff-worker.${version}.js`;
  const wasm = `pierre-diff-worker-wasm.${version}.js`;
  await withSourceWebUiInputs({ repoDir, baseDir: fixture.path('state'),
    tree: { dir: repoDir, revision: { revision: 'a'.repeat(40) } } }, async ({ uiProjectDir }) => {
    const expoPublicDir = join(uiProjectDir, 'public');
    assert.ok((await readFile(join(expoPublicDir, worker), 'utf8')).includes(`import("./${wasm}")`));
    assert.equal(await readFile(join(expoPublicDir, wasm), 'utf8'), wasmContents);
  });
  await assert.rejects(access(join(publicDir, worker)), { code: 'ENOENT' });
});

test('dependency publication web export discards a spanned candidate and returns only the rebuild', async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-web-dependency-publication-' });
  const repoDir = fixture.path('repo');
  await prepareFiniteSourceWebFixture({ sourceRepo: fileURLToPath(new URL('../../../../', import.meta.url)), repoDir });
  const env = { ...process.env, EXPO_PUBLIC_DEBUG: '0' };
  const generationPath = `${resolveDependencyRefreshLockPath(repoDir, env)}.generation`;
  await mkdir(dirname(generationPath), { recursive: true });
  await writeFile(generationPath, JSON.stringify({ generation: 'before', completedGeneration: 'before' }));
  let attempts = 0;
  const scratch = [];
  const built = await exportSourceWebUi({ repoDir, baseDir: fixture.path('state'), outputDir: fixture.path('export'), env,
    runImpl: async (_command, args, { env: exportEnv }) => {
      scratch.push(exportEnv.TMPDIR);
      await writeFile(join(exportEnv.TMPDIR, 'metro-scratch'), 'regenerable');
      const attempt = ++attempts;
      const web = args[args.indexOf('--output-dir') + 1];
      await mkdir(web);
      await writeFile(join(web, 'index.html'), '<script src="./app.js"></script>');
      await writeFile(join(web, 'app.js'), `globalThis.pass = ${attempt};`);
      if (attempt === 1) await writeFile(generationPath, JSON.stringify({ generation: 'after-writer', completedGeneration: 'after-writer' }));
    } });
  assert.equal(attempts, 2);
  assert.notEqual(scratch[0], scratch[1]);
  for (const directory of scratch) await assert.rejects(access(directory), { code: 'ENOENT' });
  assert.equal(await readFile(join(built.uiDir, 'app.js'), 'utf8'), 'globalThis.pass = 2;');
});

test('relocated source owners resolve multiline runtime imports', async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-relocated-source-owner-' });
  const owner = fixture.path('owner.mjs');
  await writeFile(owner, relocateSourceOwnerImports(
    "import { captureSourceWebBuildInputs,\n  readWorkspacePackages } from './build_source_runtime.mjs';\nexport const loaded = typeof captureSourceWebBuildInputs === 'function' && typeof readWorkspacePackages === 'function';",
    new URL('./build_source_web_ui.mjs', import.meta.url)));
  assert.equal((await import(pathToFileURL(owner))).loaded, true);
});

test('captured Metro crawls workspace-local installed dependencies', async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-captured-metro-dependencies-', registerCleanup: false });
  let metro;
  t.after(async () => { await metro?.end(); await fixture.cleanup(); });
  const sourceRepo = fileURLToPath(new URL('../../../../', import.meta.url));
  const repoDir = fixture.path('source');
  await prepareFiniteSourceWebFixture({ sourceRepo, repoDir });
  const uiPackagePath = join(repoDir, 'apps/ui/package.json');
  const uiPackage = JSON.parse(await readFile(uiPackagePath, 'utf8'));
  delete uiPackage.type; // The production Metro config is CommonJS.
  await writeFile(uiPackagePath, JSON.stringify(uiPackage));
  const dependencies = ['apps/ui/node_modules/@capture-fixture/local/index.js',
    'apps/ui/node_modules/capture-local/index.js', 'node_modules/capture-root/index.js'];
  for (const dependency of dependencies) {
    await mkdir(dirname(join(repoDir, dependency)), { recursive: true });
    await writeFile(join(repoDir, dependency), 'module.exports = "installed-dependency";');
  }
  const capture = await captureSourceWebBuildInputs({ repoDir, outputDir: fixture.path('capture') });
  const require = createRequire(join(capture.uiProjectDir, 'package.json'));
  withPatchedProcessEnv(t, { HAPPIER_UI_METRO_NARROW_WATCH_FOLDERS: '1', EXPO_NO_METRO_WORKSPACE_ROOT: '1' });
  const config = require('./metro.config.js');
  for (const directory of ['apps/docs', 'packages/tests']) assert.equal(
    config.watchFolders.includes(join(sourceRepo, directory)), false,
    'installed workspace aliases must not add unrelated authored source roots');
  const installedFiles = await Promise.all(dependencies.map(dependency => realpath(join(capture.repoDir, dependency))));
  // Restrict this file-map check to the roots chosen by the real config that
  // can contain this dependency; it needs no transform or unrelated UI graph.
  const contains = (root, file) => {
    const path = relative(root, file);
    return path === '' || (!path.startsWith('..') && !isAbsolute(path));
  };
  const roots = [config.projectRoot, ...config.watchFolders].filter(root => installedFiles.some(file => contains(root, file)));
  for (const file of installedFiles) assert.ok(roots.some(root => contains(root, file)),
    'resolved workspace-local and root bytes must be inside Metro crawl roots');
  config.watchFolders = roots;
  config.maxWorkers = 1;
  config.resolver.useWatchman = false;
  config.fileMapCacheDirectory = fixture.path('metro-cache');
  await mkdir(config.fileMapCacheDirectory);
  config.reporter = { update() {} };
  metro = await require('metro').createConnectMiddleware(config, { watch: false, waitForBundler: true });
  const graph = await metro.metroServer.getBundler().getBundler().getDependencyGraph();
  for (const file of installedFiles) assert.equal((await graph.getOrComputeSha1(file)).sha1,
    createHash('sha1').update(await readFile(file)).digest('hex'));
});

test('unchanged source export failure is terminal despite a Metro source diagnostic', async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-web-unchanged-failure-' });
  const repoDir = fixture.path('repo');
  const { uiInput, uiSource } = await prepareFiniteSourceWebFixture({
    sourceRepo: fileURLToPath(new URL('../../../../', import.meta.url)), repoDir,
  });
  const failure = Object.assign(new Error('Failed to get the SHA-1 for: installed/index.js (file is not watched)'),
    { code: 1, sourceDrift: true });
  let attempts = 0;
  const cancellation = new AbortController();
  let deadline;
  t.after(() => clearTimeout(deadline));
  await assert.rejects(exportSourceWebUi({ repoDir, baseDir: fixture.path('state'), outputDir: fixture.path('export'), signal: cancellation.signal,
    env: { ...process.env, EXPO_PUBLIC_DEBUG: '0' },
    runImpl: async () => {
      attempts++;
      await writeFile(uiInput, uiSource); // A new timestamp with identical bytes is not source drift.
      deadline ??= setTimeout(() => cancellation.abort(new Error('unchanged export kept waiting for source edits')), 30000);
      throw failure;
    } }), error => {
    assert.equal(error, failure, 'unchanged source must expose the original Metro error without waiting for edits');
    assert.equal(error.sourceDrift, false);
    return true;
  });
  assert.equal(attempts, 1);
});

test('source export retries a failed attempt after its named captured input changed', async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-web-changed-failure-' });
  const repoDir = fixture.path('repo');
  const { uiInput } = await prepareFiniteSourceWebFixture({
    sourceRepo: fileURLToPath(new URL('../../../../', import.meta.url)), repoDir,
  });
  let attempts = 0;
  const cancellation = new AbortController();
  let deadline;
  t.after(() => clearTimeout(deadline));
  const built = await exportSourceWebUi({ repoDir, baseDir: fixture.path('state'), outputDir: fixture.path('export'),
    signal: cancellation.signal, env: { ...process.env, EXPO_PUBLIC_DEBUG: '0' },
    runImpl: async (_command, args, { cwd }) => {
      if (++attempts === 1) {
        deadline = setTimeout(() => cancellation.abort(), 180000);
        await writeFile(uiInput, 'export const changed = true;');
        throw Object.assign(new Error('Metro export failed while inputs moved'), { code: 1,
          firstFailingModule: join(cwd, 'sources/app/_layout.tsx') });
      }
      assert.equal(await readFile(join(cwd, 'sources/app/_layout.tsx'), 'utf8'), 'export const changed = true;');
      const web = args[args.indexOf('--output-dir') + 1];
      await mkdir(web);
      await writeFile(join(web, 'index.html'), '<script src="./app.js"></script>');
      await writeFile(join(web, 'app.js'), 'globalThis.changed = true;');
    } });
  assert.equal(attempts, 2);
  assert.equal(await readFile(join(built.uiDir, 'app.js'), 'utf8'), 'globalThis.changed = true;');
});

test('stack web source reload preserves other roles when the served export is unavailable', async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-web-reload-command-' });
  const repoDir = fileURLToPath(new URL('../../../../', import.meta.url));
  const stackName = 'source-ui';
  const baseDir = fixture.path('stacks', stackName);
  await mkdir(baseDir, { recursive: true });
  await writeFile(join(baseDir, 'env'), `HAPPIER_STACK_REPO_DIR=${repoDir}\nHAPPIER_STACK_SERVER_PORT=3005\n`);
  const entrypoint = fixture.path('incumbent.mjs');
  await writeFile(entrypoint, 'export const incumbent = true;');
  const sourceRuntimeLaunch = { entrypoint, cliDir: join(repoDir, 'apps/cli') };
  const identities = { server: { selected: 'server', loaded: 'server' }, daemon: { selected: 'daemon', loaded: 'daemon' } };
  await recordStackRuntimeStart(join(baseDir, 'stack.runtime.json'), { stackName, ownerPid: process.pid,
    runtimeMode: 'source-snapshot', sourceUi: 'export', sourceUiLaunch: { uiDir: fixture.path('missing-web') },
    sourceRuntimeLaunch, sourceRuntimeIdentities: identities, placement: { server: 'local', daemon: 'local' } });
  const env = { ...sanitizeStackTestRunnerEnv(process.env, { isolatedStackRoot: fixture.root, repoDir }),
    HAPPIER_DEV_TARGET_EXECUTION: '0', HAPPIER_STACK_SYNC_BUNDLED_WORKSPACES: '0' };
  const result = await runNodeCapture([join(repoDir, 'apps/stack/bin/hstack.mjs'), 'stack', 'build', stackName,
    '--web', '--runtime=source', '--json'], { cwd: repoDir, env });
  assert.notEqual(result.code, 0);
  const observed = await readStackRuntimeStateFile(join(baseDir, 'stack.runtime.json'));
  assert.deepEqual(observed.sourceRuntimeLaunch, sourceRuntimeLaunch);
  assert.deepEqual(observed.sourceRuntimeIdentities, identities);
  await assert.rejects(access(join(baseDir, 'source-runtime/selected-daemon.json')), { code: 'ENOENT' });
  await assert.rejects(access(join(baseDir, 'runtime/artifacts')), { code: 'ENOENT' });
});

test('QA Stacks adopt the one shared web export the repository producer builds and never start their own', async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-web-producer-adoption-', registerCleanup: false });
  let pending;
  let activeExport;
  const cancellation = new AbortController();
  t.after(async () => {
    cancellation.abort();
    try { await activeExport?.catch(() => {}); await pending?.dispose(); }
    finally { await setBundleReadOnly(fixture.root, false); await fixture.cleanup(); }
  });
  const sourceUrl = new URL('./build_source_web_ui.mjs', import.meta.url);
  const repoDir = fixture.path('repo');
  const { uiInput } = await prepareFiniteSourceWebFixture({
    sourceRepo: fileURLToPath(new URL('../../../../', import.meta.url)), repoDir,
  });
  const stackBaseDir = fixture.path('stacks/consumer');
  const producerBaseDir = fixture.path('stacks/producer');
  const counter = fixture.path('exports.json');
  const expo = fixture.path(process.platform === 'win32' ? 'expo.cmd' : 'expo');
  await writeFile(expo, process.platform === 'win32'
    ? `@echo off\r\n"${process.execPath}" "${fixture.path('expo.mjs')}" %*\r\n`
    : `#!/bin/sh\nexec '${process.execPath}' '${fixture.path('expo.mjs')}' "$@"\n`);
  await chmod(expo, 0o755);
  await writeFile(fixture.path('expo.mjs'), `
import {mkdir,readFile,writeFile} from 'node:fs/promises';import {join} from 'node:path';
const prior=JSON.parse(await readFile(${JSON.stringify(counter)},'utf8').catch(()=>'[]'));
prior.push({stack:process.env.HAPPIER_STACK_STACK,cwd:process.cwd(),config:process.env.EXPO_APP_LOCAL_CONFIG_PATH});
await writeFile(${JSON.stringify(counter)},JSON.stringify(prior));
const web=process.argv[process.argv.indexOf('--output-dir')+1];await mkdir(web,{recursive:true});
await writeFile(join(web,'index.html'),'<script src="./app.js"></script>');await writeFile(join(web,'app.js'),'globalThis.ready=true;');
`);
  const native = process.platform === 'linux' ? await installNativeAdmissionFixture({ root: fixture.root }) : null;
  const commandBoundary = fixture.path('expo-command.mjs');
  await writeFile(commandBoundary, `export {prepareExpoCommandEnv} from ${JSON.stringify(new URL('../utils/expo/command.mjs', import.meta.url).href)};export async function resolveExpoBin(){return ${JSON.stringify(expo)}}`);
  const publicOwner = fixture.path('source-web.mjs');
  const adapterSource = new URL('../utils/proc/runSourceBuildCommand.mjs', import.meta.url);
  const adapter = native && fixture.path('native-owner/apps/stack/scripts/utils/proc/runSourceBuildCommand.mjs');
  if (adapter) await writeFile(adapter, relocateSourceOwnerImports(await readFile(adapterSource, 'utf8'), adapterSource,
    new Map([['./workspace_build_admission.mjs', null]])));
  await writeFile(publicOwner, relocateSourceOwnerImports((await readFile(sourceUrl, 'utf8'))
    .replace("fileURLToPath(new URL('../../bin/hstack-exec', import.meta.url))", JSON.stringify(native?.launcher ?? fileURLToPath(new URL('../../bin/hstack-exec', sourceUrl)))),
  sourceUrl, new Map([['../utils/expo/command.mjs', pathToFileURL(commandBoundary)],
    ...(adapter ? [['../utils/proc/runSourceBuildCommand.mjs', pathToFileURL(adapter)]] : [])])));
  const { exportSourceWebUi: exportShared } = await import(pathToFileURL(publicOwner));
  const workerLog = fixture.path('workers.jsonl');
  const handoffLog = fixture.path('worker-handoff.json');
  const observationHook = fixture.path('observe-worker.mjs');
  await writeFile(observationHook, `import {appendFileSync,readFileSync,writeFileSync} from 'node:fs';import {resolve} from 'node:path';
if(resolve(process.argv[1]??'')===${JSON.stringify(publicOwner)}){
  appendFileSync(${JSON.stringify(workerLog)},JSON.stringify({stack:process.env.HAPPIER_STACK_STACK})+'\\n');
  const write=process.stdout.write;
  process.stdout.write=function(chunk,...args){
    let built;try{built=JSON.parse(String(chunk))}catch{}
    if(built?.uiDir)writeFileSync(${JSON.stringify(handoffLog)},readFileSync(${JSON.stringify(join(producerBaseDir, 'source-runtime/start.pending.json'))},'utf8'));
    return write.call(this,chunk,...args);
  };
}`);
  // Observe the real OS process environment before compiler preparation. This
  // assertion remains decisive even when unrelated source cannot compile.
  const workerWatch = watch(fixture.root);
  t.after(() => workerWatch.close());
  const workerStarted = new Promise((resolve, reject) => {
    workerWatch.on('error', reject);
    workerWatch.on('change', async (_event, name) => {
      if (name !== 'workers.jsonl') return;
      try {
        const first = (await readFile(workerLog, 'utf8')).split('\n').find(Boolean);
        if (first) resolve(JSON.parse(first));
      } catch (error) { reject(error); }
    });
  });
  pending = await beginPendingSourceStart({ stackBaseDir });
  const producerPending = await beginPendingSourceStart({ stackBaseDir: producerBaseDir });
  t.after(() => producerPending.dispose());
  const config = fixture.path('app.local.cjs');
  await writeFile(config, 'module.exports = {};');
  const options = { repoDir, stackBaseDir, pending, signal: cancellation.signal,
    baseDir: fixture.path('consumer-state'), outputDir: fixture.path('private-bypass'),
    env: { ...(native ? buildNativeAdmissionFixtureEnv() : process.env), EXPO_PUBLIC_DEBUG: '0',
      HAPPIER_STACK_STACK: 'consumer', HAPPIER_STACK_RUNTIME_BUILD_AUTHORITY_STACK: 'producer',
      HAPPIER_STACK_STORAGE_DIR: fixture.path('stacks'), EXPO_APP_LOCAL_CONFIG_PATH: config,
      NODE_OPTIONS: [buildNativeAdmissionFixtureEnv().NODE_OPTIONS, `--import=${pathToFileURL(observationHook).href}`].filter(Boolean).join(' ') } };
  const producer = { ...options, stackBaseDir: producerBaseDir, pending: producerPending,
    baseDir: fixture.path('producer-state'), env: { ...options.env, HAPPIER_STACK_STACK: 'producer' } };
  const exports = async () => JSON.parse(await readFile(counter, 'utf8').catch(() => '[]'));
  // Owner 2026-11-13/11-14: a consumer Stack never starts an export; without a
  // shared one it uses live Expo (the caller's borrowed fallback).
  assert.equal(await exportShared(options), null, 'a QA Stack does not build its own web export');
  assert.equal((await exports()).length, 0);
  activeExport = exportShared(producer);
  void activeExport.catch(() => {});
  const worker = await Promise.race([workerStarted, activeExport.then(() => { throw new Error('export completed without an observed worker'); })]);
  assert.equal(worker.stack, 'producer', 'shared export compiler processes execute as the repository producer');
  const first = await activeExport;
  const handoff = JSON.parse(await readFile(handoffLog, 'utf8'));
  assert.ok(handoff.preparationDirs?.includes(dirname(first.uiDir)),
    'the producer pins completed output in its pending request before returning it');
  assert.equal((await exports())[0].stack, 'producer', 'an executable app config must not bypass producer authority');
  assert.equal((await exports())[0].config, config, 'the actual config variation remains part of the producer request');
  // Every QA Stack adopts that one export, across source edits, with no compiler.
  assert.equal((await exportShared(options)).uiDir, first.uiDir);
  await writeFile(uiInput, 'export const changed = true;');
  assert.equal((await exportShared(options)).uiDir, first.uiDir, 'source edits adopt the completed shared export');
  assert.equal((await exports()).length, 1, 'QA adoption launches no compiler');
  await t.test('last-green web adoption bypasses busy producer and fingerprint leases', async () => {
    const bundleRoot = fixture.path('stacks/source-bundles');
    const record = JSON.parse(await readFile(join(first.uiDir, '../source-bundle.json'), 'utf8'));
    await withWorkspaceBundleLock(() => withWorkspaceBundleLock(async () => {
      const adopted = await exportShared({ ...options, requireLastGreen: true,
        env: { ...options.env, HAPPIER_WORKSPACE_DIST_BUILD_LOCK_WAIT_ALLOWED: '0' } });
      assert.equal(adopted.uiDir, first.uiDir);
      assert.equal((await exports()).length, 1, 'adoption must not launch another Expo producer');
    }, { lockPath: join(bundleRoot, `build-${record.reuseFingerprint}.lock`), env: options.env, signal: cancellation.signal }),
    { lockPath: join(bundleRoot, 'build-producer.lock'), env: options.env, signal: cancellation.signal });
  });
  const legacyUiDir = fixture.path('legacy-serving');
  await mkdir(legacyUiDir);
  await writeFile(join(legacyUiDir, 'app.js'), 'globalThis.old=true;');
  const replaced = await exportShared({ ...options, replaceUiDir: legacyUiDir });
  assert.equal(replaced.uiDir, legacyUiDir, 'an older loaded Stack retains its private serving path');
  assert.equal(replaced.exportDir, undefined);
  assert.equal(await readFile(join(legacyUiDir, 'app.js'), 'utf8'), await readFile(join(first.uiDir, 'app.js'), 'utf8'));
  assert.equal((await exports()).length, 1, 'legacy serving replacement copies the completed producer export without compiling');
  // A boundary newer than the shared export is never met by a QA Stack's own build.
  const sourceCapturedAfter = new Date().toISOString();
  assert.equal(await exportShared({ ...options, sourceCapturedAfter }), null);
  assert.equal((await exports()).length, 1);
  // The producer refreshes the one shared export once; every QA Stack adopts it.
  activeExport = Promise.all([exportShared({ ...producer, sourceCapturedAfter }), exportShared({ ...producer, sourceCapturedAfter })]);
  const refreshed = await activeExport;
  assert.equal(refreshed[0].uiDir, refreshed[1].uiDir, 'concurrent producer freshness requests join one product');
  assert.equal((await exports()).length, 2, 'only the repository producer exports the newer capture, once');
  assert.equal((await exportShared({ ...options, sourceCapturedAfter })).uiDir, refreshed[0].uiDir);
  const markerPath = resolveDependencyRefreshMarkerPath(repoDir);
  const marker = JSON.parse(await readFile(markerPath, 'utf8').catch(() => '{}'));
  await writeFile(markerPath, JSON.stringify({ ...marker, identity: 'new-dependency-publication' }));
  assert.equal(await exportShared(options), null, 'a changed dependency publication cannot reuse the old export, and QA does not rebuild');
  assert.equal((await exports()).length, 2);
});

test('revision web publication checks its consumed installation across checkout drift', async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-web-producer-revisions-', registerCleanup: false });
  const pendings = [];
  const cancellation = new AbortController();
  t.after(async () => {
    cancellation.abort();
    try { for (const pending of pendings) await pending.dispose(); }
    finally { await setBundleReadOnly(fixture.root, false); await fixture.cleanup(); }
  });
  const sourceUrl = new URL('./build_source_web_ui.mjs', import.meta.url);
  const repoDir = fixture.path('repo');
  const { uiInput } = await prepareFiniteSourceWebFixture({
    sourceRepo: fileURLToPath(new URL('../../../../', import.meta.url)), repoDir,
  });
  const git = (...args) => execFileSync('git', ['-C', repoDir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' }).trim();
  await writeFile(join(repoDir, '.gitignore'), 'node_modules\n');
  git('init', '--quiet');
  const commit = message => { git('add', '-A'); git('commit', '--quiet', '--allow-empty', '-m', message); return git('rev-parse', 'HEAD'); };
  const counter = fixture.path('exports.json');
  const expo = fixture.path(process.platform === 'win32' ? 'expo.cmd' : 'expo');
  await writeFile(expo, process.platform === 'win32'
    ? `@echo off\r\n"${process.execPath}" "${fixture.path('expo.mjs')}" %*\r\n`
    : `#!/bin/sh\nexec '${process.execPath}' '${fixture.path('expo.mjs')}' "$@"\n`);
  await chmod(expo, 0o755);
  // Expo is the external compiler boundary: count runs and copy the captured UI input into the bundle.
  await writeFile(fixture.path('expo.mjs'), `
import {copyFile,mkdir,readFile,writeFile} from 'node:fs/promises';import {join} from 'node:path';
const prior=JSON.parse(await readFile(${JSON.stringify(counter)},'utf8').catch(()=>'[]'));
prior.push({stack:process.env.HAPPIER_STACK_STACK});await writeFile(${JSON.stringify(counter)},JSON.stringify(prior));
const web=process.argv[process.argv.indexOf('--output-dir')+1];await mkdir(web,{recursive:true});
// Like Expo, copy the project's public index.html into the output, then rewrite it.
await copyFile(join(process.cwd(),'public/index.html'),join(web,'index.html')).catch(error=>{if(error.code!=='ENOENT')throw error});
await writeFile(join(web,'index.html'),'<script src="./app.js"></script>');
await writeFile(join(web,'app.js'),await readFile(join(process.cwd(),'sources/app/_layout.tsx'),'utf8'));
if(process.env.FIXTURE_DRIFT_GENERATION) await writeFile(process.env.FIXTURE_DRIFT_GENERATION,JSON.stringify({generation:String(prior.length),completedGeneration:String(prior.length)}));
`);
  const native = process.platform === 'linux' ? await installNativeAdmissionFixture({ root: fixture.root }) : null;
  const commandBoundary = fixture.path('expo-command.mjs');
  await writeFile(commandBoundary, `export {prepareExpoCommandEnv} from ${JSON.stringify(new URL('../utils/expo/command.mjs', import.meta.url).href)};export async function resolveExpoBin(){return ${JSON.stringify(expo)}}`);
  const publicOwner = fixture.path('source-web.mjs');
  const adapterSource = new URL('../utils/proc/runSourceBuildCommand.mjs', import.meta.url);
  const adapter = native && fixture.path('native-owner/apps/stack/scripts/utils/proc/runSourceBuildCommand.mjs');
  if (adapter) {
    await mkdir(dirname(adapter), { recursive: true });
    await writeFile(adapter, relocateSourceOwnerImports(await readFile(adapterSource, 'utf8'), adapterSource,
      new Map([['./workspace_build_admission.mjs', null]])));
  }
  await writeFile(publicOwner, relocateSourceOwnerImports((await readFile(sourceUrl, 'utf8'))
    .replace("fileURLToPath(new URL('../../bin/hstack-exec', import.meta.url))", JSON.stringify(native?.launcher ?? fileURLToPath(new URL('../../bin/hstack-exec', sourceUrl)))),
  sourceUrl, new Map([['../utils/expo/command.mjs', pathToFileURL(commandBoundary)],
    ...(adapter ? [['../utils/proc/runSourceBuildCommand.mjs', pathToFileURL(adapter)]] : [])])));
  const { exportSourceWebUi: exportShared, prepareSourceQaWebUi, publishProducerSourceWebUi, readSourceWebRevisionInputDigest } = await import(pathToFileURL(publicOwner));
  const env = { ...(native ? buildNativeAdmissionFixtureEnv() : process.env), EXPO_PUBLIC_DEBUG: '0',
    HAPPIER_STACK_RUNTIME_BUILD_AUTHORITY_STACK: 'producer', HAPPIER_STACK_STORAGE_DIR: fixture.path('stacks'),
    // The fixture borrows the host's installed dependencies; pnpm installation is outside this contract.
    HAPPIER_STACK_SKIP_REFRESH_DEPS: '1' };
  const { installIdentity } = await inspectDependencyRefresh({ installDir: repoDir, env });
  await writeFile(resolveDependencyRefreshMarkerPath(repoDir), JSON.stringify({ version: 7, identity: installIdentity }));
  const producerBaseDir = fixture.path('stacks/producer');
  const generationPath = `${resolveDependencyRefreshLockPath(repoDir, env)}.generation`;
  await mkdir(dirname(generationPath), { recursive: true });
  await writeFile(generationPath, JSON.stringify({ generation: 'before', completedGeneration: 'before' }));
  const { prepareRevisionInstall, sourceRevisionTreesRoot } = await import('./source_revision_install.mjs');
  const { workspaceDirs } = await readSourceComponentBuildInputs({ repoDir, component: 'expo' });
  const installed = await prepareRevisionInstall({ repoDir, baseDir: repoDir,
    treesRoot: sourceRevisionTreesRoot(producerBaseDir), workspaceDirs, env });
  const selected = commit('revision on its own installation');
  const publish = async (rev, mirror) => publishProducerSourceWebUi({ repoDir, stackBaseDir: producerBaseDir,
    revision: { revision: rev }, sourceRevision: { rev }, signal: cancellation.signal,
    uiInputDigest: await readSourceWebRevisionInputDigest({ repoDir, revision: rev }),
    env: { ...env, HAPPIER_STACK_STACK: 'producer', HAPPIER_STACK_SOURCE_MIRROR: mirror,
      FIXTURE_DRIFT_GENERATION: generationPath } });
  // Same dependency identity, but a mirror uses the revision's completed installation.
  const own = await publish(selected, '1');
  assert.equal(own.exported, true);
  assert.equal(own.built.dependencyRootDir, installed.dir);
  assert.equal(await readFile(join(own.built.uiDir, 'app.js'), 'utf8'), await readFile(uiInput, 'utf8'));
  const record = JSON.parse(await readFile(join(dirname(own.built.uiDir), 'source-bundle.json'), 'utf8'));
  assert.equal(record.dependencyRootDir, installed.dir);
  // A controller reusing its checkout still rejects a mutation during every attempt.
  await writeFile(uiInput, 'export const checkoutDrift = true;');
  const checkout = commit('revision borrowing checkout installation');
  await assert.rejects(publish(checkout, '0'), { reason: 'BUILD_INPUTS_CHANGED' });
});

test('the repository producer publishes one shared web export per changed UI revision and QA Stacks adopt it for their revision', async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-web-producer-revisions-', registerCleanup: false });
  const pendings = [];
  const cancellation = new AbortController();
  t.after(async () => {
    cancellation.abort();
    try { for (const pending of pendings) await pending.dispose(); }
    finally { await setBundleReadOnly(fixture.root, false); await fixture.cleanup(); }
  });
  const sourceUrl = new URL('./build_source_web_ui.mjs', import.meta.url);
  const repoDir = fixture.path('repo');
  const { uiInput } = await prepareFiniteSourceWebFixture({
    sourceRepo: fileURLToPath(new URL('../../../../', import.meta.url)), repoDir,
  });
  const git = (...args) => execFileSync('git', ['-C', repoDir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' }).trim();
  await writeFile(join(repoDir, '.gitignore'), 'node_modules\n');
  git('init', '--quiet');
  const commit = message => { git('add', '-A'); git('commit', '--quiet', '--allow-empty', '-m', message); return git('rev-parse', 'HEAD'); };
  const counter = fixture.path('exports.json');
  const expo = fixture.path(process.platform === 'win32' ? 'expo.cmd' : 'expo');
  await writeFile(expo, process.platform === 'win32'
    ? `@echo off\r\n"${process.execPath}" "${fixture.path('expo.mjs')}" %*\r\n`
    : `#!/bin/sh\nexec '${process.execPath}' '${fixture.path('expo.mjs')}' "$@"\n`);
  await chmod(expo, 0o755);
  // Expo is the external compiler boundary: count runs and copy the captured UI input into the bundle.
  await writeFile(fixture.path('expo.mjs'), `
import {copyFile,mkdir,readFile,writeFile} from 'node:fs/promises';import {join} from 'node:path';
const prior=JSON.parse(await readFile(${JSON.stringify(counter)},'utf8').catch(()=>'[]'));
prior.push({stack:process.env.HAPPIER_STACK_STACK});await writeFile(${JSON.stringify(counter)},JSON.stringify(prior));
const web=process.argv[process.argv.indexOf('--output-dir')+1];await mkdir(web,{recursive:true});
// Like Expo, copy the project's public index.html into the output, then rewrite it.
await copyFile(join(process.cwd(),'public/index.html'),join(web,'index.html')).catch(error=>{if(error.code!=='ENOENT')throw error});
await writeFile(join(web,'index.html'),'<script src="./app.js"></script>');
await writeFile(join(web,'app.js'),await readFile(join(process.cwd(),'sources/app/_layout.tsx'),'utf8'));
`);
  const native = process.platform === 'linux' ? await installNativeAdmissionFixture({ root: fixture.root }) : null;
  const commandBoundary = fixture.path('expo-command.mjs');
  await writeFile(commandBoundary, `export {prepareExpoCommandEnv} from ${JSON.stringify(new URL('../utils/expo/command.mjs', import.meta.url).href)};export async function resolveExpoBin(){return ${JSON.stringify(expo)}}`);
  const publicOwner = fixture.path('source-web.mjs');
  const adapterSource = new URL('../utils/proc/runSourceBuildCommand.mjs', import.meta.url);
  const adapter = native && fixture.path('native-owner/apps/stack/scripts/utils/proc/runSourceBuildCommand.mjs');
  if (adapter) {
    await mkdir(dirname(adapter), { recursive: true });
    await writeFile(adapter, relocateSourceOwnerImports(await readFile(adapterSource, 'utf8'), adapterSource,
      new Map([['./workspace_build_admission.mjs', null]])));
  }
  await writeFile(publicOwner, relocateSourceOwnerImports((await readFile(sourceUrl, 'utf8'))
    .replace("fileURLToPath(new URL('../../bin/hstack-exec', import.meta.url))", JSON.stringify(native?.launcher ?? fileURLToPath(new URL('../../bin/hstack-exec', sourceUrl)))),
  sourceUrl, new Map([['../utils/expo/command.mjs', pathToFileURL(commandBoundary)],
    ...(adapter ? [['../utils/proc/runSourceBuildCommand.mjs', pathToFileURL(adapter)]] : [])])));
  const { exportSourceWebUi: exportShared, prepareSourceQaWebUi, publishProducerSourceWebUi, readSourceWebRevisionInputDigest } = await import(pathToFileURL(publicOwner));
  const env = { ...(native ? buildNativeAdmissionFixtureEnv() : process.env), EXPO_PUBLIC_DEBUG: '0',
    HAPPIER_STACK_RUNTIME_BUILD_AUTHORITY_STACK: 'producer', HAPPIER_STACK_STORAGE_DIR: fixture.path('stacks'),
    // The fixture borrows the host's installed dependencies; pnpm installation is outside this contract.
    HAPPIER_STACK_SKIP_REFRESH_DEPS: '1' };
  const { installIdentity } = await inspectDependencyRefresh({ installDir: repoDir, env });
  await writeFile(resolveDependencyRefreshMarkerPath(repoDir), JSON.stringify({ version: 7, identity: installIdentity }));
  const producerBaseDir = fixture.path('stacks/producer');
  const exports = async () => JSON.parse(await readFile(counter, 'utf8').catch(() => '[]')).length;
  const publish = async rev => publishProducerSourceWebUi({ repoDir, stackBaseDir: producerBaseDir, revision: { revision: rev },
    uiInputDigest: await readSourceWebRevisionInputDigest({ repoDir, revision: rev }), sourceRevision: { rev },
    env: { ...env, HAPPIER_STACK_STACK: 'producer' }, signal: cancellation.signal, logger: { error() {} } });
  const adopt = async rev => {
    const stackBaseDir = fixture.path(`stacks/consumer-${pendings.length}`);
    const pending = await beginPendingSourceStart({ stackBaseDir });
    pendings.push(pending);
    return await exportShared({ repoDir, stackBaseDir, pending, reuseOnly: true, signal: cancellation.signal,
      baseDir: fixture.path(`consumer-state-${pendings.length}`), revision: { revision: rev, overlayDigest: null },
      // Orchestrator decision under the 11-13 ruling: a QA Stack's own UI build
      // options never fork the shared export; it adopts its revision's export.
      env: { ...env, HAPPIER_STACK_STACK: `consumer-${pendings.length}`, HAPPIER_UI_QA_STACK_VARIANT: `stack-${pendings.length}` } });
  };
  const first = commit('first');
  assert.equal(await adopt(first), null, 'a QA Stack builds nothing before the producer publishes');
  assert.equal(await exports(), 0);
  const published = await publish(first);
  assert.equal(published.exported, true);
  assert.equal(await exports(), 1, 'a new HEAD exports once');
  // A HEAD advance that changes no UI input publishes nothing; its QA Stacks adopt the same bytes.
  await mkdir(join(repoDir, 'docs'), { recursive: true });
  await writeFile(join(repoDir, 'docs/note.md'), 'not a UI input\n');
  const unchanged = commit('docs only');
  assert.equal(await readSourceWebRevisionInputDigest({ repoDir, revision: unchanged }),
    await readSourceWebRevisionInputDigest({ repoDir, revision: first }));
  assert.equal((await publish(unchanged)).exported, false);
  assert.equal(await exports(), 1, 'an unchanged UI input publishes no export');
  const adoptedUnchanged = await adopt(unchanged);
  assert.equal(adoptedUnchanged.uiDir, published.built.uiDir, 'a QA Stack on the unchanged revision adopts the existing export');
  assert.equal(adoptedUnchanged.sourceCapture.revision, first, 'the adopted export names the revision it was built from');
  // A HEAD advance that changes a UI input exports once; each QA Stack adopts its own revision's export.
  await writeFile(uiInput, 'export const admissionInput = "changed-ui-input";');
  const changed = commit('ui change');
  assert.equal((await publish(changed)).exported, true);
  assert.equal((await publish(changed)).exported, false, 'a repeated HEAD notification publishes nothing');
  assert.equal(await exports(), 2, 'one export per changed UI revision');
  const adoptedChanged = await adopt(changed);
  assert.notEqual(adoptedChanged.uiDir, published.built.uiDir);
  assert.match(await readFile(join(adoptedChanged.uiDir, 'app.js'), 'utf8'), /changed-ui-input/);
  assert.equal((await adopt(unchanged)).uiDir, published.built.uiDir, 'an older revision keeps adopting its own export');
  assert.equal(await exports(), 2, 'QA adoption launches no compiler');
  // `--ui=export` on a QA Stack whose revision the producer has not exported yet
  // (Usage r182, servers-deploy #167, 2026-11-16) requests that revision's
  // producer-owned export once; later Stacks on the revision adopt it.
  await writeFile(uiInput, 'export const admissionInput = "requested-before-publication";');
  const requested = commit('ui change the producer has not reached');
  const requestExport = async () => {
    const stackBaseDir = fixture.path(`stacks/consumer-${pendings.length}`);
    const pending = await beginPendingSourceStart({ stackBaseDir });
    pendings.push(pending);
    return await exportShared({ repoDir, stackBaseDir, pending, reuseOnly: false, signal: cancellation.signal,
      baseDir: fixture.path(`consumer-state-${pendings.length}`), revision: { revision: requested, overlayDigest: null },
      env: { ...env, HAPPIER_STACK_STACK: `consumer-${pendings.length}` } });
  };
  const exported = await requestExport();
  assert.match(await readFile(join(exported.uiDir, 'app.js'), 'utf8'), /requested-before-publication/);
  assert.equal(await exports(), 3, 'an explicit request exports its revision once');
  assert.equal(JSON.parse(await readFile(counter, 'utf8')).at(-1).stack, 'producer', 'the export runs as the repository producer');
  assert.equal((await requestExport()).uiDir, exported.uiDir, 'a second explicit request adopts it');
  assert.equal((await adopt(requested)).uiDir, exported.uiDir, 'default Stacks on that revision adopt it');
  assert.equal((await publish(requested)).exported, false, 'the producer does not export that revision again');
  assert.equal(await exports(), 3);
  // A QA Stack on a source tree requests its revision's export. The request carries
  // the revision description made before the admission wait, and the checkout keeps
  // moving (commits and edits) during that wait (INFRA-RESPONDER-3, 2026-11-16 19:20Z:
  // "capture differs from <rev> at 1424 path(s)"). The export reads the Stack's
  // revision tree (the revision's archive on its installation), so it builds that revision.
  await writeFile(uiInput, 'export const admissionInput = "tree-revision";');
  const treeRevision = commit('ui change served from a revision tree');
  const described = await resolveSourceTreeRevision({ repoDir, treesRoot: fixture.path('trees'), rev: treeRevision,
    overlay: [], outputDir: fixture.path('tree-descriptors') });
  const treeDir = fixture.path('stacks/tree-consumer/source-runtime/tree-server-0a0b0c0d');
  await mkdir(treeDir, { recursive: true });
  const archive = await writeSourceRevisionArchive({ repoDir, revision: treeRevision, outputPath: fixture.path('tree.tar.gz') });
  execFileSync('tar', ['-xzf', archive, '-C', treeDir]);
  await mountCapturedWorkspaceDependencies({ sourceDir: repoDir, captureDir: treeDir,
    workspaceDirs: (await readSourceComponentBuildInputs({ repoDir, component: 'expo' })).workspaceDirs });
  // A tree's files are its base's read-only inodes.
  await setBundleReadOnly(treeDir, true);
  await writeFile(uiInput, 'export const admissionInput = "committed-during-the-wait";');
  commit('another lane commits while the export waits');
  await writeFile(uiInput, 'export const admissionInput = "edited-during-the-wait";');
  const treeConsumer = fixture.path('stacks/tree-consumer');
  const treePending = await beginPendingSourceStart({ stackBaseDir: treeConsumer });
  pendings.push(treePending);
  const fromTree = await exportShared({ repoDir, stackBaseDir: treeConsumer, pending: treePending, reuseOnly: false,
    signal: cancellation.signal, baseDir: fixture.path('tree-consumer-state'), revision: { revision: treeRevision, overlayDigest: null },
    sourceRevision: { descriptorPath: described.descriptorPath, treeDir }, env: { ...env, HAPPIER_STACK_STACK: 'tree-consumer' } });
  assert.match(await readFile(join(fromTree.uiDir, 'app.js'), 'utf8'), /tree-revision/, 'the export holds the revision tree bytes');
  assert.equal(fromTree.sourceCapture.revision, treeRevision);
  assert.equal(await exports(), 4, 'the moving checkout refuses nothing: one export for the revision');
  const adoptTreeExport = async overlayDigest => {
    const stackBaseDir = fixture.path(`stacks/tree-adopter-${pendings.length}`);
    const pending = await beginPendingSourceStart({ stackBaseDir });
    pendings.push(pending);
    return await prepareSourceQaWebUi({ mode: 'auto', repoDir, stackBaseDir, pending,
      baseDir: fixture.path(`adopter-state-${pendings.length}`), requireLastGreen: true,
      revision: { revision: treeRevision, overlayDigest }, signal: cancellation.signal,
      env: { ...env, HAPPIER_STACK_STACK: `tree-adopter-${pendings.length}` } });
  };
  const adoptedTree = await adoptTreeExport(null);
  assert.equal(adoptedTree.mode, 'export', 'a second Stack adopts the completed pinned-tree export by default');
  assert.equal(adoptedTree.built.uiDir, fromTree.uiDir, 'the consumer serves the producer directory');
  assert.equal((await lstat(adoptedTree.built.uiDir)).mode & 0o222, 0, 'the published directory is read-only');
  const differentOverlay = await adoptTreeExport('a'.repeat(64));
  assert.deepEqual(differentOverlay, { mode: 'borrowed', built: null }, 'a different overlay cannot adopt the unoverlaid export');
  assert.equal(await exports(), 4, 'neither adoption attempt starts a per-Stack export');
});

test('source stacks reuse completed web bytes while debug options and damaged exports require construction', async context => {
  const fixture = await createTempFixture(context, { prefix: 'happier-completed-source-web-', registerCleanup: false });
  let pending;
  let otherPending;
  context.after(async () => {
    try { await otherPending?.dispose(); await pending?.dispose(); }
    finally { await setBundleReadOnly(fixture.root, false); await fixture.cleanup(); }
  });
  const sourceRepo = fileURLToPath(new URL('../../../../', import.meta.url));
  const repoDir = fixture.path('repo');
  // The fixture owns its authored changes. Other lanes may keep editing the
  // shared checkout without turning this unchanged-input assertion into churn.
  await prepareFiniteSourceWebFixture({ sourceRepo, repoDir });
  const stackBaseDir = fixture.path('stacks/consumer');
  const counter = fixture.path('exports');
  const expo = fixture.path(process.platform === 'win32' ? 'expo.cmd' : 'expo');
  await writeFile(expo, process.platform === 'win32'
    ? `@echo off\r\n"${process.execPath}" "${fixture.path('expo.mjs')}" %*\r\n`
    : `#!/bin/sh\nexec '${process.execPath}' '${fixture.path('expo.mjs')}' "$@"\n`);
  await chmod(expo, 0o755);
  await writeFile(fixture.path('expo.mjs'), `
import {access,mkdir,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
const count=Number(await readFile(${JSON.stringify(counter)},'utf8').catch(()=>0))+1;
await writeFile(${JSON.stringify(counter)},String(count));
await writeFile(${JSON.stringify(fixture.path('export-owner'))},process.env.HAPPIER_STACK_STACK ?? '');
await access(join(process.cwd(),'sources/app/_layout.tsx'));
if(process.env.EXPO_PUBLIC_FEATURES==='different') throw new Error('ENOSPC: test export boundary');
const web=process.argv[process.argv.indexOf('--output-dir')+1];
await mkdir(web,{recursive:true});
await writeFile(join(web,'index.html'),'<html><body><main id="root"></main><script src="./app.js"></script></body></html>');
await writeFile(join(web,'app.js'),'globalThis.debug = '+JSON.stringify(process.env.EXPO_PUBLIC_DEBUG)+';document.getElementById("root").textContent="Completed fixture export rendered";');
`);
  const commandBoundary = fixture.path('expo-command.mjs');
  await writeFile(commandBoundary, `export {prepareExpoCommandEnv,applyExpoExportMaxWorkersArgs} from ${JSON.stringify(new URL('../utils/expo/command.mjs', import.meta.url).href)};\nexport async function resolveExpoBin(){return ${JSON.stringify(expo)};}`);
  const sourceUrl = new URL('./build_source_web_ui.mjs', import.meta.url);
  const artifactSource = new URL('./build_web_artifact.mjs', import.meta.url);
  const runtimeSource = new URL('./build_source_runtime.mjs', import.meta.url);
  const smokeSource = new URL('../runtime/launch/smokeSourceRuntimeReload.mjs', import.meta.url);
  const reloadSource = new URL('../runtime/launch/prepareSourceRuntimeReload.mjs', import.meta.url);
  // These test-owned adapters must consume the same owner interfaces even if
  // another lane edits the shared checkout while repeated exports are running.
  const [sourceOwnerText, artifactOwnerText, runtimeOwnerText, smokeOwnerText, reloadOwnerText] = await Promise.all(
    [sourceUrl, artifactSource, runtimeSource, smokeSource, reloadSource].map(url => readFile(url, 'utf8')));
  const publicOwner = fixture.path('source-web.mjs');
  const native = process.platform === 'linux' ? await installNativeAdmissionFixture({ root: fixture.root }) : null;
  const adapterSource = new URL('../utils/proc/runSourceBuildCommand.mjs', import.meta.url);
  const adapter = native && fixture.path('native-owner/apps/stack/scripts/utils/proc/runSourceBuildCommand.mjs');
  if (adapter) await writeFile(adapter, relocateSourceOwnerImports(await readFile(adapterSource, 'utf8'), adapterSource,
    new Map([['./workspace_build_admission.mjs', null]])));
  // Substitute only installed executable lookup. The subprocess producer,
  // capture, SDK preparation, admission, cache and publication remain real.
  // The isolated physical admission fixture lets independent cold producers
  // queue together, without inheriting the already-charged test runner host.
  const sourceBoundaries = new Map([['../utils/expo/command.mjs', pathToFileURL(commandBoundary)],
    ...(adapter ? [['../utils/proc/runSourceBuildCommand.mjs', pathToFileURL(adapter)]] : [])]);
  await writeFile(publicOwner, relocateSourceOwnerImports(sourceOwnerText
    .replace("fileURLToPath(new URL('../../bin/hstack-exec', import.meta.url))", JSON.stringify(native?.launcher ?? fileURLToPath(new URL('../../bin/hstack-exec', sourceUrl)))),
  sourceUrl, sourceBoundaries));
  const { exportSourceWebUi: exportShared, publishSourceWebUi: selectShared, prepareSourceQaWebUi } = await import(pathToFileURL(publicOwner));
  pending = await beginPendingSourceStart({ stackBaseDir });
  const exports = async () => Number(await readFile(counter, 'utf8'));
  const env = { ...(native ? buildNativeAdmissionFixtureEnv() : process.env), EXPO_PUBLIC_DEBUG: '0',
    // The fixture mounts installed tooling and authors tiny manifests. Package
    // installation is an external boundary outside this export/reuse test.
    HAPPIER_STACK_SKIP_REFRESH_DEPS: '1',
    GOMAXPROCS: '2', HAPPIER_STACK_EXPO_EXPORT_MAX_WORKERS: '',
    HAPPIER_STACK_STACK: 'consumer', HAPPIER_STACK_RUNTIME_BUILD_AUTHORITY_STACK: 'producer',
    HAPPIER_STACK_STORAGE_DIR: fixture.path('stacks') };
  const options = { repoDir, stackBaseDir, pending, baseDir: fixture.path('state'),
    env };
  const otherStackBaseDir = fixture.path('stacks/independent');
  otherPending = await beginPendingSourceStart({ stackBaseDir: otherStackBaseDir });
  const mode = resolveSourceQaUiMode({ consumerStackName: 'consumer', producerStackName: 'producer' });
  assert.equal(mode, 'auto', 'QA default defers publication selection to the serving host');
  const qaUiOptions = { ...options, mode };
  assert.equal((await prepareSourceQaWebUi(qaUiOptions)).mode, 'borrowed', 'missing publication falls back without building');
  const completed = await Promise.allSettled([
    exportShared({ ...options, outputDir: fixture.path('first') }),
    exportShared({ ...options, stackBaseDir: otherStackBaseDir, pending: otherPending, baseDir: fixture.path('independent-state') }),
  ]);
  const [first, other] = completed.map(result => {
    if (result.status === 'rejected') throw result.reason;
    return result.value;
  });
  assert.equal(await readFile(fixture.path('export-owner'), 'utf8'), 'producer',
    'QA requests export work from the repository producer on this execution host');
  const selectedUi = await prepareSourceQaWebUi(qaUiOptions);
  assert.equal(selectedUi.mode, 'export', 'matching completed export is the QA default');
  assert.equal(selectedUi.built.uiDir, first.uiDir);
  assert.equal((await prepareSourceQaWebUi({ ...qaUiOptions, mode: 'borrowed' })).mode, 'borrowed');
  assert.equal(await exports(), 1, 'UI provider selection never builds');
  const bundleRoot = fixture.path('stacks/source-bundles');
  const publicationLock = join(bundleRoot, 'publication.lock');
  const completedRecord = JSON.parse(await readFile(join(first.uiDir, '../source-bundle.json'), 'utf8'));
  for (let index = 0; index < 128; index += 1) {
    const directory = join(bundleRoot, `web-unrelated-${index}`);
    await mkdir(directory);
    await writeFile(join(directory, 'source-bundle.json'), JSON.stringify({ ...completedRecord, buildOptions: 'unrelated' }));
  }
  const filesystem = (await import('node:fs/promises')).default;
  const originalRead = filesystem.readFile;
  const originalReaddir = filesystem.readdir;
  const originalLstat = filesystem.lstat;
  let inventoryReads = 0;
  let completionReads = 0;
  let verificationUnderPublication = 0;
  filesystem.readFile = async (path, ...args) => {
    if (String(path).endsWith('source-bundle.json')) completionReads += 1;
    return await originalRead(path, ...args);
  };
  filesystem.readdir = async (path, ...args) => {
    if (resolve(String(path)) === bundleRoot) inventoryReads += 1;
    return await originalReaddir(path, ...args);
  };
  filesystem.lstat = async (path, ...args) => {
    const absolute = resolve(String(path));
    if ((absolute.startsWith(repoDir) || absolute.startsWith(first.uiDir)) && isJsonOwnerFileLockActive(publicationLock)) {
      verificationUnderPublication += 1;
    }
    return await originalLstat(path, ...args);
  };
  syncBuiltinESMExports();
  let repeat;
  try {
    repeat = await exportShared({ ...options, outputDir: fixture.path('second'), env: { ...env, GOMAXPROCS: '3' } });
    context.diagnostic(`web retained=128 inventoryReads=${inventoryReads} completionReads=${completionReads} verificationUnderPublication=${verificationUnderPublication}`);
    assert.equal(inventoryReads, 0, 'warm web lookup must not scan retained bundle directories');
    assert.ok(completionReads <= 2, 'warm web lookup reads only its chosen completion');
    assert.equal(verificationUnderPublication, 0, 'source and output digest verification run outside publication custody');
  } finally {
    filesystem.readFile = originalRead;
    filesystem.readdir = originalReaddir;
    filesystem.lstat = originalLstat;
    syncBuiltinESMExports();
  }
  assert.equal(await exports(), 1, 'changing the executor CPU budget must reuse unchanged completed bytes');
  assert.equal(repeat.uiDir, first.uiDir, 'restart selects the completed export without copying or mutating it');
  assert.equal(other.uiDir, first.uiDir, 'independent Stack homes share account-free completed bytes');
  const withoutBudget = await exportShared({ ...options, env: { ...env, GOMAXPROCS: '' } });
  assert.equal(withoutBudget.uiDir, first.uiDir, 'pre-admission lookup must reuse bytes without a CPU budget');
  assert.equal(await exports(), 1);
  const disabledMaps = await exportShared({ ...options,
    env: { ...env, HAPPIER_UI_EXPORT_SOURCE_MAPS: '0' } });
  assert.equal(disabledMaps.uiDir, first.uiDir,
    'remote diagnostic defaults must reuse the same export as omitted source maps');
  assert.equal(await exports(), 1, 'disabled diagnostic defaults must not rebuild matching UI inputs');
  const sourceMaps = await exportShared({ ...options, outputDir: fixture.path('source-maps'),
    env: { ...env, HAPPIER_UI_EXPORT_SOURCE_MAPS: '1' } });
  assert.notEqual(sourceMaps.uiDir, first.uiDir, 'semantic source-map options must invalidate completed bytes');
  assert.equal(await exports(), 2);
  // Already-loaded source publishers nominate bundle-* allocations and do
  // not know serving web references. Their observed namespace must not include
  // a new completed web product, even after its own build lease has retired.
  const legacyCandidates = (await readdir(fixture.path('stacks/source-bundles')))
    .filter(name => name.startsWith('bundle-')).map(name => fixture.path('stacks/source-bundles', name));
  assert.equal(legacyCandidates.includes(dirname(first.uiDir)), false,
    'an older loaded source retainer must not nominate shared serving web bytes');
  assert.equal(await exports(), 2);
  const firstServing = fixture.path('stacks/consumer/source-runtime/ui');
  const otherServing = fixture.path('stacks/independent/source-runtime/ui');
  await selectShared({ built: first, uiDir: firstServing, pending });
  await selectShared({ built: other, uiDir: otherServing, pending: otherPending });
  const debug = await exportShared({ ...options, outputDir: fixture.path('debug'),
    env: { ...options.env, EXPO_PUBLIC_DEBUG: '1' } });
  assert.equal(await exports(), 3);
  assert.notEqual(debug.uiDir, first.uiDir);
  assert.match(await readFile(join(debug.uiDir, 'app.js'), 'utf8'), /"1"/);
  await selectShared({ built: debug, uiDir: firstServing, pending });
  assert.match(await readFile(join(firstServing, 'app.js'), 'utf8'), /"1"/);
  assert.match(await readFile(join(otherServing, 'app.js'), 'utf8'), /"0"/,
    'a web-only reload changes this Stack serving link without changing another consumer');
  await chmod(join(first.uiDir, 'app.js'), 0o644);
  await writeFile(join(first.uiDir, 'app.js'), 'damaged');
  const repaired = await exportShared({ ...options, outputDir: fixture.path('repair') });
  assert.equal(await exports(), 4, 'a content-damaged completed export is not reusable');
  assert.match(await readFile(join(repaired.uiDir, 'app.js'), 'utf8'), /"0"/);
  await assert.rejects(exportShared({ ...options, outputDir: fixture.path('failure'),
    env: { ...options.env, EXPO_PUBLIC_DEBUG: '1', EXPO_PUBLIC_FEATURES: 'different' } }), /ENOSPC/);
  const afterFailure = await exportShared({ ...options, outputDir: fixture.path('after-failure') });
  assert.equal(afterFailure.uiDir, repaired.uiDir, 'a failed distinct export cannot replace the incumbent');
  assert.equal(await exports(), 5);
  const terminal = await exportShared({ ...options,
    env: { ...options.env, HAPPIER_TERMINAL_NATIVE_BUILD_EVIDENCE_ID: 'term-build-distinct-options' } });
  assert.notEqual(terminal.uiDir, repaired.uiDir, 'app configuration options participate in reuse');
  assert.equal(await exports(), 6);
  const member = join(repoDir, 'apps/ui/sources/completedWebMembership.ts');
  await writeFile(member, 'export const added = true;');
  assert.equal((await prepareSourceQaWebUi(qaUiOptions)).mode, 'borrowed', 'changed UI inputs cannot default to a stale publication');
  assert.equal(await exports(), 6, 'missing matching publication must not build in a QA consumer');
  const changed = await exportShared(options);
  assert.equal(changed.uiDir, repaired.uiDir, 'moving source must adopt the latest completed capture without a QA compiler');
  assert.equal(await exports(), 6);
  const sourceCapturedAfter = new Date().toISOString();
  const refreshed = await exportShared({ ...options, sourceCapturedAfter });
  assert.notEqual(refreshed.uiDir, repaired.uiDir, 'an explicit freshness request waits for a newer producer capture');
  assert.ok(Date.parse(refreshed.sourceCapture.capturedAt) >= Date.parse(sourceCapturedAfter));
  assert.equal(await exports(), 7);
  assert.equal((await prepareSourceQaWebUi(qaUiOptions)).built.uiDir, refreshed.uiDir, 'newly matching publication restores default export adoption');
  await rm(member);
  assert.equal((await exportShared(options)).uiDir, refreshed.uiDir, 'Undo still adopts the latest completed capture');
  assert.equal(await exports(), 7);
  const fault = fixture.path('completion-fault.mjs');
  // Fail only the real output-completion rename; no cache/publication logic
  // or domain owner is substituted beneath the filesystem boundary.
  await writeFile(fault, `import fs from 'node:fs/promises'; import {syncBuiltinESMExports} from 'node:module';
    import {basename} from 'node:path'; const rename=fs.rename;
    fs.rename=async(from,to)=>{if(basename(to)==='source-bundle.json')throw Object.assign(new Error('ENOSPC at web completion'),{code:'ENOSPC'});return rename(from,to)};
    syncBuiltinESMExports();`);
  const servingBytes = await readFile(join(firstServing, 'app.js'), 'utf8');
  await assert.rejects(exportShared({ ...options, env: { ...options.env, EXPO_PUBLIC_FEATURES: 'publication-failure',
    NODE_OPTIONS: [options.env.NODE_OPTIONS, `--import=${pathToFileURL(fault).href}`].filter(Boolean).join(' ') } }), /ENOSPC at web completion/);
  assert.equal(await readFile(join(firstServing, 'app.js'), 'utf8'), servingBytes);
  assert.equal((await exportShared(options)).uiDir, refreshed.uiDir, 'failed completion keeps reusable incumbent bytes');
  assert.equal(await exports(), 8);

  const privateExport = await exportShared({ ...options, stackBaseDir: undefined, pending: undefined,
    outputDir: fixture.path('private-export') });
  assert.equal(await exports(), 9, 'the private finite producer must execute its own Expo boundary');
  assert.match(await readFile(join(privateExport.uiDir, 'app.js'), 'utf8'), /"0"/);

  const artifactOwnerPath = fixture.path('artifact.mjs');
  await writeFile(artifactOwnerPath, relocateSourceOwnerImports(artifactOwnerText, artifactSource,
    new Map([...sourceBoundaries, ['./build_source_web_ui.mjs', pathToFileURL(publicOwner)]])));
  const { buildWebArtifact } = await import(pathToFileURL(artifactOwnerPath));
  const artifact = await buildWebArtifact({ rootDir: repoDir, artifactDir: fixture.path('artifacts/web/finite'),
    artifactFingerprint: 'finite', sourceMetadata: { sourceFingerprint: 'fixture', builtAt: '2026-10-12T00:00:00Z' },
    env: { ...env, HAPPIER_STACK_REPO_DIR: repoDir, HAPPIER_STACK_HOME_DIR: fixture.path('home') },
    // Installation is the package-manager boundary. Capture, SDK preparation,
    // finite admission, Expo execution and artifact publication remain real.
    ensureDepsInstalledImpl: async () => {} });
  assert.equal(await exports(), 10);
  assert.match(await readFile(join(artifact.artifactDir, 'payload/app.js'), 'utf8'), /"0"/);
  assert.deepEqual(await readdir(fixture.path('artifacts/web')), ['finite']);

  // Compose the real reload owner with the same source fixture/store. Only
  // the already-used Expo executable and physical admission host are remapped;
  // runtime emission, scratch migration/health and browser boot stay real.
  let browserAvailable = false;
  try { execFileSync('agent-browser', ['--version'], { stdio: 'ignore' }); browserAvailable = true; } catch {}
  if (!native || !browserAvailable) {
    context.diagnostic('composed source web reload not exercised: native admission/browser prerequisites unavailable');
    return;
  }
  const serverDir = join(repoDir, 'apps/server');
  await mkdir(join(serverDir, 'sources'), { recursive: true });
  await mkdir(join(serverDir, 'scripts'));
  await mkdir(join(serverDir, 'node_modules'));
  await writeFile(join(serverDir, 'package.json'), JSON.stringify({ name: '@happier-dev/server', type: 'module' }));
  await writeFile(join(serverDir, 'tsconfig.json'), '{}');
  await writeFile(join(serverDir, 'scripts/migrate.sqlite.deploy.ts'), 'export async function runSqliteMigrationDeploy() {}');
  await symlink(dirname(createRequire(import.meta.url).resolve('esbuild/package.json')), join(serverDir, 'node_modules/esbuild'));
  await writeFile(join(serverDir, 'sources/main.light.ts'), `
    import {createServer} from 'node:http'; import {readFile} from 'node:fs/promises'; import {join} from 'node:path';
    createServer(async(request,response)=>{
      if(request.url==='/health') {response.setHeader('content-type','application/json');response.end(JSON.stringify({status:'ok',service:'happier-server'}));return;}
      const asset=request.url==='/'?'index.html':'app.js';
      try {response.setHeader('content-type',asset.endsWith('.js')?'text/javascript':'text/html');response.end(await readFile(join(process.env.HAPPIER_SERVER_UI_DIR,asset)));}
      catch {response.statusCode=404;response.end();}
    }).listen(Number(process.env.PORT),process.env.HOST, () => console.log('API ready on port http://localhost:' + process.env.PORT));
  `);
  const runtimePath = fixture.path('native-owner/apps/stack/scripts/build/build_source_runtime.mjs');
  await mkdir(dirname(runtimePath), { recursive: true });
  await writeFile(runtimePath, relocateSourceOwnerImports(runtimeOwnerText, runtimeSource,
    new Map([['../utils/proc/runSourceBuildCommand.mjs', null], ['../utils/proc/workspace_build_admission.mjs', null]])));
  const smokePath = fixture.path('native-owner/apps/stack/scripts/runtime/launch/smokeSourceRuntimeReload.mjs');
  await mkdir(dirname(smokePath), { recursive: true });
  await writeFile(smokePath, relocateSourceOwnerImports(smokeOwnerText, smokeSource));
  const reloadPath = fixture.path('prepare-source-reload.mjs');
  await writeFile(reloadPath, relocateSourceOwnerImports(reloadOwnerText, reloadSource,
    new Map([['../../build/build_source_runtime.mjs', pathToFileURL(runtimePath)],
      ['../../build/build_source_web_ui.mjs', pathToFileURL(publicOwner)]])));
  const { prepareSourceRuntimeReload } = await import(pathToFileURL(reloadPath));
  const reload = sourceCapturedAfter => prepareSourceRuntimeReload({ stackName: 'independent', stackBaseDir: otherStackBaseDir,
    repoDir, args: ['--no-daemon', '--ui=export', ...(sourceCapturedAfter ? [`--source-after=${sourceCapturedAfter}`] : [])], onHost: true,
    env: { ...env, HAPPIER_STACK_SERVER_COMPONENT: 'happier-server-light', HAPPIER_DB_PROVIDER: 'sqlite' } });
  const firstReload = await reload(new Date().toISOString());
  const selectedServerPath = join(otherStackBaseDir, 'source-runtime/selected-server.json');
  const firstServer = await readFile(selectedServerPath, 'utf8');
  const firstReloadExports = await exports();
  const secondReload = await reload();
  assert.equal(secondReload.ui.uiDir, firstReload.ui.uiDir, 'two successful blue-green reloads share completed web bytes');
  assert.equal(await readFile(selectedServerPath, 'utf8'), firstServer, 'two successful blue-green reloads share completed runtime bytes');
  assert.equal(await exports(), firstReloadExports, 'the composed warm reload must skip the Expo producer');
  context.diagnostic('composed source reload passed twice with real shared server/web builders, scratch health and browser boot');
});

test('real Metro router transforms partition captures and reuse a stable project root', async context => {
  const fixture = await createTempFixture(context, { prefix: 'happier-router-transform-cache-' });
  const sourceRepo = fileURLToPath(new URL('../../../../', import.meta.url));
  const requireFromUi = createRequire(join(sourceRepo, 'apps/ui/package.json'));
  const Transformer = requireFromUi('metro/private/DeltaBundler/Transformer').default;
  const { FileStore } = requireFromUi('metro-cache');
  const routerContextFile = requireFromUi.resolve('expo-router/_ctx.web.js');
  const captures = [];
  for (const name of ['capture-a', 'capture-b']) {
    captures.push(await captureSourceWebBuildInputs({ repoDir: sourceRepo, outputDir: fixture.path(name) }));
  }
  assert.equal(relative(captures[0].uiProjectDir, routerContextFile),
    relative(captures[1].uiProjectDir, routerContextFile), 'the same installed module must have a colliding relative path');

  // Observe the filesystem boundary without substituting Metro, Babel, Router,
  // or cache logic. Await actual writes: Metro persists them asynchronously.
  class ObservedFileStore extends FileStore {
    reads = [];
    writes = [];
    async get(key) {
      const value = await super.get(key);
      this.reads.push(value !== null);
      return value;
    }
    set(key, value) {
      const pending = super.set(key, value);
      this.writes.push(pending);
      return pending;
    }
  }
  async function transform(capture, dev) {
    const requireFromCapture = createRequire(join(capture.uiProjectDir, 'package.json'));
    assert.equal(requireFromCapture.resolve('expo-router/_ctx.web.js'), routerContextFile);
    const configPath = requireFromCapture.resolve('./metro.config.js');
    delete requireFromCapture.cache[configPath];
    const config = requireFromCapture(configPath);
    assert.equal(config.projectRoot, capture.uiProjectDir);
    const store = new ObservedFileStore({ root: fixture.path('transforms') });
    config.cacheStores = [store];
    config.maxWorkers = 1;
    const transformer = new Transformer(config, { getOrComputeSha1: async file => {
      const content = await readFile(file);
      return { sha1: createHash('sha1').update(content).digest('hex'), content };
    } });
    const started = performance.now();
    try {
      const result = await transformer.transformFile(routerContextFile, {
        customTransformOptions: { routerRoot: './sources/app' }, dev,
        experimentalImportSupport: false, inlinePlatform: true, inlineRequires: false,
        minify: false, nonInlinedRequires: [], platform: 'web', type: 'module',
        unstable_transformProfile: 'default',
      });
      const elapsedMs = performance.now() - started;
      await Promise.all(store.writes);
      const dependency = result.dependencies.find(({ data }) => data.contextParams);
      assert.ok(dependency, 'the real Router transform must produce a require.context dependency');
      const routeRoot = resolve(dirname(routerContextFile), dependency.name);
      await access(join(routeRoot, '_layout.tsx'));
      return { routeRoot, key: result.unstable_transformResultKey, hits: store.reads, elapsedMs };
    } finally {
      await Promise.all(store.writes);
      await transformer.end();
    }
  }
  for (const dev of [false, true]) {
    const a = await transform(captures[0], dev);
    const b = await transform(captures[1], dev);
    // A new Transformer/config models reopening Metro at the same root.
    const repeat = await transform(captures[1], dev);
    context.diagnostic(JSON.stringify({ dev, coldAMs: a.elapsedMs, coldBMs: b.elapsedMs,
      warmBMs: repeat.elapsedMs, hits: [a.hits, b.hits, repeat.hits] }));
    assert.equal(a.routeRoot, join(captures[0].uiProjectDir, 'sources/app'));
    assert.equal(b.routeRoot, join(captures[1].uiProjectDir, 'sources/app'),
      'capture B must resolve its own route tree after capture A warms the shared cache');
    assert.equal(repeat.routeRoot, b.routeRoot);
    assert.notEqual(a.key, b.key);
    assert.equal(b.key, repeat.key);
    assert.deepEqual(a.hits, [false]);
    assert.deepEqual(b.hits, [false]);
    assert.deepEqual(repeat.hits, [true], 'a stable project root must reuse its persisted transform cache');
  }
});

test('source exports reuse transforms across captures and refresh changed modules and routes', async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-web-stable-transform-root-' });
  const sourceRepo = fileURLToPath(new URL('../../../../', import.meta.url));
  const repoDir = fixture.path('source');
  await prepareFiniteSourceWebFixture({ sourceRepo, repoDir });
  const uiPackagePath = join(repoDir, 'apps/ui/package.json');
  const uiPackage = JSON.parse(await readFile(uiPackagePath, 'utf8'));
  delete uiPackage.type; // The real Metro config is CommonJS.
  await writeFile(uiPackagePath, JSON.stringify(uiPackage));
  const requireFromUi = createRequire(join(sourceRepo, 'apps/ui/package.json'));
  const Transformer = requireFromUi('metro/private/DeltaBundler/Transformer').default;
  const { FileStore } = requireFromUi('metro-cache');
  const routerFile = requireFromUi.resolve('expo-router/_ctx.web.js');
  const sourcePaths = Array.from({ length: 100 }, (_, index) => `sources/module${index}.js`);
  for (const path of sourcePaths) await writeFile(join(repoDir, 'apps/ui', path), 'export const value = 1;');
  let previousRoot;
  let hits;
  let writes;
  const outputs = [];
  class ObservedFileStore extends FileStore {
    async get(key) {
      const result = await super.get(key);
      hits.push(result !== null);
      return result;
    }
    set(key, value) {
      const pending = super.set(key, value);
      writes.push(pending);
      return pending;
    }
  }
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt === 2) await writeFile(join(repoDir, 'apps/ui', sourcePaths[0]), 'export const value = 2;');
    if (attempt === 3) await writeFile(join(repoDir, 'apps/ui/sources/app/new-route.tsx'), 'export default function Route() { return null; }');
    hits = [];
    writes = [];
    await exportSourceWebUi({ repoDir, baseDir: fixture.path('state'), outputDir: fixture.path(`export-${attempt}`),
      env: { ...process.env, EXPO_PUBLIC_DEBUG: '0' }, runImpl: async (_command, args, { cwd }) => {
        if (previousRoot) assert.equal(cwd, previousRoot, 'one export context must keep its Router-bound project root');
        previousRoot = cwd;
        const requireFromCapture = createRequire(join(cwd, 'package.json'));
        const configPath = requireFromCapture.resolve('./metro.config.js');
        delete requireFromCapture.cache[configPath];
        const config = requireFromCapture(configPath);
        config.cacheStores = [new ObservedFileStore({ root: fixture.path('transforms') })];
        // Real exports own a fresh compiler process. Metro's single-worker
        // in-process adapter retains Babel configuration from earlier fixtures.
        config.maxWorkers = 2;
        const transformer = new Transformer(config, { getOrComputeSha1: async file => {
          const content = await readFile(file);
          return { sha1: createHash('sha1').update(content).digest('hex'), content };
        } });
        const bytes = [];
        try {
          for (const file of [...sourcePaths.map(path => join(cwd, path)), routerFile]) {
            const result = await transformer.transformFile(file, {
              customTransformOptions: { routerRoot: './sources/app' }, dev: false,
              experimentalImportSupport: false, inlinePlatform: true, inlineRequires: false,
              minify: false, nonInlinedRequires: [], platform: 'web', type: 'module',
              unstable_transformProfile: 'default',
            });
            bytes.push(result.output);
            if (file === routerFile) {
              const dependency = result.dependencies.find(({ data }) => data.contextParams);
              const routeRoot = resolve(dirname(routerFile), dependency.name);
              assert.equal(routeRoot, join(cwd, 'sources/app'));
              await access(join(routeRoot, '_layout.tsx'));
              if (attempt === 3) await access(join(routeRoot, 'new-route.tsx'));
            }
          }
          await Promise.all(writes);
        } finally { await transformer.end(); }
        outputs.push(createHash('sha256').update(JSON.stringify(bytes)).digest('hex'));
        const web = args[args.indexOf('--output-dir') + 1];
        await mkdir(web);
        await writeFile(join(web, 'index.html'), '<script src="./app.js"></script>');
        await writeFile(join(web, 'app.js'), JSON.stringify(bytes));
      } });
    assert.equal(hits.length, 101);
    assert.equal(hits.filter(Boolean).length, attempt === 0 ? 0 : attempt === 2 ? 100 : 101,
      'unchanged transforms hit the persisted cache; one changed source transforms once');
  }
  assert.equal(outputs[0], outputs[1], 'cold and warm transformed bytes must match');
  assert.notEqual(outputs[1], outputs[2], 'changed source must produce new transformed bytes');
});

test('shared source publication retains serving, selected and pending web exports independently', async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-web-product-retention-', registerCleanup: false });
  const store = fixture.path('alias-stacks');
  await mkdir(fixture.path('stacks'));
  await symlink(fixture.path('stacks'), store, process.platform === 'win32' ? 'junction' : 'dir');
  const stackBaseDir = join(store, 'serving');
  const pending = await beginPendingSourceStart({ stackBaseDir: join(store, 'preparing') });
  t.after(async () => { await pending.dispose(); await setBundleReadOnly(fixture.root, false); await fixture.cleanup(); });
  const publish = async name => {
    const outputDir = join(store, 'source-bundles', `web-${name}`);
    const uiDir = join(outputDir, 'web');
    await mkdir(uiDir, { recursive: true });
    await writeFile(join(uiDir, 'index.html'), '<p>completed export</p>');
    await withSourceBundlePublication({ stackBaseDir, outputDir, record: { component: 'web', uiDir } }, async () => {});
    return { outputDir, uiDir };
  };
  const serving = await publish('serving');
  const servingLink = join(stackBaseDir, 'source-runtime/ui');
  await mkdir(dirname(servingLink), { recursive: true });
  await symlink(serving.uiDir, servingLink, process.platform === 'win32' ? 'junction' : 'dir');
  // Selections pin while the serving Stack's own owner process runs.
  const { ownerPid } = await startRunningStackOwner(t, stackBaseDir);
  await recordStackRuntimeStart(join(stackBaseDir, 'stack.runtime.json'), {
    stackName: 'serving', ownerPid, runtimeMode: 'source-snapshot', sourceUi: 'export',
    sourceUiLaunch: { uiDir: servingLink },
  });
  const preparationDir = join(store, 'preparing/source-runtime/bundle-reload');
  await mkdir(preparationDir);
  await writeFile(join(preparationDir, 'candidate.mjs'), 'export const ready = true;');
  await pending.retainPreparation(preparationDir);
  const preparing = await publish('preparing');
  await pending.retainPreparation(preparing.outputDir);
  const selected = await publish('selected');
  await mkdir(join(stackBaseDir, 'source-runtime'), { recursive: true });
  await writeFile(join(stackBaseDir, 'source-runtime/selected-ui.json'), JSON.stringify({ uiDir: selected.uiDir }));
  const abandoned = await publish('abandoned');
  await publish('newest');
  for (const product of [serving, preparing, selected]) await access(join(product.uiDir, 'index.html'));
  await access(join(preparationDir, 'candidate.mjs'));
  if (process.platform !== 'win32') await assert.rejects(access(abandoned.uiDir), { code: 'ENOENT' });
  await pending.publish(async () => {});
  await publish('after-preparation');
  await access(join(serving.uiDir, 'index.html'));
  await access(join(selected.uiDir, 'index.html'));
  if (process.platform !== 'win32') {
    await assert.rejects(access(preparing.uiDir), { code: 'ENOENT' });
    await assert.rejects(access(preparationDir), { code: 'ENOENT' });
  }
});

test('failed source product publication retires completion before a competing reader can adopt it', async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-web-completion-handoff-', registerCleanup: false });
  const stackBaseDir = fixture.path('stacks/consumer');
  const pending = await beginPendingSourceStart({ stackBaseDir });
  let replacement;
  t.after(async () => {
    await replacement?.dispose();
    await pending.dispose();
    await setBundleReadOnly(fixture.root, false);
    await fixture.cleanup();
  });
  const outputDir = fixture.path('stacks/source-bundles/bundle-failed');
  await mkdir(join(outputDir, 'web'), { recursive: true });
  await writeFile(join(outputDir, 'web/index.html'), '<p>complete</p>');
  let entered;
  let release;
  const ready = new Promise(resolve => { entered = resolve; });
  const resume = new Promise(resolve => { release = resolve; });
  const failed = withSourceBundlePublication({ stackBaseDir, outputDir,
    record: { component: 'web', uiDir: join(outputDir, 'web') } }, async () => {
    entered();
    await resume;
    await pending.retainPreparation(outputDir);
  });
  const rejected = assert.rejects(failed, { code: 'ESOURCESTARTSUPERSEDED' });
  await ready;
  replacement = await beginPendingSourceStart({ stackBaseDir });
  const nextReader = withSourceBundlePublication({ stackBaseDir }, async () =>
    await assert.rejects(access(join(outputDir, 'source-bundle.json')), { code: 'ENOENT' }));
  release();
  await rejected;
  await nextReader;
});

test('cold Expo source preparation needs no workspace dist build or materialization stamp', async context => {
  const fixture = await createTempFixture(context, { prefix: 'happier-expo-source-inputs-' });
  const sourceRepo = fileURLToPath(new URL('../../../../', import.meta.url));
  const repoDir = fixture.path('source');
  const owners = [...(await readWorkspacePackages(sourceRepo)).values()]
    .filter(({ root }) => relative(sourceRepo, root).startsWith('packages')
      || ['apps/ui', 'apps/stack'].includes(relative(sourceRepo, root).replaceAll('\\', '/')));
  await captureSourceWebBuildInputs({ repoDir: sourceRepo, outputDir: repoDir });
  await cp(join(sourceRepo, 'apps/stack/bin'), join(repoDir, 'apps/stack/bin'), { recursive: true });
  for (const { root } of owners) {
    const path = join(repoDir, relative(sourceRepo, root), 'package.json');
    const manifest = JSON.parse(await readFile(path, 'utf8'));
    manifest.scripts = { ...manifest.scripts, build: 'node -e "throw new Error(\'workspace dist is not a Metro input\')"' };
    await writeFile(path, JSON.stringify(manifest));
  }
  const sharedInventory = join(repoDir, 'apps/ui/sources/sync/domains/plugins/availability/generatedBundledPluginUiArtifacts.js');
  await writeFile(sharedInventory, '// another consumer owns this inventory\n');
  const env = { ...process.env, HAPPIER_UI_PLUGIN_ARTIFACT_INVENTORY: fixture.path('consumer-a/inventory.js') };
  // A copied checkout must enter through its real source-tool authority, just
  // like live Expo. Importing its preflight into this unrelated test process
  // bypasses that entry and asks an intentionally absent dist to own imports.
  const preflight = join(repoDir, 'apps/stack/scripts/cold_preflight.mjs');
  await writeFile(preflight, String.raw`
  import assert from 'node:assert/strict';
  import { access, readFile, rm, writeFile } from 'node:fs/promises';
  import { join } from 'node:path';
  import { ensureExpoWorkspacePrepared, hasUsableExpoWorkspaceLastGreen, withExpoPreparationEnv }
    from ${JSON.stringify(pathToFileURL(join(repoDir, 'apps/stack/scripts/utils/expo/command.mjs')).href)};
  const repoDir = ${JSON.stringify(repoDir)};
  const sharedInventory = ${JSON.stringify(sharedInventory)};
  const env = process.env;
  const result = await withExpoPreparationEnv(env, async preparationEnv => {
    const result = await ensureExpoWorkspacePrepared({ projectDir: join(repoDir, 'apps/ui'), env: preparationEnv });
    assert.equal(preparationEnv.HAPPIER_UI_PLUGIN_ARTIFACT_INVENTORY, result.outputPath);
    return result;
  });
  const inventory = await readFile(result.outputPath, 'utf8');
  assert.equal(result.outputPath, env.HAPPIER_UI_PLUGIN_ARTIFACT_INVENTORY);
  assert.equal(await readFile(sharedInventory, 'utf8'), '// another consumer owns this inventory\n');
  assert.match(inventory, /happier\.channels/);
  assert.match(inventory, /happier\.triage/);
  for (const [, assetPath] of inventory.matchAll(/require\(("(?:[^"\\]|\\.)*")\)/g)) await access(JSON.parse(assetPath));
  const other = await ensureExpoWorkspacePrepared({ projectDir: join(repoDir, 'apps/ui'),
    env: { ...env, HAPPIER_UI_PLUGIN_ARTIFACT_INVENTORY: ${JSON.stringify(fixture.path('consumer-b/inventory.js'))} } });
  assert.notEqual(other.outputPath, result.outputPath);
  assert.equal(await readFile(result.outputPath, 'utf8'), inventory);
  for (const [, assetPath] of inventory.matchAll(/require\(("(?:[^"\\]|\\.)*")\)/g)) await access(JSON.parse(assetPath));
  assert.equal(await hasUsableExpoWorkspaceLastGreen({ projectDir: join(repoDir, 'apps/ui'), env }), true);
  // Asset-only refresh must not even evaluate the Plugin UI compiler. Keep the
  // real Stack child, source-asset generators and publication beneath this.
  await writeFile(join(repoDir, 'apps/ui/scripts/prepareSourcePluginUiArtifacts.mjs'),
    'throw new Error("asset-only refresh evaluated the Plugin UI compiler");');
  const { prepareUiSourcePluginInventory } = await import(${JSON.stringify(pathToFileURL(join(repoDir, 'apps/ui/scripts/ensureWorkspacePackagesBuilt.mjs')).href)});
  await prepareUiSourcePluginInventory({ uiPackageDir: join(repoDir, 'apps/ui'), env, preparePlugins: false });
  assert.equal(await readFile(result.outputPath, 'utf8'), inventory, 'asset-only preparation retains last-green plugin bytes');
  const asset = inventory.match(/require\(("(?:[^"\\]|\\.)*")\)/);
  assert.ok(asset);
  await rm(JSON.parse(asset[1]));
  assert.equal(await hasUsableExpoWorkspaceLastGreen({ projectDir: join(repoDir, 'apps/ui'), env }), false,
    'real source inventory admission includes its published assets');
  await assert.rejects(access(join(repoDir, 'packages/plugin-sdk/dist')), { code: 'ENOENT' });
  await assert.rejects(access(join(repoDir, '.project/tmp/cli-source-dev-shared-deps-sync.json')), { code: 'ENOENT' });
  `);
  const result = await runNodeCapture(sourceBuildNodeArgs({ repoDir, scriptPath: preflight }), { cwd: repoDir, env });
  assert.equal(result.code, 0, result.stderr);
});

test('source web export retains captured UI and workspace inputs across live additions, removals and edits', async context => {
  const fixture = await createTempFixture(context, { prefix: 'happier-web-input-churn-' });
  const sourceRepo = fileURLToPath(new URL('../../../../', import.meta.url));
  const repoDir = fixture.path('live');
  const { toolInput, toolDigest } = await prepareFiniteSourceWebFixture({ sourceRepo, repoDir });
  const uiInput = 'apps/ui/sources/webExportChurn.ts';
  const workspaceInput = 'packages/protocol/src/webExportChurn.ts';
  const specimenInput = 'apps/ui/sources/dev/testkit/harness/liveExportSpecimen.ts';
  await mkdir(join(repoDir, 'apps/ui/sources/dev/testkit/harness'), { recursive: true });
  await writeFile(join(repoDir, specimenInput), 'export const specimen = "shipped-debug-fixture";');
  await writeFile(join(repoDir, uiInput), 'export const value = "captured-ui";');
  await writeFile(join(repoDir, workspaceInput), 'export const value = "captured-workspace";');
  const result = await exportSourceWebUi({ repoDir, baseDir: fixture.path('state'), outputDir: fixture.path('output'),
    env: { ...process.env, EXPO_PUBLIC_DEBUG: '0' },
    runImpl: async (_command, args, { cwd, env }) => {
      await rm(join(repoDir, uiInput));
      await writeFile(join(repoDir, workspaceInput), 'export const value = "changed-live";');
      await writeFile(join(repoDir, 'apps/ui/sources/createdDuringExport.ts'), 'export const late = true;');
      const inputRepo = join(cwd, '../..');
      assert.equal(await readFile(join(inputRepo, specimenInput), 'utf8'), 'export const specimen = "shipped-debug-fixture";');
      assert.equal(await readFile(join(inputRepo, uiInput), 'utf8'), 'export const value = "captured-ui";');
      assert.equal(await readFile(join(inputRepo, workspaceInput), 'utf8'), 'export const value = "captured-workspace";');
      await assert.rejects(access(join(cwd, 'sources/createdDuringExport.ts')), { code: 'ENOENT' });
      assert.equal(createHash('sha256').update(await readFile(join(inputRepo, toolInput))).digest('hex'), toolDigest);
      const inventory = (await readFile(env.HAPPIER_UI_PLUGIN_ARTIFACT_INVENTORY, 'utf8')).replaceAll('export const ', 'const ');
      const artifacts = runInNewContext(`${inventory}\nBUNDLED_PLUGIN_UI_APP_ARTIFACTS`, { require: path => path });
      assert.deepEqual(Array.from(artifacts, artifact => artifact.pluginId), ['happier.admission-fixture']);
      const module = { exports: {} };
      runInNewContext(await readFile(artifacts[0].files[0].asset, 'utf8'), { module, exports: module.exports });
      assert.equal(module.exports.renderSurface(), 'captured-plugin-input');
      const web = args[args.indexOf('--output-dir') + 1];
      await mkdir(web);
      await writeFile(join(web, 'index.html'), '<script src="./app.js"></script>');
      await writeFile(join(web, 'app.js'), 'globalThis.captured = true;');
    } });
  assert.equal(await readFile(join(result.uiDir, 'app.js'), 'utf8'), 'globalThis.captured = true;');
  assert.match(result.sourceCapture?.inputIdentity ?? '', /^[a-f0-9]{64}$/);
  assert.ok(Number.isFinite(Date.parse(result.sourceCapture?.capturedAt)));
});

test('finite source export retains reused plugin assets inside its private Metro root', async context => {
  const fixture = await createTempFixture(context, { prefix: 'happier-web-retained-crawl-root-' });
  const repoDir = fixture.path('source');
  const { pluginInput } = await prepareFiniteSourceWebFixture({
    sourceRepo: fileURLToPath(new URL('../../../../', import.meta.url)), repoDir,
  });
  let producerInventory;
  const finishExport = async args => {
    const web = args[args.indexOf('--output-dir') + 1];
    await mkdir(web);
    await writeFile(join(web, 'index.html'), '<script src="./app.js"></script>');
    await writeFile(join(web, 'app.js'), 'globalThis.ready = true;');
  };
  await exportSourceWebUi({ repoDir, baseDir: fixture.path('producer'), outputDir: fixture.path('first'),
    env: { ...process.env, EXPO_PUBLIC_DEBUG: '0' },
    runImpl: async (_command, args, { env }) => {
      producerInventory = await readFile(env.HAPPIER_UI_PLUGIN_ARTIFACT_INVENTORY, 'utf8');
      await finishExport(args);
    } });
  const projection = join(repoDir, 'apps/ui/sources/sync/domains/plugins/availability/generatedBundledPluginUiArtifacts.js');
  await mkdir(dirname(projection), { recursive: true });
  await writeFile(projection, producerInventory);
  // An unavailable new compilation must retain the genuine last-green graph,
  // but its producer's directory is not a private export's Metro watch root.
  await writeFile(pluginInput, 'export const broken = ;');
  await exportSourceWebUi({ repoDir, baseDir: fixture.path('consumer'), outputDir: fixture.path('second'),
    env: { ...process.env, EXPO_PUBLIC_DEBUG: '0' },
    runImpl: async (_command, args, { env }) => {
      const inventory = await readFile(env.HAPPIER_UI_PLUGIN_ARTIFACT_INVENTORY, 'utf8');
      const artifacts = runInNewContext(`${inventory.replaceAll('export const ', 'const ')}\nBUNDLED_PLUGIN_UI_APP_ARTIFACTS`, { require: path => path });
      const retained = artifacts.find(artifact => artifact.pluginId === 'happier.admission-fixture');
      assert.ok(retained, 'last-green UI must remain admitted');
      for (const file of retained.files) {
        await access(file.asset);
        const suffix = relative(dirname(env.HAPPIER_UI_PLUGIN_ARTIFACT_INVENTORY), file.asset);
        assert.ok(!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith('../') && !suffix.startsWith('..\\'),
          'retained assets must be inside the consumer inventory watch root');
      }
      await finishExport(args);
    } });
});

test('source web export uses fresh private source projections and one-shot origin-relative Expo output', async (context) => {
  const scratch = await mkdtemp(join(tmpdir(), 'happier-source-web-ui-'));
  context.after(() => rm(scratch, { recursive: true, force: true }));
  const repoDir = fileURLToPath(new URL('../../../../', import.meta.url));
  const baseDir = join(scratch, 'expo-state');
  const outputDir = join(scratch, 'export');
  let expectedOutputDir = outputDir;
  const exportInputs = [];
  const env = { ...process.env, EXPO_PUBLIC_HAPPIER_SERVER_URL: 'https://moving-producer.invalid', EXPO_PUBLIC_DEBUG: '0' };
  delete env.HAPPIER_STACK_EXPO_SHARED_TMPDIR_BASE_DIR;
  delete env.HAPPIER_STACK_EXPO_SHARED_TMPDIR_KEY;
  let exportCalls = 0;
  const residentEsbuildChildren = () => {
    if (process.platform !== 'linux' && process.platform !== 'darwin') return [];
    return execFileSync('ps', ['-axo', 'pid=,ppid=,stat=,comm='], { encoding: 'utf8' })
      .split('\n').flatMap(line => {
        const row = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/.exec(line);
        return row && Number(row[2]) === process.pid && !row[3].startsWith('Z')
          && /(?:^|[/\\])esbuild(?:\.exe)?$/.test(row[4]) ? [row[1]] : [];
      });
  };
  // Other tests use the compiler in this process. This finite preparation
  // owns only services it creates, not a preceding source tool's service.
  const existingEsbuildChildren = new Set(residentEsbuildChildren());
  // Expo is the external process boundary. Source preparation and its entire
  // first-party compiler/generator graph remain real beneath this boundary.
  const runImpl = async (command, args, options) => {
    if (args[0] !== 'export') return run(command, args, options);
    exportCalls += 1;
    await access(join(options.cwd, '../cli/scripts/buildPublication.mjs'));
    assert.equal(options.env.CI, '1');
    assert.equal(options.env.EXPO_PUBLIC_HAPPIER_SERVER_URL, '');
    assert.equal(options.env.EXPO_PUBLIC_DEBUG, exportCalls === 1 ? '0' : '1');
    assert.deepEqual(residentEsbuildChildren().filter(pid => !existingEsbuildChildren.has(pid)), [],
      'source preparation must release its esbuild service before Expo starts');
    const inventory = await readFile(options.env.HAPPIER_UI_PLUGIN_ARTIFACT_INVENTORY, 'utf8');
    assert.match(inventory, /happier\.channels/);
    assert.match(inventory, /happier\.posthog/);
    assert.match(inventory, /happier\.triage/);
    assert.match(inventory, /BUNDLED_PLUGIN_BRAND_MARKS/);
    assert.match(inventory, /happier\.inspector/);
    assert.match(inventory, /happier\.machine\.hetzner/);
    assert.ok(inventory.includes(join(baseDir, 'source-web')));
    const uiDir = args[args.indexOf('--output-dir') + 1];
    exportInputs.push({ tmpDir: options.env.TMPDIR,
      inventoryPath: options.env.HAPPIER_UI_PLUGIN_ARTIFACT_INVENTORY, uiDir });
    await mkdir(uiDir);
    await writeFile(join(uiDir, 'index.html'), '<!doctype html><html><script src="./app.js"></script></html>');
    await writeFile(join(uiDir, 'app.js'), `globalThis.ready = ${exportCalls};\n`.repeat(300));
  };
  const result = await exportSourceWebUi({ repoDir, baseDir, outputDir, env, runImpl });
  assert.equal(exportCalls, 1);
  assert.equal(result.uiDir, join(outputDir, 'web'));
  assert.equal(result.entrypoint, 'index.html');
  await assert.rejects(access(join(result.uiDir, 'node_modules')), { code: 'ENOENT' });
  const firstBytes = await readFile(join(result.uiDir, 'app.js'), 'utf8');
  assert.equal(brotliDecompressSync(await readFile(join(result.uiDir, 'app.js.br'))).toString(), firstBytes);
  assert.equal(gunzipSync(await readFile(join(result.uiDir, 'app.js.gz'))).toString(), firstBytes);
  expectedOutputDir = join(scratch, 'second-export');
  delete env.EXPO_PUBLIC_DEBUG;
  const second = await exportSourceWebUi({ repoDir, baseDir, outputDir: expectedOutputDir, env, runImpl });
  assert.equal(exportCalls, 2);
  assert.equal(exportInputs[0].tmpDir, exportInputs[1].tmpDir,
    'explicit rebuilds must preserve the canonical Expo cache directory');
  assert.ok(exportInputs[0].tmpDir.startsWith(baseDir));
  assert.equal(exportInputs[0].inventoryPath, exportInputs[1].inventoryPath,
    'the compiler retains its validated candidates across exports in one context');
  assert.notEqual(result.uiDir, second.uiDir);
  assert.equal(await readFile(join(result.uiDir, 'app.js'), 'utf8'), firstBytes);
  assert.notEqual(await readFile(join(second.uiDir, 'app.js'), 'utf8'), firstBytes);
  const beforeReload = await readFile(join(result.uiDir, 'app.js'), 'utf8');
  const reloaded = await exportSourceWebUi({ repoDir, baseDir, outputDir: join(scratch, 'reload'),
    replaceUiDir: result.uiDir, env,
    runImpl: async (_command, args) => {
      assert.equal(await readFile(join(result.uiDir, 'app.js'), 'utf8'), beforeReload,
        'the live server must keep serving its previous export during preparation');
      const web = args[args.indexOf('--output-dir') + 1];
      await mkdir(web);
      await writeFile(join(web, 'index.html'), '<script src="./current.js"></script>');
      await writeFile(join(web, 'current.js'), 'globalThis.current = true;');
    } });
  assert.equal(reloaded.uiDir, result.uiDir, 'reload publishes at the existing server path without restarting it');
  assert.equal(await readFile(join(result.uiDir, 'current.js'), 'utf8'), 'globalThis.current = true;');
  await assert.rejects(access(join(result.uiDir, 'app.js')), { code: 'ENOENT' });
  await assert.rejects(exportSourceWebUi({ repoDir, baseDir, outputDir,
    replaceUiDir: result.uiDir, env }), { code: 'EEXIST' });
  assert.equal(await readFile(join(result.uiDir, 'current.js'), 'utf8'), 'globalThis.current = true;',
    'failed reload must retain the currently served export');
});

test('source web export admits its complete finite capture before consumption and reuses custody for Expo',
  { skip: process.platform !== 'linux', timeout: 180000 }, async (context) => {
    const fixture = await createTempFixture(context, { prefix: 'happier-source-expo-admission-', registerCleanup: false });
    let pending;
    context.after(async () => { await Promise.allSettled([pending]); await fixture.cleanup(); });
    const native = await installNativeAdmissionFixture({ root: fixture.root });
    const sourceRepo = fileURLToPath(new URL('../../../../', import.meta.url));
    const repoDir = fixture.path('repo');
    const { uiInput, uiSource, pluginInput, toolInput, toolDigest } = await prepareFiniteSourceWebFixture({ sourceRepo, repoDir });
    const outputDir = fixture.path('export');
    const available = fixture.path('available-memory');
    const lowMemoryObserved = fixture.path('low-memory-observed');
    const executed = fixture.path('expo-executed');
    await writeFile(available, '5242880');
    const pressure = await holdNativeAdmissionFixtureMemory(context, native, { totalKiB: 16777216, availableKiB: 5242880 });
    await mkdir(fixture.path('bin'));
    await writeFile(fixture.path('bin/awk'), `#!/bin/sh
case "$*" in
  */proc/meminfo*)
    available=$(/bin/cat '${available}')
    printf '%s 16777216\\n' "$available"
    [ "$available" -ne 5242880 ] || printf 'observed' > '${lowMemoryObserved}'
    ;;
  */proc/loadavg*|*/proc/pressure/*) printf '0\\n' ;;
  *) exec /usr/bin/awk "$@" ;;
esac
`);
    await chmod(fixture.path('bin/awk'), 0o755);
    const expo = fixture.path('bin/expo');
    const expoScript = fixture.path('expo.mjs');
    await writeFile(expo, `#!/bin/sh\nexec '${process.execPath}' '${expoScript}' "$@"\n`);
    await chmod(expo, 0o755);
    await writeFile(expoScript, `
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdirSync,readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {runInNewContext} from 'node:vm';
const root=${JSON.stringify(native.admissionRoot)};
const token=process.env.HAPPIER_HEAVYWEIGHT_ADMISSION_TOKEN;
const owner=token && join(root,'owners',token.replace(':','-'));
const capturedRepo=resolve(process.cwd(),'../..');
assert.equal(readFileSync(join(capturedRepo,'apps/ui/sources/app/_layout.tsx'),'utf8'),${JSON.stringify(uiSource)});
assert.equal(createHash('sha256').update(readFileSync(join(capturedRepo,${JSON.stringify(toolInput)}))).digest('hex'),${JSON.stringify(toolDigest)});
const inventory=readFileSync(process.env.HAPPIER_UI_PLUGIN_ARTIFACT_INVENTORY,'utf8').replaceAll('export const ','const ');
const artifacts=runInNewContext(inventory+'\\nBUNDLED_PLUGIN_UI_APP_ARTIFACTS',{require:path=>path});
assert.deepEqual(Array.from(artifacts,artifact=>artifact.pluginId),['happier.admission-fixture']);
const module={exports:{}};
runInNewContext(readFileSync(artifacts[0].files[0].asset,'utf8'),{module,exports:module.exports});
assert.equal(module.exports.renderSurface(),'captured-plugin-input');
writeFileSync(${JSON.stringify(executed)},JSON.stringify({className:owner ? readFileSync(join(owner,'class'),'utf8').trim() : null, owners:readdirSync(join(root,'owners')).length,cwd:process.cwd()}));
const output=process.argv[process.argv.indexOf('--output-dir')+1];
mkdirSync(output);writeFileSync(join(output,'index.html'),'<!doctype html><script src="./app.js"></script>');
writeFileSync(join(output,'app.js'),'globalThis.ready=true;');
`);
    const adapter = fixture.path('native-owner/apps/stack/scripts/utils/proc/runSourceBuildCommand.mjs');
    const adapterSource = new URL('../utils/proc/runSourceBuildCommand.mjs', import.meta.url);
    await writeFile(adapter, (await readFile(adapterSource, 'utf8')).replace(
      "from '../dev/devReloadCoordinator.mjs'", `from ${JSON.stringify(new URL('../dev/devReloadCoordinator.mjs', adapterSource).href)}`));
    const commandBoundary = fixture.path('expo-command.mjs');
    // Mock only installed executable lookup and physical OS memory. Public
    // orchestration, preparation, admission and the external process stay real.
    await writeFile(commandBoundary, `
export {prepareExpoCommandEnv,applyExpoExportMaxWorkersArgs} from ${JSON.stringify(new URL('../utils/expo/command.mjs', import.meta.url).href)};
import {writeFile} from 'node:fs/promises';
export async function resolveExpoBin() {
  await writeFile(${JSON.stringify(uiInput)},'export const admissionInput = "moving-ui-input";');
  await writeFile(${JSON.stringify(pluginInput)},'export function renderSurface() { return "moving-plugin-input"; }');
  return ${JSON.stringify(expo)};
}
`);
    const sourceUrl = new URL('./build_source_web_ui.mjs', import.meta.url);
    const publicOwner = fixture.path('public-source-web-ui.mjs');
    const source = (await readFile(sourceUrl, 'utf8')).replace(/from '(\.[^']+)'/g, (_match, specifier) => {
      const url = specifier === '../utils/proc/runSourceBuildCommand.mjs' ? pathToFileURL(adapter)
        : specifier === '../utils/expo/command.mjs' ? pathToFileURL(commandBoundary) : new URL(specifier, sourceUrl);
      return `from ${JSON.stringify(url.href)}`;
    });
    await writeFile(publicOwner, source);
    const { exportSourceWebUi: exportWithOsFixture } = await import(pathToFileURL(publicOwner));
    const env = { ...buildNativeAdmissionFixtureEnv(), PATH: `${fixture.path('bin')}:/usr/bin:/bin`,
      HAPPIER_DEV_TARGET_EXECUTION: '1', HAPPIER_STACK_EXPO_EXPORT_MAX_WORKERS: '1' };
    await mkdir(join(native.admissionRoot, 'waiters'), { recursive: true });
    await mkdir(join(native.admissionRoot, 'owners'), { recursive: true });
    const watcher = watch(join(native.admissionRoot, 'waiters'));
    context.after(() => watcher.close());
    const pressureWatcher = watch(fixture.root);
    context.after(() => pressureWatcher.close());
    const observedPressure = new Promise((resolve, reject) => {
      pressureWatcher.on('error', reject);
      pressureWatcher.on('change', (_event, filename) => {
        if (filename === 'low-memory-observed') { pressureWatcher.close(); resolve(); }
      });
    });
    const queued = new Promise((resolve, reject) => {
      watcher.on('error', reject);
      watcher.on('change', async () => {
        try {
          if ((await readFile(available, 'utf8')) === '5242880'
            && (await readdir(join(native.admissionRoot, 'waiters'))).length) {
            watcher.close();
            resolve('queued');
          }
        } catch (error) { reject(error); }
      });
    });
    pending = exportWithOsFixture({ repoDir, baseDir: fixture.path('expo-state'), outputDir, env, signal: context.signal });
    void pending.catch(() => {});
    assert.equal(await Promise.race([queued, pending.then(() => 'finished')]), 'queued',
      'finite capture must wait for host memory before reading installed bytes');
    await observedPressure;
    await assert.rejects(access(executed), { code: 'ENOENT' });
    assert.deepEqual(await readdir(join(native.admissionRoot, 'owners')), [pressure.ownerPath.split('/').at(-1)],
      'the queued export has no reservation beyond the live pressure holder');
    await withDependencyRefreshLock({ installDir: repoDir, env, signal: context.signal }, async () => {});
    await pressure.release(() => writeFile(available, '16777216'));
    await pending;
    const observed = JSON.parse(await readFile(executed, 'utf8'));
    assert.ok(resolveHeavyweightMemoryFloorKiB(observed.className) > resolveHeavyweightMemoryFloorKiB('validation'),
      'the real Expo tree must retain the measured export envelope rather than validation');
    assert.deepEqual({ owners: observed.owners, cwd: observed.cwd },
      { owners: 1, cwd: fixture.path('expo-state/source-web/workspace/apps/ui') });
    assert.deepEqual(await readdir(join(native.admissionRoot, 'owners')), []);
    assert.deepEqual(await readdir(join(native.admissionRoot, 'waiters')), []);
  });
