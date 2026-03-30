import type { Machine } from '@/sync/domains/state/storageTypes';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';

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

export function resolveMachineForActiveServerFromState(state: any, machineIdRaw: unknown): Machine | null {
    const machineId = typeof machineIdRaw === 'string' ? machineIdRaw.trim() : '';
    if (!machineId) return null;
    const directMachine = state?.machines?.[machineId];
    if (directMachine && typeof directMachine === 'object' && typeof directMachine.id === 'string') {
        return directMachine as Machine;
    }
    return resolveVisibleMachinesForActiveServerFromState(state).find((machine) => machine.id === machineId) ?? null;
}
