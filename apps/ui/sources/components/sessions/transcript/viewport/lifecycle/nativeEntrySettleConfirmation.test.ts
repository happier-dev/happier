import { describe, expect, it } from 'vitest';

import {
    createNativeEntrySettleConfirmationState,
    resolveNativeEntrySettleConfirmationEffects,
    type NativeEntrySettleConfirmationState,
} from './nativeEntrySettleConfirmation';

const pending: NativeEntrySettleConfirmationState = {
    issuedContentHeight: 1200,
    sessionId: 'session-1',
};

describe('native entry settle confirmation', () => {
    it('does nothing when there is no pending confirmation', () => {
        expect(resolveNativeEntrySettleConfirmationEffects({
            pending: null,
            observation: {
                bottomFollowMode: 'following',
                contentHeight: 1200,
                distanceFromBottom: 160,
                isTrusted: false,
                mountSettleDeadlineReached: true,
                mountSettleStable: true,
                pinThresholdPx: 72,
                sessionId: 'session-1',
                wantsPinned: true,
            },
        })).toEqual({
            effects: [],
            pending: null,
        });
    });

    it('clears stale, trusted, released, and non-following confirmations', () => {
        for (const observation of [
            {
                bottomFollowMode: 'following' as const,
                contentHeight: 1200,
                distanceFromBottom: 160,
                isTrusted: false,
                mountSettleDeadlineReached: true,
                mountSettleStable: true,
                pinThresholdPx: 72,
                sessionId: 'session-2',
                wantsPinned: true,
            },
            {
                bottomFollowMode: 'following' as const,
                contentHeight: 1200,
                distanceFromBottom: 160,
                isTrusted: true,
                mountSettleDeadlineReached: true,
                mountSettleStable: true,
                pinThresholdPx: 72,
                sessionId: 'session-1',
                wantsPinned: true,
            },
            {
                bottomFollowMode: 'following' as const,
                contentHeight: 1200,
                distanceFromBottom: 160,
                isTrusted: false,
                mountSettleDeadlineReached: true,
                mountSettleStable: true,
                pinThresholdPx: 72,
                sessionId: 'session-1',
                wantsPinned: false,
            },
            {
                bottomFollowMode: 'released' as const,
                contentHeight: 1200,
                distanceFromBottom: 160,
                isTrusted: false,
                mountSettleDeadlineReached: true,
                mountSettleStable: true,
                pinThresholdPx: 72,
                sessionId: 'session-1',
                wantsPinned: true,
            },
        ]) {
            expect(resolveNativeEntrySettleConfirmationEffects({
                pending,
                observation,
            })).toEqual({
                effects: [],
                pending: null,
            });
        }
    });

    it('refreshes the event-source baseline while bottom-confirmed and stays armed', () => {
        expect(resolveNativeEntrySettleConfirmationEffects({
            pending,
            observation: {
                bottomFollowMode: 'following',
                contentHeight: 1400,
                distanceFromBottom: 40,
                isTrusted: false,
                mountSettleDeadlineReached: false,
                mountSettleStable: false,
                pinThresholdPx: 72,
                sessionId: 'session-1',
                wantsPinned: true,
            },
        })).toEqual({
            effects: [],
            pending: {
                issuedContentHeight: 1400,
                sessionId: 'session-1',
            },
        });
    });

    it('records the first off-bottom event-source baseline without pinning', () => {
        const warmPending: NativeEntrySettleConfirmationState = {
            issuedContentHeight: null,
            sessionId: 'session-1',
        };

        expect(resolveNativeEntrySettleConfirmationEffects({
            pending: warmPending,
            observation: {
                bottomFollowMode: 'following',
                contentHeight: 1300,
                distanceFromBottom: 180,
                isTrusted: false,
                mountSettleDeadlineReached: true,
                mountSettleStable: true,
                pinThresholdPx: 72,
                sessionId: 'session-1',
                wantsPinned: true,
            },
        })).toEqual({
            effects: [],
            pending: {
                issuedContentHeight: 1300,
                sessionId: 'session-1',
            },
        });
    });

    it('does not spend the one-shot while mount settle is still active', () => {
        expect(resolveNativeEntrySettleConfirmationEffects({
            pending,
            observation: {
                bottomFollowMode: 'following',
                contentHeight: 1400,
                distanceFromBottom: 180,
                isTrusted: false,
                mountSettleDeadlineReached: false,
                mountSettleStable: false,
                pinThresholdPx: 72,
                sessionId: 'session-1',
                wantsPinned: true,
            },
        })).toEqual({
            effects: [],
            pending,
        });
    });

    it('spends one re-confirm pin when late stable content growth leaves the entry off bottom', () => {
        expect(resolveNativeEntrySettleConfirmationEffects({
            pending,
            observation: {
                bottomFollowMode: 'following',
                contentHeight: 1400,
                distanceFromBottom: 180,
                isTrusted: false,
                mountSettleDeadlineReached: false,
                mountSettleStable: true,
                pinThresholdPx: 72,
                sessionId: 'session-1',
                wantsPinned: true,
            },
        })).toEqual({
            effects: [{ type: 'issue-entry-settle-reconfirm-pin', sessionId: 'session-1' }],
            pending: null,
        });
    });

    it('spends one re-confirm pin when late deadline content growth leaves the entry off bottom', () => {
        expect(resolveNativeEntrySettleConfirmationEffects({
            pending,
            observation: {
                bottomFollowMode: 'following',
                contentHeight: 1400,
                distanceFromBottom: 180,
                isTrusted: false,
                mountSettleDeadlineReached: true,
                mountSettleStable: false,
                pinThresholdPx: 72,
                sessionId: 'session-1',
                wantsPinned: true,
            },
        })).toEqual({
            effects: [{ type: 'issue-entry-settle-reconfirm-pin', sessionId: 'session-1' }],
            pending: null,
        });
    });

    it('ignores unchanged and shrinking off-bottom observations', () => {
        for (const contentHeight of [1200, 1100]) {
            expect(resolveNativeEntrySettleConfirmationEffects({
                pending,
                observation: {
                    bottomFollowMode: 'following',
                    contentHeight,
                    distanceFromBottom: 180,
                    isTrusted: false,
                    mountSettleDeadlineReached: true,
                    mountSettleStable: true,
                    pinThresholdPx: 72,
                    sessionId: 'session-1',
                    wantsPinned: true,
                },
            })).toEqual({
                effects: [],
                pending,
            });
        }
    });

    it('does not emit again after the one-shot clears pending state', () => {
        expect(resolveNativeEntrySettleConfirmationEffects({
            pending: null,
            observation: {
                bottomFollowMode: 'following',
                contentHeight: 1500,
                distanceFromBottom: 180,
                isTrusted: false,
                mountSettleDeadlineReached: true,
                mountSettleStable: true,
                pinThresholdPx: 72,
                sessionId: 'session-1',
                wantsPinned: true,
            },
        })).toEqual({
            effects: [],
            pending: null,
        });
    });

    it('creates state with finite baselines and normalizes missing baselines to null', () => {
        expect(createNativeEntrySettleConfirmationState({
            baselineContentHeight: 1200,
            sessionId: 'session-1',
        })).toEqual({
            issuedContentHeight: 1200,
            sessionId: 'session-1',
        });
        for (const baselineContentHeight of [undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
            expect(createNativeEntrySettleConfirmationState({
                baselineContentHeight,
                sessionId: 'session-1',
            })).toEqual({
                issuedContentHeight: null,
                sessionId: 'session-1',
            });
        }
    });
});
