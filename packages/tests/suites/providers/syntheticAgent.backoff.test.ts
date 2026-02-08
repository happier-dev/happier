import { describe, expect, it } from 'vitest';

import { computeVersionMismatchBackoffMs } from '../../src/testkit/syntheticAgent/syntheticAgent';

describe('testkit: synthetic agent retry backoff', () => {
  it('grows with attempt number and remains bounded', () => {
    const a1 = computeVersionMismatchBackoffMs(1);
    const a2 = computeVersionMismatchBackoffMs(2);
    const a3 = computeVersionMismatchBackoffMs(3);
    const a20 = computeVersionMismatchBackoffMs(20);

    expect(a2).toBeGreaterThanOrEqual(a1);
    expect(a3).toBeGreaterThanOrEqual(a2);
    expect(a20).toBeLessThanOrEqual(781);
  });
});
