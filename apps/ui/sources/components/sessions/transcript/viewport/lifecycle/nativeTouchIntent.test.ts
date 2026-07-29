import { describe, expect, it } from 'vitest';

import {
    resolveNativeTouchIntentApplyEffects,
    type NativeTouchIntentApplyEffect,
} from './nativeTouchIntent';

const recordIntentEffect = (
    overrides: Partial<NativeTouchIntentApplyEffect> = {},
): NativeTouchIntentApplyEffect => ({
    sessionId: 'session-a',
    timestampMs: 123,
    type: 'native-touch-record-intent-timestamp',
    ...overrides,
});

describe('native touch intent apply effects', () => {
    it('returns the current-session intent timestamp', () => {
        const effect = recordIntentEffect({ timestampMs: 10 });

        expect(resolveNativeTouchIntentApplyEffects({
            effects: [effect],
            sessionId: 'session-a',
        })).toEqual([effect]);
    });

    it('filters other sessions and lifecycle effects', () => {
        expect(resolveNativeTouchIntentApplyEffects({
            effects: [
                recordIntentEffect({ sessionId: 'session-b' }),
                {
                    sessionId: 'session-a',
                    type: 'native-touch-release-live-tail',
                },
            ],
            sessionId: 'session-a',
        })).toEqual([]);
    });
});
