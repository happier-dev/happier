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
