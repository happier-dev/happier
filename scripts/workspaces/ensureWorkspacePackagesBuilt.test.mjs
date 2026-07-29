import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { bundleWorkspaceDeps } from '../../apps/cli/scripts/bundleWorkspaceDeps.mjs';
import { buildBundledWorkspaceDependenciesForCli } from '../../apps/cli/scripts/buildSharedDeps.mjs';
import {
  ensureWorkspacePackagesBuiltByName as ensureStackWorkspacePackagesBuiltByName,
} from '../../apps/stack/scripts/utils/proc/pm.mjs';
import { ensureWorkspacePackagesBuiltByName } from './ensureWorkspacePackagesBuilt.mjs';

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
      syncWorkspaceBundledDependenciesForBuildImpl: () => undefined,
      ensureWorkspacePackagesBuiltByNameImpl: async (root, packageNames, options) => (
        await ensureWorkspacePackagesBuiltByName(root, packageNames, {
          ...options,
          beforePackageBuild: async (context) => {
            preparedPackages.push(context.packageName);
            await options.beforePackageBuild?.(context);
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
        beforePackageBuild: async ({ packageName }) => {
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
      '@happier-dev/protocol',
      '@happier-dev/tests',
      '@happier-dev/plugins-pi',
    ]);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
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
        scripts: {
          build: 'fixture-build',
          'build:ui': 'happier-plugin-build-ui',
        },
      }),
      'utf8',
    );
    writeFileSync(join(packageDir, 'dist', 'index.js'), 'export const inspector = true;\n', 'utf8');

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
    writeFileSync(indexOutputPath, 'export const identity = "qualified";\n', 'utf8');
    writeFileSync(manifestOutputPath, 'export const identity = "qualified";\n', 'utf8');

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

    writeFileSync(sourcePath, 'export const identity = "local-v2";\n', 'utf8');
    utimesSync(sourcePath, staleOutputTime, staleOutputTime);
    utimesSync(distDir, misleadingDirectoryTime, misleadingDirectoryTime);

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
        beforePackageBuild: async (context) => {
          targetPreparedPackages.push(context.packageName);
          await options.beforePackageBuild?.(context);
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
      syncWorkspaceBundledDependenciesForBuildImpl: () => undefined,
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

    // Live/source publication keeps the timestamp-based reuse optimization.
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
    assert.equal(buildCalls, 2);
    assert.deepEqual(helperBuildForceModes, [true, false]);
    assert.deepEqual(targetPreparedPackages, ['@happier-dev/plugins-codex']);
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
      { env, force: true, quiet: true, timeoutMs: 500 },
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
