import { describe, expect, it } from 'vitest';

import { buildClaudeAssistantUsageObservation } from './buildAssistantObservation.js';

describe('buildClaudeAssistantUsageObservation', () => {
    const SONNET_5_STANDARD_PRICING_START_MS = Date.UTC(2026, 8, 1);

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
            modelId: 'claude-sonnet-4-6',
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

    it('leaves cost unavailable for a catalog model without exact pricing', () => {
        const observation = buildClaudeAssistantUsageObservation({
            modelId: 'claude-opus-5',
            usage: {
                input_tokens: 1_000_000,
                output_tokens: 1_000_000,
            },
        });

        expect(observation?.cost).toBeNull();
    });

    it.each([
        ['claude-opus-4-5-20251101', 30],
        ['claude-opus-4-5', 30],
        ['claude-opus-4-1-20250805', 90],
        ['claude-opus-4-1', 90],
        ['claude-sonnet-4-5-20250929', 18],
        ['claude-sonnet-4-5', 18],
        ['claude-haiku-4-5-20251001', 6],
        ['claude-haiku-4-5', 6],
        ['claude-mythos-5', 60],
    ] as const)('uses official pricing for exact current Claude API id or alias %s', (modelId, expectedUsd) => {
        const observation = buildClaudeAssistantUsageObservation({
            modelId,
            observedAtMs: SONNET_5_STANDARD_PRICING_START_MS,
            usage: {
                input_tokens: 1_000_000,
                output_tokens: 1_000_000,
            },
        });

        expect(observation?.cost).toMatchObject({
            estimatedUsd: expectedUsd,
            costSource: 'pricing_estimate',
        });
    });

    it('uses the Sonnet 5 introductory price through August 31, 2026', () => {
        const observation = buildClaudeAssistantUsageObservation({
            modelId: 'claude-sonnet-5',
            observedAtMs: SONNET_5_STANDARD_PRICING_START_MS - 1,
            usage: {
                input_tokens: 1_000_000,
                output_tokens: 1_000_000,
                cache_creation_input_tokens: 1_000_000,
                cache_read_input_tokens: 1_000_000,
            },
        });

        expect(observation?.cost?.estimatedUsd).toBe(14.7);
    });

    it('uses the Sonnet 5 standard price starting September 1, 2026', () => {
        const observation = buildClaudeAssistantUsageObservation({
            modelId: 'claude-sonnet-5',
            observedAtMs: SONNET_5_STANDARD_PRICING_START_MS,
            usage: {
                input_tokens: 1_000_000,
                output_tokens: 1_000_000,
                cache_creation_input_tokens: 1_000_000,
                cache_read_input_tokens: 1_000_000,
            },
        });

        expect(observation?.cost?.estimatedUsd).toBe(22.05);
    });

    it('leaves Sonnet 5 cost unavailable when an observation time is unavailable', () => {
        const observation = buildClaudeAssistantUsageObservation({
            modelId: 'claude-sonnet-5',
            usage: { input_tokens: 1_000_000 },
        });

        expect(observation?.cost).toBeNull();
    });

    it('uses the exact base-model price for Happier’s owned [1m] variant', () => {
        const observation = buildClaudeAssistantUsageObservation({
            modelId: 'claude-sonnet-4-6[1m]',
            usage: { input_tokens: 1_000_000 },
        });

        expect(observation?.cost).toMatchObject({
            estimatedUsd: 3,
            costSource: 'pricing_estimate',
        });
    });

    it.each([
        'future-model-without-pricing',
        'claude-opus-6',
        'claude-sonnet-5-unknown-snapshot',
    ])('does not infer pricing for unknown or unpriced native model %s', (modelId) => {
        const observation = buildClaudeAssistantUsageObservation({
            modelId,
            observedAtMs: SONNET_5_STANDARD_PRICING_START_MS,
            usage: { input_tokens: 1_000_000 },
        });

        expect(observation?.cost).toBeNull();
    });
});
