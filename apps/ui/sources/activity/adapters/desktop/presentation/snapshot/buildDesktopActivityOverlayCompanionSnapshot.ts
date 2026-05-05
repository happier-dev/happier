import type { SessionActivityAttention } from '@/activity/attention/activityAttentionTypes';
import {
    buildPetCompanionActivityState,
    type PetCompanionActivityReason,
    type PetCompanionSessionSignals,
} from '@/components/pets/state/buildPetCompanionActivityState';
import {
    DEFAULT_BUILT_IN_PET_ID,
    resolveBuiltInPetPackage,
} from '@/components/pets/builtIns/builtInPetRegistry';

import type {
    DesktopActivityOverlayCompanionAttentionLevel,
    DesktopActivityOverlayCompanionSnapshot,
} from './desktopActivityOverlaySnapshotTypes';

export type DesktopActivityOverlayCompanionSnapshotInput = Readonly<{
    enabled: boolean;
    pet: DesktopActivityOverlayCompanionSnapshot['pet'];
}>;

const DISABLED_COMPANION_PET = {
    source: {
        kind: 'builtIn',
        petId: DEFAULT_BUILT_IN_PET_ID,
    },
    displayName: resolveBuiltInPetPackage(DEFAULT_BUILT_IN_PET_ID).manifest.displayName,
} as const satisfies DesktopActivityOverlayCompanionSnapshot['pet'];

function buildCompanionSnapshot(
    candidate: SessionActivityAttention | null,
    input: DesktopActivityOverlayCompanionSnapshotInput,
    state: DesktopActivityOverlayCompanionSnapshot['state'],
    attentionLevel: DesktopActivityOverlayCompanionAttentionLevel,
    reason: PetCompanionActivityReason,
): DesktopActivityOverlayCompanionSnapshot {
    return {
        enabled: input.enabled,
        pet: input.pet,
        state,
        attentionLevel,
        reason,
        sessionId: candidate?.sessionId ?? null,
    };
}

function buildCompanionSignals(candidate: SessionActivityAttention): PetCompanionSessionSignals {
    return {
        hasFailure: false,
        hasUnreadMessages: candidate.reasons.hasUnread || candidate.attentionState === 'unread',
        latestThinkingActivityAtMs: candidate.reasons.isThinking || candidate.attentionState === 'thinking'
            ? candidate.session.updatedAt
            : null,
        latestMeaningfulActivityAtMs: candidate.session.updatedAt,
        pendingMessageCount: candidate.reasons.hasQueuedUserInput || candidate.attentionState === 'pending'
            ? Math.max(candidate.session.pendingCount ?? 0, 1)
            : candidate.session.pendingCount ?? 0,
    };
}

function resolveAttentionLevel(reason: PetCompanionActivityReason): DesktopActivityOverlayCompanionAttentionLevel {
    if (reason === 'failed') {
        return 'failed';
    }
    if (reason === 'waiting' || reason === 'review') {
        return 'needsAttention';
    }
    if (reason === 'running') {
        return 'active';
    }
    return 'idle';
}

export function buildDesktopActivityOverlayCompanionSnapshot(params: Readonly<{
    selectedSessions: readonly SessionActivityAttention[];
    companion?: DesktopActivityOverlayCompanionSnapshotInput;
}>): DesktopActivityOverlayCompanionSnapshot {
    const companion = params.companion ?? {
        enabled: false,
        pet: DISABLED_COMPANION_PET,
    };
    if (!companion.enabled) {
        return buildCompanionSnapshot(null, companion, 'idle', 'idle', 'idle');
    }

    const candidate = params.selectedSessions[0] ?? null;
    if (!candidate) {
        return buildCompanionSnapshot(null, companion, 'idle', 'idle', 'idle');
    }

    const activityState = buildPetCompanionActivityState({
        sessions: params.selectedSessions.map((selected) => selected.session),
        selectedSessionId: candidate.sessionId,
        signalsBySessionId: {
            [candidate.sessionId]: buildCompanionSignals(candidate),
        },
    });

    return buildCompanionSnapshot(
        candidate,
        companion,
        activityState.state,
        resolveAttentionLevel(activityState.reason),
        activityState.reason,
    );
}
