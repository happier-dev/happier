import { t } from '@/text';
import type { UpdatesSummary } from '@/updates/items/buildUpdatesSummary';
import type { UpdateAllProgress } from '@/updates/useUpdatesContentModel';
import { formatLastSeen } from '@/utils/sessions/sessionUtils';

export type UpdatesHeaderPresentation = Readonly<{
    title: string;
    /** Always a line (its age, or what to expect), so the header keeps one height across states. */
    meta: string;
    showUpdateAll: boolean;
    showStop: boolean;
    /** Nothing to show but the calm "You're up to date" state. */
    empty: boolean;
}>;

/**
 * The Updates header, from the one summary (the same ranking the pill uses). It never says
 * "Updating…" while updates are waiting to be taken, and never "up to date" unless every row
 * proved it.
 */
export function describeUpdatesHeader(
    summary: UpdatesSummary,
    batch: UpdateAllProgress | null,
    facts: Readonly<{ checkedAt: number | null; uncheckedMachineCount: number; checking?: boolean }>,
): UpdatesHeaderPresentation {
    // Under a result: which machines were not asked yet when some were not, otherwise when things
    // were last checked; "Not checked yet" only when nothing has been checked at all.
    const checked = facts.uncheckedMachineCount > 0
        ? t('updates.summary.uncheckedMeta')
        : facts.checkedAt
            ? t('updates.summary.checkedAt', { time: formatLastSeen(facts.checkedAt) })
            : t('updates.summary.notCheckedYet');
    const base = { showUpdateAll: false, showStop: false, empty: false };
    if (batch) {
        return {
            ...base,
            title: t('updates.summary.updatingBatch', { done: batch.done, total: batch.total }),
            meta: t('updates.summary.keepWorking'),
            showStop: !batch.stopping,
        };
    }
    if (facts.checking) return { ...base, title: t('updates.summary.checking'), meta: checked };
    const showUpdateAll = summary.actionableCount >= 2;
    switch (summary.phase) {
        case 'required':
            return { ...base, title: t('updates.summary.required'), meta: checked, showUpdateAll };
        case 'failed':
            return { ...base, title: t('updates.summary.failedCount', { count: summary.failedCount }), meta: checked, showUpdateAll };
        case 'available':
            return { ...base, title: t('updates.summary.available', { count: summary.actionableCount }), meta: checked, showUpdateAll };
        case 'running':
            return { ...base, title: t('updates.summary.updating'), meta: t('updates.summary.keepWorking') };
        case 'ready':
            return { ...base, title: t('updates.summary.ready'), meta: checked };
        case 'completed':
        case 'none':
            break;
    }
    switch (summary.status) {
        case 'checking':
            return { ...base, title: t('updates.summary.checking'), meta: checked };
        case 'unchecked':
            return { ...base, title: t('updates.summary.unchecked'), meta: checked };
        case 'unknown':
            return { ...base, title: t('updates.summary.unknown'), meta: checked };
        case 'offline':
            return { ...base, title: t('updates.summary.offline'), meta: checked };
        default:
            return { ...base, title: t('updates.summary.upToDate'), meta: checked, empty: true };
    }
}

/** Settings › General › Updates subtitle: the durable entry, which says "Up to date" only when proven. */
export function describeUpdatesSettingsSubtitle(summary: UpdatesSummary): string {
    switch (summary.status) {
        case 'available':
            return t('updates.settingsSubtitle.available', { count: summary.actionableCount });
        case 'running':
            return t('updates.settingsSubtitle.running');
        case 'ready':
            return t('updates.settingsSubtitle.ready');
        case 'required':
            return t('updates.settingsSubtitle.required');
        case 'failed':
            return t('updates.settingsSubtitle.failed');
        case 'unknown':
            return t('updates.settingsSubtitle.unknown');
        case 'unchecked':
            return t('updates.settingsSubtitle.unchecked');
        case 'offline':
            return t('updates.settingsSubtitle.offline');
        case 'checking':
            return t('updates.settingsSubtitle.checking');
        case 'completed':
        case 'upToDate':
        case 'none':
            return t('updates.settingsSubtitle.upToDate');
    }
}

/**
 * The tray's optional Updates item (sent in the localized tray payload); `null` = no item.
 * "Updating…" only reports, so it is disabled; every other phase opens Updates.
 */
export function describeUpdatesTrayItem(summary: UpdatesSummary): Readonly<{ label: string; enabled: boolean }> | null {
    switch (summary.phase) {
        case 'none':
        case 'completed':
            return null;
        case 'available':
            return { label: t('updates.tray.available', { count: summary.actionableCount }), enabled: true };
        case 'running':
            return { label: t('updates.tray.running'), enabled: false };
        case 'ready':
            return { label: t('updates.tray.ready'), enabled: true };
        case 'required':
            return { label: t('updates.tray.required'), enabled: true };
        case 'failed':
            return { label: t('updates.tray.failed'), enabled: true };
    }
}
