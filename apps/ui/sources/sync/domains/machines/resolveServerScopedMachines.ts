import type { Machine } from '@/sync/domains/state/storageTypes';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';

type MachineLike = Readonly<{
    revokedAt?: number | null;
}>;

export function resolveServerScopedMachines<T extends MachineLike>(params: Readonly<{
    serverId: string;
    activeServerId: string;
    serverIdAliases?: readonly string[];
    activeMachines: ReadonlyArray<T>;
    machineListByServerId: Readonly<Record<string, ReadonlyArray<T> | null | undefined>>;
}>): ReadonlyArray<T> | null {
    const activeServerId = String(params.activeServerId ?? '').trim();
    const serverIds = [params.serverId, ...(params.serverIdAliases ?? [])]
        .map((serverId) => String(serverId ?? '').trim())
        .filter((serverId, index, ids) => serverId.length > 0 && ids.indexOf(serverId) === index);
    const targetsActiveServer = activeServerId.length > 0
        && serverIds.some((serverId) => areServerProfileIdentifiersEquivalent(serverId, activeServerId));
    if (targetsActiveServer && params.activeMachines.length > 0) {
        return params.activeMachines;
    }

    const scopedEntries = serverIds
        .filter((serverId) => Object.prototype.hasOwnProperty.call(params.machineListByServerId, serverId))
        .map((serverId) => params.machineListByServerId[serverId]);
    const scopedMachines = scopedEntries.find((machines) => Array.isArray(machines) && machines.length > 0)
        ?? scopedEntries[0];

    if (Array.isArray(scopedMachines) && scopedMachines.length > 0) {
        return scopedMachines;
    }

    if (Array.isArray(scopedMachines)) {
        return scopedMachines;
    }

    return null;
}

export function filterVisibleMachines<T extends MachineLike>(machines: ReadonlyArray<T>): T[] {
    return machines.filter((machine) => {
        const revokedAt = machine.revokedAt;
        return !(typeof revokedAt === 'number' && Number.isFinite(revokedAt) && revokedAt > 0);
    });
}
