import { describe, expect, it } from 'vitest';

import { FX_PROMPT_USAGE } from './usage.js';

describe('FX prompt usage', () => {
  it('preserves measured zero without fabricating missing counts or replacing an explicit total', () => {
    expect(FX_PROMPT_USAGE.projectPromptUsage({ usage: { inputTokens: 0 }, promptResponse: {} }))
      .toEqual({ inputTokens: 0, accounting: { inputIncludesCache: true, outputIncludesReasoning: true } });
    expect(FX_PROMPT_USAGE.projectPromptUsage({ usage: { inputTokens: 0, outputTokens: 0 }, promptResponse: {} }))
      .toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0, accounting: { inputIncludesCache: true, outputIncludesReasoning: true } });
    expect(FX_PROMPT_USAGE.projectPromptUsage({ usage: { inputTokens: 1, outputTokens: 2, totalTokens: 4 }, promptResponse: {} }))
      .toEqual({ inputTokens: 1, outputTokens: 2, totalTokens: 4, accounting: { inputIncludesCache: true, outputIncludesReasoning: true } });
  });
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
      accounting: { inputIncludesCache: true, outputIncludesReasoning: true },
    });
  });

  it('preserves missing totals rather than fabricating zero for absent input and output', () => {
    expect(FX_PROMPT_USAGE.projectPromptUsage({
      usage: { cacheWriteTokens: 2, reasoningTokens: 3 },
      promptResponse: {},
    })).toEqual({ cacheWriteTokens: 2, reasoningTokens: 3, accounting: { inputIncludesCache: true, outputIncludesReasoning: true } });
  });
});
