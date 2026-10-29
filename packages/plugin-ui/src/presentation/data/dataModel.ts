import { resolveHappierCollectionTableColumns } from '../collection/collectionTable.js';

/**
 * The pure rules of the shared data presentation (lab `dashboards` DP/DPp): how a value reads, how a
 * proportion is drawn, which table columns a width keeps and what a chart says to assistive
 * technology. Pure, so the components, core's declarative host and a test read one answer.
 */

/** A displayed scalar, exactly as the typed data field produced it. */
export type HappierDataValue = string | number | boolean;

/** Lower drops first when a table is narrow; the first column (the name) never drops. */
export type HappierDataColumnPriority = 'primary' | 'secondary';

export type HappierDataColumn = Readonly<{
  label: string;
  priority?: HappierDataColumnPriority;
  /** A numeric column drawn as a share of its largest value (a funnel step, top errors). */
  proportion?: boolean;
}>;

/**
 * A number in the reader's locale with grouping ("1,284"); strings and booleans as they are. Integers
 * retain every digit. Fractional readings keep the existing fifteen-significant-digit suppression of
 * binary accumulation noise ("0.30000000000000004" reads as "0.3").
 */
export function formatHappierDataValue(value: HappierDataValue, locale?: string): string {
  if (typeof value !== 'number') return String(value);
  try {
    return new Intl.NumberFormat(locale === undefined ? undefined : [locale], Number.isInteger(value)
      ? { maximumFractionDigits: 0 }
      : { maximumSignificantDigits: 15 }).format(value);
  } catch {
    return String(value);
  }
}

export { formatHappierDataBytes, formatHappierDataBytesParts, type HappierDataBytesKind } from './formatBytes.js';

/** A whole-number percentage in the reader's locale ("63%"). */
export function formatHappierDataShare(share: number, locale?: string): string {
  try {
    return new Intl.NumberFormat(locale === undefined ? undefined : [locale], { style: 'percent', maximumFractionDigits: 0 }).format(share);
  } catch {
    return `${Math.round(share * 100)}%`;
  }
}

/**
 * Each value's share of the largest one, 0–1. Shares are relative to the largest value shown, so a
 * funnel's first step reads 100%; a non-positive largest value draws every bar empty rather than
 * inventing a scale.
 */
export function resolveHappierDataShares(values: readonly number[]): readonly number[] {
  const max = values.reduce((largest, value) => (Number.isFinite(value) && value > largest ? value : largest), 0);
  return values.map((value) => (max > 0 && Number.isFinite(value) && value > 0 ? Math.min(1, value / max) : 0));
}

const PRIORITY_RANK: Readonly<Record<HappierDataColumnPriority | 'default', number>> = Object.freeze({
  secondary: 0,
  default: 1,
  primary: 2,
});

/**
 * A column asks for its longest cell, up to about a short phrase ("Started a session"); longer cells
 * truncate in place rather than pushing every other column off the card.
 */
const READABLE_COLUMN_CHARACTERS = 24;
/**
 * The header is drawn at the label role's medium weight, which advances wider than the body cells the
 * character width is taken from; measured live at 14px/500 the label ran about 7% wider.
 */
const HEADER_WEIGHT_ALLOWANCE = 1.15;

type HappierDataTableInput = Readonly<{
  columns: readonly HappierDataColumn[];
  rows: readonly (readonly HappierDataValue[])[];
  /** The cell text's average advance, from the text role's font size. */
  characterWidth: number;
  locale?: string;
  /**
   * Each header label's drawn width once the host has measured it. A character count cannot know
   * wide glyphs ("Copper"), so a measured label widens its column; it never narrows below the estimate.
   */
  measuredLabelWidths?: readonly (number | undefined)[];
}>;

/**
 * Each column's readable width: its longest cell (or its label), up to a short phrase. Every row
 * uses these widths, so a table's columns line up whatever each row holds.
 */
export function estimateHappierDataColumnWidths(input: HappierDataTableInput): readonly number[] {
  return input.columns.map((column, index) => {
    let longest = column.label.length * HEADER_WEIGHT_ALLOWANCE;
    for (const row of input.rows) {
      const cell = row[index];
      if (cell !== undefined) longest = Math.max(longest, formatHappierDataValue(cell, input.locale).length);
    }
    const estimated = Math.ceil(Math.min(longest, READABLE_COLUMN_CHARACTERS) * input.characterWidth);
    const measured = input.measuredLabelWidths?.[index];
    return measured === undefined ? estimated : Math.max(estimated, Math.ceil(measured));
  });
}

/**
 * The columns a measured table width keeps, as indexes in declared order. Columns drop lowest
 * priority first (`secondary`, then unmarked, then `primary`); the first column is the row's name and
 * always stays. Before the first measurement every column is kept, so a wide card never flashes a
 * narrow table. Every row is still drawn — this decides columns, never how many rows show.
 */
export function resolveHappierDataTableColumns(input: HappierDataTableInput & Readonly<{
  availableWidth: number | null;
  gap: number;
}>): readonly number[] {
  const all = input.columns.map((_, index) => index);
  if (input.availableWidth === null || input.columns.length <= 1) return all;
  const widths = estimateHappierDataColumnWidths(input);
  const kept = resolveHappierCollectionTableColumns({
    availableWidth: input.availableWidth,
    gap: input.gap,
    columns: input.columns.map((column, index) => ({
      key: String(index),
      minWidth: widths[index]!,
      priority: PRIORITY_RANK[column.priority ?? 'default'],
      ...(index === 0 ? { flex: true } : {}),
    })),
  });
  return kept.map((column) => Number(column.key));
}

/** One point of a one-series chart. */
export type HappierDataPoint = Readonly<{ x: string | number; y: number }>;

/**
 * What a chart says in words: its name, then every point ("Signups per day: Thu 142, Fri 168, …").
 * This is the chart's table view for assistive technology, so no point is left out.
 */
export function describeHappierDataChart(label: string, points: readonly HappierDataPoint[], locale?: string): string {
  if (points.length === 0) return label;
  const values = points.map((point) => `${formatHappierDataValue(point.x, locale)} ${formatHappierDataValue(point.y, locale)}`);
  return `${label}: ${values.join(', ')}`;
}


/** `id` is a semantic bucket identity shared across series, not a series-local point index. */
export type HappierSeriesPoint = Readonly<{ id: string; x: string | number; y: number | null; label?: string; annotation?: string; color?: string; opacity?: number }>;
/**
 * `fillOpacity` washes an area ribbon in its colour at that opacity and draws the ribbon's upper edge as a
 * line, so a single history reads as a line over its own light fill rather than a solid block.
 */
export type HappierSeries = Readonly<{ id: string; label: string; color?: string; detail?: string; lineStyle?: 'solid' | 'dashed' | 'dotted'; fillPattern?: 'hatch'; fillOpacity?: number;
  /** An observed comparison line in line/area charts, excluded from stacked totals/fills. */
  overlay?: boolean;
  points: readonly HappierSeriesPoint[] }>;
export type HappierSeriesBucket = Readonly<{
  id: string; x: string | number; label: string; annotation?: string;
  values: readonly Readonly<{ seriesId: string; label: string; value: number | null; lower: number; upper: number; color?: string; opacity?: number }>[];
}>;

/** One semantic bucket alignment and scale for bars, ribbons, lines and their exact-value alternatives. */
export function resolveHappierSeriesGeometry(series: readonly HappierSeries[], options: Readonly<{
  width: number; height: number; variant: 'bar' | 'line' | 'area'; normalized?: boolean; fitLine?: boolean; minimumMaximum?: number;
  /** A fixed value scale (a zoomed line with a labelled floor, a mirrored rate scale); it must hold every value. */
  domain?: Readonly<{ min: number; max: number }>;
}>) {
  const points = new Map<string, HappierSeriesPoint>();
  for (const entry of series) for (const point of entry.points) if (!points.has(point.id)) points.set(point.id, point);
  const lookup = series.map((entry) => new Map(entry.points.map((point) => [point.id, point])));
  let largest = 0;
  let overflowingStack = false;
  for (const point of points.values()) {
    let positive = 0;
    let negative = 0;
    for (const [index, entry] of lookup.entries()) {
      const value = entry.get(point.id)?.y;
      if (typeof value !== 'number' || !Number.isFinite(value)) continue;
      largest = Math.max(largest, Math.abs(value));
      if (!series[index]!.overlay) { if (value < 0) negative += value; else positive += value; }
    }
    if (!Number.isFinite(positive) || !Number.isFinite(negative)) overflowingStack = true;
  }
  // The picture may use rescaled coordinates; exact alternatives always use untouched raw values.
  const coordinateUnit = options.variant !== 'line' && !options.normalized && overflowingStack ? largest : 1;
  let min = 0;
  let max = options.normalized ? 1 : 0;
  const buckets: HappierSeriesBucket[] = [...points.values()].map((point) => {
    const raw = lookup.map((entry) => { const y = entry.get(point.id)?.y; return typeof y === 'number' && Number.isFinite(y) ? y : null; });
    const normalizationUnit = options.normalized ? raw.reduce<number>((maxValue, value, index) =>
      series[index]!.overlay ? maxValue : Math.max(maxValue, value ?? 0), 0) : 1;
    const total = normalizationUnit > 0 ? raw.reduce<number>((sum, value, index) =>
      sum + (!series[index]!.overlay && value !== null && value > 0 ? value / normalizationUnit : 0), 0) : 0;
    let positive = 0;
    let negative = 0;
    const values = series.map((entry, index) => {
      const value = raw[index] ?? null;
      const scaled = value === null ? 0 : options.normalized ? (total > 0 ? (value / normalizationUnit) / total : 0) : value / coordinateUnit;
      const lower = options.variant === 'line' || entry.overlay ? 0 : scaled < 0 ? negative : positive;
      const upper = lower + scaled;
      if (!entry.overlay) { if (scaled < 0) negative = upper; else positive = upper; }
      min = Math.min(min, upper); max = Math.max(max, upper);
      const ink = lookup[index]!.get(point.id);
      return { seriesId: entry.id, label: entry.label, value, lower, upper,
        ...(ink?.color ? { color: ink.color } : {}), ...(ink?.opacity === undefined ? {} : { opacity: ink.opacity }) };
    });
    return { id: point.id, x: point.x, label: point.label ?? String(point.x), ...(point.annotation ? { annotation: point.annotation } : {}), values };
  });
  if (options.variant === 'line' && options.fitLine) {
    const values = buckets.flatMap((bucket) => bucket.values.flatMap((entry) => entry.value === null ? [] : [entry.value]));
    if (values.length) { min = Math.min(...values); max = Math.max(...values); }
  }
  if (!options.normalized && options.minimumMaximum !== undefined && Number.isFinite(options.minimumMaximum)) {
    max = Math.max(max, options.minimumMaximum / coordinateUnit);
  }
  if (!options.normalized && options.domain && Number.isFinite(options.domain.min) && Number.isFinite(options.domain.max)
    && options.domain.min < options.domain.max) {
    min = options.domain.min / coordinateUnit; max = options.domain.max / coordinateUnit;
  }
  // An empty/zero bar rests at the baseline; flat lines still retain their centered fallback.
  if (options.variant === 'bar' && min === 0 && max === 0) max = 1 / coordinateUnit;
  const yAt = (value: number) => options.height * (1 - (resolveHappierDataDomainFraction(value, min, max) ?? 0.5));
  const numericX = buckets.flatMap((bucket) => typeof bucket.x === 'number' && Number.isFinite(bucket.x) ? [bucket.x] : []);
  const allNumeric = numericX.length === buckets.length;
  const minX = allNumeric ? Math.min(...numericX) : 0;
  const maxX = allNumeric ? Math.max(...numericX) : 0;
  const xAt = (index: number) => buckets.length === 1 ? options.width / 2
    : allNumeric && minX !== maxX ? options.width * (resolveHappierDataDomainFraction(numericX[index]!, minX, maxX) ?? 0.5)
    : index * options.width / Math.max(1, buckets.length - 1);
  const orderedX = buckets.map((_, index) => ({ index, x: xAt(index) })).sort((a, b) => a.x - b.x);
  const hitRanges = new Map(orderedX.map((point, index) => {
    const left = index === 0 ? 0 : (orderedX[index - 1]!.x + point.x) / 2;
    const right = index === orderedX.length - 1 ? options.width : (point.x + orderedX[index + 1]!.x) / 2;
    return [point.index, { left, width: Math.max(0, right - left) }];
  }));
  const hitRangeAt = (index: number) => hitRanges.get(index) ?? { left: 0, width: 0 };
  return { buckets, min, max, yAt, xAt, hitRangeAt };
}

/**
 * How exact values read a numeric coordinate. `formatCoordinate` is the caller's own reading of its x
 * (a time bucket in its calendar and unit, read as a date): a chart's coordinates are the caller's
 * encoding, so only the caller can say them in words. `formatValue` is the caller's own reading of a value
 * (its unit and display precision); without one a value reads with every meaningful digit.
 */
export type HappierSeriesReadingOptions = Readonly<{ formatCoordinate?: (x: number) => string; formatValue?: (value: number) => string; locale?: string }>;

/**
 * Unless the caller gives its own `formatValue`, never round the accessible numerical fact, even when the caller abbreviates visible ink: a label that
 * shortens its coordinate ("Tue", "Noon") is followed by the exact one, in the caller's reading when it
 * gives one, so a timestamp reads as a date and never as an epoch number.
 */
export function describeHappierSeriesCoordinate(bucket: HappierSeriesBucket, options: HappierSeriesReadingOptions = {}): string {
  if (typeof bucket.x !== 'number' || !Number.isFinite(bucket.x)) return bucket.label;
  if (bucket.label === String(bucket.x)) return options.formatCoordinate ? options.formatCoordinate(bucket.x) : bucket.label;
  const exact = options.formatCoordinate ? options.formatCoordinate(bucket.x) : formatHappierDataValue(bucket.x, options.locale);
  return exact === bucket.label ? bucket.label : `${bucket.label} · ${exact}`;
}

export function describeHappierSeriesBucket(bucket: HappierSeriesBucket, unknownLabel: string, options: HappierSeriesReadingOptions = {}): string {
  return `${describeHappierSeriesCoordinate(bucket, options)}${bucket.annotation ? ` · ${bucket.annotation}` : ''}: ${bucket.values.map((entry) => `${entry.label} ${entry.value === null ? unknownLabel : options.formatValue ? options.formatValue(entry.value) : formatHappierDataValue(entry.value, options.locale)}`).join(', ')}`;
}

/**
 * The series' path through its samples. `smoothing` > 0 draws a monotone cubic (Steffen): it passes through
 * every sample, never overshoots the range between two neighbours (so a peak or a dip is never invented),
 * and keeps one tangent where segments join. `smoothing` scales the tangents; 0 draws straight segments.
 * Samples run in x order either way, so a ribbon's lower edge can be drawn backwards.
 */
export function buildHappierSeriesPath(points: readonly Readonly<{ x: number; y: number }>[], smoothing = 0): string {
  const round = (value: number) => Math.round(value * 100) / 100;
  if (!points.length) return '';
  const segments = [`M${round(points[0]!.x)} ${round(points[0]!.y)}`];
  if (smoothing <= 0 || points.length < 3) {
    for (let index = 1; index < points.length; index += 1) segments.push(`L${round(points[index]!.x)} ${round(points[index]!.y)}`);
    return segments.join(' ');
  }
  const slopes = points.slice(1).map((to, index) => {
    const from = points[index]!; const run = to.x - from.x;
    return run === 0 ? 0 : (to.y - from.y) / run;
  });
  const tangents = points.map((point, index) => {
    if (index === 0) return slopes[0]!;
    if (index === points.length - 1) return slopes[index - 1]!;
    const before = slopes[index - 1]!; const after = slopes[index]!;
    if (before * after <= 0) return 0;
    const left = point.x - points[index - 1]!.x; const right = points[index + 1]!.x - point.x;
    const blended = (before * right + after * left) / (left + right);
    return Math.sign(before) * Math.min(2 * Math.abs(before), 2 * Math.abs(after), Math.abs(blended));
  });
  for (let index = 1; index < points.length; index += 1) {
    const from = points[index - 1]!; const to = points[index]!; const third = (to.x - from.x) / 3;
    segments.push(`C${round(from.x + third)} ${round(from.y + tangents[index - 1]! * third * smoothing)} ${round(to.x - third)} ${round(to.y - tangents[index]! * third * smoothing)} ${round(to.x)} ${round(to.y)}`);
  }
  return segments.join(' ');
}

/** An observed scalar's location in a finite domain; values outside it stay in exact alternatives. */
export function resolveHappierDataDomainFraction(value: number | null, min: number, max: number): number | null {
  if (value === null || !Number.isFinite(value) || !Number.isFinite(min) || !Number.isFinite(max)
    || min > max || value < min || value > max) return null;
  if (min === max) return 0.5;
  const span = max - min;
  // Halving avoids overflow across both finite number extrema. Ordinary domains retain direct
  // subtraction so subnormal differences are not rounded away by halving.
  return Number.isFinite(span) ? (value - min) / span : (value / 2 - min / 2) / (max / 2 - min / 2);
}

/**
 * Ordered tonal ramp for telling series apart: index 0 is the full accent, later steps fade in
 * strictly decreasing, still-legible amounts. Eight steps, so eight categories never wrap.
 */
export const HAPPIER_SERIES_RAMP_ALPHAS = [1, 0.82, 0.68, 0.56, 0.46, 0.37, 0.29, 0.22] as const;

/** The ramp's legible span: steps up to here stay readable as a thin line on either paper. */
const HAPPIER_SERIES_RAMP_LEGIBLE_SPAN = 4;

/**
 * The ramp step for series `index` of `count` uncoloured series. A few series spread across the
 * legible span, so two lines never sit one barely-different step apart; more series take every
 * step in order, never wrapping.
 */
export function resolveHappierSeriesRampStep(index: number, count: number): number {
  if (count <= 1) return 0;
  const span = Math.min(HAPPIER_SERIES_RAMP_ALPHAS.length - 1, Math.max(HAPPIER_SERIES_RAMP_LEGIBLE_SPAN, count - 1));
  return Math.round(index * span / (count - 1));
}

const HAPPIER_HEX6 = /^#([0-9a-fA-F]{6})$/;

/** `color` at `amount` over `paper`, as one solid colour; `null` when either is not `#RRGGBB`. */
export function mixHappierColorOverPaper(color: string, paper: string, amount: number): string | null {
  const top = HAPPIER_HEX6.exec(color.trim());
  const under = HAPPIER_HEX6.exec(paper.trim());
  if (!top || !under) return null;
  const a = parseInt(top[1]!, 16);
  const b = parseInt(under[1]!, 16);
  const channel = (shift: number) => Math.round(((a >> shift) & 0xff) * amount + ((b >> shift) & 0xff) * (1 - amount));
  return `#${[16, 8, 0].map((shift) => channel(shift).toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Step `index` of the accent's ramp. On a known paper the step is solid (pre-mixed with the paper), so
 * stacked steps keep their order on glass; otherwise it is the accent at that alpha.
 */
export function resolveHappierSeriesRampColor(accent: string, paper: string | null | undefined, index: number): string {
  const alpha = HAPPIER_SERIES_RAMP_ALPHAS[Math.max(0, Math.min(index, HAPPIER_SERIES_RAMP_ALPHAS.length - 1))]!;
  if (alpha >= 1) return accent;
  const mixed = paper ? mixHappierColorOverPaper(accent, paper, alpha) : null;
  if (mixed) return mixed;
  const hex = HAPPIER_HEX6.exec(accent.trim());
  if (!hex) return accent;
  const value = parseInt(hex[1]!, 16);
  return `rgba(${(value >> 16) & 0xff}, ${(value >> 8) & 0xff}, ${value & 0xff}, ${alpha})`;
}
