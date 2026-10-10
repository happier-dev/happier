import { activityInstanceKey } from '@/sync/domains/session/sessionAddress';
import { resolveSessionListRenderableMeaningfulActivityAt } from '@/sync/domains/session/listing/sessionListRenderableSorting';
import type { ActivityOverviewSnapshot, BuildActivityOverviewSnapshotParams, SessionActivityAttention } from './activityAttentionTypes';
import { buildSessionActivityAttention } from './buildSessionActivityAttention';
import { isSessionAdmittedToPersonalActivity } from './isSessionAdmittedToPersonalActivity';

function sortCandidates(left: SessionActivityAttention, right: SessionActivityAttention): number {
    if (left.priority !== right.priority) {
        return right.priority - left.priority;
    }
    // Recency is the session list's own notion of it: the last meaningful activity. `updatedAt`
    // also moves when the person merely opens the session (its read state is written), which
    // would reorder the list under their pointer.
    const leftActivityAt = resolveSessionListRenderableMeaningfulActivityAt(left.session);
    const rightActivityAt = resolveSessionListRenderableMeaningfulActivityAt(right.session);
    if (leftActivityAt !== rightActivityAt) {
        return rightActivityAt - leftActivityAt;
    }
    return activityInstanceKey({
        serverId: left.serverId ?? null,
        sessionId: left.sessionId,
    }, left.activityName ?? 'session').localeCompare(activityInstanceKey({
        serverId: right.serverId ?? null,
        sessionId: right.sessionId,
    }, right.activityName ?? 'session'));
}

export function buildActivityOverviewSnapshot(params: BuildActivityOverviewSnapshotParams): ActivityOverviewSnapshot {
    const candidates = params.sessions
        .filter(isSessionAdmittedToPersonalActivity)
        .map((session) => buildSessionActivityAttention({
            session,
            sessionOptions: params.sessionOptions,
            nowMs: params.nowMs,
        }));

    return buildActivityOverviewFromCandidates(candidates);
}

export function buildActivityOverviewFromCandidates(input: readonly SessionActivityAttention[]): ActivityOverviewSnapshot {
    const candidates = input.filter((candidate) => isSessionAdmittedToPersonalActivity(candidate.session)).sort(sortCandidates);

    let unread = 0;
    let permissionRequired = 0;
    let actionRequired = 0;
    let thinking = 0;
    let totalAttention = 0;

    for (const candidate of candidates) {
        if (candidate.reasons.hasUnread) unread += 1;
        if (candidate.reasons.hasPendingPermissionRequests) permissionRequired += 1;
        if (candidate.reasons.hasPendingUserActionRequests || candidate.reasons.hasBlockedPendingDelivery) actionRequired += 1;
        if (candidate.reasons.isThinking) thinking += 1;
        if (candidate.hasAttention) totalAttention += 1;
    }

    const overview: ActivityOverviewSnapshot = {
        counts: {
            unread,
            permissionRequired,
            actionRequired,
            thinking,
            totalAttention,
        },
        candidates,
    };
    return { ...overview, fingerprint: buildStableActivityOverviewFingerprint(overview) };
}

export function buildStableActivityOverviewFingerprint(overview: ActivityOverviewSnapshot): string {
    return JSON.stringify({
        counts: overview.counts,
        candidates: overview.candidates.map((candidate) => ({
            address: candidate.address ?? null,
            contextLine: candidate.context?.contextLine ?? null,
            sessionId: candidate.sessionId,
            serverId: candidate.serverId ?? null,
            route: candidate.route ?? null,
            target: candidate.target ?? null,
            activityName: candidate.activityName ?? null,
            activityInstanceKey: candidate.activityInstanceKey ?? null,
            canExecuteDirectAction: candidate.directActionCapability?.canExecute ?? false,
            surfaceTiming: candidate.surfaceTiming ?? null,
            attentionState: candidate.attentionState,
            personalAttention: candidate.personalAttention,
            hasAttention: candidate.hasAttention,
            title: candidate.title,
            subtitle: candidate.subtitle,
            presentation: candidate.session.viewer?.attention.presentation ?? 'full',
            encryption: candidate.awareness.encryption,
            priority: candidate.priority,
            updatedAt: candidate.session.updatedAt,
            lastTurnCompletedAt: candidate.lastTurnCompletedAt,
            reasons: candidate.reasons,
        })),
    });
}
