import {
    buildMachineDisplayRenderableFromCacheEntry,
} from '@/sync/domains/state/machineDisplayWarmCacheAdapters';
import type { MachineDisplayCacheEntryV1 } from '@/sync/domains/state/warmCachePersistence';
import type { Machine } from '@/sync/domains/state/storageTypes';
import type { ServerProfile } from '@/sync/domains/server/serverProfiles';

import {
    buildMachineDisplayRenderableFromMachine,
    type MachineDisplayRenderable,
} from './machineDisplayRenderable';

type MachineListStatus = 'idle' | 'loading' | 'signedOut' | 'error';

export type ServerMachineInventorySnapshotV1 =
    | Readonly<{
        kind: 'resolved';
        profileId: string;
        serverIdentityId: string;
        serverName: string;
        observation: 'live' | 'stale';
        machines: readonly MachineDisplayRenderable[];
    }>
    | Readonly<{
        kind: 'unknown';
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

function readWarmMachineDisplays(params: Readonly<{
    profile: ServerProfile;
    serverIdentityId: string;
    accountId: string;
    loadWarmEntries: (
        serverId: string,
        accountId: string,
    ) => Record<string, MachineDisplayCacheEntryV1>;
}>): readonly MachineDisplayRenderable[] {
    const entriesByMachineId = new Map<string, MachineDisplayCacheEntryV1>();
    const keys = uniqueNonEmpty([
        params.serverIdentityId,
        params.profile.id,
        ...(params.profile.legacyServerIds ?? []),
    ]);
    for (const key of keys) {
        const entries = params.loadWarmEntries(key, params.accountId);
        for (const entry of Object.values(entries)) {
            const previous = entriesByMachineId.get(entry.machineId);
            if (!previous || entry.updatedAt > previous.updatedAt) {
                entriesByMachineId.set(entry.machineId, entry);
            }
        }
    }
    return Object.freeze([...entriesByMachineId.values()]
        .map(buildMachineDisplayRenderableFromCacheEntry)
        .sort(compareMachineDisplays));
}

function resolveRawMachineList(params: Readonly<{
    profile: ServerProfile;
    serverIdentityId: string;
    activeServerId: string;
    activeInventoryLoaded: boolean;
    activeMachines: readonly Machine[];
    machineListByServerId: Readonly<Record<string, readonly Machine[] | null | undefined>>;
    machineListStatusByServerId: Readonly<Record<string, MachineListStatus | undefined>>;
}>): Readonly<{ machines: readonly Machine[]; observation: 'live' | 'stale' }> | null {
    const keys = uniqueNonEmpty([
        params.serverIdentityId,
        params.profile.id,
        ...(params.profile.legacyServerIds ?? []),
    ]);
    if (params.activeInventoryLoaded && keys.includes(params.activeServerId)) {
        return { machines: params.activeMachines, observation: 'live' };
    }
    for (const key of keys) {
        const machines = params.machineListByServerId[key];
        if (!Array.isArray(machines)) continue;
        return {
            machines,
            observation: params.machineListStatusByServerId[key] === 'idle' ? 'live' : 'stale',
        };
    }
    return null;
}

/**
 * The all-profile presentation projection over the incumbent machine store and
 * warm cache. It preserves raw live rows, but stale cache entries are always
 * explicitly labelled and can never become an RPC target by themselves.
 */
export function resolveAllProfileMachineInventorySnapshots(params: Readonly<{
    profiles: readonly ServerProfile[];
    activeServerId: string;
    activeInventoryLoaded: boolean;
    activeMachines: readonly Machine[];
    machineListByServerId: Readonly<Record<string, readonly Machine[] | null | undefined>>;
    machineListStatusByServerId: Readonly<Record<string, MachineListStatus | undefined>>;
    accountId: string;
    loadWarmEntries: (
        serverId: string,
        accountId: string,
    ) => Record<string, MachineDisplayCacheEntryV1>;
}>): readonly ServerMachineInventorySnapshotV1[] {
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
        const serverName = profile.name || profile.serverUrl || profile.id;
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
            activeInventoryLoaded: params.activeInventoryLoaded,
            activeMachines: params.activeMachines,
            machineListByServerId: params.machineListByServerId,
            machineListStatusByServerId: params.machineListStatusByServerId,
        });
        if (raw) {
            snapshots.push(Object.freeze({
                kind: 'resolved',
                profileId: profile.id,
                serverIdentityId,
                serverName,
                observation: raw.observation,
                machines: Object.freeze(raw.machines
                    .map(buildMachineDisplayRenderableFromMachine)
                    .sort(compareMachineDisplays)),
            }));
            continue;
        }

        const cached = readWarmMachineDisplays({
            profile,
            serverIdentityId,
            accountId: params.accountId,
            loadWarmEntries: params.loadWarmEntries,
        });
        snapshots.push(cached.length > 0
            ? Object.freeze({
                kind: 'resolved',
                profileId: profile.id,
                serverIdentityId,
                serverName,
                observation: 'stale',
                machines: cached,
            })
            : Object.freeze({
                kind: 'unknown',
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
