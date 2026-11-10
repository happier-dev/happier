import { describe, expect, it } from 'vitest';

import { GROK_PROMPT_USAGE } from './usage.js';

describe('Grok prompt usage', () => {
  it('preserves a measured reported zero when token measurements are absent', () => {
    expect(GROK_PROMPT_USAGE.projectPromptUsage({ usage: { costUsdTicks: 0 }, promptResponse: {} }))
      .toEqual({ tokens: {}, cost: { total: 0, reportedUsd: 0, costSource: 'provider_reported' } });
  });
  it('preserves measured zero without inventing an unmeasured total', () => {
    expect(GROK_PROMPT_USAGE.projectPromptUsage({ usage: { inputTokens: 0 }, promptResponse: {} }))
      .toEqual({ tokens: { input: 0 } });
    expect(GROK_PROMPT_USAGE.projectPromptUsage({ usage: { inputTokens: 0, outputTokens: 0 }, promptResponse: {} }))
      .toEqual({ tokens: { input: 0, output: 0 } });
    expect(GROK_PROMPT_USAGE.projectPromptUsage({ usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsdTicks: 0 }, promptResponse: {} }))
      .toEqual({ tokens: { input: 0, output: 0, total: 0 }, cost: { total: 0, reportedUsd: 0, costSource: 'provider_reported' } });
  });
});
