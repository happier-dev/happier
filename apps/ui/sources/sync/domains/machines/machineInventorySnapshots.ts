import {
    readWarmMachineDisplays,
} from '@/sync/domains/state/machineDisplayWarmCacheAdapters';
import type { MachineDisplayCacheEntryV1 } from '@/sync/domains/state/warmCachePersistence';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { isPersistentMachine } from '@happier-dev/protocol/machines/machineKind';
import { areServerProfileIdentifiersEquivalent, captureServerProfileScopeResolver, type ProfileScopeResolver, type ServerProfile } from '@/sync/domains/server/serverProfiles';
import { readLiveMachineInventoryRows, readMachineInventoryRowReadiness, resolveServerScopedMachineInventory } from './resolveServerScopedMachines';
import { isMachineSelectableForFleet } from './administration/fleetUnion';
import { resolveHomeDisplayLabel } from '@/components/settings/server/homeDisplayName';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

import {
    buildMachineDisplayRenderableFromMachine,
    type MachineDisplayRenderable,
} from './machineDisplayRenderable';

export type MachineInventoryStatus = 'idle' | 'loading' | 'signedOut' | 'error';
type MachineListStatus = MachineInventoryStatus;

export type ServerMachineInventorySnapshotV1 =
    | Readonly<{
        kind: 'resolved';
        /** Credential-proven Account of this Home; absence retains presentation only. */
        accountId: string | null;
        profileId: string;
        serverIdentityId: string;
        serverName: string;
        /** `live` rows come from the live machine store (list read or refresh in flight); `stale` rows are warm-cache or follow a failed read. */
        observation: 'live' | 'stale';
        /**
         * This Home's machine list has been read and is current, so a machine absent from it has
         * left. Absent while the list is still loading, failed, or known only from the warm cache.
         */
        settled?: true;
        /** Current inventory read state; absence is an unobserved, still pending read. */
        inventoryStatus?: MachineInventoryStatus;
        /** Eligibility of the last opened live content for presentation, never fresh invocation authority. */
        executionEligibleMachineIds?: readonly string[];
        /** Online rows still opening content, including after a list read settles. */
        executionPendingMachineIds?: readonly string[];
        machines: readonly MachineDisplayRenderable[];
    }>
    | Readonly<{
        kind: 'unknown';
        inventoryStatus?: MachineInventoryStatus;
        profileId: string;
        serverIdentityId: string;
        serverName: string;
        machines: readonly MachineDisplayRenderable[];
    }>
    | Readonly<{
        kind: 'missingIdentity';
        profileId: string;
        serverName: string;
        machines: readonly MachineDisplayRenderable[];
    }>
    | Readonly<{
        kind: 'ambiguousIdentity';
        profileId: string;
        serverIdentityId: string;
        serverName: string;
        conflictingProfileIds: readonly string[];
        machines: readonly MachineDisplayRenderable[];
    }>;

function uniqueNonEmpty(values: readonly (string | null | undefined)[]): string[] {
    const result: string[] = [];
    const seen = new Set<string>();
    for (const value of values) {
        const normalized = String(value ?? '').trim();
        if (!normalized || seen.has(normalized)) continue;
        seen.add(normalized);
        result.push(normalized);
    }
    return result;
}

function normalizePortableIdentity(value: unknown): string | null {
    const normalized = String(value ?? '').trim();
    return normalized || null;
}

function compareMachineDisplays(left: MachineDisplayRenderable, right: MachineDisplayRenderable): number {
    return left.id.localeCompare(right.id);
}

function resolveRawMachineList(params: Readonly<{
    profile: ServerProfile;
    serverIdentityId: string;
    activeServerId: string;
    activeMachines: readonly Machine[];
    machineListByServerId: Readonly<Record<string, readonly Machine[] | null | undefined>>;
    machineListStatusByServerId: Readonly<Record<string, MachineListStatus | undefined>>;
}>, resolveScopeId: ProfileScopeResolver): Readonly<{ machines: readonly Machine[] | null; observation: 'live' | 'stale'; settled: boolean; inventoryStatus: MachineInventoryStatus }> {
    const keys = uniqueNonEmpty([
        params.serverIdentityId,
        params.profile.id,
        ...(params.profile.legacyServerIds ?? []),
    ]);
    const { machines, status } = resolveServerScopedMachineInventory({
        serverId: params.serverIdentityId,
        serverIdAliases: keys,
        activeServerId: params.activeServerId,
        activeMachines: params.activeMachines,
        machineListByServerId: params.machineListByServerId,
        machineListStatusByServerId: params.machineListStatusByServerId,
    }, resolveScopeId);
    const inventoryStatus = status ?? 'loading';
    return {
        machines,
        // Observation answers "are these the live store rows, whose presence is a self-expiring current fact"
        // (a warm-cache row never is). Whether the list has been read lives in `settled`/`inventoryStatus`,
        // so a refresh in flight over retained rows does not make an Online machine unselectable. A failed read
        // never proves a retained row gone (its presence still self-expires); only a signed-out Home leaves it stale.
        observation: machines !== null && inventoryStatus !== 'signedOut' ? 'live' : 'stale',
        settled: inventoryStatus === 'idle' && machines !== null,
        inventoryStatus,
    };
}

/**
 * The all-profile presentation projection over the incumbent machine store and
 * warm cache. It preserves raw live rows, but stale cache entries are always
 * explicitly labelled and can never become an RPC target by themselves.
 */
export function resolveAllProfileMachineInventorySnapshots(params: Readonly<{
    profiles: readonly ServerProfile[];
    /** Optional admitted Home demand; identity conflicts are still checked against all profiles. */
    serverId?: string;
    machineId?: string;
    activeServerId: string;
    activeMachines: readonly Machine[];
    machineListByServerId: Readonly<Record<string, readonly Machine[] | null | undefined>>;
    machineListStatusByServerId: Readonly<Record<string, MachineListStatus | undefined>>;
    accountScopesByServerId: ReadonlyMap<string, ServerAccountScope>;
    nowMs?: number;
    loadWarmEntries: (
        serverId: string,
        accountId: string,
    ) => Record<string, MachineDisplayCacheEntryV1>;
}>): readonly ServerMachineInventorySnapshotV1[] {
    // Profile correspondence is immutable during this synchronous projection;
    // presence, content readiness and request failures below remain live facts.
    const resolveScopeId = captureServerProfileScopeResolver();
    const claims = new Map<string, Set<string>>();
    for (const profile of params.profiles) {
        const identities = uniqueNonEmpty([
            profile.serverIdentityId,
            ...(profile.legacyServerIds ?? []),
        ]).map(normalizePortableIdentity).filter((value): value is string => Boolean(value));
        for (const identity of identities) {
            const profileIds = claims.get(identity) ?? new Set<string>();
            profileIds.add(profile.id);
            claims.set(identity, profileIds);
        }
    }

    const snapshots: ServerMachineInventorySnapshotV1[] = [];
    for (const profile of params.profiles) {
        if (params.serverId && !areServerProfileIdentifiersEquivalent(profile.serverIdentityId, params.serverId, resolveScopeId)) continue;
        const serverName = resolveHomeDisplayLabel(profile, profile.id);
        const serverIdentityId = normalizePortableIdentity(profile.serverIdentityId);
        if (!serverIdentityId) {
            snapshots.push(Object.freeze({
                kind: 'missingIdentity',
                profileId: profile.id,
                serverName,
                machines: Object.freeze([]),
            }));
            continue;
        }
        const conflictingProfileIds = [...(claims.get(serverIdentityId) ?? [])].sort();
        if (conflictingProfileIds.length !== 1) {
            snapshots.push(Object.freeze({
                kind: 'ambiguousIdentity',
                profileId: profile.id,
                serverIdentityId,
                serverName,
                conflictingProfileIds: Object.freeze(conflictingProfileIds),
                machines: Object.freeze([]),
            }));
            continue;
        }

        const raw = resolveRawMachineList({
            profile,
            serverIdentityId,
            activeServerId: params.activeServerId,
            activeMachines: params.activeMachines,
            machineListByServerId: params.machineListByServerId,
            machineListStatusByServerId: params.machineListStatusByServerId,
        }, resolveScopeId);
        const inventoryStatus = raw.inventoryStatus;
        const scopeCandidate = params.accountScopesByServerId.get(serverIdentityId);
        const accountScope = scopeCandidate?.serverId === serverIdentityId ? scopeCandidate : null;
        if (raw.machines !== null) {
            const liveRows = readLiveMachineInventoryRows({
                activeServerId: params.activeServerId,
                activeMachines: params.activeMachines,
                machineListByServerId: params.machineListByServerId,
                machineListStatusByServerId: params.machineListStatusByServerId,
                profile,
                serverIdentityId,
                retainOpenedContent: true,
            }, resolveScopeId);
            const executionEligibleMachineIds: string[] = [];
            const executionPendingMachineIds: string[] = [];
            const machines: MachineDisplayRenderable[] = [];
            for (const machine of raw.machines) {
                if (params.machineId && machine.id !== params.machineId) continue;
                // Presence is a live, self-expiring fact. Resolve it once for
                // both projections without making display reuse an admission.
                if (isMachineSelectableForFleet(accountScope, machine, params.nowMs, resolveScopeId)) {
                    if (liveRows.has(machine)) executionEligibleMachineIds.push(machine.id);
                    if (raw.observation === 'live' && readMachineInventoryRowReadiness(machine) === 'pending') {
                        executionPendingMachineIds.push(machine.id);
                    }
                }
                if (isPersistentMachine(machine)) machines.push(buildMachineDisplayRenderableFromMachine(machine));
            }
            snapshots.push(Object.freeze({
                kind: 'resolved',
                accountId: accountScope?.accountId ?? null,
                profileId: profile.id,
                serverIdentityId,
                serverName,
                observation: raw.observation,
                inventoryStatus: raw.inventoryStatus,
                ...(raw.settled ? { settled: true as const } : {}),
                executionEligibleMachineIds: Object.freeze(executionEligibleMachineIds),
                executionPendingMachineIds: Object.freeze(executionPendingMachineIds),
                machines: Object.freeze(machines.sort(compareMachineDisplays)),
            }));
            continue;
        }

        const cached = accountScope ? readWarmMachineDisplays({
            profile,
            serverIdentityId,
            accountId: accountScope.accountId,
            machineId: params.machineId,
            loadWarmEntries: params.loadWarmEntries,
        }) : [];
        snapshots.push(cached.length > 0
            ? Object.freeze({
                kind: 'resolved',
                accountId: accountScope?.accountId ?? null,
                profileId: profile.id,
                serverIdentityId,
                serverName,
                observation: 'stale',
                inventoryStatus,
                machines: cached,
            })
            : Object.freeze({
                kind: 'unknown',
                inventoryStatus,
                profileId: profile.id,
                serverIdentityId,
                serverName,
                machines: Object.freeze([]),
            }));
    }

    return Object.freeze(snapshots.sort((left, right) => {
        const leftIdentity = left.kind === 'missingIdentity' ? '' : left.serverIdentityId;
        const rightIdentity = right.kind === 'missingIdentity' ? '' : right.serverIdentityId;
        const identityOrder = leftIdentity.localeCompare(rightIdentity);
        return identityOrder !== 0 ? identityOrder : left.profileId.localeCompare(right.profileId);
    }));
}

/**
 * Whether a Home's machine list has been read, so that a machine absent from it has really left.
 */
export function isMachineInventorySettled(
    snapshots: readonly ServerMachineInventorySnapshotV1[],
    serverIdentityId: string,
): boolean {
    return snapshots.some((snapshot) => snapshot.kind === 'resolved'
        && snapshot.settled === true
        && areServerProfileIdentifiersEquivalent(snapshot.serverIdentityId, serverIdentityId));
}

/** Inventory failures describe the list read, never independently diagnose Home reachability. */
export function readMachineInventoryStatus(
    snapshots: readonly ServerMachineInventorySnapshotV1[],
    serverIdentityId: string,
): MachineInventoryStatus {
    const snapshot = snapshots.find((entry) => entry.kind !== 'missingIdentity'
        && areServerProfileIdentifiersEquivalent(entry.serverIdentityId, serverIdentityId));
    if (snapshot?.kind === 'ambiguousIdentity') return 'error';
    if (snapshot?.kind === 'resolved' && snapshot.settled) return 'idle';
    if (snapshot?.kind === 'resolved' || snapshot?.kind === 'unknown') {
        return snapshot.inventoryStatus === 'error' || snapshot.inventoryStatus === 'signedOut'
            ? snapshot.inventoryStatus
            : 'loading';
    }
    return 'loading';
}
