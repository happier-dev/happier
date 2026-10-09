import type { Machine } from '@/sync/domains/state/storageTypes';
import { isMachineVisibleForSelection } from '@/sync/domains/machines/identity/filterVisibleMachines';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { resolveServerScopedMachines } from '@/sync/domains/machines/resolveServerScopedMachines';
import { normalizeNonEmptyString } from '@/utils/strings/normalizeNonEmptyString';

type MachineServerScope = Readonly<{ serverId?: string | null }>;

type MachineInventoryState = Readonly<{
    machines?: Readonly<Record<string, Machine | undefined>>;
    machineListByServerId?: Readonly<Record<string, readonly Machine[] | null | undefined>>;
    machineListStatusByServerId?: Readonly<Record<string, 'idle' | 'loading' | 'signedOut' | 'error' | undefined>>;
}>;

function resolveActiveServerMachineSource(state: MachineInventoryState, scope?: MachineServerScope): readonly Machine[] | null {
    const activeServerId = String(getActiveServerSnapshot().serverId ?? '').trim();
    const serverId = String(scope?.serverId ?? activeServerId).trim();
    const activeMachines = Object.values(state.machines ?? {}).filter((machine): machine is Machine => Boolean(machine));
    if (!serverId) return activeMachines;

    return resolveServerScopedMachines({
        serverId,
        activeServerId,
        activeMachines,
        machineListByServerId: state.machineListByServerId ?? {},
        machineListStatusByServerId: state.machineListStatusByServerId,
    });
}

export function resolveMachineForActiveServerFromState(state: MachineInventoryState, machineId: string, scope?: MachineServerScope): Machine | null {
    const normalizedMachineId = normalizeNonEmptyString(machineId);
    if (!normalizedMachineId) return null;

    const activeServerMachines = resolveActiveServerMachineSource(state, scope);
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

export function resolveVisibleMachinesForActiveServerFromState(state: MachineInventoryState, scope?: MachineServerScope): Machine[] {
    const activeServerMachines = resolveActiveServerMachineSource(state, scope);
    const sourceMachines = Array.isArray(activeServerMachines) ? activeServerMachines : [];

    return sourceMachines
        .filter((machine): machine is Machine => Boolean(machine && typeof machine === 'object' && typeof machine.id === 'string'))
        .filter(isMachineVisibleForSelection)
        .sort(sortVisibleMachines);
}
