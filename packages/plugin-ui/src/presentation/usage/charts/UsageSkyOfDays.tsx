import { useId, useMemo } from 'react';
import {
  Circle,
  Defs,
  G,
  Path,
  RadialGradient,
  Stop,
  Svg,
} from 'react-native-svg';

import { HappierText } from '../../text/Text.js';
import { ChartDrawing, ChartMark } from '../../data/ChartDatum.js';
import { formatHappierDataValue } from '../../data/dataModel.js';

import {
  UsageChartCaption,
  UsageChartColumn,
  UsageChartKey,
  UsageChartValues,
  resolveUsageChartInk,
  usageChartMix,
  usageChartRound as r1,
  usageSmoothPath,
  useUsageChartSvgText,
  useUsageChartWidth,
  usageChartSvgSize,
  type UsageChartAgent,
  type UsageChartBaseProps,
  type UsageChartKeyItem,
  type UsageChartValuesLabels,
} from './chartKit.js';

/** The room one month label needs: months closer than this to the last one, or to the edge, are not drawn there. */
const MONTH_LABEL_GAP_PX = 36;

/** Who led a day on the selected metric. `null` = the model has no per-day attribution (public, or not derived). */
export type UsageSkyLeader =
  | Readonly<{ kind: 'agent'; agentId: string }>
  | Readonly<{ kind: 'tie'; agentIds: readonly [string, string, ...string[]] }>
  | Readonly<{ kind: 'unknown' }>;

export type UsageSkyDay = Readonly<{
  date: string;
  /** `unknown` = not recorded (unknown is not zero). */
  state: 'active' | 'inactive' | 'unknown';
  /** Private amount on the selected metric; absent on an ordinal (public) model. */
  value?: number | null;
  /** Ordinal level 1–4 for an active day on an ordinal model. */
  level?: 1 | 2 | 3 | 4 | null;
  leader?: UsageSkyLeader | null;
}>;

export type UsageSkyRun = Readonly<{ days: number }> &
  (
    | Readonly<{ startDate: string; endDate: string }>
    | Readonly<{ startDate?: never; endDate?: never }>
  );

export type UsageSkyModel = Readonly<{
  /** `amount` = the private metric (labelled guides); `ordinal` = levels only, never an amount axis. */
  encoding: 'amount' | 'ordinal';
  days: readonly UsageSkyDay[];
  colourBy: 'intensity' | 'leadingAgent';
  /** From the shared day-streak owner; the body never recounts them. */
  best?: UsageSkyRun | null;
  current?: UsageSkyRun | null;
}>;

export type UsageSkyLabels = Readonly<{
  formatValue: (value: number) => string;
  /** "Jul", at the first day of a month. */
  month: (date: string) => string;
  /** "Tue 18 Aug", for exact values. */
  day: (date: string) => string;
  levels: Readonly<{
    quiet: string;
    steady: string;
    busy: string;
    busiest: string;
  }>;
  streakBestOngoing: (days: number) => string;
  streakBest: (days: number) => string;
  streakNow: (days: number) => string;
  streakShort: (days: number, best: boolean) => string;
  key: Readonly<{
    tie: string;
    notAttributed: string;
    noActivity: string;
    notRecorded: string;
    quieter: string;
    busier: string;
  }>;
  /** How to read the sky; the faint run lines and the 7-day band are explained only when they are drawn. */
  caption: (drawn: Readonly<{ runs: boolean; band: boolean }>) => string;
  values: UsageChartValuesLabels &
    Readonly<{
      dateColumn: string;
      valueColumn: string;
      leaderColumn: string;
      noActivity: string;
      notRecorded: string;
      tie: string;
      notAttributed: string;
    }>;
}>;

export type UsageSkyOfDaysProps = UsageChartBaseProps &
  Readonly<{
    model: UsageSkyModel;
    agents: readonly UsageChartAgent[];
    labels: UsageSkyLabels;
  }>;

const LEVEL_OPACITY = [0, 0.5, 0.68, 0.86, 1] as const;
const COMPACT_BELOW_PX = 520;
const RUN_MIN_DAYS = 5;
/** A period this short draws one column per day. */
const SPARSE_MAX_DAYS = 14;
/** A day column at least this wide is named under the star. */
const DAY_LABEL_MIN_PX = 72;

type Star = Readonly<{
  index: number;
  x: number;
  y: number;
  level: 1 | 2 | 3 | 4;
  key: string;
  leader: UsageSkyLeader | null;
}>;

/**
 * Sky of days (Rhythm · Style Sky of days): each day a small lit star. x = the day; y = the metric (a square-root
 * amount with labelled guides privately, the day's ordinal band publicly); size, depth and glow = the day's level;
 * colour = the Agent that led the day on the same metric, or the one accent for Intensity. Runs of five days or
 * more join into faint constellations; best and current runs are named above the field.
 */
export function UsageSkyOfDays(props: UsageSkyOfDaysProps) {
  const [width, onLayout] = useUsageChartWidth(props.width);
  const ink = resolveUsageChartInk(props.theme, props.paint);
  const svgText = useUsageChartSvgText(props.theme);
  // Gradient ids are document-global; a page can hold several Skies (wide and phone editions), so each drawing owns its ids.
  const gradientId = `usage-sky-${useId().replace(/[^a-zA-Z0-9_-]/gu, '')}`;
  const agents = useMemo(
    () => new Map(props.agents.map((agent) => [agent.id, agent])),
    [props.agents],
  );
  const { labels } = props;
  const small = width !== null && width < COMPACT_BELOW_PX;
  const height = small ? 168 : 228;
  // A host-given width (the cold server page) cannot be measured: the sky draws at it and scales down with a
  // narrower column through its viewBox instead of overflowing.
  const scaled = props.width !== undefined;
  const ordinal = props.model.encoding === 'ordinal';
  const byAgent =
    props.model.colourBy === 'leadingAgent' &&
    props.model.days.some((day) => day.leader !== undefined && day.leader !== null);
  // Coloured by Agent, a lit day whose leader the owner could not name has no known Agent: it is drawn and counted as
  // one, never left without a mark.
  const model = useMemo(
    () =>
      byAgent
        ? {
            ...props.model,
            days: props.model.days.map((day) =>
              day.state === 'active' && !day.leader
                ? { ...day, leader: { kind: 'unknown' } as const }
                : day,
            ),
          }
        : props.model,
    [byAgent, props.model],
  );
  const geometry = useMemo(
    () => (width === null ? null : layoutSky(model, width, height, small)),
    [model, width, height, small],
  );
  const colourOf = (key: string) =>
    key === 'accent'
      ? props.paint.accent
      : (agents.get(key)?.color ?? ink.neutral);
  const gradientKeys = byAgent
    ? [
        ...new Set(
          geometry?.stars.flatMap((star) =>
            star.leader?.kind === 'agent' ? [star.leader.agentId] : [],
          ) ?? [],
        ),
      ]
    : ['accent'];
  const glowStrength = props.paint.dark ? 0.42 : 0.26;

  const keyItems: UsageChartKeyItem[] = [];
  if (byAgent) {
    const led = new Map<string, number>();
    let ties = 0;
    let unknown = 0;
    for (const day of model.days) {
      if (day.state !== 'active' || !day.leader) continue;
      if (day.leader.kind === 'agent')
        led.set(day.leader.agentId, (led.get(day.leader.agentId) ?? 0) + 1);
      else if (day.leader.kind === 'tie') ties++;
      else unknown++;
    }
    for (const agent of props.agents) {
      const count = led.get(agent.id);
      if (count)
        keyItems.push({
          id: agent.id,
          label: agent.shortName ?? agent.name,
          value: String(count),
          swatch: { kind: 'dot', color: agent.color },
        });
    }
    const tieColors = props.agents.slice(0, 2).map((agent) => agent.color);
    keyItems.push({
      id: 'tie',
      label: labels.key.tie,
      value: String(ties),
      swatch: {
        kind: 'split',
        colors: [tieColors[0] ?? ink.neutral, tieColors[1] ?? ink.neutral],
      },
    });
    keyItems.push({
      id: 'unknown',
      label: labels.key.notAttributed,
      value: String(unknown),
      swatch: { kind: 'ring', color: ink.neutral },
    });
  } else if (ordinal) {
    const counts = [0, 0, 0, 0, 0];
    for (const day of model.days)
      if (day.state === 'active' && day.level) counts[day.level]!++;
    const names = [
      labels.levels.quiet,
      labels.levels.steady,
      labels.levels.busy,
      labels.levels.busiest,
    ];
    names.forEach((name, index) =>
      keyItems.push({
        id: `level-${index + 1}`,
        label: name,
        value: String(counts[index + 1]),
        swatch: {
          kind: 'dot',
          color: usageChartMix(
            props.paint.accent,
            props.paint.paper,
            LEVEL_OPACITY[index + 1]!,
          ),
        },
      }),
    );
  } else {
    keyItems.push({
      id: 'quieter',
      label: labels.key.quieter,
      swatch: {
        kind: 'dot',
        color: usageChartMix(props.paint.accent, props.paint.paper, 0.5),
      },
    });
    keyItems.push({
      id: 'busier',
      label: labels.key.busier,
      swatch: { kind: 'dot', color: props.paint.accent },
    });
  }
  const inactive = model.days.filter((day) => day.state === 'inactive').length;
  const notRecorded = model.days.filter(
    (day) => day.state === 'unknown',
  ).length;
  keyItems.push({
    id: 'none',
    label: labels.key.noActivity,
    value: String(inactive),
    swatch: { kind: 'speck', color: ink.neutral },
  });
  if (notRecorded)
    keyItems.push({
      id: 'notRecorded',
      label: labels.key.notRecorded,
      value: String(notRecorded),
      swatch: { kind: 'ring', color: ink.neutral },
    });

  const undatedBest = model.best && !model.best.startDate ? model.best : null;
  const undatedCurrent =
    model.current && !model.current.startDate ? model.current : null;
  const streakWords =
    [
      undatedCurrent ? labels.streakNow(undatedCurrent.days) : null,
      undatedBest ? labels.streakBest(undatedBest.days) : null,
    ]
      .filter((part): part is string => part !== null)
      .join(' · ') || null;
  const leaderName = (leader: UsageSkyLeader | null | undefined) =>
    !leader
      ? ''
      : leader.kind === 'agent'
        ? (agents.get(leader.agentId)?.name ?? leader.agentId)
        : leader.kind === 'tie'
          ? `${labels.values.tie}: ${leader.agentIds.map((id) => agents.get(id)?.shortName ?? agents.get(id)?.name ?? id).join(', ')}`
          : labels.values.notAttributed;
  const levelNames = [
    '',
    labels.levels.quiet,
    labels.levels.steady,
    labels.levels.busy,
    labels.levels.busiest,
  ];
  const rows = model.days.map(
    (day) =>
      [
        labels.day(day.date),
        day.state === 'unknown'
          ? labels.values.notRecorded
          : day.state === 'inactive'
            ? labels.values.noActivity
            : ordinal
              ? (levelNames[day.level ?? 0] ?? '')
              : day.value == null
                ? '—'
                : labels.formatValue(day.value),
        ...(byAgent
          ? [day.state === 'active' ? leaderName(day.leader) : '']
          : []),
      ] as const,
  );

  return (
    <UsageChartColumn testID={props.testID} onLayout={onLayout}>
      <ChartDrawing
        style={scaled && width !== null ? { width: '100%', maxWidth: width, aspectRatio: width / height } : { height }}
        accessibilityLabel={props.label}
      >
        {geometry && width !== null ? (
          <Svg {...usageChartSvgSize(width, height, scaled)}>
            <Defs>
              {gradientKeys.map((key) => {
                const color = colourOf(key);
                return [
                  <RadialGradient
                    key={`c-${key}`}
                    id={`${gradientId}-core-${key}`}
                    cx="38%"
                    cy="34%"
                    r="70%"
                  >
                    <Stop
                      offset="0"
                      stopColor={usageChartMix(
                        color,
                        '#ffffff',
                        props.paint.dark ? 0.48 : 0.62,
                      )}
                    />
                    <Stop offset="0.5" stopColor={color} />
                    <Stop
                      offset="1"
                      stopColor={usageChartMix(
                        color,
                        '#000000',
                        props.paint.dark ? 0.78 : 0.86,
                      )}
                    />
                  </RadialGradient>,
                  <RadialGradient key={`h-${key}`} id={`${gradientId}-halo-${key}`}>
                    <Stop
                      offset="0"
                      stopColor={color}
                      stopOpacity={glowStrength}
                    />
                    <Stop
                      offset="0.45"
                      stopColor={color}
                      stopOpacity={glowStrength * 0.35}
                    />
                    <Stop offset="1" stopColor={color} stopOpacity={0} />
                  </RadialGradient>,
                ];
              })}
            </Defs>
            {geometry.guides.map((guide, index) => (
              <Path
                key={`g${index}`}
                d={`M0,${r1(guide.y)}H${r1(geometry.right)}`}
                stroke={ink.text}
                strokeOpacity={0.16}
                strokeDasharray="1 4"
                strokeLinecap="round"
                strokeWidth={1}
              />
            ))}
            {geometry.guides.map((guide, index) =>
              guide.label === null
                ? null
                : svgText.draw(
                    {
                      x: small ? 0 : width,
                      y: small ? guide.y - 4 : guide.y + 4,
                      text: ordinal
                        ? guide.label === 4
                          ? labels.levels.busiest
                          : labels.levels.quiet
                        : labels.formatValue(guide.label),
                      anchor: small ? 'start' : 'end',
                      halo: small ? props.paint.paper : undefined,
                    },
                    `gl${index}`,
                  ),
            )}
            {/* The lab blurs one wide stroke; SVG filters are not portable to native, so three nested strokes build the same soft band. */}
            {geometry.milkyWay
              ? [30, 20, 10].map((strokeWidth) => (
                  <Path
                    key={`mw${strokeWidth}`}
                    d={geometry.milkyWay!}
                    stroke={ink.text}
                    strokeOpacity={(props.paint.dark ? 0.08 : 0.07) / 3}
                    strokeWidth={strokeWidth}
                    fill="none"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                ))
              : null}
            {geometry.runs.map((run, index) => (
              <Path
                key={`r${index}`}
                d={run.path}
                fill="none"
                stroke={ink.text}
                strokeOpacity={run.named ? 0.3 : 0.14}
                strokeWidth={run.named ? 1 : 0.8}
                strokeLinecap="round"
              />
            ))}
            {geometry.floor.map((point) =>
              point.unknown ? (
                <Circle
                  key={`f${point.index}`}
                  cx={r1(point.x)}
                  cy={geometry.bottom}
                  r={1.6}
                  fill="none"
                  stroke={ink.neutral}
                  strokeWidth={0.9}
                />
              ) : (
                <Circle
                  key={`f${point.index}`}
                  cx={r1(point.x)}
                  cy={geometry.bottom}
                  r={0.9}
                  fill={ink.text}
                  fillOpacity={0.22}
                />
              ),
            )}
            {geometry.stars.map((star) => {
              const radius = starRadius(star.level, small, geometry.scale);
              const rare = !ordinal;
              if (byAgent && star.leader?.kind === 'unknown')
                return (
                  <Circle
                    key={`s${star.index}`}
                    cx={r1(star.x)}
                    cy={r1(star.y)}
                    r={r1(radius - 0.5)}
                    fill={props.paint.paper}
                    stroke={ink.neutral}
                    strokeWidth={1.2}
                  />
                );
              if (byAgent && star.leader?.kind === 'tie') {
                const [a, b] = star.leader.agentIds;
                const top = r1(star.y - radius),
                  bottom = r1(star.y + radius),
                  x = r1(star.x),
                  rr = r1(radius);
                return (
                  <G key={`s${star.index}`}>
                    <Path
                      d={`M${x},${top}A${rr},${rr} 0 0 0 ${x},${bottom}Z`}
                      fill={colourOf(a)}
                      fillOpacity={LEVEL_OPACITY[star.level]}
                    />
                    <Path
                      d={`M${x},${top}A${rr},${rr} 0 0 1 ${x},${bottom}Z`}
                      fill={colourOf(b)}
                      fillOpacity={LEVEL_OPACITY[star.level]}
                    />
                  </G>
                );
              }
              const key =
                byAgent && star.leader?.kind === 'agent'
                  ? star.leader.agentId
                  : 'accent';
              const glow =
                star.level >= 3
                  ? radius *
                    (star.level === 4 && rare ? (small ? 2.6 : 3.4) : 2.3)
                  : 0;
              const glint =
                star.level === 4 && !small && rare ? radius * 2.7 : 0;
              return [
                glow ? (
                  <Circle
                    key={`h${star.index}`}
                    cx={r1(star.x)}
                    cy={r1(star.y)}
                    r={r1(glow)}
                    fill={`url(#${gradientId}-halo-${key})`}
                  />
                ) : null,
                <Circle
                  key={`s${star.index}`}
                  cx={r1(star.x)}
                  cy={r1(star.y)}
                  r={r1(radius)}
                  fill={`url(#${gradientId}-core-${key})`}
                  fillOpacity={LEVEL_OPACITY[star.level]}
                />,
                glint ? (
                  <Path
                    key={`x${star.index}`}
                    d={`M${r1(star.x - glint)},${r1(star.y)}H${r1(star.x + glint)}M${r1(star.x)},${r1(star.y - glint)}V${r1(star.y + glint)}`}
                    stroke={colourOf(key)}
                    strokeOpacity={0.38}
                    strokeWidth={0.7}
                    strokeLinecap="round"
                  />
                ) : null,
              ];
            })}
            {geometry.brackets.map((bracket, index) => [
              <Path
                key={`b${index}`}
                d={`M${r1(bracket.from)},${bracket.y + 5}V${bracket.y}H${r1(bracket.to)}V${bracket.y + 5}`}
                fill="none"
                stroke={ink.text}
                strokeOpacity={0.3}
              />,
              svgText.draw(
                {
                  x: bracket.anchorEnd ? bracket.to : bracket.from,
                  y: bracket.y - 5,
                  anchor: bracket.anchorEnd ? 'end' : 'start',
                  tone: 'secondary',
                  size: 'body',
                  text: small
                    ? labels.streakShort(
                        bracket.run.days,
                        bracket.kind !== 'now',
                      )
                    : bracket.kind === 'ongoing'
                      ? labels.streakBestOngoing(bracket.run.days)
                      : bracket.kind === 'best'
                        ? labels.streakBest(bracket.run.days)
                        : labels.streakNow(bracket.run.days),
                },
                `bl${index}`,
              ),
            ])}
            {geometry.months.map((month) =>
              svgText.draw(
                geometry.dayLabels
                  ? { x: month.x, y: height - 4, anchor: 'middle', text: labels.day(month.date) }
                  // A month starting in the period's last days would run off the drawing: it ends at the edge.
                  : month.x > geometry.right - MONTH_LABEL_GAP_PX
                    ? { x: geometry.right, y: height - 4, anchor: 'end', text: labels.month(month.date) }
                    : { x: month.x, y: height - 4, text: labels.month(month.date) },
                `m${month.date}`,
              ),
            )}
          </Svg>
        ) : null}
        {geometry && width !== null ? [...geometry.stars.map(star => ({ index: star.index, x: star.x, y: star.y, radius: starRadius(star.level, small, geometry.scale) })),
          ...geometry.floor.map(point => ({ index: point.index, x: point.x, y: geometry.bottom, radius: 2 }))].map(point => {
          const day = model.days[point.index]!;
          const value = day.state === 'unknown' ? labels.values.notRecorded : day.state === 'inactive' ? labels.values.noActivity
            : ordinal ? levelNames[day.level ?? 0] ?? '—' : day.value == null ? '—' : formatHappierDataValue(day.value);
          return <ChartMark key={`datum-${point.index}`} datum={{ label: labels.day(day.date), value,
            subtitle: [!ordinal && day.state === 'active' && day.value != null ? `${labels.values.valueColumn} · ${labels.formatValue(day.value)}` : null, byAgent ? leaderName(day.leader) : null].filter(Boolean).join(' · ') || undefined,
            color: day.leader?.kind === 'agent' ? colourOf(day.leader.agentId) : props.paint.accent }}
            bounds={{ x: point.x - point.radius, y: point.y - Math.max(3, point.radius), width: point.radius * 2, height: Math.max(6, point.radius * 2) }} coordinateSpace={scaled ? { width, height } : undefined} />;
        }) : null}
      </ChartDrawing>
      {/* A streak shared as a count only (no dates) is said in words; the body never invents its position. */}
      {streakWords ? (
        <HappierText
          testID={props.testID ? `${props.testID}-streaks` : undefined}
          style={svgText.styles.strong}
        >
          {streakWords}
        </HappierText>
      ) : null}
      <UsageChartKey
        theme={props.theme}
        items={keyItems}
        testID={props.testID ? `${props.testID}-key` : undefined}
      />
      <UsageChartCaption theme={props.theme}>
        {labels.caption({ runs: (geometry?.runs.length ?? 0) > 0, band: geometry?.milkyWay != null })}
      </UsageChartCaption>
      <UsageChartValues
        theme={props.theme}
        label={props.label}
        labels={labels.values}
        testID={props.testID}
        table={{
          columns: [
            { label: labels.values.dateColumn },
            { label: labels.values.valueColumn },
            ...(byAgent ? [{ label: labels.values.leaderColumn }] : []),
          ],
          rows,
        }}
      />
    </UsageChartColumn>
  );
}

function starRadius(level: number, small: boolean, scale = 1): number {
  return (small ? 1 + level * 0.62 : 1.35 + level * 1.02) * scale;
}

/** Deterministic per-day drift inside an ordinal band, so the field breathes without implying an amount. */
function drift(date: string): number {
  let hash = 2166136261;
  for (let index = 0; index < date.length; index++)
    hash = Math.imul(hash ^ date.charCodeAt(index), 16777619);
  return ((hash >>> 0) % 1000) / 1000;
}

function layoutSky(
  model: UsageSkyModel,
  width: number,
  height: number,
  small: boolean,
) {
  const days = model.days;
  const count = Math.max(2, days.length);
  const ordinal = model.encoding === 'ordinal';
  const top = small ? 26 : 38;
  const bottom = height - 20;
  const right = width - (small ? 6 : ordinal ? 64 : 78);
  // A short period (a day, a week, a fortnight) gives each day its own column with the star at its centre and a larger
  // star, so a few days read as days rather than marks stranded at the edges of a long field.
  const sparse = days.length <= SPARSE_MAX_DAYS;
  const x = (index: number) =>
    sparse
      ? 8 + ((index + 0.5) / Math.max(1, days.length)) * (right - 16)
      : 8 + (index / (count - 1)) * (right - 16);
  const column = sparse ? (right - 16) / Math.max(1, days.length) : 0;
  const scale = sparse && !small ? Math.min(1.6, Math.max(1, column / 40)) : 1;
  const values = days.map((day) =>
    day.state === 'active'
      ? ordinal
        ? (day.level ?? null)
        : (day.value ?? null)
      : null,
  );
  const max = ordinal
    ? 4
    : Math.max(0, ...values.filter((value): value is number => value !== null));
  const level = (value: number) => ordinal ? Math.max(1, Math.min(4, Math.round(value))) as 1 | 2 | 3 | 4
    : Math.min(4, 1 + Math.floor((value / max) * 3.999)) as 1 | 2 | 3 | 4;
  const band = (bottom - top) / 4;
  const y = (value: number, index: number) =>
    ordinal
      ? bottom -
        (value - 1) * band -
        band * (0.22 + 0.56 * drift(days[index]!.date))
      : bottom - Math.sqrt(value / max) * (bottom - top);
  const stars: Star[] = [];
  const positions: (readonly [number, number] | null)[] = days.map(() => null);
  const floor: { index: number; x: number; unknown: boolean }[] = [];
  days.forEach((day, index) => {
    const value = values[index];
    if (value !== null && value !== undefined && value > 0 && max > 0) {
      const point = [x(index), y(value, index)] as const;
      positions[index] = point;
      stars.push({
        index,
        x: point[0],
        y: point[1],
        level: level(value),
        key: day.date,
        leader: day.leader ?? null,
      });
    } else floor.push({ index, x: x(index), unknown: day.state === 'unknown' });
  });
  stars.sort((a, b) => a.level - b.level);
  const guides: { y: number; label: number | null }[] = ordinal
    ? [
        { y: bottom - 3.5 * band, label: 4 },
        { y: bottom - 0.5 * band, label: 1 },
      ]
    : max > 0
      ? [
          { y: y(max * 0.25, 0), label: max * 0.25 },
          { y: y(max, 0), label: max },
        ]
      : [];
  // The milky way: a soft band through the 7-day average of the stars' heights. A period no longer than the window
  // has no average to trace, and fewer than five lit days make no band.
  let milkyWay: string | null = null;
  if (!small && days.length > 7 && stars.length >= RUN_MIN_DAYS) {
    const average: [number, number][] = [];
    for (let index = 0; index < days.length; index++) {
      const window = positions
        .slice(Math.max(0, index - 3), index + 4)
        .filter((point): point is readonly [number, number] => point !== null);
      if (window.length >= 3)
        average.push([
          x(index),
          window.reduce((sum, point) => sum + point[1], 0) / window.length,
        ]);
    }
    if (average.length > 4) milkyWay = usageSmoothPath(average);
  }
  const indexOf = (date: string | undefined) =>
    date === undefined ? -1 : days.findIndex((day) => day.date === date);
  const isNamed = (start: number, end: number) =>
    [model.best, model.current].some(
      (run) =>
        run && indexOf(run.startDate) === start && indexOf(run.endDate) === end,
    );
  const runs: { path: string; named: boolean }[] = [];
  let start = -1;
  for (let index = 0; index <= days.length; index++) {
    const lit = index < days.length && positions[index] !== null;
    if (lit && start < 0) start = index;
    if (!lit && start >= 0) {
      const end = index - 1;
      if (end - start + 1 >= RUN_MIN_DAYS) {
        let path = '';
        for (let at = start; at < end; at++) {
          const a = positions[at]!,
            b = positions[at + 1]!;
          const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
          const ra = starRadius(level(values[at]!), small, scale) + 2.5,
            rb = starRadius(level(values[at + 1]!), small, scale) + 2.5;
          if (length <= ra + rb + 1) continue;
          const ux = (b[0] - a[0]) / length,
            uy = (b[1] - a[1]) / length;
          path += `M${r1(a[0] + ux * ra)},${r1(a[1] + uy * ra)}L${r1(b[0] - ux * rb)},${r1(b[1] - uy * rb)}`;
        }
        if (path) runs.push({ path, named: isNamed(start, end) });
      }
      start = -1;
    }
  }
  const brackets: {
    from: number;
    to: number;
    y: number;
    anchorEnd: boolean;
    run: UsageSkyRun;
    kind: 'ongoing' | 'best' | 'now';
  }[] = [];
  const bracket = (run: UsageSkyRun, kind: 'ongoing' | 'best' | 'now') => {
    const a = indexOf(run.startDate),
      b = indexOf(run.endDate);
    if (a < 0 || b < 0) return;
    const from = x(a) - 3,
      to = x(b) + 3;
    brackets.push({
      from,
      to,
      y: top - (small ? 12 : 18),
      anchorEnd: small || from > width - 280,
      run,
      kind,
    });
  };
  if (
    model.current &&
    model.best &&
    model.current.startDate === model.best.startDate &&
    model.current.endDate === model.best.endDate
  )
    bracket(model.best, 'ongoing');
  else {
    if (model.best) bracket(model.best, 'best');
    if (model.current && model.current.days >= 3) bracket(model.current, 'now');
  }
  // Each day of a short period is named under its own column when the column fits the name; otherwise months.
  const dayLabels = sparse && column >= DAY_LABEL_MIN_PX;
  const months = days
    .flatMap((day, index) =>
      dayLabels || index === 0 || day.date.endsWith('-01')
        ? [{ date: day.date, x: x(index) }]
        : [],
    )
    .filter(
      (month, index, all) =>
        dayLabels || index === 0 || month.x - all[index - 1]!.x > MONTH_LABEL_GAP_PX,
    );
  return {
    dayLabels,
    scale,
    stars,
    floor,
    guides,
    milkyWay,
    runs,
    brackets,
    months,
    right,
    bottom,
  };
}
