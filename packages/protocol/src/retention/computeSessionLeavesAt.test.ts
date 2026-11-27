import { describe, expect, it } from 'vitest';

import { computeSessionLeavesAt } from '../index.js';

describe('computeSessionLeavesAt', () => {
  it('uses the inactivity date unless the rollout or grace floor is later', () => {
    const dayMs = 86_400_000;
    expect(computeSessionLeavesAt(dayMs, { retentionDays: 5, floorAt: 3 * dayMs })).toBe(6 * dayMs);
    expect(computeSessionLeavesAt(dayMs, { retentionDays: 5, floorAt: 8 * dayMs })).toBe(8 * dayMs);
  });
});
