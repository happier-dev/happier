import { describe, expect, it } from 'vitest';

import {
    resolveLocalTranscriptInteractionAutoPinDeferralApplyEffects,
    type LocalTranscriptInteractionAutoPinDeferralApplyEffect,
} from './localTranscriptInteractionAutoPinDeferral';

const recordIntentEffect = (
    overrides: Partial<Extract<
        LocalTranscriptInteractionAutoPinDeferralApplyEffect,
        { type: 'local-interaction-record-intent-timestamp' }
    >> = {},
): LocalTranscriptInteractionAutoPinDeferralApplyEffect => ({
    sessionId: 'session-a',
    timestampMs: 123,
    type: 'local-interaction-record-intent-timestamp',
    ...overrides,
});

const suppressAutoPinEffect = (
    overrides: Partial<Extract<
        LocalTranscriptInteractionAutoPinDeferralApplyEffect,
        { type: 'local-interaction-suppress-native-mount-settle-auto-pin' }
    >> = {},
): LocalTranscriptInteractionAutoPinDeferralApplyEffect => ({
    sessionId: 'session-a',
    type: 'local-interaction-suppress-native-mount-settle-auto-pin',
    ...overrides,
});

const cancelScheduledPinEffect = (
    overrides: Partial<Extract<
        LocalTranscriptInteractionAutoPinDeferralApplyEffect,
        { type: 'local-interaction-cancel-scheduled-pin' }
    >> = {},
): LocalTranscriptInteractionAutoPinDeferralApplyEffect => ({
    sessionId: 'session-a',
    type: 'local-interaction-cancel-scheduled-pin',
    ...overrides,
});

describe('local transcript interaction auto-pin deferral apply effects', () => {
    it('returns no apply effects when none match the current session', () => {
        expect(resolveLocalTranscriptInteractionAutoPinDeferralApplyEffects({
            effects: [],
            sessionId: 'session-a',
        })).toEqual([]);

        expect(resolveLocalTranscriptInteractionAutoPinDeferralApplyEffects({
            effects: [
                recordIntentEffect({ sessionId: 'session-b' }),
                suppressAutoPinEffect({ sessionId: 'session-b' }),
            ],
            sessionId: 'session-a',
        })).toEqual([]);
    });

    it('returns all current-session local interaction effects in order', () => {
        const effects = [
            recordIntentEffect({ timestampMs: 10 }),
            suppressAutoPinEffect(),
            cancelScheduledPinEffect(),
        ];

        expect(resolveLocalTranscriptInteractionAutoPinDeferralApplyEffects({
            effects,
            sessionId: 'session-a',
        })).toEqual(effects);
    });

    it('filters mixed lifecycle effects to current-session local interaction effects only', () => {
        const currentRecord = recordIntentEffect({ timestampMs: 15 });
        const currentCancel = cancelScheduledPinEffect();
        const nativeTouchEffect = {
            sessionId: 'session-a',
            timestampMs: 20,
            type: 'native-touch-record-intent-timestamp',
        };

        expect(resolveLocalTranscriptInteractionAutoPinDeferralApplyEffects({
            effects: [
                recordIntentEffect({ sessionId: 'session-b', timestampMs: 9 }),
                nativeTouchEffect,
                {
                    sessionId: 'session-a',
                    type: 'web-user-scroll-preempt-entry-restore',
                },
                currentRecord,
                currentCancel,
            ],
            sessionId: 'session-a',
        })).toEqual([currentRecord, currentCancel]);
    });
});
