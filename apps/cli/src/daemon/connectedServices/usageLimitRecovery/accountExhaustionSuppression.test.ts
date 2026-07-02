import { describe, expect, it } from 'vitest';

import { AccountExhaustionSuppression } from './accountExhaustionSuppression';

describe('AccountExhaustionSuppression', () => {
  it('reports a known-exhausted account as suppressed until its reset bucket', () => {
    let nowMs = 1_000;
    const suppression = new AccountExhaustionSuppression({ nowMs: () => nowMs });

    suppression.markExhausted({
      serviceId: 'openai-codex',
      accountId: 'work',
      resetAtMs: 5_000,
    });

    expect(suppression.isSuppressed({
      serviceId: 'openai-codex',
      accountId: 'work',
      resetAtMs: 5_000,
    })).toBe(true);

    // A sibling session on the same exhausted account + reset bucket is suppressed too.
    expect(suppression.isSuppressed({
      serviceId: 'openai-codex',
      accountId: 'work',
      resetAtMs: 5_000,
    })).toBe(true);
  });

  it('does not suppress a different account', () => {
    const suppression = new AccountExhaustionSuppression({ nowMs: () => 1_000 });
    suppression.markExhausted({ serviceId: 'openai-codex', accountId: 'work', resetAtMs: 5_000 });

    expect(suppression.isSuppressed({
      serviceId: 'openai-codex',
      accountId: 'personal',
      resetAtMs: 5_000,
    })).toBe(false);
  });

  it('does not suppress a different service', () => {
    const suppression = new AccountExhaustionSuppression({ nowMs: () => 1_000 });
    suppression.markExhausted({ serviceId: 'openai-codex', accountId: 'work', resetAtMs: 5_000 });

    expect(suppression.isSuppressed({
      serviceId: 'anthropic-claude',
      accountId: 'work',
      resetAtMs: 5_000,
    })).toBe(false);
  });

  it('releases suppression once the reset bucket time has passed', () => {
    let nowMs = 1_000;
    const suppression = new AccountExhaustionSuppression({ nowMs: () => nowMs });
    suppression.markExhausted({ serviceId: 'openai-codex', accountId: 'work', resetAtMs: 5_000 });

    expect(suppression.isSuppressed({ serviceId: 'openai-codex', accountId: 'work', resetAtMs: 5_000 })).toBe(true);
    nowMs = 5_001;
    expect(suppression.isSuppressed({ serviceId: 'openai-codex', accountId: 'work', resetAtMs: 5_000 })).toBe(false);
  });

  it('treats a newer reset bucket as a distinct exhaustion window', () => {
    const suppression = new AccountExhaustionSuppression({ nowMs: () => 1_000 });
    suppression.markExhausted({ serviceId: 'openai-codex', accountId: 'work', resetAtMs: 5_000 });

    // A genuinely new exhaustion (later reset) is not suppressed by the old window.
    expect(suppression.isSuppressed({ serviceId: 'openai-codex', accountId: 'work', resetAtMs: 10_000 })).toBe(false);
  });

  it('clears an account suppression explicitly when fresh quota is proven', () => {
    const suppression = new AccountExhaustionSuppression({ nowMs: () => 1_000 });
    suppression.markExhausted({ serviceId: 'openai-codex', accountId: 'work', resetAtMs: 5_000 });
    expect(suppression.isSuppressed({ serviceId: 'openai-codex', accountId: 'work', resetAtMs: 5_000 })).toBe(true);

    suppression.clear({ serviceId: 'openai-codex', accountId: 'work' });
    expect(suppression.isSuppressed({ serviceId: 'openai-codex', accountId: 'work', resetAtMs: 5_000 })).toBe(false);
  });

  it('exposes the active suppression window so a consumer can wait until reset', () => {
    let nowMs = 1_000;
    const suppression = new AccountExhaustionSuppression({ nowMs: () => nowMs });
    suppression.markExhausted({ serviceId: 'openai-codex', accountId: 'work', resetAtMs: 5_000 });

    expect(suppression.getActiveSuppression({
      serviceId: 'openai-codex',
      accountId: 'work',
      resetAtMs: 5_000,
    })).toEqual({ resetAtMs: 5_000, expiresAtMs: 5_000 });

    // Once the window passes there is no active suppression.
    nowMs = 5_001;
    expect(suppression.getActiveSuppression({
      serviceId: 'openai-codex',
      accountId: 'work',
      resetAtMs: 5_000,
    })).toBeNull();
  });

  it('returns null active suppression for a genuinely newer reset bucket', () => {
    const suppression = new AccountExhaustionSuppression({ nowMs: () => 1_000 });
    suppression.markExhausted({ serviceId: 'openai-codex', accountId: 'work', resetAtMs: 5_000 });
    expect(suppression.getActiveSuppression({
      serviceId: 'openai-codex',
      accountId: 'work',
      resetAtMs: 10_000,
    })).toBeNull();
  });

  it('uses a bounded default window when no reset time is known', () => {
    let nowMs = 1_000;
    const suppression = new AccountExhaustionSuppression({
      nowMs: () => nowMs,
      defaultWindowMs: 2_000,
    });
    suppression.markExhausted({ serviceId: 'openai-codex', accountId: 'work', resetAtMs: null });

    expect(suppression.isSuppressed({ serviceId: 'openai-codex', accountId: 'work', resetAtMs: null })).toBe(true);
    nowMs = 3_001;
    expect(suppression.isSuppressed({ serviceId: 'openai-codex', accountId: 'work', resetAtMs: null })).toBe(false);
  });
});
