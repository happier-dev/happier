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
import { useActiveServerAccountScope } from '@/sync/store/hooks';
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

export type UserMessageHistoryRemoteEntriesSnapshot = RemoteHistoryState & Readonly<{
    requestNextPage: () => void;
}>;

type RemoteHistoryStoreRecord = {
    state: RemoteHistoryState;
};

const remoteHistoryRecordsByKey = new Map<string, RemoteHistoryStoreRecord>();
const remoteHistoryInFlightCursorKeys = new Set<string>();
const remoteHistoryListeners = new Set<() => void>();

function normalizeRemoteHistoryBeforeSeq(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0
        ? Math.trunc(value)
        : null;
}

function remoteHistoryCursorKey(beforeSeq: number | null): string {
    return beforeSeq === null ? 'latest' : String(beforeSeq);
}

function remoteHistoryInitialState(initialBeforeSeq: number | null): RemoteHistoryState {
    return {
        entries: [],
        hasMore: true,
        nextBeforeSeq: initialBeforeSeq,
    };
}

function emitRemoteHistoryChange(): void {
    for (const listener of remoteHistoryListeners) {
        listener();
    }
}

function subscribeRemoteHistory(listener: () => void): () => void {
    remoteHistoryListeners.add(listener);
    return () => {
        remoteHistoryListeners.delete(listener);
    };
}

function readRemoteHistoryRecord(
    cacheKey: string | null,
    initialBeforeSeq: number | null,
): RemoteHistoryStoreRecord | null {
    if (!cacheKey) return null;
    const existing = remoteHistoryRecordsByKey.get(cacheKey);
    if (existing) return existing;
    const created: RemoteHistoryStoreRecord = {
        state: remoteHistoryInitialState(initialBeforeSeq),
    };
    remoteHistoryRecordsByKey.set(cacheKey, created);
    return created;
}

function readRemoteHistoryState(
    cacheKey: string | null,
    initialBeforeSeq: number | null,
): RemoteHistoryState {
    return readRemoteHistoryRecord(cacheKey, initialBeforeSeq)?.state ?? EMPTY_REMOTE_HISTORY_STATE;
}

function buildRemoteHistoryCacheKey(params: Readonly<{
    accountId: string | null;
    enabled: boolean;
    initialBeforeSeq: number | null;
    roleQuerySupported: boolean;
    serverId: string | null;
    sessionId: string | null;
}>): string | null {
    if (params.enabled !== true || params.roleQuerySupported !== true || !params.sessionId || !params.serverId) {
        return null;
    }
    const accountId = params.accountId ?? 'local';
    return [
        'user-message-history',
        `server:${params.serverId}`,
        `account:${accountId}`,
        `session:${params.sessionId}`,
        `initial:${remoteHistoryCursorKey(params.initialBeforeSeq)}`,
    ].join('|');
}

function updateRemoteHistoryState(cacheKey: string, update: (previous: RemoteHistoryState) => RemoteHistoryState): void {
    const record = readRemoteHistoryRecord(cacheKey, null);
    if (!record) return;
    const next = update(record.state);
    if (next === record.state) return;
    record.state = next;
    emitRemoteHistoryChange();
}

function requestRemoteHistoryPage(params: Readonly<{
    cacheKey: string | null;
    initialBeforeSeq: number | null;
    sessionId: string | null;
}>): void {
    if (!params.cacheKey || !params.sessionId) return;
    const record = readRemoteHistoryRecord(params.cacheKey, params.initialBeforeSeq);
    if (!record || record.state.hasMore !== true) return;

    const beforeSeq = record.state.nextBeforeSeq;
    const cursorKey = `${params.cacheKey}:cursor:${remoteHistoryCursorKey(beforeSeq)}`;
    if (remoteHistoryInFlightCursorKeys.has(cursorKey)) return;

    remoteHistoryInFlightCursorKeys.add(cursorKey);
    void sync.fetchUserMessageHistoryPage(params.sessionId, {
        limit: USER_MESSAGE_HISTORY_REMOTE_PAGE_SIZE,
        ...(beforeSeq !== null ? { beforeSeq } : {}),
    }).then((result) => {
        if (result.status === 'loaded') {
            updateRemoteHistoryState(params.cacheKey!, (previous) => ({
                entries: mergeRemoteHistoryEntries(previous.entries, result.entries),
                hasMore: result.hasMore === true && result.nextBeforeSeq !== null,
                nextBeforeSeq: result.nextBeforeSeq,
            }));
            return;
        }

        if (result.status === 'unsupported') {
            updateRemoteHistoryState(params.cacheKey!, (previous) => ({
                ...previous,
                hasMore: false,
                nextBeforeSeq: null,
            }));
            return;
        }

    }).finally(() => {
        remoteHistoryInFlightCursorKeys.delete(cursorKey);
    });
}

export function resetUserMessageHistoryRemoteEntriesForTests(): void {
    remoteHistoryRecordsByKey.clear();
    remoteHistoryInFlightCursorKeys.clear();
    emitRemoteHistoryChange();
}

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

    for (const entry of incoming) {
        const text = entry.text.trim();
        if (!text) continue;
        if (seenSeqs.has(entry.seq)) continue;
        seenSeqs.add(entry.seq);
        out.push({ ...entry, text });
    }

    return out;
}

export function useUserMessageHistoryRemoteEntries(opts: Readonly<{
    autoLoad?: boolean;
    enabled?: boolean;
    initialBeforeSeq?: number | null;
    sessionId: string | null;
}>): UserMessageHistoryRemoteEntriesSnapshot {
    const normalizedSessionIdRaw = normalizeSessionId(opts.sessionId);
    const normalizedSessionId = normalizedSessionIdRaw.length > 0 ? normalizedSessionIdRaw : null;
    const sessionIdForHook = normalizedSessionId ?? '__none__';
    const preferredServerId = usePreferredServerIdForSession(sessionIdForHook);
    const activeScope = useActiveServerAccountScope();
    const serverFeaturesSnapshot = useServerFeaturesSnapshotForServerId(preferredServerId, {
        enabled: opts.enabled !== false && Boolean(normalizedSessionId && preferredServerId),
    });
    const roleQuerySupported = serverFeaturesSnapshot.status === 'ready'
        && isSessionMessageRoleQuerySupported(serverFeaturesSnapshot.features);
    const initialBeforeSeq = normalizeRemoteHistoryBeforeSeq(opts.initialBeforeSeq);
    const cacheKey = buildRemoteHistoryCacheKey({
        accountId: activeScope?.accountId ?? null,
        enabled: opts.enabled !== false,
        initialBeforeSeq,
        roleQuerySupported,
        serverId: activeScope?.serverId ?? preferredServerId ?? null,
        sessionId: normalizedSessionId,
    });
    const state = React.useSyncExternalStore(
        subscribeRemoteHistory,
        () => readRemoteHistoryState(cacheKey, initialBeforeSeq),
        () => EMPTY_REMOTE_HISTORY_STATE,
    );
    const requestNextPage = React.useCallback(() => {
        requestRemoteHistoryPage({
            cacheKey,
            initialBeforeSeq,
            sessionId: normalizedSessionId,
        });
    }, [cacheKey, initialBeforeSeq, normalizedSessionId]);

    React.useEffect(() => {
        if (opts.autoLoad === true) {
            requestNextPage();
        }
    }, [opts.autoLoad, requestNextPage]);

    return React.useMemo(() => ({
        ...state,
        requestNextPage,
    }), [requestNextPage, state]);
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
    const remoteHistoryState = useUserMessageHistoryRemoteEntries({
        enabled: opts.scope === 'perSession',
        initialBeforeSeq: null,
        sessionId: normalizedSessionId,
    });
    const remoteHistoryEntriesLengthRef = React.useRef(remoteHistoryState.entries.length);
    const remoteHistoryRequestNextPageRef = React.useRef(remoteHistoryState.requestNextPage);
    const localEntriesRef = React.useRef<ReadonlyArray<string>>([]);
    const combinedEntriesRef = React.useRef<ReadonlyArray<string>>([]);
    const requestContextRef = React.useRef<Readonly<{
        scope: AgentInputHistoryScope;
        sessionId: string | null;
        roleQuerySupported: boolean;
    }>>({
        scope: opts.scope,
        sessionId: normalizedSessionId,
        roleQuerySupported: false,
    });

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

    localEntriesRef.current = localEntries;
    combinedEntriesRef.current = entries;
    remoteHistoryEntriesLengthRef.current = remoteHistoryState.entries.length;
    remoteHistoryRequestNextPageRef.current = remoteHistoryState.requestNextPage;
    requestContextRef.current = {
        scope: opts.scope,
        sessionId: normalizedSessionId,
        roleQuerySupported,
    };

    const requestRemoteHistoryPage = React.useCallback(() => {
        const requestContext = requestContextRef.current;
        if (requestContext.scope !== 'perSession') return;
        if (!requestContext.sessionId || requestContext.roleQuerySupported !== true) return;
        remoteHistoryRequestNextPageRef.current();
    }, []);

    const warmup = React.useCallback(() => {
        if (localEntriesRef.current.length > 0) return;
        if (remoteHistoryEntriesLengthRef.current > 0) return;
        requestRemoteHistoryPage();
    }, [requestRemoteHistoryPage]);

    const maybePrefetchOlder = React.useCallback((state: { index: number; entriesLength: number }) => {
        if (state.entriesLength <= 0) return;
        if (state.index < Math.max(0, state.entriesLength - USER_MESSAGE_HISTORY_PREFETCH_REMAINING_ENTRIES)) return;
        requestRemoteHistoryPage();
    }, [requestRemoteHistoryPage]);

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
    }, [navigator, normalizedSessionId, opts.scope]);

    return navigator;
}
