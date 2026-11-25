import { MACHINE_PRESETS_ACCOUNT_CHANGE_ENTITY_ID_V1, type ManagedMachinePresetRevisionV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';
import { TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1 } from '@happier-dev/protocol/changes';
import type { ActionApprovalRegistration } from '@/components/approvals/actionApprovalContinuation';
import { readServerAccountScopeOwnerLifetime, type ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { getServerProfileById, resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { retainDeep, retainKeyedRows, retainShallow } from '@/sync/domains/state/structuralSharing';
import { createMachinePresetCollectionClient, type ManagedMachinePresetListEntryV1, type MachinePresetCollectionFilter } from '@/sync/ops/machines/machinePresetCollectionClient';
import { subscribeHomeAccountChange, type HomeAccountChangeEvent } from '@/sync/runtime/orchestration/homeAccountChange';

export type MachinePresetQueryState<T> = Readonly<{
    value: T | null;
    loading: boolean;
    error: string | null;
    approval?: ActionApprovalRegistration;
}>;
type Snapshot = MachinePresetQueryState<readonly ManagedMachinePresetListEntryV1[]>;
type RevisionSnapshot = MachinePresetQueryState<Readonly<Record<string, ManagedMachinePresetRevisionV1>>>;
const projectionRank = { count: 1, revisions: 2, content: 3 } as const;
type Projection = keyof typeof projectionRank;
type CountSnapshot = MachinePresetQueryState<number>;
type Consumer = Readonly<{ onApprovalPending?: (approval: ActionApprovalRegistration) => void; projection: Projection }>;
type PendingRead = { controller: AbortController; awaitingApproval: boolean; projection: Projection };
type Entry = {
    lifetime: ServerAccountScopeLifetime;
    homeId: string;
    sharedWithTeamId?: string;
    snapshot: Snapshot;
    revisions: RevisionSnapshot;
    count: CountSnapshot;
    settledProjection: Projection | null;
    consumers: Set<Consumer>;
    retirement: { dispose(): void };
    read: PendingRead | null;
    stale: boolean;
};

const empty: Snapshot = { value: null, loading: true, error: null };
const emptyRevisions: RevisionSnapshot = { value: null, loading: true, error: null };
const emptyCount: CountSnapshot = { value: null, loading: true, error: null };
const entries = new Map<string, Entry>();
const listeners = new Map<string, Set<() => void>>();
const scopeId = (serverId: string) => resolveServerProfileScopeIdForIdentifier(serverId) || serverId;
const queryKey = (serverId: string, filter?: MachinePresetCollectionFilter) => JSON.stringify([scopeId(serverId), filter?.sharedWithTeamId ?? null]);
const homeEntries = (serverId: string) => [...entries.values()].filter(entry => scopeId(entry.lifetime.scope.serverId) === scopeId(serverId));
let stopObserving: (() => void) | undefined;
let stopDemanding: (() => void) | undefined;
let demandedHomes = '';

export function isMachinePresetAccessLost(code: string): boolean {
    return code === 'permission_denied'
        || code === 'preset_not_found'
        || code === 'action_account_scope_changed'
        || code === 'team_authentication_required'
        || code === 'team_authentication_unavailable';
}

export function homeAccountChangeAffectsMachinePresetList(event: HomeAccountChangeEvent): boolean {
    return event.source === 'snapshot'
        || event.entityIds?.includes(MACHINE_PRESETS_ACCOUNT_CHANGE_ENTITY_ID_V1) === true
        || event.entityIds?.includes(TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1) === true;
}

function notify(serverId: string) {
    for (const listener of listeners.get(serverId) ?? []) listener();
}

function publish(serverId: string, entry: Entry, countNext: CountSnapshot, contentNext?: Snapshot, revisionsNext?: RevisionSnapshot) {
    const snapshot = contentNext ? retainShallow(entry.snapshot, contentNext) : entry.snapshot;
    const revisions = revisionsNext ? retainShallow(entry.revisions, revisionsNext) : entry.revisions;
    const count = retainShallow(entry.count, countNext);
    if (snapshot === entry.snapshot && revisions === entry.revisions && count === entry.count) return;
    entry.snapshot = snapshot;
    entry.revisions = revisions;
    entry.count = count;
    notify(serverId);
}

function load(serverId: string, entry: Entry) {
    if (entry.read || !entry.stale || !entry.lifetime.isCurrent() || entry.consumers.size === 0) return;
    let projection: Projection = 'count';
    for (const consumer of entry.consumers) {
        if (projectionRank[consumer.projection] > projectionRank[projection]) projection = consumer.projection;
    }
    const read: PendingRead = { controller: new AbortController(), awaitingApproval: false, projection };
    entry.read = read;
    entry.stale = false;
    if (entry.count.approval) {
        const { approval: _approval, ...settled } = entry.snapshot;
        const { approval: _revisionApproval, ...settledRevisions } = entry.revisions;
        const { approval: _countApproval, ...settledCount } = entry.count;
        publish(serverId, entry, settledCount, settled, settledRevisions);
    }
    const current = () => !read.controller.signal.aborted && entry.lifetime.isCurrent() && entry.read === read;
    const client = createMachinePresetCollectionClient(entry.lifetime.scope, entry.homeId);
    const options = {
        ...(entry.sharedWithTeamId === undefined ? {} : { sharedWithTeamId: entry.sharedWithTeamId }),
        signal: read.controller.signal,
        onApprovalPending: (approval: ActionApprovalRegistration) => {
            if (!current()) return;
            read.awaitingApproval = true;
            publish(serverId, entry, { ...entry.count, approval },
                projection === 'content' ? { ...entry.snapshot, approval } : undefined,
                projection !== 'count' ? { ...entry.revisions, approval } : undefined);
            for (const consumer of entry.consumers) consumer.onApprovalPending?.(approval);
        },
        onApprovalSettled: () => { read.awaitingApproval = false; },
    };
    const request = async () => {
        if (projection === 'content') return client.list(options);
        if (projection === 'count') {
            const result = await client.listPage({ ...options, projection });
            if (result.kind === 'failed') return result;
            return result.value.kind === 'count'
                ? { kind: 'succeeded' as const, value: result.value.count }
                : { kind: 'failed' as const, code: 'invalid_action_output' };
        }
        const presets: ManagedMachinePresetRevisionV1[] = [];
        let cursor: string | undefined;
        do {
            const result = await client.listPage({ ...options, projection, cursor });
            if (result.kind === 'failed') return result;
            if (result.value.kind !== 'revisions') return { kind: 'failed' as const, code: 'invalid_action_output' };
            presets.push(...result.value.presets);
            cursor = result.value.cursor;
        } while (cursor);
        return { kind: 'succeeded' as const, value: presets };
    };
    const publishFailure = (code: string) => {
        const lost = isMachinePresetAccessLost(code);
        publish(serverId, entry, { value: lost ? null : entry.count.value, loading: false, error: code },
            projection === 'content' || lost ? { value: lost ? null : entry.snapshot.value, loading: false, error: code } : undefined,
            projection !== 'count' || lost ? { value: lost ? null : entry.revisions.value, loading: false, error: code } : undefined);
    };
    void request().then(result => {
        if (!current()) return;
        if (result.kind === 'failed') { publishFailure(result.code); return; }
        entry.settledProjection = projection;
        if (typeof result.value === 'number') {
            publish(serverId, entry, { value: result.value, loading: false, error: null });
            return;
        }
        let activeCount = 0;
        const headers: Record<string, ManagedMachinePresetRevisionV1> = Object.create(null);
        for (const preset of result.value) {
            if (preset.archivedAt === undefined) activeCount += 1;
            if (preset.setupRevision !== undefined) headers[preset.id] = {
                id: preset.id, homeId: preset.homeId, revision: preset.revision, setupRevision: preset.setupRevision,
                ...(preset.archivedAt === undefined ? {} : { archivedAt: preset.archivedAt }),
            };
        }
        publish(serverId, entry, { value: activeCount, loading: false, error: null }, projection === 'content' ? {
            value: retainKeyedRows(entry.snapshot.value,
                result.value.filter((preset): preset is ManagedMachinePresetListEntryV1 => 'contentEncryptionMode' in preset), preset => preset.id),
            loading: false, error: null,
        } : undefined, { value: retainDeep(entry.revisions.value ?? undefined, headers), loading: false, error: null });
    }).catch(() => {
        if (current()) publishFailure('request_failed');
    }).finally(() => {
        if (entry.read === read) entry.read = null;
    });
}

export function invalidateMachinePresets(serverId: string): void {
    const id = scopeId(serverId);
    for (const entry of homeEntries(id)) {
        // An approved read has not executed yet; its eventual answer covers this change.
        if (entry.read?.awaitingApproval) continue;
        entry.stale = true;
        entry.settledProjection = null;
        entry.read?.controller.abort();
        entry.read = null;
        load(id, entry);
    }
}

function reconcileObservation() {
    if (entries.size > 0 && !stopObserving) {
        // Retained rows hear changes on existing connections even between page visits.
        stopObserving = subscribeHomeAccountChange(event => {
            if (homeAccountChangeAffectsMachinePresetList(event)) invalidateMachinePresets(event.serverId);
        });
    } else if (entries.size === 0) {
        stopObserving?.();
        stopObserving = undefined;
    }
    const homes = [...new Set([...entries.values()].filter(entry => entry.consumers.size > 0)
        .map(entry => scopeId(entry.lifetime.scope.serverId)))].sort();
    const key = JSON.stringify(homes);
    if (key === demandedHomes) return;
    stopDemanding?.();
    const readNotCurrent = (entry: Entry | undefined) => !!entry && entry.read === null
        && (entry.count.value === null || entry.count.error !== null);
    // The incumbent reconnect owner retries failed reads; settled content follows the feed.
    stopDemanding = homes.length ? subscribeHomeAccountChange(event => {
        if (event.source === 'connected' && homeEntries(event.serverId).some(readNotCurrent)) {
            invalidateMachinePresets(event.serverId);
        }
    }, { serverIds: homes, reconnect: { readNotCurrent: () => homes.some(id => homeEntries(id).some(readNotCurrent)) } }) : undefined;
    demandedHomes = key;
}

function retire(key: string, entry: Entry) {
    entry.read?.controller.abort();
    entry.retirement.dispose();
    if (entries.get(key) !== entry) return;
    entries.delete(key);
    reconcileObservation();
    notify(scopeId(entry.lifetime.scope.serverId));
}

/** Account-owned settled content survives page bindings; credential retirement withdraws it synchronously. */
export function retainMachinePresets(lifetime: ServerAccountScopeLifetime, homeId: string,
    onApprovalPending?: (approval: ActionApprovalRegistration) => void,
    options?: MachinePresetCollectionFilter & Readonly<{ projection?: Projection }>): () => void {
    const projection = options?.projection ?? 'content';
    const owner = readServerAccountScopeOwnerLifetime(lifetime);
    if (!owner.isCurrent()) return () => {};
    const id = scopeId(owner.scope.serverId);
    const key = queryKey(id, options);
    let entry = entries.get(key);
    if (entry && (entry.homeId !== homeId || entry.lifetime !== owner)) {
        retire(key, entry);
        entry = undefined;
    }
    if (!entry) {
        const created: Entry = { lifetime: owner, homeId, sharedWithTeamId: options?.sharedWithTeamId,
            snapshot: empty, revisions: emptyRevisions, count: emptyCount, settledProjection: null, consumers: new Set(),
            retirement: { dispose() {} }, read: null, stale: true };
        entries.set(key, created);
        created.retirement = owner.onRetire(() => retire(key, created));
        entry = created;
    }
    const retained = entry;
    const consumer: Consumer = { onApprovalPending, projection };
    retained.consumers.add(consumer);
    const coveredRank = Math.max(retained.settledProjection ? projectionRank[retained.settledProjection] : 0,
        retained.read ? projectionRank[retained.read.projection] : 0);
    if (projectionRank[projection] > coveredRank) {
        retained.stale = true;
        if (retained.read) {
            retained.read.controller.abort();
            retained.read = null;
        }
    }
    reconcileObservation();
    load(id, retained);
    if (retained.count.approval) onApprovalPending?.(retained.count.approval);
    return () => {
        retained.consumers.delete(consumer);
        if (retained.consumers.size === 0 && retained.read) {
            retained.read.controller.abort();
            retained.read = null;
            retained.stale = true;
        }
        reconcileObservation();
    };
}

function readCurrentEntry(serverId: string, homeId: string, accountId?: string, filter?: MachinePresetCollectionFilter): Entry | undefined {
    const entry = entries.get(queryKey(serverId, filter));
    return entry?.lifetime.isCurrent() && entry.homeId === homeId
        && getServerProfileById(serverId)?.serverIdentityId === homeId
        && (accountId === undefined || entry.lifetime.scope.accountId === accountId) ? entry : undefined;
}

export function readMachinePresetsSnapshot(serverId: string, homeId: string, accountId?: string, filter?: MachinePresetCollectionFilter): Snapshot {
    return readCurrentEntry(serverId, homeId, accountId, filter)?.snapshot ?? empty;
}

export function readMachinePresetRevisionsSnapshot(serverId: string, homeId: string, accountId?: string): RevisionSnapshot {
    return readCurrentEntry(serverId, homeId, accountId)?.revisions ?? emptyRevisions;
}

export function readMachinePresetCountSnapshot(serverId: string, homeId: string, accountId: string): CountSnapshot {
    return readCurrentEntry(serverId, homeId, accountId)?.count ?? emptyCount;
}

export function subscribeMachinePresets(serverIds: readonly string[], listener: () => void): () => void {
    const ids = [...new Set(serverIds.map(scopeId))];
    for (const id of ids) {
        const subscriptions = listeners.get(id) ?? new Set();
        subscriptions.add(listener);
        listeners.set(id, subscriptions);
    }
    return () => {
        for (const id of ids) {
            const subscriptions = listeners.get(id);
            subscriptions?.delete(listener);
            if (subscriptions?.size === 0) listeners.delete(id);
        }
    };
}
