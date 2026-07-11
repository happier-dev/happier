import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { execYarn } from '../../../scripts/workspaces/execYarnCommand.mjs';
import { createWorkspaceChildBuildEnv } from '../../../scripts/workspaces/workspaceChildBuildEnv.mjs';
import { resolveWorkspaceDependencyBuildOrder } from '../../../scripts/workspaces/resolveWorkspaceDependencyBuildOrder.mjs';
import { resolveWorkspaceBundlePublicationMode } from '../../../scripts/workspaces/workspaceBundlePublication.mjs';
import {
  resolveWorkspaceBundleLockPath,
  withWorkspaceBundleLock,
} from '../../../scripts/workspaces/workspaceBundleLock.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

function findRepoRoot(startDir) {
  let dir = startDir;
  for (let i = 0; i < 10; i += 1) {
    if (existsSync(resolve(dir, 'package.json')) && existsSync(resolve(dir, 'yarn.lock'))) {
      return dir;
    }
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(startDir, '..', '..', '..');
}

async function loadCliCommonWorkspacesModule(repoRoot, env = process.env) {
  const modulePath = resolve(repoRoot, 'packages', 'cli-common', 'dist', 'workspaces', 'index.js');
  if (!existsSync(modulePath)) {
    execYarn(['-s', 'workspace', '@happier-dev/cli-common', 'build'], {
      cwd: repoRoot,
      env,
      stdio: 'inherit',
    });
  }

  if (!existsSync(modulePath)) {
    throw new Error(`Missing cli-common workspaces build helpers: ${modulePath}`);
  }

  return await import(pathToFileURL(modulePath).href);
}

function buildWorkspace(repoRoot, workspaceName, env = process.env) {
  execYarn(['-s', 'workspace', `@happier-dev/${workspaceName}`, 'build'], {
    cwd: repoRoot,
    env,
    stdio: 'inherit',
  });
}

export function resolvePluginSdkWorkspaceBuildOrder({ repoRoot }) {
  return resolveWorkspaceDependencyBuildOrder({
    repoRoot,
    seedPackageNames: ['@happier-dev/cli-common'],
  });
}

export function resolvePluginSdkWorkspaceBundleLockPath({ repoRoot, lockPath = '' }) {
  const explicitLockPath = String(lockPath ?? '').trim();
  return explicitLockPath || resolveWorkspaceBundleLockPath(repoRoot);
}

export async function bundleWorkspaceDeps(opts = {}) {
  const repoRoot = opts.repoRoot ?? findRepoRoot(__dirname);
  const pluginSdkDir = opts.pluginSdkDir ?? resolve(repoRoot, 'packages', 'plugin-sdk');
  const lockPath = resolvePluginSdkWorkspaceBundleLockPath({ repoRoot, lockPath: opts.lockPath });
  const baseEnv = opts.env ?? process.env;

  return withWorkspaceBundleLock(async ({ heldLockValue }) => {
    const heldLockEnv = createWorkspaceChildBuildEnv({
      env: baseEnv,
      heldLockValue,
    });
    for (const workspaceName of resolvePluginSdkWorkspaceBuildOrder({ repoRoot })) {
      buildWorkspace(repoRoot, workspaceName, heldLockEnv);
    }

    const {
      bundleWorkspacePackagesWithRuntimeDependencies,
      resolveWorkspaceBundlesFromPackageJson,
    } = await loadCliCommonWorkspacesModule(repoRoot, heldLockEnv);

    const bundles = resolveWorkspaceBundlesFromPackageJson({
      repoRoot,
      hostPackageDir: pluginSdkDir,
    });
    bundleWorkspacePackagesWithRuntimeDependencies({
      bundles,
      publicationMode: opts.publicationMode ?? 'live',
    });
  }, {
    lockPath,
    heldLockValue: String(
      opts.heldLockValue
        ?? opts.heldLockPath
        ?? baseEnv?.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD
        ?? '',
    ).trim(),
    timeoutMs: 240_000,
    pollIntervalMs: 250,
    staleAfterMs: 240_000,
  });
}

const invokedAsMain = (() => {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  return resolve(argv1) === fileURLToPath(import.meta.url);
})();

if (invokedAsMain) {
  try {
    await bundleWorkspaceDeps({
      publicationMode: resolveWorkspaceBundlePublicationMode({
        argv: process.argv.slice(2),
        env: process.env,
      }),
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
