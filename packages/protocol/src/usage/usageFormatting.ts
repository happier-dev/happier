function isValidUsageNumber(value: number): boolean {
    return Number.isFinite(value) && value >= 0;
}

function trimTrailingZero(value: string): string {
    return value.endsWith('.0') ? value.slice(0, -2) : value;
}

export function formatTokenCount(value: number): string {
    if (!isValidUsageNumber(value)) return '—';

    const count = Math.trunc(value);
    if (count >= 1_000_000_000) return `${trimTrailingZero((count / 1_000_000_000).toFixed(1))}B`;
    if (count >= 1_000_000) return `${trimTrailingZero((count / 1_000_000).toFixed(1))}M`;
    if (count >= 1_000) return `${trimTrailingZero((count / 1_000).toFixed(1))}k`;
    return String(count);
}

export function formatTokenCountLong(value: number, locales?: Intl.LocalesArgument): string {
    if (!isValidUsageNumber(value)) return '—';
    return new Intl.NumberFormat(locales).format(Math.trunc(value));
}

export function formatUsageCost(usd: number, currency: string): string {
    if (!isValidUsageNumber(usd)) return '—';

    // Cents from a dime up; smaller amounts keep the digits that show them.
    const maximumFractionDigits = usd < 0.1 ? 4 : 2;
    try {
        return new Intl.NumberFormat(undefined, {
            style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits,
        }).format(usd);
    } catch {
        return `${currency} ${usd.toFixed(maximumFractionDigits)}`;
    }
}

export function formatPercent(value: number): string {
    if (!isValidUsageNumber(value)) return '—';
    return `${trimTrailingZero(value.toFixed(1))}%`;
}

/** A share, not a percentage-valued measure. */
export const formatUsageSharePercent = (share: number): string => `${Math.round(share * 100)}%`;

/** Hours on the Usage chart's calendar, including its closing 24:00 tick. */
export const formatUsageChartClock = (hour: number): string => `${String(Math.floor(hour) % 24 === 0 && hour >= 24 ? 24 : Math.floor(hour) % 24).padStart(2, '0')}:${String(Math.round((hour % 1) * 60)).padStart(2, '0')}`;

/** The fixed calendar offset, stated rather than assumed to be the viewer's local zone. */
export function formatUsageUtcOffset(offsetMinutes: number): string {
    const sign = offsetMinutes < 0 ? '−' : '+';
    const absolute = Math.abs(Math.round(offsetMinutes));
    return `UTC${sign}${String(Math.floor(absolute / 60)).padStart(2, '0')}:${String(absolute % 60).padStart(2, '0')}`;
}

/** Usage bridge ids that explicitly mean the producing Agent was not attributed. */
export function isUnattributedUsageAgentId(agentId: string | null | undefined): boolean {
    const normalized = String(agentId ?? '').trim().toLowerCase();
    return normalized === '' || normalized === 'unknown' || normalized === 'legacy';
}

/** Keep a short trailing model/Agent-id segment together with a non-breaking hyphen. */
export function formatIdentifierLabel(value: string): string {
    return value.replace(/-(?=[^-]{1,3}$)/, '‑');
}

export type UsageDurationLabels = Readonly<{
    seconds(value: number): string;
    minutes(value: number): string;
    hours(hours: number, minutes: number): string;
}>;

function usageDurationParts(ms: number) {
    const seconds = Math.max(0, Math.round(ms / 1000));
    return { seconds, minutes: Math.round(seconds / 60) };
}

/** A measured duration; labels retain the host's language and a measured zero is not missing. */
export function formatUsageDuration(ms: number, labels: UsageDurationLabels): string {
    const { seconds, minutes } = usageDurationParts(ms);
    if (seconds < 60) return seconds === 0 ? labels.minutes(0) : labels.seconds(seconds);
    if (minutes < 60) return labels.minutes(minutes);
    return labels.hours(Math.floor(minutes / 60), minutes % 60);
}

/** Native narrow unit names, preserving the measured-duration rounding used by the long form. */
export function formatUsageDurationCompact(ms: number, locales?: Intl.LocalesArgument): string {
    const { seconds, minutes } = usageDurationParts(ms);
    const unit = (value: number, name: 'hour' | 'minute' | 'second') =>
        new Intl.NumberFormat(locales, { style: 'unit', unit: name, unitDisplay: 'narrow' }).format(value);
    if (seconds > 0 && seconds < 60) return unit(seconds, 'second');
    if (minutes < 60) return unit(minutes, 'minute');
    return minutes % 60 === 0 ? unit(minutes / 60, 'hour')
        : `${unit(Math.floor(minutes / 60), 'hour')} ${unit(minutes % 60, 'minute')}`;
}

/** Hosts may retain their existing Intl formatter cache without owning calendar semantics. */
export type UsageDateTimeFormatter = (
    timestampMs: number, locales: Intl.LocalesArgument, options: Intl.DateTimeFormatOptions,
) => string;

const formatDateTime: UsageDateTimeFormatter = (timestampMs, locales, options) =>
    new Intl.DateTimeFormat(locales, options).format(timestampMs);

export function formatUsageCalendarDate(timestampMs: number, timeZoneOffsetMinutes: number,
    options: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', year: 'numeric' },
    locales?: Intl.LocalesArgument, formatter: UsageDateTimeFormatter = formatDateTime): string {
    return formatter(timestampMs + timeZoneOffsetMinutes * 60_000, locales, { ...options, timeZone: 'UTC' });
}

/** Exact bounded calendar dates, with an exclusive end and a single label for one displayed day. */
export function formatUsageCalendarRange(startMs: number, endMs: number, timeZoneOffsetMinutes: number,
    locales?: Intl.LocalesArgument, formatter: UsageDateTimeFormatter = formatDateTime): string {
    const start = formatUsageCalendarDate(startMs, timeZoneOffsetMinutes, undefined, locales, formatter);
    const end = formatUsageCalendarDate(Math.max(startMs, endMs - 1), timeZoneOffsetMinutes, undefined, locales, formatter);
    return start === end ? start : `${start} – ${end}`;
}
