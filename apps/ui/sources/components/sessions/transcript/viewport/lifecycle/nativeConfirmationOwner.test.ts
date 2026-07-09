import { describe, expect, it } from 'vitest';

import { createNativeConfirmationOwner } from './nativeConfirmationOwner';

const baseObservation = {
    bottomFollowMode: 'following',
    contentHeight: 1200,
    distanceFromBottom: 180,
    isTrusted: false,
    mountSettleDeadlineReached: false,
    mountSettleStable: false,
    pinThresholdPx: 72,
    sessionId: 'session-1',
    wantsPinned: true,
} as const;

describe('native confirmation owner', () => {
    it('owns explicit jump pending state and spends one bounded reconfirm', () => {
        const owner = createNativeConfirmationOwner();
        owner.armExplicitJump({
            issuedContentHeight: 1200,
            sessionId: 'session-1',
        });

        expect(owner.observeScroll({
            ...baseObservation,
            contentHeight: 1500,
        })).toEqual({
            consumed: true,
            entrySettleEffects: [],
            explicitJumpEffects: [
                { sessionId: 'session-1', type: 'issue-reconfirm-jump-to-bottom' },
            ],
        });

        expect(owner.observeScroll({
            ...baseObservation,
            contentHeight: 1700,
        })).toEqual({
            consumed: true,
            entrySettleEffects: [],
            explicitJumpEffects: [],
        });
    });

    it('clears explicit jump pending state after bottom-threshold arrival', () => {
        const owner = createNativeConfirmationOwner();
        owner.armExplicitJump({
            issuedContentHeight: 1200,
            sessionId: 'session-1',
        });

        expect(owner.observeScroll({
            ...baseObservation,
            distanceFromBottom: 40,
        })).toEqual({
            consumed: true,
            entrySettleEffects: [],
            explicitJumpEffects: [
                {
                    distanceFromBottom: 40,
                    sessionId: 'session-1',
                    type: 'adopt-live-tail-arrival',
                },
            ],
        });
        expect(owner.observeScroll({
            ...baseObservation,
            contentHeight: 1500,
        })).toEqual({
            consumed: false,
            entrySettleEffects: [],
            explicitJumpEffects: [],
        });
    });

    it('owns entry-settle pending state without consuming observations', () => {
        const owner = createNativeConfirmationOwner();
        owner.resetEntrySettle({
            sessionId: 'session-1',
            shouldArmConfirmation: true,
        });

        expect(owner.observeScroll({
            ...baseObservation,
            contentHeight: 1300,
            distanceFromBottom: 40,
        })).toEqual({
            consumed: false,
            entrySettleEffects: [],
            explicitJumpEffects: [],
        });
        expect(owner.observeScroll({
            ...baseObservation,
            contentHeight: 1500,
            mountSettleStable: true,
        })).toEqual({
            consumed: false,
            entrySettleEffects: [
                { sessionId: 'session-1', type: 'issue-entry-settle-reconfirm-pin' },
            ],
            explicitJumpEffects: [],
        });
        expect(owner.observeScroll({
            ...baseObservation,
            contentHeight: 1700,
            mountSettleStable: true,
        })).toEqual({
            consumed: false,
            entrySettleEffects: [],
            explicitJumpEffects: [],
        });
    });

    it('runs explicit jump before entry-settle and skips entry-settle when explicit consumes', () => {
        const owner = createNativeConfirmationOwner();
        owner.armExplicitJump({
            issuedContentHeight: 1200,
            sessionId: 'session-1',
        });
        owner.armEntrySettle({
            baselineContentHeight: 1200,
            sessionId: 'session-1',
        });

        expect(owner.observeScroll({
            ...baseObservation,
            contentHeight: 1500,
            mountSettleStable: true,
        })).toEqual({
            consumed: true,
            entrySettleEffects: [],
            explicitJumpEffects: [
                { sessionId: 'session-1', type: 'issue-reconfirm-jump-to-bottom' },
            ],
        });

        owner.clearExplicitJump({ sessionId: 'session-1' });
        expect(owner.observeScroll({
            ...baseObservation,
            contentHeight: 1500,
            mountSettleStable: true,
        })).toEqual({
            consumed: false,
            entrySettleEffects: [
                { sessionId: 'session-1', type: 'issue-entry-settle-reconfirm-pin' },
            ],
            explicitJumpEffects: [],
        });
    });
});
