import { describe, expect, it } from 'vitest';

import {
  classifyAutomationWorkerError,
  nextAutomationRetryDelayMs,
} from './automationBackoffPolicy';

describe('Automation worker recovery disposition', () => {
  it('classifies server 5xx and timeout errors as transient', () => {
    expect(
      classifyAutomationWorkerError({
        response: { status: 503 },
      }),
    ).toBe('transient');

    expect(
      classifyAutomationWorkerError({
        code: 'ETIMEDOUT',
      }),
    ).toBe('transient');
  });

  it('classifies non-rate-limit 4xx errors as permanent', () => {
    expect(
      classifyAutomationWorkerError({
        response: { status: 400 },
      }),
    ).toBe('permanent');

    expect(
      classifyAutomationWorkerError({
        response: { status: 404 },
      }),
    ).toBe('permanent');
  });

  it('classifies a generation conflict through the shared owner instead of treating every 4xx as permanent', () => {
    expect(classifyAutomationWorkerError({ response: { status: 409 } })).toBe('transient');
    expect(nextAutomationRetryDelayMs({
      error: { response: { status: 409 } },
    })).toBeNull();
  });

  it('uses the authoritative server Retry-After', () => {
    expect(nextAutomationRetryDelayMs({
      error: { response: { status: 429, headers: { 'retry-after': '30' } } },
    })).toBe(30_000);
  });

  it('preserves a long server Retry-After', () => {
    expect(nextAutomationRetryDelayMs({
      error: { response: { status: 503, headers: { 'retry-after': '86400' } } },
    })).toBe(86_400_000);
  });

  it('does not impose a competing floor on a short server wait', () => {
    expect(nextAutomationRetryDelayMs({
      error: { response: { status: 429, headers: { 'retry-after': '1' } } },
    })).toBe(1_000);
  });

  it('retains unknown failures for the next real recovery edge', () => {
    expect(classifyAutomationWorkerError(new Error('something odd happened'))).toBe('transient');
    expect(nextAutomationRetryDelayMs({
      error: new Error('something odd happened'),
    })).toBeNull();
  });

  it('does not invent a retry deadline for permanent or transient errors', () => {
    const permanentDelay = nextAutomationRetryDelayMs({
      error: { response: { status: 401 } },
    });
    expect(permanentDelay).toBeNull();

    const transientDelay = nextAutomationRetryDelayMs({
      error: { response: { status: 503 } },
    });
    expect(transientDelay).toBeNull();
  });
});
