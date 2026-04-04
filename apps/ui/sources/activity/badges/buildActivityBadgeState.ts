import { hasSessionAttention } from '@/sync/domains/session/attention/sessionAttention';
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
    return hasSessionAttention(session, options);
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
