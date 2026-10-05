import * as React from 'react';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { buildScopedSessionRouteHref } from '@/hooks/session/sessionRouteServerScope';
import type { Message } from '@happier-dev/session-core/messages';
import type { AgentEvent } from '@happier-dev/session-core/raw';
import { shouldReadTranscriptForPendingRequestList } from '@happier-dev/session-core/pending';
import { deriveLatestPendingRequestObservedAtFromSession, derivePendingRequestFlagsFromSession, listPendingRequestListsFromSession, readPendingRequestFactsFromSession } from '@/sync/domains/session/pending/listPendingSessionRequests';
import { projectUiSessionAwareness } from '@/sync/domains/session/awareness/sessionAwareness';
import { readSessionRuntimePresentationFreshnessExpirations } from '@/sync/domains/session/attention/runtimePresentation';
import { useSessionListRelativeNowMs, useSessionListRuntimeWake } from '@/hooks/session/sessionListRuntimeClock';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { getForkedTranscriptSnapshotCached } from '@/sync/domains/sessionFork/forkedTranscriptSnapshot';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { nowServerMs } from '@/sync/runtime/time';
import { sync } from '@/sync/sync';
import {
    getStorage, storage, useForkedTranscriptSnapshot, useMessage, useMessagesByRefs,
    readSessionMessagesSnapshot,
    useSession, useSessionForkSupportSource, useSessionInteractionSource,
    useSessionMessages, useSessionMessagesById, useSessionMessagesReducerState, useSessionMessagesVersion,
    useSessionTranscriptIds, useSessionWorkspacePath, useSocketStatus,
    type MessageStoreRef,
} from '@/sync/domains/state/storage';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { StorageState } from '@/sync/store/types';
import { deriveTranscriptInteractionFromSession, type TranscriptInteraction } from '@/utils/sessions/deriveTranscriptInteraction';
import { useSessionMessageAuthorshipScope } from '../useSessionMessageAuthorshipScope';
import { deriveReadOnlyTranscriptInteraction } from '../forkContext/deriveReadOnlyTranscriptInteraction';
import { SessionTranscriptSourceProvider, useSessionTranscriptSource } from './SessionTranscriptSourceContext';
import type { SessionTranscriptSource, TranscriptHistoryState } from './types';
import type { SessionMessagesWindowState } from '@/sync/runtime/sessionMessagesWindowState';
import { createAppSessionTranscriptActions } from './appSessionTranscriptActions';

const EMPTY_IDS: readonly string[] = [];
const EMPTY_MESSAGES: readonly Message[] = [];
const EMPTY_MESSAGES_BY_ID: Record<string, Message> = {};
const EMPTY_PENDING = { permissionRequests: [], userActionRequests: [] } as const;

function useSourceTargetWindow(sessionId: string, enabled = true): SessionMessagesWindowState | null {
    const subscribe = React.useCallback((listener: () => void) => sync.subscribeSessionTargetWindowState(sessionId, listener), [sessionId]);
    const read = React.useCallback(() => enabled ? sync.getSessionTargetWindowState(sessionId) : null, [enabled, sessionId]);
    return React.useSyncExternalStore(subscribe, read, read);
}

function projectHistoryFrontiers(state: TranscriptHistoryState, window: SessionMessagesWindowState | null): TranscriptHistoryState {
    if (!window?.isWindowMode || window.windowId === null || window.targetSeq === null) return { ...state, hasNewer: false, targetWindow: null };
    return {
        ...state,
        hasOlder: window.hasMoreOlder !== false,
        hasNewer: window.hasMoreNewer !== false,
        targetWindow: { windowId: window.windowId, targetSeq: window.targetSeq, olderCursor: window.olderCursor, newerCursor: window.newerCursor },
    };
}

/** The app transport owns sidechain paging; presentation only supplies its exact target. */
export function createAppSidechainHistoryLoader(sessionId: string, sidechainId: string | null): NonNullable<SessionTranscriptSource['history']['loadOlder']> {
    return async () => sidechainId
        ? sync.loadOlderSidechainMessages(sessionId, sidechainId)
        : { loaded: 0, hasMore: false, status: 'not_ready' };
}

function readScopedSession(state: StorageState, sessionId: string, serverId: string | null, activeServerId: string): Session | null {
    const session = state.sessions[sessionId] ?? null;
    if (!session || !serverId) return session;
    return areServerProfileIdentifiersEquivalent(session.serverId ?? state.sessionLocalStateScope?.serverId ?? activeServerId, serverId) ? session : null;
}

type TranscriptIntentionalRestartEvent = Readonly<{ event: AgentEvent; createdAtMs: number }>;

/** Switch recovery consumes event evidence, not a subscription to every streamed row. */
export function useSessionIntentionalRestartSourceEvents(): readonly TranscriptIntentionalRestartEvent[] {
    const source = useSessionTranscriptSource();
    if (source.kind !== 'app') {
        const ids = source.useMessageIdsOldestFirst();
        const byId = source.useMessagesById();
        return React.useMemo(() => selectIntentionalRestartEvents(ids.flatMap((id) => byId[id] ? [byId[id]] : [])), [byId, ids]);
    }
    const activeServerId = useActiveServerSnapshot(Boolean(source.serverId)).serverId;
    const selector = React.useMemo(() => {
        let current: readonly TranscriptIntentionalRestartEvent[] = [];
        let messagesRef: readonly Message[] | null = null;
        return (state: StorageState) => {
            const scoped = !source.serverId || readScopedSession(state, source.sessionId, source.serverId, activeServerId) !== null;
            const transcript = state.sessionMessages[source.sessionId];
            const ids = transcript?.messageIdsOldestFirst ?? EMPTY_IDS;
            const fork = scoped ? getForkedTranscriptSnapshotCached(state, source.sessionId) : null;
            const messages = scoped && (!fork || ids.length > 0)
                ? readSessionMessagesSnapshot(source.sessionId, ids, transcript?.messagesById ?? EMPTY_MESSAGES_BY_ID, transcript?.messagesVersion ?? 0, transcript?.isLoaded ?? false)
                : EMPTY_MESSAGES;
            if (messages === messagesRef) return current;
            messagesRef = messages;
            const next = selectIntentionalRestartEvents(messages);
            if (next.length !== current.length || next.some((item, index) => item.event !== current[index].event || item.createdAtMs !== current[index].createdAtMs)) current = next;
            return current;
        };
    }, [activeServerId, source]);
    return getStorage()(selector);
}

function selectIntentionalRestartEvents(messages: readonly Message[]): readonly TranscriptIntentionalRestartEvent[] {
    const events: TranscriptIntentionalRestartEvent[] = [];
    for (const message of messages) {
        if (message.kind === 'agent-event' && message.event.type === 'connected-service-account-switch') {
            events.push({ event: message.event, createdAtMs: message.createdAt });
        }
    }
    return events;
}

/** Divider rows subscribe to machine identity, not metadata rewritten by live turns. */
export function useTranscriptMachineId(): string | null {
    const source = useSessionTranscriptSource();
    if (source.kind !== 'app') return source.useMetadata()?.machineId ?? null;
    const activeServerId = useActiveServerSnapshot(Boolean(source.serverId)).serverId;
    return getStorage()((state) => {
        const session = readScopedSession(state, source.sessionId, source.serverId, activeServerId);
        return session ? readSessionOwnerMetadataView(session)?.machineId ?? null : null;
    });
}

/** Ancestor rows belong to this presentation but legitimately read another Session (plan I1). */
export function useTranscriptMessage(messageId: string, originSessionId?: string): Message | null {
    const source = useSessionTranscriptSource();
    if (source.kind !== 'app') return source.useMessage(messageId);
    const foreign = Boolean(originSessionId && originSessionId !== source.sessionId);
    const ownIds = React.useMemo(() => foreign ? EMPTY_IDS : [messageId], [foreign, messageId]);
    const foreignRefs = React.useMemo(() => foreign && originSessionId ? [{ sessionId: originSessionId, messageId }] : [], [foreign, messageId, originSessionId]);
    const ownMessages = source.useMessagesByIds(ownIds);
    const foreignMessages = useMessagesByRefs(foreignRefs);
    return (foreign ? foreignMessages[0] : ownMessages[0]) ?? null;
}

/** Mixed ancestor/child groups retain the existing narrow, revision-aware selector. */
export function useTranscriptMessagesByRefs(refs: readonly MessageStoreRef[]): readonly (Message | null)[] {
    const source = useSessionTranscriptSource();
    const ids = React.useMemo(() => refs.map((ref) => ref.messageId), [refs]);
    if (source.kind !== 'app') return source.useMessagesByIds(ids);
    // Provenance may change within a mounted group. Keep this hook graph fixed;
    // only explicit foreign refs subscribe to another Session's app storage.
    const ownIds = React.useMemo(() => refs.filter((ref) => ref.sessionId === source.sessionId).map((ref) => ref.messageId), [refs, source.sessionId]);
    const foreignRefs = React.useMemo(() => refs.filter((ref) => ref.sessionId !== source.sessionId), [refs, source.sessionId]);
    const ownMessages = source.useMessagesByIds(ownIds);
    const foreignMessages = useMessagesByRefs(foreignRefs);
    const cache = React.useRef<Readonly<{
        refs: readonly MessageStoreRef[];
        ownMessages: readonly (Message | null)[];
        foreignMessages: readonly (Message | null)[];
        value: readonly (Message | null)[];
    }> | null>(null);
    const previous = cache.current;
    if (previous && previous.ownMessages === ownMessages && previous.foreignMessages === foreignMessages
        && previous.refs.length === refs.length && previous.refs.every((ref, index) =>
            ref.sessionId === refs[index].sessionId && ref.messageId === refs[index].messageId)) return previous.value;
    let ownIndex = 0;
    let foreignIndex = 0;
    const value = refs.map((ref) => ref.sessionId === source.sessionId
        ? ownMessages[ownIndex++] ?? null : foreignMessages[foreignIndex++] ?? null);
    cache.current = { refs, ownMessages, foreignMessages, value };
    return value;
}

/** Live roots and ancestry share the same narrow app data readers. */
function createAppSessionTranscriptReads(sessionId: string, serverId: string | null) {
    function useSessionField<T>(select: (session: Session | null) => T): T {
        const activeServerId = useActiveServerSnapshot(Boolean(serverId)).serverId;
        return getStorage()((state) => select(readScopedSession(state, sessionId, serverId, activeServerId)));
    }
    function useMessageScope(): boolean {
        return useSessionField((session) => !serverId || session !== null);
    }
    return {
        useMessageIdsOldestFirst: () => {
            const scoped = useMessageScope();
            const { ids } = useSessionTranscriptIds(sessionId, scoped);
            const fork = useForkedTranscriptSnapshot(sessionId);
            const { messages } = useSessionMessages(sessionId, { enabled: scoped && !fork && ids.length === 0 });
            return React.useMemo(() => !scoped ? EMPTY_IDS : !fork && ids.length === 0 && messages.length > 0
                ? messages.map((message) => message.id) : ids, [fork, ids, messages, scoped]);
        },
        useMessagesById: () => {
            const scoped = useMessageScope();
            const { ids } = useSessionTranscriptIds(sessionId, scoped);
            const byId = useSessionMessagesById(sessionId, scoped);
            const fork = useForkedTranscriptSnapshot(sessionId);
            const { messages } = useSessionMessages(sessionId, { enabled: scoped && !fork && ids.length === 0 });
            return React.useMemo(() => scoped && !fork && ids.length === 0 && messages.length > 0
                ? Object.fromEntries(messages.map((message) => [message.id, message])) : byId, [byId, fork, ids, messages, scoped]);
        },
        useMessage: (id) => {
            const scoped = useMessageScope();
            const message = useMessage(sessionId, id);
            return scoped ? message : null;
        },
        useMessagesByIds: (ids) => {
            const scoped = useMessageScope();
            const refs = React.useMemo(() => scoped ? ids.map((messageId) => ({ sessionId, messageId })) : [], [ids, scoped]);
            return useMessagesByRefs(refs);
        },
        useReducerState: () => {
            const scoped = useMessageScope();
            const state = useSessionMessagesReducerState(sessionId);
            return scoped ? state : null;
        },
        useMetadata: () => useSessionField((session) => session ? readSessionOwnerMetadataView(session) : null),
        useAgentState: () => useSessionField((session) => session?.agentState ?? null),
        useWorkspacePath: () => useSessionWorkspacePath(sessionId, serverId),
        useForkSupportSource: () => useSessionForkSupportSource(sessionId, serverId),
        useAuthorship: () => useSessionMessageAuthorshipScope(sessionId, serverId),
        usePendingRequests: () => {
            const session = useSession(sessionId, serverId);
            const readTranscript = session !== null && shouldReadTranscriptForPendingRequestList(readPendingRequestFactsFromSession(session));
            const { messages } = useSessionMessages(sessionId, { enabled: readTranscript });
            return React.useMemo(() => session ? listPendingRequestListsFromSession(session, messages) : EMPTY_PENDING, [messages, session]);
        },
        useAwareness: () => {
            const session = useSession(sessionId, serverId);
            const localNow = useSessionListRelativeNowMs(session !== null);
            const serverNow = React.useMemo(() => nowServerMs(), [localNow, session]);
            const wakeAt = React.useMemo(() => {
                if (!session) return null;
                const pending = derivePendingRequestFlagsFromSession(session, []);
                const expirations = readSessionRuntimePresentationFreshnessExpirations({
                    ...session,
                    ...pending,
                    pendingRequestObservedAt: deriveLatestPendingRequestObservedAtFromSession(session, []),
                }, serverNow).filter((expiry) => expiry > serverNow);
                return expirations.length > 0 ? Math.min(...expirations) - (serverNow - localNow) : null;
            }, [localNow, serverNow, session]);
            useSessionListRuntimeWake(wakeAt, session !== null);
            return React.useMemo(() => session ? projectUiSessionAwareness(session, serverNow) : null, [serverNow, session]);
        },
        useRuntimeLastObservedAt: () => useSessionField((session) => typeof session?.activeAt === 'number' && Number.isFinite(session.activeAt) ? session.activeAt : null),
    } satisfies Pick<SessionTranscriptSource,
        | 'useMessageIdsOldestFirst' | 'useMessagesById' | 'useMessage' | 'useMessagesByIds'
        | 'useReducerState' | 'useMetadata' | 'useAgentState' | 'useWorkspacePath'
        | 'useForkSupportSource' | 'useAuthorship' | 'usePendingRequests' | 'useAwareness' | 'useRuntimeLastObservedAt'>;
}

type AppSourceProviderProps = Readonly<{
    sessionId: string;
    serverId?: string | null;
    interaction?: TranscriptInteraction;
    /** Sidechain/run roots retain their existing history loader beneath the same source. */
    loadOlder?: NonNullable<SessionTranscriptSource['history']['loadOlder']>;
    /** Inherited fork rows are inspect-only while retaining exact app authorship. */
    readOnly?: boolean;
    /** Frame hosts hide app-route affordances without disabling session actions. */
    navigation?: 'app' | 'none';
    children: React.ReactNode;
}>;

export function AppSessionTranscriptSourceProvider(props: AppSourceProviderProps) {
    return <AppSessionTranscriptSourceRoot key={`app:${props.serverId ?? ''}:${props.sessionId}:${props.readOnly === true ? 'readOnly' : 'live'}:${props.navigation ?? 'app'}`} {...props} />;
}

/** Fork ancestry changes the dataset authority, while read-only snapshots retain their own source. */
export function TranscriptOriginSourceProvider(props: Readonly<{
    originSessionId?: string;
    readOnly: boolean;
    children: React.ReactNode;
}>) {
    const source = useSessionTranscriptSource();
    if (source.kind !== 'app' || !props.readOnly) return <>{props.children}</>;
    if (source.actions === null && (props.originSessionId ?? source.sessionId) === source.sessionId) return <>{props.children}</>;
    return <TranscriptOriginAppSourceRoot key={`app:${source.serverId ?? ''}:${props.originSessionId ?? source.sessionId}`} source={source} sessionId={props.originSessionId ?? source.sessionId}>
        {props.children}
    </TranscriptOriginAppSourceRoot>;
}

/** Ancestry changes data scope without mounting another live action/paging controller. */
function TranscriptOriginAppSourceRoot(props: Readonly<{ source: SessionTranscriptSource; sessionId: string; children: React.ReactNode }>) {
    const [source] = React.useState<SessionTranscriptSource>(() => {
        const parent = props.source;
        const sessionId = props.sessionId;
        return {
            kind: 'app', sessionId, serverId: parent.serverId,
            ...createAppSessionTranscriptReads(sessionId, parent.serverId),
            useInteraction: () => {
                const interaction = parent.useInteraction();
                const current = useSessionInteractionSource(sessionId, parent.serverId);
                return React.useMemo(() => {
                    const ancestor = deriveTranscriptInteractionFromSession(current ?? {});
                    return deriveReadOnlyTranscriptInteraction({
                        ...interaction,
                        canOpenFiles: interaction.canOpenFiles === true && ancestor.canOpenFiles === true,
                        canPreviewMedia: interaction.canPreviewMedia === true && ancestor.canPreviewMedia === true,
                    }, true);
                }, [current, interaction]);
            },
            useConnectionState: parent.useConnectionState,
            history: {
                useState: () => {
                    const { isLoaded } = useSessionTranscriptIds(sessionId);
                    useSessionMessagesVersion(sessionId);
                    const window = useSourceTargetWindow(sessionId);
                    const available = sync.getSessionTailDiscontinuityOlderAvailability(sessionId);
                    return React.useMemo(() => projectHistoryFrontiers({ isLoaded, hasOlder: available ?? true, isLoadingOlder: false }, window), [available, isLoaded, window]);
                },
                loadOlder: null, loadTargetWindow: null,
            },
            actions: null, navigate: null, loadSidechain: null,
        };
    });
    return <SessionTranscriptSourceProvider source={source}>{props.children}</SessionTranscriptSourceProvider>;
}

function AppSessionTranscriptSourceRoot(props: AppSourceProviderProps) {
    const router = useRouter();
    const routerRef = React.useRef(router);
    React.useLayoutEffect(() => { routerRef.current = router; }, [router]);
    const [cell] = React.useState(() => {
        let interaction = props.interaction;
        let loadOlderOverride = props.loadOlder;
        let olderLoadCount = 0;
        let newerLoadCount = 0;
        let hasOlder = true;
        const listeners = new Set<() => void>();
        const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
        const notify = () => { for (const listener of listeners) listener(); };
        const sessionId = props.sessionId;
        const serverId = props.serverId ?? null;
        const source: SessionTranscriptSource = {
            kind: 'app', sessionId, serverId,
            ...createAppSessionTranscriptReads(sessionId, serverId),
            useInteraction: () => {
                const supplied = React.useSyncExternalStore(subscribe, () => interaction, () => interaction);
                const current = useSessionInteractionSource(sessionId, serverId);
                return React.useMemo(() => deriveReadOnlyTranscriptInteraction(supplied ?? deriveTranscriptInteractionFromSession(current ?? {}), props.readOnly === true), [current, supplied]);
            },
            useConnectionState: () => {
                const { status } = useSocketStatus();
                return status === 'connected' ? 'live' : status === 'connecting' ? 'connecting' : 'offline';
            },
            history: {
                useState: () => {
                    const { isLoaded } = useSessionTranscriptIds(sessionId);
                    useSessionMessagesVersion(sessionId);
                    const window = useSourceTargetWindow(sessionId, loadOlderOverride == null);
                    const loading = React.useSyncExternalStore(subscribe, () => olderLoadCount > 0, () => olderLoadCount > 0);
                    const loadingNewer = React.useSyncExternalStore(subscribe, () => newerLoadCount > 0, () => newerLoadCount > 0);
                    const more = React.useSyncExternalStore(subscribe, () => hasOlder, () => hasOlder);
                    const available = sync.getSessionTailDiscontinuityOlderAvailability(sessionId);
                    return React.useMemo(() => projectHistoryFrontiers({ isLoaded, hasOlder: available ?? more, isLoadingOlder: loading, isLoadingNewer: loadingNewer }, window), [available, isLoaded, loading, loadingNewer, more, window]);
                },
                loadOlder: props.readOnly === true ? null : async (options) => {
                    olderLoadCount += 1;
                    notify();
                    try {
                        const state = storage.getState();
                        const forked = getForkedTranscriptSnapshotCached(state, sessionId) !== null;
                        const result = loadOlderOverride ? await loadOlderOverride(options) : forked ? await sync.loadOlderMessagesForkAware(sessionId, options) : await sync.loadOlderMessages(sessionId, options);
                        if (result.status === 'loaded' || result.status === 'no_more') hasOlder = result.hasMore;
                        return result;
                    } finally { olderLoadCount -= 1; notify(); }
                },
                loadTargetWindow: props.readOnly === true ? null : (target, options) => sync.loadTargetWindowMessages(sessionId, target, options),
                loadFindPage: props.readOnly === true ? null : async (direction, options) => {
                    const window = loadOlderOverride == null ? sync.getSessionTargetWindowState(sessionId) : null;
                    if (!window?.isWindowMode || window.windowId === null || window.targetSeq === null) {
                        return direction === 'older' && source.history.loadOlder
                            ? source.history.loadOlder(options)
                            : { loaded: 0, hasMore: false, status: 'no_more' };
                    }
                    if (direction === 'older') olderLoadCount += 1; else newerLoadCount += 1;
                    notify();
                    try {
                        const result = await sync.loadTargetWindowMessages(sessionId, { kind: 'seq', seq: window.targetSeq }, {
                            direction, limit: options?.limit, continuationWindowId: window.windowId,
                        });
                        const hasMore = (direction === 'older' ? result.hasMoreOlder : result.hasMoreNewer) !== false;
                        return {
                            loaded: result.appliedSeqs.length,
                            hasMore,
                            status: result.status === 'loaded' ? hasMore ? 'loaded' : 'no_more'
                                : result.status === 'retryable_error' ? 'retryable_error' : 'not_ready',
                        };
                    } finally {
                        if (direction === 'older') olderLoadCount -= 1; else newerLoadCount -= 1;
                        notify();
                    }
                },
            },
            loadSidechain: props.readOnly === true ? null : (sidechainId) => sync.ensureSidechainMessagesLoaded(sessionId, sidechainId),
            navigate: props.readOnly === true || props.navigation === 'none' ? null : (href) => {
                const query = new URLSearchParams(href.split('?')[1] ?? '');
                const jumpSeq = query.get('jumpSeq');
                if (jumpSeq !== null && href === buildScopedSessionRouteHref({ sessionId, serverId, query: { jumpSeq } })) {
                    routerRef.current.setParams({ jumpSeq });
                    return;
                }
                routerRef.current.push(href as Parameters<typeof router.push>[0]);
            },
            actions: props.readOnly === true ? null : createAppSessionTranscriptActions(sessionId, serverId),
        };
        return { source, update(next: AppSourceProviderProps) {
            loadOlderOverride = next.loadOlder;
            if (interaction !== next.interaction) { interaction = next.interaction; notify(); }
        } };
    });
    React.useLayoutEffect(() => { cell.update(props); }, [cell, props.interaction, props.loadOlder]);
    return <SessionTranscriptSourceProvider source={cell.source}>{props.children}</SessionTranscriptSourceProvider>;
}
