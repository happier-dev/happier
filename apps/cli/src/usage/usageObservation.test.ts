import { describe, expect, it } from 'vitest';

import {
    buildLegacyUsageReportFromUsageObservation,
    buildTokenCountSessionMessageFromUsageObservation,
    extractUsageObservationFromTokenCountMessage,
} from './usageObservation';

describe('usageObservation', () => {
    it('extracts a canonical observation from nested Codex token_count payloads', () => {
        const observation = extractUsageObservationFromTokenCountMessage({
            provider: 'codex',
            defaultSource: 'codex-mcp-token-count',
            defaultScope: 'session_cumulative',
            body: {
                type: 'token_count',
                info: {
                    total_token_usage: {
                        total_tokens: 184,
                        input_tokens: 120,
                        cached_input_tokens: 20,
                        output_tokens: 35,
                        reasoning_output_tokens: 9,
                    },
                    last_token_usage: {
                        total_tokens: 23,
                        input_tokens: 10,
                        cached_input_tokens: 5,
                        output_tokens: 7,
                        reasoning_output_tokens: 1,
                    },
                    model_context_window: 258400,
                },
            },
        });

        expect(observation).toEqual({
            provider: 'codex',
            source: 'codex-mcp-token-count',
            scope: 'session_cumulative',
            key: null,
            modelId: null,
            tokens: {
                total: 184,
                input: 120,
                cache_read: 20,
                output: 35,
                thought: 9,
            },
            cost: null,
            contextUsedTokens: 184,
            contextWindowTokens: 258400,
        });
    });

    it('builds a token_count session message with additive scope and context fields', () => {
        const message = buildTokenCountSessionMessageFromUsageObservation({
            provider: 'claude',
            source: 'claude-sdk-result',
            scope: 'session_final',
            key: 'claude-session',
            modelId: 'claude-sonnet',
            tokens: {
                total: 40,
                input: 11,
                output: 22,
                cache_read: 3,
                cache_creation: 4,
            },
            cost: {
                total: 0.123,
                reportedUsd: 0.123,
                invoiceUsd: 0.101,
                billingContext: 'api_usage',
                costSource: 'provider_reported',
            },
            contextUsedTokens: 40,
            contextWindowTokens: 200000,
        });

        expect(message).toEqual({
            type: 'token_count',
            key: 'claude-session',
            model: 'claude-sonnet',
            tokens: {
                total: 40,
                input: 11,
                output: 22,
                cache_read: 3,
                cache_creation: 4,
            },
            cost: {
                total: 0.123,
                reportedUsd: 0.123,
                invoiceUsd: 0.101,
                billingContext: 'api_usage',
                costSource: 'provider_reported',
            },
            source: 'claude-sdk-result',
            scope: 'session_final',
            context_used_tokens: 40,
            context_window_tokens: 200000,
        });
    });

    it('builds a legacy usage report from a context-only cumulative observation', () => {
        const report = buildLegacyUsageReportFromUsageObservation({
            sessionId: 'sess-1',
            observation: {
                provider: 'opencode',
                source: 'acp-usage-update',
                scope: 'session_cumulative',
                key: null,
                modelId: 'openai/gpt-5',
                tokens: null,
                cost: {
                    total: 0.42,
                },
                contextUsedTokens: 123,
                contextWindowTokens: 1000,
            },
        });

        expect(report).toEqual({
            key: 'opencode-session',
            sessionId: 'sess-1',
            tokens: {
                total: 123,
                used: 123,
                size: 1000,
            },
            cost: {
                total: 0.42,
            },
        });
    });
});
