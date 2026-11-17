/**
 * Display wording for statement statistics. Counters stay decimal strings from the producer; this only
 * turns them into readable numbers. It decides nothing about what is slow or unhealthy (P4 §9).
 */
const grouped = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
const compact = new Intl.NumberFormat(undefined, {
  notation: 'compact',
  maximumFractionDigits: 1,
});
const percent = new Intl.NumberFormat(undefined, {
  style: 'percent',
  maximumFractionDigits: 1,
});

/** Up to 100,000 in full; above that, compact ("1.4M"). */
export function formatCount(value: string | number | undefined): string | null {
  if (value === undefined) return null;
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) return String(value);
  return number < 100_000 ? grouped.format(number) : compact.format(number);
}

/** Milliseconds as the shortest honest unit: 0.21 ms, 41.2 ms, 1.2 s, 12 min 39 s. */
export function formatDuration(ms: number | null | undefined): string | null {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return null;
  if (ms < 1) return `${ms.toFixed(2)} ms`;
  if (ms < 100) return `${ms.toFixed(1)} ms`;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60)
    return `${minutes} min ${String(Math.round(seconds % 60)).padStart(2, '0')} s`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`;
}

/** A clock duration for running work: 0:01, 6:12, 1:04:10. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, '0');
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}`
    : `${minutes}:${seconds}`;
}

export function formatPercent(ratio: number | null): string | null {
  return ratio === null || !Number.isFinite(ratio)
    ? null
    : percent.format(ratio);
}

/** a / b, or null when b is missing or zero: an unknown is never drawn as 0 %. */
export function ratio(
  part: string | number | undefined,
  whole: string | number | undefined,
): number | null {
  if (part === undefined || whole === undefined) return null;
  const denominator = Number(whole);
  if (!Number.isFinite(denominator) || denominator <= 0) return null;
  return Number(part) / denominator;
}

const clock = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
});
const dayClock = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

/** "14:05" today, "Nov 15, 18:20" on another day. */
export function formatMoment(ms: number, now = Date.now()): string {
  const sameDay = new Date(ms).toDateString() === new Date(now).toDateString();
  return (sameDay ? clock : dayClock).format(ms);
}

/** "3 h ago", "19 h ago", "4 days ago"; producer timestamps are ISO strings. */
export function formatAgo(
  translate: (key: string, fallback: string, values?: Readonly<Record<string, string>>) => string,
  iso: string | undefined,
  now = Date.now(),
): string | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return null;
  const minutes = Math.max(0, Math.round((now - at) / 60_000));
  if (minutes < 1) return translate('plugins.database.time.justNow', 'just now');
  if (minutes < 60) return translate('plugins.database.time.minutesAgo', '{n} min ago', { n: String(minutes) });
  const hours = Math.round(minutes / 60);
  if (hours < 48) return translate('plugins.database.time.hoursAgo', '{n} h ago', { n: String(hours) });
  return translate('plugins.database.time.daysAgo', '{n} days ago', { n: String(Math.round(hours / 24)) });
}
