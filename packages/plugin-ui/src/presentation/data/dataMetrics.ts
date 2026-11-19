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
  /** A share bar beside a row's figures (a request step's share of the request): long enough to compare down the rows. */
  shareBarWidthPx: 112,
  intervalRowValueWidthPx: 64,
  /** Opacity of the text colour for resting bars, a proportion's track and its fill. */
  barRestOpacity: 0.16,
  trackOpacity: 0.08,
  /** A context band behind a whole bucket (weekends): half a track, so it groups days without reading as data. */
  bucketShadeOpacity: 0.04,
  proportionOpacity: 0.45,
  /** A legend's swatch beside each series name, and its corner (a chart legend, the hosted HTML kit's legend). */
  legendSwatchPx: 8,
  legendSwatchRadiusPx: 2,
});
