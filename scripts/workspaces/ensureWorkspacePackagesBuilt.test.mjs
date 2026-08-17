import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { bundleWorkspaceDeps } from '../../apps/cli/scripts/bundleWorkspaceDeps.mjs';
import {
  buildBundledWorkspaceDependenciesForCli,
  main as buildSharedDeps,
} from '../../apps/cli/scripts/buildSharedDeps.mjs';
import {
  ensureWorkspacePackagesBuiltByName as ensureStackWorkspacePackagesBuiltByName,
} from '../../apps/stack/scripts/utils/proc/pm.mjs';
import { ensureWorkspacePackagesBuiltByName } from './ensureWorkspacePackagesBuilt.mjs';

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
  const before = statSync(join(packageDir, 'dist'));
  let buildCalls = 0;

  const result = await ensureWorkspacePackagesBuiltByName(repoRoot, ['@happier-dev/unchanged'], {
    admitPriorOutputsImmediately: true,
    workspaceBuildBoundary: {
      async prepareEnv(_packageDir, env) {
        return { ...env };
      },
      async runPackageBuild() {
        buildCalls += 1;
      },
    },
  });

  const after = statSync(join(packageDir, 'dist'));
  assert.deepEqual(result.built, []);
  assert.equal(buildCalls, 0);
  assert.equal(after.ino, before.ino);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal(await readFile(join(packageDir, 'dist', 'index.js'), 'utf8'), 'export const value = true;\n');
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
  assert.ok(afterPublish.mtimeMs > before.mtimeMs, 'successful source refresh marks the declared output current');

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
        force: true,
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
    assert.deepEqual(targetPreparedPackages, []);
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
