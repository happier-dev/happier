import {
    hasActivityAttention,
    type ActivityAttentionSession,
    type ActivityAttentionSessionOptions,
} from '@/activity/attention/activityAttentionSessions';

export type ActivityBadgeState = Readonly<{
    count: number;
    showNonNumericDot: boolean;
}>;

export function buildActivityBadgeState(params: Readonly<{
    sessions: ReadonlyArray<ActivityAttentionSession>;
    numericInboxCount: number;
    hasNonNumericInboxAttention: boolean;
    sessionOptions?: ActivityAttentionSessionOptions;
}>): ActivityBadgeState {
    let sessionAttentionCount = 0;
    for (const session of params.sessions) {
        if (hasActivityAttention(session, params.sessionOptions)) {
            sessionAttentionCount += 1;
        }
    }

    const count = Math.max(0, sessionAttentionCount + Math.max(0, Math.trunc(params.numericInboxCount)));
    return {
        count,
        showNonNumericDot: count === 0 && params.hasNonNumericInboxAttention,
    };
}
