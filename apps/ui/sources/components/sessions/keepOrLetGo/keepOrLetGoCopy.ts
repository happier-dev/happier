import { t } from '@/text';
import { getCachedIntlDateTimeFormat } from '@/utils/datetime/cachedIntlFormatters';

/**
 * The words of the leaving foot, the row label and the Keep stack, as pure functions of their facts.
 *
 * A moved session stays in the list under the tab this release names it by (0.2: Direct), so every
 * "stays in your list under …" sentence takes that tab's own label instead of a second name for it.
 */

export function formatLeavingDate(ms: number, nowMs: number): string {
    const date = new Date(ms);
    return getCachedIntlDateTimeFormat(undefined, {
        month: 'short',
        day: 'numeric',
        year: date.getFullYear() !== new Date(nowMs).getFullYear() ? 'numeric' : undefined,
    }).format(date);
}

export function formatLeavingRowLabel(leavesAt: number, nowMs: number): string {
    return leavesAt <= nowMs
        ? t('keepOrLetGo.rowLeavingNow')
        : t('keepOrLetGo.rowLeaves', { date: formatLeavingDate(leavesAt, nowMs) });
}

export function movedSessionsTabLabel(): string {
    return t('sessionsList.storageDirectTab');
}

function sameCalendarDay(left: number, right: number): boolean {
    return new Date(left).toDateString() === new Date(right).toDateString();
}

/** "2 kept with a pin · 2 leave the cloud on 31 Dec and stay in your list under Direct." */
export function formatAllSetSummary(input: Readonly<{
    kept: number;
    letGoLeavesAt: readonly number[];
    nowMs: number;
}>): string {
    const letGo = input.letGoLeavesAt.length;
    const latest = letGo > 0 ? Math.max(...input.letGoLeavesAt) : input.nowMs;
    const earliest = letGo > 0 ? Math.min(...input.letGoLeavesAt) : input.nowMs;
    return t('keepOrLetGo.allSetSummary', {
        kept: input.kept,
        letGo,
        // One date when they share a day ("on 31 Dec"); otherwise the last one ("by 4 Jan"), which is
        // true of all of them.
        date: formatLeavingDate(latest, input.nowMs),
        sameDay: sameCalendarDay(earliest, latest),
        tab: movedSessionsTabLabel(),
    });
}
