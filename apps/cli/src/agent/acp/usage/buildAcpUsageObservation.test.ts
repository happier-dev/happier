import { describe, expect, it } from 'vitest';

import { buildAcpPromptUsageObservation } from './buildAcpUsageObservation';

describe('buildAcpPromptUsageObservation', () => {
  it('reads usage from the ACP prompt metadata envelope', () => {
    expect(buildAcpPromptUsageObservation({
      provider: 'test',
      promptResponse: {
        _meta: {
          usage: { total_tokens: 10, input_tokens: 7, output_tokens: 3 },
        },
      },
    })).toMatchObject({
      source: 'acp-prompt-usage',
      scope: 'turn_delta',
      tokens: { total: 10, input: 7, output: 3 },
    });
  });

  it('uses provider projection for non-additive token classes and trusted cost', () => {
    expect(buildAcpPromptUsageObservation({
      provider: 'grok',
      promptResponse: {
        _meta: {
          usage: {
            inputTokens: 70,
            outputTokens: 30,
            cachedReadTokens: 20,
            reasoningTokens: 10,
          },
        },
      },
      projectUsage: () => ({
        tokens: {
          total: 100,
          input: 70,
          output: 30,
          cacheRead: 20,
          reasoning: 10,
        },
        cost: {
          total: 0.25,
          reportedUsd: 0.25,
          costSource: 'provider_reported',
        },
      }),
    })).toMatchObject({
      tokens: {
        total: 100,
        input: 70,
        output: 30,
        cacheRead: 20,
        reasoning: 10,
      },
      cost: { reportedUsd: 0.25, costSource: 'provider_reported' },
    });
  });
});
