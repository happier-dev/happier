import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdir, rename, symlink, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { test } from 'node:test';
import { createTempFixture } from '../testkit/core/temp_fixture.mjs';
import { readSourceAuthorDependencyIdentity, readSourceRuntimeDependencyIdentity } from './source_author_inputs.mjs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { withBuildInputDependencies, withSingleTrailingBuildPass } from '../../../../scripts/workspaces/buildInputConvergence.mjs';
import { resolveInstalledRuntimePackage } from '../../../../packages/cli-common/workspaceRuntimeDependencies.mjs';
import { assertSourceRuntimeDependenciesCurrent } from '../../../../packages/cli-common/sourceRuntimeDependencies.mjs';
import { readDependencyPublicationState, resolveDependencyRefreshLockPath, resolveDependencyRefreshMarkerPath, withDependencyRefresh } from '../utils/proc/dependency_refresh.mjs';

test('runtime closure invalidates a removed installed path and re-resolves after an install relayout', async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-runtime-input-relayout-' });
  const sourceDir = fixture.path('repo');
  const importer = fixture.path('repo/apps/cli/package.json');
  const nested = fixture.path('repo/apps/cli/node_modules/runtime-input');
  const hoisted = fixture.path('repo/node_modules/runtime-input');
  const env = { ...process.env, HAPPIER_STACK_HOME_DIR: fixture.path('home'),
    HAPPIER_STACK_SKIP_REFRESH_DEPS: '0', HAPPIER_STACK_DISABLE_REFRESH_DEPS: '0' };
  await mkdir(nested, { recursive: true });
  await mkdir(fixture.path('repo/node_modules'), { recursive: true });
  await writeFile(fixture.path('repo/package.json'), '{"private":true}');
  await writeFile(importer, '{"private":true}');
  await withDependencyRefresh({ installDir: sourceDir, env }, async () => {
    await writeFile(`${nested}/package.json`, JSON.stringify({ name: 'runtime-input', main: 'index.cjs' }));
    await writeFile(`${nested}/index.cjs`, 'exports.value = 1;');
  });
  await symlink(fileURLToPath(new URL('../../', import.meta.url)), fixture.path('repo/apps/stack'),
    process.platform === 'win32' ? 'junction' : 'dir');
  const dependencyPublication = { ...await readDependencyPublicationState({ installDir: sourceDir, env }),
    markerPath: resolveDependencyRefreshMarkerPath(sourceDir),
    generationPath: `${resolveDependencyRefreshLockPath(sourceDir, env)}.generation` };
  let attempts = 0;
  let before;
  let staleImports;
  const result = await withSingleTrailingBuildPass({ run: () => withBuildInputDependencies({ sourceDir, env }, async () => {
    attempts++;
    const installed = resolveInstalledRuntimePackage({ packageName: 'runtime-input', resolveFromPackageJsonPath: importer });
    const imports = [{ path: pathToFileURL(`${installed.packageDir}/index.cjs`).href, resolveFrom: importer }];
    if (attempts === 1) {
      staleImports = imports;
      before = readSourceRuntimeDependencyIdentity({ imports });
      await withDependencyRefresh({ installDir: sourceDir, env, force: true }, async () => {
        await rename(nested, hoisted);
      });
    }
    return { imports, identity: readSourceRuntimeDependencyIdentity({ imports }) };
  }) });
  assert.equal(attempts, 2, 'the existing generation owner discards the stale closure and runs its trailing pass');
  assert.equal(result.imports[0].path, pathToFileURL(`${hoisted}/index.cjs`).href);
  assert.notEqual(readSourceRuntimeDependencyIdentity({ imports: staleImports }), before,
    'a vanished absolute import must invalidate the old runtime without inventorying an ancestor workspace');
  assert.equal(result.identity, readSourceRuntimeDependencyIdentity({ imports: result.imports }));
  assert.equal((await readDependencyPublicationState({ installDir: sourceDir, env })).identity, dependencyPublication.identity,
    'the relayout changes installation generation without changing dependency manifest identity');
  const entrypoint = fixture.path('runtime/apps/cli/src/index.mjs');
  await assert.doesNotReject(assertSourceRuntimeDependenciesCurrent({ entrypoint, env, record: {
    dependencyPublication, runtimeDependencyClosure: result,
  } }), 'an unchanged runtime closure remains usable after a completed reinstall');
  await assert.rejects(assertSourceRuntimeDependenciesCurrent({ entrypoint, env, record: {
    dependencyPublication, runtimeDependencyClosure: { imports: staleImports, identity: before },
  } }), { code: 'SOURCE_RUNTIME_RELOAD_REQUIRED' },
  'generation changes invalidate cached closure proofs even when manifest identity stays the same');
});

test('runtime dependency identity survives identical installed-file replacement but rejects changed bytes', async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-runtime-input-content-' });
  const dependency = fixture.path('node_modules/runtime-input');
  await mkdir(dependency, { recursive: true });
  await writeFile(`${dependency}/package.json`, JSON.stringify({ name: 'runtime-input', main: 'index.cjs' }));
  const entry = `${dependency}/index.cjs`;
  const contents = 'exports.value = 1;';
  await writeFile(entry, contents);
  const readIdentity = () => readSourceRuntimeDependencyIdentity({
    imports: [{ path: 'runtime-input', resolveFrom: fixture.path('package.json') }],
  });
  const before = readIdentity();
  const uiDependency = fixture.path('node_modules/@tauri-apps/plugin-http');
  await mkdir(uiDependency, { recursive: true });
  await writeFile(`${uiDependency}/package.json`, JSON.stringify({ name: '@tauri-apps/plugin-http', main: 'index.cjs' }));
  await writeFile(`${uiDependency}/index.cjs`, 'exports.uiPatch = true;');
  assert.equal(readIdentity(), before, 'an unrelated UI package patch must not invalidate the daemon runtime closure');
  await writeFile(`${entry}.replacement`, contents);
  await rename(`${entry}.replacement`, entry);
  assert.equal(readIdentity(), before, 'a dependency refresh replacing identical bytes preserves the retained runtime');
  await writeFile(entry, 'exports.value = 2;');
  assert.notEqual(readIdentity(), before, 'changed same-size runtime code must still invalidate the retained runtime');
});

test('source author identity ignores module metadata files and follows scoped package directories', async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-source-author-inputs-' });
  const repoDir = fixture.path('repo');
  const stackDir = fixture.path('repo/apps/stack');
  const scope = fixture.path('repo/apps/stack/node_modules/@happier-dev');
  const externalScope = fixture.path('repo/apps/stack/node_modules/@external');
  const dependency = fixture.path('installed/dependency');
  await Promise.all([scope, externalScope, dependency].map(path => mkdir(path, { recursive: true })));
  await writeFile(fixture.path('compiler.js'), '// compiler');
  await writeFile(`${dependency}/package.json`, JSON.stringify({ name: '@external/dependency' }));
  await writeFile(`${dependency}/index.js`, 'export const value = 1;');
  await symlink(dependency, `${externalScope}/dependency`, process.platform === 'win32' ? 'junction' : 'dir');
  const readIdentity = () => readSourceAuthorDependencyIdentity({
    sourceRepoDir: repoDir,
    repoDir,
    workspacePackages: new Map([['@happier-dev/stack', { root: stackDir }]]),
    compilerPath: fixture.path('compiler.js'),
  });
  const before = readIdentity();
  await writeFile(`${scope}/.workspace-bundle-manifest.json`, '{}');
  await writeFile(`${externalScope}/.workspace-bundle-manifest.json`, '{}');
  await writeFile(`${externalScope}/metadata.json`, '{}');
  assert.equal(readIdentity(), before, 'regular scope entries are not installed package directories');
  await writeFile(`${dependency}/index.js`, 'export const value = 200;');
  assert.notEqual(readIdentity(), before, 'a real symlinked scoped dependency remains an authoring input');
});

test('declaration dependency identity excludes runtime bodies while following transitive type inputs', async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-declaration-input-content-' });
  const dependency = fixture.path('node_modules/build-types');
  const transitive = fixture.path('node_modules/transitive-types');
  for (const [root, manifest] of [
    [dependency, { name: 'build-types', dependencies: { 'transitive-types': '1.0.0' } }],
    [transitive, { name: 'transitive-types', version: '1.0.0' }],
  ]) {
    await mkdir(root, { recursive: true });
    await writeFile(`${root}/package.json`, JSON.stringify(manifest));
    await writeFile(`${root}/index.js`, 'exports.value = 1;');
    await writeFile(`${root}/index.d.ts`, 'export declare const value: number;');
  }
  const readIdentity = () => readSourceRuntimeDependencyIdentity({
    imports: [{ path: 'build-types', resolveFrom: fixture.path('package.json') }],
    declarationsOnly: true,
  });
  const reads = { directories: 0, runtimeBodies: 0, declarationBodies: 0 };
  const originalRead = fs.readFileSync;
  const originalReadDirectory = fs.readdirSync;
  fs.readFileSync = (path, ...args) => {
    if (String(path).startsWith(fixture.path(''))) {
      if (/\.(?:js|cjs|mjs)$/.test(String(path))) reads.runtimeBodies++;
      if (/\.d\.(?:ts|cts|mts)$/.test(String(path))) reads.declarationBodies++;
    }
    return originalRead(path, ...args);
  };
  fs.readdirSync = (path, ...args) => {
    if (String(path).startsWith(fixture.path(''))) reads.directories++;
    return originalReadDirectory(path, ...args);
  };
  syncBuiltinESMExports();
  t.after(() => {
    fs.readFileSync = originalRead;
    fs.readdirSync = originalReadDirectory;
    syncBuiltinESMExports();
  });
  const before = readIdentity();
  const coldReads = { ...reads };
  assert.equal(readIdentity(), before);
  assert.equal(reads.declarationBodies, coldReads.declarationBodies, 'warm declaration checks reuse the canonical content-digest cache');
  assert.equal(reads.runtimeBodies, 0, 'development tooling runtime bodies are never hashed by a declaration check');
  t.diagnostic(JSON.stringify({ coldReads, warmAdditionalDirectories: reads.directories - coldReads.directories,
    warmAdditionalDeclarationBodies: reads.declarationBodies - coldReads.declarationBodies }));
  await writeFile(`${transitive}/index.js`, 'exports.value = 2;');
  assert.equal(readIdentity(), before, 'UI tooling runtime patches do not change TypeScript declaration inputs');
  const replacement = fixture.path('replacement-types');
  await mkdir(replacement, { recursive: true });
  await writeFile(`${replacement}/package.json`, JSON.stringify({ name: 'transitive-types', version: '1.0.0' }));
  await writeFile(`${replacement}/index.js`, 'exports.value = 3;');
  await writeFile(`${replacement}/index.d.ts`, 'export declare const value: number;');
  await rename(transitive, `${transitive}-previous`);
  await symlink(replacement, transitive, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(readIdentity(), before, 'pnpm patch relocation with identical declarations preserves compile identity');
  await writeFile(`${transitive}/index.d.ts.replacement`, 'export declare const value: number;');
  await rename(`${transitive}/index.d.ts.replacement`, `${transitive}/index.d.ts`);
  assert.equal(readIdentity(), before, 'identical declaration replacement during refresh preserves compile identity');
  await writeFile(`${transitive}/index.d.ts`, 'export declare const value: string;');
  assert.notEqual(readIdentity(), before, 'transitive external types remain compilation inputs');
});
