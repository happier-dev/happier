import { t } from '@/text';

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
    const { deltaMs: diff, minutes, hours, days } = relativeTimeUnits(timestamp, nowMs);
    if (diff < 0 || !Number.isFinite(diff)) return '';

    const seconds = Math.floor(diff / 1000);
    if (seconds < 60) return 'now';

    if (minutes < 60) return `${minutes}m`;

    if (hours < 24) return `${hours}h`;

    if (days < 7) return `${days}d`;

    const weeks = Math.floor(days / 7);
    if (weeks < 5) return `${weeks}w`;

    const months = Math.floor(days / 30);
    if (months < 12) return `${months}mo`;

    const years = Math.floor(days / 365);
    return `${years}y`;
}
