import type { Session } from '@/sync/domains/state/storageTypes';

import { buildActivityOverviewSnapshot } from '../attention/buildActivityOverviewSnapshot';

export type ActivityBadgeState = Readonly<{
    count: number;
    showNonNumericDot: boolean;
}>;

export type ActivityBadgeSessionOptions = Readonly<{
    showUnread?: boolean;
    showPendingPermissionRequests?: boolean;
    showPendingUserActionRequests?: boolean;
    showQueuedUserInput?: boolean;
}>;

export function buildActivityBadgeState(params: Readonly<{
    sessions: ReadonlyArray<Session>;
    numericInboxCount: number;
    hasNonNumericInboxAttention: boolean;
    sessionOptions?: ActivityBadgeSessionOptions;
}>): ActivityBadgeState {
    const snapshot = buildActivityOverviewSnapshot({
        sessions: params.sessions,
        sessionOptions: params.sessionOptions,
    });

    const selectedSessionCount = snapshot.candidates.filter((candidate) => (
        candidate.reasons.hasUnread
        || candidate.reasons.hasPendingPermissionRequests
        || candidate.reasons.hasPendingUserActionRequests
        || candidate.reasons.hasQueuedUserInput
    )).length;
    const count = Math.max(0, selectedSessionCount + Math.max(0, Math.trunc(params.numericInboxCount)));
    return {
        count,
        showNonNumericDot: count === 0 && params.hasNonNumericInboxAttention,
    };
}
