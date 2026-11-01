import { describe, expect, it } from 'vitest';
import { resolvePromptCacheLastUseAtMs } from './promptCacheClock.js';

describe('conservative prompt cache request clock', () => {
  it('uses the last completed non-model item before the final model request', () => {
    const turnStartedAtMs = 100;
    const completions = [120, 180, 240];
    expect(completions.map(lastNonModelItemCompletedAtMs => resolvePromptCacheLastUseAtMs({
      turnStartedAtMs, lastNonModelItemCompletedAtMs,
    }))).toEqual(completions);
    const laterUsageReceiptAtMs = 999;
    expect(resolvePromptCacheLastUseAtMs({ turnStartedAtMs, lastNonModelItemCompletedAtMs: 240 }))
      .toBeLessThan(laterUsageReceiptAtMs);
  });
  it('uses turn start without completed items and reports genuinely missing clocks', () => {
    expect(resolvePromptCacheLastUseAtMs({ turnStartedAtMs: 0 })).toBe(0);
    expect(resolvePromptCacheLastUseAtMs({ lastNonModelItemCompletedAtMs: 42 })).toBe(42);
    expect(resolvePromptCacheLastUseAtMs({})).toBeUndefined();
  });
});
