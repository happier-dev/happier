import type { ActivityOverviewSnapshot, SessionActivityAttention } from './activityAttentionTypes';
import type { ActivitySurfacePolicy } from './resolveActivitySurfacePolicy';

export type ActivitySurfaceKind = 'liveActivities' | 'widgets';

function isUrgentCandidate(candidate: SessionActivityAttention, includeReady: boolean): boolean {
    switch (candidate.attentionState) {
        case 'permission_required':
        case 'action_required':
        case 'pending':
            return true;
        case 'unread':
            return includeReady;
        case 'thinking':
        case 'quiet':
        default:
            return false;
    }
}

function isRunningCandidate(candidate: SessionActivityAttention, params: Readonly<{
    includeReady: boolean;
    includeThinking: boolean;
}>): boolean {
    if (isUrgentCandidate(candidate, params.includeReady)) {
        return true;
    }

    return params.includeThinking && candidate.attentionState === 'thinking';
}

function selectLiveActivityCandidates(
    overview: ActivityOverviewSnapshot,
    policy: ActivitySurfacePolicy,
    applyCap: boolean,
): readonly SessionActivityAttention[] {
    if (!policy.liveActivities.enabled) {
        return [];
    }

    const liveCandidates = (() => {
        switch (policy.liveActivities.mode) {
            case 'focused':
                return overview.candidates.filter((candidate) =>
                    isRunningCandidate(candidate, {
                        includeReady: policy.liveActivities.includeReady,
                        includeThinking: policy.liveActivities.includeThinking,
                    }),
                );
            case 'attention':
                return overview.candidates.filter((candidate) =>
                    isUrgentCandidate(candidate, policy.liveActivities.includeReady),
                );
            case 'running':
            default:
                return overview.candidates.filter((candidate) =>
                    isRunningCandidate(candidate, {
                        includeReady: policy.liveActivities.includeReady,
                        includeThinking: policy.liveActivities.includeThinking,
                    }),
                );
        }
    })();

    if (!applyCap) {
        return liveCandidates;
    }

    if (policy.liveActivities.mode === 'focused') {
        return liveCandidates.slice(0, 1);
    }

    return liveCandidates.slice(0, policy.liveActivities.maxConcurrent);
}

function selectWidgetCandidates(
    overview: ActivityOverviewSnapshot,
    policy: ActivitySurfacePolicy,
): readonly SessionActivityAttention[] {
    if (!policy.widgets.enabled) {
        return [];
    }

    switch (policy.widgets.mode) {
        case 'attention':
            return overview.candidates.filter((candidate) => isUrgentCandidate(candidate, true));
        case 'running':
            return overview.candidates.filter((candidate) =>
                isRunningCandidate(candidate, {
                    includeReady: true,
                    includeThinking: true,
                }),
            );
        case 'summary':
        default:
            return overview.candidates.filter((candidate) => candidate.hasAttention);
    }
}

export function selectActivitySurfaceCandidates(params: Readonly<{
    overview: ActivityOverviewSnapshot;
    surface: ActivitySurfaceKind;
    policy: ActivitySurfacePolicy;
    applyCap?: boolean;
}>): readonly SessionActivityAttention[] {
    return params.surface === 'liveActivities'
        ? selectLiveActivityCandidates(params.overview, params.policy, params.applyCap !== false)
        : selectWidgetCandidates(params.overview, params.policy);
}
