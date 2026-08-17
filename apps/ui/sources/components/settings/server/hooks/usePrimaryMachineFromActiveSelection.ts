import * as React from 'react';

import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { filterVisibleMachines, resolveServerScopedMachines } from '@/sync/domains/machines/resolveServerScopedMachines';
import { listServerProfiles } from '@/sync/domains/server/serverProfiles';
import { getEffectiveServerSelectionFromRawSettings } from '@/sync/domains/server/selection/serverSelectionResolution';
import {
    listServerProfileScopeIds,
    normalizeServerSelectionSettingsForProfileScopeIds,
} from '@/sync/domains/server/selection/serverSelectionProfileScopeIds';
import { useAllMachines, useMachineListByServerId, useSetting } from '@/sync/domains/state/storage';

/**
 * Returns an order-based display/default machine from the active server selection.
 *
 * @deprecated This is a legacy presentation convenience, not an execution-target
 * owner. It must not authorize daemon mutations or Machine Administration actions;
 * those use the exact, fresh Administration target selection instead.
 *
 * @returns The first visible machine ID, or null when no machines are available.
 */
export function usePrimaryMachineFromActiveSelection(): string | null {
    const allMachines = useAllMachines();
    const machineListByServerId = useMachineListByServerId();
    const settingsServerSelectionGroups = useSetting('serverSelectionGroups');
    const settingsServerSelectionActiveTargetKind = useSetting('serverSelectionActiveTargetKind');
    const settingsServerSelectionActiveTargetId = useSetting('serverSelectionActiveTargetId');
    const activeServerSnapshot = useActiveServerSnapshot();

    const serverProfiles = React.useMemo(() => {
        try {
            return listServerProfiles().slice();
        } catch {
            return [];
        }
    }, [activeServerSnapshot.generation]);

    return React.useMemo(() => {
        // Determine which servers are visible based on active selection
        const selection = getEffectiveServerSelectionFromRawSettings({
            activeServerId: activeServerSnapshot.serverId,
            availableServerIds: listServerProfileScopeIds(serverProfiles),
            settings: normalizeServerSelectionSettingsForProfileScopeIds({
                serverSelectionGroups: settingsServerSelectionGroups,
                serverSelectionActiveTargetKind: settingsServerSelectionActiveTargetKind,
                serverSelectionActiveTargetId: settingsServerSelectionActiveTargetId,
            }, serverProfiles),
        });

        const visibleServerIds = selection.serverIds.length > 0
            ? selection.serverIds
            : (activeServerSnapshot.serverId ? [activeServerSnapshot.serverId] : []);

        // Get machines from the first visible server
        for (const serverId of visibleServerIds) {
            const machines = resolveServerScopedMachines({
                serverId,
                activeServerId: activeServerSnapshot.serverId,
                activeMachines: allMachines,
                machineListByServerId,
            }) ?? [];

            // Find the first non-revoked machine
            const visibleMachines = filterVisibleMachines(machines);
            if (visibleMachines.length > 0) {
                return visibleMachines[0].id;
            }
        }

        return null;
    }, [
        activeServerSnapshot.serverId,
        allMachines,
        machineListByServerId,
        serverProfiles,
        settingsServerSelectionActiveTargetId,
        settingsServerSelectionActiveTargetKind,
        settingsServerSelectionGroups,
    ]);
}
