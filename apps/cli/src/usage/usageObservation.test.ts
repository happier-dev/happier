import { describe, expect, it } from 'vitest';

import {
    extractUsageObservationFromTokenCountMessage,
} from './usageObservation';
import {
    buildLegacyUsageReportFromUsageObservation,
    buildTokenCountAgentMessageFromUsageObservation,
    buildTokenCountSessionMessageFromUsageObservation,
} from './legacy/legacyUsageTransport';

describe('usageObservation', () => {
    const contextSnapshot = {
        v: 1,
        modelId: 'gpt-5.4',
        usedTokens: 23,
        windowTokens: 258_400,
        totalProcessedTokens: 184,
        baselineTokens: 12_000,
        isAutoCompactEnabled: null,
        categories: null,
        observedAtMs: 1_752_089_600_000,
        source: 'provider_turn',
    } as const;

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
                cacheRead: 20,
                cacheWrite: 0,
                output: 35,
                reasoning: 9,
            },
            cost: null,
            contextUsedTokens: 23,
            contextWindowTokens: 258400,
        });
    });

    it('does not infer cumulative context from cumulative token totals', () => {
        const observation = extractUsageObservationFromTokenCountMessage({
            provider: 'codex',
            defaultScope: 'session_cumulative',
            body: {
                tokens: { total: 184 },
                context_window_tokens: 258400,
            },
        });

        expect(observation?.contextUsedTokens).toBeNull();
        expect(observation?.contextWindowTokens).toBe(258400);
    });

    it('retains token-total context inference for turn deltas', () => {
        const observation = extractUsageObservationFromTokenCountMessage({
            provider: 'codex',
            defaultScope: 'turn_delta',
            body: {
                tokens: { total: 23 },
                context_window_tokens: 258400,
            },
        });

        expect(observation?.contextUsedTokens).toBe(23);
    });

    it('normalizes raw provider token aliases into canonical protocol keys only', () => {
        const observation = extractUsageObservationFromTokenCountMessage({
            provider: 'acp-provider',
            body: {
                tokens: {
                    input_tokens: 10,
                    outputTokens: 4,
                    thought: 3,
                    cache_read: 2,
                    cache_creation: 1,
                },
            },
        });

        expect(observation?.tokens).toEqual({
            input: 10,
            output: 4,
            reasoning: 3,
            cacheRead: 2,
            cacheWrite: 1,
            total: 20,
        });
        expect(observation?.tokens).not.toHaveProperty('thought');
        expect(observation?.tokens).not.toHaveProperty('cache_read');
        expect(observation?.tokens).not.toHaveProperty('cache_creation');
    });

    it('extracts a strict context snapshot from token_count payloads', () => {
        const observation = extractUsageObservationFromTokenCountMessage({
            provider: 'codex',
            body: {
                tokens: { total: 184 },
                contextSnapshot,
            },
        });

        expect(observation?.contextSnapshot).toEqual(contextSnapshot);
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
            contextSnapshot,
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
            contextSnapshot,
        });
    });

    it('carries a context snapshot into token-count agent messages', () => {
        const message = buildTokenCountAgentMessageFromUsageObservation({
            provider: 'codex',
            source: 'codex-app-server-token-usage',
            scope: 'session_cumulative',
            key: 'codex-session',
            modelId: 'gpt-5.4',
            tokens: { total: 184 },
            cost: null,
            contextUsedTokens: 23,
            contextWindowTokens: 258_400,
            contextSnapshot,
        });

        expect(message?.contextSnapshot).toEqual(contextSnapshot);
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
