import { describe, expect, it } from 'vitest';

import { buildClaudeSdkResultUsageObservation } from './buildClaudeSdkResultUsageObservation';

describe('buildClaudeSdkResultUsageObservation', () => {
  it('includes the runtime context window from Claude modelUsage when present', () => {
    const observation = buildClaudeSdkResultUsageObservation({
      modelId: 'claude-sonnet-4-6',
      result: {
        type: 'result',
        subtype: 'success',
        result: 'done',
        num_turns: 1,
        usage: {
          input_tokens: 11,
          output_tokens: 22,
          cache_read_input_tokens: 3,
          cache_creation_input_tokens: 4,
        },
        modelUsage: {
          contextWindow: 1_000_000,
        },
        total_cost_usd: 0.123,
        duration_ms: 1,
        duration_api_ms: 1,
        is_error: false,
        session_id: 'ses_1',
      } as any,
    });

    expect(observation).toEqual({
      provider: 'claude',
      source: 'claude-sdk-result',
      scope: 'session_final',
      key: 'claude-session',
      modelId: 'claude-sonnet-4-6',
      tokens: {
        total: 40,
        input: 11,
        output: 22,
        cache_read: 3,
        cache_creation: 4,
      },
      cost: {
        reportedUsd: 0.123,
        total: 0.123,
      },
      contextUsedTokens: null,
      contextWindowTokens: 1_000_000,
    });
  });
});
