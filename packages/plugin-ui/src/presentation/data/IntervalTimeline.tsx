import { Fragment, useState, type ReactNode } from 'react';
import { View } from 'react-native';

import { useHappierNativeMinimumInteractiveTargetSize } from '../../environment/interactiveTarget.js';
import type { HappierUiTheme } from '../../environment/types.js';
import { HappierDataHatch } from '../content/Hatch.js';
import { HappierPressable } from '../interaction/Pressable.js';
import type { HappierLayoutChangeEvent } from '../portableTypes.js';
import { HappierText } from '../text/Text.js';
import { HappierDataRows } from './DataRows.js';
import { useOptionalHappierUiLocalization } from '../../environment/context.js';
import { formatHappierDataValue, resolveHappierDataDomainFraction } from './dataModel.js';
import { HAPPIER_DATA_METRICS, useHappierDataTextStyles } from './dataText.js';
import { ChartDatum, type HappierChartDatum } from './ChartDatum.js';

export type IntervalTimelineInterval = Readonly<{
  id: string;
  label: string;
  /** A point has one witnessed coordinate; it never implies a duration or unknown end. */
  kind?: 'interval' | 'point';
  /** Coordinates in the consumer's stated domain; no time, activity or duration is inferred. */
  start: number | null;
  /** Missing end draws only a known start marker, never an assumed continuing span. */
  end: number | null;
  startLabel?: string;
  endLabel?: string;
  color?: string;
  /** A source-provided texture; any meaning belongs in the consumer's label or annotation. */
  pattern?: 'solid' | 'hatched';
  annotation?: string;
  /** Exact domain wording for interaction only; axis, rows and selection readout retain their formatter. */
  datum?: HappierChartDatum;
  /** `layout="lanes"`: the lane this interval is drawn in (a machine, an agent). */
  lane?: string;
  /** `layout="lanes"`: intervals sharing a track id (one run's busy spans and waits) stay on one line. */
  track?: string;
}>;

export type IntervalTimelineProps = Readonly<{
  theme: HappierUiTheme;
  label: string;
  intervals: readonly IntervalTimelineInterval[];
  domain: Readonly<{ start: number; end: number }>;
  startLabel?: string;
  endLabel?: string;
  basis?: string;
  unknownLabel?: string;
  size?: 'inline' | 'tile' | 'full';
  /**
   * `rows` (default): one labelled line per interval. `lanes`: intervals grouped by `lane` and packed into
   * the fewest non-overlapping tracks under one shared axis, so a busy day stays scannable; each run is
   * still selectable and listed exactly behind Details.
   */
  layout?: 'rows' | 'lanes';
  /** Names the lane column in the exact rows (`layout="lanes"`). */
  laneLabel?: string;
  /** Extra axis positions between the domain's ends, in domain units (whole hours of a day). */
  ticks?: readonly number[];
  geometry?: Readonly<{ width: number; height: number }>;
  /**
   * The domain's own exact wording (a clock time for minutes of a day). It replaces the generic
   * number on the axis, rows and readout; without it the finite coordinate is stated as a number.
   */
  formatValue?: (value: number) => string;
  /** Names the toggle that reveals the exact rows while the plot shows; defaults to the host's Details. */
  valuesLabel?: string;
  valuesCollapseLabel?: string;
  /** Domain-owned marker ink, placed by the shared timeline geometry. */
  renderMarker?: (interval: IntervalTimelineInterval) => ReactNode;
  testID?: string;
}>;

const validDomainFor = (domain: Readonly<{ start: number; end: number }>) =>
  Number.isFinite(domain.start) && Number.isFinite(domain.end) && domain.start < domain.end;

type PackedLane = Readonly<{ label: string; tracks: readonly (readonly IntervalTimelineInterval[])[] }>;

type IntervalMarks = Readonly<{
  /** The original start's and end's positions, only where they fall inside the domain. */
  start: number | null;
  end: number | null;
  /** The witnessed part of a valid span, clipped to the domain; null where nothing of it is inside. */
  span: Readonly<{ from: number; to: number }> | null;
}>;

/**
 * The one projection of an interval onto the domain, as fractions, shared by both layouts: a witnessed
 * span (finite start ≤ end) keeps its in-domain part, a missing or reversed end keeps only an in-domain
 * start, and nothing is placed for a coordinate outside the domain (the exact rows still state it).
 */
function projectIntervalMarks(interval: IntervalTimelineInterval, domain: Readonly<{ start: number; end: number }>): IntervalMarks {
  const fraction = (value: number | null) => resolveHappierDataDomainFraction(value, domain.start, domain.end);
  const witnessed = interval.kind !== 'point' && interval.start !== null && interval.end !== null && Number.isFinite(interval.start)
    && Number.isFinite(interval.end) && interval.start <= interval.end;
  const from = witnessed ? fraction(Math.max(domain.start, interval.start!)) : null;
  const to = witnessed ? fraction(Math.min(domain.end, interval.end!)) : null;
  return { start: fraction(interval.start), end: interval.kind === 'point' ? null : fraction(interval.end),
    span: from !== null && to !== null && to > from ? { from, to } : null };
}

/** A lanes mark: the clipped witnessed span, else a stub at an in-domain start (a point, an unknown end). */
const laneMarkOf = (marks: IntervalMarks) => marks.span ?? (marks.start === null ? null : { from: marks.start, to: marks.start });

/**
 * Groups intervals by lane (first-seen order) and packs each lane's runs (intervals sharing a `track`)
 * greedily into the fewest tracks whose drawn marks do not touch. `gap` (a domain fraction) is the room
 * two runs keep so that neighbouring short runs still read as two marks. A run
 * with no mark inside the domain is left out of the picture (it stays in the exact rows).
 */
function packIntervalLanes(intervals: readonly IntervalTimelineInterval[], markOf: (interval: IntervalTimelineInterval) => { from: number; to: number } | null,
  gap: number): PackedLane[] {
  const lanes = new Map<string, Map<string, IntervalTimelineInterval[]>>();
  for (const interval of intervals) {
    const lane = lanes.get(interval.lane ?? '') ?? new Map<string, IntervalTimelineInterval[]>();
    lanes.set(interval.lane ?? '', lane);
    const key = interval.track ?? interval.id;
    lane.set(key, [...(lane.get(key) ?? []), interval]);
  }
  return [...lanes.entries()].map(([label, runs]) => {
    const spans = [...runs.values()].flatMap((all) => {
      const members = all.filter((member) => markOf(member) !== null);
      if (members.length === 0) return [];
      const marks = members.map((member) => markOf(member)!);
      return [{ start: Math.min(...marks.map((mark) => mark.from)), end: Math.max(...marks.map((mark) => mark.to)), members }];
    }).sort((a, b) => a.start - b.start);
    const tracks: { end: number; members: IntervalTimelineInterval[] }[] = [];
    for (const span of spans) {
      const track = tracks.find((candidate) => candidate.end + gap <= span.start);
      if (track) { track.end = span.end; track.members.push(...span.members); }
      else tracks.push({ end: span.end, members: [...span.members] });
    }
    // Texture last, so a wait reads on top of the run it interrupts.
    return { label, tracks: tracks.map((track) => [...track.members].sort((a, b) => Number(a.pattern === 'hatched') - Number(b.pattern === 'hatched'))) };
  }).filter((lane) => lane.tracks.length > 0);
}

/** A track's selectable runs, in order: its witnessed spans and points, never the waits drawn over them. */
function trackStops(track: readonly IntervalTimelineInterval[]): readonly IntervalTimelineInterval[] {
  return track.filter((interval) => interval.pattern !== 'hatched' && interval.start !== null && Number.isFinite(interval.start))
    .sort((a, b) => a.start! - b.start!);
}

/**
 * Press-and-drag along a lane track (native): the run under the finger, else the one whose drawn edge is
 * nearest to it. `fraction` is the finger's position across the plot (0 = domain start).
 */
export function selectIntervalTrackRun(track: readonly IntervalTimelineInterval[], domain: Readonly<{ start: number; end: number }>,
  fraction: number): string | null {
  let best: { id: string; distance: number } | null = null;
  for (const interval of trackStops(track)) {
    const mark = laneMarkOf(projectIntervalMarks(interval, domain));
    if (mark === null) continue;
    const distance = fraction < mark.from ? mark.from - fraction : fraction > mark.to ? fraction - mark.to : 0;
    if (best === null || distance < best.distance) best = { id: interval.id, distance };
  }
  return best?.id ?? null;
}

/** The adjustable track's increment/decrement: the next or previous run, held at either end. */
export function stepIntervalTrackRun(track: readonly IntervalTimelineInterval[], currentId: string | null, direction: 1 | -1): string | null {
  const stops = trackStops(track);
  if (stops.length === 0) return null;
  const index = stops.findIndex((interval) => interval.id === currentId);
  if (index < 0) return stops[direction > 0 ? 0 : stops.length - 1]!.id;
  return stops[Math.max(0, Math.min(stops.length - 1, index + direction))]!.id;
}

export function IntervalTimeline(props: IntervalTimelineProps) {
  const text = useHappierDataTextStyles(props.theme);
  const nativeTarget = useHappierNativeMinimumInteractiveTargetSize();
  const [measuredWidth, setMeasuredWidth] = useState<number | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [valuesExpanded, setValuesExpanded] = useState(false);
  const localization = useOptionalHappierUiLocalization();
  const unknown = props.unknownLabel ?? 'Unknown';
  const startLabel = props.startLabel ?? 'Start';
  const endLabel = props.endLabel ?? 'End';
  const format = (value: number | null, label?: string) => {
    const exact = value !== null && Number.isFinite(value)
      ? props.formatValue?.(value) ?? formatHappierDataValue(value, text.locale) : unknown;
    return label && label !== exact ? `${label} (${exact})` : exact;
  };
  const hasIntervals = props.intervals.some(interval => interval.kind !== 'point');
  const lanesLayout = props.layout === 'lanes';
  const rowValues = (interval: IntervalTimelineInterval) => [...(lanesLayout ? [interval.lane ?? ''] : []), interval.label, format(interval.start, interval.startLabel),
    ...(hasIntervals ? [interval.kind === 'point' ? '' : format(interval.end, interval.endLabel)] : []), interval.annotation ?? ''];
  const describe = (interval: IntervalTimelineInterval) => [interval.label, lanesLayout ? interval.lane : null, `${startLabel}: ${format(interval.start, interval.startLabel)}`,
    interval.kind === 'point' ? null : `${endLabel}: ${format(interval.end, interval.endLabel)}`, interval.annotation, props.basis].filter(Boolean).join(', ');
  const selected = props.intervals.find((interval) => interval.id === selectedId);
  const width = props.geometry?.width ?? measuredWidth;
  const axisStart = format(props.domain.start);
  const axisEnd = format(props.domain.end);
  const captionWidth = (text.caption.fontSize ?? props.theme.typography.caption.fontSize) * HAPPIER_DATA_METRICS.averageCharacterEm;
  const axisFits = width === null || Number.isFinite(width) && width >= (axisStart.length + axisEnd.length) * captionWidth + HAPPIER_DATA_METRICS.columnGapPx;
  // Consumer ticks between the ends, dropped where their label would crowd an end or the previous tick.
  const axisTicks = (() => {
    if (!validDomainFor(props.domain) || !props.ticks) return [];
    const span = props.domain.end - props.domain.start;
    const room = (label: string) => label.length * captionWidth + HAPPIER_DATA_METRICS.columnGapPx * 2;
    const axisWidth = width === null ? null : props.layout === 'lanes' && (width >= HAPPIER_DATA_METRICS.laneSideLabelMinWidthPx)
      ? width - HAPPIER_DATA_METRICS.laneLabelWidthPx - HAPPIER_DATA_METRICS.blockGapPx : width;
    const kept: { value: number; fraction: number; label: string; width: number }[] = [];
    let previousEdge = axisWidth === null ? 0 : room(axisStart);
    for (const value of [...props.ticks].sort((a, b) => a - b)) {
      if (!Number.isFinite(value) || value <= props.domain.start || value >= props.domain.end) continue;
      const fraction = (value - props.domain.start) / span;
      const label = format(value);
      const labelWidth = room(label);
      if (axisWidth !== null) {
        const center = fraction * axisWidth;
        if (center - labelWidth / 2 < previousEdge || center + labelWidth / 2 > axisWidth - room(axisEnd)) continue;
        previousEdge = center + labelWidth / 2;
      }
      kept.push({ value, fraction, label, width: labelWidth });
    }
    return kept;
  })();
  // A row is its label line and its proportion bar; rows stack flush, each its own hit area.
  const rowHeight = (text.body.lineHeight ?? props.theme.typography.body.lineHeight) + HAPPIER_DATA_METRICS.cellPaddingVerticalPx * 2;
  const validDomain = Number.isFinite(props.domain.start) && Number.isFinite(props.domain.end) && props.domain.start < props.domain.end;
  const sideLabels = width === null || width >= HAPPIER_DATA_METRICS.laneSideLabelMinWidthPx;
  const plotWidth = width === null ? null : Math.max(1, width - (sideLabels ? HAPPIER_DATA_METRICS.laneLabelWidthPx + HAPPIER_DATA_METRICS.blockGapPx : 0));
  const marksOf = (interval: IntervalTimelineInterval) => projectIntervalMarks(interval, props.domain);
  // A track is the dense bar on every pointer. On native the whole track is a single target selecting the
  // run under the finger (press and drag), so packed runs never share overlapping targets; its hit area
  // reaches half the gap to the next track, never a taller track (DESIGN.md → touch targets are hit areas).
  const trackHeight = HAPPIER_DATA_METRICS.laneBarHeightPx;
  const trackGap = HAPPIER_DATA_METRICS.laneTrackGapPx;
  const lanes = lanesLayout && validDomain
    ? packIntervalLanes(props.intervals, (interval) => laneMarkOf(marksOf(interval)), HAPPIER_DATA_METRICS.barStubPx / (plotWidth ?? 800)) : [];
  const captionLine = text.caption.lineHeight ?? props.theme.typography.caption.lineHeight;
  const trackStep = trackHeight + trackGap;
  const requiredHeight = (lanesLayout
    ? lanes.reduce((sum, lane) => sum + lane.tracks.length * trackStep + (sideLabels ? 0 : captionLine) + HAPPIER_DATA_METRICS.blockGapPx, 0)
    : props.intervals.length * rowHeight) + captionLine + HAPPIER_DATA_METRICS.axisGapPx;
  const heightFits = props.geometry === undefined || Number.isFinite(props.geometry.height) && props.geometry.height >= requiredHeight;
  const showPlot = (props.size ?? 'full') === 'full' && validDomain && axisFits && heightFits && props.intervals.length > 0;
  const valuesLabel = props.valuesLabel ?? localization?.translate('happier.plugin-ui.state.details', 'Details') ?? 'Details';
  const collapseLabel = props.valuesCollapseLabel ?? (props.valuesLabel === undefined
    ? localization?.translate('happier.plugin-ui.state.collapseDetails', 'Collapse') ?? 'Collapse' : valuesLabel);

  return <View testID={props.testID} onLayout={(event: HappierLayoutChangeEvent) => setMeasuredWidth(event.nativeEvent.layout.width)}
    style={{ gap: HAPPIER_DATA_METRICS.blockGapPx }}>
    {props.basis ? <HappierText style={text.caption}>{props.basis}</HappierText> : null}
    {showPlot ? <View testID={props.testID ? `${props.testID}-plot` : undefined} style={lanesLayout ? { gap: HAPPIER_DATA_METRICS.blockGapPx } : undefined}>
      {lanesLayout ? lanes.map((lane, laneIndex) => <View key={`${laneIndex}:${lane.label}`}
        testID={props.testID ? `${props.testID}-lane-${laneIndex}` : undefined}
        style={sideLabels ? { flexDirection: 'row', alignItems: 'flex-start', gap: HAPPIER_DATA_METRICS.blockGapPx } : { gap: HAPPIER_DATA_METRICS.axisGapPx }}>
        <View aria-hidden importantForAccessibility="no-hide-descendants" style={sideLabels ? { width: HAPPIER_DATA_METRICS.laneLabelWidthPx,
          marginTop: (trackHeight - captionLine) / 2 } : undefined}>
          <HappierText style={text.caption} numberOfLines={1}>{lane.label}</HappierText>
        </View>
        <View style={{ flex: sideLabels ? 1 : undefined, minWidth: 0, gap: trackGap }}>
          {lane.tracks.map((track, trackIndex) => {
            // Touch: the whole track is one platform-height target. Press and drag selects the run nearest
            // the finger (the chart's scrub), and assistive technology steps through its runs.
            const touchTrack = nativeTarget !== undefined;
            const trackSelected = touchTrack ? track.find((interval) => interval.id === selectedId) : undefined;
            const pick = (locationX: number) => {
              if (plotWidth === null || plotWidth <= 0) return;
              const next = selectIntervalTrackRun(track, props.domain, locationX / plotWidth);
              if (next !== null) setSelectedId(next);
            };
            return <View key={trackIndex}
            testID={props.testID ? `${props.testID}-lane-${laneIndex}-track-${trackIndex}` : undefined}
            style={{ height: trackHeight }}
            {...(touchTrack ? {
              hitSlop: { top: trackGap / 2, bottom: trackGap / 2 },
              accessible: true, accessibilityRole: 'adjustable' as const,
              accessibilityLabel: `${lane.label}${lane.tracks.length > 1 ? ` ${trackIndex + 1}` : ''}`,
              accessibilityValue: { text: trackSelected ? describe(trackSelected) : `${trackStops(track).length}` },
              accessibilityActions: [{ name: 'increment' }, { name: 'decrement' }],
              onAccessibilityAction: (event: { nativeEvent: { actionName: string } }) => {
                const next = stepIntervalTrackRun(track, trackSelected?.id ?? null, event.nativeEvent.actionName === 'decrement' ? -1 : 1);
                if (next !== null) setSelectedId(next);
              },
              onStartShouldSetResponder: () => true,
              onResponderGrant: (event: { nativeEvent: { locationX: number } }) => pick(event.nativeEvent.locationX),
              onResponderMove: (event: { nativeEvent: { locationX: number } }) => pick(event.nativeEvent.locationX),
              // A vertical scroll may take the gesture back; the selection made so far stays.
              onResponderTerminationRequest: () => true,
            } : {})}>
            {track.map((interval) => {
              const mark = laneMarkOf(marksOf(interval));
              if (mark === null) return null;
              const span = mark.to - mark.from;
              const color = interval.color ?? props.theme.colors.info;
              // A run too short to draw as a span keeps a visible stub; a run with no end draws only its start.
              const place = { position: 'absolute' as const, left: `${mark.from * 100}%` as const, width: span > 0 ? `${span * 100}%` as const : undefined,
                minWidth: span > 0 ? HAPPIER_DATA_METRICS.barStubPx : HAPPIER_DATA_METRICS.lineStrokePx };
              const barHeight = HAPPIER_DATA_METRICS.laneBarHeightPx;
              return <Fragment key={interval.id}>
                <View testID={props.testID ? `${props.testID}-interval-${interval.id}` : undefined} aria-hidden importantForAccessibility="no-hide-descendants"
                  style={{ ...place, top: (trackHeight - barHeight) / 2, height: barHeight,
                    borderRadius: span > 0 ? HAPPIER_DATA_METRICS.barRadiusPx : 0, overflow: 'hidden', justifyContent: 'center',
                    backgroundColor: color, opacity: selectedId !== null && selectedId !== interval.id ? 0.55 : 1 }}>
                  {interval.pattern === 'hatched' ? <HappierDataHatch theme={props.theme} /> : null}
                </View>
                {/* Pointer: the target covers the whole track over the ink, one per run. */}
                {touchTrack ? null : <View style={{ ...place, top: 0, height: trackHeight }}>
                  <ChartDatum testID={props.testID ? `${props.testID}-datum-${interval.id}` : undefined}
                    datum={interval.datum ?? { label: interval.label, value: describe(interval), color }}
                    renderTrigger={interaction => <HappierPressable testID={props.testID ? `${props.testID}-select-${interval.id}` : undefined}
                  accessibilityRole="button" accessibilityLabel={describe(interval)} selected={selectedId === interval.id}
                  hitSlop={{ top: trackGap / 2, bottom: trackGap / 2 }}
                  hitReach={{ top: trackGap / 2, bottom: trackGap / 2, left: 0, right: 0 }}
                  onPress={() => { setSelectedId(interval.id); interaction.onPress(); }} onHoverChange={interaction.onHoverChange}
                  onFocusChange={(focused) => { if (focused) setSelectedId(interval.id); interaction.onFocusChange(focused); }}
                  style={{ height: trackHeight }} />}><View /></ChartDatum></View>}
              </Fragment>;
            })}
          </View>;
          })}
        </View>
      </View>) : props.intervals.map((interval) => {
        const { start, end, span } = marksOf(interval);
        const color = interval.color ?? props.theme.colors.info;
        const visual = <View aria-hidden importantForAccessibility="no-hide-descendants">
            <HappierText style={text.caption}>{interval.label}</HappierText>
            <View style={{ height: HAPPIER_DATA_METRICS.proportionHeightPx, marginTop: HAPPIER_DATA_METRICS.axisGapPx }}>
              <View style={{ position: 'absolute', left: 0, right: 0, top: 0, height: 1, backgroundColor: props.theme.colors.divider }} />
              {span !== null ? <View
                testID={props.testID ? `${props.testID}-interval-${interval.id}` : undefined}
                style={{ position: 'absolute', left: `${span.from * 100}%`, width: `${(span.to - span.from) * 100}%`,
                  height: HAPPIER_DATA_METRICS.proportionHeightPx, borderRadius: HAPPIER_DATA_METRICS.barRadiusPx, overflow: 'hidden', backgroundColor: color }}>
                {interval.pattern === 'hatched' ? <HappierDataHatch theme={props.theme} /> : null}
              </View> : null}
              {start !== null ? <View testID={props.testID ? `${props.testID}-start-${interval.id}` : undefined}
                style={{ position: 'absolute', left: `${start * 100}%`, ...(props.renderMarker ? {} : {
                  width: HAPPIER_DATA_METRICS.lineStrokePx, height: HAPPIER_DATA_METRICS.proportionHeightPx, backgroundColor: color }) }}>
                {props.renderMarker?.(interval)}
              </View> : null}
              {end !== null ? <View testID={props.testID ? `${props.testID}-end-${interval.id}` : undefined}
                style={{ position: 'absolute', left: `${end * 100}%`, width: HAPPIER_DATA_METRICS.lineStrokePx,
                  height: HAPPIER_DATA_METRICS.proportionHeightPx, backgroundColor: color }} /> : null}
            </View>
          </View>;
        return <ChartDatum key={interval.id} testID={props.testID ? `${props.testID}-datum-${interval.id}` : undefined}
          datum={interval.datum ?? { label: interval.label, value: describe(interval), color }}
          renderTrigger={interaction => <HappierPressable testID={props.testID ? `${props.testID}-select-${interval.id}` : undefined}
          accessibilityRole="button" accessibilityLabel={describe(interval)} selected={selectedId === interval.id}
          onPress={() => { setSelectedId(interval.id); interaction.onPress(); }} onHoverChange={interaction.onHoverChange}
          onFocusChange={(focused) => { if (focused) setSelectedId(interval.id); interaction.onFocusChange(focused); }}
          hitReach={{ top: 0, bottom: 0 }}
          style={{ minHeight: rowHeight, justifyContent: 'center' }}>
          {visual}
        </HappierPressable>}>{visual}</ChartDatum>;
      })}
      <View aria-hidden importantForAccessibility="no-hide-descendants" testID={props.testID ? `${props.testID}-axis` : undefined}
        style={{ flexDirection: 'row', justifyContent: 'space-between',
          marginLeft: lanesLayout && sideLabels ? HAPPIER_DATA_METRICS.laneLabelWidthPx + HAPPIER_DATA_METRICS.blockGapPx : 0 }}>
        <HappierText style={text.caption} tabularNumbers>{axisStart}</HappierText>
        {/* Centred on its position: a label box of its own width, pulled back by half (a zero-width box clips the text). */}
        {axisTicks.map((tick) => <View key={tick.value} style={{ position: 'absolute', left: `${tick.fraction * 100}%`, width: tick.width,
          marginLeft: -tick.width / 2, alignItems: 'center' }}>
          <HappierText style={{ ...text.caption, textAlign: 'center' }} numberOfLines={1} tabularNumbers>{tick.label}</HappierText>
        </View>)}
        <HappierText style={text.caption} tabularNumbers>{axisEnd}</HappierText>
      </View>
    </View> : null}
    {selected ? <HappierText testID={props.testID ? `${props.testID}-readout` : undefined} style={text.captionStrong}
      accessibilityLiveRegion="polite" tabularNumbers>{describe(selected)}</HappierText> : null}
    {/* The plot already lists every interval as a selectable row; its exact table waits behind Details
        (as in StackedSeriesChart) instead of repeating the same runs as text. Without a plot the rows are the body. */}
    {showPlot ? <HappierPressable testID={props.testID ? `${props.testID}-values-toggle` : undefined}
      accessibilityLabel={valuesExpanded ? collapseLabel : valuesLabel}
      expanded={valuesExpanded} onPress={() => setValuesExpanded((value) => !value)}>
      <HappierText style={text.captionStrong}>{valuesExpanded ? collapseLabel : valuesLabel}</HappierText>
    </HappierPressable> : null}
    {showPlot && !valuesExpanded ? null : <HappierDataRows theme={props.theme} label={props.label} testID={props.testID ? `${props.testID}-values` : undefined}
      density={props.size === 'inline' || props.size === 'tile' ? 'compact' : 'comfortable'}
      rowIds={props.intervals.map((interval) => interval.id)}
      renderRow={(_row, visual, index) => {
        const interval = props.intervals[index]!;
        return interval.datum ? <ChartDatum datum={interval.datum}
          testID={props.testID ? `${props.testID}-values-datum-${interval.id}` : undefined}>{visual}</ChartDatum> : visual;
      }}
      columns={[...(lanesLayout ? [{ label: props.laneLabel ?? '' }] : []), { label: props.label }, { label: startLabel }, ...(hasIntervals ? [{ label: endLabel }] : []), { label: 'Annotation' }]}
      rows={props.intervals.map(rowValues)} />}
  </View>;
}
