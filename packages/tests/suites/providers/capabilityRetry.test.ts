import { describe, expect, it } from 'vitest';

import { isRetriableCapabilityErrorMessage, withCapabilityProbeRetry } from '../../src/testkit/providers/capabilityRetry';

describe('providers: capability probe retry policy', () => {
  it('treats known transport timeout messages as retriable', () => {
    expect(isRetriableCapabilityErrorMessage('operation has timed out')).toBe(true);
    expect(isRetriableCapabilityErrorMessage('timed out connecting user socket')).toBe(true);
    expect(isRetriableCapabilityErrorMessage('RPC_METHOD_NOT_AVAILABLE')).toBe(true);
  });

  it('does not treat non-transient failures as retriable', () => {
    expect(isRetriableCapabilityErrorMessage('invalid payload shape')).toBe(false);
    expect(isRetriableCapabilityErrorMessage('unauthorized')).toBe(false);
  });

  it('retries once for transient errors and returns success value', async () => {
    let attempts = 0;
    const result = await withCapabilityProbeRetry(
      async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('operation has timed out');
        return 'ok';
      },
      { attempts: 2, delayMs: 1 },
    );

    expect(result).toBe('ok');
    expect(attempts).toBe(2);
  });

  it('throws immediately for non-retriable failures', async () => {
    let attempts = 0;
    await expect(
      withCapabilityProbeRetry(
        async () => {
          attempts += 1;
          throw new Error('invalid payload');
        },
        { attempts: 3, delayMs: 1 },
      ),
    ).rejects.toThrow('invalid payload');
    expect(attempts).toBe(1);
  });
});
