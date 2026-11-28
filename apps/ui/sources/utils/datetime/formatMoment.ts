import { getPreferredLanguage } from '@/text';
import { formatWithCachedDateTimeFormatter } from '@/utils/datetime/cachedIntlFormatters';

const DAY_MS = 24 * 60 * 60 * 1000;

/** A moment near now in the app's language: today's clock time, a nearby weekday and time, else its calendar date. */
export function formatMoment(atMs: number, nowMs: number): string {
  const when = new Date(atMs);
  const now = new Date(nowMs);
  const locale = getPreferredLanguage();
  // The language's own short clock ("7:27 PM", "07:27"): a padded hour is a convention of some languages only.
  const time = formatWithCachedDateTimeFormatter(when, locale, { timeStyle: 'short' });
  if (when.getFullYear() === now.getFullYear()
    && when.getMonth() === now.getMonth()
    && when.getDate() === now.getDate())
    return time;
  if (Math.abs(atMs - nowMs) < 6 * DAY_MS)
    return `${formatWithCachedDateTimeFormatter(when, locale, { weekday: 'short' })} ${time}`;
  return formatWithCachedDateTimeFormatter(when, locale, {
    day: 'numeric',
    month: 'short',
    ...(when.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}),
  });
}

function sameDay(a: number, b: number): boolean {
  const x = new Date(a);
  const y = new Date(b);
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
}

/**
 * A window between two moments, each end said the way `formatMoment` says it. An end that differs in day from the
 * start always carries its day, so a window ending today never reads as no time ("Fri 10:21 AM – Sat 10:21 AM", not
 * "Fri 10:21 AM – 10:21 AM"). A window inside one minute is one moment, and one inside a day names that day once.
 */
export function formatMomentRange(sinceMs: number, untilMs: number, nowMs: number): string {
  const start = formatMoment(sinceMs, nowMs);
  if (sameDay(sinceMs, untilMs)) {
    const locale = getPreferredLanguage();
    const clock = (at: number) => formatWithCachedDateTimeFormatter(new Date(at), locale, { timeStyle: 'short' });
    // An old day is said as its date alone, which already covers the whole window.
    const startHasClock = sameDay(sinceMs, nowMs) || Math.abs(sinceMs - nowMs) < 6 * DAY_MS;
    return !startHasClock || clock(sinceMs) === clock(untilMs) ? start : `${start} – ${clock(untilMs)}`;
  }
  // Today's end is said against the start, which gives it its weekday or date; any other end already carries its day.
  return `${start} – ${formatMoment(untilMs, sameDay(untilMs, nowMs) ? sinceMs : nowMs)}`;
}
