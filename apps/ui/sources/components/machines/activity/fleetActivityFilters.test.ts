import { describe, expect, it } from 'vitest';

import { fleetActivityWhenRange } from './fleetActivityFilters';

describe('Activity → When narrows the read to a half-open window chosen at selection time', () => {
  const now = new Date(2026, 10, 15, 14, 30).getTime();

  it('Any time asks for no window', () => {
    expect(fleetActivityWhenRange('any', now)).toEqual({});
  });

  it('Today starts at the local midnight; 7 and 30 days count back from now; none sets an end', () => {
    expect(fleetActivityWhenRange('today', now)).toEqual({ requestedAtFromMs: new Date(2026, 10, 15).getTime() });
    expect(fleetActivityWhenRange('7d', now)).toEqual({ requestedAtFromMs: now - 7 * 86_400_000 });
    expect(fleetActivityWhenRange('30d', now)).toEqual({ requestedAtFromMs: now - 30 * 86_400_000 });
  });
});
