import { describe, expect, it } from 'vitest';

import {
    resolveWebUserScrollIntentTimestampApplyEffects,
    resolveWebUserScrollTakeoverApplyEffects,
    type WebUserScrollIntentTimestampApplyEffect,
    type WebUserScrollTakeoverApplyEffect,
} from './webUserScrollIntent';

const takeoverEffect = (
    overrides: Partial<WebUserScrollTakeoverApplyEffect> = {},
): WebUserScrollTakeoverApplyEffect => ({
    sessionId: 'session-a',
    type: 'web-user-scroll-preempt-entry-restore',
    ...overrides,
});

const explicitJumpTakeoverEffect = (
    overrides: Partial<WebUserScrollTakeoverApplyEffect> = {},
): WebUserScrollTakeoverApplyEffect => ({
    sessionId: 'session-a',
    type: 'web-user-scroll-preempt-explicit-jump',
    ...overrides,
});

const timestampEffect = (
    overrides: Partial<WebUserScrollIntentTimestampApplyEffect> = {},
): WebUserScrollIntentTimestampApplyEffect => ({
    sessionId: 'session-a',
    timestampMs: 123,
    type: 'web-user-scroll-record-intent-timestamp',
    ...overrides,
});

describe('web user-scroll intent apply effects', () => {
    it('returns no takeover apply effects when none match the current session', () => {
        expect(resolveWebUserScrollTakeoverApplyEffects({
            effects: [],
            sessionId: 'session-a',
        })).toEqual([]);

        expect(resolveWebUserScrollTakeoverApplyEffects({
            effects: [
                takeoverEffect({ sessionId: 'session-b' }),
                timestampEffect(),
            ],
            sessionId: 'session-a',
        })).toEqual([]);
    });

    it('returns current-session takeover effects in order', () => {
        const effects = [
            takeoverEffect(),
            explicitJumpTakeoverEffect(),
        ];

        expect(resolveWebUserScrollTakeoverApplyEffects({
            effects,
            sessionId: 'session-a',
        })).toEqual(effects);
    });

    it('returns no timestamp apply effects when none match the current session', () => {
        expect(resolveWebUserScrollIntentTimestampApplyEffects({
            effects: [],
            sessionId: 'session-a',
        })).toEqual([]);

        expect(resolveWebUserScrollIntentTimestampApplyEffects({
            effects: [
                timestampEffect({ sessionId: 'session-b', timestampMs: 9 }),
                takeoverEffect(),
            ],
            sessionId: 'session-a',
        })).toEqual([]);
    });

    it('returns current-session timestamp effects in order', () => {
        const effects = [
            timestampEffect({ timestampMs: 10 }),
            timestampEffect({ timestampMs: 20 }),
        ];

        expect(resolveWebUserScrollIntentTimestampApplyEffects({
            effects,
            sessionId: 'session-a',
        })).toEqual(effects);
    });

    it('filters mixed lifecycle effects by web intent type and current session', () => {
        const currentTakeover = takeoverEffect();
        const currentTimestamp = timestampEffect({ timestampMs: 15 });
        const nativeTouchEffect = {
            sessionId: 'session-a',
            timestampMs: 20,
            type: 'native-touch-record-intent-timestamp',
        };
        const localInteractionEffect = {
            sessionId: 'session-a',
            timestampMs: 21,
            type: 'local-interaction-record-intent-timestamp',
        };

        const effects = [
            takeoverEffect({ sessionId: 'session-b' }),
            timestampEffect({ sessionId: 'session-b', timestampMs: 9 }),
            nativeTouchEffect,
            localInteractionEffect,
            currentTakeover,
            explicitJumpTakeoverEffect(),
            currentTimestamp,
        ];

        expect(resolveWebUserScrollTakeoverApplyEffects({
            effects,
            sessionId: 'session-a',
        })).toEqual([currentTakeover, explicitJumpTakeoverEffect()]);
        expect(resolveWebUserScrollIntentTimestampApplyEffects({
            effects,
            sessionId: 'session-a',
        })).toEqual([currentTimestamp]);
    });
});
