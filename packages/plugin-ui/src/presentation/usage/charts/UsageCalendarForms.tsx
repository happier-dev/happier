import type { ReactNode } from 'react';
import { View } from 'react-native';
import { Circle, Ellipse, G, Path, Rect, Svg } from 'react-native-svg';

import { HappierText } from '../../text/Text.js';
import { ChartDrawing, ChartMark, ChartPathMark } from '../../data/ChartDatum.js';
import { formatHappierDataValue } from '../../data/dataModel.js';
import {
  UsageChartCaption,
  UsageChartColumn,
  UsageChartKey,
  UsageChartValues,
  resolveUsageChartInk,
  usageChartMix,
  usageChartRound as r1,
  useUsageChartSvgText,
  useUsageChartWidth,
  type UsageChartBaseProps,
  type UsageChartKeyItem,
  type UsageChartValuesLabels,
} from './chartKit.js';
import type { UsageCalendarArtModel } from './publicUsageChartModels.js';
import {
  usageActiveRuns,
  usageCalendarWeeks,
  usageStreakRuns,
  usageWeekdayOf,
  type UsageCalendarLevel,
  type UsageCalendarRun,
} from './usageCalendarLevels.js';
import type { UsagePlanetSlot } from './usagePlanetSlot.js';

/**
 * The calendar told in the Brand's grammar: one model (`UsageCalendarArtModel`: ordinal day levels and the shared
 * streak counts), several readings. Every body draws levels, never amounts; a streak count is placed only on a drawn
 * run of exactly that length, otherwise it is said in words; an unrecorded day keeps its own mark (unknown is not
 * zero). Planets come from the host's Brand planet slot.
 */

/** Wording shared by the calendar bodies; the host localizes it once. */
export type UsageCalendarLabels = Readonly<{
  /** "Jul", at the first day of a month. */
  month: (date: string) => string;
  /** "Tue 18 Aug". */
  day: (date: string) => string;
  /** "13 Jul". */
  short: (date: string) => string;
  /** Monday-first weekday initials. */
  weekdayInitials: readonly [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  levels: Readonly<{
    quiet: string;
    steady: string;
    busy: string;
    busiest: string;
  }>;
  noActivity: string;
  notRecorded: string;
  quieter: string;
  busier: string;
  /** "Best · 18 days". */
  best: (days: number) => string;
  /** "12 days now". */
  now: (days: number) => string;
  /** "12 days · your longest in this period". */
  ongoingBest: (days: number) => string;
  values: UsageChartValuesLabels &
    Readonly<{
      dateColumn: string;
      levelColumn: string;
      weekColumn: string;
      activeDaysColumn: string;
    }>;
}>;

type CalendarProps<L = UsageCalendarLabels> = UsageChartBaseProps &
  Readonly<{
    model: UsageCalendarArtModel;
    labels: L;
    renderPlanet?: UsagePlanetSlot;
  }>;

/** A level's light: the quietest active day is a lit sliver, the busiest fully lit. */
const levelLight = (level: number) => 0.18 + 0.82 * (level / 4);
/** A level's ink strength when drawn as a plain mark. */
const LEVEL_ALPHA = [0.08, 0.32, 0.5, 0.72, 0.95] as const;

function levelName(
  labels: UsageCalendarLabels,
  level: UsageCalendarLevel,
): string {
  if (level === null) return labels.notRecorded;
  return (
    [
      '',
      labels.levels.quiet,
      labels.levels.steady,
      labels.levels.busy,
      labels.levels.busiest,
    ][level] || labels.noActivity
  );
}

function dayTable(model: UsageCalendarArtModel, labels: UsageCalendarLabels) {
  return {
    columns: [
      { label: labels.values.dateColumn },
      { label: labels.values.levelColumn },
    ],
    rows: model.days.map(
      (day) => [labels.day(day.date), levelName(labels, day.level)] as const,
    ),
  };
}

function CalendarDayMark(props: Readonly<{ day: UsageCalendarArtModel['days'][number]; labels: UsageCalendarLabels; color: string; bounds: Readonly<{ x: number; y: number; width: number; height: number }> }>) {
  return <ChartMark datum={{ label: props.labels.day(props.day.date), value: levelName(props.labels, props.day.level), color: props.color }} bounds={props.bounds} />;
}

/** Month labels at each month's first drawn position, never closer than `gap`. */
function monthTicks(
  model: UsageCalendarArtModel,
  x: (index: number) => number,
  gap: number,
) {
  const ticks: { date: string; x: number }[] = [];
  model.days.forEach((day, index) => {
    if (index !== 0 && !day.date.endsWith('-01')) return;
    const at = x(index);
    if (ticks.length && at - ticks[ticks.length - 1]!.x < gap) return;
    ticks.push({ date: day.date, x: at });
  });
  return ticks;
}

const sameRun = (a: UsageCalendarRun | null, b: UsageCalendarRun | null) =>
  a !== null && b !== null && a.start === b.start && a.end === b.end;

/** Streak counts the calendar cannot place, in words; a placed count is drawn on its run instead. */
function StreakWords(
  props: Readonly<{
    theme: UsageChartBaseProps['theme'];
    model: UsageCalendarArtModel;
    labels: UsageCalendarLabels;
    testID?: string;
  }>,
) {
  const streaks = usageStreakRuns(props.model);
  const text = useUsageChartSvgText(props.theme).styles;
  const words = [
    streaks.unplacedCurrent !== null
      ? props.labels.now(streaks.unplacedCurrent)
      : null,
    streaks.unplacedBest !== null
      ? props.labels.best(streaks.unplacedBest)
      : null,
  ]
    .filter((part): part is string => part !== null)
    .join(' · ');
  return words ? (
    <HappierText
      testID={props.testID ? `${props.testID}-streaks` : undefined}
      style={text.strong}
    >
      {words}
    </HappierText>
  ) : null;
}

function levelKey(
  props: CalendarProps,
  swatch: (level: number) => UsageChartKeyItem['swatch'],
): UsageChartKeyItem[] {
  const ink = resolveUsageChartInk(props.theme, props.paint);
  const items: UsageChartKeyItem[] = [
    { id: 'quieter', label: props.labels.quieter, swatch: swatch(1) },
    { id: 'busier', label: props.labels.busier, swatch: swatch(4) },
    {
      id: 'none',
      label: props.labels.noActivity,
      value: String(props.model.days.filter((day) => day.level === 0).length),
      swatch: { kind: 'speck', color: ink.neutral },
    },
  ];
  const unknown = props.model.days.filter((day) => day.level === null).length;
  if (unknown)
    items.push({
      id: 'unknown',
      label: props.labels.notRecorded,
      value: String(unknown),
      swatch: { kind: 'ring', color: ink.neutral },
    });
  return items;
}

/* ═════ Ninety planets: each day a small Brand planet, lit by how busy it was ═════ */

const NINETY_CELL_MAX = 30;

export function UsageNinetyPlanets(props: CalendarProps) {
  const [width, onLayout] = useUsageChartWidth(props.width);
  const ink = resolveUsageChartInk(props.theme, props.paint);
  const svgText = useUsageChartSvgText(props.theme);
  const days = props.model.days;
  const offset = days.length ? usageWeekdayOf(days[0]!.date) : 0;
  const columns = Math.max(1, Math.ceil((days.length + offset) / 7));
  const axis = 18;
  const cell =
    width === null
      ? NINETY_CELL_MAX
      : Math.max(8, Math.min(NINETY_CELL_MAX, (width - axis) / columns));
  const size = Math.floor(cell * 0.84);
  const gridHeight = 7 * cell + 18;
  const planet = (level: number, box: number): ReactNode =>
    props.renderPlanet ? (
      props.renderPlanet({
        size: box,
        radius: box / 2,
        halo: 0,
        tail: 0,
        rise: 1,
        rotate: 0,
        style: 'balanced',
        mark: true,
        light: levelLight(level),
      })
    ) : (
      <Svg width={box} height={box}>
        <Circle
          cx={box / 2}
          cy={box / 2}
          r={box * 0.42}
          fill={props.paint.accent}
          fillOpacity={LEVEL_ALPHA[level]}
        />
      </Svg>
    );
  const swatch = (level: number): UsageChartKeyItem['swatch'] => ({
    kind: 'mark',
    node: <View style={{ width: 14, height: 14 }}>{planet(level, 14)}</View>,
  });
  const place = (index: number) => ({
    column: Math.floor((index + offset) / 7),
    row: (index + offset) % 7,
  });
  return (
    <UsageChartColumn testID={props.testID} onLayout={onLayout}>
      <ChartDrawing
        style={{ height: gridHeight }}
        accessibilityLabel={props.label}
      >
        {width !== null ? (
          <>
            <Svg
              width={width}
              height={gridHeight}
              style={{ position: 'absolute', left: 0, top: 0 }}
            >
              {props.labels.weekdayInitials.map((initial, row) =>
                row % 2 === 0
                  ? svgText.draw(
                      { x: 0, y: r1(row * cell + cell / 2 + 4), text: initial },
                      `wd${row}`,
                    )
                  : null,
              )}
              {days.map((day, index) => {
                if (day.level !== null && day.level > 0) return null;
                const { column, row } = place(index);
                const x = axis + column * cell + cell / 2,
                  y = row * cell + cell / 2;
                return day.level === null ? (
                  <Circle
                    key={day.date}
                    cx={r1(x)}
                    cy={r1(y)}
                    r={r1(Math.max(2, size * 0.2))}
                    fill="none"
                    stroke={ink.neutral}
                    strokeWidth={1}
                  />
                ) : (
                  <Circle
                    key={day.date}
                    cx={r1(x)}
                    cy={r1(y)}
                    r={r1(Math.max(1, size * 0.1))}
                    fill={ink.text}
                    fillOpacity={0.18}
                  />
                );
              })}
              {monthTicks(
                props.model,
                (index) => axis + place(index).column * cell,
                30,
              ).map((tick) =>
                svgText.draw(
                  {
                    x: tick.x,
                    y: gridHeight - 3,
                    text: props.labels.month(tick.date),
                  },
                  `m${tick.date}`,
                ),
              )}
            </Svg>
            {days.map((day, index) => {
              if (day.level === null || day.level === 0) return null;
              const { column, row } = place(index);
              return (
                <View
                  key={day.date}
                  pointerEvents="none"
                  style={{
                    position: 'absolute',
                    width: size,
                    height: size,
                    left: r1(axis + column * cell + (cell - size) / 2),
                    top: r1(row * cell + (cell - size) / 2),
                  }}
                >
                  {planet(day.level, size)}
                </View>
              );
            })}
            {days.map((day, index) => { const { column, row } = place(index); return <CalendarDayMark key={`datum-${day.date}`} day={day} labels={props.labels} color={props.paint.accent} bounds={{ x: axis + column * cell, y: row * cell, width: cell, height: cell }} />; })}
          </>
        ) : null}
      </ChartDrawing>
      <StreakWords
        theme={props.theme}
        model={props.model}
        labels={props.labels}
        testID={props.testID}
      />
      <UsageChartKey theme={props.theme} items={levelKey(props, swatch)} />
      <UsageChartValues
        theme={props.theme}
        label={props.label}
        labels={props.labels.values}
        testID={props.testID}
        table={dayTable(props.model, props.labels)}
      />
    </UsageChartColumn>
  );
}

/* ═════ Streak thread: the period as one thread that knots on every rest day ═════ */

export function UsageStreakThread(props: CalendarProps) {
  const [width, onLayout] = useUsageChartWidth(props.width);
  const ink = resolveUsageChartInk(props.theme, props.paint);
  const svgText = useUsageChartSvgText(props.theme);
  const streaks = usageStreakRuns(props.model);
  const days = props.model.days;
  const count = days.length;
  const height = 84;
  const y = 44;
  const x = (index: number) =>
    width === null ? 0 : 8 + (index / Math.max(1, count - 1)) * (width - 16);
  const same = sameRun(streaks.current, streaks.best);
  return (
    <UsageChartColumn testID={props.testID} onLayout={onLayout}>
      <ChartDrawing
        style={{ height }}
        accessibilityLabel={props.label}
      >
        {width !== null && count ? (
          <><Svg width={width} height={height}>
            {streaks.runs.map((run) => {
              const current = sameRun(run, streaks.current),
                best = sameRun(run, streaks.best);
              return (
                <Path
                  key={`r${run.start}`}
                  d={`M${r1(x(run.start))},${y}H${r1(x(run.end))}`}
                  stroke={current || best ? props.paint.accent : ink.text}
                  strokeOpacity={current || best ? 1 : 0.34}
                  strokeWidth={current ? 3 : best ? 2.4 : 1.5}
                  strokeLinecap="round"
                />
              );
            })}
            {days.map((day, index) =>
              day.level === 0 ? (
                <Circle
                  key={day.date}
                  cx={r1(x(index))}
                  cy={y}
                  r={2.6}
                  fill={props.paint.paper}
                  stroke={ink.text}
                  strokeOpacity={0.42}
                  strokeWidth={1}
                />
              ) : day.level === null ? (
                <Circle
                  key={day.date}
                  cx={r1(x(index))}
                  cy={y}
                  r={1.1}
                  fill={ink.neutral}
                />
              ) : null,
            )}
            {streaks.best && !same
              ? svgText.draw(
                  {
                    x: r1((x(streaks.best.start) + x(streaks.best.end)) / 2),
                    y: y + 22,
                    anchor: 'middle',
                    tone: 'secondary',
                    text: props.labels.best(streaks.best.days),
                  },
                  'best',
                )
              : null}
            {streaks.current
              ? svgText.draw(
                  {
                    x: r1(x(streaks.current.end)),
                    y: y - 12,
                    anchor: 'end',
                    tone: 'strong',
                    size: 'body',
                    text: same
                      ? props.labels.ongoingBest(streaks.current.days)
                      : props.labels.now(streaks.current.days),
                  },
                  'now',
                )
              : null}
            {monthTicks(props.model, x, 34).map((tick) =>
              svgText.draw(
                {
                  x: tick.x,
                  y: height - 3,
                  text: props.labels.month(tick.date),
                },
                `m${tick.date}`,
              ),
            )}
          </Svg>
          {days.map((day, index) => {
            const left = index === 0 ? x(index) - 3 : (x(index - 1) + x(index)) / 2;
            const right = index === count - 1 ? x(index) + 3 : (x(index) + x(index + 1)) / 2;
            return <CalendarDayMark key={day.date} day={day} labels={props.labels} color={props.paint.accent} bounds={{ x: left, y: y - 6, width: right - left, height: 12 }} />;
          })}
          </>
        ) : null}
      </ChartDrawing>
      <StreakWords
        theme={props.theme}
        model={props.model}
        labels={props.labels}
        testID={props.testID}
      />
      <UsageChartValues
        theme={props.theme}
        label={props.label}
        labels={props.labels.values}
        testID={props.testID}
        table={dayTable(props.model, props.labels)}
      />
    </UsageChartColumn>
  );
}

/* ═════ Weeks skyline: one column per Monday week, one brick per active day, shaded by how busy ═════ */

export function UsageWeeksSkyline(props: CalendarProps) {
  const [width, onLayout] = useUsageChartWidth(props.width);
  const ink = resolveUsageChartInk(props.theme, props.paint);
  const svgText = useUsageChartSvgText(props.theme);
  const days = props.model.days;
  const weeks = usageCalendarWeeks(days);
  const brick = width !== null && width < 420 ? 8 : 11;
  const height = 7 * (brick + 2) + 22;
  const base = height - 20;
  const shade = (level: number) =>
    usageChartMix(props.paint.accent, props.paint.paper, LEVEL_ALPHA[level]!);
  const swatch = (level: number): UsageChartKeyItem['swatch'] => ({
    kind: 'dot',
    color: shade(level),
  });
  const rows = weeks.map(
    (week) =>
      [
        props.labels.short(week.start),
        String(
          week.days.filter((index) => (days[index]!.level ?? 0) > 0).length,
        ),
      ] as const,
  );
  return (
    <UsageChartColumn testID={props.testID} onLayout={onLayout}>
      <ChartDrawing
        style={{ height }}
        accessibilityLabel={props.label}
      >
        {width !== null && weeks.length
          ? (() => {
              const column = width / weeks.length,
                bar = Math.min(column * 0.64, 30);
              let lastMonth = '';
              const targets: ReactNode[] = [];
              return (
                <><Svg width={width} height={height}>
                  <Path
                    d={`M0,${base + 0.5}H${width}`}
                    stroke={ink.base}
                    strokeWidth={1}
                  />
                  {weeks.map((week, k) => {
                    const left = k * column + (column - bar) / 2;
                    const marks: ReactNode[] = [];
                    let top = base;
                    // Active days stack busiest first; unrecorded days sit above as outlines, never as activity.
                    const active = week.days
                      .filter((index) => (days[index]!.level ?? 0) > 0)
                      .sort(
                        (a, b) => (days[b]!.level ?? 0) - (days[a]!.level ?? 0),
                      );
                    for (const index of active) {
                      top -= brick + 2;
                      targets.push(<CalendarDayMark key={index} day={days[index]!} labels={props.labels} color={props.paint.accent} bounds={{ x: left, y: top, width: bar, height: brick }} />);
                      marks.push(
                        <Rect
                          key={index}
                          x={r1(left)}
                          y={r1(top)}
                          width={r1(bar)}
                          height={brick}
                          rx={2}
                          fill={shade(days[index]!.level ?? 1)}
                        />,
                      );
                    }
                    for (const index of week.days.filter(
                      (at) => days[at]!.level === null,
                    )) {
                      top -= brick + 2;
                      targets.push(<CalendarDayMark key={index} day={days[index]!} labels={props.labels} color={props.paint.accent} bounds={{ x: left, y: top, width: bar, height: brick }} />);
                      marks.push(
                        <Rect
                          key={index}
                          x={r1(left + 0.5)}
                          y={r1(top + 0.5)}
                          width={r1(bar - 1)}
                          height={brick - 1}
                          rx={2}
                          fill="none"
                          stroke={ink.neutral}
                          strokeDasharray="2 2"
                        />,
                      );
                    }
                    const month = week.start.slice(0, 7);
                    const tick =
                      month !== lastMonth &&
                      (k === 0 || week.start.slice(8) <= '07');
                    if (tick) lastMonth = month;
                    return (
                      <G key={week.start}>
                        {marks}
                        {tick && (column > 22 || k % 2 === 0)
                          ? svgText.draw({
                              x: left,
                              y: height - 3,
                              text: props.labels.month(
                                days[week.days[0]!]!.date,
                              ),
                            })
                          : null}
                      </G>
                    );
                  })}
                </Svg>{targets}</>
              );
            })()
          : null}
      </ChartDrawing>
      <StreakWords
        theme={props.theme}
        model={props.model}
        labels={props.labels}
        testID={props.testID}
      />
      <UsageChartKey theme={props.theme} items={levelKey(props, swatch)} />
      <UsageChartValues
        theme={props.theme}
        label={props.label}
        labels={props.labels.values}
        testID={props.testID}
        table={{
          columns: [
            { label: props.labels.values.weekColumn },
            { label: props.labels.values.activeDaysColumn },
          ],
          rows,
        }}
      />
    </UsageChartColumn>
  );
}

/* ═════ Around the period: the days as stones along one orbit; the planet sits at the last day ═════ */

export function UsageAroundThePeriod(props: CalendarProps) {
  const [width, onLayout] = useUsageChartWidth(props.width);
  const ink = resolveUsageChartInk(props.theme, props.paint);
  const svgText = useUsageChartSvgText(props.theme);
  const days = props.model.days;
  const count = days.length;
  const height = width !== null && width < 420 ? 220 : 260;
  const swatch = (level: number): UsageChartKeyItem['swatch'] => ({
    kind: 'dot',
    color:
      level === 4
        ? props.paint.accent
        : usageChartMix(ink.text, props.paint.paper, LEVEL_ALPHA[level]!),
  });
  return (
    <UsageChartColumn testID={props.testID} onLayout={onLayout}>
      <ChartDrawing
        style={{ height }}
        accessibilityLabel={props.label}
      >
        {width !== null && count
          ? (() => {
              const cx = width / 2,
                cy = height / 2 + 2,
                rx = Math.min(width * 0.44, height * 1.1),
                ry = height * 0.36;
              const from = Math.PI * 0.85,
                span = Math.PI * 1.55;
              const at = (index: number) => {
                const angle = from + (index / Math.max(1, count - 1)) * span;
                return [
                  cx + rx * Math.cos(angle),
                  cy + ry * Math.sin(angle),
                ] as const;
              };
              const [sx, sy] = at(0),
                [ex, ey] = at(count - 1);
              const size = Math.round(Math.min(56, height * 0.24));
              return (
                <>
                  <Svg width={width} height={height}>
                    <Ellipse
                      cx={cx}
                      cy={cy}
                      rx={r1(rx)}
                      ry={r1(ry)}
                      fill="none"
                      stroke={ink.grid}
                      strokeWidth={1}
                    />
                    {days.map((day, index) => {
                      const [x, y] = at(index);
                      if (day.level === null)
                        return (
                          <Circle
                            key={day.date}
                            cx={r1(x)}
                            cy={r1(y)}
                            r={1.8}
                            fill="none"
                            stroke={ink.neutral}
                            strokeWidth={0.9}
                          />
                        );
                      return (
                        <Circle
                          key={day.date}
                          cx={r1(x)}
                          cy={r1(y)}
                          r={r1(day.level ? 1.3 + day.level * 0.8 : 1)}
                          fill={day.level === 4 ? props.paint.accent : ink.text}
                          fillOpacity={
                            day.level === 4
                              ? 1
                              : day.level
                                ? LEVEL_ALPHA[day.level]
                                : 0.18
                          }
                        />
                      );
                    })}
                    {svgText.draw(
                      {
                        x: r1(sx),
                        y: r1(sy + 18),
                        anchor: 'middle',
                        text: props.labels.short(days[0]!.date),
                        halo: props.paint.paper,
                      },
                      'from',
                    )}
                    {svgText.draw(
                      {
                        x: r1(ex),
                        y: r1(ey + size / 2 + 14),
                        anchor: 'middle',
                        tone: 'secondary',
                        text: props.labels.short(days[count - 1]!.date),
                        halo: props.paint.paper,
                      },
                      'to',
                    )}
                  </Svg>
                  {props.renderPlanet ? (
                    <View
                      pointerEvents="none"
                      style={{
                        position: 'absolute',
                        left: r1(ex - size / 2),
                        top: r1(ey - size / 2),
                        width: size,
                        height: size,
                      }}
                    >
                      {props.renderPlanet({
                        size,
                        radius: size * 0.3,
                        halo: 0.7,
                        tail: 0.6,
                        rise: 1,
                        rotate: -0.6,
                        style: 'rich',
                      })}
                    </View>
                  ) : null}
                  {days.map((day, index) => { const [x, y] = at(index); const radius = day.level === null ? 1.8 : day.level ? 1.3 + day.level * 0.8 : 1; return <CalendarDayMark key={day.date} day={day} labels={props.labels} color={props.paint.accent} bounds={{ x: x - radius, y: y - Math.max(radius, 3), width: radius * 2, height: Math.max(radius * 2, 6) }} />; })}
                </>
              );
            })()
          : null}
      </ChartDrawing>
      <StreakWords
        theme={props.theme}
        model={props.model}
        labels={props.labels}
        testID={props.testID}
      />
      <UsageChartKey theme={props.theme} items={levelKey(props, swatch)} />
      <UsageChartValues
        theme={props.theme}
        label={props.label}
        labels={props.labels.values}
        testID={props.testID}
        table={dayTable(props.model, props.labels)}
      />
    </UsageChartColumn>
  );
}

/* ═════ Days on the surface: the planet's own lattice in one meridian per day, brighter on busier days ═════ */

export type UsageSurfaceLabels = UsageCalendarLabels &
  Readonly<{
    /** "41 of 90 days lit". */
    lit: (active: number, days: number) => string;
  }>;

export function UsageDaysOnSurface(props: CalendarProps<UsageSurfaceLabels>) {
  const [width, onLayout] = useUsageChartWidth(props.width);
  const svgText = useUsageChartSvgText(props.theme);
  const days = props.model.days;
  const count = days.length;
  const active = days.filter((day) => (day.level ?? 0) > 0).length;
  const small = width !== null && width < 360;
  const height = small ? 150 : 230;
  const radius = Math.round(height * 0.44);
  const meridians = days.map((day) =>
    day.level === null || day.level === 0 ? 0 : levelLight(day.level),
  );
  return (
    <UsageChartColumn testID={props.testID} onLayout={onLayout}>
      <ChartDrawing
        style={{
          height,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: small ? 'flex-start' : 'center',
          gap: 16,
        }}
        accessibilityLabel={props.label}
      >
        {width !== null && count && props.renderPlanet ? (
          <View style={{ width: height, height }}>
            <View pointerEvents="none">
            {props.renderPlanet({
              size: height,
              radius,
              halo: 0,
              tail: 0,
              rise: 1,
              rotate: 0,
              style: 'balanced',
              meridians,
            })}
            </View>
            {days.map((day, index) => {
              const band = radius * 2 / count;
              const x = height / 2 - radius + (index + 0.5) * band;
              return <ChartPathMark key={day.date} datum={{ label: props.labels.day(day.date), value: levelName(props.labels, day.level), color: props.paint.accent }}
                d={`M${height / 2 - radius},${height / 2}a${radius},${radius} 0 1 0 ${radius * 2},0a${radius},${radius} 0 1 0 ${-radius * 2},0`} hitMode="fill" strokeWidth={0}
                bounds={{ x: x - band / 2, y: height / 2 - radius, width: band, height: radius * 2 }} focusBounds={{ x: x - band / 2, y: height / 2 - 4, width: band, height: 8 }} />;
            })}
          </View>
        ) : null}
        {small || !props.renderPlanet ? (
          <HappierText tabularNumbers style={svgText.styles.strong}>
            {props.labels.lit(active, count)}
          </HappierText>
        ) : null}
      </ChartDrawing>
      {!small && props.renderPlanet && width !== null && count ? (
        <View
          style={{
            flexDirection: 'row',
            justifyContent: 'space-between',
            alignSelf: 'center',
            width: radius * 2,
          }}
        >
          <HappierText style={svgText.styles.caption}>
            {props.labels.short(days[0]!.date)}
          </HappierText>
          <HappierText tabularNumbers style={svgText.styles.caption}>
            {props.labels.lit(active, count)}
          </HappierText>
          <HappierText style={svgText.styles.caption}>
            {props.labels.short(days[count - 1]!.date)}
          </HappierText>
        </View>
      ) : null}
      <StreakWords
        theme={props.theme}
        model={props.model}
        labels={props.labels}
        testID={props.testID}
      />
      <UsageChartValues
        theme={props.theme}
        label={props.label}
        labels={props.labels.values}
        testID={props.testID}
        table={dayTable(props.model, props.labels)}
      />
    </UsageChartColumn>
  );
}

/* ═════ Ringed by streaks: each run of three days or more is a ring; the best run, when shared, is the accent ring ═════ */

const RING_MIN_DAYS = 3;

export type UsageRingsLabels = UsageCalendarLabels &
  Readonly<{ /** No run reached three days. */ noRuns: string }>;

export function UsageRingedByStreaks(props: CalendarProps<UsageRingsLabels>) {
  const [width, onLayout] = useUsageChartWidth(props.width);
  const ink = resolveUsageChartInk(props.theme, props.paint);
  const svgText = useUsageChartSvgText(props.theme);
  const streaks = usageStreakRuns(props.model);
  const runs = usageActiveRuns(props.model.days).filter(
    (run) => run.days >= RING_MIN_DAYS,
  );
  const height = width !== null && width < 420 ? 200 : 250;
  const longest = Math.max(1, ...runs.map((run) => run.days));
  const rows = runs.map(
    (run) =>
      [
        `${props.labels.short(props.model.days[run.start]!.date)} – ${props.labels.short(props.model.days[run.end]!.date)}`,
        String(run.days),
      ] as const,
  );
  return (
    <UsageChartColumn testID={props.testID} onLayout={onLayout}>
      <ChartDrawing
        style={{ height }}
        accessibilityLabel={props.label}
      >
        {width !== null
          ? (() => {
              const cx = width / 2,
                cy = height / 2,
                radius = Math.round(Math.min(height * 0.26, width * 0.14)),
                tilt = 0.28;
              const outer = Math.min(width / 2 - 10, radius * 3.6);
              const rings = runs.map((run, index) => {
                const rx =
                  radius * 1.35 +
                  ((index + 1) / runs.length) * (outer - radius * 1.35);
                const best = sameRun(run, streaks.best);
                return {
                  run,
                  rx,
                  ry: rx * tilt,
                  best,
                  stroke: best ? props.paint.accent : ink.text,
                  opacity: best ? 1 : 0.2 + 0.4 * (run.days / longest),
                  weight: 0.6 + (run.days / longest) * 3,
                };
              });
              const half = (front: boolean) =>
                rings.map((ring) => (
                  <Path
                    key={`${front ? 'f' : 'b'}${ring.run.start}`}
                    d={
                      front
                        ? `M${r1(cx + ring.rx)},${r1(cy)}A${r1(ring.rx)},${r1(ring.ry)} 0 0 1 ${r1(cx - ring.rx)},${r1(cy)}`
                        : `M${r1(cx - ring.rx)},${r1(cy)}A${r1(ring.rx)},${r1(ring.ry)} 0 0 1 ${r1(cx + ring.rx)},${r1(cy)}`
                    }
                    fill="none"
                    stroke={ring.stroke}
                    strokeOpacity={ring.opacity}
                    strokeWidth={r1(ring.weight)}
                  />
                ));
              const best = rings.find((ring) => ring.best);
              const size = Math.ceil(radius * 2.6);
              return (
                <>
                  <Svg
                    width={width}
                    height={height}
                    style={{ position: 'absolute', left: 0, top: 0 }}
                  >
                    {half(false)}
                  </Svg>
                  {props.renderPlanet ? (
                    <View
                      pointerEvents="none"
                      style={{
                        position: 'absolute',
                        left: r1(cx - size / 2),
                        top: r1(cy - size / 2),
                        width: size,
                        height: size,
                      }}
                    >
                      {props.renderPlanet({
                        size,
                        radius,
                        halo: 0.35,
                        tail: 0,
                        rise: 1,
                        rotate: -0.5,
                        style: 'rich',
                      })}
                    </View>
                  ) : (
                    <Svg
                      width={width}
                      height={height}
                      style={{ position: 'absolute', left: 0, top: 0 }}
                    >
                      <Circle cx={cx} cy={cy} r={radius} fill={ink.track} />
                    </Svg>
                  )}
                  <Svg
                    width={width}
                    height={height}
                    style={{ position: 'absolute', left: 0, top: 0 }}
                  >
                    {half(true)}
                    {best
                      ? svgText.draw(
                          {
                            x: r1(cx + best.rx * 0.7),
                            y: r1(cy + best.ry * 0.7 + 16),
                            tone: 'secondary',
                            halo: props.paint.paper,
                            text: props.labels.best(best.run.days),
                          },
                          'best',
                        )
                      : null}
                  </Svg>
                  {rings.map(ring => <ChartPathMark key={ring.run.start} datum={{ label: `${props.labels.day(props.model.days[ring.run.start]!.date)} – ${props.labels.day(props.model.days[ring.run.end]!.date)}`, value: formatHappierDataValue(ring.run.days), subtitle: props.labels.values.activeDaysColumn, color: ring.stroke }}
                    d={`M${r1(cx - ring.rx)},${r1(cy)}A${r1(ring.rx)},${r1(ring.ry)} 0 0 1 ${r1(cx + ring.rx)},${r1(cy)}A${r1(ring.rx)},${r1(ring.ry)} 0 0 1 ${r1(cx - ring.rx)},${r1(cy)}`}
                    strokeWidth={ring.weight} bounds={{ x: cx - ring.rx - ring.weight, y: cy - ring.ry - ring.weight, width: 2 * (ring.rx + ring.weight), height: 2 * (ring.ry + ring.weight) }} focusBounds={{ x: cx + ring.rx - 4, y: cy - 4, width: 8, height: 8 }} />)}
                </>
              );
            })()
          : null}
      </ChartDrawing>
      {runs.length === 0 ? (
        <UsageChartCaption theme={props.theme}>
          {props.labels.noRuns}
        </UsageChartCaption>
      ) : null}
      <StreakWords
        theme={props.theme}
        model={props.model}
        labels={props.labels}
        testID={props.testID}
      />
      <UsageChartValues
        theme={props.theme}
        label={props.label}
        labels={props.labels.values}
        testID={props.testID}
        table={{
          columns: [
            { label: props.labels.values.dateColumn },
            { label: props.labels.values.activeDaysColumn },
          ],
          rows,
        }}
      />
    </UsageChartColumn>
  );
}
