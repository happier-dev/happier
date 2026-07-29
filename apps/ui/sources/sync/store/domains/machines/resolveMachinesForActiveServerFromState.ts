import type { Machine } from '@/sync/domains/state/storageTypes';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { normalizeNonEmptyString } from '@/utils/strings/normalizeNonEmptyString';

function resolveActiveServerMachineSource(state: any): readonly Machine[] | null {
    const activeServerId = String(getActiveServerSnapshot().serverId ?? '').trim();
    if (!activeServerId) {
        const globalMachines = Object.values(state?.machines ?? {});
        return globalMachines as Machine[];
    }

    const machineListByServerId = state?.machineListByServerId;
    const hasActiveServerMachineList = Boolean(
        machineListByServerId
        && typeof machineListByServerId === 'object'
        && Object.prototype.hasOwnProperty.call(machineListByServerId, activeServerId),
    );
    const activeServerMachines = hasActiveServerMachineList ? machineListByServerId[activeServerId] : undefined;
    if (Array.isArray(activeServerMachines) && activeServerMachines.length > 0) return activeServerMachines;

    if (machineListByServerId && typeof machineListByServerId === 'object') {
        const equivalentEntry = Object.entries(machineListByServerId).find(([serverId, machines]) => (
            areServerProfileIdentifiersEquivalent(serverId, activeServerId)
            && Array.isArray(machines)
            && machines.length > 0
        ));
        if (equivalentEntry) {
            const [, equivalentMachines] = equivalentEntry;
            return Array.isArray(equivalentMachines) ? equivalentMachines : [];
        }
    }

    if (hasActiveServerMachineList) {
        return Array.isArray(activeServerMachines) ? activeServerMachines : [];
    }

    const globalMachines = Object.values(state?.machines ?? {});
    return globalMachines as Machine[];
}

export function resolveMachineForActiveServerFromState(state: any, machineId: string): Machine | null {
    const normalizedMachineId = normalizeNonEmptyString(machineId);
    if (!normalizedMachineId) return null;

    const activeServerMachines = resolveActiveServerMachineSource(state);
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
        return activeServerMachine ?? null;
    }

    return null;
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
    const activeServerMachines = resolveActiveServerMachineSource(state);
    const sourceMachines = Array.isArray(activeServerMachines) ? activeServerMachines : [];

    return sourceMachines
        .filter((machine): machine is Machine => Boolean(machine && typeof machine === 'object' && typeof machine.id === 'string'))
        .filter(isVisibleMachine)
        .sort(sortVisibleMachines);
}
