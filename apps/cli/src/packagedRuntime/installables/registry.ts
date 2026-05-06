import {
  BUILT_IN_INSTALLABLES_REGISTRY,
  type CapabilityId,
  type InstallableKey,
  type InstallablesRegistry,
} from '@happier-dev/protocol';

import { getGitHubReleaseBinaryRuntimeInstallableAdapter } from './sourceAdapters/githubReleaseBinary';

export type RuntimeInstallableLaunchAvailability =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; errorMessage: string }>;

export type RuntimeInstallableLaunchResolution = Readonly<{
  availability: RuntimeInstallableLaunchAvailability;
  canAutoInstall: boolean;
  canBackgroundAutoUpdate: boolean;
}>;

export type RuntimeInstallableInstallResult =
  | Readonly<{ ok: true; logPath: string }>
  | Readonly<{ ok: false; errorMessage: string; logPath: string | null }>;

export type RuntimeInstallableAdapter = Readonly<{
  key: InstallableKey;
  capabilityId: Extract<CapabilityId, `dep.${string}`>;
  detectLaunchResolution: (params?: Readonly<{ env?: NodeJS.ProcessEnv }>) => Promise<RuntimeInstallableLaunchResolution>;
  installOrUpgrade: () => Promise<RuntimeInstallableInstallResult>;
  runBackgroundAutoUpdateCheck: () => Promise<void>;
}>;

export async function getRuntimeInstallableAdapter(
  key: InstallableKey,
  opts: Readonly<{ installablesRegistry?: InstallablesRegistry }> = {},
): Promise<RuntimeInstallableAdapter> {
  const registry = opts.installablesRegistry ?? BUILT_IN_INSTALLABLES_REGISTRY;
  const descriptor = registry.descriptorsByKey[key]?.descriptor;
  if (!descriptor) {
    throw new Error(`No runtime installable adapter is registered for "${key}"`);
  }

  if (descriptor.source.kind === 'github_release_binary') {
    const adapter = await getGitHubReleaseBinaryRuntimeInstallableAdapter(descriptor);
    if (adapter) {
      return adapter;
    }
  }

  throw new Error(`Installable source kind "${descriptor.source.kind}" for "${key}" is not executable by the runtime installables adapter`);
}
