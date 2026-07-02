import { deriveExternalSessionAttentionHasUnread } from '@/sync/domains/session/external/readExternalSessionAttention';
import { isUserFacingSession } from '@/sync/domains/session/listing/isUserFacingSession';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import {
    deriveLatestPendingRequestObservedAtFromSession,
    derivePendingRequestFlagsFromSession,
} from '@/sync/domains/session/pending/listPendingSessionRequests';
import {
    readStoredSessionMessages,
    readStoredSessionMessagesFromStateLike,
} from '@/sync/domains/messages/readStoredSessionMessages';
import {
    isFreshTimestamp,
    SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS,
} from '@/sync/domains/session/attention/runtimePresentation';
import type { SessionListAttentionRow } from '@/sync/domains/state/storage';
import { readRegisteredStorageState } from '@/sync/domains/state/storageStateReaderBridge';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { StorageState } from '@/sync/store/types';

import { buildInboxSessionState, type InboxSessionState } from './buildInboxSessionState';

type InboxSessionContentInput = Readonly<{
    sessions: readonly Session[];
    sessionRows: readonly SessionListAttentionRow[];
    sessionMessagesById?: StorageState['sessionMessages'];
    nowMs?: number;
}>;

type InboxSessionContentEvaluator = (input: Readonly<{
    sessions: readonly Session[];
    sessionRows: readonly SessionListAttentionRow[];
    sessionMessagesById?: StorageState['sessionMessages'];
    nowMs: number;
}>) => InboxSessionState;
type ReadStateMetadata = Readonly<{
    readStateV1?: Readonly<{
        sessionSeq?: unknown;
        pendingActivityAt?: unknown;
    }> | null;
}> | null | undefined;

type PendingRequestProjection = Readonly<{
    hasPendingPermissionRequests: boolean;
    hasPendingUserActionRequests: boolean;
    pendingRequestObservedAt: number | null;
}>;

type PendingRequestProjectionCacheEntry = Readonly<{
    storageScopeSignature: string;
    sessionSignature: string;
    sessionMessagesSignature: string;
    value: PendingRequestProjection;
}>;

const FIELD_SEPARATOR = '\u001f';
const ITEM_SEPARATOR = '\u001d';
const COLLECTION_SEPARATOR = '\u001c';

function normalizeOptionalString(value: string | null | undefined): string | null {
    const normalized = typeof value === 'string' ? value.trim() : '';
    return normalized.length > 0 ? normalized : null;
}

function readNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : null;
}

function readBooleanBit(value: unknown): 0 | 1 {
    return value === true ? 1 : 0;
}

function readTriStateBooleanBit(value: unknown): '' | 0 | 1 {
    return typeof value === 'boolean' ? readBooleanBit(value) : '';
}

function readFreshnessBit(value: unknown, nowMs: number): 0 | 1 {
    const timestamp = readNumber(value);
    return isFreshTimestamp(timestamp, nowMs, SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS) ? 1 : 0;
}

function readSessionExternalUnreadBit(session: Pick<Session, 'metadata'>): '' | 0 | 1 {
    const hasUnread = deriveExternalSessionAttentionHasUnread(session.metadata);
    return hasUnread === null ? '' : readBooleanBit(hasUnread);
}

function readRequestSignature(value: unknown): string {
    if (!value || typeof value !== 'object') return '';
    const requests = value as Record<string, {
        createdAt?: unknown;
        kind?: unknown;
        tool?: unknown;
    }>;
    return Object.keys(requests).sort().map((requestId) => {
        const request = requests[requestId];
        return [
            requestId,
            typeof request?.tool === 'string' ? request.tool : '',
            typeof request?.kind === 'string' ? request.kind : '',
            readNumber(request?.createdAt) ?? '',
        ].join(FIELD_SEPARATOR);
    }).join(ITEM_SEPARATOR);
}

function readCompletedRequestSignature(value: unknown): string {
    if (!value || typeof value !== 'object') return '';
    const completed = value as Record<string, { completedAt?: unknown; createdAt?: unknown }>;
    return Object.keys(completed).sort().map((requestId) => {
        const request = completed[requestId];
        return [
            requestId,
            readNumber(request?.completedAt) ?? '',
            readNumber(request?.createdAt) ?? '',
        ].join(FIELD_SEPARATOR);
    }).join(ITEM_SEPARATOR);
}

function readSessionScopeKey(session: Session): string {
    return `${normalizeOptionalString(session.serverId) ?? 'local'}:${session.id}`;
}

function readStorageScopeSignature(storageState: StorageState | null): string {
    const readScope = (scope: StorageState['profileScope']): string => [
        normalizeOptionalString(scope?.serverId) ?? '',
        normalizeOptionalString(scope?.accountId) ?? '',
    ].join(FIELD_SEPARATOR);

    return [
        readScope(storageState?.profileScope ?? null),
        readScope(storageState?.settingsScope ?? null),
        readScope(storageState?.sessionLocalStateScope ?? null),
    ].join(ITEM_SEPARATOR);
}

function readAttentionRowScopeKey(row: SessionListAttentionRow): string {
    return `${normalizeOptionalString(row.serverId) ?? 'local'}:${row.session.id}`;
}

function readReadStateSignature(
    metadata: ReadStateMetadata,
): string {
    const readState = metadata?.readStateV1;
    return [
        readNumber(readState?.sessionSeq) ?? '',
        readNumber(readState?.pendingActivityAt) ?? '',
    ].join(FIELD_SEPARATOR);
}

function buildPendingRequestSessionSignature(session: Session): string {
    const agentState = session.agentState;
    const hasProjectedPendingRequestCounts =
        typeof session.pendingPermissionRequestCount === 'number'
        || typeof session.pendingUserActionRequestCount === 'number';
    return [
        session.active === true ? 1 : 0,
        hasProjectedPendingRequestCounts ? readNumber(session.updatedAt) ?? '' : '',
        readNumber(session.pendingPermissionRequestCount) ?? '',
        readNumber(session.pendingUserActionRequestCount) ?? '',
        readNumber(session.pendingRequestObservedAt) ?? '',
        readRequestSignature(agentState?.requests),
        readCompletedRequestSignature(agentState?.completedRequests),
    ].join(FIELD_SEPARATOR);
}

function buildSessionMessagesPendingSignature(
    sessionMessages: StorageState['sessionMessages'][string] | undefined,
): string {
    if (!sessionMessages) return '';
    return [
        sessionMessages.isLoaded === true ? 1 : 0,
        readNumber(sessionMessages.messagesVersion) ?? '',
        readNumber(sessionMessages.latestReadyEventSeq) ?? '',
        readNumber(sessionMessages.latestReadyEventAt) ?? '',
        sessionMessages.messageIdsOldestFirst.length,
    ].join(FIELD_SEPARATOR);
}

function readPendingRequestProjection(
    params: Readonly<{
        cache: Map<string, PendingRequestProjectionCacheEntry>;
        session: Session;
        sessionMessages: StorageState['sessionMessages'][string] | undefined;
        scopeKey: string;
        storageState: StorageState | null;
        storageScopeSignature: string;
    }>,
): PendingRequestProjection {
    const sessionSignature = buildPendingRequestSessionSignature(params.session);
    const sessionMessagesSignature = buildSessionMessagesPendingSignature(params.sessionMessages);
    const cached = params.cache.get(params.scopeKey);
    if (
        cached?.storageScopeSignature === params.storageScopeSignature
        && cached.sessionSignature === sessionSignature
        && cached.sessionMessagesSignature === sessionMessagesSignature
    ) {
        return cached.value;
    }

    const messages = params.sessionMessages
        ? readStoredSessionMessagesFromStateLike(params.sessionMessages)
        : params.storageState
            ? readStoredSessionMessages(params.storageState, params.session.id)
            : [];
    const pendingFlags = derivePendingRequestFlagsFromSession(params.session, messages);
    const pendingRequestObservedAt =
        pendingFlags.hasPendingPermissionRequests || pendingFlags.hasPendingUserActionRequests
            ? deriveLatestPendingRequestObservedAtFromSession(params.session, messages)
            : null;
    const value: PendingRequestProjection = {
        hasPendingPermissionRequests: pendingFlags.hasPendingPermissionRequests,
        hasPendingUserActionRequests: pendingFlags.hasPendingUserActionRequests,
        pendingRequestObservedAt,
    };
    params.cache.set(params.scopeKey, {
        storageScopeSignature: params.storageScopeSignature,
        sessionSignature,
        sessionMessagesSignature,
        value,
    });
    return value;
}

function buildCanonicalSessionSignature(
    session: Session,
    nowMs: number,
    pendingProjection: PendingRequestProjection,
): string {
    return [
        isUserFacingSession(session) ? 1 : 0,
        readNumber(session.seq) ?? '',
        readNumber(session.latestReadyEventSeq) ?? '',
        readNumber(session.lastViewedSessionSeq) ?? '',
        readReadStateSignature(session.metadata),
        readSessionExternalUnreadBit(session),
        session.latestTurnStatus ?? '',
        session.lastRuntimeIssue != null ? 1 : 0,
        session.active === true ? 1 : 0,
        session.presence,
        session.thinking === true ? 1 : 0,
        pendingProjection.hasPendingPermissionRequests ? 1 : 0,
        pendingProjection.hasPendingUserActionRequests ? 1 : 0,
        readFreshnessBit(session.thinkingAt, nowMs),
        readFreshnessBit(session.latestTurnStatusObservedAt, nowMs),
        readFreshnessBit(session.meaningfulActivityAt, nowMs),
        readFreshnessBit(pendingProjection.pendingRequestObservedAt, nowMs),
    ].join(FIELD_SEPARATOR);
}

function buildAttentionRowSignature(row: SessionListAttentionRow): string {
    const session = row.session;
    return [
        isUserFacingSession(session) ? 1 : 0,
        readTriStateBooleanBit(session.hasUnreadMessages),
        readNumber(session.seq) ?? '',
        readNumber(session.latestReadyEventSeq) ?? '',
        readNumber(session.lastViewedSessionSeq) ?? '',
        readReadStateSignature(session.metadata),
        session.latestTurnStatus ?? '',
        session.lastRuntimeIssue != null ? 1 : 0,
    ].join(FIELD_SEPARATOR);
}

function buildCollectionSignature<T>(
    items: readonly T[],
    readScopeKey: (item: T) => string,
    buildItemSignature: (item: T) => string,
): string {
    const keyCounts = new Map<string, number>();
    for (const item of items) {
        const key = readScopeKey(item);
        keyCounts.set(key, (keyCounts.get(key) ?? 0) + 1);
    }

    return items
        .map((item, index) => {
            const key = readScopeKey(item);
            const scopedKey = (keyCounts.get(key) ?? 0) > 1 ? `${key}#${index}` : key;
            return `${scopedKey}${FIELD_SEPARATOR}${buildItemSignature(item)}`;
        })
        .sort()
        .join(ITEM_SEPARATOR);
}

function prunePendingRequestProjectionCache(
    cache: Map<string, PendingRequestProjectionCacheEntry>,
    sessions: readonly Session[],
): void {
    const activeKeys = new Set(sessions.map(readSessionScopeKey));
    for (const cachedKey of cache.keys()) {
        if (!activeKeys.has(cachedKey)) {
            cache.delete(cachedKey);
        }
    }
}

function buildInboxSessionContentSignature(
    input: InboxSessionContentInput,
    nowMs: number,
    pendingProjectionCache: Map<string, PendingRequestProjectionCacheEntry>,
): string {
    const storageState = readRegisteredStorageState();
    const storageScopeSignature = readStorageScopeSignature(storageState);
    prunePendingRequestProjectionCache(pendingProjectionCache, input.sessions);
    return [
        storageScopeSignature,
        buildCollectionSignature(input.sessions, readSessionScopeKey, (session) => {
            const scopeKey = readSessionScopeKey(session);
            const pendingProjection = readPendingRequestProjection({
                cache: pendingProjectionCache,
                session,
                sessionMessages: input.sessionMessagesById?.[session.id] ?? storageState?.sessionMessages?.[session.id],
                scopeKey,
                storageState,
                storageScopeSignature,
            });
            return buildCanonicalSessionSignature(session, nowMs, pendingProjection);
        }),
        buildCollectionSignature(input.sessionRows, readAttentionRowScopeKey, buildAttentionRowSignature),
    ].join(COLLECTION_SEPARATOR);
}

export function createInboxSessionContentSelector(
    evaluateInboxSessionContent: InboxSessionContentEvaluator = buildInboxSessionState,
): (input: InboxSessionContentInput) => boolean {
    const pendingProjectionCache = new Map<string, PendingRequestProjectionCacheEntry>();
    let previousSignature: string | null = null;
    let previousResult = false;

    return (input: InboxSessionContentInput): boolean => {
        const nowMs = typeof input.nowMs === 'number' && Number.isFinite(input.nowMs)
            ? Math.trunc(input.nowMs)
            : Date.now();
        const signature = buildInboxSessionContentSignature(input, nowMs, pendingProjectionCache);
        if (signature === previousSignature) {
            return previousResult;
        }

        previousSignature = signature;
        const storageState = readRegisteredStorageState();
        const state = evaluateInboxSessionContent({
            sessions: input.sessions,
            sessionRows: input.sessionRows,
            sessionMessagesById: input.sessionMessagesById ?? storageState?.sessionMessages,
            nowMs,
        });
        previousResult = state.sessionsNeedingAttention.length > 0 || state.unreadSessions.length > 0;
        return previousResult;
    };
}
