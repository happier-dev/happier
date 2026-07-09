import { describe, expect, it } from 'vitest';

import {
    planBottomFollowWriteSchedulerEvent,
    type BottomFollowScheduledWrite,
    type BottomFollowWriteSchedulerState,
} from './writeScheduler';

type TestWebMetrics = Readonly<{
    scrollTop: number;
}>;

function initialState(
    overrides: Partial<BottomFollowWriteSchedulerState<TestWebMetrics> & { explicitJumpActive: boolean }> = {},
): BottomFollowWriteSchedulerState<TestWebMetrics> {
    return {
        explicitJumpActive: false,
        gestureActive: false,
        pending: null,
        ...overrides,
    } as BottomFollowWriteSchedulerState<TestWebMetrics>;
}

function scheduledWrite(
    overrides: Partial<BottomFollowScheduledWrite<TestWebMetrics>> = {},
): BottomFollowScheduledWrite<TestWebMetrics> {
    return {
        delayMs: 0,
        kind: 'raf',
        nativePrevFollowAtBottom: false,
        previousWebMetrics: null,
        reason: 'content-size-change',
        writer: 'content-growth',
        ...overrides,
    };
}

describe('bottom-follow write scheduler', () => {
    it('suspends automatic writes during an active gesture and releases the coalesced write after the gesture ends', () => {
        const suspended = planBottomFollowWriteSchedulerEvent(initialState(), {
            active: true,
            type: 'set-gesture-active',
        });
        expect(suspended).toEqual({
            effects: [],
            state: {
                explicitJumpActive: false,
                gestureActive: true,
                pending: null,
            },
        });

        const requested = planBottomFollowWriteSchedulerEvent(suspended.state, {
            canUseAnimationFrame: true,
            nativePrevFollowAtBottom: false,
            platform: 'web',
            previousWebMetrics: { scrollTop: 120 },
            reason: 'content-size-change',
            type: 'request-write',
            usesNativeFlashListBottomMaintenance: false,
            waitMs: 0,
            writer: 'content-growth',
        });

        expect(requested).toEqual({
            effects: [
                {
                    reason: 'gesture-active',
                    type: 'defer-write',
                    write: scheduledWrite({
                        previousWebMetrics: { scrollTop: 120 },
                    }),
                },
            ],
            state: {
                explicitJumpActive: false,
                gestureActive: true,
                pending: scheduledWrite({
                    previousWebMetrics: { scrollTop: 120 },
                }),
            },
        });

        expect(planBottomFollowWriteSchedulerEvent(requested.state, {
            active: false,
            type: 'set-gesture-active',
        })).toEqual({
            effects: [
                {
                    type: 'schedule-write',
                    write: scheduledWrite({
                        previousWebMetrics: { scrollTop: 120 },
                    }),
                },
            ],
            state: {
                explicitJumpActive: false,
                gestureActive: false,
                pending: scheduledWrite({
                    previousWebMetrics: { scrollTop: 120 },
                }),
            },
        });
    });

    it('coalesces pending automatic writes so one trigger cannot install two timers', () => {
        const state = initialState({
            pending: scheduledWrite({
                previousWebMetrics: { scrollTop: 200 },
            }),
        });

        expect(planBottomFollowWriteSchedulerEvent(state, {
            canUseAnimationFrame: true,
            nativePrevFollowAtBottom: false,
            platform: 'web',
            previousWebMetrics: null,
            reason: 'layout-change',
            type: 'request-write',
            usesNativeFlashListBottomMaintenance: false,
            waitMs: 0,
            writer: 'automatic-live-tail',
        })).toEqual({
            effects: [
                {
                    reason: 'existing-pending-write',
                    type: 'coalesce-write',
                    write: state.pending,
                },
            ],
            state,
        });
    });

    it('supersedes stale pending web metrics with a fresh materialized-state capture', () => {
        const state = initialState({
            pending: scheduledWrite({
                previousWebMetrics: { scrollTop: 200 },
            }),
        });

        expect(planBottomFollowWriteSchedulerEvent(state, {
            canUseAnimationFrame: true,
            nativePrevFollowAtBottom: false,
            platform: 'web',
            previousWebMetrics: { scrollTop: 240 },
            reason: 'content-size-change',
            type: 'request-write',
            usesNativeFlashListBottomMaintenance: false,
            waitMs: 0,
            writer: 'content-growth',
        })).toEqual({
            effects: [
                { type: 'cancel-scheduled-write' },
                {
                    type: 'schedule-write',
                    write: scheduledWrite({
                        previousWebMetrics: { scrollTop: 240 },
                    }),
                },
            ],
            state: {
                explicitJumpActive: false,
                gestureActive: false,
                pending: scheduledWrite({
                    previousWebMetrics: { scrollTop: 240 },
                }),
            },
        });
    });

    it('absorbs gesture-free negative raw transients without authorizing a cascading write', () => {
        expect(planBottomFollowWriteSchedulerEvent(initialState({
            pending: scheduledWrite({
                nativePrevFollowAtBottom: true,
                reason: 'stream-append',
                writer: 'hot-tail-carve',
            }),
        }), {
            observedRawOffsetY: -1076,
            type: 'fire-pending',
            usesNativeFlashListBottomMaintenance: true,
            waitMs: 0,
        })).toEqual({
            effects: [
                {
                    observedRawOffsetY: -1076,
                    reason: 'negative-raw-offset',
                    type: 'drop-write',
                    write: scheduledWrite({
                        nativePrevFollowAtBottom: true,
                        reason: 'stream-append',
                        writer: 'hot-tail-carve',
                    }),
                },
            ],
            state: {
                explicitJumpActive: false,
                gestureActive: false,
                pending: null,
            },
        });
    });

    it('authorizes web passive correction as an immediate scheduler write', () => {
        expect(planBottomFollowWriteSchedulerEvent(initialState(), {
            reason: 'passive-drift',
            type: 'authorize-immediate-write',
            writer: 'web-passive-correction',
        })).toEqual({
            effects: [
                {
                    reason: 'passive-drift',
                    schedulerAuthorityReason: 'passive-drift',
                    schedulerAuthorityWriter: 'web-passive-correction',
                    type: 'authorize-write',
                    writer: 'web-passive-correction',
                },
            ],
            state: initialState(),
        });
    });

    it('drops immediate automatic writes while a gesture is active', () => {
        const state = initialState({ gestureActive: true });

        expect(planBottomFollowWriteSchedulerEvent(state, {
            reason: 'passive-drift',
            type: 'authorize-immediate-write',
            writer: 'web-passive-correction',
        })).toEqual({
            effects: [
                {
                    reason: 'gesture-active',
                    type: 'drop-write',
                },
            ],
            state,
        });
    });

    it('defers a pending write when a gesture becomes active before the timer fires', () => {
        const write = scheduledWrite({
            previousWebMetrics: { scrollTop: 120 },
        });
        const state = initialState({
            gestureActive: true,
            pending: write,
        });

        expect(planBottomFollowWriteSchedulerEvent(state, {
            observedRawOffsetY: 12,
            type: 'fire-pending',
            usesNativeFlashListBottomMaintenance: false,
            waitMs: 0,
        })).toEqual({
            effects: [
                {
                    reason: 'gesture-active',
                    type: 'defer-write',
                    write,
                },
            ],
            state,
        });
    });

    it('drops passive drift authorization while an explicit jump is in flight', () => {
        const state = initialState({ explicitJumpActive: true });

        expect(planBottomFollowWriteSchedulerEvent(state, {
            reason: 'passive-drift',
            type: 'authorize-immediate-write',
            writer: 'web-passive-correction',
        })).toEqual({
            effects: [
                {
                    reason: 'explicit-jump-active',
                    type: 'drop-write',
                },
            ],
            state,
        });
    });
});
