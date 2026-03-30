import { describe, expect, it } from 'vitest';

import { withRetry } from './withRetry';

describe('withRetry', () => {
  it('wraps non-Error thrown values with useful details', async () => {
    const thrown = { code: 'E_FAIL', detail: { nested: 'boom' } };

    const outcome = await withRetry(
      async () => {
        throw thrown;
      },
      {
        operationName: 'test',
        maxAttempts: 1,
        baseDelayMs: 1,
        maxDelayMs: 1,
      },
    )
      .then(() => ({ ok: true as const }))
      .catch((error: unknown) => ({ ok: false as const, error }));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('expected failure');

    expect(outcome.error).toBeInstanceOf(Error);
    const message = (outcome.error as Error).message;
    expect(message).not.toBe('[object Object]');
    expect(message).toContain('E_FAIL');
    expect(message).toContain('nested');
    expect(message).toContain('boom');
  });

  it('preserves Error instances as-is', async () => {
    const err = new Error('boom');
    await expect(
      withRetry(
        async () => {
          throw err;
        },
        { operationName: 'test', maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
      ),
    ).rejects.toBe(err);
  });
});

