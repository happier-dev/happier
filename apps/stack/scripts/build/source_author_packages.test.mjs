// @happier-test-preparation source
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cp, mkdir, readFile, writeFile, readdir, rm, symlink } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import childProcess from 'node:child_process';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { build } from 'esbuild';
import { createTempFixture } from '../testkit/core/temp_fixture.mjs';
import { installSourcePreparationInputs } from '../testkit/core/source_runtime_fixture.mjs';
import { readWorkspacePackages } from '../../../../packages/cli-common/sourceRuntimeEntries.mjs';
import { emitSourceAuthorPackages } from './source_author_packages.mjs';
import { setBundleReadOnly } from './build_source_runtime.mjs';
import { captureRuntimeDependencies } from './captured_runtime_dependencies.mjs';
import { runCapture } from '../utils/proc/proc.mjs';
import { collectExternalRuntimeDependencies, resolveInstalledRuntimePackage } from '../../../../packages/cli-common/workspaceRuntimeDependencies.mjs';

test('source author runtime emits the 18-package closure without native declaration compilers', async context => {
  const fixture = await createTempFixture(context, { prefix: 'source-author-js-' });
  const repoDir = fixture.path('repo');
  const projectDir = join(repoDir, 'apps/cli');
  const runtimeDir = fixture.path('runtime');
  await mkdir(projectDir, { recursive: true });
  await mkdir(runtimeDir);
  await writeFile(join(runtimeDir, 'package.json'), JSON.stringify({ name: '@fixture/runtime' }));
  const workspaceOwner = fixture.path('workspaces.mjs');
  await build({ entryPoints: [fileURLToPath(new URL('../../../../packages/cli-common/src/workspaces/index.ts', import.meta.url))],
    outfile: workspaceOwner, bundle: true, platform: 'node', format: 'esm', conditions: ['happier-source'], logLevel: 'silent' });
  const { bundleInstalledPackageWithRuntimeDependencies, materializePrepublicationWorkspacePackageRoots } =
    await import(pathToFileURL(workspaceOwner).href);
  await writeFile(join(projectDir, 'package.json'), JSON.stringify({ name: '@happier-dev/cli',
    bundledDependencies: [...Array.from({ length: 18 }, (_, index) => index === 17 ? '@happier-dev/plugin-sdk' : `@happier-dev/author-${index}`),
      '@happier-dev/author-private'] }));
  for (let index = 0; index < 18; index++) {
    const name = index === 17 ? 'plugin-sdk' : `author-${index}`;
    const directory = join(repoDir, 'packages', name);
    await mkdir(join(directory, 'src'), { recursive: true });
    const dependency = index ? `@happier-dev/author-${index - 1}` : undefined;
    await writeFile(join(directory, 'package.json'), JSON.stringify({ name: `@happier-dev/${name}`,
      version: '0.0.0', type: 'module', main: './dist/index.js', types: './dist/index.d.ts',
      exports: { '.': { 'happier-source': './src/index.ts', types: './dist/index.d.ts', default: './dist/index.js' } },
      ...(dependency ? { dependencies: { [dependency]: '0.0.0', ...(index === 17 ? { 'author-external': '1.0.0' } : {}) }, bundledDependencies: index === 17 ? [...Array.from({ length: 17 }, (_, index) => `@happier-dev/author-${index}`), '@happier-dev/author-private', 'author-external'] : [dependency] } : {
        dependencies: { zod: '4.6.7' }, optionalDependencies: { 'happier-author-fixture-absent-optional': '1.0.0' },
      }),
      ...(index === 17 ? { happier: { publicSdkRelease: { posture: 'developer_preview' } } } : {}) }));
    await writeFile(join(directory, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
      target: 'ES2022', module: index ? 'NodeNext' : 'ESNext', moduleResolution: index ? 'NodeNext' : 'Bundler', declaration: true, resolveJsonModule: true, strict: true,
      rootDir: 'src', outDir: 'dist' }, include: ['src/**/*.ts'] }));
    await writeFile(join(directory, 'src/index.ts'), dependency
      ? `export { value } from '${dependency}';\n` : 'import data from "./data.json" with { type: "json" }; export const value = data.value;\n');
    if (!index) {
      await writeFile(join(directory, 'src/data.json'), '{"value":"captured"}');
      await writeFile(join(directory, 'src/schema.ts'), 'import { z } from "zod/mini"; export const schema: z.ZodMiniType<string> = z.string().check(z.refine(value => value.trim().length > 0));\n');
      await writeFile(join(directory, 'src/selection.ts'), 'import { schema } from "./schema.js"; export function selectedSchema() { return schema; }\n');
      bundleInstalledPackageWithRuntimeDependencies({ packageName: 'zod',
        resolveFromPackageJsonPath: fileURLToPath(new URL('../../../../packages/protocol/package.json', import.meta.url)),
        destNodeModulesDir: join(directory, 'node_modules') });
    }
  }
  const privateDirectory = join(repoDir, 'packages', 'author-private');
  await mkdir(join(privateDirectory, 'src'), { recursive: true });
  await writeFile(join(privateDirectory, 'package.json'), JSON.stringify({ name: '@happier-dev/author-private',
    version: '0.0.0', type: 'module', main: './dist/index.js', types: './dist/index.d.ts',
    exports: { '.': { 'happier-source': './src/index.ts', types: './dist/index.d.ts', default: './dist/index.js' } } }));
  await writeFile(join(privateDirectory, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
    target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', declaration: true, strict: true,
    rootDir: 'src', outDir: 'dist' }, include: ['src/**/*.ts'] }));
  await writeFile(join(privateDirectory, 'src/index.ts'), 'export const value = "private";\n');
  await mkdir(join(runtimeDir, 'node_modules'), { recursive: true });
  await cp(join(repoDir, 'packages', 'author-0', 'node_modules', 'zod'), join(runtimeDir, 'node_modules', 'zod'), { recursive: true });
  const externalSource = fixture.path('retained-install/node_modules/author-external');
  await mkdir(externalSource, { recursive: true });
  await writeFile(join(externalSource, 'package.json'), JSON.stringify({ name: 'author-external', version: '1.0.0', main: './index.js' }));
  await writeFile(join(externalSource, 'index.js'), 'export const external = "captured-external";\n');
  await mkdir(join(repoDir, 'packages', 'plugin-sdk', 'node_modules'), { recursive: true });
  await symlink(externalSource, join(repoDir, 'packages', 'plugin-sdk', 'node_modules', 'author-external'));
  const runtimeExternal = join(runtimeDir, 'node_modules', 'author-external');
  await mkdir(runtimeExternal, { recursive: true });
  await writeFile(join(runtimeExternal, 'package.json'), JSON.stringify({ name: 'author-external', version: '1.0.0', main: './index.js' }));
  await writeFile(join(runtimeExternal, 'index.js'), 'export const external = "captured-external";\n');
  captureRuntimeDependencies({
    imports: [
      { path: '@typescript/native', resolveFrom: fileURLToPath(new URL('../../../../package.json', import.meta.url)) },
      { path: 'esbuild', resolveFrom: fileURLToPath(new URL('../../../cli/package.json', import.meta.url)) },
    ],
    outputDir: repoDir, sourceRepoDir: fileURLToPath(new URL('../../../../', import.meta.url)),
  });
  await installSourcePreparationInputs(repoDir, 'daemon');
  const sourceInputDigests = {};
  let declarationCompilers = 0;
  const originalSpawn = childProcess.spawn;
  childProcess.spawn = function(command, args, ...options) {
    if (args?.some(arg => arg.includes('--project') || arg === '-p')) {
      declarationCompilers++;
      throw new Error('Ordinary daemon preparation must not launch a declaration compiler');
    }
    return originalSpawn.call(this, command, args, ...options);
  };
  syncBuiltinESMExports();
  let result;
  try {
    result = await emitSourceAuthorPackages({ repoDir, sourceRepoDir: repoDir, projectDir, runtimeDir,
      workspacePackages: await readWorkspacePackages(repoDir), build, sourceInputDigests,
      readSourceInput: path => readFile(path), env: process.env });
  } finally {
    childProcess.spawn = originalSpawn;
    syncBuiltinESMExports();
  }
  assert.equal(declarationCompilers, 0, 'ordinary daemon preparation launches zero declaration compilers at real closure scale');
  const declarations = result.codeFiles.filter(path => /[\\/]dist[\\/].*\.d\.[cm]?ts$/.test(path));
  assert.equal(declarations.length, 0, 'daemon preparation must not emit plugin-author declarations');
  assert.equal(result.codeFiles.filter(path => path.endsWith(join('dist', 'index.js'))).length, 19);
  const sdk = join(runtimeDir, 'authoring/node_modules/@happier-dev/plugin-sdk');
  assert.match(await readFile(join(sdk, 'dist/index.js'), 'utf8'), /author-16/);
  const privateBundle = join(runtimeDir, 'authoring/node_modules/@happier-dev/author-private');
  assert.match(await readFile(join(privateBundle, 'dist/index.js'), 'utf8'), /private/);
  assert.equal(await readFile(join(sdk, 'node_modules/author-external/index.js'), 'utf8'), 'export const external = "captured-external";\n');
  // A revision runtime that captures its dependencies has none linked yet: its author
  // packages resolve their externals from the revision's own installation.
  const revisionRuntime = fixture.path('revision-runtime');
  const installation = fixture.path('installation');
  await mkdir(revisionRuntime);
  await writeFile(join(revisionRuntime, 'package.json'), JSON.stringify({ name: '@fixture/revision-runtime' }));
  await cp(join(runtimeDir, 'node_modules'), join(installation, 'node_modules'), { recursive: true });
  // The installation nests the SDK's own version under its workspace; the hoisted
  // root holds another one that does not satisfy the SDK's declared range.
  await cp(join(installation, 'node_modules/author-external'), join(installation, 'packages/plugin-sdk/node_modules/author-external'), { recursive: true });
  await writeFile(join(installation, 'node_modules/author-external/package.json'), JSON.stringify({ name: 'author-external', version: '0.9.0', main: './index.js' }));
  const revisionResult = await emitSourceAuthorPackages({ repoDir, sourceRepoDir: repoDir, projectDir, runtimeDir: revisionRuntime,
    workspacePackages: await readWorkspacePackages(repoDir), build, sourceInputDigests: {},
    readSourceInput: path => readFile(path), env: process.env,
    authorDependencies: { resolveFromPackageJsonPath: bundle => join(installation, relative(repoDir, bundle.srcDir), 'package.json'),
      dereferenceRootDir: installation, toolRootDir: installation } });
  // Its deferred compiler and bundler are captured from that installation too.
  assert.ok(revisionResult.runtimeImports.every(item => item.resolveFrom.startsWith(installation)));
  assert.equal(await readFile(join(revisionRuntime, 'authoring/node_modules/@happier-dev/plugin-sdk/node_modules/author-external/index.js'), 'utf8'),
    'export const external = "captured-external";\n');
  assert.match(await readFile(join(sdk, 'dist/.happier-source/src/index.ts'), 'utf8'), /author-16/);
  assert.ok((await readdir(join(sdk, 'dist/.happier-source'))).includes('tsconfig.json'),
    'the existing author materializer can produce declarations later from captured inputs');
  const declarationOwner = fixture.path('source-declarations.mjs');
  await build({ entryPoints: [fileURLToPath(new URL('../../../cli/src/plugins/authoring/sourceDeclarations.ts', import.meta.url))],
    outfile: declarationOwner, bundle: true, platform: 'node', format: 'esm', conditions: ['happier-source'], logLevel: 'silent' });
  const { emitSourceAuthorDeclarations } = await import(pathToFileURL(declarationOwner).href);
  const materializationRoot = fixture.path('materialized');
  const packageNames = [...Array.from({ length: 18 }, (_, index) => index === 17 ? '@happier-dev/plugin-sdk' : `@happier-dev/author-${index}`),
    '@happier-dev/author-private'];
  await setBundleReadOnly(runtimeDir, true);
  try {
    materializePrepublicationWorkspacePackageRoots({ rootPackageNames: ['@happier-dev/plugin-sdk'],
      bundles: packageNames.map(packageName => ({ packageName,
        srcDir: join(runtimeDir, 'authoring/node_modules', packageName),
        destDir: join(materializationRoot, 'node_modules', packageName) })) });
  } finally {
    await setBundleReadOnly(runtimeDir, false);
  }
  const materializedSdk = join(materializationRoot, 'node_modules/@happier-dev/plugin-sdk');
  await rm(join(repoDir, 'packages'), { recursive: true, force: true });
  // A transferred runtime must resolve its deferred compiler without the checkout.
  captureRuntimeDependencies({ imports: result.runtimeImports ?? [], outputDir: runtimeDir, sourceRepoDir: repoDir });
  const runtimeRequire = createRequire(join(runtimeDir, 'package.json'));
  const authorBundler = runtimeRequire('esbuild');
  const bundled = await authorBundler.build({ stdin: { contents: 'export const plugin = "captured-author";' },
    bundle: true, platform: 'node', format: 'esm', write: false });
  assert.match(bundled.outputFiles[0].text, /captured-author/,
    'a transferred author runtime can execute its physical bundler without the checkout');
  const compiler = resolveInstalledRuntimePackage({ packageName: '@typescript/native',
    resolveFromPackageJsonPath: join(runtimeDir, 'package.json') });
  const compilerManifest = JSON.parse(await readFile(compiler.packageJsonPath, 'utf8'));
  const compilerPath = join(compiler.packageDir, compilerManifest.bin.tsc);
  let authorCompilers = 0;
  await emitSourceAuthorDeclarations([materializedSdk], async (projectPath, workingDirectory) => {
    const args = ['-p', projectPath];
    await runCapture(process.execPath, [compilerPath, ...args], { cwd: workingDirectory, env: process.env });
    authorCompilers++;
  });
  assert.equal(authorCompilers, 18, 'an explicit author preparation emits each captured package once, dependency first');
  assert.match(await readFile(join(materializedSdk, 'dist/index.d.ts'), 'utf8'), /author-16/);
  const materializedLeaf = resolveInstalledRuntimePackage({
    packageName: '@happier-dev/author-0', resolveFromPackageJsonPath: join(materializedSdk, 'package.json'),
  }).packageDir;
  assert.match(await readFile(join(materializedLeaf, 'dist/selection.d.ts'), 'utf8'), /selectedSchema/);
  assert.ok((await readdir(join(sdk, 'dist/.happier-source'))).includes('tsconfig.json'),
    'author compilation leaves the original source runtime capture intact');
  const value = await import(pathToFileURL(join(materializedSdk, 'dist/index.js')).href);
  assert.equal(value.value, 'captured', 'the same physical SDK closure remains executable');
  await emitSourceAuthorDeclarations([materializedSdk], async () => assert.fail('already prepared author packages need no compiler'));
});

test('source author runtime emits the real plugin-sdk to agents closure for the packaged resolver', async context => {
  const fixture = await createTempFixture(context, { prefix: 'source-author-real-closure-' });
  const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url));
  const projectDir = fixture.path('project');
  await mkdir(projectDir);
  const runtimeDir = fixture.path('bundle/apps/cli');
  const pluginSdkManifest = JSON.parse(await readFile(join(repositoryRoot, 'packages/plugin-sdk/package.json'), 'utf8'));
  await mkdir(runtimeDir, { recursive: true });
  await writeFile(join(runtimeDir, 'package.json'), JSON.stringify({ name: '@fixture/runtime' }));
  const workspacePackages = await readWorkspacePackages(repositoryRoot);
  const workspaceOwner = fixture.path('workspaces.mjs');
  await build({ entryPoints: [join(repositoryRoot, 'packages/cli-common/src/workspaces/index.ts')],
    outfile: workspaceOwner, bundle: true, platform: 'node', format: 'esm', conditions: ['happier-source'], logLevel: 'silent' });
  const { resolveInternalWorkspacePackageNameClosure, resolveWorkspaceBundlesFromPackageJson } =
    await import(pathToFileURL(workspaceOwner).href);
  const closure = resolveInternalWorkspacePackageNameClosure({ repoRoot: repositoryRoot,
    packageNames: [pluginSdkManifest.name, ...pluginSdkManifest.bundledDependencies] });
  const hostBundles = resolveWorkspaceBundlesFromPackageJson({ repoRoot: repositoryRoot,
    hostPackageDir: join(repositoryRoot, 'apps/cli') });
  assert.ok(closure.every(name => hostBundles.some(bundle => bundle.packageName === name)),
    'the real CLI declares the SDK bundled workspace closure');
  // Emit only this public SDK's real closure, without unrelated CLI SDK roots.
  await writeFile(join(projectDir, 'package.json'), JSON.stringify({ name: '@happier-dev/cli', bundledDependencies: closure }));
  const imports = closure.flatMap(name => {
    const workspace = workspacePackages.get(name);
    return collectExternalRuntimeDependencies(workspace.manifest)
      .filter(dependency => !workspacePackages.has(dependency.name))
      .map(dependency => ({ path: dependency.name, resolveFrom: join(workspace.root, 'package.json') }));
  });
  captureRuntimeDependencies({ imports, outputDir: runtimeDir, sourceRepoDir: repositoryRoot,
    manifestPath: join(repositoryRoot, 'packages/plugin-sdk/package.json') });
  await writeFile(fixture.path('bundle/source-bundle.json'), JSON.stringify({ runtimeDir, cliDir: runtimeDir }));

  await emitSourceAuthorPackages({ repoDir: repositoryRoot, sourceRepoDir: repositoryRoot, projectDir, runtimeDir,
    workspacePackages, build, sourceInputDigests: {},
    readSourceInput: path => readFile(path), env: process.env });

  const resolverOutput = await runCapture(process.execPath, [
    '--conditions=happier-source', '--import', join(repositoryRoot, 'packages/cli-common/registerSourceRuntime.mjs'),
    '--input-type=module', '-e', `import { resolvePackagedCliBundledWorkspacePackageRoot } from './apps/cli/src/plugins/authoring/hostSdkResolution.ts';
      console.log(resolvePackagedCliBundledWorkspacePackageRoot(${JSON.stringify(runtimeDir)}, '@happier-dev/agents'));`,
  // The CLI's `@/` aliases resolve through its own tsconfig, as in the canonical launcher.
  ], { cwd: repositoryRoot, env: { ...process.env, TSX_TSCONFIG_PATH: join(repositoryRoot, 'apps/cli/tsconfig.json') } });
  const agentsRoot = resolverOutput.trim();
  assert.equal(agentsRoot, join(runtimeDir, 'authoring/node_modules/@happier-dev/agents'));
  assert.equal(JSON.parse(await readFile(join(agentsRoot, 'package.json'))).name, '@happier-dev/agents');
  assert.ok((await readFile(join(agentsRoot, 'dist/index.js'))).length > 0, 'the physical agents package contains emitted code');
});
