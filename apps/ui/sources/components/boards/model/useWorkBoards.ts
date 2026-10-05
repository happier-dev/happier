import * as React from 'react';
import { WORK_BOARD_ARTIFACT_KIND_V1, type WorkBoardIntentV1, type WorkBoardV1, type WorkBoardsV1, type WorkBoardArtifactTransportV1 } from '@happier-dev/protocol';
import { useOptionalAuth } from '@/auth/context/AuthContext';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { storage, useActiveServerAccountScope, useIsDataReady } from '@/sync/domains/state/storage';
import { captureActiveServerAccountScopeLifetime, type ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { getActiveServerHomeCarrier, getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { apiSocket } from '@/sync/api/session/apiSocket';
import { InvalidateSync } from '@/utils/sessions/sync';
import { parseToken } from '@/utils/auth/parseToken';
import { createWorkBoardAccountStore } from './workBoardAccountStore';
import { projectDisplayedWorkBoards, type WorkBoardSaveOutcome, type WorkBoardSaveQueue, type WorkBoardSaveState } from './workBoardSaveQueue';

type MountedBoards = ReturnType<typeof createWorkBoardAccountStore> & Readonly<{ retain(demand: string): () => void; isCurrent(): boolean }>;
const stores = new WeakMap<ActiveServerAccountScopeLifetime, WeakMap<AuthCredentials, MountedBoards>>();
const refuse = async (): Promise<never> => { throw new Error('Board Account unavailable'); };
const unavailable = createWorkBoardAccountStore({ read: refuse, list: refuse, create: refuse, update: refuse, delete: refuse }, () => false);

/** All mounted Board surfaces share one projection/queue in the canonical active Account lifetime. */
function useBoardStore(bodyDemand = 'headers') {
    const credentials = useOptionalAuth()?.credentials ?? null;
    const scope = useActiveServerAccountScope();
    const ready = useIsDataReady();
    const server = useActiveServerSnapshot(credentials !== null);
    const lifetime = captureActiveServerAccountScopeLifetime();
    let store: MountedBoards | typeof unavailable = unavailable;
    let accountId: string | null = null;
    try { if (credentials) accountId = parseToken(credentials.token); } catch { /* No Account identity can be established. */ }
    if (ready && credentials && scope && lifetime && accountId === scope.accountId
        && scope.serverId === server.serverId && server.serverUrl) {
        let byCredentials = stores.get(lifetime);
        if (!byCredentials) { byCredentials = new WeakMap(); stores.set(lifetime, byCredentials); }
        let mounted = byCredentials.get(credentials);
        if (!mounted || !mounted.isCurrent()) {
            const capturedCredentials = credentials;
            const carrier = getActiveServerHomeCarrier();
            const shouldContinue = () => {
                const current = getActiveServerSnapshot();
                return lifetime.isCurrent() && current.serverId === server.serverId
                    && current.generation === server.generation && current.serverUrl === server.serverUrl
                    && current.runtimeOrigin === server.runtimeOrigin && current.carrier === server.carrier
                    && getActiveServerHomeCarrier() === carrier;
            };
            // Reuse the Artifact host client and its credential/mode fence. Starting it is deferred to a real read.
            let context: ReturnType<typeof captureLazyActionAccountContext> | null = null;
            const getContext = async () => {
                if (!shouldContinue()) throw new Error('Board Account scope retired');
                context ??= captureLazyActionAccountContext(server.serverId);
                const account = await context;
                account.assertCurrent();
                if (account.credentials.token !== capturedCredentials.token || !shouldContinue()) throw new Error('Board Account scope retired');
                return account;
            };
            const transport: WorkBoardArtifactTransportV1 = {
                read: async (id, options) => { options?.signal?.throwIfAborted(); return (await getContext()).workflowArtifacts.read(id, options); },
                list: async options => { options.signal?.throwIfAborted(); return (await getContext()).workflowArtifacts.list(options); },
                create: async input => { input.signal?.throwIfAborted(); return (await getContext()).workflowArtifacts.create(input); },
                update: async input => { input.signal?.throwIfAborted(); return (await getContext()).workflowArtifacts.update(input); },
                delete: async (id, options) => { options?.signal?.throwIfAborted(); return (await getContext()).workflowArtifacts.delete(id, options); },
            };
            const domain = createWorkBoardAccountStore(transport, shouldContinue);
            lifetime.onRetire(() => {
                domain.retire();
                if (context) void context.then(account => account.dispose(), () => {});
            });
            let refresh: (() => void) | null = null;
            mounted = { ...domain, isCurrent: shouldContinue, retain(demand) {
                const release = domain.retainView(() => {
                    const invalidation = new InvalidateSync(async () => { if (shouldContinue()) await domain.refresh(); });
                    refresh = () => { if (shouldContinue()) invalidation.invalidate(); };
                    // Existing Artifact socket and catch-up materialization own publication; observe their projection.
                    const unsubscribeArtifacts = storage.subscribe((state, previous) => {
                        if (!shouldContinue() || state.artifacts === previous.artifacts) return;
                        const changed = new Set([...Object.keys(state.artifacts), ...Object.keys(previous.artifacts)]);
                        for (const id of changed) {
                            const next = state.artifacts[id], old = previous.artifacts[id];
                            if (next !== old && (next?.header?.kind === WORK_BOARD_ARTIFACT_KIND_V1 || old?.header?.kind === WORK_BOARD_ARTIFACT_KIND_V1)) {
                                refresh?.(); break;
                            }
                        }
                    });
                    const unsubscribeReconnect = apiSocket.onReconnected(() => refresh?.());
                    return () => { invalidation.stop(); refresh = null; unsubscribeArtifacts(); unsubscribeReconnect(); };
                }, demand);
                refresh?.();
                return release;
            } };
            byCredentials.set(credentials, mounted);
        }
        store = mounted;
    }
    React.useEffect(() => bodyDemand !== 'inactive' && 'retain' in store ? store.retain(bodyDemand) : undefined, [store, bodyDemand]);
    return store;
}

export function useWorkBoardSaveQueue(): WorkBoardSaveQueue { return useBoardStore().queue; }

export function useWorkBoardReadState() {
    const store = useBoardStore();
    const state = React.useSyncExternalStore(store.subscribe, store.getReadState, store.getReadState);
    return { ...state, retry: store.refresh };
}

export function useWorkBoardSaveState(): WorkBoardSaveState {
    const queue = useWorkBoardSaveQueue();
    return React.useSyncExternalStore(queue.subscribe, queue.getState, queue.getState);
}

export function useWorkBoardSummaries(enabled = true) {
    const store = useBoardStore(enabled ? 'headers' : 'inactive');
    return React.useSyncExternalStore(store.subscribe, store.getSummaries, store.getSummaries);
}

export function useWorkBoards(): WorkBoardsV1 {
    const store = useBoardStore('all');
    const acknowledged = React.useSyncExternalStore(store.subscribe, store.getBoards, store.getBoards);
    const { pending } = React.useSyncExternalStore(store.queue.subscribe, store.queue.getState, store.queue.getState);
    return React.useMemo(() => pending.length === 0 ? acknowledged : projectDisplayedWorkBoards(acknowledged, pending), [acknowledged, pending]);
}

export function useWorkBoard(boardId: string | null): WorkBoardV1 | null {
    const store = useBoardStore(boardId ? `board:${boardId}` : 'headers');
    const acknowledged = React.useSyncExternalStore(store.subscribe, store.getBoards, store.getBoards);
    const { pending } = React.useSyncExternalStore(store.queue.subscribe, store.queue.getState, store.queue.getState);
    const displayed = React.useMemo(() => pending.length === 0 ? acknowledged : projectDisplayedWorkBoards(acknowledged, pending), [acknowledged, pending]);
    return boardId ? displayed.boards.find(board => board.id === boardId) ?? null : null;
}

export function useDispatchWorkBoardIntent(): (intent: WorkBoardIntentV1) => Promise<WorkBoardSaveOutcome> {
    return useWorkBoardSaveQueue().dispatch;
}

/**
 * One Board as the Account last acknowledged it, without this device's pending edits: what arrived
 * from elsewhere (an agent's Action) is read here, never an optimistic local write. It rides the
 * displayed Board's demand rather than retaining its own.
 */
export function useAcknowledgedWorkBoard(boardId: string): WorkBoardV1 | null {
    const store = useBoardStore('inactive');
    const acknowledged = React.useSyncExternalStore(store.subscribe, store.getBoards, store.getBoards);
    return acknowledged.boards.find(board => board.id === boardId) ?? null;
}
