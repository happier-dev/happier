import { describe, expect, it } from 'vitest';

import {
    resolveNativeUserScrollTakeoverApplyEffects,
    type NativeUserScrollTakeoverApplyEffect,
} from './nativeUserScrollTakeover';

const preemptEntryRestoreEffect = (
    overrides: Partial<Extract<
        NativeUserScrollTakeoverApplyEffect,
        { type: 'native-user-scroll-preempt-entry-restore' }
    >> = {},
): NativeUserScrollTakeoverApplyEffect => ({
    sessionId: 'session-a',
    type: 'native-user-scroll-preempt-entry-restore',
    ...overrides,
});

const clearInitialViewportObservationEffect = (
    overrides: Partial<Extract<
        NativeUserScrollTakeoverApplyEffect,
        { type: 'native-user-scroll-clear-native-initial-viewport-pending-observation' }
    >> = {},
): NativeUserScrollTakeoverApplyEffect => ({
    sessionId: 'session-a',
    type: 'native-user-scroll-clear-native-initial-viewport-pending-observation',
    ...overrides,
});

const recordIntentTimestampEffect = (
    overrides: Partial<Extract<
        NativeUserScrollTakeoverApplyEffect,
        { type: 'native-user-scroll-record-intent-timestamp' }
    >> = {},
): NativeUserScrollTakeoverApplyEffect => ({
    sessionId: 'session-a',
    timestampMs: 123,
    type: 'native-user-scroll-record-intent-timestamp',
    ...overrides,
});

describe('native user-scroll takeover apply effects', () => {
    it('returns no apply effects when none match the current session', () => {
        expect(resolveNativeUserScrollTakeoverApplyEffects({
            effects: [],
            sessionId: 'session-a',
        })).toEqual([]);

        expect(resolveNativeUserScrollTakeoverApplyEffects({
            effects: [
                preemptEntryRestoreEffect({ sessionId: 'session-b' }),
                { sessionId: 'session-a', type: 'native-touch-release-live-tail' },
            ],
            sessionId: 'session-a',
        })).toEqual([]);
    });

    it('returns all current-session native user-scroll takeover effects in order', () => {
        const effects = [
            preemptEntryRestoreEffect(),
            clearInitialViewportObservationEffect(),
            recordIntentTimestampEffect({ timestampMs: 456 }),
        ];

        expect(resolveNativeUserScrollTakeoverApplyEffects({
            effects,
            sessionId: 'session-a',
        })).toEqual(effects);
    });

    it('filters mixed lifecycle effects by native user-scroll type and current session', () => {
        const currentTimestamp = recordIntentTimestampEffect();
        const effects = [
            preemptEntryRestoreEffect({ sessionId: 'session-b' }),
            {
                sessionId: 'session-a',
                timestampMs: 10,
                type: 'native-touch-record-intent-timestamp',
            },
            {
                sessionId: 'session-a',
                timestampMs: 11,
                type: 'local-interaction-record-intent-timestamp',
            },
            {
                sessionId: 'session-a',
                type: 'web-user-scroll-preempt-entry-restore',
            },
            {
                sessionId: 'session-a',
                type: 'web-immediate-release-live-tail',
            },
            {
                active: true,
                sessionId: 'session-a',
                type: 'native-drag-active-mirror',
            },
            {
                sessionId: 'session-a',
                type: 'explicit-jump-preempt-entry-restore',
            },
            {
                sessionId: 'session-a',
                type: 'follow-bottom-intent-preempt-entry-restore',
            },
            currentTimestamp,
        ];

        expect(resolveNativeUserScrollTakeoverApplyEffects({
            effects,
            sessionId: 'session-a',
        })).toEqual([currentTimestamp]);
    });
});
