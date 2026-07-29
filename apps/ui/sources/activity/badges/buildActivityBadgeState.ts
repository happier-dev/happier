import type { Session } from '@/sync/domains/state/storageTypes';

import type { ActivityOverviewSnapshot } from '../attention/activityAttentionTypes';
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

    return buildActivityBadgeStateFromOverview({
        overview: snapshot,
        numericInboxCount: params.numericInboxCount,
        hasNonNumericInboxAttention: params.hasNonNumericInboxAttention,
        sessionOptions: params.sessionOptions,
    });
}

export function buildActivityBadgeStateFromOverview(params: Readonly<{
    overview: ActivityOverviewSnapshot;
    numericInboxCount: number;
    hasNonNumericInboxAttention: boolean;
    sessionOptions?: ActivityBadgeSessionOptions;
}>): ActivityBadgeState {
    const selectedSessionCount = params.overview.candidates.filter((candidate) => (
        (params.sessionOptions?.showUnread !== false && candidate.reasons.hasUnread)
        || (params.sessionOptions?.showPendingPermissionRequests !== false && candidate.reasons.hasPendingPermissionRequests)
        || (params.sessionOptions?.showPendingUserActionRequests !== false && candidate.reasons.hasPendingUserActionRequests)
        || (params.sessionOptions?.showPendingUserActionRequests !== false && candidate.reasons.hasBlockedPendingDelivery)
    )).length;
    const count = Math.max(0, selectedSessionCount + Math.max(0, Math.trunc(params.numericInboxCount)));
    return {
        count,
        showNonNumericDot: count === 0 && params.hasNonNumericInboxAttention,
    };
}
