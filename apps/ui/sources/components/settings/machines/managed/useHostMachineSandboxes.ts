import * as React from 'react';
import type { ManagedControllerV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';

import { projectHostMachineSandboxCounts, readHostMachineSandboxCount, selectHostMachineSandboxes } from './hostMachineSandboxes';
import { useManagedMachineInventory } from './useManagedMachineInventory';

/** Host presentation borrows the existing pushed inventory and its Account lifetime. */
export function useHostMachineSandboxes(input: Readonly<{ serverId: string; controller: ManagedControllerV1 }>) {
    const serverId = resolveServerProfileScopeIdForIdentifier(input.serverId) || input.serverId;
    const serverIds = React.useMemo(() => [serverId], [serverId]);
    const inventory = useManagedMachineInventory(serverIds);
    const machines = inventory.machinesByServerId[serverId];
    const sandboxes = React.useMemo(() => selectHostMachineSandboxes(machines ?? [], input.controller),
        [machines, input.controller.machineId, input.controller.installationId]);
    const counts = React.useMemo(() => projectHostMachineSandboxCounts(machines ?? []), [machines]);
    return { sandboxes, count: readHostMachineSandboxCount(counts, input.controller), entry: inventory.entries[serverId],
        loading: inventory.loading, firstAnswerPending: inventory.firstAnswerPending,
        refresh: inventory.refresh };
}
