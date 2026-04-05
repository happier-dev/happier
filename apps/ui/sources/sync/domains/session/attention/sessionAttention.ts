import { computeHasUnreadActivity } from '@/sync/domains/messages/unread';
import { deriveDirectSessionAttentionHasUnread } from '@/sync/domains/session/directSessions/readDirectSessionAttention';
import { readDirectSessionLink } from '@/sync/domains/session/directSessions/readDirectSessionLink';
import { resolveLastViewedSessionSeq } from '@/sync/domains/session/readCursor/resolveLastViewedSessionSeq';
import { derivePendingRequestFlagsFromAgentState } from '@/sync/domains/session/listing/sessionListRenderable';
import type { Session } from '@/sync/domains/state/storageTypes';

export type SessionAttentionOptions = Readonly<{
    showUnread?: boolean;
    showPendingPermissionRequests?: boolean;
    showPendingUserActionRequests?: boolean;
    showQueuedUserInput?: boolean;
}>;

export type SessionAttentionFlags = Readonly<{
    hasUnread: boolean;
    hasPendingPermissionRequests: boolean;
    hasPendingUserActionRequests: boolean;
    hasQueuedUserInput: boolean;
}>;

export function deriveSessionAttentionFlags(
    session: Session,
    options?: SessionAttentionOptions,
): SessionAttentionFlags {
    const isSessionActive = session.active === true;
    const pendingFlags = derivePendingRequestFlagsFromAgentState(session.agentState);
    const directSessionHasUnread = readDirectSessionLink(session.metadata)
        ? deriveDirectSessionAttentionHasUnread(session.metadata)
        : null;

    const hasUnread = options?.showUnread === false
        ? false
        : directSessionHasUnread ?? computeHasUnreadActivity({
            sessionSeq: session.seq ?? 0,
            pendingActivityAt: 0,
            lastViewedSessionSeq: resolveLastViewedSessionSeq(session),
            lastViewedPendingActivityAt: session.metadata?.readStateV1?.pendingActivityAt,
        });

    const hasPendingPermissionRequests = isSessionActive && options?.showPendingPermissionRequests !== false
        ? typeof session.pendingPermissionRequestCount === 'number'
            ? session.pendingPermissionRequestCount > 0
            : pendingFlags.hasPendingPermissionRequests
        : false;

    const hasPendingUserActionRequests = isSessionActive && options?.showPendingUserActionRequests !== false
        ? typeof session.pendingUserActionRequestCount === 'number'
            ? session.pendingUserActionRequestCount > 0
            : pendingFlags.hasPendingUserActionRequests
        : false;

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

export function hasSessionAttention(session: Session, options?: SessionAttentionOptions): boolean {
    const flags = deriveSessionAttentionFlags(session, options);
    return (
        flags.hasUnread ||
        flags.hasPendingPermissionRequests ||
        flags.hasPendingUserActionRequests ||
        flags.hasQueuedUserInput
    );
}
