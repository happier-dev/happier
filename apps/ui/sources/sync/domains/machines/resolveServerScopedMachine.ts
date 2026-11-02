import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { resolveExactServerScopedMachine } from '@/sync/domains/machines/resolveServerScopedMachines';
import type { Machine } from '@/sync/domains/state/storageTypes';

type ServerScopedMachineState = Readonly<{
    machines: Readonly<Record<string, Machine | undefined>>;
    machineListByServerId?: Readonly<Record<string, readonly Machine[] | null | undefined>>;
    machineRecordsByServerId?: Readonly<Record<string, Readonly<Record<string, Machine | undefined>> | undefined>>;
    machineListStatusByServerId?: Readonly<Record<string, 'idle' | 'loading' | 'signedOut' | 'error' | undefined>>;
}>;

export function resolveServerScopedMachine(
    state: ServerScopedMachineState,
    serverId: string | null | undefined,
    machineId: string,
): Machine | null {
    const normalizedMachineId = typeof machineId === 'string' ? machineId.trim() : '';
    if (!normalizedMachineId) return null;

    const activeServerId = getActiveServerSnapshot().serverId;
    const normalizedServerId = (typeof serverId === 'string' ? serverId.trim() : '') || activeServerId;
    if (normalizedServerId.length > 0) {
        let activeMachines: Machine[] | undefined;
        return resolveExactServerScopedMachine({
            serverId: normalizedServerId,
            machineId: normalizedMachineId,
            activeServerId,
            // Settled scoped inventories are authoritative. Only project the active map if
            // the canonical inventory resolver actually needs its loading-state fallback.
            get activeMachines() {
                return activeMachines ??= Object.values(state.machines).filter((machine): machine is Machine => Boolean(machine));
            },
            machineListByServerId: state.machineListByServerId ?? {},
            machineRecordsByServerId: state.machineRecordsByServerId,
            activeMachineRecords: state.machines,
            machineListStatusByServerId: state.machineListStatusByServerId,
        });
    }

    return state.machines[normalizedMachineId] ?? null;
}
