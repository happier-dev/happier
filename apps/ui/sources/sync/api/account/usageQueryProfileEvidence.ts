import type { UsageQueryResultSlice, UsageWorkSourceSnapshot } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import { projectUsageAgentCalendar } from '@happier-dev/protocol/usage/usageAgentCalendar';
import { projectUsageWorkSummary, resolveUsageWorkOutcomeAdmissions } from '@happier-dev/protocol/usage/usageOutcomeAllocation';
import { projectPublicProfileIntervalFacts, projectPublicProfileSessionDurations, projectPublicProfilePopulationFacts,
    projectPublicProfileLensIntervals, projectPublicProfilePrivateFieldCoverage,
    type PublicProfileAccountingPopulation } from '@happier-dev/protocol/account/publicProfileSnapshot';

/** Strip private event detail only after the existing owners have projected the profile's consented facts. */
export function projectUsageQueryProfileEvidence(slice: UsageQueryResultSlice, workSource: UsageWorkSourceSnapshot | undefined): UsageQueryResultSlice {
    const prepared = slice.accounting?.summary?.publicProfileAccounting;
    if (slice.requestedQuery.population !== 'public_eligible_personal' || !prepared) return slice;
    const accounting = slice.accounting;
    const detail = slice.howYouWork;
    const intervals = detail?.detailStatus !== 'unknown' ? detail?.intervals : undefined;
    const period = { startMs: prepared.period.startMs, endMs: prepared.period.endMs };
    const projectCalendar = (population: PublicProfileAccountingPopulation, selectedIntervals: typeof intervals) => projectUsageAgentCalendar({
        accounting, period, timeZoneOffsetMinutes: prepared.period.timeZoneOffsetMinutes,
        costMode: population.calendar.costMode,
        accountingCalendar: { accounting, period, timeZoneOffsetMinutes: prepared.period.timeZoneOffsetMinutes,
            costMode: population.calendar.costMode, projection: population.calendar },
        intervals: selectedIntervals, detailStatus: selectedIntervals ? detail?.detailStatus : 'unknown', nightHours: detail?.nightShift ?? undefined,
    });
    const calendar = detail?.agentCalendar ?? projectCalendar(prepared.total, intervals);
    const accountingFacts = (population: PublicProfileAccountingPopulation, selectedCalendar: typeof calendar) => {
        const facts = projectPublicProfilePopulationFacts(population, selectedCalendar);
        return { agentMix: facts.agentMix, agentActiveDays: facts.agentActiveDays, weeklyAgentMix: facts.weeklyAgentMix };
    };
    const retained = slice.publicProfileEvidence;
    const facts = { ...retained?.facts, ...projectPublicProfileIntervalFacts(intervals, calendar),
        ...(detail?.detailStatus !== 'unknown' && detail?.runLengths
            ? { sessionDurations: projectPublicProfileSessionDurations(detail.runLengths) } : {}) };
    const readableWork = workSource && ['available', 'partial', 'stale'].includes(workSource.status);
    if (readableWork && slice.workSummary) facts.mergedPrs = slice.workSummary.mergedPrCount;
    const fieldCoverage = { ...projectPublicProfilePrivateFieldCoverage({ intervals, detailStatus: detail?.detailStatus ?? 'unknown',
        runLengths: detail?.runLengths, calendar, accountingCoverage: prepared.total.coverage, hasMergedOutcomes: facts.mergedPrs !== undefined }),
        ...retained?.fieldCoverage };
    const lenses = prepared.lenses.map(lens => {
        const prior = retained?.lenses.find(prior => prior.execution === lens.execution);
        const selectedIntervals = projectPublicProfileLensIntervals({ intervals, detailStatus: detail?.detailStatus ?? 'unknown',
            accounting: prepared, execution: lens.execution, period: prepared.period });
        const selectedCalendar = projectCalendar(lens.population, selectedIntervals);
        const selectedFacts = { ...prior?.facts, ...projectPublicProfileIntervalFacts(selectedIntervals, selectedCalendar) };
        if (readableWork) {
            const turns = prepared.membership.turns.filter(turn => turn.executions.includes(lens.execution));
            selectedFacts.mergedPrs = projectUsageWorkSummary(resolveUsageWorkOutcomeAdmissions({ turns,
                evidence: workSource.evidence ?? [] }).outcomes).mergedPrCount;
        }
        return { execution: lens.execution, facts: selectedFacts,
            accountingFacts: prior?.accountingFacts ?? accountingFacts(lens.population, selectedCalendar) };
    });
    const { howYouWork: _detail, work: _work, mergedOutcomes: _outcomes, coach: _coach, ...bounded } = slice;
    return { ...bounded, publicProfileEvidence: { facts, fieldCoverage,
        accountingFacts: retained?.accountingFacts ?? accountingFacts(prepared.total, calendar), lenses } };
}
