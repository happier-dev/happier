import assert from 'node:assert/strict';
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { inspectDependencyRefresh, SCRIPTLESS_DEPENDENCY_INSTALL_MODE, withDependencyRefresh } from '../proc/dependency_refresh.mjs';
import { ensureWorkspacePackagesBuiltForComponent, inspectWorkspaceQaStalePackages, WORKSPACE_BUILD_MODE_ENV } from '../../../../../scripts/workspaces/ensureWorkspacePackagesBuilt.mjs';
import { resolveTypeScriptCliInvocation } from '../../../../../scripts/workspaces/resolveTypeScriptCliInvocation.mjs';
import {
  REACT_NATIVE_ENRICHED_MARKDOWN_STREAMING_PATCH_REQUIRED_FILES,
  REACT_NATIVE_ENRICHED_MARKDOWN_STREAMING_PATCH_REQUIRED_MARKERS,
} from '../../../../ui/tools/postinstall/verifyReactNativeEnrichedMarkdownWebStreamingPatch.mjs';

import {
  REMOTE_INITIAL_DEPENDENCY_INSTALL_ARGS,
  bootstrapRemoteDependencies,
} from './remote_dependency_bootstrap.mjs';

const runDependencyRefreshImmediately = async (_options, refresh) => await refresh({});

async function copyColdPreparationSourceGraph(repoDir) {
  const sourceRepoDir = fileURLToPath(new URL('../../../../../', import.meta.url));
  for (const relativeDir of ['apps/stack/scripts/utils', 'scripts/workspaces']) {
    await cp(join(sourceRepoDir, relativeDir), join(repoDir, relativeDir), {
      recursive: true,
      filter: (sourcePath) => !sourcePath.endsWith('.test.mjs'),
    });
  }
  const sourceCommonDir = join(sourceRepoDir, 'packages', 'cli-common');
  const commonDir = join(repoDir, 'packages', 'cli-common');
  await mkdir(commonDir, { recursive: true });
  for (const entry of await readdir(sourceCommonDir, { withFileTypes: true })) {
    if (entry.isFile() && (entry.name === 'package.json'
      || (/\.(mjs|cjs)$/u.test(entry.name) && !entry.name.endsWith('.test.mjs')))) {
      await cp(join(sourceCommonDir, entry.name), join(commonDir, entry.name));
    }
  }
  return sourceRepoDir;
}

test('runtime worker bootstrap retains coherent last-green output in explicit QA mode while release stays strict', async (t) => {
  const repoDir = await mkdtemp(join(tmpdir(), 'happier-runtime-bootstrap-qa-'));
  t.after(async () => rm(repoDir, { recursive: true, force: true }));
  await writeFile(join(repoDir, 'package.json'), JSON.stringify({ private: true, workspaces: ['apps/*', 'packages/*'] }));
  for (const name of ['cli', 'ui', 'server', 'stack']) {
    await mkdir(join(repoDir, 'apps', name), { recursive: true });
    await writeFile(join(repoDir, 'apps', name, 'package.json'), JSON.stringify({
      name: `@fixture/${name}`, ...(name === 'stack' ? { dependencies: { '@fixture/emitted': '1.0.0' } } : {}),
    }));
  }
  const packageDir = join(repoDir, 'packages/emitted');
  await mkdir(join(packageDir, 'src'), { recursive: true });
  const source = join(packageDir, 'src/index.ts');
  await writeFile(source, 'export const value: string = "green";\n');
  await writeFile(join(packageDir, 'package.json'), JSON.stringify({
    name: '@fixture/emitted', version: '1.0.0', type: 'module', main: './dist/index.js', types: './dist/index.d.ts',
    scripts: { build: 'node compile.mjs' },
  }));
  await writeFile(join(packageDir, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
    target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', rootDir: 'src', declaration: true, strict: true, types: [],
  }, include: ['src/**/*.ts'] }));
  const compiler = resolveTypeScriptCliInvocation({});
  await writeFile(join(packageDir, 'compile.mjs'), `import { spawnSync } from 'node:child_process';
const result = spawnSync(${JSON.stringify(compiler.command)}, [...${JSON.stringify(compiler.argsPrefix)}, '-p', 'tsconfig.json', '--outDir', process.env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR], { stdio: 'inherit', env: process.env });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
`);
  await ensureWorkspacePackagesBuiltForComponent(join(repoDir, 'apps/stack'), { quiet: true, env: { ...process.env, [WORKSPACE_BUILD_MODE_ENV]: 'strict' } });
  const recordPath = join(packageDir, 'dist/.happier-build-inputs.json');
  const greenRecord = JSON.parse(await readFile(recordPath, 'utf8'));
  for (const domain of ['workspaces', 'process']) {
    await mkdir(join(repoDir, 'packages/cli-common/dist', domain), { recursive: true });
    await writeFile(join(repoDir, 'packages/cli-common/dist', domain, 'index.js'), 'export {};\n');
  }
  await mkdir(join(repoDir, 'node_modules'), { recursive: true });
  await writeFile(source, 'export const value: string = 1;\n');
  // Installed dependency admission is separate from package compilation. The
  // real bootstrap, Stack package-manager adapter and compiler all run below it.
  const env = { ...process.env, HAPPIER_STACK_SKIP_REFRESH_DEPS: '1', [WORKSPACE_BUILD_MODE_ENV]: 'qa-runtime' };
  const bootstrap = (extraEnv = {}) => bootstrapRemoteDependencies({ repoDir, componentRelativeDir: 'apps/stack', env: { ...env, ...extraEnv } });
  await bootstrap();
  const stale = await inspectWorkspaceQaStalePackages(repoDir, ['@fixture/emitted']);
  assert.equal(stale.length, 1);
  assert.equal(stale[0].lastGreenBuildRecord.fingerprint, greenRecord.fingerprint);
  assert.match(stale[0].diagnosticSummary, /TS2322/);
  assert.match(await readFile(join(packageDir, 'dist/index.js'), 'utf8'), /green/);
  await ensureWorkspacePackagesBuiltForComponent(join(repoDir, 'apps/stack'), { env, quiet: false });
  assert.match(await readFile(join(packageDir, 'dist/index.js'), 'utf8'), /green/,
    'the default package-manager adapter applies the same verbose QA contract');
  await assert.rejects(bootstrap({ [WORKSPACE_BUILD_MODE_ENV]: 'strict' }));
  await assert.rejects(bootstrap({ npm_lifecycle_event: 'prepack' }));
  await writeFile(source, 'export const value: string = "fixed";\n');
  await bootstrap();
  assert.deepEqual(await inspectWorkspaceQaStalePackages(repoDir, ['@fixture/emitted']), []);
  assert.match(await readFile(join(packageDir, 'dist/index.js'), 'utf8'), /fixed/);
});

test('scriptless source-test refresh cannot admit changed UI patch inputs as postinstall-ready', async (t) => {
  const repoDir = await mkdtemp(join(tmpdir(), 'happier-scriptless-ui-patch-'));
  t.after(async () => rm(repoDir, { recursive: true, force: true }));
  await mkdir(join(repoDir, 'apps/stack'), { recursive: true });
  await mkdir(join(repoDir, 'apps/ui/patches'), { recursive: true });
  for (const name of ['cli', 'server']) {
    await mkdir(join(repoDir, 'apps', name), { recursive: true });
    await writeFile(join(repoDir, 'apps', name, 'package.json'), JSON.stringify({ name: `@fixture/${name}` }));
  }
  await writeFile(join(repoDir, 'apps/stack/package.json'), '{"name":"@fixture/stack"}');
  await writeFile(join(repoDir, 'apps/ui/package.json'), JSON.stringify({
    name: '@fixture/ui', happier: { installFreshnessInputs: ['patches'] },
  }));
  await writeFile(join(repoDir, 'package.json'), JSON.stringify({
    private: true, workspaces: ['apps/*'],
  }));
  await writeFile(join(repoDir, 'yarn.lock'), '# fixture\n');
  const patchPath = join(repoDir, 'apps/ui/patches/markdown.patch');
  const installedOutput = join(repoDir, 'node_modules/patched-markdown.js');
  await writeFile(patchPath, 'original patch\n');
  let scriptlessInstalls = 0;
  const options = {
    repoDir, validationKind: 'source-test',
    // Installation is the process boundary; bootstrap admission and freshness stay real.
    installInitialDependencies: async () => {
      scriptlessInstalls += 1;
      await mkdir(join(repoDir, 'node_modules'), { recursive: true });
    },
  };
  const fullInstall = async () => {
    await writeFile(installedOutput, await readFile(patchPath));
  };
  await bootstrapRemoteDependencies(options);
  assert.equal((await inspectDependencyRefresh({ installDir: repoDir })).required, true,
    'a scriptless install must leave runtime postinstall admission stale');
  await bootstrapRemoteDependencies(options);
  assert.equal(scriptlessInstalls, 1, 'unchanged source tests reuse scriptless dependency readiness');
  await withDependencyRefresh({ installDir: repoDir }, fullInstall);
  await bootstrapRemoteDependencies(options);
  assert.equal(scriptlessInstalls, 1, 'full dependency readiness also satisfies source tests');

  await writeFile(patchPath, 'streaming reveal patch\n');
  await bootstrapRemoteDependencies(options);
  assert.equal(scriptlessInstalls, 2);
  assert.equal((await inspectDependencyRefresh({ installDir: repoDir })).required, true,
    'refreshing installed tools must not swallow changed UI postinstall inputs');
  await withDependencyRefresh({ installDir: repoDir }, fullInstall);
  assert.equal(await readFile(installedOutput, 'utf8'), 'streaming reveal patch\n');
  assert.equal((await inspectDependencyRefresh({ installDir: repoDir })).required, false);
});

test('UI dependency preparation owner imports from installed source without compiled workspace outputs', async (t) => {
  const repoDir = await mkdtemp(join(tmpdir(), 'happier-ui-preparation-cold-import-'));
  t.after(async () => rm(repoDir, { recursive: true, force: true }));
  // Relocate the real authored import graph, not a stub of the preparation
  // owner. No first-party dist or caller node_modules can satisfy the child.
  await copyColdPreparationSourceGraph(repoDir);
  const commonDir = join(repoDir, 'packages', 'cli-common');
  const installedCommonDir = join(repoDir, 'node_modules', '@happier-dev', 'cli-common');
  await cp(commonDir, installedCommonDir, { recursive: true });
  await writeFile(join(repoDir, 'package.json'), JSON.stringify({
    private: true, type: 'module', workspaces: ['apps/*', 'packages/*'],
  }));
  await assert.rejects(stat(join(commonDir, 'dist')), { code: 'ENOENT' });
  await assert.rejects(stat(join(installedCommonDir, 'dist')), { code: 'ENOENT' });
  const ownerUrl = pathToFileURL(join(repoDir, 'apps', 'stack', 'scripts', 'utils', 'proc', 'pm.mjs')).href;

  // Real Node resolution sees the real cli-common export map and its authored
  // source files. A transitive emitted-package import must fail this admission.
  try {
    execFileSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(ownerUrl)});`], {
      cwd: repoDir,
      env: { ...process.env, NODE_PATH: '', NODE_OPTIONS: '' },
      stdio: 'pipe',
    });
  } catch (error) {
    const stderr = String(error.stderr ?? '');
    assert.match(stderr, /ERR_MODULE_NOT_FOUND/u);
    assert.ok(stderr.includes(join(installedCommonDir, 'dist', 'workspaces', 'index.js')),
      `Cold-import RED must identify the emitted workspaces dependency, not a missing fixture source file:\n${stderr}`);
    throw error;
  }
});

test('cold UI source-test bootstrap prepares the real postinstall import closure without compiling the Stack closure', {
  skip: process.platform === 'win32' ? 'This fixture exercises the POSIX worker package-manager executable boundary' : false,
}, async (t) => {
  const repoDir = await mkdtemp(join(tmpdir(), 'happier-source-test-ui-patch-'));
  t.after(async () => rm(repoDir, { recursive: true, force: true }));
  for (const component of ['stack', 'ui', 'cli', 'server']) {
    await mkdir(join(repoDir, 'apps', component), { recursive: true });
    await writeFile(join(repoDir, 'apps', component, 'package.json'), JSON.stringify({
      name: component === 'ui' ? '@happier-dev/app' : `@happier-dev/${component}`,
      ...(component === 'ui' ? {
        scripts: { 'postinstall:real': 'node tools/postinstall.mjs' },
        happier: { installFreshnessInputs: ['patches'] },
      } : {}),
    }));
  }
  await writeFile(join(repoDir, 'package.json'), JSON.stringify({
    private: true, workspaces: ['apps/*', 'packages/*'], packageManager: 'yarn@1.22.22',
  }));
  await writeFile(join(repoDir, 'yarn.lock'), '# fixture\n');
  const uiDir = join(repoDir, 'apps', 'ui');
  const sourceRepoDir = await copyColdPreparationSourceGraph(repoDir);
  for (const relativePath of [
    'apps/ui/scripts/ensureWorkspacePackagesBuilt.mjs',
    'apps/ui/scripts/generateBundledPluginUiArtifacts.mjs',
    'apps/ui/tools/postinstall/verifyReactNativeEnrichedMarkdownWebStreamingPatch.mjs',
  ]) {
    const destination = join(repoDir, relativePath);
    await mkdir(join(destination, '..'), { recursive: true });
    await cp(join(sourceRepoDir, relativePath), destination);
  }
  const protocolDir = join(repoDir, 'packages', 'protocol');
  await cp(join(sourceRepoDir, 'packages', 'protocol', 'src'), join(protocolDir, 'src'), { recursive: true });
  // Compile the actual public UI import closure, not reconstructed Protocol
  // exports. Fixture package metadata limits this process-boundary build to
  // the entrypoint consumed by the real readiness verifier and generator.
  await writeFile(join(protocolDir, 'package.json'), JSON.stringify({
    name: '@happier-dev/protocol', version: '0.0.0', type: 'module',
    main: './dist/plugins/ui/index.js', types: './dist/plugins/ui/index.d.ts',
    exports: { './plugins/ui': './dist/plugins/ui/index.js' },
    scripts: { build: 'node compile.mjs' },
  }));
  await writeFile(join(protocolDir, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
    target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', rootDir: 'src',
    declaration: true, strict: true, skipLibCheck: true, types: ['node'],
  }, include: ['src/plugins/ui/index.ts', 'src/auth/tr46.d.ts'] }));
  const compiler = resolveTypeScriptCliInvocation({});
  await writeFile(join(protocolDir, 'compile.mjs'), `import { spawnSync } from 'node:child_process';
const result = spawnSync(${JSON.stringify(compiler.command)}, [...${JSON.stringify(compiler.argsPrefix)}, '-p', 'tsconfig.json', '--outDir', process.env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR], { stdio: 'inherit', env: process.env });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
`);
  await mkdir(join(repoDir, 'node_modules', '@happier-dev'), { recursive: true });
  for (const entry of await readdir(join(sourceRepoDir, 'node_modules'))) {
    if (entry === '@happier-dev' || entry === '.bin') continue;
    await symlink(join(sourceRepoDir, 'node_modules', entry), join(repoDir, 'node_modules', entry));
  }
  await symlink(protocolDir, join(repoDir, 'node_modules', '@happier-dev', 'protocol'));
  await symlink(join(repoDir, 'packages', 'cli-common'), join(repoDir, 'node_modules', '@happier-dev', 'cli-common'));
  const protocolDependencyDir = join(sourceRepoDir, 'packages', 'protocol', 'node_modules');
  if (await stat(protocolDependencyDir).then(() => true, (error) => {
    if (error.code === 'ENOENT') return false;
    throw error;
  })) await symlink(protocolDependencyDir, join(protocolDir, 'node_modules'));
  await assert.rejects(stat(join(protocolDir, 'dist')), { code: 'ENOENT' });
  await mkdir(join(uiDir, 'patches'));
  const patchPath = join(uiDir, 'patches', 'markdown.patch');
  const markersByFile = new Map();
  for (const [relativePath, marker, count = 1] of REACT_NATIVE_ENRICHED_MARKDOWN_STREAMING_PATCH_REQUIRED_MARKERS) {
    const markers = markersByFile.get(relativePath) ?? [];
    markers.push(...Array.from({ length: count }, () => marker));
    markersByFile.set(relativePath, markers);
  }
  const patchInputDir = join(uiDir, 'patches', 'installed-markdown');
  for (const relativePath of REACT_NATIVE_ENRICHED_MARKDOWN_STREAMING_PATCH_REQUIRED_FILES) {
    const output = join(patchInputDir, relativePath);
    await mkdir(join(output, '..'), { recursive: true });
    await writeFile(output, (markersByFile.get(relativePath) ?? []).join('\n'));
  }
  const preparedModule = await readFile(join(patchInputDir, 'lib/module/web/streamingReveal.js'), 'utf8');
  await writeFile(patchPath, preparedModule);
  const requiredOutputPath = join(uiDir, 'node_modules', 'react-native-enriched-markdown', 'lib', 'module', 'web', 'streamingReveal.js');
  const binDir = join(repoDir, 'bin');
  await mkdir(binDir);
  // Corepack/Yarn is the OS boundary. A scriptless install creates only the
  // dependency tree; the UI package-manager task produces its patched module,
  // and a package build invokes the canonical native compiler. Bootstrap,
  // source import resolution, workspace publication and readiness stay real.
  const packageManagerFixture = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args[0] === 'yarn') args.shift();
if (args[0] === '--version') {
  console.log('1.22.22');
} else if (args[0] === 'install') {
  fs.mkdirSync(path.join(process.cwd(), 'node_modules'), { recursive: true });
} else if (args.join(' ') === '-s build' && process.cwd() === ${JSON.stringify(protocolDir)}) {
  require('node:child_process').execFileSync(process.execPath, ['compile.mjs'], { stdio: 'inherit', env: process.env });
} else if (args.join(' ') === '-s workspace @happier-dev/app postinstall:real'
  || (args.join(' ') === '-s postinstall:real' && process.cwd() === ${JSON.stringify(uiDir)})) {
  fs.cpSync(process.env.HAPPIER_TEST_UI_PATCH_INPUT, path.dirname(path.dirname(path.dirname(path.dirname(process.env.HAPPIER_TEST_UI_PATCH_OUTPUT)))), { recursive: true });
} else {
  throw new Error('Unexpected package-manager command: ' + JSON.stringify(args));
}
`;
  for (const command of ['corepack', 'yarn']) {
    const executablePath = join(binDir, command);
    await writeFile(executablePath, packageManagerFixture);
    await chmod(executablePath, 0o755);
  }
  await bootstrapRemoteDependencies({
    repoDir,
    validationKind: 'source-test',
    componentRelativeDir: 'apps/ui',
    env: {
      ...process.env,
      PATH: `${binDir}${delimiter}${process.env.PATH ?? ''}`,
      npm_execpath: '',
      HAPPIER_STACK_HOME_DIR: join(repoDir, 'home'),
      HAPPIER_STACK_ENV_FILE: '',
      HAPPIER_TEST_UI_PATCH_INPUT: patchInputDir,
      HAPPIER_TEST_UI_PATCH_OUTPUT: requiredOutputPath,
    },
  });

  // This is the payload's dependency read after bootstrap returns, not a
  // postinstall call-count assertion or a separately repaired fixture.
  assert.equal(await readFile(requiredOutputPath, 'utf8'), preparedModule);
  assert.ok((await stat(join(protocolDir, 'dist/plugins/ui/index.js'))).size > 0);
  assert.ok((await stat(join(protocolDir, 'dist/plugins/ui/index.d.ts'))).size > 0);
  assert.equal((await inspectDependencyRefresh({
    installDir: repoDir, installMode: SCRIPTLESS_DEPENDENCY_INSTALL_MODE,
  })).required, false);
  assert.equal((await inspectDependencyRefresh({ installDir: repoDir })).required, true,
    'UI source-test preparation must not claim a full runtime dependency install');
  await assert.rejects(stat(join(repoDir, 'packages', 'cli-common', 'dist')), { code: 'ENOENT' },
    'source-test preparation must not compile the Stack dependency-owner closure');
});

test('source-test bootstrap admits installed tools without requiring a compiled Stack owner', async (t) => {
  const repoDir = await mkdtemp(join(tmpdir(), 'happier-source-test-bootstrap-'));
  t.after(async () => rm(repoDir, { recursive: true, force: true }));
  await mkdir(join(repoDir, 'apps/stack'), { recursive: true });
  for (const name of ['ui', 'cli', 'server']) {
    await mkdir(join(repoDir, 'apps', name), { recursive: true });
    await writeFile(join(repoDir, 'apps', name, 'package.json'), JSON.stringify({ name: `@fixture/${name}`, version: '1.0.0' }));
  }
  await writeFile(join(repoDir, 'package.json'), JSON.stringify({ private: true, workspaces: ['apps/*', 'packages/*'] }));
  await writeFile(join(repoDir, 'apps/stack/package.json'), '{"name":"@fixture/stack","version":"1.0.0","dependencies":{"@fixture/emitted":"1.0.0"}}');
  await mkdir(join(repoDir, 'packages/emitted/src'), { recursive: true });
  await writeFile(join(repoDir, 'packages/emitted/package.json'), JSON.stringify({ name: '@fixture/emitted', version: '1.0.0', main: './dist/index.js', scripts: { build: 'node compile.mjs' } }));
  await writeFile(join(repoDir, 'packages/emitted/compile.mjs'), 'import { mkdirSync, writeFileSync } from "node:fs"; const out = process.env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR; mkdirSync(out, { recursive: true }); writeFileSync(out + "/index.js", "export {};\\n");');
  await writeFile(join(repoDir, 'yarn.lock'), '# first\n');
  let installs = 0;
  const options = {
    repoDir, validationKind: 'source-test',
    // Package installation is the OS boundary; freshness/locking remains real.
    installInitialDependencies: async () => {
      installs += 1;
      await mkdir(join(repoDir, 'node_modules'), { recursive: true });
      await writeFile(join(repoDir, 'node_modules/.yarn-integrity'), '{}');
    },
  };
  await bootstrapRemoteDependencies(options);
  await assert.rejects(stat(join(repoDir, 'packages/emitted/dist/index.js')), { code: 'ENOENT' });
  await bootstrapRemoteDependencies(options);
  assert.equal(installs, 1);
  await bootstrapRemoteDependencies({ ...options, validationKind: 'typecheck', toolsOnly: true });
  assert.equal(installs, 1, 'sibling typechecks reuse their own dependency freshness without a compiled Stack');
  assert.equal((await inspectDependencyRefresh({ installDir: repoDir })).required, true,
    'tools-only bootstrap must not attest the sibling runtime lifecycle as a full install');
  await writeFile(join(repoDir, 'yarn.lock'), '# second\n');
  await bootstrapRemoteDependencies(options);
  assert.equal(installs, 2);
  await assert.rejects(stat(join(repoDir, 'packages/cli-common/dist')), { code: 'ENOENT' });
  for (const domain of ['workspaces', 'process']) {
    await mkdir(join(repoDir, 'packages/cli-common/dist', domain), { recursive: true });
    await writeFile(join(repoDir, 'packages/cli-common/dist', domain, 'index.js'), 'export {};\n');
  }
  await bootstrapRemoteDependencies({ ...options, validationKind: 'runtime', componentRelativeDir: 'apps/ui' });
  await assert.rejects(stat(join(repoDir, 'packages/emitted/dist/index.js')), { code: 'ENOENT' },
    'non-Stack validation must not publish the Stack closure');
  await bootstrapRemoteDependencies({ ...options, validationKind: 'runtime', componentRelativeDir: 'apps/stack' });
  assert.equal((await stat(join(repoDir, 'packages/emitted/dist/index.js'))).isFile(), true,
    'Stack-native validation keeps its emitted-package contract');
});

test('remote stage-zero dependency install materializes dependencies without workspace lifecycle scripts', () => {
  assert.deepEqual(REMOTE_INITIAL_DEPENDENCY_INSTALL_ARGS, [
    'install',
    '--production=false',
    '--ignore-engines',
    '--ignore-scripts',
    '--pure-lockfile',
  ]);
});

test('remote dependency bootstrap serializes stage-zero installs through the canonical dependency owner', async (t) => {
  const repoDir = await mkdtemp(join(tmpdir(), 'happier-remote-dependency-bootstrap-'));
  t.after(async () => rm(repoDir, { recursive: true, force: true }));

  await Promise.all([
    mkdir(join(repoDir, 'apps', 'stack'), { recursive: true }),
    mkdir(join(repoDir, 'apps', 'ui'), { recursive: true }),
    mkdir(join(repoDir, 'apps', 'cli'), { recursive: true }),
    mkdir(join(repoDir, 'apps', 'server'), { recursive: true }),
    mkdir(join(repoDir, 'packages', 'cli-common', 'dist', 'workspaces'), { recursive: true }),
    mkdir(join(repoDir, 'packages', 'cli-common', 'dist', 'process'), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(repoDir, 'package.json'), JSON.stringify({
      name: 'fixture',
      private: true,
      workspaces: ['apps/*', 'packages/*'],
    }) + '\n', 'utf-8'),
    writeFile(join(repoDir, 'yarn.lock'), '# fixture\n', 'utf-8'),
    writeFile(join(repoDir, 'apps', 'stack', 'package.json'), '{"name":"@happier-dev/stack"}\n', 'utf-8'),
    writeFile(join(repoDir, 'apps', 'ui', 'package.json'), '{"name":"@happier-dev/app"}\n', 'utf-8'),
    writeFile(join(repoDir, 'apps', 'cli', 'package.json'), '{"name":"@happier-dev/cli"}\n', 'utf-8'),
    writeFile(join(repoDir, 'apps', 'server', 'package.json'), '{"name":"@happier-dev/server"}\n', 'utf-8'),
    writeFile(join(repoDir, 'packages', 'cli-common', 'package.json'), '{"name":"@happier-dev/cli-common"}\n', 'utf-8'),
    writeFile(join(repoDir, 'packages', 'cli-common', 'dist', 'workspaces', 'index.js'), 'export {};\n', 'utf-8'),
    writeFile(join(repoDir, 'packages', 'cli-common', 'dist', 'process', 'index.js'), 'export {};\n', 'utf-8'),
  ]);

  let installCalls = 0;
  let releaseFirstInstall;
  const firstInstallRelease = new Promise((resolve) => {
    releaseFirstInstall = resolve;
  });
  let markFirstInstallStarted;
  const firstInstallStarted = new Promise((resolve) => {
    markFirstInstallStarted = resolve;
  });
  const installInitialDependencies = async () => {
    installCalls += 1;
    assert.equal((await stat(join(repoDir, '.project', 'tmp', 'dependency-install.lock'))).isFile(), true);
    await assert.rejects(
      () => stat(join(repoDir, '.project', 'tmp', 'cli-dist-build.lock')),
      { code: 'ENOENT' },
      'dependency installation must not hold the final CLI publication lock',
    );
    if (installCalls === 1) {
      markFirstInstallStarted();
      await firstInstallRelease;
    }
    await mkdir(join(repoDir, 'node_modules'), { recursive: true });
    await writeFile(join(repoDir, 'node_modules', '.yarn-integrity'), 'fixture\n', 'utf-8');
  };
  const loadDependencyOwner = async () => ({
    ensureDepsInstalled: async () => {},
    ensureWorkspacePackagesBuiltForComponent: async () => {},
  });
  const options = {
    repoDir,
    env: { ...process.env, CI: '1' },
    packageExists: () => false,
    installInitialDependencies,
    loadDependencyOwner,
  };

  const firstBootstrap = bootstrapRemoteDependencies(options);
  await firstInstallStarted;
  const secondBootstrap = bootstrapRemoteDependencies(options);
  await delay(100);
  assert.equal(installCalls, 1, 'a second controller must wait instead of mutating shared node_modules');

  releaseFirstInstall();
  await Promise.all([firstBootstrap, secondBootstrap]);
  assert.equal(installCalls, 1);
});

test('remote dependency bootstrap builds the dependency-owner closure before loading that owner', async () => {
  const calls = [];

  await bootstrapRemoteDependencies({
    repoDir: '/remote/happier',
    componentRelativeDir: 'apps/stack',
    env: { HAPPIER_STACK_PM_CACHE_BASE_DIR: '/remote/cache', HAPPIER_WORKSPACE_BUILD_MODE: 'strict' },
    packageExists: () => false,
    installInitialDependencies: async (options) => calls.push(['initial', options]),
    withDependencyRefresh: runDependencyRefreshImmediately,
    loadWorkspaceBuildOwner: async () => ({
      ensureWorkspacePackagesBuiltByName: async (...args) => calls.push(['build-owner', ...args]),
    }),
    loadDependencyOwner: async () => {
      calls.push(['load-owner']);
      return {
        ensureDepsInstalled: async (dir, label, options) => {
          calls.push(['ensure', dir, label, {
            env: options.env,
            hasDependencyReadyAction: typeof options.onDependenciesReady === 'function',
          }]);
        },
        ensureWorkspacePackagesBuiltForComponent: async (componentDir, options) => {
          calls.push(['workspace', componentDir, options]);
        },
      };
    },
  });

  assert.deepEqual(calls, [
    ['initial', {
      repoDir: '/remote/happier',
      env: { HAPPIER_STACK_PM_CACHE_BASE_DIR: '/remote/cache', HAPPIER_WORKSPACE_BUILD_MODE: 'strict' },
    }],
    ['build-owner', '/remote/happier', ['@happier-dev/cli-common'], {
      env: { HAPPIER_STACK_PM_CACHE_BASE_DIR: '/remote/cache', HAPPIER_WORKSPACE_BUILD_MODE: 'strict' },
      includeDevDependencies: false,
    }],
    ['load-owner'],
    ['ensure', '/remote/happier/apps/stack', 'remote Happier workspace', {
      env: { HAPPIER_STACK_PM_CACHE_BASE_DIR: '/remote/cache', HAPPIER_WORKSPACE_BUILD_MODE: 'strict' },
      hasDependencyReadyAction: false,
    }],
    ['workspace', '/remote/happier/apps/stack', {
      env: { HAPPIER_STACK_PM_CACHE_BASE_DIR: '/remote/cache', HAPPIER_WORKSPACE_BUILD_MODE: 'strict' },
    }],
  ]);
});

test('remote dependency bootstrap leaves unrelated workspace publication to component preparation', async () => {
  const calls = [];

  await bootstrapRemoteDependencies({
    repoDir: '/remote/happier',
    env: { HAPPIER_STACK_PM_CACHE_BASE_DIR: '/remote/cache', HAPPIER_WORKSPACE_BUILD_MODE: 'strict' },
    packageExists: () => false,
    installInitialDependencies: async (options) => calls.push(['initial', options]),
    withDependencyRefresh: runDependencyRefreshImmediately,
    loadWorkspaceBuildOwner: async () => ({
      ensureWorkspacePackagesBuiltByName: async (...args) => calls.push(['build-owner', ...args]),
    }),
    loadDependencyOwner: async () => ({
      ensureDepsInstalled: async (_dir, _label, options) => {
        calls.push(['ensure:begin']);
        assert.equal(options.onDependenciesReady, undefined);
        calls.push(['ensure:end']);
      },
      ensureWorkspacePackagesBuiltForComponent: async (componentDir, options) => {
        calls.push(['workspace', componentDir, options]);
      },
    }),
  });

  assert.deepEqual(calls, [
    ['initial', {
      repoDir: '/remote/happier',
      env: { HAPPIER_STACK_PM_CACHE_BASE_DIR: '/remote/cache', HAPPIER_WORKSPACE_BUILD_MODE: 'strict' },
    }],
    ['build-owner', '/remote/happier', ['@happier-dev/cli-common'], {
      env: { HAPPIER_STACK_PM_CACHE_BASE_DIR: '/remote/cache', HAPPIER_WORKSPACE_BUILD_MODE: 'strict' },
      includeDevDependencies: false,
    }],
    ['ensure:begin'],
    ['ensure:end'],
  ]);
});

test('remote dependency bootstrap propagates stage-zero failures before loading later owners', async () => {
  const stageZeroFailure = new Error('stage-zero failed');
  let workspaceBuildOwnerLoaded = false;
  let dependencyOwnerLoaded = false;

  await assert.rejects(
    () => bootstrapRemoteDependencies({
      repoDir: '/remote/happier',
      installInitialDependencies: async () => {
        throw stageZeroFailure;
      },
      withDependencyRefresh: runDependencyRefreshImmediately,
      loadWorkspaceBuildOwner: async () => {
        workspaceBuildOwnerLoaded = true;
        return { ensureWorkspacePackagesBuiltByName: async () => {} };
      },
      loadDependencyOwner: async () => {
        dependencyOwnerLoaded = true;
        return { ensureDepsInstalled: async () => {} };
      },
    }),
    (error) => error === stageZeroFailure,
  );

  assert.equal(workspaceBuildOwnerLoaded, false);
  assert.equal(dependencyOwnerLoaded, false);
});

test('remote dependency bootstrap skips stage zero when the canonical dependency owner already exists', async () => {
  let initialInstallCalled = false;
  let workspaceBuildOwnerLoaded = false;
  let ensured = false;
  let workspacePrepared = false;

  await bootstrapRemoteDependencies({
    repoDir: '/remote/happier',
    packageExists: (path) => new Set([
      '/remote/happier/node_modules/.yarn-integrity',
      '/remote/happier/packages/cli-common/dist/workspaces/index.js',
      '/remote/happier/packages/cli-common/dist/process/index.js',
    ]).has(path),
    installInitialDependencies: async () => {
      initialInstallCalled = true;
    },
    withDependencyRefresh: async () => {
      throw new Error('warm targets must not enter stage-zero dependency refresh');
    },
    loadWorkspaceBuildOwner: async () => {
      workspaceBuildOwnerLoaded = true;
      return {
        ensureWorkspacePackagesBuiltByName: async () => {},
      };
    },
    loadDependencyOwner: async () => ({
      ensureDepsInstalled: async () => {
        ensured = true;
      },
      ensureWorkspacePackagesBuiltForComponent: async () => {
        workspacePrepared = true;
      },
    }),
  });

  assert.equal(initialInstallCalled, false);
  assert.equal(workspaceBuildOwnerLoaded, false);
  assert.equal(ensured, true);
  assert.equal(workspacePrepared, false);
});

test('remote dependency bootstrap refreshes the Stack component workspace closure before returning', async () => {
  const calls = [];

  await bootstrapRemoteDependencies({
    repoDir: '/remote/happier',
    componentRelativeDir: 'apps/stack',
    env: { HAPPIER_STACK_PM_CACHE_BASE_DIR: '/remote/cache', HAPPIER_WORKSPACE_BUILD_MODE: 'strict' },
    packageExists: () => true,
    loadDependencyOwner: async () => ({
      ensureDepsInstalled: async () => calls.push('dependencies'),
      ensureWorkspacePackagesBuiltForComponent: async (componentDir, options) => {
        calls.push(['workspace', componentDir, options]);
      },
    }),
  });

  assert.deepEqual(calls, [
    'dependencies',
    ['workspace', '/remote/happier/apps/stack', {
      env: { HAPPIER_STACK_PM_CACHE_BASE_DIR: '/remote/cache', HAPPIER_WORKSPACE_BUILD_MODE: 'strict' },
    }],
  ]);
});

test('remote dependency bootstrap repairs a scriptless install whose dependency owner was not built', async () => {
  const calls = [];

  await bootstrapRemoteDependencies({
    repoDir: '/remote/happier',
    env: { HAPPIER_STACK_PM_CACHE_BASE_DIR: '/remote/cache', HAPPIER_WORKSPACE_BUILD_MODE: 'strict' },
    packageExists: (path) => path === '/remote/happier/node_modules/.yarn-integrity',
    installInitialDependencies: async () => calls.push(['initial']),
    withDependencyRefresh: async () => ({ refreshed: false, reason: 'up-to-date' }),
    loadWorkspaceBuildOwner: async () => ({
      ensureWorkspacePackagesBuiltByName: async (...args) => calls.push(['build-owner', ...args]),
    }),
    loadDependencyOwner: async () => ({
      ensureDepsInstalled: async () => {
        calls.push(['ensure']);
      },
      ensureWorkspacePackagesBuiltForComponent: async (componentDir, options) => {
        calls.push(['workspace', componentDir, options]);
      },
    }),
  });

  assert.deepEqual(calls, [
    ['build-owner', '/remote/happier', ['@happier-dev/cli-common'], {
      env: { HAPPIER_STACK_PM_CACHE_BASE_DIR: '/remote/cache', HAPPIER_WORKSPACE_BUILD_MODE: 'strict' },
      includeDevDependencies: false,
    }],
    ['ensure'],
  ]);
});
