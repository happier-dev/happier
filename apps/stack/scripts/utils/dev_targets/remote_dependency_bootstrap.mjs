import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join, posix, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { execYarn } from '../../../../../scripts/workspaces/execYarnCommand.mjs';
import { resolveWorkspaceBuildMode, WORKSPACE_BUILD_MODE_ENV } from '../../../../../scripts/workspaces/workspaceChildBuildEnv.mjs';
import { SCRIPTLESS_DEPENDENCY_INSTALL_MODE, withDependencyRefresh } from '../proc/dependency_refresh.mjs';
import { ensureUiPostinstallOutputs } from '../proc/ui_postinstall.mjs';
import { resolvePackageManagerCachePaths } from '../proc/package_manager_cache.mjs';

export const REMOTE_INITIAL_DEPENDENCY_INSTALL_ARGS = [
  'install',
  '--production=false',
  '--ignore-engines',
  '--ignore-scripts',
  '--pure-lockfile',
];

function resolveInitialInstallEnv(env) {
  const resolved = {
    ...(env ?? process.env),
    NODE_ENV: 'development',
    YARN_PRODUCTION: '0',
    npm_config_production: 'false',
    NPM_CONFIG_PRODUCTION: 'false',
    COREPACK_ENABLE_AUTO_PIN: '0',
  };
  const cacheBaseDir = String(resolved.HAPPIER_STACK_PM_CACHE_BASE_DIR ?? '').trim();
  if (cacheBaseDir) {
    for (const [key, path] of Object.entries(resolvePackageManagerCachePaths(cacheBaseDir))) resolved[key] ||= path;
  }
  return resolved;
}

async function installInitialDependencies({ repoDir, env }) {
  const installEnv = resolveInitialInstallEnv(env);
  for (const path of [
    installEnv.XDG_CACHE_HOME,
    installEnv.YARN_CACHE_FOLDER,
    installEnv.npm_config_cache,
    installEnv.COREPACK_HOME,
  ]) {
    if (path) await mkdir(path, { recursive: true });
  }
  execYarn(REMOTE_INITIAL_DEPENDENCY_INSTALL_ARGS, {
    cwd: repoDir,
    env: installEnv,
    preferCorepack: true,
    stdio: 'inherit',
  });
}

async function prepareInitialUiOutputs({ repoDir, env }) {
  const installEnv = resolveInitialInstallEnv(env);
  const runYarn = args => execYarn(args, { cwd: repoDir, env: installEnv, preferCorepack: true, stdio: 'inherit' });
  await ensureUiPostinstallOutputs(join(repoDir, 'apps', 'ui'), repoDir, {
    force: true,
    runPostinstall: async () => runYarn(['-s', 'workspace', '@happier-dev/app', 'postinstall:real']),
    restoreDependencies: async () => runYarn(['install', '--force', ...REMOTE_INITIAL_DEPENDENCY_INSTALL_ARGS.slice(1)]),
  });
}

export async function bootstrapRemoteDependencies({
  repoDir = resolve(process.cwd()),
  validationKind = 'runtime',
  toolsOnly = false,
  componentRelativeDir = '.',
  env = process.env,
  packageExists = existsSync,
  installInitialDependencies: installInitialDependenciesImpl = installInitialDependencies,
  withDependencyRefresh: withDependencyRefreshImpl = withDependencyRefresh,
  loadWorkspaceBuildOwner = async () => await import('../../../../../scripts/workspaces/ensureWorkspacePackagesBuilt.mjs'),
  loadDependencyOwner = async () => await import('../proc/pm.mjs'),
} = {}) {
  // Runtime preparation emits executable prerequisites. Semantic checking is
  // owned by explicit strict/publication callers and the separate check lane.
  env = { ...env, [WORKSPACE_BUILD_MODE_ENV]: resolveWorkspaceBuildMode({
    buildMode: env[WORKSPACE_BUILD_MODE_ENV] ?? (validationKind === 'runtime' ? 'source-dev' : 'strict'), env,
  }) };
  const componentDir = join(repoDir, 'apps', 'stack');
  const componentPath = posix.normalize(String(componentRelativeDir).replaceAll('\\', '/'));
  const sourceToolsOnly = toolsOnly || validationKind === 'source-test';
  const needsUiPostinstallPreparation = sourceToolsOnly && /^apps\/ui(?:\/|$)/u.test(componentPath);
  let refreshed = false;
  const installAndPrepare = async () => {
    await installInitialDependenciesImpl({ repoDir, env });
    refreshed = true;
    // UI source tooling prepares postinstall under the same freshness lock.
    // Other installs still complete shared UI outputs before
    // releasing their stage-zero dependency admission.
    if (!needsUiPostinstallPreparation) await prepareInitialUiOutputs({ repoDir, env });
  };
  if (sourceToolsOnly) {
    // Source tests do not consume the Stack dependency owner's compiled closure.
    // The readiness verifier and postinstall tools resolve source directly;
    // retain patched dependency preparation without publishing workspace dist.
    const onDependenciesReady = needsUiPostinstallPreparation
      ? async () => {
          const { ensureUiPostinstallOutputs } = await loadDependencyOwner();
          await ensureUiPostinstallOutputs(join(repoDir, 'apps', 'ui'), repoDir, { env, force: refreshed });
        }
      : null;
    return await withDependencyRefreshImpl(
      { installDir: repoDir, componentDir, env, installMode: SCRIPTLESS_DEPENDENCY_INSTALL_MODE, onDependenciesReady },
      installAndPrepare,
    );
  }
  const dependencyOwnerEntrypoints = ['workspaces', 'process'].map((domain) => join(
    repoDir,
    'packages',
    'cli-common',
    'dist',
    domain,
    'index.js',
  ));
  const dependencyOwnerReady = dependencyOwnerEntrypoints.every((entrypoint) => packageExists(entrypoint));
  if (!dependencyOwnerReady) {
    await withDependencyRefreshImpl(
      { installDir: repoDir, componentDir, env, installMode: SCRIPTLESS_DEPENDENCY_INSTALL_MODE },
      installAndPrepare,
    );
    const { ensureWorkspacePackagesBuiltByName } = await loadWorkspaceBuildOwner();
    await ensureWorkspacePackagesBuiltByName(
      repoDir,
      ['@happier-dev/cli-common'],
      { env, includeDevDependencies: false },
    );
  }

  const {
    ensureDepsInstalled,
    ensureWorkspacePackagesBuiltForComponent,
  } = await loadDependencyOwner();
  await ensureDepsInstalled(
    componentDir,
    'remote Happier workspace',
    { env },
  );
  // The launcher needs its dependency owner, while only Stack commands consume
  // Stack's emitted workspace closure. Other components prepare their own outputs.
  if (/^apps\/stack(?:\/|$)/u.test(componentPath)) {
    if (typeof ensureWorkspacePackagesBuiltForComponent !== 'function') {
      throw new Error('Remote Happier workspace dependency owner does not expose component workspace preparation');
    }
    await ensureWorkspacePackagesBuiltForComponent(componentDir, { env });
  }
}

const entryPath = String(process.argv[1] ?? '').trim();
if (entryPath && pathToFileURL(resolve(entryPath)).href === import.meta.url) {
  const kind = process.argv.slice(2).find(value => value.startsWith('--validation-kind='));
  const component = process.argv.slice(2).find(value => value.startsWith('--component-relative-dir='));
  const repo = process.argv.slice(2).find(value => value.startsWith('--repo-dir='));
  await bootstrapRemoteDependencies({
    ...(repo ? { repoDir: resolve(repo.slice('--repo-dir='.length)) } : {}),
    toolsOnly: process.argv.includes('--tools-only'),
    validationKind: kind?.slice('--validation-kind='.length) ?? 'runtime',
    componentRelativeDir: component?.slice('--component-relative-dir='.length) ?? '.',
  });
}
