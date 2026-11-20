import * as React from 'react';

import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { useServerProfilesGeneration } from '@/hooks/server/useServerProfilesGeneration';
import { areServerProfileIdentifiersEquivalent, listServerProfiles } from '@/sync/domains/server/serverProfiles';
import { loadMachineDisplayWarmCacheEntries } from '@/sync/domains/state/warmCachePersistence';
import { getStorage } from '@/sync/domains/state/storageStore';
import type { Machine } from '@/sync/domains/state/storageTypes';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

import {
    resolveAllProfileMachineInventorySnapshots,
    type ServerMachineInventorySnapshotV1,
} from './machineInventorySnapshots';
import { useMachinePresenceSnapshot } from './reachability/useMachinePresenceSummary';
import { useServerCredentialAccountScopeBindings } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { resolveServerScopedMachineInventory } from './resolveServerScopedMachines';
import { areSnapshotProjectionsEquivalent } from '@/sync/domains/state/structuralSharing';

const EMPTY_MACHINE_INVENTORY_SNAPSHOTS: readonly ServerMachineInventorySnapshotV1[] = Object.freeze([]);
const EMPTY_MACHINES: readonly Machine[] = Object.freeze([]);
type InventorySelection = Readonly<{ scope: Pick<ServerAccountScope, 'serverId'>; machineId: string | null }>;

export type MachineInventoryFactsSelector = (
    machine: Machine, scope: ServerAccountScope | null, nowMs: number,
) => readonly unknown[];

/** A consumer that reads one summary of a Home's Machines, not each Machine's facts. */
export type MachineInventoryFactsDemand = MachineInventoryFactsSelector | Readonly<{
    select: MachineInventoryFactsSelector;
    summarize: (machineFacts: readonly (readonly unknown[])[]) => readonly unknown[];
}>;

/**
 * The one React projection over the all-profile raw inventory and its
 * presentation-only warm fallback. Administration consumers share this hook
 * instead of independently interpreting active/concurrent machine stores.
 * A supplied Home/Machine selection narrows source subscriptions before projection;
 * omitted selection retains the fleet view and its profile-conflict census.
 */
export function useAllProfileMachineInventorySnapshots(enabled = true, selection?: InventorySelection,
    demand?: MachineInventoryFactsDemand): readonly ServerMachineInventorySnapshotV1[] {
    const activeServer = useActiveServerSnapshot();
    const serverProfilesGeneration = useServerProfilesGeneration();
    const profiles = React.useMemo(() => listServerProfiles(), [serverProfilesGeneration]);
    const serverId = selection?.scope.serverId;
    const machineId = selection?.machineId ?? undefined;
    const bindings = useServerCredentialAccountScopeBindings(enabled
        ? serverId ? [serverId] : profiles.map(profile => profile.serverIdentityId) : []);
    const accountScopesByServerId = React.useMemo(() => new Map([...bindings].flatMap(([serverId, binding]) =>
        binding.isCurrent() ? [[serverId, binding.scope] as const] : [])), [bindings]);
    const store = getStorage();
    const selectedProfiles = React.useMemo(() => enabled ? profiles.filter(profile => !serverId
        || areServerProfileIdentifiersEquivalent(profile.serverIdentityId, serverId)) : [], [enabled, profiles, serverId]);
    const targets = React.useMemo(() => selectedProfiles.map(profile => ({ serverId: profile.id,
        ...(machineId ? { machineIds: [machineId] } : {}) })), [selectedProfiles, machineId]);
    const readInputs = React.useCallback(() => {
        const state = store.getState();
        return { activeServerId: activeServer.serverId, activeMachineRecords: state.machines,
            machineListByServerId: state.machineListByServerId,
            machineRecordsByServerId: state.machineRecordsByServerId,
            machineListStatusByServerId: state.machineListStatusByServerId };
    }, [store, activeServer.serverId]);
    const readInventories = React.useCallback(() => {
        const inputs = readInputs();
        return selectedProfiles.map(profile => {
            const inventoryInputs = { ...inputs, serverId: profile.serverIdentityId ?? profile.id,
                serverIdAliases: [profile.id, ...(profile.legacyServerIds ?? [])], machineId };
            const inventory = resolveServerScopedMachineInventory(inventoryInputs);
            return { profile, ...inventory,
                scoped: resolveServerScopedMachineInventory({ ...inventoryInputs, activeServerId: '' }).machines !== null };
        });
    }, [readInputs, selectedProfiles, machineId]);
    const readMachines = React.useCallback(() => readInventories().flatMap(inventory => inventory.machines ?? EMPTY_MACHINES), [readInventories]);
    // Select source facts before display conversion. Raw consumers omit this selector.
    const readDemandedInputs = React.useMemo(() => {
        if (!demand) return undefined;
        const select = typeof demand === 'function' ? demand : demand.select;
        const summarize = typeof demand === 'function' ? undefined : demand.summarize;
        return (nowMs: number) => readInventories().flatMap(inventory => {
            const scope = accountScopesByServerId.get(inventory.profile.serverIdentityId ?? '') ?? null;
            const machineFacts = (inventory.machines ?? []).map(machine => select(machine, scope, nowMs));
            return [inventory.profile.id, inventory.status, inventory.scoped, inventory.machines !== null,
                ...(summarize ? summarize(machineFacts) : machineFacts.flat())];
        });
    }, [demand, readInventories, accountScopesByServerId]);
    const readSnapshot = React.useCallback((nowMs: number) => enabled ? resolveAllProfileMachineInventorySnapshots({
        ...readInputs(),
        profiles,
        serverId,
        machineId,
        accountScopesByServerId,
        nowMs,
        loadWarmEntries: loadMachineDisplayWarmCacheEntries,
    }) : EMPTY_MACHINE_INVENTORY_SNAPSHOTS, [enabled, readInputs, accountScopesByServerId, profiles, serverId, machineId]);
    return useMachinePresenceSnapshot(readMachines, readSnapshot, targets, areSnapshotProjectionsEquivalent, readDemandedInputs);
}
