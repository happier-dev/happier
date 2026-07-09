import { describe, expect, it } from 'vitest';

import {
    resolveWebImmediateReleaseLiveTailApplyEffects,
    type WebImmediateReleaseLiveTailApplyEffect,
} from './webImmediateReleaseLiveTail';

const releaseEffect = (
    overrides: Partial<WebImmediateReleaseLiveTailApplyEffect> = {},
): WebImmediateReleaseLiveTailApplyEffect => ({
    sessionId: 'session-a',
    type: 'web-immediate-release-live-tail',
    ...overrides,
});

describe('web immediate release live-tail apply effects', () => {
    it('returns no apply effects when none match the current session', () => {
        expect(resolveWebImmediateReleaseLiveTailApplyEffects({
            effects: [],
            sessionId: 'session-a',
        })).toEqual([]);

        expect(resolveWebImmediateReleaseLiveTailApplyEffects({
            effects: [
                releaseEffect({ sessionId: 'session-b' }),
                {
                    sessionId: 'session-a',
                    type: 'web-user-scroll-preempt-entry-restore',
                },
            ],
            sessionId: 'session-a',
        })).toEqual([]);
    });

    it('returns all current-session release effects in order', () => {
        const effects = [
            releaseEffect(),
            releaseEffect(),
        ];

        expect(resolveWebImmediateReleaseLiveTailApplyEffects({
            effects,
            sessionId: 'session-a',
        })).toEqual(effects);
    });

    it('filters mixed lifecycle effects by immediate web release type and current session', () => {
        const currentRelease = releaseEffect();
        const effects = [
            releaseEffect({ sessionId: 'session-b' }),
            {
                sessionId: 'session-a',
                timestampMs: 10,
                type: 'web-user-scroll-record-intent-timestamp',
            },
            {
                sessionId: 'session-a',
                timestampMs: 20,
                type: 'native-touch-record-intent-timestamp',
            },
            {
                sessionId: 'session-a',
                timestampMs: 21,
                type: 'local-interaction-record-intent-timestamp',
            },
            currentRelease,
        ];

        expect(resolveWebImmediateReleaseLiveTailApplyEffects({
            effects,
            sessionId: 'session-a',
        })).toEqual([currentRelease]);
    });
});
