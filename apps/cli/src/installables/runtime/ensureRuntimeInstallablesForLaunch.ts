import { INSTALLABLES_CATALOG, type AccountSettings, type InstallableKey } from '@happier-dev/protocol';
import { resolveInstallablePolicy } from '@happier-dev/protocol/installablesPolicy';

import {
  getRuntimeInstallableAdapter,
  type RuntimeInstallableAdapter,
} from './runtimeInstallablesRegistry';
import { startBackgroundRuntimeInstallableUpdate } from './startBackgroundRuntimeInstallableUpdate';

type Deps = Readonly<{
  getRuntimeInstallableAdapter: (installableKey: InstallableKey) => Promise<RuntimeInstallableAdapter>;
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
  }>,
  depsOverrides: Partial<Deps> = {},
): Promise<EnsureRuntimeInstallablesForLaunchResult> {
  const deps: Deps = {
    getRuntimeInstallableAdapter: depsOverrides.getRuntimeInstallableAdapter ?? getRuntimeInstallableAdapter,
    startBackgroundRuntimeInstallableUpdate:
      depsOverrides.startBackgroundRuntimeInstallableUpdate ?? startBackgroundRuntimeInstallableUpdate,
  };

  const installedKeys: InstallableKey[] = [];
  const defaultsByInstallableKey = new Map(INSTALLABLES_CATALOG.map((entry) => [entry.key, entry.defaultPolicy]));

  for (const installableKey of Array.from(new Set(params.installableKeys))) {
    const adapter = await deps.getRuntimeInstallableAdapter(installableKey);
    const defaults = defaultsByInstallableKey.get(installableKey);
    if (!defaults) {
      throw new Error(`No installable catalog entry exists for "${installableKey}"`);
    }
    const policy = resolveInstallablePolicy({
      settings: params.settings ?? {},
      machineId: params.machineId,
      installableKey,
      defaults,
    });

    let resolution = await adapter.detectLaunchResolution({ env: params.env });
    let installedThisLaunch = false;

    if (!resolution.availability.ok && resolution.canAutoInstall && policy.autoInstallWhenNeeded) {
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

    if (!installedThisLaunch && resolution.availability.ok && resolution.canBackgroundAutoUpdate && policy.autoUpdateMode === 'auto') {
      void deps.startBackgroundRuntimeInstallableUpdate({
        installableKey,
        adapter,
      });
    }
  }

  return { ok: true, installedKeys };
}
