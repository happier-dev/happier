import { describe, expect, it, vi } from 'vitest';

import { logger } from '@/ui/logger';

import { createAcpRequestFailureLogRecord, withRetry } from './withRetry';

describe('withRetry', () => {
  it.each([-32700, -32600, -32601, -32602])('does not resend an identical deterministic JSON-RPC rejection (%s)', async code => {
    const failure = Object.assign(new Error('Invalid request parameters'), { code });
    const operation = vi.fn(async () => { throw failure; });
    await expect(withRetry(operation, { operationName: 'Initialize', maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1 }))
      .rejects.toBe(failure);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('retains retries for a transient provider rate limit', async () => {
    let attempts = 0;
    const result = await withRetry(async () => {
      if (++attempts === 1) throw Object.assign(new Error('Rate limit'), { code: 429 });
      return 'ready';
    }, { operationName: 'Authenticate', maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 });
    expect(result).toBe('ready');
    expect(attempts).toBe(2);
  });

  it('retains the numeric request error code without exposing provider error data', () => {
    const secret = 'Bearer must-not-appear-in-acp-request-log';
    const error = Object.assign(new Error(secret), {
      code: -32000,
      data: { reason: 'onboarding_failed', message: secret },
    });
    const record = createAcpRequestFailureLogRecord({ operation: 'NewSession', error });

    expect(record).toEqual({ operation: 'NewSession', failureKind: 'provider_rejection', requestErrorCode: -32000 });
    expect(JSON.stringify(record)).not.toContain(secret);
    expect(JSON.stringify(record)).not.toContain('onboarding_failed');
    expect(createAcpRequestFailureLogRecord({
      operation: 'NewSession', error: Object.assign(new Error('Rejected'), { code: secret }),
    })).toEqual({ operation: 'NewSession', failureKind: 'provider_rejection' });
  });

  it('wraps non-Error thrown values with useful details', async () => {
    const thrown = { code: 'E_FAIL', detail: { nested: 'boom' } };

    const outcome = await withRetry(
      async () => {
        throw thrown;
      },
      {
        operationName: 'Initialize',
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
        { operationName: 'Initialize', maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
      ),
    ).rejects.toBe(err);
  });

  it.each([{ retryable: false }, { canTryAgain: false }])('does not retry errors explicitly classified as non-retryable (%o)', async flags => {
    const err = Object.assign(new Error('outcome unknown'), flags);
    const operation = vi.fn(async () => {
      throw err;
    });

    await expect(withRetry(operation, {
      operationName: 'Initialize',
      maxAttempts: 3,
      baseDelayMs: 1,
      maxDelayMs: 1,
    })).rejects.toBe(err);

    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('logs bounded attempt metadata without serializing the rejected value', async () => {
    const secret = 'Bearer must-not-appear-in-acp-retry-log';
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => undefined);
    let attempt = 0;

    await expect(withRetry(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error(`fetch failed: ${secret}`);
      return 'ok';
    }, {
      operationName: 'Initialize',
      maxAttempts: 2,
      baseDelayMs: 1,
      maxDelayMs: 1,
    })).resolves.toBe('ok');

    const retryLogs = debugSpy.mock.calls.filter(
      ([message]) => message === '[AcpBackend] Retrying ACP request after failure',
    );
    expect(retryLogs).toEqual([[
      '[AcpBackend] Retrying ACP request after failure',
      {
        operation: 'Initialize',
        failureKind: 'transport',
        failedAttempt: 1,
        nextAttempt: 2,
        maxAttempts: 2,
      },
    ]]);
    expect(JSON.stringify(retryLogs)).not.toContain(secret);
  });
});
