import React from 'react';

import type { FeaturesResponse } from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import { compareTranscriptMessagesOldestFirst } from '@happier-dev/session-core/messages';
import {
    SESSION_MESSAGE_HISTORY_REMOTE_ROLES_QUERY,
    USER_MESSAGE_HISTORY_REMOTE_PAGE_SIZE,
    compareHistoryRowsNewestFirst,
    type FetchUserMessageHistoryPageResult,
    type SessionMessageHistoryRemoteRow,
} from '@/sync/engine/sessions/fetchUserMessageHistoryPage';
import { getStorage } from '@/sync/domains/state/storageStore';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { normalizeSessionId } from '@/sync/domains/session/normalizeSessionId';
import { useServerFeaturesSnapshotForServerId } from '@/sync/domains/features/featureDecisionRuntime';
import { usePreferredServerIdForSession } from '@/sync/runtime/orchestration/serverScopedRpc/usePreferredServerIdForSession';
import { useActiveServerAccountScope, useSessionServerId, useSessionUserMessageHistory,
    useUserMessageHistorySessionIds, useUserMessageHistorySessionServerIds } from '@/sync/store/hooks';
import { sync } from '@/sync/sync';
import { mergeAbortSignals } from '@/utils/runtime/abortSignals';

import type { AgentInputHistoryScope } from './userMessageHistory';

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
    requestNextPage: (retryFailed?: boolean) => void;
}>;

type RemoteHistoryStoreRecord = {
    state: RemoteHistoryState;
};

const remoteHistoryRecordsByKey = new Map<string, RemoteHistoryStoreRecord>();
const remoteHistoryInFlightByCursorKey = new Map<string, Readonly<{ promise: Promise<void>; controller: AbortController }>>();
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
    explicitRetry?: boolean;
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
        if (pendingOlderPage && !params.explicitRetry) return pendingOlderPage.promise.then(() => requestRemoteHistoryPage(params));
        pendingOlderPage?.controller.abort();
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
    if (pending && !params.explicitRetry) return pending.promise;
    pending?.controller.abort();
    // Store updates cannot retry a failed cursor. Retry, ArrowUp or a fresh Session mount
    // clears this existing failure fact; elapsed time is not renewed demand.
    if (!params.explicitRetry && record.state.failure === 'error') return Promise.resolve();
    if (params.explicitRetry && record.state.failure === 'error') {
        updateRemoteHistoryState(params.cacheKey, (previous) => ({ ...previous, failure: null }));
    }

    const cacheKey = params.cacheKey;
    const controller = new AbortController();
    const request = sync.fetchUserMessageHistoryPage(params.sessionId, {
        limit: USER_MESSAGE_HISTORY_REMOTE_PAGE_SIZE,
        signal: controller.signal,
        ...(params.explicitRetry ? { fresh: true } : {}),
        ...(params.turnProjection ? { turnProjection: true } : {}),
        ...(beforeSeq !== null ? { beforeSeq } : {}),
    // A rejected call (unresolvable server scope, transport throw) is the same transport failure
    // the page fetcher already reports as `error`, and latches the same failure fact.
    }).catch((): FetchUserMessageHistoryPageResult => ({ status: 'error' })).then((result) => {
        // A superseded cursor read can finish after its replacement. Only the current
        // request may publish rows, checkpoint a cursor, or latch a failure.
        if (controller.signal.aborted || remoteHistoryInFlightByCursorKey.get(cursorKey) !== inFlight) return;
        if (result.status === 'error') {
            updateRemoteHistoryState(cacheKey, (previous) => (
                previous.failure === 'error' ? previous : { ...previous, failure: 'error' }
            ));
            return;
        }
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
        if (remoteHistoryInFlightByCursorKey.get(cursorKey) === inFlight) remoteHistoryInFlightByCursorKey.delete(cursorKey);
    });
    const inFlight = { promise: request, controller };
    remoteHistoryInFlightByCursorKey.set(cursorKey, inFlight);
    return request;
}

/** Stop releases this demand's wait; another consumer may still need the shared cursor read. */
function waitForRemoteHistoryDemand(request: Promise<void>, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
        const stop = () => { signal.removeEventListener('abort', stop); resolve(); };
        signal.addEventListener('abort', stop, { once: true });
        request.then(() => {
            signal.removeEventListener('abort', stop);
            resolve();
        }, error => {
            signal.removeEventListener('abort', stop);
            reject(error);
        });
    });
}

export function resetUserMessageHistoryRemoteEntriesForTests(): void {
    for (const request of remoteHistoryInFlightByCursorKey.values()) request.controller.abort();
    remoteHistoryRecordsByKey.clear();
    remoteHistoryInFlightByCursorKey.clear();
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
    React.useEffect(() => {
        if (!cacheKey) return;
        updateRemoteHistoryState(cacheKey, (previous) => previous.failure === 'error'
            ? { ...previous, failure: null } : previous);
    }, [cacheKey]);
    const requestNextPage = React.useCallback((retryFailed = false) => {
        requestRemoteHistoryPage({
            cacheKey,
            initialBeforeSeq,
            sessionId: normalizedSessionId,
            turnProjection: turnProjectionSupported,
            explicitRetry: retryFailed && readRemoteHistoryState(cacheKey, initialBeforeSeq).failure === 'error',
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

export type UserMessageHistoryEntriesData = Readonly<{
    entries: readonly UserMessageHistoryEntry[];
    coverage: 'loaded' | 'partial' | 'complete';
    hasMore: boolean;
    isLoading: boolean;
    error: boolean;
    progress: Readonly<{ pagesLoaded: number; sessionsSearched: number; totalSessions: number }>;
}>;

export type UserMessageHistoryEntriesSnapshot = UserMessageHistoryEntriesData & Readonly<{
    loadMore: (signal?: AbortSignal) => Promise<UserMessageHistoryEntriesData>;
    retry: (signal?: AbortSignal) => Promise<UserMessageHistoryEntriesData>;
    stop: () => UserMessageHistoryEntriesData;
}>;

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
    const perSession = opts.scope === 'perSession';
    const localHistory = useSessionUserMessageHistory(perSession ? sessionId ?? '__none__' : null, enabled && sourceAvailable);
    const sessionServerId = useSessionServerId(sessionId ?? '__none__', enabled && sourceAvailable && perSession);
    const sessionServerIds = useUserMessageHistorySessionServerIds(enabled && sourceAvailable && !perSession);
    const globalInventory = useUserMessageHistorySessionIds(serverId, enabled && sourceAvailable && !perSession);
    const inventory = React.useMemo(() => !enabled || !sourceAvailable ? []
        : perSession ? sessionId ? [sessionId] : [] : globalInventory,
    [enabled, globalInventory, perSession, sessionId, sourceAvailable]);
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
    const pendingRef = React.useRef<AbortController | null>(null);
    const [isLoading, setIsLoading] = React.useState(false);
    const stop = React.useCallback(() => {
        pendingRef.current?.abort();
        pendingRef.current = null;
        setIsLoading(false);
        return { ...latestProjection.current.data, isLoading: false };
    }, []);
    React.useEffect(() => {
        stop();
        return () => {
            pendingRef.current?.abort();
            pendingRef.current = null;
        };
    }, [contextKey, enabled, stop]);

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

    const projectEntries = React.useCallback((sessions: Readonly<Record<string, RemoteHistoryState>>) => {
        if (!enabled || !sourceAvailable || !serverId) return EMPTY_ENTRIES;
        const rows = new Map<string, UserMessageHistoryEntry>();
        const include = (entry: UserMessageHistoryEntry) => {
            const key = JSON.stringify([entry.serverId, entry.sessionId, entry.messageId]);
            if (!rows.has(key)) rows.set(key, entry);
        };
        const localSessionIds = opts.scope === 'perSession'
            ? sessionId ? [sessionId] : []
            : [...new Set([...inventory, ...Object.keys(localHistory)])];
        for (const id of localSessionIds) {
            const ownerServerId = perSession ? sessionServerId : sessionServerIds[id];
            if (ownerServerId && !areServerProfileIdentifiersEquivalent(ownerServerId, serverId)) continue;
            for (const message of Object.values(localHistory[id] ?? {}).sort(compareTranscriptMessagesOldestFirst)) {
                const text = message.text;
                if (!text.trim()) continue;
                include({
                    serverId, sessionId: id, messageId: message.realID ?? message.id,
                    seq: typeof message.seq === 'number' && Number.isFinite(message.seq) ? message.seq : null,
                    createdAtMs: message.createdAt, text,
                });
            }
        }
        for (const [id, state] of Object.entries(sessions)) {
            for (const row of state.rows) {
                if (row.role !== 'user') continue;
                include({ serverId, sessionId: id, messageId: row.messageId, seq: row.seq, createdAtMs: row.createdAt, text: row.text });
            }
        }
        return [...rows.values()].sort((a, b) => b.createdAtMs - a.createdAtMs || (b.seq ?? 0) - (a.seq ?? 0));
    }, [enabled, inventory, opts.scope, perSession, serverId, sessionId, sourceAvailable,
        localHistory, sessionServerId, sessionServerIds]);
    const entries = React.useMemo(() => projectEntries(acceptedSessions), [projectEntries, acceptedSessions]);

    const projectData = React.useCallback((sessions: Readonly<Record<string, RemoteHistoryState>>, hasDemand: boolean,
        loading: boolean, projectedEntries = projectEntries(sessions)): UserMessageHistoryEntriesData => {
        // The paged ordinary/archived/query inventory cannot attest Account-wide completeness.
        const complete = perSession && inventory.length > 0 && inventory.every((id) => {
            const state = sessions[id];
            return state && state.startedFromLatest && state.pagesLoaded > 0 && !state.hasMore && state.failure === null;
        });
        return {
            entries: projectedEntries,
            coverage: complete ? 'complete' : hasDemand ? 'partial' : 'loaded',
            hasMore: enabled && roleQuerySupported && inventory.some((id) => sessions[id]?.hasMore !== false || sessions[id]?.startedFromLatest !== true),
            isLoading: enabled && loading,
            error: enabled && hasDemand && (!roleQuerySupported || Object.values(sessions).some((state) => state.failure !== null)),
            progress: {
                pagesLoaded: Object.values(sessions).reduce((count, state) => count + state.pagesLoaded, 0),
                sessionsSearched: Object.keys(sessions).length,
                totalSessions: inventory.length,
            },
        };
    }, [enabled, inventory, perSession, projectEntries, roleQuerySupported]);
    const data = projectData(acceptedSessions, demanded, isLoading, entries);
    const latestProjection = React.useRef({ projectData, acceptedSessions, demanded, data });
    latestProjection.current = { projectData, acceptedSessions, demanded, data };

    const nextSessionId = inventory.find((id) => acceptedSessions[id]?.hasMore !== false || acceptedSessions[id]?.startedFromLatest !== true) ?? null;
    const loadPage = React.useCallback(async (explicitRetry: boolean, signal?: AbortSignal) => {
        if (!enabled || !serverId || pendingRef.current) return latestProjection.current.data;
        const demandKey = contextKey;
        setAccepted((previous) => ({
            key: demandKey,
            sessions: previous.key === demandKey ? previous.sessions : EMPTY_ACCEPTED_SESSIONS,
            demanded: true,
        }));
        if (!nextSessionId || !roleQuerySupported) return latestProjection.current.projectData(acceptedSessions, true, false);
        const pending = new AbortController();
        const cancellation = mergeAbortSignals([pending.signal, signal]);
        pendingRef.current = pending;
        setIsLoading(true);
        const cacheKey = buildRemoteHistoryCacheKey({
            enabled: true, roleQuerySupported, serverId, sessionId: nextSessionId,
            accountId: activeScope?.accountId ?? null,
        });
        try {
            await waitForRemoteHistoryDemand(requestRemoteHistoryPage({ cacheKey, sessionId: nextSessionId, initialBeforeSeq: null,
                turnProjection, includeLatest: true, explicitRetry }), cancellation.signal);
            if (cancellation.signal.aborted || contextRef.current.key !== demandKey || !contextRef.current.enabled) {
                const latest = latestProjection.current;
                return latest.projectData(latest.acceptedSessions, latest.demanded, false);
            }
            const state = readRemoteHistoryState(cacheKey, null);
            const nextAccepted = {
                key: demandKey,
                demanded: true,
                sessions: { ...latestProjection.current.acceptedSessions, [nextSessionId]: state },
            };
            setAccepted(nextAccepted);
            // Return the owner's accepted projection directly: React may commit the setState only
            // after an Action awaiting this page resumes. No presenter needs to wait for a render.
            return latestProjection.current.projectData(nextAccepted.sessions, true, false);
        } finally {
            cancellation.dispose();
            if (pendingRef.current === pending) {
                pendingRef.current = null;
                setIsLoading(false);
            }
        }
    }, [acceptedSessions, activeScope?.accountId, contextKey, enabled, nextSessionId, roleQuerySupported, serverId, turnProjection]);
    const loadMore = React.useCallback((signal?: AbortSignal) => loadPage(false, signal), [loadPage]);
    const retry = React.useCallback((signal?: AbortSignal) => loadPage(true, signal), [loadPage]);

    return {
        ...data,
        loadMore,
        retry,
        stop,
    };
}
