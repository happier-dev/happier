import { describe, expect, it } from 'vitest';

import {
  TRIAGE_SPLIT_LIST_RATIO_PREFERENCE_V1,
  resolveTriageDetailPaneMinimumWidthV1,
  resolveTriageLayoutV1,
  resolveTriageListPaneMinimumWidthV1,
  type TriageScaledTypeMetricsV1,
} from './layout.js';

const TYPE_AT_100_PERCENT: TriageScaledTypeMetricsV1 = {
  title: { fontSize: 15, lineHeight: 20 },
  body: { fontSize: 13, lineHeight: 17 },
  caption: { fontSize: 12, lineHeight: 16 },
  label: { fontSize: 11, lineHeight: 14 },
};

const TYPE_AT_200_PERCENT: TriageScaledTypeMetricsV1 = {
  title: { fontSize: 30, lineHeight: 40 },
  body: { fontSize: 26, lineHeight: 34 },
  caption: { fontSize: 24, lineHeight: 32 },
  label: { fontSize: 22, lineHeight: 28 },
};

const SPACING = { xsmall: 4, small: 8, medium: 12 } as const;

function layout(overrides: Partial<Parameters<typeof resolveTriageLayoutV1>[0]> = {}) {
  return resolveTriageLayoutV1({
    availableWidth: 1280,
    type: TYPE_AT_100_PERCENT,
    spacing: SPACING,
    ...overrides,
  });
}

function paneMinima(type: TriageScaledTypeMetricsV1) {
  return {
    list: resolveTriageListPaneMinimumWidthV1({ type, spacing: SPACING }),
    detail: resolveTriageDetailPaneMinimumWidthV1({ type, spacing: SPACING }),
  };
}

describe('Triage shell layout', () => {
  it('publishes only the composition facts the shell needs, never a resizable or persisted pane width', () => {
    // A drag handle, separator role, persisted pane width or restoration path is
    // explicitly not built in V1 (`core/SURFACE.md` §2.1). A smuggled width or
    // `resizable` field is how that gets built by accident.
    expect(Object.keys(layout()).sort()).toEqual(['listRatio', 'mode']);
    expect(Object.keys(layout({ availableWidth: 320 })).sort()).toEqual(['mode']);
  });

  it('splits exactly when the measured width can honour both pane minima, not at a device breakpoint', () => {
    const minima = paneMinima(TYPE_AT_100_PERCENT);
    const exactlyEnough = minima.list + minima.detail;

    expect(layout({ availableWidth: exactlyEnough }).mode).toBe('split');
    expect(layout({ availableWidth: exactlyEnough - 1 }).mode).toBe('stacked');
  });

  it('crosses from split to stacked on text scale alone, at one unchanged measured width', () => {
    const width = paneMinima(TYPE_AT_100_PERCENT).list + paneMinima(TYPE_AT_100_PERCENT).detail + 40;

    expect(layout({ availableWidth: width }).mode).toBe('split');
    // Same container, larger accessibility text: the panes no longer fit, so the
    // shell stacks. A platform/width guess would keep splitting and clip.
    expect(layout({ availableWidth: width, type: TYPE_AT_200_PERCENT }).mode).toBe('stacked');
  });

  it('applies the one static list-ratio preference when both panes clear their minima', () => {
    const wide = layout({ availableWidth: 2000 });

    expect(wide.mode === 'split' && wide.listRatio).toBe(TRIAGE_SPLIT_LIST_RATIO_PREFERENCE_V1);
  });

  it('clamps the static preference up so the list pane never starves below its minimum', () => {
    const minima = paneMinima(TYPE_AT_100_PERCENT);
    // A width where the raw preference would put the list under its minimum.
    const width = Math.ceil(minima.list / TRIAGE_SPLIT_LIST_RATIO_PREFERENCE_V1) - 60;
    const resolved = layout({ availableWidth: width });

    expect(resolved.mode).toBe('split');
    expect(resolved.mode === 'split' && resolved.listRatio).toBeGreaterThan(
      TRIAGE_SPLIT_LIST_RATIO_PREFERENCE_V1,
    );
    expect(resolved.mode === 'split' && resolved.listRatio * width).toBeGreaterThanOrEqual(minima.list);
  });

  it('honours both pane minima at every width it accepts as split', () => {
    const minima = paneMinima(TYPE_AT_100_PERCENT);
    const threshold = minima.list + minima.detail;
    const starved: number[] = [];

    for (let width = threshold; width <= threshold + 900; width += 7) {
      const resolved = layout({ availableWidth: width });
      if (resolved.mode !== 'split') {
        starved.push(width);
        continue;
      }
      const listWidth = resolved.listRatio * width;
      if (listWidth < minima.list || width - listWidth < minima.detail) starved.push(width);
    }

    expect(starved).toEqual([]);
  });

  it('is a pure projection: repeated calls carry no retained pane state', () => {
    const first = layout({ availableWidth: 1400 });
    layout({ availableWidth: 320 });
    const second = layout({ availableWidth: 1400 });

    expect(second).toEqual(first);
    expect(Object.isFrozen(first)).toBe(true);
  });

  it('derives both pane minima from the reading measure, so they grow with accessibility text', () => {
    const small = paneMinima(TYPE_AT_100_PERCENT);
    const large = paneMinima(TYPE_AT_200_PERCENT);

    expect(large.list).toBeGreaterThan(small.list);
    expect(large.detail).toBeGreaterThan(small.detail);
    // Source-native detail carries prose; it needs the wider comfortable measure.
    expect(small.detail).toBeGreaterThan(small.list);
  });
});
