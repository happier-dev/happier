import type { MachineAdministrationTargetV1 } from '@happier-dev/protocol/account/settings/machineAdministrationSelectionsV1';
import { storage } from '@/sync/domains/state/storageStore';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { areServerProfileIdentifiersEquivalent, captureServerProfileScopeResolver, type ProfileScopeResolver } from '@/sync/domains/server/serverProfiles';
import { getActiveServerAccountScope, selectActiveServerAccountScopeForServer } from '@/sync/domains/scope/activeServerAccountScope';
import { readLiveMachineInventoryRows, resolvePortableMachineAdministrationTarget, type PortableMachineAdministrationTargetResolution } from '@/sync/domains/machines/resolveServerScopedMachines';
import { isMachineReplaced } from '@/sync/domains/machines/identity/machineIdentityTypes';
import { isMachineSelectableForFleet } from './fleetUnion';
import type { FreshMachineAdministrationExecutionTargetV1, MachineAdministrationExecutionTargetOptions } from './useTargetSelection';

type StorageState = ReturnType<typeof storage.getState>;
type LiveTargetResolution = Extract<PortableMachineAdministrationTargetResolution<Machine>, { kind: 'resolved' }>;

const EMPTY_MACHINE_LISTS: StorageState['machineListByServerId'] = Object.freeze({});
const EMPTY_MACHINE_LIST_STATUSES: NonNullable<StorageState['machineListStatusByServerId']> = Object.freeze({});

/**
 * Scoped membership of one target: profile correspondence, the exact scoped row
 * and its content readiness. It is a pure function of the immutable list and
 * status records and the profile projection, so it is held for exactly those
 * identities; any inventory or profile publication starts a new index. Presence,
 * reachability, Account scope and lock/revocation are never held here.
 */
let membershipIndex: {
    lists: StorageState['machineListByServerId'];
    statuses: NonNullable<StorageState['machineListStatusByServerId']>;
    resolveScopeId: ProfileScopeResolver;
    byTarget: Map<string, LiveTargetResolution | null>;
} | null = null;

function readLiveTargetMembership(target: MachineAdministrationTargetV1, state: StorageState): LiveTargetResolution | null {
    const lists = state.machineListByServerId ?? EMPTY_MACHINE_LISTS;
    const statuses = state.machineListStatusByServerId ?? EMPTY_MACHINE_LIST_STATUSES;
    // The resolver keeps its identity while the profile projection is unchanged
    // and is rebuilt for every other profile snapshot.
    const resolveScopeId = captureServerProfileScopeResolver();
    if (membershipIndex?.lists !== lists || membershipIndex.statuses !== statuses || membershipIndex.resolveScopeId !== resolveScopeId) {
        membershipIndex = { lists, statuses, resolveScopeId, byTarget: new Map() };
    }
    const key = `${target.serverIdentityId}\n${target.machineId}`;
    if (membershipIndex.byTarget.has(key)) return membershipIndex.byTarget.get(key) ?? null;
    // Scoped membership never reads the active display inventory (no active
    // server fallback), so neither the active rows nor the active server is an input.
    const resolution = resolvePortableMachineAdministrationTarget<Machine>({
        target, activeServerId: '', activeMachines: [], machineListByServerId: lists, machineListStatusByServerId: statuses,
    });
    const live = resolution.kind === 'resolved' && readLiveMachineInventoryRows<Machine>({
        activeServerId: '', activeMachines: [], machineListByServerId: lists, machineListStatusByServerId: statuses,
        profile: resolution.profile, serverIdentityId: resolution.target.serverIdentityId,
    }, resolveScopeId).has(resolution.machine) ? resolution : null;
    membershipIndex.byTarget.set(key, live);
    return live;
}

/** Fresh invocation admission shared by Administration's selector and non-hook readers. */
export function resolveFreshMachineAdministrationExecutionTarget(
    target: MachineAdministrationTargetV1 | null,
    options: MachineAdministrationExecutionTargetOptions = {},
): FreshMachineAdministrationExecutionTargetV1 | null {
    if (!target) return null;
    const resolution = readLiveTargetMembership(target, storage.getState());
    if (!resolution) return null;
    const accountScope = 'accountScope' in options ? options.accountScope
        : selectActiveServerAccountScopeForServer(getActiveServerAccountScope(), resolution.profile.id);
    if (!accountScope || !areServerProfileIdentifiersEquivalent(accountScope.serverId, resolution.profile.id)) return null;
    if (resolution.machine.availability?.kind === 'locked'
        || (typeof resolution.machine.revokedAt === 'number' && resolution.machine.revokedAt > 0)
        || isMachineReplaced(resolution.machine)) return null;
    if (options.intent === 'retry') return resolution;
    // Presence (clock) and request reachability are read on every check.
    return isMachineSelectableForFleet(accountScope, resolution.machine) ? resolution : null;
}
