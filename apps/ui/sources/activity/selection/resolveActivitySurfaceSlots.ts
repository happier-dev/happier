import type { SessionActivityAttention } from '@/activity/attention/activityAttentionTypes';

import type {
    ActivitySurfaceSelectionSpec,
    ActivitySurfaceSlots,
    ResolveActivitySurfaceSlotsParams,
} from './activitySurfaceSelectionTypes';
import { applyActivitySelectionDwell } from './applyActivitySelectionDwell';

function isUrgentCandidate(candidate: SessionActivityAttention, selection: Pick<
    ActivitySurfaceSelectionSpec,
    'includeUrgent' | 'includeReady' | 'activeOnly'
>): boolean {
    if (selection.activeOnly && candidate.session.active !== true) {
        return false;
    }

    switch (candidate.attentionState) {
        case 'permission_required':
        case 'action_required':
        case 'pending':
            return selection.includeUrgent;
        case 'unread':
            return selection.includeReady;
        case 'thinking':
        case 'quiet':
        default:
            return false;
    }
}

function isRunningCandidate(candidate: SessionActivityAttention, selection: Pick<
    ActivitySurfaceSelectionSpec,
    'includeUrgent' | 'includeReady' | 'includeThinking' | 'includeQuietActive' | 'activeOnly'
>): boolean {
    if (isUrgentCandidate(candidate, selection)) {
        return true;
    }

    if (selection.activeOnly && candidate.session.active !== true) {
        return false;
    }

    if (selection.includeThinking && candidate.attentionState === 'thinking') {
        return true;
    }

    return (
        selection.includeQuietActive &&
        candidate.attentionState === 'quiet' &&
        candidate.session.active === true
    );
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
                isRunningCandidate(candidate, params.selection),
            );
        case 'attention':
            return params.overview.candidates.filter((candidate) =>
                isUrgentCandidate(candidate, params.selection),
            );
        case 'running':
            return params.overview.candidates.filter((candidate) =>
                isRunningCandidate(candidate, params.selection),
            );
        case 'summary':
            return params.overview.candidates.filter((candidate) => candidate.hasAttention);
        default:
            return params.overview.candidates.filter((candidate) =>
                isRunningCandidate(candidate, params.selection),
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
    const selected = resolveSelectedSessions(eligibleSessions, params);
    const selectedSessions = applyActivitySelectionDwell({
        eligibleSessions,
        selectedSessions: selected.selectedSessions,
        selection: params.selection,
        previousPrimary: {
            sessionId: params.previousPrimarySessionId,
            activityInstanceKey: params.previousPrimaryActivityInstanceKey,
            changedAtMs: params.previousPrimaryChangedAtMs,
        },
        nowMs: params.nowMs,
    });

    return {
        selection: params.selection,
        overview: params.overview,
        eligibleSessions,
        selectedSessions,
        primarySession: selectedSessions[0] ?? null,
        overflowCount: Math.max(0, eligibleSessions.length - selectedSessions.length),
        selectionReason: selected.selectionReason,
        sourceFingerprint: params.overview.fingerprint ?? null,
    };
}
