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
                cache_read: 3,
                cache_creation: 4,
            },
            cost: {
                reportedUsd: 0.123,
                total: 0.123,
            },
            contextUsedTokens: null,
            contextWindowTokens: 1_000_000,
        });
    });

    it('uses active context usage instead of cumulative result token totals', () => {
        const observation = buildClaudeSdkResultUsageObservation({
            modelId: 'claude-opus-4-7',
            contextUsedTokens: 938_843,
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
                },
                modelUsage: {
                    'claude-opus-4-7': {
                        contextWindow: 1_000_000,
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
    });
});
