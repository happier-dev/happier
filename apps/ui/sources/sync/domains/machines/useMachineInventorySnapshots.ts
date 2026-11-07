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

const EMPTY_MACHINE_INVENTORY_SNAPSHOTS: readonly ServerMachineInventorySnapshotV1[] = Object.freeze([]);
const EMPTY_MACHINES: readonly Machine[] = Object.freeze([]);
type InventorySelection = Readonly<{ scope: ServerAccountScope; machineId: string | null }>;

export type MachineInventoryFactsSelector = (
    machine: Machine, scope: ServerAccountScope | null, nowMs: number,
) => readonly unknown[];

/**
 * The one React projection over the all-profile raw inventory and its
 * presentation-only warm fallback. Administration consumers share this hook
 * instead of independently interpreting active/concurrent machine stores.
 * A supplied Home/Machine selection narrows source subscriptions before projection;
 * omitted selection retains the fleet view and its profile-conflict census.
 */
export function useAllProfileMachineInventorySnapshots(enabled = true, selection?: InventorySelection,
    selectFacts?: MachineInventoryFactsSelector): readonly ServerMachineInventorySnapshotV1[] {
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
        return { activeServerId: activeServer.serverId, activeMachines: Object.values(state.machines),
            machineListByServerId: state.machineListByServerId,
            machineListStatusByServerId: state.machineListStatusByServerId };
    }, [store, activeServer.serverId]);
    const readInventories = React.useCallback(() => {
        const inputs = readInputs();
        return selectedProfiles.map(profile => {
            const inventoryInputs = { ...inputs, serverId: profile.serverIdentityId ?? profile.id,
                serverIdAliases: [profile.id, ...(profile.legacyServerIds ?? [])] };
            const inventory = resolveServerScopedMachineInventory(inventoryInputs);
            return { profile, ...inventory,
                scoped: resolveServerScopedMachineInventory({ ...inventoryInputs, activeServerId: '' }).machines !== null,
                machines: machineId ? inventory.machines?.filter(machine => machine.id === machineId) ?? null : inventory.machines };
        });
    }, [readInputs, selectedProfiles, machineId]);
    const readMachines = React.useCallback(() => readInventories().flatMap(inventory => inventory.machines ?? EMPTY_MACHINES), [readInventories]);
    // Select source facts before display conversion. Raw consumers omit this selector.
    const readDemandedInputs = React.useMemo(() => selectFacts ? (nowMs: number) => readInventories().flatMap(inventory => [
        inventory.profile.id, inventory.status, inventory.scoped, inventory.machines !== null,
        ...(inventory.machines ?? []).flatMap(machine => selectFacts(machine,
            accountScopesByServerId.get(inventory.profile.serverIdentityId ?? '') ?? null, nowMs)),
    ]) : undefined, [selectFacts, readInventories, accountScopesByServerId]);
    const readSnapshot = React.useCallback((nowMs: number) => enabled ? resolveAllProfileMachineInventorySnapshots({
        ...readInputs(),
        profiles,
        serverId,
        machineId,
        accountScopesByServerId,
        nowMs,
        loadWarmEntries: loadMachineDisplayWarmCacheEntries,
    }) : EMPTY_MACHINE_INVENTORY_SNAPSHOTS, [enabled, readInputs, accountScopesByServerId, profiles, serverId, machineId]);
    return useMachinePresenceSnapshot(readMachines, readSnapshot, targets, undefined, readDemandedInputs);
}
