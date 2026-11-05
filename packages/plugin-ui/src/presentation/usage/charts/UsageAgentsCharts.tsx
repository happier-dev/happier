import { useId, type ReactNode } from 'react';
import { View } from 'react-native';
import { Circle, Defs, Ellipse, G, Marker, Path, Pattern, Rect, Svg } from 'react-native-svg';
import { HAPPIER_WIDGET_FRAME_METRICS } from '../../layout/WidgetFrame.js';

import { HappierText } from '../../text/Text.js';
import { ChartDatum, ChartDrawing, ChartMark, ChartPathMark } from '../../data/ChartDatum.js';
import { formatHappierDataExactShare, formatHappierDataValue } from '../../data/dataModel.js';
import {
  UsageChartCaption, UsageChartColumn, UsageChartKey, UsageChartValues, resolveUsageChartInk, usageChartRound as r1, usageSmoothPath,
  useUsageChartSvgText, useUsageChartWidth, type UsageChartAgent, type UsageChartBaseProps, type UsageChartKeyItem, type UsageChartValuesLabels,
} from './chartKit.js';
import type { UsagePlanetSlot } from './usagePlanetSlot.js';

type AgentsProps = UsageChartBaseProps & Readonly<{ agents: readonly UsageChartAgent[] }>;
const agentOf = (agents: readonly UsageChartAgent[], id: string | null) => agents.find((agent) => agent.id === id);
/** An Agent's display name; a member the owner could not attribute is the host's neutral, localized Unknown. */
const shortName = (agents: readonly UsageChartAgent[], id: string | null, unknown: string) => id === null ? unknown : agentOf(agents, id)?.shortName ?? agentOf(agents, id)?.name ?? id;
const fullName = (agents: readonly UsageChartAgent[], id: string | null, unknown: string) => id === null ? unknown : agentOf(agents, id)?.name ?? id;
const exactPercent = (share: number) => formatHappierDataExactShare(share);

/* ═════ Score (new body): the selected week, a staff line per Agent, equal round dots ═════ */

export type UsageScoreModel = Readonly<{
  /** Monday of the week, ISO date. */
  weekStart: string;
  /** `minutes`: dot strength = busy minutes in that hour (private). `presence`: busy in the hour only. */
  encoding: 'minutes' | 'presence';
  rows: readonly Readonly<{ agentId: string | null; hours: readonly (readonly (number | null)[])[] }>[];
}>;
export type UsageScoreLabels = Readonly<{
  /** "Mon 7". */
  day: (dayIndex: number) => string;
  clock: (hour: number) => string;
  key: Readonly<{ light: string; medium: string; strong: string; presence: string; presenceNote: string }>;
  unknownAgent: string;
  values: UsageChartValuesLabels & Readonly<{ agentColumn: string; dayColumn: string; hoursColumn: string; formatHours: (minutesByHour: readonly (number | null)[]) => string }>;
}>;
const scoreOpacity = (encoding: UsageScoreModel['encoding'], minutes: number) => encoding === 'presence' ? (minutes ? 0.9 : 0)
  : minutes > 40 ? 1 : minutes > 15 ? 0.66 : minutes ? 0.36 : 0;

export function UsageScore(props: AgentsProps & Readonly<{ model: UsageScoreModel; labels: UsageScoreLabels }>) {
  const [width, onLayout] = useUsageChartWidth(props.width);
  const ink = resolveUsageChartInk(props.theme, props.paint);
  const svgText = useUsageChartSvgText(props.theme);
  const phone = width !== null && width < 560;
  const rows = props.model.rows;
  const colour = (id: string | null) => agentOf(props.agents, id)?.color ?? ink.neutral;
  const datum = (row: UsageScoreModel['rows'][number], day: number, hour: number, minutes: number) => ({
    // A minutes value already names its hour ("10:00 18 min"), so its title stops at the day.
    label: props.model.encoding === 'presence'
      ? `${fullName(props.agents, row.agentId, props.labels.unknownAgent)} · ${props.labels.day(day)} · ${props.labels.clock(hour)}`
      : `${fullName(props.agents, row.agentId, props.labels.unknownAgent)} · ${props.labels.day(day)}`,
    value: props.model.encoding === 'presence' ? props.labels.key.presence : props.labels.values.formatHours(row.hours[day]!.map((value, index) => index === hour ? value : null)) || formatHappierDataValue(minutes),
    color: colour(row.agentId),
  });
  const keyItems: UsageChartKeyItem[] = props.model.encoding === 'presence'
    ? [{ id: 'p', label: props.labels.key.presence, swatch: { kind: 'dot', color: ink.text } }]
    : [{ id: 'l', label: props.labels.key.light, swatch: { kind: 'dot', color: ink.neutral } },
      { id: 'm', label: props.labels.key.medium, swatch: { kind: 'dot', color: props.theme.colors.secondaryText } },
      { id: 's', label: props.labels.key.strong, swatch: { kind: 'dot', color: ink.text } }];
  const table = rows.flatMap((row) => row.hours.map((hours, day) => [fullName(props.agents, row.agentId, props.labels.unknownAgent), props.labels.day(day),
    props.labels.values.formatHours(hours)] as const)).filter((row) => row[2] !== '');
  let chart: ReactNode = <View style={{ height: rows.length * 26 + 26 }} />;
  if (width !== null && !phone) {
    const label = 92, plot = width - label, step = plot / 168, rowHeight = 26, height = rows.length * rowHeight + 26, radius = Math.min(2.5, step * 0.4);
    chart = <ChartDrawing style={{ height }} accessibilityLabel={props.label}><Svg width={width} height={height}>
      {Array.from({ length: 8 }, (_, day) => <Path key={`v${day}`} d={`M${r1(label + day * 24 * step)},2V${height - 18}`} stroke={ink.grid} strokeWidth={1} />)}
      {rows.map((row, index) => {
        const y = index * rowHeight + rowHeight / 2 + 2;
        return <G key={JSON.stringify(row.agentId)}>
          <Path d={`M${label},${y}H${width}`} stroke={ink.grid} strokeWidth={1} />
          {svgText.draw({ x: 0, y: y + 4, text: shortName(props.agents, row.agentId, props.labels.unknownAgent), tone: 'secondary', size: 'body' })}
          {row.hours.flatMap((hours, day) => hours.map((minutes, hour) => minutes ? <Circle key={`${day}-${hour}`} cx={r1(label + (day * 24 + hour + 0.5) * step)} cy={y}
            r={r1(radius)} fill={colour(row.agentId)} fillOpacity={scoreOpacity(props.model.encoding, minutes)} /> : null))}
        </G>;
      })}
      {Array.from({ length: 7 }, (_, day) => svgText.draw({ x: label + day * 24 * step + 3, y: height - 4, text: props.labels.day(day) }, `d${day}`))}
    </Svg>{rows.flatMap((row, index) => row.hours.flatMap((hours, day) => hours.map((minutes, hour) => minutes ? <ChartMark key={`${index}-${day}-${hour}`}
      datum={datum(row, day, hour, minutes)} testID={`${props.testID}.hour.${index}.${day}.${hour}`}
      bounds={{ x: label + (day * 24 + hour) * step, y: index * rowHeight + 2, width: step, height: rowHeight }} /> : null)))}</ChartDrawing>;
  } else if (width !== null) {
    // A phone recomposes the week into seven day strips: one row of 24 dots per Agent.
    const label = 34, plot = width - label, step = plot / 24;
    chart = <ChartDrawing accessibilityLabel={props.label} style={{ gap: 4 }}>
      {Array.from({ length: 7 }, (_, day) => {
        const height = 6 + rows.length * 7 + 4;
        return <View key={day} style={{ height }}><Svg width={width} height={height}>
          {svgText.draw({ x: 0, y: 12, text: props.labels.day(day), tone: 'secondary', size: 'body' })}
          {rows.map((row, index) => (row.hours[day] ?? []).map((minutes, hour) => minutes === null ? null : <Circle key={`${index}-${hour}`} cx={r1(label + (hour + 0.5) * step)} cy={6 + index * 7}
            r={2.1} fill={minutes ? colour(row.agentId) : ink.track} fillOpacity={minutes ? scoreOpacity(props.model.encoding, minutes) : 1} />))}
        </Svg>{rows.flatMap((row, index) => (row.hours[day] ?? []).map((minutes, hour) => minutes === null || (props.model.encoding === 'presence' && !minutes) ? null : <ChartMark key={`${index}-${hour}`}
          datum={datum(row, day, hour, minutes)} testID={`${props.testID}.hour.${index}.${day}.${hour}`}
          bounds={{ x: label + hour * step, y: 2.5 + index * 7, width: step, height: 7 }} />))}</View>;
      })}
      <Svg width={width} height={14}>{[0, 6, 12, 18].map((hour) => svgText.draw({ x: label + hour * step, y: 11, text: props.labels.clock(hour) }, `h${hour}`))}</Svg>
    </ChartDrawing>;
  }
  return <UsageChartColumn testID={props.testID} onLayout={onLayout}>
    {chart}
    <UsageChartKey theme={props.theme} items={keyItems} note={props.model.encoding === 'presence' ? props.labels.key.presenceNote : undefined} />
    <UsageChartValues theme={props.theme} label={props.label} labels={props.labels.values} testID={props.testID}
      table={{ columns: [{ label: props.labels.values.agentColumn }, { label: props.labels.values.dayColumn }, { label: props.labels.values.hoursColumn, priority: 'secondary' }], rows: table }} />
  </UsageChartColumn>;
}

/* ═════ Agent mix (Orbit, Crew): every Agent, its share and how it is measured ═════ */

export type UsageAgentShare = Readonly<{
  agentId: string | null;
  /** Null = no measured denominator or not shared: drawn as "—", never a source-method claim. */
  share: number | null;
  /** How this Agent's usage is measured, as the host names it ("Measured · Happier and its logs"). */
  coverage?: Readonly<{ long: string; short: string }>;
  /** Active days, only when the model may say them. */
  activeDays?: number | null;
}>;

export type UsageOrbitLabels = Readonly<{ percent: (share: number) => string; unknown: (names: string) => string; unknownAgent: string }>;

/** Orbit (new body): the closer orbit did more (rank by share); the dot's area is its share; unknown shares sit apart. */
export function UsageOrbit(props: AgentsProps & Readonly<{ model: readonly UsageAgentShare[]; labels: UsageOrbitLabels; renderPlanet?: UsagePlanetSlot }>) {
  const [width, onLayout] = useUsageChartWidth(props.width);
  const ink = resolveUsageChartInk(props.theme, props.paint);
  const svgText = useUsageChartSvgText(props.theme);
  const known = props.model.filter((entry): entry is UsageAgentShare & { share: number } => entry.share !== null).sort((a, b) => b.share - a.share);
  const unknown = props.model.filter((entry) => entry.share === null);
  const height = width !== null && width < 420 ? 240 : 300;
  return <UsageChartColumn testID={props.testID} onLayout={onLayout}>
    <ChartDrawing style={{ height }} accessibilityLabel={props.label}>
      {width !== null ? (() => {
        const cx = width / 2, cy = height / 2 - 8;
        const orbits = Math.max(2, known.length);
        const outer = Math.max(60, Math.min(width / 2 - 72, 260));
        const aspect = Math.min(0.75, Math.max(0.42, (height / 2 - 24) / outer));
        const rx0 = Math.min(width * 0.17, 74), step = (outer - rx0) / (orbits - 1);
        const angles = [-0.12, 3.0, 0.42, 3.62, -0.62, 2.4, 0.95];
        const placed = known.map((entry, index) => {
          const rx = rx0 + index * step, ry = rx * aspect, t = angles[index % angles.length]!;
          const x = cx + rx * Math.cos(t), y = cy + ry * Math.sin(t), radius = 3 + Math.sqrt(entry.share) * 13, right = Math.cos(t) >= 0;
          // A label beside its planet, kept inside the body on a narrow width (it moves to the edge, never off it).
          const text = `${shortName(props.agents, entry.agentId, props.labels.unknownAgent)} ${props.labels.percent(entry.share)}`;
          const span = text.length * (svgText.styles.body.fontSize ?? 13) * 0.7;
          const beside = x + (right ? radius + 6 : -radius - 6);
          return { entry, x, y, radius, text, span, anchor: right ? 'start' as const : 'end' as const,
            at: right ? Math.min(beside, width - span) : Math.max(beside, span) };
        });
        return <>
          <Svg width={width} height={height}>
            {known.map((_, index) => <Ellipse key={`o${index}`} cx={cx} cy={cy} rx={r1(rx0 + index * step)} ry={r1((rx0 + index * step) * aspect)} stroke={ink.grid} strokeWidth={1} fill="none" />)}
            {placed.map(({ entry, x, y, radius }) => <Circle key={JSON.stringify(entry.agentId)} cx={r1(x)} cy={r1(y)} r={r1(radius)} fill={agentOf(props.agents, entry.agentId)?.color ?? ink.neutral} />)}
            {placed.map(({ entry, text, at, anchor }, index) => svgText.draw({ x: at, y: placed[index]!.y + 4, anchor, tone: 'secondary', size: 'body', halo: props.paint.paper, text }, `l${index}-${JSON.stringify(entry.agentId)}`))}
            {unknown.length ? svgText.draw({ x: width, y: height - 4, anchor: 'end', text: props.labels.unknown(unknown.map((entry) => shortName(props.agents, entry.agentId, props.labels.unknownAgent)).join(', ')) }) : null}
          </Svg>
          {placed.map(({ entry, x, y, radius }) => <ChartMark key={JSON.stringify(entry.agentId)} testID={`${props.testID}.agent.${entry.agentId}`}
            datum={{ label: fullName(props.agents, entry.agentId, props.labels.unknownAgent), value: exactPercent(entry.share), color: agentOf(props.agents, entry.agentId)?.color ?? ink.neutral }}
            bounds={{ x: x - radius, y: y - radius, width: radius * 2, height: radius * 2 }} />)}
          {props.renderPlanet ? <View pointerEvents="none" style={{ position: 'absolute', left: r1(cx - 36), top: r1(cy - 36), width: 72, height: 72 }}>
            {props.renderPlanet({ size: 72, radius: 20, halo: 0.5, tail: 0, rise: 1, rotate: -0.6, style: 'rich' })}
          </View> : null}
        </>;
      })() : null}
    </ChartDrawing>
  </UsageChartColumn>;
}

export type UsageCrewLabels = Readonly<{ percent: (share: number) => string; days: (activeDays: number) => string; unknownAgent: string }>;

/** Crew (Breakdowns · Style Crew): every Agent with its share, how it is measured and (when shared) its active days. */
export function UsageCrew(props: AgentsProps & Readonly<{ model: readonly UsageAgentShare[]; labels: UsageCrewLabels }>) {
  const [width, onLayout] = useUsageChartWidth(props.width);
  const ink = resolveUsageChartInk(props.theme, props.paint);
  const svgText = useUsageChartSvgText(props.theme);
  const text = svgText.styles;
  const compact = width !== null && width < 380;
  const showDays = props.model.some((entry) => entry.activeDays !== undefined);
  return <View testID={props.testID} onLayout={onLayout} accessibilityLabel={props.label} style={{ minWidth: 0 }}>
    {props.model.map((entry, index) => {
      const agent = agentOf(props.agents, entry.agentId);
      return <View key={JSON.stringify(entry.agentId)} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 9,
        borderTopWidth: index === 0 ? 0 : 1, borderColor: ink.grid }}>
        <View style={{ width: 18, alignItems: 'center' }}>{entry.agentId === null
          ? <View style={{ width: 8, height: 8, borderRadius: 4, borderWidth: 1.2, borderColor: ink.neutral }} />
          // A host without identity marks (the cold server page) keeps the Agent's colour in the slot.
          : agent?.mark ?? <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: agent?.color ?? ink.neutral }} />}</View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <HappierText style={text.strong} numberOfLines={1}>{compact ? shortName(props.agents, entry.agentId, props.labels.unknownAgent) : fullName(props.agents, entry.agentId, props.labels.unknownAgent)}</HappierText>
          {entry.coverage ? <HappierText style={text.caption} numberOfLines={1}>{compact ? entry.coverage.short : entry.coverage.long}</HappierText> : null}
        </View>
        {!compact ? <View style={{ width: 100, height: 4, borderRadius: 2, backgroundColor: ink.track, overflow: 'hidden' }}>
          {entry.share !== null ? <View style={{ width: `${Math.round(Math.sqrt(entry.share) * 100)}%`, height: 4, borderRadius: 2, backgroundColor: agent?.color ?? ink.neutral }} /> : null}
        </View> : null}
        <ChartDatum datum={{ label: fullName(props.agents, entry.agentId, props.labels.unknownAgent), value: entry.share === null ? '—' : exactPercent(entry.share),
          subtitle: entry.coverage?.long, color: agent?.color ?? ink.neutral }} testID={`${props.testID}.agent.${entry.agentId}`}>
          <HappierText tabularNumbers style={{ ...text.strong, minWidth: 40, textAlign: 'right' }}>{entry.share === null ? '—' : props.labels.percent(entry.share)}</HappierText>
        </ChartDatum>
        {showDays ? <HappierText tabularNumbers style={{ ...text.body, color: props.theme.colors.mutedText, minWidth: compact ? 56 : 88, textAlign: 'right' }}>
          {entry.activeDays === null || entry.activeDays === undefined ? '—' : props.labels.days(entry.activeDays)}</HappierText> : null}
      </View>;
    })}
  </View>;
}

/* ═════ Agent river (Flow · Style Agent river): weekly shares; width = the week's volume or ordinal intensity ═════ */

export type UsageRiverModel = Readonly<{
  /** `amount`: width = the week's metric total; `level`: width = the week's labelled intensity (public), never an amount. */
  width: 'amount' | 'level' | 'share';
  /** Null in composition-only mode: equal width, with no implied weekly amount. */
  weeks: readonly Readonly<{ start: string; end: string; partial: boolean; total: number | null;
    shares: readonly Readonly<{ agentId: string | null; share: number }>[] }>[];
}>;
export type UsageRiverLabels = Readonly<{ week: (start: string) => string; inline: (name: string, share: number) => string; caption: string; unknownAgent: string;
  /** A week the period clips, named by the days it covers ("13–15 Jul · part week"); its shares are of those days only. */
  partialWeek: (start: string, end: string) => string;
  values: UsageChartValuesLabels & Readonly<{ weekColumn: string; totalColumn: string; formatTotal: (total: number) => string; percent: (share: number) => string }> }>;

export function UsageAgentRiver(props: AgentsProps & Readonly<{ model: UsageRiverModel; labels: UsageRiverLabels }>) {
  const [width, onLayout] = useUsageChartWidth(props.width);
  const svgText = useUsageChartSvgText(props.theme);
  const weeks = props.model.weeks;
  const shareOf = (week: UsageRiverModel['weeks'][number], id: string | null) => week.shares.find(entry => entry.agentId === id)?.share ?? 0;
  const weight = (week: UsageRiverModel['weeks'][number]) => props.model.width === 'share' ? 1 : week.total ?? 0;
  const height = width !== null && width < 480 ? 150 : 190;
  // Every member with a share, the unattributed one included (it is part of the composition, never dropped).
  const members: (string | null)[] = [...props.agents.map((agent) => agent.id), ...(weeks.some((week) => shareOf(week, null) > 0) ? [null] : [])];
  const order = members.filter((id) => weeks.some((week) => shareOf(week, id) > 0))
    .sort((a, b) => weeks.reduce((sum, week) => sum + shareOf(week, a) * weight(week), 0) - weeks.reduce((sum, week) => sum + shareOf(week, b) * weight(week), 0));
  const rows = weeks.map((week) => [week.partial ? props.labels.partialWeek(week.start, week.end) : props.labels.week(week.start), week.total === null ? '—' : props.labels.values.formatTotal(week.total),
    ...order.slice().reverse().map((id) => props.labels.values.percent(shareOf(week, id)))] as const);
  return <UsageChartColumn testID={props.testID} onLayout={onLayout}>
    <ChartDrawing style={{ height }} accessibilityLabel={props.label}>
      {width !== null && weeks.length >= 2 ? (() => {
        const max = Math.max(...weeks.map(weight)) || 1;
        const mid = (height - 20) / 2, half = mid - 6, x = (index: number) => 4 + (index / (weeks.length - 1)) * (width - 8);
        let floor = weeks.map((week) => -(weight(week) / max) * half);
        const bands = order.map((id) => {
          const low = floor.slice();
          const high = weeks.map((week, index) => low[index]! + (shareOf(week, id) * weight(week) / max) * half * 2);
          floor = high;
          const top = high.map((value, index) => [x(index), mid - value] as const);
          const bottom = low.map((value, index) => [x(index), mid - value] as const).reverse();
          const d = `${usageSmoothPath(top)}L${r1(bottom[0]![0])},${r1(bottom[0]![1])}${usageSmoothPath(bottom).replace(/^M[^C]*/u, '')}Z`;
          return { id, low, high, d };
        });
        const colour = (id: string | null) => agentOf(props.agents, id)?.color ?? props.theme.colors.mutedText;
        const leaders = order.slice(-2).reverse();
        return <><Svg width={width} height={height}>
          {bands.map((band) => <Path key={band.id ?? "unknown"} d={band.d} fill={colour(band.id)} fillOpacity={0.9} />)}
          {(() => {
            // Each leading Agent is named where its band is thickest (never the same week twice), kept inside the plot.
            const used = new Set<number>();
            return leaders.map((id) => {
              const band = bands.find((entry) => entry.id === id);
              if (!band) return null;
              let index = -1;
              // Interior weeks are preferred: a label at either end of the river sits against the plot's edge.
              const room = (at: number) => (band.high[at]! - band.low[at]!) * (weeks.length > 2 && (at === 0 || at === weeks.length - 1) ? 0.6 : 1);
              for (let at = 0; at < weeks.length; at++) if (!used.has(at) && (index < 0 || room(at) > room(index))) index = at;
              if (index < 0 || band.high[index]! - band.low[index]! < 16) return null;
              used.add(index);
              const text = props.labels.inline(shortName(props.agents, id, props.labels.unknownAgent), shareOf(weeks[index]!, id));
              // The label is drawn semibold in the body role; it keeps the card's inset from either edge of the river.
              const half = (text.length * (svgText.styles.body.fontSize ?? 13) * 0.66) / 2;
              const inset = HAPPIER_WIDGET_FRAME_METRICS.cardInsetPx;
              const y = mid - (band.low[index]! + band.high[index]!) / 2;
              return <G key={`l${id ?? "unknown"}`}>{svgText.draw({ x: Math.min(width - half - inset, Math.max(half + inset, x(index))), y: y + 4, anchor: 'middle', tone: 'onMark', size: 'body', text })}</G>;
            });
          })()}
          {weeks.map((week, index) => index % 3 === 0 || index === weeks.length - 1 ? svgText.draw({ x: x(index), y: height - 3,
            anchor: index === weeks.length - 1 ? 'end' : index === 0 ? 'start' : 'middle', text: props.labels.week(week.start) }, `w${index}`) : null)}
        </Svg>{bands.flatMap((band) => weeks.map((week, index) => {
          const left = index === 0 ? 0 : (x(index - 1) + x(index)) / 2;
          const right = index === weeks.length - 1 ? width : (x(index) + x(index + 1)) / 2;
          return <ChartPathMark key={`${band.id}-${index}`} testID={`${props.testID}.week.${index}.${band.id}`} d={band.d} strokeWidth={0} hitMode="fill"
            datum={{ label: `${fullName(props.agents, band.id, props.labels.unknownAgent)} · ${week.partial ? props.labels.partialWeek(week.start, week.end) : props.labels.week(week.start)}`,
              value: exactPercent(shareOf(week, band.id)), subtitle: week.total === null ? undefined : `${props.labels.values.totalColumn}: ${formatHappierDataValue(week.total)} · ${props.labels.values.formatTotal(week.total)}`, color: colour(band.id) }}
            bounds={{ x: left, y: 0, width: right - left, height }}
            focusBounds={{ x: left, y: mid - band.high[index]!, width: right - left, height: band.high[index]! - band.low[index]! }} />;
        }))}</>;
      })() : null}
    </ChartDrawing>
    <UsageChartCaption theme={props.theme}>{props.labels.caption}</UsageChartCaption>
    <UsageChartValues theme={props.theme} label={props.label} labels={props.labels.values} testID={props.testID}
      table={{ columns: [{ label: props.labels.values.weekColumn }, { label: props.labels.values.totalColumn },
        ...order.slice().reverse().map((id) => ({ label: shortName(props.agents, id, props.labels.unknownAgent), priority: 'secondary' as const }))], rows }} />
  </UsageChartColumn>;
}

/* ═════ Shipped (Outcomes · Style Shipped): merged pull requests on a shelf ═════ */

export type UsageShippedModel =
  /** Private: one spine per merged PR in its merge week, coloured by its leading Agent (`mixed` below the lead share). */
  | Readonly<{ mode: 'weeks'; weeks: readonly Readonly<{ start: string; spines: readonly (string | 'mixed')[] }>[]; undated: number; total: number }>
  /** Public or no merge dates: the count only, one anonymous shelf. */
  | Readonly<{ mode: 'count'; total: number }>;
export type UsageShippedLabels = Readonly<{ week: (start: string) => string; noDate: string; countLine: (total: number) => string; mixed: string; noMergeDate: string;
  colourBy: 'agent' | 'accent' }>;

export function UsageShipped(props: AgentsProps & Readonly<{ model: UsageShippedModel; labels: UsageShippedLabels }>) {
  const [width, onLayout] = useUsageChartWidth(props.width);
  const ink = resolveUsageChartInk(props.theme, props.paint);
  const svgText = useUsageChartSvgText(props.theme);
  const height = 120;
  const bottom = height - 18;
  const model = props.model;
  const spineInk = props.paint.accent;
  const mix = `usage-shipped-mix-${useId().replace(/[^a-zA-Z0-9_-]/gu, '')}`;
  const counts = new Map<string, number>();
  if (model.mode === 'weeks') for (const week of model.weeks) for (const spine of week.spines) counts.set(spine, (counts.get(spine) ?? 0) + 1);
  const byAgent = model.mode === 'weeks' && props.labels.colourBy === 'agent';
  const marks: ReactNode[] = [];
  const keyItems: UsageChartKeyItem[] = model.mode === 'weeks' ? [
    ...(byAgent ? props.agents.filter((agent) => counts.get(agent.id)).map((agent) => ({ id: agent.id, label: agent.shortName ?? agent.name, value: String(counts.get(agent.id)), swatch: { kind: 'dot' as const, color: agent.color } })) : []),
    ...(byAgent ? [{ id: 'mixed', label: props.labels.mixed, value: String(counts.get('mixed') ?? 0), swatch: { kind: 'split' as const, colors: [props.agents[0]?.color ?? ink.neutral, props.agents[1]?.color ?? ink.neutral] as const } }] : []),
    { id: 'undated', label: props.labels.noMergeDate, value: String(model.undated), swatch: { kind: 'hatch', color: ink.neutral } },
  ] : [];
  // Nothing merged is a statement, not a drawing: no axis over an empty shelf.
  if (model.total === 0) return <UsageChartColumn testID={props.testID} onLayout={onLayout}>
    <HappierText style={svgText.styles.body}>{props.labels.countLine(0)}</HappierText>
  </UsageChartColumn>;
  return <UsageChartColumn testID={props.testID} onLayout={onLayout}>
    <ChartDrawing style={{ height }} accessibilityLabel={props.label}>
      {width !== null ? <Svg width={width} height={height}>
        <Defs>
          <Pattern id={mix} width={5} height={5} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <Rect width={5} height={5} fill={props.agents[0]?.color ?? ink.neutral} /><Rect width={2.5} height={5} fill={props.agents[1]?.color ?? ink.neutral} />
          </Pattern>
        </Defs>
        {model.mode === 'count' ? (() => {
          const n = model.total, spine = Math.max(3, Math.min(9, (width - 4) / Math.max(1, n) - 2.5));
          const perRow = Math.max(1, Math.floor((width - 4) / (spine + 2.5))), rows = Math.max(1, Math.ceil(n / perRow)), per = Math.ceil(n / rows), rowHeight = Math.min(46, (bottom - 4) / rows);
          return [...Array.from({ length: n }, (_, index) => {
            const row = Math.floor(index / per), column = index % per, h = rowHeight * (0.72 + ((index * 7) % 5) * 0.06);
            return <Rect key={index} x={r1(column * (spine + 2.5))} y={r1(bottom - row * (rowHeight + 6) - h)} width={r1(spine)} height={r1(h)} rx={1} fill={spineInk} />;
          }), <Path key="base" d={`M0,${bottom + 0.5}H${width}`} stroke={ink.base} strokeWidth={1} />,
          svgText.draw({ x: 0, y: height - 3, text: props.labels.countLine(n) }, 'count')];
        })() : (() => {
          const n = Math.max(1, model.weeks.length), gap = 6, tail = 54, column = (width - tail - gap * n) / n, unit = Math.min(20, (bottom - 10) / 7);
          const colour = (spine: string) => !byAgent ? spineInk : spine === 'mixed' ? `url(#${mix})` : agentOf(props.agents, spine)?.color ?? ink.neutral;
          const out: ReactNode[] = [];
          model.weeks.forEach((week, index) => {
            const x = index * (column + gap);
            week.spines.forEach((spine, j) => {
              const w = Math.max(2.5, Math.min(5, (column - 2) / 7)), h = unit * (0.8 + ((index * 7 + j * 3) % 5) * 0.06) * 3.2;
              out.push(<Rect key={`${index}-${j}`} x={r1(x + j * (w + 1.5))} y={r1(bottom - h)} width={r1(w)} height={r1(h)} rx={1} fill={colour(spine)} />);
              marks.push(<ChartMark key={`${index}-${j}`} testID={`${props.testID}.spine.${index}.${j}`}
                datum={{ label: byAgent ? `${props.labels.week(week.start)} · ${spine === 'mixed' ? props.labels.mixed : agentOf(props.agents, spine)?.name ?? spine}` : props.labels.week(week.start),
                  value: props.labels.countLine(1), color: spine === 'mixed' ? ink.neutral : byAgent ? agentOf(props.agents, spine)?.color ?? ink.neutral : spineInk }}
                bounds={{ x: x + j * (w + 1.5), y: bottom - h, width: w, height: h }} />);
            });
            if (index % 3 === 0) out.push(svgText.draw({ x, y: height - 3, text: props.labels.week(week.start) }, `w${index}`));
          });
          out.push(<Path key="base" d={`M0,${bottom + 0.5}H${width - tail + 4}`} stroke={ink.base} strokeWidth={1} />);
          const ux = width - tail + 14;
          for (let j = 0; j < model.undated; j++) out.push(<Rect key={`u${j}`} x={ux + (j % 6) * 7} y={r1(bottom - unit * 2.6)} width={4.5} height={r1(unit * 2.6)} rx={1} fill="none" stroke={ink.neutral} strokeDasharray="2 1.5" />);
          if (model.undated > 0) marks.push(<ChartMark key="undated" testID={`${props.testID}.undated`}
            datum={{ label: props.labels.noMergeDate, value: props.labels.countLine(model.undated), color: ink.neutral }}
            bounds={{ x: ux, y: bottom - unit * 2.6, width: Math.min(6, model.undated) * 7, height: unit * 2.6 }} />);
          out.push(svgText.draw({ x: ux - 2, y: height - 3, text: props.labels.noDate }, 'nodate'));
          return out;
        })()}
      </Svg> : null}
      {width !== null && model.mode === 'count' ? <ChartMark testID={`${props.testID}.count`}
        datum={{ label: props.label, value: props.labels.countLine(model.total), color: spineInk }}
        bounds={{ x: 0, y: 0, width, height: bottom }} /> : null}
      {marks}
    </ChartDrawing>
    {keyItems.length ? <UsageChartKey theme={props.theme} items={keyItems} /> : null}
  </UsageChartColumn>;
}

/* ═════ Constellation (new body): how Agents worked together, from witnessed directed typed relations ═════ */

export type UsageCollaborationKind = 'spawn' | 'run' | 'native' | 'review' | 'plan' | 'report' | 'replay' | 'handoff';
export type UsageConstellationModel = Readonly<{
  /** Each Agent's share sizes its planet; null = unknown share (drawn small, never estimated). */
  nodes: readonly Readonly<{ agentId: string | null; share: number | null }>[];
  /** Null = no collaboration summary: nodes only, said plainly; never co-running time as a stand-in. */
  edges: readonly Readonly<{ from: string; to: string; kind: 'session' | 'run' | 'native'; count: number }>[] | null;
  unknownStarts: number | null;
}>;
export type UsageConstellationLabels = Readonly<{ kinds: Readonly<{ session: string; run: string; native: string }>; arrowNote: string;
  unknownStarts: (count: number) => string; nodesOnly: string; unknownAgent: string }>;
const EDGE_DASH = { session: undefined, run: '5 3', native: '1.5 3' } as const;
const CONSTELLATION_SLOTS = 7;

export function UsageConstellation(props: AgentsProps & Readonly<{ model: UsageConstellationModel; labels: UsageConstellationLabels; renderPlanet?: UsagePlanetSlot }>) {
  const [width, onLayout] = useUsageChartWidth(props.width);
  const ink = resolveUsageChartInk(props.theme, props.paint);
  const svgText = useUsageChartSvgText(props.theme);
  // Marker ids are document-global; each drawing owns its own so another edition on the page can't supply its arrows.
  const markerId = `usage-const-${useId().replace(/[^a-zA-Z0-9_-]/gu, '')}`;
  const phone = width !== null && width < 600;
  // Every member is placed. Up to seven sit on the composed slots; more go round one ring, planets scaled to fit.
  const nodes = props.model.nodes;
  const crowded = nodes.length > CONSTELLATION_SLOTS;
  const scale = crowded ? Math.sqrt(CONSTELLATION_SLOTS / nodes.length) : 1;
  const height = crowded ? (phone ? 380 : 360) : phone ? 340 : 330;
  const slots = phone ? [[0.32, 0.3], [0.74, 0.4], [0.3, 0.78], [0.72, 0.82], [0.12, 0.56], [0.86, 0.14], [0.55, 0.6]]
    : [[0.34, 0.4], [0.68, 0.38], [0.5, 0.8], [0.14, 0.74], [0.88, 0.78], [0.12, 0.2], [0.9, 0.16]];
  const colour = (id: string | null) => agentOf(props.agents, id)?.color ?? ink.neutral;
  const keyItems: UsageChartKeyItem[] = props.model.edges ? (['session', 'run', 'native'] as const).map((kind) => ({ id: kind, label: props.labels.kinds[kind],
    swatch: { kind: 'line' as const, color: ink.text, dashed: kind === 'run', dotted: kind === 'native' } })) : [];
  return <UsageChartColumn testID={props.testID} onLayout={onLayout}>
    <ChartDrawing style={{ height }} accessibilityLabel={props.label}>
      {width !== null ? (() => {
        const ring = (index: number) => {
          const angle = -Math.PI / 2 + (index / nodes.length) * 2 * Math.PI;
          return [width / 2 + Math.cos(angle) * width * 0.38, height * 0.46 + Math.sin(angle) * height * 0.36] as const;
        };
        const position = new Map(nodes.map((node, index) => [node.agentId, crowded ? ring(index) : [slots[index]![0]! * width, slots[index]![1]! * height] as const]));
        const radius = (id: string | null) => (9 + Math.sqrt(nodes.find((node) => node.agentId === id)?.share ?? 0.02) * (phone ? 22 : 30)) * scale;
        const edges = (props.model.edges ?? []).filter((edge) => position.has(edge.from) && position.has(edge.to));
        const edgeMarks: ReactNode[] = [];
        return <>
          <Svg width={width} height={height}>
            <Defs>{nodes.map((node) => <Marker key={JSON.stringify(node.agentId)} id={`${markerId}-arrow-${node.agentId}`} viewBox="0 0 8 8" refX={7} refY={4} markerWidth={9} markerHeight={9}
              markerUnits="userSpaceOnUse" orient="auto-start-reverse"><Path d="M0,0L8,4L0,8Z" fill={colour(node.agentId)} /></Marker>)}</Defs>
            {edges.map((edge, index) => {
              const stroke = 1 + Math.sqrt(edge.count) * 0.28;
              const [x1, y1] = position.get(edge.from)!, [x2, y2] = position.get(edge.to)!;
              const datum = { label: `${fullName(props.agents, edge.from, props.labels.unknownAgent)} → ${fullName(props.agents, edge.to, props.labels.unknownAgent)} · ${props.labels.kinds[edge.kind]}`,
                value: formatHappierDataValue(edge.count), color: colour(edge.from) };
              const countWidth = formatHappierDataValue(edge.count).length * (svgText.styles.body.fontSize ?? 13) * 0.7;
              const countHeight = (svgText.styles.body.fontSize ?? 13) * 1.5;
              if (edge.from === edge.to) {
                const r = radius(edge.from);
                const d = `M${r1(x1 - r * 0.75)},${r1(y1 - r * 0.62)}C${r1(x1 - r * 2.4)},${r1(y1 - r * 2.8)} ${r1(x1 + r * 2.4)},${r1(y1 - r * 2.8)} ${r1(x1 + r * 0.75)},${r1(y1 - r * 0.62)}`;
                edgeMarks.push(<ChartPathMark key={index} testID={`${props.testID}.edge.${index}`} datum={datum} d={d} strokeWidth={r1(stroke)}
                  bounds={{ x: 0, y: 0, width, height }}
                  focusBounds={{ x: x1 - countWidth / 2, y: y1 - r * 2.35 - (svgText.styles.body.fontSize ?? 13), width: countWidth, height: countHeight }} />);
                return <G key={index}>
                  <Path d={d}
                    fill="none" stroke={colour(edge.from)} strokeOpacity={0.9} strokeWidth={r1(stroke)} strokeDasharray={EDGE_DASH[edge.kind]} markerEnd={`url(#${markerId}-arrow-${edge.from})`} />
                  {svgText.draw({ x: x1, y: y1 - r * 2.35, anchor: 'middle', tone: 'strong', halo: props.paint.paper, text: String(edge.count) })}
                </G>;
              }
              const dx = x2 - x1, dy = y2 - y1, length = Math.hypot(dx, dy) || 1, ux = dx / length, uy = dy / length;
              const twin = edges.some((other) => other !== edge && other.from === edge.from && other.to === edge.to);
              const back = edges.some((other) => other.from === edge.to && other.to === edge.from);
              const bend = twin ? (edge.kind === 'session' ? -40 : 0) : back ? -40 : 14;
              const sx = x1 + ux * (radius(edge.from) + 4), sy = y1 + uy * (radius(edge.from) + 4), tx = x2 - ux * (radius(edge.to) + 7), ty = y2 - uy * (radius(edge.to) + 7);
              const mx = (sx + tx) / 2 - uy * bend, my = (sy + ty) / 2 + ux * bend;
              const labelX = (sx + tx) / 2 - uy * bend * 0.62, labelY = (sy + ty) / 2 + ux * bend * 0.62;
              const d = `M${r1(sx)},${r1(sy)}Q${r1(mx)},${r1(my)} ${r1(tx)},${r1(ty)}`;
              edgeMarks.push(<ChartPathMark key={index} testID={`${props.testID}.edge.${index}`} datum={datum} d={d} strokeWidth={r1(stroke)}
                bounds={{ x: 0, y: 0, width, height }}
                focusBounds={{ x: labelX - countWidth / 2, y: labelY - (svgText.styles.body.fontSize ?? 13), width: countWidth, height: countHeight }} />);
              return <G key={index}>
                <Path d={d} fill="none" stroke={colour(edge.from)} strokeOpacity={0.9} strokeWidth={r1(stroke)}
                  strokeDasharray={EDGE_DASH[edge.kind]} markerEnd={`url(#${markerId}-arrow-${edge.from})`} />
                {svgText.draw({ x: (sx + tx) / 2 - uy * bend * 0.62, y: (sy + ty) / 2 + ux * bend * 0.62 + 4, anchor: 'middle', tone: 'strong', halo: props.paint.paper, text: String(edge.count) })}
              </G>;
            })}
            {nodes.map((node) => { const [x, y] = position.get(node.agentId)!; return <G key={`n${node.agentId}`}>
              {!props.renderPlanet ? <Circle cx={r1(x)} cy={r1(y)} r={r1(radius(node.agentId) * 0.8)} fill={colour(node.agentId)} /> : null}
              {svgText.draw({ x, y: y + radius(node.agentId) + 15, anchor: 'middle', tone: 'strong', size: 'body', text: shortName(props.agents, node.agentId, props.labels.unknownAgent) })}
            </G>; })}
          </Svg>
          {edgeMarks}
          {nodes.map((node) => {
            const [x, y] = position.get(node.agentId)!, r = radius(node.agentId);
            return <ChartMark key={`datum-${node.agentId}`} testID={`${props.testID}.node.${node.agentId}`}
              datum={{ label: fullName(props.agents, node.agentId, props.labels.unknownAgent), value: node.share === null ? '—' : exactPercent(node.share), color: colour(node.agentId) }}
              bounds={{ x: x - r, y: y - r, width: r * 2, height: r * 2 }} />;
          })}
          {props.renderPlanet ? nodes.map((node) => {
            const [x, y] = position.get(node.agentId)!, r = radius(node.agentId), size = Math.ceil(r * 2.9);
            return <View key={`p${node.agentId}`} pointerEvents="none" style={{ position: 'absolute', left: r1(x - size / 2), top: r1(y - size / 2), width: size, height: size }}>
              {props.renderPlanet!({ size, radius: r, halo: 0.45, tail: 0, rise: 0.9, rotate: -0.5, style: 'rich', ink: colour(node.agentId) })}
            </View>;
          }) : null}
        </>;
      })() : null}
    </ChartDrawing>
    {props.model.edges?.length ? <UsageChartKey theme={props.theme} items={keyItems} note={props.labels.arrowNote} /> : <UsageChartCaption theme={props.theme}>{props.labels.nodesOnly}</UsageChartCaption>}
    {props.model.edges && props.model.unknownStarts !== null && props.model.unknownStarts > 0 ? <UsageChartCaption theme={props.theme}>{props.labels.unknownStarts(props.model.unknownStarts)}</UsageChartCaption> : null}
  </UsageChartColumn>;
}
