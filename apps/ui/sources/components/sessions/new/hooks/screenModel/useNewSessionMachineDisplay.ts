import * as React from 'react';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { buildMachineDisplayRenderableFromMachine, type MachineDisplayRenderable } from '@/sync/domains/machines/machineDisplayRenderable';
import { useAllProfileMachineInventorySnapshots } from '@/sync/domains/machines/useMachineInventorySnapshots';

/** Reuse the scoped presentation owner; the launch owner keeps the original Machine. */
export function useNewSessionMachineDisplay(scope: ServerAccountScope | null, machineId: string | null, machine: Machine | null): MachineDisplayRenderable | null {
    const selection = React.useMemo(() => scope && machineId ? { scope, machineId } : undefined, [scope, machineId]);
    // Opened content already follows the launch owner's semantic subscription.
    // Demand retained inventory labels only while that content is unavailable.
    const snapshots = useAllProfileMachineInventorySnapshots(Boolean(selection) && !machine?.metadata, selection);
    if (machine?.metadata) return buildMachineDisplayRenderableFromMachine(machine);
    return snapshots[0]?.machines.find(display => display.id === machineId)
        ?? (machine ? buildMachineDisplayRenderableFromMachine(machine) : null);
}
