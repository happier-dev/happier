import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, watch, writeFileSync } from 'node:fs';
import { cp, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { registerHooks } from 'node:module';
import { dirname, isAbsolute, join, posix, relative, resolve, sep, win32 } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

import { buildTypeScriptPackageDist } from './buildTypeScriptPackageDist.mjs';
import { BUILD_INPUT_RECORD, defaultWorkspaceBuildBoundary, ensureWorkspacePackagesBuiltByName, isWorkspacePackageOutputCurrent } from './ensureWorkspacePackagesBuilt.mjs';
import { withWorkspaceBundleLock } from './workspaceBundleLock.mjs';
import { resolveWorkspacePackageBuildLockPath } from './workspacePackageBuildLock.mjs';
import { resolveTypeScriptCliInvocation } from './resolveTypeScriptCliInvocation.mjs';
import { runCaptureResult } from '../../apps/stack/scripts/utils/proc/proc.mjs';
import { buildNativeAdmissionFixtureEnv, installNativeAdmissionFixture } from '../../apps/stack/scripts/testkit/core/native_admission_fixture.mjs';
import { writeFakeBin } from '../../apps/stack/scripts/testkit/core/fake_bin_harness.mjs';
import { spawnTestProcess } from '../../apps/stack/scripts/testkit/core/spawn_test_process.mjs';
import { withPatchedProcessEnv } from '../../apps/stack/scripts/testkit/core/env_scope.mjs';

for (const [platform, paths, packageDir, caseSensitive] of [
  ['Windows', win32, 'C:\\Work\\Package', false],
  ['Linux', posix, '/work/package', true],
]) {
  test(`compiler output pruning retains live ${platform} emits and removes retired files`, async (t) => {
    const workDir = paths.join(packageDir, '.happier', 'compiler');
    const outputDir = paths.join(workDir, 'dist');
    const tsBuildInfoFile = paths.join(workDir, '.tsbuildinfo');
    const projectPath = paths.join(packageDir, 'tsconfig.json');
    const fileId = (path) => {
      const normalized = ts.normalizePath(paths.resolve(path));
      return caseSensitive ? normalized : normalized.toLowerCase();
    };
    const files = new Map();
    const put = (path, content) => files.set(fileId(path), { path, content });
    put(paths.join(workDir, 'tsconfig.dist.json'), JSON.stringify({
      compilerOptions: { rootDir: paths.join(packageDir, 'src'), outDir: outputDir,
        declaration: true, declarationMap: true, sourceMap: true },
      files: [paths.join(packageDir, 'src', 'index.ts')],
    }));
    // Incremental metadata and directory enumeration can spell the same
    // Windows path differently. Exercise real TS config/output computation;
    // substitute only filesystem and platform adapters beneath the prune.
    const sourceBase = caseSensitive ? packageDir : packageDir.toLowerCase();
    put(tsBuildInfoFile, JSON.stringify({ fileNames: [
      paths.join(sourceBase, 'src', 'index.ts'),
      paths.join(sourceBase, 'src', 'nested', 'module.ts'),
    ] }));
    put(paths.join(packageDir, 'src', 'index.ts'), 'export {};');
    put(paths.join(packageDir, 'src', 'nested', 'module.ts'), 'export {};');
    const liveOutputs = ['index', paths.join('nested', caseSensitive ? 'module' : 'Module')]
      .flatMap(name => ['.js', '.js.map', '.d.ts', '.d.ts.map'].map(suffix => paths.join(outputDir, `${name}${suffix}`)));
    for (const path of liveOutputs) put(path, 'emitted');
    const retiredPath = paths.join(outputDir, 'nested', 'retired.js');
    put(retiredPath, 'retired');
    // Case-sensitive hosts must still retire a stale differently-cased emit.
    const staleCasePath = paths.join(outputDir, 'Index.js');
    if (caseSensitive) put(staleCasePath, 'retired');
    const read = path => files.get(fileId(path))?.content;
    const removed = [];
    const boundary = {
      paths,
      fs: { existsSync: path => files.has(fileId(path)), readFileSync: read },
      asyncFs: {
        async readdir(directory) {
          const entries = new Map();
          for (const { path } of files.values()) {
            const relation = paths.relative(directory, path);
            if (!relation || relation.startsWith('..') || paths.isAbsolute(relation)) continue;
            const [name, ...rest] = relation.split(paths.sep);
            entries.set(name, { name, isDirectory: () => rest.length > 0 });
          }
          return [...entries.values()];
        },
        async rm(path) { removed.push(path); files.delete(fileId(path)); },
      },
      ts: { ...ts, sys: { ...ts.sys, useCaseSensitiveFileNames: caseSensitive,
        readFile: read, fileExists: path => files.has(fileId(path)),
        getCurrentDirectory: () => packageDir } },
    };
    const boundaryName = `happier.prune-test.${platform}`;
    globalThis[Symbol.for(boundaryName)] = boundary;
    const ownerUrl = new URL(`./pruneRetiredCompilerOutputs.mjs?${platform}`, import.meta.url).href;
    const exports = {
      'node:path': ['paths', ['dirname', 'join', 'resolve']],
      'node:fs': ['fs', ['existsSync', 'readFileSync']],
      'node:fs/promises': ['asyncFs', ['readdir', 'rm']],
      typescript: ['ts', ['default']],
    };
    const hooks = registerHooks({
      resolve(specifier, context, nextResolve) {
        if (context.parentURL !== ownerUrl || !exports[specifier]) return nextResolve(specifier, context);
        const [adapter, names] = exports[specifier];
        const reference = `globalThis[Symbol.for(${JSON.stringify(boundaryName)})].${adapter}`;
        const source = names.map(name => name === 'default'
          ? `export default ${reference};` : `export const ${name} = ${reference}.${name};`).join('\n');
        return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
      },
    });
    t.after(() => { hooks.deregister(); delete globalThis[Symbol.for(boundaryName)]; });
    const { pruneRetiredCompilerOutputs } = await import(ownerUrl);
    await pruneRetiredCompilerOutputs({ packageDir, compilerWorkTree: { workDir, outputDir, tsBuildInfoFile, projectPath }, compilerArgs: [] });
    assert.deepEqual(liveOutputs.filter(path => files.has(fileId(path))), liveOutputs,
      'pruning must retain every live JavaScript, declaration and map output');
    assert.deepEqual(removed.sort(), [retiredPath, ...(caseSensitive ? [staleCasePath] : [])].sort());
  });
}

async function createNativeDistBuildFixture(t) {
  const packageDir = await createPackageFixture(t, 'native-dist-admission');
  await writeFile(join(packageDir, 'src', 'index.ts'), 'export const built = true;\n');
  const native = await installNativeAdmissionFixture({ root: packageDir });
  const { launcher, admissionRoot } = native;
  await Promise.all(['owners', 'waiters'].map(kind => mkdir(join(admissionRoot, kind), { recursive: true })));
  const memoryPath = join(packageDir, 'memory');
  await writeFile(memoryPath, '1 73400320\n');
  writeFakeBin({ root: packageDir, name: 'awk', content: `#!/bin/sh
case "$*" in
  */proc/meminfo*) /usr/bin/awk '{print $1, $2}' "$FIXTURE_MEMORY" ;;
  *) exec /usr/bin/awk "$@" ;;
esac
` });
  writeFakeBin({ root: packageDir, name: 'systemctl', content: '#!/bin/sh\nexit 1\n' });
  writeFakeBin({ root: packageDir, name: 'sleep', content: '#!/bin/sh\nexec /bin/sleep 0.02\n' });
  const compilerBoundaryPath = join(packageDir, 'compiler-boundary.mjs');
  await writeFile(compilerBoundaryPath, `import { resolveTypeScriptCliInvocation as resolveOwner } from ${JSON.stringify(new URL('./resolveTypeScriptCliInvocation.mjs', import.meta.url).href)};
export * from ${JSON.stringify(new URL('./resolveTypeScriptCliInvocation.mjs', import.meta.url).href)};
export function resolveTypeScriptCliInvocation(options) {
  const invocation = resolveOwner(options);
  return { ...invocation, ...(invocation.command.endsWith('/hstack-exec') ? { command: ${JSON.stringify(launcher)} } : {}) };
}
`);
  // Remap only the worker's physical admission/command endpoints. The public
  // dist API, compiler policy, real compiler, leases and promotion stay real.
  const loaderPath = join(packageDir, 'native-boundary-loader.mjs');
  await writeFile(loaderPath, `export async function resolve(specifier, context, next) {
  if (context.parentURL?.endsWith('/buildTypeScriptPackageDist.mjs')) {
    if (specifier.endsWith('/proc/workspace_build_admission.mjs')) return { url: ${JSON.stringify(pathToFileURL(join(packageDir, 'native-owner/apps/stack/scripts/utils/proc/workspace_build_admission.mjs')).href)}, shortCircuit: true };
    if (specifier === './resolveTypeScriptCliInvocation.mjs') return { url: ${JSON.stringify(pathToFileURL(compilerBoundaryPath).href)}, shortCircuit: true };
  }
  return next(specifier, context);
}
`);
  const apiScriptPath = join(packageDir, 'api.mjs');
  await writeFile(apiScriptPath, `import { buildTypeScriptPackageDist } from ${JSON.stringify(new URL('./buildTypeScriptPackageDist.mjs', import.meta.url).href)};
try {
  const result = await buildTypeScriptPackageDist({ packageDir: ${JSON.stringify(packageDir)}, args: ['-p', 'tsconfig.json', '--noCheck'], stdio: process.env.FIXTURE_STDIO || 'inherit' });
  process.stdout.write(JSON.stringify(result));
} catch (error) {
  process.stdout.write(JSON.stringify({ failed: true, exitCode: error.exitCode, signal: error.signal }));
  process.exitCode = error.exitCode ?? 1;
}
`);
  const env = { ...buildNativeAdmissionFixtureEnv(),
    PATH: `${join(packageDir, 'bin')}:${dirname(process.execPath)}:/usr/bin:/bin`, FIXTURE_MEMORY: memoryPath,
    NODE_OPTIONS: `--experimental-loader=${loaderPath}`, CI: '', HAPPIER_DEV_TARGET_EXECUTION: '1',
    HAPPIER_STACK_PM_CACHE_BASE_DIR: '', HAPPIER_WORKSPACE_DIST_OUTPUT_DIR: '',
    HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD: '', HAPPIER_WORKSPACE_DIST_BUILD_LOCK_LEASES: '',
    HAPPIER_HEAVYWEIGHT_ADMISSION_TOKEN: '', HAPPIER_HEAVYWEIGHT_ADMISSION_ROOT: '', HAPPIER_HEAVYWEIGHT_ADMISSION_MACHINE: '',
    HAPPIER_WORKSPACE_BUILD_MODE: 'strict',
  };
  const entries = kind => readdir(join(admissionRoot, kind));
  const start = (extraEnv = {}, args = [apiScriptPath], command = process.execPath) => {
    const child = spawnTestProcess(command, args, { cwd: packageDir, env: { ...env, ...extraEnv }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const exited = new Promise(resolveExit => child.once('close', (status, signal) => resolveExit({ status, signal })));
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) process.kill(-child.pid, 'SIGTERM');
      await exited;
    });
    return { child, exited, stdout: () => stdout, stderr: () => stderr };
  };
  return { packageDir, launcher, admissionRoot, memoryPath, loaderPath, entries, start };
}

async function waitForNativeDistBuildState(fixture, run, condition) {
  await new Promise((resolveReady, reject) => {
    let checking = false;
    const cleanup = () => {
      for (const watcher of watchers) watcher.close();
      run.child.stderr.off('data', check);
      run.child.off('close', failed);
    };
    const failed = () => { cleanup(); reject(new Error(`dist build exited before the expected state: ${run.stderr()}`)); };
    const check = async () => {
      if (checking) return;
      checking = true;
      try { if (await condition()) { cleanup(); resolveReady(); } }
      catch (error) { cleanup(); reject(error); }
      finally { checking = false; }
    };
    const watchers = [fixture.packageDir, fixture.admissionRoot, join(fixture.admissionRoot, 'waiters')]
      .map(path => watch(path, check));
    run.child.stderr.on('data', check);
    run.child.once('close', failed);
    void check();
  });
}

test('public hstack finite dist producer waits for its package lease without an outer admission envelope', { skip: process.platform !== 'linux' }, async t => {
  const fixture = await createNativeDistBuildFixture(t);
  const source = new URL('./buildTypeScriptPackageDist.mjs', import.meta.url);
  const fixtureRepo = resolve(dirname(fixture.launcher), '../../..');
  const entry = join(fixtureRepo, 'scripts/workspaces/buildTypeScriptPackageDist.mjs');
  await mkdir(dirname(entry), { recursive: true });
  await cp(source, entry);
  // Replace only this fixture's disk-observation footprint with the real
  // compiler dependency tree required by its physical producer entry.
  await rm(join(fixtureRepo, 'node_modules'), { recursive: true });
  await symlink(fileURLToPath(new URL('../../node_modules', import.meta.url)), join(fixtureRepo, 'node_modules'), 'dir');
  // The physical entry is the actual finite producer. Remap its relative
  // imports back to source, retaining the existing real compiler endpoints.
  const loader = await readFile(fixture.loaderPath, 'utf8');
  await writeFile(fixture.loaderPath, loader.replace('  return next(specifier, context);',
    `  if (context.parentURL === ${JSON.stringify(pathToFileURL(entry).href)} && specifier.startsWith('.')) return next(new URL(specifier, ${JSON.stringify(source.href)}).href, context);\n  return next(specifier, context);`));
  writeFakeBin({ root: fixture.packageDir, name: 'node', content: `#!/bin/sh
case "$*" in
  *remote_dependency_bootstrap.mjs*|*remote_validation_preparation.mjs*) exit 0 ;;
  *) exec '${process.execPath}' "$@" ;;
esac
` });
  await writeFile(fixture.memoryPath, '31457280 73400320\n');
  const packageJson = JSON.parse(await readFile(join(fixture.packageDir, 'package.json'), 'utf8'));
  const lockPath = resolveWorkspacePackageBuildLockPath(fixture.packageDir, packageJson);
  let entered, release;
  const ready = new Promise(resolveReady => { entered = resolveReady; });
  const holder = withWorkspaceBundleLock(async () => { entered(); await new Promise(resolveRelease => { release = resolveRelease; }); }, { lockPath });
  await ready;
  const run = fixture.start({ HAPPIER_DEV_TARGET_EXECUTION: '', HAPPIER_HSTACK_EXECUTION: '',
    HAPPIER_WORKSPACE_DIST_BUILD_LOCK_WAIT_ALLOWED: '' },
  [fixture.launcher, '--local', '--allow-local-compilation', '--', process.execPath, entry, '-p', 'tsconfig.json'], '/bin/sh');
  try {
    // Joint admission tries leases without waiting inside the lock owner, so it
    // queues at the native owner rather than creating a lock priority claim.
    await waitForNativeDistBuildState(fixture, run, async () =>
      (await fixture.entries('waiters')).length === 1
      && run.stderr().includes('Workspace publication lease is busy:'));
    assert.deepEqual(await fixture.entries('owners'), []);
    assert.equal((await fixture.entries('waiters')).length, 1);
    release();
    await holder;
    assert.deepEqual(await run.exited, { status: 0, signal: null }, run.stderr());
    assert.match(await readFile(join(fixture.packageDir, 'dist/index.js'), 'utf8'), /built/);
    assert.deepEqual(await fixture.entries('owners'), []);
  } finally { release(); await holder; }
});

test('standalone dist API waits for package leases without reserving capacity and releases leases while capacity is unavailable', { skip: process.platform !== 'linux' }, async t => {
  const fixture = await createNativeDistBuildFixture(t);
  const packageJson = JSON.parse(await readFile(join(fixture.packageDir, 'package.json'), 'utf8'));
  const lockPath = resolveWorkspacePackageBuildLockPath(fixture.packageDir, packageJson);
  let entered, release;
  const ready = new Promise(resolveReady => { entered = resolveReady; });
  const holder = withWorkspaceBundleLock(async () => { entered(); await new Promise(resolveRelease => { release = resolveRelease; }); }, { lockPath });
  await ready;
  const run = fixture.start();
  try {
    await waitForNativeDistBuildState(fixture, run, async () =>
      (await fixture.entries('waiters')).length === 1
      && run.stderr().includes('Workspace publication lease is busy:'));
    assert.equal((await fixture.entries('waiters')).length, 1, 'the public API must enter joint admission before waiting for a foreign package lease');
    assert.deepEqual(await fixture.entries('owners'), []);
    release();
    await holder;
    await waitForNativeDistBuildState(fixture, run, () =>
      run.stderr().includes('memory-available=') && !existsSync(lockPath));
    assert.match(run.stderr(), /class=compilation/, 'effective strict options must govern outer admission despite a raw --noCheck');
    assert.equal(existsSync(lockPath), false, 'a capacity waiter must release its package lease');
    await withWorkspaceBundleLock(async () => {
      assert.deepEqual(await fixture.entries('owners'), []);
      assert.equal(run.stdout(), '');
      await writeFile(fixture.memoryPath, '31457280 73400320\n');
    }, { lockPath });
    assert.deepEqual(await run.exited, { status: 0, signal: null }, run.stderr());
    assert.deepEqual(JSON.parse(run.stdout()), { outputDir: join(fixture.packageDir, 'dist'), promoted: true });
    assert.match(await readFile(join(fixture.packageDir, 'dist/index.js'), 'utf8'), /built/);
    assert.deepEqual(await fixture.entries('owners'), []);
    assert.deepEqual(await fixture.entries('waiters'), []);
    assert.equal(existsSync(lockPath), false);
    const repeated = fixture.start({ HAPPIER_WORKSPACE_BUILD_MODE: 'source-dev' });
    assert.deepEqual(await repeated.exited, { status: 0, signal: null }, repeated.stderr());
    assert.deepEqual(JSON.parse(repeated.stdout()), { outputDir: join(fixture.packageDir, 'dist'), promoted: false });
    const lastGreen = await hashFixtureDist(join(fixture.packageDir, 'dist'));
    await writeFile(join(fixture.packageDir, 'src/index.ts'), 'export const broken: string = 1;\n');
    const failed = fixture.start({ FIXTURE_STDIO: 'ignore' });
    assert.deepEqual(await failed.exited, { status: 2, signal: null }, failed.stderr());
    assert.deepEqual(JSON.parse(failed.stdout()), { failed: true, exitCode: 2, signal: null });
    assert.equal(await hashFixtureDist(join(fixture.packageDir, 'dist')), lastGreen, 'worker failure must preserve published dist');
    assert.deepEqual(await fixture.entries('owners'), []);
    assert.deepEqual(await fixture.entries('waiters'), []);
    assert.equal(existsSync(lockPath), false);
    await writeFile(fixture.memoryPath, '1 73400320\n');
    const ci = fixture.start({ CI: '1', HAPPIER_DEV_TARGET_EXECUTION: '',
      HAPPIER_WORKSPACE_BUILD_MODE: 'source-dev', FIXTURE_STDIO: 'ignore' });
    assert.deepEqual(await ci.exited, { status: 0, signal: null }, ci.stderr());
    assert.deepEqual(JSON.parse(ci.stdout()), { outputDir: join(fixture.packageDir, 'dist'), promoted: true });
    assert.deepEqual(await fixture.entries('owners'), []);
    assert.deepEqual(await fixture.entries('waiters'), []);
  } finally { release(); await holder; }
});

test('private dist worker rejects absent and unrelated inherited package leases', { skip: process.platform !== 'linux' }, async t => {
  const fixture = await createNativeDistBuildFixture(t);
  const args = [fileURLToPath(new URL('./buildTypeScriptPackageDist.mjs', import.meta.url)), '--happier-dist-build-worker', JSON.stringify({ args: ['-p', 'tsconfig.json'], stdio: 'ignore' })];
  const lastGreen = await hashFixtureDist(join(fixture.packageDir, 'dist'));
  for (const heldLockValue of ['', 'forged-lease']) {
    const run = fixture.start({ HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD: heldLockValue }, args);
    assert.deepEqual(await run.exited, { status: 1, signal: null }, run.stderr());
    assert.match(run.stderr(), /requires its authenticated inherited package lease/);
  }
  await withWorkspaceBundleLock(async ({ heldLockValue }) => {
    const run = fixture.start({ HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD: heldLockValue,
      HAPPIER_WORKSPACE_DIST_BUILD_LOCK_LEASES: JSON.stringify([heldLockValue]) }, args);
    assert.deepEqual(await run.exited, { status: 1, signal: null }, run.stderr());
    assert.match(run.stderr(), /requires its authenticated inherited package lease/);
  }, { lockPath: join(fixture.packageDir, 'unrelated.lock') });
  assert.equal(await hashFixtureDist(join(fixture.packageDir, 'dist')), lastGreen);
  assert.equal(existsSync(join(fixture.packageDir, '.happier')), false);
  assert.deepEqual(await fixture.entries('owners'), []);
});

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

async function createPackageFixture(t, name) {
  const root = await mkdtemp(join(tmpdir(), `happier-${name}-`));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  await mkdir(join(root, 'src'), { recursive: true });
  await mkdir(join(root, 'dist'), { recursive: true });
  await writeJson(join(root, 'package.json'), {
    name: `@happier-dev/${name}`,
    type: 'module',
    main: './dist/index.js',
    types: './dist/index.d.ts',
    exports: { '.': { default: './dist/index.js', types: './dist/index.d.ts' } },
  });
  await writeJson(join(root, 'tsconfig.json'), {
    compilerOptions: {
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'Bundler',
      rootDir: 'src',
      outDir: 'dist',
      declaration: true,
      strict: true,
      skipLibCheck: true,
    },
    include: ['src/**/*.ts'],
  });
  await writeFile(join(root, 'dist', 'index.js'), 'export const stable = true;\n', 'utf-8');
  await writeFile(join(root, 'dist', 'index.d.ts'), 'export declare const stable: boolean;\n', 'utf-8');

  return root;
}

async function createPackageFixtureWithUiArtifacts(t, name) {
  const packageDir = await createPackageFixture(t, name);
  const packageJsonPath = join(packageDir, 'package.json');
  const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf-8'));
  packageJson.exports['./happier-plugin-ui/*'] = './dist/happier-plugin-ui/*';
  packageJson.scripts = {
    build: 'fixture-build',
    'build:ui': 'fixture-build-ui',
  };
  await writeJson(packageJsonPath, packageJson);
  await mkdir(join(packageDir, 'dist', 'happier-plugin-ui'), { recursive: true });
  await writeFile(
    join(packageDir, 'dist', 'happier-plugin-ui', 'ui-artifacts.json'),
    '{"version":1,"entries":["known-good"]}\n',
    'utf-8',
  );
  return packageDir;
}

function writeTypeScriptFixtureOutput(args) {
  const outDir = args[args.indexOf('--outDir') + 1];
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'index.js'), 'export const built = true;\n', 'utf-8');
  writeFileSync(join(outDir, 'index.d.ts'), 'export declare const built: boolean;\n', 'utf-8');
  return outDir;
}

async function hashFixtureDist(distDir) {
  const hash = createHash('sha256');
  for (const relativePath of ['index.js', 'index.d.ts']) {
    hash.update(relativePath);
    hash.update(await readFile(join(distDir, relativePath)));
  }
  return hash.digest('hex');
}

function isPathInside(parentPath, candidatePath) {
  const relation = relative(parentPath, candidatePath);
  return relation === '' || (
    relation !== '..'
    && !relation.startsWith(`..${sep}`)
    && !isAbsolute(relation)
  );
}

function resolveMapSourcePath(mapPath, sourceRoot, source) {
  return resolve(dirname(mapPath), typeof sourceRoot === 'string' ? sourceRoot : '', source);
}

test('buildTypeScriptPackageDist excludes type tests while the original project still checks them', async (t) => {
  const packageDir = await createPackageFixture(t, 'build-ts-package-type-tests');
  const projectPath = join(packageDir, 'tsconfig.json');
  const originalConfig = await readFile(projectPath, 'utf-8');
  const config = JSON.parse(originalConfig);
  config.compilerOptions.incremental = true;
  config.compilerOptions.jsx = 'preserve';
  config.compilerOptions.rootDir = '../src';
  config.compilerOptions.outDir = '../dist';
  config.include = ['../src/**/*.ts', '../src/**/*.tsx'];
  config.exclude = ['../src/**/*.test.ts', '../src/**/*.spec.ts', '../src/**/*.testSupport.ts'];
  // Inheritance must keep the package's existing exclusions and relative paths.
  await mkdir(join(packageDir, 'config'));
  await writeJson(join(packageDir, 'config', 'tsconfig.base.json'), config);
  await writeJson(projectPath, { extends: './config/tsconfig.base.json' });
  const unchangedConfig = await readFile(projectPath, 'utf-8');
  await writeFile(join(packageDir, 'src', 'index.ts'), 'export const built = true;\n');
  for (const suffix of ['test.ts', 'spec.ts', 'testSupport.ts']) {
    await writeFile(join(packageDir, 'src', `excluded.${suffix}`), 'const broken: string = 1;\nexport {};\n');
  }
  const invocation = resolveTypeScriptCliInvocation({});
  const compile = (args) => runCaptureResult(invocation.command, [...invocation.argsPrefix, ...args], {
    cwd: packageDir, ownedProcessGroup: true,
  });
  for (const suffix of ['test-d.ts', 'test-d.tsx']) {
    await writeFile(join(packageDir, 'src', `${suffix.endsWith('tsx') ? 'jsx-contract' : 'contract'}.${suffix}`), 'export const checked = true;\n');
  }
  const baselineDir = join(packageDir, '.baseline');
  assert.equal((await compile(['-p', projectPath, '--outDir', baselineDir])).exitCode, 0);
  const baselineFiles = await readdir(baselineDir);
  assert.ok(baselineFiles.some((name) => name.includes('.test-d.')));
  await cp(baselineDir, join(packageDir, 'dist'), { recursive: true });

  for (const suffix of ['test-d.ts', 'test-d.tsx']) {
    await writeFile(join(packageDir, 'src', `${suffix.endsWith('tsx') ? 'jsx-contract' : 'contract'}.${suffix}`), 'export const checked: string = 1;\n');
  }
  const typecheck = await compile(['--noEmit', '-p', projectPath]);
  assert.ok(Number.isInteger(typecheck.exitCode) && typecheck.exitCode !== 0, 'type tests must remain enforced by typecheck');
  assert.match(typecheck.out, /contract\.test-d\.ts\(1,14\): error TS2322/);
  assert.match(typecheck.out, /jsx-contract\.test-d\.tsx\(1,14\): error TS2322/);

  for (const args of [['-p', 'tsconfig.json'], ['--project=tsconfig.json']]) {
    await buildTypeScriptPackageDist({ packageDir, args, stdio: 'inherit' });
    const distFiles = await readdir(join(packageDir, 'dist'));
    assert.deepEqual(distFiles.sort(), baselineFiles.filter((name) => !name.includes('.test-d.')).sort());
    for (const name of distFiles) {
      assert.deepEqual(await readFile(join(packageDir, 'dist', name)), await readFile(join(baselineDir, name)));
    }
  }
  assert.equal(await readFile(projectPath, 'utf-8'), unchangedConfig);

  // An explicit files list bypasses TypeScript's exclude patterns.
  await writeJson(projectPath, {
    extends: './config/tsconfig.base.json', include: [],
    files: ['src/index.ts', 'src/contract.test-d.ts', 'src/jsx-contract.test-d.tsx'],
  });
  await buildTypeScriptPackageDist({ packageDir, args: ['--project', '.'], stdio: 'inherit' });
  assert.deepEqual((await readdir(join(packageDir, 'dist'))).sort(), ['index.d.ts', 'index.js']);
});

test('buildTypeScriptPackageDist preserves original Node type roots in isolated staged builds', async (t) => {
  const packageDir = await createPackageFixture(t, 'build-ts-package-node-type-roots');
  const projectPath = join(packageDir, 'tsconfig.json');
  const config = JSON.parse(await readFile(projectPath, 'utf-8'));
  config.compilerOptions.types = ['node'];
  config.compilerOptions.rootDir = '../src';
  config.compilerOptions.paths = { '#value': ['../src/value.ts'] };
  config.include = ['../src/**/*.ts'];
  await mkdir(join(packageDir, 'config'));
  await symlink(fileURLToPath(new URL('../../node_modules', import.meta.url)), join(packageDir, 'node_modules'), 'junction');
  await writeJson(join(packageDir, 'config', 'tsconfig.base.json'), config);
  await writeJson(projectPath, { extends: './config/tsconfig.base.json' });
  await writeFile(join(packageDir, 'src', 'value.ts'), 'export const value = 1;\n');
  await writeFile(join(packageDir, 'src', 'index.ts'), "import { value } from '#value';\nexport const built: number = process.pid + value;\n");
  const invocation = resolveTypeScriptCliInvocation({});
  const baseline = await runCaptureResult(invocation.command, [...invocation.argsPrefix, '--noEmit', '-p', projectPath], {
    cwd: packageDir, ownedProcessGroup: true,
  });
  assert.equal(baseline.exitCode, 0, baseline.out);

  // Both default ancestor lookup and an inherited explicit root must survive
  // relocating the top-level build config outside the original project tree.
  for (const explicitRoots of [false, true]) {
    if (explicitRoots) {
      await symlink(fileURLToPath(new URL('../../node_modules/@types', import.meta.url)), join(packageDir, 'custom-types'), 'junction');
      await rm(join(packageDir, 'node_modules'));
      config.compilerOptions.typeRoots = ['../custom-types'];
      await writeJson(join(packageDir, 'config', 'tsconfig.base.json'), config);
    }
    const originalConfig = await readFile(projectPath, 'utf-8');
    const result = await buildTypeScriptPackageDist({
      packageDir, args: ['-p', 'tsconfig.json'],
      outputDir: join(packageDir, '.staged-dist'), stdio: 'inherit',
    });
    assert.equal(result.promoted, false);
    assert.match(await readFile(join(result.outputDir, 'index.js'), 'utf-8'), /process\.pid/);
    assert.match(await readFile(join(result.outputDir, 'index.d.ts'), 'utf-8'), /built: number/);
    assert.equal(await readFile(projectPath, 'utf-8'), originalConfig);
  }
});

test('buildTypeScriptPackageDist defaults to one checker but respects an explicitly sized compiler', async (t) => {
  const packageDir = await createPackageFixture(t, 'build-ts-package-checker-budget');
  withPatchedProcessEnv(t, { HAPPIER_WORKSPACE_BUILD_MODE: 'source-dev' });
  for (const explicit of [false, true]) {
    await buildTypeScriptPackageDist({
      packageDir,
      args: ['-p', 'tsconfig.json', '--noCheck', ...(explicit ? ['--singleThreaded', 'false'] : [])],
      env: { ...buildNativeAdmissionFixtureEnv(), CI: '', HAPPIER_DEV_TARGET_EXECUTION: '1', HAPPIER_WORKSPACE_BUILD_MODE: 'strict' },
      stdio: 'ignore',
      // The process boundary observes the resource policy passed to the real
      // compiler; output admission, caching and promotion remain real.
      runCommandImpl: (_command, args) => {
        if (process.platform === 'linux') assert.ok(args.includes('--class=compilation'),
          'explicit strict compiler mode must govern admission even in a source-dev process');
        const checkerOption = args.indexOf('--singleThreaded');
        assert.notEqual(checkerOption, -1, 'package compiles must not implicitly use every checker');
        if (explicit) assert.equal(args[checkerOption + 1], 'false');
        assert.equal(args.filter((arg) => arg === '--singleThreaded').length, 1);
        assert.equal(args[args.lastIndexOf('--noCheck') + 1], 'false');
        writeTypeScriptFixtureOutput(args);
        return { status: 0 };
      },
    });
    assert.match(await readFile(join(packageDir, 'dist', 'index.js'), 'utf-8'), /built/);
  }
});

test('buildTypeScriptPackageDist preserves previous dist when TypeScript compilation fails', async (t) => {
  const packageDir = await createPackageFixture(t, 'build-ts-package-fail');
  await writeFile(join(packageDir, 'src', 'index.ts'), 'export const built: string = 1;\n', 'utf-8');

  await assert.rejects(
    () =>
      buildTypeScriptPackageDist({
        packageDir,
        args: ['-p', 'tsconfig.json'],
        stdio: 'ignore',
        resolveTypeScriptCliInvocationImpl: () => ({ command: 'tsc', argsPrefix: [] }),
        runCommandImpl: () => ({ status: 1 }),
      }),
    /failed with code|TypeScript package build failed/,
  );

  assert.equal(await readFile(join(packageDir, 'dist', 'index.js'), 'utf-8'), 'export const stable = true;\n');
});

test('buildTypeScriptPackageDist emits incremental QA output while strict and publication builds still check it', async (t) => {
  const packageDir = await createPackageFixture(t, 'build-ts-package-qa-emit');
  const projectPath = join(packageDir, 'tsconfig.json');
  const config = JSON.parse(await readFile(projectPath, 'utf-8'));
  config.compilerOptions.incremental = true;
  await writeJson(projectPath, config);
  await writeFile(join(packageDir, 'src', 'index.ts'), 'export const built: string = 1;\n');
  const options = {
    packageDir, args: ['-p', 'tsconfig.json'], stdio: 'ignore',
    // Compiler execution is the system boundary. Keep cache preparation,
    // artifact verification and publication real while observing its options.
    runCommandImpl: (_command, args) => {
      if (!args.includes('--noCheck') || args[args.indexOf('--noCheck') + 1] === 'false') return { status: 1 };
      assert.ok(args.includes('--incremental'));
      const outDir = args[args.indexOf('--outDir') + 1];
      mkdirSync(outDir, { recursive: true });
      const source = readFileSync(join(packageDir, 'src', 'index.ts'), 'utf-8');
      writeFileSync(join(outDir, 'index.js'), source.replace(': string', ''));
      writeFileSync(join(outDir, 'index.d.ts'), 'export declare const built: string;\n');
      writeFileSync(args[args.indexOf('--tsBuildInfoFile') + 1], JSON.stringify({ fileNames: [join(packageDir, 'src', 'index.ts')] }));
      return { status: 0 };
    },
  };
  const qaEnv = { HAPPIER_WORKSPACE_BUILD_MODE: 'qa-runtime', npm_lifecycle_event: 'build' };
  await buildTypeScriptPackageDist({ ...options, env: qaEnv });
  assert.match(await readFile(join(packageDir, 'dist', 'index.js'), 'utf-8'), /built = 1/);
  assert.match(await readFile(join(packageDir, 'dist', 'index.d.ts'), 'utf-8'), /built: string/);
  const cacheRoot = join(packageDir, '.happier', 'typescript-package-build');
  const qaCache = (await readdir(cacheRoot))[0];
  assert.ok(existsSync(join(cacheRoot, qaCache, '.tsbuildinfo')));
  const qaDist = await hashFixtureDist(join(packageDir, 'dist'));
  for (const env of [
    { HAPPIER_WORKSPACE_BUILD_MODE: 'strict', npm_lifecycle_event: 'build' },
    ...['prepack', 'pack', 'publish', 'prepublishOnly'].map((npm_lifecycle_event) => ({ ...qaEnv, npm_lifecycle_event })),
  ]) {
    await assert.rejects(buildTypeScriptPackageDist({ ...options, env }), /TypeScript package build failed/);
    assert.equal(await hashFixtureDist(join(packageDir, 'dist')), qaDist);
  }
  await writeFile(join(packageDir, 'src', 'index.ts'), 'export const built: string = 2;\n');
  await buildTypeScriptPackageDist({ ...options, env: qaEnv });
  assert.match(await readFile(join(packageDir, 'dist', 'index.js'), 'utf-8'), /built = 2/);
  assert.deepEqual(await readdir(cacheRoot), [qaCache], 'QA repeats reuse their own compiler cache');
  delete config.compilerOptions.incremental;
  await writeJson(projectPath, config);
  await buildTypeScriptPackageDist({ ...options, env: qaEnv });
  assert.ok(existsSync(join(cacheRoot, qaCache, '.tsbuildinfo')), 'dev emit stays incremental without requiring package config changes');
});

test('buildTypeScriptPackageDist produces consumable native QA and source-dev emit and refreshes it incrementally', async (t) => {
  const packageDir = await createPackageFixture(t, 'build-ts-package-native-qa-emit');
  const sourcePath = join(packageDir, 'src', 'index.ts');
  const options = {
    packageDir, args: ['-p', 'tsconfig.json'], stdio: 'ignore',
    env: { HAPPIER_WORKSPACE_BUILD_MODE: 'qa-runtime', npm_lifecycle_event: 'build' },
  };
  for (const [value, mode] of [[1, 'qa-runtime'], [2, 'qa-runtime'], [3, 'source-dev']]) {
    await writeFile(sourcePath, `export const built: string = ${value};\n`);
    await buildTypeScriptPackageDist({ ...options, env: { ...options.env, HAPPIER_WORKSPACE_BUILD_MODE: mode } });
    const emitted = await import(`${pathToFileURL(join(packageDir, 'dist', 'index.js')).href}?value=${value}`);
    assert.equal(emitted.built, value);
    assert.match(await readFile(join(packageDir, 'dist', 'index.d.ts'), 'utf-8'), /built: string/);
  }
  const cacheRoot = join(packageDir, '.happier', 'typescript-package-build');
  const caches = await readdir(cacheRoot);
  assert.equal(caches.length, 1);
  assert.ok(existsSync(join(cacheRoot, caches[0], '.tsbuildinfo')));
  const retained = await hashFixtureDist(join(packageDir, 'dist'));
  await assert.rejects(buildTypeScriptPackageDist({ ...options,
    env: { HAPPIER_WORKSPACE_BUILD_MODE: 'source-dev', npm_lifecycle_event: 'prepack' } }), /TypeScript package build failed/);
  assert.equal(await hashFixtureDist(join(packageDir, 'dist')), retained);
});

test('buildTypeScriptPackageDist removes stale outputs whose source no longer exists', async (t) => {
  const packageDir = await createPackageFixture(t, 'build-ts-package-retired-source');
  await writeFile(join(packageDir, 'src', 'index.ts'), 'export const built = true;\n', 'utf-8');
  await writeFile(join(packageDir, 'dist', 'retired.js'), 'export const retired = true;\n', 'utf-8');

  await buildTypeScriptPackageDist({
    packageDir,
    args: ['-p', 'tsconfig.json'],
    stdio: 'ignore',
    resolveTypeScriptCliInvocationImpl: () => ({ command: 'tsc', argsPrefix: [] }),
    runCommandImpl: (_command, args) => {
      writeTypeScriptFixtureOutput(args);
      return { status: 0 };
    },
  });

  assert.equal(existsSync(join(packageDir, 'dist', 'retired.js')), false);
  assert.equal(await readFile(join(packageDir, 'dist', 'index.js'), 'utf-8'), 'export const built = true;\n');
});

test('buildTypeScriptPackageDist promotes portable source maps for packed consumers', async (t) => {
  const packageDir = await createPackageFixture(t, 'build-ts-package-source-maps');
  const tsconfigPath = join(packageDir, 'tsconfig.json');
  const tsconfig = JSON.parse(await readFile(tsconfigPath, 'utf-8'));
  await writeJson(tsconfigPath, {
    ...tsconfig,
    compilerOptions: {
      ...tsconfig.compilerOptions,
      sourceMap: true,
      declarationMap: true,
    },
  });
  await writeFile(join(packageDir, 'src', 'index.ts'), [
    "export { greeting } from './nested/greeting.js';",
    "export type { Greeting } from './nested/greeting.js';",
    '',
  ].join('\n'), 'utf-8');
  await mkdir(join(packageDir, 'src', 'nested'), { recursive: true });
  await writeFile(join(packageDir, 'src', 'nested', 'greeting.ts'), [
    "export const greeting = 'hello';",
    'export type Greeting = typeof greeting;',
    '',
  ].join('\n'), 'utf-8');

  await buildTypeScriptPackageDist({
    packageDir,
    args: ['-p', 'tsconfig.json'],
    stdio: 'ignore',
  });
  const initialDistStat = statSync(join(packageDir, 'dist'));
  await buildTypeScriptPackageDist({
    packageDir,
    args: ['-p', 'tsconfig.json'],
    stdio: 'ignore',
  });
  assert.equal(
    statSync(join(packageDir, 'dist')).ino,
    initialDistStat.ino,
    'identical normalized maps must not replace the last-green dist tree',
  );

  const packedPackageDir = await mkdtemp(join(tmpdir(), 'happier-packed-source-maps-'));
  t.after(async () => {
    await rm(packedPackageDir, { recursive: true, force: true });
  });
  await cp(join(packageDir, 'dist'), join(packedPackageDir, 'dist'), { recursive: true });

  for (const relativeMapPath of [
    'index.js.map',
    'index.d.ts.map',
    'nested/greeting.js.map',
    'nested/greeting.d.ts.map',
  ]) {
    const promotedMapPath = join(packageDir, 'dist', relativeMapPath);
    const packedMapPath = join(packedPackageDir, 'dist', relativeMapPath);
    const sourceMap = JSON.parse(await readFile(promotedMapPath, 'utf-8'));
    const packedSourceMap = JSON.parse(await readFile(packedMapPath, 'utf-8'));
    assert.ok(Array.isArray(sourceMap.sources) && sourceMap.sources.length > 0, relativeMapPath);
    assert.deepEqual(packedSourceMap, sourceMap, 'promotion must produce portable map bytes');

    for (const [index, source] of sourceMap.sources.entries()) {
      const promotedSourcePath = resolveMapSourcePath(promotedMapPath, sourceMap.sourceRoot, source);
      assert.equal(
        isPathInside(packageDir, promotedSourcePath) && existsSync(promotedSourcePath),
        true,
        `${relativeMapPath} source must be relative to the final package, not compiler staging`,
      );
      assert.equal(
        source,
        relative(dirname(promotedMapPath), promotedSourcePath).replaceAll('\\', '/'),
        `${relativeMapPath} source must not retain transient path segments`,
      );

      const packedSourcePath = resolveMapSourcePath(packedMapPath, sourceMap.sourceRoot, source);
      const expectedSourceContents = await readFile(promotedSourcePath, 'utf-8');
      const sourcesContent = Array.isArray(sourceMap.sourcesContent)
        ? sourceMap.sourcesContent[index]
        : undefined;
      const packedSourceResolves = isPathInside(packedPackageDir, packedSourcePath)
        && existsSync(packedSourcePath);
      assert.equal(
        packedSourceResolves || sourcesContent === expectedSourceContents,
        true,
        `${relativeMapPath} source ${source} must resolve in a packed package or retain its source text`,
      );
    }
  }
});

test('buildTypeScriptPackageDist rejects escaping source maps without replacing last-green dist', async (t) => {
  const packageDir = await createPackageFixture(t, 'build-ts-package-source-map-boundary');
  const sourcePath = join(packageDir, 'src', 'index.ts');
  await writeFile(sourcePath, 'export const built = true;\n', 'utf-8');

  const outsideDir = await mkdtemp(join(tmpdir(), 'happier-source-map-outside-'));
  t.after(async () => {
    await rm(outsideDir, { recursive: true, force: true });
  });
  const outsideSourcePath = join(outsideDir, 'outside.ts');
  await writeFile(outsideSourcePath, 'export const outside = true;\n', 'utf-8');
  const linkedOutsideDir = join(packageDir, 'src', 'linked-outside');
  await symlink(
    outsideDir,
    linkedOutsideDir,
    process.platform === 'win32' ? 'junction' : 'dir',
  );

  let sourceMapSource = (compilerOutputDir) => relative(compilerOutputDir, sourcePath);
  const runFakeCompiler = (_command, args) => {
    const compilerOutputDir = args[args.indexOf('--outDir') + 1];
    mkdirSync(compilerOutputDir, { recursive: true });
    writeFileSync(
      join(compilerOutputDir, 'index.js'),
      'export const built = true;\n//# sourceMappingURL=index.js.map\n',
      'utf-8',
    );
    writeFileSync(
      join(compilerOutputDir, 'index.d.ts'),
      'export declare const built: boolean;\n//# sourceMappingURL=index.d.ts.map\n',
      'utf-8',
    );
    writeFileSync(
      join(compilerOutputDir, 'index.js.map'),
      JSON.stringify({ version: 3, file: 'index.js', sources: [sourceMapSource(compilerOutputDir)], names: [], mappings: '' }),
      'utf-8',
    );
    writeFileSync(
      join(compilerOutputDir, 'index.d.ts.map'),
      JSON.stringify({ version: 3, file: 'index.d.ts', sources: [sourceMapSource(compilerOutputDir)], names: [], mappings: '' }),
      'utf-8',
    );
    return { status: 0 };
  };

  await buildTypeScriptPackageDist({
    packageDir,
    args: ['-p', 'tsconfig.json'],
    stdio: 'ignore',
    resolveTypeScriptCliInvocationImpl: () => ({ command: 'tsc', argsPrefix: [] }),
    runCommandImpl: runFakeCompiler,
  });

  const promotedJs = await readFile(join(packageDir, 'dist', 'index.js'), 'utf-8');
  const promotedDts = await readFile(join(packageDir, 'dist', 'index.d.ts'), 'utf-8');
  const promotedJsMap = await readFile(join(packageDir, 'dist', 'index.js.map'), 'utf-8');
  const promotedDtsMap = await readFile(join(packageDir, 'dist', 'index.d.ts.map'), 'utf-8');
  assert.match(promotedJs, /sourceMappingURL=index\.js\.map/);
  assert.match(promotedDts, /sourceMappingURL=index\.d\.ts\.map/);
  assert.equal(JSON.parse(promotedJsMap).file, 'index.js');
  assert.equal(JSON.parse(promotedDtsMap).file, 'index.d.ts');
  assert.deepEqual(JSON.parse(promotedJsMap).sources, ['../src/index.ts']);
  assert.deepEqual(JSON.parse(promotedDtsMap).sources, ['../src/index.ts']);

  // TypeScript emits a file URL source when no relative path exists, such as a
  // Windows temp outDir on another drive than the package.
  sourceMapSource = () => pathToFileURL(sourcePath).href;
  await buildTypeScriptPackageDist({
    packageDir,
    args: ['-p', 'tsconfig.json'],
    stdio: 'ignore',
    resolveTypeScriptCliInvocationImpl: () => ({ command: 'tsc', argsPrefix: [] }),
    runCommandImpl: runFakeCompiler,
  });
  assert.equal(await readFile(join(packageDir, 'dist', 'index.js.map'), 'utf-8'), promotedJsMap);
  assert.equal(await readFile(join(packageDir, 'dist', 'index.d.ts.map'), 'utf-8'), promotedDtsMap);

  const lastGreenDist = {
    js: promotedJs,
    dts: promotedDts,
    jsMap: promotedJsMap,
    dtsMap: promotedDtsMap,
  };
  const escapingSources = [
    {
      label: 'lexical',
      source: (compilerOutputDir) => relative(compilerOutputDir, outsideSourcePath),
    },
    {
      label: 'absolute',
      source: () => outsideSourcePath,
    },
    {
      label: 'file URL',
      source: () => pathToFileURL(outsideSourcePath).href,
    },
    {
      label: 'in-package symlink',
      source: (compilerOutputDir) => relative(
        compilerOutputDir,
        join(linkedOutsideDir, 'outside.ts'),
      ),
    },
  ];

  for (const escapingSource of escapingSources) {
    sourceMapSource = escapingSource.source;
    await assert.rejects(
      () => buildTypeScriptPackageDist({
        packageDir,
        args: ['-p', 'tsconfig.json'],
        stdio: 'ignore',
        resolveTypeScriptCliInvocationImpl: () => ({ command: 'tsc', argsPrefix: [] }),
        runCommandImpl: runFakeCompiler,
      }),
      /TypeScript emitted a source map that escapes its package/,
      escapingSource.label,
    );

    assert.equal(await readFile(join(packageDir, 'dist', 'index.js'), 'utf-8'), lastGreenDist.js);
    assert.equal(await readFile(join(packageDir, 'dist', 'index.d.ts'), 'utf-8'), lastGreenDist.dts);
    assert.equal(await readFile(join(packageDir, 'dist', 'index.js.map'), 'utf-8'), lastGreenDist.jsMap);
    assert.equal(await readFile(join(packageDir, 'dist', 'index.d.ts.map'), 'utf-8'), lastGreenDist.dtsMap);
  }
});

test('buildTypeScriptPackageDist composes an explicit staged UI producer before validating wildcard exports', async (t) => {
  const packageDir = await createPackageFixtureWithUiArtifacts(t, 'build-ts-package-ui-composition');
  await writeFile(join(packageDir, 'src', 'index.ts'), 'export const built = true;\n', 'utf-8');
  let uiBuildCalls = 0;

  await buildTypeScriptPackageDist({
    packageDir,
    args: ['-p', 'tsconfig.json', '--happier-staged-output-script', 'build:ui'],
    stdio: 'ignore',
    resolveTypeScriptCliInvocationImpl: () => ({ command: 'tsc', argsPrefix: [] }),
    resolvePnpmCommandInvocationImpl: () => ({ command: 'pnpm', args: ['-s', 'build:ui'] }),
    runCommandImpl: (_command, args, options) => {
      if (args.includes('--outDir')) {
        writeTypeScriptFixtureOutput(args);
        return { status: 0 };
      }
      if (args.includes('build:ui')) {
        uiBuildCalls += 1;
        const outputDir = options.env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR;
        assert.equal(typeof outputDir, 'string');
        mkdirSync(join(outputDir, 'happier-plugin-ui'), { recursive: true });
        writeFileSync(
          join(outputDir, 'happier-plugin-ui', 'ui-artifacts.json'),
          '{"version":1,"entries":["rebuilt"]}\n',
          'utf-8',
        );
        return { status: 0 };
      }
      throw new Error(`Unexpected command: ${args.join(' ')}`);
    },
  });

  assert.equal(uiBuildCalls, 1);
  assert.equal(await readFile(join(packageDir, 'dist', 'index.js'), 'utf-8'), 'export const built = true;\n');
  assert.equal(
    await readFile(join(packageDir, 'dist', 'happier-plugin-ui', 'ui-artifacts.json'), 'utf-8'),
    '{"version":1,"entries":["rebuilt"]}\n',
  );
});

test('buildTypeScriptPackageDist builds UI from the current staged manifest without a packaged manifest prerequisite', async (t) => {
  for (const hasPackagedManifest of [true, false]) {
    const packageDir = await createPackageFixtureWithUiArtifacts(t, `build-ts-package-ui-manifest-${hasPackagedManifest}`);
    const packageJsonPath = join(packageDir, 'package.json');
    const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'));
    packageJson.scripts['build:ui'] = 'happier-plugin-build-ui';
    packageJson.exports['./manifest'] = { default: './dist/manifest.js' };
    await writeJson(packageJsonPath, packageJson);
    await writeFile(join(packageDir, 'src', 'index.ts'), 'export const built = true;\n');
    if (hasPackagedManifest) {
      await mkdir(join(packageDir, '.happier-plugin'));
      await writeJson(join(packageDir, '.happier-plugin', 'plugin.json'), { id: 'stale' });
    }

    await buildTypeScriptPackageDist({
      packageDir,
      args: ['-p', 'tsconfig.json', '--happier-staged-output-script', 'build:ui'],
      stdio: 'ignore',
      resolveTypeScriptCliInvocationImpl: () => ({ command: 'tsc', argsPrefix: [] }),
      resolvePnpmCommandInvocationImpl: args => ({ command: 'pnpm', args }),
      // Only the external compiler/process boundary is replaced. Staging,
      // manifest import/serialization and dist promotion remain real.
      runCommandImpl: async (_command, args, options) => {
        if (args.includes('--outDir')) {
          const outputDir = writeTypeScriptFixtureOutput(args);
          writeFileSync(join(outputDir, 'manifest.js'), 'export const PLUGIN_MANIFEST = { id: "current" };\n');
          return { status: 0 };
        }
        if (args.includes('build:ui')) {
          const manifestFlag = args.indexOf('--manifest-path');
          const manifestPath = manifestFlag === -1
            ? join(packageDir, '.happier-plugin', 'plugin.json') : args[manifestFlag + 1];
          const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
          assert.equal(manifest.id, 'current');
          const outputDir = options.env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR;
          await mkdir(join(outputDir, 'happier-plugin-ui'), { recursive: true });
          await writeJson(join(outputDir, 'happier-plugin-ui', 'ui-artifacts.json'), { entries: [manifest.id] });
          return { status: 0 };
        }
        throw new Error(`Unexpected command: ${args.join(' ')}`);
      },
    });

    assert.deepEqual(JSON.parse(await readFile(join(packageDir, 'dist/happier-plugin-ui/ui-artifacts.json'), 'utf8')), { entries: ['current'] });
    assert.equal(existsSync(join(packageDir, '.happier-plugin/plugin.json')), hasPackagedManifest);
    if (hasPackagedManifest) {
      assert.deepEqual(JSON.parse(await readFile(join(packageDir, '.happier-plugin/plugin.json'), 'utf8')), { id: 'stale' });
    }
  }
});

test('workspace output-only UI refresh compiles current staged manifest facts through the real SDK compiler', async (t) => {
  const packageDir = await createPackageFixture(t, 'build-ts-package-ui-refresh-manifest');
  await writeJson(join(packageDir, 'package.json'), {
    type: 'module',
    scripts: { 'build:ui': 'happier-plugin-build-ui' },
    exports: {
      './manifest': { default: './dist/manifest.js' },
      './happier-plugin-ui/first': './src/renderSurface.ts',
      './happier-plugin-ui/second': './src/renderSurface.ts',
    },
  });
  await writeFile(join(packageDir, 'src/renderSurface.ts'), 'export function renderSurface() { return null; }\n');
  const outputDir = join(packageDir, '.refresh');
  await mkdir(outputDir);
  await writeFile(join(outputDir, 'manifest.js'), `import { artifact } from './manifestFacts.js';
export const PLUGIN_MANIFEST = { contributes: { ui: { renderers: [{ kind: 'reactNative', artifact }] } } };
`);
  // The package-manager process boundary is replaced, not manifest discovery,
  // compilation, artifact validation or publication inside the SDK.
  const packageManagerShim = join(packageDir, 'package-manager.cjs');
  await writeFile(packageManagerShim, `const { spawnSync } = require('node:child_process');
const result = spawnSync(process.execPath, ['--import', ${JSON.stringify(fileURLToPath(new URL('../../packages/cli-common/registerSourceRuntime.mjs', import.meta.url)))}, ${JSON.stringify(fileURLToPath(new URL('../../packages/plugin-sdk/src/ui/build/bin.ts', import.meta.url)))}, ...process.argv.slice(4)], { env: process.env, stdio: 'inherit' });
process.exitCode = result.status ?? 1;
`);
  for (const artifact of ['first', 'second']) {
    await writeFile(join(outputDir, 'manifestFacts.js'), `export const artifact = ${JSON.stringify(artifact)};\n`);
    await defaultWorkspaceBuildBoundary.runPackageScript(packageDir, 'build:ui', {
      env: { ...process.env, npm_execpath: packageManagerShim, HAPPIER_WORKSPACE_DIST_OUTPUT_DIR: outputDir },
      quiet: false,
    });
    const inventory = JSON.parse(await readFile(join(outputDir, 'happier-plugin-ui/ui-artifacts.json'), 'utf8'));
    assert.deepEqual(inventory.entries.map(entry => entry.artifactId), [artifact]);
  }
  assert.equal(existsSync(join(packageDir, '.happier-plugin/plugin.json')), false);
});

test('buildTypeScriptPackageDist preserves the complete prior dist when the staged UI producer fails', async (t) => {
  const packageDir = await createPackageFixtureWithUiArtifacts(t, 'build-ts-package-ui-failure');
  await writeFile(join(packageDir, 'src', 'index.ts'), 'export const built = true;\n', 'utf-8');
  let uiBuildCalls = 0;

  await assert.rejects(
    () => buildTypeScriptPackageDist({
      packageDir,
      args: ['-p', 'tsconfig.json', '--happier-staged-output-script', 'build:ui'],
      stdio: 'ignore',
      resolveTypeScriptCliInvocationImpl: () => ({ command: 'tsc', argsPrefix: [] }),
      resolvePnpmCommandInvocationImpl: () => ({ command: 'pnpm', args: ['-s', 'build:ui'] }),
      runCommandImpl: (_command, args) => {
        if (args.includes('--outDir')) {
          writeTypeScriptFixtureOutput(args);
          return { status: 0 };
        }
        if (args.includes('build:ui')) {
          uiBuildCalls += 1;
          return { status: 1 };
        }
        throw new Error(`Unexpected command: ${args.join(' ')}`);
      },
    }),
    /staged package output script "build:ui" failed/i,
  );

  assert.equal(uiBuildCalls, 1);
  assert.equal(await readFile(join(packageDir, 'dist', 'index.js'), 'utf-8'), 'export const stable = true;\n');
  assert.equal(
    await readFile(join(packageDir, 'dist', 'happier-plugin-ui', 'ui-artifacts.json'), 'utf-8'),
    '{"version":1,"entries":["known-good"]}\n',
  );
});

test('buildTypeScriptPackageDist rejects a wildcard export whose staged output has no matching file', async (t) => {
  const packageDir = await createPackageFixtureWithUiArtifacts(t, 'build-ts-package-ui-missing-output');
  await writeFile(join(packageDir, 'src', 'index.ts'), 'export const built = true;\n', 'utf-8');

  await assert.rejects(
    () => buildTypeScriptPackageDist({
      packageDir,
      args: ['-p', 'tsconfig.json'],
      stdio: 'ignore',
      resolveTypeScriptCliInvocationImpl: () => ({ command: 'tsc', argsPrefix: [] }),
      runCommandImpl: (_command, args) => {
        writeTypeScriptFixtureOutput(args);
        return { status: 0 };
      },
    }),
    /happier-plugin-ui\/\*/,
  );

  assert.equal(await readFile(join(packageDir, 'dist', 'index.js'), 'utf-8'), 'export const stable = true;\n');
  assert.equal(
    await readFile(join(packageDir, 'dist', 'happier-plugin-ui', 'ui-artifacts.json'), 'utf-8'),
    '{"version":1,"entries":["known-good"]}\n',
  );
});

test('buildTypeScriptPackageDist does not invoke a staged output producer when TypeScript fails', async (t) => {
  const packageDir = await createPackageFixtureWithUiArtifacts(t, 'build-ts-package-ui-ts-failure');
  await writeFile(join(packageDir, 'src', 'index.ts'), 'export const built: string = 1;\n', 'utf-8');
  let uiBuildCalls = 0;

  await assert.rejects(
    () => buildTypeScriptPackageDist({
      packageDir,
      args: ['-p', 'tsconfig.json', '--happier-staged-output-script', 'build:ui'],
      stdio: 'ignore',
      resolveTypeScriptCliInvocationImpl: () => ({ command: 'tsc', argsPrefix: [] }),
      resolvePnpmCommandInvocationImpl: () => ({ command: 'pnpm', args: ['-s', 'build:ui'] }),
      runCommandImpl: (_command, args) => {
        if (args.includes('--outDir')) return { status: 1 };
        if (args.includes('build:ui')) uiBuildCalls += 1;
        return { status: 0 };
      },
    }),
    /TypeScript package build failed/,
  );

  assert.equal(uiBuildCalls, 0);
  assert.equal(await readFile(join(packageDir, 'dist', 'index.js'), 'utf-8'), 'export const stable = true;\n');
  assert.equal(
    await readFile(join(packageDir, 'dist', 'happier-plugin-ui', 'ui-artifacts.json'), 'utf-8'),
    '{"version":1,"entries":["known-good"]}\n',
  );
});

test('buildTypeScriptPackageDist can write to an explicit staged output directory without mutating live dist', async (t) => {
  const packageDir = await createPackageFixture(t, 'build-ts-package-staged');
  const stagedDist = join(packageDir, '.staged-dist');
  await writeFile(join(packageDir, 'src', 'index.ts'), 'export const built = true;\n', 'utf-8');

  await buildTypeScriptPackageDist({
    packageDir,
    args: ['-p', 'tsconfig.json'],
    outputDir: stagedDist,
    stdio: 'ignore',
    resolveTypeScriptCliInvocationImpl: () => ({ command: 'tsc', argsPrefix: [] }),
    runCommandImpl: (_command, args) => {
      const outDir = args[args.indexOf('--outDir') + 1];
      mkdirSync(outDir, { recursive: true });
      writeFileSync(join(outDir, 'index.js'), 'export const built = true;\n', 'utf-8');
      writeFileSync(join(outDir, 'index.d.ts'), 'export declare const built: boolean;\n', 'utf-8');
      return { status: 0 };
    },
  });

  assert.equal(await readFile(join(packageDir, 'dist', 'index.js'), 'utf-8'), 'export const stable = true;\n');
  assert.match(await readFile(join(stagedDist, 'index.js'), 'utf-8'), /built/);
});

test('buildTypeScriptPackageDist keeps TypeScript incremental metadata out of promoted dist', async (t) => {
  const packageDir = await createPackageFixture(t, 'build-ts-package-incremental-metadata');
  await writeFile(join(packageDir, 'src', 'index.ts'), 'export const built = true;\n', 'utf-8');

  await buildTypeScriptPackageDist({
    packageDir,
    args: ['-p', 'tsconfig.json'],
    stdio: 'ignore',
    resolveTypeScriptCliInvocationImpl: () => ({ command: 'tsc', argsPrefix: [] }),
    runCommandImpl: (_command, args) => {
      const outDir = args[args.indexOf('--outDir') + 1];
      const tsBuildInfoFile = args[args.indexOf('--tsBuildInfoFile') + 1];
      mkdirSync(outDir, { recursive: true });
      writeFileSync(join(outDir, 'index.js'), 'export const built = true;\n', 'utf-8');
      writeFileSync(join(outDir, 'index.d.ts'), 'export declare const built: boolean;\n', 'utf-8');
      writeFileSync(tsBuildInfoFile, JSON.stringify({
        fileNames: [relative(dirname(tsBuildInfoFile), join(packageDir, 'src', 'index.ts'))],
      }), 'utf-8');
      return { status: 0 };
    },
  });

  assert.equal(existsSync(join(packageDir, 'dist', '.tsbuildinfo')), false);
});

test('buildTypeScriptPackageDist isolates concurrent staged compiler work trees under an unrelated outer lock', async (t) => {
  const packageDir = await createPackageFixture(t, 'build-ts-package-persistent-cache');
  await writeFile(join(packageDir, 'src', 'index.ts'), 'export const built = true;\n', 'utf-8');
  const stagedOutputs = [join(packageDir, '.stage-one'), join(packageDir, '.stage-two')];
  const compilerRuns = [];

  await withWorkspaceBundleLock(async ({ heldLockValue }) => {
    await Promise.all(stagedOutputs.map(async (outputDir) => {
      await buildTypeScriptPackageDist({
        packageDir,
        args: ['-p', 'tsconfig.json'],
        outputDir,
        env: { HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD: heldLockValue },
        stdio: 'ignore',
        resolveTypeScriptCliInvocationImpl: () => ({ command: 'tsc', argsPrefix: [] }),
        runCommandImpl: (_command, args) => {
          const compilerOutputDir = args[args.indexOf('--outDir') + 1];
          const tsBuildInfoFile = args[args.indexOf('--tsBuildInfoFile') + 1];
          compilerRuns.push({ compilerOutputDir, tsBuildInfoFile });
          mkdirSync(compilerOutputDir, { recursive: true });
          writeFileSync(join(compilerOutputDir, 'index.js'), 'export const built = true;\n', 'utf-8');
          writeFileSync(join(compilerOutputDir, 'index.d.ts'), 'export declare const built: boolean;\n', 'utf-8');
          writeFileSync(tsBuildInfoFile, JSON.stringify({ fileNames: ['src/index.ts'] }), 'utf-8');
          return { status: 0 };
        },
      });
    }));
  }, { lockPath: join(packageDir, '.unrelated-outer.lock') });

  assert.equal(compilerRuns.length, 2);
  assert.notEqual(compilerRuns[1].compilerOutputDir, compilerRuns[0].compilerOutputDir);
  assert.notEqual(compilerRuns[1].tsBuildInfoFile, compilerRuns[0].tsBuildInfoFile);
  assert.notEqual(compilerRuns[0].compilerOutputDir, stagedOutputs[0]);
  assert.notEqual(compilerRuns[1].compilerOutputDir, stagedOutputs[1]);
  for (const { compilerOutputDir, tsBuildInfoFile } of compilerRuns) {
    assert.equal(
      isPathInside(packageDir, compilerOutputDir),
      false,
      'unlocked staged compiler output must not appear beneath a watched package root',
    );
    assert.equal(
      isPathInside(packageDir, tsBuildInfoFile),
      false,
      'unlocked staged compiler metadata must not appear beneath a watched package root',
    );
    assert.equal(existsSync(compilerOutputDir), false);
    assert.equal(existsSync(tsBuildInfoFile), false);
  }
  assert.match(await readFile(join(stagedOutputs[1], 'index.js'), 'utf-8'), /built/);
});

test('buildTypeScriptPackageDist reuses and protects its staged compiler work tree under the authenticated package lock', async (t) => {
  const packageDir = await createPackageFixture(t, 'build-ts-package-locked-persistent-cache');
  const packageJson = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf-8'));
  const lockPath = resolveWorkspacePackageBuildLockPath(packageDir, packageJson);
  await writeFile(join(packageDir, 'src', 'index.ts'), 'export const built = true;\n', 'utf-8');
  const stagedOutputs = [join(packageDir, '.stage-one'), join(packageDir, '.stage-two')];
  const compilerRuns = [];

  await withWorkspaceBundleLock(async ({ heldLockValue }) => {
    for (const outputDir of stagedOutputs) {
      await buildTypeScriptPackageDist({
        packageDir,
        args: ['-p', 'tsconfig.json'],
        outputDir,
        env: { HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD: heldLockValue },
        stdio: 'ignore',
        resolveTypeScriptCliInvocationImpl: () => ({ command: 'tsc', argsPrefix: [] }),
        runCommandImpl: (_command, args) => {
          const compilerOutputDir = args[args.indexOf('--outDir') + 1];
          const tsBuildInfoFile = args[args.indexOf('--tsBuildInfoFile') + 1];
          compilerRuns.push({ compilerOutputDir, tsBuildInfoFile });
          mkdirSync(compilerOutputDir, { recursive: true });
          writeFileSync(join(compilerOutputDir, 'index.js'), 'export const built = true;\n', 'utf-8');
          writeFileSync(join(compilerOutputDir, 'index.d.ts'), 'export declare const built: boolean;\n', 'utf-8');
          writeFileSync(tsBuildInfoFile, JSON.stringify({ fileNames: ['src/index.ts'] }), 'utf-8');
          return { status: 0 };
        },
      });
    }
  }, { lockPath });

  assert.equal(compilerRuns.length, 2);
  assert.equal(compilerRuns[1].compilerOutputDir, compilerRuns[0].compilerOutputDir);
  assert.equal(compilerRuns[1].tsBuildInfoFile, compilerRuns[0].tsBuildInfoFile);
  assert.equal(existsSync(compilerRuns[0].tsBuildInfoFile), true);

  await assert.rejects(
    () => buildTypeScriptPackageDist({
      packageDir,
      args: ['-p', 'tsconfig.json'],
      outputDir: join(packageDir, '.unlocked-failing-stage'),
      stdio: 'ignore',
      resolveTypeScriptCliInvocationImpl: () => ({ command: 'tsc', argsPrefix: [] }),
      runCommandImpl: (_command, args) => {
        assert.notEqual(args[args.indexOf('--outDir') + 1], compilerRuns[0].compilerOutputDir);
        return { status: 1 };
      },
    }),
    /TypeScript package build failed/,
  );
  assert.equal(
    existsSync(compilerRuns[0].tsBuildInfoFile),
    true,
    'an unlocked failing stage must not discard the lock-owned incremental cache',
  );
});

test('buildTypeScriptPackageDist rebuilds an authenticated staged compiler cache when a declared output disappeared', async (t) => {
  const packageDir = await createPackageFixture(t, 'build-ts-package-locked-interrupted-cache');
  const packageJson = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf-8'));
  const lockPath = resolveWorkspacePackageBuildLockPath(packageDir, packageJson);
  await writeFile(join(packageDir, 'src', 'index.ts'), 'export const built = true;\n', 'utf-8');
  let compilerOutputDir = '';
  let tsBuildInfoFile = '';
  let compilerRuns = 0;
  let cacheWasReset = false;

  await withWorkspaceBundleLock(async ({ heldLockValue }) => {
    const build = (outputDir) => buildTypeScriptPackageDist({
      packageDir,
      args: ['-p', 'tsconfig.json'],
      outputDir,
      env: { HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD: heldLockValue },
      stdio: 'ignore',
      resolveTypeScriptCliInvocationImpl: () => ({ command: 'tsc', argsPrefix: [] }),
      runCommandImpl: (_command, args) => {
        compilerRuns += 1;
        compilerOutputDir = args[args.indexOf('--outDir') + 1];
        tsBuildInfoFile = args[args.indexOf('--tsBuildInfoFile') + 1];
        cacheWasReset = !existsSync(tsBuildInfoFile);
        if (!cacheWasReset) {
          // A real incremental compiler can exit successfully without re-emitting
          // when its authenticated build-info cache still says everything is current.
          return { status: 0 };
        }
        mkdirSync(compilerOutputDir, { recursive: true });
        writeFileSync(join(compilerOutputDir, 'index.js'), 'export const rebuilt = true;\n', 'utf-8');
        writeFileSync(join(compilerOutputDir, 'index.d.ts'), 'export declare const rebuilt: boolean;\n', 'utf-8');
        writeFileSync(tsBuildInfoFile, JSON.stringify({ fileNames: ['src/index.ts'] }), 'utf-8');
        return { status: 0 };
      },
    });

    await build(join(packageDir, '.stage-one'));
    await rm(join(compilerOutputDir, 'index.js'));
    await build(join(packageDir, '.stage-two'));
  }, { lockPath });

  assert.equal(compilerRuns, 2);
  assert.equal(cacheWasReset, true, 'missing declared output must invalidate otherwise valid compiler state');
  assert.equal(
    await readFile(join(packageDir, '.stage-two', 'index.js'), 'utf-8'),
    'export const rebuilt = true;\n',
  );
});

test('buildTypeScriptPackageDist does not invalidate compiler output for a wildcard owned by a staged producer', async (t) => {
  const packageDir = await createPackageFixtureWithUiArtifacts(t, 'build-ts-package-locked-ui-cache');
  const packageJson = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf-8'));
  const lockPath = resolveWorkspacePackageBuildLockPath(packageDir, packageJson);
  await writeFile(join(packageDir, 'src', 'index.ts'), 'export const built = true;\n', 'utf-8');
  let compilerCacheReused = false;
  let uiBuildCalls = 0;

  await withWorkspaceBundleLock(async ({ heldLockValue }) => {
    for (const outputDir of [join(packageDir, '.stage-one'), join(packageDir, '.stage-two')]) {
      await buildTypeScriptPackageDist({
        packageDir,
        args: ['-p', 'tsconfig.json', '--happier-staged-output-script', 'build:ui'],
        outputDir,
        env: { HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD: heldLockValue },
        stdio: 'ignore',
        resolveTypeScriptCliInvocationImpl: () => ({ command: 'tsc', argsPrefix: [] }),
        resolvePnpmCommandInvocationImpl: () => ({ command: 'pnpm', args: ['-s', 'build:ui'] }),
        runCommandImpl: (_command, args, options) => {
          if (args.includes('--outDir')) {
            const tsBuildInfoFile = args[args.indexOf('--tsBuildInfoFile') + 1];
            if (existsSync(tsBuildInfoFile)) {
              compilerCacheReused = true;
              return { status: 0 };
            }
            writeTypeScriptFixtureOutput(args);
            writeFileSync(tsBuildInfoFile, JSON.stringify({ fileNames: ['src/index.ts'] }), 'utf-8');
            return { status: 0 };
          }
          if (args.includes('build:ui')) {
            uiBuildCalls += 1;
            const stagedOutputDir = options.env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR;
            mkdirSync(join(stagedOutputDir, 'happier-plugin-ui'), { recursive: true });
            writeFileSync(
              join(stagedOutputDir, 'happier-plugin-ui', 'ui-artifacts.json'),
              '{"version":1,"entries":["rebuilt"]}\n',
              'utf-8',
            );
            return { status: 0 };
          }
          throw new Error(`Unexpected command: ${args.join(' ')}`);
        },
      });
    }
  }, { lockPath });

  assert.equal(compilerCacheReused, true);
  assert.equal(uiBuildCalls, 2);
});

test('buildTypeScriptPackageDist permits an incremental repeat but does not replace identical dist', async (t) => {
  const fixtureDir = await createPackageFixture(t, 'build-ts-package-unchanged-repeat');
  const repoDir = await mkdtemp(join(tmpdir(), 'happier-build-ts-recorded-repeat-'));
  t.after(() => rm(repoDir, { recursive: true, force: true }));
  const packageDir = join(repoDir, 'packages/example');
  await mkdir(dirname(packageDir), { recursive: true });
  await cp(fixtureDir, packageDir, { recursive: true });
  await writeJson(join(repoDir, 'package.json'), { private: true, workspaces: ['apps/*', 'packages/*'] });
  await writeFile(join(repoDir, 'pnpm-lock.yaml'), '# fixture\n');
  await writeFile(join(repoDir, 'pnpm-workspace.yaml'), 'packages: []\n');
  for (const app of ['cli', 'server', 'ui']) {
    await mkdir(join(repoDir, 'apps', app), { recursive: true });
    await writeJson(join(repoDir, 'apps', app, 'package.json'), { name: `@fixture/${app}` });
  }
  const packageJson = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'));
  packageJson.scripts = { build: 'fixture compiler' };
  await writeJson(join(packageDir, 'package.json'), packageJson);
  await writeFile(join(packageDir, 'src', 'index.ts'), 'export const built = true;\n', 'utf-8');
  let compilerRuns = 0;
  const runCommandImpl = (_command, args) => {
    compilerRuns += 1;
    const compilerOutputDir = args[args.indexOf('--outDir') + 1];
    const tsBuildInfoFile = args[args.indexOf('--tsBuildInfoFile') + 1];
    mkdirSync(compilerOutputDir, { recursive: true });
    writeFileSync(join(compilerOutputDir, 'index.js'), 'export const built = true;\n', 'utf-8');
    writeFileSync(join(compilerOutputDir, 'index.d.ts'), 'export declare const built: boolean;\n', 'utf-8');
    writeFileSync(tsBuildInfoFile, JSON.stringify({ fileNames: ['src/index.ts'] }), 'utf-8');
    return { status: 0 };
  };
  const buildOptions = {
    packageDir,
    args: ['-p', 'tsconfig.json'],
    stdio: 'ignore',
    resolveTypeScriptCliInvocationImpl: () => ({ command: 'tsc', argsPrefix: [] }),
    runCommandImpl,
  };

  const admit = () => ensureWorkspacePackagesBuiltByName(repoDir, [packageJson.name], {
    quiet: true,
    env: { ...process.env, HAPPIER_WORKSPACE_BUILD_MODE: 'strict' },
    // Only the compiler process is substituted. Canonical package admission
    // invokes the real staged builder and publishes its real input receipt.
    workspaceBuildBoundary: {
      async prepareEnv(_dir, env) { return { ...env }; },
      async runPackageBuild(_dir, { env }) {
        await buildTypeScriptPackageDist({ ...buildOptions, outputDir: env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR, env });
      },
    },
  });
  await admit();
  assert.equal(isWorkspacePackageOutputCurrent(packageDir), true);
  const recordPath = join(packageDir, 'dist', BUILD_INPUT_RECORD);
  const beforeRecord = await readFile(recordPath, 'utf8');
  const before = statSync(join(packageDir, 'dist'));
  const beforeHash = await hashFixtureDist(join(packageDir, 'dist'));

  await buildTypeScriptPackageDist(buildOptions);

  const after = statSync(join(packageDir, 'dist'));
  const afterHash = await hashFixtureDist(join(packageDir, 'dist'));
  assert.equal(compilerRuns, 2, 'a cheap incremental compiler invocation remains allowed');
  assert.equal(await readFile(recordPath, 'utf8'), beforeRecord,
    'byte-identical standalone output must not destroy the canonical admission receipt');
  assert.equal(after.ino, before.ino, 'identical staged bytes must not replace the last-green dist directory');
  assert.equal(after.mtimeMs, before.mtimeMs, 'identical staged bytes must not mutate the last-green dist directory');
  assert.equal(afterHash, beforeHash);
  assert.equal(isWorkspacePackageOutputCurrent(packageDir), true);

  // Retaining a receipt must never bless changed source or changed output.
  await writeJson(join(packageDir, 'package.json'), { ...packageJson, dependencies: { '@fixture/dependency': '1.0.0' } });
  assert.equal(isWorkspacePackageOutputCurrent(packageDir), false);
  await writeJson(join(packageDir, 'package.json'), packageJson);
  assert.equal(isWorkspacePackageOutputCurrent(packageDir), true);
  await writeFile(join(packageDir, 'src/index.ts'), 'export const built = false;\n');
  assert.equal(isWorkspacePackageOutputCurrent(packageDir), false);
  await buildTypeScriptPackageDist({
    ...buildOptions,
    runCommandImpl: (_command, args) => {
      const outDir = writeTypeScriptFixtureOutput(args);
      writeFileSync(join(outDir, 'index.js'), 'export const built = false;\n');
      return { status: 0 };
    },
  });
  assert.equal(existsSync(recordPath), false, 'changed emitted bytes invalidate the prior receipt');
  assert.equal(isWorkspacePackageOutputCurrent(packageDir), false);
});

test('native strict package promotion checks identical QA output and preserves the emitted UI and internal closure', async (t) => {
  const fixtureDir = await createPackageFixtureWithUiArtifacts(t, 'native-strict-promotion');
  const repoDir = await mkdtemp(join(tmpdir(), 'happier-native-strict-promotion-'));
  t.after(() => rm(repoDir, { recursive: true, force: true }));
  const packageDir = join(repoDir, 'packages/example');
  await mkdir(dirname(packageDir), { recursive: true });
  await cp(fixtureDir, packageDir, { recursive: true });
  await writeJson(join(repoDir, 'package.json'), { private: true, workspaces: ['apps/*', 'packages/*'] });
  for (const app of ['cli', 'server', 'ui']) {
    await mkdir(join(repoDir, 'apps', app), { recursive: true });
    await writeJson(join(repoDir, 'apps', app, 'package.json'), { name: `@fixture/${app}` });
  }
  const packageJson = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'));
  const config = JSON.parse(await readFile(join(packageDir, 'tsconfig.json'), 'utf8'));
  // Inherited noCheck must never bypass a strict promotion; the exact dist
  // project still excludes authored type tests, as its emitter does.
  config.compilerOptions.noCheck = true;
  config.compilerOptions.sourceMap = true;
  config.compilerOptions.declarationMap = true;
  await writeJson(join(packageDir, 'tsconfig.json'), config);
  await writeFile(join(packageDir, 'src/index.ts'), 'import { value } from "./value.js"; export const built: string = value;\n');
  await writeFile(join(packageDir, 'src/value.ts'), 'export const value = "checked";\n');
  await writeFile(join(packageDir, 'src/excluded.test.ts'), 'const testOnlyError: string = 1;\n');
  const passes = [];
  let uiBuilds = 0;
  const boundary = {
    prepareEnv: async (_dir, env) => ({ ...env }),
    runPackageBuild: (_dir, { env }) => buildTypeScriptPackageDist({
      packageDir, env, outputDir: env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR,
      args: ['-p', 'tsconfig.json', '--happier-staged-output-script', 'build:ui'],
      resolvePnpmCommandInvocationImpl: () => ({ command: 'fixture-ui-process', args: [] }),
      async runCommandImpl(command, args, options) {
        if (command === 'fixture-ui-process') {
          uiBuilds += 1;
          const uiDir = join(options.env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR, 'happier-plugin-ui');
          await mkdir(uiDir, { recursive: true });
          await writeFile(join(uiDir, 'ui-artifacts.json'), '{"version":1,"entries":["verified"]}\n');
          await writeFile(join(uiDir, 'entry.js'), 'export const uiReady = true;\n');
          return { status: 0 };
        }
        // Observe the real native compiler boundary; admission, generated dist
        // config, compiler cache and package publication remain the real owners.
        const result = await runCaptureResult(command, args, { ...options, stdio: undefined });
        passes.push({ args, output: result.out + result.err, status: result.exitCode });
        t.diagnostic(JSON.stringify({ checkOnly: args.includes('--noEmit'), exitCode: result.exitCode,
          durationMs: result.durationMs, output: result.out + result.err }));
        return { status: result.exitCode, signal: result.signal };
      },
    }),
  };
  const admit = (buildMode) => ensureWorkspacePackagesBuiltByName(repoDir, [packageJson.name], {
    buildMode, quiet: true, workspaceBuildBoundary: boundary,
    env: { ...process.env, HAPPIER_STACK_REPO_DIR: repoDir, HAPPIER_STACK_RUNTIME_IDENTITY_REPO_DIR: '' },
  });
  const recordPath = join(packageDir, 'dist', BUILD_INPUT_RECORD);
  await admit('source-dev');
  const before = await hashFixtureDist(join(packageDir, 'dist'));
  const uiBefore = await readFile(join(packageDir, 'dist/happier-plugin-ui/entry.js'), 'utf8');
  await admit('strict');
  assert.ok(passes.at(-1).args.includes('--noEmit'));
  assert.equal(passes.at(-1).status, 0, passes.at(-1).output);
  assert.equal(await hashFixtureDist(join(packageDir, 'dist')), before);
  assert.equal(await readFile(join(packageDir, 'dist/happier-plugin-ui/entry.js'), 'utf8'), uiBefore);
  assert.equal(uiBuilds, 1, 'strict promotion retains the verified generated UI graph');
  assert.equal(JSON.parse(await readFile(recordPath, 'utf8')).buildMode, 'strict');
  assert.deepEqual((await admit('strict')).built, []);

  await writeFile(join(packageDir, 'src/value.ts'), 'export const value = 1;\n');
  await admit('source-dev');
  const qaRecord = await readFile(recordPath, 'utf8');
  const qaOutput = await hashFixtureDist(join(packageDir, 'dist'));
  await assert.rejects(admit('strict'), /TypeScript package build failed/);
  assert.ok(passes.at(-1).args.includes('--noEmit'));
  assert.match(passes.at(-1).output, /TS2322/);
  assert.equal(await readFile(recordPath, 'utf8'), qaRecord, 'failed promotion must preserve QA provenance');
  assert.equal(await hashFixtureDist(join(packageDir, 'dist')), qaOutput);
  await writeFile(join(packageDir, 'dist/value.js'), 'export const value = "damaged";\n');
  await assert.rejects(admit('strict'), /TypeScript package build failed/);
  assert.equal(passes.at(-1).args.includes('--noEmit'), false, 'damaged QA output requires a full strict build');
  assert.match(passes.at(-1).output, /TS2322/, 'inherited noCheck cannot bypass strict fallback emission either');
  assert.equal(await readFile(recordPath, 'utf8'), qaRecord);

  await writeFile(join(packageDir, 'src/value.ts'), 'export const value = "recovered";\n');
  await admit('source-dev');
  await writeFile(join(packageDir, 'dist/value.js'), 'export const value = "corrupt internal output";\n');
  await admit('strict');
  assert.equal(passes.at(-1).args.includes('--noEmit'), false, 'damaged internal bytes require emission, not promotion');
  assert.match(await readFile(join(packageDir, 'dist/value.js'), 'utf8'), /"recovered"/);

  const legacyRecord = JSON.parse(await readFile(recordPath, 'utf8'));
  legacyRecord.buildMode = 'qa-runtime';
  legacyRecord.outputs = legacyRecord.outputs.filter(({ path }) => path === 'index.js' || path === 'index.d.ts');
  await writeJson(recordPath, legacyRecord);
  await admit('strict');
  assert.equal(passes.at(-1).args.includes('--noEmit'), false, 'legacy export-only digests cannot prove the complete emitted tree');
});

test('buildTypeScriptPackageDist resets a corrupt compiler cache without replacing last-green dist', async (t) => {
  const packageDir = await createPackageFixture(t, 'build-ts-package-corrupt-cache');
  await writeFile(join(packageDir, 'src', 'index.ts'), 'export const built = true;\n', 'utf-8');
  let compilerOutputDir = '';
  let tsBuildInfoFile = '';

  await buildTypeScriptPackageDist({
    packageDir,
    args: ['-p', 'tsconfig.json'],
    stdio: 'ignore',
    resolveTypeScriptCliInvocationImpl: () => ({ command: 'tsc', argsPrefix: [] }),
    runCommandImpl: (_command, args) => {
      compilerOutputDir = args[args.indexOf('--outDir') + 1];
      tsBuildInfoFile = args[args.indexOf('--tsBuildInfoFile') + 1];
      mkdirSync(compilerOutputDir, { recursive: true });
      writeFileSync(join(compilerOutputDir, 'index.js'), 'export const green = true;\n', 'utf-8');
      writeFileSync(join(compilerOutputDir, 'index.d.ts'), 'export declare const green: boolean;\n', 'utf-8');
      writeFileSync(tsBuildInfoFile, JSON.stringify({ fileNames: ['src/index.ts'] }), 'utf-8');
      return { status: 0 };
    },
  });
  await writeFile(tsBuildInfoFile, '{not-json', 'utf-8');

  await assert.rejects(
    () => buildTypeScriptPackageDist({
      packageDir,
      args: ['-p', 'tsconfig.json'],
      stdio: 'ignore',
      resolveTypeScriptCliInvocationImpl: () => ({ command: 'tsc', argsPrefix: [] }),
      runCommandImpl: (_command, args) => {
        assert.equal(args[args.indexOf('--outDir') + 1], compilerOutputDir);
        assert.equal(args[args.indexOf('--tsBuildInfoFile') + 1], tsBuildInfoFile);
        assert.equal(existsSync(tsBuildInfoFile), false, 'corrupt compiler state must be discarded before reuse');
        return { status: 1 };
      },
    }),
    /TypeScript package build failed/,
  );

  assert.equal(
    await readFile(join(packageDir, 'dist', 'index.js'), 'utf-8'),
    'export const green = true;\n',
  );
});

test('buildTypeScriptPackageDist discards an interrupted compiler cache without replacing last-green dist', async (t) => {
  const packageDir = await createPackageFixture(t, 'build-ts-package-interrupted-cache');
  await writeFile(join(packageDir, 'src', 'index.ts'), 'export const built = true;\n', 'utf-8');
  let compilerOutputDir = '';
  let tsBuildInfoFile = '';

  await buildTypeScriptPackageDist({
    packageDir,
    args: ['-p', 'tsconfig.json'],
    stdio: 'ignore',
    resolveTypeScriptCliInvocationImpl: () => ({ command: 'tsc', argsPrefix: [] }),
    runCommandImpl: (_command, args) => {
      compilerOutputDir = args[args.indexOf('--outDir') + 1];
      tsBuildInfoFile = args[args.indexOf('--tsBuildInfoFile') + 1];
      mkdirSync(compilerOutputDir, { recursive: true });
      writeFileSync(join(compilerOutputDir, 'index.js'), 'export const green = true;\n', 'utf-8');
      writeFileSync(join(compilerOutputDir, 'index.d.ts'), 'export declare const green: boolean;\n', 'utf-8');
      writeFileSync(tsBuildInfoFile, JSON.stringify({ fileNames: ['src/index.ts'] }), 'utf-8');
      return { status: 0 };
    },
  });
  await rm(tsBuildInfoFile);

  await assert.rejects(
    () => buildTypeScriptPackageDist({
      packageDir,
      args: ['-p', 'tsconfig.json'],
      stdio: 'ignore',
      resolveTypeScriptCliInvocationImpl: () => ({ command: 'tsc', argsPrefix: [] }),
      runCommandImpl: (_command, args) => {
        assert.equal(args[args.indexOf('--outDir') + 1], compilerOutputDir);
        assert.equal(args[args.indexOf('--tsBuildInfoFile') + 1], tsBuildInfoFile);
        assert.equal(existsSync(join(compilerOutputDir, 'index.js')), false);
        return { status: 1 };
      },
    }),
    /TypeScript package build failed/,
  );

  assert.equal(
    await readFile(join(packageDir, 'dist', 'index.js'), 'utf-8'),
    'export const green = true;\n',
  );
});

test('buildTypeScriptPackageDist discards partial compiler state left by a failed compile before retrying', async (t) => {
  const packageDir = await createPackageFixture(t, 'build-ts-package-failed-cache-update');
  await writeFile(join(packageDir, 'src', 'index.ts'), 'export const built = true;\n', 'utf-8');
  let compilerOutputDir = '';
  let tsBuildInfoFile = '';

  await assert.rejects(
    () => buildTypeScriptPackageDist({
      packageDir,
      args: ['-p', 'tsconfig.json'],
      stdio: 'ignore',
      resolveTypeScriptCliInvocationImpl: () => ({ command: 'tsc', argsPrefix: [] }),
      runCommandImpl: (_command, args) => {
        compilerOutputDir = args[args.indexOf('--outDir') + 1];
        tsBuildInfoFile = args[args.indexOf('--tsBuildInfoFile') + 1];
        mkdirSync(compilerOutputDir, { recursive: true });
        writeFileSync(join(compilerOutputDir, 'index.js'), 'export const partial = true;\n', 'utf-8');
        writeFileSync(tsBuildInfoFile, JSON.stringify({ fileNames: ['src/index.ts'] }), 'utf-8');
        return { status: 1 };
      },
    }),
    /TypeScript package build failed/,
  );
  assert.equal(await readFile(join(packageDir, 'dist', 'index.js'), 'utf-8'), 'export const stable = true;\n');

  await buildTypeScriptPackageDist({
    packageDir,
    args: ['-p', 'tsconfig.json'],
    stdio: 'ignore',
    resolveTypeScriptCliInvocationImpl: () => ({ command: 'tsc', argsPrefix: [] }),
    runCommandImpl: (_command, args) => {
      assert.equal(args[args.indexOf('--outDir') + 1], compilerOutputDir);
      assert.equal(args[args.indexOf('--tsBuildInfoFile') + 1], tsBuildInfoFile);
      assert.equal(existsSync(join(compilerOutputDir, 'index.js')), false);
      assert.equal(existsSync(tsBuildInfoFile), false);
      mkdirSync(compilerOutputDir, { recursive: true });
      writeFileSync(join(compilerOutputDir, 'index.js'), 'export const rebuilt = true;\n', 'utf-8');
      writeFileSync(join(compilerOutputDir, 'index.d.ts'), 'export declare const rebuilt: boolean;\n', 'utf-8');
      writeFileSync(tsBuildInfoFile, JSON.stringify({ fileNames: ['src/index.ts'] }), 'utf-8');
      return { status: 0 };
    },
  });

  assert.equal(await readFile(join(packageDir, 'dist', 'index.js'), 'utf-8'), 'export const rebuilt = true;\n');
});

test('buildTypeScriptPackageDist invalidates its stable cache when the compiler project excludes a prior source', async (t) => {
  const packageDir = await createPackageFixture(t, 'build-ts-package-config-change');
  const excludedSourcePath = join(packageDir, 'src', 'excluded.ts');
  await writeFile(join(packageDir, 'src', 'index.ts'), 'export const built = true;\n', 'utf-8');
  await writeFile(excludedSourcePath, 'export const excluded = true;\n', 'utf-8');
  let compilerOutputDir = '';

  await buildTypeScriptPackageDist({
    packageDir,
    args: ['-p', 'tsconfig.json'],
    stdio: 'ignore',
    resolveTypeScriptCliInvocationImpl: () => ({ command: 'tsc', argsPrefix: [] }),
    runCommandImpl: (_command, args) => {
      compilerOutputDir = args[args.indexOf('--outDir') + 1];
      const tsBuildInfoFile = args[args.indexOf('--tsBuildInfoFile') + 1];
      mkdirSync(compilerOutputDir, { recursive: true });
      writeFileSync(join(compilerOutputDir, 'index.js'), 'export const built = true;\n', 'utf-8');
      writeFileSync(join(compilerOutputDir, 'index.d.ts'), 'export declare const built: boolean;\n', 'utf-8');
      writeFileSync(join(compilerOutputDir, 'excluded.js'), 'export const excluded = true;\n', 'utf-8');
      writeFileSync(
        tsBuildInfoFile,
        JSON.stringify({ fileNames: ['src/index.ts', 'src/excluded.ts'] }),
        'utf-8',
      );
      return { status: 0 };
    },
  });

  await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  const tsconfigPath = join(packageDir, 'tsconfig.json');
  const tsconfig = JSON.parse(await readFile(tsconfigPath, 'utf-8'));
  await writeJson(tsconfigPath, { ...tsconfig, include: ['src/index.ts'] });

  const secondStage = join(packageDir, 'dist');
  await buildTypeScriptPackageDist({
    packageDir,
    args: ['-p', 'tsconfig.json'],
    stdio: 'ignore',
    resolveTypeScriptCliInvocationImpl: () => ({ command: 'tsc', argsPrefix: [] }),
    runCommandImpl: (_command, args) => {
      assert.equal(args[args.indexOf('--outDir') + 1], compilerOutputDir);
      assert.equal(existsSync(join(compilerOutputDir, 'excluded.js')), false);
      const tsBuildInfoFile = args[args.indexOf('--tsBuildInfoFile') + 1];
      mkdirSync(compilerOutputDir, { recursive: true });
      writeFileSync(join(compilerOutputDir, 'index.js'), 'export const rebuilt = true;\n', 'utf-8');
      writeFileSync(join(compilerOutputDir, 'index.d.ts'), 'export declare const rebuilt: boolean;\n', 'utf-8');
      writeFileSync(tsBuildInfoFile, JSON.stringify({ fileNames: ['src/index.ts'] }), 'utf-8');
      return { status: 0 };
    },
  });

  assert.equal(existsSync(join(secondStage, 'excluded.js')), false);
  assert.match(await readFile(join(secondStage, 'index.js'), 'utf-8'), /rebuilt/);
});

test('buildTypeScriptPackageDist prunes deleted sources from its persistent incremental cache without discarding unchanged outputs', async (t) => {
  const packageDir = await createPackageFixture(t, 'build-ts-package-real-deleted-source');
  const tsconfigPath = join(packageDir, 'tsconfig.json');
  const tsconfig = JSON.parse(await readFile(tsconfigPath, 'utf-8'));
  tsconfig.compilerOptions.incremental = true;
  tsconfig.compilerOptions.sourceMap = true;
  tsconfig.compilerOptions.declarationMap = true;
  tsconfig.include = ['src/*.ts'];
  await writeJson(tsconfigPath, tsconfig);

  const deletedSourcePath = join(packageDir, 'src', 'removed.ts');
  await mkdir(join(packageDir, 'src', 'nested'));
  await writeFile(join(packageDir, 'src', 'nested', 'imported.mts'), 'export const imported = true;\n');
  await writeFile(join(packageDir, 'src', 'index.ts'), "export const built = true;\nexport { imported } from './nested/imported.mjs';\n", 'utf-8');
  await writeFile(deletedSourcePath, 'export const removed = true;\n', 'utf-8');
  let compilerInvocation;
  let compilerOutputDir;
  let retainedBeforeRebuild;
  const suffixes = ['.js', '.js.map', '.d.ts', '.d.ts.map'];
  const options = {
    packageDir,
    args: ['-p', 'tsconfig.json'],
    stdio: 'ignore',
    // Observe the real selected Microsoft compiler process boundary; config,
    // incremental state, source-map checks and publication stay real.
    runCommandImpl: async (command, args, commandOptions) => {
      compilerInvocation = { command, args, options: commandOptions };
      compilerOutputDir = args[args.indexOf('--outDir') + 1];
      if (!existsSync(deletedSourcePath)) {
        retainedBeforeRebuild = suffixes.filter(suffix => existsSync(join(compilerOutputDir, `index${suffix}`))).length;
      }
      const result = await runCaptureResult(command, args, commandOptions);
      assert.equal(result.exitCode, 0, `${result.stdout}\n${result.stderr}`);
      return { status: result.exitCode };
    },
  };
  await buildTypeScriptPackageDist(options);
  const retiredOutputs = await Promise.all(suffixes.map(suffix => readFile(join(compilerOutputDir, `removed${suffix}`))));
  for (const suffix of suffixes) {
    assert.equal(existsSync(join(packageDir, 'dist', `removed${suffix}`)), true);
  }

  await rm(deletedSourcePath);
  // Reproduce retained old emits after a real incremental compiler pass;
  // the compiler leaves the deleted source's previous outputs on disk.
  const advanced = await runCaptureResult(compilerInvocation.command, compilerInvocation.args, compilerInvocation.options);
  assert.equal(advanced.exitCode, 0, advanced.stderr);
  for (const suffix of suffixes) {
    assert.equal(existsSync(join(compilerOutputDir, `removed${suffix}`)), true);
  }
  await buildTypeScriptPackageDist(options);
  const retainedOnDeletion = retainedBeforeRebuild;
  // Model a worker's stale output tree independently of its current metadata,
  // using the real compiler's earlier emits rather than fabricated map paths.
  await Promise.all(suffixes.map((suffix, index) => writeFile(join(compilerOutputDir, `removed${suffix}`), retiredOutputs[index])));
  const unchanged = suffixes.map(suffix => join(compilerOutputDir, `index${suffix}`));
  const unchangedStats = unchanged.map(path => statSync(path, { bigint: true }).mtimeNs);
  await buildTypeScriptPackageDist(options);
  assert.equal(retainedOnDeletion, suffixes.length, 'source deletion must retain the unchanged compiler outputs');
  assert.equal(unchanged.filter((path, index) => statSync(path, { bigint: true }).mtimeNs === unchangedStats[index]).length, suffixes.length);
  for (const suffix of suffixes) {
    assert.equal(existsSync(join(compilerOutputDir, `removed${suffix}`)), false);
    assert.equal(existsSync(join(packageDir, 'dist', `removed${suffix}`)), false);
  }
  assert.match(await readFile(join(packageDir, 'dist', 'index.js'), 'utf-8'), /built/);

  // Normal build -> delete -> rebuild also retains the persistent cache,
  // rather than handling deletion by discarding every unchanged output.
  await writeFile(deletedSourcePath, 'export const removed = true;\n');
  await buildTypeScriptPackageDist(options);
  await rm(deletedSourcePath);
  await writeFile(join(packageDir, 'src', 'renamed.ts'), 'export const renamed = true;\n');
  await buildTypeScriptPackageDist(options);
  assert.equal(retainedBeforeRebuild, suffixes.length);
  for (const suffix of suffixes) {
    assert.equal(existsSync(join(compilerOutputDir, `removed${suffix}`)), false);
    assert.equal(existsSync(join(packageDir, 'dist', `removed${suffix}`)), false);
    assert.equal(existsSync(join(packageDir, 'dist', `renamed${suffix}`)), true);
  }
  for (const suffix of ['.mjs', '.mjs.map', '.d.mts', '.d.mts.map']) {
    assert.equal(existsSync(join(compilerOutputDir, 'nested', `imported${suffix}`)), true);
    assert.equal(existsSync(join(packageDir, 'dist', 'nested', `imported${suffix}`)), true);
  }
});

test('buildTypeScriptPackageDist promotes live dist under the canonical package build lock', async (t) => {
  const packageDir = await createPackageFixture(t, 'build-ts-package-lock');
  await writeFile(join(packageDir, 'src', 'index.ts'), 'export const built = true;\n', 'utf-8');
  let observedLockOptions = null;
  let compilerLockValue = null;

  await buildTypeScriptPackageDist({
    packageDir,
    args: ['-p', 'tsconfig.json'],
    stdio: 'ignore',
    withWorkspaceBundleLockImpl: async (fn, options) => {
      observedLockOptions = options;
      return await fn({ heldLockValue: 'test-package-lock-lease' });
    },
    resolveTypeScriptCliInvocationImpl: () => ({ command: 'tsc', argsPrefix: [] }),
    runCommandImpl: (_command, args, options) => {
      compilerLockValue = options.env.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD;
      const outDir = args[args.indexOf('--outDir') + 1];
      mkdirSync(outDir, { recursive: true });
      writeFileSync(join(outDir, 'index.js'), 'export const built = true;\n', 'utf-8');
      writeFileSync(join(outDir, 'index.d.ts'), 'export declare const built: boolean;\n', 'utf-8');
      return { status: 0 };
    },
  });

  assert.match(observedLockOptions?.lockPath ?? '', /\.dist-build-happier-dev-build-ts-package-lock\.lock$/);
  assert.equal(compilerLockValue, 'test-package-lock-lease');
});

test('buildTypeScriptPackageDist rejects staged builds with missing local import targets', async (t) => {
  const packageDir = await createPackageFixture(t, 'build-ts-package-missing-local-import');
  await writeFile(join(packageDir, 'src', 'index.ts'), "export * from './internal.js';\n", 'utf-8');

  await assert.rejects(
    () =>
      buildTypeScriptPackageDist({
        packageDir,
        args: ['-p', 'tsconfig.json'],
        stdio: 'ignore',
        resolveTypeScriptCliInvocationImpl: () => ({ command: 'tsc', argsPrefix: [] }),
        runCommandImpl: (_command, args) => {
          const outDir = args[args.indexOf('--outDir') + 1];
          mkdirSync(outDir, { recursive: true });
          writeFileSync(join(outDir, 'index.js'), "export * from './internal.js';\n", 'utf-8');
          writeFileSync(join(outDir, 'index.d.ts'), "export * from './internal.js';\n", 'utf-8');
          return { status: 0 };
        },
      }),
    /missing local imports|internal\.js/,
  );

  assert.equal(await readFile(join(packageDir, 'dist', 'index.js'), 'utf-8'), 'export const stable = true;\n');
});

test('buildTypeScriptPackageDist marks declared bin targets executable in the promoted dist', async (t) => {
  const packageDir = await createPackageFixture(t, 'build-ts-package-bin');
  const packageJsonPath = join(packageDir, 'package.json');
  const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf-8'));
  packageJson.bin = { 'happier-example-bin': './dist/bin.js' };
  packageJson.exports['./bin'] = { default: './dist/bin.js' };
  await writeJson(packageJsonPath, packageJson);
  await writeFile(join(packageDir, 'src', 'index.ts'), 'export const built = true;\n', 'utf-8');

  await buildTypeScriptPackageDist({
    packageDir,
    args: ['-p', 'tsconfig.json'],
    stdio: 'ignore',
    resolveTypeScriptCliInvocationImpl: () => ({ command: 'tsc', argsPrefix: [] }),
    runCommandImpl: (_command, args) => {
      const outDir = args[args.indexOf('--outDir') + 1];
      mkdirSync(outDir, { recursive: true });
      // tsc emits 0644 files; the shebang is preserved but the executable bit is not.
      writeFileSync(join(outDir, 'index.js'), 'export const built = true;\n', 'utf-8');
      writeFileSync(join(outDir, 'index.d.ts'), 'export declare const built: boolean;\n', 'utf-8');
      writeFileSync(join(outDir, 'bin.js'), '#!/usr/bin/env node\nexport const bin = true;\n', { encoding: 'utf-8', mode: 0o644 });
      return { status: 0 };
    },
  });

  const { statSync } = await import('node:fs');
  const mode = statSync(join(packageDir, 'dist', 'bin.js')).mode;
  if (process.platform !== 'win32') {
    assert.equal(mode & 0o111, 0o111, 'bin target should be executable for user/group/other');
  }
});
