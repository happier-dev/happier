import assert from 'node:assert/strict';
import test from 'node:test';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import yaml from 'js-yaml';
import { installWorkspaceAdmissionProcessFixture } from '../../apps/stack/scripts/testkit/core/native_admission_fixture.mjs';

import { BUILD_INPUT_RECORD, ensureWorkspacePackagesBuiltByName, ensureWorkspacePackagesBuiltForComponent, isWorkspacePackageOutputCurrent } from './ensureWorkspacePackagesBuilt.mjs';
import { copyDirDereferenceContainedSync, vendorRuntimeDependencyTree } from '../../packages/cli-common/workspaceRuntimeDependencies.mjs';

import {
  parseWorkspaceBuildArgs,
  runWorkspacePackageBuild,
} from './ensureWorkspacePackagesBuiltCli.mjs';

function fixtureCompilerPackageManager(root) {
  const path = join(root, 'fixture-package-manager.mjs');
  // Package-manager execution is an OS boundary. The fixture has no external
  // dependencies; retain the real compiler child without pnpm's auto-install.
  writeFileSync(path, `import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
assert.deepEqual(process.argv.slice(2), ['run', '--silent', 'build']);
const result = spawnSync(process.execPath, ['compile.mjs'], { stdio: 'inherit' });
process.exitCode = result.status ?? 1;
`);
  return path;
}

test('root workspace preparation forwards its environment and reuses current shared outputs across components', async (t) => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'happier-preparation-cli-environment-'));
  t.after(() => rmSync(repoRoot, { recursive: true, force: true }));
  writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({ private: true }));
  writeFileSync(join(repoRoot, 'pnpm-lock.yaml'), '# fixture\n');
  writeFileSync(join(repoRoot, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n  - packages/*\n');
  const packageDir = join(repoRoot, 'packages/example');
  mkdirSync(join(packageDir, 'src'), { recursive: true });
  writeFileSync(join(packageDir, 'src/index.ts'), 'export const value = "source";\n');
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({
    name: '@happier-dev/example', type: 'module', main: './dist/index.js',
    scripts: { build: 'node compile.mjs' },
  }));
  // The fixture compiler is a genuine child process. Admission, fingerprints,
  // package copying and the root preparation adapter execute their real paths.
  writeFileSync(join(packageDir, 'compile.mjs'), `import {mkdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
const output = process.env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR;
mkdirSync(output, {recursive: true});
writeFileSync(join(output, 'index.js'), 'export const value = ' + JSON.stringify(process.env.FIXTURE_PREPARATION_VALUE ?? 'missing') + ';\\n');
`);
  for (const app of ['cli', 'ui', 'server']) {
    const dir = join(repoRoot, 'apps', app);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: `@fixture/${app}`,
      dependencies: { '@happier-dev/example': '0.0.0' }, bundledDependencies: ['@happier-dev/example'] }));
  }
  const env = { ...process.env, FIXTURE_PREPARATION_VALUE: 'from-root-preparation' };
  const options = { repoRoot, env, componentDirs: ['apps/cli', 'apps/server', 'apps/cli'] };
  const first = await runWorkspacePackageBuild(options);
  assert.deepEqual(first.built, ['@happier-dev/example']);
  for (const app of ['cli', 'server']) {
    assert.equal(readFileSync(join(repoRoot, 'apps', app, 'node_modules/@happier-dev/example/dist/index.js'), 'utf8'),
      'export const value = "from-root-preparation";\n');
  }
  assert.deepEqual((await runWorkspacePackageBuild(options)).built, [], 'a repeated preparation must reuse current outputs');
});
test('a configured workspace build refreshes stale target dist before returning', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'happier-target-workspace-build-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const native = await installWorkspaceAdmissionProcessFixture(t, root);
  const env = { ...native.env, npm_execpath: fixtureCompilerPackageManager(root) };
  const controller = join(root, 'controller');
  const replicas = ['command-worker', 'runtime-only-worker'].map(name => join(root, name));
  const packageName = '@happier-dev/example';
  for (const repo of [controller, ...replicas]) {
    mkdirSync(join(repo, 'packages/example/src'), { recursive: true });
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
    writeFileSync(join(repo, 'pnpm-lock.yaml'), '# fixture\n');
    writeFileSync(join(repo, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n  - packages/*\n');
    for (const app of ['cli', 'ui', 'server']) {
      mkdirSync(join(repo, 'apps', app), { recursive: true });
      writeFileSync(join(repo, 'apps', app, 'package.json'), JSON.stringify({ name: `@fixture/${app}` }));
    }
    writeFileSync(join(repo, 'packages/example/package.json'), JSON.stringify({ name: packageName,
      type: 'module', main: './dist/index.js', scripts: { build: 'node compile.mjs' } }));
    writeFileSync(join(repo, 'packages/example/src/index.ts'), 'export const initial = 1;\n');
    // Compiler and SSH transport are genuine process boundaries. Both invoke
    // child processes; graph, currentness, capture and publication stay real.
    writeFileSync(join(repo, 'packages/example/compile.mjs'), `import { readFileSync, writeFileSync } from 'node:fs';
writeFileSync(process.env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR + '/index.js', readFileSync('src/index.ts'));
`);
    await runWorkspacePackageBuild({ repoRoot: repo, env, packageNames: [packageName] });
  }
  for (const repo of [controller, ...replicas]) writeFileSync(join(repo, 'packages/example/src/index.ts'),
    'export const initial = 1;\nexport const newlyAdded = 2;\n');
  const configPath = join(root, 'dev-targets.json');
  writeFileSync(configPath, JSON.stringify({ version: 3,
    targets: replicas.map((repoDir, index) => ({ name: index ? 'runtime-only-worker' : 'command-worker',
      ssh: 'fixture-worker', platform: 'posix', repoDir, cliHomeDir: join(root, 'worker-home') })),
    commandExecution: { mode: 'prefer-target', target: 'command-worker', fallback: 'local' } }));
  const cli = fileURLToPath(new URL('./ensureWorkspacePackagesBuiltCli.mjs', import.meta.url));
  const options = { repoRoot: controller, env: { ...env, HAPPIER_EXEC_CONFIG_PATH: configPath },
    packageNames: [packageName], prepareConfiguredTargets: true,
    async runDevTargetCommandImpl({ target, commandArgs }) {
      const child = spawnSync(process.execPath, [cli, ...commandArgs.slice(2)], {
        cwd: target.repoDir, env: { ...env, HAPPIER_DEV_TARGET_EXECUTION: '1' }, encoding: 'utf8',
      });
      assert.equal(child.status, 0, child.stderr);
      return { code: child.status, signal: child.signal };
    },
  };
  await runWorkspacePackageBuild(options);
  for (const replica of replicas) {
    const child = spawnSync(process.execPath, ['--input-type=module', '--eval',
      `import { newlyAdded } from ${JSON.stringify(pathToFileURL(join(replica, 'packages/example/dist/index.js')).href)}; process.stdout.write(String(newlyAdded));`],
    { env: { ...process.env, NODE_OPTIONS: '' }, encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout, '2');
  }
  await assert.rejects(runWorkspacePackageBuild({ ...options,
    runDevTargetCommandImpl: async () => ({ code: 255, signal: null }),
  }), /command-worker/);
});
for (const { compiledAlready, buildMode, changeAfterManifest } of [
  { compiledAlready: false, buildMode: 'strict' },
  { compiledAlready: true, buildMode: 'strict' },
  { compiledAlready: false, buildMode: 'source-dev' },
  { compiledAlready: false, buildMode: 'strict', changeAfterManifest: true },
  { compiledAlready: false, buildMode: 'source-dev', changeAfterManifest: true },
]) {
  test(`root preparation publishes a real packaged plugin before component copies (${compiledAlready ? 'current dist, missing artifacts' : 'cold compiler outputs'}${buildMode === 'source-dev' ? ', captured QA source' : ''}${changeAfterManifest ? ', changed after manifest preparation' : ''})`, async (t) => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'happier-root-plugin-publication-'));
    t.after(() => rmSync(repoRoot, { recursive: true, force: true }));
    const sourceRoot = fileURLToPath(new URL('../..', import.meta.url));
    const copy = (relativePath) => {
      mkdirSync(dirname(join(repoRoot, relativePath)), { recursive: true });
      cpSync(join(sourceRoot, relativePath), join(repoRoot, relativePath), {
        recursive: true,
        filter: (candidate) => !candidate.split(/[\\/]/u).some((part) => part === 'node_modules' || part === 'dist'),
      });
    };
    for (const relativePath of ['scripts', 'apps/stack/scripts', 'apps/cli/scripts', 'apps/cli/src', 'apps/cli/tsconfig.json', 'apps/cli/tsconfig.runtime.json']) copy(relativePath);
    const dependencyPackages = ['agents', 'protocol', 'cli-common', 'plugin-sdk', 'release-runtime', 'brand', 'transfers', 'peer-mediation'];
    for (const name of dependencyPackages) {
      copy(`packages/${name}`);
    }
    // Physical package custody is part of the real copier's contract. Prepare
    // declared external packages through its owner, not an out-of-root symlink.
    const visited = new Set();
    const vendor = (packageJsonPath, resolveFromPackageJsonPath = packageJsonPath) => vendorRuntimeDependencyTree({
      packageJsonPath, resolveFromPackageJsonPath,
      destNodeModulesDir: join(repoRoot, 'node_modules'), dereferenceRootDir: sourceRoot, visited,
      copyResolvedPackage: ({ sourcePackageDir, destPackageDir, dereferenceRootDir }) => copyDirDereferenceContainedSync({
        sourceDir: sourcePackageDir, destDir: destPackageDir, dereferenceRootDir,
        shouldCopyPath: (candidate) => !relative(sourcePackageDir, candidate).split(/[\\/]/u).includes('node_modules'),
      }),
    });
    for (const name of dependencyPackages) vendor(join(sourceRoot, 'packages', name, 'package.json'));
    const toolchainOwnerPath = join(sourceRoot, 'apps/cli/package.json');
    const toolchain = JSON.parse(readFileSync(toolchainOwnerPath, 'utf8'));
    // The publisher's source loader uses jiti; its authoring input owner uses
    // esbuild. Include their actual CLI declarations alongside the toolchain.
    const dependencies = Object.fromEntries(['tsx', 'typescript', 'yaml', 'jiti', 'esbuild', ...(!compiledAlready ? ['tweetnacl'] : [])].map((name) => {
      const version = toolchain.dependencies?.[name] ?? toolchain.devDependencies?.[name];
      assert.equal(typeof version, 'string', `Fixture toolchain ${name} must be declared`);
      return [name, version];
    }));
    const toolchainPath = join(repoRoot, 'toolchain.json');
    writeFileSync(toolchainPath, JSON.stringify({ dependencies }));
    vendor(toolchainPath, toolchainOwnerPath);
    if (!compiledAlready) {
      const sdkOwnerPath = join(sourceRoot, 'packages/plugin-sdk/package.json');
      const sdkToolchain = JSON.parse(readFileSync(sdkOwnerPath, 'utf8'));
      const react = sdkToolchain.devDependencies.react;
      assert.equal(typeof react, 'string', 'The real UI compiler must use the SDK-declared React toolchain');
      writeFileSync(toolchainPath, JSON.stringify({ dependencies: { react } }));
      vendor(toolchainPath, sdkOwnerPath);
    }
    writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({ private: true }));
    writeFileSync(join(repoRoot, 'pnpm-lock.yaml'), '# fixture\n');
    writeFileSync(join(repoRoot, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n  - packages/*\n  - packages/plugins/*\n');
    mkdirSync(join(repoRoot, 'apps/ui'), { recursive: true });
    writeFileSync(join(repoRoot, 'apps/ui/package.json'), JSON.stringify({ name: '@happier-dev/ui' }));
    const packageName = '@happier-dev/plugins-selected';
    const hostDependencies = [...dependencyPackages.map((name) => `@happier-dev/${name}`), packageName];
    for (const component of ['cli', 'server']) {
      const componentDir = join(repoRoot, 'apps', component);
      mkdirSync(componentDir, { recursive: true });
      writeFileSync(join(componentDir, 'package.json'), JSON.stringify({
        name: `@happier-dev/${component}`, type: 'module',
        dependencies: {
          ...Object.fromEntries(hostDependencies.map((name) => [name, '0.0.0'])),
          ...(component === 'cli' && !compiledAlready ? { tweetnacl: dependencies.tweetnacl } : {}),
        },
        bundledDependencies: hostDependencies,
      }));
    }
    const packageDir = join(repoRoot, 'packages/plugins/selected');
    mkdirSync(join(packageDir, 'src'), { recursive: true });
    writeFileSync(join(packageDir, 'package.json'), JSON.stringify({
      name: packageName, version: '0.0.0', type: 'module', main: './dist/index.js',
      files: ['dist', '.happier-plugin', 'package.json'],
      dependencies: { '@happier-dev/plugin-sdk': '0.0.0' },
      ...(!compiledAlready ? { exports: {
        '.': './dist/index.js',
        './happier-plugin-ui/panel': './src/panel.ts',
        ...(changeAfterManifest ? { './happier-plugin-ui/second-panel': './src/panel.ts' } : {}),
      } } : {}),
      scripts: { build: 'fixture-compiler', ...(!compiledAlready ? { 'build:ui': 'happier-plugin-build-ui' } : {}) },
    }));
    const manifest = {
      schemaVersion: 2, id: 'happier.selected', version: '0.0.0', displayName: 'Selected',
      engines: { happier: '^0.0.0' }, runtime: { apiVersion: 1 },
      entrypoints: { daemon: './.happier-plugin/daemon.js' },
      hostAccess: { required: [], optional: [] },
      contributes: !compiledAlready ? {
        ui: { renderers: [{ id: 'panel', kind: 'reactNative', artifact: 'panel' }] },
      } : {},
    };
    writeFileSync(join(packageDir, 'src/manifest.ts'), `export const PLUGIN_MANIFEST = ${JSON.stringify(manifest)};\n`);
    const entrypoint = "export { PLUGIN_MANIFEST as manifest } from './manifest.js';\nexport function activate() {}\n";
    writeFileSync(join(packageDir, 'src/index.ts'), entrypoint);
    if (!compiledAlready) writeFileSync(join(packageDir, 'src/panel.ts'), 'export function renderSurface() { return null; }\n');
    writeFileSync(join(packageDir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { outDir: 'dist' }, include: ['src/**/*.ts'] }));
    let compilerRuns = 0;
    // Compilation is an external process boundary; retain real admission,
    // fingerprints, publisher, manifest parsing and strict atomic package copies.
    const workspaceBuildBoundary = {
      async prepareEnv(_packageDir, env) { return { ...env }; },
      async runPackageBuild(compiledPackageDir, { env }) {
        const name = JSON.parse(readFileSync(join(compiledPackageDir, 'package.json'), 'utf8')).name;
        if (name !== packageName) {
          // Reuse genuine prepared public dependency outputs at the compiler
          // boundary; this fixture never compiles or fakes the CLI application.
          cpSync(join(sourceRoot, 'packages', name.slice('@happier-dev/'.length), 'dist'), env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR, { recursive: true });
          return;
        }
        compilerRuns += 1;
        mkdirSync(env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR, { recursive: true });
        writeFileSync(join(env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR, 'index.js'), entrypoint);
        writeFileSync(join(env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR, 'manifest.js'),
          readFileSync(join(compiledPackageDir, 'src/manifest.ts'), 'utf8'));
        if (!compiledAlready) {
          // Keep the real staged UI producer beneath the compiler-process boundary.
          // Its input remains package-root plugin.json; only its output is staged.
          const ui = spawnSync(process.execPath, [join(repoRoot, 'packages/plugin-sdk/dist/ui/build/bin.js')], {
            cwd: compiledPackageDir, env, encoding: 'utf8',
          });
          assert.equal(ui.status, 0, `${ui.stdout}\n${ui.stderr}`);
        }
      },
    };
    // A partial temporary plugin corpus prepares target-owned runtime artifacts,
    // not the full checkout's generated native/legacy semantic projections.
    const env = { ...process.env, HAPPIER_DEV_TARGET_EXECUTION: '1', HAPPIER_WORKSPACE_BUILD_MODE: buildMode, HAPPIER_STACK_REPO_DIR: repoRoot, HAPPIER_STACK_RUNTIME_IDENTITY_REPO_DIR: repoRoot };
    if (compiledAlready) await ensureWorkspacePackagesBuiltByName(repoRoot, hostDependencies, { env, workspaceBuildBoundary });
    assert.equal(existsSync(join(packageDir, '.happier-plugin')), false);
    let changedManifest = false;
    if (changeAfterManifest) {
      const editedManifest = {
        ...manifest, contributes: { ui: { renderers: [{ id: 'panel', kind: 'reactNative', artifact: 'second-panel' }] } },
      };
      const { ingestPluginManifestV2 } = await import(pathToFileURL(
        join(sourceRoot, 'packages/protocol/dist/plugins/manifest/index.js'),
      ).href);
      const ingestion = ingestPluginManifestV2(editedManifest);
      assert.equal(ingestion.ok, true, JSON.stringify(ingestion));
      // Observe the real filesystem publication boundary, then edit authored
      // input before its capture. A foreign package lock must not be retained
      // while waiting for manifest preparation inside joint admission.
      const fs = createRequire(import.meta.url)('node:fs');
      const rename = fs.renameSync;
      fs.renameSync = (source, target) => {
        const result = rename(source, target);
        if (!changedManifest && String(target) === join(packageDir, '.happier-plugin/plugin.json')) {
          changedManifest = true;
          writeFileSync(join(packageDir, 'src/manifest.ts'), `export const PLUGIN_MANIFEST = ${JSON.stringify(editedManifest)};\n`);
        }
        return result;
      };
      syncBuiltinESMExports();
      t.after(() => { fs.renameSync = rename; syncBuiltinESMExports(); });
    }
    const preparation = runWorkspacePackageBuild({
      repoRoot, env, packageNames: hostDependencies, componentDirs: ['apps/cli', 'apps/server'],
      ensureWorkspacePackagesBuiltByNameImpl: (root, names, options) => ensureWorkspacePackagesBuiltByName(root, names, { ...options, env, workspaceBuildBoundary }),
      ensureWorkspacePackagesBuiltForComponentImpl: (componentDir, options) => ensureWorkspacePackagesBuiltForComponent(componentDir, { ...options, env, workspaceBuildBoundary }),
    });
    if (changeAfterManifest) {
      try {
        await preparation;
      } catch (error) {
        assert.match(error.message, /inputs changed/);
        assert.equal(changedManifest, true, 'The authored edit must follow the real manifest publication');
        assert.equal(existsSync(join(packageDir, 'dist/happier-plugin-ui/ui-artifacts.json')), false,
          'A drift refusal must retain the prior published tree');
        return;
      }
      assert.equal(changedManifest, true, 'The authored edit must follow the real manifest publication');
      const publishedManifest = JSON.parse(readFileSync(join(packageDir, '.happier-plugin/plugin.json'), 'utf8'));
      const publishedUi = JSON.parse(readFileSync(join(packageDir, 'dist/happier-plugin-ui/ui-artifacts.json'), 'utf8'));
      const compiled = await import(pathToFileURL(join(packageDir, 'dist/manifest.js')).href);
      const authored = await import(pathToFileURL(join(packageDir, 'src/manifest.ts')).href);
      const inputRecord = JSON.parse(readFileSync(join(packageDir, 'dist', BUILD_INPUT_RECORD), 'utf8'));
      const pairing = {
        authored: authored.PLUGIN_MANIFEST.contributes.ui.renderers[0].artifact,
        compiled: compiled.PLUGIN_MANIFEST.contributes.ui.renderers[0].artifact,
        serialized: publishedManifest.contributes.ui.renderers[0].artifact,
        ui: publishedUi.entries.map(entry => entry.artifactId),
        current: isWorkspacePackageOutputCurrent(packageDir, {
          env, buildMode, dependencyDirs: inputRecord.dependencies.map(entry => join(repoRoot, entry.packageDir)),
        }),
      };
      t.diagnostic(JSON.stringify(pairing));
      assert.deepEqual(pairing, {
        authored: 'second-panel', compiled: 'second-panel', serialized: 'second-panel', ui: ['second-panel'], current: true,
      }, 'Successful current admission must bind the source, serialized manifest and actual UI graph');
      return;
    }
    const result = await preparation;
    assert.equal(result.ok, true);
    assert.equal(compilerRuns, 1, 'current compiler output must not be confused with missing publisher output');
    if (compiledAlready) assert.deepEqual(result.built, []);
    for (const component of ['cli', 'server']) {
      const installed = join(repoRoot, 'apps', component, 'node_modules', '@happier-dev/plugins-selected');
      assert.equal(JSON.parse(readFileSync(join(installed, '.happier-plugin/plugin.json'), 'utf8')).id, manifest.id);
      assert.equal(readFileSync(join(installed, '.happier-plugin/daemon.js'), 'utf8'), readFileSync(join(packageDir, '.happier-plugin/daemon.js'), 'utf8'));
      const runtime = await import(pathToFileURL(join(installed, '.happier-plugin/daemon.js')).href);
      assert.equal(typeof runtime.activate, 'function');
      if (!compiledAlready) {
        const ui = JSON.parse(readFileSync(join(installed, 'dist/happier-plugin-ui/ui-artifacts.json'), 'utf8'));
        assert.equal(ui.entries.length, 1);
        assert.equal(ui.entries[0].artifactId, 'panel');
        assert.equal(ui.entries[0].tier, 'reactNative');
        assert.match(readFileSync(join(installed, 'dist/happier-plugin-ui', ui.entries[0].entry), 'utf8'), /renderSurface/);
      }
    }
    if (!compiledAlready) {
      // Currentness must use the same execution-root inputs as the builder,
      // not this test process's shared-checkout environment.
      const publishedRuntimePath = join(packageDir, '.happier-plugin/daemon.js');
      const publishedRuntimeModifiedAt = statSync(publishedRuntimePath, { bigint: true }).mtimeNs;
      const readinessProcess = spawnSync(process.execPath, ['--input-type=module', '-e',
        `const { main, inspectSourceDevSharedDepsForSourceDev } = await import(${JSON.stringify(pathToFileURL(join(sourceRoot, 'apps/cli/scripts/buildSharedDeps.mjs')).href)});\n`
        + `await main({ mode: 'source-dev', repoRoot: process.cwd(), workspaceNames: ${JSON.stringify(hostDependencies)} });\n`
        + `process.stdout.write(JSON.stringify(inspectSourceDevSharedDepsForSourceDev({ repoRoot: process.cwd(), workspaceNames: ${JSON.stringify(hostDependencies)} }).current));`,
      ], { cwd: repoRoot, env, encoding: 'utf8' });
      assert.equal(readinessProcess.status, 0, readinessProcess.stderr);
      const readiness = JSON.parse(readinessProcess.stdout);
      assert.equal(readiness, true, 'archive input must carry genuine verified runtime readiness');
      assert.equal(statSync(publishedRuntimePath, { bigint: true }).mtimeNs, publishedRuntimeModifiedAt,
        'CLI closure preparation must reuse the already published plugin runtime');
      const workflow = yaml.load(readFileSync(join(sourceRoot, '.github/workflows/tests.yml'), 'utf8'));
      const action = yaml.load(readFileSync(join(sourceRoot, '.github/actions/install-pnpm-dependencies/action.yml'), 'utf8'));
      const runnerTemp = join(repoRoot, 'runner-temp');
      mkdirSync(runnerTemp);
      const archive = workflow.jobs['gate-prepare'].steps.find((step) => step.name === "Archive the current run's coherent preparation");
      const archived = spawnSync('bash', ['-c', archive.run], { cwd: repoRoot, env: { ...env, RUNNER_TEMP: runnerTemp }, encoding: 'utf8' });
      assert.equal(archived.status, 0, `${archived.stdout}\n${archived.stderr}`);
      const restoredRoot = join(repoRoot, 'restored');
      mkdirSync(restoredRoot);
      mkdirSync(join(runnerTemp, 'gate-prepared'));
      cpSync(join(runnerTemp, 'gate-prepared-workspace.tar'), join(runnerTemp, 'gate-prepared/gate-prepared-workspace.tar'));
      const restore = action.runs.steps.find((step) => step.name === "Restore this run's prepared workspace");
      const restored = spawnSync('bash', ['-c', restore.run], {
        cwd: restoredRoot, env: { ...env, RUNNER_TEMP: runnerTemp, GITHUB_WORKSPACE: restoredRoot, RESTORE_STARTED_SECONDS: String(Math.floor(Date.now() / 1000)) }, encoding: 'utf8',
      });
      assert.equal(restored.status, 0, `${restored.stdout}\n${restored.stderr}`);
      for (const output of ['.happier-plugin/plugin.json', '.happier-plugin/daemon.js']) {
        assert.equal(readFileSync(join(restoredRoot, 'packages/plugins/selected', output), 'utf8'), readFileSync(join(packageDir, output), 'utf8'));
      }
      const stamp = '.project/tmp/cli-source-dev-shared-deps-sync.json';
      assert.equal(readFileSync(join(restoredRoot, stamp), 'utf8'), readFileSync(join(repoRoot, stamp), 'utf8'));
    }
  });
}

test('the root package-build adapter delegates one package set to the canonical currentness owner', async () => {
  const calls = [];
  const result = await runWorkspacePackageBuild({
    repoRoot: '/repo',
    packageNames: ['alpha', 'beta', 'alpha'],
    ensureWorkspacePackagesBuiltByNameImpl: async (repoRoot, packageNames, { env, onPackageBuildResult, ...options }) => {
      assert.equal(env, process.env);
      assert.equal(typeof onPackageBuildResult, 'function');
      calls.push({ repoRoot, packageNames, options });
      return { ok: true, built: ['beta'], skipped: [] };
    },
    publishBundledPluginArtifactsAfterWorkspaceBuildImpl: async () => false,
  });

  assert.deepEqual(calls, [{
    repoRoot: '/repo',
    packageNames: ['alpha', 'beta'],
    options: { publicationMode: 'live' },
  }]);
  assert.deepEqual(result, { ok: true, built: ['beta'], skipped: [] });
});

test('the root package-build adapter rejects an empty package selection', async () => {
  await assert.rejects(
    runWorkspacePackageBuild({ repoRoot: '/repo', packageNames: [] }),
    /requires at least one workspace package name/,
  );
});

test('the root package-build adapter prepares component dependency closures through the canonical owner', async () => {
  const calls = [];
  const result = await runWorkspacePackageBuild({
    repoRoot: '/repo',
    componentDirs: ['apps/cli', 'apps/server', 'apps/cli'],
    ensureWorkspacePackagesBuiltForComponentImpl: async (componentDir, { env, onPackageBuildResult, ...options }) => {
      assert.equal(env, process.env);
      assert.equal(typeof onPackageBuildResult, 'function');
      calls.push({ componentDir, options });
      return { ok: true, built: [componentDir.split('/').at(-1)], skipped: [] };
    },
    publishBundledPluginArtifactsAfterWorkspaceBuildImpl: async () => false,
  });

  assert.deepEqual(calls, [
    { componentDir: '/repo/apps/cli', options: { publicationMode: 'live', deferBundledWorkspaceSync: true } },
    { componentDir: '/repo/apps/server', options: { publicationMode: 'live', deferBundledWorkspaceSync: true } },
  ]);
  assert.deepEqual(result, { ok: true, built: ['cli', 'server'], skipped: [] });
});

test('the root package-build adapter publishes the deduplicated rebuilt union once after every build', async () => {
  const events = [];
  const env = { HAPPIER_DEV_TARGET_EXECUTION: '1' };
  const result = await runWorkspacePackageBuild({
    repoRoot: '/repo',
    env,
    componentDirs: ['apps/ui', 'apps/cli'],
    ensureWorkspacePackagesBuiltForComponentImpl: async (componentDir) => {
      events.push(`build:${componentDir}`);
      return componentDir.endsWith('/ui')
        ? {
            ok: true,
            built: ['@happier-dev/plugins-inspector', '@happier-dev/plugin-ui'],
            skipped: [],
          }
        : {
            ok: true,
            built: ['@happier-dev/plugins-inspector', '@happier-dev/plugins-triage'],
            skipped: [],
          };
    },
    publishBundledPluginArtifactsAfterWorkspaceBuildImpl: async (options) => {
      events.push(['publish', options]);
      return true;
    },
    rebuildWorkspacesInvalidatedByBundledPluginPublicationImpl: async (options) => {
      events.push(['rebuild-generated', options]);
      return [];
    },
  });

  assert.deepEqual(events, [
    'build:/repo/apps/ui',
    'build:/repo/apps/cli',
    ['publish', {
      repoRoot: '/repo',
      workspaceNames: [
        '@happier-dev/plugins-inspector',
        '@happier-dev/plugin-ui',
        '@happier-dev/plugins-triage',
      ],
      env,
      pluginFailures: [],
      bundledPluginArtifactPublication: { mode: 'write', targetOwnedOnly: true },
    }],
    ['rebuild-generated', {
      repoRoot: '/repo',
      workspaceNames: [
        '@happier-dev/plugins-inspector',
        '@happier-dev/plugin-ui',
        '@happier-dev/plugins-triage',
      ],
      env,
    }],
  ]);
  assert.deepEqual(result, {
    ok: true,
    built: [
      '@happier-dev/plugins-inspector',
      '@happier-dev/plugin-ui',
      '@happier-dev/plugins-triage',
    ],
    skipped: [],
  });
});

test('the authoritative root package-build adapter retains full publication', async () => {
  const publications = [];
  await runWorkspacePackageBuild({
    repoRoot: '/repo',
    env: {},
    packageNames: ['@happier-dev/plugins-inspector'],
    ensureWorkspacePackagesBuiltByNameImpl: async () => ({
      ok: true,
      built: ['@happier-dev/plugins-inspector'],
      skipped: [],
    }),
    publishBundledPluginArtifactsAfterWorkspaceBuildImpl: async (options) => {
      publications.push(options);
      return false;
    },
  });

  assert.deepEqual(publications, [{
    repoRoot: '/repo',
    workspaceNames: ['@happier-dev/plugins-inspector'],
    env: {},
    pluginFailures: [],
    bundledPluginArtifactPublication: { mode: 'write' },
  }]);
});

test('the root package-build CLI separates package names from component preparation paths', () => {
  assert.deepEqual(parseWorkspaceBuildArgs([
    '@happier-dev/protocol',
    '--for-component=apps/cli',
    '--for-component=apps/server',
  ]), {
    packageNames: ['@happier-dev/protocol'],
    componentDirs: ['apps/cli', 'apps/server'],
  });
});
