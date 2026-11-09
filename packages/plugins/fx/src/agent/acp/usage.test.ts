import { describe, expect, it } from 'vitest';

import { FX_PROMPT_USAGE } from './usage.js';

describe('FX prompt usage', () => {
  it('keeps cache and reasoning details within the provider input/output totals', () => {
    // fx 0.0.14 wire keys captured 2026-10-27 in E-fx-live-probe.md §3.
    // Nonzero vector: fx 1a070af, src/gateway/responses_protocol.zig:2681.
    const usage = {
      inputTokens: 17,
      outputTokens: 7,
      cacheReadTokens: 5,
      cacheWriteTokens: 2,
      reasoningTokens: 3,
    };

    expect(FX_PROMPT_USAGE.projectPromptUsage({ usage, promptResponse: {} })).toEqual({
      ...usage,
      totalTokens: 24,
    });
  });

  it('preserves missing totals rather than fabricating zero for absent input and output', () => {
    expect(FX_PROMPT_USAGE.projectPromptUsage({
      usage: { cacheWriteTokens: 2, reasoningTokens: 3 },
      promptResponse: {},
    })).toEqual({ cacheWriteTokens: 2, reasoningTokens: 3 });
  });
});
