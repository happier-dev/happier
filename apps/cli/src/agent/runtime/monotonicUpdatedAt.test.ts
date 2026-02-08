import { describe, expect, it } from 'vitest';

import { computeMonotonicUpdatedAt } from '@happier-dev/agents';

describe('computeMonotonicUpdatedAt', () => {
  it('returns desiredUpdatedAt when it is newer', () => {
    expect(
      computeMonotonicUpdatedAt({
        previousUpdatedAt: 10,
        desiredUpdatedAt: 11,
        previousValue: 'a',
        desiredValue: 'b',
        policy: 'ignore_older',
      }),
    ).toBe(11);
  });

  it('returns null when desiredUpdatedAt is not newer and policy is ignore_older', () => {
    expect(
      computeMonotonicUpdatedAt({
        previousUpdatedAt: 10,
        desiredUpdatedAt: 10,
        previousValue: 'a',
        desiredValue: 'b',
        policy: 'ignore_older',
      }),
    ).toBeNull();
  });

  it('bumps to previousUpdatedAt+1 when forcing an older change', () => {
    expect(
      computeMonotonicUpdatedAt({
        previousUpdatedAt: 10,
        desiredUpdatedAt: 1,
        previousValue: 'a',
        desiredValue: 'b',
        policy: 'force_update',
      }),
    ).toBe(11);
  });

  it('returns null when forcing an older change but value is the same', () => {
    expect(
      computeMonotonicUpdatedAt({
        previousUpdatedAt: 10,
        desiredUpdatedAt: 1,
        previousValue: 'a',
        desiredValue: 'a',
        policy: 'force_update',
      }),
    ).toBeNull();
  });
});

