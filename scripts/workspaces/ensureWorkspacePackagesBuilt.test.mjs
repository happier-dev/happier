import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import fsPromises from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { promisify } from 'node:util';
import { bundleWorkspaceDeps } from '../../apps/cli/scripts/bundleWorkspaceDeps.mjs';
import { runPluginSdkPreparedScript } from '../../packages/plugin-sdk/scripts/bundleWorkspaceDeps.mjs';
import {
  buildBundledWorkspaceDependenciesForCli,
  inspectSourceDevSharedDepsForSourceDev,
  inspectUsableSourceDevSharedDepsLastGreen,
  prepareBundledWorkspaceDependenciesForCli,
  syncSharedDepsForSourceDev,
} from '../../apps/cli/scripts/buildSharedDeps.mjs';
import {
  ensureWorkspacePackagesBuiltByName as ensureStackWorkspacePackagesBuiltByName,
} from '../../apps/stack/scripts/utils/proc/pm.mjs';
import { withCliDistBuildLock } from '../../apps/stack/scripts/utils/proc/cliDistBuildLock.mjs';
import { prepareRemoteValidationWorkspace } from '../../apps/stack/scripts/utils/dev_targets/remote_validation_preparation.mjs';
import { withDependencyRefreshLock } from '../../apps/stack/scripts/utils/proc/dependency_refresh.mjs';
import {
  ensureWorkspacePackagesBuiltByName,
  defaultWorkspaceBuildBoundary,
  ensureWorkspacePackagesBuiltForComponent,
  syncWorkspaceComponentBundledDependencies,
  hasUsableWorkspaceLastGreen,
  readWorkspaceBuildFileDigest,
  readWorkspacePackageInputFingerprint,
  isWorkspacePackageOutputValid,
  isWorkspacePackageOutputCurrent,
  inspectWorkspaceQaStalePackages,
} from './ensureWorkspacePackagesBuilt.mjs';
import {
  resolveWorkspaceBundleLockPath,
  withWorkspaceBundleLock,
} from './workspaceBundleLock.mjs';
import { createWorkspaceChildBuildEnv } from './workspaceChildBuildEnv.mjs';
import { resolveWorkspacePackageBuildLockPath } from './workspacePackageBuildLock.mjs';
import { createBundledPluginPublicationFailure } from './bundledPluginPublicationFailure.mjs';
import { isTerminalBuildFailure } from './buildInputConvergence.mjs';
import { resolveTypeScriptCliInvocation } from './resolveTypeScriptCliInvocation.mjs';
import { buildTypeScriptPackageDist } from './buildTypeScriptPackageDist.mjs';
import { run } from '../../apps/stack/scripts/utils/proc/proc.mjs';
import { resolveRuntimeBuildRequestIdentity } from '../../apps/stack/scripts/build/runtime_build_request_identity.mjs';
import { ensureSourceServerWorkspacePackagesBuilt } from '../../apps/stack/scripts/utils/server/source_server_workspace_deps.mjs';
import { ensureUiWorkspacePackagesBuilt } from '../../apps/ui/scripts/ensureWorkspacePackagesBuilt.mjs';
import { readStackInfoSnapshot } from '../../apps/stack/scripts/stack/stack_info_snapshot.mjs';
import { withPatchedProcessEnv } from '../../apps/stack/scripts/testkit/core/env_scope.mjs';
import { bundleWorkspacePackageWithRuntimeDependencies } from '../../packages/cli-common/dist/workspaces/index.js';
import { buildNativeAdmissionFixtureEnv, installNativeAdmissionFixture, installWorkspaceAdmissionProcessFixture } from '../../apps/stack/scripts/testkit/core/native_admission_fixture.mjs';
import { writeFakeBin } from '../../apps/stack/scripts/testkit/core/fake_bin_harness.mjs';

function readFixturePackageName(packageDir) {
  return JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')).name;
}

function writePnpmWorkspaceFixture(root, { workspaces, ...manifest }) {
  const packageManager = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).packageManager;
  writeFileSync(join(root, 'package.json'), JSON.stringify({ ...manifest, packageManager }));
  writeFileSync(join(root, 'pnpm-workspace.yaml'), `packages:\n${workspaces.map(pattern => `  - ${JSON.stringify(pattern)}`).join('\n')}\n`);
}

for (const preparation of ['named', 'remote-validation']) test(`${preparation} workspace preparation releases dependency and dist custody while compiler capacity is unavailable`, { skip: process.platform !== 'linux', timeout: 30_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'happier-workspace-capacity-order-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { launcher, admissionRoot } = await installNativeAdmissionFixture({ root });
  const repoRoot = join(root, 'native-owner');
  writePnpmWorkspaceFixture(repoRoot, { private: true, workspaces: ['packages/*'] });
  writeFileSync(join(repoRoot, 'pnpm-lock.yaml'), '# fixture\n');
  for (const app of ['ui', 'cli', 'server']) {
    mkdirSync(join(repoRoot, 'apps', app), { recursive: true });
    writeFileSync(join(repoRoot, 'apps', app, 'package.json'), JSON.stringify({ name: `@fixture/${app}`,
      dependencies: { '@happier-dev/example': 'workspace:*' } }));
  }
  const packageDir = join(repoRoot, 'packages', 'example');
  mkdirSync(join(packageDir, 'src'), { recursive: true });
  const manifest = { name: '@happier-dev/example', type: 'module', main: './dist/index.js', scripts: { build: 'fixture-build' } };
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify(manifest));
  writeFileSync(join(packageDir, 'src', 'index.ts'), 'export const ready = true;\n');
  const memory = join(root, 'memory');
  writeFileSync(memory, '1 73400320\n');
  writeFakeBin({ root: repoRoot, binDirName: 'node_modules/.bin', name: 'awk', content: `#!/bin/sh
case "$*" in
  */proc/meminfo*) /usr/bin/awk '{print $1, $2}' "$FIXTURE_MEMORY" ;;
  *) exec /usr/bin/awk "$@" ;;
esac
` });
  writeFakeBin({ root: repoRoot, binDirName: 'node_modules/.bin', name: 'systemctl', content: '#!/bin/sh\nexit 1\n' });
  // Package manager/compiler are process boundaries. The real native admission, package
  // graph, fingerprints, lock ownership and staged publisher remain intact.
  const compiler = join(root, 'compiler.mjs');
  writeFileSync(compiler, `import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
mkdirSync(process.env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR, { recursive: true });
writeFileSync(join(process.env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR, 'index.js'), 'export const ready = true;\\n');
`);
  const pnpm = join(root, 'pnpm.mjs');
  writeFileSync(pnpm, `import { spawnSync } from 'node:child_process';
const result = spawnSync('/bin/sh', [${JSON.stringify(launcher)}, '--heavyweight-admission', '--class=package-dist', '--machine=worker', '--', process.execPath, ${JSON.stringify(compiler)}], { stdio: 'inherit', env: process.env });
process.exitCode = result.status ?? 1;
`);
  const env = { ...buildNativeAdmissionFixtureEnv(), PATH: `${join(root, 'bin')}:/usr/bin:/bin`, npm_execpath: pnpm, CI: '',
    FIXTURE_MEMORY: memory, HAPPIER_DEV_TARGET_EXECUTION: '1', HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD: '',
    HAPPIER_WORKSPACE_DIST_BUILD_LOCK_LEASES: '[]', HAPPIER_HEAVYWEIGHT_ADMISSION_TOKEN: '',
    HAPPIER_HEAVYWEIGHT_ADMISSION_ROOT: '', HAPPIER_HEAVYWEIGHT_ADMISSION_MACHINE: '' };
  const buildOptions = { env, quiet: true, signal: t.signal,
    workspaceBuildBoundary: { ...defaultWorkspaceBuildBoundary, workerLauncherPath: launcher } };
  const build = preparation === 'named'
    ? ensureWorkspacePackagesBuiltByName(repoRoot, [manifest.name], buildOptions)
    : prepareRemoteValidationWorkspace({ repoDir: repoRoot, componentRelativeDir: 'apps/server', validationKind: 'runtime', env,
      // Only the package-manager/compiler process adapter is redirected; the
      // remote preparation, graph, admission and publication owners stay real.
      loadWorkspaceBuildOwner: async () => ({ ensureWorkspacePackagesBuiltForComponent: (dir, options) =>
        ensureWorkspacePackagesBuiltForComponent(dir, { ...buildOptions, ...options }) }) });
  void build.catch(() => {});
  const lockPath = resolveWorkspacePackageBuildLockPath(packageDir, manifest);
  try {
    for (let attempt = 0; ; attempt++) {
      if (existsSync(join(admissionRoot, 'waiters')) && readdirSync(join(admissionRoot, 'waiters')).length) break;
      if (attempt === 500) assert.fail('compiler preparation did not enter the native queue');
      await new Promise(resolveWait => setTimeout(resolveWait, 10));
    }
    // A compiler queued for capacity must not prevent another preparer from
    // reading/publishing under this same canonical dist lease.
    assert.equal(existsSync(lockPath), false, 'capacity wait must release the publisher lease');
    await withWorkspaceBundleLock(() => {}, { lockPath, timeoutMs: 30, staleAfterMs: 1_000 });
    await withDependencyRefreshLock({ installDir: repoRoot, env, signal: t.signal }, async () => {});
    assert.equal(readdirSync(join(admissionRoot, 'owners')).length, 0);
  } finally {
    writeFileSync(memory, '73400320 73400320\n');
    const result = await build;
    assert.deepEqual(result.built, [manifest.name]);
  }
  assert.equal(isWorkspacePackageOutputCurrent(packageDir), true);
});

test('finite workspace worker streams active-package progress before compiler completion', async t => {
  const root = mkdtempSync(join(tmpdir(), 'happier-workspace-worker-progress-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  withPatchedProcessEnv(t, { HAPPIER_STACK_REPO_DIR: root, HAPPIER_STACK_RUNTIME_IDENTITY_REPO_DIR: null });
  writePnpmWorkspaceFixture(root, { private: true, workspaces: ['apps/*', 'packages/*'] });
  for (const app of ['server', 'cli', 'ui']) {
    mkdirSync(join(root, 'apps', app), { recursive: true });
    writeFileSync(join(root, 'apps', app, 'package.json'), JSON.stringify({ name: `@fixture/${app}` }));
  }
  const dir = join(root, 'packages/example');
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src/index.ts'), 'export const ready = true;');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@happier-dev/example', type: 'module',
    main: './dist/index.js', scripts: { build: 'node compile.mjs' } }));
  const native = await installWorkspaceAdmissionProcessFixture(t, root);
  for (const fail of [false, true]) await t.test(fail ? 'failure retains the active package' : 'success retires the active package', async () => {
    let accept;
    const connected = new Promise(resolve => { accept = resolve; });
    // Input repair may require the owner's trailing pass; only hold its first compiler.
    let released = false;
    let compilerCount = 0;
    const heldSockets = [];
    const server = createServer(socket => {
      compilerCount += 1;
      if (released) socket.end('release');
      else {
        heldSockets.push(socket);
        accept(socket);
      }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    // Hold only the genuine compiler process. The finite worker, native leases,
    // callbacks and staged package publication execute their real paths.
    writeFileSync(join(dir, 'compile.mjs'), `import {connect} from 'node:net';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
const socket=connect(${port},'127.0.0.1');
socket.once('data',()=>{socket.end();
if (${fail}) {console.error('compiler.ts(1,1): error TS2307: missing import');process.exitCode=1;return;}
mkdirSync(process.env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR,{recursive:true});
writeFileSync(join(process.env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR,'index.js'),'export const ready = true;');
});
`);
    const events = [];
    let reportStart;
    const started = new Promise(resolve => { reportStart = resolve; });
    const active = new Set();
    const completion = ensureWorkspacePackagesBuiltByName(root, ['@happier-dev/example'], { env: native.env,
      quiet: true, force: true, buildMode: 'strict',
      onPackageBuildStart(context) { active.add(context.packageName); events.push('start'); reportStart(true); },
      async onPackageBuildDone(context) { await Promise.resolve(); active.delete(context.packageName); events.push('done'); },
    }).then(result => ({ result }), error => ({ error }));
    let timer;
    try {
      await Promise.race([connected, completion.then(({ error }) => {
        throw error ?? new Error('compiler completed without connecting to its fixture server');
      })]);
      const observed = await Promise.race([started, new Promise(resolve => { timer = setTimeout(() => resolve(false), 2000); })]);
      assert.equal(observed, true, 'start must reach the caller while its compiler is still blocked');
      assert.deepEqual([...active], ['@happier-dev/example']);
    } finally {
      clearTimeout(timer);
      released = true;
      for (const socket of heldSockets) socket.end('release');
      const terminal = await completion;
      await new Promise(resolve => server.close(resolve));
      if (fail) {
        assert.equal(terminal.error?.code, 'EEXIT');
        assert.deepEqual([...active], ['@happier-dev/example']);
        assert.deepEqual(events, Array.from({ length: compilerCount }, () => 'start'));
      } else {
        assert.deepEqual(terminal.result?.built, ['@happier-dev/example']);
        assert.deepEqual([...active], []);
        assert.deepEqual(events, Array.from({ length: compilerCount }, () => ['start', 'done']).flat());
      }
    }
  });
});

test('unchanged workspace admission shares graph observations without retaining them across passes', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'happier-workspace-graph-observation-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  withPatchedProcessEnv(t, { HAPPIER_STACK_REPO_DIR: root, HAPPIER_STACK_RUNTIME_IDENTITY_REPO_DIR: null });
  writePnpmWorkspaceFixture(root, { private: true, workspaces: ['apps/*', 'packages/*'] });
  for (const app of ['cli', 'ui', 'server']) {
    mkdirSync(join(root, 'apps', app), { recursive: true });
    writeFileSync(join(root, 'apps', app, 'package.json'), JSON.stringify({ name: `@fixture/${app}` }));
  }
  const dirs = Array.from({ length: 12 }, (_, index) => join(root, 'packages', `example-${index}`));
  for (const [index, dir] of dirs.entries()) {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src/index.ts'), 'export const value = 1;\n');
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: `@happier-dev/example-${index}`, type: 'module',
      main: './dist/index.js', types: './dist/index.d.ts', scripts: { build: 'fixture-build' },
      ...(index ? { dependencies: { [`@happier-dev/example-${index - 1}`]: 'workspace:*' } } : {}) }));
  }
  const builds = [];
  // Only the compiler process boundary is substituted; admission, fingerprints,
  // dependency traversal, locks and publication all use the real owners.
  const workspaceBuildBoundary = {
    prepareEnv: async (_dir, env) => ({ ...env }),
    async runPackageBuild(dir, { env }) {
      builds.push(dir);
      mkdirSync(env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR, { recursive: true });
      writeFileSync(join(env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR, 'index.js'), readFileSync(join(dir, 'src/index.ts')));
      writeFileSync(join(env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR, 'index.d.ts'), 'export declare const value: number;\n');
    },
  };
  const admit = () => ensureWorkspacePackagesBuiltByName(root, ['@happier-dev/example-11'], { workspaceBuildBoundary });
  await admit();
  builds.length = 0;
  const manifestReads = new Map();
  const originalReadFile = fsPromises.readFile;
  let changeGraphDuringObservation = false;
  t.mock.method(fsPromises, 'readFile', (...args) => {
    if (dirs.some((dir) => args[0] === join(dir, 'package.json'))) {
      manifestReads.set(args[0], (manifestReads.get(args[0]) ?? 0) + 1);
    }
    return originalReadFile(...args).then((contents) => {
      if (changeGraphDuringObservation && args[0] === join(dirs[11], 'package.json')) {
        changeGraphDuringObservation = false;
        const metadata = JSON.parse(contents);
        writeFileSync(args[0], JSON.stringify({ ...metadata, dependencies: { '@happier-dev/example-0': 'workspace:*' } }));
      }
      return contents;
    });
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const samples = [];
  for (let pass = 0; pass < 7; pass += 1) {
    manifestReads.clear();
    const started = performance.now();
    assert.deepEqual((await admit()).built, []);
    samples.push(performance.now() - started);
  }
  t.diagnostic(JSON.stringify({ unchangedPassMs: samples, packageManifestReads: [...manifestReads.values()] }));
  assert.deepEqual(builds, []);
  assert.ok([...manifestReads.values()].every((reads) => reads === 3),
    'share the graph observation while preserving fresh closure admission and queued package admission');
  writeFileSync(join(dirs[0], 'src/index.ts'), 'export const value = 2;\n');
  assert.deepEqual((await admit()).built, ['@happier-dev/example-0']);
  assert.match(readFileSync(join(dirs[0], 'dist/index.js'), 'utf8'), /value = 2/);
  writeFileSync(join(dirs[0], 'dist/index.js'), 'export const corrupted = true;\n');
  assert.deepEqual((await admit()).built, ['@happier-dev/example-0'], 'output corruption still re-enters canonical admission');
  changeGraphDuringObservation = true;
  await admit();
  assert.deepEqual(JSON.parse(readFileSync(join(dirs[11], 'dist/.happier-build-inputs.json'), 'utf8')).dependencies
    .map(({ packageDir }) => packageDir), ['packages/example-0'],
  'manifest movement during graph observation cannot publish a receipt for the old dependency closure');
});

test('strict workspace admission checks QA emit output before reusing it', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'happier-workspace-qa-emit-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  withPatchedProcessEnv(t, { HAPPIER_STACK_REPO_DIR: root, HAPPIER_STACK_RUNTIME_IDENTITY_REPO_DIR: null });
  writePnpmWorkspaceFixture(root, { private: true, workspaces: ['apps/*', 'packages/*'] });
  for (const app of ['cli', 'ui', 'server']) {
    mkdirSync(join(root, 'apps', app), { recursive: true });
    writeFileSync(join(root, 'apps', app, 'package.json'), JSON.stringify({ name: `@fixture/${app}` }));
  }
  writeFileSync(join(root, 'apps/cli/package.json'), JSON.stringify({ name: '@fixture/cli',
    dependencies: { '@happier-dev/example': 'workspace:*' }, bundledDependencies: ['@happier-dev/example'] }));
  const packageDir = join(root, 'packages/example');
  mkdirSync(join(packageDir, 'src'), { recursive: true });
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name: '@happier-dev/example', type: 'module',
    main: './dist/index.js', types: './dist/index.d.ts', scripts: { build: 'fixture-build' } }));
  writeFileSync(join(packageDir, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
    target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', rootDir: 'src', declaration: true, strict: true, types: [], incremental: true,
  }, include: ['src/**/*.ts'] }));
  const source = join(packageDir, 'src/index.ts');
  writeFileSync(source, 'export const value: string = "checked later";\n');
  const compilerPasses = [];
  const workspaceBuildBoundary = {
    prepareEnv: async (_dir, env) => ({ ...env }),
    // The package-script process boundary executes the real compiler owner.
    runPackageBuild: (packageDir, { env }) => buildTypeScriptPackageDist({
      packageDir, env, outputDir: env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR, args: ['-p', 'tsconfig.json'], stdio: 'ignore',
      // Model only the external compiler process: semantic failure must not
      // be hidden by workspace admission or by a previously emitted QA tree.
      runCommandImpl: (_command, args) => {
        compilerPasses.push(args);
        const contents = readFileSync(source, 'utf8');
        const unchecked = args.includes('--noCheck') && args[args.indexOf('--noCheck') + 1] !== 'false';
        if (!unchecked && /= [12];/.test(contents)) return { status: 1 };
        if (args.includes('--noEmit')) return { status: 0 };
        const outDir = args[args.indexOf('--outDir') + 1];
        mkdirSync(outDir, { recursive: true });
        writeFileSync(join(outDir, 'index.js'), contents.replace(': string', ''));
        writeFileSync(join(outDir, 'index.d.ts'), 'export declare const value: string;\n');
        writeFileSync(args[args.indexOf('--tsBuildInfoFile') + 1], JSON.stringify({ fileNames: [source] }));
        return { status: 0 };
      },
    }),
  };
  const build = (buildMode, extraEnv = {}) => ensureWorkspacePackagesBuiltByName(root, ['@happier-dev/example'], {
    buildMode, env: { ...process.env, npm_lifecycle_event: 'build', ...extraEnv }, workspaceBuildBoundary,
  });
  await build('qa-runtime');
  assert.deepEqual((await build('qa-runtime')).built, [], 'QA reuses its emitted output');
  const qaOutputInfo = statSync(join(packageDir, 'dist/index.js'), { bigint: true });
  assert.deepEqual((await build('strict')).built, ['@happier-dev/example'], 'strict requests cannot skip checking QA output');
  assert.ok(compilerPasses.at(-1).includes('--noEmit'), 'strict promotion checks identical emitted output without re-emitting it');
  assert.equal(statSync(join(packageDir, 'dist/index.js'), { bigint: true }).mtimeNs, qaOutputInfo.mtimeNs);
  assert.deepEqual((await build('qa-runtime')).built, [], 'QA can reuse checked output');
  assert.deepEqual((await build('strict')).built, []);
  writeFileSync(source, 'export const value: string = "stamp still must check";\n');
  await build('qa-runtime');
  const sync = (buildMode) => syncSharedDepsForSourceDev({
    repoRoot: root, workspaceNames: ['example'], includeRuntimeDependencies: false,
    publishBundledPluginArtifacts: false, stampPath: join(root, 'source-dev.json'),
    env: { ...process.env, npm_lifecycle_event: 'build', HAPPIER_WORKSPACE_BUILD_MODE: buildMode },
    // Keep source-dev and package admission real, adapting only the external
    // package script's compiler-process boundary from the fixture above.
    ensureWorkspacePackagesBuiltByNameImpl: (repoRoot, names, options) => ensureWorkspacePackagesBuiltByName(repoRoot, names, {
      ...options, workspaceBuildBoundary,
    }),
  });
  await sync('qa-runtime');
  assert.equal((await sync('qa-runtime')).reason, 'current');
  await sync('strict');
  assert.equal(JSON.parse(readFileSync(join(packageDir, 'dist/.happier-build-inputs.json'), 'utf8')).buildMode, 'strict',
    'a materialization stamp cannot upgrade emit-only output to checked output');
  writeFileSync(source, 'export const value: string = 1;\n');
  await build('qa-runtime');
  const emitted = readFileSync(join(packageDir, 'dist/index.js'), 'utf8');
  assert.match(emitted, /value = 1/);
  writeFileSync(source, 'export const value: string = 2;\n');
  await build('source-dev');
  const sourceDevEmitted = readFileSync(join(packageDir, 'dist/index.js'), 'utf8');
  assert.match(sourceDevEmitted, /value = 2/);
  assert.equal(JSON.parse(readFileSync(join(packageDir, 'dist/.happier-build-inputs.json'), 'utf8')).buildMode, 'qa-runtime');
  for (const [mode, extraEnv] of [['strict', {}], ['qa-runtime', { npm_lifecycle_event: 'prepack' }], ['source-dev', { npm_lifecycle_event: 'prepack' }]]) {
    await assert.rejects(build(mode, extraEnv), /TypeScript package build failed/);
    assert.equal(readFileSync(join(packageDir, 'dist/index.js'), 'utf8'), sourceDevEmitted);
  }
});

test('captured package admission uses the caller identity environment on every repeated pass', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'happier-workspace-caller-identity-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  withPatchedProcessEnv(t, { HAPPIER_STACK_REPO_DIR: root, HAPPIER_STACK_RUNTIME_IDENTITY_REPO_DIR: null });
  writePnpmWorkspaceFixture(root, { private: true, workspaces: ['apps/*', 'packages/*'] });
  for (const app of ['cli', 'ui', 'server']) {
    mkdirSync(join(root, 'apps', app), { recursive: true });
    writeFileSync(join(root, 'apps', app, 'package.json'), JSON.stringify({ name: `@fixture/${app}` }));
  }
  const dir = join(root, 'packages/example');
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src/index.ts'), 'export const value = 1;\n');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@happier-dev/example', type: 'module',
    main: './dist/index.js', types: './dist/index.d.ts', scripts: { build: 'fixture-build' } }));
  const env = { ...process.env, HAPPIER_STACK_REPO_DIR: root,
    HAPPIER_STACK_RUNTIME_IDENTITY_REPO_DIR: join(root, 'producer-origin') };
  const builds = [];
  const admit = () => ensureWorkspacePackagesBuiltByName(root, ['@happier-dev/example'], {
    buildMode: 'qa-runtime', env,
    workspaceBuildBoundary: {
      prepareEnv: async (_dir, env) => ({ ...env }),
      async runPackageBuild(packageDir, { env }) {
        builds.push(packageDir);
        writeFileSync(join(env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR, 'index.js'), readFileSync(join(packageDir, 'src/index.ts')));
        writeFileSync(join(env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR, 'index.d.ts'), 'export declare const value: number;\n');
      },
    },
  });
  await admit();
  assert.equal(isWorkspacePackageOutputCurrent(dir, { env }), true, 'public currentness uses the same caller identity as admission');
  assert.deepEqual((await admit()).built, [], 'capture and later admission must share the caller-provided producer identity');
  assert.equal(builds.length, 1);
  writeFileSync(join(dir, 'src/index.ts'), 'export const value = 2;\n');
  assert.deepEqual((await admit()).built, ['@happier-dev/example'], 'real source changes still compile');
});

test('source-dev entry points build captured inputs with coherent materialized readiness', async (t) => {
  for (const surface of ['server', 'cli', 'ui']) await t.test(surface, async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'workspace-source-dev-inputs-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    withPatchedProcessEnv(t, { HAPPIER_STACK_REPO_DIR: root, HAPPIER_STACK_RUNTIME_IDENTITY_REPO_DIR: null });
    writePnpmWorkspaceFixture(root, { workspaces: ['apps/*', 'packages/*'] });
    mkdirSync(join(root, 'packages/plugins'), { recursive: true });
    for (const app of ['cli', 'ui', 'server']) {
      mkdirSync(join(root, 'apps', app), { recursive: true });
      writeFileSync(join(root, 'apps', app, 'package.json'), JSON.stringify({ name: `@fixture/${app}`,
        dependencies: { '@happier-dev/example': 'workspace:*', ...(app === 'cli' ? { tweetnacl: '1.0.0' } : {}) },
        ...(app === 'cli' ? { bundledDependencies: ['@happier-dev/example'] } : {}),
      }));
    }
    const dir = join(root, 'packages/example');
    const runtimeDir = join(root, 'node_modules/tweetnacl');
    mkdirSync(runtimeDir, { recursive: true });
    writeFileSync(join(runtimeDir, 'package.json'), JSON.stringify({ name: 'tweetnacl', version: '1.0.0', main: 'index.js' }));
    writeFileSync(join(runtimeDir, 'index.js'), 'module.exports = "runtime";\n');
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src/index.ts'), 'export const value = "source-dev";\n');
    writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({ include: ['src/**/*.ts'] }));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@happier-dev/example', type: 'module',
      main: './dist/index.js', dependencies: { tweetnacl: '1.0.0' }, scripts: { build: 'node compile.mjs' } }));
    writeFileSync(join(dir, 'compile.mjs'), `import { mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
const output = process.env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR;
mkdirSync(output, { recursive: true });
writeFileSync(join(output, 'index.js'), 'export const value = ' + JSON.stringify(realpathSync(process.cwd()) === realpathSync(${JSON.stringify(dir)}) ? 'in-place' : 'capture') + ';\\n');
if (process.env.HAPPIER_TEST_SOURCE_DRIFT) writeFileSync(${JSON.stringify(join(dir, 'src/index.ts'))}, 'export const value = "moving' + Date.now() + '";\\n');
`);
    const native = await installWorkspaceAdmissionProcessFixture(t, root);
    const env = { ...native.env, HAPPIER_STACK_SKIP_REFRESH_DEPS: '1' };
    delete env.HAPPIER_WORKSPACE_BUILD_MODE;
    const stampPath = join(root, 'generator-stage-prep.json');
    const admit = () => surface === 'server'
      ? ensureSourceServerWorkspacePackagesBuilt({ serverDir: join(root, 'apps/server'), env })
      : surface === 'cli'
        ? syncSharedDepsForSourceDev({ repoRoot: root, workspaceNames: ['example'], env, stampPath,
          includeRuntimeDependencies: true, publishBundledPluginArtifacts: false })
        : ensureUiWorkspacePackagesBuilt({ uiPackageDir: join(root, 'apps/ui'), env,
          verifyPatchedDependencies: () => {} });
    await admit();
    if (surface === 'cli') {
      assert.equal(inspectUsableSourceDevSharedDepsLastGreen({ repoRoot: root, workspaceNames: ['example'], stampPath,
        includeRuntimeDependencies: true, requireExactOutputs: true, verifyMaterializedOutputs: true }).usable, true);
      assert.match(readFileSync(join(root, 'apps/cli/node_modules/@happier-dev/example/dist/index.js'), 'utf8'), /capture/);
      assert.match(readFileSync(join(root, 'apps/cli/node_modules/tweetnacl/index.js'), 'utf8'), /runtime/);
    }
    assert.match(readFileSync(join(dir, 'dist/index.js'), 'utf8'), /capture/);
    assert.equal(isWorkspacePackageOutputCurrent(dir), true);
    assert.equal(JSON.parse(readFileSync(join(dir, 'dist/.happier-build-inputs.json'), 'utf8')).buildMode, 'qa-runtime',
      'source-dev emit does not certify strict checking or introduce a new persisted receipt shape');
    const retained = readFileSync(join(dir, 'dist/.happier-build-inputs.json'), 'utf8');
    writeFileSync(join(dir, 'src/index.ts'), 'export const value = "moving";\n');
    env.HAPPIER_TEST_SOURCE_DRIFT = '1';
    const drifting = await admit();
    const admission = surface === 'server' ? drifting.result : drifting;
    assert.equal(admission.stalePackages?.length ?? 0, 0);
    assert.equal(isWorkspacePackageOutputCurrent(dir), false);
    assert.notEqual(JSON.parse(readFileSync(join(dir, 'dist/.happier-build-inputs.json'), 'utf8')).fingerprint,
      JSON.parse(retained).fingerprint, 'captured input replaces the prior receipt despite later producer edits');
    delete env.HAPPIER_TEST_SOURCE_DRIFT;
    writeFileSync(join(dir, 'src/index.ts'), 'export const value = "recovered";\n');
    await admit();
    assert.equal(isWorkspacePackageOutputCurrent(dir), true);
    if (surface === 'cli') assert.equal(inspectUsableSourceDevSharedDepsLastGreen({ repoRoot: root,
      workspaceNames: ['example'], stampPath, includeRuntimeDependencies: true,
      requireExactOutputs: true, verifyMaterializedOutputs: true }).usable, true);
  });
});

for (const failure of ['compiler diagnostics', 'input drift']) {
test(`source-dev cold admission recovers through server, CLI and UI owners after ${failure}`, async (t) => {
  for (const surface of ['server', 'cli', 'ui']) {
    await t.test(surface, async (t) => {
      const root = mkdtempSync(join(tmpdir(), 'happier-source-dev-last-green-'));
      t.after(() => rmSync(root, { recursive: true, force: true }));
      withPatchedProcessEnv(t, { HAPPIER_STACK_REPO_DIR: root, HAPPIER_STACK_RUNTIME_IDENTITY_REPO_DIR: null });
      writePnpmWorkspaceFixture(root, { private: true, workspaces: ['apps/*', 'packages/*'] });
      mkdirSync(join(root, 'packages/plugins'), { recursive: true });
      for (const app of ['server', 'cli', 'ui']) {
        mkdirSync(join(root, 'apps', app), { recursive: true });
        writeFileSync(join(root, 'apps', app, 'package.json'), JSON.stringify({
          name: `@fixture/${app}`, dependencies: { '@happier-dev/example': 'workspace:*' },
          ...(app === 'cli' ? { bundledDependencies: ['@happier-dev/example'] } : {}),
        }));
      }
      const dir = join(root, 'packages/example');
      mkdirSync(join(dir, 'src'), { recursive: true });
      const source = join(dir, 'src/index.ts');
      writeFileSync(source, 'export const value: string = "green";\n');
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@happier-dev/example', version: '1.0.0',
        type: 'module', main: './dist/index.js', types: './dist/index.d.ts', scripts: { build: 'node compile.mjs' } }));
      writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
        target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', rootDir: 'src', declaration: true, strict: true, types: [],
      }, include: ['src/**/*.ts'] }));
      const native = await installWorkspaceAdmissionProcessFixture(t, root);
      const selectedCompiler = resolveTypeScriptCliInvocation({ env: native.env });
      const compiler = { ...selectedCompiler, command: native.launcher ?? selectedCompiler.command };
      const driftControl = join(root, 'drift.json');
      writeFileSync(join(dir, 'compile.mjs'), `import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
const result = spawnSync(${JSON.stringify(compiler.command)}, [...${JSON.stringify(compiler.argsPrefix)}, '-p', 'tsconfig.json', '--outDir', process.env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR], { env: process.env, stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
const controlPath = ${JSON.stringify(driftControl)};
if (result.status === 0 && existsSync(controlPath)) {
  const revision = JSON.parse(readFileSync(controlPath, 'utf8')).revision + 1;
  writeFileSync(controlPath, JSON.stringify({ revision }));
  writeFileSync(${JSON.stringify(source)}, 'export const value: string = "moving' + revision + '";\\n');
}
`);
      const env = { ...native.env, HAPPIER_STACK_SKIP_REFRESH_DEPS: '1' };
      env.HAPPIER_WORKSPACE_BUILD_MODE = 'qa-runtime';
      const admit = (extraEnv = {}, publicationMode = 'live') => surface === 'server'
        ? ensureSourceServerWorkspacePackagesBuilt({ serverDir: join(root, 'apps/server'), env: { ...env, ...extraEnv } })
        : surface === 'cli'
          ? syncSharedDepsForSourceDev({ repoRoot: root, workspaceNames: ['example'], includeRuntimeDependencies: false, env: { ...env, ...extraEnv } })
          : ensureUiWorkspacePackagesBuilt({ uiPackageDir: join(root, 'apps/ui'), env: { ...env, ...extraEnv }, publicationMode,
            // Installed native dependency patches are the external installation boundary.
            verifyPatchedDependencies: () => {} });
      await ensureWorkspacePackagesBuiltByName(root, ['@happier-dev/example'], { env, buildMode: 'strict' });
      const probeService = async (expected) => {
        const modulePath = surface === 'cli'
          ? join(root, 'apps/cli/node_modules/@happier-dev/example/dist/index.js')
          : join(dir, 'dist/index.js');
        const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', `
import http from 'node:http';
const { value } = await import(${JSON.stringify(pathToFileURL(modulePath).href)});
const server = http.createServer((_req, res) => res.end(value));
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
try { process.stdout.write(await (await fetch('http://127.0.0.1:' + server.address().port)).text()); }
finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
`], { env });
        assert.equal(stdout, expected);
      };
      const cleanStarted = performance.now();
      await admit();
      await probeService('green');
      t.diagnostic(`cold ${surface} clean admission + HTTP service: ${(performance.now() - cleanStarted).toFixed(1)} ms`);
      const introduceFailure = () => {
        writeFileSync(source, failure === 'input drift'
          ? 'export const value: string = "moving";\n' : 'export const value: string = 1;\n');
        if (failure === 'input drift') writeFileSync(driftControl, JSON.stringify({ revision: 0 }));
      };
      introduceFailure();
      const started = performance.now();
      const result = await admit();
      if (failure === 'input drift') assert.equal(isWorkspacePackageOutputValid(dir, { monorepoRoot: root }), true,
        'the canonical package owner certifies the captured output before a source-dev consumer publishes it');
      await probeService(failure === 'input drift' ? 'moving' : 'green');
      t.diagnostic(`cold ${surface} QA admission + HTTP service: ${(performance.now() - started).toFixed(1)} ms`);
      const admission = surface === 'server' ? result.result : result;
      assert.equal(admission.stalePackages?.length ?? 0, failure === 'input drift' ? 0 : 1);
      if (failure === 'compiler diagnostics') assert.match(admission.stalePackages[0].diagnosticSummary, /TS2322/);
      if (failure === 'input drift') assert.equal(JSON.parse(readFileSync(driftControl, 'utf8')).revision, 1,
        'post-capture edits do not hold the package lock through another compiler pass');
      assert.equal(isWorkspacePackageOutputCurrent(dir), false);
      assert.match(readFileSync(join(dir, 'dist/index.js'), 'utf8'), failure === 'input drift' ? /moving/ : /green/);
      const storageDir = join(root, 'stack-storage');
      const stackName = `last-green-${surface}`;
      mkdirSync(join(storageDir, stackName), { recursive: true });
      writeFileSync(join(storageDir, stackName, 'env'), `HAPPIER_STACK_REPO_DIR=${root}\nHAPPIER_STACK_RUNTIME_MODE=source-dev\n`);
      const restoreEnv = withPatchedProcessEnv(t, { HAPPIER_STACK_STORAGE_DIR: storageDir });
      t.after(restoreEnv);
      const info = () => readStackInfoSnapshot({ rootDir: join(root, 'apps/stack'), stackName });
      assert.deepEqual((await info()).runtime.sourceWorkspaceStalePackages[surface], admission.stalePackages ?? []);
      if (surface === 'cli') {
        assert.match(readFileSync(join(root, 'apps/cli/node_modules/@happier-dev/example/dist/index.js'), 'utf8'), failure === 'input drift' ? /moving/ : /green/);
      }
      const reused = await admit();
      assert.deepEqual((surface === 'server' ? reused.result : reused).stalePackages ?? [], admission.stalePackages ?? [],
        'an unchanged last-green publication must still report its diagnostics');
      if (failure === 'input drift') await probeService('moving1');
      const expectedFailure = failure === 'input drift'
        ? { code: 'BUILD_INPUTS_CHANGED', trailingPassExhausted: true } : { code: 'EEXIT' };
      const strictStarted = performance.now();
      await assert.rejects(admit({ HAPPIER_WORKSPACE_BUILD_MODE: 'strict' }), expectedFailure);
      t.diagnostic(`cold ${surface} without fallback: rejected in ${(performance.now() - strictStarted).toFixed(1)} ms; no service started`);
      await assert.rejects(admit({ npm_lifecycle_event: 'prepack' }), expectedFailure);
      if (surface === 'ui') await assert.rejects(admit({ HAPPIER_WORKSPACE_BUILD_MODE: 'qa-runtime' }, 'artifact'), expectedFailure);
      if (failure === 'input drift') rmSync(driftControl);
      writeFileSync(source, 'export const value: string = "fixed";\n');
      const fixed = await admit();
      assert.equal((surface === 'server' ? fixed.result : fixed).stalePackages?.length ?? 0, 0);
      assert.match(readFileSync(join(dir, 'dist/index.js'), 'utf8'), /fixed/);
      await probeService('fixed');
      assert.deepEqual((await info()).runtime.sourceWorkspaceStalePackages[surface], []);
      assert.equal(isWorkspacePackageOutputCurrent(dir), true);
      if (failure === 'input drift') {
        writeFileSync(join(dir, 'dist/index.js'), 'damaged retained output');
        introduceFailure();
        await admit();
        await probeService('moving');
        assert.equal(isWorkspacePackageOutputValid(dir, { monorepoRoot: root }), true,
          'captured compilation repairs damaged output without admitting it as last-green');
      }
      rmSync(join(dir, 'dist'), { recursive: true, force: true });
      introduceFailure();
      if (failure === 'input drift') {
        await admit();
        await probeService('moving');
        assert.equal(isWorkspacePackageOutputCurrent(dir), false, 'cold output is labelled with the capture, not later producer edits');
      } else {
        await assert.rejects(admit(), expectedFailure);
        assert.equal(existsSync(join(dir, 'dist/index.js')), false, 'failed initial output is never adopted');
      }
    });
  }
});
}

test('workspace input identity includes excluded config files reached through extends', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'workspace-extended-inputs-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@fixture/extended' }));
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ extends: './tsconfig.tests.json' }));
  const extended = join(root, 'tsconfig.tests.json');
  writeFileSync(extended, JSON.stringify({ compilerOptions: { strict: true } }));
  const before = readWorkspacePackageInputFingerprint({ packageDir: root });
  writeFileSync(extended, JSON.stringify({ compilerOptions: { strict: false } }));
  assert.notEqual(readWorkspacePackageInputFingerprint({ packageDir: root }), before);
});

test('generated first-party plugin manifests do not invalidate compilation while authored plugin source does', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'workspace-plugin-derived-inputs-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writePnpmWorkspaceFixture(root, { workspaces: ['packages/plugins/*', 'apps/*'] });
  for (const name of ['cli', 'ui', 'server']) {
    mkdirSync(join(root, 'apps', name), { recursive: true });
    writeFileSync(join(root, 'apps', name, 'package.json'), JSON.stringify({ name: `@fixture/${name}` }));
  }
  const dir = join(root, 'packages/plugins/fixture');
  mkdirSync(join(dir, 'src'), { recursive: true });
  mkdirSync(join(dir, '.happier-plugin'));
  const manifest = join(dir, '.happier-plugin/plugin.json');
  const source = join(dir, 'src/index.ts');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@happier-dev/plugins-fixture', main: './dist/index.js', scripts: { build: 'fixture-compiler' } }));
  writeFileSync(source, 'export const runtime = 1;\n');
  writeFileSync(manifest, '{"id":"first"}');
  const sibling = join(root, 'packages/plugins/sibling');
  mkdirSync(join(sibling, 'src'), { recursive: true });
  writeFileSync(join(sibling, 'package.json'), JSON.stringify({ name: '@happier-dev/plugins-sibling', main: './dist/index.js', scripts: { build: 'fixture-compiler' } }));
  writeFileSync(join(sibling, 'src/index.ts'), 'export const runtime = "sibling";\n');
  const compiled = [];
  const decisions = [];
  const build = () => ensureWorkspacePackagesBuiltByName(root, ['@happier-dev/plugins-fixture', '@happier-dev/plugins-sibling'], {
    onPackageBuildResult: (result) => decisions.push(result),
    quiet: true, workspaceBuildBoundary: {
      prepareEnv: async (_dir, env) => ({ ...env }),
      runPackageBuild: async (packageDir, { env }) => {
        compiled.push(packageDir);
        writeFileSync(join(env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR, 'index.js'), readFileSync(join(packageDir, 'src/index.ts')));
      },
    },
  });
  await build();
  const siblingRecord = readFileSync(join(sibling, 'dist/.happier-build-inputs.json'), 'utf8');
  const before = readWorkspacePackageInputFingerprint({ packageDir: dir, includeShippedFiles: true });
  writeFileSync(manifest, '{"id":"published"}');
  await build();
  assert.equal(compiled.length, 2, 'a publisher output must not trigger plugin compilation');
  assert.notEqual(readWorkspacePackageInputFingerprint({ packageDir: dir, includeShippedFiles: true }), before,
    'runtime integrity continues observing generated manifest bytes');
  writeFileSync(source, 'export const runtime = 2;\n');
  await build();
  assert.equal(compiled.length, 3);
  assert.match(readFileSync(join(dir, 'dist/index.js'), 'utf8'), /runtime = 2/);
  assert.equal(readFileSync(join(sibling, 'dist/.happier-build-inputs.json'), 'utf8'), siblingRecord,
    'editing one plugin preserves the unchanged sibling publication');
  assert.deepEqual(decisions.filter(({ packageName }) => packageName === '@happier-dev/plugins-fixture')
    .map(({ packageName, reason, invalidation }) => ({ packageName, reason, invalidation })), [
    { packageName: '@happier-dev/plugins-fixture', reason: 'rebuilt', invalidation: 'missing-outputs' },
    { packageName: '@happier-dev/plugins-fixture', reason: 'already-built', invalidation: undefined },
    { packageName: '@happier-dev/plugins-fixture', reason: 'rebuilt', invalidation: 'inputs-changed' },
  ]);
  assert.ok(decisions.every(({ elapsedMs }) => Number.isFinite(elapsedMs) && elapsedMs >= 0));
});

test('CLI plugin preparation preserves package-owner shared failures and optional plugin isolation', async (t) => {
  for (const failedName of ['plugin-sdk', 'plugins-failed']) await t.test(failedName, async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'workspace-plugin-preparation-owner-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    writePnpmWorkspaceFixture(root, { workspaces: ['apps/*', 'packages/*', 'packages/plugins/*'] });
    for (const app of ['cli', 'ui', 'server']) {
      mkdirSync(join(root, 'apps', app), { recursive: true });
      writeFileSync(join(root, 'apps', app, 'package.json'), JSON.stringify({ name: `@fixture/${app}` }));
    }
    const dirs = new Map();
    for (const name of ['plugin-sdk', 'plugins-failed', 'plugins-healthy']) {
      const dir = join(root, 'packages', ...(name.startsWith('plugins-') ? ['plugins', name.slice('plugins-'.length)] : [name]));
      dirs.set(name, dir);
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(dir, 'src/index.ts'), 'export const value = 1;\n');
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: `@happier-dev/${name}`, main: './dist/index.js',
        dependencies: name === 'plugin-sdk' ? {} : { '@happier-dev/plugin-sdk': 'workspace:*' }, scripts: { build: 'fixture-compiler' } }));
    }
    const prepare = () => prepareBundledWorkspaceDependenciesForCli({
      repoRoot: root, workspaceNames: ['plugins-failed', 'plugins-healthy'],
      // Replace only the compiler/process adapter beneath the real package graph.
      ensureWorkspacePackagesBuiltByNameImpl: (repo, names, options) => ensureWorkspacePackagesBuiltByName(repo, names, {
        ...options, workspaceBuildBoundary: {
          prepareEnv: async (_dir, env) => ({ ...env }),
          runPackageBuild: async (dir, { env }) => {
            if (readFixturePackageName(dir) === `@happier-dev/${failedName}`) throw new Error(`compiler failed for ${failedName}`);
            writeFileSync(join(env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR, 'index.js'), 'export const value = 1;\n');
          },
        },
      }),
    });
    if (failedName === 'plugin-sdk') {
      await assert.rejects(prepare, /compiler failed for plugin-sdk/);
    } else {
      const result = await prepare();
      assert.deepEqual(result.failedPluginBuilds.map(({ packageName }) => packageName), ['@happier-dev/plugins-failed']);
      assert.equal(readFileSync(join(dirs.get('plugins-healthy'), 'dist/index.js'), 'utf8'), 'export const value = 1;\n');
      assert.equal(existsSync(join(dirs.get('plugins-failed'), 'dist/index.js')), false);
    }
  });
});

test('workspace input identity retains origin labels in a dedicated captured checkout', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'workspace-relocated-inputs-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const producer = join(root, 'producer');
  const worker = join(root, 'worker');
  for (const repo of [producer, worker]) {
    const dir = join(repo, 'packages/example');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@fixture/relocated' }));
    writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true } }));
  }
  assert.equal(readWorkspacePackageInputFingerprint({ packageDir: join(worker, 'packages/example'), identitySourceRepoDir: worker, identityRepoDir: producer }),
    readWorkspacePackageInputFingerprint({ packageDir: join(producer, 'packages/example') }));

  // Nested package captures reuse the retained worker's installed compiler.
  // Its physical path must keep the same producer identity as package inputs.
  const capture = join(root, 'package-capture');
  for (const repo of [worker, capture]) {
    mkdirSync(join(repo, 'packages/example'), { recursive: true });
    writeFileSync(join(repo, 'packages/example/package.json'), JSON.stringify({ name: '@fixture/relocated' }));
    writeFileSync(join(repo, 'packages/example/tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true } }));
    mkdirSync(join(repo, 'scripts/workspaces'), { recursive: true });
    writeFileSync(join(repo, 'scripts/workspaces/buildTypeScriptPackageDist.mjs'), 'export const build = 1;');
  }
  const compilerPath = join(worker, 'node_modules/@typescript/native/bin/tsc.js');
  mkdirSync(join(compilerPath, '..'), { recursive: true });
  writeFileSync(compilerPath, 'installed compiler');
  writeFileSync(join(compilerPath, '../../package.json'), '{"version":"fixture"}');
  const resolveTypeScriptCliInvocationImpl = () => ({ compilerPath });
  const admitted = readWorkspacePackageInputFingerprint({ packageDir: join(worker, 'packages/example'),
    identitySourceRepoDir: worker, identityRepoDir: producer, resolveTypeScriptCliInvocationImpl });
  assert.equal(readWorkspacePackageInputFingerprint({ packageDir: join(capture, 'packages/example'),
    identitySourceRepoDir: capture, identityRepoDir: producer, installedDependencyRepoDir: worker,
    resolveTypeScriptCliInvocationImpl }), admitted, 'nested capture cannot invalidate an unchanged installed compiler');
  writeFileSync(compilerPath, 'changed installed compiler');
  assert.notEqual(readWorkspacePackageInputFingerprint({ packageDir: join(capture, 'packages/example'),
    identitySourceRepoDir: capture, identityRepoDir: producer, installedDependencyRepoDir: worker,
    resolveTypeScriptCliInvocationImpl }), admitted, 'real compiler changes still invalidate captured outputs');
});

test('component startup admits intact last-green before a failed refresh, but blocks cold, damaged and strict outputs', async (t) => {
  for (const scenario of ['warm', 'cold', 'damaged', 'strict', 'dependency-advanced', 'publication-held']) {
    await t.test(scenario, { timeout: 10000 }, async (t) => {
      const root = mkdtempSync(join(tmpdir(), 'happier-startup-last-green-'));
      let publisher;
      let publisherExit;
      t.after(async () => {
        if (publisher?.connected) publisher.send('release');
        if (publisherExit) await publisherExit;
        rmSync(root, { recursive: true, force: true });
      });
      writePnpmWorkspaceFixture(root, { workspaces: ['apps/*', 'packages/*'] });
      for (const name of ['server', 'ui', 'cli']) {
        mkdirSync(join(root, 'apps', name), { recursive: true });
        writeFileSync(join(root, 'apps', name, 'package.json'), JSON.stringify({ name: `@fixture/${name}`,
          ...(scenario === 'publication-held' && name === 'server' ? { bundledDependencies: ['@happier-dev/example'] } : {}),
          dependencies: { '@happier-dev/example': 'workspace:*' } }));
      }
      const dir = join(root, 'packages/example');
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@happier-dev/example', type: 'module',
        main: './dist/index.js', scripts: { build: 'fixture-compiler' },
        ...(scenario === 'dependency-advanced' ? { dependencies: { '@happier-dev/dependency': 'workspace:*' } } : {}) }));
      const source = join(dir, 'src/index.ts');
      writeFileSync(source, 'export const value = "green";\n');
      if (scenario === 'dependency-advanced') {
        const dependencyDir = join(root, 'packages/dependency');
        mkdirSync(join(dependencyDir, 'src'), { recursive: true });
        writeFileSync(join(dependencyDir, 'src/index.ts'), 'export const dependency = "green";\n');
        writeFileSync(join(dependencyDir, 'package.json'), JSON.stringify({ name: '@happier-dev/dependency',
          type: 'module', main: './dist/index.js', scripts: { build: 'fixture-compiler' } }));
      }
      let failCompiler = false;
      const workspaceBuildBoundary = {
        prepareEnv: async (_dir, env) => ({ ...env }),
        async runPackageBuild(_dir, { env }) {
          if (failCompiler) throw new Error('fixture compiler unavailable during source edits');
          writeFileSync(join(env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR, 'index.js'), readFileSync(join(_dir, 'src/index.ts')));
        },
      };
      const componentDir = join(root, 'apps/server');
      const options = { workspaceBuildBoundary, buildMode: 'qa-runtime', quiet: true };
      if (scenario !== 'cold') await ensureWorkspacePackagesBuiltForComponent(componentDir, options);
      if (scenario === 'dependency-advanced') {
        writeFileSync(join(root, 'packages/dependency/src/index.ts'), 'export const dependency = "next";\n');
        await ensureWorkspacePackagesBuiltByName(root, ['@happier-dev/dependency'], options);
      }
      writeFileSync(source, 'export const value = "moving";\n');
      if (scenario === 'damaged') writeFileSync(join(dir, 'dist/index.js'), 'damaged');
      failCompiler = scenario !== 'publication-held';
      if (scenario === 'publication-held') {
        publisher = spawn(process.execPath, ['--input-type=module', '-e', `
          import {withWorkspaceBundleLock} from ${JSON.stringify(new URL('./workspaceBundleLock.mjs', import.meta.url).href)};
          await withWorkspaceBundleLock(async () => {
            process.send('held');
            await new Promise(resolve => process.once('message', resolve));
          }, {lockPath: ${JSON.stringify(resolveWorkspaceBundleLockPath(root))}});
          process.disconnect();
        `], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
        publisherExit = once(publisher, 'exit');
        await once(publisher, 'message');
      }
      const errors = [];
      const startup = () => ensureWorkspacePackagesBuiltForComponent(componentDir, { ...options, startup: true, signal: t.signal,
        ...(scenario === 'strict' ? { buildMode: 'strict' } : {}), logger: { warn: message => errors.push(message) } });
      if (scenario !== 'warm' && scenario !== 'publication-held') {
        await assert.rejects(startup, /fixture compiler unavailable/);
        return;
      }
      const admitted = await startup();
      assert.equal(admitted.lastGreen, true);
      if (scenario === 'publication-held') {
        assert.equal(publisher.exitCode, null, 'server output is admitted while the foreign publication lease remains held');
        let refreshed = false;
        void admitted.refresh.then(() => { refreshed = true; });
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(refreshed, false, 'only the background producer waits for publication');
        publisher.send('release');
        await publisherExit;
        await admitted.refresh;
        assert.equal(readFileSync(join(componentDir, 'node_modules/@happier-dev/example/dist/index.js'), 'utf8'), 'export const value = "moving";\n');
        assert.equal(errors.length, 0);
        return;
      }
      await assert.rejects(admitted.refresh, /fixture compiler unavailable/);
      assert.equal(errors.length, 1, 'background failure is observable without denying startup');
      assert.equal(readFileSync(join(dir, 'dist/index.js'), 'utf8'), 'export const value = "green";\n');
      failCompiler = false;
      const repaired = await ensureWorkspacePackagesBuiltForComponent(componentDir, options);
      assert.deepEqual(repaired.built, ['@happier-dev/example']);
      assert.equal(readFileSync(join(dir, 'dist/index.js'), 'utf8'), 'export const value = "moving";\n');
    });
  }
});

test('QA runtime builds use coherent last-green package outputs only for compiler diagnostics', async (t) => {
  for (const scenario of ['last-green', 'forced-last-green', 'no-output', 'strict', 'release', 'damaged', 'process-failure', 'drift', 'syntax-error']) {
    await t.test(scenario, async (t) => {
      const root = mkdtempSync(join(tmpdir(), 'happier-qa-last-green-'));
      t.after(() => rmSync(root, { recursive: true, force: true }));
      writePnpmWorkspaceFixture(root, { workspaces: ['apps/*', 'packages/*'] });
      for (const name of ['cli', 'ui', 'server']) {
        mkdirSync(join(root, 'apps', name), { recursive: true });
        writeFileSync(join(root, 'apps', name, 'package.json'), JSON.stringify({ name: `@fixture/${name}` }));
      }
      const dir = join(root, 'packages', 'example');
      mkdirSync(join(dir, 'src'), { recursive: true });
      const source = join(dir, 'src', 'index.ts');
      writeFileSync(source, `${scenario === 'forced-last-green' ? 'const unused = 1;\n' : ''}export const value: string = "green";\n`);
      writeFileSync(join(dir, 'package.json'), JSON.stringify({
        name: '@happier-dev/example', type: 'module', main: './dist/index.js', types: './dist/index.d.ts', scripts: { build: 'fixture-compiler' },
      }));
      writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
        target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', rootDir: 'src', declaration: true, strict: true, types: [],
      }, include: ['src/**/*.ts'] }));
      // This test already injects the compiler-process boundary. Execute the
      // selected real TS7 binary there; native admission belongs to the default
      // process adapter, not this intentionally in-process publisher fixture.
      const compiler = resolveTypeScriptCliInvocation({});
      const consumer = join(root, 'packages', 'consumer');
      if (scenario === 'last-green') {
        mkdirSync(join(consumer, 'src'), { recursive: true });
        writeFileSync(join(consumer, 'package.json'), JSON.stringify({ name: '@happier-dev/consumer', type: 'module', main: './dist/index.js', types: './dist/index.d.ts',
          dependencies: { '@happier-dev/example': 'workspace:*' }, scripts: { build: 'fixture-compiler' } }));
        writeFileSync(join(consumer, 'src', 'index.ts'), 'export { value } from "@happier-dev/example";\n');
        writeFileSync(join(consumer, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
          target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', rootDir: 'src', declaration: true, strict: true, types: [],
          paths: { '@happier-dev/example': ['../example/dist/index.d.ts'] },
        }, include: ['src/**/*.ts'] }));
      }
      let attempts = 0;
      let changeDuringCompile = false;
      let failForcedCompile = false;
      const workspaceBuildBoundary = {
        prepareEnv: async (_dir, env) => ({ ...env }),
        async runPackageBuild(packageDir, { env }) {
          attempts++;
          if (scenario === 'process-failure' && attempts > 1) throw Object.assign(new Error('tool could not start'), { code: 'ENOENT' });
          await run(process.execPath, [compiler.compilerPath, '-p', join(packageDir, 'tsconfig.json'), '--outDir', env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR,
            ...(failForcedCompile ? ['--noUnusedLocals'] : [])], {
            cwd: packageDir, env, captureFailureDiagnostic: true,
          });
          if (changeDuringCompile) {
            changeDuringCompile = false;
            writeFileSync(source, 'export const value: string = "settled";\n');
          }
        },
      };
      const names = [scenario === 'last-green' ? '@happier-dev/consumer' : '@happier-dev/example'];
      const build = (buildMode = 'qa-runtime', force = false) => ensureWorkspacePackagesBuiltByName(root, names, {
        quiet: true, workspaceBuildBoundary, buildMode,
        force,
        env: { ...process.env, ...(scenario === 'release' ? { npm_lifecycle_event: 'prepack' } : {}) },
      });
      if (scenario !== 'no-output') await build('strict');
      const recordPath = join(dir, 'dist', '.happier-build-inputs.json');
      const greenRecord = scenario !== 'no-output' ? JSON.parse(readFileSync(recordPath, 'utf8')) : null;
      if (scenario === 'forced-last-green') {
        failForcedCompile = true;
        const result = await build('qa-runtime', true);
        assert.equal(result.stalePackages.length, 1);
        assert.equal(isWorkspacePackageOutputCurrent(dir), false, 'failed QA output must never be certified current');
        failForcedCompile = false;
        assert.deepEqual((await build()).built, ['@happier-dev/example']);
        assert.equal(isWorkspacePackageOutputCurrent(dir), true);
        return;
      }
      if (scenario === 'damaged') writeFileSync(join(dir, 'dist', 'index.js'), 'damaged');
      writeFileSync(source, scenario === 'syntax-error' ? 'export const = ;\n'
        : scenario === 'drift' ? 'export const value: string = "moving";\n' : 'export const value: string = 1;\n');
      changeDuringCompile = scenario === 'drift';
      if (scenario === 'last-green') {
        writeFileSync(join(consumer, 'src', 'index.ts'), 'export { value } from "@happier-dev/example";\nexport const next = true;\n');
        const result = await build();
        assert.deepEqual(result.built, ['@happier-dev/consumer']);
        assert.equal(result.stalePackages.length, 1);
        assert.equal(result.stalePackages[0].packageName, '@happier-dev/example');
        assert.equal(result.stalePackages[0].lastGreenBuildRecord.fingerprint, greenRecord.fingerprint);
        assert.ok(result.stalePackages[0].lastGreenBuiltAt);
        assert.match(result.stalePackages[0].diagnosticSummary, /TS2322/);
        assert.match(readFileSync(join(dir, 'dist', 'index.js'), 'utf8'), /green/);
        assert.equal(isWorkspacePackageOutputValid(dir, { monorepoRoot: root }), true);
        assert.deepEqual(await inspectWorkspaceQaStalePackages(root, names), result.stalePackages);
        writeFileSync(join(root, 'apps', 'ui', 'package.json'), JSON.stringify({
          name: '@fixture/ui', dependencies: { '@happier-dev/consumer': 'workspace:*' },
        }));
        const runtimeRequest = (buildMode) => resolveRuntimeBuildRequestIdentity({
          rootDir: join(root, 'apps', 'stack'), producerStackBaseDir: join(root, 'runtime'),
          selection: { components: { web: true, server: false, daemon: false }, activateRuntime: true },
          sourceMetadata: { repoDir: root, serverComponent: 'happier-server-light', dbProvider: 'sqlite' },
          env: { HAPPIER_WORKSPACE_BUILD_MODE: buildMode },
        });
        const qaRequest = await runtimeRequest('qa-runtime');
        const strictRequest = await runtimeRequest('strict');
        // Request identity describes the same consumed source/toolchain inputs;
        // coherent last-green admission is already proved against the package
        // record and retained bytes above, not a removed request result field.
        assert.equal(qaRequest.artifactFingerprints.web, strictRequest.artifactFingerprints.web);
        assert.equal(qaRequest.snapshotId, strictRequest.snapshotId);
        writeFileSync(source, 'export const value: string = "fixed";\n');
        const fixed = await build();
        assert.deepEqual(fixed.built, ['@happier-dev/example']);
        assert.equal(fixed.stalePackages?.length ?? 0, 0);
        assert.equal(JSON.parse(readFileSync(recordPath, 'utf8')).qaFailure, undefined);
        const repairedRequest = await runtimeRequest('qa-runtime');
        assert.notEqual(repairedRequest.componentSourceFingerprints.web, qaRequest.componentSourceFingerprints.web);
        assert.notEqual(repairedRequest.artifactFingerprints.web, qaRequest.artifactFingerprints.web);
      } else if (scenario === 'drift') {
        const result = await build();
        assert.deepEqual(result.built, ['@happier-dev/example']);
        assert.equal(result.stalePackages?.length ?? 0, 0);
        assert.match(readFileSync(join(dir, 'dist', 'index.js'), 'utf8'), /moving/);
        assert.equal(attempts, 2, 'post-capture edits demand the next build, not a compiler retry');
      } else {
        await assert.rejects(build(scenario === 'strict' ? 'strict' : 'qa-runtime'), scenario === 'process-failure' ? /tool could not start/ : scenario === 'syntax-error' ? /TS1\d{3}/ : /TS2322/);
      }
    });
  }
});

// Exercise the SDK-owned bundler dependency at its real system boundary.
const { build: buildUiBundle } = createRequire(new URL('../../packages/plugin-sdk/package.json', import.meta.url))('esbuild');

test('Stack runtime-only refresh uses its selected package manager without entering the compiler', async (t) => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'happier-stack-workspace-refresh-'));
  t.after(() => rmSync(repoRoot, { recursive: true, force: true }));
  writePnpmWorkspaceFixture(repoRoot, { workspaces: ['apps/*', 'packages/*'] });
  for (const name of ['cli', 'ui', 'server']) {
    const dir = join(repoRoot, 'apps', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: `@fixture/${name}` }));
  }
  const dependencyDir = join(repoRoot, 'packages', 'dependency');
  const consumerDir = join(repoRoot, 'packages', 'consumer');
  for (const [name, dir] of [['dependency', dependencyDir], ['consumer', consumerDir]]) {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'index.ts'), 'export const value = "first";\n');
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: `@fixture/${name}`, type: 'module', main: './dist/index.js', types: './dist/index.d.ts',
      scripts: { build: 'fixture-build', ...(name === 'consumer' ? { 'build:ui': 'fixture-ui' } : {}) },
      ...(name === 'consumer' ? { dependencies: { '@fixture/dependency': '0.0.0' } } : {}),
    }));
  }
  const entrypointPath = join(repoRoot, 'fixture-pnpm.cjs');
  const callsPath = join(repoRoot, 'calls.jsonl');
  writeFileSync(entrypointPath, [
    "const { appendFileSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');",
    "const { join, basename } = require('node:path');",
    'const args = process.argv.slice(2);',
    "if (args.length === 1 && args[0] === '--version') process.exit(0);",
    "if (args[0] !== 'run' || args[1] !== '--silent') process.exit(91);",
    `appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify([basename(process.cwd()), args[2]]) + '\\n');`,
    'const output = process.env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR;',
    "if (args[2] === 'build') {",
    '  mkdirSync(output, { recursive: true });',
    "  writeFileSync(join(output, 'index.js'), readFileSync(join(process.cwd(), 'src', 'index.ts')));",
    "  writeFileSync(join(output, 'index.d.ts'), 'export declare const value: string;\\n');",
    '} else {',
    "  writeFileSync(join(output, 'ui.js'), readFileSync(join(process.cwd(), '..', 'dependency', 'dist', 'index.js')));",
    '}',
    "if (basename(process.cwd()) === 'consumer') {",
    "  mkdirSync(join(output, 'happier-plugin-ui'), { recursive: true });",
    "  writeFileSync(join(output, 'happier-plugin-ui', 'ui-artifacts.json'), '{\"version\":1,\"entries\":[]}\\n');",
    '}',
  ].join('\n'));
  const binDir = join(repoRoot, 'bin');
  mkdirSync(binDir);
  const pnpmCommandPath = join(binDir, process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm');
  writeFileSync(pnpmCommandPath, process.platform === 'win32'
    ? `@${JSON.stringify(process.execPath)} ${JSON.stringify(entrypointPath)} %*\r\n`
    : `#!${process.execPath}\nrequire(${JSON.stringify(entrypointPath)});\n`);
  chmodSync(pnpmCommandPath, 0o755);
  const native = await installWorkspaceAdmissionProcessFixture(t, repoRoot);
  const options = { quiet: true, env: { ...native.env, PATH: `${binDir}${delimiter}${native.env.PATH ?? ''}`, npm_execpath: '' } };
  await ensureStackWorkspacePackagesBuiltByName(repoRoot, ['@fixture/consumer'], options);
  writeFileSync(callsPath, '');
  writeFileSync(join(dependencyDir, 'src', 'index.ts'), 'export const value = "second";\n');
  const result = await ensureStackWorkspacePackagesBuiltByName(repoRoot, ['@fixture/consumer'], options);
  assert.deepEqual(result.built, ['@fixture/dependency']);
  assert.deepEqual(readFileSync(callsPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line)), [
    ['dependency', 'build'], ['consumer', 'build:ui'],
  ]);
  assert.match(readFileSync(join(consumerDir, 'dist', 'ui.js'), 'utf8'), /second/);
});

test('declaration admission refreshes embedded runtime bytes without recompiling references', async (t) => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'happier-declaration-admission-'));
  t.after(() => rmSync(repoRoot, { recursive: true, force: true }));
  writePnpmWorkspaceFixture(repoRoot, { workspaces: ['apps/*', 'packages/*'] });
  writeFileSync(join(repoRoot, 'pnpm-lock.yaml'), '# fixture\n');
  for (const app of ['cli', 'ui', 'server']) {
    const dir = join(repoRoot, 'apps', app);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: `@fixture/${app}` }));
  }
  const dirs = Object.fromEntries(['protocol', 'plugin-sdk', 'references', 'ui-bundle', 'projection'].map((name) => [name, join(repoRoot, 'packages', name)]));
  for (const [name, dir] of Object.entries(dirs)) {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'index.ts'), 'export const value: string = "first";\n');
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: `@happier-dev/${name}`, type: 'module', main: './dist/index.js', types: './dist/index.d.ts',
      dependencies: name === 'protocol' ? {} : { [`@happier-dev/${name === 'plugin-sdk' || name === 'projection' ? 'protocol' : 'plugin-sdk'}`]: '0.0.0' },
      ...(name === 'protocol' ? { exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' }, './runtime-helper': './runtime-helper.mjs' } } : {}),
      ...(name === 'plugin-sdk' ? { bundledDependencies: ['@happier-dev/protocol'] } : {}),
      scripts: { build: 'fixture-compiler', ...(name === 'ui-bundle' ? { 'build:ui': 'fixture-ui-bundler' } : {}), ...(name === 'projection' ? { prebuild: 'fixture-projection-check' } : {}) },
    }));
  }
  writeFileSync(join(dirs.protocol, 'runtime-helper.mjs'), 'export const helper = "first helper";\n');
  writeFileSync(join(dirs.protocol, 'runtime-helper.d.mts'), 'export declare const helper: string;\n');
  const compileCalls = [];
  const scripts = [];
  let failUiRefresh = false;
  const emitUi = async (dir, env) => {
    const outDir = join(env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR, 'happier-plugin-ui');
    mkdirSync(outDir, { recursive: true });
    await buildUiBundle({ entryPoints: [join(dir, '../protocol/dist/index.js')], bundle: true, format: 'cjs', outfile: join(outDir, 'entry.cjs.bundle') });
    writeFileSync(join(outDir, 'ui-artifacts.json'), '{"version":1,"entries":[]}\n');
  };
  const workspaceBuildBoundary = {
    async prepareEnv(_dir, env) { return { ...env }; },
    // Compiler/subprocess boundaries only; graph admission, publication, copies,
    // integrity and the esbuild runtime-byte consumer remain real.
    async runPackageBuild(dir, { env }) {
      const name = readFixturePackageName(dir);
      compileCalls.push(name);
      writeFileSync(join(env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR, 'index.js'), name === '@happier-dev/protocol' ? readFileSync(join(dir, 'src', 'index.ts'), 'utf8').replace(': string', '') : 'export { value } from "@happier-dev/plugin-sdk";\n');
      writeFileSync(join(env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR, 'index.d.ts'), 'export declare const value: string;\n');
      if (name === '@happier-dev/ui-bundle') await emitUi(dir, env);
    },
    async runPackageScript(dir, script, { env }) {
      scripts.push([readFixturePackageName(dir), script]);
      if (script === 'build:ui') {
        if (failUiRefresh) throw new Error('UI compiler failed');
        await emitUi(dir, env);
      }
    },
  };
  const prepare = () => ensureWorkspacePackagesBuiltByName(repoRoot, ['@happier-dev/references', '@happier-dev/ui-bundle', '@happier-dev/projection'], { workspaceBuildBoundary });
  assert.equal((await prepare()).skipped.length, 0);
  for (const name of ['references', 'ui-bundle']) {
    writeFileSync(join(dirs[name], 'dist', 'retained.js'), 'export const previousGeneration = true;\n');
  }
  compileCalls.length = 0;
  writeFileSync(join(dirs.protocol, 'src', 'index.ts'), 'export const value: string = "second";\n');
  const refreshed = await prepare();
  assert.deepEqual(compileCalls, ['@happier-dev/protocol'], 'runtime-only dependency edits must not enter dependent compilers');
  assert.deepEqual(refreshed.built, ['@happier-dev/protocol']);
  assert.match(readFileSync(join(dirs['plugin-sdk'], 'node_modules', '@happier-dev', 'protocol', 'dist', 'index.js'), 'utf8'), /second/);
  assert.match(readFileSync(join(dirs['ui-bundle'], 'dist', 'happier-plugin-ui', 'entry.cjs.bundle'), 'utf8'), /second/);
  for (const name of ['references', 'ui-bundle']) {
    const record = JSON.parse(readFileSync(join(dirs[name], 'dist', '.happier-build-inputs.json'), 'utf8'));
    assert.equal(record.files.includes('retained.js'), false, 'refresh must not certify retained live outputs as current artifacts');
    assert.equal(existsSync(join(dirs[name], 'dist', 'retained.js')), true, 'live readers keep prior outputs');
  }
  assert.deepEqual(scripts.sort(([a], [b]) => a.localeCompare(b)), [['@happier-dev/projection', 'prebuild'], ['@happier-dev/ui-bundle', 'build:ui']]);
  compileCalls.length = 0;
  scripts.length = 0;
  assert.deepEqual((await prepare()).built, []);
  assert.deepEqual(compileCalls, []);
  assert.deepEqual(scripts, [], 'unchanged runtime outputs must not rebundle or recheck projections');
  writeFileSync(join(dirs.protocol, 'runtime-helper.mjs'), 'export const helper = "second helper";\n');
  await prepare();
  assert.deepEqual(compileCalls, ['@happier-dev/protocol']);
  assert.match(readFileSync(join(dirs['plugin-sdk'], 'node_modules', '@happier-dev', 'protocol', 'runtime-helper.mjs'), 'utf8'), /second helper/);
  compileCalls.length = 0;

  const uiRecordPath = join(dirs['ui-bundle'], 'dist', '.happier-build-inputs.json');
  const uiRecord = readFileSync(uiRecordPath, 'utf8');
  writeFileSync(join(dirs.protocol, 'src', 'index.ts'), 'export const value: string = "third";\n');
  failUiRefresh = true;
  await assert.rejects(prepare(), /UI compiler failed/);
  assert.equal(readFileSync(uiRecordPath, 'utf8'), uiRecord);
  assert.match(readFileSync(join(dirs['ui-bundle'], 'dist', 'happier-plugin-ui', 'entry.cjs.bundle'), 'utf8'), /second/);
  failUiRefresh = false;
  compileCalls.length = 0;
  await prepare();
  assert.deepEqual(compileCalls, [], 'failed rebundling retries only the output phase');
  assert.match(readFileSync(join(dirs['ui-bundle'], 'dist', 'happier-plugin-ui', 'entry.cjs.bundle'), 'utf8'), /third/);

  writeFileSync(join(dirs.protocol, 'dist', 'index.d.ts'), 'export declare const value: "changed";\n');
  // A valid new declaration publication must invalidate even an indirect
  // consumer whose immediate dependency still exports the same declaration.
  const recordPath = join(dirs.protocol, 'dist', '.happier-build-inputs.json');
  const record = JSON.parse(readFileSync(recordPath, 'utf8'));
  record.outputs.find((output) => output.path === 'index.d.ts').digest = readWorkspaceBuildFileDigest(join(dirs.protocol, 'dist', 'index.d.ts'));
  writeFileSync(recordPath, JSON.stringify(record));
  await prepare();
  assert.equal(compileCalls.includes('@happier-dev/references'), true);
});

test('declaration-only packages require a current build record instead of bypassing admission', async (t) => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'happier-declaration-only-'));
  t.after(() => rmSync(repoRoot, { recursive: true, force: true }));
  writePnpmWorkspaceFixture(repoRoot, { workspaces: ['apps/*', 'packages/*'] });
  writeFileSync(join(repoRoot, 'pnpm-lock.yaml'), '# fixture\n');
  for (const app of ['cli', 'ui', 'server']) {
    const dir = join(repoRoot, 'apps', app);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: `@fixture/${app}` }));
  }
  const packageDir = join(repoRoot, 'packages', 'declarations');
  mkdirSync(join(packageDir, 'src'), { recursive: true });
  mkdirSync(join(packageDir, 'dist'), { recursive: true });
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name: '@happier-dev/declarations', types: './dist/index.d.ts', scripts: { build: 'fixture-compiler' } }));
  writeFileSync(join(packageDir, 'src', 'index.ts'), 'export interface Value { value: string }\n');
  writeFileSync(join(packageDir, 'dist', 'index.d.ts'), 'export interface Value { stale: true }\n');
  const options = { workspaceBuildBoundary: {
    async prepareEnv(_dir, env) { return { ...env }; },
    async runPackageBuild(dir, { env }) { writeFileSync(join(env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR, 'index.d.ts'), readFileSync(join(dir, 'src', 'index.ts'))); },
  } };
  assert.deepEqual((await ensureWorkspacePackagesBuiltByName(repoRoot, ['@happier-dev/declarations'], options)).built, ['@happier-dev/declarations']);
  assert.match(readFileSync(join(packageDir, 'dist', 'index.d.ts'), 'utf8'), /value: string/);
  assert.deepEqual((await ensureWorkspacePackagesBuiltByName(repoRoot, ['@happier-dev/declarations'], options)).built, []);
});

test('dependency declarations include membership, module variants and the package resolution surface', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'happier-declaration-fingerprint-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const packageDir = join(root, 'consumer');
  const dependencyDir = join(root, 'dependency');
  mkdirSync(packageDir, { recursive: true });
  mkdirSync(join(dependencyDir, 'dist', 'nested'), { recursive: true });
  writeFileSync(join(packageDir, 'package.json'), '{"name":"@fixture/consumer"}');
  const metadataPath = join(dependencyDir, 'package.json');
  writeFileSync(metadataPath, JSON.stringify({ name: '@fixture/dependency', types: './dist/index.d.ts', exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } } }));
  const declaration = join(dependencyDir, 'dist', 'index.d.ts');
  writeFileSync(declaration, 'export declare const value: string;\n');
  const fingerprint = () => readWorkspacePackageInputFingerprint({ packageDir, dependencyDirs: [dependencyDir] });
  const before = fingerprint();
  writeFileSync(join(dependencyDir, 'dist', 'index.js'), 'export const value = "changed implementation";\n');
  writeFileSync(join(dependencyDir, 'dist', 'index.d.ts.map'), 'changed declaration map\n');
  assert.equal(fingerprint(), before);
  for (const extension of ['d.mts', 'd.cts']) {
    const path = join(dependencyDir, 'dist', 'nested', `index.${extension}`);
    const previous = fingerprint();
    writeFileSync(path, 'export declare const value: number;\n');
    assert.notEqual(fingerprint(), previous);
    rmSync(path);
    assert.equal(fingerprint(), previous);
  }
  renameSync(declaration, join(dependencyDir, 'dist', 'nested', 'index.d.ts'));
  assert.notEqual(fingerprint(), before);
  rmSync(join(dependencyDir, 'dist', 'nested', 'index.d.ts'));
  assert.notEqual(fingerprint(), before);
  writeFileSync(declaration, 'export declare const value: string;\n');
  assert.equal(fingerprint(), before);
  const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
  metadata.exports['./new'] = { types: './dist/new.d.ts', default: './dist/new.js' };
  writeFileSync(metadataPath, JSON.stringify(metadata));
  assert.notEqual(fingerprint(), before);
  metadata.exports['./lease'] = './workspaceLockLease.mjs';
  writeFileSync(metadataPath, JSON.stringify(metadata));
  const beforeRootDeclaration = fingerprint();
  const rootDeclaration = join(dependencyDir, 'workspaceLockLease.d.mts');
  writeFileSync(rootDeclaration, 'export declare const lease: string;\n');
  assert.notEqual(fingerprint(), beforeRootDeclaration, 'TypeScript resolves root .mjs exports through adjacent .d.mts files');
  const afterRootDeclaration = fingerprint();
  writeFileSync(join(dependencyDir, 'workspaceLockLease.mjs'), 'export const lease = "runtime-only";\n');
  assert.equal(fingerprint(), afterRootDeclaration);
  rmSync(rootDeclaration);
  assert.equal(fingerprint(), beforeRootDeclaration);
});

test('component publication retains a valid plugin when another plugin has a missing staged export', async (t) => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'happier-plugin-isolated-publication-'));
  t.after(() => rmSync(repoRoot, { recursive: true, force: true }));
  writePnpmWorkspaceFixture(repoRoot, {
    private: true,
    workspaces: ['apps/*', 'packages/plugins/*'],
  });
  writeFileSync(join(repoRoot, 'pnpm-lock.yaml'), '# fixture\n');
  const uiDir = join(repoRoot, 'apps', 'ui');
  mkdirSync(uiDir, { recursive: true });
  for (const name of ['cli', 'server']) {
    const dir = join(repoRoot, 'apps', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: `@happier-dev/${name}` }));
  }
  writeFileSync(join(uiDir, 'package.json'), JSON.stringify({
    name: '@happier-dev/ui',
    dependencies: {
      '@happier-dev/plugins-broken': '0.0.0',
      '@happier-dev/plugins-healthy': '0.0.0',
    },
  }));
  for (const name of ['broken', 'healthy', 'codex']) {
    const dir = join(repoRoot, 'packages', 'plugins', name);
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'index.ts'), 'export const ready = true;\n');
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: `@happier-dev/plugins-${name}`,
      version: '0.0.0',
      exports: { '.': './dist/index.js' },
      scripts: { build: 'fixture-build' },
    }));
  }
  const workspaceBuildBoundary = {
      async prepareEnv(_dir, env) { return { ...env }; },
      async runPackageBuild(dir, { env }) {
        if (dir.endsWith('/healthy')) {
          writeFileSync(join(env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR, 'index.js'), 'export const ready = true;\n');
        }
      },
    };
  const result = await ensureWorkspacePackagesBuiltForComponent(uiDir, {
    workspaceBuildBoundary,
    isolatePluginFailures: true,
  });
  assert.deepEqual(result.built, ['@happier-dev/plugins-healthy']);
  assert.equal(result.pluginFailures.length, 1);
  assert.equal(result.pluginFailures[0].packageName, '@happier-dev/plugins-broken');
  assert.equal(result.pluginFailures[0].diagnostic.code, 'plugin_package_build_failed');
  assert.match(result.pluginFailures[0].diagnostic.message, /index\.js/);
  assert.equal(existsSync(join(repoRoot, 'packages', 'plugins', 'healthy', 'dist', 'index.js')), true);
  // Requiredness comes from the shared reviewed host policy, not an ad hoc
  // source scan. Codex has a real executable host edge and must remain fatal.
  writeFileSync(join(uiDir, 'package.json'), JSON.stringify({
    name: '@happier-dev/ui',
    dependencies: {
      '@happier-dev/plugins-codex': '0.0.0',
      '@happier-dev/plugins-healthy': '0.0.0',
    },
  }));
  mkdirSync(join(uiDir, 'sources'), { recursive: true });
  writeFileSync(join(uiDir, 'sources', 'required.ts'), "import '@happier-dev/plugins-codex';\n");
  await assert.rejects(
    () => ensureWorkspacePackagesBuiltForComponent(uiDir, { workspaceBuildBoundary, isolatePluginFailures: true }),
    (error) => {
      assert.match(error.message, /plugins-codex.*required by host code/u);
      assert.match(error.cause?.message, /expected staged outputs[\s\S]*index\.js/u);
      return true;
    },
  );
});

test('component builds remain strict unless a caller opts in to plugin failure projection', async (t) => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'happier-component-plugin-strict-'));
  t.after(() => rmSync(repoRoot, { recursive: true, force: true }));
  const componentDir = join(repoRoot, 'apps', 'ui');
  const pluginDir = join(repoRoot, 'packages', 'plugins', 'broken');
  mkdirSync(componentDir, { recursive: true });
  for (const name of ['cli', 'server']) {
    const dir = join(repoRoot, 'apps', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: `@happier-dev/${name}` }));
  }
  mkdirSync(join(pluginDir, 'src'), { recursive: true });
  writePnpmWorkspaceFixture(repoRoot, { workspaces: ['apps/*', 'packages/plugins/*'] });
  writeFileSync(join(repoRoot, 'pnpm-lock.yaml'), '# fixture\n');
  writeFileSync(join(componentDir, 'package.json'), JSON.stringify({
    name: '@happier-dev/ui',
    dependencies: { '@happier-dev/plugins-broken': '0.0.0' },
  }));
  writeFileSync(join(pluginDir, 'package.json'), JSON.stringify({
    name: '@happier-dev/plugins-broken',
    version: '0.0.0',
    exports: { '.': './dist/index.js' },
    scripts: { build: 'fixture-build' },
  }));
  writeFileSync(join(pluginDir, 'src', 'index.ts'), 'export const ready = true;\n');
  await assert.rejects(
    () => ensureWorkspacePackagesBuiltForComponent(componentDir, {
      workspaceBuildBoundary: {
        async prepareEnv(_dir, env) { return { ...env }; },
        async runPackageBuild() {},
      },
    }),
    /expected staged outputs[\s\S]*index\.js/u,
  );
});

test('component admission can defer bundled copies until shared preparation completes', async (t) => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'happier-component-bundled-workspace-refresh-'));
  t.after(() => rmSync(repoRoot, { recursive: true, force: true }));

  const stackDir = join(repoRoot, 'apps', 'stack');
  const protocolDir = join(repoRoot, 'packages', 'protocol');
  const bundledProtocolDir = join(
    stackDir,
    'node_modules',
    '@happier-dev',
    'protocol',
  );
  mkdirSync(join(protocolDir, 'src'), { recursive: true });
  mkdirSync(join(protocolDir, 'dist'), { recursive: true });
  mkdirSync(join(bundledProtocolDir, 'dist'), { recursive: true });
  writePnpmWorkspaceFixture(repoRoot, { private: true, workspaces: ['apps/*', 'packages/*'] });
  writeFileSync(join(repoRoot, 'pnpm-lock.yaml'), '# fixture\n', 'utf8');
  for (const appName of ['ui', 'cli', 'server']) {
    const appDir = join(repoRoot, 'apps', appName);
    mkdirSync(appDir, { recursive: true });
    writeFileSync(
      join(appDir, 'package.json'),
      JSON.stringify({ name: `@fixture/${appName}`, private: true }),
      'utf8',
    );
  }
  writeFileSync(
    join(stackDir, 'package.json'),
    JSON.stringify({
      name: '@happier-dev/stack',
      dependencies: { '@happier-dev/protocol': '0.0.0' },
      bundledDependencies: ['@happier-dev/protocol'],
    }),
    'utf8',
  );
  writeFileSync(
    join(protocolDir, 'package.json'),
    JSON.stringify({
      name: '@happier-dev/protocol',
      type: 'module',
      main: './dist/index.js',
      scripts: { build: 'fixture-build' },
    }),
    'utf8',
  );
  writeFileSync(join(protocolDir, 'src', 'index.ts'), 'export const value = "source";\n', 'utf8');
  const oldTime = new Date(Date.now() - 30_000);
  utimesSync(join(protocolDir, 'src', 'index.ts'), oldTime, oldTime);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  writeFileSync(join(protocolDir, 'dist', 'index.js'), 'export const value = "current";\n', 'utf8');
  writeFileSync(
    join(bundledProtocolDir, 'package.json'),
    JSON.stringify({ name: '@happier-dev/protocol', type: 'module', main: './dist/index.js' }),
    'utf8',
  );
  writeFileSync(
    join(bundledProtocolDir, 'dist', 'index.js'),
    'export const value = "stale";\n',
    'utf8',
  );
  await ensureWorkspacePackagesBuiltByName(repoRoot, ['@happier-dev/protocol'], {
    workspaceBuildBoundary: {
      async prepareEnv(_packageDir, env) { return { ...env }; },
      async runPackageBuild(_packageDir, { env }) {
        writeFileSync(join(env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR, 'index.js'),
          'export const value = "current";\n');
      },
    },
  });
  const result = await ensureWorkspacePackagesBuiltForComponent(stackDir, {
    quiet: true,
    deferBundledWorkspaceSync: true,
    workspaceBuildBoundary: {
      async prepareEnv(_packageDir, env) {
        return { ...env };
      },
      async runPackageBuild() {
        throw new Error('current source package output must not rebuild');
      },
    },
  });

  assert.deepEqual(result.built, []);
  assert.deepEqual(result.skipped, []);
  assert.equal(readFileSync(join(bundledProtocolDir, 'dist', 'index.js'), 'utf8'),
    'export const value = "stale";\n');
  const { syncWorkspaceComponentBundledDependencies } = await import('./ensureWorkspacePackagesBuilt.mjs');
  await syncWorkspaceComponentBundledDependencies(stackDir);
  assert.equal(
    readFileSync(join(bundledProtocolDir, 'dist', 'index.js'), 'utf8'),
    'export const value = "current";\n',
  );
});

test('component completion refreshes physical hosts once and leaves unchanged bodies untouched', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'happier-host-copy-completion-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'packages', 'protocol', 'dist'), { recursive: true });
  writePnpmWorkspaceFixture(root, { workspaces: ['apps/*', 'packages/*'] });
  writeFileSync(join(root, 'pnpm-lock.yaml'), '# fixture\n');
  const source = join(root, 'packages', 'protocol');
  for (const name of ['ui', 'server']) {
    mkdirSync(join(root, 'apps', name), { recursive: true });
    writeFileSync(join(root, 'apps', name, 'package.json'), JSON.stringify({ name: `@fixture/${name}` }));
  }
  writeFileSync(join(source, 'package.json'), JSON.stringify({
    name: '@happier-dev/protocol', version: '0.0.0', type: 'module',
    exports: { '.': './dist/index.js' },
    files: ['dist', 'resource.txt'],
    dependencies: { 'fixture-copy-runtime': '1.0.0' },
  }));
  writeFileSync(join(source, 'dist', 'index.js'), 'export { metadata } from "fixture-copy-runtime";\n');
  writeFileSync(join(source, 'resource.txt'), 'first resource\n');
  const runtime = join(source, 'node_modules', 'fixture-copy-runtime');
  mkdirSync(runtime, { recursive: true });
  writeFileSync(join(runtime, 'package.json'), JSON.stringify({
    name: 'fixture-copy-runtime', version: '1.0.0', type: 'module', main: './index.js',
  }));
  writeFileSync(join(runtime, 'index.js'), 'export const metadata = "current";\n');
  const receipt = join(source, 'dist', '.happier-build-inputs.json');
  writeFileSync(receipt, JSON.stringify({ version: 2, outputs: [], builtAt: 'before' }));
  const hosts = ['stack', 'cli'].map(name => join(root, 'apps', name));
  for (const host of hosts) {
    const bundled = join(host, 'node_modules', '@happier-dev', 'protocol');
    mkdirSync(join(bundled, 'dist'), { recursive: true });
    writeFileSync(join(host, 'package.json'), JSON.stringify({
      name: `@happier-dev/${host.split('/').at(-1)}`,
      bundledDependencies: ['@happier-dev/protocol'],
      dependencies: { '@happier-dev/protocol': '0.0.0' },
    }));
    writeFileSync(join(bundled, 'package.json'), readFileSync(join(source, 'package.json')));
    writeFileSync(join(bundled, 'dist', 'index.js'), 'export const metadata = "previous";\n');
  }
  for (const host of hosts) {
    await syncWorkspaceComponentBundledDependencies(host);
    const loaded = await promisify(execFile)(process.execPath, ['--input-type=module', '--eval',
      'process.stdout.write((await import("@happier-dev/protocol")).metadata)'], { cwd: host });
    assert.equal(loaded.stdout, 'current');
  }
  const fs = createRequire(import.meta.url)('node:fs');
  const originalCopy = fs.copyFileSync;
  const originalWrite = fs.writeFileSync;
  const originalRename = fs.renameSync;
  const originalRead = fs.readFileSync;
  let stagedBodies = 0;
  let destinationWrites = 0;
  let bodyReads = 0;
  const isHostPath = path => hosts.some(host => String(path).startsWith(join(host, 'node_modules')));
  fs.copyFileSync = (...args) => { stagedBodies += 1; return originalCopy(...args); };
  fs.writeFileSync = (...args) => { if (isHostPath(args[0])) destinationWrites += 1; return originalWrite(...args); };
  fs.renameSync = (...args) => { if (isHostPath(args[1])) destinationWrites += 1; return originalRename(...args); };
  fs.readFileSync = (...args) => {
    if (String(args[0]).startsWith(root) && String(args[0]).endsWith('index.js')) bodyReads += 1;
    return originalRead(...args);
  };
  syncBuiltinESMExports();
  const before = hosts.map(host => statSync(join(host, 'node_modules', '@happier-dev', 'protocol', 'dist', 'index.js'), { bigint: true }));
  try {
    writeFileSync(receipt, JSON.stringify({ version: 2, outputs: [], builtAt: 'after' }));
    for (let iteration = 0; iteration < 10; iteration += 1) {
      for (const host of hosts) await syncWorkspaceComponentBundledDependencies(host);
    }
  } finally {
    fs.copyFileSync = originalCopy;
    fs.writeFileSync = originalWrite;
    fs.renameSync = originalRename;
    fs.readFileSync = originalRead;
    syncBuiltinESMExports();
  }
  assert.equal(stagedBodies, 0, 'unchanged component completion must stage zero package bodies');
  assert.equal(destinationWrites, 0, 'unchanged component completion must write no destination files');
  assert.equal(bodyReads, 0, 'warm verification must reuse recorded output-body digests');
  hosts.forEach((host, index) => {
    const after = statSync(join(host, 'node_modules', '@happier-dev', 'protocol', 'dist', 'index.js'), { bigint: true });
    assert.equal(after.ino, before[index].ino);
    assert.equal(after.ctimeNs, before[index].ctimeNs);
  });
  const freshProcess = await promisify(execFile)(process.execPath, ['--input-type=module', '--eval', `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const counts = { copies: 0, writes: 0, bodyReads: 0 };
    const hosts = ${JSON.stringify(hosts)};
    const root = ${JSON.stringify(root)};
    for (const name of ['copyFileSync', 'writeFileSync', 'renameSync', 'readFileSync']) {
      const original = fs[name];
      fs[name] = (...args) => {
        if (name === 'copyFileSync') counts.copies += 1;
        if (name === 'readFileSync' && String(args[0]).startsWith(root) && String(args[0]).endsWith('index.js')) counts.bodyReads += 1;
        if ((name === 'writeFileSync' || name === 'renameSync') && hosts.some(host => String(args[name === 'renameSync' ? 1 : 0]).startsWith(host))) counts.writes += 1;
        return original(...args);
      };
    }
    syncBuiltinESMExports();
    const { syncWorkspaceComponentBundledDependencies } = await import(${JSON.stringify(new URL('./ensureWorkspacePackagesBuilt.mjs', import.meta.url).href)});
    for (const host of hosts) await syncWorkspaceComponentBundledDependencies(host);
    process.stdout.write(JSON.stringify(counts));
  `]);
  assert.deepEqual(JSON.parse(freshProcess.stdout), { copies: 0, writes: 0, bodyReads: 0 });
  for (const host of hosts) {
    const bundled = join(host, 'node_modules', '@happier-dev', 'protocol');
    rmSync(join(bundled, 'dist', 'index.js'));
    await syncWorkspaceComponentBundledDependencies(host);
    assert.equal(readFileSync(join(bundled, 'dist', 'index.js'), 'utf8'),
      'export { metadata } from "fixture-copy-runtime";\n');
    const vendorFile = join(bundled, 'node_modules', 'fixture-copy-runtime', 'index.js');
    const prior = statSync(vendorFile);
    writeFileSync(vendorFile, 'export const metadata = "corrupt";\n');
    utimesSync(vendorFile, prior.atime, prior.mtime);
    await syncWorkspaceComponentBundledDependencies(host);
    assert.equal(readFileSync(vendorFile, 'utf8'), 'export const metadata = "current";\n');
  }
  writeFileSync(join(source, 'resource.txt'), 'changed resource\n');
  writeFileSync(join(runtime, 'index.js'), 'export const metadata = "updated";\n');
  for (const host of hosts) {
    await syncWorkspaceComponentBundledDependencies(host);
    const bundled = join(host, 'node_modules', '@happier-dev', 'protocol');
    assert.equal(readFileSync(join(bundled, 'resource.txt'), 'utf8'), 'changed resource\n');
    const loaded = await promisify(execFile)(process.execPath, ['--input-type=module', '--eval',
      'process.stdout.write((await import("@happier-dev/protocol")).metadata)'], { cwd: host });
    assert.equal(loaded.stdout, 'updated');
  }
  // A producer can publish again while a live component is copying. Never
  // persist a clean-looking proof of bytes that were copied between versions.
  const firstBundleFile = join(hosts[0], 'node_modules', '@happier-dev', 'protocol', 'dist', 'index.js');
  const sourceFile = join(source, 'dist', 'index.js');
  const sourceContents = readFileSync(sourceFile, 'utf8');
  rmSync(firstBundleFile);
  let interruptedCopy = false;
  fs.copyFileSync = (...args) => {
    if (String(args[0]) !== sourceFile || interruptedCopy) return originalCopy(...args);
    interruptedCopy = true;
    writeFileSync(sourceFile, 'export const metadata = "racing";\n');
    try { return originalCopy(...args); } finally { writeFileSync(sourceFile, sourceContents); }
  };
  syncBuiltinESMExports();
  try {
    await syncWorkspaceComponentBundledDependencies(hosts[0]);
  } finally {
    fs.copyFileSync = originalCopy;
    syncBuiltinESMExports();
  }
  assert.equal(interruptedCopy, true);
  await syncWorkspaceComponentBundledDependencies(hosts[0]);
  assert.equal(readFileSync(firstBundleFile, 'utf8'), sourceContents);
  const linkedHost = join(root, 'apps', 'linked-host');
  const linkedPackage = join(linkedHost, 'node_modules', '@happier-dev', 'protocol');
  mkdirSync(join(linkedHost, 'node_modules', '@happier-dev'), { recursive: true });
  writeFileSync(join(linkedHost, 'package.json'), readFileSync(join(hosts[0], 'package.json')));
  fs.symlinkSync(source, linkedPackage, process.platform === 'win32' ? 'junction' : 'dir');
  const sourceManifest = readFileSync(join(source, 'package.json'), 'utf8');
  await syncWorkspaceComponentBundledDependencies(linkedHost);
  assert.equal(fs.lstatSync(linkedPackage).isSymbolicLink(), true);
  assert.equal(readFileSync(join(source, 'package.json'), 'utf8'), sourceManifest);
  assert.equal(existsSync(join(source, '.happier-bundle-inputs.json')), false);
  await syncWorkspaceComponentBundledDependencies(linkedHost, { publicationMode: 'artifact' });
  assert.equal(fs.lstatSync(linkedPackage).isSymbolicLink(), false,
    'explicit artifact publication must materialize a physical package');
  assert.equal(readFileSync(join(source, 'package.json'), 'utf8'), sourceManifest);
});

test('source-dev runtime preparation admits SDK outputs without deriving Action declarations', async (t) => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'happier-source-dev-action-declarations-'));
  t.after(() => rmSync(repoRoot, { recursive: true, force: true }));
  const packageDir = join(repoRoot, 'packages', 'plugin-sdk');
  const cliDir = join(repoRoot, 'apps', 'cli');
  for (const app of ['cli', 'ui', 'server']) {
    mkdirSync(join(repoRoot, 'apps', app), { recursive: true });
    writeFileSync(join(repoRoot, 'apps', app, 'package.json'), JSON.stringify({
      name: `@happier-dev/${app}`,
      ...(app === 'cli' ? { bundledDependencies: ['@happier-dev/plugin-sdk'] } : {}),
    }));
  }
  writePnpmWorkspaceFixture(repoRoot, { private: true, workspaces: ['packages/*', 'apps/*'] });
  writeFileSync(join(repoRoot, 'pnpm-lock.yaml'), '# fixture\n');
  const sdkScripts = JSON.parse(readFileSync(new URL('../../packages/plugin-sdk/package.json', import.meta.url))).scripts;
  mkdirSync(join(packageDir, 'src'), { recursive: true });
  mkdirSync(join(packageDir, 'scripts'), { recursive: true });
  mkdirSync(join(packageDir, 'dist'), { recursive: true });
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({
    name: '@happier-dev/plugin-sdk', type: 'module', main: './dist/index.js',
    scripts: {
      build: 'fixture-compiler',
      'prepare:declarations:prepared': sdkScripts['prepare:declarations:prepared'],
      'generate:action-type-map': sdkScripts['generate:action-type-map'],
    },
  }));
  writeFileSync(join(packageDir, 'tsconfig.json'), '{}\n');
  writeFileSync(join(packageDir, 'src', 'index.ts'), 'export const value = "runtime";\n');
  const outputPath = join(packageDir, 'dist', 'index.js');
  writeFileSync(outputPath, 'export const value = "runtime";\n');
  const markerPath = join(packageDir, 'derivation-invoked');
  // The generator/compiler subprocess is the system boundary. Keep package
  // currentness, source-dev admission and physical synchronization real.
  writeFileSync(join(packageDir, 'scripts', 'generateActionTypeMap.mjs'), [
    "import { writeFileSync } from 'node:fs';",
    "writeFileSync(new URL('../derivation-invoked', import.meta.url), 'invoked');",
    "throw new Error('Fixture Action derivation inputs changed');",
  ].join('\n'));
  writeFileSync(join(packageDir, 'dist', '.happier-build-inputs.json'), JSON.stringify({
    version: 2,
    fingerprint: readWorkspacePackageInputFingerprint({ packageDir }),
    outputs: [{ path: 'index.js', digest: readWorkspaceBuildFileDigest(outputPath) }],
  }));
  const options = { repoRoot, workspaceNames: ['plugin-sdk'], includeRuntimeDependencies: false };
  await assert.doesNotReject(() => syncSharedDepsForSourceDev(options));
  assert.equal(existsSync(markerPath), false, 'runtime readiness must not invoke Action derivation');
  assert.equal(readFileSync(join(cliDir, 'node_modules', '@happier-dev', 'plugin-sdk', 'dist', 'index.js'), 'utf8'),
    'export const value = "runtime";\n');
  assert.equal(inspectSourceDevSharedDepsForSourceDev(options).current, true);
  await assert.doesNotReject(() => syncSharedDepsForSourceDev(options));
  assert.equal(existsSync(markerPath), false, 'warm runtime readiness must not invoke Action derivation');
  await assert.rejects(() => runPluginSdkPreparedScript('prepare:declarations:prepared', { pluginSdkDir: packageDir }));
  assert.equal(existsSync(markerPath), true, 'declaration preparation invokes the producer and reports derivation failures');
});

test('source-dev refresh observes root UI config inputs through workspace build admission', async (t) => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'happier-source-dev-ui-config-'));
  t.after(() => rmSync(repoRoot, { recursive: true, force: true }));
  const packageDir = join(repoRoot, 'packages', 'ui-component');
  const cliDir = join(repoRoot, 'apps', 'cli');
  mkdirSync(join(packageDir, 'src'), { recursive: true });
  mkdirSync(cliDir, { recursive: true });
  for (const appName of ['ui', 'server']) {
    mkdirSync(join(repoRoot, 'apps', appName), { recursive: true });
    writeFileSync(join(repoRoot, 'apps', appName, 'package.json'), JSON.stringify({ name: `@fixture/${appName}` }));
  }
  writePnpmWorkspaceFixture(repoRoot, { private: true, workspaces: ['packages/*', 'apps/*'] });
  writeFileSync(join(repoRoot, 'pnpm-lock.yaml'), '# fixture\n');
  writeFileSync(join(cliDir, 'package.json'), JSON.stringify({
    name: '@happier-dev/cli', bundledDependencies: ['@happier-dev/ui-component'],
  }));
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({
    name: '@happier-dev/ui-component', type: 'module', main: './dist/index.js',
    scripts: { build: 'fixture compiler' },
  }));
  writeFileSync(join(packageDir, 'tsconfig.json'), '{}\n');
  writeFileSync(join(packageDir, 'src', 'index.ts'), 'export {};\n');
  const configPath = join(packageDir, 'happier-plugin-ui.config.mjs');
  writeFileSync(configPath, 'export default "first";\n');
  const workspaceBuildBoundary = {
    async prepareEnv(_packageDir, env) { return { ...env }; },
    async runPackageBuild(_packageDir, { env }) {
      writeFileSync(join(env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR, 'index.js'), readFileSync(configPath));
    },
  };
  await ensureWorkspacePackagesBuiltByName(repoRoot, ['@happier-dev/ui-component'], { workspaceBuildBoundary });
  const options = {
    repoRoot, workspaceNames: ['ui-component'], includeRuntimeDependencies: false,
    // Keep the entire shared-deps and package-build owners real; replace only
    // the compiler subprocess at the canonical package owner's OS boundary.
    ensureWorkspacePackagesBuiltByNameImpl: (root, names, buildOptions) => (
      ensureWorkspacePackagesBuiltByName(root, names, { ...buildOptions, workspaceBuildBoundary })
    ),
  };
  await syncSharedDepsForSourceDev(options);
  assert.equal(inspectSourceDevSharedDepsForSourceDev(options).current, true);
  writeFileSync(configPath, 'export default "second";\n');
  const changedAt = new Date(Math.floor(statSync(join(packageDir, 'dist', 'index.js')).mtimeMs) + 1);
  utimesSync(configPath, changedAt, changedAt);
  assert.equal(inspectSourceDevSharedDepsForSourceDev(options).current, false);
  await syncSharedDepsForSourceDev(options);
  assert.equal(readFileSync(join(cliDir, 'node_modules', '@happier-dev', 'ui-component', 'dist', 'index.js'), 'utf8'),
    'export default "second";\n');
  assert.equal(inspectSourceDevSharedDepsForSourceDev(options).current, true);
});

test('workspace build admission includes dev dependencies by default and excludes them for CLI runtime preparation', async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'happier-workspace-build-runtime-only-'));
  try {
    const pluginDir = join(repoRoot, 'packages', 'plugins', 'pi');
    const protocolDir = join(repoRoot, 'packages', 'protocol');
    const peerMediationDir = join(repoRoot, 'packages', 'peer-mediation');
    const testsDir = join(repoRoot, 'packages', 'tests');
    mkdirSync(join(pluginDir, 'src'), { recursive: true });
    for (const packageDir of [protocolDir, peerMediationDir, testsDir]) {
      mkdirSync(packageDir, { recursive: true });
    }
    writePnpmWorkspaceFixture(repoRoot, {
        private: true,
        workspaces: ['apps/*', 'packages/*', 'packages/plugins/*'],
      });
    writeFileSync(join(repoRoot, 'pnpm-lock.yaml'), '# fixture\n', 'utf8');
    for (const appName of ['ui', 'cli', 'server']) {
      const appDir = join(repoRoot, 'apps', appName);
      mkdirSync(appDir, { recursive: true });
      writeFileSync(
        join(appDir, 'package.json'),
        JSON.stringify({ name: `@fixture/${appName}`, private: true }),
        'utf8',
      );
    }
    writeFileSync(join(pluginDir, 'src', 'index.ts'), 'export const pi = true;\n', 'utf8');
    writeFileSync(join(pluginDir, 'tsconfig.json'), '{}\n', 'utf8');
    writeFileSync(
      join(pluginDir, 'package.json'),
      JSON.stringify({
        name: '@happier-dev/plugins-pi',
        type: 'module',
        exports: { '.': './dist/index.js' },
        scripts: { build: 'fixture-build' },
        optionalDependencies: { '@happier-dev/protocol': '0.0.0' },
        peerDependencies: { '@happier-dev/peer-mediation': '0.0.0' },
        devDependencies: { '@happier-dev/tests': '0.0.0' },
      }),
      'utf8',
    );
    writeFileSync(
      join(protocolDir, 'package.json'),
      JSON.stringify({
        name: '@happier-dev/protocol',
        main: './dist/index.js',
        scripts: { build: 'fixture-build' },
        dependencies: { '@happier-dev/plugins-pi': '0.0.0' },
      }),
      'utf8',
    );
    writeFileSync(
      join(peerMediationDir, 'package.json'),
      JSON.stringify({ name: '@happier-dev/peer-mediation' }),
      'utf8',
    );
    writeFileSync(
      join(testsDir, 'package.json'),
      JSON.stringify({
        name: '@happier-dev/tests',
        private: true,
        type: 'module',
        main: './dist/index.js',
        scripts: { build: 'fixture-build' },
        exports: {
          './testkit/tls/ephemeralTlsServerFixture': './src/testkit/tls/ephemeralTlsServerFixture.mjs',
        },
      }),
      'utf8',
    );

    const preparedPackages = [];
    await buildBundledWorkspaceDependenciesForCli({
      repoRoot,
      workspaceNames: ['plugins-pi'],
      ensureWorkspacePackagesBuiltByNameImpl: async (root, packageNames, options) => (
        await ensureWorkspacePackagesBuiltByName(root, packageNames, {
          ...options,
          onPackageBuildStart: async (context) => {
            preparedPackages.push(context.packageName);
            await options.onPackageBuildStart?.(context);
          },
          workspaceBuildBoundary: {
            async prepareEnv(_packageDir, env) {
              return { ...env };
            },
            async runPackageBuild(_packageDir, { env }) {
              await writeFile(join(env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR, 'index.js'), 'export const pi = true;\n');
            },
          },
        })
      ),
    });

    assert.deepEqual(preparedPackages, [
      '@happier-dev/protocol',
      '@happier-dev/plugins-pi',
    ]);

    preparedPackages.length = 0;
    await ensureWorkspacePackagesBuiltByName(
      repoRoot,
      ['@happier-dev/plugins-pi'],
      {
        force: true,
        onPackageBuildStart: async ({ packageName }) => {
          preparedPackages.push(packageName);
        },
        workspaceBuildBoundary: {
          async prepareEnv(_packageDir, env) {
            return { ...env };
          },
          async runPackageBuild(_packageDir, { env }) {
            await writeFile(join(env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR, 'index.js'), 'export const pi = true;\n');
          },
        },
      },
    );

    assert.deepEqual(preparedPackages, [
      '@happier-dev/tests',
      '@happier-dev/plugins-pi',
    ]);

    preparedPackages.length = 0;
    await ensureWorkspacePackagesBuiltByName(repoRoot, ['@happier-dev/plugins-pi'], {
      includeDevDependencies: false,
      onPackageBuildStart: async ({ packageName }) => {
        preparedPackages.push(packageName);
      },
      workspaceBuildBoundary: {
        async prepareEnv(_packageDir, env) { return { ...env }; },
        async runPackageBuild(_packageDir, { env }) {
          await writeFile(join(env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR, 'index.js'), 'export const pi = true;\n');
        },
      },
    });
    assert.deepEqual(preparedPackages, [], 'the same plugin output stays current across traversal modes');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('workspace build admission rebuilds a consumer after a dependency output changes', async (t) => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'happier-workspace-build-dependent-invalidation-'));
  t.after(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  writePnpmWorkspaceFixture(repoRoot, { private: true, workspaces: ['packages/*'] });
  writeFileSync(join(repoRoot, 'pnpm-lock.yaml'), '# fixture\n', 'utf8');
  for (const appName of ['ui', 'cli', 'server']) {
    const appDir = join(repoRoot, 'apps', appName);
    mkdirSync(appDir, { recursive: true });
    writeFileSync(
      join(appDir, 'package.json'),
      JSON.stringify({ name: `@fixture/${appName}`, private: true }),
      'utf8',
    );
  }

  const dependencyDir = join(repoRoot, 'packages', 'dependency');
  const consumerDir = join(repoRoot, 'packages', 'consumer');
  for (const [packageDir, packageJson] of [
    [dependencyDir, {
      name: '@happier-dev/dependency',
      main: './dist/index.js',
      scripts: { build: 'fixture-build' },
    }],
    [consumerDir, {
      name: '@happier-dev/consumer',
      main: './dist/index.js',
      dependencies: { '@happier-dev/dependency': '0.0.0' },
      scripts: { build: 'fixture-build' },
    }],
  ]) {
    mkdirSync(join(packageDir, 'src'), { recursive: true });
    mkdirSync(join(packageDir, 'dist'), { recursive: true });
    writeFileSync(join(packageDir, 'package.json'), JSON.stringify(packageJson), 'utf8');
    writeFileSync(join(packageDir, 'src', 'index.ts'), 'export const value = true;\n', 'utf8');
    writeFileSync(join(packageDir, 'dist', 'index.js'), 'export const value = true;\n', 'utf8');
  }

  const oldTime = new Date(Date.now() - 10_000);
  const newTime = new Date();
  for (const packageDir of [dependencyDir, consumerDir]) {
    utimesSync(join(packageDir, 'src', 'index.ts'), oldTime, oldTime);
    utimesSync(join(packageDir, 'dist', 'index.js'), newTime, newTime);
  }
  utimesSync(join(dependencyDir, 'src', 'index.ts'), new Date(Date.now() + 1_000), new Date(Date.now() + 1_000));

  const builds = [];
  await ensureWorkspacePackagesBuiltByName(repoRoot, ['@happier-dev/consumer'], {
    quiet: true,
    workspaceBuildBoundary: {
      async prepareEnv(_packageDir, env) {
        return { ...env };
      },
      async runPackageBuild(packageDir, { env }) {
        builds.push(readFixturePackageName(packageDir));
        await writeFile(join(env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR, 'index.js'), 'export const rebuilt = true;\n');
      },
    },
  });

  assert.deepEqual(builds, ['@happier-dev/dependency', '@happier-dev/consumer']);
});

test('workspace build admission publishes an admitted peer before its dependent chain', async (t) => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'happier-workspace-build-admitted-peer-order-'));
  t.after(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  writePnpmWorkspaceFixture(repoRoot, { private: true, workspaces: ['packages/*'] });
  writeFileSync(join(repoRoot, 'pnpm-lock.yaml'), '# fixture\n', 'utf8');
  for (const appName of ['ui', 'cli', 'server']) {
    const appDir = join(repoRoot, 'apps', appName);
    mkdirSync(appDir, { recursive: true });
    writeFileSync(
      join(appDir, 'package.json'),
      JSON.stringify({ name: `@fixture/${appName}`, private: true }),
      'utf8',
    );
  }

  const sdkDir = join(repoRoot, 'packages', 'plugin-sdk');
  const protocolDir = join(repoRoot, 'packages', 'channels-protocol');
  const pluginDir = join(repoRoot, 'packages', 'channels-plugin');
  for (const [packageDir, packageJson] of [
    [sdkDir, {
      name: '@happier-dev/plugin-sdk',
      main: './dist/index.js',
      scripts: { build: 'fixture-build' },
    }],
    [protocolDir, {
      name: '@happier-dev/channels-protocol',
      main: './dist/index.js',
      peerDependencies: { '@happier-dev/plugin-sdk': '>=0.0.0 <1.0.0' },
      devDependencies: { '@happier-dev/plugin-sdk': '>=0.0.0 <1.0.0' },
      scripts: { build: 'fixture-build' },
    }],
    [pluginDir, {
      name: '@happier-dev/channels-plugin',
      main: './dist/index.js',
      dependencies: {
        '@happier-dev/channels-protocol': '0.0.0',
        '@happier-dev/plugin-sdk': '0.0.0',
      },
      scripts: { build: 'fixture-build' },
    }],
  ]) {
    mkdirSync(join(packageDir, 'src'), { recursive: true });
    writeFileSync(join(packageDir, 'package.json'), JSON.stringify(packageJson), 'utf8');
    writeFileSync(join(packageDir, 'src', 'index.ts'), 'export const value = true;\n', 'utf8');
  }

  const builds = [];
  await ensureWorkspacePackagesBuiltByName(
    repoRoot,
    [
      '@happier-dev/plugin-sdk',
      '@happier-dev/channels-protocol',
      '@happier-dev/channels-plugin',
    ],
    {
      force: true,
      includeDevDependencies: false,
      maxConcurrentBuilds: 3,
      workspaceBuildBoundary: {
        async prepareEnv(_packageDir, env) {
          return { ...env };
        },
        async runPackageBuild(packageDir, { env }) {
          const packageName = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')).name;
          if (packageName === '@happier-dev/plugin-sdk') {
            await new Promise((resolvePromise) => setTimeout(resolvePromise, 30));
          }
          if (packageName === '@happier-dev/channels-protocol') {
            assert.equal(
              existsSync(join(sdkDir, 'dist', 'index.js')),
              true,
              'an admitted peer must publish before its dependent protocol compiles',
            );
          }
          if (packageName === '@happier-dev/channels-plugin') {
            assert.equal(existsSync(join(protocolDir, 'dist', 'index.js')), true);
          }
          builds.push(packageName);
          await writeFile(join(env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR, 'index.js'), 'export const built = true;\n');
        },
      },
    },
  );

  assert.deepEqual(builds, [
    '@happier-dev/plugin-sdk',
    '@happier-dev/channels-protocol',
    '@happier-dev/channels-plugin',
  ]);
});

test('workspace build admission overlaps independent packages within a bounded scheduler', async (t) => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'happier-workspace-build-parallel-siblings-'));
  t.after(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  writePnpmWorkspaceFixture(repoRoot, { private: true, workspaces: ['packages/*'] });
  writeFileSync(join(repoRoot, 'pnpm-lock.yaml'), '# fixture\n', 'utf8');
  for (const appName of ['ui', 'cli', 'server']) {
    const appDir = join(repoRoot, 'apps', appName);
    mkdirSync(appDir, { recursive: true });
    writeFileSync(
      join(appDir, 'package.json'),
      JSON.stringify({ name: `@fixture/${appName}`, private: true }),
      'utf8',
    );
  }

  const packageNames = ['@happier-dev/parallel-a', '@happier-dev/parallel-b'];
  for (const packageName of packageNames) {
    const packageDir = join(repoRoot, 'packages', packageName.split('/').at(-1));
    mkdirSync(join(packageDir, 'src'), { recursive: true });
    writeFileSync(join(packageDir, 'src', 'index.ts'), 'export const value = true;\n', 'utf8');
    writeFileSync(
      join(packageDir, 'package.json'),
      JSON.stringify({
        name: packageName,
        main: './dist/index.js',
        scripts: { build: 'fixture-build' },
      }),
      'utf8',
    );
  }

  let releaseBuilds;
  const release = new Promise((resolveRelease) => {
    releaseBuilds = resolveRelease;
  });
  let notifyBothStarted;
  const bothStarted = new Promise((resolveStarted) => {
    notifyBothStarted = resolveStarted;
  });
  const active = new Set();
  let maximumActive = 0;
  const build = ensureWorkspacePackagesBuiltByName(repoRoot, packageNames, {
    force: true,
    maxConcurrentBuilds: 2,
    workspaceBuildBoundary: {
      async prepareEnv(_packageDir, env) {
        return { ...env };
      },
      async runPackageBuild(packageDir, { env }) {
        active.add(packageDir);
        maximumActive = Math.max(maximumActive, active.size);
        if (active.size === 2) notifyBothStarted();
        await release;
        active.delete(packageDir);
        await writeFile(
          join(env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR, 'index.js'),
          'export const value = true;\n',
        );
      },
    },
  });

  const overlapped = await Promise.race([
    bothStarted.then(() => true),
    new Promise((resolveTimeout) => setTimeout(() => resolveTimeout(false), 2_000)),
  ]);
  releaseBuilds();
  await build;

  assert.equal(overlapped, true);
  assert.equal(maximumActive, 2);
});

test('workspace build admission queues bundled siblings before they enter the shared publication lock', async (t) => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'happier-workspace-build-bundled-siblings-'));
  t.after(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  writePnpmWorkspaceFixture(repoRoot, { private: true, workspaces: ['packages/*'] });
  writeFileSync(join(repoRoot, 'pnpm-lock.yaml'), '# fixture\n', 'utf8');
  for (const appName of ['ui', 'cli', 'server']) {
    const appDir = join(repoRoot, 'apps', appName);
    mkdirSync(appDir, { recursive: true });
    writeFileSync(
      join(appDir, 'package.json'),
      JSON.stringify({ name: `@fixture/${appName}`, private: true }),
      'utf8',
    );
  }

  const dependencyDir = join(repoRoot, 'packages', 'dependency');
  const hostPackageNames = ['@happier-dev/bundled-a', '@happier-dev/bundled-b'];
  const hostPackageDirs = hostPackageNames.map((packageName) => (
    join(repoRoot, 'packages', packageName.split('/').at(-1))
  ));
  const workspaceBundleLockPath = resolveWorkspaceBundleLockPath(repoRoot);
  const bundledDependencyName = '@happier-dev/dependency';
  const dependencySourcePath = join(dependencyDir, 'src', 'index.ts');
  const dependencyDistPath = join(dependencyDir, 'dist', 'index.js');

  mkdirSync(join(dependencyDir, 'src'), { recursive: true });
  mkdirSync(join(dependencyDir, 'dist'), { recursive: true });
  writeFileSync(dependencySourcePath, 'export const value = true;\n', 'utf8');
  writeFileSync(dependencyDistPath, 'export const value = true;\n', 'utf8');
  writeFileSync(
    join(dependencyDir, 'package.json'),
    JSON.stringify({
      name: bundledDependencyName,
      main: './dist/index.js',
      scripts: { build: 'fixture-build' },
    }),
    'utf8',
  );
  const oldTime = new Date(Date.now() - 10_000);
  const currentTime = new Date();
  utimesSync(dependencySourcePath, oldTime, oldTime);
  utimesSync(dependencyDistPath, currentTime, currentTime);

  for (const [index, packageDir] of hostPackageDirs.entries()) {
    mkdirSync(join(packageDir, 'src'), { recursive: true });
    writeFileSync(join(packageDir, 'src', 'index.ts'), `export const host${index} = true;\n`, 'utf8');
    writeFileSync(
      join(packageDir, 'package.json'),
      JSON.stringify({
        name: hostPackageNames[index],
        main: './dist/index.js',
        dependencies: { [bundledDependencyName]: '0.0.0' },
        bundledDependencies: [bundledDependencyName],
        scripts: { build: 'fixture-build' },
      }),
      'utf8',
    );
  }

  let releaseFirstBuild;
  const firstBuildRelease = new Promise((resolveRelease) => {
    releaseFirstBuild = resolveRelease;
  });
  let notifyFirstBuildStarted;
  const firstBuildStarted = new Promise((resolveStarted) => {
    notifyFirstBuildStarted = resolveStarted;
  });
  let hostBuildCount = 0;
  const build = ensureWorkspacePackagesBuiltByName(repoRoot, hostPackageNames, {
    force: true,
    quiet: true,
    maxConcurrentBuilds: 2,
    workspaceBuildBoundary: {
      async prepareEnv(_packageDir, env) {
        return { ...env };
      },
      async runPackageBuild(packageDir, { env }) {
        if (hostPackageNames.includes(readFixturePackageName(packageDir))) {
          hostBuildCount += 1;
          if (hostBuildCount === 1) {
            notifyFirstBuildStarted();
            await firstBuildRelease;
          }
        }
        await writeFile(
          join(env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR, 'index.js'),
          'export const value = true;\n',
        );
      },
    },
  });

  const started = await Promise.race([
    firstBuildStarted.then(() => true),
    new Promise((resolveTimeout) => setTimeout(() => resolveTimeout(false), 2_000)),
  ]);
  let siblingEnteredBundleLockWait = false;
  if (started) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (existsSync(`${workspaceBundleLockPath}.priority-claim`)) {
        siblingEnteredBundleLockWait = true;
        break;
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
  }
  releaseFirstBuild();
  await build;

  assert.equal(started, true, 'expected the first bundled package build to start');
  assert.equal(hostBuildCount, 2, 'expected both bundled siblings to build');
  assert.equal(
    siblingEnteredBundleLockWait,
    false,
    'a bundled sibling must queue before it attempts the shared publication lock',
  );
});

test('unchanged workspace package admission preserves the published dist directory', async (t) => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'happier-workspace-build-unchanged-admission-'));
  t.after(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  writePnpmWorkspaceFixture(repoRoot, { private: true, workspaces: ['packages/*'] });
  writeFileSync(join(repoRoot, 'pnpm-lock.yaml'), '# fixture\n', 'utf8');
  for (const appName of ['ui', 'cli', 'server']) {
    const appDir = join(repoRoot, 'apps', appName);
    mkdirSync(appDir, { recursive: true });
    writeFileSync(
      join(appDir, 'package.json'),
      JSON.stringify({ name: `@fixture/${appName}`, private: true }),
      'utf8',
    );
  }

  const packageDir = join(repoRoot, 'packages', 'unchanged');
  mkdirSync(join(packageDir, 'src'), { recursive: true });
  mkdirSync(join(packageDir, 'dist'), { recursive: true });
  writeFileSync(join(packageDir, 'src', 'index.ts'), 'export const value = true;\n', 'utf8');
  writeFileSync(join(packageDir, 'dist', 'index.js'), 'export const value = true;\n', 'utf8');
  writeFileSync(
    join(packageDir, 'package.json'),
    JSON.stringify({
      name: '@happier-dev/unchanged',
      main: './dist/index.js',
      scripts: { build: 'fixture-build' },
    }),
    'utf8',
  );
  let buildCalls = 0;
  const workspaceBuildBoundary = {
      async prepareEnv(_packageDir, env) {
        return { ...env };
      },
      async runPackageBuild(_packageDir, { env }) {
        buildCalls += 1;
        mkdirSync(env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR, { recursive: true });
        writeFileSync(join(env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR, 'index.js'), 'export const value = true;\n');
      },
  };
  await ensureWorkspacePackagesBuiltByName(repoRoot, ['@happier-dev/unchanged'], {
    workspaceBuildBoundary,
  });
  const before = statSync(join(packageDir, 'dist'));
  const result = await ensureWorkspacePackagesBuiltByName(repoRoot, ['@happier-dev/unchanged'], {
    workspaceBuildBoundary,
  });

  const after = statSync(join(packageDir, 'dist'));
  assert.deepEqual(result.built, []);
  assert.equal(buildCalls, 1);
  assert.equal(after.ino, before.ino);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal(await readFile(join(packageDir, 'dist', 'index.js'), 'utf8'), 'export const value = true;\n');
});

test('fresh-process publisher verifies final output identities without hashing unchanged output bodies', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'happier-workspace-output-proof-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writePnpmWorkspaceFixture(root, { private: true, workspaces: ['packages/*'] });
  writeFileSync(join(root, 'pnpm-lock.yaml'), '# fixture\n');
  for (const app of ['cli', 'ui', 'server']) {
    mkdirSync(join(root, 'apps', app), { recursive: true });
    writeFileSync(join(root, 'apps', app, 'package.json'), JSON.stringify({ name: `@fixture/${app}` }));
  }
  const names = ['producer', 'consumer', 'unrelated'];
  for (const name of names) {
    const dir = join(root, 'packages', name);
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src/index.ts'), 'export const value = 1;\n');
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: `@fixture/${name}`, type: 'module',
      main: './dist/index.js', types: './dist/index.d.ts', scripts: { build: 'fixture-compiler' },
      ...(name === 'consumer' ? { dependencies: { '@fixture/producer': 'workspace:*' } } : {}) }));
  }
  // Fresh processes discard the digest helper's in-memory cache. Instrument
  // only filesystem/process boundaries; all freshness and publication is real.
  const ownerUrl = new URL('./ensureWorkspacePackagesBuilt.mjs', import.meta.url).href;
  const code = `
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import {join, sep} from 'node:path';
import {syncBuiltinESMExports} from 'node:module';
const {ensureWorkspacePackagesBuiltByName} = await import(${JSON.stringify(ownerUrl)});
const root = process.argv[1];
const outputRoot = root.split(sep).join('/');
const builds = [];
let outputBodyBytes = 0, outputBodyReads = 0, outputStats = 0;
const read = fs.readFileSync;
fs.readFileSync = (...args) => {
  const value = read(...args);
  const path = String(args[0]).split(sep).join('/');
  if (path.startsWith(outputRoot + '/') && !path.endsWith('/.happier-build-inputs.json')
    && (path.includes('/dist/') || path.includes('/.tmp.'))) {
    outputBodyReads++; outputBodyBytes += Buffer.byteLength(value);
  }
  return value;
};
for (const method of ['lstatSync', 'statSync']) {
  const original = fs[method];
  fs[method] = (...args) => {
    const path = String(args[0]).split(sep).join('/');
    if (path.startsWith(outputRoot + '/') && path.includes('/dist')) outputStats++;
    return original(...args);
  };
}
const rename = fsPromises.rename;
let rejectFinalRecord = process.argv[2] === 'fail-final-record';
fsPromises.rename = async (...args) => {
  if (rejectFinalRecord && args[1] === join(root, 'packages/producer/dist/.happier-build-inputs.json')) {
    rejectFinalRecord = false;
    throw Object.assign(new Error('fixture final publication failure'), {code:'EIO'});
  }
  return await rename(...args);
};
const renameSync = fs.renameSync;
let rejectMountedOutput = process.argv[2] === 'fail-mounted-output';
fs.renameSync = (...args) => {
  if (rejectMountedOutput && args[1] === join(root, 'packages/producer/dist/index.js')) {
    rejectMountedOutput = false;
    throw Object.assign(new Error('fixture mounted publication failure'), {code:'EIO'});
  }
  return renameSync(...args);
};
syncBuiltinESMExports();
const workspaceBuildBoundary = {
  prepareEnv: async (_dir, env) => ({...env}),
  async runPackageBuild(dir, {env}) {
    builds.push(JSON.parse(read(join(dir, 'package.json'))).name);
    fs.mkdirSync(env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR, {recursive:true});
    fs.writeFileSync(join(env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR, 'index.js'), read(join(dir, 'src/index.ts')));
    fs.writeFileSync(join(env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR, 'index.d.ts'), read(join(dir, 'src/index.ts'), 'utf8').includes('value = "')
      ? 'export declare const value: string;\\n' : 'export declare const value: number;\\n');
    if (process.argv[2] === 'cancel') {
      process.kill(process.pid, 'SIGINT');
      await new Promise(() => {});
    }
    if (process.argv[2] === 'fail') throw new Error('fixture publication failure');
  }
};
try {
  const result = await ensureWorkspacePackagesBuiltByName(root, ['@fixture/consumer', '@fixture/unrelated'], {
    workspaceBuildBoundary, buildMode:'strict', env:{...process.env, HAPPIER_STACK_REPO_DIR:root,
      HAPPIER_STACK_RUNTIME_IDENTITY_REPO_DIR:''}
  });
  console.log(JSON.stringify({built:result.built, builds, outputBodyBytes, outputBodyReads, outputStats}));
} catch (error) { console.log(JSON.stringify({error:error.message, builds, outputBodyBytes, outputBodyReads, outputStats})); }
`;
  const runFresh = async (failure = '') => {
    const { stdout } = await promisify(execFile)(process.execPath,
      ['--experimental-strip-types', '--input-type=module', '--eval', code, root, failure], { maxBuffer: 1024 * 1024 });
    return JSON.parse(stdout.trim());
  };
  const producerDir = join(root, 'packages/producer');
  const outputPath = join(producerDir, 'dist/index.js');
  const recordPath = join(producerDir, 'dist/.happier-build-inputs.json');
  const cold = await runFresh();
  assert.equal(cold.error, undefined, `cold publisher failed: ${cold.error}`);
  assert.deepEqual(cold.built, ['@fixture/consumer', '@fixture/producer', '@fixture/unrelated']);
  assert.ok(cold.outputBodyBytes > 0);
  const warm = await runFresh();
  assert.deepEqual(warm.built, []);
  assert.deepEqual(warm.builds, []);
  assert.equal(warm.outputBodyBytes, 0, 'unchanged outputs must not be rehashed in a fresh process');
  assert.ok(warm.outputStats > 0, 'warm admission still verifies live file identity');
  const record = JSON.parse(readFileSync(recordPath));
  for (const output of record.outputs) {
    const stat = statSync(join(producerDir, 'dist', output.path), { bigint: true });
    assert.deepEqual(output.verification, Object.fromEntries(
      ['size', 'dev', 'ino', 'mtimeNs', 'ctimeNs'].map(key => [key, String(stat[key])])));
  }
  writeFileSync(recordPath, JSON.stringify({ ...record,
    outputs: record.outputs.map(({ verification, ...output }) => output) }));
  const migrated = await runFresh();
  assert.deepEqual(migrated.built, []);
  assert.ok(migrated.outputBodyBytes > 0, 'older records verify content before gaining worker-local proof');
  assert.equal((await runFresh()).outputBodyBytes, 0, 'older record migration is persisted under the existing lease');
  const retainedDeclaration = join(producerDir, 'dist/retained.d.ts');
  writeFileSync(retainedDeclaration, 'export declare const retained: number;\n');
  assert.deepEqual((await runFresh()).built, ['@fixture/consumer'], 'retained declaration additions remain visible to consumers');
  assert.equal((await runFresh()).outputBodyBytes, 0, 'retained live outputs also gain worker-local proof');
  writeFileSync(retainedDeclaration, 'export declare const retained: string;\n');
  assert.deepEqual((await runFresh()).built, ['@fixture/consumer'], 'retained declaration edits still invalidate consumers');
  rmSync(retainedDeclaration);
  assert.deepEqual((await runFresh()).built, ['@fixture/consumer'], 'retained declaration removal remains semantic change');
  assert.equal((await runFresh()).outputBodyBytes, 0);
  writeFileSync(join(producerDir, 'src/index.ts'), 'export const value = 2;\n');
  assert.deepEqual((await runFresh()).built, ['@fixture/producer'], 'equal declarations do not re-emit dependents');
  writeFileSync(join(producerDir, 'src/index.ts'), 'export const value = "changed";\n');
  assert.deepEqual((await runFresh()).built, ['@fixture/consumer', '@fixture/producer']);

  const beforeRewrite = statSync(outputPath);
  const originalOutput = readFileSync(outputPath, 'utf8');
  writeFileSync(outputPath, originalOutput.replace('changed', 'damaged'));
  utimesSync(outputPath, beforeRewrite.atime, beforeRewrite.mtime);
  assert.deepEqual((await runFresh()).built, ['@fixture/producer'], 'ctime detects same-size restored-mtime corruption');
  const replacement = join(producerDir, 'replacement.js');
  writeFileSync(replacement, readFileSync(outputPath, 'utf8').replace('changed', 'invalid'));
  renameSync(replacement, outputPath);
  assert.deepEqual((await runFresh()).built, ['@fixture/producer'], 'inode replacement cannot reuse the old proof');
  rmSync(join(producerDir, 'dist/index.d.ts'));
  assert.deepEqual((await runFresh()).built, ['@fixture/producer'], 'missing output is repaired');
  const distDir = join(producerDir, 'dist');
  const copiedDir = join(producerDir, 'copied-dist');
  cpSync(distDir, copiedDir, { recursive: true, preserveTimestamps: true });
  rmSync(distDir, { recursive: true });
  renameSync(copiedDir, distDir);
  const copied = await runFresh();
  assert.deepEqual(copied.built, []);
  assert.ok(copied.outputBodyBytes > 0, 'copied files require content verification before proof reuse');
  assert.equal((await runFresh()).outputBodyBytes, 0, 'copied files are verified once under the publication lease');
  // A changed declaration inventory must affect the consuming fingerprint.
  writeFileSync(join(distDir, 'added.d.ts'), 'export declare const added: boolean;\n');
  assert.deepEqual((await runFresh()).built, ['@fixture/consumer']);
  const priorRecord = readFileSync(recordPath, 'utf8');
  const priorOutput = readFileSync(outputPath, 'utf8');
  writeFileSync(join(producerDir, 'src/index.ts'), 'export const value = "failure";\n');
  assert.match((await runFresh('fail')).error, /fixture publication failure/);
  assert.equal(readFileSync(recordPath, 'utf8'), priorRecord);
  assert.equal(readFileSync(outputPath, 'utf8'), priorOutput);
  await assert.rejects(runFresh('cancel'), error => error.signal === 'SIGINT');
  assert.equal(readFileSync(recordPath, 'utf8'), priorRecord, 'cancelled staging cannot publish a new proof');
  assert.equal(readFileSync(outputPath, 'utf8'), priorOutput, 'cancelled staging preserves live bytes');
  assert.match((await runFresh('fail-mounted-output')).error, /fixture mounted publication failure/);
  assert.equal(readFileSync(recordPath, 'utf8'), priorRecord, 'failed mounted publication restores the coherent record');
  assert.equal(readFileSync(outputPath, 'utf8'), priorOutput, 'failed mounted publication restores the prior usable output');
  await runFresh();
  writeFileSync(join(producerDir, 'src/index.ts'), 'export const value = "final";\n');
  assert.match((await runFresh('fail-final-record')).error, /fixture final publication failure/);
  assert.ok(JSON.parse(readFileSync(recordPath)).outputs.every(output => !output.verification),
    'failed final publication leaves no clean-looking staged inode proof');
  assert.deepEqual((await runFresh()).built, [], 'the existing lease verifies and repairs the unproven record without re-emitting');
  assert.equal((await runFresh()).outputBodyBytes, 0);
  t.diagnostic(JSON.stringify({cold, warm, copied}));
});

test('a restored output tree in a fresh checkout is reused by content and rebuilt only where it differs', async (t) => {
  // The v0.3 Gate restores package dists from an earlier run into a fresh
  // checkout at the same path: every source and output file has a new inode,
  // ctime and source mtime, so reuse must follow recorded content alone.
  const parent = mkdtempSync(join(tmpdir(), 'happier-workspace-restored-outputs-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const repoRoot = join(parent, 'checkout');
  const checkOut = (consumerSource = 'export const consumer = 1;\n') => {
    rmSync(repoRoot, { recursive: true, force: true });
    mkdirSync(repoRoot);
    writePnpmWorkspaceFixture(repoRoot, { private: true, workspaces: ['packages/*'] });
    writeFileSync(join(repoRoot, 'pnpm-lock.yaml'), '# fixture\n');
    for (const appName of ['ui', 'cli', 'server']) {
      mkdirSync(join(repoRoot, 'apps', appName), { recursive: true });
      writeFileSync(join(repoRoot, 'apps', appName, 'package.json'), JSON.stringify({ name: `@fixture/${appName}` }));
    }
    for (const [name, source, dependencies] of [
      ['base', 'export const base = 1;\n', {}],
      ['consumer', consumerSource, { '@happier-dev/base': 'workspace:*' }],
    ]) {
      mkdirSync(join(repoRoot, 'packages', name, 'src'), { recursive: true });
      writeFileSync(join(repoRoot, 'packages', name, 'package.json'), JSON.stringify({
        name: `@happier-dev/${name}`, type: 'module', main: './dist/index.js', types: './dist/index.d.ts',
        dependencies, scripts: { build: 'fixture-build' },
      }));
      writeFileSync(join(repoRoot, 'packages', name, 'src', 'index.ts'), source);
    }
  };
  const builds = [];
  const workspaceBuildBoundary = {
    async prepareEnv(_packageDir, env) { return { ...env }; },
    // The compiler is the process boundary; graph, fingerprints and publication stay real.
    async runPackageBuild(buildDir, { env }) {
      builds.push(JSON.parse(readFileSync(join(buildDir, 'package.json'), 'utf8')).name);
      const source = readFileSync(join(buildDir, 'src', 'index.ts'), 'utf8');
      writeFileSync(join(env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR, 'index.js'), source);
      writeFileSync(join(env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR, 'index.d.ts'), source.replace('= 1;', ': number;'));
    },
  };
  const build = async () => {
    builds.length = 0;
    const result = await ensureWorkspacePackagesBuiltByName(repoRoot, ['@happier-dev/consumer'], { workspaceBuildBoundary, quiet: true });
    return { built: [...result.built].sort(), compiled: [...builds].sort() };
  };
  const cache = join(parent, 'cache');
  const saveDists = () => {
    rmSync(cache, { recursive: true, force: true });
    for (const name of ['base', 'consumer']) {
      cpSync(join(repoRoot, 'packages', name, 'dist'), join(cache, name), { recursive: true, preserveTimestamps: true });
    }
  };
  const restoreDists = () => {
    for (const name of ['base', 'consumer']) {
      cpSync(join(cache, name), join(repoRoot, 'packages', name, 'dist'), { recursive: true, preserveTimestamps: true });
    }
  };

  checkOut();
  assert.deepEqual(await build(), { built: ['@happier-dev/base', '@happier-dev/consumer'], compiled: ['@happier-dev/base', '@happier-dev/consumer'] });
  saveDists();
  const restoredInode = statSync(join(cache, 'consumer', 'index.js')).ino;

  checkOut();
  restoreDists();
  assert.notEqual(statSync(join(repoRoot, 'packages', 'consumer', 'dist', 'index.js')).ino, restoredInode);
  assert.deepEqual(await build(), { built: [], compiled: [] });

  // A changed input rebuilds only its package over the restored tree.
  checkOut('export const consumer = 1;\nexport const added = 1;\n');
  restoreDists();
  assert.deepEqual(await build(), { built: ['@happier-dev/consumer'], compiled: ['@happier-dev/consumer'] });

  // A partial or damaged restore rebuilds the package it damaged.
  checkOut();
  restoreDists();
  rmSync(join(repoRoot, 'packages', 'base', 'dist', 'index.d.ts'));
  writeFileSync(join(repoRoot, 'packages', 'consumer', 'dist', 'index.js'), 'export const consumer = 0;\n');
  const damaged = await build();
  assert.deepEqual(damaged.compiled, ['@happier-dev/base', '@happier-dev/consumer']);
  assert.equal(readFileSync(join(repoRoot, 'packages', 'consumer', 'dist', 'index.js'), 'utf8'), 'export const consumer = 1;\n');
});

test('package admission follows source content and membership rather than timestamps', async (t) => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'happier-workspace-content-currentness-'));
  t.after(() => rmSync(repoRoot, { recursive: true, force: true }));
  writePnpmWorkspaceFixture(repoRoot, { private: true, workspaces: ['packages/*'] });
  writeFileSync(join(repoRoot, 'pnpm-lock.yaml'), '# fixture\n');
  for (const appName of ['ui', 'cli', 'server']) {
    const appDir = join(repoRoot, 'apps', appName);
    mkdirSync(appDir, { recursive: true });
    writeFileSync(join(appDir, 'package.json'), JSON.stringify({ name: `@fixture/${appName}` }));
  }
  const packageDir = join(repoRoot, 'packages', 'content');
  const sourceDir = join(packageDir, 'src');
  mkdirSync(sourceDir, { recursive: true });
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({
    name: '@happier-dev/content', type: 'module', main: './dist/index.js',
    scripts: { build: 'fixture-build ./build-input.ts' },
  }));
  writeFileSync(join(packageDir, 'tsconfig.json'), '{}\n');
  const buildScriptPath = join(packageDir, 'build-input.ts');
  writeFileSync(buildScriptPath, 'export const buildMode = 1;\n');
  const sourcePath = join(sourceDir, 'index.ts');
  const deletedPath = join(sourceDir, 'removed.ts');
  writeFileSync(sourcePath, 'export const value = 1;\n');
  writeFileSync(deletedPath, 'export const removed = true;\n');
  let buildCalls = 0;
  const workspaceBuildBoundary = {
    async prepareEnv(_packageDir, env) { return { ...env }; },
    async runPackageBuild(buildDir, { env }) {
      buildCalls += 1;
      assert.equal(readFileSync(join(buildDir, 'build-input.ts'), 'utf8'), readFileSync(buildScriptPath, 'utf8'),
        'the referenced build script must be present in the admitted compiler inputs');
      writeFileSync(join(env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR, 'index.js'), readFileSync(join(buildDir, 'src/index.ts')));
    },
  };
  const build = () => ensureWorkspacePackagesBuiltByName(repoRoot, ['@happier-dev/content'], {
    workspaceBuildBoundary, buildMode: 'source-dev',
  });
  assert.deepEqual((await build()).built, ['@happier-dev/content']);
  assert.deepEqual((await build()).built, []);
  assert.equal(buildCalls, 1);

  const priorTime = new Date(Date.now() - 60_000);
  writeFileSync(sourcePath, 'export const value = 2;\n');
  utimesSync(sourcePath, priorTime, priorTime);
  assert.deepEqual((await build()).built, ['@happier-dev/content']);
  rmSync(deletedPath);
  assert.deepEqual((await build()).built, ['@happier-dev/content']);
  writeFileSync(buildScriptPath, 'export const buildMode = 2;\n');
  assert.deepEqual((await build()).built, ['@happier-dev/content']);
  writeFileSync(join(packageDir, 'tsconfig.json'), '{"compilerOptions":{"strict":true}}\n');
  assert.deepEqual((await build()).built, ['@happier-dev/content']);
  const pluginManifestPath = join(packageDir, '.happier-plugin', 'plugin.json');
  mkdirSync(join(pluginManifestPath, '..'), { recursive: true });
  writeFileSync(pluginManifestPath, '{"id":"first"}\n');
  assert.deepEqual((await build()).built, ['@happier-dev/content']);
  writeFileSync(pluginManifestPath, '{"id":"second"}\n');
  assert.deepEqual((await build()).built, ['@happier-dev/content']);
  const hostedWebPath = join(packageDir, '.happier-plugin', 'ui', 'hosted-web', 'card', 'index.html');
  mkdirSync(join(hostedWebPath, '..'), { recursive: true });
  writeFileSync(hostedWebPath, '<div>first</div>\n');
  assert.deepEqual((await build()).built, ['@happier-dev/content']);
  writeFileSync(hostedWebPath, '<div>second</div>\n');
  assert.deepEqual((await build()).built, ['@happier-dev/content']);
  writeFileSync(join(packageDir, 'dist', 'index.js'), 'export const value = 0;\n');
  assert.deepEqual((await build()).built, ['@happier-dev/content']);
  assert.deepEqual((await build()).built, []);
  const recordPath = join(packageDir, 'dist', '.happier-build-inputs.json');
  const record = JSON.parse(readFileSync(recordPath, 'utf8'));
  writeFileSync(recordPath, JSON.stringify({ ...record, outputs: [] }));
  assert.deepEqual((await build()).built, ['@happier-dev/content']);
  assert.equal(buildCalls, 11);
});

test('non-strict workspace builds publish captured inputs despite edits during compilation; strict retains its fence', async t => {
  for (const buildMode of ['qa-runtime', 'source-dev', 'strict']) await t.test(buildMode, async t => {
    const root = mkdtempSync(join(tmpdir(), 'workspace-captured-build-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    writePnpmWorkspaceFixture(root, { workspaces: ['packages/*'] });
    for (const app of ['cli', 'ui', 'server']) {
      mkdirSync(join(root, 'apps', app), { recursive: true });
      writeFileSync(join(root, 'apps', app, 'package.json'), JSON.stringify({ name: `@fixture/${app}` }));
    }
    const dir = join(root, 'packages/moving');
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@happier-dev/moving', main: './dist/index.js', scripts: { build: 'fixture-compiler' } }));
    const source = join(dir, 'src/index.ts');
    writeFileSync(source, 'export const value = "captured";');
    // Package-root JavaScript helpers resolve their authored declaration
    // companions during compilation, before any dist declarations exist.
    writeFileSync(join(dir, 'runtime-helper.mjs'), 'export const helper = "captured";\n');
    writeFileSync(join(dir, 'runtime-helper.cjs'), 'exports.helper = "captured";\n');
    const declarations = ['runtime-helper.d.mts', 'runtime-helper.d.cts', 'types.d.ts'];
    const declarationBytes = 'export declare const helper: string;\n';
    for (const name of declarations) writeFileSync(join(dir, name), declarationBytes);
    const fingerprint = readWorkspacePackageInputFingerprint({ packageDir: dir });
    let attempts = 0;
    const building = ensureWorkspacePackagesBuiltByName(root, ['@happier-dev/moving'], { quiet: true, buildMode,
      workspaceBuildBoundary: { prepareEnv: async (_dir, env) => env,
        runPackageBuild: async (buildDir, { env }) => {
          attempts++;
          for (const name of declarations) {
            const currentDeclaration = await readFile(join(dir, name), 'utf8');
            const capturedDeclaration = await readFile(join(buildDir, name), 'utf8');
            assert.equal(capturedDeclaration, currentDeclaration);
            await writeFile(join(dir, name), 'export declare const helper: number;\n');
            assert.equal(await readFile(join(buildDir, name), 'utf8'), buildMode !== 'strict'
              ? capturedDeclaration : 'export declare const helper: number;\n');
          }
          await writeFile(source, 'export const value = "later-' + attempts + '";');
          const contents = await readFile(join(buildDir, 'src/index.ts'), 'utf8');
          await writeFile(join(env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR, 'index.js'), contents);
        } },
    });
    if (buildMode === 'strict') {
      await assert.rejects(building, { code: 'BUILD_INPUTS_CHANGED', trailingPassExhausted: true });
      assert.equal(attempts, 2);
    } else {
      assert.deepEqual((await building).built, ['@happier-dev/moving']);
      assert.equal(attempts, 1);
      assert.match(await readFile(join(dir, 'dist/index.js'), 'utf8'), /captured/);
      assert.equal(JSON.parse(await readFile(join(dir, 'dist/.happier-build-inputs.json'), 'utf8')).fingerprint, fingerprint);
      assert.equal(isWorkspacePackageOutputCurrent(dir), false, 'later inputs must demand the next build');
    }
  });
});

test('cold SDK capture publishes generated inputs while the producer keeps editing', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'workspace-cold-sdk-capture-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writePnpmWorkspaceFixture(root, { workspaces: ['packages/*'] });
  for (const app of ['cli', 'ui', 'server']) {
    mkdirSync(join(root, 'apps', app), { recursive: true });
    writeFileSync(join(root, 'apps', app, 'package.json'), JSON.stringify({ name: `@fixture/${app}`,
      ...(app === 'server' ? { dependencies: { '@happier-dev/plugin-sdk': 'workspace:*' } } : {}) }));
  }
  const dir = join(root, 'packages/plugin-sdk');
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@happier-dev/plugin-sdk', type: 'module',
    main: './dist/index.js', scripts: { build: 'fixture-generator-and-compiler' } }));
  const source = join(dir, 'src/index.ts');
  writeFileSync(source, 'export const value = "captured";\n');
  writeFileSync(join(dir, 'src/bootstrap.generated.ts'), 'export const bootstrap = "stale";\n');
  const fingerprint = readWorkspacePackageInputFingerprint({ packageDir: dir });
  const serverDir = join(root, 'apps/server');
  assert.equal(await hasUsableWorkspaceLastGreen(serverDir), false);
  let edits = 0;
  let editTimer;
  t.after(() => clearInterval(editTimer));
  await ensureWorkspacePackagesBuiltForComponent(serverDir, { quiet: true, buildMode: 'source-dev',
    workspaceBuildBoundary: { prepareEnv: async (_dir, env) => env,
      // Only the package-script process boundary is substituted. The generator
      // mutates its private captured source before emitting, just as the SDK's
      // hosted HTML bootstrap generator does; the live producer keeps moving.
      runPackageBuild: async (buildDir, { env }) => {
        const edit = () => writeFileSync(source, `export const value = "later-${++edits}";\n`);
        clearInterval(editTimer);
        editTimer = setInterval(edit, 5);
        await promisify(execFile)(process.execPath, ['--input-type=module', '-e', `
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
writeFileSync('src/bootstrap.generated.ts', 'export const bootstrap = "generated";\\n');
await new Promise(resolve => setTimeout(resolve, 50));
writeFileSync(join(process.env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR, 'index.js'),
  readFileSync('src/index.ts', 'utf8') + readFileSync('src/bootstrap.generated.ts', 'utf8'));
`], { cwd: buildDir, env });
      } },
  });
  assert.ok(edits > 1, 'producer changed repeatedly during compilation');
  assert.equal(await hasUsableWorkspaceLastGreen(dir), true, 'cold captured SDK establishes last-green');
  assert.equal(await hasUsableWorkspaceLastGreen(serverDir), true, 'server can activate its coherent dependency closure');
  assert.equal(isWorkspacePackageOutputCurrent(dir), false, 'next demand catches up with later live edits');
  assert.equal(JSON.parse(readFileSync(join(dir, 'dist/.happier-build-inputs.json'), 'utf8')).fingerprint, fingerprint,
    'publication identifies the captured inputs, including the generator basis');
  assert.match(readFileSync(join(dir, 'dist/index.js'), 'utf8'), /captured[\s\S]*generated/);
  assert.equal(readFileSync(join(dir, 'src/bootstrap.generated.ts'), 'utf8'), 'export const bootstrap = "stale";\n',
    'generation stays private to the captured build');
  const editsAtPublication = edits;
  const service = spawn(process.execPath, ['--input-type=module', '-e', `
import { createServer } from 'node:http';
import { value, bootstrap } from ${JSON.stringify(pathToFileURL(join(dir, 'dist/index.js')).href)};
const server = createServer((_request, response) => response.end(JSON.stringify({ value, bootstrap })));
server.listen(0, '127.0.0.1', () => console.log(server.address().port));
`], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => {
    if (service.exitCode !== null || service.signalCode !== null) return;
    const exited = once(service, 'exit');
    service.kill();
    await exited;
  });
  let stderr = '';
  service.stderr.on('data', chunk => { stderr += chunk; });
  const port = await new Promise((resolvePort, rejectPort) => {
    service.once('error', rejectPort);
    service.once('exit', code => rejectPort(new Error(`fixture server exited ${code}: ${stderr}`)));
    service.stdout.once('data', chunk => resolvePort(Number(String(chunk).trim())));
  });
  const response = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { value: 'captured', bootstrap: 'generated' },
    'a disposable source-dev service starts from published captured output');
  assert.ok(edits > editsAtPublication, 'live edits continue through service activation');
  clearInterval(editTimer);
});

test('QA captures approve their physical install when producer identity is remote', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'workspace-capture-install-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writePnpmWorkspaceFixture(root, { workspaces: ['packages/*'] });
  for (const app of ['cli', 'ui', 'server']) {
    mkdirSync(join(root, 'apps', app), { recursive: true });
    writeFileSync(join(root, 'apps', app, 'package.json'), JSON.stringify({ name: `@fixture/${app}` }));
  }
  const dir = join(root, 'packages/example');
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@happier-dev/example', type: 'module',
    main: './dist/index.js', dependencies: { tr46: '^1.0.0' }, scripts: { build: 'fixture-process' } }));
  writeFileSync(join(dir, 'src/index.ts'), 'export const value = 46;\n');
  const runtime = join(root, 'node_modules/tr46');
  mkdirSync(runtime, { recursive: true });
  writeFileSync(join(runtime, 'package.json'), JSON.stringify({ name: 'tr46', version: '1.0.0' }));
  writeFileSync(join(runtime, 'index.js'), 'module.exports = 46;\n');
  const helper = new URL('../../packages/cli-common/workspaceRuntimeDependencies.mjs', import.meta.url).href;
  await ensureWorkspacePackagesBuiltByName(root, ['@happier-dev/example'], { quiet: true, buildMode: 'qa-runtime',
    env: { ...process.env, HAPPIER_STACK_RUNTIME_IDENTITY_REPO_DIR: join(root, 'remote-producer-identity') },
    workspaceBuildBoundary: {
      prepareEnv: async (_dir, env) => env,
      // Adapt only the package-script process boundary; the child consumes the
      // capture owner's actual environment and real runtime vendoring/copy.
      runPackageBuild: async (buildDir, { env }) => {
        await promisify(execFile)(process.execPath, ['--input-type=module', '-e', `
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { vendorRuntimeDependencyTree, copyDirDereferenceContainedSync } from ${JSON.stringify(helper)};
vendorRuntimeDependencyTree({ packageJsonPath: join(process.cwd(), 'package.json'),
  destNodeModulesDir: join(process.env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR, 'node_modules'),
  dereferenceRootDir: process.env.HAPPIER_STACK_REPO_DIR,
  copyResolvedPackage: ({ sourcePackageDir, destPackageDir, dereferenceRootDir }) =>
    copyDirDereferenceContainedSync({ sourceDir: sourcePackageDir, destDir: destPackageDir, dereferenceRootDir }) });
writeFileSync(join(process.env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR, 'index.js'), readFileSync('src/index.ts'));
`], { cwd: buildDir, env });
      },
    },
  });
  assert.equal(readFileSync(join(dir, 'dist/node_modules/tr46/index.js'), 'utf8'), 'module.exports = 46;\n');
  assert.equal(readFileSync(join(dir, 'dist/index.js'), 'utf8'), 'export const value = 46;\n');
});

test('QA workspace dependency preparation cannot rewrite captured producer inputs', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'workspace-captured-bundling-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writePnpmWorkspaceFixture(root, { workspaces: ['packages/*'] });
  for (const app of ['cli', 'ui', 'server']) {
    mkdirSync(join(root, 'apps', app), { recursive: true });
    writeFileSync(join(root, 'apps', app, 'package.json'), JSON.stringify({ name: `@fixture/${app}` }));
  }
  const leaf = join(root, 'packages/leaf');
  const consumer = join(root, 'packages/consumer');
  for (const [dir, name] of [[leaf, 'leaf'], [consumer, 'consumer']]) {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src/index.ts'), 'export const value = "captured";\n');
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: `@happier-dev/${name}`, type: 'module',
      main: './dist/index.js', types: './dist/index.d.ts', scripts: { build: 'fixture-compiler' },
      ...(name === 'consumer' ? { dependencies: { '@happier-dev/leaf': 'workspace:*' }, bundledDependencies: ['@happier-dev/leaf'] } : {}),
    }));
  }
  const originalLeafMetadata = readFileSync(join(leaf, 'package.json'), 'utf8');
  const consumerBuilds = [];
  const options = { quiet: true, buildMode: 'qa-runtime', workspaceBuildBoundary: {
    prepareEnv: async (_dir, env) => env,
    // Adapt the package-script process boundary, running the real dependency
    // publisher used by SDK preparation before simulating compiler emission.
    runPackageBuild: async (dir, { env }) => {
      if (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).name === '@happier-dev/consumer') {
        const capturedLeaf = join(dir, '../leaf');
        const builtRecord = readFileSync(join(capturedLeaf, 'dist/.happier-build-inputs.json'), 'utf8');
        bundleWorkspacePackageWithRuntimeDependencies({ packageName: '@happier-dev/leaf', srcDir: capturedLeaf,
          destDir: join(dir, 'node_modules/@happier-dev/leaf'), preserveDestinationPath: true, pruneStale: true });
        consumerBuilds.push(dir);
        assert.equal(readFileSync(join(capturedLeaf, 'package.json'), 'utf8'), originalLeafMetadata,
          'packages/leaf/package.json must retain producer metadata after consumer preparation');
        assert.equal(readFileSync(join(capturedLeaf, 'src/index.ts'), 'utf8'), 'export const value = "captured";\n');
        assert.equal(readFileSync(join(capturedLeaf, 'dist/.happier-build-inputs.json'), 'utf8'), builtRecord,
          'consumer pruning cannot retire the producer build record');
      }
      writeFileSync(join(env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR, 'index.js'), readFileSync(join(dir, 'src/index.ts')));
      writeFileSync(join(env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR, 'index.d.ts'), 'export declare const value: string;\n');
    },
  } };
  assert.deepEqual((await ensureWorkspacePackagesBuiltByName(root, ['@happier-dev/consumer'], options)).built,
    ['@happier-dev/consumer', '@happier-dev/leaf']);
  assert.equal(consumerBuilds.length, 1, 'preparation must converge without a trailing build');
  assert.deepEqual((await ensureWorkspacePackagesBuiltByName(root, ['@happier-dev/consumer'], options)).built, []);
  assert.equal(readFileSync(join(leaf, 'package.json'), 'utf8'), originalLeafMetadata);
  assert.equal(isWorkspacePackageOutputCurrent(consumer, { dependencyDirs: [leaf] }), true);
});

test('workspace phase takes one selective trailing pass for real-process input drift', async (t) => {
  for (const mode of ['settled', 'forced', 'continuing', 'compile-error', 'sibling-error']) {
    await t.test(mode, async (t) => {
      const root = mkdtempSync(join(tmpdir(), 'happier-workspace-convergence-'));
      t.after(() => rmSync(root, { recursive: true, force: true }));
      writePnpmWorkspaceFixture(root, { workspaces: ['apps/*', 'packages/*'] });
      for (const app of ['cli', 'ui', 'server']) {
        mkdirSync(join(root, 'apps', app), { recursive: true });
        writeFileSync(join(root, 'apps', app, 'package.json'), JSON.stringify({ name: `@fixture/${app}` }));
      }
      const dirs = Object.fromEntries(['moving', 'reference', 'sibling'].map((name) => [name, join(root, 'packages', name)]));
      for (const [name, dir] of Object.entries(dirs)) {
        mkdirSync(join(dir, 'src'), { recursive: true });
        writeFileSync(join(dir, 'src', 'index.ts'), 'export const value = "first";\n');
        writeFileSync(join(dir, 'package.json'), JSON.stringify({
          name: `@happier-dev/${name}`, main: './dist/index.js', types: './dist/index.d.ts',
          scripts: { build: 'fixture-compiler' },
          ...(name === 'reference' ? { dependencies: { '@happier-dev/moving': 'workspace:*' } } : {}),
        }));
      }
      // Only the compiler process is substituted; graph admission, locks,
      // declarations, staging and currentness publication remain real.
      const child = `
        import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
        import { join, basename } from 'node:path';
        const [dir, output, mode] = process.argv.slice(1);
        const attempts = join(dir, 'attempts');
        const attempt = existsSync(attempts) ? readFileSync(attempts, 'utf8').trim().split('\\n').length + 1 : 1;
        appendFileSync(attempts, String(attempt) + '\\n');
        const input = readFileSync(join(dir, 'src/index.ts'), 'utf8');
        if (basename(dir) === 'sibling' && attempt === 2 && mode === 'sibling-error') throw new Error('fixture compiler error');
        if (basename(dir) === 'moving' && attempt >= 2) {
          if (!readFileSync(join(dir, 'dist/index.js'), 'utf8').includes('first')) throw new Error('incoherent output published');
          if (attempt === 2 || mode === 'continuing') writeFileSync(join(dir, 'src/index.ts'), 'export const value = "edit-' + attempt + '";\\n');
          if (mode === 'compile-error') throw new Error('fixture compiler error');
        }
        writeFileSync(join(output, 'index.js'), input);
        writeFileSync(join(output, 'index.d.ts'), 'export declare const value: string;\\n');
      `;
      const options = {
        quiet: true, maxConcurrentBuilds: 2, buildMode: 'strict',
        workspaceBuildBoundary: {
          prepareEnv: async (_dir, env) => ({ ...env }),
          runPackageBuild: async (dir, { env }) => {
            await promisify(execFile)(process.execPath, ['--input-type=module', '-e', child, dir, env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR, mode]);
          },
        },
      };
      const build = (force = false) => ensureWorkspacePackagesBuiltByName(root, ['@happier-dev/reference', '@happier-dev/sibling'], { ...options, force });
      await build();
      const record = readFileSync(join(dirs.moving, 'dist/.happier-build-inputs.json'), 'utf8');
      writeFileSync(join(dirs.moving, 'src/index.ts'), 'export const value = "second";\n');
      writeFileSync(join(dirs.sibling, 'src/index.ts'), 'export const value = "sibling second";\n');
      if (mode === 'settled' || mode === 'forced') {
        const result = await build(mode === 'forced');
        assert.deepEqual(result.built, mode === 'forced'
          ? ['@happier-dev/moving', '@happier-dev/reference', '@happier-dev/sibling']
          : ['@happier-dev/moving', '@happier-dev/sibling']);
        assert.match(readFileSync(join(dirs.moving, 'dist/index.js'), 'utf8'), /edit-2/u);
        assert.notEqual(readFileSync(join(dirs.moving, 'dist/.happier-build-inputs.json'), 'utf8'), record);
        assert.deepEqual((await build()).built, []);
      } else {
        await assert.rejects(build(), (error) => {
          if (mode === 'continuing') {
            assert.equal(error.code, 'BUILD_INPUTS_CHANGED');
            assert.equal(error.trailingPassExhausted, true);
            assert.throws(() => createBundledPluginPublicationFailure({
              repoRoot: root, packageName: '@happier-dev/plugins-moving', error,
            }), (failure) => failure === error, 'drift must not become an optional-plugin availability diagnostic');
          } else assert.match(error.message, /fixture compiler error/u);
          if (mode === 'compile-error') {
            assert.throws(() => createBundledPluginPublicationFailure({
              repoRoot: root, packageName: '@happier-dev/plugins-codex', error,
            }), (failure) => isTerminalBuildFailure(failure), 'required-plugin policy must preserve compiler failure classification');
          }
          return true;
        });
        assert.match(readFileSync(join(dirs.moving, 'dist/index.js'), 'utf8'), /first/u);
        assert.equal(readFileSync(join(dirs.moving, 'dist/.happier-build-inputs.json'), 'utf8'), record);
      }
      const attempts = (dir) => readFileSync(join(dir, 'attempts'), 'utf8').trim().split('\n').length;
      assert.equal(attempts(dirs.moving), mode === 'compile-error' || mode === 'sibling-error' ? 2 : 3);
      assert.equal(attempts(dirs.reference), mode === 'forced' ? 2 : 1, 'unchanged declarations must not re-enter its compiler unless explicitly forced');
      assert.equal(attempts(dirs.sibling), 2, 'a sibling that settled on the first pass must be reused');
    });
  }
});

test('continuing concurrent source edits preserve the last coherent output and its built-input fingerprint', async (t) => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'happier-workspace-moving-inputs-'));
  t.after(() => rmSync(repoRoot, { recursive: true, force: true }));
  writePnpmWorkspaceFixture(repoRoot, { private: true, workspaces: ['packages/*'] });
  writeFileSync(join(repoRoot, 'pnpm-lock.yaml'), '# fixture\n');
  for (const appName of ['ui', 'cli', 'server']) {
    const appDir = join(repoRoot, 'apps', appName);
    mkdirSync(appDir, { recursive: true });
    writeFileSync(join(appDir, 'package.json'), JSON.stringify({ name: `@fixture/${appName}` }));
  }
  const packageDir = join(repoRoot, 'packages', 'moving');
  const sourcePath = join(packageDir, 'src', 'index.ts');
  const distPath = join(packageDir, 'dist', 'index.js');
  const recordPath = join(packageDir, 'dist', '.happier-build-inputs.json');
  mkdirSync(join(sourcePath, '..'), { recursive: true });
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({
    name: '@happier-dev/moving', main: './dist/index.js', scripts: { build: 'fixture-build' },
  }));
  writeFileSync(sourcePath, 'first\n');
  let builds = 0;
  const workspaceBuildBoundary = {
    async prepareEnv(_packageDir, env) { return { ...env }; },
    async runPackageBuild(_packageDir, { env }) {
      builds += 1;
      writeFileSync(join(env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR, 'index.js'), readFileSync(sourcePath));
      if (builds === 2 || builds === 3) writeFileSync(sourcePath, `edit-${builds}\n`);
    },
  };
  const build = () => ensureWorkspacePackagesBuiltByName(repoRoot, ['@happier-dev/moving'], {
    workspaceBuildBoundary, buildMode: 'strict',
  });
  assert.deepEqual((await build()).built, ['@happier-dev/moving']);
  assert.equal(readFileSync(distPath, 'utf8'), 'first\n');
  assert.equal(existsSync(recordPath), true);
  const lastGreenRecord = readFileSync(recordPath, 'utf8');
  writeFileSync(sourcePath, 'second\n');
  await assert.rejects(build(), /inputs changed while building/u);
  assert.equal(readFileSync(distPath, 'utf8'), 'first\n');
  assert.equal(readFileSync(recordPath, 'utf8'), lastGreenRecord);
  assert.deepEqual((await build()).built, ['@happier-dev/moving']);
  assert.equal(readFileSync(distPath, 'utf8'), 'edit-3\n');
  assert.equal(builds, 4);
  assert.equal(existsSync(recordPath), true);
});

test('a recorded build remains valid after source edits but not after a dependency output changes', async (t) => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'happier-workspace-built-dependencies-'));
  t.after(() => rmSync(repoRoot, { recursive: true, force: true }));
  writePnpmWorkspaceFixture(repoRoot, { private: true, workspaces: ['packages/*', 'apps/*'] });
  writeFileSync(join(repoRoot, 'pnpm-lock.yaml'), '# fixture\n');
  for (const app of ['cli', 'ui', 'server']) {
    const dir = join(repoRoot, 'apps', app);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: `@fixture/${app}` }));
  }
  const leaf = join(repoRoot, 'packages', 'leaf');
  const parent = join(repoRoot, 'packages', 'parent');
  for (const [dir, name, dependencies] of [[leaf, 'leaf', {}], [parent, 'parent', { '@happier-dev/leaf': 'workspace:*' }]]) {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'index.ts'), 'export const value = 1;\n');
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: `@happier-dev/${name}`, main: './dist/index.js', scripts: { build: 'fixture-build' }, dependencies,
    }));
  }
  await ensureWorkspacePackagesBuiltByName(repoRoot, ['@happier-dev/parent'], {
    workspaceBuildBoundary: {
      async prepareEnv(_dir, env) { return { ...env }; },
      async runPackageBuild(dir, { env }) {
        writeFileSync(join(env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR, 'index.js'), readFileSync(join(dir, 'src', 'index.ts')));
      },
    },
  });
  writeFileSync(join(parent, 'src', 'index.ts'), 'export const value = 2;\n');
  const input = { dependencyDirs: [leaf], monorepoRoot: repoRoot };
  assert.equal(isWorkspacePackageOutputValid(parent, input), true);
  writeFileSync(join(leaf, 'dist', 'index.js'), 'export const value = 3;\n');
  assert.equal(isWorkspacePackageOutputValid(parent, input), false);
});

test('package input fingerprint changes with the selected compiler bytes', async (t) => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'happier-workspace-compiler-identity-'));
  t.after(() => rmSync(repoRoot, { recursive: true, force: true }));
  const packageDir = join(repoRoot, 'package');
  const compilerPath = join(repoRoot, 'node_modules', '@typescript', 'native', 'bin', 'tsc.js');
  mkdirSync(join(packageDir, 'src'), { recursive: true });
  mkdirSync(join(compilerPath, '..'), { recursive: true });
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name: '@fixture/compiler', scripts: { build: 'fixture-build' } }));
  writeFileSync(join(packageDir, 'src', 'index.ts'), 'export const value = 1;\n');
  writeFileSync(join(repoRoot, 'node_modules', '@typescript', 'native', 'package.json'), '{"version":"1"}\n');
  writeFileSync(compilerPath, 'compiler one\n');
  const nativeExecutable = join(repoRoot, 'node_modules', '@typescript', 'typescript-linux-x64', 'bin', 'tsgo');
  mkdirSync(join(nativeExecutable, '..'), { recursive: true });
  writeFileSync(nativeExecutable, 'native compiler one\n');
  const compilerHelper = join(repoRoot, 'node_modules', '@typescript', 'native', 'lib', 'getExePath.js');
  mkdirSync(join(compilerHelper, '..'), { recursive: true });
  writeFileSync(compilerHelper, 'native resolution helper one\n');
  writeFileSync(join(repoRoot, 'pnpm-lock.yaml'), 'external-types@1:\n');
  writeFileSync(join(repoRoot, 'pnpm-workspace.yaml'), 'packages:\n');
  const outputScriptOwner = join(repoRoot, 'scripts/workspaces/workspaceOutputScriptArgs.mjs');
  mkdirSync(join(outputScriptOwner, '..'), { recursive: true });
  writeFileSync(outputScriptOwner, 'export const stagedManifest = 1;\n');
  const fingerprint = () => readWorkspacePackageInputFingerprint({
    packageDir,
    env: { HAPPIER_STACK_REPO_DIR: repoRoot },
    resolveTypeScriptCliInvocationImpl: () => ({ command: process.execPath, argsPrefix: [compilerPath] }),
  });
  const first = fingerprint();
  writeFileSync(compilerPath, 'compiler two changed\n');
  assert.notEqual(fingerprint(), first);
  for (const [path, contents, contract, changesInput = true] of [
    [nativeExecutable, 'native compiler two\n', 'native compiler replacement'],
    [compilerHelper, 'native resolution helper two\n', 'executable-resolution helper replacement'],
    // Installed compiler, runtime bytes and external declarations decide build
    // freshness. Unapplied/unrelated policy changes are not consumed inputs.
    [join(repoRoot, 'pnpm-lock.yaml'), 'external-types@2:\n', 'unrelated dependency-lock change', false],
    [join(repoRoot, 'pnpm-workspace.yaml'), 'packages:\nnodeLinker: hoisted\n', 'unapplied package-manager policy change', false],
    [outputScriptOwner, 'export const stagedManifest = 2;\n', 'staged manifest preparation owner replacement'],
  ]) await t.test(contract, () => {
    const before = fingerprint();
    writeFileSync(path, contents);
    assert.equal(fingerprint() !== before, changesInput, contract);
  });
});

test('package input fingerprint follows its build producer rather than an inherited foreign Stack', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'happier-workspace-producer-frame-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const producer = join(root, 'producer');
  const foreignStack = join(root, 'foreign-stack');
  const packageDir = join(producer, 'packages/example');
  for (const app of ['cli', 'ui', 'server']) {
    const dir = join(producer, 'apps', app);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: `@fixture/${app}` }));
  }
  mkdirSync(join(packageDir, 'src'), { recursive: true });
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name: '@fixture/producer' }));
  writeFileSync(join(packageDir, 'src/index.ts'), 'export const value = 1;\n');
  for (const repo of [producer, foreignStack]) {
    mkdirSync(join(repo, 'scripts/workspaces'), { recursive: true });
    writeFileSync(join(repo, 'scripts/workspaces/buildTypeScriptPackageDist.mjs'), 'export const build = 1;\n');
    writeFileSync(join(repo, 'scripts/workspaces/workspaceOutputScriptArgs.mjs'), 'export const staged = 1;\n');
  }
  const compilerPath = join(root, 'toolchain/node_modules/@typescript/native/bin/tsc.js');
  mkdirSync(join(compilerPath, '..'), { recursive: true });
  writeFileSync(compilerPath, 'installed compiler');
  writeFileSync(join(compilerPath, '../../package.json'), '{"version":"fixture"}');
  // The compiler executable lookup is the external boundary; package-root
  // discovery, source membership and the fingerprint owner remain real.
  const fingerprint = () => readWorkspacePackageInputFingerprint({
    packageDir, env: { HAPPIER_STACK_REPO_DIR: foreignStack },
    resolveTypeScriptCliInvocationImpl: () => ({ compilerPath }),
  });
  for (const script of ['buildTypeScriptPackageDist.mjs', 'workspaceOutputScriptArgs.mjs']) await t.test(script, () => {
    const before = fingerprint();
    writeFileSync(join(producer, 'scripts/workspaces', script), 'export const changedProducer = 2;\n');
    assert.notEqual(fingerprint(), before, 'actual compiler/build owner changes must invalidate package output');
    const admitted = fingerprint();
    writeFileSync(join(foreignStack, 'scripts/workspaces', script), 'export const unrelatedStack = 2;\n');
    assert.equal(fingerprint(), admitted, 'a running foreign Stack does not own this package build');
  });
});

test('live publication refreshes declared output currentness when source changes without emitted-byte changes', async (t) => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'happier-workspace-build-live-currentness-'));
  t.after(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  writePnpmWorkspaceFixture(repoRoot, { private: true, workspaces: ['packages/*'] });
  writeFileSync(join(repoRoot, 'pnpm-lock.yaml'), '# fixture\n', 'utf8');
  for (const appName of ['ui', 'cli', 'server']) {
    const appDir = join(repoRoot, 'apps', appName);
    mkdirSync(appDir, { recursive: true });
    writeFileSync(
      join(appDir, 'package.json'),
      JSON.stringify({ name: `@fixture/${appName}`, private: true }),
      'utf8',
    );
  }

  const packageDir = join(repoRoot, 'packages', 'same-emit');
  const outputPath = join(packageDir, 'dist', 'index.js');
  mkdirSync(join(packageDir, 'src'), { recursive: true });
  mkdirSync(join(packageDir, 'dist'), { recursive: true });
  writeFileSync(
    join(packageDir, 'package.json'),
    JSON.stringify({
      name: '@happier-dev/same-emit',
      main: './dist/index.js',
      scripts: { build: 'fixture-build' },
    }),
    'utf8',
  );
  writeFileSync(outputPath, 'export const value = true;\n', 'utf8');
  utimesSync(outputPath, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  writeFileSync(join(packageDir, 'src', 'index.ts'), 'export const value = true;\n', 'utf8');
  const before = statSync(outputPath);
  let buildCalls = 0;
  const workspaceBuildBoundary = {
    async prepareEnv(_packageDir, env) {
      return { ...env };
    },
    async runPackageBuild(_packageDir, { env }) {
      buildCalls += 1;
      await writeFile(join(env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR, 'index.js'), 'export const value = true;\n');
    },
  };

  await ensureWorkspacePackagesBuiltByName(repoRoot, ['@happier-dev/same-emit'], {
    quiet: true,
    workspaceBuildBoundary,
  });
  const afterPublish = statSync(outputPath);
  assert.equal(afterPublish.ino, before.ino, 'live publication keeps an identical declared file in place');
  assert.equal(afterPublish.mtimeMs, before.mtimeMs, 'content admission preserves byte-identical live output');

  await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  writeFileSync(join(packageDir, 'src', 'index.test.ts'), 'export const testOnly = true;\n', 'utf8');
  await ensureWorkspacePackagesBuiltByName(repoRoot, ['@happier-dev/same-emit'], {
    quiet: true,
    workspaceBuildBoundary,
  });

  assert.equal(buildCalls, 1, 'test-only input must not trigger a repeat build after current live publication');
});

test('concurrent workspace package build waiters reuse the one published result', async (t) => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'happier-workspace-build-concurrent-waiters-'));
  t.after(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  writePnpmWorkspaceFixture(repoRoot, { private: true, workspaces: ['packages/*'] });
  writeFileSync(join(repoRoot, 'pnpm-lock.yaml'), '# fixture\n', 'utf8');
  for (const appName of ['ui', 'cli', 'server']) {
    const appDir = join(repoRoot, 'apps', appName);
    mkdirSync(appDir, { recursive: true });
    writeFileSync(
      join(appDir, 'package.json'),
      JSON.stringify({ name: `@fixture/${appName}`, private: true }),
      'utf8',
    );
  }

  const packageDir = join(repoRoot, 'packages', 'waiter');
  mkdirSync(join(packageDir, 'src'), { recursive: true });
  writeFileSync(join(packageDir, 'src', 'index.ts'), 'export const value = true;\n', 'utf8');
  writeFileSync(
    join(packageDir, 'package.json'),
    JSON.stringify({
      name: '@happier-dev/waiter',
      main: './dist/index.js',
      scripts: { build: 'fixture-build' },
    }),
    'utf8',
  );

  let notifyStarted = null;
  const started = new Promise((resolveStarted) => {
    notifyStarted = resolveStarted;
  });
  let releaseBuild = null;
  const release = new Promise((resolveRelease) => {
    releaseBuild = resolveRelease;
  });
  let buildCalls = 0;
  const workspaceBuildBoundary = {
    async prepareEnv(_packageDir, env) {
      return { ...env };
    },
    async runPackageBuild(_packageDir, { env }) {
      buildCalls += 1;
      notifyStarted();
      await release;
      await writeFile(join(env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR, 'index.js'), 'export const published = true;\n');
    },
  };

  const first = ensureWorkspacePackagesBuiltByName(repoRoot, ['@happier-dev/waiter'], {
    quiet: true,
    workspaceBuildBoundary,
  });
  await started;
  const waiter = ensureWorkspacePackagesBuiltByName(repoRoot, ['@happier-dev/waiter'], {
    quiet: true,
    workspaceBuildBoundary,
  });
  releaseBuild();
  const [firstResult, waiterResult] = await Promise.all([first, waiter]);

  assert.equal(buildCalls, 1);
  assert.deepEqual([...firstResult.built, ...waiterResult.built], ['@happier-dev/waiter']);
  assert.equal(await readFile(join(packageDir, 'dist', 'index.js'), 'utf8'), 'export const published = true;\n');
});

test('workspace build reuses an inherited bundle publication lease', async (t) => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'happier-workspace-build-inherited-bundle-lock-'));
  t.after(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  writePnpmWorkspaceFixture(repoRoot, { private: true, workspaces: ['packages/*'] });
  writeFileSync(join(repoRoot, 'pnpm-lock.yaml'), '# fixture\n', 'utf8');
  for (const appName of ['ui', 'cli', 'server']) {
    const appDir = join(repoRoot, 'apps', appName);
    mkdirSync(appDir, { recursive: true });
    writeFileSync(
      join(appDir, 'package.json'),
      JSON.stringify({ name: `@fixture/${appName}`, private: true }),
      'utf8',
    );
  }

  const packageDir = join(repoRoot, 'packages', 'consumer');
  mkdirSync(join(packageDir, 'src'), { recursive: true });
  writeFileSync(join(packageDir, 'src', 'index.ts'), 'export const value = true;\n', 'utf8');
  writeFileSync(
    join(packageDir, 'package.json'),
    JSON.stringify({
      name: '@happier-dev/consumer',
      main: './dist/index.js',
      bundledDependencies: ['@happier-dev/dependency'],
      scripts: { build: 'fixture-build' },
    }),
    'utf8',
  );

  const workspaceBundleLockPath = resolveWorkspaceBundleLockPath(repoRoot);
  await withWorkspaceBundleLock(
    async ({ heldLockValue }) => {
      const inheritedEnv = createWorkspaceChildBuildEnv({
        env: {
          PATH: '/repo/bin',
          HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD: 'stale-parent-lease',
          Happier_Workspace_Dist_Build_Lock_Held: 'mixed-case-stale-parent-lease',
        },
        heldLockValue,
      });
      const result = await ensureWorkspacePackagesBuiltByName(
        repoRoot,
        ['@happier-dev/consumer'],
        {
          env: inheritedEnv,
          force: true,
          quiet: true,
          workspaceBuildBoundary: {
            async prepareEnv(_packageDir, env) {
              return { ...env };
            },
            async runPackageBuild(_packageDir, { env }) {
              assert.equal(env.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD, heldLockValue);
              await writeFile(
                join(env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR, 'index.js'),
                'export const value = true;\n',
              );
            },
          },
        },
      );
      assert.deepEqual(result.built, ['@happier-dev/consumer']);
    },
    { lockPath: workspaceBundleLockPath },
  );
});

test('workspace build preserves an inherited bundle lease through an unbundled package lifecycle', async (t) => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'happier-workspace-build-nested-bundle-reentry-'));
  t.after(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  writePnpmWorkspaceFixture(repoRoot, { private: true, workspaces: ['packages/*'] });
  writeFileSync(join(repoRoot, 'pnpm-lock.yaml'), '# fixture\n', 'utf8');
  for (const appName of ['ui', 'cli', 'server']) {
    const appDir = join(repoRoot, 'apps', appName);
    mkdirSync(appDir, { recursive: true });
    writeFileSync(
      join(appDir, 'package.json'),
      JSON.stringify({ name: `@fixture/${appName}`, private: true }),
      'utf8',
    );
  }

  const packageDir = join(repoRoot, 'packages', 'consumer');
  mkdirSync(join(packageDir, 'src'), { recursive: true });
  writeFileSync(join(packageDir, 'src', 'index.ts'), 'export const value = true;\n', 'utf8');
  writeFileSync(
    join(packageDir, 'package.json'),
    JSON.stringify({
      name: '@happier-dev/consumer',
      main: './dist/index.js',
      scripts: { build: 'fixture-build' },
    }),
    'utf8',
  );

  const workspaceBundleLockPath = resolveWorkspaceBundleLockPath(repoRoot);
  const packageBuildLockPath = resolveWorkspacePackageBuildLockPath(packageDir, {
    name: '@happier-dev/consumer',
  });
  await withWorkspaceBundleLock(
    async ({ heldLockValue }) => {
      const result = await ensureWorkspacePackagesBuiltByName(
        repoRoot,
        ['@happier-dev/consumer'],
        {
          env: createWorkspaceChildBuildEnv({ env: {}, heldLockValue }),
          force: true,
          quiet: true,
          workspaceBuildBoundary: {
            async prepareEnv(_packageDir, env) {
              return { ...env };
            },
            async runPackageBuild(_packageDir, { env }) {
              assert.equal(existsSync(packageBuildLockPath), true);
              assert.equal(env.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD, heldLockValue);
              await withWorkspaceBundleLock(
                ({ inherited }) => assert.equal(inherited, true),
                {
                  lockPath: workspaceBundleLockPath,
                  heldLockValue: env.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD,
                  timeoutMs: 80,
                  pollIntervalMs: 5,
                  staleAfterMs: 1_000,
                },
              );
              await writeFile(
                join(env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR, 'index.js'),
                'export const value = true;\n',
              );
            },
          },
        },
      );
      assert.deepEqual(result.built, ['@happier-dev/consumer']);
    },
    { lockPath: workspaceBundleLockPath },
  );
});

test('first-party plugin UI siblings prepare their manifests inside joint publication admission before capture', async (t) => {
  const repoRoot = realpathSync(mkdtempSync(join(tmpdir(), 'happier-plugin-ui-manifest-admission-')));
  t.after(() => rmSync(repoRoot, { recursive: true, force: true }));
  writePnpmWorkspaceFixture(repoRoot, {
    private: true, workspaces: ['apps/*', 'packages/plugins/*'],
  });
  writeFileSync(join(repoRoot, 'pnpm-lock.yaml'), '# fixture\n');
  for (const appName of ['ui', 'cli', 'server']) {
    const appDir = join(repoRoot, 'apps', appName);
    mkdirSync(appDir, { recursive: true });
    writeFileSync(join(appDir, 'package.json'), JSON.stringify({ name: `@fixture/${appName}`, private: true }));
  }
  const packageNames = ['@happier-dev/plugins-first', '@happier-dev/plugins-second'];
  for (const packageName of packageNames) {
    const id = packageName.slice('@happier-dev/plugins-'.length);
    const packageDir = join(repoRoot, 'packages/plugins', id);
    mkdirSync(join(packageDir, 'src'), { recursive: true });
    writeFileSync(join(packageDir, 'package.json'), JSON.stringify({
      name: packageName, version: '0.0.0', type: 'module', main: './dist/index.js',
      exports: { '.': './dist/index.js', './happier-plugin-ui/panel': './src/panel.ts' },
      scripts: { build: 'fixture-compiler', 'build:ui': 'happier-plugin-build-ui' },
    }));
    writeFileSync(join(packageDir, 'src/index.ts'), 'export const value = true;\n');
    writeFileSync(join(packageDir, 'src/panel.ts'), 'export function renderSurface() { return null; }\n');
    writeFileSync(join(packageDir, 'src/manifest.ts'), `export const PLUGIN_MANIFEST = ${JSON.stringify({
      schemaVersion: 2, id: `happier.${id}`, version: '0.0.0', displayName: id,
      engines: { happier: '^0.0.0' }, runtime: { apiVersion: 1 },
      entrypoints: { daemon: './.happier-plugin/daemon.js' },
      hostAccess: { required: [], optional: [] },
      contributes: { ui: { renderers: [{ id: 'panel', kind: 'reactNative', artifact: 'panel' }] } },
    })};\n`);
  }
  const workspaceLock = resolveWorkspaceBundleLockPath(repoRoot);
  const ancestorLock = join(repoRoot, 'ancestor-publication.lock');
  const built = [];
  // The admitted root may retain a different primary publication lease.
  // The canonical lock owner must resolve this transaction's global lease
  // from its existing inherited lease array rather than waiting on itself.
  const result = await withWorkspaceBundleLock(({ heldLockValue }) => ensureWorkspacePackagesBuiltByName(repoRoot, packageNames, {
    buildMode: 'source-dev', maxConcurrentBuilds: 2,
    env: { ...process.env, HAPPIER_WORKSPACE_DIST_BUILD_LOCK_WAIT_ALLOWED: '0',
      HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD: heldLockValue },
    workspaceBuildBoundary: {
      async prepareEnv(_packageDir, env) { return { ...env }; },
      async runPackageBuild(capturedPackageDir, { env }) {
        const packageJson = JSON.parse(readFileSync(join(capturedPackageDir, 'package.json'), 'utf8'));
        const packageDir = join(repoRoot, 'packages/plugins', packageJson.name.slice('@happier-dev/plugins-'.length));
        assert.equal(JSON.parse(env.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD).path, ancestorLock);
        assert.equal(existsSync(workspaceLock), true, 'manifest preparation and capture must retain admitted publication custody');
        assert.equal(existsSync(resolveWorkspacePackageBuildLockPath(packageDir, packageJson)), true);
        assert.notEqual(capturedPackageDir, packageDir, 'the UI input must be consumed from bounded source capture');
        const manifest = JSON.parse(readFileSync(join(capturedPackageDir, '.happier-plugin/plugin.json'), 'utf8'));
        assert.equal(manifest.id, `happier.${packageJson.name.slice('@happier-dev/plugins-'.length)}`);
        built.push(packageJson.name);
        await writeFile(join(env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR, 'index.js'), 'export const value = true;\n');
        mkdirSync(join(env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR, 'happier-plugin-ui'), { recursive: true });
        await writeFile(join(env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR, 'happier-plugin-ui/ui-artifacts.json'), '{"version":1,"entries":[]}\n');
      },
    },
  }), { lockPath: ancestorLock });
  assert.deepEqual([...result.built].sort(), packageNames);
  assert.deepEqual(built.sort(), packageNames);
  assert.equal(existsSync(workspaceLock), false);
});

test('plugin UI runtime build uses only its package lock', async (t) => {
  const repoRoot = realpathSync(mkdtempSync(join(tmpdir(), 'happier-plugin-ui-build-lock-order-')));
  t.after(() => rmSync(repoRoot, { recursive: true, force: true }));
  writePnpmWorkspaceFixture(repoRoot, {
    private: true,
    workspaces: ['packages/*'],
  });
  writeFileSync(join(repoRoot, 'pnpm-lock.yaml'), '# fixture\n');
  for (const appName of ['ui', 'cli', 'server']) {
    const appDir = join(repoRoot, 'apps', appName);
    mkdirSync(appDir, { recursive: true });
    writeFileSync(join(appDir, 'package.json'), JSON.stringify({
      name: `@fixture/${appName}`,
      private: true,
    }));
  }
  const packageDir = join(repoRoot, 'packages', 'plugin-ui');
  const packageJson = {
    name: '@happier-dev/plugin-ui',
    main: './dist/index.js',
    scripts: { build: 'fixture-build' },
  };
  mkdirSync(join(packageDir, 'src'), { recursive: true });
  writeFileSync(join(packageDir, 'src', 'index.ts'), 'export const value = true;\n');
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify(packageJson));

  const packageLockPath = resolveWorkspacePackageBuildLockPath(packageDir, packageJson);
  const result = await ensureWorkspacePackagesBuiltByName(repoRoot, [packageJson.name], {
    workspaceBuildBoundary: {
      async prepareEnv(_packageDir, env) { return { ...env }; },
      async runPackageBuild(_packageDir, { env }) {
        assert.equal(existsSync(packageLockPath), true);
        assert.equal(JSON.parse(env.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD).path, packageLockPath);
        await writeFile(join(env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR, 'index.js'), 'export const value = true;\n');
      },
    },
  });
  assert.deepEqual(result, { ok: true, built: [packageJson.name], skipped: [] });
});

test('workspace build refreshes a consumer bundled dependency after the dependency publishes', async (t) => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'happier-workspace-build-bundled-dependency-'));
  t.after(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  writePnpmWorkspaceFixture(repoRoot, { private: true, workspaces: ['packages/*'] });
  writeFileSync(join(repoRoot, 'pnpm-lock.yaml'), '# fixture\n', 'utf8');
  for (const appName of ['ui', 'cli', 'server']) {
    const appDir = join(repoRoot, 'apps', appName);
    mkdirSync(appDir, { recursive: true });
    writeFileSync(
      join(appDir, 'package.json'),
      JSON.stringify({ name: `@fixture/${appName}`, private: true }),
      'utf8',
    );
  }

  const dependencyDir = join(repoRoot, 'packages', 'dependency');
  const consumerDir = join(repoRoot, 'packages', 'consumer');
  const bundledDependencyDir = join(
    consumerDir,
    'node_modules',
    '@happier-dev',
    'dependency',
  );
  const workspaceBundleLockPath = resolveWorkspaceBundleLockPath(repoRoot);
  const packageBuildLockPath = resolveWorkspacePackageBuildLockPath(consumerDir, {
    name: '@happier-dev/consumer',
  });
  for (const [packageDir, packageJson] of [
    [dependencyDir, {
      name: '@happier-dev/dependency',
      main: './dist/index.js',
      scripts: { build: 'fixture-build' },
    }],
    [consumerDir, {
      name: '@happier-dev/consumer',
      main: './dist/index.js',
      dependencies: { '@happier-dev/dependency': '0.0.0' },
      bundledDependencies: ['@happier-dev/dependency'],
      scripts: { build: 'fixture-build' },
    }],
  ]) {
    mkdirSync(join(packageDir, 'src'), { recursive: true });
    mkdirSync(join(packageDir, 'dist'), { recursive: true });
    writeFileSync(join(packageDir, 'package.json'), JSON.stringify(packageJson), 'utf8');
    writeFileSync(join(packageDir, 'src', 'index.ts'), 'export const value = true;\n', 'utf8');
    writeFileSync(join(packageDir, 'dist', 'index.js'), 'export const value = "old";\n', 'utf8');
  }
  mkdirSync(join(bundledDependencyDir, 'dist'), { recursive: true });
  writeFileSync(
    join(bundledDependencyDir, 'package.json'),
    JSON.stringify({ name: '@happier-dev/dependency', main: './dist/index.js' }),
    'utf8',
  );
  writeFileSync(
    join(bundledDependencyDir, 'dist', 'index.js'),
    'export const value = "stale-private-copy";\n',
    'utf8',
  );

  const oldTime = new Date(Date.now() - 10_000);
  const newTime = new Date();
  for (const packageDir of [dependencyDir, consumerDir]) {
    utimesSync(join(packageDir, 'src', 'index.ts'), oldTime, oldTime);
    utimesSync(join(packageDir, 'dist', 'index.js'), newTime, newTime);
  }
  utimesSync(
    join(dependencyDir, 'src', 'index.ts'),
    new Date(Date.now() + 1_000),
    new Date(Date.now() + 1_000),
  );

  await ensureWorkspacePackagesBuiltByName(repoRoot, ['@happier-dev/consumer'], {
    quiet: true,
    workspaceBuildBoundary: {
      async prepareEnv(_packageDir, env) {
        return { ...env };
      },
      async runPackageBuild(packageDir, { env }) {
        if (packageDir === consumerDir) {
          assert.equal(existsSync(workspaceBundleLockPath), true);
          assert.equal(existsSync(packageBuildLockPath), true);
          assert.equal(env.HAPPIER_WORKSPACE_PACKAGE_PREREQUISITES_READY, '1');
          assert.notEqual(env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR, join(consumerDir, 'dist'));
          await withWorkspaceBundleLock(
            ({ inherited, heldLockValue }) => {
              assert.equal(inherited, true);
              assert.equal(heldLockValue, env.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD);
            },
            {
              lockPath: workspaceBundleLockPath,
              heldLockValue: env.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD,
            },
          );
          assert.equal(
            readFileSync(join(bundledDependencyDir, 'dist', 'index.js'), 'utf8'),
            'export const value = "current-dependency";\n',
          );
        }
        await writeFile(
          join(env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR, 'index.js'),
          packageDir === dependencyDir
            ? 'export const value = "current-dependency";\n'
            : 'export const value = "current-consumer";\n',
        );
      },
    },
  });
});

test('workspace build refreshes a stale private bundled dependency published by an earlier invocation', async (t) => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'happier-workspace-build-prior-bundled-dependency-'));
  t.after(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  writePnpmWorkspaceFixture(repoRoot, { private: true, workspaces: ['packages/*'] });
  writeFileSync(join(repoRoot, 'pnpm-lock.yaml'), '# fixture\n', 'utf8');
  for (const appName of ['ui', 'cli', 'server']) {
    const appDir = join(repoRoot, 'apps', appName);
    mkdirSync(appDir, { recursive: true });
    writeFileSync(
      join(appDir, 'package.json'),
      JSON.stringify({ name: `@fixture/${appName}`, private: true }),
      'utf8',
    );
  }

  const dependencyDir = join(repoRoot, 'packages', 'dependency');
  const consumerDir = join(repoRoot, 'packages', 'consumer');
  const bundledDependencyDir = join(
    consumerDir,
    'node_modules',
    '@happier-dev',
    'dependency',
  );
  for (const [packageDir, packageJson] of [
    [dependencyDir, {
      name: '@happier-dev/dependency',
      main: './dist/index.js',
      scripts: { build: 'fixture-build' },
    }],
    [consumerDir, {
      name: '@happier-dev/consumer',
      main: './dist/index.js',
      dependencies: { '@happier-dev/dependency': '0.0.0' },
      bundledDependencies: ['@happier-dev/dependency'],
      scripts: { build: 'fixture-build' },
    }],
  ]) {
    mkdirSync(join(packageDir, 'src'), { recursive: true });
    mkdirSync(join(packageDir, 'dist'), { recursive: true });
    writeFileSync(join(packageDir, 'package.json'), JSON.stringify(packageJson), 'utf8');
    writeFileSync(join(packageDir, 'src', 'index.ts'), 'export const value = true;\n', 'utf8');
    writeFileSync(join(packageDir, 'dist', 'index.js'), 'export const value = "old";\n', 'utf8');
  }
  mkdirSync(join(bundledDependencyDir, 'dist'), { recursive: true });
  writeFileSync(
    join(bundledDependencyDir, 'package.json'),
    JSON.stringify({ name: '@happier-dev/dependency', main: './dist/index.js' }),
    'utf8',
  );
  writeFileSync(
    join(bundledDependencyDir, 'dist', 'index.js'),
    'export const value = "stale-private-copy";\n',
    'utf8',
  );

  const now = Date.now();
  const oldSourceTime = new Date(now - 30_000);
  const staleDependencyOutputTime = new Date(now - 20_000);
  for (const packageDir of [dependencyDir, consumerDir]) {
    utimesSync(join(packageDir, 'src', 'index.ts'), oldSourceTime, oldSourceTime);
  }
  utimesSync(
    join(dependencyDir, 'dist', 'index.js'),
    staleDependencyOutputTime,
    staleDependencyOutputTime,
  );
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  const currentConsumerOutputTime = new Date();
  utimesSync(
    join(consumerDir, 'dist', 'index.js'),
    currentConsumerOutputTime,
    currentConsumerOutputTime,
  );

  writeFileSync(join(dependencyDir, 'src', 'index.ts'), 'export const value = "changed";\n', 'utf8');
  const dependencyBuild = await ensureWorkspacePackagesBuiltByName(
    repoRoot,
    ['@happier-dev/dependency'],
    {
      quiet: true,
      workspaceBuildBoundary: {
        async prepareEnv(_packageDir, env) {
          return { ...env };
        },
        async runPackageBuild(packageDir, { env }) {
          assert.equal(readFixturePackageName(packageDir), '@happier-dev/dependency');
          await writeFile(
            join(env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR, 'index.js'),
            'export const value = "current-dependency";\n',
          );
        },
      },
    },
  );
  assert.deepEqual(dependencyBuild.built, ['@happier-dev/dependency']);
  assert.equal(
    readFileSync(join(bundledDependencyDir, 'dist', 'index.js'), 'utf8'),
    'export const value = "stale-private-copy";\n',
  );

  const consumerBuild = await ensureWorkspacePackagesBuiltByName(
    repoRoot,
    ['@happier-dev/consumer'],
    {
      quiet: true,
      workspaceBuildBoundary: {
        async prepareEnv(_packageDir, env) {
          return { ...env };
        },
        async runPackageBuild(packageDir, { env }) {
          assert.equal(readFixturePackageName(packageDir), '@happier-dev/consumer');
          assert.equal(
            readFileSync(join(packageDir, 'node_modules/@happier-dev/dependency/dist/index.js'), 'utf8'),
            'export const value = "current-dependency";\n',
          );
          await writeFile(
            join(env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR, 'index.js'),
            'export const value = "current-consumer";\n',
          );
        },
      },
    },
  );

  assert.deepEqual(consumerBuild.built, ['@happier-dev/consumer']);

  const converged = await ensureWorkspacePackagesBuiltByName(
    repoRoot,
    ['@happier-dev/consumer'],
    {
      quiet: true,
      workspaceBuildBoundary: {
        async prepareEnv(_packageDir, env) {
          return { ...env };
        },
        async runPackageBuild() {
          throw new Error('current dependency and consumer outputs must not rebuild');
        },
      },
    },
  );
  assert.deepEqual(converged.built, []);
});

test('workspace build leaves non-bundled packages under only their package build lock', async (t) => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'happier-workspace-build-unbundled-lock-'));
  t.after(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  writePnpmWorkspaceFixture(repoRoot, { private: true, workspaces: ['packages/*'] });
  writeFileSync(join(repoRoot, 'pnpm-lock.yaml'), '# fixture\n', 'utf8');
  for (const appName of ['ui', 'cli', 'server']) {
    const appDir = join(repoRoot, 'apps', appName);
    mkdirSync(appDir, { recursive: true });
    writeFileSync(
      join(appDir, 'package.json'),
      JSON.stringify({ name: `@fixture/${appName}`, private: true }),
      'utf8',
    );
  }

  const packageDir = join(repoRoot, 'packages', 'unbundled');
  const packageJson = {
    name: '@happier-dev/unbundled',
    main: './dist/index.js',
    scripts: { build: 'fixture-build' },
  };
  const workspaceBundleLockPath = resolveWorkspaceBundleLockPath(repoRoot);
  const packageBuildLockPath = resolveWorkspacePackageBuildLockPath(packageDir, packageJson);
  mkdirSync(join(packageDir, 'src'), { recursive: true });
  writeFileSync(join(packageDir, 'src', 'index.ts'), 'export const value = true;\n', 'utf8');
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify(packageJson), 'utf8');

  await ensureWorkspacePackagesBuiltByName(repoRoot, [packageJson.name], {
    force: true,
    quiet: true,
    workspaceBuildBoundary: {
      async prepareEnv(_packageDir, env) {
        return { ...env };
      },
      async runPackageBuild(_packageDir, { env }) {
        assert.equal(existsSync(workspaceBundleLockPath), false);
        assert.equal(existsSync(packageBuildLockPath), true);
        await withCliDistBuildLock(
          ({ inherited, heldLockValue }) => {
            assert.equal(inherited, true);
            assert.equal(heldLockValue, env.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD);
          },
          {
            lockPath: packageBuildLockPath,
            env,
          },
        );
        await writeFile(
          join(env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR, 'index.js'),
          'export const value = true;\n',
        );
      },
    },
  });
});

test('declared plugin UI artifacts participate in atomic workspace build admission', async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'happier-workspace-plugin-ui-admission-'));
  try {
    const packageDir = join(repoRoot, 'packages', 'inspector');
    mkdirSync(join(packageDir, 'src'), { recursive: true });
    mkdirSync(join(packageDir, 'dist'), { recursive: true });
    writePnpmWorkspaceFixture(repoRoot, { private: true, workspaces: ['apps/*', 'packages/*'] });
    writeFileSync(join(repoRoot, 'pnpm-lock.yaml'), '# fixture\n', 'utf8');
    for (const appName of ['ui', 'cli', 'server']) {
      const appDir = join(repoRoot, 'apps', appName);
      mkdirSync(appDir, { recursive: true });
      writeFileSync(
        join(appDir, 'package.json'),
        JSON.stringify({ name: `@fixture/${appName}`, private: true }),
        'utf8',
      );
    }
    writeFileSync(join(packageDir, 'src', 'index.ts'), 'export const inspector = true;\n', 'utf8');
    writeFileSync(join(packageDir, 'tsconfig.json'), '{}\n', 'utf8');
    writeFileSync(
      join(packageDir, 'package.json'),
      JSON.stringify({
        name: '@happier-dev/plugins-inspector',
        type: 'module',
        main: './dist/index.js',
        exports: {
          './happier-plugin-ui/*': './dist/happier-plugin-ui/*',
        },
        scripts: {
          build: 'fixture-build',
          'build:ui': 'happier-plugin-build-ui',
        },
      }),
      'utf8',
    );
    writeFileSync(join(packageDir, 'dist', 'index.js'), 'export const inspector = true;\n', 'utf8');
    mkdirSync(join(packageDir, 'dist', 'happier-plugin-ui'), { recursive: true });
    const priorChunkPath = join(packageDir, 'dist', 'happier-plugin-ui', 'prior.chunk.bundle');
    writeFileSync(priorChunkPath, 'prior generation\n', 'utf8');
    utimesSync(priorChunkPath, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    const priorChunkMtimeMs = statSync(priorChunkPath).mtimeMs;

    let buildCalls = 0;
    const result = await ensureWorkspacePackagesBuiltByName(
      repoRoot,
      ['@happier-dev/plugins-inspector'],
      {
        workspaceBuildBoundary: {
          async prepareEnv(_packageDir, env) {
            return { ...env };
          },
          async runPackageBuild(_packageDir, { env }) {
            buildCalls += 1;
            const outputDir = env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR;
            assert.equal(typeof outputDir, 'string');
            assert.equal(env.HAPPIER_WORKSPACE_PACKAGE_PREREQUISITES_READY, '1');
            await writeFile(join(outputDir, 'index.js'), 'export const inspector = "rebuilt";\n');
            mkdirSync(join(outputDir, 'happier-plugin-ui'), { recursive: true });
            await writeFile(
              join(outputDir, 'happier-plugin-ui', 'ui-artifacts.json'),
              '{"version":1,"entries":[]}\n',
            );
          },
        },
      },
    );

    assert.equal(buildCalls, 1);
    assert.deepEqual(result.built, ['@happier-dev/plugins-inspector']);
    assert.equal(existsSync(join(packageDir, 'dist', 'happier-plugin-ui', 'ui-artifacts.json')), true);
    assert.equal(
      existsSync(priorChunkPath),
      true,
      'live source publication must retain a prior content-addressed target for in-flight Metro graphs',
    );
    assert.equal(
      statSync(priorChunkPath).mtimeMs,
      priorChunkMtimeMs,
      'currentness refresh must not touch a retained live-only target',
    );

    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
    writeFileSync(join(packageDir, 'src', 'index.ts'), 'export const inspector = "new-source";\n', 'utf8');
    await ensureWorkspacePackagesBuiltByName(
      repoRoot,
      ['@happier-dev/plugins-inspector'],
      {
        workspaceBuildBoundary: {
          async prepareEnv(_packageDir, env) {
            return { ...env };
          },
          async runPackageBuild(_packageDir, { env }) {
            buildCalls += 1;
            const outputDir = env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR;
            await writeFile(join(outputDir, 'index.js'), 'export const inspector = "rebuilt";\n');
            mkdirSync(join(outputDir, 'happier-plugin-ui'), { recursive: true });
            await writeFile(
              join(outputDir, 'happier-plugin-ui', 'ui-artifacts.json'),
              '{"version":1,"entries":[]}\n',
            );
          },
        },
      },
    );
    await ensureWorkspacePackagesBuiltByName(
      repoRoot,
      ['@happier-dev/plugins-inspector'],
      {
        workspaceBuildBoundary: {
          async prepareEnv(_packageDir, env) {
            return { ...env };
          },
          async runPackageBuild() {
            buildCalls += 1;
            throw new Error('current live outputs should be admitted without a repeat build');
          },
        },
      },
    );
    assert.equal(buildCalls, 2, 'retained live-only wildcard targets must not keep a current output stale');

    await ensureWorkspacePackagesBuiltByName(
      repoRoot,
      ['@happier-dev/plugins-inspector'],
      {
        publicationMode: 'artifact',
        workspaceBuildBoundary: {
          async prepareEnv(_packageDir, env) {
            return { ...env };
          },
          async runPackageBuild(_packageDir, { env }) {
            const outputDir = env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR;
            await writeFile(join(outputDir, 'index.js'), 'export const inspector = "artifact";\n');
            mkdirSync(join(outputDir, 'happier-plugin-ui'), { recursive: true });
            await writeFile(
              join(outputDir, 'happier-plugin-ui', 'ui-artifacts.json'),
              '{"version":1,"entries":[]}\n',
            );
          },
        },
      },
    );
    assert.equal(
      existsSync(priorChunkPath),
      false,
      'artifact publication must prune retained live-only generations',
    );
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('a newer dist directory does not hide stale declared workspace outputs', async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'happier-workspace-declared-output-freshness-'));
  try {
    const packageDir = join(repoRoot, 'packages', 'codex');
    const sourceDir = join(packageDir, 'src');
    const distDir = join(packageDir, 'dist');
    mkdirSync(sourceDir, { recursive: true });
    mkdirSync(distDir, { recursive: true });
    writePnpmWorkspaceFixture(repoRoot, { private: true, workspaces: ['apps/*', 'packages/*'] });
    writeFileSync(join(repoRoot, 'pnpm-lock.yaml'), '# fixture\n', 'utf8');
    for (const appName of ['ui', 'cli', 'server']) {
      const appDir = join(repoRoot, 'apps', appName);
      mkdirSync(appDir, { recursive: true });
      writeFileSync(
        join(appDir, 'package.json'),
        JSON.stringify({ name: `@fixture/${appName}`, private: true }),
        'utf8',
      );
    }

    const packageJsonPath = join(packageDir, 'package.json');
    const tsconfigPath = join(packageDir, 'tsconfig.json');
    const sourcePath = join(sourceDir, 'manifest.ts');
    const indexOutputPath = join(distDir, 'index.js');
    const manifestOutputPath = join(distDir, 'manifest.js');
    // Windows exposes creation time as ctime, so create expected outputs before
    // inputs to make the filesystem-level stale-output fixture discriminating
    // on both Windows and POSIX hosts.
    writeFileSync(indexOutputPath, 'export const identity = "qualified";\n', 'utf8');
    writeFileSync(manifestOutputPath, 'export const identity = "qualified";\n', 'utf8');
    writeFileSync(sourcePath, 'export const identity = "local";\n', 'utf8');
    writeFileSync(tsconfigPath, '{}\n', 'utf8');
    writeFileSync(
      packageJsonPath,
      JSON.stringify({
        name: '@happier-dev/plugins-codex',
        type: 'module',
        main: './dist/index.js',
        exports: {
          '.': './dist/index.js',
          './manifest': './dist/manifest.js',
        },
        scripts: { build: 'fixture-build' },
      }),
      'utf8',
    );

    const staleOutputTime = new Date('2026-07-27T01:00:00.000Z');
    const currentSourceTime = new Date('2026-07-27T02:00:00.000Z');
    const misleadingDirectoryTime = new Date('2026-07-27T03:00:00.000Z');
    for (const outputPath of [indexOutputPath, manifestOutputPath]) {
      utimesSync(outputPath, staleOutputTime, staleOutputTime);
    }
    for (const inputPath of [sourcePath, tsconfigPath, packageJsonPath]) {
      utimesSync(inputPath, currentSourceTime, currentSourceTime);
    }
    utimesSync(distDir, misleadingDirectoryTime, misleadingDirectoryTime);

    let buildCalls = 0;
    const result = await ensureWorkspacePackagesBuiltByName(
      repoRoot,
      ['@happier-dev/plugins-codex'],
      {
        workspaceBuildBoundary: {
          async prepareEnv(_packageDir, env) {
            return { ...env };
          },
          async runPackageBuild(_packageDir, { env }) {
            buildCalls += 1;
            const outputDir = env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR;
            assert.equal(typeof outputDir, 'string');
            await writeFile(join(outputDir, 'index.js'), 'export const identity = "local";\n');
            await writeFile(join(outputDir, 'manifest.js'), 'export const identity = "local";\n');
          },
        },
      },
    );

    assert.equal(buildCalls, 1);
    assert.deepEqual(result.built, ['@happier-dev/plugins-codex']);

    // A post-build source write must invalidate the refreshed outputs even when
    // the dist directory presents a newer mtime. The ordering is derived from the
    // observed output refresh stamp: an immediate rewrite backdated with utimes
    // cannot prove staleness because several Linux filesystems do not advance
    // ctime within the same coarse tick (after ctime can equal the pre-rewrite
    // ctime), leaving that write unobservable to any timestamp predicate.
    // Stamping the rewritten source strictly after the observed outputs makes the
    // stale verdict filesystem-independent, and strict `>` admission turns a
    // granularity-collapsed equality into a converging rebuild rather than a pass.
    const refreshedOutputTimeMs = Math.floor(statSync(indexOutputPath).mtimeMs);
    const rewrittenSourceTime = new Date(refreshedOutputTimeMs + 1);
    const misleadingDirectoryTimeAfterBuild = new Date(refreshedOutputTimeMs + 60_000);
    writeFileSync(sourcePath, 'export const identity = "local-v2";\n', 'utf8');
    utimesSync(sourcePath, rewrittenSourceTime, rewrittenSourceTime);
    utimesSync(distDir, misleadingDirectoryTimeAfterBuild, misleadingDirectoryTimeAfterBuild);

    const restoredMtimeResult = await ensureWorkspacePackagesBuiltByName(
      repoRoot,
      ['@happier-dev/plugins-codex'],
      {
        workspaceBuildBoundary: {
          async prepareEnv(_packageDir, env) {
            return { ...env };
          },
          async runPackageBuild(_packageDir, { env }) {
            buildCalls += 1;
            const outputDir = env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR;
            assert.equal(typeof outputDir, 'string');
            await writeFile(join(outputDir, 'index.js'), 'export const identity = "local-v2";\n');
            await writeFile(join(outputDir, 'manifest.js'), 'export const identity = "local-v2";\n');
          },
        },
      },
    );

    assert.equal(buildCalls, 2);
    assert.deepEqual(restoredMtimeResult.built, ['@happier-dev/plugins-codex']);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('CLI artifact preparation rebuilds bundled outputs recreated after current source inputs', async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'happier-cli-build-shared-stale-newer-output-'));
  try {
    const codexDir = join(repoRoot, 'packages', 'plugins', 'codex');
    const codexSourceDir = join(codexDir, 'src');
    const codexDistDir = join(codexDir, 'dist');
    const testsDir = join(repoRoot, 'packages', 'tests');
    mkdirSync(codexSourceDir, { recursive: true });
    mkdirSync(codexDistDir, { recursive: true });
    mkdirSync(testsDir, { recursive: true });
    writePnpmWorkspaceFixture(repoRoot, {
        private: true,
        workspaces: ['apps/*', 'packages/*', 'packages/plugins/*'],
      });
    writeFileSync(join(repoRoot, 'pnpm-lock.yaml'), '# fixture\n', 'utf8');
    for (const appName of ['ui', 'cli', 'server']) {
      const appDir = join(repoRoot, 'apps', appName);
      mkdirSync(appDir, { recursive: true });
      writeFileSync(
        join(appDir, 'package.json'),
        JSON.stringify(appName === 'cli'
          ? {
              name: '@happier-dev/cli',
              private: true,
              bundledDependencies: ['@happier-dev/plugins-codex'],
              dependencies: { '@happier-dev/plugins-codex': '0.0.0' },
            }
          : { name: `@fixture/${appName}`, private: true }),
        'utf8',
      );
    }
    const heapLimitWrapperPath = join(repoRoot, 'apps', 'cli', 'scripts', 'withNodeHeapLimit.mjs');
    const bundledPluginGeneratorPath = join(
      repoRoot,
      'apps',
      'cli',
      'scripts',
      'build-owned',
      'generateBundledPluginEntries.ts',
    );
    mkdirSync(join(repoRoot, 'apps', 'cli', 'scripts'), { recursive: true });
    mkdirSync(join(repoRoot, 'apps', 'cli', 'scripts', 'build-owned'), { recursive: true });
    writeFileSync(
      heapLimitWrapperPath,
      [
        "import { spawnSync } from 'node:child_process';",
        'const [command, ...args] = process.argv.slice(2);',
        'const result = spawnSync(command, args, { stdio: \'inherit\', env: process.env });',
        'process.exit(result.status ?? 1);',
      ].join('\n') + '\n',
      'utf8',
    );
    writeFileSync(bundledPluginGeneratorPath, 'process.exit(0);\n', 'utf8');
    writeFileSync(
      join(codexDir, 'package.json'),
      JSON.stringify({
        name: '@happier-dev/plugins-codex',
        version: '0.0.0',
        type: 'module',
        main: './dist/index.js',
        exports: {
          '.': './dist/index.js',
          './manifest': './dist/manifest.js',
        },
        devDependencies: { '@happier-dev/tests': '0.0.0' },
        scripts: { build: 'fixture-build' },
        // Reservation-only keeps this fixture plugin out of generator-owned
        // membership, so artifact preparation force-rebuilds it through the
        // ordinary workspace compiler — the derivation contract this test
        // pins. A generator-owned plugin would instead be bound by the
        // pack-time source-artifact inventory, which only the canonical
        // publisher owns and this fixture deliberately does not stage.
        happier: { pluginScaffold: { shipping: 'reservation_only' } },
      }),
      'utf8',
    );
    writeFileSync(
      join(testsDir, 'package.json'),
      JSON.stringify({
        name: '@happier-dev/tests',
        private: true,
        type: 'module',
        exports: {
          './testkit/tls/ephemeralTlsServerFixture': './src/testkit/tls/ephemeralTlsServerFixture.mjs',
        },
      }),
      'utf8',
    );
    writeFileSync(join(codexDir, 'tsconfig.json'), '{}\n', 'utf8');
    writeFileSync(
      join(codexSourceDir, 'manifest.ts'),
      'export const identity = "codex";\n',
      'utf8',
    );

    // Recreate stale pre-correction outputs after the current source/config.
    // Their newer timestamps cannot prove that these bytes were derived.
    writeFileSync(
      join(codexDistDir, 'index.js'),
      'export const identity = "happier.agent.codex";\n',
      'utf8',
    );
    writeFileSync(
      join(codexDistDir, 'manifest.js'),
      'export const identity = "happier.agent.codex";\n',
      'utf8',
    );

    let buildCalls = 0;
    const helperBuildForceModes = [];
    let targetPreparedPackages = [];
    const ensureFixtureWorkspacePackagesBuilt = async (root, packageNames, options) => {
      if (root !== repoRoot) {
        helperBuildForceModes.push(options?.force === true);
        return { ok: true, built: [], skipped: [] };
      }
      return await ensureWorkspacePackagesBuiltByName(root, packageNames, {
        ...options,
        onPackageBuildStart: async (context) => {
          targetPreparedPackages.push(context.packageName);
          await options.onPackageBuildStart?.(context);
        },
        workspaceBuildBoundary: {
          async prepareEnv(_packageDir, env) {
            return { ...env };
          },
          async runPackageBuild(_packageDir, { env }) {
            buildCalls += 1;
            const outputDir = env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR;
            assert.equal(typeof outputDir, 'string');
            writeFileSync(
              join(outputDir, 'index.js'),
              'export const identity = "codex";\n',
              'utf8',
            );
            writeFileSync(
              join(outputDir, 'manifest.js'),
              'export const identity = "codex";\n',
              'utf8',
            );
          },
        },
      });
    };
    await buildBundledWorkspaceDependenciesForCli({
      repoRoot,
      workspaceNames: ['plugins-codex'],
      // Bootstrap outputs are usable for loading helpers, but they are not
      // derivation evidence for the final artifact closure.
      alreadyBuiltWorkspaceNames: new Set(['plugins-codex']),
      ensureWorkspacePackagesBuiltByNameImpl: ensureFixtureWorkspacePackagesBuilt,
    });

    assert.equal(buildCalls, 1);
    assert.deepEqual(targetPreparedPackages, ['@happier-dev/plugins-codex']);
    assert.match(readFileSync(join(codexDistDir, 'manifest.js'), 'utf8'), /"codex"/);

    // packTarball publishes workspace dependencies into an isolated snapshot
    // with lifecycle scripts disabled, so this artifact bundler must enforce
    // the same derivation contract independently of prebuild.
    writeFileSync(
      join(codexDistDir, 'index.js'),
      'export const identity = "happier.agent.codex";\n',
      'utf8',
    );
    writeFileSync(
      join(codexDistDir, 'manifest.js'),
      'export const identity = "happier.agent.codex";\n',
      'utf8',
    );
    await bundleWorkspaceDeps({
      repoRoot,
      happyCliDir: join(repoRoot, 'apps', 'cli'),
      publicationMode: 'artifact',
      ensureWorkspacePackagesBuiltByName: ensureFixtureWorkspacePackagesBuilt,
    });

    assert.equal(buildCalls, 2);
    assert.deepEqual(helperBuildForceModes, [false], 'helper loading uses content admission; artifact forcing belongs to the target closure');
    assert.match(
      readFileSync(
        join(
          repoRoot,
          'apps',
          'cli',
          'node_modules',
          '@happier-dev',
          'plugins-codex',
          'dist',
          'manifest.js',
        ),
        'utf8',
      ),
      /"codex"/,
    );
    assert.deepEqual(targetPreparedPackages, [
      '@happier-dev/plugins-codex',
      '@happier-dev/plugins-codex',
    ]);

    // Live publication uses the same content admission as artifact publication.
    targetPreparedPackages = [];
    writeFileSync(
      join(codexDistDir, 'index.js'),
      'export const identity = "happier.agent.codex";\n',
      'utf8',
    );
    writeFileSync(
      join(codexDistDir, 'manifest.js'),
      'export const identity = "happier.agent.codex";\n',
      'utf8',
    );
    await bundleWorkspaceDeps({
      repoRoot,
      happyCliDir: join(repoRoot, 'apps', 'cli'),
      publicationMode: 'live',
      ensureWorkspacePackagesBuiltByName: ensureFixtureWorkspacePackagesBuilt,
    });
    assert.equal(buildCalls, 3);
    assert.deepEqual(helperBuildForceModes, [false, false]);
    assert.deepEqual(targetPreparedPackages, ['@happier-dev/plugins-codex']);
    assert.match(readFileSync(join(codexDistDir, 'manifest.js'), 'utf8'), /"codex"/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('workspace build timeout kills descendant writers before releasing the package lock', async (t) => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'happier-workspace-build-timeout-tree-'));
  let writerPid = null;
  t.after(() => {
    if (writerPid) {
      try {
        process.kill(writerPid, 'SIGKILL');
      } catch {
        // The timeout cleanup should already have terminated this test-owned writer.
      }
    }
    rmSync(repoRoot, { recursive: true, force: true });
  });

  for (const appName of ['ui', 'cli', 'server']) {
    const appDir = join(repoRoot, 'apps', appName);
    mkdirSync(appDir, { recursive: true });
    writeFileSync(
      join(appDir, 'package.json'),
      JSON.stringify({ name: `@fixture/${appName}`, private: true }),
      'utf8',
    );
  }
  writePnpmWorkspaceFixture(repoRoot, { private: true, workspaces: ['apps/*', 'packages/*'] });
  writeFileSync(join(repoRoot, 'pnpm-lock.yaml'), '# fixture\n', 'utf8');

  const packageDir = join(repoRoot, 'packages', 'timeout-tree');
  mkdirSync(join(packageDir, 'src'), { recursive: true });
  writeFileSync(join(packageDir, 'src', 'index.ts'), 'export const value = true;\n', 'utf8');
  writeFileSync(
    join(packageDir, 'package.json'),
    JSON.stringify({
      name: '@happier-dev/timeout-tree',
      type: 'module',
      main: './dist/index.js',
      scripts: { build: 'fixture-build' },
    }),
    'utf8',
  );

  const heartbeatPath = join(repoRoot, 'descendant-heartbeat.txt');
  const writerPidPath = join(repoRoot, 'descendant-writer.pid');
  const writerSource = [
    "const { appendFileSync, writeFileSync } = require('node:fs');",
    'const [heartbeatPath, pidPath] = process.argv.slice(1);',
    "writeFileSync(pidPath, String(process.pid), 'utf8');",
    "appendFileSync(heartbeatPath, 'started\\n', 'utf8');",
    "setInterval(() => appendFileSync(heartbeatPath, 'tick\\n', 'utf8'), 20);",
  ].join('\n');
  const pnpmEntrypointPath = join(repoRoot, 'fixture-pnpm.cjs');
  writeFileSync(
    pnpmEntrypointPath,
    [
      "const { spawn } = require('node:child_process');",
      'const args = process.argv.slice(2);',
      "if (args.length === 1 && args[0] === '--version') process.exit(0);",
      "if (args[0] !== 'run' || args[1] !== '--silent' || args[2] !== 'build') process.exit(91);",
      `spawn(process.execPath, ['-e', ${JSON.stringify(writerSource)}, ${JSON.stringify(heartbeatPath)}, ${JSON.stringify(writerPidPath)}], { stdio: 'ignore' });`,
      'setInterval(() => {}, 1_000);',
    ].join('\n') + '\n',
    'utf8',
  );

  const native = await installWorkspaceAdmissionProcessFixture(t, repoRoot);
  const env = {
    ...native.env,
    npm_execpath: pnpmEntrypointPath,
  };
  let timeoutError = null;
  await assert.rejects(
    ensureWorkspacePackagesBuiltByName(
      repoRoot,
      ['@happier-dev/timeout-tree'],
      // The remote validation hosts can be heavily loaded. Keep the deadline short enough to
      // exercise timeout cleanup, but long enough for the fixture's descendant to start and
      // publish its process identity before cleanup is assessed.
      { env, force: true, quiet: true, timeoutMs: 5_000 },
    ),
    (error) => {
      timeoutError = error;
      return error?.code === 'ETIMEDOUT';
    },
  );
  assert.equal(timeoutError?.cleanup, undefined, 'process-tree cleanup must be confirmed');

  writerPid = Number(readFileSync(writerPidPath, 'utf8'));
  assert.ok(Number.isInteger(writerPid) && writerPid > 1, 'expected a test-owned descendant pid');
  const heartbeatAtRejection = readFileSync(heartbeatPath, 'utf8');
  assert.equal(
    existsSync(join(
      repoRoot,
      '.project',
      'tmp',
      'workspace-dist-builds',
      'happier-dev-timeout-tree.lock',
    )),
    false,
    'the package build lock should be released when the timeout rejects',
  );
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
  assert.equal(
    readFileSync(heartbeatPath, 'utf8'),
    heartbeatAtRejection,
    'a timed-out descendant must not keep writing after lock release',
  );
});

test('quiet workspace builds retain bounded child diagnostics when the build fails', async (t) => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'happier-workspace-build-quiet-diagnostic-'));
  t.after(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  for (const appName of ['ui', 'cli', 'server']) {
    const appDir = join(repoRoot, 'apps', appName);
    mkdirSync(appDir, { recursive: true });
    writeFileSync(
      join(appDir, 'package.json'),
      JSON.stringify({ name: `@fixture/${appName}`, private: true }),
      'utf8',
    );
  }
  writePnpmWorkspaceFixture(repoRoot, { private: true, workspaces: ['apps/*', 'packages/*'] });
  writeFileSync(join(repoRoot, 'pnpm-lock.yaml'), '# fixture\n', 'utf8');

  const packageDir = join(repoRoot, 'packages', 'quiet-diagnostic');
  mkdirSync(join(packageDir, 'src'), { recursive: true });
  writeFileSync(join(packageDir, 'src', 'index.ts'), 'export const value = true;\n', 'utf8');
  writeFileSync(
    join(packageDir, 'package.json'),
    JSON.stringify({
      name: '@happier-dev/quiet-diagnostic',
      type: 'module',
      main: './dist/index.js',
      scripts: { build: 'fixture-build' },
    }),
    'utf8',
  );

  const pnpmEntrypointPath = join(repoRoot, 'fixture-quiet-failure-pnpm.cjs');
  writeFileSync(
    pnpmEntrypointPath,
    [
      'const args = process.argv.slice(2);',
      "if (args.length === 1 && args[0] === '--version') process.exit(92);",
      "if (args[0] !== 'run' || args[1] !== '--silent' || args[2] !== 'build') process.exit(91);",
      "process.stdout.write('stdout-head\\n' + 'x'.repeat(10_000) + 'stdout-tail\\n');",
      "process.stderr.write('stderr-head\\n' + 'y'.repeat(10_000) + 'stderr-tail\\n');",
      'process.exit(37);',
    ].join('\n') + '\n',
    'utf8',
  );

  let failure = null;
  const native = await installWorkspaceAdmissionProcessFixture(t, repoRoot);
  await assert.rejects(
    ensureWorkspacePackagesBuiltByName(
      repoRoot,
      ['@happier-dev/quiet-diagnostic'],
      {
        env: { ...native.env, npm_execpath: pnpmEntrypointPath },
        force: true,
        quiet: true,
      },
    ),
    (error) => {
      failure = error;
      return error?.code === 'EEXIT';
    },
  );

  assert.match(failure?.message ?? '', /failed \(code=37, sig=null\)/);
  assert.match(failure?.message ?? '', /Child output \(tail; earlier output omitted\):/);
  assert.match(failure?.message ?? '', /\[stdout\]\n[\s\S]*stdout-tail/);
  assert.match(failure?.message ?? '', /\[stderr\]\n[\s\S]*stderr-tail/);
  assert.doesNotMatch(failure?.message ?? '', /stdout-head|stderr-head/);
  assert.ok((failure?.message.length ?? 0) < 17_000, 'expected a bounded failure diagnostic');
});

test('Stack workspace build boundary propagates timeoutMs to the package-manager build', async (t) => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'happier-stack-workspace-build-timeout-'));
  t.after(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  for (const appName of ['ui', 'cli', 'server']) {
    const appDir = join(repoRoot, 'apps', appName);
    mkdirSync(appDir, { recursive: true });
    writeFileSync(
      join(appDir, 'package.json'),
      JSON.stringify({ name: `@fixture/${appName}`, private: true }),
      'utf8',
    );
  }
  writePnpmWorkspaceFixture(repoRoot, { private: true, workspaces: ['apps/*', 'packages/*'] });
  writeFileSync(join(repoRoot, 'pnpm-lock.yaml'), '# fixture\n', 'utf8');

  const packageDir = join(repoRoot, 'packages', 'stack-timeout');
  mkdirSync(join(packageDir, 'src'), { recursive: true });
  writeFileSync(join(packageDir, 'src', 'index.ts'), 'export const value = true;\n', 'utf8');
  writeFileSync(
    join(packageDir, 'package.json'),
    JSON.stringify({
      name: '@happier-dev/stack-timeout',
      type: 'module',
      main: './dist/index.js',
      scripts: { build: 'fixture-build' },
    }),
    'utf8',
  );

  const pnpmEntrypointPath = join(repoRoot, 'fixture-stack-pnpm.cjs');
  writeFileSync(
    pnpmEntrypointPath,
    [
      "const { mkdirSync, writeFileSync } = require('node:fs');",
      "const { join } = require('node:path');",
      'const args = process.argv.slice(2);',
      "if (args.length === 1 && args[0] === '--version') process.exit(0);",
      "if (args[0] !== 'run' || args[1] !== '--silent' || args[2] !== 'build') process.exit(91);",
      'setTimeout(() => {',
      '  const outDir = process.env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR;',
      '  mkdirSync(outDir, { recursive: true });',
      "  writeFileSync(join(outDir, 'index.js'), 'export const late = true;\\n', 'utf8');",
      '  process.exit(0);',
      '}, 500);',
    ].join('\n') + '\n',
    'utf8',
  );
  const binDir = join(repoRoot, 'bin');
  mkdirSync(binDir, { recursive: true });
  const pnpmCommandPath = join(binDir, process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm');
  writeFileSync(
    pnpmCommandPath,
    process.platform === 'win32'
      ? `@${JSON.stringify(process.execPath)} ${JSON.stringify(pnpmEntrypointPath)} %*\r\n`
      : `#!${process.execPath}\nrequire(${JSON.stringify(pnpmEntrypointPath)});\n`,
    'utf8',
  );
  chmodSync(pnpmCommandPath, 0o755);

  const native = await installWorkspaceAdmissionProcessFixture(t, repoRoot);
  await assert.rejects(
    ensureStackWorkspacePackagesBuiltByName(
      repoRoot,
      ['@happier-dev/stack-timeout'],
      {
        env: { ...native.env, PATH: `${binDir}${delimiter}${native.env.PATH ?? ''}` },
        force: true,
        quiet: true,
        timeoutMs: 100,
      },
    ),
  );
});
