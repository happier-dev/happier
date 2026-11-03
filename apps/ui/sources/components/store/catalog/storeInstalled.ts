import * as React from 'react';
import { useAllProfileMachineInventorySnapshots } from '@/sync/domains/machines/useMachineInventorySnapshots';
import { resolvePortableMachineAdministrationTarget, type PortableMachineAdministrationTargetResolution } from '@/sync/domains/machines/resolveServerScopedMachines';
import type { MachineDisplayRenderable } from '@/sync/domains/machines/machineDisplayRenderable';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { StoreDemand, StoreInstalledInput } from './storeKinds';

type MachineFailure = Exclude<PortableMachineAdministrationTargetResolution<MachineDisplayRenderable>, { kind: 'resolved' }>;

const EMPTY_MACHINES: readonly MachineDisplayRenderable[] = Object.freeze([]);

/** Held, Home-qualified inventory only. This composition never requests a machine census or probe. */
export function useInstalledMachines(input: StoreInstalledInput, demand: StoreDemand, scope: ServerAccountScope | null) {
    const snapshots = useAllProfileMachineInventorySnapshots(demand.presented && scope !== null,
        scope ? { scope, machineId: input.machine?.machineId ?? null } : undefined);
    const snapshot = snapshots.find(candidate => candidate.kind === 'resolved' && scope
        && candidate.accountId === scope.accountId
        && areServerProfileIdentifiersEquivalent(candidate.serverIdentityId, scope.serverId));
    const machineResolution = React.useMemo(() => {
        if (!input.machine || !scope) return null;
        const machines = snapshot?.kind === 'resolved' ? snapshot.machines : EMPTY_MACHINES;
        return resolvePortableMachineAdministrationTarget({ target: input.machine, activeServerId: '', activeMachines: EMPTY_MACHINES,
            machineListByServerId: snapshot?.kind === 'resolved' ? { [snapshot.profileId]: machines, [snapshot.serverIdentityId]: machines } : {},
            machineListStatusByServerId: snapshot?.kind === 'resolved' && snapshot.inventoryStatus
                ? { [snapshot.profileId]: snapshot.inventoryStatus, [snapshot.serverIdentityId]: snapshot.inventoryStatus } : {} });
    }, [input.machine, scope, snapshot]);
    const machines = React.useMemo(() => machineResolution
        ? machineResolution.kind === 'resolved' ? [machineResolution.machine] : EMPTY_MACHINES
        : input.machine ? EMPTY_MACHINES : snapshot?.machines ?? EMPTY_MACHINES,
    [input.machine, machineResolution, snapshot]);
    const failure: MachineFailure | null = machineResolution && machineResolution.kind !== 'resolved' ? machineResolution : null;
    return { machines, snapshot, failure };
}
