import * as React from 'react';
import type { Message } from '@happier-dev/session-core/messages';
import type { AgentState, Metadata } from '@happier-dev/session-core/state';
import type { ReducerState } from '@happier-dev/session-core/reducer';
import { listPendingRequestLists, readSharedMetadataActionConfirmationState, readSharedMetadataPresentationCompletedRequests } from '@happier-dev/session-core/pending';
import { deriveTranscriptInteraction, type TranscriptInteraction } from '@/utils/sessions/deriveTranscriptInteraction';
import type { SessionTranscriptActions, SessionTranscriptSource, TranscriptHistoryState } from './types';

export type ReadOnlySessionTranscriptSnapshot = Readonly<{
    messages: readonly Message[];
    messagesById?: Readonly<Record<string, Message>>;
    reducerState: ReducerState | null;
    metadata: Metadata | null;
    agentState: AgentState | null;
    metadataLayoutVersion?: number;
    workspacePath?: string | null;
    authorship?: Readonly<{ viewerScope: null; hasOtherNamedCollaborator: boolean }>;
    historyState?: TranscriptHistoryState;
}>;

type ReadOnlySessionTranscriptSourceInput = ReadOnlySessionTranscriptSnapshot & Readonly<{
    sessionId: string;
    serverId?: string | null;
    loadOlder?: SessionTranscriptSource['history']['loadOlder'];
    /**
     * A sample surface that lets people press prompts locally (the Settings embed preview) passes
     * its interaction and no-op actions. Default: the public, non-interactive transcript.
     */
    interaction?: TranscriptInteraction;
    actions?: SessionTranscriptActions;
}>;

/** Hosts replace the local dataset after a page fold; neither the source nor its hooks change identity. */
export function createReadOnlySessionTranscriptSource(input: ReadOnlySessionTranscriptSourceInput): SessionTranscriptSource & Readonly<{
    update(snapshot: ReadOnlySessionTranscriptSnapshot): void;
}> {
    const actions = input.actions ?? null;
    const interaction = actions === null
        ? deriveTranscriptInteraction({ kind: 'public' })
        : input.interaction ?? deriveTranscriptInteraction({ kind: 'public' });
    const loadOlder = input.loadOlder;
    let olderLoadCount = 0;
    let suppliedHistoryState = input.historyState;
    let historyStateCache: TranscriptHistoryState | null = null;
    const listeners = new Set<() => void>();
    const subscribe = (listener: () => void) => {
        listeners.add(listener);
        return () => { listeners.delete(listener); };
    };
    function materialize(snapshot: ReadOnlySessionTranscriptSnapshot) {
        const materializedById: Record<string, Message> = {};
        function indexMessages(messages: readonly Message[]) {
            for (const message of messages) {
                materializedById[message.id] = message;
                if (message.kind === 'tool-call') indexMessages(message.children);
            }
        }
        // Materialized demo/tool datasets carry child rows on their parent, not
        // in app storage. Index them without adding sidechain rows to root order.
        if (!snapshot.messagesById) indexMessages(snapshot.messages);
        const messagesById = snapshot.messagesById ?? materializedById;
        return {
            ...snapshot,
            messagesById,
            ids: snapshot.messages.map((message) => message.id),
            authorship: { viewerScope: null, hasOtherNamedCollaborator: snapshot.authorship?.hasOtherNamedCollaborator === true } as const,
            historyState: readHistoryState(snapshot.historyState),
            pending: listPendingRequestLists({
                sessionId: input.sessionId,
                active: true,
                agentState: snapshot.agentState,
                actionConfirmations: readSharedMetadataActionConfirmationState(snapshot.metadata, snapshot.metadataLayoutVersion),
                presentationCompletedRequests: readSharedMetadataPresentationCompletedRequests(snapshot.metadata, snapshot.metadataLayoutVersion),
                projected: null,
            }, snapshot.messages),
        };
    }
    function readHistoryState(historyState: TranscriptHistoryState | undefined): TranscriptHistoryState {
        const state = historyState ?? { isLoaded: true, hasOlder: loadOlder != null, isLoadingOlder: false };
        const next = olderLoadCount > 0 && !state.isLoadingOlder ? { ...state, isLoadingOlder: true } : state;
        if (!historyStateCache || next.isLoaded !== historyStateCache.isLoaded || next.hasOlder !== historyStateCache.hasOlder
            || next.isLoadingOlder !== historyStateCache.isLoadingOlder || next.hasNewer !== historyStateCache.hasNewer
            || next.isLoadingNewer !== historyStateCache.isLoadingNewer || next.targetWindow !== historyStateCache.targetWindow) historyStateCache = next;
        return historyStateCache;
    }
    let current = materialize(input);
    function notify() {
        for (const listener of listeners) listener();
    }
    function refreshHistoryState() {
        current = { ...current, historyState: readHistoryState(suppliedHistoryState) };
        notify();
    }
    function useSelected<T>(select: (snapshot: typeof current) => T): T {
        const getSnapshot = () => select(current);
        return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    }
    return {
        kind: 'readOnly', sessionId: input.sessionId, serverId: input.serverId ?? null,
        useInteraction: () => interaction,
        useMessageIdsOldestFirst: () => useSelected((snapshot) => snapshot.ids),
        useMessagesById: () => useSelected((snapshot) => snapshot.messagesById),
        useMessage: (id) => useSelected((snapshot) => snapshot.messagesById[id] ?? null),
        useMessagesByIds: (ids) => {
            const cache = React.useRef<readonly (Message | null)[]>([]);
            return useSelected((snapshot) => {
                const next = ids.map((id) => snapshot.messagesById[id] ?? null);
                if (next.length !== cache.current.length || next.some((message, index) => message !== cache.current[index])) cache.current = next;
                return cache.current;
            });
        },
        useReducerState: () => useSelected((snapshot) => snapshot.reducerState),
        useAwareness: () => null,
        useRuntimeLastObservedAt: () => null,
        useMetadata: () => useSelected((snapshot) => snapshot.metadata),
        useAgentState: () => useSelected((snapshot) => snapshot.agentState),
        useWorkspacePath: () => useSelected((snapshot) => snapshot.workspacePath ?? null),
        useForkSupportSource: () => null,
        useAuthorship: () => useSelected((snapshot) => snapshot.authorship),
        usePendingRequests: () => useSelected((snapshot) => snapshot.pending),
        useConnectionState: () => 'static',
        history: {
            useState: () => useSelected((snapshot) => snapshot.historyState),
            loadOlder: loadOlder ? async (options) => {
                olderLoadCount += 1;
                refreshHistoryState();
                try {
                    return await loadOlder(options);
                } finally {
                    olderLoadCount -= 1;
                    refreshHistoryState();
                }
            } : null,
            loadTargetWindow: null,
        },
        loadSidechain: null, navigate: null, actions,
        update: (snapshot) => {
            suppliedHistoryState = snapshot.historyState;
            current = materialize(snapshot);
            notify();
        },
    };
}
