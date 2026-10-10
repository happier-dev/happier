import type { SessionBoardItemProjection } from './sessionBoardProjection';
import { deriveSessionBoardItemState } from './sessionBoardItemState';
import type { SessionSystemRecordObservationBase, SessionSystemRecordUnavailableReason } from '@/sync/domains/sessionSystemRecords/observation';
import type { SessionSystemRecordRepositoryEntry } from '@/sync/domains/sessionSystemRecords/repository';
import type { SessionSystemRecordStored } from '@happier-dev/protocol';

export type SessionSurfaceItemBinding = Readonly<{
    status: 'ready';
    item: SessionBoardItemProjection;
    freshness: 'fresh' | 'stale';
    reachability: 'reachable' | 'offline' | 'unknown';
    loading: 'idle' | 'initial' | 'refreshing';
}> | Readonly<{ status: 'unavailable'; reason: SessionSystemRecordUnavailableReason }>;

/** Observe one exact Session content address, without Board inventory or admission. */
export function observeSessionSurfaceItem(options: SessionSystemRecordObservationBase & Readonly<{
    itemId: string;
    onChange: (binding: SessionSurfaceItemBinding) => void;
}>): () => void {
    const query = { type: 'read', address: { owner: 'host', namespace: 'surface', kind: 'item.v1', localId: options.itemId } } as const;
    let stopped = false;
    let currentJob: object | null = null;
    let snapshot: SessionSystemRecordRepositoryEntry<SessionSystemRecordStored> = options.repository.getSnapshot(options.session, query);
    let context = options.authority.contentContext;
    let authorityReachability: 'reachable' | 'offline' = 'reachable';
    let previous: Extract<SessionSurfaceItemBinding, { status: 'ready' }> | undefined;
    let renewal: ReturnType<typeof options.renewAuthority> | null = null;
    const emit = (binding: SessionSurfaceItemBinding) => { if (!stopped) options.onChange(binding); };
    const authorized = () => options.isCurrent() && options.repository.isCurrent() && options.readCapabilities()?.readTranscript === true;
    function changed() {
        const next = options.repository.getSnapshot(options.session, query);
        const before = snapshot;
        snapshot = next;
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
        const needsAuthority = (before.freshness === 'fresh' && next.freshness === 'stale')
            || (before.data !== null && before.loading !== 'refreshing' && next.loading === 'refreshing');
        const refreshingAuthority = needsAuthority || renewal !== null;
        if (previous && (refreshingAuthority || previous.freshness !== next.freshness || previous.loading !== next.loading || previous.reachability !== next.reachability)) {
            previous = { ...previous, freshness: refreshingAuthority ? 'stale' : next.freshness, loading: next.loading, reachability: authorityReachability === 'offline' ? 'offline' : next.reachability };
            emit(previous);
        }
        context = options.readContentContext();
        void (async () => {
            if (needsAuthority) {
                const pending = renewal ??= options.renewAuthority();
                const renewed = await pending;
                if (renewal === pending) renewal = null;
                if (!isCurrent()) return;
                if (renewed.status === 'ok') { context = renewed.value.contentContext; authorityReachability = 'reachable'; }
                else if (renewed.status === 'offline' && previous) authorityReachability = 'offline';
                else if (renewed.status !== 'offline' || !previous) { emit({ status: 'unavailable', reason: renewed.status }); return; }
            } else if (renewal) {
                const renewed = await renewal;
                if (!isCurrent()) return;
                if (renewed.status === 'ok') { context = renewed.value.contentContext; authorityReachability = 'reachable'; }
                else if (renewed.status === 'offline' && previous) authorityReachability = 'offline';
                else if (renewed.status !== 'offline' || !previous) { emit({ status: 'unavailable', reason: renewed.status }); return; }
            }
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
            previous = { status: 'ready', item: retained, freshness: authorityReachability === 'offline' ? 'stale' : next.freshness,
                reachability: authorityReachability === 'offline' ? 'offline' : next.reachability, loading: next.loading };
            emit(previous);
        })().catch(() => { if (isCurrent()) emit({ status: 'unavailable', reason: 'invalid_response' }); });
    }
    if (!authorized()) { emit({ status: 'unavailable', reason: 'forbidden' }); return () => { stopped = true; }; }
    const unsubscribe = options.repository.subscribe(options.session, query, changed);
    changed();
    return () => { stopped = true; currentJob = null; unsubscribe(); };
}
