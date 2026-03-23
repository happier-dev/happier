import { computeHasUnreadActivity } from '@/sync/domains/messages/unread';
import { resolveLastViewedSessionSeq } from '@/sync/domains/session/readCursor/resolveLastViewedSessionSeq';
import { derivePendingRequestFlagsFromAgentState } from '@/sync/domains/session/listing/sessionListRenderable';
import type { Session } from '@/sync/domains/state/storageTypes';

export type ActivityBadgeState = Readonly<{
    count: number;
    showNonNumericDot: boolean;
}>;

type ActivityBadgeSessionOptions = Readonly<{
    showUnread?: boolean;
    showPendingPermissionRequests?: boolean;
    showPendingUserActionRequests?: boolean;
    showQueuedUserInput?: boolean;
}>;

function hasSessionBadgeAttention(session: Session, options?: ActivityBadgeSessionOptions): boolean {
    if (options?.showUnread !== false) {
        const hasUnread = computeHasUnreadActivity({
            sessionSeq: session.seq ?? 0,
            pendingActivityAt: 0,
            lastViewedSessionSeq: resolveLastViewedSessionSeq(session),
            lastViewedPendingActivityAt: session.metadata?.readStateV1?.pendingActivityAt,
        });
        if (hasUnread) return true;
    }

    if (options?.showPendingPermissionRequests !== false) {
        const hasPendingPermissionRequests =
            typeof session.pendingPermissionRequestCount === 'number'
                ? session.pendingPermissionRequestCount > 0
                : derivePendingRequestFlagsFromAgentState(session.agentState).hasPendingPermissionRequests;
        if (hasPendingPermissionRequests) return true;
    }

    if (options?.showPendingUserActionRequests !== false) {
        const hasPendingUserActionRequests =
            typeof session.pendingUserActionRequestCount === 'number'
                ? session.pendingUserActionRequestCount > 0
                : derivePendingRequestFlagsFromAgentState(session.agentState).hasPendingUserActionRequests;
        if (hasPendingUserActionRequests) return true;
    }

    if (options?.showQueuedUserInput !== false) {
        return (session.pendingCount ?? 0) > 0;
    }

    return false;
}

export function buildActivityBadgeState(params: Readonly<{
    sessions: ReadonlyArray<Session>;
    numericInboxCount: number;
    hasNonNumericInboxAttention: boolean;
    sessionOptions?: ActivityBadgeSessionOptions;
}>): ActivityBadgeState {
    let sessionAttentionCount = 0;
    for (const session of params.sessions) {
        if (hasSessionBadgeAttention(session, params.sessionOptions)) {
            sessionAttentionCount += 1;
        }
    }

    const count = Math.max(0, sessionAttentionCount + Math.max(0, Math.trunc(params.numericInboxCount)));
    return {
        count,
        showNonNumericDot: count === 0 && params.hasNonNumericInboxAttention,
    };
}
