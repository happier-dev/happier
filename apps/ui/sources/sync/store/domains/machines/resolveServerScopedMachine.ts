import type { Machine } from '@/sync/domains/state/storageTypes';

type ServerScopedMachineState = Readonly<{
    machines: Readonly<Record<string, Machine | undefined>>;
    machineListByServerId?: Readonly<Record<string, readonly Machine[] | null | undefined>>;
    machineListStatusByServerId?: Readonly<Record<string, 'idle' | 'loading' | 'signedOut' | 'error' | undefined>>;
}>;

export function resolveServerScopedMachine(
    state: ServerScopedMachineState,
    serverId: string | null | undefined,
    machineId: string,
): Machine | null {
    const normalizedMachineId = typeof machineId === 'string' ? machineId.trim() : '';
    if (!normalizedMachineId) return null;

    const normalizedServerId = typeof serverId === 'string' ? serverId.trim() : '';
    if (normalizedServerId.length > 0) {
        const scopedMachines = state.machineListByServerId?.[normalizedServerId];
        if (Array.isArray(scopedMachines)) {
            const scopedMachine = scopedMachines.find(
                (candidate) => candidate.id === normalizedMachineId,
            ) ?? null;
            if (scopedMachine) return scopedMachine;
            if (state.machineListStatusByServerId?.[normalizedServerId] === 'idle') {
                return null;
            }
        }
    }

    return state.machines[normalizedMachineId] ?? null;
}
