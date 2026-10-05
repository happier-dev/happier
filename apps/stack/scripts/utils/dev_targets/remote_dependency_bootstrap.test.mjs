import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { inspectDependencyRefresh, withDependencyRefresh } from '../proc/dependency_refresh.mjs';

import {
  REMOTE_INITIAL_DEPENDENCY_INSTALL_ARGS,
  bootstrapRemoteDependencies,
} from './remote_dependency_bootstrap.mjs';

const runDependencyRefreshImmediately = async (_options, refresh) => await refresh({});

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
    env: { HAPPIER_STACK_PM_CACHE_BASE_DIR: '/remote/cache' },
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
      env: { HAPPIER_STACK_PM_CACHE_BASE_DIR: '/remote/cache' },
    }],
    ['build-owner', '/remote/happier', ['@happier-dev/cli-common'], {
      env: { HAPPIER_STACK_PM_CACHE_BASE_DIR: '/remote/cache' },
      includeDevDependencies: false,
    }],
    ['load-owner'],
    ['ensure', '/remote/happier/apps/stack', 'remote Happier workspace', {
      env: { HAPPIER_STACK_PM_CACHE_BASE_DIR: '/remote/cache' },
      hasDependencyReadyAction: false,
    }],
    ['workspace', '/remote/happier/apps/stack', {
      env: { HAPPIER_STACK_PM_CACHE_BASE_DIR: '/remote/cache' },
    }],
  ]);
});

test('remote dependency bootstrap leaves unrelated workspace publication to component preparation', async () => {
  const calls = [];

  await bootstrapRemoteDependencies({
    repoDir: '/remote/happier',
    env: { HAPPIER_STACK_PM_CACHE_BASE_DIR: '/remote/cache' },
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
      env: { HAPPIER_STACK_PM_CACHE_BASE_DIR: '/remote/cache' },
    }],
    ['build-owner', '/remote/happier', ['@happier-dev/cli-common'], {
      env: { HAPPIER_STACK_PM_CACHE_BASE_DIR: '/remote/cache' },
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
    env: { HAPPIER_STACK_PM_CACHE_BASE_DIR: '/remote/cache' },
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
      env: { HAPPIER_STACK_PM_CACHE_BASE_DIR: '/remote/cache' },
    }],
  ]);
});

test('remote dependency bootstrap repairs a scriptless install whose dependency owner was not built', async () => {
  const calls = [];

  await bootstrapRemoteDependencies({
    repoDir: '/remote/happier',
    env: { HAPPIER_STACK_PM_CACHE_BASE_DIR: '/remote/cache' },
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
      env: { HAPPIER_STACK_PM_CACHE_BASE_DIR: '/remote/cache' },
      includeDevDependencies: false,
    }],
    ['ensure'],
  ]);
});
