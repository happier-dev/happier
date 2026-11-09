import * as React from 'react';

import type { Machine } from '@/sync/domains/state/storageTypes';
import { useLaunchSelectionMachines } from '@/sync/store/hooks';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { useServerScopedMachineOptions } from '@/components/sessions/new/hooks/machines/useServerScopedMachineOptions';
import { useMachinePoolGroups } from '@/components/sessions/new/hooks/machines/useMachinePoolGroups';
import { resolveNewSessionMachinePickerHistory } from '@/components/sessions/new/modules/newSessionPlacementSources';

export type NewSessionMachinePickerInventory = Readonly<{
    allowedServerIds: ReadonlyArray<string>;
    activeServerId: string;
    refreshToken?: string | number;
    targetServerId: string | null;
    /** Already scoped to the target Home by the authoring placement owner. */
    recentMachinePaths: ReadonlyArray<Readonly<{ machineId: string; path: string }>>;
    favoriteMachineIds: ReadonlyArray<string>;
}>;

const NO_MACHINES: ReadonlyArray<Machine> = [];

/** Mounted only by the open picker; every destination family consumes the same Home groups. */
export function useNewSessionMachinePickerInventory(inventory: NewSessionMachinePickerInventory) {
    const activeMachines = useLaunchSelectionMachines();
    const groups = useServerScopedMachineOptions({
        allowedServerIds: inventory.allowedServerIds,
        activeServerId: inventory.activeServerId,
        activeMachines,
        refreshToken: inventory.refreshToken,
        inventoryPurpose: 'launch',
    });
    const poolGroups = useMachinePoolGroups(groups);
    const machines = groups.find((group) => areServerProfileIdentifiersEquivalent(group.serverId, inventory.targetServerId))?.machines;
    // The rows below feed the picker's whole-list model: an equal answer keeps its identity.
    const history = React.useMemo(() => resolveNewSessionMachinePickerHistory({
        machines: machines ?? NO_MACHINES,
        recentMachinePaths: inventory.recentMachinePaths,
        favoriteMachineIds: inventory.favoriteMachineIds,
    }), [machines, inventory.recentMachinePaths, inventory.favoriteMachineIds]);
    return { groups, poolGroups, ...history };
}
