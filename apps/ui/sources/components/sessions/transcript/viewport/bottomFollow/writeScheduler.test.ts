import { describe, expect, it } from 'vitest';

import {
    planBottomFollowWriteSchedulerEvent,
    type BottomFollowWriteSchedulerState,
} from './writeScheduler';

function initialState(): BottomFollowWriteSchedulerState {
    return {
        explicitJumpActive: false,
        gestureActive: false,
    };
}

describe('bottom-follow write authority', () => {
    it('authorizes immediate blank recovery while no exclusive writer is active', () => {
        const state = initialState();

        expect(planBottomFollowWriteSchedulerEvent(state, {
            reason: 'passive-drift',
            type: 'authorize-immediate-write',
            writer: 'blank-recovery',
        })).toEqual({
            effects: [{
                reason: 'passive-drift',
                schedulerAuthorityReason: 'passive-drift',
                schedulerAuthorityWriter: 'blank-recovery',
                type: 'authorize-write',
                writer: 'blank-recovery',
            }],
            state,
        });
    });

    it('drops blank recovery while a gesture owns the viewport', () => {
        const gestureState = planBottomFollowWriteSchedulerEvent(initialState(), {
            active: true,
            type: 'set-gesture-active',
        }).state;

        expect(planBottomFollowWriteSchedulerEvent(gestureState, {
            reason: 'passive-drift',
            type: 'authorize-immediate-write',
            writer: 'blank-recovery',
        })).toEqual({
            effects: [{
                reason: 'gesture-active',
                type: 'drop-write',
            }],
            state: gestureState,
        });
    });

    it('drops blank recovery while an explicit jump owns the viewport', () => {
        const jumpState = planBottomFollowWriteSchedulerEvent(initialState(), {
            active: true,
            type: 'set-explicit-jump-active',
        }).state;

        expect(planBottomFollowWriteSchedulerEvent(jumpState, {
            reason: 'passive-drift',
            type: 'authorize-immediate-write',
            writer: 'blank-recovery',
        })).toEqual({
            effects: [{
                reason: 'explicit-jump-active',
                type: 'drop-write',
            }],
            state: jumpState,
        });
    });
});
