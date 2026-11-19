import { getPreferredLanguage } from '@/text';
import { getCachedDateTimeFormatter } from '@/utils/datetime/cachedIntlFormatters';

/**
 * When a Check last answered: its clock time today, else its date and time. The time stays one unit: the space before
 * a day period ("2:54 AM") is non-breaking, so a narrow State cell wraps before the time, never inside it
 * (PAGE-ACCEPT-176 R4-D1; V8 formats that space as an ordinary one).
 */
export function formatServiceCheckMoment(atMs: number, nowMs = Date.now()): string {
  const includeDate = new Date(atMs).toDateString() !== new Date(nowMs).toDateString();
  const parts = getCachedDateTimeFormatter(getPreferredLanguage(), {
    ...(includeDate ? { month: 'short', day: 'numeric' } : {}),
    hour: 'numeric',
    minute: '2-digit',
  }).formatToParts(atMs);
  return parts.map((part, index) => part.type === 'literal' && parts[index + 1]?.type === 'dayPeriod'
    ? part.value.replace(/\s+/g, ' ') : part.value).join('');
}
