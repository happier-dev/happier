import { describe, expect, it } from 'vitest';

import { buildClaudeSdkResultUsageObservation } from './buildSdkResultObservation.js';

describe('buildClaudeSdkResultUsageObservation', () => {
    it('includes the runtime context window from Claude modelUsage when present', () => {
        const observation = buildClaudeSdkResultUsageObservation({
            modelId: 'claude-sonnet-4-6',
            result: {
                type: 'result',
                subtype: 'success',
                result: 'done',
                num_turns: 1,
                usage: {
                    input_tokens: 11,
                    output_tokens: 22,
                    cache_read_input_tokens: 3,
                    cache_creation_input_tokens: 4,
                },
                modelUsage: {
                    'claude-sonnet-4-6': {
                        inputTokens: 11,
                        outputTokens: 22,
                        cacheReadInputTokens: 3,
                        cacheCreationInputTokens: 4,
                        contextWindow: 1_000_000,
                    },
                },
                total_cost_usd: 0.123,
                duration_ms: 1,
                duration_api_ms: 1,
                is_error: false,
                session_id: 'ses_1',
            },
        });

        expect(observation).toEqual({
            provider: 'claude',
            source: 'claude-sdk-result',
            scope: 'session_final',
            key: 'claude-session',
            modelId: 'claude-sonnet-4-6',
            tokens: {
                total: 40,
                input: 11,
                output: 22,
                reasoning: 0,
                cacheRead: 3,
                cacheWrite: 4,
            },
            cost: {
                reportedUsd: 0.123,
                estimatedUsd: 0,
                billingContext: 'unknown',
                costSource: 'provider_reported',
                currency: 'USD',
            },
            contextUsedTokens: null,
            contextWindowTokens: 1_000_000,
        });
    });

    it('uses active context usage instead of cumulative result token totals', () => {
        const observation = buildClaudeSdkResultUsageObservation({
            modelId: 'claude-opus-4-7',
            observedAtMs: 1_752_089_600_000,
            result: {
                type: 'result',
                subtype: 'success',
                result: 'done',
                num_turns: 20,
                usage: {
                    input_tokens: 4_000_000,
                    output_tokens: 25_000,
                    cache_read_input_tokens: 39_231_000,
                    cache_creation_input_tokens: 769_000,
                    iterations: [
                        {
                            type: 'message',
                            input_tokens: 100,
                            cache_creation_input_tokens: 20,
                            cache_read_input_tokens: 30,
                            output_tokens: 10,
                        },
                        {
                            type: 'message',
                            input_tokens: 900_000,
                            cache_creation_input_tokens: 8_000,
                            cache_read_input_tokens: 20_000,
                            output_tokens: 10_843,
                        },
                        {
                            type: 'compaction',
                            input_tokens: 999_999,
                            cache_creation_input_tokens: 0,
                            cache_read_input_tokens: 0,
                            output_tokens: 1,
                        },
                    ],
                },
                modelUsage: {
                    'claude-opus-4-7': {
                        contextWindow: 1_000_000,
                    },
                    'claude-sonnet-4-6': {
                        contextWindow: 2_000_000,
                    },
                },
                total_cost_usd: 100,
                duration_ms: 1,
                duration_api_ms: 1,
                is_error: false,
                session_id: 'ses_1',
            },
        });

        expect(observation?.contextUsedTokens).toBe(938_843);
        expect(observation?.contextWindowTokens).toBe(1_000_000);
        expect(observation?.tokens?.total).toBe(44_025_000);
        expect(observation?.cost).toMatchObject({
            reportedUsd: 100,
            estimatedUsd: 0,
            costSource: 'provider_reported',
        });
        expect(observation?.contextSnapshot).toEqual({
            v: 1,
            modelId: 'claude-opus-4-7',
            usedTokens: 938_843,
            windowTokens: 1_000_000,
            totalProcessedTokens: 44_025_000,
            baselineTokens: null,
            isAutoCompactEnabled: null,
            categories: null,
            observedAtMs: 1_752_089_600_000,
            source: 'provider_turn',
        });
    });

    it('keeps provider-turn context when the active model window is unavailable', () => {
        const observation = buildClaudeSdkResultUsageObservation({
            modelId: 'claude-sonnet-4-6',
            observedAtMs: 1_752_089_600_000,
            result: {
                type: 'result',
                subtype: 'success',
                usage: {
                    input_tokens: 100,
                    output_tokens: 20,
                    iterations: [{
                        type: 'message',
                        input_tokens: 40,
                        output_tokens: 5,
                        cache_creation_input_tokens: 3,
                        cache_read_input_tokens: 2,
                    }],
                },
                modelUsage: {},
            },
        });

        expect(observation?.contextSnapshot).toEqual(expect.objectContaining({
            usedTokens: 50,
            windowTokens: null,
            totalProcessedTokens: 120,
        }));
    });

    it('uses estimated cost when the provider omits total_cost_usd', () => {
        const result = {
            type: 'result',
            subtype: 'success',
            result: 'done',
            num_turns: 1,
            usage: {
                input_tokens: 1_000_000,
                output_tokens: 100_000,
            },
            modelUsage: {
                'claude-sonnet-4-6': { contextWindow: 1_000_000 },
            },
            total_cost_usd: 0,
            duration_ms: 1,
            duration_api_ms: 1,
            is_error: false,
            session_id: 'ses_1',
        } as const;
        Reflect.deleteProperty(result, 'total_cost_usd');

        const observation = buildClaudeSdkResultUsageObservation({
            modelId: 'claude-sonnet-4-6',
            result,
        });

        expect(observation?.cost).toMatchObject({
            estimatedUsd: expect.any(Number),
            reportedUsd: 0,
            costSource: 'pricing_estimate',
        });
        expect(observation?.cost?.estimatedUsd).toBeGreaterThan(0);
        expect(observation?.cost?.reportedUsd).toBe(0);
    });

    it('keeps Provider-bound cost unavailable when the upstream omits it', () => {
        const observation = buildClaudeSdkResultUsageObservation({
            modelId: 'deepseek-ai/DeepSeek-V3.1',
            modelSource: 'provider',
            result: {
                type: 'result',
                subtype: 'success',
                usage: {
                    input_tokens: 1_000_000,
                    output_tokens: 100_000,
                },
                modelUsage: {},
            },
        });

        expect(observation).toMatchObject({
            modelId: 'deepseek-ai/DeepSeek-V3.1',
            cost: null,
        });
    });

    it('keeps gateway-routed Claude cost unavailable without billing provenance', () => {
        const observation = buildClaudeSdkResultUsageObservation({
            modelId: 'claude-sonnet-4-6',
            modelSource: 'provider',
            result: {
                type: 'result',
                subtype: 'success',
                usage: {
                    input_tokens: 10,
                    output_tokens: 5,
                },
                modelUsage: {},
                total_cost_usd: 0.25,
            },
        });

        expect(observation?.cost).toBeNull();
    });

    it('drops a result with no tokens, cost, or context usage', () => {
        expect(buildClaudeSdkResultUsageObservation({
            modelId: 'claude-sonnet-4-6',
            result: {
                type: 'result',
                subtype: 'success',
                result: 'done',
                num_turns: 1,
                usage: {
                    input_tokens: 0,
                    output_tokens: 0,
                },
                modelUsage: {},
                total_cost_usd: 0,
                duration_ms: 1,
                duration_api_ms: 1,
                is_error: false,
                session_id: 'ses_zero',
            },
        })).toBeNull();
    });
});
