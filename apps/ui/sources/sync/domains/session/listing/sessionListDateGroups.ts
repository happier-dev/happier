import { t } from '@/text';
import { formatRelativeTimeShort } from '@/utils/time/formatShortRelativeTime';

export type SessionListDateGroup<T> = Readonly<{
    dateKey: string;
    title: string;
    items: ReadonlyArray<T>;
}>;

function toLocalDateKey(timestamp: number): string {
    const date = new Date(timestamp);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** Whole local calendar days between a timestamp and now: the one day boundary groups and their rows share. */
function countCalendarDaysAgo(timestamp: number, nowMs: number): number {
    const groupDate = new Date(timestamp);
    const sessionDateOnly = new Date(groupDate.getFullYear(), groupDate.getMonth(), groupDate.getDate());
    const now = new Date(nowMs);
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return Math.round((today.getTime() - sessionDateOnly.getTime()) / (24 * 60 * 60 * 1000));
}

function resolveDateGroupTitle(timestamp: number, nowMs: number): string {
    const diffDays = countCalendarDaysAgo(timestamp, nowMs);
    if (diffDays <= 0) {
        return t('sessionHistory.today');
    }
    if (diffDays === 1) {
        return t('sessionHistory.yesterday');
    }
    return t('sessionHistory.daysAgo', { count: diffDays });
}

/**
 * A row's compact age inside a day-grouped list: within today the elapsed age ("5h"), otherwise the same calendar
 * day count its group title says ("6d" under "6 days ago"), so a row never disagrees with its heading.
 */
export function formatDayGroupedAgeShort(timestamp: number, nowMs: number): string {
    const diffDays = countCalendarDaysAgo(timestamp, nowMs);
    return diffDays <= 0 ? formatRelativeTimeShort(timestamp, nowMs) : t('time.daysAgoShort', { count: diffDays });
}

export function buildSessionListDateGroups<T>(params: Readonly<{
    items: ReadonlyArray<T>;
    readMeaningfulActivityAt: (item: T) => number;
    nowMs?: number;
}>): ReadonlyArray<SessionListDateGroup<T>> {
    const groups: Array<{ dateKey: string; title: string; items: T[] }> = [];
    const nowMs = params.nowMs ?? Date.now();
    for (const item of params.items) {
        const timestamp = params.readMeaningfulActivityAt(item);
        const dateKey = toLocalDateKey(timestamp);
        const current = groups[groups.length - 1];
        if (current?.dateKey === dateKey) {
            current.items.push(item);
            continue;
        }
        groups.push({
            dateKey,
            title: resolveDateGroupTitle(timestamp, nowMs),
            items: [item],
        });
    }
    return groups;
}
