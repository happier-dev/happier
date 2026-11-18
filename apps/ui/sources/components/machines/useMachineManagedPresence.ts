import * as React from 'react';

import { useManagedMachineInventory } from '@/components/settings/machines/managed/useManagedMachineInventory';
import { projectMachineManagedPresence } from '@/utils/sessions/machinePresenceLine';

/** The selected Machine borrows the picker's admitted lifecycle, then observes only that enrolled target. */
export function useMachineManagedPresence(
    serverId: string | null,
    machine: Parameters<typeof projectMachineManagedPresence>[0] | null,
) {
    const machineId = machine?.id;
    const homes = React.useMemo(() => serverId && machineId ? [serverId] : [], [serverId, machineId]);
    const inventory = useManagedMachineInventory(homes, undefined, undefined, false, machineId);
    const managed = serverId && machineId ? inventory.machinesByEnrolledMachineIdByServerId[serverId]?.[machineId] : undefined;
    return React.useMemo(() => machine ? projectMachineManagedPresence(machine, managed) : null, [machine, managed]);
}
