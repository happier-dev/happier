import * as React from 'react';

import type { ActiveServerSnapshot, ServerProfile } from '@/sync/domains/server/serverProfiles';
import { filterVisibleMachines, resolveServerScopedMachines } from '@/sync/domains/machines/resolveServerScopedMachines';
import { getEffectiveServerSelectionFromRawSettings } from '@/sync/domains/server/selection/serverSelectionResolution';
import type { Machine } from '@/sync/domains/state/storageTypes';

type MachineListStatus = 'idle' | 'loading' | 'signedOut' | 'error';

export type ActiveSelectionMachineGroup = Readonly<{
    serverId: string;
    serverName: string;
    machines: ReadonlyArray<Machine>;
    status: MachineListStatus;
}>;

export function useActiveSelectionMachineGroups(params: Readonly<{
    activeServerSnapshot: ActiveServerSnapshot;
    allMachines: ReadonlyArray<Machine>;
    serverProfiles: ReadonlyArray<ServerProfile>;
    machineListByServerId: Readonly<Record<string, Machine[] | null>>;
    machineListStatusByServerId: Readonly<Record<string, MachineListStatus>>;
    settings: Readonly<{
        serverSelectionGroups: unknown;
        serverSelectionActiveTargetKind: unknown;
        serverSelectionActiveTargetId: unknown;
    }>;
}>): Readonly<{
    showMachinesGroupedByServer: boolean;
    hasAnyVisibleMachines: boolean;
    visibleMachineGroups: ReadonlyArray<ActiveSelectionMachineGroup>;
}> {
    const visibleMachineServerIds = React.useMemo(() => {
        const selection = getEffectiveServerSelectionFromRawSettings({
            activeServerId: params.activeServerSnapshot.serverId,
            availableServerIds: params.serverProfiles.map((server) => server.id),
            settings: params.settings,
        });

        return selection.serverIds.length > 0
            ? selection.serverIds
            : (params.activeServerSnapshot.serverId ? [params.activeServerSnapshot.serverId] : []);
    }, [
        params.activeServerSnapshot.serverId,
        params.serverProfiles,
        params.settings.serverSelectionActiveTargetId,
        params.settings.serverSelectionActiveTargetKind,
        params.settings.serverSelectionGroups,
    ]);

    const showMachinesGroupedByServer = visibleMachineServerIds.length > 1;

    const visibleMachineGroups = React.useMemo(() => {
        const serverNameById = new Map(params.serverProfiles.map((server) => [server.id, server.name] as const));
        return visibleMachineServerIds.map((serverId) => {
            const machines = resolveServerScopedMachines({
                serverId,
                activeServerId: params.activeServerSnapshot.serverId,
                activeMachines: params.allMachines,
                machineListByServerId: params.machineListByServerId,
            }) ?? [];
            const status = params.machineListStatusByServerId[serverId] ?? 'idle';
            const visibleMachines = filterVisibleMachines(machines);
            return {
                serverId,
                serverName: serverNameById.get(serverId) ?? serverId,
                machines: visibleMachines,
                status,
            };
        });
    }, [
        params.activeServerSnapshot.serverId,
        params.allMachines,
        params.machineListByServerId,
        params.machineListStatusByServerId,
        params.serverProfiles,
        visibleMachineServerIds,
    ]);

    const hasAnyVisibleMachines = visibleMachineGroups.some((group) => group.machines.length > 0);

    return {
        showMachinesGroupedByServer,
        hasAnyVisibleMachines,
        visibleMachineGroups,
    };
}
