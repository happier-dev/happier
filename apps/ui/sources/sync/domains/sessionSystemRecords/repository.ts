import type { SessionSystemRecordStored, SessionSystemRecordStoredPageResponse } from '@happier-dev/protocol';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
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
};

function queryKey(query: SessionSystemRecordQuery): string {
    if (query.type === 'legacy_workflow') return JSON.stringify(['legacy_workflow', query.localId]);
    return query.type === 'read'
        ? JSON.stringify(['read', query.address.namespace, query.address.kind, query.address.localId])
        : JSON.stringify(['list', query.namespace, query.kind ?? null, query.localId ?? null, query.limit ?? 100, query.cursor ?? null]);
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

/** Runtime projection owned by one captured Server/Account lifetime. */
export function createSessionSystemRecordRepository(options: SessionSystemRecordTransportOptions) {
    const transport = createSessionSystemRecordTransport(options);
    const sessions = new Map<string, Map<string, Entry>>();
    // Opening follows retained record identity, never a separate content store.
    // Weak keys release decoded bytes with the last observed repository entry.
    const surfaceItemOpenings = new WeakMap<SessionSystemRecordStored, Readonly<{
        context: SessionStoredContentContext | null;
        result: ReturnType<typeof openSessionSurfaceItemRecord>;
    }>>();
    let retired = false;
    // A surface may address an identity-bearing Home by its device-local profile id
    // while this scope names it by its published identity; both are the same Home.
    const isScopeHome = (session: SessionAddress) => areServerProfileIdentifiersEquivalent(session.serverId, options.scope.serverId);
    const empty: SessionSystemRecordRepositoryEntry<never> = { data: null, freshness: 'stale', reachability: 'unknown', loading: 'idle', lastError: null };
    const forbidden: SessionSystemRecordRepositoryEntry<never> = { ...empty, lastError: { status: 'forbidden' } };
    function lookup(session: SessionAddress, query: SessionSystemRecordQuery, create: boolean): Entry | null {
        if (retired || !isScopeHome(session)) return null;
        let queries = sessions.get(session.sessionId);
        if (!queries) {
            if (!create) return null;
            queries = new Map();
            sessions.set(session.sessionId, queries);
        }
        const key = queryKey(query);
        let entry = queries.get(key);
        if (!entry && create) {
            entry = { session, query, snapshot: empty, listeners: new Set(), invalidatedWhileLoading: false };
            queries.set(key, entry);
        }
        return entry ?? null;
    }
    function retireIfUnobserved(entry: Entry) {
        if (entry.listeners.size > 0 || entry.pending) return;
        const queries = sessions.get(entry.session.sessionId);
        if (!queries) return;
        const key = queryKey(entry.query);
        if (queries.get(key) !== entry) return;
        queries.delete(key);
        if (queries.size === 0) sessions.delete(entry.session.sessionId);
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
        for (const observed of sessions.get(entry.session.sessionId)?.values() ?? []) {
            const value = observed.snapshot.data;
            if (!value || 'source' in value) continue;
            for (const record of 'records' in value ? value.records : [value]) retained.set(key(record), record);
        }
        const retain = (record: SessionSystemRecordStored) => retained.get(key(record)) ?? record;
        return retainValue(entry.snapshot.data, 'records' in next
            ? { ...next, records: next.records.map(retain) }
            : retain(next));
    }
    function refresh(session: SessionAddress, query: SessionSystemRecordQuery): Promise<void> {
        const entry = lookup(session, query, true);
        if (!entry) return Promise.resolve();
        if (entry.pending) return entry.pending;
        publish(entry, { ...entry.snapshot, loading: entry.snapshot.data === null ? 'initial' : 'refreshing' });
        const operation = query.type === 'read' ? transport.read(session, query.address)
            : query.type === 'legacy_workflow' ? readLegacyWorkflowSystemRecord(options, session, query.localId)
                : transport.list(session, query);
        entry.pending = operation.then((result) => {
            if (retired) return;
            if (result.status === 'ok') {
                publish(entry, { data: retainObservedValue(entry, result.value), loading: 'idle', freshness: entry.invalidatedWhileLoading ? 'stale' : 'fresh', reachability: 'reachable', lastError: null });
            } else {
                publish(entry, { ...entry.snapshot, data: result.status === 'forbidden' || result.status === 'not_found' ? null : entry.snapshot.data, loading: 'idle', freshness: 'stale', reachability: result.status === 'offline' ? 'offline' : 'reachable', lastError: result });
            }
        }).finally(() => {
            entry.pending = undefined;
            const refreshAgain = entry.invalidatedWhileLoading;
            entry.invalidatedWhileLoading = false;
            if (!retired && refreshAgain && entry.listeners.size > 0) void refresh(session, query);
            retireIfUnobserved(entry);
        });
        return entry.pending;
    }
    return {
        scope: options.scope,
        openSurfaceItem(record: SessionSystemRecordStored, context: SessionStoredContentContext | null) {
            const opening = surfaceItemOpenings.get(record);
            const sameContext = opening && (opening.context === context || (opening.context?.mode === context?.mode
                && (context?.mode !== 'e2ee' || (opening.context?.mode === 'e2ee' && opening.context.encryption === context.encryption))));
            if (sameContext) return opening.result;
            const result = openSessionSurfaceItemRecord(record, context);
            surfaceItemOpenings.set(record, { context, result });
            return result;
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
                retireIfUnobserved(entry);
            };
        },
        invalidate(session: SessionAddress) {
            if (retired || !isScopeHome(session)) return;
            for (const entry of sessions.get(session.sessionId)?.values() ?? []) {
                entry.invalidatedWhileLoading = Boolean(entry.pending);
                publish(entry, { ...entry.snapshot, freshness: 'stale' });
                if (entry.listeners.size > 0 && !entry.pending) void refresh(session, entry.query);
            }
        },
        refreshObserved(options?: Readonly<{ force?: boolean }>) {
            if (retired) return;
            for (const queries of sessions.values()) for (const entry of queries.values()) {
                if (entry.listeners.size === 0) continue;
                if (options?.force !== true && entry.snapshot.freshness !== 'stale') continue;
                entry.invalidatedWhileLoading = Boolean(entry.pending);
                publish(entry, { ...entry.snapshot, freshness: 'stale' });
                if (!entry.pending) void refresh(entry.session, entry.query);
            }
        },
        notifyContentContextChanged(session: SessionAddress) {
            if (retired || !isScopeHome(session)) return;
            for (const entry of sessions.get(session.sessionId)?.values() ?? []) publish(entry, { ...entry.snapshot });
        },
        retire() {
            retired = true;
            for (const queries of sessions.values()) for (const entry of queries.values()) {
                publish(entry, forbidden);
                entry.listeners.clear();
            }
            sessions.clear();
        },
    };
}
export type SessionSystemRecordRepository = ReturnType<typeof createSessionSystemRecordRepository>;
