import React from 'react';
import { useShallow } from 'zustand/react/shallow';

import type { FeaturesResponse } from '@happier-dev/protocol';
import {
    SESSION_MESSAGE_HISTORY_REMOTE_ROLES_QUERY,
    USER_MESSAGE_HISTORY_REMOTE_PAGE_SIZE,
    type FetchUserMessageHistoryPageResult,
    type SessionMessageHistoryRemoteRow,
} from '@/sync/engine/sessions/fetchUserMessageHistoryPage';
import type { Message } from '@/sync/domains/messages/messageTypes';
import { readStoredSessionMessagesFromStateLike } from '@/sync/domains/messages/readStoredSessionMessages';
import { getStorage } from '@/sync/domains/state/storageStore';
import { useSessionMessagesById, useSessionTranscriptIds } from '@/sync/domains/state/storage';
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
    rows: SessionMessageHistoryRemoteRow[];
    hasMore: boolean;
    /** Paging cursor lives with the accumulated rows so paging the transcript older never resets it. */
    nextBeforeSeq: number | null;
    pagesLoaded: number;
    /** The last attempt could not decrypt yet; a readiness change re-drives the same cursor. */
    pendingEncryption: boolean;
}>;

const EMPTY_REMOTE_HISTORY_STATE: RemoteHistoryState = Object.freeze({
    rows: [],
    hasMore: true,
    nextBeforeSeq: null,
    pagesLoaded: 0,
    pendingEncryption: false,
});

export type UserMessageHistoryRemoteEntriesSnapshot = RemoteHistoryState & Readonly<{
    requestNextPage: () => void;
}>;

type RemoteHistoryStoreRecord = {
    state: RemoteHistoryState;
};

/**
 * A cursor the current scope cannot read stays retryable, and the navigation continuation
 * re-drives it on every transcript store change. Without a floor that turns each store mutation
 * into a request; with one, recovery still happens on its own within a session.
 */
export const USER_MESSAGE_HISTORY_REMOTE_RETRY_COOLDOWN_MS = 30_000;

const remoteHistoryRecordsByKey = new Map<string, RemoteHistoryStoreRecord>();
const remoteHistoryInFlightCursorKeys = new Set<string>();
const remoteHistoryRetryFloorMsByCursorKey = new Map<string, number>();
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
        rows: [],
        hasMore: true,
        nextBeforeSeq: initialBeforeSeq,
        pagesLoaded: 0,
        pendingEncryption: false,
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
    roleQuerySupported: boolean;
    serverId: string | null;
    sessionId: string | null;
}>): string | null {
    if (params.enabled !== true || params.roleQuerySupported !== true || !params.sessionId || !params.serverId) {
        return null;
    }
    return [
        'session-message-history',
        `server:${params.serverId}`,
        `account:${params.accountId ?? 'local'}`,
        `session:${params.sessionId}`,
        `roles:${SESSION_MESSAGE_HISTORY_REMOTE_ROLES_QUERY}`,
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
    turnProjection: boolean;
}>): void {
    if (!params.cacheKey || !params.sessionId) return;
    const record = readRemoteHistoryRecord(params.cacheKey, params.initialBeforeSeq);
    if (!record || record.state.hasMore !== true) return;

    const beforeSeq = record.state.nextBeforeSeq;
    const cursorKey = `${params.cacheKey}:cursor:${remoteHistoryCursorKey(beforeSeq)}`;
    if (remoteHistoryInFlightCursorKeys.has(cursorKey)) return;
    const retryFloorMs = remoteHistoryRetryFloorMsByCursorKey.get(cursorKey);
    if (retryFloorMs !== undefined && Date.now() < retryFloorMs) return;

    const cacheKey = params.cacheKey;
    remoteHistoryInFlightCursorKeys.add(cursorKey);
    void sync.fetchUserMessageHistoryPage(params.sessionId, {
        limit: USER_MESSAGE_HISTORY_REMOTE_PAGE_SIZE,
        ...(params.turnProjection ? { turnProjection: true } : {}),
        ...(beforeSeq !== null ? { beforeSeq } : {}),
    // A rejected call (unresolvable server scope, transport throw) is the same transport failure
    // the page fetcher already reports as `error`, and gets the same retry floor; letting the
    // rejection escape only produced an unhandled rejection.
    }).catch((): FetchUserMessageHistoryPageResult => ({ status: 'error' })).then((result) => {
        if (result.status === 'error') {
            // The record is left untouched so the cursor stays retryable; only its cadence is capped.
            remoteHistoryRetryFloorMsByCursorKey.set(
                cursorKey,
                Date.now() + USER_MESSAGE_HISTORY_REMOTE_RETRY_COOLDOWN_MS,
            );
            return;
        }
        remoteHistoryRetryFloorMsByCursorKey.delete(cursorKey);

        if (result.status === 'loaded') {
            updateRemoteHistoryState(cacheKey, (previous) => ({
                rows: mergeRemoteHistoryRows(previous.rows, result.rows),
                hasMore: result.hasMore === true && result.nextBeforeSeq !== null,
                nextBeforeSeq: result.nextBeforeSeq,
                pagesLoaded: previous.pagesLoaded + 1,
                pendingEncryption: false,
            }));
            return;
        }

        if (result.status === 'unsupported') {
            updateRemoteHistoryState(cacheKey, (previous) => ({
                ...previous,
                hasMore: false,
                nextBeforeSeq: null,
                pendingEncryption: false,
            }));
            return;
        }

        if (result.status === 'not_ready') {
            // Session keys are not available yet. Keep the cursor so the next readiness change
            // re-drives this exact page; never latch `hasMore` off for a decryptable session.
            updateRemoteHistoryState(cacheKey, (previous) => (
                previous.pendingEncryption ? previous : { ...previous, pendingEncryption: true }
            ));
        }
    }).finally(() => {
        remoteHistoryInFlightCursorKeys.delete(cursorKey);
    });
}

export function resetUserMessageHistoryRemoteEntriesForTests(): void {
    remoteHistoryRecordsByKey.clear();
    remoteHistoryInFlightCursorKeys.clear();
    remoteHistoryRetryFloorMsByCursorKey.clear();
    emitRemoteHistoryChange();
}

function isSessionMessageRoleQuerySupported(features: FeaturesResponse | null | undefined): boolean {
    return features?.capabilities?.session?.messages?.role === true;
}

/**
 * The server returns one row per prompt plus the LAST reply of that turn — exactly what the
 * rail renders — instead of every reply row.
 *
 * Strictly capability-gated: an unknown query parameter is IGNORED rather than rejected, so an
 * older server would quietly answer with the ordinary listing, which is a different row set
 * than the caller asked for.
 */
function isSessionMessageTurnProjectionSupported(features: FeaturesResponse | null | undefined): boolean {
    return features?.capabilities?.session?.messages?.turns === true;
}

function mergeHistoryEntries(params: Readonly<{
    localEntries: ReadonlyArray<string>;
    remoteRows: ReadonlyArray<SessionMessageHistoryRemoteRow>;
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

    // Remote rows arrive newest-first from `fetchUserMessageHistoryPage` and pages accumulate
    // strictly older, so appending them in array order keeps ArrowUp walking backwards in time.
    for (const row of params.remoteRows) {
        // Composer history replays prompts; agent rows share the page but never the input.
        if (row.role !== 'user') continue;
        push(row.text);
        if (out.length >= params.maxEntries) return out;
    }

    return out;
}

function mergeRemoteHistoryRows(
    current: ReadonlyArray<SessionMessageHistoryRemoteRow>,
    incoming: ReadonlyArray<SessionMessageHistoryRemoteRow>,
): SessionMessageHistoryRemoteRow[] {
    const out = [...current];
    const seenMessageIds = new Set(out.map((row) => row.messageId));

    for (const row of incoming) {
        const text = row.text.trim();
        if (!text) continue;
        if (seenMessageIds.has(row.messageId)) continue;
        seenMessageIds.add(row.messageId);
        out.push({ ...row, text });
    }

    return out;
}

export function useUserMessageHistoryRemoteEntries(opts: Readonly<{
    enabled?: boolean;
    initialBeforeSeq?: number | null;
    sessionId: string | null;
}>): UserMessageHistoryRemoteEntriesSnapshot {
    const sessionIdForHook = opts.sessionId ?? '__none__';
    const preferredServerId = usePreferredServerIdForSession(sessionIdForHook);
    const activeScope = useActiveServerAccountScope();
    const serverFeaturesSnapshot = useServerFeaturesSnapshotForServerId(preferredServerId, {
        enabled: opts.enabled !== false && Boolean(opts.sessionId && preferredServerId),
    });
    const roleQuerySupported = serverFeaturesSnapshot.status === 'ready'
        && isSessionMessageRoleQuerySupported(serverFeaturesSnapshot.features);
    const turnProjectionSupported = serverFeaturesSnapshot.status === 'ready'
        && isSessionMessageTurnProjectionSupported(serverFeaturesSnapshot.features);
    const initialBeforeSeq = normalizeRemoteHistoryBeforeSeq(opts.initialBeforeSeq);
    const cacheKey = buildRemoteHistoryCacheKey({
        accountId: activeScope?.accountId ?? null,
        enabled: opts.enabled !== false,
        roleQuerySupported,
        serverId: activeScope?.serverId ?? preferredServerId ?? null,
        sessionId: opts.sessionId,
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
            sessionId: opts.sessionId,
            turnProjection: turnProjectionSupported,
        });
    }, [cacheKey, initialBeforeSeq, opts.sessionId, turnProjectionSupported]);

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
    // Safe: for null sessionId, subscribe to a non-existent key and get empty arrays.
    const sessionIdForHook = opts.sessionId ?? '__none__';
    const { ids: sessionMessageIds } = useSessionTranscriptIds(sessionIdForHook);
    const sessionMessagesById = useSessionMessagesById(sessionIdForHook);
    const allSessionMessages = useAllSessionMessages(opts.scope === 'global');
    const preferredServerId = usePreferredServerIdForSession(sessionIdForHook);
    const serverFeaturesSnapshot = useServerFeaturesSnapshotForServerId(preferredServerId, {
        enabled: opts.scope === 'perSession' && Boolean(opts.sessionId && preferredServerId),
    });
    const roleQuerySupported = serverFeaturesSnapshot.status === 'ready'
        && isSessionMessageRoleQuerySupported(serverFeaturesSnapshot.features);
    const turnProjectionSupported = serverFeaturesSnapshot.status === 'ready'
        && isSessionMessageTurnProjectionSupported(serverFeaturesSnapshot.features);
    const remoteHistoryState = useUserMessageHistoryRemoteEntries({
        enabled: opts.scope === 'perSession',
        initialBeforeSeq: null,
        sessionId: opts.sessionId,
    });
    const remoteHistoryRowsLengthRef = React.useRef(remoteHistoryState.rows.length);
    const remoteHistoryRequestNextPageRef = React.useRef(remoteHistoryState.requestNextPage);
    const localEntriesRef = React.useRef<ReadonlyArray<string>>([]);
    const combinedEntriesRef = React.useRef<ReadonlyArray<string>>([]);
    const requestContextRef = React.useRef<Readonly<{
        scope: AgentInputHistoryScope;
        sessionId: string | null;
        roleQuerySupported: boolean;
    }>>({
        scope: opts.scope,
        sessionId: opts.sessionId,
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
            sessionId: opts.sessionId,
            messagesBySessionId,
            maxEntries: opts.maxEntries,
        });
    }, [opts.scope, opts.sessionId, opts.maxEntries, sessionIdForHook, sessionUserMessages, allSessionMessages]);

    const entries = React.useMemo(() => mergeHistoryEntries({
        localEntries,
        remoteRows: opts.scope === 'perSession' ? remoteHistoryState.rows : [],
        maxEntries: opts.maxEntries ?? DEFAULT_USER_MESSAGE_HISTORY_MAX_ENTRIES,
    }), [localEntries, opts.maxEntries, opts.scope, remoteHistoryState.rows]);

    localEntriesRef.current = localEntries;
    combinedEntriesRef.current = entries;
    remoteHistoryRowsLengthRef.current = remoteHistoryState.rows.length;
    remoteHistoryRequestNextPageRef.current = remoteHistoryState.requestNextPage;
    requestContextRef.current = {
        scope: opts.scope,
        sessionId: opts.sessionId,
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
        if (remoteHistoryRowsLengthRef.current > 0) return;
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
    }, [navigator, opts.sessionId, opts.scope]);

    return navigator;
}
