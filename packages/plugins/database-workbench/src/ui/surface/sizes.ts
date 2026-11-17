import { formatHappierDataBytes } from '@happier-dev/plugin-ui/components';

const compactCount = new Intl.NumberFormat(undefined, {
  notation: 'compact',
  maximumFractionDigits: 1,
});

/** A row count the database estimated (D27 #2): always marked approximate; unknown stays unknown. */
export function approxRowsLabel(
  approxRows: string | null | undefined,
): string | undefined {
  if (approxRows === null || approxRows === undefined) return undefined;
  const value = Number(approxRows);
  return `~${Number.isFinite(value) ? compactCount.format(value) : approxRows}`;
}

const groupedCount = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });

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
