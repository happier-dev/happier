import { useMemo } from 'react';

import { useOptionalHappierUiLocalization, useOptionalHappierUiTypography } from '../../environment/context.js';
import type { HappierUiTheme } from '../../environment/types.js';
import { resolveHappierTextStepStyle } from '../layout/pageText.js';
import type { HappierPortableStyle } from '../portableTypes.js';
import { resolveHappierTypeRoleStyle } from '../text/typeRole.js';

/** The data presentation's metrics (lab `dashboards` DP): one owner for every node. */
export const HAPPIER_DATA_METRICS = Object.freeze({
  /** The hero number of a metric. */
  metricValue: Object.freeze({ weight: 'bold' as const, fontSize: 30, lineHeight: 36, letterSpacing: -0.6 }),
  /** The one number a widget is about (a period's total), set larger and tighter. */
  heroValue: Object.freeze({ weight: 'bold' as const, fontSize: 44, lineHeight: 50, letterSpacing: -1.4 }),
  /** One of a row of labelled facts. */
  statValue: Object.freeze({ weight: 'semiBold' as const, fontSize: 22, lineHeight: 28, letterSpacing: -0.3 }),
  /** Space between a metric and a chart beneath it, and between stacked rows. */
  blockGapPx: 12,
  comparisonGapPx: 6,
  rowGapPx: 10,
  /** A proportion bar's track. */
  proportionHeightPx: 6,
  /** A table cell's vertical padding and the gap between its columns. */
  cellPaddingVerticalPx: 7,
  columnGapPx: 8,
  /** A text run's average advance, in ems, for sizing columns and axis labels before text lays out. */
  averageCharacterEm: 0.6,
  /** A chart's plot: bars sit on a hairline baseline with a 2 pt gap between them. */
  plotHeightPx: 64,
  barGapPx: 6,
  /** Per-core bars wrap at this readable width rather than squeezing an entire CPU into one row. */
  coreWidthPx: 16,
  coreGapPx: 3,
  coreHeightPx: 32,
  barRadiusPx: 3,
  /** A chart column's widest reading: a plot shared by few buckets keeps slim columns, never slabs. */
  barMaxWidthPx: 28,
  /** A zero still reads as a point in the series. */
  barStubPx: 4,
  lineStrokePx: 2,
  /** The paper seam between stacked area series. */
  areaSeamPx: 1.5,
  barSeamPx: 1,
  axisGapPx: 4,
  /** A lanes timeline: one bar per run, packed into tracks under one lane label (a machine, an agent). */
  laneBarHeightPx: 10,
  laneTrackGapPx: 4,
  laneLabelWidthPx: 112,
  /** Below this body width a lane's label sits above its tracks instead of beside them. */
  laneSideLabelMinWidthPx: 480,
  /** A rows timeline at that width: each label beside its bar (a waterfall's span column) and the value after it. */
  intervalRowLabelWidthPx: 240,
  intervalRowValueWidthPx: 64,
  /** Opacity of the text colour for resting bars, a proportion's track and its fill. */
  barRestOpacity: 0.16,
  trackOpacity: 0.08,
  /** A context band behind a whole bucket (weekends): half a track, so it groups days without reading as data. */
  bucketShadeOpacity: 0.04,
  proportionOpacity: 0.45,
});

/**
 * How a live meter moves (lab `rv`): a new value eases from where the fill is drawn (strong ease-out, so a sample
 * reads as arriving, never as lagging), and a tone change cross-fades on the shared slow step. Reduced motion jumps.
 */
export const HAPPIER_DATA_MOTION = Object.freeze({
  valueMs: 600,
  valueBezier: Object.freeze([0.23, 1, 0.32, 1] as const),
});

export type HappierDataTextStyles = Readonly<{
  metric: HappierPortableStyle;
  body: HappierPortableStyle;
  strong: HappierPortableStyle;
  caption: HappierPortableStyle;
  captionStrong: HappierPortableStyle;
  header: HappierPortableStyle;
  /** The reader's locale, for number formatting. */
  locale: string | undefined;
}>;

/** The text styles every data node shares, from the host's real type roles when it installs them. */
export function useHappierDataTextStyles(theme: HappierUiTheme): HappierDataTextStyles {
  const typography = useOptionalHappierUiTypography();
  const localization = useOptionalHappierUiLocalization();
  return useMemo(() => {
    const body = resolveHappierTypeRoleStyle('meta', theme, typography);
    const caption = resolveHappierTypeRoleStyle('micro', theme, typography);
    // A column header sits at the cell's size with the label's weight: it names the column without
    // outweighing the widget title above it or the cells below it.
    const header = resolveHappierTypeRoleStyle('meta', theme, typography, 'medium');
    const semiBold = (role: HappierPortableStyle) => ({ ...role, ...resolveHappierTextStepStyle({ weight: 'semiBold',
      fontSize: role.fontSize ?? theme.typography.body.fontSize, lineHeight: role.lineHeight ?? theme.typography.body.lineHeight }, typography) });
    return {
      metric: { ...resolveHappierTextStepStyle(HAPPIER_DATA_METRICS.metricValue, typography), color: theme.colors.text },
      body: { ...body, color: theme.colors.text },
      strong: { ...semiBold(body), color: theme.colors.text },
      caption: { ...caption, color: theme.colors.mutedText },
      captionStrong: { ...semiBold(caption), color: theme.colors.text },
      header: { ...header, color: theme.colors.secondaryText },
      locale: localization?.locale,
    };
  }, [localization?.locale, theme, typography]);
}
