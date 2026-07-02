import { describe, expect, it } from 'vitest';

import { resolveCodexUsageLimitSuppressionWait } from './suppressionWait.js';

type ActiveSuppression = Readonly<{
  resetAtMs: number | null;
  expiresAtMs: number;
}>;

function createSuppression(entries: ReadonlyMap<string, ActiveSuppression>) {
  return {
    getActiveSuppression(input: Readonly<{
      serviceId: string;
      accountId: string;
      resetAtMs: number | null;
    }>): ActiveSuppression | null {
      return entries.get(`${input.serviceId}:${input.accountId}:${input.resetAtMs ?? 'none'}`) ?? null;
    },
  };
}

describe('resolveCodexUsageLimitSuppressionWait', () => {
  it('suppresses a sibling session on a known-exhausted account', () => {
    const decision = resolveCodexUsageLimitSuppressionWait({
      suppression: createSuppression(new Map([
        ['openai-codex:work:5000', { resetAtMs: 5_000, expiresAtMs: 6_000 }],
      ])),
      serviceId: 'openai-codex',
      accountId: 'work',
      resetAtMs: 5_000,
      nowMs: 1_000,
    });

    expect(decision).toEqual({ kind: 'wait_until_reset', nextCheckAtMs: 5_000 });
  });

  it('proceeds when account id cannot key cross-session suppression', () => {
    const decision = resolveCodexUsageLimitSuppressionWait({
      suppression: createSuppression(new Map([
        ['openai-codex:work:5000', { resetAtMs: 5_000, expiresAtMs: 6_000 }],
      ])),
      serviceId: 'openai-codex',
      accountId: null,
      resetAtMs: 5_000,
      nowMs: 1_000,
    });

    expect(decision).toEqual({ kind: 'proceed' });
  });

  it('falls back to suppression expiry when provider reset time is unavailable', () => {
    const decision = resolveCodexUsageLimitSuppressionWait({
      suppression: createSuppression(new Map([
        ['openai-codex:work:none', { resetAtMs: null, expiresAtMs: 3_000 }],
      ])),
      serviceId: 'openai-codex',
      accountId: 'work',
      resetAtMs: null,
      nowMs: 1_000,
    });

    expect(decision).toEqual({ kind: 'wait_until_reset', nextCheckAtMs: 3_000 });
  });

  it('proceeds when the account is not suppressed', () => {
    const decision = resolveCodexUsageLimitSuppressionWait({
      suppression: createSuppression(new Map()),
      serviceId: 'openai-codex',
      accountId: 'work',
      resetAtMs: 5_000,
      nowMs: 1_000,
    });

    expect(decision).toEqual({ kind: 'proceed' });
  });

  it('proceeds for a genuinely newer reset bucket', () => {
    const decision = resolveCodexUsageLimitSuppressionWait({
      suppression: createSuppression(new Map([
        ['openai-codex:work:5000', { resetAtMs: 5_000, expiresAtMs: 6_000 }],
      ])),
      serviceId: 'openai-codex',
      accountId: 'work',
      resetAtMs: 10_000,
      nowMs: 1_000,
    });

    expect(decision).toEqual({ kind: 'proceed' });
  });
});
