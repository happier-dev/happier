import type { TranscriptViewportScrollReason } from '@/components/sessions/transcript/viewport/transcriptViewportTypes';

export type BottomFollowWriteSchedulerPlatform = 'native' | 'web';

export type BottomFollowAutomaticWriter =
    | 'automatic-live-tail'
    | 'blank-recovery'
    | 'content-growth'
    | 'deferred-post-scroll'
    | 'hot-tail-carve'
    | 'passive-drift'
    | 'proactive-auto-follow'
    | 'settle-reconfirm'
    | 'web-passive-correction';

export type BottomFollowScheduledWrite<PreviousWebMetrics = unknown> = Readonly<{
    delayMs: number;
    kind: 'raf' | 'timeout';
    nativePrevFollowAtBottom: boolean;
    previousWebMetrics: PreviousWebMetrics | null;
    reason: TranscriptViewportScrollReason;
    writer: BottomFollowAutomaticWriter;
}>;

export type BottomFollowWriteSchedulerState<PreviousWebMetrics = unknown> = Readonly<{
    explicitJumpActive: boolean;
    gestureActive: boolean;
    pending: BottomFollowScheduledWrite<PreviousWebMetrics> | null;
}>;

export type BottomFollowWriteSchedulerEvent<PreviousWebMetrics = unknown> =
    | Readonly<{
        active: boolean;
        type: 'set-explicit-jump-active';
    }>
    | Readonly<{
        active: boolean;
        type: 'set-gesture-active';
    }>
    | Readonly<{
        canUseAnimationFrame: boolean;
        nativePrevFollowAtBottom: boolean;
        platform: BottomFollowWriteSchedulerPlatform;
        previousWebMetrics: PreviousWebMetrics | null;
        reason: TranscriptViewportScrollReason;
        type: 'request-write';
        usesNativeFlashListBottomMaintenance: boolean;
        waitMs: number | null;
        writer: BottomFollowAutomaticWriter;
    }>
    | Readonly<{
        observedRawOffsetY?: number | null;
        type: 'fire-pending';
        usesNativeFlashListBottomMaintenance: boolean;
        waitMs: number | null;
    }>
    | Readonly<{
        reason: TranscriptViewportScrollReason;
        type: 'authorize-immediate-write';
        writer: BottomFollowAutomaticWriter;
    }>
    | Readonly<{
        type: 'clear-pending';
    }>;

export type BottomFollowWriteSchedulerEffect<PreviousWebMetrics = unknown> =
    | Readonly<{
        type: 'cancel-scheduled-write';
    }>
    | Readonly<{
        type: 'schedule-write';
        write: BottomFollowScheduledWrite<PreviousWebMetrics>;
    }>
    | Readonly<{
        reason: 'gesture-active';
        type: 'defer-write';
        write: BottomFollowScheduledWrite<PreviousWebMetrics>;
    }>
    | Readonly<{
        reason: 'existing-pending-write';
        type: 'coalesce-write';
        write: BottomFollowScheduledWrite<PreviousWebMetrics>;
    }>
    | Readonly<{
        observedRawOffsetY?: number;
        reason: 'auto-follow-blocked' | 'auto-follow-not-ready' | 'explicit-jump-active' | 'gesture-active' | 'negative-raw-offset' | 'no-pending-write';
        type: 'drop-write';
        write?: BottomFollowScheduledWrite<PreviousWebMetrics>;
    }>
    | Readonly<{
        command?: 'native-respecting-mount-settle' | 'pin-to-bottom';
        nativePrevFollowAtBottom?: boolean;
        reason: TranscriptViewportScrollReason;
        schedulerAuthorityReason: TranscriptViewportScrollReason;
        schedulerAuthorityWriter: BottomFollowAutomaticWriter;
        type: 'authorize-write';
        writer: BottomFollowAutomaticWriter;
    }>
    | Readonly<{
        command: 'web-bottom-follow-adjustment';
        previousWebMetrics: PreviousWebMetrics;
        reason: TranscriptViewportScrollReason;
        schedulerAuthorityReason: TranscriptViewportScrollReason;
        schedulerAuthorityWriter: BottomFollowAutomaticWriter;
        type: 'authorize-write';
        writer: BottomFollowAutomaticWriter;
    }>;

export type BottomFollowWriteSchedulerPlan<PreviousWebMetrics = unknown> = Readonly<{
    effects: readonly BottomFollowWriteSchedulerEffect<PreviousWebMetrics>[];
    state: BottomFollowWriteSchedulerState<PreviousWebMetrics>;
}>;

export function planBottomFollowWriteSchedulerEvent<PreviousWebMetrics = unknown>(
    state: BottomFollowWriteSchedulerState<PreviousWebMetrics>,
    event: BottomFollowWriteSchedulerEvent<PreviousWebMetrics>,
): BottomFollowWriteSchedulerPlan<PreviousWebMetrics> {
    switch (event.type) {
        case 'set-explicit-jump-active':
            return planExplicitJumpActiveChange(state, event.active);
        case 'set-gesture-active':
            return planGestureActiveChange(state, event.active);
        case 'request-write':
            return planWriteRequest(state, event);
        case 'fire-pending':
            return planPendingWriteFire(state, event);
        case 'authorize-immediate-write':
            if (state.explicitJumpActive) {
                const effect: BottomFollowWriteSchedulerEffect<PreviousWebMetrics> = {
                    reason: 'explicit-jump-active',
                    type: 'drop-write',
                };
                return {
                    effects: [effect],
                    state,
                };
            }
            if (state.gestureActive) {
                const effect: BottomFollowWriteSchedulerEffect<PreviousWebMetrics> = {
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
        case 'clear-pending':
            return {
                effects: [],
                state: {
                    ...state,
                    pending: null,
                },
            };
    }
}

function planExplicitJumpActiveChange<PreviousWebMetrics>(
    state: BottomFollowWriteSchedulerState<PreviousWebMetrics>,
    active: boolean,
): BottomFollowWriteSchedulerPlan<PreviousWebMetrics> {
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

function planGestureActiveChange<PreviousWebMetrics>(
    state: BottomFollowWriteSchedulerState<PreviousWebMetrics>,
    active: boolean,
): BottomFollowWriteSchedulerPlan<PreviousWebMetrics> {
    if (state.gestureActive === active) {
        return { effects: [], state };
    }
    const nextState = {
        ...state,
        gestureActive: active,
    };
    if (active || state.pending === null) {
        return {
            effects: [],
            state: nextState,
        };
    }
    return {
        effects: [
            {
                type: 'schedule-write',
                write: state.pending,
            },
        ],
        state: nextState,
    };
}

function planWriteRequest<PreviousWebMetrics>(
    state: BottomFollowWriteSchedulerState<PreviousWebMetrics>,
    event: Extract<BottomFollowWriteSchedulerEvent<PreviousWebMetrics>, { type: 'request-write' }>,
): BottomFollowWriteSchedulerPlan<PreviousWebMetrics> {
    if (state.explicitJumpActive) {
        return {
            effects: [
                {
                    reason: 'explicit-jump-active',
                    type: 'drop-write',
                },
            ],
            state,
        };
    }
    if (event.waitMs === null) {
        return {
            effects: [
                {
                    reason: 'auto-follow-blocked',
                    type: 'drop-write',
                },
            ],
            state,
        };
    }

    const supersedesPending =
        state.pending !== null &&
        (
            (
                event.platform === 'native' &&
                event.usesNativeFlashListBottomMaintenance &&
                event.reason === 'stream-append' &&
                state.pending.reason !== 'stream-append'
            ) ||
            (
                event.platform === 'web' &&
                event.previousWebMetrics !== null
            )
        );

    if (state.pending !== null && !supersedesPending) {
        return {
            effects: [
                {
                    reason: 'existing-pending-write',
                    type: 'coalesce-write',
                    write: state.pending,
                },
            ],
            state,
        };
    }

    const delayMs = Math.max(0, event.waitMs);
    const write: BottomFollowScheduledWrite<PreviousWebMetrics> = {
        delayMs,
        kind: delayMs === 0 && event.canUseAnimationFrame ? 'raf' : 'timeout',
        nativePrevFollowAtBottom: event.nativePrevFollowAtBottom,
        previousWebMetrics: event.previousWebMetrics,
        reason: event.reason,
        writer: event.writer,
    };
    const nextState = {
        ...state,
        pending: write,
    };
    if (state.gestureActive) {
        return {
            effects: [
                {
                    reason: 'gesture-active',
                    type: 'defer-write',
                    write,
                },
            ],
            state: nextState,
        };
    }

    return {
        effects: [
            ...(supersedesPending ? [{ type: 'cancel-scheduled-write' } as const] : []),
            {
                type: 'schedule-write',
                write,
            },
        ],
        state: nextState,
    };
}

function planPendingWriteFire<PreviousWebMetrics>(
    state: BottomFollowWriteSchedulerState<PreviousWebMetrics>,
    event: Extract<BottomFollowWriteSchedulerEvent<PreviousWebMetrics>, { type: 'fire-pending' }>,
): BottomFollowWriteSchedulerPlan<PreviousWebMetrics> {
    const write = state.pending;
    const nextState = {
        ...state,
        pending: null,
    };
    if (write === null) {
        return {
            effects: [
                {
                    reason: 'no-pending-write',
                    type: 'drop-write',
                },
            ],
            state: nextState,
        };
    }
    if (state.gestureActive) {
        return {
            effects: [
                {
                    reason: 'gesture-active',
                    type: 'defer-write',
                    write,
                },
            ],
            state,
        };
    }
    if (state.explicitJumpActive) {
        return {
            effects: [
                {
                    reason: 'explicit-jump-active',
                    type: 'drop-write',
                    write,
                },
            ],
            state: nextState,
        };
    }
    if (
        typeof event.observedRawOffsetY === 'number' &&
        Number.isFinite(event.observedRawOffsetY) &&
        event.observedRawOffsetY < 0
    ) {
        return {
            effects: [
                {
                    observedRawOffsetY: event.observedRawOffsetY,
                    reason: 'negative-raw-offset',
                    type: 'drop-write',
                    write,
                },
            ],
            state: nextState,
        };
    }
    if (event.waitMs !== 0) {
        return {
            effects: [
                {
                    reason: 'auto-follow-not-ready',
                    type: 'drop-write',
                    write,
                },
            ],
            state: nextState,
        };
    }

    const effects: BottomFollowWriteSchedulerEffect<PreviousWebMetrics>[] = [];
    if (write.previousWebMetrics !== null) {
        effects.push({
            command: 'web-bottom-follow-adjustment',
            previousWebMetrics: write.previousWebMetrics,
            reason: write.reason,
            schedulerAuthorityReason: write.reason,
            schedulerAuthorityWriter: write.writer,
            type: 'authorize-write',
            writer: write.writer,
        });
    }
    effects.push(event.usesNativeFlashListBottomMaintenance
        ? {
            command: 'native-respecting-mount-settle',
            nativePrevFollowAtBottom: write.nativePrevFollowAtBottom,
            reason: write.reason,
            schedulerAuthorityReason: write.reason,
            schedulerAuthorityWriter: write.writer,
            type: 'authorize-write',
            writer: write.writer,
        }
        : {
            command: 'pin-to-bottom',
            reason: write.reason,
            schedulerAuthorityReason: write.reason,
            schedulerAuthorityWriter: write.writer,
            type: 'authorize-write',
            writer: write.writer,
        });

    return {
        effects,
        state: nextState,
    };
}
