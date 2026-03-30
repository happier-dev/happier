import type { InstallableKey } from '@happier-dev/protocol';
import { INSTALLABLE_KEYS } from '@happier-dev/protocol';

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
  detectLaunchResolution: (params?: Readonly<{ env?: NodeJS.ProcessEnv }>) => Promise<RuntimeInstallableLaunchResolution>;
  installOrUpgrade: () => Promise<RuntimeInstallableInstallResult>;
  runBackgroundAutoUpdateCheck: () => Promise<void>;
}>;

const runtimeInstallableLoaders: Partial<Record<InstallableKey, () => Promise<RuntimeInstallableAdapter>>> = {
  [INSTALLABLE_KEYS.CODEX_ACP]: async () => (await import('@/backends/codex/acp/runtimeInstallable')).codexAcpRuntimeInstallable,
};

export async function getRuntimeInstallableAdapter(key: InstallableKey): Promise<RuntimeInstallableAdapter> {
  const loader = runtimeInstallableLoaders[key];
  if (!loader) {
    throw new Error(`No runtime installable adapter is registered for "${key}"`);
  }

  return await loader();
}
