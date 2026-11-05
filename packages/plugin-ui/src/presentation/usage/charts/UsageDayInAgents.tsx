import { useId } from 'react';
import { View } from 'react-native';

import { HappierText } from '../../text/Text.js';
import { ChartDatum, ChartDrawing, ChartMark, ChartPathMark } from '../../data/ChartDatum.js';
import { formatHappierDataValue } from '../../data/dataModel.js';
import { Circle, Defs, G, Path, Pattern, Rect, Svg } from 'react-native-svg';

import {
  UsageChartCaption, UsageChartColumn, UsageChartKey, UsageChartValues, resolveUsageChartInk, usageChartRound as r1, usageSmoothPath,
  useUsageChartSvgText, useUsageChartWidth, type UsageChartAgent, type UsageChartBaseProps, type UsageChartValuesLabels,
} from './chartKit.js';

/** One actual day of witnessed work. Hours are the query's own clock, 0–24, clipped to the day. */
export type UsageDayModel = Readonly<{
  date: string;
  lanes: readonly Readonly<{
    agentId: string | null;
    /** Witnessed work/wait spans; `waits` identify the hatched part, excluded from Agent-time/concurrency. */
    spans: readonly Readonly<{ fromHour: number; toHour: number; waits: readonly (readonly [number, number])[] }>[];
    /** That Agent's agent time that day (turns running together add up). */
    agentTimeMs: number;
  }>[];
  /** Turns running at once, evenly binned over the 24 hours (the shared boundary sweep's display bins). */
  atOnce: readonly number[];
  peak: Readonly<{ count: number; atHour: number; byAgent: readonly Readonly<{ agentId: string | null; count: number }>[] }>;
  waitCount: number;
}>;

/** A public edition: only the period's approved peak, no day, clock, lanes or attribution. */
export type UsageDayPeakModel = Readonly<{ kind: 'peakOnly'; count: number }>;

export type UsageDayLabels = Readonly<{
  unknownAgent: string;
  /** Says what the peak-only figure is and that a day's timeline is not shared. */
  peakOnlyCaption: string;
  clock: (hour: number) => string;
  duration: (ms: number) => string;
  atOnce: string;
  turns: string;
  agentTime: string;
  /** "6 at once · 15:00". */
  peak: (count: number, atHour: number) => string;
  /** "6 at once". */
  peakCount: (count: number) => string;
  /** "15:00 · Claude 4, Codex 2". */
  peakLine: (atHour: number, byAgent: readonly Readonly<{ name: string; count: number }>[]) => string;
  waiting: string;
  caption: Readonly<{ lanes: string; dial: string }>;
  values: UsageChartValuesLabels & Readonly<{ agentColumn: string; agentTimeColumn: string; spansColumn: string; formatSpan: (fromHour: number, toHour: number) => string }>;
}>;

export type UsageDayInAgentsProps = UsageChartBaseProps & Readonly<{
  model: UsageDayModel | UsageDayPeakModel;
  agents: readonly UsageChartAgent[];
  style: 'lanes' | 'dial';
  labels: UsageDayLabels;
}>;

const PHONE_BELOW_PX = 440;

/**
 * A day in agents (Parallel · Styles Lanes | Dial). Both draw the same facts of one day: each Agent's closed turns,
 * the waits for you inside them, and how many turns ran at once. Lanes is the default at every size; Dial is the
 * signature alternative.
 */
export function UsageDayInAgents(props: UsageDayInAgentsProps) {
  const model = props.model;
  if ('kind' in model) return <UsageDayPeakOnly {...props} model={model} />;
  return <UsageDayInAgentsDrawn {...props} model={model} />;
}

/** The same body's reduced edition: one figure, said plainly, never a fabricated day. */
function UsageDayPeakOnly(props: UsageDayInAgentsProps & Readonly<{ model: UsageDayPeakModel }>) {
  const text = useUsageChartSvgText(props.theme).styles;
  return <UsageChartColumn testID={props.testID}>
    <ChartDatum datum={{ label: props.label, value: formatHappierDataValue(props.model.count), subtitle: props.labels.peakCount(props.model.count), color: props.paint.accent }}><View accessible accessibilityLabel={`${props.label}: ${props.labels.peakCount(props.model.count)}`} style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: props.paint.accent }} />
      <HappierText tabularNumbers style={{ ...text.metric }}>{props.labels.peakCount(props.model.count)}</HappierText>
    </View></ChartDatum>
    <UsageChartCaption theme={props.theme}>{props.labels.peakOnlyCaption}</UsageChartCaption>
  </UsageChartColumn>;
}

function UsageDayInAgentsDrawn(props: UsageDayInAgentsProps & Readonly<{ model: UsageDayModel }>) {
  const [width, onLayout] = useUsageChartWidth(props.width);
  const agents = new Map(props.agents.map((agent) => [agent.id, agent]));
  const agent = (id: string | null) => id === null ? undefined : agents.get(id);
  const ink = resolveUsageChartInk(props.theme, props.paint);
  const lanes = props.model.lanes.filter((lane) => lane.agentTimeMs > 0 || lane.spans.length > 0);
  const name = (id: string | null) => agent(id)?.shortName ?? agent(id)?.name ?? id ?? props.labels.unknownAgent;
  const keyItems = [
    ...lanes.map((lane) => ({ id: JSON.stringify(lane.agentId), label: name(lane.agentId), value: props.style === 'dial' ? props.labels.duration(lane.agentTimeMs) : undefined,
      swatch: { kind: 'dot' as const, color: agent(lane.agentId)?.color ?? ink.neutral } })),
    { id: 'waiting', label: props.labels.waiting, value: String(props.model.waitCount), swatch: { kind: 'hatch' as const, color: ink.text } },
  ];
  const rows = lanes.map((lane) => [agent(lane.agentId)?.name ?? name(lane.agentId), props.labels.duration(lane.agentTimeMs),
    lane.spans.map((span) => props.labels.values.formatSpan(span.fromHour, span.toHour)).join(', ')] as const);
  const phone = width !== null && width < PHONE_BELOW_PX;
  return <UsageChartColumn testID={props.testID} onLayout={onLayout}>
    {width !== null ? (props.style === 'dial'
      ? <DayDial {...props} width={width} lanes={lanes} name={name} />
      : <DayLanes {...props} width={width} lanes={lanes} name={name} phone={phone} />) : <View style={{ height: 160 }} />}
    <UsageChartKey theme={props.theme} items={keyItems} />
    <UsageChartCaption theme={props.theme}>{props.style === 'dial' ? props.labels.caption.dial : props.labels.caption.lanes}</UsageChartCaption>
    <UsageChartValues theme={props.theme} label={props.label} labels={props.labels.values} testID={props.testID}
      table={{ columns: [{ label: props.labels.values.agentColumn }, { label: props.labels.values.agentTimeColumn }, { label: props.labels.values.spansColumn, priority: 'secondary' }], rows }} />
  </UsageChartColumn>;
}

type DayDrawProps = UsageDayInAgentsProps & Readonly<{ model: UsageDayModel; width: number; lanes: UsageDayModel['lanes']; name: (id: string | null) => string }>;

function workingSpans(span: UsageDayModel['lanes'][number]['spans'][number]) {
  const ranges: (readonly [number, number])[] = [];
  let cursor = span.fromHour;
  for (const [from, to] of span.waits) {
    if (from > cursor) ranges.push([cursor, from]);
    cursor = to;
  }
  if (span.toHour > cursor) ranges.push([cursor, span.toHour]);
  return ranges;
}


function DayLanes(props: DayDrawProps & Readonly<{ phone: boolean }>) {
  const ink = resolveUsageChartInk(props.theme, props.paint);
  const svgText = useUsageChartSvgText(props.theme);
  const { width, phone, model } = props;
  // A phone recomposes: each lane takes the full width with its name and figure on a line above it, and the
  // "At once" label sits above the curve, so nothing narrows the day to a sliver between two text columns.
  const label = phone ? 0 : 76;
  const figures = phone ? 0 : 84;
  const nameRow = phone ? 16 : 0;
  const plot = width - label - figures;
  const x = (hour: number) => label + (hour / 24) * plot;
  const curveHeight = 54, laneHeight = phone ? 12 : 14, gap = phone ? 8 : 9, top = phone ? 30 : 18;
  const height = top + curveHeight + props.lanes.length * (nameRow + laneHeight + gap) + 22;
  const scale = Math.max(2, Math.ceil(model.peak.count / 2) * 2);
  const cy = (count: number) => top + curveHeight - (count / scale) * (curveHeight - 10);
  const bins = model.atOnce.length || 1;
  const points = model.atOnce.map((count, index) => [x(((index + 0.5) / bins) * 24), cy(count)] as const);
  const curve = points.length > 1 ? usageSmoothPath(points) : '';
  const px = x(model.peak.atHour), py = cy(model.peak.count);
  const right = px > label + plot * 0.62;
  const hatch = `usage-day-hatch-${useId().replace(/[^a-zA-Z0-9_-]/gu, '')}`;
  const colour = (id: string | null) => props.agents.find((agent) => agent.id === id)?.color ?? ink.neutral;
  return <ChartDrawing style={{ height }} accessibilityLabel={props.label}>
    <Svg width={width} height={height}>
      <Defs>
        <Pattern id={hatch} width={4} height={4} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <Rect width={4} height={4} fill={props.paint.paper} />
          <Path d="M0,0V4" stroke={ink.text} strokeOpacity={0.55} strokeWidth={1.6} />
        </Pattern>
      </Defs>
      {[2, 4, 6, 8].filter((count) => count <= scale).map((count) => <G key={`g${count}`}>
        <Path d={`M${label},${r1(cy(count))}H${r1(label + plot)}`} stroke={ink.grid} strokeWidth={1} />
        {svgText.draw(phone ? { x: width, y: cy(count) - 3, anchor: 'end', text: String(count) } : { x: label - 6, y: cy(count) + 3, anchor: 'end', text: String(count) })}
      </G>)}
      {curve ? <Path d={`${curve}L${r1(x(24))},${r1(cy(0))}L${r1(x(0))},${r1(cy(0))}Z`} fill={props.paint.accent} fillOpacity={0.14} /> : null}
      {curve ? <Path d={curve} fill="none" stroke={props.paint.accent} strokeWidth={1.3} /> : null}
      {svgText.draw({ x: 0, y: phone ? 14 : top + 12, text: phone ? `${props.labels.atOnce} · ${props.labels.turns}` : props.labels.atOnce, tone: 'strong', size: 'body' }, 'at-once')}
      {!phone ? svgText.draw({ x: 0, y: top + 27, text: props.labels.turns }, 'turns') : null}
      {model.peak.count > 0 ? <Circle cx={r1(px)} cy={r1(py)} r={3.2} fill={props.paint.accent} /> : null}
      {model.peak.count > 0 ? svgText.draw({ x: right ? px - 8 : px + 8, y: py - 6, anchor: right ? 'end' : 'start', tone: 'strong', size: 'body', halo: props.paint.paper,
        text: props.labels.peak(model.peak.count, model.peak.atHour) }, 'peak') : null}
      {!phone ? svgText.draw({ x: width, y: top + curveHeight + 2, anchor: 'end', text: props.labels.agentTime }, 'agent-time') : null}
      {props.lanes.map((lane, index) => {
        const y = top + curveHeight + 10 + index * (nameRow + laneHeight + gap) + nameRow;
        return <G key={JSON.stringify(lane.agentId)}>
          {svgText.draw({ x: 0, y: phone ? y - 4 : y + laneHeight - 3, text: props.name(lane.agentId), tone: 'secondary', size: 'body' })}
          <Rect x={label} y={y} width={r1(plot)} height={laneHeight} rx={laneHeight / 2} fill={ink.track} />
          {lane.spans.map((span, spanIndex) => <G key={spanIndex}>
            <Rect x={r1(x(span.fromHour))} y={y + 2} width={r1(Math.max(3, x(span.toHour) - x(span.fromHour)))} height={laneHeight - 4} rx={(laneHeight - 4) / 2} fill={colour(lane.agentId)} />
            {span.waits.map(([from, to], waitIndex) => <Rect key={waitIndex} x={r1(x(from))} y={y + 2} width={r1(Math.max(2.5, x(to) - x(from)))} height={laneHeight - 4} fill={`url(#${hatch})`} />)}
          </G>)}
          {svgText.draw({ x: width, y: phone ? y - 4 : y + laneHeight - 3, anchor: 'end', tone: 'strong', size: 'body', text: props.labels.duration(lane.agentTimeMs) })}
        </G>;
      })}
      {[0, 6, 12, 18].map((hour) => svgText.draw({ x: x(hour), y: height - 4, text: props.labels.clock(hour) }, `t${hour}`))}
      {!phone && plot > 440 ? svgText.draw({ x: x(24), y: height - 4, anchor: 'end', text: props.labels.clock(24) }, 't24') : null}
    </Svg>
    {model.atOnce.map((count, index) => <ChartMark key={`count-${index}`} datum={{ label: `${props.labels.atOnce} · ${props.labels.clock(((index + 0.5) / bins) * 24)}`, value: formatHappierDataValue(count), color: props.paint.accent }}
      bounds={{ x: x((index / bins) * 24), y: top, width: plot / bins, height: curveHeight }} />)}
    {props.lanes.map((lane, index) => {
      const y = top + curveHeight + 10 + index * (nameRow + laneHeight + gap) + nameRow;
      return <View key={`marks-${JSON.stringify(lane.agentId)}`} pointerEvents="box-none" style={{ position: 'absolute', left: 0, top: 0, width, height }}>
        <ChartMark datum={{ label: props.name(lane.agentId), value: `${formatHappierDataValue(lane.agentTimeMs)} ms`, subtitle: `${props.labels.agentTime} · ${props.labels.duration(lane.agentTimeMs)}`, color: colour(lane.agentId) }}
          bounds={{ x: phone ? width - 84 : width - figures, y: phone ? y - nameRow : y, width: 84, height: laneHeight }} />
        {lane.spans.map((span, spanIndex) => <View key={spanIndex} pointerEvents="box-none" style={{ position: 'absolute', left: 0, top: 0, width, height }}>
          <ChartMark datum={{ label: props.name(lane.agentId), value: props.labels.values.formatSpan(span.fromHour, span.toHour), color: colour(lane.agentId) }} bounds={{ x: x(span.fromHour), y: y + 2, width: Math.max(3, x(span.toHour) - x(span.fromHour)), height: laneHeight - 4 }} />
          {span.waits.map(([from, to], waitIndex) => <ChartMark key={waitIndex} datum={{ label: `${props.name(lane.agentId)} · ${props.labels.waiting}`, value: props.labels.values.formatSpan(from, to) }} bounds={{ x: x(from), y: y + 2, width: Math.max(2.5, x(to) - x(from)), height: laneHeight - 4 }} />)}
        </View>)}
      </View>;
    })}
    {model.peak.count > 0 ? <ChartMark datum={{ label: props.labels.atOnce, value: formatHappierDataValue(model.peak.count), subtitle: props.labels.peak(model.peak.count, model.peak.atHour), color: props.paint.accent }} bounds={{ x: px - 4, y: py - 4, width: 8, height: 8 }} /> : null}
  </ChartDrawing>;
}

function DayDial(props: DayDrawProps) {
  const ink = resolveUsageChartInk(props.theme, props.paint);
  const svgText = useUsageChartSvgText(props.theme);
  const { width, model } = props;
  const size = Math.min(260, width);
  const room = width - size >= 170;
  const center = size / 2, inner = size * 0.17, outer = size * 0.36, trackStart = outer + 10, trackWidth = 4.2;
  const angle = (hour: number) => (hour / 24) * Math.PI * 2 - Math.PI / 2;
  const at = (radius: number, hour: number) => [center + radius * Math.cos(angle(hour)), center + radius * Math.sin(angle(hour))] as const;
  const bins = model.atOnce.length || 1;
  const shape = model.atOnce.map((count, index) => at(inner + ((outer - inner) * Math.min(6, count)) / 6, ((index + 0.5) / bins) * 24));
  const shapePath = shape.length > 2 ? `M${shape.map(([x, y]) => `${r1(x)},${r1(y)}`).join('L')}Z` : '';
  const colour = (id: string | null) => props.agents.find((agent) => agent.id === id)?.color ?? ink.neutral;
  const peakAt = at(inner + ((outer - inner) * Math.min(6, model.peak.count)) / 6, model.peak.atHour);
  const peakLine = props.labels.peakLine(model.peak.atHour, model.peak.byAgent.map((entry) => ({ name: props.name(entry.agentId), count: entry.count })));
  const arc = (radius: number, from: number, to: number) => {
    const [x1, y1] = at(radius, from), [x2, y2] = at(radius, to);
    return `M${r1(x1)},${r1(y1)}A${r1(radius)},${r1(radius)} 0 ${to - from > 12 ? 1 : 0} 1 ${r1(x2)},${r1(y2)}`;
  };
  const offset = room ? width - size : (width - size) / 2;
  const laneArcs = props.lanes.map((lane, index) => {
    const radius = trackStart + index * (trackWidth + 1.6);
    return lane.spans.map(span => ({ span, d: workingSpans(span).map(([from, to]) => arc(radius, from, to)).join(' ') }));
  });
  return <View style={{ gap: 8 }}>
    {!room ? <View style={{ flexDirection: 'row', alignItems: 'center' }}>
      <Svg width={Math.min(width, 360)} height={18}>
        <Circle cx={5} cy={9} r={3.2} fill={props.paint.accent} />
        {svgText.draw({ x: 13, y: 13, text: `${props.labels.peakCount(model.peak.count)} · ${peakLine}`, tone: 'strong', size: 'body' })}
      </Svg>
    </View> : null}
    <ChartDrawing style={{ height: size }} accessibilityLabel={props.label}>
      <Svg width={width} height={size}>
        {room ? <G>
          <Circle cx={5} cy={9} r={3.2} fill={props.paint.accent} />
          {svgText.draw({ x: 13, y: 13, text: props.labels.peakCount(model.peak.count), tone: 'strong', size: 'body' })}
          {svgText.draw({ x: 13, y: 28, text: peakLine })}
        </G> : null}
        <G transform={`translate(${r1(offset)},0)`}>
          {[2, 4, 6].map((count) => {
            const radius = inner + ((outer - inner) * count) / 6;
            const [lx, ly] = at(radius, 1.3);
            return <G key={count}>
              <Circle cx={center} cy={center} r={r1(radius)} stroke={ink.grid} strokeWidth={1} fill="none" />
              {svgText.draw({ x: lx + 2, y: ly - 1, text: String(count) })}
            </G>;
          })}
          {shapePath ? <Path d={shapePath} fill={props.paint.accent} fillOpacity={0.16}
            stroke={props.paint.accent} strokeWidth={1.1} strokeLinejoin="round" /> : null}
          <Circle cx={center} cy={center} r={inner} fill={props.paint.paper} stroke={ink.grid} strokeWidth={1} />
          {props.lanes.map((lane, index) => {
            const radius = trackStart + index * (trackWidth + 1.6);
            return <G key={JSON.stringify(lane.agentId)}>
              <Circle cx={center} cy={center} r={r1(radius)} fill="none" stroke={ink.grid} strokeWidth={trackWidth} />
              {laneArcs[index]!.map(({ d }, segment) => <Path key={segment} d={d} fill="none" stroke={colour(lane.agentId)} strokeWidth={trackWidth} />)}
            </G>;
          })}
          {[0, 6, 12, 18].map((hour) => { const [x, y] = at(inner - 10, hour); return svgText.draw({ x, y: y + 3.5, anchor: 'middle', text: String(hour).padStart(2, '0') }, `h${hour}`); })}
          {model.peak.count > 0 ? <Circle cx={r1(peakAt[0])} cy={r1(peakAt[1])} r={3.2} fill={props.paint.accent} /> : null}
        </G>
      </Svg>
      {model.atOnce.map((count, index) => {
        const datum = { label: `${props.labels.atOnce} · ${props.labels.clock(((index + 0.5) / bins) * 24)}`, value: formatHappierDataValue(count), color: props.paint.accent };
        const focusBounds = { x: offset + shape[index]![0] - 5, y: shape[index]![1] - 5, width: 10, height: 10 };
        const from = index / bins * 24, to = (index + 1) / bins * 24;
        const [x1, y1] = at(outer, from), [x2, y2] = at(outer, to);
        const [ix1, iy1] = at(inner, from), [ix2, iy2] = at(inner, to);
        const clip = `M${r1(ix1)},${r1(iy1)}L${r1(x1)},${r1(y1)}A${outer},${outer} 0 ${to - from > 12 ? 1 : 0} 1 ${r1(x2)},${r1(y2)}L${r1(ix2)},${r1(iy2)}A${inner},${inner} 0 ${to - from > 12 ? 1 : 0} 0 ${r1(ix1)},${r1(iy1)}Z`;
        return <View key={`count-${index}`} pointerEvents="box-none" style={{ position: 'absolute', left: 0, top: 0, width, height: size }}>
          {shapePath ? <ChartPathMark datum={datum} d={shapePath} transform={`translate(${r1(offset)},0)`} clipPathD={clip} hitMode="fill" strokeWidth={1.1}
            bounds={{ x: offset + center - outer, y: center - outer, width: outer * 2, height: outer * 2 }} focusBounds={focusBounds} /> : null}
          <ChartMark datum={{ ...datum, keyboard: !shapePath }} bounds={focusBounds} />
        </View>;
      })}
      {props.lanes.map((lane, index) => {
        const radius = trackStart + index * (trackWidth + 1.6);
        const [totalX, totalY] = at(radius, lane.spans[0]?.fromHour ?? 0);
        const bounds = { x: offset + center - radius - trackWidth, y: center - radius - trackWidth, width: (radius + trackWidth) * 2, height: (radius + trackWidth) * 2 };
        return <View key={`marks-${JSON.stringify(lane.agentId)}`} pointerEvents="box-none" style={{ position: 'absolute', left: 0, top: 0, width, height: size }}>
          <ChartPathMark datum={{ label: props.name(lane.agentId), value: `${formatHappierDataValue(lane.agentTimeMs)} ms`, subtitle: `${props.labels.agentTime} · ${props.labels.duration(lane.agentTimeMs)}`, color: colour(lane.agentId) }}
            d={`${arc(radius, 0, 12)} ${arc(radius, 12, 24)}`} transform={`translate(${r1(offset)},0)`} bounds={bounds} strokeWidth={trackWidth} focusBounds={{ x: offset + totalX - 4, y: totalY - 4, width: 8, height: 8 }} />
          {laneArcs[index]!.map(({ span, d }, spanIndex) => {
            return <View key={spanIndex} pointerEvents="box-none" style={{ position: 'absolute', left: 0, top: 0, width, height: size }}>
              {d ? <ChartPathMark datum={{ label: props.name(lane.agentId), value: props.labels.values.formatSpan(span.fromHour, span.toHour), color: colour(lane.agentId) }} d={d} transform={`translate(${r1(offset)},0)`} bounds={bounds} strokeWidth={trackWidth}
                focusBounds={{ x: offset + totalX - 4, y: totalY - 4, width: 8, height: 8 }} /> : null}
              {span.waits.map(([from, to], waitIndex) => { const [wx, wy] = at(radius, (from + to) / 2); return <ChartMark key={waitIndex} datum={{ label: `${props.name(lane.agentId)} · ${props.labels.waiting}`, value: props.labels.values.formatSpan(from, to) }} bounds={{ x: offset + wx - 4, y: wy - 4, width: 8, height: 8 }} />; })}
            </View>;
          })}
        </View>;
      })}
      {model.peak.count > 0 ? <ChartMark datum={{ label: props.labels.atOnce, value: formatHappierDataValue(model.peak.count), subtitle: peakLine, color: props.paint.accent }} bounds={{ x: offset + peakAt[0] - 4, y: peakAt[1] - 4, width: 8, height: 8 }} /> : null}
    </ChartDrawing>
  </View>;
}
