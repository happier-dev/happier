import * as React from 'react';

import { useActiveSelectionMachineGroups } from '@/components/settings/machines/hooks/useActiveSelectionMachineGroups';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { listServerProfiles } from '@/sync/domains/server/serverProfiles';
import {
    useActiveMachineFacts,
    useMachineListByServerId,
    useMachineListStatusByServerId,
} from '@/sync/domains/state/storage';
import { useHomeViewSelectionSettings } from '@/hooks/server/useHomeViewSelectionSettings';
import { getMachineDisplayName } from '@/utils/sessions/machineDisplayNames';
import { useManagedMachineInventory } from './managed/useManagedMachineInventory';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';

export type MachinesSettingsViewModel = {
    activeServerId: string;
    allMachines: ReturnType<typeof useActiveMachineFacts>;
    hasMachines: boolean;
    isLoadingMachines: boolean;
    managedFirstAnswerPending: boolean;
    machineRows: { id: string; title: string; subtitle: string | undefined; serverId: string }[];
    showMachinesGroupedByServer: boolean;
    visibleMachineGroups: ReturnType<typeof useActiveSelectionMachineGroups>['visibleMachineGroups'];
    managedByServerId: ReturnType<typeof useManagedMachineInventory>['machinesByServerId'];
    managedInventory: ReturnType<typeof useManagedMachineInventory>;
    visibleServerIds: readonly string[];
};

export function useMachinesSettingsGroups() {
    const presented = useLayoutPresentationActive();
    // Machine facts only: live resources are read per machine by their own owners (row summaries, attention,
    // the index's host facts), so a resource publication does not rebuild every Machines surface.
    const allMachines = useActiveMachineFacts(true, presented);
    const machineListByServerId = useMachineListByServerId(presented);
    const machineListStatusByServerId = useMachineListStatusByServerId(presented);
    const {
        serverSelectionGroups,
        serverSelectionActiveTargetKind,
        serverSelectionActiveTargetId,
    } = useHomeViewSelectionSettings();

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

    return {
        ...activeSelectionMachineGroups,
        activeServerId: activeServerSnapshot.serverId,
        activeMachineListStatus: machineListStatusByServerId[activeServerSnapshot.serverId] ?? 'loading',
        allMachines,
    };
}

export function useMachinesSettingsViewModel(): MachinesSettingsViewModel {
    const activeSelectionMachineGroups = useMachinesSettingsGroups();
    const { activeServerId, activeMachineListStatus, allMachines, visibleMachineGroups } = activeSelectionMachineGroups;
    const visibleServerIds = React.useMemo(() => visibleMachineGroups.map(group => group.serverId), [visibleMachineGroups]);
    const managedInventory = useManagedMachineInventory(visibleServerIds, undefined, undefined, true);
    const isLoadingMachines = allMachines.length === 0 && (activeMachineListStatus === 'loading' || managedInventory.loading);

    const managedFirstAnswerPending = managedInventory.firstAnswerPending;

    const machineRows = React.useMemo(() => {
        return activeSelectionMachineGroups.visibleMachineGroups.flatMap((group) =>
            group.machines.map((machine) => ({
                id: machine.id,
                title: getMachineDisplayName(machine) ?? machine.id,
                subtitle: machine.metadata?.host,
                serverId: group.serverId,
            })),
        );
    }, [activeSelectionMachineGroups.visibleMachineGroups]);

    return {
        activeServerId,
        allMachines,
        hasMachines: activeSelectionMachineGroups.hasAnyVisibleMachines || Object.values(managedInventory.machinesByServerId).some(rows => rows.length > 0),
        isLoadingMachines,
        managedFirstAnswerPending,
        machineRows,
        showMachinesGroupedByServer: activeSelectionMachineGroups.showMachinesGroupedByServer,
        visibleMachineGroups: activeSelectionMachineGroups.visibleMachineGroups,
        managedByServerId: managedInventory.machinesByServerId,
        managedInventory,
        visibleServerIds,
    };
}
