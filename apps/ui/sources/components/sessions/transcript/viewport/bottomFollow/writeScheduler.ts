import type { TranscriptViewportScrollReason } from '@/components/sessions/transcript/viewport/transcriptViewportTypes';

export type BottomFollowAutomaticWriter = 'blank-recovery';

export type BottomFollowWriteSchedulerState = Readonly<{
    explicitJumpActive: boolean;
    gestureActive: boolean;
}>;

export type BottomFollowWriteSchedulerEvent =
    | Readonly<{
        active: boolean;
        type: 'set-explicit-jump-active';
    }>
    | Readonly<{
        active: boolean;
        type: 'set-gesture-active';
    }>
    | Readonly<{
        reason: TranscriptViewportScrollReason;
        type: 'authorize-immediate-write';
        writer: BottomFollowAutomaticWriter;
    }>;

export type BottomFollowWriteSchedulerEffect =
    | Readonly<{
        reason: 'explicit-jump-active' | 'gesture-active';
        type: 'drop-write';
    }>
    | Readonly<{
        command?: 'pin-to-bottom';
        reason: TranscriptViewportScrollReason;
        schedulerAuthorityReason: TranscriptViewportScrollReason;
        schedulerAuthorityWriter: BottomFollowAutomaticWriter;
        type: 'authorize-write';
        writer: BottomFollowAutomaticWriter;
    }>;

export type BottomFollowWriteSchedulerPlan = Readonly<{
    effects: readonly BottomFollowWriteSchedulerEffect[];
    state: BottomFollowWriteSchedulerState;
}>;

export function planBottomFollowWriteSchedulerEvent(
    state: BottomFollowWriteSchedulerState,
    event: BottomFollowWriteSchedulerEvent,
): BottomFollowWriteSchedulerPlan {
    switch (event.type) {
        case 'set-explicit-jump-active':
            return planExplicitJumpActiveChange(state, event.active);
        case 'set-gesture-active':
            return planGestureActiveChange(state, event.active);
        case 'authorize-immediate-write':
            if (state.explicitJumpActive) {
                const effect: BottomFollowWriteSchedulerEffect = {
                    reason: 'explicit-jump-active',
                    type: 'drop-write',
                };
                return {
                    effects: [effect],
                    state,
                };
            }
            if (state.gestureActive) {
                const effect: BottomFollowWriteSchedulerEffect = {
                    reason: 'gesture-active',
                    type: 'drop-write',
                };
                return {
                    effects: [effect],
                    state,
                };
            }
            return {
                effects: [
                    {
                        reason: event.reason,
                        schedulerAuthorityReason: event.reason,
                        schedulerAuthorityWriter: event.writer,
                        type: 'authorize-write',
                        writer: event.writer,
                    },
                ],
                state,
            };
    }
}

function planExplicitJumpActiveChange(
    state: BottomFollowWriteSchedulerState,
    active: boolean,
): BottomFollowWriteSchedulerPlan {
    if (state.explicitJumpActive === active) {
        return { effects: [], state };
    }
    return {
        effects: [],
        state: {
            ...state,
            explicitJumpActive: active,
        },
    };
}

function planGestureActiveChange(
    state: BottomFollowWriteSchedulerState,
    active: boolean,
): BottomFollowWriteSchedulerPlan {
    if (state.gestureActive === active) {
        return { effects: [], state };
    }
    return {
        effects: [],
        state: {
            ...state,
            gestureActive: active,
        },
    };
}
