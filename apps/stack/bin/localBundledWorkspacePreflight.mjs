import { pathToFileURL } from 'node:url';

import { loadCliCommonWorkspacesModule } from '../../../scripts/workspaces/loadCliCommonWorkspacesModule.mjs';
import { resolveWorkspaceBuildMode, WORKSPACE_BUILD_MODE_ENV } from '../../../scripts/workspaces/workspaceChildBuildEnv.mjs';
import { resolveBundledWorkspaceSyncModulePath } from '../scripts/runtime/resolveBundledWorkspaceSyncModulePath.mjs';
import { coerceHappyMonorepoRootFromPath } from '../scripts/utils/paths/paths.mjs';
import { resolveStackRuntimeMode } from '../scripts/runtime/shared/runtime_mode.mjs';

export function isBundledWorkspaceRuntimeInvocation(argv, env = process.env) {
  const { mode } = resolveStackRuntimeMode({ argv, env });
  return mode === 'require' || mode === 'source-snapshot';
}

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
  env,
}) {
  try {
    const cliCommonWorkspacesModule = await loadCliCommonWorkspacesModule(
      repoRoot,
      env,
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
  const env = { ...process.env, [WORKSPACE_BUILD_MODE_ENV]: resolveWorkspaceBuildMode({
    buildMode: process.env[WORKSPACE_BUILD_MODE_ENV] ?? 'source-dev', env: process.env,
  }) };
  const syncModulePath = resolveBundledWorkspaceSyncModulePath(cliRoot);
  if (await bundledWorkspacePackagesAreHealthy({
    repoRoot,
    hostPackageDir: cliRoot,
    ensureWorkspacePackagesBuiltByName: opts.ensureWorkspacePackagesBuiltByName,
    env,
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
        env,
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
    env,
  });
}
