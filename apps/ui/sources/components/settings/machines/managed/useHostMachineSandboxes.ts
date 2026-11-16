import * as React from 'react';
import type { ManagedControllerV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';

import { projectHostMachineSandboxCounts, readHostMachineSandboxCount, selectHostMachineSandboxes } from './hostMachineSandboxes';
import { useManagedMachineInventory } from './useManagedMachineInventory';

/** Host presentation borrows the existing pushed inventory and its Account lifetime. */
export function useHostMachineSandboxes(input: Readonly<{ serverId: string; controller: ManagedControllerV1 }>) {
    const serverIds = React.useMemo(() => [input.serverId], [input.serverId]);
    const inventory = useManagedMachineInventory(serverIds);
    const machines = inventory.machinesByServerId[input.serverId];
    const sandboxes = React.useMemo(() => selectHostMachineSandboxes(machines ?? [], input.controller),
        [machines, input.controller.machineId, input.controller.installationId]);
    const counts = React.useMemo(() => projectHostMachineSandboxCounts(machines ?? []), [machines]);
    return { sandboxes, count: readHostMachineSandboxCount(counts, input.controller), loading: inventory.loading, firstAnswerPending: inventory.firstAnswerPending,
        refresh: inventory.refresh };
}
