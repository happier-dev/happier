import { getPreferredLanguage } from '@/text';
import { formatWithCachedDateTimeFormatter } from '@/utils/datetime/cachedIntlFormatters';

export function formatServiceCheckMoment(atMs: number, nowMs = Date.now()): string {
  const includeDate = new Date(atMs).toDateString() !== new Date(nowMs).toDateString();
  return formatWithCachedDateTimeFormatter(atMs, getPreferredLanguage(), {
    ...(includeDate ? { month: 'short', day: 'numeric' } : {}),
    hour: 'numeric',
    minute: '2-digit',
  });
}
