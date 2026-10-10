import type { ConversationSearchMachineStatus, ConversationSearchResult } from '@/sync/domains/search/searchConversations';
import { t } from '@/text';

type CoverageGap = Exclude<ConversationSearchMachineStatus['status'], 'ok'>;

/** Most blocking first: a machine that cannot answer at all, then one that answered in part. */
const GAP_ORDER: readonly CoverageGap[] = ['offline', 'outdated', 'disabled-by-settings', 'partial'];

function describeGap(gap: CoverageGap, machines: string): string {
    switch (gap) {
        case 'offline': return t('conversationSearch.coverageOffline', { machines });
        case 'outdated': return t('conversationSearch.coverageOutdated', { machines });
        case 'disabled-by-settings': return t('conversationSearch.coverageDisabled', { machines });
        case 'partial': return t('conversationSearch.coveragePartial', { machines });
    }
}

/**
 * The one quiet line saying which machines a conversation search did not fully cover, and why. Full
 * coverage says nothing. The palette, its scan results and History read it the same way, so a machine
 * that is offline is "offline" everywhere rather than "partial" in one place.
 */
export function describeConversationSearchCoverage(input: Readonly<{
    machines: ConversationSearchResult['machines'];
    homeStatus?: ConversationSearchResult['homeStatus'];
    machineName: (machineId: string) => string;
    /** Gaps this surface does not report (a machine whose index is off, where the Home answers instead). */
    omit?: readonly CoverageGap[];
}>): string {
    const parts: string[] = [];
    if (input.homeStatus === 'unavailable') parts.push(t('conversationSearch.coverageHomeUnavailable'));
    for (const gap of GAP_ORDER) {
        if (input.omit?.includes(gap)) continue;
        const names = input.machines.filter((machine) => machine.status === gap).map((machine) => input.machineName(machine.machineId));
        if (names.length > 0) parts.push(describeGap(gap, names.join(', ')));
    }
    return parts.join(' · ');
}
