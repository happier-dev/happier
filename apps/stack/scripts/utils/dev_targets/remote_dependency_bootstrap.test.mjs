import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import {
  REMOTE_INITIAL_DEPENDENCY_INSTALL_ARGS,
  bootstrapRemoteDependencies,
} from './remote_dependency_bootstrap.mjs';

const runDependencyRefreshImmediately = async (_options, refresh) => await refresh({});

test('remote stage-zero dependency install materializes dependencies without workspace lifecycle scripts', () => {
  assert.deepEqual(REMOTE_INITIAL_DEPENDENCY_INSTALL_ARGS, [
    'install',
    '--production=false',
    '--ignore-engines',
    '--ignore-scripts',
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
    assert.equal((await stat(join(repoDir, '.project', 'tmp', 'cli-dist-build.lock'))).isFile(), true);
    if (installCalls === 1) {
      markFirstInstallStarted();
      await firstInstallRelease;
    }
    await mkdir(join(repoDir, 'node_modules'), { recursive: true });
    await writeFile(join(repoDir, 'node_modules', '.yarn-integrity'), 'fixture\n', 'utf-8');
  };
  const loadDependencyOwner = async () => ({
    ensureDepsInstalled: async () => {},
  });
  const options = {
    repoDir,
    env: { ...process.env, CI: '1' },
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
  ]);
});

test('remote dependency bootstrap does not run component-owned UI preparation for an arbitrary command', async () => {
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

test('remote dependency bootstrap reuses the canonical dependency owner when stage zero exists', async () => {
  let initialInstallCalled = false;
  let workspaceBuildOwnerLoaded = false;
  let ensured = false;

  await bootstrapRemoteDependencies({
    repoDir: '/remote/happier',
    packageExists: (path) => new Set([
      '/remote/happier/node_modules/.yarn-integrity',
      '/remote/happier/packages/cli-common/dist/workspaces/index.js',
    ]).has(path),
    installInitialDependencies: async () => {
      initialInstallCalled = true;
    },
    withDependencyRefresh: async () => ({ refreshed: false, reason: 'up-to-date' }),
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
    }),
  });

  assert.equal(initialInstallCalled, false);
  assert.equal(workspaceBuildOwnerLoaded, true);
  assert.equal(ensured, true);
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
