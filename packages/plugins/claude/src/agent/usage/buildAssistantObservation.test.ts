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
                reasoning: 0,
                cacheWrite: 4,
                cacheRead: 3,
            },
            cost: {
                estimatedUsd: expect.any(Number),
                reportedUsd: 0,
                breakdown: { cacheSavingsUsd: expect.any(Number) },
                billingContext: 'unknown',
                costSource: 'pricing_estimate',
                currency: 'USD',
            },
            contextUsedTokens: null,
            contextWindowTokens: null,
        });
        expect(observation?.cost?.estimatedUsd).toBeGreaterThan(0);
    });

    it('emits cache savings from known provider pricing', () => {
        const observation = buildClaudeAssistantUsageObservation({
            modelId: 'claude-4.5-sonnet',
            usage: { input_tokens: 1_000_000, cache_read_input_tokens: 100_000 },
        });

        expect(observation?.cost?.breakdown).toEqual({ cacheSavingsUsd: 0.27 });
    });

    it('keeps Provider-bound token telemetry but leaves cost unavailable', () => {
        const observation = buildClaudeAssistantUsageObservation({
            modelId: 'deepseek-ai/DeepSeek-V3.1',
            modelSource: 'provider',
            usage: {
                input_tokens: 1_000_000,
                output_tokens: 100_000,
            },
        });

        expect(observation).toMatchObject({
            modelId: 'deepseek-ai/DeepSeek-V3.1',
            tokens: {
                total: 1_100_000,
                input: 1_000_000,
                output: 100_000,
                reasoning: 0,
                cacheRead: 0,
                cacheWrite: 0,
            },
            cost: null,
        });
    });

    it('does not assign default Sonnet pricing to an unknown native model id', () => {
        const observation = buildClaudeAssistantUsageObservation({
            modelId: 'future-model-without-pricing',
            usage: { input_tokens: 1_000_000 },
        });

        expect(observation?.cost).toBeNull();
    });
});
