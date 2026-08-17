import { describe, expect, it } from 'vitest';

import {
  resolveTriageRowGeometryV1,
  type TriageScaledTypeMetricsV1,
} from './geometry.js';

/**
 * Host-projected theme metrics AFTER the canonical text-scale owner has applied
 * the surface's `textScale`. Geometry never rescales them: `Text` owns that rule.
 */
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

function geometry(overrides: Partial<Parameters<typeof resolveTriageRowGeometryV1>[0]> = {}) {
  return resolveTriageRowGeometryV1({
    type: TYPE_AT_100_PERCENT,
    spacing: SPACING,
    density: 'compact',
    minimumInteractiveTargetSize: 44,
    ...overrides,
  });
}

describe('Triage row geometry', () => {
  it('publishes only exact integer geometry the section virtualizer can lay out without measuring', () => {
    const resolved = geometry();

    // A fractional height accumulates subpixel drift across a 2,000-row
    // `getItemLayout`, so sticky headers and focus reveal land off target.
    expect(Object.keys(resolved).sort()).toEqual([
      'rowHeight',
      'sectionHeaderHeight',
      'separatorHeight',
      'titleLineCeiling',
    ]);
    for (const value of [resolved.rowHeight, resolved.sectionHeaderHeight, resolved.separatorHeight]) {
      expect(Number.isInteger(value)).toBe(true);
    }
  });

  it('reserves the density bucket\'s whole title-line ceiling so every row in one pass shares a height', () => {
    const compact = geometry({ density: 'compact' });
    const regular = geometry({ density: 'regular' });

    expect(compact.titleLineCeiling).toBe(1);
    expect(regular.titleLineCeiling).toBe(2);
    // The regular bucket differs by an entire reserved title line plus its own
    // padding step — not merely by a padding tweak, which would clip the second
    // title line the design allows.
    expect(regular.rowHeight - compact.rowHeight).toBeGreaterThanOrEqual(
      TYPE_AT_100_PERCENT.title.lineHeight,
    );
  });

  it('grows with the already-scaled type metrics instead of holding a fixed pixel height', () => {
    const atLargestText = geometry({ type: TYPE_AT_200_PERCENT });

    expect(atLargestText.rowHeight).toBeGreaterThan(geometry().rowHeight);
    // Clipping at 200% text is the failure this replaces: the reserved content
    // must still fit inside each published height. Section headers carry one
    // label line, so at realistic scales they stay on the interactive floor —
    // but they must never publish a height their own label overflows.
    expect(atLargestText.rowHeight).toBeGreaterThanOrEqual(
      TYPE_AT_200_PERCENT.title.lineHeight + TYPE_AT_200_PERCENT.caption.lineHeight,
    );
    expect(atLargestText.sectionHeaderHeight).toBeGreaterThanOrEqual(
      TYPE_AT_200_PERCENT.label.lineHeight,
    );
    expect(
      geometry({ type: TYPE_AT_200_PERCENT, minimumInteractiveTargetSize: 0 }).sectionHeaderHeight,
    ).toBeGreaterThan(
      geometry({ minimumInteractiveTargetSize: 0 }).sectionHeaderHeight,
    );
  });

  it('never publishes a row or collapsible section header below the host interactive target floor', () => {
    const tiny: TriageScaledTypeMetricsV1 = {
      title: { fontSize: 6, lineHeight: 7 },
      body: { fontSize: 6, lineHeight: 7 },
      caption: { fontSize: 5, lineHeight: 6 },
      label: { fontSize: 5, lineHeight: 6 },
    };
    const androidFloor = geometry({ type: tiny, minimumInteractiveTargetSize: 48 });

    // Rows are pressable and section headers collapse, so both are interactive
    // targets and the platform floor is a real contract, not a style choice.
    expect(androidFloor.rowHeight).toBeGreaterThanOrEqual(48);
    expect(androidFloor.sectionHeaderHeight).toBeGreaterThanOrEqual(48);
    expect(geometry({ type: tiny, minimumInteractiveTargetSize: 44 }).rowHeight).toBe(44);
  });

  it('keeps the section header on its own label metric rather than reusing the row height', () => {
    const resolved = geometry({ minimumInteractiveTargetSize: 0 });

    expect(resolved.sectionHeaderHeight).toBeLessThan(resolved.rowHeight);
  });

  it('adds no separator geometry, because the public row owner draws its divider inside the row', () => {
    // A separate separator band would double-count height in `getItemLayout`
    // while `List.Item` already reserves its own divider.
    expect(geometry().separatorHeight).toBe(0);
  });

  it('is a pure projection: equal input produces deeply equal, frozen output', () => {
    const first = geometry();
    const second = geometry();

    expect(first).toEqual(second);
    expect(Object.isFrozen(first)).toBe(true);
  });
});
