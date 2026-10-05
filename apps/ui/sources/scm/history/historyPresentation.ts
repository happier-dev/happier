import { formatShortRelativeTime } from '@/utils/time/formatShortRelativeTime';

export const SCM_HISTORY_INITIAL_VISIBLE_COUNT = 12;
export const SCM_HISTORY_LOAD_MORE_VISIBLE_STEP = 25;
export const SCM_HISTORY_PAGE_SIZE = 50;

export function formatScmHistoryTimestamp(timestampMs: number): string {
    if (!Number.isFinite(timestampMs) || timestampMs <= 0) {
        return '';
    }

    const relative = formatShortRelativeTime(timestampMs);
    if (relative.length > 0) {
        return relative;
    }

    return new Date(timestampMs).toLocaleDateString();
}

export function formatScmHistoryTimestampAccessibilityLabel(timestampMs: number): string {
    if (!Number.isFinite(timestampMs) || timestampMs <= 0) {
        return '';
    }

    return new Date(timestampMs).toLocaleString();
}

const WEEK_MS = 6 * 24 * 60 * 60 * 1000;

/**
 * When a timeline item happened, in the fewest words for its left column: the time today, the
 * weekday within the week, the day and month before that.
 */
/** The time of day only (the timeline's day groups already say which day). */
export function formatScmTimelineTime(timestampMs: number): string {
    if (!Number.isFinite(timestampMs) || timestampMs <= 0) return '';
    return new Date(timestampMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

export function formatScmTimelineWhen(timestampMs: number, nowMs: number = Date.now()): string {
    if (!Number.isFinite(timestampMs) || timestampMs <= 0) return '';
    const at = new Date(timestampMs);
    const now = new Date(nowMs);
    const sameDay = at.getFullYear() === now.getFullYear()
        && at.getMonth() === now.getMonth()
        && at.getDate() === now.getDate();
    if (sameDay) return formatScmTimelineTime(timestampMs);
    if (nowMs - timestampMs < WEEK_MS && nowMs > timestampMs) return at.toLocaleDateString([], { weekday: 'short' });
    return at.toLocaleDateString([], { day: 'numeric', month: 'short' });
}
