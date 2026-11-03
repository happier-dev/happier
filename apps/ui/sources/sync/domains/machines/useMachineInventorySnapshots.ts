import * as React from 'react';
import { useShallow } from 'zustand/react/shallow';

import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { useServerProfilesGeneration } from '@/hooks/server/useServerProfilesGeneration';
import { areServerProfileIdentifiersEquivalent, listServerProfiles, type ServerProfile } from '@/sync/domains/server/serverProfiles';
import { loadMachineDisplayWarmCacheEntries } from '@/sync/domains/state/warmCachePersistence';
import { getStorage } from '@/sync/domains/state/storageStore';
import type { Machine } from '@/sync/domains/state/storageTypes';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import {
    useMachineListStatusByServerId,
    useMachineRecordListsByServerId,
    useMachineRecordValues,
} from '@/sync/store/hooks';

import {
    resolveAllProfileMachineInventorySnapshots,
    type ServerMachineInventorySnapshotV1,
} from './machineInventorySnapshots';
import { useMachineReachabilityRevision } from './reachability/useMachineReachabilityRevision';
import { useServerCredentialAccountScopeBindings } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { useMachinePresenceNowMs } from '@/hooks/machine/useMachinePresenceNowMs';
import { resolveServerScopedMachineInventory, resolveServerScopedMachineInventoryKeys } from './resolveServerScopedMachines';

const EMPTY_MACHINE_INVENTORY_SNAPSHOTS: readonly ServerMachineInventorySnapshotV1[] = Object.freeze([]);
const EMPTY_MACHINES: readonly Machine[] = Object.freeze([]);
type InventorySelection = Readonly<{ scope: ServerAccountScope; machineId: string | null }>;

/** Narrow raw inputs before display conversion, retaining tombstones and list readiness. */
function useSelectedInventoryInput(selection: InventorySelection | undefined, profiles: readonly ServerProfile[],
    activeServerId: string, enabled: boolean) {
    const serverId = selection?.scope.serverId ?? '';
    const machineId = selection?.machineId ?? null;
    const targetsActive = Boolean(serverId && areServerProfileIdentifiersEquivalent(serverId, activeServerId));
    const keys = React.useMemo(() => serverId ? resolveServerScopedMachineInventoryKeys({ serverId,
        serverIdAliases: profiles.filter(profile => areServerProfileIdentifiersEquivalent(profile.serverIdentityId, serverId))
            .flatMap(profile => [profile.id, ...(profile.legacyServerIds ?? [])]), machineListByServerId: {} }) : [], [profiles, serverId]);
    const subscription = React.useMemo(() => ({ machineListByServerId: enabled ? keys : [],
        machineListStatusByServerId: enabled ? keys : [] }), [enabled, keys]);
    const activeSubscription = React.useMemo(() => ({ machines: enabled && targetsActive
        ? machineId ? [machineId] : true as const : [] }), [enabled, machineId, targetsActive]);
    const store = getStorage();
    const activeMachines = store(useShallow(state => {
        if (!enabled || !targetsActive) return EMPTY_MACHINES;
        const machine = machineId ? state.machines[machineId] : null;
        return machineId ? machine ? [machine] : EMPTY_MACHINES : Object.values(state.machines);
    }), activeSubscription);
    const raw = store(useShallow(state => {
        const inventory = enabled && serverId ? resolveServerScopedMachineInventory({ serverId,
            serverIdAliases: keys, activeServerId: '', activeMachines: EMPTY_MACHINES,
            machineListByServerId: state.machineListByServerId,
            machineListStatusByServerId: state.machineListStatusByServerId }) : { machines: null, status: undefined };
        return { machines: machineId ? null : inventory.machines,
            machine: machineId ? inventory.machines?.find(machine => machine.id === machineId) ?? null : null,
            hasInventory: inventory.machines !== null, status: inventory.status };
    }), subscription);
    return React.useMemo(() => {
        const machines = machineId ? raw.hasInventory ? raw.machine ? [raw.machine] : EMPTY_MACHINES : null : raw.machines;
        return { activeMachines,
            machineListByServerId: { [serverId]: machines },
            machineListStatusByServerId: { [serverId]: raw.status } };
    }, [activeMachines, machineId, raw, serverId]);
}

/**
 * The one React projection over the all-profile raw inventory and its
 * presentation-only warm fallback. Administration consumers share this hook
 * instead of independently interpreting active/concurrent machine stores.
 * A supplied Home/Machine selection narrows source subscriptions before projection;
 * omitted selection retains the fleet view and its profile-conflict census.
 */
export function useAllProfileMachineInventorySnapshots(enabled = true, selection?: InventorySelection): readonly ServerMachineInventorySnapshotV1[] {
    const activeServer = useActiveServerSnapshot();
    const serverProfilesGeneration = useServerProfilesGeneration();
    const profiles = React.useMemo(() => listServerProfiles(), [serverProfilesGeneration]);
    const allActiveMachines = useMachineRecordValues(enabled && !selection);
    const allMachineLists = useMachineRecordListsByServerId(enabled && !selection);
    const allMachineStatuses = useMachineListStatusByServerId(enabled && !selection);
    const selected = useSelectedInventoryInput(selection, profiles, activeServer.serverId, enabled && !!selection);
    const activeMachines = selection ? selected.activeMachines : allActiveMachines;
    const machineListByServerId = selection ? selected.machineListByServerId : allMachineLists;
    const machineListStatusByServerId = selection ? selected.machineListStatusByServerId : allMachineStatuses;
    const serverId = selection?.scope.serverId;
    const machineId = selection?.machineId ?? undefined;
    const bindings = useServerCredentialAccountScopeBindings(enabled
        ? serverId ? [serverId] : profiles.map(profile => profile.serverIdentityId) : []);
    const accountScopesByServerId = React.useMemo(() => new Map([...bindings].flatMap(([serverId, binding]) =>
        binding.isCurrent() ? [[serverId, binding.scope] as const] : [])), [bindings]);
    const reachabilityRevision = useMachineReachabilityRevision(enabled, selection?.scope, selection?.machineId);
    const presenceMachines = React.useMemo(() => enabled
        ? [...activeMachines, ...Object.values(machineListByServerId).flatMap(machines => machines ?? [])] : [],
    [enabled, activeMachines, machineListByServerId]);
    const nowMs = useMachinePresenceNowMs(presenceMachines);

    return React.useMemo(() => enabled ? resolveAllProfileMachineInventorySnapshots({
        profiles,
        serverId,
        machineId,
        activeServerId: activeServer.serverId,
        activeMachines,
        machineListByServerId,
        machineListStatusByServerId,
        accountScopesByServerId,
        nowMs,
        loadWarmEntries: loadMachineDisplayWarmCacheEntries,
    }) : EMPTY_MACHINE_INVENTORY_SNAPSHOTS, [
        enabled,
        activeMachines,
        activeServer.serverId,
        machineListByServerId,
        machineListStatusByServerId,
        accountScopesByServerId,
        profiles,
        serverId,
        machineId,
        reachabilityRevision,
        nowMs,
    ]);
}
