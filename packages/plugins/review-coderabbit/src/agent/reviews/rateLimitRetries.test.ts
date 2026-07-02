import { describe, expect, it } from 'vitest';

import {
  parseCodeRabbitRateLimitRetryMs,
  runWithCodeRabbitRateLimitRetries,
} from './rateLimitRetries.js';

describe('CodeRabbit rate-limit retries', () => {
  it('parses provider retry text with one-second padding', () => {
    expect(parseCodeRabbitRateLimitRetryMs(
      'Rate limit exceeded, please try after 1 minutes and 2 seconds',
    )).toBe(63_000);
  });

  it('retries rate-limited attempts until a later attempt succeeds', async () => {
    const attempts: number[] = [];
    const sleeps: number[] = [];

    const result = await runWithCodeRabbitRateLimitRetries({
      maxAttempts: 3,
      runOnce: async (attempt) => {
        attempts.push(attempt);
        if (attempt === 1) {
          return {
            ok: false as const,
            stdout: '',
            stderr: 'Rate limit exceeded, please try after 0 minutes and 1 seconds',
          };
        }
        return { ok: true as const, stdout: 'ok', stderr: '' };
      },
      sleepMs: async (ms) => {
        sleeps.push(ms);
      },
    });

    expect(result.ok).toBe(true);
    expect(attempts).toEqual([1, 2]);
    expect(sleeps).toEqual([2_000]);
  });

  it('does not sleep when retry delay exceeds the configured retry budget', async () => {
    const attempts: number[] = [];
    const sleeps: number[] = [];

    const result = await runWithCodeRabbitRateLimitRetries({
      maxAttempts: 3,
      maxTotalRetrySleepMs: 60_000,
      runOnce: async (attempt) => {
        attempts.push(attempt);
        return {
          ok: false as const,
          stdout: '',
          stderr: 'Rate limit exceeded, please try after 7 minutes and 21 seconds',
        };
      },
      sleepMs: async (ms) => {
        sleeps.push(ms);
      },
    });

    expect(result.ok).toBe(false);
    expect(attempts).toEqual([1]);
    expect(sleeps).toEqual([]);
  });
});
