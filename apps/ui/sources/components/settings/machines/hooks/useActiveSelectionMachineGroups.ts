import { selectVisibleMachineInventory } from '@/sync/domains/machines/identity/filterVisibleMachines';
import * as React from 'react';

import type { ActiveServerSnapshot, ServerProfile } from '@/sync/domains/server/serverProfiles';
import { resolveServerProfileScopeId, resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { resolveServerScopedMachineInventory } from '@/sync/domains/machines/resolveServerScopedMachines';
import { getEffectiveServerSelectionFromRawSettings } from '@/sync/domains/server/selection/serverSelectionResolution';
import {
    listServerProfileScopeIds,
    normalizeServerSelectionSettingsForProfileScopeIds,
} from '@/sync/domains/server/selection/serverSelectionProfileScopeIds';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { resolveHomeDisplayLabel } from '@/components/settings/server/homeDisplayName';
import type { MachineReachabilityScope } from '@/sync/domains/machines/reachability/machineReachability';
import { useServerCredentialAccountScopeBindings } from '@/sync/domains/scope/useServerCredentialAccountScopes';

const EMPTY_MACHINES: readonly Machine[] = [];

type MachineListStatus = 'idle' | 'loading' | 'signedOut' | 'error';

export type ActiveSelectionMachineGroup = Readonly<{
    serverId: string;
    accountScope?: MachineReachabilityScope | null;
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
            availableServerIds: listServerProfileScopeIds(params.serverProfiles),
            settings: normalizeServerSelectionSettingsForProfileScopeIds(params.settings, params.serverProfiles),
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
    const bindings = useServerCredentialAccountScopeBindings(visibleMachineServerIds);

    const visibleMachineGroups = React.useMemo(() => {
        const serverNameById = new Map<string, string>();
        for (const server of params.serverProfiles) {
            // Every group uses the Home label owner, including unnamed Homes.
            const label = resolveHomeDisplayLabel(server, server.id, params.activeServerSnapshot.serverId);
            serverNameById.set(server.id, label);
            serverNameById.set(resolveServerProfileScopeId(server), label);
        }
        return visibleMachineServerIds.map((serverId) => {
            const binding = bindings.get(resolveServerProfileScopeIdForIdentifier(serverId));
            const inventory = resolveServerScopedMachineInventory({
                serverId,
                activeServerId: params.activeServerSnapshot.serverId,
                activeMachines: params.allMachines,
                machineListByServerId: params.machineListByServerId,
                machineListStatusByServerId: params.machineListStatusByServerId,
            });
            const status = inventory.status ?? 'loading';
            const visibleMachines = selectVisibleMachineInventory(inventory.machines ?? EMPTY_MACHINES);
            return {
                serverId,
                accountScope: binding?.isCurrent() ? binding.scope : null,
                serverName: serverNameById.get(serverId) ?? resolveHomeDisplayLabel(null, serverId, params.activeServerSnapshot.serverId),
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
        bindings,
    ]);

    const hasAnyVisibleMachines = visibleMachineGroups.some((group) => group.machines.length > 0);

    return {
        showMachinesGroupedByServer,
        hasAnyVisibleMachines,
        visibleMachineGroups,
    };
}
