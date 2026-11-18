import * as React from 'react';
import type { WorkflowRunListResultV1 } from '@happier-dev/protocol/workflows/actionsV1';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { readServerAccountScopeOwnerLifetime } from '@/sync/domains/scope/serverAccountScope';
import { storage } from '@/sync/domains/state/storageStore';
import { retainDeep } from '@/sync/domains/state/structuralSharing';
import { createWorkflowActivityProjection } from '@/sync/engine/workflows/workflowActivityProjection';
import { getWorkflowActivitySource } from '@/sync/engine/workflows/workflowActivitySource';
import type { WorkflowActivityPageInput, WorkflowActivitySource } from './workflowActivityTypes';

type FeedState = Readonly<{
    status: 'connecting' | 'live' | 'offline' | 'failed';
    listeningSince: number | null;
    retained: WorkflowRunListResultV1 | null;
    error: unknown;
    historyError: unknown;
    loadingMore: boolean;
    loadMoreError: unknown;
}>;
const INITIAL: FeedState = Object.freeze({ status: 'connecting', listeningSince: null,
    retained: null, error: null, historyError: null, loadingMore: false, loadMoreError: null });
const EMPTY_KEYS: readonly string[] = Object.freeze([]);
const subscribeInactive = () => () => {};
const owners = new WeakMap<ServerAccountScopeLifetime, ReturnType<typeof createFeed>>();

function createFeed(lifetime: ServerAccountScopeLifetime, source: WorkflowActivitySource) {
    const projection = createWorkflowActivityProjection();
    const listeners = new Set<() => void>();
    const demands = new Set<symbol>();
    let state = INITIAL;
    let close: (() => void) | null = null;
    let continuation: Promise<void> | null = null;
    const publish = (next: FeedState) => {
        next = retainDeep(state, next);
        if (next === state) return;
        state = next;
        for (const listener of listeners) listener();
    };
    const connectionStatus = (): FeedState['status'] => {
        const status = storage.getState().socketStatus;
        return status === 'connected' ? 'live' : status === 'connecting' || status === 'paused' ? 'connecting' : 'offline';
    };
    const releaseDemand = () => {
        const release = close;
        close = null;
        release?.();
        continuation = null;
        publish(INITIAL);
    };
    lifetime.onRetire(() => { demands.clear(); releaseDemand(); projection.clear(); });
    const readPage = async (input?: WorkflowActivityPageInput) => {
        if (close === null) return null;
        const opened = close;
        const page = await source.readPage(input);
        return close === opened ? page : null;
    };
    const loadMore = (): Promise<void> => {
        if (continuation) return continuation;
        const cursor = state.retained?.nextCursor;
        if (close === null || !cursor) return Promise.resolve();
        const opened = close;
        publish({ ...state, loadingMore: true, loadMoreError: null });
        const pending = source.loadMore().then(() => {
            if (close !== opened) return;
            publish({ ...state, loadingMore: false });
        }, error => {
            if (close === opened) publish({ ...state, loadingMore: false, loadMoreError: error });
        }).finally(() => { if (continuation === pending) continuation = null; });
        continuation = pending;
        return pending;
    };
    return {
        projection,
        getSnapshot: () => state,
        subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
        acquire() {
            const demand = Symbol();
            demands.add(demand);
            if (close === null) {
                const release = source.acquire({
                    onLive: batch => projection.apply(batch),
                    onRetained: retained => {
                        projection.applyRetained(retained.runs);
                        publish({ ...state, retained, status: connectionStatus(), error: null, historyError: null });
                    },
                    onError: error => publish({ ...state, status: 'failed', error }),
                    onHistoryError: error => publish({ ...state, status: connectionStatus(), historyError: error }),
                });
                // The source owns mounted-Account admission, including retirement
                // between render and effect; an unadmitted host adds no observers.
                if (!source.hasDemand()) { demands.delete(demand); return release; }
                const unsubscribeConnection = storage.subscribe((next, previous) => {
                    if (next.socketStatus !== previous.socketStatus && state.error === null)
                        publish({ ...state, status: connectionStatus() });
                });
                close = () => { release(); unsubscribeConnection(); };
                publish({ ...state, status: connectionStatus(), listeningSince: source.listeningSince() });
            }
            return () => {
                if (!demands.delete(demand)) return;
                if (demands.size === 0) releaseDemand();
            };
        },
        retry: async () => { if (close !== null) await source.retry(); },
        readPage,
        loadMore,
    };
}

/** Both presented hosts borrow one live source, frame projection and retained Run window.
 * Closed hosts subscribe to neither the source nor the projection. Live observations stay
 * local to this Account lifetime; durable Machine presence is rehydrated by the source. */
export function useWorkflowActivityFeed(input: Readonly<{ lifetime: ServerAccountScopeLifetime | null; active: boolean }>) {
    const owner = React.useMemo(() => {
        if (!input.active || input.lifetime === null) return null;
        const source = getWorkflowActivitySource(input.lifetime);
        if (source === null) return null;
        const lifetime = readServerAccountScopeOwnerLifetime(input.lifetime);
        let feed = owners.get(lifetime);
        if (!feed) owners.set(lifetime, feed = createFeed(lifetime, source));
        return feed;
    }, [input.lifetime, input.active]);
    React.useEffect(() => owner?.acquire(), [owner]);
    const state = React.useSyncExternalStore(owner?.subscribe ?? subscribeInactive,
        owner?.getSnapshot ?? readInitial, owner?.getSnapshot ?? readInitial);
    const keys = React.useSyncExternalStore(owner?.projection.subscribeKeys ?? subscribeInactive,
        owner?.projection.getKeys ?? readEmptyKeys, owner?.projection.getKeys ?? readEmptyKeys);
    const projection = owner?.projection ?? EMPTY_PROJECTION;
    return { ...state, keys, projection, getKeys: projection.getKeys, getRow: projection.getRow, subscribeRow: projection.subscribeRow,
        retry: owner?.retry ?? doNothing, readPage: owner?.readPage ?? readNoPage,
        loadMore: owner?.loadMore ?? doNothing };
}

const EMPTY_PROJECTION = createWorkflowActivityProjection();
function readInitial() { return INITIAL; }
function readEmptyKeys() { return EMPTY_KEYS; }
async function doNothing() {}
async function readNoPage() { return null; }
