import { BUILT_IN_INSTALLABLES_REGISTRY } from '@happier-dev/protocol/installables';
import type { InstallableContributionOwner, InstallableDependencyDescriptor } from '@happier-dev/protocol/installables';
import type { AccountSettings, InstallableKey, InstallablesRegistry } from '@happier-dev/protocol';
import { resolveEffectiveInstallablePolicy } from '@happier-dev/protocol/installablesPolicy';

import {
  getRuntimeInstallableAdapter,
  getRuntimeInstallableAdapterForDescriptor,
  type RuntimeInstallableAdapter,
  type RuntimeInstallableInstallResult,
  type RuntimeInstallableInstallOptions,
} from './registry';
import { startBackgroundRuntimeInstallableUpdate } from './startBackgroundUpdate';

type Deps = Readonly<{
  getRuntimeInstallableAdapter: (
    installableKey: InstallableKey,
    opts?: Readonly<{ installablesRegistry?: InstallablesRegistry }>,
  ) => Promise<RuntimeInstallableAdapter>;
  startBackgroundRuntimeInstallableUpdate: typeof startBackgroundRuntimeInstallableUpdate;
}>;

type DescriptorDeps = Readonly<{
  getRuntimeInstallableAdapterForDescriptor: typeof getRuntimeInstallableAdapterForDescriptor;
  startBackgroundRuntimeInstallableUpdate: typeof startBackgroundRuntimeInstallableUpdate;
}>;

export type EnsureRuntimeInstallablesForLaunchResult =
  | Readonly<{ ok: true; installedKeys: InstallableKey[] }>
  | (Extract<RuntimeInstallableInstallResult, { ok: false }> & Readonly<{ installableKey: InstallableKey }>);

export async function ensureRuntimeInstallableDescriptorForLaunch(
  params: Readonly<{
    descriptor: InstallableDependencyDescriptor;
    owner?: Pick<InstallableContributionOwner, 'ownerId'>;
    settings: AccountSettings | null | undefined;
    machineId: string;
    env?: NodeJS.ProcessEnv;
    host?: Readonly<{ platform?: NodeJS.Platform; architecture?: string }>;
    managedAcpDefinition?: RuntimeInstallableInstallOptions['managedAcpDefinition'];
  }>,
  depsOverrides: Partial<DescriptorDeps> = {},
): Promise<EnsureRuntimeInstallablesForLaunchResult> {
  const descriptor = params.descriptor;
  const installableKey = descriptor.key;
  const adapter = await (depsOverrides.getRuntimeInstallableAdapterForDescriptor ?? getRuntimeInstallableAdapterForDescriptor)(
    descriptor, params.owner ?? { ownerId: descriptor.id }, params.host,
  );
  const policy = resolveEffectiveInstallablePolicy({
    settings: params.settings ?? {},
    machineId: params.machineId,
    descriptor,
  });
  let resolution = await adapter.detectLaunchResolution({ env: params.env });
  let installedThisLaunch = false;
  const installedKeys: InstallableKey[] = [];

  if (
    !resolution.availability.ok && resolution.canAutoInstall && policy.autoInstallWhenNeeded &&
    descriptor.consent.install !== 'required'
  ) {
    const installResult = await adapter.installOrUpgrade({ env: params.env, managedAcpDefinition: params.managedAcpDefinition });
    if (!installResult.ok) {
      return { ...installResult, installableKey };
    }
    resolution = await adapter.detectLaunchResolution({ env: params.env });
    installedThisLaunch = true;
    if (resolution.availability.ok) installedKeys.push(installableKey);
  }

  if (!resolution.availability.ok) {
    return { ok: false, installableKey, errorMessage: resolution.availability.errorMessage, logPath: null };
  }

  if (
    !installedThisLaunch && resolution.canBackgroundAutoUpdate && policy.autoUpdateMode === 'auto' &&
    descriptor.consent.update !== 'required'
  ) {
    void (depsOverrides.startBackgroundRuntimeInstallableUpdate ?? startBackgroundRuntimeInstallableUpdate)({ installableKey, adapter });
  }
  return { ok: true, installedKeys };
}

export async function ensureRuntimeInstallablesForLaunch(
  params: Readonly<{
    installableKeys: readonly InstallableKey[];
    settings: AccountSettings | null | undefined;
    machineId: string;
    env?: NodeJS.ProcessEnv;
    installablesRegistry?: InstallablesRegistry;
  }>,
  depsOverrides: Partial<Deps> = {},
): Promise<EnsureRuntimeInstallablesForLaunchResult> {
  const deps: Deps = {
    getRuntimeInstallableAdapter: depsOverrides.getRuntimeInstallableAdapter ?? getRuntimeInstallableAdapter,
    startBackgroundRuntimeInstallableUpdate:
      depsOverrides.startBackgroundRuntimeInstallableUpdate ?? startBackgroundRuntimeInstallableUpdate,
  };

  const installedKeys: InstallableKey[] = [];
  const installablesRegistry = params.installablesRegistry ?? BUILT_IN_INSTALLABLES_REGISTRY;
  for (const installableKey of Array.from(new Set(params.installableKeys))) {
    const contribution = installablesRegistry.descriptorsByKey[installableKey];
    if (!contribution) {
      throw new Error(`No installable catalog entry exists for "${installableKey}"`);
    }
    const result = await ensureRuntimeInstallableDescriptorForLaunch({
      descriptor: contribution.descriptor,
      owner: contribution.owner,
      settings: params.settings,
      machineId: params.machineId,
      env: params.env,
    }, {
      getRuntimeInstallableAdapterForDescriptor: async () => deps.getRuntimeInstallableAdapter(installableKey, { installablesRegistry }),
      startBackgroundRuntimeInstallableUpdate: deps.startBackgroundRuntimeInstallableUpdate,
    });
    if (!result.ok) return result;
    installedKeys.push(...result.installedKeys);
  }

  return { ok: true, installedKeys };
}
