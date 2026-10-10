import { describe, expect, it } from 'vitest';

import { buildCodexAppServerTokenCountObservationInput } from './tokenCountMessage.js';

describe('buildCodexAppServerTokenCountObservationInput', () => {
    it('uses the shared catalog for a model absent from the retired Codex table', () => {
        const observation = buildCodexAppServerTokenCountObservationInput({ modelId: 'gpt-4o',
            notificationParams: { tokenUsage: { total: { inputTokens: 1_000_000, outputTokens: 0 } } } });
        expect(observation?.runtimeObservation?.cost?.estimatedUsd).toBe(2.5);
    });
    it('normalizes both counter vocabularies without adding inclusive cache or reasoning twice', () => {
        const snake = buildCodexAppServerTokenCountObservationInput({
            notificationParams: { token_usage: { total: {
                input_tokens: 100, cached_input_tokens: 40,
                output_tokens: 20, reasoning_output_tokens: 5,
            } } },
        });
        const camel = buildCodexAppServerTokenCountObservationInput({
            notificationParams: { tokenUsage: { totalTokenUsage: {
                inputTokens: 100, cachedInputTokens: 40,
                outputTokens: 20, reasoningOutputTokens: 5,
            } } },
        });
        const expected = { input: 100, output: 20, cacheRead: 40, cacheWrite: 0, reasoning: 5, total: 120 };
        expect(snake?.runtimeObservation?.tokens).toEqual(expected);
        expect(camel?.runtimeObservation?.tokens).toEqual(expected);
        expect(snake?.runtimeObservation?.accounting).toEqual({ inputIncludesCache: true, outputIncludesReasoning: true });
        expect(snake?.body.tokens).toEqual(expected);
        expect(camel?.body.tokens).toEqual(expected);
    });

    it('keeps witnessed zero counters as an observation and preserves explicit vendor totals', () => {
        const zero = buildCodexAppServerTokenCountObservationInput({
            notificationParams: { tokenUsage: { total: { inputTokens: 0, outputTokens: 0 } } },
        });
        expect(zero?.runtimeObservation?.tokens?.total).toBe(0);
        const explicit = buildCodexAppServerTokenCountObservationInput({
            notificationParams: { tokenUsage: { total: { inputTokens: 100, outputTokens: 20, totalTokens: 121 } } },
        });
        expect(explicit?.runtimeObservation?.tokens?.total).toBe(121);
    });

    it('retains the installed 0.160.0 producer cache-write counter without adding it to input again', () => {
        // Official rust-v0.160.0 (a956835d020762cb2b570053af06f643a11c0ecc),
        // codex-rs/codex-api/src/sse/responses.rs parses_cache_write_token_usage.
        const input = buildCodexAppServerTokenCountObservationInput({
            notificationParams: { tokenUsage: { total: {
                input_tokens: 100, cached_input_tokens: 40, cache_write_input_tokens: 60,
                output_tokens: 10, reasoning_output_tokens: 5, total_tokens: 110,
            } } },
        });
        expect(input?.runtimeObservation?.tokens).toEqual({
            input: 100, output: 10, reasoning: 5, cacheRead: 40, cacheWrite: 60, total: 110,
        });
        // The same tag's ThreadTokenUsageUpdatedNotification.json preserves
        // this counter as cacheWriteInputTokens on the live app-server wire.
        const live = buildCodexAppServerTokenCountObservationInput({
            notificationParams: { tokenUsage: { total: {
                inputTokens: 100, cachedInputTokens: 40, cacheWriteInputTokens: 60,
                outputTokens: 10, reasoningOutputTokens: 5, totalTokens: 110,
            } } },
        });
        expect(live?.runtimeObservation?.tokens).toEqual(input?.runtimeObservation?.tokens);
    });

    it('prices cached input as a subset of the captured app-server input total', () => {
        const input = buildCodexAppServerTokenCountObservationInput({
            notificationParams: {
                tokenUsage: {
                    total: {
                        totalTokens: 20_019,
                        inputTokens: 20_001,
                        cachedInputTokens: 4_480,
                        outputTokens: 18,
                        reasoningOutputTokens: 10,
                    },
                },
            },
            modelId: 'gpt-5.4',
        });

        const cost = input?.runtimeObservation?.cost;
        expect(cost?.estimatedUsd).toBeCloseTo(0.0401925, 8);
        expect(cost?.reportedUsd).toBe(0);
        expect(cost?.costSource).toBe('pricing_estimate');
    });

    it('preserves raw counters but leaves an impossible cached-input population unpriced', () => {
        const input = buildCodexAppServerTokenCountObservationInput({
            notificationParams: {
                tokenUsage: {
                    total: {
                        totalTokens: 110,
                        inputTokens: 100,
                        cachedInputTokens: 150,
                        outputTokens: 10,
                    },
                },
            },
            modelId: 'gpt-5.4',
        });

        expect(input?.body.cost).toBeUndefined();
        expect(input?.runtimeObservation?.tokens).toMatchObject({ input: 100, cacheRead: 150 });
    });

    it('attaches estimated Codex pricing to normalized token-count observation input', () => {
        const input = buildCodexAppServerTokenCountObservationInput({
            notificationParams: {
                tokenUsage: {
                    total: {
                        total_tokens: 3_350_000,
                        input_tokens: 1_000_000,
                        cached_input_tokens: 100_000,
                        output_tokens: 2_000_000,
                        reasoning_output_tokens: 250_000,
                    },
                    model_context_window: 258_400,
                },
            },
            modelId: 'gpt-5.4',
        });

        const cost = input?.body.cost as Readonly<Record<string, unknown>> | undefined;
        expect(input?.defaultScope).toBe('session_cumulative');
        expect(cost?.estimatedUsd).toBeCloseTo(32.275, 6);
        expect(cost?.total).toBeCloseTo(32.275, 6);
        expect(cost?.breakdown).toEqual({ cacheSavingsUsd: 0.225 });
    });
});
