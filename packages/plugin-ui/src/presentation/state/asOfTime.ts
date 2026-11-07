/**
 * When cached facts were read, as a person says it: the time for a read made today ("10:42"), the
 * day and time for an older one ("26 Sep, 18:44"), in the viewer's own locale clock like every other time
 * on the page. Never seconds or the year.
 *
 * The one "as of" formatter: Happier core's freshness line and the public plugin `FreshnessLine`
 * both say it through here, so a stale pane reads the same whoever drew it.
 */
export function formatHappierAsOfTime(at: number, now: number = Date.now(), locale?: string): string {
  const locales = locale === undefined ? [] : [locale];
  const read = new Date(at);
  const today = new Date(now);
  // `numeric` hour: "3:42 PM" as people say it, never a padded "03:42 PM".
  const time = read.toLocaleTimeString(locales, { hour: 'numeric', minute: '2-digit' });
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
type HappierFreshnessTextInput = Readonly<{
  asOf?: number | null;
  reason: string;
  formatAsOf: (time: string) => string;
  now?: number;
  /** The locale the host shows its other times in; the runtime's own when absent. */
  locale?: string;
}>;

export type HappierFreshnessTextParts = Readonly<{ text: string; asOf: string | null; reason: string }>;

/** Separate clauses for wrapping layouts; existing callers retain the joined string API. */
export function resolveHappierFreshnessText(input: HappierFreshnessTextInput & { parts: true }): HappierFreshnessTextParts;
export function resolveHappierFreshnessText(input: HappierFreshnessTextInput & { parts?: false }): string;
export function resolveHappierFreshnessText(input: HappierFreshnessTextInput & { parts?: boolean }): string | HappierFreshnessTextParts {
  const asOf = typeof input.asOf === 'number'
    ? input.formatAsOf(formatHappierAsOfTime(input.asOf, input.now, input.locale))
    : null;
  const text = asOf !== null ? (input.reason ? `${asOf} · ${input.reason}` : asOf) : input.reason;
  return input.parts ? { text, asOf, reason: input.reason } : text;
}
