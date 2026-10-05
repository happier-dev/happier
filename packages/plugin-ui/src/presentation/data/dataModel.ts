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
    return new Intl.NumberFormat(locale === undefined ? undefined : [locale]).format(value);
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
