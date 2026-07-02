import { describe, expect, it, vi } from 'vitest';

import {
  readCodexRuntimeRateLimitsSnapshot,
  resolveCodexRuntimeRateLimitsState,
} from './runtimeRateLimits.js';

describe('Codex runtime rate-limit reads', () => {
  it('retries account/rateLimits/read with empty-object params when null params are rejected', async () => {
    const request = vi.fn(async (_method: string, params: unknown) => {
      if (params === null) throw new Error('params must be object');
      return {
        rateLimits: {
          planType: 'pro',
          primary: { usedPercent: 25, resetsAt: 1_768_010_000 },
        },
      };
    });

    const result = await readCodexRuntimeRateLimitsSnapshot({ request });

    expect(result).toMatchObject({
      status: 'loaded',
      paramsUsed: 'empty_object',
    });
    expect(request.mock.calls).toEqual([
      ['account/rateLimits/read', null],
      ['account/rateLimits/read', {}],
    ]);
  });

  it('distinguishes not-loaded from loaded-empty and loaded-data states', () => {
    expect(resolveCodexRuntimeRateLimitsState(undefined)).toEqual({ status: 'not_loaded' });
    expect(resolveCodexRuntimeRateLimitsState({ rateLimits: {} })).toEqual({
      status: 'loaded_empty',
      rawSnapshot: { rateLimits: {} },
    });
    expect(resolveCodexRuntimeRateLimitsState({
      rateLimits: { primary: { usedPercent: 50 } },
    })).toMatchObject({
      status: 'loaded_data',
    });
  });
});
