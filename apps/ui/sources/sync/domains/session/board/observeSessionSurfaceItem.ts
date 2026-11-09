import type { SessionBoardItemProjection } from './sessionBoardProjection';
import { deriveSessionBoardItemState } from './sessionBoardItemState';
import type { SessionSystemRecordObservationBase, SessionSystemRecordUnavailableReason } from '@/sync/domains/sessionSystemRecords/observation';
import { projectSessionSystemRecordFetchFailure } from '@/sync/domains/sessionSystemRecords/transport';

export type SessionSurfaceItemBinding = Readonly<{
    status: 'ready';
    item: SessionBoardItemProjection;
    freshness: 'fresh' | 'stale';
    reachability: 'reachable' | 'offline' | 'unknown';
    loading: 'idle' | 'initial' | 'refreshing';
}> | Readonly<{ status: 'unavailable'; reason: SessionSystemRecordUnavailableReason }>;

/** The already-opened record, guarded by the same authority as its observer. No work starts here. */
export function readRetainedSessionSurfaceItem(options: Pick<SessionSystemRecordObservationBase,
    'session' | 'repository' | 'isCurrent' | 'readCapabilities' | 'readContentContext'> & Readonly<{ itemId: string }>): SessionSurfaceItemBinding | null {
    if (!options.isCurrent() || !options.repository.isCurrent() || options.readCapabilities()?.readTranscript !== true) {
        return { status: 'unavailable', reason: 'forbidden' };
    }
    const snapshot = options.repository.getSnapshot(options.session, { type: 'read', address: {
        owner: 'host', namespace: 'surface', kind: 'item.v1', localId: options.itemId,
    } });
    if (snapshot.lastError && (!snapshot.data || (snapshot.lastError.status !== 'offline' && snapshot.lastError.status !== 'server_error'))) {
        return snapshot.lastError.status === 'not_found'
            ? { status: 'ready', item: { itemId: options.itemId, revision: null, state: { kind: 'removed' } },
                freshness: snapshot.freshness, reachability: snapshot.reachability, loading: snapshot.loading }
            : { status: 'unavailable', reason: snapshot.lastError.status };
    }
    const outcome = snapshot.data && options.repository.readOpenedSurfaceItem(snapshot.data, options.readContentContext());
    if (!outcome || !snapshot.data) return null;
    return { status: 'ready', item: { itemId: options.itemId, revision: snapshot.data.revision,
        state: deriveSessionBoardItemState({ revision: snapshot.data.revision, outcome }, { complete: false }) },
        freshness: snapshot.freshness, reachability: snapshot.reachability, loading: snapshot.loading };
}

/** Observe one exact Session content address, without Board inventory or admission. */
export function observeSessionSurfaceItem(options: SessionSystemRecordObservationBase & Readonly<{
    itemId: string;
    onChange: (binding: SessionSurfaceItemBinding) => void;
}>): () => void {
    const query = { type: 'read', address: { owner: 'host', namespace: 'surface', kind: 'item.v1', localId: options.itemId } } as const;
    let stopped = false;
    let currentJob: object | null = null;
    const retained = readRetainedSessionSurfaceItem(options);
    let previous = retained?.status === 'ready' ? retained : undefined;
    const emit = (binding: SessionSurfaceItemBinding) => { if (!stopped) options.onChange(binding); };
    const authorized = () => options.isCurrent() && options.repository.isCurrent() && options.readCapabilities()?.readTranscript === true;
    function changed() {
        const next = options.repository.getSnapshot(options.session, query);
        const job = {};
        currentJob = job;
        const isCurrent = () => !stopped && currentJob === job && authorized();
        if (!authorized()) { emit({ status: 'unavailable', reason: 'forbidden' }); return; }
        const error = next.lastError;
        if (error && (!next.data || (error.status !== 'offline' && error.status !== 'server_error'))) {
            if (error.status === 'not_found') emit({ status: 'ready', item: { itemId: options.itemId, revision: null, state: { kind: 'removed' } }, freshness: next.freshness, reachability: next.reachability, loading: next.loading });
            else emit({ status: 'unavailable', reason: error.status });
            return;
        }
        if (previous && (previous.freshness !== next.freshness || previous.loading !== next.loading || previous.reachability !== next.reachability)) {
            previous = { ...previous, freshness: next.freshness, loading: next.loading, reachability: next.reachability };
            emit(previous);
        }
        const context = options.readContentContext();
        void (async () => {
            const outcome = next.data ? await options.repository.openSurfaceItem(next.data, context) : undefined;
            if (!isCurrent()) return;
            const item: SessionBoardItemProjection = {
                itemId: options.itemId, revision: next.data?.revision ?? null,
                state: deriveSessionBoardItemState(outcome && next.data ? { revision: next.data.revision, outcome } : undefined, { complete: false }),
            };
            const retained = previous?.item.revision === item.revision && previous.item.state.kind === item.state.kind
                && (item.state.kind !== 'ready' || (previous.item.state.kind === 'ready' && previous.item.state.item === item.state.item))
                && (item.state.kind !== 'unopenable' || (previous.item.state.kind === 'unopenable' && previous.item.state.reason === item.state.reason))
                && (item.state.kind !== 'unsupported' || (previous.item.state.kind === 'unsupported' && previous.item.state.version === item.state.version))
                ? previous.item : item;
            previous = { status: 'ready', item: retained, freshness: next.freshness,
                reachability: next.reachability, loading: next.loading };
            emit(previous);
        })().catch(error => { if (isCurrent()) emit({ status: 'unavailable', reason: projectSessionSystemRecordFetchFailure(error).status }); });
    }
    if (!authorized()) { emit({ status: 'unavailable', reason: 'forbidden' }); return () => { stopped = true; }; }
    if (retained) emit(retained);
    const unsubscribe = options.repository.subscribe(options.session, query, changed);
    changed();
    return () => { stopped = true; currentJob = null; unsubscribe(); };
}
