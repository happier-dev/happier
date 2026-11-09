import type { Machine } from '@/sync/domains/state/storageTypes';
import type { resolveServerScopedMachine } from '@/sync/domains/machines/resolveServerScopedMachine';
import { resolveExactServerScopedMachine } from '@/sync/domains/machines/resolveServerScopedMachines';
import { getAppliedActiveServerId } from '@/sync/runtime/orchestration/connectionManager';

type PeerEndpointState = Parameters<typeof resolveServerScopedMachine>[0];

export function readPeerEndpointForServerScope<TEndpoint>(params: Readonly<{
    state: PeerEndpointState;
    serverId: string;
    machineId: string;
    select: (machine: Machine) => TEndpoint | null | undefined;
}>): TEndpoint | null {
    const machineId = String(params.machineId ?? '').trim();
    const serverId = String(params.serverId ?? '').trim();
    const activeServerId = String(getAppliedActiveServerId() ?? '').trim();
    if (!machineId || !serverId) return null;

    let activeMachines: Machine[] | undefined;
    const machine = resolveExactServerScopedMachine({
        serverId, machineId, activeServerId,
        get activeMachines() {
            return activeMachines ??= Object.values(params.state.machines).filter((machine): machine is Machine => Boolean(machine));
        },
        activeMachineRecords: params.state.machines,
        machineListByServerId: params.state.machineListByServerId ?? {},
        machineRecordsByServerId: params.state.machineRecordsByServerId,
        machineListStatusByServerId: params.state.machineListStatusByServerId,
    });
    return machine ? params.select(machine) ?? null : null;
}
