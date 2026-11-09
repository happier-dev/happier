import { SessionBoardLayoutV1StoredSchema, type SessionBoardLayoutV1 } from '@happier-dev/protocol/sessions/board/layout';
import type { SessionSurfaceItemV1 } from '@happier-dev/protocol/sessions/board/item';
import type { SessionSystemRecordStoredPageResponse } from '@happier-dev/protocol/sessions/system/records/sessionSystemRecordRoutes';
import { openSessionSystemRecord, type SessionSystemRecordPayloadResult } from '@/sync/domains/sessionSystemRecords/codec';
import { projectSessionBoard, type SessionBoardOpenedRecord } from '@/sync/domains/session/board';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import type {
    SessionSystemRecordQuery,
    SessionSystemRecordRepositoryEntry,
} from '@/sync/domains/sessionSystemRecords/repository';
import type { SessionBoardSnapshot } from '@/sync/domains/session/board';
import { projectSessionSystemRecordFetchFailure, type SessionSystemRecordFetchResult } from '@/sync/domains/sessionSystemRecords/transport';
import type { SessionSystemRecordObservationBase, SessionSystemRecordUnavailableReason } from '@/sync/domains/sessionSystemRecords/observation';

// The credential-resolution kinds are read from their own owner rather than
// copied here, so a new non-bound kind can never silently fall outside the
// Board's unavailable reasons.
export type SessionBoardBindingUnavailableReason = SessionSystemRecordUnavailableReason | 'board_feature_disabled';
export type SessionBoardBinding = Readonly<{ status: 'ready'; snapshot: SessionBoardSnapshot }>
    | Readonly<{ status: 'unavailable'; reason: SessionBoardBindingUnavailableReason }>;
export type SessionBoardObservationOptions = SessionSystemRecordObservationBase & Readonly<{
    /** Unopened/retained presentation never inventories Session content. */
    demanded?: boolean;
    onChange: (binding: SessionBoardBinding) => void;
}>;

function toBoardUnavailableReason(
    reason: Exclude<SessionSystemRecordFetchResult<never>, { status: 'ok' }>['status'],
): SessionBoardBindingUnavailableReason {
    return reason === 'feature_disabled' ? 'board_feature_disabled' : reason;
}

/** A placement-local projection; all stored bytes, requests and invalidation stay in the repository. */
export function observeSessionBoard(options: SessionBoardObservationOptions): () => void {
    if (options.demanded === false) return () => {};
    type ListQuery = Extract<SessionSystemRecordQuery, { type: 'list' }>;
    type Page = SessionSystemRecordRepositoryEntry<SessionSystemRecordStoredPageResponse>;
    type ObservedPage = { query: ListQuery; snapshot: Page; stop: () => void };
    const pages = new Map<string, ObservedPage>();
    let stopped = false;
    let queued = false;
    let previous: SessionBoardSnapshot | undefined;
    let currentJob: object | null = null;
    const emit = (binding: SessionBoardBinding) => { if (!stopped) options.onChange(binding); };
    const unavailable = (reason: SessionBoardBindingUnavailableReason) => {
        if (reason === 'forbidden' || reason === 'not_found' || reason === 'board_feature_disabled') previous = undefined;
        emit({ status: 'unavailable', reason });
    };
    const initialCapabilities = options.readCapabilities();
    // The same Home can be addressed by its profile id or its identity id; the one equivalence owner decides.
    if (!areServerProfileIdentifiersEquivalent(options.session.serverId, options.repository.scope.serverId)
        || !initialCapabilities?.readTranscript || !options.isCurrent()) {
        unavailable('forbidden');
        return () => { stopped = true; };
    }

    function decode<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, value: unknown): SessionSystemRecordPayloadResult<T> {
        if (value && typeof value === 'object' && 'v' in value && typeof value.v === 'number' && value.v !== 1) {
            return { status: 'unsupported_version', version: value.v };
        }
        const parsed = schema.safeParse(value);
        return parsed.success ? { status: 'ready', value: parsed.data } : { status: 'malformed' };
    }
    function changed(page: ObservedPage) {
        const next = options.repository.getSnapshot(options.session, page.query);
        page.snapshot = next;
        const currentCapabilities = options.readCapabilities();
        if (
            !options.isCurrent()
            || !currentCapabilities?.readTranscript
            || (next.lastError !== null && next.lastError.status !== 'offline' && next.lastError.status !== 'server_error')
        ) {
            currentJob = null;
            unavailable(next.lastError ? toBoardUnavailableReason(next.lastError.status) : 'forbidden');
            return;
        }
        schedule();
    }
    function observe(cursor: string): ObservedPage {
        const existing = pages.get(cursor);
        if (existing) return existing;
        const query: ListQuery = { type: 'list', namespace: 'surface', ...(cursor ? { cursor } : {}) };
        const page: ObservedPage = { query, snapshot: options.repository.getSnapshot(options.session, query), stop: () => {} };
        pages.set(cursor, page);
        page.stop = options.repository.subscribe(options.session, query, () => changed(page));
        page.snapshot = options.repository.getSnapshot(options.session, query);
        return page;
    }
    function schedule() {
        currentJob = null;
        if (queued || stopped) return;
        queued = true;
        const job = {};
        void Promise.resolve().then(async () => {
            queued = false;
            if (stopped) return;
            currentJob = job;
            const isCurrent = () => !stopped && currentJob === job && options.isCurrent();
            const currentCapabilities = options.readCapabilities();
            if (!options.isCurrent() || !currentCapabilities?.readTranscript) {
                unavailable('forbidden');
                return;
            }
            const authority = { contentContext: options.readContentContext(), capabilities: currentCapabilities };
            const chain: Page[] = [];
            const seen = new Set<string>();
            let cursor = '';
            let complete = false;
            while (!seen.has(cursor)) {
                seen.add(cursor);
                const page = observe(cursor).snapshot;
                chain.push(page);
                if (!page.data) break;
                if (!page.data.hasNext) { complete = true; break; }
                if (!page.data.nextCursor) break;
                cursor = page.data.nextCursor;
            }
            for (const [key, page] of pages) if (!seen.has(key)) { page.stop(); pages.delete(key); }
            const denied = chain.find(page => page.lastError !== null
                && page.lastError.status !== 'offline' && page.lastError.status !== 'server_error');
            if (denied) { unavailable(toBoardUnavailableReason(denied.lastError!.status)); return; }
            const firstFailure = chain.find(page => !page.data && page.lastError)?.lastError;
            if (firstFailure && (!previous || previous.layoutState.kind === 'loading') && chain.every(page => !page.data)) {
                unavailable(toBoardUnavailableReason(firstFailure.status));
                return;
            }
            const freshness = chain.some(page => page.freshness === 'stale') ? 'stale' : 'fresh';
            const reachability = chain.some(page => page.reachability === 'offline') ? 'offline'
                : chain.every(page => page.reachability === 'reachable') ? 'reachable' : 'unknown';
            const loading = chain.some(page => page.loading !== 'idle') ? (previous ? 'refreshing' : 'initial') : 'idle';
            let layout: SessionBoardOpenedRecord<SessionBoardLayoutV1> | undefined;
            const items = new Map<string, SessionBoardOpenedRecord<SessionSurfaceItemV1>>();
            for (const page of chain) for (const record of page.data?.records ?? []) {
                if (record.address.owner !== 'host') continue;
                if (record.address.kind === 'layout.v1' && record.address.localId === 'layout') {
                    layout = { revision: record.revision, outcome: await openSessionSystemRecord({ record, address: record.address,
                        context: authority.contentContext, decode: value => decode(SessionBoardLayoutV1StoredSchema, value) }) };
                } else if (record.address.kind === 'item.v1') {
                    items.set(record.address.localId, { revision: record.revision,
                        outcome: await options.repository.openSurfaceItem(record, authority.contentContext) });
                }
            }
            if (!isCurrent()) return;
            const snapshot: SessionBoardSnapshot = !complete && previous && previous.layoutState.kind !== 'loading'
                ? { ...previous, freshness, reachability, loading, incomplete: true, capabilities: authority.capabilities, canEdit: authority.capabilities.editSessionRecords }
                : projectSessionBoard({ layout, items, capabilities: authority.capabilities, freshness, reachability, loading, incomplete: !complete }, previous);
            previous = snapshot;
            emit({ status: 'ready', snapshot });
        }).catch(error => {
            if (!stopped && currentJob === job) unavailable(toBoardUnavailableReason(projectSessionSystemRecordFetchFailure(error).status));
        });
    }
    observe('');
    schedule();
    return () => {
        stopped = true;
        currentJob = null;
        for (const page of pages.values()) page.stop();
        pages.clear();
    };
}
