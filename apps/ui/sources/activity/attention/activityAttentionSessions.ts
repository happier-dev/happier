import { computeHasUnreadActivity } from '@/sync/domains/messages/unread';
import { isUserFacingSession } from '@/sync/domains/session/listing/isUserFacingSession';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { derivePendingRequestFlagsFromSession } from '@/sync/domains/session/pending/listPendingSessionRequests';
import { resolveLastViewedSessionSeq } from '@/sync/domains/session/readCursor/resolveLastViewedSessionSeq';
import type { Session } from '@/sync/domains/state/storageTypes';

export type ActivityAttentionSession = Session | SessionListRenderableSession;

export type ActivityAttentionSessionOptions = Readonly<{
    showUnread?: boolean;
    showPendingPermissionRequests?: boolean;
    showPendingUserActionRequests?: boolean;
    showQueuedUserInput?: boolean;
}>;

export type ActivityAttentionFlags = Readonly<{
    hasUnread: boolean;
    hasPendingPermissionRequests: boolean;
    hasPendingUserActionRequests: boolean;
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

export function deriveActivityAttentionFlags(
    session: ActivityAttentionSession,
    options?: ActivityAttentionSessionOptions,
): ActivityAttentionFlags {
    const isSessionActive = session.active === true;
    const metadataAvailable = hasMetadataAvailable(session);

    const hasUnread = metadataAvailable && options?.showUnread !== false
        ? readSessionBooleanFlag(session, 'hasUnreadMessages') ?? computeHasUnreadActivity({
            sessionSeq: session.seq ?? 0,
            pendingActivityAt: 0,
            lastViewedSessionSeq: resolveLastViewedSessionSeq(session),
            lastViewedPendingActivityAt: session.metadata?.readStateV1?.pendingActivityAt,
        })
        : false;

    const pendingFlags = isHydratedSession(session)
        ? derivePendingRequestFlagsFromSession(session)
        : null;

    const hasPendingPermissionRequests =
        isSessionActive
        && options?.showPendingPermissionRequests !== false
        && (
            readSessionBooleanFlag(session, 'hasPendingPermissionRequests')
            ?? pendingFlags?.hasPendingPermissionRequests
            ?? false
        );

    const hasPendingUserActionRequests =
        isSessionActive
        && options?.showPendingUserActionRequests !== false
        && (
            readSessionBooleanFlag(session, 'hasPendingUserActionRequests')
            ?? pendingFlags?.hasPendingUserActionRequests
            ?? false
        );

    const hasQueuedUserInput = options?.showQueuedUserInput === false
        ? false
        : (session.pendingCount ?? 0) > 0;

    return {
        hasUnread,
        hasPendingPermissionRequests,
        hasPendingUserActionRequests,
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
        || flags.hasQueuedUserInput
    );
}
