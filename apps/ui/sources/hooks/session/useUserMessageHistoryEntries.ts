import React from 'react';
import { useShallow } from 'zustand/react/shallow';

import type { FeaturesResponse } from '@happier-dev/protocol';
import {
    SESSION_MESSAGE_HISTORY_REMOTE_ROLES_QUERY,
    USER_MESSAGE_HISTORY_REMOTE_PAGE_SIZE,
    compareHistoryRowsNewestFirst,
    type FetchUserMessageHistoryPageResult,
    type SessionMessageHistoryRemoteRow,
} from '@/sync/engine/sessions/fetchUserMessageHistoryPage';
import type { Message } from "@happier-dev/session-core/messages";
import { readStoredSessionMessagesFromStateLike } from "@happier-dev/session-core/messages";
import { getStorage } from '@/sync/domains/state/storageStore';
import type { StorageState } from '@/sync/store/types';
import { readMessageDisplayText } from '@happier-dev/session-core/messages';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { readSessionListRowsForServerId } from '@/sync/domains/session/listing/sessionListRowStateLookup';
import { deriveSessionListMeaningfulActivityAt } from '@/sync/domains/session/listing/deriveSessionListActivity';
import { normalizeSessionId } from '@/sync/domains/session/normalizeSessionId';
import { useServerFeaturesSnapshotForServerId } from '@/sync/domains/features/featureDecisionRuntime';
import { usePreferredServerIdForSession } from '@/sync/runtime/orchestration/serverScopedRpc/usePreferredServerIdForSession';
import { useActiveServerAccountScope } from '@/sync/store/hooks';
import { sync } from '@/sync/sync';

import type { AgentInputHistoryScope } from './userMessageHistory';

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

export function useAllSessionMessages(enabled: boolean): Record<string, ReadonlyArray<Message> | undefined> {
    // IMPORTANT:
    // Do not derive new objects/arrays inside a Zustand selector. React 18 may call getSnapshot twice, and if
    // the selector allocates new references for the same store state it can trigger:
    // - "The result of getSnapshot should be cached…"
    // - "Maximum update depth exceeded"
    //
    // Instead, subscribe to the store's stable `sessionMessages` reference and derive via `useMemo`.
    const emptySessionMessages = React.useMemo<Record<string, SessionMessagesStateLike>>(() => ({}), []);
    const sessionMessages = getStorage()(
        useShallow((state) => (enabled === true ? state.sessionMessages : emptySessionMessages))
    );

    return React.useMemo(() => {
        if (enabled !== true) return {};
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
    failure: 'error' | 'unsupported' | 'not_ready' | null;
    /** An older transcript-window backfill alone cannot cover the session's newest rows. */
    startedFromLatest: boolean;
}>;

const EMPTY_REMOTE_HISTORY_STATE: RemoteHistoryState = Object.freeze({
    rows: [],
    hasMore: true,
    nextBeforeSeq: null,
    pagesLoaded: 0,
    pendingEncryption: false,
    failure: null,
    startedFromLatest: false,
});

export type UserMessageHistoryRemoteEntriesSnapshot = RemoteHistoryState & Readonly<{
    requestNextPage: () => void;
}>;

type RemoteHistoryStoreRecord = {
    state: RemoteHistoryState;
};

/**
 * A transport failure leaves the cursor, `hasMore` and `pagesLoaded` untouched, so every caller
 * that re-drives history — the transcript-navigation continuation effect on each transcript store
 * update, composer prefetch on each ArrowUp — would otherwise re-issue the same request against an
 * already failing (possibly rate-limiting) endpoint. The floor keeps the failing cursor retryable
 * without letting it be retried faster than this.
 */
export const USER_MESSAGE_HISTORY_REMOTE_RETRY_COOLDOWN_MS = 30_000;

const remoteHistoryRecordsByKey = new Map<string, RemoteHistoryStoreRecord>();
const remoteHistoryInFlightByCursorKey = new Map<string, Promise<void>>();
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
        failure: null,
        startedFromLatest: initialBeforeSeq === null,
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
    turnProjection: boolean;
    includeLatest?: boolean;
    cacheKey: string | null;
    initialBeforeSeq: number | null;
    sessionId: string | null;
}>): Promise<void> {
    if (!params.cacheKey || !params.sessionId) return Promise.resolve();
    const record = readRemoteHistoryRecord(params.cacheKey, params.initialBeforeSeq);
    if (!record) return Promise.resolve();
    if (params.includeLatest && !record.state.startedFromLatest) {
        const existingCursorKey = `${params.cacheKey}:cursor:${remoteHistoryCursorKey(record.state.nextBeforeSeq)}`;
        const pendingOlderPage = remoteHistoryInFlightByCursorKey.get(existingCursorKey);
        if (pendingOlderPage) return pendingOlderPage.then(() => requestRemoteHistoryPage(params));
        // Keep the already-read rows and use this same pager to bridge from the latest page to
        // the old window. Exhaustion then means the whole session, rather than only its backfill.
        updateRemoteHistoryState(params.cacheKey, (previous) => ({
            ...previous, hasMore: true, nextBeforeSeq: null, startedFromLatest: true, failure: null,
        }));
    }
    if (record.state.hasMore !== true) return Promise.resolve();

    const beforeSeq = record.state.nextBeforeSeq;
    const cursorKey = `${params.cacheKey}:cursor:${remoteHistoryCursorKey(beforeSeq)}`;
    const pending = remoteHistoryInFlightByCursorKey.get(cursorKey);
    if (pending) return pending;
    const retryFloorMs = remoteHistoryRetryFloorMsByCursorKey.get(cursorKey);
    if (retryFloorMs !== undefined && Date.now() < retryFloorMs) return Promise.resolve();

    const cacheKey = params.cacheKey;
    const request = sync.fetchUserMessageHistoryPage(params.sessionId, {
        limit: USER_MESSAGE_HISTORY_REMOTE_PAGE_SIZE,
        ...(params.turnProjection ? { turnProjection: true } : {}),
        ...(beforeSeq !== null ? { beforeSeq } : {}),
    // A rejected call (unresolvable server scope, transport throw) is the same transport failure
    // the page fetcher already reports as `error`, and gets the same retry floor.
    }).catch((): FetchUserMessageHistoryPageResult => ({ status: 'error' })).then((result) => {
        if (result.status === 'error') {
            remoteHistoryRetryFloorMsByCursorKey.set(
                cursorKey,
                Date.now() + USER_MESSAGE_HISTORY_REMOTE_RETRY_COOLDOWN_MS,
            );
            updateRemoteHistoryState(cacheKey, (previous) => (
                previous.failure === 'error' ? previous : { ...previous, failure: 'error' }
            ));
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
                failure: null,
                startedFromLatest: previous.startedFromLatest,
            }));
            return;
        }

        if (result.status === 'unsupported') {
            updateRemoteHistoryState(cacheKey, (previous) => ({
                ...previous,
                hasMore: false,
                nextBeforeSeq: null,
                pendingEncryption: false,
                failure: 'unsupported',
            }));
            return;
        }

        if (result.status === 'not_ready') {
            // Session keys are not available yet. Keep the cursor so the next readiness change
            // re-drives this exact page; never latch `hasMore` off for a decryptable session.
            updateRemoteHistoryState(cacheKey, (previous) => (
                previous.pendingEncryption ? previous : { ...previous, pendingEncryption: true, failure: 'not_ready' }
            ));
        }
    }).finally(() => {
        remoteHistoryInFlightByCursorKey.delete(cursorKey);
    });
    remoteHistoryInFlightByCursorKey.set(cursorKey, request);
    return request;
}

export function resetUserMessageHistoryRemoteEntriesForTests(): void {
    remoteHistoryRecordsByKey.clear();
    remoteHistoryInFlightByCursorKey.clear();
    remoteHistoryRetryFloorMsByCursorKey.clear();
    emitRemoteHistoryChange();
}

export function isSessionMessageRoleQuerySupported(features: FeaturesResponse | null | undefined): boolean {
    return features?.capabilities?.session?.messages?.role === true;
}

/**
 * The server returns one row per prompt plus that turn's final reply — exactly what the rail
 * renders — instead of every reply row.
 *
 * Strictly capability-gated: an unknown query parameter is IGNORED rather than rejected, so an
 * older server would quietly answer with the ordinary listing, which is a different row set
 * than the caller asked for.
 */
function isSessionMessageTurnProjectionSupported(features: FeaturesResponse | null | undefined): boolean {
    return features?.capabilities?.session?.messages?.turns === true;
}

function mergeRemoteHistoryRows(
    current: ReadonlyArray<SessionMessageHistoryRemoteRow>,
    incoming: ReadonlyArray<SessionMessageHistoryRemoteRow>,
): SessionMessageHistoryRemoteRow[] {
    const out = [...current];
    const seenMessageIds = new Set(out.map((row) => row.messageId));

    for (const row of incoming) {
        if (!row.text.trim()) continue;
        if (seenMessageIds.has(row.messageId)) continue;
        seenMessageIds.add(row.messageId);
        out.push(row);
    }

    return out.sort(compareHistoryRowsNewestFirst);
}

export function useUserMessageHistoryRemoteEntries(opts: Readonly<{
    enabled?: boolean;
    initialBeforeSeq?: number | null;
    sessionId: string | null;
    serverId?: string | null;
}>): UserMessageHistoryRemoteEntriesSnapshot {
    const normalizedSessionIdRaw = normalizeSessionId(opts.sessionId);
    const normalizedSessionId = normalizedSessionIdRaw.length > 0 ? normalizedSessionIdRaw : null;
    const sessionIdForHook = normalizedSessionId ?? '__none__';
    const preferredServerId = usePreferredServerIdForSession({
        serverId: opts.serverId,
        sessionId: sessionIdForHook,
    });
    const activeScope = useActiveServerAccountScope();
    const serverFeaturesSnapshot = useServerFeaturesSnapshotForServerId(preferredServerId, {
        enabled: opts.enabled !== false && Boolean(normalizedSessionId && preferredServerId),
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
            turnProjection: turnProjectionSupported,
        });
    }, [cacheKey, initialBeforeSeq, normalizedSessionId, turnProjectionSupported]);

    return React.useMemo(() => ({
        ...state,
        requestNextPage,
    }), [requestNextPage, state]);
}

export type UserMessageHistoryEntry = Readonly<{
    serverId: string;
    sessionId: string;
    messageId: string;
    seq: number | null;
    createdAtMs: number;
    text: string;
}>;

export type UserMessageHistoryEntriesOptions = Readonly<{
    scope: AgentInputHistoryScope;
    sessionId?: string | null;
    serverId?: string | null;
    enabled?: boolean;
}>;

export type UserMessageHistoryEntriesSnapshot = Readonly<{
    entries: readonly UserMessageHistoryEntry[];
    coverage: 'loaded' | 'partial' | 'complete';
    hasMore: boolean;
    isLoading: boolean;
    error: boolean;
    progress: Readonly<{ pagesLoaded: number; sessionsSearched: number; totalSessions: number }>;
    loadMore: () => Promise<void>;
    retry: () => Promise<void>;
    stop: () => void;
}>;

type HistorySource = Pick<StorageState, 'sessionMessages' | 'sessions' | 'sessionListRowsByServerId'>;
const EMPTY_HISTORY_SOURCE: HistorySource = { sessionMessages: {}, sessions: {}, sessionListRowsByServerId: {} };
const EMPTY_ACCEPTED_SESSIONS: Readonly<Record<string, RemoteHistoryState>> = {};
const EMPTY_ENTRIES: readonly UserMessageHistoryEntry[] = [];

/** Account history is a client-side projection of the existing decrypted message-page owner. */
export function useUserMessageHistoryEntries(opts: UserMessageHistoryEntriesOptions): UserMessageHistoryEntriesSnapshot {
    const enabled = opts.enabled !== false;
    const activeScope = useActiveServerAccountScope();
    const sessionId = normalizeSessionId(opts.sessionId ?? '') || null;
    const preferredServerId = usePreferredServerIdForSession({
        serverId: opts.serverId,
        sessionId: sessionId ?? '__none__',
    }, enabled);
    // The Account-wide inventory is the applied active Home's corpus, not another Home's row cache.
    const serverId = opts.scope === 'global'
        ? opts.serverId?.trim() || activeScope?.serverId || null
        : preferredServerId ?? activeScope?.serverId ?? null;
    const sourceAvailable = Boolean(serverId && activeScope && areServerProfileIdentifiersEquivalent(serverId, activeScope.serverId));
    const serverFeatures = useServerFeaturesSnapshotForServerId(serverId, { enabled: enabled && sourceAvailable });
    const roleQuerySupported = sourceAvailable && serverFeatures.status === 'ready' && isSessionMessageRoleQuerySupported(serverFeatures.features);
    const turnProjection = serverFeatures.status === 'ready' && isSessionMessageTurnProjectionSupported(serverFeatures.features);
    const source = getStorage()(useShallow((state) => enabled && sourceAvailable ? {
        sessionMessages: state.sessionMessages,
        sessions: state.sessions,
        sessionListRowsByServerId: state.sessionListRowsByServerId,
    } : EMPTY_HISTORY_SOURCE));
    const contextKey = JSON.stringify([serverId, activeScope?.accountId ?? null, opts.scope, sessionId]);
    const contextRef = React.useRef({ key: contextKey, enabled });
    contextRef.current = { key: contextKey, enabled };
    const [accepted, setAccepted] = React.useState<Readonly<{
        key: string;
        sessions: Readonly<Record<string, RemoteHistoryState>>;
        demanded: boolean;
    }>>({ key: contextKey, sessions: EMPTY_ACCEPTED_SESSIONS, demanded: false });
    const acceptedSessions = accepted.key === contextKey ? accepted.sessions : EMPTY_ACCEPTED_SESSIONS;
    const demanded = accepted.key === contextKey && accepted.demanded;
    const pendingRef = React.useRef<{ cancelled: boolean } | null>(null);
    const [isLoading, setIsLoading] = React.useState(false);
    const stop = React.useCallback(() => {
        if (pendingRef.current) pendingRef.current.cancelled = true;
        pendingRef.current = null;
        setIsLoading(false);
    }, []);
    React.useEffect(() => {
        stop();
        return () => {
            if (pendingRef.current) pendingRef.current.cancelled = true;
            pendingRef.current = null;
        };
    }, [contextKey, enabled, stop]);

    const inventory = React.useMemo(() => {
        if (!enabled || !sourceAvailable || !serverId) return [];
        if (opts.scope === 'perSession') return sessionId ? [sessionId] : [];
        const rows = readSessionListRowsForServerId(source.sessionListRowsByServerId, serverId) ?? {};
        const sessions = new Map(Object.entries(rows));
        for (const session of Object.values(source.sessions)) {
            if (session.serverId && !areServerProfileIdentifiersEquivalent(session.serverId, serverId)) continue;
            if (!sessions.has(session.id)) sessions.set(session.id, session);
        }
        const activityAt = (id: string) => {
            const session = sessions.get(id);
            return deriveSessionListMeaningfulActivityAt({
                sessionMeaningfulActivityAt: session?.meaningfulActivityAt,
                sessionCreatedAt: session?.createdAt,
                latestCommittedMessageCreatedAt: undefined,
                latestPendingMessageCreatedAt: undefined,
            }) ?? 0;
        };
        return [...sessions.keys()].sort((a, b) => activityAt(b) - activityAt(a) || a.localeCompare(b));
    }, [enabled, opts.scope, serverId, sessionId, sourceAvailable, source.sessions, source.sessionListRowsByServerId]);

    React.useEffect(() => {
        if (!enabled || !roleQuerySupported || demanded || !serverId) return;
        const cached: Record<string, RemoteHistoryState> = {};
        for (const id of inventory) {
            const key = buildRemoteHistoryCacheKey({ enabled: true, roleQuerySupported, serverId, sessionId: id,
                accountId: activeScope?.accountId ?? null });
            const state = key ? remoteHistoryRecordsByKey.get(key)?.state : undefined;
            if (state && (state.pagesLoaded > 0 || state.failure !== null)) cached[id] = state;
        }
        if (Object.keys(cached).length > 0) {
            setAccepted({ key: contextKey, sessions: cached, demanded: true });
        }
    }, [activeScope?.accountId, contextKey, demanded, enabled, inventory, roleQuerySupported, serverId]);

    const entries = React.useMemo(() => {
        if (!enabled || !sourceAvailable || !serverId) return EMPTY_ENTRIES;
        const rows = new Map<string, UserMessageHistoryEntry>();
        const include = (entry: UserMessageHistoryEntry) => {
            const key = JSON.stringify([entry.serverId, entry.sessionId, entry.messageId]);
            if (!rows.has(key)) rows.set(key, entry);
        };
        const localSessionIds = opts.scope === 'perSession'
            ? sessionId ? [sessionId] : []
            : [...new Set([...inventory, ...Object.keys(source.sessionMessages)])];
        for (const id of localSessionIds) {
            const session = source.sessions[id];
            if (session?.serverId && !areServerProfileIdentifiersEquivalent(session.serverId, serverId)) continue;
            for (const message of readStoredSessionMessagesFromStateLike(source.sessionMessages[id])) {
                if (message.kind !== 'user-text') continue;
                const text = readMessageDisplayText(message);
                if (!text.trim()) continue;
                include({
                    serverId, sessionId: id, messageId: message.realID ?? message.id,
                    seq: typeof message.seq === 'number' && Number.isFinite(message.seq) ? message.seq : null,
                    createdAtMs: message.createdAt, text,
                });
            }
        }
        for (const [id, state] of Object.entries(acceptedSessions)) {
            for (const row of state.rows) {
                if (row.role !== 'user') continue;
                include({ serverId, sessionId: id, messageId: row.messageId, seq: row.seq, createdAtMs: row.createdAt, text: row.text });
            }
        }
        return [...rows.values()].sort((a, b) => b.createdAtMs - a.createdAtMs || (b.seq ?? 0) - (a.seq ?? 0));
    }, [acceptedSessions, enabled, inventory, opts.scope, serverId, sessionId, sourceAvailable, source.sessionMessages, source.sessions]);

    const nextSessionId = inventory.find((id) => acceptedSessions[id]?.hasMore !== false || acceptedSessions[id]?.startedFromLatest !== true) ?? null;
    const loadMore = React.useCallback(async () => {
        if (!enabled || !serverId || pendingRef.current) return;
        const demandKey = contextKey;
        setAccepted((previous) => ({
            key: demandKey,
            sessions: previous.key === demandKey ? previous.sessions : EMPTY_ACCEPTED_SESSIONS,
            demanded: true,
        }));
        if (!nextSessionId || !roleQuerySupported) return;
        const pending = { cancelled: false };
        pendingRef.current = pending;
        setIsLoading(true);
        const cacheKey = buildRemoteHistoryCacheKey({
            enabled: true, roleQuerySupported, serverId, sessionId: nextSessionId,
            accountId: activeScope?.accountId ?? null,
        });
        try {
            await requestRemoteHistoryPage({ cacheKey, sessionId: nextSessionId, initialBeforeSeq: null, turnProjection, includeLatest: true });
            if (pending.cancelled || contextRef.current.key !== demandKey || !contextRef.current.enabled) return;
            const state = readRemoteHistoryState(cacheKey, null);
            setAccepted((previous) => ({
                key: demandKey,
                demanded: true,
                sessions: { ...(previous.key === demandKey ? previous.sessions : {}), [nextSessionId]: state },
            }));
        } finally {
            if (pendingRef.current === pending) {
                pendingRef.current = null;
                setIsLoading(false);
            }
        }
    }, [activeScope?.accountId, contextKey, enabled, nextSessionId, roleQuerySupported, serverId, turnProjection]);

    // Ordinary, archived and strict-query memberships each retain independent pagination in the
    // Account inventory owner. The union of cached rows cannot attest that archived/shared sessions
    // were fully enumerated, so global exhaustion is partial even when all known sessions were read.
    const complete = opts.scope === 'perSession' && inventory.length > 0 && inventory.every((id) => {
        const state = acceptedSessions[id];
        return state && state.startedFromLatest && state.pagesLoaded > 0 && !state.hasMore && state.failure === null;
    });
    return {
        entries,
        coverage: complete ? 'complete' : demanded ? 'partial' : 'loaded',
        hasMore: enabled && roleQuerySupported && nextSessionId !== null,
        isLoading: enabled && isLoading,
        error: enabled && demanded && (!roleQuerySupported || Object.values(acceptedSessions).some((state) => state.failure !== null)),
        progress: {
            pagesLoaded: Object.values(acceptedSessions).reduce((count, state) => count + state.pagesLoaded, 0),
            sessionsSearched: Object.keys(acceptedSessions).length,
            totalSessions: inventory.length,
        },
        loadMore,
        retry: loadMore,
        stop,
    };
}
