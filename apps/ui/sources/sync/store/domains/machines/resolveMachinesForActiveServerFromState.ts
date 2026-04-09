import type { Machine } from '@/sync/domains/state/storageTypes';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { normalizeNonEmptyString } from '@/utils/strings/normalizeNonEmptyString';

export function resolveMachineForActiveServerFromState(state: any, machineId: string): Machine | null {
    const normalizedMachineId = normalizeNonEmptyString(machineId);
    if (!normalizedMachineId) return null;

    const activeServerId = String(getActiveServerSnapshot().serverId ?? '').trim();
    const activeServerMachines = activeServerId ? state?.machineListByServerId?.[activeServerId] : null;
    if (Array.isArray(activeServerMachines)) {
        const activeServerMachine = activeServerMachines.find(
            (machine): machine is Machine =>
                Boolean(
                    machine
                    && typeof machine === 'object'
                    && normalizeNonEmptyString(machine.id) === normalizedMachineId
                    && isVisibleMachine(machine),
                ),
        );
        if (activeServerMachine) return activeServerMachine;
    }

    const machine = state?.machines?.[normalizedMachineId] ?? null;
    return machine && typeof machine === 'object' && typeof machine.id === 'string' && isVisibleMachine(machine) ? machine : null;
}

function isVisibleMachine(machine: Machine): boolean {
    const revokedAt = machine.revokedAt;
    return !(typeof revokedAt === 'number' && Number.isFinite(revokedAt) && revokedAt > 0);
}

function sortVisibleMachines(a: Machine, b: Machine): number {
    if (a.active !== b.active) return a.active ? -1 : 1;
    if (b.createdAt !== a.createdAt) return b.createdAt - a.createdAt;
    return a.id.localeCompare(b.id);
}

export function resolveVisibleMachinesForActiveServerFromState(state: any): Machine[] {
    const activeServerId = String(getActiveServerSnapshot().serverId ?? '').trim();
    const activeServerMachines = activeServerId ? state?.machineListByServerId?.[activeServerId] : null;
    const sourceMachines = Array.isArray(activeServerMachines) && activeServerMachines.length > 0
        ? activeServerMachines
        : Object.values(state?.machines ?? {});

    return sourceMachines
        .filter((machine): machine is Machine => Boolean(machine && typeof machine === 'object' && typeof machine.id === 'string'))
        .filter(isVisibleMachine)
        .sort(sortVisibleMachines);
}
