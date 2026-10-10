import { resolveExactServerScopedMachine } from '@/sync/domains/machines/resolveServerScopedMachines';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { storage } from '@/sync/domains/state/storage';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { isMachineOnline } from '@/utils/sessions/machineUtils';

import type { WorkspaceScopeBase } from './workspaceScope';

type WorkspaceMachineInventoryState = Readonly<{
    isDataReady?: boolean;
    machines?: Record<string, Machine | undefined>;
    machineListByServerId?: Record<string, Machine[] | null | undefined>;
    machineListStatusByServerId?: Readonly<Record<string, 'idle' | 'loading' | 'signedOut' | 'error' | undefined>>;
}>;

/**
 * Resolves workspace reachability through the shared server-scoped machine
 * inventory and canonical machine-liveness policy. Machine ids are not global,
 * so a same-id machine on another Home can never make this scope reachable.
 */
export function isWorkspaceScopeReachableFromState(
    state: WorkspaceMachineInventoryState,
    scope: WorkspaceScopeBase,
    activeServerId: string,
): boolean {
    const machine = resolveExactServerScopedMachine<Machine>({
        machineId: scope.machineId,
        serverId: scope.serverId,
        activeServerId,
        activeMachines: state.isDataReady
            ? Object.values(state.machines ?? {}).filter((candidate): candidate is Machine => candidate !== undefined)
            : [],
        machineListByServerId: state.machineListByServerId ?? {},
        machineListStatusByServerId: state.machineListStatusByServerId,
    });
    return machine ? isMachineOnline(machine) : false;
}

export function isWorkspaceScopeReachable(scope: WorkspaceScopeBase): boolean {
    return isWorkspaceScopeReachableFromState(
        storage.getState(),
        scope,
        String(getActiveServerSnapshot().serverId ?? '').trim(),
    );
}
