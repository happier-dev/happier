import { PluginError } from '@happier-dev/plugin-sdk';
import type { MachineNativeEffectKey } from '@/daemon/local/services/launch/machineNativeEffectAdmission';
import type { ProjectManagedServiceHandle } from './managedServicesOwner';

export type SetupScriptServiceEffectsInput = Readonly<{
    serverId: string;
    machineId: string;
    serviceIds: readonly string[];
    signal?: AbortSignal;
}>;

/** Resolves reviewed service ids only against the incumbent native custody. */
export async function resolveSetupScriptServiceEffects(
    input: SetupScriptServiceEffectsInput,
    services: readonly ProjectManagedServiceHandle[],
    isOwnerCurrent: () => boolean,
): Promise<readonly MachineNativeEffectKey[]> {
    const unavailable = (): never => {
        throw new PluginError({ code: 'plugin_managed_service_unavailable',
            message: 'Current attributed service native effects are unavailable' });
    };
    input.signal?.throwIfAborted();
    if (!isOwnerCurrent()) return unavailable();
    const requested = new Set(input.serviceIds);
    const matches = new Map<string, ProjectManagedServiceHandle>();
    for (const handle of services) {
        if (handle.kind !== 'environment' || handle.serverId !== input.serverId
            || handle.machineId !== input.machineId || !requested.has(handle.serviceId)) continue;
        if (matches.has(handle.serviceId)) return unavailable();
        matches.set(handle.serviceId, handle);
    }
    const selected = [...requested].map(serviceId => {
        const handle = matches.get(serviceId);
        if (!handle) return unavailable();
        const read = handle.readNativeEffectKeys;
        if (!read) return unavailable();
        return { handle, read };
    });
    const assertCurrent = (): void => {
        input.signal?.throwIfAborted();
        if (!isOwnerCurrent() || selected.some(({ handle }) => !handle.isCurrent())) unavailable();
    };
    assertCurrent();
    const keys: MachineNativeEffectKey[] = [];
    for (const { read } of selected) {
        const captured = await read({ signal: input.signal });
        assertCurrent();
        if (!captured.length) return unavailable();
        keys.push(...captured);
    }
    assertCurrent();
    return Object.freeze(keys);
}
