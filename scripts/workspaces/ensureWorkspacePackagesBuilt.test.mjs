import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { promisify } from 'node:util';
import { bundleWorkspaceDeps } from '../../apps/cli/scripts/bundleWorkspaceDeps.mjs';
import { runPluginSdkPreparedScript } from '../../packages/plugin-sdk/scripts/bundleWorkspaceDeps.mjs';
import {
  buildBundledWorkspaceDependenciesForCli,
  inspectSourceDevSharedDepsForSourceDev,
  main as buildSharedDeps,
  prepareBundledWorkspaceDependenciesForCli,
  syncSharedDepsForSourceDev,
} from '../../apps/cli/scripts/buildSharedDeps.mjs';
import {
  ensureWorkspacePackagesBuiltByName as ensureStackWorkspacePackagesBuiltByName,
} from '../../apps/stack/scripts/utils/proc/pm.mjs';
import { withCliDistBuildLock } from '../../apps/stack/scripts/utils/proc/cliDistBuildLock.mjs';
import {
  ensureWorkspacePackagesBuiltByName,
  ensureWorkspacePackagesBuiltForComponent,
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

test('strict workspace admission checks QA emit output before reusing it', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'happier-workspace-qa-emit-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ private: true, workspaces: ['apps/*', 'packages/*'] }));
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
  const workspaceBuildBoundary = {
    prepareEnv: async (_dir, env) => ({ ...env }),
    // The package-script process boundary executes the real compiler owner.
    runPackageBuild: (packageDir, { env }) => buildTypeScriptPackageDist({
      packageDir, env, outputDir: env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR, args: ['-p', 'tsconfig.json'], stdio: 'ignore',
      // Model only the external compiler process: semantic failure must not
      // be hidden by workspace admission or by a previously emitted QA tree.
      runCommandImpl: (_command, args) => {
        const contents = readFileSync(source, 'utf8');
        if (!args.includes('--noCheck') && contents.includes('= 1;')) return { status: 1 };
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
  assert.deepEqual((await build('strict')).built, ['@happier-dev/example'], 'strict requests cannot skip checking QA output');
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
  for (const [mode, extraEnv] of [['strict', {}], ['qa-runtime', { npm_lifecycle_event: 'prepack' }]]) {
    await assert.rejects(build(mode, extraEnv), /TypeScript package build failed/);
    assert.equal(readFileSync(join(packageDir, 'dist/index.js'), 'utf8'), emitted);
  }
});

for (const failure of ['compiler diagnostics', 'input drift']) {
test(`source-dev cold admission recovers through server, CLI and UI owners after ${failure}`, async (t) => {
  for (const surface of ['server', 'cli', 'ui']) {
    await t.test(surface, async (t) => {
      const root = mkdtempSync(join(tmpdir(), 'happier-source-dev-last-green-'));
      t.after(() => rmSync(root, { recursive: true, force: true }));
      writeFileSync(join(root, 'package.json'), JSON.stringify({ private: true, workspaces: ['apps/*', 'packages/*'] }));
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
      const compiler = resolveTypeScriptCliInvocation({});
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
      const env = { ...process.env, HAPPIER_STACK_SKIP_REFRESH_DEPS: '1' };
      delete env.HAPPIER_WORKSPACE_BUILD_MODE;
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
      await probeService(failure === 'input drift' ? 'moving' : 'green');
      t.diagnostic(`cold ${surface} QA admission + HTTP service: ${(performance.now() - started).toFixed(1)} ms`);
      const admission = surface === 'server' ? result.result : result;
      assert.equal(admission.stalePackages.length, failure === 'input drift' ? 0 : 1);
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
      assert.deepEqual((await info()).runtime.sourceWorkspaceStalePackages[surface], admission.stalePackages);
      if (surface === 'cli') {
        assert.match(readFileSync(join(root, 'apps/cli/node_modules/@happier-dev/example/dist/index.js'), 'utf8'), failure === 'input drift' ? /moving/ : /green/);
      }
      const reused = await admit();
      assert.deepEqual((surface === 'server' ? reused.result : reused).stalePackages, admission.stalePackages,
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
  writeFileSync(join(root, 'package.json'), JSON.stringify({ workspaces: ['packages/plugins/*', 'apps/*'] }));
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
    writeFileSync(join(root, 'package.json'), JSON.stringify({ workspaces: ['apps/*', 'packages/*', 'packages/plugins/*'] }));
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
            if (dir === dirs.get(failedName)) throw new Error(`compiler failed for ${failedName}`);
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
});

test('QA runtime builds use coherent last-green package outputs only for compiler diagnostics', async (t) => {
  for (const scenario of ['last-green', 'forced-last-green', 'no-output', 'strict', 'release', 'damaged', 'process-failure', 'drift', 'syntax-error']) {
    await t.test(scenario, async (t) => {
      const root = mkdtempSync(join(tmpdir(), 'happier-qa-last-green-'));
      t.after(() => rmSync(root, { recursive: true, force: true }));
      writeFileSync(join(root, 'package.json'), JSON.stringify({ workspaces: ['apps/*', 'packages/*'] }));
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
          await run(compiler.command, [...compiler.argsPrefix, '-p', join(packageDir, 'tsconfig.json'), '--outDir', env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR,
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
        assert.deepEqual(qaRequest.stalePackagesByComponent.web, result.stalePackages);
        const strictRequest = await runtimeRequest('strict');
        assert.notEqual(qaRequest.artifactFingerprints.web, strictRequest.artifactFingerprints.web);
        assert.notEqual(qaRequest.snapshotId, strictRequest.snapshotId);
        writeFileSync(source, 'export const value: string = "fixed";\n');
        const fixed = await build();
        assert.deepEqual(fixed.built, ['@happier-dev/example']);
        assert.equal(fixed.stalePackages?.length ?? 0, 0);
        assert.equal(JSON.parse(readFileSync(recordPath, 'utf8')).qaFailure, undefined);
        assert.deepEqual((await runtimeRequest('qa-runtime')).stalePackagesByComponent.web, []);
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
  writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({ workspaces: ['apps/*', 'packages/*'] }));
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
  const entrypointPath = join(repoRoot, 'fixture-yarn.cjs');
  const callsPath = join(repoRoot, 'calls.jsonl');
  writeFileSync(entrypointPath, [
    "const { appendFileSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');",
    "const { join, basename } = require('node:path');",
    'const args = process.argv.slice(2);',
    "if (args.length === 1 && args[0] === '--version') process.exit(0);",
    "if (args[0] !== '-s') process.exit(91);",
    `appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify([basename(process.cwd()), args[1]]) + '\\n');`,
    'const output = process.env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR;',
    "if (args[1] === 'build') {",
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
  const yarnCommandPath = join(binDir, process.platform === 'win32' ? 'yarn.cmd' : 'yarn');
  writeFileSync(yarnCommandPath, process.platform === 'win32'
    ? `@${JSON.stringify(process.execPath)} ${JSON.stringify(entrypointPath)} %*\r\n`
    : `#!${process.execPath}\nrequire(${JSON.stringify(entrypointPath)});\n`);
  chmodSync(yarnCommandPath, 0o755);
  const options = { quiet: true, env: { ...process.env, PATH: binDir, npm_execpath: '' } };
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
  writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({ workspaces: ['apps/*', 'packages/*'] }));
  writeFileSync(join(repoRoot, 'yarn.lock'), '# fixture\n');
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
  const emitUi = async (env) => {
    const outDir = join(env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR, 'happier-plugin-ui');
    mkdirSync(outDir, { recursive: true });
    await buildUiBundle({ entryPoints: [join(dirs.protocol, 'dist', 'index.js')], bundle: true, format: 'cjs', outfile: join(outDir, 'entry.cjs.bundle') });
    writeFileSync(join(outDir, 'ui-artifacts.json'), '{"version":1,"entries":[]}\n');
  };
  const workspaceBuildBoundary = {
    async prepareEnv(_dir, env) { return { ...env }; },
    // Compiler/subprocess boundaries only; graph admission, publication, copies,
    // integrity and the esbuild runtime-byte consumer remain real.
    async runPackageBuild(dir, { env }) {
      compileCalls.push(dir);
      writeFileSync(join(env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR, 'index.js'), dir === dirs.protocol ? readFileSync(join(dir, 'src', 'index.ts'), 'utf8').replace(': string', '') : 'export { value } from "@happier-dev/plugin-sdk";\n');
      writeFileSync(join(env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR, 'index.d.ts'), 'export declare const value: string;\n');
      if (dir === dirs['ui-bundle']) await emitUi(env);
    },
    async runPackageScript(dir, script, { env }) {
      scripts.push([dir, script]);
      if (script === 'build:ui') {
        if (failUiRefresh) throw new Error('UI compiler failed');
        await emitUi(env);
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
  assert.deepEqual(compileCalls, [dirs.protocol], 'runtime-only dependency edits must not enter dependent compilers');
  assert.deepEqual(refreshed.built, ['@happier-dev/protocol']);
  assert.match(readFileSync(join(dirs['plugin-sdk'], 'node_modules', '@happier-dev', 'protocol', 'dist', 'index.js'), 'utf8'), /second/);
  assert.match(readFileSync(join(dirs['ui-bundle'], 'dist', 'happier-plugin-ui', 'entry.cjs.bundle'), 'utf8'), /second/);
  for (const name of ['references', 'ui-bundle']) {
    const record = JSON.parse(readFileSync(join(dirs[name], 'dist', '.happier-build-inputs.json'), 'utf8'));
    assert.equal(record.files.includes('retained.js'), false, 'refresh must not certify retained live outputs as current artifacts');
    assert.equal(existsSync(join(dirs[name], 'dist', 'retained.js')), true, 'live readers keep prior outputs');
  }
  assert.deepEqual(scripts.sort(([a], [b]) => a.localeCompare(b)), [[dirs.projection, 'prebuild'], [dirs['ui-bundle'], 'build:ui']].sort(([a], [b]) => a.localeCompare(b)));
  compileCalls.length = 0;
  scripts.length = 0;
  assert.deepEqual((await prepare()).built, []);
  assert.deepEqual(compileCalls, []);
  assert.deepEqual(scripts, [], 'unchanged runtime outputs must not rebundle or recheck projections');
  writeFileSync(join(dirs.protocol, 'runtime-helper.mjs'), 'export const helper = "second helper";\n');
  await prepare();
  assert.deepEqual(compileCalls, [dirs.protocol]);
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
  assert.equal(compileCalls.includes(dirs.references), true);
});

test('declaration-only packages require a current build record instead of bypassing admission', async (t) => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'happier-declaration-only-'));
  t.after(() => rmSync(repoRoot, { recursive: true, force: true }));
  writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({ workspaces: ['apps/*', 'packages/*'] }));
  writeFileSync(join(repoRoot, 'yarn.lock'), '# fixture\n');
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
  writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({
    private: true,
    workspaces: ['apps/*', 'packages/plugins/*'],
  }));
  writeFileSync(join(repoRoot, 'yarn.lock'), '# fixture\n');
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
  writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({ workspaces: ['apps/*', 'packages/plugins/*'] }));
  writeFileSync(join(repoRoot, 'yarn.lock'), '# fixture\n');
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

test('component admission refreshes its bundled workspace package copies', async (t) => {
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
  writeFileSync(
    join(repoRoot, 'package.json'),
    JSON.stringify({ private: true, workspaces: ['apps/*', 'packages/*'] }),
    'utf8',
  );
  writeFileSync(join(repoRoot, 'yarn.lock'), '# fixture\n', 'utf8');
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
  assert.equal(
    readFileSync(join(bundledProtocolDir, 'dist', 'index.js'), 'utf8'),
    'export const value = "current";\n',
  );
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
  writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({ private: true, workspaces: ['packages/*', 'apps/*'] }));
  writeFileSync(join(repoRoot, 'yarn.lock'), '# fixture\n');
  const sdkScripts = JSON.parse(readFileSync(new URL('../../packages/plugin-sdk/package.json', import.meta.url))).scripts;
  mkdirSync(join(packageDir, 'src'), { recursive: true });
  mkdirSync(join(packageDir, 'scripts'), { recursive: true });
  mkdirSync(join(packageDir, 'dist'), { recursive: true });
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({
    name: '@happier-dev/plugin-sdk', type: 'module', main: './dist/index.js',
    scripts: {
      build: 'fixture-compiler',
      'prepare:declarations:prepared': sdkScripts['prepare:declarations:prepared'],
      'check:action-type-map': sdkScripts['check:action-type-map'],
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
  assert.equal(existsSync(markerPath), true, 'declaration preparation must retain its drift gate');
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
  writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({ private: true, workspaces: ['packages/*', 'apps/*'] }));
  writeFileSync(join(repoRoot, 'yarn.lock'), '# fixture\n');
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

test('CLI shared dependency publication reuses an exact current runtime closure before taking the build lock', async (t) => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'happier-cli-shared-deps-current-closure-'));
  t.after(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  await assert.doesNotReject(async () => {
    await buildSharedDeps({
      repoRoot,
      lockPath: join(repoRoot, 'build.lock'),
      inspectSourceDevSharedDepsForSourceDevImpl: () => ({ current: true, reason: 'current' }),
      ensureWorkspacePackagesBuiltByNameImpl: async () => {
        throw new Error('current closure must not rebuild workspace packages');
      },
    });
  });

  assert.equal(existsSync(join(repoRoot, 'build.lock')), false);
});

test('CLI shared dependency publication rechecks the exact runtime closure after taking the build lock', async (t) => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'happier-cli-shared-deps-current-after-lock-'));
  t.after(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  let inspectionCount = 0;
  await assert.doesNotReject(async () => {
    await buildSharedDeps({
      repoRoot,
      lockPath: join(repoRoot, 'build.lock'),
      tryResolveWaiter: async () => ({ resolved: false }),
      inspectSourceDevSharedDepsForSourceDevImpl: () => ({
        current: ++inspectionCount >= 2,
        reason: inspectionCount >= 2 ? 'current' : 'not-current',
      }),
      ensureWorkspacePackagesBuiltByNameImpl: async () => {
        throw new Error('closure made current before lock acquisition must not rebuild workspace packages');
      },
    });
  });

  assert.equal(inspectionCount, 2);
  assert.equal(existsSync(join(repoRoot, 'build.lock')), false);
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
    writeFileSync(
      join(repoRoot, 'package.json'),
      JSON.stringify({
        private: true,
        workspaces: ['apps/*', 'packages/*', 'packages/plugins/*'],
      }),
      'utf8',
    );
    writeFileSync(join(repoRoot, 'yarn.lock'), '# fixture\n', 'utf8');
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

  writeFileSync(
    join(repoRoot, 'package.json'),
    JSON.stringify({ private: true, workspaces: ['packages/*'] }),
    'utf8',
  );
  writeFileSync(join(repoRoot, 'yarn.lock'), '# fixture\n', 'utf8');
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
        builds.push(packageDir);
        await writeFile(join(env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR, 'index.js'), 'export const rebuilt = true;\n');
      },
    },
  });

  assert.deepEqual(builds, [dependencyDir, consumerDir]);
});

test('workspace build admission publishes an admitted peer before its dependent chain', async (t) => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'happier-workspace-build-admitted-peer-order-'));
  t.after(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  writeFileSync(
    join(repoRoot, 'package.json'),
    JSON.stringify({ private: true, workspaces: ['packages/*'] }),
    'utf8',
  );
  writeFileSync(join(repoRoot, 'yarn.lock'), '# fixture\n', 'utf8');
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

  writeFileSync(
    join(repoRoot, 'package.json'),
    JSON.stringify({ private: true, workspaces: ['packages/*'] }),
    'utf8',
  );
  writeFileSync(join(repoRoot, 'yarn.lock'), '# fixture\n', 'utf8');
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

  writeFileSync(
    join(repoRoot, 'package.json'),
    JSON.stringify({ private: true, workspaces: ['packages/*'] }),
    'utf8',
  );
  writeFileSync(join(repoRoot, 'yarn.lock'), '# fixture\n', 'utf8');
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
        if (hostPackageDirs.includes(packageDir)) {
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

  writeFileSync(
    join(repoRoot, 'package.json'),
    JSON.stringify({ private: true, workspaces: ['packages/*'] }),
    'utf8',
  );
  writeFileSync(join(repoRoot, 'yarn.lock'), '# fixture\n', 'utf8');
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

test('package admission follows source content and membership rather than timestamps', async (t) => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'happier-workspace-content-currentness-'));
  t.after(() => rmSync(repoRoot, { recursive: true, force: true }));
  writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({ private: true, workspaces: ['packages/*'] }));
  writeFileSync(join(repoRoot, 'yarn.lock'), '# fixture\n');
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
    async runPackageBuild(_packageDir, { env }) {
      buildCalls += 1;
      writeFileSync(join(env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR, 'index.js'), readFileSync(sourcePath));
    },
  };
  const build = () => ensureWorkspacePackagesBuiltByName(repoRoot, ['@happier-dev/content'], {
    workspaceBuildBoundary,
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

test('QA workspace builds publish captured inputs despite edits during compilation; strict retains its fence', async t => {
  for (const buildMode of ['qa-runtime', 'strict']) await t.test(buildMode, async t => {
    const root = mkdtempSync(join(tmpdir(), 'workspace-captured-build-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    writeFileSync(join(root, 'package.json'), JSON.stringify({ workspaces: ['packages/*'] }));
    for (const app of ['cli', 'ui', 'server']) {
      mkdirSync(join(root, 'apps', app), { recursive: true });
      writeFileSync(join(root, 'apps', app, 'package.json'), JSON.stringify({ name: `@fixture/${app}` }));
    }
    const dir = join(root, 'packages/moving');
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@happier-dev/moving', main: './dist/index.js', scripts: { build: 'fixture-compiler' } }));
    const source = join(dir, 'src/index.ts');
    writeFileSync(source, 'export const value = "captured";');
    const fingerprint = readWorkspacePackageInputFingerprint({ packageDir: dir });
    let attempts = 0;
    const building = ensureWorkspacePackagesBuiltByName(root, ['@happier-dev/moving'], { quiet: true, buildMode,
      workspaceBuildBoundary: { prepareEnv: async (_dir, env) => env,
        runPackageBuild: async (buildDir, { env }) => {
          attempts++;
          const contents = await readFile(join(buildDir, 'src/index.ts'), 'utf8');
          await writeFile(source, 'export const value = "later-' + attempts + '";');
          assert.equal(await readFile(join(buildDir, 'src/index.ts'), 'utf8'), buildMode === 'qa-runtime' ? contents : 'export const value = "later-' + attempts + '";');
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

test('workspace phase takes one selective trailing pass for real-process input drift', async (t) => {
  for (const mode of ['settled', 'forced', 'continuing', 'compile-error', 'sibling-error']) {
    await t.test(mode, async (t) => {
      const root = mkdtempSync(join(tmpdir(), 'happier-workspace-convergence-'));
      t.after(() => rmSync(root, { recursive: true, force: true }));
      writeFileSync(join(root, 'package.json'), JSON.stringify({ workspaces: ['apps/*', 'packages/*'] }));
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
        quiet: true, maxConcurrentBuilds: 2,
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
  writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({ private: true, workspaces: ['packages/*'] }));
  writeFileSync(join(repoRoot, 'yarn.lock'), '# fixture\n');
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
    workspaceBuildBoundary,
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
  writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({ private: true, workspaces: ['packages/*', 'apps/*'] }));
  writeFileSync(join(repoRoot, 'yarn.lock'), '# fixture\n');
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

test('package input fingerprint changes with the selected compiler bytes', (t) => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'happier-workspace-compiler-identity-'));
  t.after(() => rmSync(repoRoot, { recursive: true, force: true }));
  const packageDir = join(repoRoot, 'package');
  const compilerPath = join(repoRoot, 'compiler', 'bin', 'tsc.js');
  mkdirSync(join(packageDir, 'src'), { recursive: true });
  mkdirSync(join(compilerPath, '..'), { recursive: true });
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name: '@fixture/compiler', scripts: { build: 'fixture-build' } }));
  writeFileSync(join(packageDir, 'src', 'index.ts'), 'export const value = 1;\n');
  writeFileSync(join(repoRoot, 'compiler', 'package.json'), '{"version":"1"}\n');
  writeFileSync(compilerPath, 'compiler one\n');
  const fingerprint = () => readWorkspacePackageInputFingerprint({
    packageDir,
    resolveTypeScriptCliInvocationImpl: () => ({ command: process.execPath, argsPrefix: [compilerPath] }),
  });
  const first = fingerprint();
  writeFileSync(compilerPath, 'compiler two changed\n');
  assert.notEqual(fingerprint(), first);
});

test('live publication refreshes declared output currentness when source changes without emitted-byte changes', async (t) => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'happier-workspace-build-live-currentness-'));
  t.after(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  writeFileSync(
    join(repoRoot, 'package.json'),
    JSON.stringify({ private: true, workspaces: ['packages/*'] }),
    'utf8',
  );
  writeFileSync(join(repoRoot, 'yarn.lock'), '# fixture\n', 'utf8');
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

  writeFileSync(
    join(repoRoot, 'package.json'),
    JSON.stringify({ private: true, workspaces: ['packages/*'] }),
    'utf8',
  );
  writeFileSync(join(repoRoot, 'yarn.lock'), '# fixture\n', 'utf8');
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

  writeFileSync(
    join(repoRoot, 'package.json'),
    JSON.stringify({ private: true, workspaces: ['packages/*'] }),
    'utf8',
  );
  writeFileSync(join(repoRoot, 'yarn.lock'), '# fixture\n', 'utf8');
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

  writeFileSync(
    join(repoRoot, 'package.json'),
    JSON.stringify({ private: true, workspaces: ['packages/*'] }),
    'utf8',
  );
  writeFileSync(join(repoRoot, 'yarn.lock'), '# fixture\n', 'utf8');
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

test('plugin UI runtime build uses only its package lock', async (t) => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'happier-plugin-ui-build-lock-order-'));
  t.after(() => rmSync(repoRoot, { recursive: true, force: true }));
  writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({
    private: true,
    workspaces: ['packages/*'],
  }));
  writeFileSync(join(repoRoot, 'yarn.lock'), '# fixture\n');
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

  writeFileSync(
    join(repoRoot, 'package.json'),
    JSON.stringify({ private: true, workspaces: ['packages/*'] }),
    'utf8',
  );
  writeFileSync(join(repoRoot, 'yarn.lock'), '# fixture\n', 'utf8');
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

  writeFileSync(
    join(repoRoot, 'package.json'),
    JSON.stringify({ private: true, workspaces: ['packages/*'] }),
    'utf8',
  );
  writeFileSync(join(repoRoot, 'yarn.lock'), '# fixture\n', 'utf8');
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
          assert.equal(packageDir, dependencyDir);
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
          assert.equal(packageDir, consumerDir);
          assert.equal(
            readFileSync(join(bundledDependencyDir, 'dist', 'index.js'), 'utf8'),
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

  writeFileSync(
    join(repoRoot, 'package.json'),
    JSON.stringify({ private: true, workspaces: ['packages/*'] }),
    'utf8',
  );
  writeFileSync(join(repoRoot, 'yarn.lock'), '# fixture\n', 'utf8');
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
    writeFileSync(
      join(repoRoot, 'package.json'),
      JSON.stringify({ private: true, workspaces: ['apps/*', 'packages/*'] }),
      'utf8',
    );
    writeFileSync(join(repoRoot, 'yarn.lock'), '# fixture\n', 'utf8');
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
    writeFileSync(
      join(repoRoot, 'package.json'),
      JSON.stringify({ private: true, workspaces: ['apps/*', 'packages/*'] }),
      'utf8',
    );
    writeFileSync(join(repoRoot, 'yarn.lock'), '# fixture\n', 'utf8');
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
    writeFileSync(
      join(repoRoot, 'package.json'),
      JSON.stringify({
        private: true,
        workspaces: ['apps/*', 'packages/*', 'packages/plugins/*'],
      }),
      'utf8',
    );
    writeFileSync(join(repoRoot, 'yarn.lock'), '# fixture\n', 'utf8');
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
    assert.deepEqual(helperBuildForceModes, [true]);
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
    assert.deepEqual(helperBuildForceModes, [true, false]);
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
  writeFileSync(
    join(repoRoot, 'package.json'),
    JSON.stringify({ private: true, workspaces: ['apps/*', 'packages/*'] }),
    'utf8',
  );
  writeFileSync(join(repoRoot, 'yarn.lock'), '# fixture\n', 'utf8');

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
  const yarnEntrypointPath = join(repoRoot, 'fixture-yarn.cjs');
  writeFileSync(
    yarnEntrypointPath,
    [
      "const { spawn } = require('node:child_process');",
      'const args = process.argv.slice(2);',
      "if (args.length === 1 && args[0] === '--version') process.exit(0);",
      "if (args[0] !== '-s' || args[1] !== 'build') process.exit(91);",
      `spawn(process.execPath, ['-e', ${JSON.stringify(writerSource)}, ${JSON.stringify(heartbeatPath)}, ${JSON.stringify(writerPidPath)}], { stdio: 'ignore' });`,
      'setInterval(() => {}, 1_000);',
    ].join('\n') + '\n',
    'utf8',
  );

  const env = {
    ...process.env,
    npm_execpath: yarnEntrypointPath,
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
  writeFileSync(
    join(repoRoot, 'package.json'),
    JSON.stringify({ private: true, workspaces: ['apps/*', 'packages/*'] }),
    'utf8',
  );
  writeFileSync(join(repoRoot, 'yarn.lock'), '# fixture\n', 'utf8');

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

  const yarnEntrypointPath = join(repoRoot, 'fixture-quiet-failure-yarn.cjs');
  writeFileSync(
    yarnEntrypointPath,
    [
      'const args = process.argv.slice(2);',
      "if (args.length === 1 && args[0] === '--version') process.exit(92);",
      "if (args[0] !== '-s' || args[1] !== 'build') process.exit(91);",
      "process.stdout.write('stdout-head\\n' + 'x'.repeat(10_000) + 'stdout-tail\\n');",
      "process.stderr.write('stderr-head\\n' + 'y'.repeat(10_000) + 'stderr-tail\\n');",
      'process.exit(37);',
    ].join('\n') + '\n',
    'utf8',
  );

  let failure = null;
  await assert.rejects(
    ensureWorkspacePackagesBuiltByName(
      repoRoot,
      ['@happier-dev/quiet-diagnostic'],
      {
        env: { ...process.env, npm_execpath: yarnEntrypointPath },
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
  writeFileSync(
    join(repoRoot, 'package.json'),
    JSON.stringify({ private: true, workspaces: ['apps/*', 'packages/*'] }),
    'utf8',
  );
  writeFileSync(join(repoRoot, 'yarn.lock'), '# fixture\n', 'utf8');

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

  const yarnEntrypointPath = join(repoRoot, 'fixture-stack-yarn.cjs');
  writeFileSync(
    yarnEntrypointPath,
    [
      "const { mkdirSync, writeFileSync } = require('node:fs');",
      "const { join } = require('node:path');",
      'const args = process.argv.slice(2);',
      "if (args.length === 1 && args[0] === '--version') process.exit(0);",
      "if (args[0] !== '-s' || args[1] !== 'build') process.exit(91);",
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
  const yarnCommandPath = join(binDir, process.platform === 'win32' ? 'yarn.cmd' : 'yarn');
  writeFileSync(
    yarnCommandPath,
    process.platform === 'win32'
      ? `@${JSON.stringify(process.execPath)} ${JSON.stringify(yarnEntrypointPath)} %*\r\n`
      : `#!${process.execPath}\nrequire(${JSON.stringify(yarnEntrypointPath)});\n`,
    'utf8',
  );
  chmodSync(yarnCommandPath, 0o755);

  await assert.rejects(
    ensureStackWorkspacePackagesBuiltByName(
      repoRoot,
      ['@happier-dev/stack-timeout'],
      {
        env: { ...process.env, PATH: binDir },
        force: true,
        quiet: true,
        timeoutMs: 100,
      },
    ),
  );
});
