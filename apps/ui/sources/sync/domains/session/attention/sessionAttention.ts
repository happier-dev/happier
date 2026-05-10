import { computeHasUnreadActivity } from '@/sync/domains/messages/unread';
import { deriveExternalSessionAttentionHasUnread } from '@/sync/domains/session/external/readExternalSessionAttention';
import { readExternalSessionLink } from '@/sync/domains/session/external/readExternalSessionLink';
import { derivePendingRequestFlagsFromSession } from '@/sync/domains/session/pending/listPendingSessionRequests';
import { resolveLastViewedSessionSeq } from '@/sync/domains/session/readCursor/resolveLastViewedSessionSeq';
import type { Session } from '@/sync/domains/state/storageTypes';
import { deriveSessionAttentionState } from './deriveSessionAttentionState';
export { deriveSessionAttentionState } from './deriveSessionAttentionState';
export type { SessionAttentionState } from './types';

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
    const pendingFlags = derivePendingRequestFlagsFromSession(session);
    const externalSessionHasUnread = readExternalSessionLink(session.metadata)
        ? deriveExternalSessionAttentionHasUnread(session.metadata)
        : null;

    const hasUnread = options?.showUnread === false
        ? false
        : externalSessionHasUnread ?? computeHasUnreadActivity({
            sessionSeq: session.seq ?? 0,
            pendingActivityAt: 0,
            lastViewedSessionSeq: resolveLastViewedSessionSeq(session),
            lastViewedPendingActivityAt: session.metadata?.readStateV1?.pendingActivityAt,
        });

    const hasPendingPermissionRequests = isSessionActive && options?.showPendingPermissionRequests !== false
        ? pendingFlags.hasPendingPermissionRequests
        : false;

    const hasPendingUserActionRequests = isSessionActive && options?.showPendingUserActionRequests !== false
        ? pendingFlags.hasPendingUserActionRequests
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
    const attentionState = deriveSessionAttentionState({
        latestTurnStatus: session.latestTurnStatus ?? null,
        lastRuntimeIssue: session.lastRuntimeIssue ?? null,
        isRunning: session.active === true,
        hasWaitingActivity: flags.hasPendingPermissionRequests
            || flags.hasPendingUserActionRequests
            || flags.hasQueuedUserInput,
        hasReviewActivity: flags.hasUnread,
    });
    return (
        attentionState === 'failed' ||
        flags.hasUnread ||
        flags.hasPendingPermissionRequests ||
        flags.hasPendingUserActionRequests ||
        flags.hasQueuedUserInput
    );
}
