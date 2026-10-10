import { getUsageQueryKey } from '../inputs/usageQuery.js';
import type { UsageQueryResultSlice } from './resolveUsagePageAggregation.js';
import { UsageRecapComposeInputSchema, UsageRecapComposeResultSchema, USAGE_RECAP_FIELDS,
  type UsageRecapComposeInput, type UsageRecapComposeResult, type UsageRecapFacts } from './usageRecap.js';

/** One selected-fact projection for all styles and formats, with no file or sharing effect. */
export function composeUsageRecap(args: Readonly<{
  input: UsageRecapComposeInput;
  snapshot: UsageQueryResultSlice;
}>): UsageRecapComposeResult {
  const input = UsageRecapComposeInputSchema.parse(args.input);
  const { snapshot } = args;
  const key = getUsageQueryKey(input.query);
  if (snapshot.key !== key || getUsageQueryKey(snapshot.requestedQuery) !== key || getUsageQueryKey(snapshot.shownQuery) !== key) {
    return { kind: 'unavailable', reason: 'query_mismatch' };
  }
  const accounting = snapshot.accounting;
  if (!accounting) return { kind: 'unavailable', reason: 'accounting_unavailable' };
  const { startMs, endMs } = input.query.period;
  if (startMs === undefined || endMs === undefined || endMs < startMs) return { kind: 'unavailable', reason: 'period_unavailable' };
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
  const work = snapshot.work;
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
  if (selected.has('dollars') && accounting.costFacts?.length) {
    // Preserve A's distinct money truths and unknown amounts; never blend or price here.
    facts.dollars = { basis: input.query.costBasis,
      facts: accounting.costFacts.map(({ source: _source, ...fact }) => fact) };
  }
  const coverage = accounting.coverage;
  const accountingCoverage = coverage ? (({ sources: _sources, ...value }) => value)(coverage) : null;
  const source = snapshot.sources.find(row => row.source === 'accounting');
  return UsageRecapComposeResultSchema.parse({ kind: 'composed', v: 1, style: input.style, format: input.format,
    selectedFields, unavailableFields: selectedFields.filter(field => field !== 'names' && !(field in facts)),
    period: { startMs, endMs, timeZoneOffsetMinutes: input.query.timeZoneOffsetMinutes }, asOfMs: source?.asOfMs ?? null,
    coverage: { accounting: accountingCoverage,
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
