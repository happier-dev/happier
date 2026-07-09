import { describe, expect, it } from 'vitest';

import {
    resolveFollowBottomIntentTakeoverApplyEffects,
    type FollowBottomIntentTakeoverApplyEffect,
} from './followBottomIntentTakeover';

const preemptEntryRestoreEffect = (
    overrides: Partial<Extract<
        FollowBottomIntentTakeoverApplyEffect,
        { type: 'follow-bottom-intent-preempt-entry-restore' }
    >> = {},
): FollowBottomIntentTakeoverApplyEffect => ({
    sessionId: 'session-a',
    type: 'follow-bottom-intent-preempt-entry-restore',
    ...overrides,
});

const clearUserScrollIntentEffect = (
    overrides: Partial<Extract<
        FollowBottomIntentTakeoverApplyEffect,
        { type: 'follow-bottom-intent-clear-user-scroll-intent' }
    >> = {},
): FollowBottomIntentTakeoverApplyEffect => ({
    sessionId: 'session-a',
    type: 'follow-bottom-intent-clear-user-scroll-intent',
    ...overrides,
});

const recordLiveTailPinOffsetEffect = (
    overrides: Partial<Extract<
        FollowBottomIntentTakeoverApplyEffect,
        { type: 'follow-bottom-intent-record-live-tail-pin-offset' }
    >> = {},
): FollowBottomIntentTakeoverApplyEffect => ({
    distanceFromLiveTailPx: 0,
    sessionId: 'session-a',
    type: 'follow-bottom-intent-record-live-tail-pin-offset',
    ...overrides,
});

describe('follow-bottom intent takeover apply effects', () => {
    it('returns no apply effects when none match the current session', () => {
        expect(resolveFollowBottomIntentTakeoverApplyEffects({
            effects: [],
            sessionId: 'session-a',
        })).toEqual([]);

        expect(resolveFollowBottomIntentTakeoverApplyEffects({
            effects: [
                preemptEntryRestoreEffect({ sessionId: 'session-b' }),
                {
                    sessionId: 'session-a',
                    type: 'web-immediate-release-live-tail',
                },
            ],
            sessionId: 'session-a',
        })).toEqual([]);
    });

    it('returns all current-session follow-bottom intent takeover effects in order', () => {
        const effects = [
            preemptEntryRestoreEffect(),
            clearUserScrollIntentEffect(),
            recordLiveTailPinOffsetEffect({ distanceFromLiveTailPx: 12 }),
        ];

        expect(resolveFollowBottomIntentTakeoverApplyEffects({
            effects,
            sessionId: 'session-a',
        })).toEqual(effects);
    });

    it('filters mixed lifecycle effects by follow-bottom intent type and current session', () => {
        const currentRecordOffset = recordLiveTailPinOffsetEffect({ distanceFromLiveTailPx: 42 });
        const effects = [
            preemptEntryRestoreEffect({ sessionId: 'session-b' }),
            {
                sessionId: 'session-a',
                type: 'explicit-jump-preempt-entry-restore',
            },
            {
                sessionId: 'session-a',
                type: 'native-user-scroll-preempt-entry-restore',
            },
            {
                sessionId: 'session-a',
                type: 'web-user-scroll-preempt-entry-restore',
            },
            {
                sessionId: 'session-a',
                timestampMs: 10,
                type: 'web-user-scroll-record-intent-timestamp',
            },
            {
                sessionId: 'session-a',
                type: 'web-immediate-release-live-tail',
            },
            {
                sessionId: 'session-a',
                timestampMs: 11,
                type: 'native-touch-record-intent-timestamp',
            },
            {
                sessionId: 'session-a',
                timestampMs: 12,
                type: 'local-interaction-record-intent-timestamp',
            },
            {
                active: true,
                sessionId: 'session-a',
                type: 'native-momentum-active-mirror',
            },
            currentRecordOffset,
        ];

        expect(resolveFollowBottomIntentTakeoverApplyEffects({
            effects,
            sessionId: 'session-a',
        })).toEqual([currentRecordOffset]);
    });
});
