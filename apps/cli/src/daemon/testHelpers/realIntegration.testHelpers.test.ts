import { describe, expect, it } from 'vitest';

import { waitForPidInspection } from './realIntegration.testHelpers';

describe('waitForPidInspection', () => {
  it('accepts falsy non-null inspection values', async () => {
    const inspected = await waitForPidInspection(
      async () => 0,
      12345,
      { timeoutMs: 25, intervalMs: 1 },
    );
    expect(inspected).toBe(0);
  });
});
