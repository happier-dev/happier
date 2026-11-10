import { describe, expect, it } from 'vitest';

import { buildClaudeAssistantUsageObservation } from './buildAssistantObservation.js';

describe('buildClaudeAssistantUsageObservation', () => {
    it('keeps explicit zero but does not turn omitted counters or billing into zero', () => {
        const partial = buildClaudeAssistantUsageObservation({ modelId: 'claude-sonnet-4-6', usage: { input_tokens: 0 } });
        expect(partial?.tokens).toEqual({ input: 0, output: null, reasoning: null, cacheRead: null, cacheWrite: null, total: null });
        const measured = buildClaudeAssistantUsageObservation({ modelId: 'claude-sonnet-4-6', usage: {
            input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
        } });
        expect(measured?.tokens).toEqual({ input: 0, output: 0, reasoning: null, cacheRead: 0, cacheWrite: 0, total: 0 });
        expect(measured?.cost).toBeNull();
    });
    it.each([
        { cache_creation: { ephemeral_1h_input_tokens: 20, ephemeral_5m_input_tokens: 10 }, ttlMs: 3_600_000 },
        { cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 30 }, ttlMs: undefined },
        { cache_creation: undefined, ttlMs: undefined },
    ])('uses only the live request clock and detected long-write class ($ttlMs)', ({ cache_creation, ttlMs }) => {
        const observation = buildClaudeAssistantUsageObservation({
            requestStartedAtMs: 100, observedAtMs: 900,
            usage: { input_tokens: 5, cache_creation_input_tokens: 30, cache_creation },
        });
        expect(observation?.promptCache).toEqual({ lastUseAtMs: 100, ...(ttlMs === undefined ? {} : { ttlMs }) });
        expect(observation?.tokens.cacheWrite).toBe(30);
    });

    it('never turns receipt time or a long-write total without a request clock into cache evidence', () => {
        const observation = buildClaudeAssistantUsageObservation({ observedAtMs: 900,
            usage: { input_tokens: 5, cache_creation: { ephemeral_1h_input_tokens: 30 } } });
        expect(observation?.promptCache).toBeUndefined();
    });

    it('carries the native record identity for replayable assistant usage', () => {
        expect(buildClaudeAssistantUsageObservation({
            nativeSessionId: 'native-session-exact',
            nativeRecordId: 'assistant-record-1', inferenceId: 'request-message-1', observedAtMs: 100, usage: { input_tokens: 10 },
        })).toMatchObject({ nativeSessionId: 'native-session-exact', nativeRecordId: 'assistant-record-1', inferenceId: 'request-message-1', observedAtMs: 100 });
    });

    it('preserves complete additive counters without inventing a reasoning split for pricing', () => {
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
                reasoning: null,
                cacheWrite: 4,
                cacheRead: 3,
            },
            cost: null,
            contextUsedTokens: null,
            contextWindowTokens: null,
        });
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
                total: null,
                input: 1_000_000,
                output: 100_000,
                reasoning: null,
                cacheRead: null,
                cacheWrite: null,
            },
            cost: null,
        });
    });


});
