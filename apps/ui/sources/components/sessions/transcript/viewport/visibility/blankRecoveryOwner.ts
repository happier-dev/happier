import type {
    BottomFollowAutomaticWriter,
} from '@/components/sessions/transcript/viewport/bottomFollow/writeScheduler';
import type {
    TranscriptViewportScrollReason,
} from '@/components/sessions/transcript/viewport/transcriptViewportTypes';
import type {
    TranscriptViewportTelemetryBottomFollowMode,
    TranscriptViewportTelemetryObservationReason,
} from '@/components/sessions/transcript/scroll/transcriptViewportTelemetry';

// NQA-3 measured harmless native bounce at about -15px. NQA-F4 was about -995k.
// The -64px gate leaves bounce margin while still catching impossible native offsets.
export const INVALID_NATIVE_OFFSET_RECOVERY_RAW_THRESHOLD_PX = -64;
export const INVALID_NATIVE_OFFSET_RECOVERY_DURATION_MS = 120;
export const EMPTY_VISIBLE_WINDOW_RECOVERY_DURATION_MS = 500;
export const BLANK_RECOVERY_REARM_QUIET_PERIOD_MS = 250;

export type TranscriptBlankRecoveryState = Readonly<{
    emptyVisibleWindowClearedSinceMs: number | null;
    emptyVisibleWindowSinceMs: number | null;
    invalidNativeOffsetSinceMs: number | null;
    recoveredEmptyVisibleWindowSessionId: string | null;
    recoveredInvalidNativeOffsetSessionId: string | null;
    sessionId: string | null;
}>;

export type TranscriptBlankRecoveryObservation = Readonly<{
    bottomFollowMode: TranscriptViewportTelemetryBottomFollowMode;
    contentPresent: boolean;
    entryRestoreOpen: boolean;
    gestureActive: boolean;
    hasVisibleRows: boolean;
    nowMs: number;
    observationReason?: TranscriptViewportTelemetryObservationReason;
    prependOpen: boolean;
    rawOffsetY?: number | null;
    sessionId: string;
    viewportOutsideContent?: boolean;
}>;

export type TranscriptBlankRecoveryEffect =
    | Readonly<{
        recovery: 'empty-visible-window' | 'invalid-native-offset';
        reason: TranscriptViewportScrollReason;
        type: 'request-bottom-follow-write';
        writer: BottomFollowAutomaticWriter;
    }>
    | Readonly<{
        recovery: 'empty-visible-window';
        type: 'request-anchor-restore';
    }>;

export type TranscriptBlankRecoveryPlan = Readonly<{
    effects: readonly TranscriptBlankRecoveryEffect[];
    state: TranscriptBlankRecoveryState;
}>;

export function createTranscriptBlankRecoveryState(): TranscriptBlankRecoveryState {
    return {
        emptyVisibleWindowClearedSinceMs: null,
        emptyVisibleWindowSinceMs: null,
        invalidNativeOffsetSinceMs: null,
        recoveredEmptyVisibleWindowSessionId: null,
        recoveredInvalidNativeOffsetSessionId: null,
        sessionId: null,
    };
}

export function planTranscriptBlankRecoveryObservation(
    state: TranscriptBlankRecoveryState,
    observation: TranscriptBlankRecoveryObservation,
): TranscriptBlankRecoveryPlan {
    const sessionState = state.sessionId === observation.sessionId
        ? state
        : {
            ...createTranscriptBlankRecoveryState(),
            sessionId: observation.sessionId,
        };
    if (observation.entryRestoreOpen || observation.prependOpen || observation.gestureActive) {
        return {
            effects: [],
            state: clearArmedRecovery(sessionState),
        };
    }

    const invalidNativeOffsetPlan = planInvalidNativeOffsetRecovery(sessionState, observation);
    if (invalidNativeOffsetPlan.effects.length > 0) return invalidNativeOffsetPlan;
    return planEmptyVisibleWindowRecovery(invalidNativeOffsetPlan.state, observation);
}

function planInvalidNativeOffsetRecovery(
    state: TranscriptBlankRecoveryState,
    observation: TranscriptBlankRecoveryObservation,
): TranscriptBlankRecoveryPlan {
    const invalid =
        observation.observationReason === 'invalid-native-offset' &&
        typeof observation.rawOffsetY === 'number' &&
        Number.isFinite(observation.rawOffsetY) &&
        observation.rawOffsetY < INVALID_NATIVE_OFFSET_RECOVERY_RAW_THRESHOLD_PX;
    if (!invalid) {
        return {
            effects: [],
            state: {
                ...state,
                invalidNativeOffsetSinceMs: null,
            },
        };
    }
    if (state.recoveredInvalidNativeOffsetSessionId === observation.sessionId) {
        return { effects: [], state };
    }
    const invalidSinceMs = state.invalidNativeOffsetSinceMs ?? observation.nowMs;
    const nextState = {
        ...state,
        invalidNativeOffsetSinceMs: invalidSinceMs,
    };
    if (observation.nowMs - invalidSinceMs < INVALID_NATIVE_OFFSET_RECOVERY_DURATION_MS) {
        return { effects: [], state: nextState };
    }
    return {
        effects: [requestBottomFollowRecovery('invalid-native-offset')],
        state: {
            ...nextState,
            recoveredInvalidNativeOffsetSessionId: observation.sessionId,
        },
    };
}

function planEmptyVisibleWindowRecovery(
    state: TranscriptBlankRecoveryState,
    observation: TranscriptBlankRecoveryObservation,
): TranscriptBlankRecoveryPlan {
    const emptyVisibleWindow = observation.contentPresent && (
        !observation.hasVisibleRows ||
        observation.viewportOutsideContent === true
    );
    if (!emptyVisibleWindow) {
        const emptyVisibleWindowClearedSinceMs =
            state.recoveredEmptyVisibleWindowSessionId === observation.sessionId
                ? state.emptyVisibleWindowClearedSinceMs ?? observation.nowMs
                : null;
        const shouldRearmEmptyVisibleWindowRecovery =
            emptyVisibleWindowClearedSinceMs !== null &&
            observation.nowMs - emptyVisibleWindowClearedSinceMs >= BLANK_RECOVERY_REARM_QUIET_PERIOD_MS;
        return {
            effects: [],
            state: {
                ...state,
                emptyVisibleWindowClearedSinceMs: shouldRearmEmptyVisibleWindowRecovery
                    ? null
                    : emptyVisibleWindowClearedSinceMs,
                emptyVisibleWindowSinceMs: null,
                recoveredEmptyVisibleWindowSessionId: shouldRearmEmptyVisibleWindowRecovery
                    ? null
                    : state.recoveredEmptyVisibleWindowSessionId,
            },
        };
    }
    if (state.recoveredEmptyVisibleWindowSessionId === observation.sessionId) {
        return { effects: [], state };
    }
    const emptySinceMs = state.emptyVisibleWindowSinceMs ?? observation.nowMs;
    const nextState = {
        ...state,
        emptyVisibleWindowClearedSinceMs: null,
        emptyVisibleWindowSinceMs: emptySinceMs,
    };
    if (observation.nowMs - emptySinceMs < EMPTY_VISIBLE_WINDOW_RECOVERY_DURATION_MS) {
        return { effects: [], state: nextState };
    }
    return {
        effects: [
            observation.bottomFollowMode === 'following'
                ? requestBottomFollowRecovery('empty-visible-window')
                : {
                    recovery: 'empty-visible-window',
                    type: 'request-anchor-restore',
                },
        ],
        state: {
            ...nextState,
            recoveredEmptyVisibleWindowSessionId: observation.sessionId,
        },
    };
}

function requestBottomFollowRecovery(
    recovery: 'empty-visible-window' | 'invalid-native-offset',
): Extract<TranscriptBlankRecoveryEffect, { type: 'request-bottom-follow-write' }> {
    return {
        recovery,
        reason: 'passive-drift',
        type: 'request-bottom-follow-write',
        writer: 'blank-recovery',
    };
}

function clearArmedRecovery(state: TranscriptBlankRecoveryState): TranscriptBlankRecoveryState {
    return {
        ...state,
        emptyVisibleWindowClearedSinceMs: null,
        emptyVisibleWindowSinceMs: null,
        invalidNativeOffsetSinceMs: null,
    };
}
