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

/** A number in the reader's locale with grouping ("1,284"); strings and booleans as they are. */
export function formatHappierDataValue(value: HappierDataValue, locale?: string): string {
  if (typeof value !== 'number') return String(value);
  try {
    return new Intl.NumberFormat(locale === undefined ? undefined : [locale], { maximumSignificantDigits: 21 }).format(value);
  } catch {
    return String(value);
  }
}

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

type HappierDataTableInput = Readonly<{
  columns: readonly HappierDataColumn[];
  rows: readonly (readonly HappierDataValue[])[];
  /** The cell text's average advance, from the text role's font size. */
  characterWidth: number;
  locale?: string;
}>;

/**
 * Each column's readable width: its longest cell (or its label), up to a short phrase. Every row
 * uses these widths, so a table's columns line up whatever each row holds.
 */
export function estimateHappierDataColumnWidths(input: HappierDataTableInput): readonly number[] {
  return input.columns.map((column, index) => {
    let longest = column.label.length;
    for (const row of input.rows) {
      const cell = row[index];
      if (cell !== undefined) longest = Math.max(longest, formatHappierDataValue(cell, input.locale).length);
    }
    return Math.ceil(Math.min(longest, READABLE_COLUMN_CHARACTERS) * input.characterWidth);
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

/**
 * Bar heights as fractions of the plot, measured from a zero baseline. Every bar keeps a visible
 * stub so a zero still reads as a point in the series.
 */
export function resolveHappierDataBarHeights(points: readonly HappierDataPoint[], plotHeight: number, stub: number): readonly number[] {
  const shares = resolveHappierDataShares(points.map((point) => point.y));
  return shares.map((share) => Math.round(stub + share * Math.max(0, plotHeight - stub)));
}

/** A line's vertices inside a measured plot, scaled between the series' own lowest and highest values. */
export function resolveHappierDataLinePoints(
  points: readonly HappierDataPoint[],
  width: number,
  height: number,
  strokeWidth: number,
): readonly Readonly<{ x: number; y: number }>[] {
  if (points.length === 0 || width <= 0 || height <= 0) return [];
  const values = points.map((point) => point.y);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;
  const inset = strokeWidth / 2;
  const usable = Math.max(0, height - strokeWidth);
  return points.map((point, index) => ({
    x: points.length === 1 ? width / 2 : (index / (points.length - 1)) * width,
    y: inset + (span > 0 ? (1 - (point.y - min) / span) * usable : usable / 2),
  }));
}

/** The straight pieces between consecutive vertices, as centre, length and angle in degrees. */
export function resolveHappierDataLineSegments(vertices: readonly Readonly<{ x: number; y: number }>[]): readonly Readonly<{
  centerX: number;
  centerY: number;
  length: number;
  angle: number;
}>[] {
  const segments = [];
  for (let index = 1; index < vertices.length; index += 1) {
    const from = vertices[index - 1]!;
    const to = vertices[index]!;
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    segments.push({
      centerX: (from.x + to.x) / 2,
      centerY: (from.y + to.y) / 2,
      length: Math.hypot(dx, dy),
      angle: (Math.atan2(dy, dx) * 180) / Math.PI,
    });
  }
  return segments;
}

/** `id` is a semantic bucket identity shared across series, not a series-local point index. */
export type HappierSeriesPoint = Readonly<{ id: string; x: string | number; y: number | null; label?: string; annotation?: string; color?: string; opacity?: number }>;
export type HappierSeries = Readonly<{ id: string; label: string; color?: string; detail?: string; lineStyle?: 'solid' | 'dashed' | 'dotted'; points: readonly HappierSeriesPoint[] }>;
export type HappierSeriesBucket = Readonly<{
  id: string; x: string | number; label: string; annotation?: string;
  values: readonly Readonly<{ seriesId: string; label: string; value: number | null; lower: number; upper: number; color?: string; opacity?: number }>[];
}>;

/** One semantic bucket alignment and scale for bars, ribbons, lines and their exact-value alternatives. */
export function resolveHappierSeriesGeometry(series: readonly HappierSeries[], options: Readonly<{
  width: number; height: number; variant: 'bar' | 'line' | 'area'; normalized?: boolean; fitLine?: boolean; minimumMaximum?: number;
}>) {
  const points = new Map<string, HappierSeriesPoint>();
  for (const entry of series) for (const point of entry.points) if (!points.has(point.id)) points.set(point.id, point);
  const lookup = series.map((entry) => new Map(entry.points.map((point) => [point.id, point])));
  let largest = 0;
  let overflowingStack = false;
  for (const point of points.values()) {
    let positive = 0;
    let negative = 0;
    for (const entry of lookup) {
      const value = entry.get(point.id)?.y;
      if (typeof value !== 'number' || !Number.isFinite(value)) continue;
      largest = Math.max(largest, Math.abs(value));
      if (value < 0) negative += value; else positive += value;
    }
    if (!Number.isFinite(positive) || !Number.isFinite(negative)) overflowingStack = true;
  }
  // The picture may use rescaled coordinates; exact alternatives always use untouched raw values.
  const coordinateUnit = options.variant !== 'line' && !options.normalized && overflowingStack ? largest : 1;
  let min = 0;
  let max = options.normalized ? 1 : 0;
  const buckets: HappierSeriesBucket[] = [...points.values()].map((point) => {
    const raw = lookup.map((entry) => { const y = entry.get(point.id)?.y; return typeof y === 'number' && Number.isFinite(y) ? y : null; });
    const normalizationUnit = options.normalized ? raw.reduce<number>((maxValue, value) => Math.max(maxValue, value ?? 0), 0) : 1;
    const total = normalizationUnit > 0 ? raw.reduce<number>((sum, value) => sum + (value !== null && value > 0 ? value / normalizationUnit : 0), 0) : 0;
    let positive = 0;
    let negative = 0;
    const values = series.map((entry, index) => {
      const value = raw[index] ?? null;
      const scaled = value === null ? 0 : options.normalized ? (total > 0 ? (value / normalizationUnit) / total : 0) : value / coordinateUnit;
      const lower = options.variant === 'line' ? 0 : scaled < 0 ? negative : positive;
      const upper = lower + scaled;
      if (scaled < 0) negative = upper; else positive = upper;
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

/** Never round the accessible numerical fact, even when the caller abbreviates visible ink. */
export function describeHappierSeriesCoordinate(bucket: HappierSeriesBucket): string {
  return typeof bucket.x === 'number' && Number.isFinite(bucket.x) && bucket.label !== String(bucket.x)
    ? `${bucket.label} · ${formatHappierDataValue(bucket.x)}` : bucket.label;
}

export function describeHappierSeriesBucket(bucket: HappierSeriesBucket, unknownLabel: string): string {
  return `${describeHappierSeriesCoordinate(bucket)}${bucket.annotation ? ` · ${bucket.annotation}` : ''}: ${bucket.values.map((entry) => `${entry.label} ${entry.value === null ? unknownLabel : formatHappierDataValue(entry.value)}`).join(', ')}`;
}

export function buildHappierSeriesPath(points: readonly Readonly<{ x: number; y: number }>[], smoothing = 0): string {
  const round = (value: number) => Math.round(value * 100) / 100;
  if (!points.length) return '';
  const segments = [`M${round(points[0]!.x)} ${round(points[0]!.y)}`];
  for (let index = 1; index < points.length; index += 1) {
    const from = points[index - 1]!; const to = points[index]!;
    if (smoothing <= 0 || points.length < 3) { segments.push(`L${round(to.x)} ${round(to.y)}`); continue; }
    const before = points[index - 2] ?? from; const after = points[index + 1] ?? to;
    const clamp = (value: number) => Math.max(Math.min(from.y, to.y), Math.min(Math.max(from.y, to.y), value));
    segments.push(`C${round(from.x + (to.x - before.x) * smoothing / 6)} ${round(clamp(from.y + (to.y - before.y) * smoothing / 6))} ${round(to.x - (after.x - from.x) * smoothing / 6)} ${round(clamp(to.y - (after.y - from.y) * smoothing / 6))} ${round(to.x)} ${round(to.y)}`);
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
