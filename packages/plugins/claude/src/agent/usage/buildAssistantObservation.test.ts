import { describe, expect, it } from 'vitest';

import { buildClaudeAssistantUsageObservation } from './buildAssistantObservation.js';

describe('buildClaudeAssistantUsageObservation', () => {
    it('builds Claude assistant usage as provider-owned estimated cost telemetry', () => {
        const observation = buildClaudeAssistantUsageObservation({
            modelId: 'claude-sonnet-4-6',
            usage: {
                input_tokens: 11,
                output_tokens: 22,
                cache_read_input_tokens: 3,
                cache_creation_input_tokens: 4,
            },
        });

        expect(observation).toEqual({
            provider: 'claude',
            source: 'claude-assistant-usage',
            scope: 'turn_delta',
            key: 'claude-session',
            modelId: 'claude-sonnet-4-6',
            tokens: {
                total: 40,
                input: 11,
                output: 22,
                cache_creation: 4,
                cache_read: 3,
            },
            cost: {
                estimatedUsd: expect.any(Number),
                total: expect.any(Number),
                input: expect.any(Number),
                output: expect.any(Number),
                billingContext: 'unknown',
                costSource: 'pricing_estimate',
            },
            contextUsedTokens: null,
            contextWindowTokens: null,
        });
        expect(observation?.cost?.total).toBeGreaterThan(0);
    });
});
