import { describe, expect, it } from 'vitest';

import {
    resolveNativeTouchIntentApplyEffects,
    type NativeTouchIntentApplyEffect,
} from './nativeTouchIntent';

const recordIntentEffect = (
    overrides: Partial<Extract<
        NativeTouchIntentApplyEffect,
        { type: 'native-touch-record-intent-timestamp' }
    >> = {},
): NativeTouchIntentApplyEffect => ({
    sessionId: 'session-a',
    timestampMs: 123,
    type: 'native-touch-record-intent-timestamp',
    ...overrides,
});

const suppressAutoPinEffect = (
    overrides: Partial<Extract<
        NativeTouchIntentApplyEffect,
        { type: 'native-touch-suppress-native-mount-settle-auto-pin' }
    >> = {},
): NativeTouchIntentApplyEffect => ({
    sessionId: 'session-a',
    type: 'native-touch-suppress-native-mount-settle-auto-pin',
    ...overrides,
});

const cancelMountSettleBottomPinEffect = (
    overrides: Partial<Extract<
        NativeTouchIntentApplyEffect,
        { type: 'native-touch-cancel-native-mount-settle-bottom-pin' }
    >> = {},
): NativeTouchIntentApplyEffect => ({
    sessionId: 'session-a',
    type: 'native-touch-cancel-native-mount-settle-bottom-pin',
    ...overrides,
});

const cancelScheduledPinEffect = (
    overrides: Partial<Extract<
        NativeTouchIntentApplyEffect,
        { type: 'native-touch-cancel-scheduled-pin' }
    >> = {},
): NativeTouchIntentApplyEffect => ({
    sessionId: 'session-a',
    type: 'native-touch-cancel-scheduled-pin',
    ...overrides,
});

describe('native touch intent apply effects', () => {
    it('returns no apply effects when none match the current session', () => {
        expect(resolveNativeTouchIntentApplyEffects({
            effects: [],
            sessionId: 'session-a',
        })).toEqual([]);

        expect(resolveNativeTouchIntentApplyEffects({
            effects: [
                recordIntentEffect({ sessionId: 'session-b' }),
                suppressAutoPinEffect({ sessionId: 'session-b' }),
            ],
            sessionId: 'session-a',
        })).toEqual([]);
    });

    it('returns all current-session touch intent effects in order', () => {
        const effects = [
            recordIntentEffect({ timestampMs: 10 }),
            suppressAutoPinEffect(),
            cancelMountSettleBottomPinEffect(),
            cancelScheduledPinEffect(),
        ];

        expect(resolveNativeTouchIntentApplyEffects({
            effects,
            sessionId: 'session-a',
        })).toEqual(effects);
    });

    it('supports active native restore touch intent without recording a timestamp', () => {
        const effects = [
            suppressAutoPinEffect(),
            cancelMountSettleBottomPinEffect(),
            cancelScheduledPinEffect(),
        ];

        expect(resolveNativeTouchIntentApplyEffects({
            effects,
            sessionId: 'session-a',
        })).toEqual(effects);
    });

    it('filters mixed lifecycle effects to current-session touch intent effects only', () => {
        const currentRecord = recordIntentEffect({ timestampMs: 15 });
        const currentCancel = cancelScheduledPinEffect();
        const localInteractionEffect = {
            sessionId: 'session-a',
            timestampMs: 17,
            type: 'local-interaction-record-intent-timestamp',
        };

        expect(resolveNativeTouchIntentApplyEffects({
            effects: [
                recordIntentEffect({ sessionId: 'session-b', timestampMs: 9 }),
                {
                    sessionId: 'session-a',
                    type: 'native-touch-release-live-tail',
                },
                localInteractionEffect,
                currentRecord,
                currentCancel,
            ],
            sessionId: 'session-a',
        })).toEqual([currentRecord, currentCancel]);
    });
});
