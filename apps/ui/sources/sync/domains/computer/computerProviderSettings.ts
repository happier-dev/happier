import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { COMPUTER_PROVIDER_INSTALLABLE_KEYS, ComputerUseSettingsV1Schema,
    type ComputerUseSettingsV1, type ComputerProviderIdV1 } from '@happier-dev/protocol/computer/v1';
import { BUILT_IN_INSTALLABLES_REGISTRY } from '@happier-dev/protocol/installables';
import { MachineCapabilityInstallOutputSchema } from '@happier-dev/protocol/actions/specs/machineConnection';

import { getInstallablesRegistryEntries } from '@/capabilities/installablesRegistry';
import type { MachineCapabilitiesCacheState } from '@/hooks/server/useMachineCapabilitiesCache';

export type ComputerProviderSettingsRow = Readonly<{
    provider: ComputerProviderIdV1;
    enabled: boolean;
    isDefault: boolean;
    availability: 'unknown' | 'loading' | 'installing' | 'unavailable' | 'not_installed' | 'ready';
    error?: Readonly<{ code?: string; message: string }>;
}>;

/** Each provider's own product name (brand names, not translated). */
export const COMPUTER_PROVIDER_DISPLAY_NAMES: Readonly<Record<ComputerProviderIdV1, string>> = Object.freeze({
    cua: 'Cua',
    'agent-desktop': 'Agent Desktop',
});

/** Presentation only: the daemon resolver owns provider admission. */
export function projectComputerProviderRows(preferences: ComputerUseSettingsV1 | null,
    state: MachineCapabilitiesCacheState): readonly ComputerProviderSettingsRow[] {
    const entries = getInstallablesRegistryEntries();
    const results = 'snapshot' in state ? state.snapshot?.response.results : undefined;
    return (Object.keys(COMPUTER_PROVIDER_INSTALLABLE_KEYS) as ComputerProviderIdV1[]).map(provider => {
        const entry = entries.find(candidate => candidate.key === COMPUTER_PROVIDER_INSTALLABLE_KEYS[provider]);
        const detection = entry?.getDetectResult(results);
        const status = entry?.getStatus(results);
        const availability: ComputerProviderSettingsRow['availability'] = status
            ? status.runtimeState === 'unavailable' ? 'unavailable'
                : status.runtimeState === 'downloading' ? 'installing' : status.installed ? 'ready' : 'not_installed'
            : state.status === 'idle' ? 'unknown'
                : state.status === 'loading' && !detection ? 'loading' : 'unavailable';
        return { provider, enabled: preferences?.enabledProviders.includes(provider) ?? false,
            isDefault: preferences?.defaultProvider === provider, availability,
            ...(detection && !detection.ok ? { error: detection.error } : {}) };
    });
}

export type ComputerProviderSettingsExecute = (
    actionId: 'machines.capabilities.install' | 'settings.set', input: unknown,
) => Promise<ActionExecuteResult>;

export async function installComputerProvider(args: Readonly<{
    execute: ComputerProviderSettingsExecute; machineId: string; serverId: string; provider: ComputerProviderIdV1;
}>): Promise<ActionExecuteResult> {
    const installation = await args.execute('machines.capabilities.install', {
        machineId: args.machineId, serverId: args.serverId, method: 'install',
        capabilityId: BUILT_IN_INSTALLABLES_REGISTRY.descriptorsByKey[COMPUTER_PROVIDER_INSTALLABLE_KEYS[args.provider]].descriptor.capabilityId,
    });
    if (!installation.ok) return installation;
    const parsed = MachineCapabilityInstallOutputSchema.safeParse(installation.result);
    if (!parsed.success) return { ok: false, errorCode: 'invalid_action_output', error: 'The computer provider installation returned an invalid result' };
    if (!parsed.data.supported) return { ok: false, errorCode: parsed.data.reason === 'not-supported' ? 'install_not_supported' : 'install_failed',
        error: 'The computer provider could not be installed', details: parsed.data };
    if (!parsed.data.response.ok) return { ok: false, errorCode: parsed.data.response.error.code ?? 'install_failed',
        error: parsed.data.response.error.message, details: parsed.data.response };
    return installation;
}

/** The mounted Action owner supplies Account lifetime, approval and persistence. */
export async function changeComputerUseSettings(args: Readonly<{
    execute: ComputerProviderSettingsExecute;
    machineId: string;
    serverId: string;
    current: ComputerUseSettingsV1;
    next: ComputerUseSettingsV1;
    onPhase?: (phase: Readonly<{ phase: 'installing'; provider: ComputerProviderIdV1 }> | Readonly<{ phase: 'saving' }>) => void;
}>): Promise<ActionExecuteResult> {
    const next = ComputerUseSettingsV1Schema.safeParse(args.next);
    if (!next.success) return { ok: false, errorCode: 'invalid_setting_value', error: 'The default computer-use provider must remain enabled' };
    for (const provider of Object.keys(COMPUTER_PROVIDER_INSTALLABLE_KEYS) as ComputerProviderIdV1[]) {
        if (!next.data.enabledProviders.includes(provider) || args.current.enabledProviders.includes(provider)) continue;
        args.onPhase?.({ phase: 'installing', provider });
        const installation = await installComputerProvider({ ...args, provider });
        if (!installation.ok) return installation;
    }
    args.onPhase?.({ phase: 'saving' });
    return args.execute('settings.set', {
        anchor: 'machines.computerUse.providers', key: args.machineId, value: next.data,
    });
}
