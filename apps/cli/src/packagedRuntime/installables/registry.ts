import { BUILT_IN_INSTALLABLES_REGISTRY } from '@happier-dev/protocol/installables';
import type { InstallableContributionOwner, InstallChecksumStateV1 } from '@happier-dev/protocol/installables';
import type { CapabilityId, InstallableKey, InstallablesRegistry, InstallableDependencyDescriptor } from '@happier-dev/protocol';
import type { AgentInstallProgressCallback } from '@happier-dev/cli-common/agents';

import { getGitHubReleaseBinaryRuntimeInstallableAdapter } from './sourceAdapters/githubReleaseBinary';
import { getManagedPypiWheelAssetRuntimeInstallableAdapter } from './sourceAdapters/pypiWheelAsset';
import { getPinnedArchiveRuntimeInstallableAdapter } from './sourceAdapters/pinnedArchive';
import { COMPUTER_CUA_DRIVER_INSTALLABLE_KEY, getComputerCuaDriverArchiveDownloadInstallableAdapter, getComputerCuaDriverRuntimeInstallableAdapter } from './sourceAdapters/computerCuaDriver';
import { COMPUTER_AGENT_DESKTOP_INSTALLABLE_KEY, getComputerAgentDesktopArchiveDownloadInstallableAdapter, getComputerAgentDesktopRuntimeInstallableAdapter } from './sourceAdapters/computerAgentDesktop';
import {
  ARCHIVE_DOWNLOAD_INSTALLABLE_SOURCE_KIND,
  BROWSER_CHROMIUM_INSTALLABLE_KEY,
  getBrowserChromiumArchiveDownloadInstallableAdapter,
  type ArchiveDownloadInstallableAdapter,
} from './sourceAdapters/browserChromium';

export { readRuntimeInstallableDescriptor, readRuntimeInstallablesRegistry } from './descriptors';

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

/**
 * `logPath` is the install log this source wrote, or `null` when the source
 * writes none. Readers present it to users as the install log, so a source must
 * never substitute another path for it.
 */
export type RuntimeInstallableInstallResult =
  | Readonly<{ ok: true; logPath: string | null; checksum?: InstallChecksumStateV1 }>
  | Readonly<{ ok: false; errorMessage: string; logPath: string | null; errorCode?: RuntimeInstallableInstallErrorCode }>;

export type RuntimeInstallableInstallErrorCode =
  | 'download-failed'
  | 'rate-limited'
  | 'verification-failed'
  | 'command-timed-out'
  | 'termination-failed';

export type RuntimeInstallableCapabilityStatusParams = Readonly<{
  env?: NodeJS.ProcessEnv;
  includeLatestVersion?: boolean;
  onlyIfInstalled?: boolean;
}>;

export type RuntimeInstallableInstallOptions = Readonly<{
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  onProgress?: AgentInstallProgressCallback;
  managedAcpDefinition?: Readonly<{ definitionId: string; title: string }>;
}>;

export type RuntimeInstallableAdapter = Readonly<{
  key: InstallableKey;
  capabilityId: Extract<CapabilityId, `dep.${string}`>;
  detectCapabilityStatus?: (params?: RuntimeInstallableCapabilityStatusParams) => Promise<unknown>;
  detectLaunchResolution: (params?: Readonly<{ env?: NodeJS.ProcessEnv }>) => Promise<RuntimeInstallableLaunchResolution>;
  resolveLaunchCommand?: (params?: RuntimeInstallableLaunchCommandParams) => Promise<RuntimeInstallableLaunchCommandResolution>;
  installOrUpgrade: (options?: RuntimeInstallableInstallOptions) => Promise<RuntimeInstallableInstallResult>;
  removeManagedInstall?: (options?: Readonly<{ env?: NodeJS.ProcessEnv; signal?: AbortSignal }>) => Promise<void>;
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
  return getRuntimeInstallableAdapterForDescriptor(contribution.descriptor, contribution.owner);
}

export async function getRuntimeInstallableAdapterForDescriptor(
  descriptor: InstallableDependencyDescriptor,
  owner: Pick<InstallableContributionOwner, 'ownerId'>,
  host: Readonly<{ platform?: NodeJS.Platform; architecture?: string }> = {},
): Promise<RuntimeInstallableAdapter> {
  const key = descriptor.key;

  if (descriptor.source.kind === 'first_party_runtime') {
    const { getOptionalRuntimeInstallableAdapter } = await import('./optionalRuntimes');
    const adapter = getOptionalRuntimeInstallableAdapter(descriptor);
    if (adapter) return adapter;
  }

  if (descriptor.source.kind === 'github_release_binary') {
    const adapter = await getGitHubReleaseBinaryRuntimeInstallableAdapter(descriptor);
    if (adapter) {
      return adapter;
    }
  }

  if (descriptor.source.kind === 'managed_pypi_wheel_asset') {
    const adapter = await getManagedPypiWheelAssetRuntimeInstallableAdapter(
      descriptor,
      owner.ownerId,
    );
    if (adapter) {
      return adapter;
    }
  }

  if (descriptor.source.kind === 'pinned_archive') {
    if (key === COMPUTER_CUA_DRIVER_INSTALLABLE_KEY) return getComputerCuaDriverRuntimeInstallableAdapter(descriptor);
    if (key === COMPUTER_AGENT_DESKTOP_INSTALLABLE_KEY) return getComputerAgentDesktopRuntimeInstallableAdapter(descriptor);
    const adapter = getPinnedArchiveRuntimeInstallableAdapter(descriptor, host);
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
  if (key === COMPUTER_CUA_DRIVER_INSTALLABLE_KEY) {
    return getComputerCuaDriverArchiveDownloadInstallableAdapter();
  }
  if (key === COMPUTER_AGENT_DESKTOP_INSTALLABLE_KEY) {
    return getComputerAgentDesktopArchiveDownloadInstallableAdapter();
  }
  return null;
}

export { ARCHIVE_DOWNLOAD_INSTALLABLE_SOURCE_KIND, BROWSER_CHROMIUM_INSTALLABLE_KEY };
export type { ArchiveDownloadInstallableAdapter };
