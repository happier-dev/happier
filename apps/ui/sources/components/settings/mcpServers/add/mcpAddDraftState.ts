import * as React from 'react';
import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import type { McpAddDraft, McpAddState } from './McpAddDetail';
import type { McpAddSelection } from './openMcpAddModal';
import { useActiveServerAccountScopeLifetime } from '@/sync/store/hooks';
import { areServerAccountScopesEqual, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { StoreListingReference } from '@/components/settings/plugins/model/pluginsSurfaceRoutes';

type State = Readonly<{ drafts: ReadonlyMap<string, McpAddDraft>; adds: ReadonlyMap<string, McpAddState>; detailScrollOffset: { current: number } }>;
const empty = (): State => ({ drafts: new Map(), adds: new Map(), detailScrollOffset: { current: 0 } });
const createDraftState = () => createStore<State>(empty);
type Continuation = {
    identity: string | null;
    selection: McpAddSelection | undefined;
    store: ReturnType<typeof createDraftState>;
    owners: Set<symbol | string>;
    retirement?: { dispose: () => void };
};
// This is an index of the native controller's state, not a serialized copy. Only
// an explicit pane→page handoff shares it; separate Add visits remain independent.
const continuations = new Map<string, Continuation>();

function retireContinuation(continuationId: string, entry: Continuation) {
    if (continuations.get(continuationId) === entry) continuations.delete(continuationId);
    entry.retirement?.dispose();
    entry.retirement = undefined;
    entry.store.setState(empty());
}

/** The native owner decides whether a newly selected listing continues its exact review. */
export function reconcileMcpAddDraftContinuation(continuationId: string | undefined, reference: StoreListingReference | null) {
    if (!continuationId || !reference) return;
    const entry = continuations.get(continuationId);
    if (!entry) return;
    const selection = entry.selection;
    if (reference.type === 'registryItem' && reference.kind === 'mcpServer' && selection
        && reference.sourceId === selection.sourceId && reference.itemId === selection.itemId
        && reference.version === selection.version) return;
    releaseMcpAddDraftContinuation(continuationId);
}

/** The retained directory owns the review across lazy page loading and Back; values stay native and host-local. */
export function retainMcpAddDraftContinuation(continuationId: string | undefined) {
    if (continuationId) continuations.get(continuationId)?.owners.add(continuationId);
}

/** A review close or its originating destination's retirement ends that retained ownership. */
export function releaseMcpAddDraftContinuation(continuationId: string | undefined) {
    if (!continuationId) return;
    const entry = continuations.get(continuationId);
    if (!entry) return;
    entry.owners.delete(continuationId);
    if (entry.owners.size === 0) retireContinuation(continuationId, entry);
}

export function useMcpAddDraftStore(scope: ServerAccountScope | null, selection: McpAddSelection | undefined, continuationId?: string) {
    const lifetime = useActiveServerAccountScopeLifetime();
    const key = scope && selection && continuationId ? JSON.stringify([scope.serverId, scope.accountId,
        selection.sourceId, selection.itemId, selection.version ?? null, continuationId]) : null;
    const entry = React.useMemo<Continuation>(() => {
        const current = continuationId ? continuations.get(continuationId) : null;
        return current && current.identity === key ? current : { identity: key, selection, store: createDraftState(), owners: new Set() };
    }, [continuationId, key]);
    React.useEffect(() => {
        if (!key || !continuationId || !lifetime?.isCurrent() || !areServerAccountScopesEqual(lifetime.scope, scope)) return;
        const previous = continuations.get(continuationId);
        // A different native selection is a new review, even when it uses the same originating pane.
        if (previous && previous !== entry) {
            previous.owners.delete(continuationId);
            if (previous.owners.size === 0) retireContinuation(continuationId, previous);
        }
        const owner = Symbol();
        entry.owners.add(owner);
        continuations.set(continuationId, entry);
        // The retained review, including its lazy destination gap, owns the scope subscription.
        entry.retirement ??= lifetime.onRetire(() => retireContinuation(continuationId, entry));
        return () => {
            entry.owners.delete(owner);
            if (entry.owners.size === 0) retireContinuation(continuationId, entry);
        };
    }, [continuationId, entry, key, lifetime, scope]);
    return entry.store;
}

/** The visible Add content subscribes; its outer readiness and scope owner stays quiet on typing. */
export function useMcpAddDraftState(store: ReturnType<typeof createDraftState>) {
    const state = useStore(store);
    const setDrafts = React.useCallback((update: (previous: State['drafts']) => State['drafts']) => {
        store.setState(previous => {
            const drafts = update(previous.drafts);
            return drafts === previous.drafts ? previous : { ...previous, drafts };
        });
    }, [store]);
    const setAdds = React.useCallback((update: (previous: State['adds']) => State['adds']) => {
        store.setState(previous => {
            const adds = update(previous.adds);
            return adds === previous.adds ? previous : { ...previous, adds };
        });
    }, [store]);
    return { ...state, setDrafts, setAdds };
}
