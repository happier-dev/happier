import { describe, expect, it } from 'vitest';

import { createSessionMetadataShutdownDeadline } from './sessionMetadataShutdownDeadline';

describe('createSessionMetadataShutdownDeadline', () => {
  it('shares one decreasing metadata shutdown budget across phases', () => {
    let now = 1_000;
    const deadline = createSessionMetadataShutdownDeadline({ budgetMs: 3_000, nowMs: () => now });

    expect(deadline.remainingMs()).toBe(3_000);
    now += 1_250;
    expect(deadline.remainingMs()).toBe(1_750);
    now += 2_000;
    expect(deadline.remainingMs()).toBe(1);
  });
});
