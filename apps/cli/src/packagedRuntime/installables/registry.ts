import {
  BUILT_IN_INSTALLABLES_REGISTRY,
  type CapabilityId,
  type InstallableKey,
  type InstallablesRegistry,
} from '@happier-dev/protocol';

import { getGitHubReleaseBinaryRuntimeInstallableAdapter } from './sourceAdapters/githubReleaseBinary';
import { getManagedPypiWheelAssetRuntimeInstallableAdapter } from './sourceAdapters/pypiWheelAsset';
import {
  ARCHIVE_DOWNLOAD_INSTALLABLE_SOURCE_KIND,
  BROWSER_CHROMIUM_INSTALLABLE_KEY,
  getBrowserChromiumArchiveDownloadInstallableAdapter,
  type ArchiveDownloadInstallableAdapter,
} from './sourceAdapters/browserChromium';

export type RuntimeInstallableLaunchAvailability =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; errorMessage: string }>;

export type RuntimeInstallableLaunchResolution = Readonly<{
  availability: RuntimeInstallableLaunchAvailability;
  canAutoInstall: boolean;
  canBackgroundAutoUpdate: boolean;
}>;

export type RuntimeInstallableLaunchCommandResolution =
  | Readonly<{
    ok: true;
    command: string;
    args: readonly string[];
    source: 'system' | 'managed' | 'user_config' | 'unknown';
  }>
  | Readonly<{
    ok: false;
    errorMessage: string;
    canAutoInstall: boolean;
  }>;

export type RuntimeInstallableLaunchCommandParams = Readonly<{
  env?: NodeJS.ProcessEnv;
  sourcePreference?: 'system-first' | 'managed-first';
}>;

export type RuntimeInstallableInstallResult =
  | Readonly<{ ok: true; logPath: string }>
  | Readonly<{ ok: false; errorMessage: string; logPath: string | null }>;

export type RuntimeInstallableCapabilityStatusParams = Readonly<{
  includeLatestVersion?: boolean;
  onlyIfInstalled?: boolean;
}>;

export type RuntimeInstallableAdapter = Readonly<{
  key: InstallableKey;
  capabilityId: Extract<CapabilityId, `dep.${string}`>;
  detectCapabilityStatus?: (params?: RuntimeInstallableCapabilityStatusParams) => Promise<unknown>;
  detectLaunchResolution: (params?: Readonly<{ env?: NodeJS.ProcessEnv }>) => Promise<RuntimeInstallableLaunchResolution>;
  resolveLaunchCommand?: (params?: RuntimeInstallableLaunchCommandParams) => Promise<RuntimeInstallableLaunchCommandResolution>;
  installOrUpgrade: () => Promise<RuntimeInstallableInstallResult>;
  removeManagedInstall?: () => Promise<void>;
  runBackgroundAutoUpdateCheck: () => Promise<void>;
}>;

export async function getRuntimeInstallableAdapter(
  key: InstallableKey,
  opts: Readonly<{ installablesRegistry?: InstallablesRegistry }> = {},
): Promise<RuntimeInstallableAdapter> {
  const registry = opts.installablesRegistry ?? BUILT_IN_INSTALLABLES_REGISTRY;
  const contribution = registry.descriptorsByKey[key];
  if (!contribution) {
    throw new Error(`No runtime installable adapter is registered for "${key}"`);
  }
  const descriptor = contribution.descriptor;

  if (descriptor.source.kind === 'github_release_binary') {
    const adapter = await getGitHubReleaseBinaryRuntimeInstallableAdapter(descriptor);
    if (adapter) {
      return adapter;
    }
  }

  if (descriptor.source.kind === 'managed_pypi_wheel_asset') {
    const adapter = await getManagedPypiWheelAssetRuntimeInstallableAdapter(
      descriptor,
      contribution.owner.ownerId,
    );
    if (adapter) {
      return adapter;
    }
  }

  throw new Error(`Installable source kind "${descriptor.source.kind}" for "${key}" is not executable by the runtime installables adapter`);
}

/**
 * Resolve the archive-download installable adapter (MCH-2). Chrome-for-Testing is a per-platform
 * archive, not a `dep.*` system CLI / npm-shaped package, so it lives in its own archive-download
 * source-kind keyed by the product-source `key` rather than the `dep.*` `InstallablesRegistry`.
 * Returns `null` for any unknown key so callers fail closed.
 */
export function getArchiveDownloadInstallableAdapter(
  key: string,
): ArchiveDownloadInstallableAdapter | null {
  if (key === BROWSER_CHROMIUM_INSTALLABLE_KEY) {
    return getBrowserChromiumArchiveDownloadInstallableAdapter();
  }
  return null;
}

export { ARCHIVE_DOWNLOAD_INSTALLABLE_SOURCE_KIND, BROWSER_CHROMIUM_INSTALLABLE_KEY };
export type { ArchiveDownloadInstallableAdapter };
