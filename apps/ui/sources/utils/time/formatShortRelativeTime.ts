import { t } from '@/text';

/** Locale-aware relative label with an absolute-date fallback for Hermes builds without RelativeTimeFormat. */
export function formatRelativeTimeOrAbsolute(
    atMs: number,
    value: number,
    unit: Intl.RelativeTimeFormatUnit,
    locales?: Intl.LocalesArgument,
): string {
    try {
        return new Intl.RelativeTimeFormat(locales, { numeric: value === 1 || value === -1 ? 'auto' : 'always' }).format(value, unit);
    } catch {
        return new Intl.DateTimeFormat(locales, { dateStyle: 'medium' }).format(new Date(atMs));
    }
}

function relativeTimeUnits(timestamp: number, nowMs: number) {
    const deltaMs = nowMs - timestamp;
    return {
        deltaMs,
        minutes: Math.floor(deltaMs / 60_000),
        hours: Math.floor(deltaMs / 3_600_000),
        days: Math.floor(deltaMs / 86_400_000),
    };
}

/** Localized compact age; future timestamps read as now and old ages stay in days. */
export function formatRelativeTimeShort(atMs: number, nowMs: number): string {
    const { deltaMs, minutes, hours, days } = relativeTimeUnits(atMs, nowMs);
    if (deltaMs < 60_000) return t('time.nowShort');
    if (minutes < 60) return t('time.minutesAgoShort', { count: minutes });
    if (hours < 24) return t('time.hoursAgoShort', { count: hours });
    return t('time.daysAgoShort', { count: days });
}

/** The next change of the compact localized age, including future timestamps reading as now. */
export function readRelativeTimeShortRefreshAtMs(atMs: number, nowMs: number): number | null {
    if (!Number.isFinite(atMs) || !Number.isFinite(nowMs)) return null;
    const { minutes, hours, days } = relativeTimeUnits(atMs, nowMs);
    if (minutes < 1) return atMs + 60_000;
    if (minutes < 60) return atMs + (minutes + 1) * 60_000;
    if (hours < 24) return atMs + (hours + 1) * 3_600_000;
    return atMs + (days + 1) * 86_400_000;
}

/** Full localized feed age, sharing the same minute/hour/day boundaries. */
export function formatRelativeTime(timestamp: number, nowMs = Date.now()): string {
    const { minutes, hours, days } = relativeTimeUnits(timestamp, nowMs);
    if (minutes < 1) return t('time.justNow');
    if (minutes < 60) return t('time.minutesAgo', { count: minutes });
    if (hours < 24) return t('time.hoursAgo', { count: hours });
    return t('sessionHistory.daysAgo', { count: days });
}

/**
 * Formats a timestamp as a short relative time string (e.g. "1m", "2h", "3d", "1w").
 * Returns an empty string for invalid or future timestamps.
 */
export function formatShortRelativeTime(timestamp: number): string {
    return formatShortRelativeTimeAt(timestamp, Date.now());
}

export function formatShortRelativeTimeAt(timestamp: number, nowMs: number): string {
    return shortRelativeTimeDisplay(timestamp, nowMs).label;
}

/** Exact boundary of the same label, so an old row does not tick every minute. */
export function readShortRelativeTimeRefreshAtMs(timestamp: number, nowMs: number): number | null {
    return shortRelativeTimeDisplay(timestamp, nowMs).nextAtMs;
}

function shortRelativeTimeDisplay(timestamp: number, nowMs: number): Readonly<{ label: string; nextAtMs: number | null }> {
    const { deltaMs: diff, minutes, hours, days } = relativeTimeUnits(timestamp, nowMs);
    if (!Number.isFinite(diff)) return { label: '', nextAtMs: null };
    if (diff < 0) return { label: '', nextAtMs: timestamp };

    const seconds = Math.floor(diff / 1000);
    if (seconds < 60) return { label: 'now', nextAtMs: timestamp + 60_000 };

    if (minutes < 60) return { label: `${minutes}m`, nextAtMs: timestamp + (minutes + 1) * 60_000 };

    if (hours < 24) return { label: `${hours}h`, nextAtMs: timestamp + (hours + 1) * 3_600_000 };

    if (days < 7) return { label: `${days}d`, nextAtMs: timestamp + (days + 1) * 86_400_000 };

    const weeks = Math.floor(days / 7);
    if (weeks < 5) return { label: `${weeks}w`, nextAtMs: timestamp + (weeks + 1) * 7 * 86_400_000 };

    const months = Math.floor(days / 30);
    if (months < 12) return { label: `${months}mo`, nextAtMs: timestamp + (months + 1) * 30 * 86_400_000 };

    // Twelve 30-day months end at 360 days, before the first 365-day year.
    const years = Math.max(1, Math.floor(days / 365));
    return { label: `${years}y`, nextAtMs: timestamp + (years + 1) * 365 * 86_400_000 };
}
