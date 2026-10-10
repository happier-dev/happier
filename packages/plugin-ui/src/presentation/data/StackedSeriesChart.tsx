import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Animated, View } from 'react-native';
import { Path, Svg } from 'react-native-svg';

import type { HappierUiTheme } from '../../environment/types.js';
import { useOptionalHappierUiAccessibility } from '../../environment/context.js';
import { useHappierNativeMinimumInteractiveTargetSize } from '../../environment/interactiveTarget.js';
import { HappierPressable } from '../interaction/Pressable.js';
import type { HappierFocusable, HappierLayoutChangeEvent, HappierPortableStyle } from '../portableTypes.js';
import { HappierText } from '../text/Text.js';
import { HAPPIER_DATA_METRICS, useHappierDataTextStyles } from './dataText.js';
import { HappierDataTable } from './DataRows.js';
import { buildHappierSeriesPath, describeHappierSeriesBucket, describeHappierSeriesCoordinate, formatHappierDataValue, resolveHappierSeriesGeometry, type HappierSeries, type HappierSeriesBucket } from './dataModel.js';

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
  reducedMotion?: boolean;
  /** The host's existing entrance-once and spring grammar; absent means static. */
  barMotion?: Readonly<{
    /** Existing host slot morphs may opt in; semantic bucket identity is the default. */
    identity?: 'bucket' | 'slot';
    entrance?: Readonly<{ durationMs: number; delaysMs?: readonly number[] }>;
    change?: Readonly<{ stiffness: number; damping: number; mass: number }>;
  }>;
  barWidth?: number;
  /** A column never grows past this, however few buckets share the plot; it stays centred in its slot. */
  barMaxWidth?: number;
  barSlotWidth?: number;
  barLeadingInset?: number;
  barGap?: number;
  barMinHeight?: number;
  barTrackColor?: string;
  barEmphasis?: 'last' | 'maximum';
  showPointLabels?: boolean;
  showPeakValue?: boolean;
  axisTicks?: readonly string[];
  /** One labelled reference level (a typical day): a quiet dotted rule, never a series of its own. */
  reference?: Readonly<{ value: number; label: string }>;
  showAnnotations?: boolean;
  /** A series' own identity mark for the legend, keyed by series id; it follows the colour swatch. */
  leads?: Readonly<Record<string, ReactNode>>;
  /** Callers supply localized unavailable wording. */
  unknownLabel?: string;
  valueFormatter?: (value: number) => string;
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

function SeriesBar(props: Readonly<{ top: number; height: number; color: string; opacity: number; index: number;
  /** A mark that joins an already drawn chart (a period change) rises from the axis; it never pops in. */
  joining: boolean;
  motion: StackedSeriesChartProps['barMotion']; reducedMotion: boolean; testID?: string }>) {
  const joining = useRef(props.joining && props.motion?.change !== undefined).current;
  const animatedHeight = useRef(new Animated.Value(!props.reducedMotion && (props.motion?.entrance || joining) ? 0 : props.height)).current;
  const mounted = useRef(false);
  useEffect(() => {
    const first = !mounted.current;
    mounted.current = true;
    if (props.reducedMotion || !props.motion || (!first && !props.motion.change) || (first && !props.motion.entrance && !joining)) {
      animatedHeight.setValue(props.height);
      return;
    }
    const animation = first && props.motion.entrance && !joining
      ? Animated.timing(animatedHeight, { toValue: props.height, duration: props.motion.entrance.durationMs,
        delay: props.motion.entrance.delaysMs?.[props.index] ?? 0, useNativeDriver: false })
      : props.motion.change ? Animated.spring(animatedHeight, { toValue: props.height, ...props.motion.change, useNativeDriver: false }) : null;
    animation?.start();
    return () => animation?.stop();
  }, [animatedHeight, props.height, props.index, props.motion, props.reducedMotion]);
  const base = { position: 'absolute' as const, width: '100%' as const, backgroundColor: props.color, opacity: props.opacity };
  if (props.reducedMotion || !props.motion) return <View testID={props.testID} style={{ ...base, top: props.top, height: props.height }} />;
  return <Animated.View testID={props.testID} style={{ ...base, top: Animated.subtract(props.top + props.height, animatedHeight), height: animatedHeight }} />;
}

/** Finite series renderer. All variants share bucket identity, scale, interaction and exact facts. */
export function StackedSeriesChart(props: StackedSeriesChartProps) {
  const text = useHappierDataTextStyles(props.theme);
  const [measuredWidth, setWidth] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [valuesExpanded, setValuesExpanded] = useState(false);
  const accessibility = useOptionalHappierUiAccessibility();
  const nativeTarget = useHappierNativeMinimumInteractiveTargetSize();
  const reducedMotion = accessibility?.reducedMotion === true || (props.reducedMotion ?? accessibility?.reducedMotion ?? true);
  const controls = useRef(new Map<string, HappierFocusable>());
  // Marks created after the first commit are joining a chart the viewer is already reading.
  const drawn = useRef(false);
  useEffect(() => { drawn.current = true; }, []);
  const width = props.width ?? measuredWidth;
  const inline = props.size === 'inline';
  const showAxis = props.showAxis ?? !inline;
  const showLegend = props.showLegend ?? (!inline && props.series.length > 1);
  const height = Math.max(1, (props.viewportHeight ?? (inline ? 16 : props.size === 'tile' ? 64 : 150)));
  const peakInset = props.showPeakValue ? 32 : 0;
  // Stacked areas part on a thin paper seam (lab kitcharts "1.6px paper gap"), never a darker outline.
  const stroke = props.strokeWidth ?? (props.variant === 'area' ? (props.series.length > 1 ? HAPPIER_DATA_METRICS.areaSeamPx : 0) : HAPPIER_DATA_METRICS.lineStrokePx);
  const inset = props.variant === 'bar' ? 0 : props.plotInset ?? stroke / 2;
  const plotWidth = Math.max(0, width - (props.scaleGutter ?? 0));
  const geometry = resolveHappierSeriesGeometry(props.series, { width: plotWidth, height: Math.max(1, height - inset * 2), variant: props.variant, normalized: props.normalized, fitLine: props.fitLine, minimumMaximum: props.minimumMaximum });
  const unknown = props.unknownLabel ?? '—';
  const format = props.valueFormatter ?? ((value: number) => formatHappierDataValue(value, text.locale));
  const selected = geometry.buckets.find((bucket) => bucket.id === selectedId) ?? null;
  const select = (id: string) => { setSelectedId(id); props.onSelect?.(id); };
  const color = (index: number) => props.series[index]?.color ?? props.theme.colors.accent;
  const exact = geometry.buckets.map((bucket) => describeHappierSeriesBucket(bucket, unknown)).join('; ');
  // A stacked bucket's peak is its whole column, not its first series.
  const bucketTotal = (bucket: HappierSeriesBucket): number | null => bucket.values.some((entry) => entry.value !== null)
    ? bucket.values.reduce((sum, entry) => sum + (entry.value ?? 0), 0) : null;
  const peakIndex = geometry.buckets.reduce((peak, bucket, index) => (bucketTotal(bucket) ?? -Infinity) > (bucketTotal(geometry.buckets[peak]!) ?? -Infinity) ? index : peak, 0);
  const barGap = props.barGap ?? HAPPIER_DATA_METRICS.barGapPx;
  const nativeInline = !props.renderBucket && inline && nativeTarget !== undefined;
  const barSlotWidth = props.barSlotWidth ?? Math.max(0, plotWidth - (props.barLeadingInset ?? 0) * 2 - barGap * Math.max(0, geometry.buckets.length - 1)) / Math.max(1, geometry.buckets.length);
  const nativeDense = !props.renderBucket && !inline && nativeTarget !== undefined && geometry.buckets.length > 0
    && (height < nativeTarget || geometry.buckets.some((_, index) => (props.variant === 'bar' ? barSlotWidth : geometry.hitRangeAt(index).width) < nativeTarget));
  const bucketControl = (bucket: HappierSeriesBucket, index: number, visual: ReactNode, style?: HappierPortableStyle, key: string | number = bucket.id) => <HappierPressable key={key}
    testID={props.testID ? `${props.testID}-bucket-${bucket.id}` : undefined}
    controlRef={(control) => { if (control) controls.current.set(bucket.id, control); else controls.current.delete(bucket.id); }}
    accessibilityLabel={describeHappierSeriesBucket(bucket, unknown)} selected={selectedId === bucket.id}
    onPress={() => select(bucket.id)} onFocusChange={(focused) => { if (focused) setSelectedId(bucket.id); }}
    onKeyDown={(key) => {
      const next = key === 'ArrowRight' ? Math.min(index + 1, geometry.buckets.length - 1) : key === 'ArrowLeft' ? Math.max(0, index - 1) : key === 'Home' ? 0 : key === 'End' ? geometry.buckets.length - 1 : null;
      if (next === null) return false;
      const id = geometry.buckets[next]!.id;
      select(id); controls.current.get(id)?.focus(); return true;
    }} style={style}>{visual}</HappierPressable>;

  const paths = props.variant === 'bar' || plotWidth <= 0 ? null : props.series.flatMap((entry, seriesIndex) => {
    // Missing points break the ribbon/stroke rather than silently becoming zero or bridging a gap.
    const runs: number[][] = [];
    let run: number[] = [];
    geometry.buckets.forEach((bucket, index) => {
      if (bucket.values[seriesIndex]!.value === null || (props.normalized && !bucket.values.some((value) => value.value !== null && value.value > 0))) { if (run.length) runs.push(run); run = []; }
      else run.push(index);
    });
    if (run.length) runs.push(run);
    return runs.map((indexes, index) => {
      const upper = indexes.map((bucketIndex) => ({ x: geometry.xAt(bucketIndex), y: inset + geometry.yAt(geometry.buckets[bucketIndex]!.values[seriesIndex]!.upper) }));
      if (indexes.length === 1) {
        const center = upper[0]!;
        upper.splice(0, 1, { x: geometry.buckets.length === 1 ? 0 : Math.max(0, center.x - stroke), y: center.y }, { x: geometry.buckets.length === 1 ? plotWidth : Math.min(plotWidth, center.x + stroke), y: center.y });
      }
      let path = buildHappierSeriesPath(upper, props.variant === 'area' ? 0.85 : 0);
      if (props.variant === 'area') {
        const lower = [...indexes].reverse().map((bucketIndex) => ({ x: geometry.xAt(bucketIndex), y: inset + geometry.yAt(geometry.buckets[bucketIndex]!.values[seriesIndex]!.lower) }));
        if (indexes.length === 1) { lower[0] = { x: upper[1]!.x, y: lower[0]!.y }; lower.push({ x: upper[0]!.x, y: lower[0]!.y }); }
        path += ` ${buildHappierSeriesPath(lower, 0.85).replace(/^M/u, 'L')} Z`;
      }
      const key = `${entry.id}:${index}`;
      if (props.variant === 'line' && props.renderLinePath) return <View key={key} style={{ position: 'absolute', left: 0, top: 0 }}>{props.renderLinePath(path, { width: plotWidth, height, color: color(seriesIndex), strokeWidth: stroke, reducedMotion })}</View>;
      return <Path key={key} d={path} fill={props.variant === 'area' ? color(seriesIndex) : 'none'} stroke={props.variant === 'line' ? color(seriesIndex) : props.theme.colors.surface} strokeWidth={stroke} strokeDasharray={entry.lineStyle === 'dotted' ? [1.5, 3.5] : entry.lineStyle === 'dashed' ? [4, 4] : undefined} strokeLinecap="round" strokeLinejoin="round" />;
    });
  });

  const showGrid = props.showGrid ?? !inline;
  const pathInk = props.variant === 'line' && props.renderLinePath ? paths : <Svg width={plotWidth} height={height}>{paths}</Svg>;
  const plot = <View style={{ width: props.renderFrame ? undefined : plotWidth, height, marginTop: peakInset, position: 'relative', borderBottomWidth: inline || showGrid ? 0 : 1, borderBottomColor: props.theme.colors.divider }}>
    {props.variant === 'bar' ? null : <View pointerEvents="none" aria-hidden importantForAccessibility="no-hide-descendants" style={{ position: 'absolute', width: '100%', height }}>
      {props.renderInk ? props.renderInk(pathInk, reducedMotion) : pathInk}
    </View>}
    <View style={{ height, flexDirection: 'row', gap: props.variant === 'bar' ? barGap : 0, paddingHorizontal: props.variant === 'bar' ? props.barLeadingInset : undefined }}>
      {geometry.buckets.map((bucket, index) => {
        const visual = props.variant !== 'bar' ? <View style={{ flex: 1 }} /> : <View style={{ height, width: props.barWidth ?? '100%', maxWidth: props.barMaxWidth, alignSelf: 'center', position: 'relative', overflow: 'hidden', backgroundColor: props.barTrackColor, borderTopLeftRadius: HAPPIER_DATA_METRICS.barRadiusPx, borderTopRightRadius: HAPPIER_DATA_METRICS.barRadiusPx }}>
          {bucket.values.map((entry, seriesIndex) => {
            if (entry.value === null) return null;
            const extent = Math.max(props.barMinHeight ?? (entry.value === 0 ? HAPPIER_DATA_METRICS.barStubPx : 0), Math.abs(geometry.yAt(entry.lower) - geometry.yAt(entry.upper)));
            // Stacked segments part on a paper seam, as stacked areas do; the base segment sits on the axis.
            const seam = props.series.length > 1 && seriesIndex > 0 && entry.lower !== 0 && extent > HAPPIER_DATA_METRICS.barSeamPx * 2 ? HAPPIER_DATA_METRICS.barSeamPx : 0;
            const barHeight = extent - seam;
            const emphasized = index === (props.barEmphasis === 'maximum' ? peakIndex : geometry.buckets.length - 1);
            return <SeriesBar key={entry.seriesId} testID={props.testID ? `${props.testID}-bar-${index}-${seriesIndex}` : undefined}
              top={entry.value >= 0 ? Math.max(0, geometry.yAt(entry.lower) - extent) : geometry.yAt(entry.lower) + seam} height={barHeight}
              color={entry.color ?? color(seriesIndex)} opacity={entry.opacity ?? (selectedId === bucket.id || props.series.length > 1 || emphasized ? 1 : props.barEmphasis === 'maximum' ? Math.max(0.55, 0.9 * barHeight / height) : 0.65)}
              index={index} joining={drawn.current} motion={props.barMotion} reducedMotion={reducedMotion} />;
          })}
        </View>;
        const columnKey = props.variant === 'bar' && props.barMotion?.identity === 'slot' ? index : bucket.id;
        const columnStyle = props.variant === 'bar'
          ? { ...(props.barSlotWidth ? { width: props.barSlotWidth } : { flex: 1 }), height }
          : { position: 'absolute' as const, ...geometry.hitRangeAt(index), height };
        const peakTotal = props.showPeakValue && index === peakIndex ? bucketTotal(bucket) : null;
        const peakLabel = peakTotal !== null
          ? <HappierText style={{ ...text.captionStrong, position: 'absolute', top: -peakInset, alignSelf: 'center' }} tabularNumbers>{format(peakTotal)}</HappierText> : null;
        if (props.renderBucket) return <View key={columnKey} style={columnStyle}>{peakLabel}{props.renderBucket(bucket, visual, () => select(bucket.id))}</View>;
        if (nativeInline || nativeDense) return <View key={columnKey} style={columnStyle} aria-hidden importantForAccessibility="no-hide-descendants">{peakLabel}{visual}</View>;
        return bucketControl(bucket, index, <>{peakLabel}{visual}</>, columnStyle, columnKey);
      })}
    </View>
    {props.renderPlotOverlay && plotWidth > 0 && geometry.buckets.length ? <View pointerEvents="box-none" style={{ position: 'absolute', left: 0, top: 0, width: plotWidth, height }}>
      {props.renderPlotOverlay({ width: plotWidth, height, buckets: geometry.buckets, centers: geometry.buckets.map((_, index) => props.variant === 'bar'
        ? (props.barLeadingInset ?? 0) + index * (barSlotWidth + barGap) + barSlotWidth / 2 : geometry.xAt(index)) })}
    </View> : null}
  </View>;
  const chartBody = <View>
    {plot}
    {showAxis && geometry.buckets.length ? <View style={{ flexDirection: 'row', justifyContent: props.barSlotWidth && props.showPointLabels ? 'flex-start' : 'space-between', gap: props.showPointLabels ? barGap : undefined, paddingHorizontal: props.showPointLabels ? props.barLeadingInset : undefined, paddingRight: props.showPointLabels ? undefined : props.scaleGutter, marginTop: props.showPeakValue && props.showPointLabels ? 16 : HAPPIER_DATA_METRICS.axisGapPx }}>
      {(props.axisTicks ?? (props.showPointLabels ? geometry.buckets.map((bucket) => bucket.label) : [geometry.buckets[0]!.label, ...(geometry.buckets.length > 1 ? [geometry.buckets[geometry.buckets.length - 1]!.label] : [])])).map((label, index) => <HappierText key={index} style={{ ...text.caption, ...(props.showPointLabels ? { ...(props.barSlotWidth ? { width: props.barSlotWidth } : { flex: 1 }), textAlign: 'center' } : {}) }}>{label}</HappierText>)}
    </View> : null}
  </View>;
  return <View testID={props.testID} accessible={nativeInline ? true : undefined} accessibilityLabel={`${props.label}${exact ? `: ${exact}` : ''}`}
    onLayout={(event: HappierLayoutChangeEvent) => setWidth(event.nativeEvent.layout.width)} style={props.width ? { width: props.width } : undefined}>
    {props.showAnnotations ? geometry.buckets.filter((bucket) => bucket.annotation).map((bucket) => <HappierText key={bucket.id} style={{ ...text.caption, marginBottom: 6 }}>{bucket.label}{` · ${bucket.annotation}`}</HappierText>) : null}
    <View style={{ position: 'relative' }}>
      {showGrid ? <View pointerEvents="none" style={{ position: 'absolute', left: 0, right: props.scaleGutter ?? 0, top: peakInset, height }}>
        {(props.scaleTicks ? props.scaleTicks.map((tick) => inset + geometry.yAt(tick.value)) : [0, 0.5, 1].map((fraction) => fraction * (height - 1)))
          .map((top, index) => <View key={index} style={{ position: 'absolute', left: 0, right: 0, top, borderTopWidth: 1, borderTopColor: props.theme.colors.divider, opacity: 0.55 }} />)}
      </View> : null}
      {props.reference && Number.isFinite(props.reference.value) && geometry.buckets.length ? <View pointerEvents="none" aria-hidden importantForAccessibility="no-hide-descendants"
        style={{ position: 'absolute', left: 0, right: 0, top: peakInset + inset + geometry.yAt(props.reference.value), flexDirection: 'row', alignItems: 'center' }}>
        <View style={{ flex: 1, marginRight: props.scaleGutter ?? 0, borderTopWidth: 1, borderStyle: 'dashed', borderTopColor: props.theme.colors.secondaryText, opacity: 0.6 }} />
        {props.scaleGutter ? <HappierText style={{ ...text.caption, position: 'absolute', right: 0, top: -7 }}>{props.reference.label}</HappierText> : null}
      </View> : null}
      {props.renderFrame ? props.renderFrame(chartBody) : chartBody}
      {props.showScaleValues ? [geometry.min, geometry.min / 2 + geometry.max / 2].map((value, index) => <HappierText key={index} style={{ ...text.caption, position: 'absolute', right: 4, top: Math.max(0, peakInset + geometry.yAt(value) - 16) }} tabularNumbers>{format(value)}</HappierText>) : null}
      {props.scaleTicks?.map((tick) => <HappierText key={tick.value} style={{ ...text.caption, position: 'absolute', right: 0, top: Math.max(0, Math.min(height - 14, inset + geometry.yAt(tick.value) - 7)) }} tabularNumbers>{tick.label}</HappierText>)}
    </View>
    {selected && (props.showReadout ?? !inline) ? <View testID={props.testID ? `${props.testID}-readout` : undefined} accessibilityLiveRegion="polite">
      <HappierText style={text.captionStrong}>{selected.label}{selected.annotation ? ` · ${selected.annotation}` : ''}</HappierText>
      {selected.values.map((entry) => <HappierText key={entry.seriesId} style={text.caption} tabularNumbers>{`${entry.label} · ${entry.value === null ? unknown : format(entry.value)}`}</HappierText>)}
    </View> : null}
    {showLegend ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: HAPPIER_DATA_METRICS.blockGapPx, rowGap: HAPPIER_DATA_METRICS.axisGapPx, marginTop: HAPPIER_DATA_METRICS.blockGapPx }}>
      {props.series.map((entry, index) => {
        const chosen = props.selectedSeriesIds?.includes(entry.id) === true;
        const key = <>
          <View style={{ width: 8, height: 8, borderRadius: 2, backgroundColor: color(index) }} />
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
    </View> : null}
    {props.summary ? <HappierText style={text.caption} tabularNumbers>{props.summary}</HappierText> : null}
    {props.valuesLabel ? <HappierPressable testID={props.testID ? `${props.testID}-values-toggle` : undefined}
      accessibilityLabel={valuesExpanded ? props.valuesCollapseLabel ?? props.valuesLabel : props.valuesLabel}
      expanded={valuesExpanded} onPress={() => setValuesExpanded((value) => !value)}>
      <HappierText style={text.captionStrong}>{valuesExpanded ? props.valuesCollapseLabel ?? props.valuesLabel : props.valuesLabel}</HappierText>
    </HappierPressable> : null}
    {nativeDense && (valuesExpanded || !props.valuesLabel) ? <View testID={props.testID ? `${props.testID}-values` : undefined}>
      {geometry.buckets.map((bucket, index) => bucketControl(bucket, index, <HappierText style={text.caption} tabularNumbers>{describeHappierSeriesBucket(bucket, unknown)}</HappierText>, { justifyContent: 'center' }))}
    </View> : valuesExpanded ? <HappierDataTable theme={props.theme} label={props.label}
      columns={[{ label: props.label }, ...props.series.map((entry) => ({ label: entry.label }))]}
      rows={geometry.buckets.map((bucket) => [describeHappierSeriesCoordinate(bucket), ...bucket.values.map((entry) => entry.value ?? unknown)])}
      testID={props.testID ? `${props.testID}-values` : undefined} /> : null}
  </View>;
}
