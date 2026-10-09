import { describe, expect, it } from 'vitest';

import { resolveProjectOverviewArrangement } from './ProjectOverviewLayout';

describe('resolveProjectOverviewArrangement', () => {
  it('keeps both areas side by side while the measured page holds the main minimum beside the aside', () => {
    expect(resolveProjectOverviewArrangement(944)).toBe('columns');
    expect(resolveProjectOverviewArrangement(792)).toBe('columns');
  });

  it('stacks the aside first once the page can no longer hold both (D32 FIT), and holds before measuring', () => {
    expect(resolveProjectOverviewArrangement(791)).toBe('stacked');
    expect(resolveProjectOverviewArrangement(null)).toBe('columns');
  });
});
