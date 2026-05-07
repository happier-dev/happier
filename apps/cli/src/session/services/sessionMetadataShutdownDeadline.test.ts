import { describe, expect, it } from 'vitest';

import { createSessionMetadataShutdownDeadline } from './sessionMetadataShutdownDeadline';

describe('createSessionMetadataShutdownDeadline', () => {
  it('returns the same bounded budget across sequential shutdown metadata phases', () => {
    let now = 1_000;
    const deadline = createSessionMetadataShutdownDeadline({
      budgetMs: 3_000,
      nowMs: () => now,
    });

    expect(deadline.remainingMs()).toBe(3_000);

    now += 2_750;
    expect(deadline.remainingMs()).toBe(250);

    now += 500;
    expect(deadline.remainingMs()).toBe(1);
  });
});
