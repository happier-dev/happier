import { formatHappierDataBytes } from '@happier-dev/plugin-ui/components';

const groupedCount = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
const compactCount = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 0 });
const compactMillions = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
const compact = (value: number) => (Math.abs(value) >= 1_000_000 ? compactMillions : compactCount).format(value);

/**
 * The workbench's one count wording. An exact count (statement calls, rows read) reads in full up to 100,000, then
 * compactly ("1.4M"). An estimate reads exactly while it is small (the database's estimate of a small table is its
 * count) and compactly, marked approximate, from 1,000 ("~212K"). Digits too large for a number keep their text.
 */
export function formatCount(
  value: string | number | undefined | null,
  /** `full`: every digit, where the count is the page's subject (a relation's header: "~48,210 rows"). */
  options?: Readonly<{ approximate?: boolean; full?: boolean }>,
): string | null {
  if (value === undefined || value === null) return null;
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) return String(value);
  const shown = options?.full === true ? groupedCount.format(number) : compact(number);
  if (options?.approximate === true) return number < 1_000 ? groupedCount.format(number) : `~${shown}`;
  if (options?.full === true) return shown;
  return number < 100_000 ? groupedCount.format(number) : compact(number);
}

/** A row count the database estimated (D27 #2); unknown stays unknown. */
export function approxRowsLabel(
  approxRows: string | null | undefined,
): string | undefined {
  return formatCount(approxRows, { approximate: true }) ?? undefined;
}

/** A whole count read in full ("48,210"); digits too large for a number keep the engine's own text. */
export function countLabel(count: string): string {
  const value = Number(count);
  return Number.isSafeInteger(value) ? groupedCount.format(value) : count;
}

/** Storage bytes (D27 #1) from the producer's decimal counter; a missing figure is null, never 0. */
export function bytesLabel(bytes: string | undefined): string | null {
  if (bytes === undefined) return null;
  const value = Number(bytes);
  return Number.isFinite(value)
    ? formatHappierDataBytes(value, { kind: 'storage' })
    : null;
}
