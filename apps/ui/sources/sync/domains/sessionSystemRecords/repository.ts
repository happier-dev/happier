import type { SessionSystemRecordStored, SessionSystemRecordStoredPageResponse } from '@happier-dev/protocol';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { linearBackoffDelay } from '@/utils/timing/time';
import {
    createSessionSystemRecordTransport,
    type HostSessionSystemRecordAddress,
    type HostSessionSystemRecordListQuery,
    type SessionSystemRecordFetchResult,
    type SessionSystemRecordTransportOptions,
} from './transport';
import { readLegacyWorkflowSystemRecord, type LegacyWorkflowRecordProjection } from './compatibility/legacyHostTransport';
import type { SessionSystemRecordCompatibilityOpenInput } from './codec';
import { openSessionSurfaceItemRecord } from './codec';
import type { SessionStoredContentContext } from '@happier-dev/sync-client';
import type { SessionSystemRecordObservationBase } from './observation';
import type { SessionSystemRecordCountResponse } from '@happier-dev/protocol/sessions/system/records/sessionSystemRecordRoutes';

type BoardCountAuthority = Pick<SessionSystemRecordObservationBase, 'isCurrent' | 'readCapabilities'>;
type BoardCount = {
    value: number | null;
    listeners: Set<() => void>;
    holders: Set<BoardCountAuthority>;
    attempted: boolean;
    request?: { controller: AbortController; readers: number; promise: Promise<SessionSystemRecordFetchResult<SessionSystemRecordCountResponse>> };
};

export type SessionSystemRecordQuery =
    | Readonly<{ type: 'read'; address: HostSessionSystemRecordAddress }>
    | (Readonly<{ type: 'list' }> & HostSessionSystemRecordListQuery)
    | Readonly<{ type: 'legacy_workflow'; localId: string }>;
export type SessionSystemRecordQueryValue<Q extends SessionSystemRecordQuery> = Q extends { type: 'read' } ? SessionSystemRecordStored : Q extends { type: 'legacy_workflow' } ? LegacyWorkflowRecordProjection : SessionSystemRecordStoredPageResponse;
type RecordValue = SessionSystemRecordStored | SessionSystemRecordStoredPageResponse | SessionSystemRecordCompatibilityOpenInput;
type FetchError = Exclude<SessionSystemRecordFetchResult<never>, { status: 'ok' }>;
export type SessionSystemRecordRepositoryEntry<T> = Readonly<{
    data: T | null;
    freshness: 'fresh' | 'stale';
    reachability: 'reachable' | 'offline' | 'unknown';
    loading: 'idle' | 'initial' | 'refreshing';
    lastError: FetchError | null;
}>;
type Entry = {
    session: SessionAddress;
    query: SessionSystemRecordQuery;
    snapshot: SessionSystemRecordRepositoryEntry<RecordValue>;
    listeners: Set<() => void>;
    pending?: Promise<void>;
    invalidatedWhileLoading: boolean;
    /** Consecutive transient failures of this query; reset by any answer. */
    transientFailures: number;
    retryTimer?: ReturnType<typeof setTimeout>;
    measurements?: Partial<Record<'reply' | `intrinsic:${string}`, number>>;
};
type SessionEntries = {
    queries: Map<string, Entry>;
    /** Selector membership shares the lifetime of the retained queries, including hidden ones. */
    lists: Map<string, Set<Entry>>;
    legacyWorkflows: Set<Entry>;
    boardInventoryPages: Set<Entry>;
    boardCount?: BoardCount;
    authority?: Pick<SessionSystemRecordObservationBase, 'readCapabilities' | 'readContentContext' | 'isCurrent'>;
};

function queryKey(query: SessionSystemRecordQuery): string {
    if (query.type === 'legacy_workflow') return JSON.stringify(['legacy_workflow', query.localId]);
    return query.type === 'read'
        ? JSON.stringify(['read', query.address.namespace, query.address.kind, query.address.localId])
        : JSON.stringify(['list', query.namespace, query.kind ?? null, query.localId ?? null, query.limit ?? 100, query.cursor ?? null]);
}

function listSelectorKey(namespace: HostSessionSystemRecordListQuery['namespace'], kind?: string, localId?: string): string {
    return JSON.stringify([namespace, kind ?? null, localId ?? null]);
}

function retainRecord(previous: SessionSystemRecordStored | undefined, next: SessionSystemRecordStored) {
    return previous?.id === next.id && previous.revision === next.revision ? previous : next;
}
function retainValue(previous: RecordValue | null, next: RecordValue): RecordValue {
    if ('source' in next) return previous && 'source' in previous && JSON.stringify(previous) === JSON.stringify(next) ? previous : next;
    if (!('records' in next)) return retainRecord(previous && !('records' in previous) && !('source' in previous) ? previous : undefined, next);
    if (!previous || !('records' in previous)) return next;
    const byId = new Map(previous.records.map((record) => [record.id, record]));
    const records = next.records.map((record) => retainRecord(byId.get(record.id), record));
    if (records.length === previous.records.length && records.every((record, index) => record === previous.records[index]) && next.nextCursor === previous.nextCursor && next.hasNext === previous.hasNext) return previous;
    return { ...next, records };
}

/**
 * A read that could not complete (`offline` is only the transport's name for a
 * thrown request) or a retryable server answer. Neither proves the retained
 * record gone, nor the Home unreachable.
 */
function isTransientFailure(result: FetchError): boolean {
    return result.status === 'offline' || (result.status === 'server_error' && result.retryable);
}

export type SessionSystemRecordRepositoryOptions = SessionSystemRecordTransportOptions & Readonly<{
    /**
     * The app's existing sync backoff (`SyncTuning.invalidateSyncBackoff*`).
     * When given, an observed query that failed transiently re-reads on that
     * schedule until it answers or loses its last observer.
     */
    retryBackoff?: Readonly<{ minDelayMs: number; maxDelayMs: number }>;
}>;

/** Runtime projection retained for one captured Server/Account lifetime. */
export function createSessionSystemRecordRepository(options: SessionSystemRecordRepositoryOptions) {
    const transport = createSessionSystemRecordTransport(options);
    const sessions = new Map<string, SessionEntries>();
    // Opening follows retained record identity, never a separate content store.
    // Weak keys release decoded bytes with their retained record. Unmounting
    // stops observation work, not the data needed for a scroll/panel remount.
    const surfaceItemOpenings = new WeakMap<SessionSystemRecordStored, {
        context: SessionStoredContentContext | null;
        result: ReturnType<typeof openSessionSurfaceItemRecord>;
        settled?: Awaited<ReturnType<typeof openSessionSurfaceItemRecord>>;
    }>();
    const sameContext = (left: SessionStoredContentContext | null, right: SessionStoredContentContext | null) => left === right
        || (left?.mode === right?.mode && (right?.mode !== 'e2ee' || (left?.mode === 'e2ee' && left.encryption === right.encryption)));
    let retired = false;
    // A surface may address an identity-bearing Home by its device-local profile id
    // while this scope names it by its published identity; both are the same Home.
    const isScopeHome = (session: SessionAddress) => areServerProfileIdentifiersEquivalent(session.serverId, options.scope.serverId);
    const empty: SessionSystemRecordRepositoryEntry<never> = { data: null, freshness: 'stale', reachability: 'unknown', loading: 'idle', lastError: null };
    const forbidden: SessionSystemRecordRepositoryEntry<never> = { ...empty, lastError: { status: 'forbidden' } };
    function sessionEntries(session: SessionAddress, create: boolean): SessionEntries | null {
        if (retired || !isScopeHome(session)) return null;
        let retained = sessions.get(session.sessionId);
        if (!retained && create) {
            retained = { queries: new Map(), lists: new Map(), legacyWorkflows: new Set(), boardInventoryPages: new Set() };
            sessions.set(session.sessionId, retained);
        }
        return retained ?? null;
    }
    function boardCount(session: SessionAddress, create: boolean): BoardCount | null {
        const retained = sessionEntries(session, create);
        if (!retained) return null;
        if (!retained.boardCount && create) retained.boardCount = { value: null, listeners: new Set(), holders: new Set(), attempted: false };
        return retained.boardCount ?? null;
    }
    function publishBoardCount(count: BoardCount, value: number | null) {
        if (count.value === value) return;
        count.value = value;
        for (const listener of count.listeners) {
            try { listener(); } catch { /* An optional projection observer cannot stop sibling delivery. */ }
        }
    }
    function invalidateBoardCount(session: SessionAddress) {
        const count = boardCount(session, false);
        if (!count) return;
        if (count.request?.readers === 0) count.request.controller.abort();
        count.request = undefined;
        publishBoardCount(count, null);
    }
    function retainCompleteBoardInventory(session: SessionAddress) {
        const retained = sessionEntries(session, false);
        if (!retained) return;
        const pages = [...retained.boardInventoryPages].filter(entry => entry.snapshot.freshness === 'fresh' && entry.snapshot.lastError === null);
        for (const first of pages) {
            if (first.query.type !== 'list' || first.query.cursor) continue;
            const firstQuery = first.query;
            let entry: Entry | undefined = first;
            const seen = new Set<Entry>();
            const ids = new Set<string>();
            while (entry && !seen.has(entry)) {
                seen.add(entry);
                const data: RecordValue | null = entry.snapshot.data;
                if (!data || !('records' in data)) break;
                for (const record of data.records) {
                    if (record.address.owner === 'host' && record.address.namespace === 'surface' && record.address.kind === 'item.v1') ids.add(record.id);
                }
                if (!data.hasNext) {
                    const count = boardCount(session, true)!;
                    if (count.request?.readers === 0) count.request.controller.abort();
                    count.request = undefined;
                    publishBoardCount(count, ids.size);
                    return;
                }
                const cursor: SessionSystemRecordStoredPageResponse['nextCursor'] = data.nextCursor;
                entry = cursor ? pages.find(page => page.query.type === 'list' && page.query.cursor === cursor
                    && page.query.kind === firstQuery.kind && page.query.limit === firstQuery.limit) : undefined;
            }
        }
    }
    function requestBoardItemCount(session: SessionAddress, signal?: AbortSignal, acquisition = false): Promise<SessionSystemRecordFetchResult<SessionSystemRecordCountResponse>> {
        const count = boardCount(session, true);
        if (!count) return Promise.resolve({ status: 'forbidden' });
        if (signal?.aborted) return Promise.resolve({ status: 'offline' });
        if (!count.request) {
            const controller = new AbortController();
            const request = { controller, readers: 0, promise: Promise.resolve<SessionSystemRecordFetchResult<SessionSystemRecordCountResponse>>({ status: 'offline' }) };
            request.promise = transport.countBoardItems(session, controller.signal).then(result => {
                if (retired || controller.signal.aborted) return { status: 'forbidden' } as const;
                if (count.request === request && (request.readers > 0
                    || [...count.holders].some(holder => holder.isCurrent() && holder.readCapabilities()?.readTranscript === true))) {
                    publishBoardCount(count, result.status === 'ok' ? result.value.count : null);
                }
                return result;
            }).finally(() => {
                if (count.request === request) count.request = undefined;
            });
            count.request = request;
        }
        const request = count.request;
        if (acquisition) return request.promise;
        request.readers++;
        let released = false;
        const release = () => {
            if (released) return;
            released = true;
            request.readers--;
            if (request.readers === 0 && count.holders.size === 0 && count.request === request) {
                request.controller.abort();
                count.request = undefined;
            }
        };
        if (signal?.aborted) release(); else signal?.addEventListener('abort', release, { once: true });
        return request.promise.then(result => signal?.aborted ? { status: 'offline' } as const : result).finally(() => {
            signal?.removeEventListener('abort', release);
            release();
        });
    }
    function lookup(session: SessionAddress, query: SessionSystemRecordQuery, create: boolean): Entry | null {
        const retained = sessionEntries(session, create);
        if (!retained) return null;
        const queries = retained.queries;
        const key = queryKey(query);
        let entry = queries.get(key);
        if (!entry && create) {
            entry = { session, query, snapshot: empty, listeners: new Set(), invalidatedWhileLoading: false, transientFailures: 0 };
            queries.set(key, entry);
            if (query.type === 'list') {
                const selector = listSelectorKey(query.namespace, query.kind, query.localId);
                let pages = retained.lists.get(selector);
                if (!pages) { pages = new Set(); retained.lists.set(selector, pages); }
                pages.add(entry);
                // Preserve the existing inventory precedence (query insertion order)
                // while excluding unrelated queries from scalar count reuse.
                if (query.namespace === 'surface' && (query.kind === undefined || query.kind === 'item.v1')
                    && query.localId === undefined) retained.boardInventoryPages.add(entry);
            } else if (query.type === 'legacy_workflow') retained.legacyWorkflows.add(entry);
        }
        return entry ?? null;
    }
    function publish(entry: Entry, snapshot: Entry['snapshot']) {
        entry.snapshot = snapshot;
        for (const listener of entry.listeners) {
            try {
                listener();
            } catch {
                // Projection observers are optional. One consumer must not abort
                // sibling delivery or the AccountChange cursor that invalidated it.
            }
        }
    }
    function retainObservedValue(entry: Entry, next: RecordValue): RecordValue {
        if ('source' in next) return retainValue(entry.snapshot.data, next);
        // A list placement and an addressed reply can receive the same revision
        // through different HTTP responses. Give both the existing record object
        // so their opening is shared without another inventory or record cache.
        const retained = new Map<string, SessionSystemRecordStored>();
        const key = (record: SessionSystemRecordStored) => JSON.stringify([record.id, record.revision]);
        for (const observed of sessions.get(entry.session.sessionId)?.queries.values() ?? []) {
            const value = observed.snapshot.data;
            if (!value || 'source' in value) continue;
            for (const record of 'records' in value ? value.records : [value]) retained.set(key(record), record);
        }
        const retain = (record: SessionSystemRecordStored) => retained.get(key(record)) ?? record;
        return retainValue(entry.snapshot.data, 'records' in next
            ? { ...next, records: next.records.map(retain) }
            : retain(next));
    }
    function clearRetry(entry: Entry) {
        if (entry.retryTimer === undefined) return;
        clearTimeout(entry.retryTimer);
        entry.retryTimer = undefined;
    }
    function scheduleRetry(entry: Entry): boolean {
        const backoff = options.retryBackoff;
        if (!backoff || retired || entry.listeners.size === 0 || entry.retryTimer !== undefined) return false;
        const delayMs = linearBackoffDelay(entry.transientFailures, backoff.minDelayMs, Math.max(backoff.minDelayMs, backoff.maxDelayMs), 50);
        entry.retryTimer = setTimeout(() => {
            entry.retryTimer = undefined;
            if (!retired && entry.listeners.size > 0) void refresh(entry.session, entry.query);
        }, delayMs);
        return true;
    }
    function refresh(session: SessionAddress, query: SessionSystemRecordQuery): Promise<void> {
        const entry = lookup(session, query, true);
        if (!entry) return Promise.resolve();
        if (entry.pending) return entry.pending;
        clearRetry(entry);
        publish(entry, { ...entry.snapshot, loading: entry.snapshot.data === null ? 'initial' : 'refreshing' });
        const operation = query.type === 'read' ? transport.read(session, query.address)
            : query.type === 'legacy_workflow' ? readLegacyWorkflowSystemRecord(options, session, query.localId)
                : transport.list(session, query);
        entry.pending = operation.then((result) => {
            if (retired) return;
            if (result.status === 'ok') {
                entry.transientFailures = 0;
                publish(entry, { data: retainObservedValue(entry, result.value), loading: 'idle', freshness: entry.invalidatedWhileLoading ? 'stale' : 'fresh', reachability: 'reachable', lastError: null });
                if (query.type === 'list' && query.namespace === 'surface' && (query.kind === undefined || query.kind === 'item.v1')) retainCompleteBoardInventory(session);
            } else if (isTransientFailure(result)) {
                // A failed read never proves absence. The last record stays, its freshness is
                // whatever invalidation made it (a failure does not stale it), and reachability
                // is not demoted: no request answered "unreachable", one simply did not finish.
                entry.transientFailures += 1;
                const retrying = scheduleRetry(entry);
                const previous = entry.snapshot;
                publish(entry, {
                    data: previous.data,
                    loading: !retrying ? 'idle' : previous.data === null ? 'initial' : 'refreshing',
                    freshness: previous.data === null || entry.invalidatedWhileLoading ? 'stale' : previous.freshness,
                    reachability: previous.data === null && result.status === 'offline' ? 'unknown' : 'reachable',
                    lastError: result,
                });
            } else {
                entry.transientFailures = 0;
                publish(entry, { ...entry.snapshot, data: result.status === 'forbidden' || result.status === 'not_found' ? null : entry.snapshot.data, loading: 'idle', freshness: 'stale', reachability: 'reachable', lastError: result });
                if (result.status === 'forbidden' || result.status === 'not_found') invalidateBoardCount(session);
            }
        }).finally(() => {
            entry.pending = undefined;
            const refreshAgain = entry.invalidatedWhileLoading;
            entry.invalidatedWhileLoading = false;
            if (!retired && refreshAgain && entry.listeners.size > 0) void refresh(session, query);
        });
        return entry.pending;
    }
    function invalidateEntry(entry: Entry) {
        entry.invalidatedWhileLoading = Boolean(entry.pending);
        if (entry.snapshot.freshness !== 'stale') publish(entry, { ...entry.snapshot, freshness: 'stale' });
        if (entry.listeners.size > 0 && !entry.pending) void refresh(entry.session, entry.query);
    }
    function invalidate(session: SessionAddress, addresses?: readonly HostSessionSystemRecordAddress[]) {
        if (retired || !isScopeHome(session)) return;
        if (!addresses || addresses.some(address => address.namespace === 'surface' && address.kind === 'item.v1')) invalidateBoardCount(session);
        const retained = sessions.get(session.sessionId);
        if (!retained) return;
        if (!addresses) {
            for (const entry of retained.queries.values()) invalidateEntry(entry);
            return;
        }
        const affected = new Set<Entry>();
        for (const address of addresses) {
            const direct = retained.queries.get(queryKey({ type: 'read', address }));
            if (direct) affected.add(direct);
            if (address.namespace === 'activity' && address.kind === 'workflow_run.v1') {
                const legacy = retained.queries.get(queryKey({ type: 'legacy_workflow', localId: address.localId }));
                if (legacy) affected.add(legacy);
            }
            // A list selects namespace plus optional kind/localId. Cursor and limit
            // distinguish its retained pages, not which addressed changes affect it.
            for (const kind of [undefined, address.kind]) for (const localId of [undefined, address.localId]) {
                for (const entry of retained.lists.get(listSelectorKey(address.namespace, kind, localId)) ?? []) affected.add(entry);
            }
        }
        for (const entry of affected) invalidateEntry(entry);
    }
    return {
        scope: options.scope,
        readBoardItemCount(session: SessionAddress): number | null {
            return boardCount(session, false)?.value ?? null;
        },
        /** Passive in-process publication only: no transport demand, retries or watches. */
        subscribeBoardItemCount(session: SessionAddress, listener: () => void) {
            const count = boardCount(session, true);
            if (!count) return () => undefined;
            count.listeners.add(listener);
            return () => { count.listeners.delete(listener); };
        },
        /** One allowance shared by consumers of the currently mounted Session address. */
        acquireBoardItemCount(session: SessionAddress, authority: BoardCountAuthority) {
            const count = boardCount(session, true);
            if (!count || !authority.isCurrent() || authority.readCapabilities()?.readTranscript !== true) return () => undefined;
            const holder = { ...authority };
            count.holders.add(holder);
            if (!count.attempted) {
                count.attempted = true;
                if (count.value === null) void requestBoardItemCount(session, undefined, true);
            }
            return () => {
                count.holders.delete(holder);
                if (count.holders.size === 0) {
                    if (count.request?.readers === 0) {
                        count.request.controller.abort();
                        count.request = undefined;
                    }
                    count.attempted = false;
                }
            };
        },
        fetchBoardItemCount: (session: SessionAddress, signal?: AbortSignal) => requestBoardItemCount(session, signal),
        openSurfaceItem(record: SessionSystemRecordStored, context: SessionStoredContentContext | null) {
            const opening = surfaceItemOpenings.get(record);
            if (opening && sameContext(opening.context, context)) return opening.result;
            const result = openSessionSurfaceItemRecord(record, context);
            const next: NonNullable<ReturnType<typeof surfaceItemOpenings.get>> = { context, result };
            surfaceItemOpenings.set(record, next);
            void result.then(value => { if (!retired) next.settled = value; });
            return result;
        },
        readOpenedSurfaceItem(record: SessionSystemRecordStored, context: SessionStoredContentContext | null) {
            if (retired) return undefined;
            const opening = surfaceItemOpenings.get(record);
            return opening && sameContext(opening.context, context) ? opening.settled : undefined;
        },
        /** Readers survive request release, but never credential/repository retirement. */
        retainObservationAuthority(session: SessionAddress, authority: NonNullable<SessionEntries['authority']>) {
            const retained = sessionEntries(session, true);
            if (retained) retained.authority = authority;
        },
        readObservationAuthority(session: SessionAddress) {
            const authority = !retired && isScopeHome(session) ? sessions.get(session.sessionId)?.authority : undefined;
            return authority?.isCurrent() ? authority : null;
        },
        readSurfaceItemMeasurements(session: SessionAddress, itemId: string) {
            return lookup(session, { type: 'read', address: { owner: 'host', namespace: 'surface', kind: 'item.v1', localId: itemId } }, false)?.measurements;
        },
        reportSurfaceItemMeasurement(session: SessionAddress, itemId: string, kind: 'reply' | `intrinsic:${string}`, height: number) {
            if (!Number.isFinite(height) || height <= 0) return;
            const entry = lookup(session, { type: 'read', address: { owner: 'host', namespace: 'surface', kind: 'item.v1', localId: itemId } }, false);
            if (!entry?.snapshot.data) return;
            entry.measurements ??= {};
            entry.measurements[kind] = height;
        },
        /** Credential/reset owners retire this exact qualified projection. */
        isCurrent(): boolean {
            return !retired;
        },
        getSnapshot<Q extends SessionSystemRecordQuery>(session: SessionAddress, query: Q): SessionSystemRecordRepositoryEntry<SessionSystemRecordQueryValue<Q>> {
            // Query identity fixes the value type at creation and every refresh.
            if (retired || !isScopeHome(session)) {
                return forbidden as SessionSystemRecordRepositoryEntry<SessionSystemRecordQueryValue<Q>>;
            }
            return (lookup(session, query, false)?.snapshot ?? empty) as SessionSystemRecordRepositoryEntry<SessionSystemRecordQueryValue<Q>>;
        },
        refresh,
        subscribe(session: SessionAddress, query: SessionSystemRecordQuery, listener: () => void) {
            const entry = lookup(session, query, true);
            if (!entry) return () => undefined;
            entry.listeners.add(listener);
            if (entry.snapshot.freshness === 'stale') void refresh(session, query);
            return () => {
                entry.listeners.delete(listener);
                if (entry.listeners.size === 0) clearRetry(entry);
            };
        },
        invalidate,
        /** Released Homes without addressed publications wake their revisionless workflow reader through Session changes. */
        invalidateLegacyWorkflows(session: SessionAddress) {
            if (retired || !isScopeHome(session)) return;
            for (const entry of sessions.get(session.sessionId)?.legacyWorkflows ?? []) invalidateEntry(entry);
        },
        /** A content-free Home wake withdraws freshness, not retained bytes or access authority. */
        invalidateAll() {
            for (const sessionId of sessions.keys()) invalidate({ serverId: options.scope.serverId, sessionId });
        },
        refreshObserved(options?: Readonly<{ force?: boolean }>) {
            if (retired) return;
            for (const retained of sessions.values()) for (const entry of retained.queries.values()) {
                if (entry.listeners.size === 0) continue;
                if (options?.force !== true && entry.snapshot.freshness !== 'stale') continue;
                entry.invalidatedWhileLoading = Boolean(entry.pending);
                if (entry.snapshot.freshness !== 'stale') publish(entry, { ...entry.snapshot, freshness: 'stale' });
                if (!entry.pending) void refresh(entry.session, entry.query);
            }
        },
        notifyContentContextChanged(session: SessionAddress) {
            if (retired || !isScopeHome(session)) return;
            for (const entry of sessions.get(session.sessionId)?.queries.values() ?? []) publish(entry, { ...entry.snapshot });
        },
        retire() {
            retired = true;
            for (const retained of sessions.values()) if (retained.boardCount) {
                retained.boardCount.request?.controller.abort();
                publishBoardCount(retained.boardCount, null);
                retained.boardCount.listeners.clear();
                retained.boardCount.holders.clear();
            }
            for (const retained of sessions.values()) for (const entry of retained.queries.values()) {
                clearRetry(entry);
                publish(entry, forbidden);
                entry.listeners.clear();
            }
            sessions.clear();
        },
    };
}
export type SessionSystemRecordRepository = ReturnType<typeof createSessionSystemRecordRepository>;
