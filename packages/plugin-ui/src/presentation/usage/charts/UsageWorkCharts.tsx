import type { ReactNode } from 'react';
import { View } from 'react-native';
import { Circle, G, Path, Rect } from 'react-native-svg';

import { HappierText } from '../../text/Text.js';
import { ChartDrawing, ChartMark } from '../../data/ChartDatum.js';
import { formatHappierDataValue, formatHappierDataValueWithPrecision } from '../../data/dataModel.js';
import {
  UsageDecorativeSvg as Svg,
  UsageChartCaption, UsageChartColumn, UsageChartValues, resolveUsageChartInk, usageChartMix, usageChartRound as r1, usageSmoothPath,
  useUsageChartSvgText, useUsageChartWidth, type UsageChartAgent, type UsageChartBaseProps, type UsageChartValuesLabels,
} from './chartKit.js';
import type { UsagePlanetSlot } from './usagePlanetSlot.js';

const agentOf = (agents: readonly UsageChartAgent[], id: string | null) => id === null ? undefined : agents.find((agent) => agent.id === id);

/* ═════ Your planet (new body): a data portrait, each visual property a labelled figure ═════ */

export type UsagePortraitModel = Readonly<{
  /** Each input is absent when it is not known or not shared; its property then rests at its neutral value. */
  activeDays?: Readonly<{ active: number; of: number }>;
  peakParallel?: number;
  streak?: Readonly<{ current: number; best: number | null }>;
}>;
export type UsagePortraitLabels = Readonly<{
  rows: Readonly<{ light: string; halo: string; trail: string }>;
  activeDays: (active: number, of: number) => string;
  peak: (count: number) => string;
  streak: (days: number) => string;
  notShared: string;
  lightNote: string; lightRest: string;
  haloNote: string; haloRest: string;
  trailNote: (best: number | null) => string; trailRest: string;
}>;
/** Halo is full at this many turns at once; the label says so ("of 8"). */
const PORTRAIT_HALO_FULL_AT = 8;

const PORTRAIT_NIGHT_SHADE = 0.5;

export function UsagePlanetPortrait(props: UsageChartBaseProps & Readonly<{ model: UsagePortraitModel; labels: UsagePortraitLabels; renderPlanet?: UsagePlanetSlot }>) {
  const [width, onLayout] = useUsageChartWidth(props.width);
  const ink = resolveUsageChartInk(props.theme, props.paint);
  const text = useUsageChartSvgText(props.theme).styles;
  const { model, labels } = props;
  // The figures sit beside the planet down to a half-width page cell (lab `ppalign`); only a phone column stacks them.
  const phone = width !== null && width < 400;
  const size = width !== null && width < 520 ? 180 : 220;
  const rise = model.activeDays ? 0.35 + 0.65 * (model.activeDays.active / Math.max(1, model.activeDays.of)) : 0.68;
  const halo = model.peakParallel !== undefined ? Math.min(1, model.peakParallel / PORTRAIT_HALO_FULL_AT) : 0;
  const tail = model.streak && model.streak.best ? (model.streak.current / model.streak.best) * 0.9 : 0;
  const rows = [
    { key: 'light', name: labels.rows.light, value: model.activeDays ? labels.activeDays(model.activeDays.active, model.activeDays.of) : labels.notShared, note: model.activeDays ? labels.lightNote : labels.lightRest },
    { key: 'halo', name: labels.rows.halo, value: model.peakParallel !== undefined ? labels.peak(model.peakParallel) : labels.notShared, note: model.peakParallel !== undefined ? labels.haloNote : labels.haloRest },
    { key: 'trail', name: labels.rows.trail, value: model.streak ? labels.streak(model.streak.current) : labels.notShared, note: model.streak ? labels.trailNote(model.streak.best) : labels.trailRest },
  ];
  return <View testID={props.testID} onLayout={onLayout} style={{ flexDirection: phone ? 'column' : 'row', alignItems: phone ? 'stretch' : 'center', gap: 20, minWidth: 0 }}>
    <ChartDrawing accessibilityLabel={props.label} style={{ width: size, height: size, alignSelf: 'center' }}>
      {/* The night side keeps a soft shade: a few active days light a sliver of a whole planet, never a stray fragment. */}
      {props.renderPlanet?.({ size, radius: size * 0.3, halo, tail, rise, night: PORTRAIT_NIGHT_SHADE, rotate: -0.7, style: 'rich' })}
      <ChartMark testID={props.testID ? `${props.testID}-portrait` : undefined} bounds={{ x: 0, y: 0, width: size, height: size }}
        datum={{ label: props.label, value: rows.map(row => `${row.name}: ${row.value}`).join(' · '), color: props.paint.accent }} />
    </ChartDrawing>
    <View style={{ flex: phone ? undefined : 1, minWidth: 0 }}>
      {rows.map((row, index) => <View key={row.key} style={{ flexDirection: 'row', gap: 16, paddingVertical: 10, borderTopWidth: index === 0 ? 0 : 1, borderColor: ink.grid }}>
        <HappierText style={{ ...text.body, color: props.theme.colors.mutedText, width: 48 }}>{row.name}</HappierText>
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <HappierText tabularNumbers style={text.strong}>{row.value}</HappierText>
          <HappierText style={text.caption}>{row.note}</HappierText>
        </View>
      </View>)}
    </View>
  </View>;
}

/* ═════ Personal records (Recap · Style Personal records): in-period observed bests ═════ */

export type UsageRecordsModel = readonly Readonly<{ id: string; title: string; detail: string; value: string }>[];

export function UsagePersonalRecords(props: UsageChartBaseProps & Readonly<{ model: UsageRecordsModel; caption: string }>) {
  const ink = resolveUsageChartInk(props.theme, props.paint);
  const text = useUsageChartSvgText(props.theme).styles;
  return <UsageChartColumn testID={props.testID}>
    <View accessibilityLabel={props.label}>
      {props.model.map((record, index) => <View key={record.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10, borderTopWidth: index === 0 ? 0 : 1, borderColor: ink.grid }}>
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <HappierText style={text.strong}>{record.title}</HappierText>
          <HappierText style={text.caption}>{record.detail}</HappierText>
        </View>
        <HappierText tabularNumbers style={text.strong}>{record.value}</HappierText>
      </View>)}
    </View>
    <UsageChartCaption theme={props.theme}>{props.caption}</UsageChartCaption>
  </UsageChartColumn>;
}

/* ═════ Steering by Agent (Human loop · Style tide): accepted steers by hour per Agent, phone answers as dots ═════ */

export type UsageSteeringTideModel = Readonly<{
  /** The owner's Night shift window, drawn as a quiet wash; null when not set. */
  night: Readonly<{ fromHour: number; toHour: number }> | null;
  rows: readonly Readonly<{
    agentId: string | null;
    /** Accepted steers in each hour of the day (24). */
    steersByHour: readonly (number | null)[];
    /** Permission answers given from a phone (iOS/Android) in each hour (24). */
    phoneAnswersByHour: readonly (number | null)[];
    steers: number | null; busyMs: number | null; perBusyHour: number | null; phoneAnswers: number | null;
  }>[];
}>;
export type UsageSteeringTideLabels = Readonly<{
  clock: (hour: number) => string; unknownAgent: string;
  perBusyHourHeader: string; fromPhoneHeader: string; perBusyHourUnit: string; answers: string;
  rate: (value: number | null) => string; detail: (steers: number | null, busyMs: number | null) => string; count: (value: number | null) => string;
  caption: string;
  /** The one line the Agents nobody steered or answered from a phone fold into ("Not steered: Claude, Codex"). */
  unsteered: (names: readonly string[]) => string;
  values: UsageChartValuesLabels & Readonly<{ agentColumn: string; steersColumn: string }>;
}>;

export function UsageSteeringTide(props: UsageChartBaseProps & Readonly<{ agents: readonly UsageChartAgent[]; model: UsageSteeringTideModel; labels: UsageSteeringTideLabels }>) {
  const [width, onLayout] = useUsageChartWidth(props.width);
  const ink = resolveUsageChartInk(props.theme, props.paint);
  const svgText = useUsageChartSvgText(props.theme);
  const text = svgText.styles;
  const phone = width !== null && width < 720;
  // Only the Agents someone steered or answered from a phone get a lane; the busy rest fold into one line, and the values
  // keep every Agent (USAGE-ACCEPT 1121 #5: sixteen flat lanes for one steered Agent).
  const steered = (row: UsageSteeringTideModel['rows'][number]) => (row.steers ?? 0) > 0 || (row.phoneAnswers ?? 0) > 0;
  const rows = props.model.rows.some(steered) ? props.model.rows.filter(steered) : props.model.rows;
  const folded = props.model.rows.filter((row) => !rows.includes(row));
  const rowHeight = phone ? 46 : 52;
  const height = rows.length * rowHeight + 22;
  const figuresWidth = phone ? 0 : 300;
  const name = (id: string | null) => agentOf(props.agents, id)?.shortName ?? agentOf(props.agents, id)?.name ?? (id ?? props.labels.unknownAgent);
  const colour = (id: string | null) => agentOf(props.agents, id)?.color ?? ink.neutral;
  const max = Math.max(1, ...rows.flatMap((row) => row.steersByHour.filter((value): value is number => value !== null)));
  const chartWidth = width === null ? 0 : phone ? width : width - figuresWidth - 24;
  const axis = phone ? 0 : 98;
  const plot = chartWidth - axis;
  const night = props.model.night;
  const nightSpans = !night ? [] : night.fromHour > night.toHour ? [[0, night.toHour], [night.fromHour, 24]] : [[night.fromHour, night.toHour]];
  const wash = usageChartMix(props.theme.colors.text, props.paint.paper, 0.04);
  const maxRate = Math.max(1, ...rows.map((row) => row.perBusyHour ?? 0));
  return <UsageChartColumn testID={props.testID} onLayout={onLayout}>
    <View style={{ flexDirection: 'row', gap: 24 }}>
      <ChartDrawing style={{ height, width: chartWidth || undefined }} accessibilityLabel={props.label}>
        {width !== null ? <Svg width={chartWidth} height={height}>
          {nightSpans.map(([from, to], index) => <Rect key={`n${index}`} x={r1(axis + (from! / 24) * plot)} y={0} width={r1(((to! - from!) / 24) * plot)} height={height - 18} rx={6} fill={wash} />)}
          {rows.map((row, index) => {
            const base = (index + 1) * rowHeight - 6, amplitude = rowHeight * 0.72;
            const points = row.steersByHour.map((value, hour) => [axis + ((hour + 0.5) / 24) * plot, base - Math.pow((value ?? 0) / max, 0.6) * amplitude] as const);
            // Missing input observations have no curve, rather than a measured zero line.
            const curve = row.steersByHour.some(value => value !== null) ? usageSmoothPath(points) : null;
            return <G key={row.agentId ?? 'unknown'}>
              {curve ? <Path d={`${curve}L${r1(axis + (23.5 / 24) * plot)},${base}L${r1(axis + (0.5 / 24) * plot)},${base}Z`} fill={colour(row.agentId)} fillOpacity={0.14} /> : null}
              {curve ? <Path d={curve} fill="none" stroke={colour(row.agentId)} strokeWidth={1.4} /> : null}
              <Path d={`M${axis},${base}H${axis + plot}`} stroke={ink.base} strokeWidth={1} />
              {row.phoneAnswersByHour.flatMap((answers, hour) => Array.from({ length: answers === null ? 0 : Math.min(4, Math.round(answers / 2)) }, (_, j) =>
                <Circle key={`${hour}-${j}`} cx={r1(points[hour]![0])} cy={r1(points[hour]![1] - 5 - j * 4.4)} r={1.6} fill={ink.text} fillOpacity={0.7} />))}
              {phone ? svgText.draw({ x: 4, y: base - amplitude + 6, text: name(row.agentId), tone: 'strong', size: 'body', halo: props.paint.paper })
                : svgText.draw({ x: 0, y: base - 6, text: name(row.agentId), tone: 'strong', size: 'body' })}
            </G>;
          })}
          {[0, 6, 12, 18].map((hour) => svgText.draw({ x: axis + (hour / 24) * plot, y: height - 3, text: props.labels.clock(hour) }, `t${hour}`))}
        </Svg> : null}
        {width !== null ? rows.flatMap((row, index) => row.steersByHour.map((steers, hour) => {
          const answers = row.phoneAnswersByHour[hour] ?? null;
          if (steers === null && answers === null) return null;
          return <ChartMark key={`${row.agentId ?? 'unknown'}-${hour}`} testID={props.testID ? `${props.testID}-hour-${index}-${hour}` : undefined}
            bounds={{ x: axis + hour / 24 * plot, y: index * rowHeight, width: plot / 24, height: rowHeight }}
            datum={{ keyboard: false, label: `${props.label} · ${name(row.agentId)} · ${props.labels.clock(hour)}`, value: props.labels.count(steers),
              subtitle: `${props.labels.fromPhoneHeader}: ${props.labels.count(answers)}`, color: colour(row.agentId) }} />;
        })) : null}
      </ChartDrawing>
      {!phone && width !== null ? <View style={{ width: figuresWidth }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 }}>
          <HappierText style={text.caption}>{props.labels.perBusyHourHeader}</HappierText>
          <HappierText style={text.caption}>{props.labels.fromPhoneHeader}</HappierText>
        </View>
        {rows.map((row) => <View key={row.agentId ?? 'unknown'} style={{ height: rowHeight, flexDirection: 'row', alignItems: 'center', gap: 10, borderTopWidth: 1, borderColor: ink.grid }}>
          <HappierText tabularNumbers style={{ ...text.strong, width: 32 }}>{props.labels.rate(row.perBusyHour)}</HappierText>
          <View style={{ flex: 1, gap: 4 }}>
            <View style={{ height: 4, borderRadius: 2, backgroundColor: ink.track, overflow: 'hidden' }}>
              {row.perBusyHour !== null ? <View style={{ width: `${Math.round(Math.min(1, row.perBusyHour / maxRate) * 100)}%`, height: 4, borderRadius: 2, backgroundColor: colour(row.agentId) }} /> : null}
            </View>
            <HappierText style={text.caption} numberOfLines={1}>{props.labels.detail(row.steers, row.busyMs)}</HappierText>
          </View>
          <View style={{ alignItems: 'flex-end', minWidth: 52 }}>
            <HappierText tabularNumbers style={text.strong}>{props.labels.count(row.phoneAnswers)}</HappierText>
            <HappierText style={text.caption}>{props.labels.answers}</HappierText>
          </View>
        </View>)}
      </View> : null}
    </View>
    {phone ? <View>{rows.map((row) => <View key={row.agentId ?? 'unknown'} style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8, paddingVertical: 6, borderTopWidth: 1, borderColor: ink.grid }}>
      <HappierText style={{ ...text.body, flex: 1 }}>{name(row.agentId)}</HappierText>
      <HappierText tabularNumbers style={text.strong}>{props.labels.rate(row.perBusyHour)}</HappierText>
      <HappierText style={text.caption}>{props.labels.perBusyHourUnit}</HappierText>
    </View>)}</View> : null}
    {folded.length ? <HappierText style={text.caption} testID={props.testID ? `${props.testID}-unsteered` : undefined}>
      {props.labels.unsteered(folded.map((row) => name(row.agentId)))}</HappierText> : null}
    <UsageChartCaption theme={props.theme}>{props.labels.caption}</UsageChartCaption>
    <UsageChartValues theme={props.theme} label={props.label} labels={props.labels.values} testID={props.testID}
      table={{ columns: [{ label: props.labels.values.agentColumn }, { label: props.labels.values.steersColumn }, { label: props.labels.fromPhoneHeader }],
        rows: props.model.rows.flatMap(row => row.steersByHour.map((steers, hour) => [
          `${name(row.agentId)} · ${props.labels.clock(hour)}`, props.labels.count(steers), props.labels.count(row.phoneAnswersByHour[hour] ?? null),
        ])) }} />
  </UsageChartColumn>;
}

/* ═════ Run length (new body): closed-turn wall time per Agent, its distribution, median and p90 ═════ */

export type UsageRunLengthModel = Readonly<{
  rows: readonly Readonly<{ agentId: string | null; samples: number; medianMs: number; p90Ms: number; durationsMs: readonly number[] }>[];
  openCount: number | null;
  croppedCount: number | null;
}>;
export type UsageRunLengthLabels = Readonly<{
  duration: (ms: number) => string; unknownAgent: string;
  /** "p90 38 min · 18,420". */
  detail: (p90Ms: number, samples: number) => string;
  ticks: Readonly<{ minute: string; tenMinutes: string; hour: string; fourHours: string }>;
  caption: string;
  values: UsageChartValuesLabels & Readonly<{ agentColumn: string; medianColumn: string; p90Column: string; samplesColumn: string; formatCount: (count: number) => string }>;
}>;
const RUN_MIN_MS = 20_000;
const RUN_MAX_MS = 4 * 3_600_000;
/** Dots sit in columns of this width; a busier column stacks its dots outward from the row's centre line. */
const RUN_COLUMN_PX = 4.2;
/** A row shows its distribution as this many equal-share dots (the lab's 1 in 40); fewer turns show one dot each. */
const RUN_DOTS_PER_ROW = 40;

export function UsageRunLength(props: UsageChartBaseProps & Readonly<{ agents: readonly UsageChartAgent[]; model: UsageRunLengthModel; labels: UsageRunLengthLabels }>) {
  const [width, onLayout] = useUsageChartWidth(props.width);
  const ink = resolveUsageChartInk(props.theme, props.paint);
  const svgText = useUsageChartSvgText(props.theme);
  const rows = props.model.rows;
  const rowHeight = 34;
  const height = rows.length * rowHeight + 24;
  const name = (id: string | null) => agentOf(props.agents, id)?.shortName ?? agentOf(props.agents, id)?.name ?? (id ?? props.labels.unknownAgent);
  // Names keep a left column and median, p90 and count a right one at every width (the lab's anatomy); a narrow card
  // trims both columns to what its own labels need, so the distribution never sits under text.
  const narrow = width !== null && width < 460;
  // Names are drawn semibold in the body role; the column fits the longest one (up to a third of a narrow card,
  // a quarter of a wide one) so a long Agent name never runs into the distribution.
  const textWidth = (value: string, size: number | undefined, factor = 0.56) => value.length * (size ?? 13) * factor;
  const nameWidth = Math.ceil(Math.max(0, ...rows.map((row) => textWidth(name(row.agentId), svgText.styles.body.fontSize, 0.62))) + 12);
  const label = width === null ? 92 : narrow ? Math.min(Math.round(width / 3), Math.max(56, nameWidth)) : Math.max(92, Math.min(Math.round(width / 4), nameWidth));
  const right = narrow ? Math.min(150, Math.max(84, Math.ceil(Math.max(0, ...rows.map((row) => textWidth(props.labels.detail(row.p90Ms, row.samples), svgText.fontSize))) + 10))) : 150;
  const colour = (id: string | null) => agentOf(props.agents, id)?.color ?? ink.neutral;
  const exactDuration = (ms: number) => formatHappierDataValueWithPrecision(`${formatHappierDataValue(ms, svgText.styles.locale)} ms`, props.labels.duration(ms));
  const table = rows.map((row) => [agentOf(props.agents, row.agentId)?.name ?? name(row.agentId), exactDuration(row.medianMs), exactDuration(row.p90Ms),
    props.labels.values.formatCount(row.samples), row.durationsMs.join(', ')] as const);
  return <UsageChartColumn testID={props.testID} onLayout={onLayout}>
    <ChartDrawing style={{ height }} accessibilityLabel={props.label}>
      {width !== null ? (() => {
        const plot = width - label - right;
        const lo = Math.log(RUN_MIN_MS), hi = Math.log(RUN_MAX_MS);
        const x = (ms: number) => label + ((Math.log(Math.max(RUN_MIN_MS, Math.min(RUN_MAX_MS, ms))) - lo) / (hi - lo)) * plot;
        const ticks = [[60_000, props.labels.ticks.minute], [600_000, props.labels.ticks.tenMinutes], [3_600_000, props.labels.ticks.hour], [RUN_MAX_MS, props.labels.ticks.fourHours]] as const;
        // A tick label that would print into the next one keeps its rule and leaves its words to the closer tick: on a phone
        // "1 h" and "4 h" sit 27 px apart and read "1 h4 h" (USAGE-ACCEPT 1121 #17). The end tick always keeps its label.
        const tickSpan = (ms: number, text: string) => {
          const reach = textWidth(text, svgText.fontSize);
          return ms === RUN_MAX_MS ? [x(ms) - reach, x(ms)] : [x(ms) - reach / 2, x(ms) + reach / 2];
        };
        const labelled = ticks.map(([ms, text], at) => {
          const next = ticks[at + 1];
          return !next || tickSpan(ms, text)[1]! + 4 <= tickSpan(next[0], next[1])[0]!;
        });
        // A name wider than its column is cut to it, so it never runs into the distribution; the values keep it whole.
        const fitName = (value: string) => {
          const room = Math.floor((label - 8) / ((svgText.styles.body.fontSize ?? 13) * 0.62));
          return value.length <= room ? value : `${value.slice(0, Math.max(1, room - 1)).trimEnd()}…`;
        };
        const targets: ReactNode[] = [];
        return <><Svg width={width} height={height}>
          {ticks.map(([ms, text], at) => <G key={ms}>
            <Path d={`M${r1(x(ms))},4V${height - 20}`} stroke={ink.grid} strokeWidth={1} />
            {labelled[at] ? svgText.draw({ x: x(ms), y: height - 4, anchor: ms === RUN_MAX_MS ? 'end' : 'middle', text }) : null}
          </G>)}
          {rows.map((row, index) => {
            const cy = index * rowHeight + rowHeight / 2 + 2;
            const stacks = new Map<number, number>();
            // Each dot is an equal share of this Agent's closed turns (its quantiles), so a heavy row reads as a distribution
            // rather than a solid block. Every observation counts toward them; none is dropped.
            const sorted = [...row.durationsMs].sort((a, b) => a - b);
            const count = Math.min(sorted.length, RUN_DOTS_PER_ROW);
            const quantiles = Array.from({ length: count }, (_, at) => sorted[Math.min(sorted.length - 1, Math.floor(((at + 0.5) / count) * sorted.length))]!);
            const dots = quantiles.map((ms, dotIndex) => {
              const cx = r1(x(ms)), column = Math.round(cx / RUN_COLUMN_PX), depth = stacks.get(column) ?? 0;
              stacks.set(column, depth + 1);
              const offset = (depth % 2 ? 1 : -1) * Math.ceil(depth / 2) * Math.min(4.4, (rowHeight / 2 - 3) / Math.max(1, Math.ceil(depth / 2)));
              targets.push(<ChartMark key={`dot-${index}-${dotIndex}`} testID={props.testID ? `${props.testID}-duration-${index}-${dotIndex}` : undefined}
                bounds={{ x: cx - RUN_COLUMN_PX / 2, y: r1(cy + offset) - 2.2, width: RUN_COLUMN_PX, height: 4.4 }}
                datum={{ keyboard: false, label: `${props.label} · ${name(row.agentId)}`, value: `${formatHappierDataValue(ms, svgText.styles.locale)} ms`, subtitle: props.labels.duration(ms), color: colour(row.agentId) }} />);
              return <Circle key={dotIndex} cx={cx} cy={r1(cy + offset)} r={1.9} fill={colour(row.agentId)} fillOpacity={0.78} />;
            });
            for (const [kind, ms, title, h] of [['median', row.medianMs, props.labels.values.medianColumn, 20], ['p90', row.p90Ms, props.labels.values.p90Column, 14]] as const) {
              targets.push(<ChartMark key={`${kind}-${index}`} testID={props.testID ? `${props.testID}-${kind}-${index}` : undefined}
                bounds={{ x: r1(x(ms)) - 2, y: cy - h / 2, width: 4, height: h }}
                datum={{ keyboard: false, label: `${props.label} · ${name(row.agentId)} · ${title}`, value: `${formatHappierDataValue(ms, svgText.styles.locale)} ms`, subtitle: props.labels.duration(ms), color: colour(row.agentId) }} />);
            }
            return <G key={row.agentId ?? 'unknown'}>
              {dots}
              <Path d={`M${r1(x(row.medianMs))},${cy - 10}V${cy + 10}`} stroke={ink.text} strokeWidth={2} />
              <Path d={`M${r1(x(row.p90Ms))},${cy - 7}V${cy + 7}`} stroke={ink.text} strokeOpacity={0.45} strokeWidth={1.2} />
              {svgText.draw({ x: 0, y: cy + 4, tone: 'strong', size: 'body', text: fitName(name(row.agentId)) }, 'n')}
              {svgText.draw({ x: width, y: cy - 1, anchor: 'end', tone: 'strong', size: 'body', text: props.labels.duration(row.medianMs) }, 'm')}
              {svgText.draw({ x: width, y: cy + 12, anchor: 'end', text: props.labels.detail(row.p90Ms, row.samples) }, 'd')}
            </G>;
          })}
        </Svg>{targets}</>;
      })() : null}
    </ChartDrawing>
    <UsageChartCaption theme={props.theme}>{props.labels.caption}</UsageChartCaption>
    <UsageChartValues theme={props.theme} label={props.label} labels={props.labels.values} testID={props.testID}
      table={{ columns: [{ label: props.labels.values.agentColumn }, { label: props.labels.values.medianColumn }, { label: props.labels.values.p90Column }, { label: props.labels.values.samplesColumn }, { label: `${props.label} (ms)` }], rows: table }} />
  </UsageChartColumn>;
}
