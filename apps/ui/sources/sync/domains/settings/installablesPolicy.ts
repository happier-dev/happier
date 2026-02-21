import type { InstallableAutoUpdateMode, InstallableDefaultPolicy } from '@/capabilities/installablesRegistry';
import type { KnownSettings } from './settings';

export type InstallablePolicyOverride = Readonly<{
    autoInstallWhenNeeded?: boolean;
    autoUpdateMode?: InstallableAutoUpdateMode;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readInstallablesPolicyByMachineId(settings: KnownSettings): Record<string, Record<string, InstallablePolicyOverride>> {
    const raw = (settings as any).installablesPolicyByMachineId;
    if (!isRecord(raw)) return {};
    const out: Record<string, Record<string, InstallablePolicyOverride>> = {};
    for (const [machineId, byKeyRaw] of Object.entries(raw)) {
        if (!isRecord(byKeyRaw)) continue;
        const byKey: Record<string, InstallablePolicyOverride> = {};
        for (const [k, v] of Object.entries(byKeyRaw)) {
            if (!isRecord(v)) continue;
            const autoInstallWhenNeeded = (v as any).autoInstallWhenNeeded;
            const autoUpdateMode = (v as any).autoUpdateMode;
            byKey[k] = {
                ...(typeof autoInstallWhenNeeded === 'boolean' ? { autoInstallWhenNeeded } : {}),
                ...((autoUpdateMode === 'off' || autoUpdateMode === 'notify' || autoUpdateMode === 'auto') ? { autoUpdateMode } : {}),
            };
        }
        out[machineId] = byKey;
    }
    return out;
}

export function resolveInstallablePolicy(params: {
    settings: KnownSettings;
    machineId: string;
    installableKey: string;
    defaults: InstallableDefaultPolicy;
}): InstallableDefaultPolicy {
    const overridesByMachineId = readInstallablesPolicyByMachineId(params.settings);
    const overrides = overridesByMachineId[params.machineId]?.[params.installableKey] ?? null;
    if (!overrides) return params.defaults;

    return {
        autoInstallWhenNeeded: typeof overrides.autoInstallWhenNeeded === 'boolean'
            ? overrides.autoInstallWhenNeeded
            : params.defaults.autoInstallWhenNeeded,
        autoUpdateMode: (overrides.autoUpdateMode === 'off' || overrides.autoUpdateMode === 'notify' || overrides.autoUpdateMode === 'auto')
            ? overrides.autoUpdateMode
            : params.defaults.autoUpdateMode,
    };
}

export function applyInstallablePolicyOverride(params: {
    prev: Record<string, Record<string, InstallablePolicyOverride>>;
    machineId: string;
    installableKey: string;
    patch: InstallablePolicyOverride;
}): Record<string, Record<string, InstallablePolicyOverride>> {
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

