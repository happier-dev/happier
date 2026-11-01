import { computeHasUnreadActivity } from '@/sync/domains/messages/unread';
import {
    readStoredSessionMessagesFromStateLike,
    readStoredSessionMessagesReadProjectionFromStateLike,
} from '@/sync/domains/messages/readStoredSessionMessages';
import { isUserFacingSession } from '@/sync/domains/session/listing/isUserFacingSession';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import {
    deriveLatestPendingRequestObservedAtFromSession,
    derivePendingRequestFlagsFromSession,
} from '@/sync/domains/session/pending/listPendingSessionRequests';
import { resolveLastViewedSessionSeq } from '@/sync/domains/session/readCursor/resolveLastViewedSessionSeq';
import { resolveSessionReadableSeq } from '@/sync/domains/session/readCursor/resolveSessionReadableSeq';
import type { Session } from '@/sync/domains/state/storageTypes';
import { readRegisteredStorageState } from '@/sync/domains/state/storageStateReaderBridge';
import { deriveSessionRuntimePresentationState } from '@/sync/domains/session/attention/deriveSessionRuntimePresentationState';
import { forEachRecordValue } from '@/sync/store/sessionRecordProjection';
import type { StorageState } from '@/sync/store/types';

export type ActivityAttentionSession = Session | SessionListRenderableSession;

export type ActivityAttentionSessionOptions = Readonly<{
    showUnread?: boolean;
    showPendingPermissionRequests?: boolean;
    showPendingUserActionRequests?: boolean;
    showQueuedUserInput?: boolean;
    sessionMessagesById?: StorageState['sessionMessages'];
    nowMs?: number;
}>;

export type ActivityAttentionFlags = Readonly<{
    hasUnread: boolean;
    hasPendingPermissionRequests: boolean;
    hasPendingUserActionRequests: boolean;
    hasBlockedPendingDelivery: boolean;
    hasQueuedUserInput: boolean;
}>;

function isHydratedSession(session: ActivityAttentionSession): session is Session {
    return 'agentState' in session;
}

function readSessionBooleanFlag(
    session: ActivityAttentionSession,
    flag: 'hasPendingPermissionRequests' | 'hasPendingUserActionRequests' | 'hasUnreadMessages',
): boolean | null {
    const value = (session as Partial<Record<typeof flag, unknown>>)[flag];
    return typeof value === 'boolean' ? value : null;
}

function hasMetadataAvailable(session: ActivityAttentionSession): boolean {
    return !('metadataUnavailable' in session && session.metadataUnavailable === true);
}

function readSessionMessagesStateForAttention(
    session: ActivityAttentionSession,
    options?: ActivityAttentionSessionOptions,
): StorageState['sessionMessages'][string] | null | undefined {
    if (!isHydratedSession(session)) return null;
    if (options?.sessionMessagesById) {
        return options.sessionMessagesById[session.id];
    }
    const storageState = readRegisteredStorageState();
    if (!storageState) return null;
    return storageState.sessionMessages?.[session.id];
}

function resolveActivityReadableSeq(
    session: ActivityAttentionSession,
    sessionMessages: StorageState['sessionMessages'][string] | null | undefined,
): number {
    return resolveSessionReadableSeq({
        messagesProjection: readStoredSessionMessagesReadProjectionFromStateLike(sessionMessages),
        sessionSeq: session.seq,
        latestReadyEventSeq: session.latestReadyEventSeq,
        latestTurnStatus: session.latestTurnStatus ?? null,
        includeTerminalSessionSeq: true,
    }) ?? 0;
}

export function resolveActivityAttentionSessions(params: Readonly<{
    sessions: readonly Session[];
    sessionRows?: readonly ActivityAttentionSession[];
}>): ActivityAttentionSession[] {
    const sessionsById = new Map(params.sessions.map((session) => [session.id, session]));
    const resolvedSessions: ActivityAttentionSession[] = [];
    const seenSessionIds = new Set<string>();

    const pushSession = (session: ActivityAttentionSession) => {
        if (seenSessionIds.has(session.id)) return;
        seenSessionIds.add(session.id);
        const canonical = sessionsById.get(session.id) ?? session;
        // Archived sessions belong only to the archived surface. Keep this
        // exclusion in the shared attention source so inbox, badges, and
        // native activity consumers cannot independently re-promote them from
        // stale pending/unread fields.
        if (session.archivedAt != null || canonical.archivedAt != null) return;
        if (!isUserFacingSession(canonical)) return;
        resolvedSessions.push(canonical);
    };

    for (const row of params.sessionRows ?? []) {
        pushSession(row);
    }

    for (const session of params.sessions) {
        pushSession(session);
    }

    return resolvedSessions;
}

export function resolveActivityAttentionSessionsFromRecords(params: Readonly<{
    sessionsById: Readonly<Record<string, Session>>;
    sessionRowsById?: Readonly<Record<string, ActivityAttentionSession>>;
}>): ActivityAttentionSession[] {
    const resolvedSessions: ActivityAttentionSession[] = [];
    const seenSessionIds = new Set<string>();

    const pushSession = (session: ActivityAttentionSession) => {
        if (seenSessionIds.has(session.id)) return;
        seenSessionIds.add(session.id);
        const canonical = params.sessionsById[session.id] ?? session;
        if (session.archivedAt != null || canonical.archivedAt != null) return;
        if (!isUserFacingSession(canonical)) return;
        resolvedSessions.push(canonical);
    };

    if (params.sessionRowsById) {
        forEachRecordValue(params.sessionRowsById, pushSession);
    }
    forEachRecordValue(params.sessionsById, pushSession);

    return resolvedSessions;
}

export function deriveActivityAttentionFlags(
    session: ActivityAttentionSession,
    options?: ActivityAttentionSessionOptions,
): ActivityAttentionFlags {
    const metadataAvailable = hasMetadataAvailable(session);
    const sessionMessagesState = readSessionMessagesStateForAttention(session, options);

    const hasUnread = metadataAvailable && options?.showUnread !== false
        ? readSessionBooleanFlag(session, 'hasUnreadMessages') ?? computeHasUnreadActivity({
            sessionSeq: resolveActivityReadableSeq(session, sessionMessagesState),
            pendingActivityAt: 0,
            lastViewedSessionSeq: resolveLastViewedSessionSeq(session),
            lastViewedPendingActivityAt: session.metadata?.readStateV1?.pendingActivityAt,
        })
        : false;

    const sessionMessages = sessionMessagesState === null
        ? undefined
        : readStoredSessionMessagesFromStateLike(sessionMessagesState);
    const pendingFlags = isHydratedSession(session)
        ? derivePendingRequestFlagsFromSession(session, sessionMessages)
        : null;

    const pendingPermissionCandidate = options?.showPendingPermissionRequests !== false
        && (
            readSessionBooleanFlag(session, 'hasPendingPermissionRequests')
            ?? pendingFlags?.hasPendingPermissionRequests
            ?? false
        );

    const pendingUserActionCandidate = options?.showPendingUserActionRequests !== false
        && (
            readSessionBooleanFlag(session, 'hasPendingUserActionRequests')
            ?? pendingFlags?.hasPendingUserActionRequests
            ?? false
        );

    const runtimeStatus = deriveSessionRuntimePresentationState({
        active: session.active,
        activeAt: session.activeAt,
        presence: session.presence,
        thinking: session.thinking,
        thinkingAt: session.thinkingAt,
        latestTurnStatus: session.latestTurnStatus,
        latestTurnStatusObservedAt: session.latestTurnStatusObservedAt,
        meaningfulActivityAt: session.meaningfulActivityAt,
        hasPendingPermissionRequests: pendingPermissionCandidate,
        hasPendingUserActionRequests: pendingUserActionCandidate,
        pendingRequestObservedAt: isHydratedSession(session)
            ? deriveLatestPendingRequestObservedAtFromSession(session, sessionMessages)
            : session.pendingRequestObservedAt ?? null,
    }, options?.nowMs ?? Date.now());

    const hasPendingPermissionRequests = runtimeStatus.freshPermissionRequired;
    const hasPendingUserActionRequests = runtimeStatus.freshActionRequired;

    const hasQueuedUserInput = options?.showQueuedUserInput === false
        ? false
        : (session.pendingCount ?? 0) > 0;
    const hasBlockedPendingDelivery = (session.pendingBlockedCount ?? 0) > 0;

    return {
        hasUnread,
        hasPendingPermissionRequests,
        hasPendingUserActionRequests,
        hasBlockedPendingDelivery,
        hasQueuedUserInput,
    };
}

export function hasActivityAttention(
    session: ActivityAttentionSession,
    options?: ActivityAttentionSessionOptions,
): boolean {
    const flags = deriveActivityAttentionFlags(session, options);
    return (
        flags.hasUnread
        || flags.hasPendingPermissionRequests
        || flags.hasPendingUserActionRequests
        || flags.hasBlockedPendingDelivery
        || flags.hasQueuedUserInput
    );
}
