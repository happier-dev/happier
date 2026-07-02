/**
 * Formats a timestamp as a short relative time string (e.g. "1m", "2h", "3d", "1w").
 * Returns an empty string for invalid or future timestamps.
 */
export function formatShortRelativeTime(timestamp: number): string {
    return formatShortRelativeTimeAt(timestamp, Date.now());
}

export function formatShortRelativeTimeAt(timestamp: number, nowMs: number): string {
    const diff = nowMs - timestamp;
    if (diff < 0 || !Number.isFinite(diff)) return '';

    const seconds = Math.floor(diff / 1000);
    if (seconds < 60) return 'now';

    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m`;

    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h`;

    const days = Math.floor(hours / 24);
    if (days < 7) return `${days}d`;

    const weeks = Math.floor(days / 7);
    if (weeks < 5) return `${weeks}w`;

    const months = Math.floor(days / 30);
    if (months < 12) return `${months}mo`;

    const years = Math.floor(days / 365);
    return `${years}y`;
}
