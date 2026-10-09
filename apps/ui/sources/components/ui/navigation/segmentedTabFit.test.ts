import { describe, expect, it } from 'vitest';

import { resolveSegmentedTabFit } from './segmentedTabFit';

// Six Project pages as measured on a desktop pane (labels 13pt, glyph 15pt + 7pt gap).
const withIcons = [102, 76, 104, 82, 94, 90];
const labelsOnly = [80, 54, 82, 60, 72, 68];
const base = { withIcons, labelsOnly, gap: 2, more: 60 } as const;

describe('resolveSegmentedTabFit', () => {
  it('keeps every tab with its glyph while the measured row holds them all', () => {
    expect(resolveSegmentedTabFit({ ...base, available: 600 })).toEqual({
      icons: true,
      visibleCount: 6,
    });
  });

  it('drops the glyphs before moving any tab into More', () => {
    expect(resolveSegmentedTabFit({ ...base, available: 430 })).toEqual({
      icons: false,
      visibleCount: 6,
    });
  });

  it('moves only the trailing tabs that no longer fit into More, keeping room for its trigger', () => {
    // 80+54+82+60 = 276 + 3 gaps = 282; + gap + More 60 = 344 fits 350; a fifth tab would not.
    expect(resolveSegmentedTabFit({ ...base, available: 350 })).toEqual({
      icons: false,
      visibleCount: 4,
    });
  });

  it('follows the measured widths, not a tab count: longer labels overflow sooner at the same width', () => {
    const longer = labelsOnly.map((width) => width * 1.6);
    expect(
      resolveSegmentedTabFit({
        withIcons: longer.map((width) => width + 22),
        labelsOnly: longer,
        gap: 2,
        more: 60,
        available: 350,
      }),
    ).toEqual({ icons: false, visibleCount: 2 });
  });

  it('leaves the row as it is before the first measurement, so nothing moves on arrival', () => {
    expect(resolveSegmentedTabFit({ ...base, available: null })).toEqual({
      icons: true,
      visibleCount: 6,
    });
  });

  it('can put every tab behind More in the narrowest pane', () => {
    expect(resolveSegmentedTabFit({ ...base, available: 100 })).toEqual({
      icons: false,
      visibleCount: 0,
    });
  });
});
