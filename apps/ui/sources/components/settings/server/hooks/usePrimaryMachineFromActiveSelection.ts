import * as React from 'react';

import { getActiveServerSnapshot, listServerProfiles } from '@/sync/domains/server/serverProfiles';
import { getEffectiveServerSelectionFromRawSettings } from '@/sync/domains/server/selection/serverSelectionResolution';
import { useAllMachines, useMachineListByServerId, useMachineListStatusByServerId, useSetting } from '@/sync/domains/state/storage';

/**
 * Returns the ID of the primary machine from the active server selection.
 * 
 * This hook respects the user's active server selection (single server or multi-server group)
 * and returns the first non-revoked machine from the first visible server.
 * 
 * Use this instead of `useAllMachines()[0]` in settings screens to ensure machine-backed
 * operations target the correct machine relative to the user's active server selection.
 * 
 * @returns The machine ID of the primary machine, or null if no machines are available
 */
export function usePrimaryMachineFromActiveSelection(): string | null {
    const allMachines = useAllMachines();
    const machineListByServerId = useMachineListByServerId();
    const machineListStatusByServerId = useMachineListStatusByServerId();
    const settingsServerSelectionGroups = useSetting('serverSelectionGroups');
    const settingsServerSelectionActiveTargetKind = useSetting('serverSelectionActiveTargetKind');
    const settingsServerSelectionActiveTargetId = useSetting('serverSelectionActiveTargetId');

    const activeServerSnapshot = React.useMemo(() => {
        try {
            return getActiveServerSnapshot();
        } catch {
            return { serverId: '', serverUrl: '', generation: 0 };
        }
    }, []);

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
            availableServerIds: serverProfiles.map((server) => server.id),
            settings: {
                serverSelectionGroups: settingsServerSelectionGroups,
                serverSelectionActiveTargetKind: settingsServerSelectionActiveTargetKind,
                serverSelectionActiveTargetId: settingsServerSelectionActiveTargetId,
            },
        });

        const visibleServerIds = selection.serverIds.length > 0
            ? selection.serverIds
            : (activeServerSnapshot.serverId ? [activeServerSnapshot.serverId] : []);

        // Get machines from the first visible server
        for (const serverId of visibleServerIds) {
            const machines =
                machineListByServerId[serverId]
                ?? (serverId === activeServerSnapshot.serverId ? allMachines : null)
                ?? [];

            // Find the first non-revoked machine
            const visibleMachines = machines.filter((machine) => !machine.revokedAt);
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

