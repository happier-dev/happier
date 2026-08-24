import { pathToFileURL } from 'node:url';

import { loadCliCommonWorkspacesModule } from '../../../scripts/workspaces/loadCliCommonWorkspacesModule.mjs';
import { resolveBundledWorkspaceSyncModulePath } from '../scripts/runtime/resolveBundledWorkspaceSyncModulePath.mjs';
import { coerceHappyMonorepoRootFromPath } from '../scripts/utils/paths/paths.mjs';

export function isBundledWorkspaceMetadataInvocation(argv) {
  const args = Array.isArray(argv) ? argv.map((arg) => String(arg ?? '')) : [];
  const separatorIndex = args.indexOf('--');
  const metadataScope = separatorIndex === -1 ? args : args.slice(0, separatorIndex);
  if (metadataScope.includes('--help') || metadataScope.includes('-h')) return true;
  if (metadataScope.length === 1 && (metadataScope[0] === '--version' || metadataScope[0] === '-v')) return true;
  return metadataScope[0] === 'help';
}

async function bundledWorkspacePackagesAreHealthy({
  repoRoot,
  hostPackageDir,
  ensureWorkspacePackagesBuiltByName,
}) {
  try {
    const cliCommonWorkspacesModule = await loadCliCommonWorkspacesModule(
      repoRoot,
      process.env,
      ensureWorkspacePackagesBuiltByName,
      { includeDevDependencies: false, quiet: true },
    );
    return typeof cliCommonWorkspacesModule?.hasBundledWorkspacePackagesHealthy === 'function'
      ? cliCommonWorkspacesModule.hasBundledWorkspacePackagesHealthy({ repoRoot, hostPackageDir })
      : false;
  } catch {
    return false;
  }
}

export async function refreshLocalBundledWorkspacePackages(cliRootDir, opts = {}) {
  const cliRoot = String(cliRootDir ?? '').trim();
  if (!cliRoot) return;
  if (isBundledWorkspaceMetadataInvocation(opts.argv)) return;
  const disabled = String(process.env.HAPPIER_STACK_SYNC_BUNDLED_WORKSPACES ?? '').trim().toLowerCase();
  if (disabled === '0' || disabled === 'false' || disabled === 'no') return;

  const repoRoot = coerceHappyMonorepoRootFromPath(cliRoot);
  if (!repoRoot) return;
  const syncModulePath = resolveBundledWorkspaceSyncModulePath(cliRoot);
  if (await bundledWorkspacePackagesAreHealthy({
    repoRoot,
    hostPackageDir: cliRoot,
    ensureWorkspacePackagesBuiltByName: opts.ensureWorkspacePackagesBuiltByName,
  })) {
    return;
  }
  if (syncModulePath) {
    try {
      const { syncBundledWorkspacePackages } = await import(pathToFileURL(syncModulePath).href);
      syncBundledWorkspacePackages({
        repoRoot,
        hostApps: ['stack'],
        replaceExisting: false,
      });
      if (await bundledWorkspacePackagesAreHealthy({
        repoRoot,
        hostPackageDir: cliRoot,
        ensureWorkspacePackagesBuiltByName: opts.ensureWorkspacePackagesBuiltByName,
      })) {
        return;
      }
    } catch {
      // A fresh source checkout can lack build output required by the fast sync.
      // The canonical bundler below owns building that output before publication.
    }
  }

  const { bundleWorkspaceDeps } = await import('../scripts/bundleWorkspaceDeps.mjs');
  await bundleWorkspaceDeps({
    repoRoot,
    stackDir: cliRoot,
  });
}
