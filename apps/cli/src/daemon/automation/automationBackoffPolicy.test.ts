import { describe, expect, it } from 'vitest';

import {
  classifyAutomationWorkerError,
  nextAutomationBackoffMs,
  nextAutomationRetryDelayMs,
} from './automationBackoffPolicy';

describe('nextAutomationBackoffMs', () => {
  it('grows backoff with a capped exponential curve', () => {
    expect(nextAutomationBackoffMs(0)).toBe(500);
    expect(nextAutomationBackoffMs(1)).toBe(1_000);
    expect(nextAutomationBackoffMs(2)).toBe(2_000);
    expect(nextAutomationBackoffMs(10)).toBe(60_000);
  });

  it('normalizes invalid failure counts', () => {
    expect(nextAutomationBackoffMs(-10)).toBe(500);
    expect(nextAutomationBackoffMs(Number.NaN)).toBe(500);
  });

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

  it('uses fixed delay for permanent errors and exponential delay for transient errors', () => {
    const permanentDelay = nextAutomationRetryDelayMs({
      failureCount: 3,
      error: { response: { status: 401 } },
    });
    expect(permanentDelay).toBe(300_000);

    const transientDelay = nextAutomationRetryDelayMs({
      failureCount: 3,
      error: { response: { status: 503 } },
    });
    expect(transientDelay).toBe(4_000);
  });
});
