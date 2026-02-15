import { describe, expect, it } from 'vitest';

import { parseCodeRabbitRateLimitRetryMs, runWithCodeRabbitRateLimitRetries } from './runWithRateLimitRetries';

describe('coderabbit rate-limit retries', () => {
  it('parses retry delay from CodeRabbit rate limit message and adds padding', () => {
    const ms = parseCodeRabbitRateLimitRetryMs('Rate limit exceeded, please try after 1 minutes and 2 seconds');
    // (1*60 + 2 + 1) seconds * 1000
    expect(ms).toBe(63_000);
  });

  it('retries when failure output indicates rate limiting', async () => {
    const calls: number[] = [];
    const sleeps: number[] = [];

    const res = await runWithCodeRabbitRateLimitRetries({
      maxAttempts: 3,
      runOnce: async (attempt) => {
        calls.push(attempt);
        if (attempt === 1) {
          return { ok: false as const, stdout: '', stderr: 'Rate limit exceeded, please try after 0 minutes and 1 seconds' };
        }
        return { ok: true as const, stdout: 'ok', stderr: '' };
      },
      sleepMs: async (ms) => {
        sleeps.push(ms);
      },
    });

    expect(res.ok).toBe(true);
    expect(calls).toEqual([1, 2]);
    expect(sleeps).toEqual([2_000]); // 1s + 1s padding
  });

  it('does not retry when failure is not a rate limit', async () => {
    const calls: number[] = [];
    const sleeps: number[] = [];

    const res = await runWithCodeRabbitRateLimitRetries({
      maxAttempts: 3,
      runOnce: async (attempt) => {
        calls.push(attempt);
        return { ok: false as const, stdout: '', stderr: 'some other error' };
      },
      sleepMs: async (ms) => {
        sleeps.push(ms);
      },
    });

    expect(res.ok).toBe(false);
    expect(calls).toEqual([1]);
    expect(sleeps).toEqual([]);
  });
});

