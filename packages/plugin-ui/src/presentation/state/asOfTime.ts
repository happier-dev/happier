/**
 * When cached facts were read, as a person says it: the time for a read made today ("10:42"), the
 * day and time for an older one ("26 Sep, 18:44"). Never seconds or the year.
 *
 * The one "as of" formatter: Happier core's freshness line and the public plugin `FreshnessLine`
 * both say it through here, so a stale pane reads the same whoever drew it.
 */
export function formatHappierAsOfTime(at: number, now: number = Date.now(), locale?: string): string {
  const locales = locale === undefined ? [] : [locale];
  const read = new Date(at);
  const today = new Date(now);
  const time = read.toLocaleTimeString(locales, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const sameDay = read.getFullYear() === today.getFullYear()
    && read.getMonth() === today.getMonth()
    && read.getDate() === today.getDate();
  if (sameDay) return time;
  return `${read.toLocaleDateString(locales, { day: 'numeric', month: 'short' })}, ${time}`;
}

/**
 * The one text policy of a freshness line (UI primitives audit P1), shared by Happier core's
 * `SurfaceFreshnessLine` and the public plugin `FreshnessLine` so the two cannot drift: "As of 10:42 ·
 * why" when the content's read time is known, the reason alone otherwise — busy or not. Each realm
 * keeps its own render binding and says "As of {time}" in its own i18n (`formatAsOf`).
 */
export function resolveHappierFreshnessText(input: Readonly<{
  asOf?: number | null;
  reason: string;
  formatAsOf: (time: string) => string;
  now?: number;
}>): string {
  if (typeof input.asOf !== 'number') return input.reason;
  const asOf = input.formatAsOf(formatHappierAsOfTime(input.asOf, input.now));
  return input.reason ? `${asOf} · ${input.reason}` : asOf;
}
