import { deriveExternalSessionAttentionHasUnread } from '@/sync/domains/session/external/readExternalSessionAttention';
import { isUserFacingSession } from '@/sync/domains/session/listing/isUserFacingSession';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import {
    buildPendingSessionRequestsSourceSignature,
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
import type { Metadata, Session } from '@/sync/domains/state/storageTypes';
import type { StorageState } from '@/sync/store/types';
import { isVoiceConversationCustodySessionMetadata } from '@/voice/persistence/voiceConversationSystemSessionLookup';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';

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

function readSessionExternalUnreadBit(metadata: Metadata | null | undefined): '' | 0 | 1 {
    const hasUnread = deriveExternalSessionAttentionHasUnread(metadata);
    return hasUnread === null ? '' : readBooleanBit(hasUnread);
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
    return [
        session.active === true ? 1 : 0,
        buildPendingSessionRequestsSourceSignature(session),
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
    const ownerMetadata = readSessionOwnerMetadataView(session);
    const metadataUnavailable = session.metadataLayoutVersion === 1 && ownerMetadata == null;
    return [
        metadataUnavailable ? 1 : 0,
        isUserFacingSession({
            metadata: ownerMetadata,
            metadataUnavailable,
        }) ? 1 : 0,
        isVoiceConversationCustodySessionMetadata(ownerMetadata) ? 1 : 0,
        readNumber(session.seq) ?? '',
        readNumber(session.latestReadyEventSeq) ?? '',
        readNumber(session.lastViewedSessionSeq) ?? '',
        readReadStateSignature(ownerMetadata),
        readSessionExternalUnreadBit(ownerMetadata),
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

function buildAttentionRowSignature(row: SessionListAttentionRow, nowMs: number): string {
    const session = row.session;
    return [
        isUserFacingSession(session) ? 1 : 0,
        readTriStateBooleanBit(session.hasUnreadMessages),
        readNumber(session.seq) ?? '',
        readNumber(session.agentStateVersion) ?? '',
        readNumber(session.latestReadyEventSeq) ?? '',
        readNumber(session.lastViewedSessionSeq) ?? '',
        readReadStateSignature(session.metadata),
        session.latestTurnStatus ?? '',
        session.lastRuntimeIssue != null ? 1 : 0,
        readTriStateBooleanBit(session.hasPendingPermissionRequests),
        readTriStateBooleanBit(session.hasPendingUserActionRequests),
        readFreshnessBit(session.pendingRequestObservedAt, nowMs),
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
    storageState: StorageState | null,
): string {
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
        buildCollectionSignature(
            input.sessionRows,
            readAttentionRowScopeKey,
            (row) => buildAttentionRowSignature(row, nowMs),
        ),
    ].join(COLLECTION_SEPARATOR);
}

function areSameReferenceItems<T>(
    previous: readonly T[] | null,
    next: readonly T[],
): boolean {
    if (previous === null || previous.length !== next.length) return false;
    for (let index = 0; index < next.length; index += 1) {
        if (previous[index] !== next[index]) return false;
    }
    return true;
}

function buildRelevantSessionMessagesSignature(
    sessions: readonly Session[],
    sessionMessagesById: StorageState['sessionMessages'] | undefined,
): string {
    if (!sessionMessagesById) return '';
    return buildCollectionSignature(
        sessions,
        readSessionScopeKey,
        (session) => buildSessionMessagesPendingSignature(sessionMessagesById[session.id]),
    );
}

export function createInboxSessionContentSelector(
    evaluateInboxSessionContent: InboxSessionContentEvaluator = buildInboxSessionState,
): (input: InboxSessionContentInput) => boolean {
    const pendingProjectionCache = new Map<string, PendingRequestProjectionCacheEntry>();
    let previousSignature: string | null = null;
    let previousResult = false;
    let previousDeltaRevision: number | null = null;
    let previousNowMs: number | null = null;
    let previousSessions: readonly Session[] | null = null;
    let previousSessionRows: readonly SessionListAttentionRow[] | null = null;
    let previousStorageScopeSignature: string | null = null;
    let previousRelevantSessionMessagesSignature: string | null = null;

    return (input: InboxSessionContentInput): boolean => {
        const nowMs = typeof input.nowMs === 'number' && Number.isFinite(input.nowMs)
            ? Math.trunc(input.nowMs)
            : Date.now();
        const storageState = readRegisteredStorageState();
        const renderableDelta = storageState?.sessionListRenderableDelta;
        const storageScopeSignature = readStorageScopeSignature(storageState);
        const relevantSessionMessagesSignature = buildRelevantSessionMessagesSignature(
            input.sessions,
            input.sessionMessagesById ?? storageState?.sessionMessages,
        );
        if (
            previousSignature !== null
            && renderableDelta
            && previousDeltaRevision !== null
            && renderableDelta.revision !== previousDeltaRevision
            && renderableDelta.rebuiltSessionListIndex !== true
            && renderableDelta.changedSessionIds.length === 0
            && renderableDelta.removedSessionIds.length === 0
            && previousNowMs === nowMs
            && areSameReferenceItems(previousSessions, input.sessions)
            && areSameReferenceItems(previousSessionRows, input.sessionRows)
            && previousStorageScopeSignature === storageScopeSignature
            && previousRelevantSessionMessagesSignature === relevantSessionMessagesSignature
        ) {
            previousDeltaRevision = renderableDelta.revision;
            return previousResult;
        }
        const signature = buildInboxSessionContentSignature(input, nowMs, pendingProjectionCache, storageState);
        if (signature === previousSignature) {
            previousDeltaRevision = renderableDelta?.revision ?? null;
            previousNowMs = nowMs;
            previousSessions = input.sessions;
            previousSessionRows = input.sessionRows;
            previousStorageScopeSignature = storageScopeSignature;
            previousRelevantSessionMessagesSignature = relevantSessionMessagesSignature;
            return previousResult;
        }

        previousSignature = signature;
        previousDeltaRevision = renderableDelta?.revision ?? null;
        previousNowMs = nowMs;
        previousSessions = input.sessions;
        previousSessionRows = input.sessionRows;
        previousStorageScopeSignature = storageScopeSignature;
        previousRelevantSessionMessagesSignature = relevantSessionMessagesSignature;
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
