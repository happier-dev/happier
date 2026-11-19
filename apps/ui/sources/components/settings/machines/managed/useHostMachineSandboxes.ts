import * as React from 'react';
import type { ManagedControllerV1, ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';

import { selectHostMachineSandboxes } from './hostMachineSandboxes';
import { useManagedMachineInventory } from './useManagedMachineInventory';

const NO_SANDBOXES: readonly ManagedMachineV1[] = Object.freeze([]);

/** Host presentation borrows the existing pushed inventory and its Account lifetime. */
export function useHostMachineSandboxes(input: Readonly<{ serverId: string; controller: ManagedControllerV1 | undefined }>) {
    const { controller } = input;
    const serverId = controller ? resolveServerProfileScopeIdForIdentifier(input.serverId) || input.serverId : '';
    const serverIds = React.useMemo(() => serverId ? [serverId] : [], [serverId]);
    const inventory = useManagedMachineInventory(serverIds);
    const machines = inventory.machinesByServerId[serverId];
    const sandboxes = React.useMemo(() => machines && controller ? selectHostMachineSandboxes(machines, controller) : NO_SANDBOXES,
        [machines, controller]);
    return { sandboxes, entry: inventory.entries[serverId], firstAnswerPending: inventory.firstAnswerPending,
        refresh: inventory.refresh };
}
