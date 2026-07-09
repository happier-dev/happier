import { describe, expect, it } from 'vitest';

import {
    resolveNativeExplicitJumpConfirmationEffects,
    type NativeExplicitJumpConfirmationState,
} from './nativeExplicitJumpConfirmation';

const pending: NativeExplicitJumpConfirmationState = {
    issuedContentHeight: 1200,
    reconfirmSpent: false,
    sessionId: 'session-1',
};

describe('native explicit jump confirmation', () => {
    it('does nothing when there is no pending confirmation', () => {
        expect(resolveNativeExplicitJumpConfirmationEffects({
            pending: null,
            observation: {
                contentHeight: 1200,
                distanceFromBottom: 120,
                isTrusted: false,
                pinThresholdPx: 72,
                sessionId: 'session-1',
            },
        })).toEqual({
            consumed: false,
            effects: [],
            pending: null,
        });
    });

    it('clears stale-session and trusted-scroll pending confirmation without consuming the observation', () => {
        for (const observation of [
            {
                contentHeight: 1200,
                distanceFromBottom: 120,
                isTrusted: false,
                pinThresholdPx: 72,
                sessionId: 'session-2',
            },
            {
                contentHeight: 1200,
                distanceFromBottom: 120,
                isTrusted: true,
                pinThresholdPx: 72,
                sessionId: 'session-1',
            },
        ]) {
            expect(resolveNativeExplicitJumpConfirmationEffects({
                pending,
                observation,
            })).toEqual({
                consumed: false,
                effects: [],
                pending: null,
            });
        }
    });

    it('clears pending and adopts live-tail arrival when the explicit jump reaches the bottom threshold', () => {
        expect(resolveNativeExplicitJumpConfirmationEffects({
            pending,
            observation: {
                contentHeight: 1200,
                distanceFromBottom: 40,
                isTrusted: false,
                pinThresholdPx: 72,
                sessionId: 'session-1',
            },
        })).toEqual({
            consumed: true,
            effects: [
                {
                    distanceFromBottom: 40,
                    sessionId: 'session-1',
                    type: 'adopt-live-tail-arrival',
                },
            ],
            pending: null,
        });
    });

    it('spends exactly one reconfirm write when content height changes before bottom arrival', () => {
        expect(resolveNativeExplicitJumpConfirmationEffects({
            pending,
            observation: {
                contentHeight: 1500,
                distanceFromBottom: 180,
                isTrusted: false,
                pinThresholdPx: 72,
                sessionId: 'session-1',
            },
        })).toEqual({
            consumed: true,
            effects: [{ type: 'issue-reconfirm-jump-to-bottom', sessionId: 'session-1' }],
            pending: {
                issuedContentHeight: 1500,
                reconfirmSpent: true,
                sessionId: 'session-1',
            },
        });
    });

    it('keeps ownership without another write after the reconfirm is spent', () => {
        const spentPending: NativeExplicitJumpConfirmationState = {
            ...pending,
            reconfirmSpent: true,
        };

        expect(resolveNativeExplicitJumpConfirmationEffects({
            pending: spentPending,
            observation: {
                contentHeight: 1600,
                distanceFromBottom: 180,
                isTrusted: false,
                pinThresholdPx: 72,
                sessionId: 'session-1',
            },
        })).toEqual({
            consumed: true,
            effects: [],
            pending: spentPending,
        });
    });

    it('leaves unchanged off-bottom observations unconsumed', () => {
        expect(resolveNativeExplicitJumpConfirmationEffects({
            pending,
            observation: {
                contentHeight: 1200,
                distanceFromBottom: 180,
                isTrusted: false,
                pinThresholdPx: 72,
                sessionId: 'session-1',
            },
        })).toEqual({
            consumed: false,
            effects: [],
            pending,
        });
    });
});
