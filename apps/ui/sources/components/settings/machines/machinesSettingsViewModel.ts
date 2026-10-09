import * as React from 'react';

import { useActiveSelectionMachineGroups } from '@/components/settings/machines/hooks/useActiveSelectionMachineGroups';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { listServerProfiles } from '@/sync/domains/server/serverProfiles';
import {
    useAllMachines,
    useMachineListByServerId,
    useMachineListStatusByServerId,
} from '@/sync/domains/state/storage';
import { useHomeViewSelectionSettings } from '@/hooks/server/useHomeViewSelectionSettings';
import { getMachineDisplayName } from '@/utils/sessions/machineDisplayNames';
import { useManagedMachineInventory } from './managed/useManagedMachineInventory';
import { useMachinePresets } from './managed/useMachinePresets';

export type MachinesSettingsViewModel = ReturnType<typeof useMachinesSettingsViewModel>;

export function useMachinesSettingsViewModel() {
    const allMachines = useAllMachines();
    const machineListByServerId = useMachineListByServerId();
    const machineListStatusByServerId = useMachineListStatusByServerId();
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

    const managedServerIds = React.useMemo(() => activeSelectionMachineGroups.visibleMachineGroups.map(group => group.serverId),
        [activeSelectionMachineGroups.visibleMachineGroups]);
    const managedInventory = useManagedMachineInventory(managedServerIds);
    const presetInventory = useMachinePresets(managedServerIds);

    const isLoadingMachines = React.useMemo(() => {
        const status = machineListStatusByServerId[activeServerSnapshot.serverId] ?? 'loading';
        return allMachines.length === 0 && (status === 'loading' || managedInventory.loading);
    }, [activeServerSnapshot.serverId, allMachines.length, machineListStatusByServerId, managedInventory.loading]);

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
        activeServerId: activeServerSnapshot.serverId,
        allMachines,
        hasMachines: activeSelectionMachineGroups.hasAnyVisibleMachines || Object.values(managedInventory.machinesByServerId).some(rows => rows.length > 0),
        isLoadingMachines,
        machineRows,
        showMachinesGroupedByServer: activeSelectionMachineGroups.showMachinesGroupedByServer,
        visibleMachineGroups: activeSelectionMachineGroups.visibleMachineGroups,
        managedByServerId: managedInventory.machinesByServerId,
        managedInventory,
        presetsByServerId: presetInventory.presetsByServerId,
        presetInventory,
    };
}
