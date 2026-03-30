import * as React from 'react';

import { useRelayDriftBanner } from '@/components/settings/server/useRelayDriftBanner';
import { useActiveSelectionMachineGroups } from '@/components/settings/server/hooks/useActiveSelectionMachineGroups';
import { getActiveServerSnapshot, listServerProfiles } from '@/sync/domains/server/serverProfiles';
import {
    useAllMachines,
    useMachineListByServerId,
    useMachineListStatusByServerId,
    useSetting,
} from '@/sync/domains/state/storage';

export function useMachinesSettingsViewModel() {
    const relayDriftBanner = useRelayDriftBanner();
    const allMachines = useAllMachines();
    const machineListByServerId = useMachineListByServerId();
    const machineListStatusByServerId = useMachineListStatusByServerId();
    const serverSelectionGroups = useSetting('serverSelectionGroups');
    const serverSelectionActiveTargetKind = useSetting('serverSelectionActiveTargetKind');
    const serverSelectionActiveTargetId = useSetting('serverSelectionActiveTargetId');

    const activeServerSnapshot = getActiveServerSnapshot();
    const serverProfiles = React.useMemo(() => {
        try {
            return listServerProfiles().slice();
        } catch {
            return [];
        }
    }, [activeServerSnapshot.generation]);

    const activeSelectionMachineGroups = useActiveSelectionMachineGroups({
        activeServerSnapshot,
        allMachines,
        serverProfiles,
        machineListByServerId,
        machineListStatusByServerId,
        settings: {
            serverSelectionGroups,
            serverSelectionActiveTargetKind,
            serverSelectionActiveTargetId,
        },
    });

    const isLoadingMachines = React.useMemo(() => {
        const status = machineListStatusByServerId[activeServerSnapshot.serverId] ?? 'loading';
        return allMachines.length === 0 && status === 'loading';
    }, [activeServerSnapshot.serverId, allMachines.length, machineListStatusByServerId]);

    const machineRows = React.useMemo(() => {
        return activeSelectionMachineGroups.visibleMachineGroups.flatMap((group) =>
            group.machines.map((machine) => ({
                id: machine.id,
                title: machine.metadata?.displayName || machine.metadata?.host || machine.id,
                subtitle: machine.metadata?.host,
                serverId: group.serverId,
            })),
        );
    }, [activeSelectionMachineGroups.visibleMachineGroups]);

    return {
        activeServerId: activeServerSnapshot.serverId,
        allMachines,
        hasMachines: activeSelectionMachineGroups.hasAnyVisibleMachines,
        isLoadingMachines,
        machineRows,
        relayDriftBanner,
        showMachinesGroupedByServer: activeSelectionMachineGroups.showMachinesGroupedByServer,
        visibleMachineGroups: activeSelectionMachineGroups.visibleMachineGroups,
    };
}
