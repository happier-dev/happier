import type { UsageQueryResultSlice } from './resolveUsagePageAggregation.js';
import { resolveUsageQueryPeriod } from '../inputs/usageQuery.js';
import { projectUsagePageCost } from './usageCostFacts.js';
import { projectUsageCostFactTotals } from './usageCostFactTotals.js';
import { summarizeUsageExecutionSources } from './usageSourceSummary.js';
import { UsageRecapComposeResultSchema, USAGE_RECAP_FIELDS,
  type UsageRecapPrivateComposeInput, type UsageRecapComposeResult, type UsageRecapFacts } from './usageRecap.js';

/** Project schema-admitted input and its correlated read, admitted by the Usage Action owner. */
export function composeUsageRecap(args: Readonly<{
  input: UsageRecapPrivateComposeInput;
  snapshot: UsageQueryResultSlice;
}>): UsageRecapComposeResult {
  const { input, snapshot } = args;
  const key = snapshot.key;
  const accounting = snapshot.accounting;
  if (!accounting) return { kind: 'unavailable', reason: 'accounting_unavailable' };
  const witnessedPeriod = 'relative' in input.query.period
    ? accounting.coverage?.range ?? {} : input.query.period;
  const endMs = witnessedPeriod.endMs;
  if (endMs === undefined) return { kind: 'unavailable', reason: 'period_unavailable' };
  const requestedPeriod = resolveUsageQueryPeriod(input.query, endMs);
  const startMs = requestedPeriod.startMs === undefined
    ? accounting.coverage?.range.startMs ?? 0 : witnessedPeriod.startMs;
  if (startMs === undefined || endMs < startMs) return { kind: 'unavailable', reason: 'period_unavailable' };
  const selectedFields = USAGE_RECAP_FIELDS.filter(field => input.selectedFields.includes(field));
  const selected = new Set(selectedFields);
  const facts: UsageRecapFacts = {};
  if (selected.has('tokens')) facts.tokens = accounting.totals.tokens;
  if (selected.has('activeDays') && accounting.insights) facts.activeDays = accounting.insights.activeDays;
  if (selected.has('streak') && accounting.insights && accounting.coverage?.range.complete) {
    facts.streak = { longestDays: accounting.insights.longestStreakDays };
  }
  for (const [field, dimension] of [['modelMix', 'model'], ['agentMix', 'agent']] as const) {
    const rows = accounting.breakdowns?.[dimension];
    if (selected.has(field) && rows) facts[field] = rows.map(row => ({ tokens: row.tokens.total, events: row.eventCount,
      ...(dimension === 'agent' && row.key ? { agentId: row.key } : {}),
      ...(selected.has('names') && row.label ? { name: row.label } : {}) }));
  }
  if (selected.has('cache')) facts.cache = { readTokens: accounting.totals.tokens.cacheRead, writeTokens: accounting.totals.tokens.cacheWrite };
  if (selected.has('rhythm') && accounting.activity?.calendarDays && accounting.activity.weekdayHourBuckets) {
    facts.rhythm = { calendarDays: accounting.activity.calendarDays, weekdayHourBuckets: accounting.activity.weekdayHourBuckets };
  }
  const intervals = snapshot.howYouWork?.intervals;
  const sameIntervalPeriod = intervals?.period.startMs === startMs && intervals.period.endMs === endMs
    && intervals.timeZoneOffsetMinutes === input.query.timeZoneOffsetMinutes;
  if (selected.has('parallel') && intervals && sameIntervalPeriod) facts.parallel = {
    sumAgentMs: intervals.agentTimeMs, unionElapsedMs: intervals.elapsedBusyMs, maximumConcurrency: intervals.maxParallel,
  };
  const nightShift = snapshot.howYouWork?.nightShift;
  if (selected.has('night') && nightShift && (!intervals || sameIntervalPeriod)) facts.night = nightShift;
  const workStatus = snapshot.sources.find(row => row.source === 'work')?.status;
  // Unavailable Work evidence can still project an empty outcome list. Only
  // admitted reads or retained positive witnesses establish recap Work facts.
  const work = (workStatus !== undefined && ['available', 'partial', 'stale'].includes(workStatus))
    || (workStatus === 'pending' && (snapshot.work?.outcomes.length ?? 0) > 0) ? snapshot.work : undefined;
  if (selected.has('work') && work) facts.work = { linkedOutcomes: work.outcomes.length,
    allocatedContributions: work.allocations.filter(row => row.outcome !== null).length,
    unallocatedContributions: work.allocations.filter(row => row.outcome === null).length };
  const coach = snapshot.coach;
  const coachFindings = selected.has('coach') && coach?.queryKey === key
    && coach.period.startMs === startMs && coach.period.endMs === endMs
    ? coach.findings.filter(row => row.coverage !== 'unknown' && row.evidence.length > 0) : [];
  if (coachFindings.length > 0) facts.coach = { findings: coachFindings.map(row => ({
    detectorId: row.detectorId, evidenceCount: row.evidence.length,
  })) };
  if (selected.has('highlights')) {
    facts.highlights = [];
    const peak = accounting.series?.reduce<(NonNullable<typeof accounting.series>)[number] | undefined>((current, row) =>
      row.tokens.total > 0 && (!current || row.tokens.total > current.tokens.total) ? row : current, undefined);
    if (peak) facts.highlights.push({ kind: 'observed_peak', bucketStartMs: peak.bucketStartMs, bucketEndMs: peak.bucketEndMs, tokens: peak.tokens.total });
    if (work?.outcomes.length) facts.highlights.push({ kind: 'linked_outcomes', count: work.outcomes.length });
  }
  if (selected.has('dollars')) {
    const cost = projectUsagePageCost(accounting, input.query.costBasis);
    // Reuse both cost owners: scoped selection and kind/currency comparison totals.
    // Private producer/pricing identities never enter a share result.
    if (cost.amountUsd !== null || accounting.costFacts?.length) facts.dollars = { basis: input.query.costBasis,
      selected: cost.selection && cost.amountUsd !== null ? { kind: cost.selection.kind,
        currency: cost.selection.currency, amountUsd: cost.amountUsd } : null,
      facts: projectUsageCostFactTotals(accounting.costFacts ?? []).map(({ sources: _sources, ...fact }) => fact) };
  }
  const coverage = accounting.coverage;
  const accountingCoverage = coverage ? (({ sources: _sources, ...value }) => value)(coverage) : null;
  const source = snapshot.sources.find(row => row.source === 'accounting');
  const execution = accounting.summary?.execution ?? summarizeUsageExecutionSources(accounting.contributions);
  return UsageRecapComposeResultSchema.parse({ kind: 'composed', v: 1, style: input.style, format: input.format,
    sourceSelection: input.sourceSelection,
    selectedFields, unavailableFields: selectedFields.filter(field => field !== 'names' && !(field in facts)),
    period: { startMs, endMs, timeZoneOffsetMinutes: input.query.timeZoneOffsetMinutes }, asOfMs: source?.asOfMs ?? null,
    coverage: { accounting: accountingCoverage,
      execution: { status: execution.coverage },
      sourceCoverage: coverage?.sources.map(row => ({ status: row.status, eventCount: row.eventCount, historyComplete: row.historyComplete ?? null,
        ...(row.asOfMs === undefined ? {} : { asOfMs: row.asOfMs }) })) ?? [],
      sourceStatuses: snapshot.sources.map(row => ({ status: row.status, ...(row.asOfMs === undefined ? {} : { asOfMs: row.asOfMs }) })), pending: snapshot.pending,
      ...(facts.night && snapshot.howYouWork ? { night: { detailStatus: snapshot.howYouWork.detailStatus } } : {}),
      ...(facts.coach && coach ? { coach: { currentness: coach.currentness, asOfMs: coach.asOfMs,
        findings: coachFindings.map(row => row.coverage) } } : {}),
      ...(intervals && sameIntervalPeriod && (selected.has('parallel') || selected.has('night')) ? {
        intervals: { method: intervals.method, status: intervals.coverage, detailStatus: snapshot.howYouWork?.detailStatus,
          unknownEndCount: intervals.unknownEndCount, invalidIntervalCount: intervals.invalidIntervalCount },
      } : {}) }, facts });
}
