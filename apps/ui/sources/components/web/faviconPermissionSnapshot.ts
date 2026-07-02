import {
    deriveLatestPendingRequestObservedAtFromSession,
    derivePendingRequestFlagsFromSession,
} from '@/sync/domains/session/pending/listPendingSessionRequests';
import {
    deriveSessionRuntimePresentationState,
    isFreshTimestamp,
    SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS,
} from '@/sync/domains/session/attention/runtimePresentation';
import { readStoredSessionMessages } from '@/sync/domains/messages/readStoredSessionMessages';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { StorageState } from '@/sync/store/types';

export type FaviconPermissionSnapshot = Readonly<{
    hasFreshPermission: boolean;
    nextRefreshDelayMs: number | null;
}>;

type SignatureCacheEntry<T> = Readonly<{
    signature: string;
    value: T;
}>;

type PendingRequestObservedAtCacheEntry = Readonly<{
    sessionSignature: string;
    sessionMessagesSignature: string;
    value: number | null;
}>;

function collectRecordIds<T>(record: Readonly<Record<string, T>> | null | undefined): string[] {
    const ids: string[] = [];
    if (!record || typeof record !== 'object') return ids;
    for (const id in record) {
        if (!Object.prototype.hasOwnProperty.call(record, id)) continue;
        ids.push(id);
    }
    return ids;
}

function readNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : null;
}

function readFreshnessRefreshDelayMs(timestamp: number | null | undefined, nowMs: number): number | null {
    if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return null;
    const normalizedTimestamp = Math.trunc(timestamp);
    if (!isFreshTimestamp(normalizedTimestamp, nowMs, SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS)) return null;
    return Math.max(
        0,
        normalizedTimestamp + SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS - nowMs + 1,
    );
}

function readRequestSignature(value: unknown): string {
    if (!value || typeof value !== 'object') return '';
    const requests = value as Record<string, {
        tool?: unknown;
        kind?: unknown;
        createdAt?: unknown;
    }>;
    return collectRecordIds(requests).sort().map((requestId) => {
        const request = requests[requestId];
        return [
            requestId,
            typeof request?.tool === 'string' ? request.tool : '',
            typeof request?.kind === 'string' ? request.kind : '',
            readNumber(request?.createdAt) ?? '',
        ].join(':');
    }).join('|');
}

function readCompletedRequestSignature(value: unknown): string {
    if (!value || typeof value !== 'object') return '';
    const completed = value as Record<string, { completedAt?: unknown; createdAt?: unknown }>;
    return collectRecordIds(completed).sort().map((requestId) => {
        const request = completed[requestId];
        return [
            requestId,
            readNumber(request?.completedAt) ?? '',
            readNumber(request?.createdAt) ?? '',
        ].join(':');
    }).join('|');
}

function buildSessionPermissionSignature(session: Session): string {
    const agentState = session.agentState;
    return [
        session.id,
        session.active === true ? 1 : 0,
        readNumber(session.activeAt) ?? '',
        session.presence,
        session.thinking === true ? 1 : 0,
        readNumber(session.thinkingAt) ?? '',
        session.latestTurnStatus ?? '',
        readNumber(session.latestTurnStatusObservedAt) ?? '',
        readNumber(session.meaningfulActivityAt) ?? '',
        readNumber(session.pendingPermissionRequestCount) ?? '',
        readNumber(session.pendingUserActionRequestCount) ?? '',
        readNumber(session.pendingRequestObservedAt) ?? '',
        readRequestSignature(agentState?.requests),
        readCompletedRequestSignature(agentState?.completedRequests),
    ].join('\u001f');
}

function buildSessionMessagesPermissionSignature(
    sessionMessages: StorageState['sessionMessages'][string] | undefined,
): string {
    if (!sessionMessages) return '';
    return [
        sessionMessages.isLoaded === true ? 1 : 0,
        readNumber(sessionMessages.messagesVersion) ?? '',
        readNumber(sessionMessages.latestReadyEventSeq) ?? '',
        readNumber(sessionMessages.latestReadyEventAt) ?? '',
        sessionMessages.messageIdsOldestFirst?.length ?? '',
    ].join('\u001f');
}

function deriveFreshPermissionRefreshDelayMs(
    session: Session,
    pendingRequestObservedAt: number | null,
    nowMs: number,
): number | null {
    const delays: number[] = [];
    const addDelay = (timestamp: number | null | undefined) => {
        const delay = readFreshnessRefreshDelayMs(timestamp, nowMs);
        if (delay !== null) delays.push(delay);
    };

    addDelay(pendingRequestObservedAt);
    addDelay(session.latestTurnStatusObservedAt);
    addDelay(session.thinkingAt);
    addDelay(session.activeAt);

    return delays.length === 0 ? null : Math.min(...delays);
}

function deriveFaviconPermissionSnapshotFromSessions(
    state: StorageState,
    sessionIds: readonly string[],
    nowMs: number,
): FaviconPermissionSnapshot {
    let hasFreshPermission = false;
    let nextRefreshDelayMs: number | null = null;

    for (const sessionId of sessionIds) {
        const session = state.sessions[sessionId];
        if (!session) continue;
        const messages = readStoredSessionMessages(state, session.id);
        const pendingFlags = derivePendingRequestFlagsFromSession(session, messages);
        const pendingRequestObservedAt = deriveLatestPendingRequestObservedAtFromSession(session, messages);
        const runtimeState = deriveSessionRuntimePresentationState({
            active: session.active,
            activeAt: session.activeAt,
            presence: session.presence,
            thinking: session.thinking,
            thinkingAt: session.thinkingAt,
            latestTurnStatus: session.latestTurnStatus ?? null,
            latestTurnStatusObservedAt: session.latestTurnStatusObservedAt ?? null,
            meaningfulActivityAt: session.meaningfulActivityAt ?? null,
            lastRuntimeIssue: session.lastRuntimeIssue ?? null,
            hasPendingPermissionRequests: pendingFlags.hasPendingPermissionRequests,
            hasPendingUserActionRequests: pendingFlags.hasPendingUserActionRequests,
            pendingRequestObservedAt,
            nowMs,
        });

        if (!runtimeState.freshPermissionRequired) continue;

        hasFreshPermission = true;
        const refreshDelayMs = deriveFreshPermissionRefreshDelayMs(session, pendingRequestObservedAt, nowMs);
        if (refreshDelayMs !== null) {
            nextRefreshDelayMs = nextRefreshDelayMs === null
                ? refreshDelayMs
                : Math.min(nextRefreshDelayMs, refreshDelayMs);
        }
    }

    return {
        hasFreshPermission,
        nextRefreshDelayMs,
    };
}

function buildRecordSignature<T>(
    record: Readonly<Record<string, T>>,
    cache: Map<string, SignatureCacheEntry<T>>,
    buildValueSignature: (value: T, id: string) => string,
): string {
    const ids = collectRecordIds(record).sort();
    for (const cachedId of cache.keys()) {
        if (!Object.prototype.hasOwnProperty.call(record, cachedId)) {
            cache.delete(cachedId);
        }
    }
    return ids.map((id) => {
        const value = record[id];
        const cached = cache.get(id);
        const signature = cached !== undefined && cached.value === value
            ? cached.signature
            : buildValueSignature(value, id);
        if (cached?.value !== value) {
            cache.set(id, { signature, value });
        }
        return `${id}\u001e${signature}`;
    }).join('\u001d');
}

function buildSessionMessagesRecordSignature(
    sessionIds: readonly string[],
    sessionMessages: StorageState['sessionMessages'] | undefined,
    cache: Map<string, SignatureCacheEntry<StorageState['sessionMessages'][string]>>,
): string {
    for (const cachedId of cache.keys()) {
        if (!sessionIds.includes(cachedId)) {
            cache.delete(cachedId);
        }
    }
    return sessionIds.map((id) => {
        const value = sessionMessages?.[id];
        const cached = cache.get(id);
        const signature = cached !== undefined && cached.value === value
            ? cached.signature
            : buildSessionMessagesPermissionSignature(value);
        if (value) {
            cache.set(id, { signature, value });
        } else {
            cache.delete(id);
        }
        return `${id}\u001e${signature}`;
    }).join('\u001d');
}

function buildRuntimeFreshnessRecordSignature(
    state: StorageState,
    sessionIds: readonly string[],
    nowMs: number,
    pendingRequestObservedAtCache: Map<string, PendingRequestObservedAtCacheEntry>,
    sessionSignatureCache: ReadonlyMap<string, SignatureCacheEntry<Session>>,
    sessionMessagesSignatureCache: ReadonlyMap<string, SignatureCacheEntry<StorageState['sessionMessages'][string]>>,
): string {
    const activeIds = new Set(sessionIds);
    for (const cachedId of pendingRequestObservedAtCache.keys()) {
        if (!activeIds.has(cachedId)) {
            pendingRequestObservedAtCache.delete(cachedId);
        }
    }

    return sessionIds.map((id) => {
        const session = state.sessions[id];
        const sessionSignature = sessionSignatureCache.get(id)?.signature
            ?? buildSessionPermissionSignature(session);
        const sessionMessagesSignature = sessionMessagesSignatureCache.get(id)?.signature
            ?? buildSessionMessagesPermissionSignature(state.sessionMessages?.[id]);
        const cachedPendingRequestObservedAt = pendingRequestObservedAtCache.get(id);
        const pendingRequestObservedAt = cachedPendingRequestObservedAt?.sessionSignature === sessionSignature
            && cachedPendingRequestObservedAt.sessionMessagesSignature === sessionMessagesSignature
            ? cachedPendingRequestObservedAt.value
            : (() => {
                const messages = readStoredSessionMessages(state, id);
                const value = deriveLatestPendingRequestObservedAtFromSession(session, messages);
                pendingRequestObservedAtCache.set(id, {
                    sessionSignature,
                    sessionMessagesSignature,
                    value,
                });
                return value;
            })();
        return [
            id,
            readFreshnessRefreshDelayMs(session.activeAt, nowMs) === null ? 0 : 1,
            readFreshnessRefreshDelayMs(session.thinkingAt, nowMs) === null ? 0 : 1,
            readFreshnessRefreshDelayMs(session.latestTurnStatusObservedAt, nowMs) === null ? 0 : 1,
            readFreshnessRefreshDelayMs(pendingRequestObservedAt, nowMs) === null ? 0 : 1,
        ].join(':');
    }).join('\u001d');
}

export function createFaviconPermissionSnapshotSelector(): (state: StorageState) => FaviconPermissionSnapshot {
    const sessionSignatureCache = new Map<string, SignatureCacheEntry<Session>>();
    const sessionMessagesSignatureCache = new Map<string, SignatureCacheEntry<StorageState['sessionMessages'][string]>>();
    const pendingRequestObservedAtCache = new Map<string, PendingRequestObservedAtCacheEntry>();
    let previousSignature: string | null = null;
    let previousSnapshot: FaviconPermissionSnapshot | null = null;

    return (state) => {
        const nowMs = Date.now();
        const sessionIds = collectRecordIds(state.sessions).sort();
        const signature = [
            buildRecordSignature(state.sessions, sessionSignatureCache, buildSessionPermissionSignature),
            buildSessionMessagesRecordSignature(sessionIds, state.sessionMessages, sessionMessagesSignatureCache),
            buildRuntimeFreshnessRecordSignature(
                state,
                sessionIds,
                nowMs,
                pendingRequestObservedAtCache,
                sessionSignatureCache,
                sessionMessagesSignatureCache,
            ),
        ].join('\u001c');

        if (signature === previousSignature && previousSnapshot) {
            return previousSnapshot;
        }

        previousSignature = signature;
        previousSnapshot = deriveFaviconPermissionSnapshotFromSessions(state, sessionIds, nowMs);
        return previousSnapshot;
    };
}
