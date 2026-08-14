import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { execYarn } from '../../../../../scripts/workspaces/execYarnCommand.mjs';
import { withDependencyRefresh } from '../proc/dependency_refresh.mjs';

export const REMOTE_INITIAL_DEPENDENCY_INSTALL_ARGS = [
  'install',
  '--production=false',
  '--ignore-engines',
  '--ignore-scripts',
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
    resolved.XDG_CACHE_HOME ||= join(cacheBaseDir, 'xdg');
    resolved.YARN_CACHE_FOLDER ||= join(cacheBaseDir, 'yarn');
    resolved.npm_config_cache ||= join(cacheBaseDir, 'npm');
    resolved.COREPACK_HOME ||= join(cacheBaseDir, 'corepack');
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

function runCanonicalUiPostinstall({ repoDir, env }) {
  execYarn(['-s', 'postinstall:real'], {
    cwd: join(repoDir, 'apps', 'ui'),
    env: resolveInitialInstallEnv(env),
    stdio: 'inherit',
  });
}

export async function bootstrapRemoteDependencies({
  repoDir = resolve(process.cwd()),
  env = process.env,
  packageExists = existsSync,
  installInitialDependencies: installInitialDependenciesImpl = installInitialDependencies,
  runUiPostinstall: runUiPostinstallImpl = runCanonicalUiPostinstall,
  withDependencyRefresh: withDependencyRefreshImpl = withDependencyRefresh,
  loadWorkspaceBuildOwner = async () => await import('../../../../../scripts/workspaces/ensureWorkspacePackagesBuilt.mjs'),
  loadDependencyOwner = async () => await import('../proc/pm.mjs'),
} = {}) {
  const componentDir = join(repoDir, 'apps', 'stack');
  const dependencyOwnerEntrypoints = ['workspaces', 'process'].map((domain) => join(
    repoDir,
    'packages',
    'cli-common',
    'dist',
    domain,
    'index.js',
  ));
  await withDependencyRefreshImpl(
    { installDir: repoDir, componentDir, env },
    async () => await installInitialDependenciesImpl({ repoDir, env }),
  );
  if (dependencyOwnerEntrypoints.some((entrypoint) => !packageExists(entrypoint))) {
    const { ensureWorkspacePackagesBuiltByName } = await loadWorkspaceBuildOwner();
    await ensureWorkspacePackagesBuiltByName(
      repoDir,
      ['@happier-dev/cli-common'],
      { env, includeDevDependencies: false },
    );
  }

  const { ensureDepsInstalled } = await loadDependencyOwner();
  await ensureDepsInstalled(
    componentDir,
    'remote Happier workspace',
    {
      env,
      onDependenciesReady: () => runUiPostinstallImpl({ repoDir, env }),
    },
  );
}

const entryPath = String(process.argv[1] ?? '').trim();
if (entryPath && pathToFileURL(resolve(entryPath)).href === import.meta.url) {
  await bootstrapRemoteDependencies();
}
