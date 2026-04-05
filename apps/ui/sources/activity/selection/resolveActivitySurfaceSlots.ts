import type { SessionActivityAttention } from '@/activity/attention/activityAttentionTypes';

import type { ActivitySurfaceSlots, ResolveActivitySurfaceSlotsParams } from './activitySurfaceSelectionTypes';

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

function resolveEligibleSessions(
    params: ResolveActivitySurfaceSlotsParams,
): readonly SessionActivityAttention[] {
    if (!params.selection.enabled) {
        return [];
    }

    switch (params.selection.mode) {
        case 'focused':
            return params.overview.candidates.filter((candidate) =>
                isRunningCandidate(candidate, {
                    includeReady: params.selection.includeReady,
                    includeThinking: params.selection.includeThinking,
                }),
            );
        case 'attention':
            return params.overview.candidates.filter((candidate) =>
                isUrgentCandidate(candidate, params.selection.includeReady),
            );
        case 'running':
            return params.overview.candidates.filter((candidate) =>
                isRunningCandidate(candidate, {
                    includeReady: params.selection.includeReady,
                    includeThinking: params.selection.includeThinking,
                }),
            );
        case 'summary':
            return params.overview.candidates.filter((candidate) => candidate.hasAttention);
        default:
            return params.overview.candidates.filter((candidate) =>
                isRunningCandidate(candidate, {
                    includeReady: params.selection.includeReady,
                    includeThinking: params.selection.includeThinking,
                }),
            );
    }
}

function resolveSelectedSessions(
    eligibleSessions: readonly SessionActivityAttention[],
    params: ResolveActivitySurfaceSlotsParams,
): Readonly<{
    selectedSessions: readonly SessionActivityAttention[];
    selectionReason: ActivitySurfaceSlots['selectionReason'];
}> {
    if (params.applyCap === false) {
        return {
            selectedSessions: eligibleSessions,
            selectionReason: 'all_eligible',
        };
    }

    if (params.selection.selectionReason === 'pinned_primary') {
        const preferredPrimary = params.preferredPrimarySessionId
            ? eligibleSessions.find((candidate) => candidate.sessionId === params.preferredPrimarySessionId) ?? null
            : null;
        if (preferredPrimary) {
            return {
                selectedSessions: [preferredPrimary],
                selectionReason: 'pinned_primary',
            };
        }
        return {
            selectedSessions: eligibleSessions.slice(0, 1),
            selectionReason: 'pinned_primary',
        };
    }

    if (params.selection.selectionReason === 'dynamic_primary') {
        return {
            selectedSessions: eligibleSessions.slice(0, 1),
            selectionReason: 'dynamic_primary',
        };
    }

    if (params.selection.selectionReason === 'session_specific') {
        return {
            selectedSessions: eligibleSessions.slice(0, params.selection.maxSelected ?? eligibleSessions.length),
            selectionReason: 'session_specific',
        };
    }

    return {
        selectedSessions: eligibleSessions,
        selectionReason: 'all_eligible',
    };
}

export function resolveActivitySurfaceSlots(params: ResolveActivitySurfaceSlotsParams): ActivitySurfaceSlots {
    const eligibleSessions = resolveEligibleSessions(params);
    const { selectedSessions, selectionReason } = resolveSelectedSessions(eligibleSessions, params);

    return {
        selection: params.selection,
        overview: params.overview,
        eligibleSessions,
        selectedSessions,
        primarySession: selectedSessions[0] ?? null,
        overflowCount: Math.max(0, eligibleSessions.length - selectedSessions.length),
        selectionReason,
    };
}
