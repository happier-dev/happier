import { describe, expect, it } from 'vitest';

import { buildCodexAppServerTokenCountSessionMessage } from './buildCodexAppServerTokenCountSessionMessage';

describe('buildCodexAppServerTokenCountSessionMessage', () => {
    it('attaches an estimated cost derived from Codex token pricing', () => {
        const message = buildCodexAppServerTokenCountSessionMessage({
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

        expect(message?.cost?.estimatedUsd).toBeCloseTo(32.525, 6);
        expect(message?.cost?.total).toBeCloseTo(32.525, 6);
    });
});
