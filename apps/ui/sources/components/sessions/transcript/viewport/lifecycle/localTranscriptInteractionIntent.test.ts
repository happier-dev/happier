import { describe, expect, it } from 'vitest';

import {
    resolveLocalTranscriptInteractionIntentApplyEffects,
    type LocalTranscriptInteractionIntentApplyEffect,
} from './localTranscriptInteractionIntent';

const recordIntentEffect = (
    overrides: Partial<LocalTranscriptInteractionIntentApplyEffect> = {},
): LocalTranscriptInteractionIntentApplyEffect => ({
    sessionId: 'session-a',
    timestampMs: 123,
    type: 'local-interaction-record-intent-timestamp',
    ...overrides,
});

describe('local transcript interaction intent apply effects', () => {
    it('returns the current-session intent timestamp', () => {
        const effect = recordIntentEffect({ timestampMs: 10 });

        expect(resolveLocalTranscriptInteractionIntentApplyEffects({
            effects: [effect],
            sessionId: 'session-a',
        })).toEqual([effect]);
    });

    it('filters other sessions and lifecycle effects', () => {
        expect(resolveLocalTranscriptInteractionIntentApplyEffects({
            effects: [
                recordIntentEffect({ sessionId: 'session-b' }),
                {
                    sessionId: 'session-a',
                    type: 'web-user-scroll-preempt-entry-restore',
                },
            ],
            sessionId: 'session-a',
        })).toEqual([]);
    });
});
