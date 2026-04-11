import type { Machine } from '@/sync/domains/state/storageTypes';

type MachineLike = Readonly<{
    revokedAt?: number | null;
}>;

export function resolveServerScopedMachines<T extends MachineLike>(params: Readonly<{
    serverId: string;
    activeServerId: string;
    activeMachines: ReadonlyArray<T>;
    machineListByServerId: Readonly<Record<string, ReadonlyArray<T> | null | undefined>>;
}>): ReadonlyArray<T> | null {
    const hasScopedMachines = Object.prototype.hasOwnProperty.call(params.machineListByServerId, params.serverId);
    const scopedMachines = hasScopedMachines ? params.machineListByServerId[params.serverId] : undefined;

    if (Array.isArray(scopedMachines) && scopedMachines.length > 0) {
        return scopedMachines;
    }

    if (params.serverId === params.activeServerId && params.activeMachines.length > 0) {
        return params.activeMachines;
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
