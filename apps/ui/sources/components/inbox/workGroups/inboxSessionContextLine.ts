import type { InboxSessionAttentionEntry } from '@/activity/presentation/buildInboxSessionPresentation';
import { t } from '@/text';

/**
 * What an Inbox session row says under its title: a lead's working reports (ORC R-10), then where
 * it runs. Pure, so the Voice brief draws the same line without importing the row's component tree.
 */
export function buildInboxSessionContextLine(candidate: InboxSessionAttentionEntry['candidate']): string | undefined {
    const reports = candidate.session.reports;
    const outstandingReports = reports ? reports.working + reports.needsYou + reports.stalled : 0;
    const context = (candidate.context?.contextLine ?? candidate.subtitle).trim();
    return joinFacts(
        outstandingReports > 0 ? t('sessionWork.strip.stillWorking', { count: outstandingReports }) : null,
        context,
    ) || undefined;
}

export function joinFacts(...facts: ReadonlyArray<string | null | undefined>): string {
    return facts.filter((fact): fact is string => typeof fact === 'string' && fact.length > 0).join(' · ');
}
