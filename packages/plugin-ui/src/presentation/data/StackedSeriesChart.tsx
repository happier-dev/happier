import { Fragment, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Animated, Easing, Platform, StyleSheet, View, type ViewStyle } from 'react-native';
import { Circle, ClipPath, Defs, Path, Pattern, Rect, Svg } from 'react-native-svg';

import type { HappierUiTheme } from '../../environment/types.js';
import { useOptionalHappierUiAccessibility, useOptionalHappierUiLocalization } from '../../environment/context.js';
import { useHappierNativeMinimumInteractiveTargetSize } from '../../environment/interactiveTarget.js';
import { HappierPressable } from '../interaction/Pressable.js';
import type { HappierHitReach } from '../../environment/interactiveTarget.js';
import { HAPPIER_MOTION_V1 } from '../interaction/motion.js';
import type { HappierFocusable, HappierLayoutChangeEvent, HappierPortableStyle } from '../portableTypes.js';
import { readHappierVisibleLayoutWidth } from '../layout/pageMetrics.js';
import { HappierText } from '../text/Text.js';
import { HAPPIER_DATA_METRICS, useHappierDataTextStyles } from './dataText.js';
import { HappierDataTable } from './DataRows.js';
import { ChartDatum, useChartInteractionAvailable, type HappierChartDatumInteraction } from './ChartDatum.js';
import { SeriesHistoryDatum } from './SeriesHistoryDatum.js';
import { buildHappierSeriesPath, describeHappierSeriesBucket, describeHappierSeriesCoordinate, formatHappierDataValue, resolveHappierSeriesGeometry, resolveHappierSeriesRampColor, resolveHappierSeriesRampStep, type HappierSeries, type HappierSeriesBucket } from './dataModel.js';

/** A line-chart fill between caller-produced bounds; it adds no values or forecast semantics. */
export type StackedSeriesBand = Readonly<{
  id: string;
  lowerSeriesId: string;
  upperSeriesId: string;
  color?: string;
  opacity?: number;
}>;

export type StackedSeriesChartProps = Readonly<{
  theme: HappierUiTheme;
  label: string;
  series: readonly HappierSeries[];
  variant: 'bar' | 'line' | 'area';
  size: 'inline' | 'tile' | 'full';
  viewportHeight?: number;
  width?: number;
  /** Share geometry only; exact values always retain the caller's original numbers. */
  normalized?: boolean;
  /** Fit a micro-line to its observed range, as the incumbent sparkline does. */
  fitLine?: boolean;
  strokeWidth?: number;
  plotInset?: number;
  scaleGutter?: number;
  scaleTicks?: readonly Readonly<{ value: number; label: string }>[];
  minimumMaximum?: number;
  /** A fixed value scale for line and area forms; it must hold every value drawn (a labelled zoom, a mirrored rate scale). */
  domain?: Readonly<{ min: number; max: number }>;
  /** Line appearance only. Missing, non-finite or inverted bounds break the fill; isolated points have no area. */
  bands?: readonly StackedSeriesBand[];
  /** Incumbent host ink consumes the already-built path, not another scale or renderer. */
  renderLinePath?: (path: string, ink: Readonly<{ width: number; height: number; color: string; strokeWidth: number; reducedMotion: boolean }>) => ReactNode;
  renderInk?: (visual: ReactNode, reducedMotion: boolean) => ReactNode;
  showAxis?: boolean;
  showLegend?: boolean;
  showGrid?: boolean;
  showScaleValues?: boolean;
  showReadout?: boolean;
  summary?: string;
  valuesLabel?: string;
  valuesCollapseLabel?: string;
  /** Controlled exact-values disclosure; omit to retain the chart's initially collapsed state. */
  valuesExpanded?: boolean;
  /** Requests the next disclosure state; controlled callers supply the updated valuesExpanded prop. */
  onValuesExpandedChange?: (expanded: boolean) => void;
  reducedMotion?: boolean;
  /** One linear step on a received sample; the host supplies cadence and visibility, never a chart timer. */
  liveMotion?: Readonly<{ sampleKey: string | number; stepPx: number; durationMs: number; active?: boolean }>;
  /** The host's existing entrance-once and spring grammar; absent means static. */
  barMotion?: Readonly<{
    /** Existing host slot morphs may opt in; semantic bucket identity is the default. */
    identity?: 'bucket' | 'slot';
    entrance?: Readonly<{ durationMs: number; delaysMs?: readonly number[] }>;
    change?: Readonly<{ stiffness: number; damping: number; mass: number }>;
  }>;
  barWidth?: number;
  /** A column never grows past this, however few buckets share the plot; it stays centred in its slot. Defaults to the data metric outside inline charts. */
  barMaxWidth?: number;
  barSlotWidth?: number;
  barLeadingInset?: number;
  barGap?: number;
  barMinHeight?: number;
  barTrackColor?: string;
  /** Which bar a single series singles out at full ink; `none` draws the series in one ink (no "now" to point at). */
  barEmphasis?: 'last' | 'maximum' | 'none';
  showPointLabels?: boolean;
  showPeakValue?: boolean;
  /** Every tick sits at a bucket: a `{ label, bucket }` tick at that bucket ("6 AM" under the 6 AM bar; on a line or area, at
   * the bucket's own x). Plain strings are spread over the buckets in order, the first on the first bucket and the last on the
   * last, so a label is never set between buckets. Absent, the first and last bucket name the plot's two ends. */
  axisTicks?: readonly (string | Readonly<{ label: string; bucket: number }>)[];
  /** One labelled reference level (a typical day): a quiet dotted rule, never a series of its own. */
  reference?: Readonly<{ value: number; label: string }>;
  /** Quiet background for caller-selected semantic bar slots (for example, weekends). */
  bucketShading?: readonly Readonly<{ bucketId: string; color?: string; opacity?: number }>[];
  /** Caller-produced comparison outlines on the observed bar scale, not observations or forecasts.
   * Missing buckets and non-finite, inverted or out-of-scale bounds have no outline. */
  barRanges?: readonly Readonly<{ bucketId: string; lower: number; upper: number; label: string }>[];
  /** Tones only the ink above this level, in the same observed scale as the series. */
  threshold?: Readonly<{ value: number; label: string; tone: 'warning' | 'error' }>;
  /** The caller supplies negative values below zero; labels retain their absolute magnitudes. */
  mirrored?: boolean;
  showAnnotations?: boolean;
  /** A series' own identity mark for the legend, keyed by series id; it follows the colour swatch. */
  leads?: Readonly<Record<string, ReactNode>>;
  /** Callers supply localized unavailable wording. */
  unknownLabel?: string;
  valueFormatter?: (value: number) => string;
  /**
   * Say each value in an accessible name as `valueFormatter` reads it (unit and display precision) instead of with every
   * meaningful digit. A host chart whose values are measurements ("74 %") opts in; the default keeps the exact value.
   */
  formattedReadings?: boolean;
  /** The caller's reading of a numeric x (a time bucket as its date) for exact values and Details. */
  coordinateFormatter?: (x: number) => string;
  onSelect?: (bucketId: string) => void;
  /** Host overlay adapter; the chart retains selection and exact values. */
  renderBucket?: (bucket: HappierSeriesBucket, visual: ReactNode, select: () => void) => ReactNode;
  /** Incumbent horizontal frame adapter, without another scrolling owner. */
  renderFrame?: (visual: ReactNode) => ReactNode;
  /**
   * Host lens over the plot's exact rectangle. It receives the chart's own bucket positions, so a
   * host crosshair never repeats the scale; exact values and keyboard selection stay with the chart.
   */
  renderPlotOverlay?: (plot: StackedSeriesPlot) => ReactNode;
  /** Choosing a legend entry (a drill into that series). Absent means the legend is a plain key. */
  onSeriesPress?: (seriesId: string) => void;
  /** Callers supply the localized name of that choice; `null` leaves that entry a plain key. */
  seriesPressLabel?: (series: HappierSeries, selected: boolean) => string | null;
  selectedSeriesIds?: readonly string[];
  testID?: string;
}>;

/** The plot rectangle and where each bucket sits on it (a column's middle, or a line's point). */
export type StackedSeriesPlot = Readonly<{
  width: number;
  height: number;
  buckets: readonly HappierSeriesBucket[];
  /** One x per bucket, in the plot's own coordinates. */
  centers: readonly number[];
}>;

function HatchPattern(props: Readonly<{ id: string; color: string }>) {
  return <Pattern id={props.id} width={6} height={6} patternUnits="userSpaceOnUse">
    <Path d="M-1 1 L1 -1 M0 6 L6 0 M5 7 L7 5" stroke={props.color} strokeWidth={1} strokeOpacity={0.65} />
  </Pattern>;
}

function HatchSwatch(props: Readonly<{ ink: string }>) {
  const id = `hatch-${useId().replace(/:/gu, '')}`;
  return <Svg width="100%" height="100%"><Defs><HatchPattern id={id} color={props.ink} /></Defs>
    <Rect width="100%" height="100%" fill={`url(#${id})`} /></Svg>;
}

/** A column narrower than a compact peak figure ("12.4M") cannot centre it without cutting it at the plot's edge. */
const PEAK_LABEL_SLOT_PX = 44;

/** A segment that already has a height follows its value changes with the host spring; it never starts from zero. */
function SeriesBar(props: Readonly<{ top: number; height: number; color: string; opacity: number; fillPattern?: 'hatch'; patternInk: string;
  motion: StackedSeriesChartProps['barMotion']; reducedMotion: boolean; testID?: string }>) {
  const change = props.reducedMotion ? undefined : props.motion?.change;
  const animatedHeight = useRef(new Animated.Value(props.height)).current;
  const mounted = useRef(false);
  useEffect(() => {
    const first = !mounted.current;
    mounted.current = true;
    if (first || !change) {
      animatedHeight.setValue(props.height);
      return;
    }
    const animation = Animated.spring(animatedHeight, { toValue: props.height, ...change, useNativeDriver: false });
    animation.start();
    return () => animation.stop();
  }, [animatedHeight, props.height, change]);
  const base = { position: 'absolute' as const, width: '100%' as const, backgroundColor: props.color, opacity: props.opacity };
  const pattern = props.fillPattern === 'hatch' ? <HatchSwatch ink={props.patternInk} /> : null;
  if (!change) return <View testID={props.testID} style={{ ...base, top: props.top, height: props.height }}>{pattern}</View>;
  return <Animated.View testID={props.testID} style={{ ...base, top: Animated.subtract(props.top + props.height, animatedHeight), height: animatedHeight }}>{pattern}</Animated.View>;
}

type WebRiseStyle = ViewStyle & {
  animationKeyframes?: ReadonlyArray<Record<string, { transform: ReadonlyArray<{ translateY: string }> }>>;
  animationDuration?: string;
  animationDelay?: string;
  animationFillMode?: string;
  animationTimingFunction?: string;
};

// react-native-web compiles keyframes only from a created style sheet, never from an inline style object.
const riseStyles = StyleSheet.create({
  fromAxis: { animationKeyframes: [{ '0%': { transform: [{ translateY: '100%' }] }, '100%': { transform: [{ translateY: '0%' }] } }] } as WebRiseStyle,
});

/**
 * A column grows as one unit: the whole stack rises from the axis inside the column's clip, so no segment
 * is ever drawn at a height of its own while its neighbours wait. On the web the browser runs the keyframes
 * (they start with the element and survive a busy JS thread); on a native host the native driver does.
 * Only a column that mounts decides to rise; a stack that already has its height never replays it.
 */
function StackRise(props: Readonly<{ rise: Readonly<{ durationMs: number; delayMs: number }> | null; height: number; testID?: string; children: ReactNode }>) {
  const rise = useRef(props.rise).current;
  const lift = useRef(new Animated.Value(rise ? props.height : 0)).current;
  useEffect(() => {
    if (!rise || Platform.OS === 'web') return;
    const animation = Animated.timing(lift, { toValue: 0, duration: rise.durationMs, delay: rise.delayMs,
      easing: Easing.bezier(...HAPPIER_MOTION_V1.standardBezier), useNativeDriver: true });
    animation.start();
    return () => animation.stop();
  }, [lift, rise]);
  const fill = { position: 'absolute' as const, left: 0, right: 0, top: 0, bottom: 0 };
  if (!rise) return <View testID={props.testID} style={fill}>{props.children}</View>;
  if (Platform.OS === 'web') {
    const timing: WebRiseStyle = { ...fill, animationDuration: `${rise.durationMs}ms`, animationDelay: `${rise.delayMs}ms`,
      animationFillMode: 'backwards', animationTimingFunction: HAPPIER_MOTION_V1.standardEasingCss };
    return <View testID={props.testID} style={[riseStyles.fromAxis, timing]}>{props.children}</View>;
  }
  return <Animated.View testID={props.testID} style={[fill, { transform: [{ translateY: lift }] }]}>{props.children}</Animated.View>;
}

type AxisTick = Readonly<{ label: string; bucket: number }>;

/** The one tick rule: every axis label belongs to a bucket, and the plot places it there. */
function resolveAxisTicks(ticks: StackedSeriesChartProps['axisTicks'], buckets: readonly HappierSeriesBucket[], pointLabels: boolean): readonly AxisTick[] {
  const last = buckets.length - 1;
  if (last < 0) return [];
  if (ticks) {
    return ticks.flatMap((tick, index): AxisTick[] => {
      if (typeof tick === 'string') return [{ label: tick, bucket: ticks.length === 1 ? 0 : Math.round(index * last / (ticks.length - 1)) }];
      return Number.isInteger(tick.bucket) && tick.bucket >= 0 && tick.bucket <= last ? [tick] : [];
    });
  }
  if (pointLabels) return buckets.map((bucket, index) => ({ label: bucket.label, bucket: index }));
  return last === 0 ? [{ label: buckets[0]!.label, bucket: 0 }] : [{ label: buckets[0]!.label, bucket: 0 }, { label: buckets[last]!.label, bucket: last }];
}

/** Reach past a tick's own column or point on each side so a centred label never wraps or clips. */
const AXIS_TICK_REACH_PX = 40;

/** Finite series renderer. All variants share bucket identity, scale, interaction and exact facts. */
/** A fragment of fewer consecutive samples than this (cut off by gaps) is drawn as a line only: an area under 2 or 3 points is a hard-edged sliver. A chart that is itself that short keeps its area. */
const MIN_AREA_RUN_SAMPLES = 4;

export function StackedSeriesChart(props: StackedSeriesChartProps) {
  const interactive = useChartInteractionAvailable();
  const defaultDatum = interactive && !props.renderBucket && !props.renderPlotOverlay;
  const patternId = `chart-hatch-${useId().replace(/:/gu, '')}`;
  const thresholdId = `chart-threshold-${useId().replace(/:/gu, '')}`;
  const text = useHappierDataTextStyles(props.theme);
  const [measuredWidth, setWidth] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [uncontrolledValuesExpanded, setUncontrolledValuesExpanded] = useState(false);
  const valuesExpanded = props.valuesExpanded ?? uncontrolledValuesExpanded;
  const accessibility = useOptionalHappierUiAccessibility();
  const localization = useOptionalHappierUiLocalization();
  const nativeTarget = useHappierNativeMinimumInteractiveTargetSize();
  const reducedMotion = accessibility?.reducedMotion === true || (props.reducedMotion ?? accessibility?.reducedMotion ?? true);
  const liveOffset = useRef(new Animated.Value(0)).current;
  const liveInk = useRef<View | null>(null);
  const priorLive = useRef({ sampleKey: props.liveMotion?.sampleKey, active: props.liveMotion?.active !== false });
  useLayoutEffect(() => {
    const motion = props.liveMotion;
    const previous = priorLive.current;
    const active = motion?.active !== false;
    priorLive.current = { sampleKey: motion?.sampleKey, active };
    if (Platform.OS !== 'web') {
      liveOffset.stopAnimation();
      liveOffset.setValue(0);
    }
    if (!motion || !active || !previous.active || reducedMotion || props.variant === 'bar'
      || previous.sampleKey === undefined || previous.sampleKey === motion.sampleKey) return;
    if (Platform.OS === 'web') {
      // RNW's View ref is the DOM element. Let the browser move the ink without
      // the JS Animated driver committing React work on every frame.
      const element = liveInk.current as (View & { animate?: Element['animate'] }) | null;
      const animation = element?.animate?.([{ transform: `translateX(${motion.stepPx}px)` }, { transform: 'translateX(0px)' }],
        { duration: motion.durationMs, easing: 'linear' });
      return () => animation?.cancel();
    }
    liveOffset.setValue(motion.stepPx);
    const animation = Animated.timing(liveOffset, { toValue: 0, duration: motion.durationMs, easing: Easing.linear, useNativeDriver: true });
    animation.start();
    return () => animation.stop();
  }, [liveOffset, props.liveMotion?.sampleKey, props.liveMotion?.active, props.liveMotion?.stepPx, props.liveMotion?.durationMs, props.variant, reducedMotion]);
  const controls = useRef(new Map<string, HappierFocusable>());
  const historyControlRef = useRef<HappierFocusable | null>(null);
  const plotHasFocus = useRef(false);
  // Marks created after the first commit are joining a chart the viewer is already reading.
  const drawn = useRef(false);
  useEffect(() => { drawn.current = true; }, []);
  const width = props.width ?? measuredWidth;
  const inline = props.size === 'inline';
  // Full charts always offer their exact table, including declarative and N=1 adapters.
  // Reuse the host-reserved Details label; callers can supply their own localized wording.
  const valuesLabel = props.valuesLabel ?? (props.size === 'full'
    ? localization?.translate('happier.plugin-ui.state.details', 'Details') ?? 'Details' : undefined);
  // Expanded, the toggle says what it now does; a caller that names the open label names the closed one too.
  const collapseLabel = props.valuesCollapseLabel ?? (props.valuesLabel === undefined
    ? localization?.translate('happier.plugin-ui.state.collapseDetails', 'Collapse') ?? 'Collapse' : valuesLabel);
  const showAxis = props.showAxis ?? !inline;
  const showLegend = props.showLegend ?? (!inline && props.series.length > 1);
  // The values toggle is quiet meta: at the legend's trailing end when there is one, else on its own line
  // at the same trailing edge. On the leading edge it sat under the first axis label and read as one more.
  const toggleInLegend = showLegend && !props.summary;
  const valuesToggle = valuesLabel ? <HappierPressable testID={props.testID ? `${props.testID}-values-toggle` : undefined}
    accessibilityLabel={valuesExpanded ? collapseLabel : valuesLabel}
    expanded={valuesExpanded} onPress={() => {
      const expanded = !valuesExpanded;
      if (props.valuesExpanded === undefined) setUncontrolledValuesExpanded(expanded);
      props.onValuesExpandedChange?.(expanded);
    }}
    style={toggleInLegend ? { marginLeft: 'auto' } : { alignSelf: 'flex-end', marginTop: HAPPIER_DATA_METRICS.blockGapPx }}>
    <HappierText style={text.captionStrong}>{valuesExpanded ? collapseLabel : valuesLabel}</HappierText>
  </HappierPressable> : null;
  const height = Math.max(1, (props.viewportHeight ?? (inline ? 16 : props.size === 'tile' ? 64 : 150)));
  const peakInset = props.showPeakValue ? 32 : 0;
  // Stacked areas part on a thin paper seam (lab kitcharts "1.6px paper gap"), never a darker outline.
  const stroke = props.strokeWidth ?? (props.variant === 'area' ? (props.series.length > 1 ? HAPPIER_DATA_METRICS.areaSeamPx : 0) : HAPPIER_DATA_METRICS.lineStrokePx);
  const inset = props.variant === 'bar' ? 0 : props.plotInset ?? stroke / 2;
  const plotWidth = Math.max(0, width - (props.scaleGutter ?? 0));
  const geometry = useMemo(() => resolveHappierSeriesGeometry(props.series, {
    width: plotWidth, height: Math.max(1, height - inset * 2), variant: props.variant,
    normalized: props.normalized, fitLine: props.fitLine, minimumMaximum: props.minimumMaximum, domain: props.domain,
  }), [props.series, plotWidth, height, inset, props.variant, props.normalized, props.fitLine, props.minimumMaximum, props.domain]);
  // A subpixel hit target cannot identify an exact sample by pointer. Keep the complete path and
  // geometry, but use one physical plot control with exact traversal. Native inline charts retain
  // their complete accessible image instead. This also avoids mounting all targets before layout.
  const nativeInline = !props.renderBucket && inline && nativeTarget !== undefined;
  const denseLine = props.variant !== 'bar' && !props.renderBucket
    && !props.showPointLabels && !props.showPeakValue && geometry.buckets.some((_, index) => geometry.hitRangeAt(index).width < 1);
  const previousDenseLine = useRef(denseLine);
  useEffect(() => {
    const changed = previousDenseLine.current !== denseLine;
    previousDenseLine.current = denseLine;
    if (!changed || !plotHasFocus.current) return;
    const target = denseLine ? historyControlRef.current : controls.current.get(selectedId ?? geometry.buckets[0]?.id ?? '');
    target?.focus();
  }, [denseLine, selectedId, geometry.buckets]);
  const unknown = props.unknownLabel ?? '—';
  const magnitude = (value: number) => props.mirrored ? Math.abs(value) : value;
  const format = (value: number) => props.valueFormatter ? props.valueFormatter(magnitude(value)) : formatHappierDataValue(magnitude(value), text.locale);
  const reading = { formatCoordinate: props.coordinateFormatter, ...(props.formattedReadings && props.valueFormatter ? { formatValue: props.valueFormatter } : {}), locale: text.locale };
  const describe = (bucket: HappierSeriesBucket) => describeHappierSeriesBucket(props.mirrored
    ? { ...bucket, values: bucket.values.map((entry) => ({ ...entry, value: entry.value === null ? null : magnitude(entry.value) })) } : bucket, unknown, reading);
  const selected = geometry.buckets.find((bucket) => bucket.id === selectedId) ?? null;
  const select = (id: string) => { setSelectedId(id); props.onSelect?.(id); };
  // A series without its own colour takes the accent's ordered ramp, spread so several read apart.
  // Unnamed series take the host's data accent (Usage's signature accent) and its ramp, the one palette data
  // marks share across Happier and plugins; the action accent is ink and read as disabled or redacted.
  const seriesAccent = props.theme.colors.dataAccent ?? props.theme.colors.accent;
  const color = (index: number) => props.series[index]?.color
    ?? resolveHappierSeriesRampColor(seriesAccent, props.theme.colors.surface, resolveHappierSeriesRampStep(index, props.series.length));
  // A live or dense history is one image (plan 20 §6.7): it names its range, its newest reading in the caller's
  // units ("As of 7:35 AM: Mean 12%", past any trailing gap) and, below, its threshold. The plot control, the bucket
  // controls and the exact-values table keep every exact point; a short chart still names each of its buckets.
  const summarised = (props.liveMotion !== undefined || (denseLine && !nativeInline)) && geometry.buckets.length > 0;
  let latest: HappierSeriesBucket | null = null;
  if (summarised) {
    let index = geometry.buckets.length - 1;
    while (index > 0 && geometry.buckets[index]!.values.every(entry => entry.value === null)) index -= 1;
    latest = geometry.buckets[index]!;
  }
  const asOf = (time: string) => (localization?.translate('happier.plugin-ui.state.asOf', 'As of {time}') ?? 'As of {time}').replace('{time}', time);
  const imageName = (bucket: HappierSeriesBucket) => {
    const first = geometry.buckets[0]!;
    const last = geometry.buckets[geometry.buckets.length - 1]!;
    // The range reads as the plot's own two ends when the caller labels them ("24 h ago – now"): a clock reading can drop
    // the date of an end that is today and then names a day-long range as a few hours. Otherwise the buckets' own readings.
    const ends = props.axisTicks ? resolveAxisTicks(props.axisTicks, geometry.buckets, false) : [];
    const named = ends.length > 1 && ends[0]!.bucket === 0 && ends[ends.length - 1]!.bucket === geometry.buckets.length - 1
      ? `${ends[0]!.label} – ${ends[ends.length - 1]!.label}` : null;
    const range = first === last ? '' : `, ${named ?? `${describeHappierSeriesCoordinate(first, reading)} – ${describeHappierSeriesCoordinate(last, reading)}`}`;
    const values = bucket.values.map(entry => `${entry.label} ${entry.value === null ? unknown : format(entry.value)}`).join(', ');
    return `${range}; ${asOf(describeHappierSeriesCoordinate(bucket, reading))}${bucket.annotation ? ` · ${bucket.annotation}` : ''}: ${values}`;
  };
  const exact = latest ? '' : geometry.buckets.map(describe).join('; ');
  const reference = props.reference && Number.isFinite(props.reference.value) ? props.reference : null;
  const shading = new Map((props.bucketShading ?? []).map(entry => [entry.bucketId, entry]));
  const barRanges = props.variant === 'bar' ? (props.barRanges ?? []).filter(range => Number.isFinite(range.lower)
    && Number.isFinite(range.upper) && range.lower < range.upper && range.lower >= geometry.min && range.upper <= geometry.max
    && geometry.buckets.some(bucket => bucket.id === range.bucketId && bucket.values.every(entry => entry.value !== null))) : [];
  const ranges = new Map(barRanges.map(range => [range.bucketId, range]));
  const threshold = props.threshold && Number.isFinite(props.threshold.value) ? props.threshold : null;
  const thresholdY = threshold ? Math.max(0, Math.min(height, inset + geometry.yAt(threshold.value))) : 0;
  const thresholdColor = threshold?.tone === 'error' ? props.theme.colors.danger : props.theme.colors.warning;
  // A stacked bucket's peak is its whole column, not its first series.
  const overlays = new Set(props.series.filter(entry => entry.overlay).map(entry => entry.id));
  const bucketTotal = (bucket: HappierSeriesBucket): number | null => bucket.values.some((entry) => !overlays.has(entry.seriesId) && entry.value !== null)
    ? bucket.values.reduce((sum, entry) => sum + (overlays.has(entry.seriesId) ? 0 : entry.value ?? 0), 0) : null;
  const peakIndex = geometry.buckets.reduce((peak, bucket, index) => (bucketTotal(bucket) ?? -Infinity) > (bucketTotal(geometry.buckets[peak]!) ?? -Infinity) ? index : peak, 0);
  const barGap = props.barGap ?? HAPPIER_DATA_METRICS.barGapPx;
  const barSlotWidth = props.barSlotWidth ?? Math.max(0, plotWidth - (props.barLeadingInset ?? 0) * 2 - barGap * Math.max(0, geometry.buckets.length - 1)) / Math.max(1, geometry.buckets.length);
  const nativeDense = !props.renderBucket && !inline && nativeTarget !== undefined && geometry.buckets.length > 0
    && (height < nativeTarget || geometry.buckets.some((_, index) => (props.variant === 'bar' ? barSlotWidth : geometry.hitRangeAt(index).width) < nativeTarget));
  const selectByKey = (index: number, key: string) => {
    const next = key === 'ArrowRight' ? Math.min(index + 1, geometry.buckets.length - 1)
      : key === 'ArrowLeft' ? Math.max(0, index - 1) : key === 'Home' ? 0 : key === 'End' ? geometry.buckets.length - 1 : null;
    if (next === null) return null;
    const id = geometry.buckets[next]!.id;
    select(id);
    return id;
  };
  // A bucket's hit area never reaches a neighbouring bucket: bar columns split their gap, stacked
  // exact-value rows stay on their own row.
  const datumOf = (bucket: HappierSeriesBucket) => ({
    label: describeHappierSeriesCoordinate(bucket, reading),
    value: bucket.values.map(entry => {
      if (entry.value === null) return `${entry.label}: ${unknown}`;
      const exact = formatHappierDataValue(magnitude(entry.value), text.locale);
      const visible = format(entry.value);
      return `${entry.label}: ${visible.includes(exact) ? visible : `${visible} (${exact})`}`;
    }).join(' · '),
    subtitle: [bucket.annotation, props.summary].filter(Boolean).join(' · ') || undefined,
    color: bucket.values[0]?.color ?? color(0),
  });
  const bucketControl = (bucket: HappierSeriesBucket, index: number, visual: ReactNode, style: HappierPortableStyle | undefined,
    hitReach: HappierHitReach, key: string | number = bucket.id, withDatum = false) => {
    const datum = defaultDatum && withDatum;
    const control = (interaction?: HappierChartDatumInteraction) => <HappierPressable
    hitReach={hitReach}
    testID={props.testID ? `${props.testID}-bucket-${bucket.id}` : undefined}
    controlRef={(control) => { if (control) controls.current.set(bucket.id, control); else controls.current.delete(bucket.id); }}
    accessibilityLabel={describe(bucket)} selected={selectedId === bucket.id}
    onPress={() => { select(bucket.id); interaction?.onPress(); }}
    onHoverChange={interaction?.onHoverChange}
    onFocusChange={(focused) => { plotHasFocus.current = focused; if (focused) setSelectedId(bucket.id); interaction?.onFocusChange(focused); }}
    onKeyDown={(key) => {
      const id = selectByKey(index, key);
      if (id === null) return false;
      controls.current.get(id)?.focus(); return true;
    }} style={datum ? { height: '100%' } : style}>{visual}</HappierPressable>;
    return datum ? <View key={key} style={style}><ChartDatum datum={datumOf(bucket)}
      testID={props.testID ? `${props.testID}-bucket-${bucket.id}-datum` : undefined} renderTrigger={control}>{visual}</ChartDatum></View>
      : <Fragment key={key}>{control()}</Fragment>;
  };
  const activeIndex = Math.max(0, geometry.buckets.findIndex(bucket => bucket.id === selectedId));
  const activeBucket = geometry.buckets[activeIndex];
  const historyCanInteract = denseLine && !nativeInline && (nativeTarget === undefined || height >= nativeTarget);
  const historyControl = historyCanInteract && activeBucket ? <SeriesHistoryDatum enabled={defaultDatum}
    buckets={geometry.buckets} selectedIndex={activeIndex} indexAt={geometry.indexAt} datumOf={datumOf} width={plotWidth} height={height}
    testID={props.testID ? `${props.testID}-history-datum` : undefined}
    renderControl={(interaction, onKeyboardUse) => <HappierPressable
    testID={props.testID ? `${props.testID}-history-control` : undefined}
    controlRef={control => { historyControlRef.current = control; }}
    accessibilityLabel={describe(activeBucket)} accessibilityPositionInSet={activeIndex + 1} accessibilitySetSize={geometry.buckets.length}
    accessibilityActions={nativeTarget === undefined ? undefined : [{ name: 'increment' }, { name: 'decrement' }]}
    onAccessibilityAction={nativeTarget === undefined ? undefined : ({ nativeEvent }) => {
      onKeyboardUse?.();
      if (nativeEvent.actionName === 'increment' || nativeEvent.actionName === 'decrement')
        selectByKey(activeIndex, nativeEvent.actionName === 'increment' ? 'ArrowRight' : 'ArrowLeft');
    }}
    onHoverChange={interaction?.onHoverChange}
    onFocusChange={focused => { plotHasFocus.current = focused; if (focused && selectedId === null) setSelectedId(activeBucket.id); interaction?.onFocusChange(focused); }}
    onPress={event => {
      const native = event?.nativeEvent;
      // RN supplies locationX; RNW's click boundary supplies a MouseEvent. Keyboard clicks (detail=0)
      // activate the already selected sample instead of jumping to the plot's origin.
      const x = native && typeof native === 'object'
        ? 'locationX' in native && typeof native.locationX === 'number' ? native.locationX
          : 'offsetX' in native && typeof native.offsetX === 'number' && 'detail' in native && typeof native.detail === 'number' && native.detail > 0
            ? native.offsetX : null
        : null;
      if (x !== null && Number.isFinite(x)) {
        const nearest = geometry.indexAt(x);
        if (nearest !== null) select(geometry.buckets[nearest]!.id);
      } else select(activeBucket.id);
      interaction?.onPress();
    }}
    onKeyDown={key => { onKeyboardUse?.(); return selectByKey(activeIndex, key) !== null; }}
    style={{ width: plotWidth, height }}><View /></HappierPressable>} /> : null;

  const bandPaths = props.variant !== 'line' || plotWidth <= 0 ? [] : (props.bands ?? []).flatMap((band) => {
    const lowerIndex = props.series.findIndex((entry) => entry.id === band.lowerSeriesId);
    const upperIndex = props.series.findIndex((entry) => entry.id === band.upperSeriesId);
    if (lowerIndex < 0 || upperIndex < 0) return [];
    const runs: number[][] = [];
    let run: number[] = [];
    geometry.buckets.forEach((bucket, index) => {
      const lower = bucket.values[lowerIndex]!.value;
      const upper = bucket.values[upperIndex]!.value;
      if (lower === null || upper === null || lower > upper) {
        if (run.length > 1) runs.push(run);
        run = [];
      } else run.push(index);
    });
    if (run.length > 1) runs.push(run);
    return runs.map((indexes, index) => {
      const upper = indexes.map((bucketIndex) => ({ x: geometry.xAt(bucketIndex), y: inset + geometry.yAt(geometry.buckets[bucketIndex]!.values[upperIndex]!.upper) }));
      const lower = [...indexes].reverse().map((bucketIndex) => ({ x: geometry.xAt(bucketIndex), y: inset + geometry.yAt(geometry.buckets[bucketIndex]!.values[lowerIndex]!.upper) }));
      const path = `${buildHappierSeriesPath(upper, 0)} ${buildHappierSeriesPath(lower, 0).replace(/^M/u, 'L')} Z`;
      return <Path key={`${band.id}:${index}`} testID={props.testID ? `${props.testID}-band-${band.id}-${index}` : undefined}
        d={path} fill={band.color ?? color(upperIndex)} fillOpacity={band.opacity ?? HAPPIER_DATA_METRICS.barRestOpacity} stroke="none" />;
    });
  });

  const thresholdPaths: ReactNode[] = [];
  const paths = props.variant === 'bar' || plotWidth <= 0 ? null : props.series.flatMap((entry, seriesIndex) => {
    // Missing points break the ribbon/stroke rather than silently becoming zero or bridging a gap.
    const runs: number[][] = [];
    let run: number[] = [];
    geometry.buckets.forEach((bucket, index) => {
      if (bucket.values[seriesIndex]!.value === null || (props.normalized && !bucket.values.some((value) => value.value !== null && value.value > 0))) { if (run.length) runs.push(run); run = []; }
      else run.push(index);
    });
    if (run.length) runs.push(run);
    // A gap is a plain break: nothing is drawn across it and nothing marks it, so the line and its wash simply stop
    // where the samples stop and resume where they resume.
    const variant = entry.overlay ? 'line' : props.variant;
    const lineStroke = entry.overlay ? HAPPIER_DATA_METRICS.lineStrokePx : stroke;
    // A point that carries its own colour inks its stretch of the line (a pressure episode in a memory
    // history); stretches share their joining point, so the line stays continuous across the change.
    const inkAt = (bucketIndex: number) => geometry.buckets[bucketIndex]!.values[seriesIndex]!.color ?? color(seriesIndex);
    const pieces = runs.flatMap((indexes) => indexes.reduce<{ indexes: number[]; ink: string; runLength: number }[]>((out, bucketIndex, position) => {
      const ink = inkAt(bucketIndex);
      const current = out[out.length - 1];
      if (current && current.ink === ink) current.indexes.push(bucketIndex);
      else out.push({ indexes: current ? [indexes[position - 1]!, bucketIndex] : [bucketIndex], ink, runLength: indexes.length });
      return out;
    }, []));
    const washed = variant === 'area' && entry.fillOpacity !== undefined;
    return pieces.map(({ indexes, ink, runLength }, index) => {
      // A run of a few samples is not a solid area to read: filled, it is a hard-edged sliver. It is the line alone, at the
      // chart's line stroke, with no fill beneath it. A wash is faint enough to sit under any run.
      if (indexes.length > 1 && variant === 'area' && !washed && entry.fillPattern !== 'hatch' && runLength < MIN_AREA_RUN_SAMPLES && runLength < geometry.buckets.length) {
        const points = indexes.map((bucketIndex) => ({ x: geometry.xAt(bucketIndex), y: inset + geometry.yAt(geometry.buckets[bucketIndex]!.values[seriesIndex]!.upper) }));
        const linePath = buildHappierSeriesPath(points, 0);
        const lineKey = `${entry.id}:${index}`;
        if (threshold && points.some((point) => point.y < thresholdY)) thresholdPaths.push(<Path key={lineKey}
          testID={props.testID ? `${props.testID}-threshold-path-${seriesIndex}-${index}` : undefined}
          d={linePath} clipPath={`url(#${thresholdId})`} fill="none" stroke={thresholdColor} strokeWidth={HAPPIER_DATA_METRICS.lineStrokePx}
          strokeLinecap="round" strokeLinejoin="round" />);
        return <Path key={lineKey} testID={props.testID ? `${props.testID}-short-run-${seriesIndex}-${index}` : undefined}
          d={linePath} fill="none" stroke={ink} strokeWidth={HAPPIER_DATA_METRICS.lineStrokePx} strokeLinecap="round" strokeLinejoin="round" />;
      }
      // One lone sample is a dot: as an area it would be a thin column dropping to the baseline.
      if (indexes.length === 1 && variant === 'area' && entry.fillPattern !== 'hatch') {
        const only = geometry.buckets[indexes[0]!]!.values[seriesIndex]!;
        return <Circle key={`${entry.id}:${index}`} testID={props.testID ? `${props.testID}-lone-${seriesIndex}-${index}` : undefined}
          cx={geometry.xAt(indexes[0]!)} cy={inset + geometry.yAt(only.upper)} r={Math.max(stroke, HAPPIER_DATA_METRICS.lineStrokePx)} fill={ink} />;
      }
      const upper = indexes.map((bucketIndex) => ({ x: geometry.xAt(bucketIndex), y: inset + geometry.yAt(geometry.buckets[bucketIndex]!.values[seriesIndex]!.upper) }));
      if (indexes.length === 1) {
        const center = upper[0]!;
        upper.splice(0, 1, { x: geometry.buckets.length === 1 ? 0 : Math.max(0, center.x - stroke), y: center.y }, { x: geometry.buckets.length === 1 ? plotWidth : Math.min(plotWidth, center.x + stroke), y: center.y });
      }
      let path = buildHappierSeriesPath(upper, variant === 'area' ? 1 : 0);
      const edge = washed ? path : null;
      if (variant === 'area') {
        const lower = [...indexes].reverse().map((bucketIndex) => ({ x: geometry.xAt(bucketIndex), y: inset + geometry.yAt(geometry.buckets[bucketIndex]!.values[seriesIndex]!.lower) }));
        if (indexes.length === 1) { lower[0] = { x: upper[1]!.x, y: lower[0]!.y }; lower.push({ x: upper[0]!.x, y: lower[0]!.y }); }
        path += ` ${buildHappierSeriesPath(lower, 1).replace(/^M/u, 'L')} Z`;
      }
      const key = `${entry.id}:${index}`;
      if (threshold && upper.some((point) => point.y < thresholdY)) thresholdPaths.push(<Path key={key}
        testID={props.testID ? `${props.testID}-threshold-path-${seriesIndex}-${index}` : undefined}
        d={path} clipPath={`url(#${thresholdId})`} fill={variant === 'area' ? thresholdColor : 'none'}
        stroke={variant === 'line' ? thresholdColor : props.theme.colors.surface} strokeWidth={lineStroke}
        strokeDasharray={entry.lineStyle === 'dotted' ? [1.5, 3.5] : entry.lineStyle === 'dashed' ? [4, 4] : undefined}
        strokeLinecap="round" strokeLinejoin="round" />);
      if (variant === 'line' && props.renderLinePath) return <View key={key} style={{ position: 'absolute', left: 0, top: 0 }}>{props.renderLinePath(path, { width: plotWidth, height, color: ink, strokeWidth: stroke, reducedMotion })}</View>;
      const dash = entry.lineStyle === 'dotted' ? [1.5, 3.5] : entry.lineStyle === 'dashed' ? [4, 4] : undefined;
      if (edge) return <Fragment key={key}><Path d={path} fill={ink} fillOpacity={entry.fillOpacity} stroke="none" />
        <Path d={edge} fill="none" stroke={ink} strokeWidth={props.strokeWidth ?? HAPPIER_DATA_METRICS.lineStrokePx} strokeDasharray={dash} strokeLinecap="round" strokeLinejoin="round" /></Fragment>;
      return <Fragment key={key}><Path d={path} fill={variant === 'area' ? ink : 'none'} stroke={variant === 'line' ? ink : props.theme.colors.surface} strokeWidth={lineStroke} strokeDasharray={dash} strokeLinecap="round" strokeLinejoin="round" />
        {variant === 'area' && entry.fillPattern === 'hatch' ? <Path d={path} fill={`url(#${patternId})`} /> : null}</Fragment>;
    });
  });

  const showGrid = props.showGrid ?? !inline;
  const hasAreaHatch = props.variant === 'area' && props.series.some(entry => entry.fillPattern === 'hatch');
  const pathInk = props.variant === 'line' && props.renderLinePath
    ? <>{bandPaths.length ? <Svg width={plotWidth} height={height}>{bandPaths}</Svg> : null}{paths}</>
    : <Svg width={plotWidth} height={height}>{hasAreaHatch ? <Defs><HatchPattern id={patternId} color={props.theme.colors.surface} /></Defs> : null}{bandPaths}{paths}</Svg>;
  const thresholdInk = thresholdPaths.length ? <Svg width={plotWidth} height={height} style={{ position: 'absolute', left: 0, top: 0 }}>
    <Defs><ClipPath id={thresholdId}><Rect testID={props.testID ? `${props.testID}-threshold-clip` : undefined}
      x={0} y={0} width={plotWidth} height={thresholdY} /></ClipPath></Defs>{thresholdPaths}
  </Svg> : null;
  const liveEndpoints = props.liveMotion && props.liveMotion.active !== false && geometry.buckets.length ? <Svg width={plotWidth} height={height}
    style={{ position: 'absolute', left: 0, top: 0 }}>
    {geometry.buckets[geometry.buckets.length - 1]!.values.map((entry, index) => entry.value === null ? null : <Circle key={entry.seriesId}
      testID={props.testID ? `${props.testID}-endpoint-${index}` : undefined}
      cx={geometry.xAt(geometry.buckets.length - 1)} cy={inset + geometry.yAt(entry.upper)} r={HAPPIER_DATA_METRICS.lineStrokePx}
      fill={threshold && inset + geometry.yAt(entry.upper) < thresholdY ? thresholdColor : entry.color ?? color(index)}
      stroke={props.theme.colors.surface} strokeWidth={HAPPIER_DATA_METRICS.barSeamPx} />)}
  </Svg> : null;
  const ink = props.liveMotion ? <View style={{ width: plotWidth, height, overflow: 'hidden' }}>
    <Animated.View ref={liveInk} testID={props.testID ? `${props.testID}-sliding-ink` : undefined} style={{ transform: [{ translateX: Platform.OS === 'web' ? 0 : liveOffset }] }}>
      {pathInk}{thresholdInk}
    </Animated.View>{liveEndpoints}
  </View> : <>{pathInk}{thresholdInk}</>;
  const plot = <View style={{ width: props.renderFrame ? undefined : plotWidth, height, marginTop: peakInset, position: 'relative', borderBottomWidth: inline || showGrid ? 0 : 1, borderBottomColor: props.theme.colors.divider }}>
    {props.variant === 'bar' ? null : <View pointerEvents="none" aria-hidden importantForAccessibility="no-hide-descendants" style={{ position: 'absolute', width: '100%', height }}>
      {props.renderInk ? props.renderInk(ink, reducedMotion) : ink}
    </View>}
    <View style={{ height, flexDirection: 'row', gap: props.variant === 'bar' ? barGap : 0, paddingHorizontal: props.variant === 'bar' ? props.barLeadingInset : undefined }}>
      {denseLine ? historyControl : geometry.buckets.map((bucket, index) => {
        const shade = shading.get(bucket.id);
        const range = ranges.get(bucket.id);
        const visual = props.variant !== 'bar' ? <View style={{ flex: 1 }} /> : <View style={{ height, width: '100%', position: 'relative' }}>
          {shade ? <View pointerEvents="none" aria-hidden importantForAccessibility="no-hide-descendants"
            testID={props.testID ? `${props.testID}-shading-${bucket.id}` : undefined}
            style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0,
              backgroundColor: shade.color ?? props.theme.colors.secondaryText, opacity: shade.opacity ?? HAPPIER_DATA_METRICS.bucketShadeOpacity }} /> : null}
          <View style={{ height, width: props.barWidth ?? '100%', maxWidth: props.barMaxWidth ?? (inline ? undefined : HAPPIER_DATA_METRICS.barMaxWidthPx), alignSelf: 'center', position: 'relative', overflow: 'hidden', backgroundColor: props.barTrackColor, borderTopLeftRadius: HAPPIER_DATA_METRICS.barRadiusPx, borderTopRightRadius: HAPPIER_DATA_METRICS.barRadiusPx }}>
          <StackRise height={height} testID={props.testID ? `${props.testID}-stack-${index}` : undefined} rise={reducedMotion || !props.barMotion ? null
            : props.barMotion.entrance && !drawn.current ? { durationMs: props.barMotion.entrance.durationMs, delayMs: props.barMotion.entrance.delaysMs?.[index] ?? 0 }
              : props.barMotion.change && drawn.current ? { durationMs: HAPPIER_MOTION_V1.baseMs, delayMs: 0 } : null}>
          {bucket.values.map((entry, seriesIndex) => {
            if (entry.value === null) return null;
            const extent = Math.max(props.barMinHeight ?? (entry.value === 0 ? HAPPIER_DATA_METRICS.barStubPx : 0), Math.abs(geometry.yAt(entry.lower) - geometry.yAt(entry.upper)));
            // Stacked segments part on a paper seam, as stacked areas do; the base segment sits on the axis.
            const seam = props.series.length > 1 && seriesIndex > 0 && entry.lower !== 0 && extent > HAPPIER_DATA_METRICS.barSeamPx * 2 ? HAPPIER_DATA_METRICS.barSeamPx : 0;
            const barHeight = extent - seam;
            const emphasized = index === (props.barEmphasis === 'maximum' ? peakIndex : geometry.buckets.length - 1);
            return <SeriesBar key={entry.seriesId} testID={props.testID ? `${props.testID}-bar-${index}-${seriesIndex}` : undefined}
              top={entry.value >= 0 ? Math.max(0, geometry.yAt(entry.lower) - extent) : geometry.yAt(entry.lower) + seam} height={barHeight}
              color={entry.color ?? color(seriesIndex)} opacity={entry.opacity ?? (selectedId === bucket.id || props.series.length > 1 || emphasized || props.barEmphasis === 'none' ? 1 : props.barEmphasis === 'maximum' ? Math.max(0.55, 0.9 * barHeight / height) : 0.65)}
              fillPattern={props.series[seriesIndex]?.fillPattern} patternInk={props.theme.colors.surface}
              motion={props.barMotion} reducedMotion={reducedMotion} />;
          })}</StackRise>
          {bucket.values.every(entry => entry.value === null) ? <View pointerEvents="none" aria-hidden importantForAccessibility="no-hide-descendants"
            testID={props.testID ? `${props.testID}-gap-${bucket.id}` : undefined}
            style={{ position: 'absolute', left: 0, right: 0, top: Math.max(0, geometry.yAt(0) - HAPPIER_DATA_METRICS.blockGapPx),
              height: Math.min(height, HAPPIER_DATA_METRICS.blockGapPx), opacity: HAPPIER_DATA_METRICS.barRestOpacity }}>
            <HatchSwatch ink={props.theme.colors.secondaryText} />
          </View> : null}
          {range ? <View pointerEvents="none" aria-hidden importantForAccessibility="no-hide-descendants"
            testID={props.testID ? `${props.testID}-range-${bucket.id}` : undefined}
            style={{ position: 'absolute', left: 0, right: 0, top: geometry.yAt(range.upper), height: geometry.yAt(range.lower) - geometry.yAt(range.upper),
              borderWidth: HAPPIER_DATA_METRICS.barSeamPx, borderStyle: 'dashed', borderColor: props.theme.colors.secondaryText, opacity: 0.6 }} /> : null}
          </View>
        </View>;
        const columnKey = props.variant === 'bar' && props.barMotion?.identity === 'slot' ? index : bucket.id;
        const columnStyle = props.variant === 'bar'
          ? { ...(props.barSlotWidth ? { width: props.barSlotWidth } : { flex: 1 }), height }
          : { position: 'absolute' as const, ...geometry.hitRangeAt(index), height };
        const peakTotal = props.showPeakValue && index === peakIndex ? bucketTotal(bucket) : null;
        // A peak of nothing names nothing ("$0.00" over an empty plot).
        // It rests on its own bar (a scale rounded above the peak would otherwise leave it floating at the
        // plot's top), and the edge buckets align it inward so a narrow column never cuts it at the card edge.
        const peakLabel = peakTotal !== null && peakTotal > 0
          ? <HappierText testID={props.testID ? `${props.testID}-peak` : undefined} style={{ ...text.captionStrong, position: 'absolute',
            bottom: height - geometry.yAt(peakTotal) + HAPPIER_DATA_METRICS.axisGapPx,
            alignSelf: barSlotWidth >= PEAK_LABEL_SLOT_PX ? 'center' : index === 0 ? 'flex-start' : index === geometry.buckets.length - 1 ? 'flex-end' : 'center' }}
            tabularNumbers>{format(peakTotal)}</HappierText> : null;
        if (props.renderBucket) return <View key={columnKey} style={columnStyle}>{peakLabel}{props.renderBucket(bucket, visual, () => select(bucket.id))}</View>;
        if (nativeInline || nativeDense) return <View key={columnKey} style={columnStyle} aria-hidden importantForAccessibility="no-hide-descendants">{peakLabel}{visual}</View>;
        return bucketControl(bucket, index, <>{peakLabel}{visual}</>, columnStyle, { left: barGap / 2, right: barGap / 2 }, columnKey, true);
      })}
    </View>
    {props.renderPlotOverlay && plotWidth > 0 && geometry.buckets.length ? <View pointerEvents="box-none" style={{ position: 'absolute', left: 0, top: 0, width: plotWidth, height }}>
      {props.renderPlotOverlay({ width: plotWidth, height, buckets: geometry.buckets, centers: geometry.buckets.map((_, index) => props.variant === 'bar'
        ? (props.barLeadingInset ?? 0) + index * (barSlotWidth + barGap) + barSlotWidth / 2 : geometry.xAt(index)) })}
    </View> : null}
  </View>;
  const axisTicks = resolveAxisTicks(props.axisTicks, geometry.buckets, props.showPointLabels === true);
  const axisTop = props.showPeakValue && props.showPointLabels ? 16 : HAPPIER_DATA_METRICS.axisGapPx;
  const axisId = (bucket: number) => props.testID ? `${props.testID}-axis-${bucket}` : undefined;
  // A bar's tick lives in its bar's slot; a line or area has no slots, so its tick sits at the bucket's own x.
  const axis = props.variant === 'bar'
    ? <View testID={props.testID ? `${props.testID}-axis` : undefined}
      style={{ flexDirection: 'row', gap: barGap, paddingLeft: props.barLeadingInset, paddingRight: (props.barLeadingInset ?? 0) + (props.scaleGutter ?? 0), marginTop: axisTop }}>
      {geometry.buckets.map((bucket, index) => {
        const tick = axisTicks.find((entry) => entry.bucket === index);
        const slot = props.barSlotWidth ? { width: props.barSlotWidth } : { flex: 1, minWidth: 0 };
        if (props.showPointLabels) return <View key={bucket.id} testID={axisId(index)} style={slot}>
          {tick ? <HappierText style={{ ...text.caption, textAlign: 'center' }}>{tick.label}</HappierText> : null}
        </View>;
        return <View key={bucket.id} testID={axisId(index)} style={{ ...slot, height: text.caption.lineHeight }}>
          {tick ? <HappierText style={{ ...text.caption, position: 'absolute',
            // A slot wide enough for a centred label keeps it under its bar (a two-bar chart). In a narrow slot an edge
            // bar's tick reads inward from the plot's edge, which would otherwise cut half of it off.
            ...(barSlotWidth >= AXIS_TICK_REACH_PX * 2 ? { left: 0, right: 0, textAlign: 'center' }
              : index === 0 ? { left: 0, right: -AXIS_TICK_REACH_PX, textAlign: 'left' } : index === geometry.buckets.length - 1 ? { left: -AXIS_TICK_REACH_PX, right: 0, textAlign: 'right' }
              : { left: -AXIS_TICK_REACH_PX / 2, right: -AXIS_TICK_REACH_PX / 2, textAlign: 'center' }) }}>{tick.label}</HappierText> : null}
        </View>;
      })}
    </View>
    : <View testID={props.testID ? `${props.testID}-axis` : undefined}
      style={{ position: 'relative', width: plotWidth, height: text.caption.lineHeight, marginTop: axisTop }}>
      {plotWidth > 0 ? axisTicks.map((tick) => {
        const x = geometry.xAt(tick.bucket);
        // A tick at either end of the plot reads inward from its edge, as a bar's edge tick does.
        const place: HappierPortableStyle = x <= AXIS_TICK_REACH_PX / 2 ? { left: 0, textAlign: 'left' }
          : x >= plotWidth - AXIS_TICK_REACH_PX / 2 ? { right: 0, textAlign: 'right' }
            : { left: x - AXIS_TICK_REACH_PX, width: AXIS_TICK_REACH_PX * 2, textAlign: 'center' };
        return <HappierText key={tick.bucket} testID={axisId(tick.bucket)} style={{ ...text.caption, position: 'absolute', ...place }}>{tick.label}</HappierText>;
      }) : null}
    </View>;
  const chartBody = <View>
    {plot}
    {showAxis && geometry.buckets.length ? axis : null}
  </View>;
  return <View testID={props.testID} accessible={nativeInline ? true : undefined}
    accessibilityRole={threshold || props.mirrored || summarised ? 'image' : undefined}
    accessibilityLabel={`${props.label}${latest ? imageName(latest) : exact ? `: ${exact}` : ''}${threshold ? `; ${threshold.label} ${format(threshold.value)}` : ''}${reference ? `; ${reference.label} ${reference.value}` : ''}${barRanges.map(range => `; ${range.label} ${range.lower}–${range.upper}`).join('')}`}
    onLayout={(event: HappierLayoutChangeEvent) => {
      const visibleWidth = readHappierVisibleLayoutWidth(event.nativeEvent.layout.width);
      if (visibleWidth !== null) setWidth(visibleWidth);
    }} style={props.width ? { width: props.width } : undefined}>
    {props.showAnnotations ? geometry.buckets.filter((bucket) => bucket.annotation).map((bucket) => <HappierText key={bucket.id} style={{ ...text.caption, marginBottom: 6 }}>{bucket.label}{` · ${bucket.annotation}`}</HappierText>) : null}
    <View style={{ position: 'relative' }}>
      {showGrid ? <View pointerEvents="none" style={{ position: 'absolute', left: 0, right: props.scaleGutter ?? 0, top: peakInset, height }}>
        {(props.scaleTicks ? props.scaleTicks.map((tick) => inset + geometry.yAt(tick.value)) : [0, 0.5, 1].map((fraction) => fraction * (height - 1)))
          .map((top, index) => <View key={index} style={{ position: 'absolute', left: 0, right: 0, top, borderTopWidth: 1, borderTopColor: props.theme.colors.divider, opacity: 0.55 }} />)}
      </View> : null}
      {props.renderFrame ? props.renderFrame(chartBody) : chartBody}
      {reference && geometry.buckets.length ? <View pointerEvents="none" aria-hidden importantForAccessibility="no-hide-descendants"
        style={{ position: 'absolute', left: 0, right: 0, top: peakInset + inset + geometry.yAt(reference.value), flexDirection: 'row', alignItems: 'center' }}>
        <View style={{ flex: 1, marginRight: props.scaleGutter ?? 0, borderTopWidth: 1, borderStyle: 'dashed', borderTopColor: props.theme.colors.secondaryText, opacity: 0.6 }} />
        {props.scaleGutter ? <HappierText style={{ ...text.caption, position: 'absolute', right: 0, top: -7 }}>{reference.label}</HappierText> : null}
      </View> : null}
      {threshold && threshold.value >= geometry.min && threshold.value <= geometry.max && geometry.buckets.length ? <View pointerEvents="none" aria-hidden importantForAccessibility="no-hide-descendants"
        style={{ position: 'absolute', left: 0, right: props.scaleGutter ?? 0, top: peakInset + thresholdY, borderTopWidth: 1, borderStyle: 'dashed', borderTopColor: thresholdColor }}>
        <HappierText style={{ ...text.caption, color: thresholdColor, position: 'absolute', left: 0, bottom: HAPPIER_DATA_METRICS.axisGapPx }}>{threshold.label}</HappierText>
      </View> : null}
      {/* The reference label shares the scale gutter: a scale value it would print over steps aside for it. */}
      {props.showScaleValues ? (props.mirrored ? [geometry.max, 0, geometry.min] : [geometry.min, geometry.min / 2 + geometry.max / 2]).map((value, index) =>
        reference && props.scaleGutter && geometry.buckets.length
          && Math.abs(geometry.yAt(value) - geometry.yAt(reference.value)) < (text.caption.lineHeight ?? props.theme.typography.caption.lineHeight) * 1.5 ? null
          : <HappierText key={index} testID={props.testID ? `${props.testID}-scale-${index}` : undefined}
            style={{ ...text.caption, position: 'absolute', right: 4, top: Math.max(0, peakInset + geometry.yAt(value) - 16) }} tabularNumbers>{format(value)}</HappierText>) : null}
      {props.scaleTicks?.map((tick) => <HappierText key={tick.value} style={{ ...text.caption, position: 'absolute', right: 0, top: Math.max(0, Math.min(height - 14, inset + geometry.yAt(tick.value) - 7)) }} tabularNumbers>{tick.label}</HappierText>)}
    </View>
    {selected && (props.showReadout ?? !inline) ? <View testID={props.testID ? `${props.testID}-readout` : undefined} accessibilityLiveRegion="polite">
      <HappierText style={text.captionStrong}>{selected.label}{selected.annotation ? ` · ${selected.annotation}` : ''}</HappierText>
      {selected.values.map((entry) => <HappierText key={entry.seriesId} style={text.caption} tabularNumbers>{`${entry.label} · ${entry.value === null ? unknown : format(entry.value)}`}</HappierText>)}
    </View> : null}
    {showLegend ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: HAPPIER_DATA_METRICS.blockGapPx, rowGap: HAPPIER_DATA_METRICS.axisGapPx, marginTop: HAPPIER_DATA_METRICS.blockGapPx }}>
      {props.series.map((entry, index) => {
        // A legend keys looks: series drawn the same way under one name (many comparable lines) share one key.
        const look = (candidate: typeof entry, at: number) => [candidate.label, color(at), candidate.lineStyle ?? '', candidate.fillPattern ?? ''].join('\u0000');
        if (props.series.slice(0, index).some((earlier, at) => look(earlier, at) === look(entry, index))) return null;
        const chosen = props.selectedSeriesIds?.includes(entry.id) === true;
        const key = <>
          <View style={{ width: 8, height: 8, borderRadius: 2, overflow: 'hidden', backgroundColor: color(index) }}>
            {entry.fillPattern === 'hatch' ? <HatchSwatch ink={props.theme.colors.surface} /> : null}
          </View>
          {props.leads?.[entry.id] ?? null}
          <HappierText style={chosen ? text.captionStrong : text.caption}>{entry.label}{entry.detail ? ` · ${entry.detail}` : ''}</HappierText>
        </>;
        const row = { flexDirection: 'row' as const, alignItems: 'center' as const, gap: HAPPIER_DATA_METRICS.axisGapPx };
        const pressLabel = props.seriesPressLabel ? props.seriesPressLabel(entry, chosen) : entry.label;
        const press = pressLabel === null ? undefined : props.onSeriesPress;
        return press ? <HappierPressable key={entry.id} testID={props.testID ? `${props.testID}-series-${entry.id}` : undefined}
          accessibilityLabel={pressLabel ?? entry.label} selected={chosen}
          onPress={() => press(entry.id)} style={row}>{key}</HappierPressable> : <View key={entry.id} style={row}>{key}</View>;
      })}
      {toggleInLegend ? valuesToggle : null}
    </View> : null}
    {props.summary ? <HappierText style={text.caption} tabularNumbers>{props.summary}</HappierText> : null}
    {valuesLabel && !toggleInLegend ? valuesToggle : null}
    {nativeDense && (valuesExpanded || (!valuesLabel && !historyCanInteract)) ? <View testID={props.testID ? `${props.testID}-values` : undefined}>
      {geometry.buckets.map((bucket, index) => bucketControl(bucket, index, <HappierText style={text.caption} tabularNumbers>{describe(bucket)}</HappierText>,
        { justifyContent: 'center', paddingVertical: HAPPIER_DATA_METRICS.cellPaddingVerticalPx }, { top: 0, bottom: 0 }))}
    </View> : valuesExpanded ? <View style={{ marginTop: HAPPIER_DATA_METRICS.blockGapPx }}><HappierDataTable theme={props.theme} label={props.label}
      columns={[{ label: props.label }, ...props.series.map((entry) => ({ label: entry.label }))]}
      // Details keeps every meaningful digit (a display formatter may abbreviate); coordinates read in the caller's words.
      rows={geometry.buckets.map((bucket) => [describeHappierSeriesCoordinate(bucket, reading), ...bucket.values.map((entry) => entry.value === null ? unknown : magnitude(entry.value))])}
      testID={props.testID ? `${props.testID}-values` : undefined} /></View> : null}
  </View>;
}
