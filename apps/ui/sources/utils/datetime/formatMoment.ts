import { getPreferredLanguage } from '@/text';
import { formatWithCachedDateTimeFormatter } from '@/utils/datetime/cachedIntlFormatters';

const DAY_MS = 24 * 60 * 60 * 1000;

/** A moment near now in the app's language: today's clock time, a nearby weekday and time, else its calendar date. */
export function formatMoment(atMs: number, nowMs: number): string {
  const when = new Date(atMs);
  const now = new Date(nowMs);
  const locale = getPreferredLanguage();
  const time = formatWithCachedDateTimeFormatter(when, locale, {
    hour: '2-digit',
    minute: '2-digit',
  });
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
