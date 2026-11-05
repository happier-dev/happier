import { View } from 'react-native';
import { Circle, G, Path, Rect, Svg } from 'react-native-svg';
import { ChartDrawing, ChartMark, ChartPathMark } from '../../data/ChartDatum.js';
import { formatHappierDataExactShare, formatHappierDataValue } from '../../data/dataModel.js';

import {
  UsageChartCaption, UsageChartColumn, UsageChartValues, resolveUsageChartInk, usageChartMix, usageChartRound as r1, usageSmoothPath,
  useUsageChartSvgText, useUsageChartWidth, type UsageChartBaseProps, type UsageChartValuesLabels,
} from './chartKit.js';

/** A typical week's hours, Monday first: an amount privately, an ordinal level (0–4) publicly. Null = not known. */
export type UsageWeekHourModel = Readonly<{
  encoding: 'amount' | 'ordinal';
  /** Seven rows (Mon…Sun) of 24 hourly values. */
  grid: readonly (readonly (number | null)[])[];
}>;

export type UsageWeekTideLabels = Readonly<{
  weekdays: readonly [string, string, string, string, string, string, string];
  /** "06:00". */
  clock: (hour: number) => string;
  /** "Wed 12:00 · 30 started", or "busiest hour" on an ordinal model. */
  peak: (weekday: number, hour: number, value: number) => string;
  values: UsageChartValuesLabels & Readonly<{ weekdayColumn: string; formatValue: (value: number) => string; levelNames: readonly string[] }>;
}>;

/**
 * Week tide (Rhythm · Style Week tide): a ridgeline per weekday through its 24 hours, any metric; the peak hour is
 * named. Ordinal (public) models draw punch levels only, never an amount.
 */
export function UsageWeekTide(props: UsageChartBaseProps & Readonly<{ model: UsageWeekHourModel; labels: UsageWeekTideLabels }>) {
  const [width, onLayout] = useUsageChartWidth(props.width);
  const svgText = useUsageChartSvgText(props.theme);
  const grid = props.model.grid;
  const height = 186;
  const max = Math.max(0, ...grid.flat().filter((value): value is number => value !== null)) || 1;
  let peak = { value: -1, row: 0, hour: 0 };
  grid.forEach((row, rowIndex) => row.forEach((value, hour) => { if (value !== null && value > peak.value) peak = { value, row: rowIndex, hour }; }));
  const axis = 34;
  const plot = width === null ? 0 : width - axis - 4;
  const rowHeight = (height - 26) / 8.4;
  const drawing = grid.map((row, rowIndex) => {
    const base = 8 + rowHeight * 2.2 + rowIndex * rowHeight;
    const points = row.map((value, hour) => [axis + (hour / 23) * plot, base - Math.pow((value ?? 0) / max, 0.9) * rowHeight * 2.2] as const);
    const curve = usageSmoothPath(points);
    return { base, points, curve, area: `${curve}L${r1(axis + plot)},${r1(base)}L${axis},${r1(base)}Z` };
  });
  const columns = Array.from({ length: 24 }, (_, hour) => props.labels.clock(hour));
  const rows = grid.map((row, index) => [props.labels.weekdays[index] ?? '', ...row.map((value) => value === null ? '—'
    : props.model.encoding === 'ordinal' ? props.labels.values.levelNames[value] ?? '' : props.labels.values.formatValue(value))] as const);
  return <UsageChartColumn testID={props.testID} onLayout={onLayout}>
    <ChartDrawing style={{ height }} accessibilityLabel={props.label}>
      {width !== null ? <Svg width={width} height={height}>
        {(() => {
          const shapes = drawing.map(({ base, curve, area }, rowIndex) => {
            return <G key={rowIndex}>
              <Path d={area} fill={props.paint.paper} />
              <Path d={area} fill={props.paint.accent} fillOpacity={0.05 + rowIndex * 0.012} />
              <Path d={curve} fill="none" stroke={props.paint.accent} strokeOpacity={0.85} strokeWidth={1.2} />
              {svgText.draw({ x: 0, y: base - 1, text: props.labels.weekdays[rowIndex] ?? '' })}
            </G>;
          });
          const peakBase = 8 + rowHeight * 2.2 + peak.row * rowHeight;
          const px = axis + (peak.hour / 23) * plot;
          const py = peakBase - Math.pow(Math.max(0, peak.value) / max, 0.9) * rowHeight * 2.2;
          const right = px > width - 200;
          return [...shapes,
            peak.value > 0 ? <Circle key="peak" cx={r1(px)} cy={r1(py)} r={3} fill={props.paint.accent} /> : null,
            peak.value > 0 ? svgText.draw({ x: right ? px - 7 : px + 7, y: py - 5, anchor: right ? 'end' : 'start', tone: 'text', size: 'body', halo: props.paint.paper,
              text: props.labels.peak(peak.row, peak.hour, peak.value) }, 'peak-label') : null,
            ...[0, 6, 12, 18, 24].filter((hour) => hour < 24 || width >= 380).map((hour) => svgText.draw({ x: axis + (Math.min(hour, 23) / 23) * plot, y: height - 3,
              anchor: hour === 24 ? 'end' : 'start', text: props.labels.clock(hour) }, `t${hour}`)),
          ];
        })()}
      </Svg> : null}
      {width !== null ? grid.flatMap((row, rowIndex) => row.map((value, hour) => {
        const shape = drawing[rowIndex]!;
        const [x, y] = shape.points[hour]!;
        const datum = { label: `${props.labels.weekdays[rowIndex] ?? ''} · ${props.labels.clock(hour)}`, value: value === null ? '—' : props.model.encoding === 'ordinal' ? props.labels.values.levelNames[value] ?? '—' : formatHappierDataValue(value), subtitle: value !== null && props.model.encoding === 'amount' ? props.labels.values.formatValue(value) : undefined, color: props.paint.accent };
        const left = Math.max(axis, x - plot / 46), right = Math.min(axis + plot, x + plot / 46);
        return <View key={`${rowIndex}-${hour}`} pointerEvents="box-none" style={{ position: 'absolute', left: 0, top: 0, width, height }}>
          <ChartPathMark datum={datum} d={shape.area} hitMode="fill" strokeWidth={1.2} bounds={{ x: left, y: 0, width: right - left, height }} focusBounds={{ x: x - 4, y: y - 4, width: 8, height: 8 }} />
          <ChartMark datum={{ ...datum, keyboard: false }} bounds={{ x: x - Math.min(5, plot / 46), y: y - 5, width: Math.min(10, plot / 23), height: 10 }} />
        </View>;
      })) : null}
    </ChartDrawing>
    <UsageChartValues theme={props.theme} label={props.label} labels={props.labels.values} testID={props.testID}
      table={{ columns: [{ label: props.labels.values.weekdayColumn }, ...columns.map((label) => ({ label, priority: 'secondary' as const }))], rows }} />
  </UsageChartColumn>;
}

export type UsageDaylightModel = Readonly<{
  encoding: 'amount' | 'ordinal';
  /** 24 hourly values of the typical day; null = not known. */
  hours: readonly (number | null)[];
  /** The owner's Night shift window, only when its share may be shown; `share` is that window's share of the measure. */
  night: Readonly<{ fromHour: number; toHour: number; share: number | null }> | null;
}>;

export type UsageDaylightLabels = Readonly<{
  clock: (hour: number) => string;
  /** "Night · 23:00–07:00 · 30%". */
  night: (fromHour: number, toHour: number, share: number | null) => string;
  /** `peakHour` is null when no hour is known: the caption never names a busiest hour it was not given. */
  caption: (peakHour: number | null, nightShare: number | null) => string;
  values: UsageChartValuesLabels & Readonly<{ hourColumn: string; valueColumn: string; formatValue: (value: number) => string; levelNames: readonly string[] }>;
}>;

/**
 * Daylight (Rhythm · Style Daylight): the typical day as 24 columns of dots in the one Usage accent, taller is busier;
 * the owner's Night shift window is a quiet wash. Ordinal (public) models draw levels only.
 */
export function UsageDaylight(props: UsageChartBaseProps & Readonly<{ model: UsageDaylightModel; labels: UsageDaylightLabels }>) {
  const [width, onLayout] = useUsageChartWidth(props.width);
  const ink = resolveUsageChartInk(props.theme, props.paint);
  const svgText = useUsageChartSvgText(props.theme);
  const hours = props.model.hours.map((value) => value ?? 0);
  const max = Math.max(0, ...hours) || 1;
  const peakHour = props.model.hours.some((value) => value !== null && value > 0) ? hours.indexOf(Math.max(...hours)) : null;
  const night = props.model.night;
  const inNight = (hour: number) => night !== null && (night.fromHour > night.toHour ? hour >= night.fromHour || hour < night.toHour : hour >= night.fromHour && hour < night.toHour);
  const small = width !== null && width < 420;
  const height = small ? 120 : 150;
  const steps = small ? 5 : 7;
  const nightInk = usageChartMix(props.paint.accent, props.paint.paper, 0.56);
  const nightLabel = width !== null && night ? (() => {
    const text = props.labels.night(night.fromHour, night.toHour, night.share);
    const half = text.length * (svgText.styles.body.fontSize ?? 13) * 0.7 / 2;
    const column = width / 24;
    const at = night.fromHour > night.toHour ? night.toHour / 2 * column : (night.fromHour + night.toHour) / 2 * column;
    return { text, half, x: Math.min(width - half, Math.max(half, at)) };
  })() : null;
  const rows = props.model.hours.map((value, hour) => [props.labels.clock(hour), value === null ? '—'
    : props.model.encoding === 'ordinal' ? props.labels.values.levelNames[value] ?? '' : props.labels.values.formatValue(value)] as const);
  return <UsageChartColumn testID={props.testID} onLayout={onLayout}>
    <ChartDrawing style={{ height }} accessibilityLabel={props.label}>
      {width !== null ? <Svg width={width} height={height}>
        {(() => {
          const column = width / 24;
          const top = 22;
          const band = height - 18;
          const spacing = (band - top - 4) / steps;
          const radius = Math.min(4, column * 0.2, spacing * 0.36);
          const out = [];
          if (night) {
            const wash = usageChartMix(props.theme.colors.text, props.paint.paper, 0.04);
            const spans = night.fromHour > night.toHour ? [[0, night.toHour], [night.fromHour, 24]] : [[night.fromHour, night.toHour]];
            spans.forEach(([from, to], index) => out.push(<Rect key={`n${index}`} x={r1(from! * column)} y={top - 6} width={r1((to! - from!) * column)} height={r1(band - top + 8)} rx={6} fill={wash} />));
            // The window's label sits over its wash, kept wholly inside the plot (it is wider than an early-morning wash).
            out.push(svgText.draw({ x: nightLabel!.x, y: top - 10, anchor: 'middle', tone: 'secondary', size: 'body', text: nightLabel!.text }, 'night'));
          }
          hours.forEach((value, hour) => {
            const lit = Math.round((value / max) * steps);
            for (let step = 0; step < steps; step++) out.push(<Circle key={`d${hour}-${step}`} cx={r1(hour * column + column / 2)} cy={r1(band - 6 - step * spacing)} r={r1(radius)}
              fill={step < lit ? (inNight(hour) ? nightInk : props.paint.accent) : ink.track} />);
          });
          [0, 6, 12, 18].forEach((hour) => out.push(svgText.draw({ x: hour * column + 2, y: height - 3, text: props.labels.clock(hour) }, `t${hour}`)));
          out.push(svgText.draw({ x: width - 2, y: height - 3, anchor: 'end', text: props.labels.clock(24) }, 't24'));
          return out;
        })()}
      </Svg> : null}
      {width !== null && night && nightLabel ? <ChartMark datum={{ label: nightLabel.text, value: night.share === null ? '—' : formatHappierDataExactShare(night.share), color: nightInk }}
        bounds={{ x: Math.max(0, nightLabel.x - nightLabel.half), y: 0, width: Math.min(width, nightLabel.half * 2), height: 22 }} /> : null}
      {width !== null ? props.model.hours.map((value, hour) => <ChartMark key={hour} datum={{ label: props.labels.clock(hour), value: value === null ? '—' : props.model.encoding === 'ordinal' ? props.labels.values.levelNames[value] ?? '—' : formatHappierDataValue(value), subtitle: value !== null && props.model.encoding === 'amount' ? `${props.labels.values.valueColumn} · ${props.labels.values.formatValue(value)}` : undefined, color: inNight(hour) ? nightInk : props.paint.accent }}
        bounds={{ x: hour * width / 24, y: 22, width: width / 24, height: height - 40 }} />) : null}
    </ChartDrawing>
    <UsageChartCaption theme={props.theme}>{props.labels.caption(peakHour, night?.share ?? null)}</UsageChartCaption>
    <UsageChartValues theme={props.theme} label={props.label} labels={props.labels.values} testID={props.testID}
      table={{ columns: [{ label: props.labels.values.hourColumn }, { label: props.labels.values.valueColumn }], rows }} />
  </UsageChartColumn>;
}
