import { describe, expect, it } from 'vitest';

import { resolveSegmentedTabFit } from './segmentedTabFit';

// Six Project pages as measured on a desktop pane (labels 13pt, glyph 15pt + 7pt gap).
const withIcons = [102, 76, 104, 82, 94, 90];
const labelsOnly = [80, 54, 82, 60, 72, 68];
const base = { withIcons, labelsOnly, gap: 2, more: 60 } as const;

describe('resolveSegmentedTabFit', () => {
  it('reserves More for explicit overflow before testing glyph, count and name fit', () => {
    const explicit = {
      withIcons: [100, 100],
      labelsOnly: [80, 80],
      labelsWithoutCounts: [60, 60],
      gap: 2,
      more: 60,
      reserveMore: true,
    };
    expect(resolveSegmentedTabFit({ ...explicit, available: 264 })).toEqual({
      icons: true,
      counts: true,
      visibleCount: 2,
    });
    expect(resolveSegmentedTabFit({ ...explicit, available: 224 })).toEqual({
      icons: false,
      counts: true,
      visibleCount: 2,
    });
    expect(resolveSegmentedTabFit({ ...explicit, available: 184 })).toEqual({
      icons: false,
      counts: false,
      visibleCount: 2,
    });
    expect(resolveSegmentedTabFit({ ...explicit, available: 183 })).toEqual({
      icons: false,
      counts: false,
      visibleCount: 1,
    });
    expect(resolveSegmentedTabFit({ ...explicit, available: 40 })).toEqual({
      icons: false,
      counts: false,
      visibleCount: 0,
    });
  });

  it('keeps every tab with its glyph while the measured row holds them all', () => {
    expect(resolveSegmentedTabFit({ ...base, available: 600 })).toEqual({
      icons: true,
      counts: true,
      visibleCount: 6,
    });
  });

  it('drops the glyphs before moving any tab into More', () => {
    expect(resolveSegmentedTabFit({ ...base, available: 430 })).toEqual({
      icons: false,
      counts: true,
      visibleCount: 6,
    });
  });

  it('drops the counts after the glyphs and before moving any tab into More', () => {
    // Inbox views beside an open item: "Needs you 69 | Updates 95 | Mentions" do not fit 280,
    // the names alone do (93+75+79 = 247 + 2 gaps).
    const counted = {
      withIcons: [113, 98, 79],
      labelsOnly: [113, 98, 79],
      labelsWithoutCounts: [93, 75, 79],
      gap: 2,
      more: 60,
    } as const;
    expect(resolveSegmentedTabFit({ ...counted, available: 280 })).toEqual({
      icons: false,
      counts: false,
      visibleCount: 3,
    });
    expect(resolveSegmentedTabFit({ ...counted, available: 300 })).toEqual({
      icons: true,
      counts: true,
      visibleCount: 3,
    });
    // Narrower still, the names without counts are what moves behind More.
    expect(resolveSegmentedTabFit({ ...counted, available: 240 })).toEqual({
      icons: false,
      counts: false,
      visibleCount: 2,
    });
  });

  it('moves only the trailing tabs that no longer fit into More, keeping room for its trigger', () => {
    // 80+54+82+60 = 276 + 3 gaps = 282; + gap + More 60 = 344 fits 350; a fifth tab would not.
    expect(resolveSegmentedTabFit({ ...base, available: 350 })).toEqual({
      icons: false,
      counts: false,
      visibleCount: 4,
    });
  });

  it('never moves the selected tab into More: the leading tabs give way so it keeps a place after them', () => {
    // At 260 the names fit Overview and Code before More (80+54+2 = 136, + gap + 60 = 198). The selected
    // last tab (68) needs its own place too: 136 + 2 + 68 + 2 + 60 = 268 > 260, so Code gives way.
    expect(resolveSegmentedTabFit({ ...base, available: 260 })).toEqual({
      icons: false,
      counts: false,
      visibleCount: 2,
    });
    expect(
      resolveSegmentedTabFit({ ...base, available: 260, keep: 5 }),
    ).toEqual({ icons: false, counts: false, visibleCount: 1 });
    // A selected tab already inside the fitting row changes nothing.
    expect(
      resolveSegmentedTabFit({ ...base, available: 260, keep: 1 }),
    ).toEqual({ icons: false, counts: false, visibleCount: 2 });
    // In the narrowest pane the selected tab is what stays: every other tab moves behind More.
    expect(
      resolveSegmentedTabFit({ ...base, available: 100, keep: 3 }),
    ).toEqual({ icons: false, counts: false, visibleCount: 0 });
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
    ).toEqual({ icons: false, counts: false, visibleCount: 2 });
  });

  it('leaves the row as it is before the first measurement, so nothing moves on arrival', () => {
    expect(resolveSegmentedTabFit({ ...base, available: null })).toEqual({
      icons: true,
      counts: true,
      visibleCount: 6,
    });
  });

  it('can put every tab behind More in the narrowest pane', () => {
    expect(resolveSegmentedTabFit({ ...base, available: 100 })).toEqual({
      icons: false,
      counts: false,
      visibleCount: 0,
    });
  });
});
