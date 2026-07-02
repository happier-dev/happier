import { describe, expect, it } from 'vitest';

import { buildCodexAppServerTokenCountObservationInput } from './tokenCountMessage.js';

describe('buildCodexAppServerTokenCountObservationInput', () => {
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

        const cost = input?.body.cost as Readonly<Record<string, number>> | undefined;
        expect(input?.defaultScope).toBe('session_cumulative');
        expect(cost?.estimatedUsd).toBeCloseTo(32.525, 6);
        expect(cost?.total).toBeCloseTo(32.525, 6);
    });
});
