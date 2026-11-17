import { MACHINE_PRESETS_ACCOUNT_CHANGE_ENTITY_ID_V1, type ManagedMachinePresetRevisionV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';
import { TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1 } from '@happier-dev/protocol/changes';
import type { ActionApprovalRegistration } from '@/components/approvals/actionApprovalContinuation';
import { readServerAccountScopeOwnerLifetime, type ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { getServerProfileById, resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { retainDeep, retainKeyedRows, retainShallow } from '@/sync/domains/state/structuralSharing';
import { createMachinePresetCollectionClient, type ManagedMachinePresetListEntryV1, type MachinePresetCollectionFilter } from '@/sync/ops/machines/machinePresetCollectionClient';
import { subscribeHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';

export type MachinePresetQueryState<T> = Readonly<{
    value: T | null;
    loading: boolean;
    error: string | null;
    approval?: ActionApprovalRegistration;
}>;
type Snapshot = MachinePresetQueryState<readonly ManagedMachinePresetListEntryV1[]>;
type RevisionSnapshot = MachinePresetQueryState<Readonly<Record<string, ManagedMachinePresetRevisionV1>>>;
type Consumer = Readonly<{ onApprovalPending?: (approval: ActionApprovalRegistration) => void; projection: 'content' | 'revisions' }>;
type PendingRead = { controller: AbortController; awaitingApproval: boolean; content: boolean };
type Entry = {
    lifetime: ServerAccountScopeLifetime;
    homeId: string;
    sharedWithTeamId?: string;
    snapshot: Snapshot;
    revisions: RevisionSnapshot;
    contentStale: boolean;
    consumers: Set<Consumer>;
    retirement: { dispose(): void };
    read: PendingRead | null;
    stale: boolean;
};

const empty: Snapshot = { value: null, loading: true, error: null };
const emptyRevisions: RevisionSnapshot = { value: null, loading: true, error: null };
const entries = new Map<string, Entry>();
const listeners = new Map<string, Set<() => void>>();
const scopeId = (serverId: string) => resolveServerProfileScopeIdForIdentifier(serverId) || serverId;
const queryKey = (serverId: string, filter?: MachinePresetCollectionFilter) => JSON.stringify([scopeId(serverId), filter?.sharedWithTeamId ?? null]);
const homeEntries = (serverId: string) => [...entries.values()].filter(entry => scopeId(entry.lifetime.scope.serverId) === scopeId(serverId));
let stopObserving: (() => void) | undefined;
let stopDemanding: (() => void) | undefined;
let demandedHomes = '';

export function isMachinePresetAccessLost(code: string): boolean {
    return code === 'permission_denied' || code === 'preset_not_found' || code === 'action_account_scope_changed';
}

function notify(serverId: string) {
    for (const listener of listeners.get(serverId) ?? []) listener();
}

function publish(serverId: string, entry: Entry, next: Snapshot) {
    const retained = retainShallow(entry.snapshot, next);
    if (retained === entry.snapshot) return;
    entry.snapshot = retained;
    notify(serverId);
}

function publishRevisions(serverId: string, entry: Entry, next: RevisionSnapshot) {
    const retained = retainShallow(entry.revisions, next);
    if (retained === entry.revisions) return;
    entry.revisions = retained;
    notify(serverId);
}

function load(serverId: string, entry: Entry) {
    if (entry.read || !entry.stale || !entry.lifetime.isCurrent() || entry.consumers.size === 0) return;
    const content = [...entry.consumers].some(consumer => consumer.projection === 'content');
    const read: PendingRead = { controller: new AbortController(), awaitingApproval: false, content };
    entry.read = read;
    entry.stale = false;
    if (entry.snapshot.approval) {
        const { approval: _approval, ...settled } = entry.snapshot;
        publish(serverId, entry, settled);
    }
    const current = () => !read.controller.signal.aborted && entry.lifetime.isCurrent() && entry.read === read;
    const client = createMachinePresetCollectionClient(entry.lifetime.scope, entry.homeId);
    const options = {
        ...(entry.sharedWithTeamId === undefined ? {} : { sharedWithTeamId: entry.sharedWithTeamId }),
        signal: read.controller.signal,
        onApprovalPending: (approval: ActionApprovalRegistration) => {
            if (!current()) return;
            read.awaitingApproval = true;
            publish(serverId, entry, { ...entry.snapshot, approval });
            publishRevisions(serverId, entry, { ...entry.revisions, approval });
            for (const consumer of entry.consumers) consumer.onApprovalPending?.(approval);
        },
        onApprovalSettled: () => { read.awaitingApproval = false; },
    };
    const request = content ? client.list(options) : (async () => {
        const presets: ManagedMachinePresetRevisionV1[] = [];
        let cursor: string | undefined;
        do {
            const result = await client.read('machines.presets.list', { homeId: entry.homeId,
                projection: 'revisions', includeArchived: true,
                ...(entry.sharedWithTeamId === undefined ? {} : { sharedWithTeamId: entry.sharedWithTeamId }),
                ...(cursor ? { cursor } : {}) }, options);
            if (result.kind === 'failed') return result;
            if (result.value.kind === 'refused') return { kind: 'failed' as const, code: result.value.code };
            if (result.value.kind !== 'revisions') return { kind: 'failed' as const, code: 'invalid_action_output' };
            presets.push(...result.value.presets);
            cursor = result.value.cursor;
        } while (cursor);
        return { kind: 'succeeded' as const, value: presets };
    })();
    void request.then(result => {
        if (!current()) return;
        entry.read = null;
        const error = result.kind === 'failed' ? result.code : null;
        const lost = result.kind === 'failed' && isMachinePresetAccessLost(result.code);
        if (content) {
            entry.contentStale = result.kind === 'failed';
            publish(serverId, entry, {
                value: result.kind === 'succeeded' ? retainKeyedRows(entry.snapshot.value,
                    result.value.filter((preset): preset is ManagedMachinePresetListEntryV1 => 'contentEncryptionMode' in preset), preset => preset.id)
                    : lost ? null : entry.snapshot.value,
                loading: false, error,
            });
        } else if (lost) publish(serverId, entry, { value: null, loading: false, error });
        publishRevisions(serverId, entry, {
            value: result.kind === 'succeeded' ? retainDeep(entry.revisions.value ?? undefined, Object.fromEntries(
                result.value.flatMap(preset => preset.setupRevision === undefined ? [] : [[preset.id, {
                    id: preset.id, homeId: preset.homeId, revision: preset.revision, setupRevision: preset.setupRevision,
                    ...(preset.archivedAt === undefined ? {} : { archivedAt: preset.archivedAt }),
                }]]))) : lost ? null : entry.revisions.value,
            loading: false,
            error,
        });
    }).catch(() => {
        if (!current()) return;
        entry.read = null;
        publish(serverId, entry, { value: entry.snapshot.value, loading: false, error: 'request_failed' });
        publishRevisions(serverId, entry, { value: entry.revisions.value, loading: false, error: 'request_failed' });
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
        entry.contentStale = true;
        entry.read?.controller.abort();
        entry.read = null;
        load(id, entry);
    }
}

function reconcileObservation() {
    if (entries.size > 0 && !stopObserving) {
        // Retained rows hear changes on existing connections even between page visits.
        stopObserving = subscribeHomeAccountChange(event => {
            if (event.source === 'snapshot'
                || event.entityIds?.includes(MACHINE_PRESETS_ACCOUNT_CHANGE_ENTITY_ID_V1)
                || event.entityIds?.includes(TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1)) invalidateMachinePresets(event.serverId);
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
        && (entry.revisions.value === null || entry.revisions.error !== null);
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
    options?: MachinePresetCollectionFilter & Readonly<{ projection?: 'content' | 'revisions' }>): () => void {
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
            snapshot: empty, revisions: emptyRevisions, contentStale: true, consumers: new Set(),
            retirement: { dispose() {} }, read: null, stale: true };
        entries.set(key, created);
        created.retirement = owner.onRetire(() => retire(key, created));
        entry = created;
    }
    const retained = entry;
    const consumer: Consumer = { onApprovalPending, projection };
    retained.consumers.add(consumer);
    if (projection === 'content' && retained.contentStale && !retained.read?.content) {
        retained.stale = true;
        if (retained.read && !retained.read.content) {
            retained.read.controller.abort();
            retained.read = null;
        }
    }
    reconcileObservation();
    load(id, retained);
    if (retained.snapshot.approval) onApprovalPending?.(retained.snapshot.approval);
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

export function readMachinePresetsSnapshot(serverId: string, homeId: string, accountId?: string, filter?: MachinePresetCollectionFilter): Snapshot {
    const entry = entries.get(queryKey(serverId, filter));
    return entry?.lifetime.isCurrent() && entry.homeId === homeId
        && getServerProfileById(serverId)?.serverIdentityId === homeId
        && (accountId === undefined || entry.lifetime.scope.accountId === accountId) ? entry.snapshot : empty;
}

export function readMachinePresetRevisionsSnapshot(serverId: string, homeId: string, accountId?: string): RevisionSnapshot {
    const entry = entries.get(queryKey(serverId));
    return entry?.lifetime.isCurrent() && entry.homeId === homeId
        && getServerProfileById(serverId)?.serverIdentityId === homeId
        && (accountId === undefined || entry.lifetime.scope.accountId === accountId) ? entry.revisions : emptyRevisions;
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
