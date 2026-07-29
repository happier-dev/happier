import { describe, expect, it } from 'vitest';

import { buildCodexAppServerTokenCountObservationInput } from './tokenCountMessage.js';

describe('buildCodexAppServerTokenCountObservationInput', () => {
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

    it('clamps cached input to the reported input subset when the cache count is overreported', () => {
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

        const cost = input?.body.cost as Readonly<Record<string, unknown>> | undefined;
        expect(cost?.input).toBeCloseTo(0.000025, 10);
        expect(cost?.estimatedUsd).toBeCloseTo(0.000175, 10);
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
