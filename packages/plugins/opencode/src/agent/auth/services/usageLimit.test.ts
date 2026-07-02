import { describe, expect, it, vi } from 'vitest';

import { classifyOpenCodeUsageLimitError } from './usageLimit.js';

describe('classifyOpenCodeUsageLimitError', () => {
  it('classifies OpenCode free-tier quota failures with injected retry timing', () => {
    const parseResetAt = vi.fn(() => ({ retryAfterMs: 2500, resetAtMs: 123_456 }));

    const classification = classifyOpenCodeUsageLimitError({
      providerErrorPath: true,
      now: 1000,
      parseResetAt,
      error: {
        name: 'FreeUsageLimitError',
        headers: { 'retry-after-ms': '2500' },
      },
    });

    expect(classification).toEqual({
      kind: 'usage_limit',
      limitCategory: 'usage_limit',
      retryAfterMs: 2500,
      resetAtMs: 123_456,
      quotaScope: 'account',
      providerLimitId: 'free_tier_limit',
      action: null,
    });
    expect(parseResetAt).toHaveBeenCalledWith({
      headers: { 'retry-after-ms': '2500' },
      body: {
        name: 'FreeUsageLimitError',
        headers: { 'retry-after-ms': '2500' },
      },
      nowMs: 1000,
    });
  });

  it('preserves OpenCode Go workspace metadata and action links', () => {
    const classification = classifyOpenCodeUsageLimitError({
      providerErrorPath: true,
      parseResetAt: () => ({ retryAfterMs: 5000, resetAtMs: null }),
      error: {
        name: 'GoUsageLimitError',
        metadata: { workspace: 'acme', limitName: 'daily_tokens' },
        action: { url: 'https://opencode.ai/go' },
      },
    });

    expect(classification).toEqual({
      kind: 'rate_limit',
      limitCategory: 'rate_limit',
      retryAfterMs: 5000,
      resetAtMs: null,
      quotaScope: 'workspace',
      providerLimitId: 'daily_tokens',
      action: { kind: 'open_url', url: 'https://opencode.ai/go' },
    });
  });

  it('ignores non-provider-path and capacity failures', () => {
    expect(classifyOpenCodeUsageLimitError({
      providerErrorPath: false,
      parseResetAt: () => ({ retryAfterMs: null, resetAtMs: null }),
      error: { name: 'FreeUsageLimitError' },
    })).toBeNull();

    expect(classifyOpenCodeUsageLimitError({
      providerErrorPath: true,
      parseResetAt: () => ({ retryAfterMs: null, resetAtMs: null }),
      error: { name: 'ServerCapacityError' },
    })).toBeNull();
  });
});
