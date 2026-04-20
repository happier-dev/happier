import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { resolveBundledWorkspaceSyncModulePath } from '../scripts/runtime/resolveBundledWorkspaceSyncModulePath.mjs';
import { coerceHappyMonorepoRootFromPath } from '../scripts/utils/paths/paths.mjs';

async function bundledWorkspacePackagesAreHealthy({ repoRoot, hostPackageDir }) {
  try {
    const cliCommonWorkspacesModule = await import(
      pathToFileURL(resolve(repoRoot, 'packages', 'cli-common', 'dist', 'workspaces', 'index.js')).href
    );
    return typeof cliCommonWorkspacesModule?.hasBundledWorkspacePackagesHealthy === 'function'
      ? cliCommonWorkspacesModule.hasBundledWorkspacePackagesHealthy({ repoRoot, hostPackageDir })
      : false;
  } catch {
    return false;
  }
}

export async function refreshLocalBundledWorkspacePackages(cliRootDir) {
  const cliRoot = String(cliRootDir ?? '').trim();
  if (!cliRoot) return;
  const disabled = String(process.env.HAPPIER_STACK_SYNC_BUNDLED_WORKSPACES ?? '').trim().toLowerCase();
  if (disabled === '0' || disabled === 'false' || disabled === 'no') return;

  const repoRoot = coerceHappyMonorepoRootFromPath(cliRoot);
  if (!repoRoot) return;
  const syncModulePath = resolveBundledWorkspaceSyncModulePath(cliRoot);
  if (syncModulePath) {
    const { syncBundledWorkspacePackages } = await import(pathToFileURL(syncModulePath).href);
    syncBundledWorkspacePackages({
      repoRoot,
      hostApps: ['stack'],
      replaceExisting: false,
    });
    if (await bundledWorkspacePackagesAreHealthy({ repoRoot, hostPackageDir: cliRoot })) {
      return;
    }
  }

  const { bundleWorkspaceDeps } = await import('../scripts/bundleWorkspaceDeps.mjs');
  await bundleWorkspaceDeps({
    repoRoot,
    stackDir: cliRoot,
  });
}
