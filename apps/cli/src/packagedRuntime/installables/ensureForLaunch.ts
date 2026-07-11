import {
  BUILT_IN_INSTALLABLES_REGISTRY,
  type AccountSettings,
  type InstallableKey,
  type InstallablesRegistry,
} from '@happier-dev/protocol';
import { resolveEffectiveInstallablePolicy } from '@happier-dev/protocol/installablesPolicy';

import {
  getRuntimeInstallableAdapter,
  type RuntimeInstallableAdapter,
} from './registry';
import { startBackgroundRuntimeInstallableUpdate } from './startBackgroundUpdate';

type Deps = Readonly<{
  getRuntimeInstallableAdapter: (
    installableKey: InstallableKey,
    opts?: Readonly<{ installablesRegistry?: InstallablesRegistry }>,
  ) => Promise<RuntimeInstallableAdapter>;
  startBackgroundRuntimeInstallableUpdate: typeof startBackgroundRuntimeInstallableUpdate;
}>;

export type EnsureRuntimeInstallablesForLaunchResult =
  | Readonly<{ ok: true; installedKeys: InstallableKey[] }>
  | Readonly<{ ok: false; installableKey: InstallableKey; errorMessage: string; logPath: string | null }>;

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
    const descriptor = installablesRegistry.descriptorsByKey[installableKey]?.descriptor;
    if (!descriptor) {
      throw new Error(`No installable catalog entry exists for "${installableKey}"`);
    }
    const adapter = await deps.getRuntimeInstallableAdapter(installableKey, { installablesRegistry });
    const policy = resolveEffectiveInstallablePolicy({
      settings: params.settings ?? {},
      machineId: params.machineId,
      descriptor,
    });

    let resolution = await adapter.detectLaunchResolution({ env: params.env });
    let installedThisLaunch = false;

    if (
      !resolution.availability.ok &&
      resolution.canAutoInstall &&
      policy.autoInstallWhenNeeded &&
      descriptor.consent.install !== 'required'
    ) {
      const installResult = await adapter.installOrUpgrade();
      if (!installResult.ok) {
        return {
          ok: false,
          installableKey,
          errorMessage: installResult.errorMessage,
          logPath: installResult.logPath,
        };
      }

      resolution = await adapter.detectLaunchResolution({ env: params.env });
      installedThisLaunch = true;
      if (resolution.availability.ok) installedKeys.push(installableKey);
    }

    if (!resolution.availability.ok) {
      return {
        ok: false,
        installableKey,
        errorMessage: resolution.availability.errorMessage,
        logPath: null,
      };
    }

    if (
      !installedThisLaunch &&
      resolution.availability.ok &&
      resolution.canBackgroundAutoUpdate &&
      policy.autoUpdateMode === 'auto' &&
      descriptor.consent.update !== 'required'
    ) {
      void deps.startBackgroundRuntimeInstallableUpdate({
        installableKey,
        adapter,
      });
    }
  }

  return { ok: true, installedKeys };
}
