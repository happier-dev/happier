import type { InstallableAutoUpdateMode, InstallableDefaultPolicy } from './installables.js';

export type InstallablePolicyOverride = Readonly<{
  autoInstallWhenNeeded?: boolean;
  autoUpdateMode?: InstallableAutoUpdateMode;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readInstallablesPolicyByMachineId(
  settingsLike: unknown,
): Record<string, Record<string, InstallablePolicyOverride>> {
  const raw = isRecord(settingsLike) ? settingsLike.installablesPolicyByMachineId : null;
  if (!isRecord(raw)) return {};

  const out: Record<string, Record<string, InstallablePolicyOverride>> = {};
  for (const [machineId, byKeyRaw] of Object.entries(raw)) {
    if (!isRecord(byKeyRaw)) continue;
    const byKey: Record<string, InstallablePolicyOverride> = {};
    for (const [installableKey, overrideRaw] of Object.entries(byKeyRaw)) {
      if (!isRecord(overrideRaw)) continue;
      const autoInstallWhenNeeded = overrideRaw.autoInstallWhenNeeded;
      const autoUpdateMode = overrideRaw.autoUpdateMode;
      byKey[installableKey] = {
        ...(typeof autoInstallWhenNeeded === 'boolean' ? { autoInstallWhenNeeded } : {}),
        ...(autoUpdateMode === 'off' || autoUpdateMode === 'notify' || autoUpdateMode === 'auto'
          ? { autoUpdateMode }
          : {}),
      };
    }
    out[machineId] = byKey;
  }

  return out;
}

export function resolveInstallablePolicy(params: Readonly<{
  settings: unknown;
  machineId: string;
  installableKey: string;
  defaults: InstallableDefaultPolicy;
}>): InstallableDefaultPolicy {
  const overrides = readInstallablesPolicyByMachineId(params.settings)[params.machineId]?.[params.installableKey] ?? null;
  if (!overrides) return params.defaults;

  return {
    autoInstallWhenNeeded:
      typeof overrides.autoInstallWhenNeeded === 'boolean'
        ? overrides.autoInstallWhenNeeded
        : params.defaults.autoInstallWhenNeeded,
    autoUpdateMode:
      overrides.autoUpdateMode === 'off' ||
      overrides.autoUpdateMode === 'notify' ||
      overrides.autoUpdateMode === 'auto'
        ? overrides.autoUpdateMode
        : params.defaults.autoUpdateMode,
  };
}

export function applyInstallablePolicyOverride(params: Readonly<{
  prev: Record<string, Record<string, InstallablePolicyOverride>>;
  machineId: string;
  installableKey: string;
  patch: InstallablePolicyOverride;
}>): Record<string, Record<string, InstallablePolicyOverride>> {
  const prevByMachine = params.prev[params.machineId] ?? {};
  const prevOverride = prevByMachine[params.installableKey] ?? {};
  return {
    ...params.prev,
    [params.machineId]: {
      ...prevByMachine,
      [params.installableKey]: {
        ...prevOverride,
        ...params.patch,
      },
    },
  };
}
