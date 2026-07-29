import type { ActivityOverviewSnapshot, BuildActivityOverviewSnapshotParams, SessionActivityAttention } from './activityAttentionTypes';
import { buildSessionActivityAttention } from './buildSessionActivityAttention';

function sortCandidates(left: SessionActivityAttention, right: SessionActivityAttention): number {
    if (left.priority !== right.priority) {
        return right.priority - left.priority;
    }
    if (left.session.updatedAt !== right.session.updatedAt) {
        return right.session.updatedAt - left.session.updatedAt;
    }
    return left.sessionId.localeCompare(right.sessionId);
}

export function buildActivityOverviewSnapshot(params: BuildActivityOverviewSnapshotParams): ActivityOverviewSnapshot {
    const candidates = params.sessions
        .map((session) => buildSessionActivityAttention({
            session,
            sessionOptions: params.sessionOptions,
            nowMs: params.nowMs,
        }))
        .sort(sortCandidates);

    let unread = 0;
    let permissionRequired = 0;
    let actionRequired = 0;
    let queuedInput = 0;
    let thinking = 0;
    let totalAttention = 0;

    for (const candidate of candidates) {
        if (candidate.reasons.hasUnread) unread += 1;
        if (candidate.reasons.hasPendingPermissionRequests) permissionRequired += 1;
        if (candidate.reasons.hasPendingUserActionRequests || candidate.reasons.hasBlockedPendingDelivery) actionRequired += 1;
        if (candidate.reasons.isThinking) thinking += 1;
        if (candidate.hasAttention) totalAttention += 1;
    }

    return {
        counts: {
            unread,
            permissionRequired,
            actionRequired,
            queuedInput,
            thinking,
            totalAttention,
        },
        candidates,
    };
}
