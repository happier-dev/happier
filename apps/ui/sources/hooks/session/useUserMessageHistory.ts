import React from 'react';
import { useShallow } from 'zustand/react/shallow';

import type { FeaturesResponse } from '@happier-dev/protocol';
import { USER_MESSAGE_HISTORY_REMOTE_PAGE_SIZE, type UserMessageHistoryRemoteEntry } from '@/sync/engine/sessions/fetchUserMessageHistoryPage';
import type { Message } from '@/sync/domains/messages/messageTypes';
import { readStoredSessionMessagesFromStateLike } from '@/sync/domains/messages/readStoredSessionMessages';
import { getStorage } from '@/sync/domains/state/storageStore';
import { useSessionMessagesById, useSessionTranscriptIds } from '@/sync/domains/state/storage';
import { normalizeSessionId } from '@/sync/domains/session/normalizeSessionId';
import { useServerFeaturesSnapshotForServerId } from '@/sync/domains/features/featureDecisionRuntime';
import { usePreferredServerIdForSession } from '@/sync/runtime/orchestration/serverScopedRpc/usePreferredServerIdForSession';
import { sync } from '@/sync/sync';

import type { AgentInputHistoryScope, UserMessageHistoryNavigator } from './userMessageHistory';
import {
    DEFAULT_USER_MESSAGE_HISTORY_MAX_ENTRIES,
    collectUserMessageHistoryEntries,
    createUserMessageHistoryNavigator,
} from './userMessageHistory';

const USER_MESSAGE_HISTORY_PREFETCH_REMAINING_ENTRIES = 3;

type SessionMessagesStateLike = {
    messageIdsOldestFirst?: ReadonlyArray<string>;
    messagesById?: Record<string, Message>;
    // Back-compat alias (older store snapshots/tests).
    messagesMap?: Record<string, Message>;
};

export function collectUserTextMessagesBySessionIdFromSessionMessagesState(
    sessionMessages: Record<string, SessionMessagesStateLike> | undefined,
): Record<string, ReadonlyArray<Message> | undefined> {
    const out: Record<string, ReadonlyArray<Message> | undefined> = {};
    const map = sessionMessages ?? {};

    for (const [sessionId, value] of Object.entries(map)) {
        const messages = readStoredSessionMessagesFromStateLike(value);

        if (messages.length === 0) {
            out[sessionId] = [];
            continue;
        }

        const userMessages: Message[] = [];
        for (const m of messages) {
            if (!m || m.kind !== 'user-text') continue;
            userMessages.push(m);
        }
        out[sessionId] = userMessages;
    }

    return out;
}

function useAllSessionMessages(enabled: boolean): Record<string, ReadonlyArray<Message> | undefined> {
    // IMPORTANT:
    // Do not derive new objects/arrays inside a Zustand selector. React 18 may call getSnapshot twice, and if
    // the selector allocates new references for the same store state it can trigger:
    // - "The result of getSnapshot should be cached…"
    // - "Maximum update depth exceeded"
    //
    // Instead, subscribe to the store's stable `sessionMessages` reference and derive via `useMemo`.
    const emptySessionMessages = React.useMemo(() => ({} as Record<string, any>), []);
    const sessionMessages = getStorage()(
        useShallow((state: any) => (enabled === true ? state.sessionMessages : emptySessionMessages))
    );

    return React.useMemo(() => {
        if (enabled !== true) return emptySessionMessages;
        return collectUserTextMessagesBySessionIdFromSessionMessagesState(sessionMessages);
    }, [enabled, sessionMessages, emptySessionMessages]);
}

type RemoteHistoryState = Readonly<{
    entries: UserMessageHistoryRemoteEntry[];
    hasMore: boolean;
    nextBeforeSeq: number | null;
}>;

const EMPTY_REMOTE_HISTORY_STATE: RemoteHistoryState = Object.freeze({
    entries: [],
    hasMore: true,
    nextBeforeSeq: null,
});

function isSessionMessageRoleQuerySupported(features: FeaturesResponse | null | undefined): boolean {
    return features?.capabilities?.session?.messages?.role === true;
}

function mergeHistoryEntries(params: Readonly<{
    localEntries: ReadonlyArray<string>;
    remoteEntries: ReadonlyArray<UserMessageHistoryRemoteEntry>;
    maxEntries: number;
}>): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const push = (value: string) => {
        const text = value.trim();
        if (!text || seen.has(text)) return;
        seen.add(text);
        out.push(text);
    };

    for (const entry of params.localEntries) {
        push(entry);
        if (out.length >= params.maxEntries) return out;
    }

    for (const entry of params.remoteEntries) {
        push(entry.text);
        if (out.length >= params.maxEntries) return out;
    }

    return out;
}

function mergeRemoteHistoryEntries(
    current: ReadonlyArray<UserMessageHistoryRemoteEntry>,
    incoming: ReadonlyArray<UserMessageHistoryRemoteEntry>,
): UserMessageHistoryRemoteEntry[] {
    const out = [...current];
    const seenSeqs = new Set(out.map((entry) => entry.seq));
    const seenTexts = new Set(out.map((entry) => entry.text.trim()).filter(Boolean));

    for (const entry of incoming) {
        const text = entry.text.trim();
        if (!text) continue;
        if (seenSeqs.has(entry.seq) || seenTexts.has(text)) continue;
        seenSeqs.add(entry.seq);
        seenTexts.add(text);
        out.push({ ...entry, text });
    }

    return out;
}

export function useUserMessageHistory(opts: {
    scope: AgentInputHistoryScope;
    sessionId: string | null;
    maxEntries?: number;
}): UserMessageHistoryNavigator {
    const normalizedSessionIdRaw = normalizeSessionId(opts.sessionId);
    const normalizedSessionId = normalizedSessionIdRaw.length > 0 ? normalizedSessionIdRaw : null;
    // Safe: for null sessionId, subscribe to a non-existent key and get empty arrays.
    const sessionIdForHook = normalizedSessionId ?? '__none__';
    const { ids: sessionMessageIds } = useSessionTranscriptIds(sessionIdForHook);
    const sessionMessagesById = useSessionMessagesById(sessionIdForHook);
    const allSessionMessages = useAllSessionMessages(opts.scope === 'global');
    const preferredServerId = usePreferredServerIdForSession(sessionIdForHook);
    const serverFeaturesSnapshot = useServerFeaturesSnapshotForServerId(preferredServerId, {
        enabled: opts.scope === 'perSession' && Boolean(normalizedSessionId && preferredServerId),
    });
    const roleQuerySupported = serverFeaturesSnapshot.status === 'ready'
        && isSessionMessageRoleQuerySupported(serverFeaturesSnapshot.features);
    const [remoteHistoryState, setRemoteHistoryState] = React.useState<RemoteHistoryState>(EMPTY_REMOTE_HISTORY_STATE);
    const remoteHistoryStateRef = React.useRef(remoteHistoryState);
    const localEntriesRef = React.useRef<ReadonlyArray<string>>([]);
    const combinedEntriesRef = React.useRef<ReadonlyArray<string>>([]);
    const requestRemoteHistoryPageRef = React.useRef<() => void>(() => {});
    const inFlightCursorRef = React.useRef<string | null>(null);
    const failedCursorKeysRef = React.useRef<Set<string>>(new Set());
    const activeHistoryScopeKeyRef = React.useRef<string>('');
    const historyScopeKey = `${opts.scope}:${normalizedSessionId ?? ''}`;
    activeHistoryScopeKeyRef.current = historyScopeKey;

    const sessionUserMessages = React.useMemo(() => {
        if (opts.scope !== 'perSession') return [] as Message[];
        if (!Array.isArray(sessionMessageIds) || sessionMessageIds.length === 0) return [] as Message[];
        const out: Message[] = [];
        for (const id of sessionMessageIds) {
            const m = sessionMessagesById[id];
            if (!m || m.kind !== 'user-text') continue;
            out.push(m);
        }
        return out;
    }, [opts.scope, sessionMessageIds, sessionMessagesById]);

    const localEntries = React.useMemo(() => {
        const messagesBySessionId =
            opts.scope === 'perSession'
                ? { [sessionIdForHook]: sessionUserMessages as ReadonlyArray<Message> }
                : allSessionMessages;

        return collectUserMessageHistoryEntries({
            scope: opts.scope,
            sessionId: normalizedSessionId,
            messagesBySessionId,
            maxEntries: opts.maxEntries,
        });
    }, [opts.scope, normalizedSessionId, opts.maxEntries, sessionIdForHook, sessionUserMessages, allSessionMessages]);

    const entries = React.useMemo(() => mergeHistoryEntries({
        localEntries,
        remoteEntries: opts.scope === 'perSession' ? remoteHistoryState.entries : [],
        maxEntries: opts.maxEntries ?? DEFAULT_USER_MESSAGE_HISTORY_MAX_ENTRIES,
    }), [localEntries, opts.maxEntries, opts.scope, remoteHistoryState.entries]);

    remoteHistoryStateRef.current = remoteHistoryState;
    localEntriesRef.current = localEntries;
    combinedEntriesRef.current = entries;

    const requestRemoteHistoryPage = React.useCallback(() => {
        if (opts.scope !== 'perSession') return;
        if (!normalizedSessionId || roleQuerySupported !== true) return;

        const current = remoteHistoryStateRef.current;
        if (current.hasMore !== true) return;

        const beforeSeq = current.nextBeforeSeq;
        const cursorKey = beforeSeq === null ? 'latest' : String(beforeSeq);
        const requestScopeKey = `${opts.scope}:${normalizedSessionId}`;
        const requestCursorKey = `${requestScopeKey}:${cursorKey}`;
        if (inFlightCursorRef.current === requestCursorKey || failedCursorKeysRef.current.has(requestCursorKey)) return;

        inFlightCursorRef.current = requestCursorKey;
        void sync.fetchUserMessageHistoryPage(normalizedSessionId, {
            limit: USER_MESSAGE_HISTORY_REMOTE_PAGE_SIZE,
            ...(beforeSeq !== null ? { beforeSeq } : {}),
        }).then((result) => {
            if (activeHistoryScopeKeyRef.current !== requestScopeKey) {
                return;
            }

            if (result.status === 'loaded') {
                setRemoteHistoryState((previous) => ({
                    entries: mergeRemoteHistoryEntries(previous.entries, result.entries),
                    hasMore: result.hasMore === true && result.nextBeforeSeq !== null,
                    nextBeforeSeq: result.nextBeforeSeq,
                }));
                return;
            }

            if (result.status === 'unsupported') {
                setRemoteHistoryState((previous) => ({
                    ...previous,
                    hasMore: false,
                    nextBeforeSeq: null,
                }));
                return;
            }

            if (result.status === 'error') {
                failedCursorKeysRef.current.add(requestCursorKey);
            }
        }).finally(() => {
            if (inFlightCursorRef.current === requestCursorKey) {
                inFlightCursorRef.current = null;
            }
        });
    }, [opts.scope, normalizedSessionId, roleQuerySupported]);
    requestRemoteHistoryPageRef.current = requestRemoteHistoryPage;

    const warmup = React.useCallback(() => {
        if (localEntriesRef.current.length > 0) return;
        if (remoteHistoryStateRef.current.entries.length > 0) return;
        requestRemoteHistoryPageRef.current();
    }, []);

    const maybePrefetchOlder = React.useCallback((state: { index: number; entriesLength: number }) => {
        if (state.entriesLength <= 0) return;
        if (state.index < Math.max(0, state.entriesLength - USER_MESSAGE_HISTORY_PREFETCH_REMAINING_ENTRIES)) return;
        requestRemoteHistoryPageRef.current();
    }, []);

    const navigator = React.useMemo(
        () => createUserMessageHistoryNavigator(
            () => combinedEntriesRef.current,
            {
                onMoveUp: maybePrefetchOlder,
                onWarmup: warmup,
            },
        ),
        [maybePrefetchOlder, warmup],
    );

    React.useEffect(() => {
        // If the user switches sessions or scope, drop any in-progress history browsing state.
        navigator.reset();
        setRemoteHistoryState(EMPTY_REMOTE_HISTORY_STATE);
        inFlightCursorRef.current = null;
        failedCursorKeysRef.current = new Set();
    }, [navigator, normalizedSessionId, opts.scope]);

    return navigator;
}
