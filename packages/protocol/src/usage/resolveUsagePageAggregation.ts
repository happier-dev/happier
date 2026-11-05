import { z } from 'zod/mini';
import type { UsageCoachPreferencesV1 } from '../account/settings/usageCoachPreferencesV1.js';
import type { AccountSettings } from '../account/settings/accountSettings.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { sameStrictJsonValue } from '../json/strictJsonValue.js';
import { getUsageQueryKey, normalizeUsageQuery, resolveUsageQueryPeriod, usageQueryToAnalyticsRequest, usageQueryNeedsContributionRows, UsageQuerySchema, type UsageQuery } from '../inputs/usageQuery.js';
import { UsageQueryAccountingSchema, type UsageAnalyticsQueryResponse } from './usageAnalyticsContracts.js';
import { UsageCostFactTotalSchema, projectUsageCostFactTotals } from './usageCostFactTotals.js';
import { allocateUsageOutcomes, summarizeUsageMergedOutcomes, projectUsageWorkSummary, UsageWorkSummarySchema, UsageMergedOutcomeSummarySchema, UsageWorkProjectionSchema, type UsageWorkEvidence, type UsageWorkSummary } from './usageOutcomeAllocation.js';
import type { ScmBranchWorkEvidence } from '../scm/branches.js';
import { resolveUsageHowYouWork, UsageHowYouWorkSchema, type UsageHowYouWorkDetailInput, type UsageSessionEvidenceCoverage } from './resolveUsageHowYouWork.js';
import type { UsageWorkIntervalsInput } from './usageWorkIntervals.js';
import { ConnectedServiceQuotaGetResultV1Schema, type ConnectedServiceQuotaGetResultV1 } from '../connect/providerAccountUsageHistorySchemasV1.js';
import { evaluateUsageCoach } from './coach/evaluateUsageCoach.js';
import { createUsageCoachDigestSuggestion } from './coach/coachDigestSuggestion.js';
import { UsageCoachEvaluationSchema } from './coach/coachFinding.js';
import { QualifiedConnectedAccountGroupRefSchema } from '../connect/qualifiedConnectedAccountProjectionsV4.js';
import { ConnectedServicePoolSelectionGetResponseV1Schema } from '../connect/connectedServicePoolSelection.js';
import { projectUsageAnalyticsSummary, repriceUsageAnalyticsResponse } from './usageCost.js';
import type { UsageModelPriceOverridesV1 } from './usageModelPriceCatalog.js';
import { projectUsagePlanInsights, UsagePlanInsightsSchema } from './usagePlanInsights.js';
import { hasSameUsageQueryWorkEvidenceMembership } from './usageWorkEvidence.js';
import { projectUsageAgentAccountingCalendar, resolveUsageAccountingCalendarPeriod, type UsageAgentAccountingCalendar } from './usageAgentCalendar.js';
import { RPC_ERROR_CODES } from '../rpc/errors.js';
import { OperationUpdateRequiredV1Schema, type OperationUpdateRequiredV1 } from '../compat/operationUpdateRequiredV1.js';
import { PublicProfilePrivateFactsSchema, PublicProfilePrivateFieldCoverageSchema, PublicProfilePrivateAccountingFactsSchema } from '../account/publicProfileAccounting.js';
import { readUsageAccountingSessionMembership } from './usageAccountingMembership.js';
export type { UsagePlanInsights } from './usagePlanInsights.js';

/** Source transport currentness is separate from accounting completeness. */
export const UsageQuerySourceStatusSchema = lazyZodSchema(() => z.enum([
  'available', 'stale', 'not_loaded', 'pending', 'error', 'unsupported', 'unknown', 'partial',
]));
export const UsageQuerySourceStateSchema = lazyZodSchema(() => z.strictObject({
  source: z.string().check(z.trim(), z.minLength(1)),
  status: UsageQuerySourceStatusSchema,
  asOfMs: z.optional(z.number().check(z.int(), z.nonnegative())),
  errorCode: z.optional(z.string().check(z.trim(), z.minLength(1))),
  updateRequired: z.optional(OperationUpdateRequiredV1Schema),
}));
export type UsageQuerySourceState = z.infer<typeof UsageQuerySourceStateSchema>;

/** Pool membership is an Account projection, separate from unique B account/window facts. */
export const UsageQueryPoolSnapshotSchema = lazyZodSchema(() => z.strictObject({
  group: QualifiedConnectedAccountGroupRefSchema,
  memberAccountIds: z.array(z.string().check(z.trim(), z.minLength(1))),
  activeAccountId: z.nullable(z.string().check(z.trim(), z.minLength(1))),
  selection: (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(z.omit(UsageQuerySourceStateSchema, { source: true }), {
    machineId: z.optional(z.string().check(z.trim(), z.minLength(1))),
    value: z.optional(ConnectedServicePoolSelectionGetResponseV1Schema),
  })),
}).check(z.superRefine((pool, context) => {
  const value = pool.selection.value;
  if (value && !['available', 'stale'].includes(pool.selection.status)) {
    context.addIssue({ code: 'custom', path: ['selection'], message: 'Unavailable selector cannot disclose retained decisions' });
  }
  if (value && 'group' in value && !sameStrictJsonValue(value.group, pool.group)) {
    context.addIssue({ code: 'custom', path: ['selection'], message: 'Selector must identify its qualified pool' });
  }
})));
export type UsageQueryPoolSnapshot = z.infer<typeof UsageQueryPoolSnapshotSchema>;
export type UsagePoolSourceSnapshot = Readonly<{ query: UsageQuery; value: readonly UsageQueryPoolSnapshot[] }>;

function readBoundedAccountingPeriod(value: UsageAnalyticsQueryResponse | undefined) {
  const range = value?.coverage?.range;
  return range?.startMs !== undefined && range.endMs !== undefined
    ? { startMs: range.startMs, endMs: range.endMs } : undefined;
}

export const USAGE_QUERY_EVIDENCE_SECTIONS = ['work', 'howYouWork', 'coach'] as const;

export const UsageQueryResultSliceSchema = lazyZodSchema(() => z.strictObject({
  key: z.string().check(z.minLength(1)),
  requestedQuery: UsageQuerySchema,
  shownQuery: UsageQuerySchema,
  accounting: z.optional(UsageQueryAccountingSchema),
  /** Actual observation witnesses retained by the local Resource, distinct from requested coverage. */
  accountingObservationRange: z.optional(z.strictObject({ startMs: z.number().check(z.int(), z.nonnegative()),
    endMs: z.number().check(z.int(), z.nonnegative()) })),
  costFactTotals: z.optional(z.array(UsageCostFactTotalSchema)),
  quota: z.optional(z.array(ConnectedServiceQuotaGetResultV1Schema)),
  pools: z.optional(z.array(UsageQueryPoolSnapshotSchema)),
  planInsights: z.optional(UsagePlanInsightsSchema),
  comparison: z.optional(z.strictObject({ query: UsageQuerySchema, accounting: z.optional(UsageQueryAccountingSchema),
    costFactTotals: z.optional(z.array(UsageCostFactTotalSchema)),
    source: UsageQuerySourceStateSchema })),
  work: z.optional(UsageWorkProjectionSchema),
  workSummary: z.optional(UsageWorkSummarySchema),
  mergedOutcomes: z.optional(UsageMergedOutcomeSummarySchema),
  /** Profile preparation keeps bounded public facts, never its private Work and interval models. */
  publicProfileEvidence: z.optional(z.strictObject({
    facts: PublicProfilePrivateFactsSchema,
    fieldCoverage: PublicProfilePrivateFieldCoverageSchema,
    accountingFacts: z.optional(PublicProfilePrivateAccountingFactsSchema),
    lenses: z.array(z.strictObject({ execution: z.enum(['happier', 'outside']), facts: PublicProfilePrivateFactsSchema,
      accountingFacts: z.optional(PublicProfilePrivateAccountingFactsSchema) })),
  })),
  howYouWork: z.optional(UsageHowYouWorkSchema),
  coach: z.optional(UsageCoachEvaluationSchema),
  /** Delivery omissions are distinct from acquisition/source currentness. */
  incomplete: z.optional(z.strictObject({
    reason: z.literal('response_size_limit'),
    /** Work also omits its raw contributions and dependent merged-outcome summary. */
    omittedSections: z.array(z.enum(USAGE_QUERY_EVIDENCE_SECTIONS)).check(z.minLength(1), z.refine(sections => new Set(sections).size === sections.length)),
    recovery: z.literal('narrow_query'),
  })),
  sources: z.array(UsageQuerySourceStateSchema),
  pending: z.boolean(),
}).check(z.superRefine((slice, context) => {
  for (const section of slice.incomplete?.omittedSections ?? []) {
    if (slice[section] !== undefined || section === 'work' && (slice.mergedOutcomes !== undefined || slice.accounting?.contributions !== undefined)) {
      context.addIssue({ code: 'custom', path: ['incomplete'], message: 'Omitted evidence must not be presented as complete delivered facts' });
    }
  }
  if (slice.key !== getUsageQueryKey(slice.requestedQuery)) {
    context.addIssue({ code: 'custom', path: ['key'], message: 'Result key must identify the requested query' });
  }
  if (!slice.requestedQuery.includeAccounting && (slice.accounting || slice.comparison || slice.costFactTotals || slice.work || slice.workSummary || slice.mergedOutcomes || slice.howYouWork || slice.coach || slice.publicProfileEvidence)) {
    context.addIssue({ code: 'custom', path: ['accounting'], message: 'Quota-only demand cannot disclose accounting or Session evidence' });
  }
  // An Action snapshot names exactly what it queried. Previous-period display
  // belongs to the retained Resource consumer, never relabelled Action facts.
  if (getUsageQueryKey(slice.shownQuery) !== slice.key) {
    context.addIssue({ code: 'custom', path: ['shownQuery'], message: 'Shown facts must identify the queried slice' });
  }
  if (slice.costFactTotals && (!slice.accounting || !sameStrictJsonValue(
    slice.costFactTotals, projectUsageCostFactTotals(slice.accounting.costFacts ?? [])))) {
    context.addIssue({ code: 'custom', path: ['costFactTotals'], message: 'Money totals must preserve the exact admitted accounting and source provenance' });
  }
  if (slice.comparison?.costFactTotals && (!slice.comparison.accounting || !sameStrictJsonValue(
    slice.comparison.costFactTotals, projectUsageCostFactTotals(slice.comparison.accounting.costFacts ?? [])))) {
    context.addIssue({ code: 'custom', path: ['comparison', 'costFactTotals'], message: 'Comparison money totals must preserve their admitted accounting and source provenance' });
  }
  // Retained private evidence and its calendar can have an older read window
  // during progression. Accounting comparisons belong to the witnessed A window.
  const accountingPeriod = 'relative' in slice.shownQuery.period
    ? readBoundedAccountingPeriod(slice.accounting) ?? slice.coach?.period ?? slice.accounting?.coverage?.range
    : slice.shownQuery.period;
  if (slice.comparison) {
    const expected = resolveUsageComparisonQuery(slice.requestedQuery, accountingPeriod);
    if (!expected || getUsageQueryKey(slice.comparison.query) !== getUsageQueryKey(expected)) {
      context.addIssue({ code: 'custom', path: ['comparison', 'query'], message: 'Comparison must identify the exact preceding range' });
    }
  }
  if (slice.work && (!slice.accounting?.contributions || !sameStrictJsonValue(
    slice.work.allocations.map(row => row.contribution), slice.accounting.contributions))) {
    context.addIssue({ code: 'custom', path: ['work'], message: 'Work must conserve the exact admitted contributions' });
  }
  if (slice.quota && !slice.sources.some(source => source.source === 'quota' && ['available', 'partial', 'stale'].includes(source.status))) {
    context.addIssue({ code: 'custom', path: ['quota'], message: 'Unavailable allowance cannot disclose protected facts' });
  }
  if (slice.planInsights?.accounts.some(account => !slice.quota?.some(read => sameStrictJsonValue(read.source, account.source)))) {
    context.addIssue({ code: 'custom', path: ['planInsights', 'accounts'], message: 'Plan facts must identify an admitted qualified allowance account' });
  }
  const week = slice.planInsights?.recordedWeek;
  const witnessedPeriod = 'relative' in slice.shownQuery.period
    ? slice.coach?.period ?? accountingPeriod
    : slice.shownQuery.period;
  if (slice.mergedOutcomes && (!slice.work || witnessedPeriod?.startMs === undefined || witnessedPeriod.endMs === undefined
    || !slice.sources.some(source => source.source === 'work' && ['available', 'partial', 'stale', 'pending'].includes(source.status))
    || !sameStrictJsonValue(slice.mergedOutcomes, summarizeUsageMergedOutcomes({ work: slice.work,
      period: { startMs: witnessedPeriod.startMs, endMs: witnessedPeriod.endMs }, timeZoneOffsetMinutes: slice.shownQuery.timeZoneOffsetMinutes })))) {
    context.addIssue({ code: 'custom', path: ['mergedOutcomes'], message: 'Merged outcomes must preserve the admitted Work, period and calendar' });
  }
  if (week?.status === 'available' && (!slice.accounting?.activity
    || week.startMs !== accountingPeriod?.startMs || week.endMs !== accountingPeriod?.endMs
    || week.timeZoneOffsetMinutes !== slice.shownQuery.timeZoneOffsetMinutes)) {
    context.addIssue({ code: 'custom', path: ['planInsights', 'recordedWeek'], message: 'Recorded week must preserve admitted accounting period and calendar' });
  }
  if ((slice.work?.allocations.some(row => row.evidence.length > 0) || slice.work?.branchAllocations.some(row => row.evidence.length > 0))
    && !slice.sources.some(source => source.source === 'work' && ['available', 'partial', 'stale', 'pending'].includes(source.status))) {
    context.addIssue({ code: 'custom', path: ['work'], message: 'Unavailable Work sources cannot disclose private evidence' });
  }
  const intervals = slice.howYouWork?.intervals;
  if (intervals && (intervals.timeZoneOffsetMinutes !== slice.shownQuery.timeZoneOffsetMinutes
    || (witnessedPeriod?.startMs !== undefined && intervals.period.startMs !== witnessedPeriod.startMs)
    || (witnessedPeriod?.endMs !== undefined && intervals.period.endMs !== witnessedPeriod.endMs))) {
    context.addIssue({ code: 'custom', path: ['howYouWork'], message: 'Intervals must identify the shown period and calendar' });
  }
  if (intervals && !slice.sources.some(isUsageDetailSourceReadable)) {
    context.addIssue({ code: 'custom', path: ['howYouWork'], message: 'Unavailable detail cannot disclose private intervals' });
  }
  const agentCalendar = slice.howYouWork?.agentCalendar;
  const calendarRequestedPeriod = agentCalendar && resolveUsageQueryPeriod(slice.shownQuery,
    witnessedPeriod?.endMs ?? agentCalendar.period.endMs);
  if (agentCalendar && (agentCalendar.timeZoneOffsetMinutes !== slice.shownQuery.timeZoneOffsetMinutes
    || agentCalendar.period.startMs > agentCalendar.period.endMs
    || calendarRequestedPeriod?.startMs !== undefined && witnessedPeriod?.startMs !== undefined && agentCalendar.period.startMs !== witnessedPeriod.startMs
    || witnessedPeriod?.endMs !== undefined && agentCalendar.period.endMs !== witnessedPeriod.endMs)) {
    context.addIssue({ code: 'custom', path: ['howYouWork', 'agentCalendar'], message: 'Agent calendar must identify the shown period and fixed offset' });
  }
  if (slice.coach && (slice.coach.queryKey !== slice.key
    || (slice.shownQuery.period.startMs !== undefined && slice.coach.period.startMs !== slice.shownQuery.period.startMs)
    || (slice.shownQuery.period.endMs !== undefined && slice.coach.period.endMs !== slice.shownQuery.period.endMs))) {
    context.addIssue({ code: 'custom', path: ['coach'], message: 'Coach must identify the exact admitted query period' });
  }
  if (slice.coach?.findings.some(finding => finding.evidence.some(evidence => evidence.kind !== 'accounting'))
    && !slice.sources.some(isUsageDetailSourceReadable)) {
    context.addIssue({ code: 'custom', path: ['coach'], message: 'Unavailable detail cannot disclose private Coach evidence' });
  }
})));
export type UsageQueryResultSlice = z.infer<typeof UsageQueryResultSliceSchema>;

type AdmittedUsageProjection<T> = Readonly<{ inputs: Readonly<Record<string, unknown>>; value: T }>;
type UsagePageProjections = {
  calendar: AdmittedUsageProjection<UsageAgentAccountingCalendar | undefined>;
  howYouWork: AdmittedUsageProjection<UsageQueryResultSlice['howYouWork']>;
  coach: AdmittedUsageProjection<UsageQueryResultSlice['coach']>;
  work: AdmittedUsageProjection<UsageQueryResultSlice['work']>;
  mergedOutcomes: AdmittedUsageProjection<UsageQueryResultSlice['mergedOutcomes']>;
  planInsights: AdmittedUsageProjection<UsageQueryResultSlice['planInsights']>;
  costFactTotals: AdmittedUsageProjection<UsageQueryResultSlice['costFactTotals']>;
  comparisonCostFactTotals: AdmittedUsageProjection<UsageQueryResultSlice['costFactTotals']>;
};
// Carry admitted inputs beside their projection through the existing read's
// previous value. Symbols survive in-process source-wrapper spreads but never
// enter JSON, Action schemas or an independent cache/lifetime.
const usagePageProjections = Symbol('usagePageProjections');
type ProjectedUsageSlice = UsageQueryResultSlice & { [usagePageProjections]?: UsagePageProjections };

function projectAdmittedUsageInputs<T>(previous: AdmittedUsageProjection<T> | undefined,
  inputs: Readonly<Record<string, unknown>>, project: () => T): AdmittedUsageProjection<T> {
  const keys = Object.keys(inputs);
  if (previous && keys.length === Object.keys(previous.inputs).length
    && keys.every(key => inputs[key] === previous.inputs[key])) return previous;
  const value = project();
  // Reconcile a changed admission once, never rebuild/compare unchanged trees
  // for another source's progress publication.
  return { inputs, value: previous && sameStrictJsonValue(value, previous.value) ? previous.value : value };
}

function carryUsageProjectionInputs(value: UsageQueryResultSlice, source: UsageQueryResultSlice): UsageQueryResultSlice {
  const admitted = (source as ProjectedUsageSlice)[usagePageProjections];
  if (!admitted) return value;
  const withValue = <T>(projection: AdmittedUsageProjection<T>, value: T): AdmittedUsageProjection<T> =>
    projection.value === value ? projection : { ...projection, value };
  // Boundary reconciliation can retain an equal prior projection, and the UI
  // may have admitted remedies/preferences. Carry that actual admitted value.
  const projected: UsagePageProjections = { ...admitted,
    howYouWork: withValue(admitted.howYouWork, value.howYouWork), coach: withValue(admitted.coach, value.coach),
    work: withValue(admitted.work, value.work), mergedOutcomes: withValue(admitted.mergedOutcomes, value.mergedOutcomes),
    planInsights: withValue(admitted.planInsights, value.planInsights), costFactTotals: withValue(admitted.costFactTotals, value.costFactTotals),
    comparisonCostFactTotals: withValue(admitted.comparisonCostFactTotals, value.comparison?.costFactTotals),
  };
  const current = (value as ProjectedUsageSlice)[usagePageProjections];
  if (current) {
    // A retained public slice must keep its identity even when a completed
    // reread refreshes its private projection basis. Memoize only that basis;
    // never replace or mutate any admitted public fact.
    Object.assign(current, projected);
    return value;
  }
  return { ...value, [usagePageProjections]: projected } as ProjectedUsageSlice;
}

export const UsageQueryBatchResultSchema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  results: z.array(UsageQueryResultSliceSchema),
}).check(z.superRefine((batch, context) => {
  const keys = new Set<string>();
  batch.results.forEach((slice, index) => {
    if (keys.has(slice.key)) context.addIssue({ code: 'custom', path: ['results', index, 'key'], message: 'Duplicate query slice' });
    keys.add(slice.key);
  });
})));
export type UsageQueryBatchResult = z.infer<typeof UsageQueryBatchResultSchema>;

/** Compare changed members once; already reconciled children need only identity checks. */
function retainUsageMembers<T extends object>(value: T, previous: T, reconciled: readonly (keyof T)[] = []): T {
  if (value === previous) return previous;
  const keys = Object.keys(value) as Array<keyof T>;
  let result = value;
  for (const key of keys) {
    if (!reconciled.includes(key) && value[key] !== previous[key]
      && sameStrictJsonValue(value[key], previous[key], { omitUndefinedObjectMembers: true })) {
      result = { ...result, [key]: previous[key] };
    }
  }
  // Demand projections may spell absent optional JSON members as undefined.
  // Their presence does not change the admitted accounting value.
  return keys.every(key => result[key] === previous[key])
    && (Object.keys(previous) as Array<keyof T>).every(key => result[key] === previous[key]) ? previous : result;
}

const accountingSourceLocationProjections = new WeakMap<UsageAnalyticsQueryResponse, {
  locations: UsagePageAggregationInput['sourceLocations']; value: UsageAnalyticsQueryResponse;
}>();

export function retainAccountingReferences(value: UsageAnalyticsQueryResponse | undefined,
  previous: UsageAnalyticsQueryResponse | undefined): UsageAnalyticsQueryResponse | undefined {
  if (!value || !previous || value === previous) return value;
  if (value.priceCatalog && previous.priceCatalog && value.priceCatalog !== previous.priceCatalog) {
    value = { ...value, priceCatalog: retainUsageMembers(value.priceCatalog, previous.priceCatalog) };
  }
  if (value.coverage && previous.coverage && value.coverage !== previous.coverage) {
    value = { ...value, coverage: retainUsageMembers(value.coverage, previous.coverage) };
  }
  if (value.contributions && previous.contributions && value.contributions !== previous.contributions) {
    // IDs locate candidates, not immutable facts: corrections can retain an ID.
    const prior = new Map(previous.contributions.map(row => [row.id, row]));
    const rows = value.contributions.map(row => {
      const retained = prior.get(row.id);
      return retained && (row === retained || sameStrictJsonValue(row, retained)) ? retained : row;
    });
    const contributions = rows.length === previous.contributions.length
      && rows.every((row, index) => row === previous.contributions![index]) ? previous.contributions : rows;
    value = { ...value, contributions };
  }
  return retainUsageMembers(value, previous, ['priceCatalog', 'coverage', 'contributions']);
}

/** Reuse semantically unchanged validated slices from the caller's same-authority prior value. */
export function retainUsageQueryResultReferences(current: UsageQueryBatchResult,
  previous: UsageQueryBatchResult | undefined, settled?: UsageQueryBatchResult): UsageQueryBatchResult {
  if (!previous || current === previous) return current;
  const prior = new Map(previous.results.map(slice => [slice.key, slice]));
  const original = new Map(settled?.results.map(slice => [slice.key, slice]));
  const results = current.results.map(slice => {
    const retained = prior.get(slice.key);
    if (!retained || slice === retained) return slice;
    // Source progress replaces the slice, not its unchanged accounting. Mounted
    // consumers key their existing price/ranking projections by these facts.
    let reconciled = slice;
    const accounting = retainAccountingReferences(slice.accounting, retained.accounting);
    if (accounting !== slice.accounting) {
      reconciled = { ...reconciled, accounting };
    }
    if (slice.comparison?.accounting && retained.comparison?.accounting
      && getUsageQueryKey(slice.comparison.query) === getUsageQueryKey(retained.comparison.query)) {
      const accounting = retainAccountingReferences(slice.comparison.accounting, retained.comparison.accounting);
      reconciled = { ...reconciled, comparison: retainUsageMembers({ ...slice.comparison, accounting }, retained.comparison, ['accounting']) };
    }
    // A source wrapper can share a refreshed private basis while retaining its
    // older public identity. Only skip facts reconciled against that identity;
    // divergent and wire-only facts still need ordinary member admission.
    const retainedProjections = (retained as ProjectedUsageSlice)[usagePageProjections];
    const projectedKeys: (keyof UsageQueryResultSlice)[] = (slice as ProjectedUsageSlice)[usagePageProjections] && retainedProjections
      ? (['work', 'mergedOutcomes', 'howYouWork', 'coach', 'planInsights', 'costFactTotals'] as const)
        .filter(key => retainedProjections[key].value === retained[key]) : [];
    const result = retainUsageMembers(reconciled, retained, ['accounting', ...projectedKeys, ...(slice.comparison?.accounting && retained.comparison?.accounting
      && getUsageQueryKey(slice.comparison.query) === getUsageQueryKey(retained.comparison.query) ? ['comparison' as const] : [])]);
    const baseline = original.get(slice.key);
    if (!baseline || result === retained) return carryUsageProjectionInputs(result, slice);
    // A changed sibling prevents whole-Resource digest reuse. Restore this
    // slice's settled identity from canonical accounting references and its
    // other members, never a recursive whole-slice comparison.
    const comparison = result.comparison && baseline.comparison
      ? retainUsageMembers(result.comparison, baseline.comparison, ['accounting']) : result.comparison;
    return carryUsageProjectionInputs(retainUsageMembers(comparison === result.comparison ? result : { ...result, comparison }, baseline,
      ['accounting', 'comparison', ...projectedKeys.filter(key => baseline[key] === retained[key])]), slice);
  });
  if (results.length === previous.results.length
    && results.every((slice, index) => slice === previous.results[index])) return previous;
  if (results.every((slice, index) => slice === current.results[index])) return current;
  return { ...current, results };
}

export type UsageAccountingSourceSnapshot = Readonly<{
  query: UsageQuery;
  /** Captured once by the read planner, including failed/pending reads. */
  period?: ReturnType<typeof resolveUsageQueryPeriod>;
  value?: UsageAnalyticsQueryResponse;
  status: UsageQuerySourceState['status'];
  asOfMs?: number;
  errorCode?: string;
  /** Same-read derived value held by the existing accounting snapshot owner; never serialized. */
  priceProjection?: Readonly<{
    input: UsageAnalyticsQueryResponse;
    overrides: UsageModelPriceOverridesV1 | undefined;
    costBasis: UsageQuery['costBasis'];
    value: UsageAnalyticsQueryResponse;
    /** Local presentation witness held with this already admitted price projection. */
    observationRange?: UsageQueryResultSlice['accountingObservationRange'];
  }>;
  /** Accounting-only calendar for this admitted response and numeric query basis; never serialized. */
  agentCalendarAccounting?: UsageAgentAccountingCalendar;
}>;

/** Admit prices and stable references once in the existing read snapshot, before source publications. */
export function projectUsageAccountingSnapshotPrices(snapshot: UsageAccountingSourceSnapshot,
  overrides: UsageModelPriceOverridesV1 | undefined,
  siblings?: Iterable<UsageAccountingSourceSnapshot>,
  previous?: UsageAnalyticsQueryResponse): UsageAccountingSourceSnapshot {
  const value = snapshot.value;
  if (snapshot.query.population === 'public_eligible_personal') return snapshot.priceProjection
    ? { ...snapshot, priceProjection: undefined } : snapshot;
  if (!value) return snapshot.priceProjection ? { ...snapshot, priceProjection: undefined } : snapshot;
  if (!value.priceCatalog && overrides === undefined) {
    const admitted = retainAccountingReferences(value, previous);
    return admitted === value && !snapshot.priceProjection ? snapshot : { ...snapshot, value: admitted, priceProjection: undefined };
  }
  const retained = snapshot.priceProjection;
  if (retained?.input === value && retained.costBasis === snapshot.query.costBasis && sameStrictJsonValue(retained.overrides, overrides)) return snapshot;
  const needsRows = usageQueryNeedsContributionRows(snapshot.query);
  // Evidence flags can share one admitted accounting response. Reuse that
  // response's projection already held by a sibling in this same read, rather
  // than repricing and retaining the complete contribution population again.
  for (const sibling of siblings ?? []) {
    const projection = sibling.priceProjection;
    if (projection?.input === value && projection.costBasis === snapshot.query.costBasis
      && (projection.value.contributions !== undefined) === (needsRows && value.contributions !== undefined)
      && sameStrictJsonValue(projection.overrides, overrides)) {
      const admitted = retainAccountingReferences(projection.value, previous)!;
      return { ...snapshot, priceProjection: admitted === projection.value ? projection : { ...projection, value: admitted } };
    }
  }
  const priced = repriceUsageAnalyticsResponse(value, value.priceCatalog, overrides, snapshot.query.costBasis);
  const projected = priced.contributions && !needsRows ? projectUsageAnalyticsSummary(priced,
    usageQueryToAnalyticsRequest(snapshot.query, snapshot.period?.endMs ?? value.coverage?.range.endMs)) : priced;
  return { ...snapshot, priceProjection: { input: value, overrides, costBasis: snapshot.query.costBasis,
    value: retainAccountingReferences(projected, previous)! } };
}

/** Carry the admitted accounting reduction through this read's independent source publications. */
export function projectUsageAccountingSnapshotCalendar(snapshot: UsageAccountingSourceSnapshot,
  siblings?: Iterable<UsageAccountingSourceSnapshot>,
  witnessedPeriod?: Readonly<{ startMs: number; endMs: number }>): UsageAccountingSourceSnapshot {
  const query = snapshot.query;
  const value = snapshot.priceProjection && snapshot.priceProjection.input === snapshot.value
    && snapshot.priceProjection.costBasis === query.costBasis ? snapshot.priceProjection.value : snapshot.value;
  const range = witnessedPeriod ?? ('relative' in query.period ? readBoundedAccountingPeriod(value) ?? snapshot.period : snapshot.period ?? query.period);
  if (!value || !query.includeAccounting || !query.includeActivity && !query.includeModelTimeline
    || !canRetainUsageReadFailure(snapshot.errorCode) || range?.endMs === undefined) return snapshot.agentCalendarAccounting
    ? { ...snapshot, agentCalendarAccounting: undefined } : snapshot;
  const period = resolveUsageAccountingCalendarPeriod({ accounting: value, timeZoneOffsetMinutes: query.timeZoneOffsetMinutes,
    period: { startMs: resolveUsageQueryPeriod(query, range.endMs).startMs === undefined ? undefined : range.startMs, endMs: range.endMs } });
  if (period.endMs < period.startMs) return snapshot.agentCalendarAccounting ? { ...snapshot, agentCalendarAccounting: undefined } : snapshot;
  const matches = (projection: UsageAgentAccountingCalendar | undefined) => projection?.accounting === value
    && projection.period.startMs === period.startMs && projection.period.endMs === period.endMs
    && projection.timeZoneOffsetMinutes === query.timeZoneOffsetMinutes && projection.costMode === query.costBasis;
  if (matches(snapshot.agentCalendarAccounting)) return snapshot;
  for (const sibling of siblings ?? []) {
    if (matches(sibling.agentCalendarAccounting)) return { ...snapshot, agentCalendarAccounting: sibling.agentCalendarAccounting };
  }
  return { ...snapshot, agentCalendarAccounting: projectUsageAgentAccountingCalendar({ accounting: value, period,
    timeZoneOffsetMinutes: query.timeZoneOffsetMinutes, costMode: query.costBasis }) };
}

/** A successful read retains producer observation time, never the adapter's clock. */
export function resolveUsageAccountingAsOfMs(value: UsageAnalyticsQueryResponse): number | undefined {
  const times = value.coverage?.sources.filter(source => source.status === 'available' || source.status === 'partial')
    .flatMap(source => source.asOfMs === undefined ? [] : [source.asOfMs]) ?? [];
  return times.length ? Math.min(...times) : undefined;
}

export type UsageWorkSourceSnapshot = Readonly<{
  query: UsageQuery;
  evidence?: readonly UsageWorkEvidence[];
  branchEvidence?: readonly ScmBranchWorkEvidence[];
  summary?: UsageWorkSummary;
  status: UsageQuerySourceState['status'];
  asOfMs?: number;
  errorCode?: string;
  updateRequired?: OperationUpdateRequiredV1;
}>;

export type UsageHowYouWorkSourceSnapshot = Readonly<{
  query: UsageQuery;
  detail?: UsageHowYouWorkDetailInput;
  errorCode?: string;
  updateRequired?: OperationUpdateRequiredV1;
  sessionCoverage?: UsageSessionEvidenceCoverage;
  asOfMs?: number;
  nightHours?: UsageWorkIntervalsInput['nightHours'];
}>;

/** Unbounded ranges and ranges without a valid preceding interval have no comparison. */
export function resolveUsageComparisonQuery(candidate: UsageQuery, period?: Readonly<{ startMs?: number; endMs?: number }>): UsageQuery | null {
  const query = normalizeUsageQuery(candidate);
  if (!query.includeComparison) return null;
  const { startMs, endMs } = period ?? query.period;
  if (startMs === undefined || endMs === undefined || endMs <= startMs) return null;
  const previousStart = startMs - (endMs - startMs);
  if (previousStart < 0) return null;
  // Comparison consumers use token/money totals, including client price
  // overrides over the admitted contributions. They do not consume charts or
  // whole-Session message counts from this preceding population.
  return normalizeUsageQuery({ ...query, period: { startMs: previousStart, endMs: startMs },
    breakdown: [], includeSeries: false, includeInsights: false, includeActivity: false,
    includeLeaders: false, includeModelTimeline: false, includeMessageStats: false,
    includeSessionEvidence: false, includeTranscriptEvidence: false, includeWorkEvidence: false });
}

export function resolveUsagePageAccountingReads(queries: readonly UsageQuery[], nowMs: number): Readonly<{ query: UsageQuery; period: ReturnType<typeof resolveUsageQueryPeriod> }>[] {
  const requests = new Map<string, Readonly<{ query: UsageQuery; period: ReturnType<typeof resolveUsageQueryPeriod> }>>();
  for (const candidate of queries) {
    const query = normalizeUsageQuery(candidate);
    if (!query.includeAccounting) continue;
    const period = resolveUsageQueryPeriod(query, nowMs);
    requests.set(getUsageQueryKey(query), { query, period });
    const comparison = resolveUsageComparisonQuery(query, period);
    if (comparison) requests.set(getUsageQueryKey(comparison), { query: comparison, period: comparison.period });
  }
  return [...requests.values()];
}

export function resolveUsagePageAccountingRequests(queries: readonly UsageQuery[], nowMs = Date.now()): UsageQuery[] {
  return resolveUsagePageAccountingReads(queries, nowMs).map(read => read.query);
}

export function canRetainUsageReadFailure(errorCode?: string): boolean {
  return !['denied', 'permission_denied', 'unauthorized', 'forbidden', 'stale_surface', 'cancelled', 'plugin_resource_context_unavailable',
    RPC_ERROR_CODES.FORBIDDEN, RPC_ERROR_CODES.TEAM_AUTHENTICATION_REQUIRED,
    RPC_ERROR_CODES.TEAM_AUTHENTICATION_UNAVAILABLE].includes(errorCode ?? '');
}

function isUsageDetailSourceReadable(source: UsageQuerySourceState): boolean {
  return source.source === 'how_you_work' && ['available', 'partial', 'stale', 'pending'].includes(source.status)
    && canRetainUsageReadFailure(source.errorCode);
}

export function retainAccountingOnReadFailure(observed: UsageAccountingSourceSnapshot | undefined,
  value: UsageAnalyticsQueryResponse | undefined, asOfMs: number | undefined): UsageAccountingSourceSnapshot | undefined {
  // Authority loss/cancellation never revives previously disclosed facts.
  if (!observed || observed.value !== undefined || value === undefined || observed.status !== 'error'
    || !canRetainUsageReadFailure(observed.errorCode)) return observed;
  return { ...observed, value, ...(asOfMs === undefined ? {} : { asOfMs }) };
}

/**
 * One deterministic page composition over already-authorized owner snapshots.
 * No accounting, vendor refresh, transport, cache or authority is invented here.
 */
export type UsagePageAggregationInput = Readonly<{
  queries: readonly UsageQuery[];
  /** Opened Account preferences share one resolution path across UI, CLI and daemon callers. */
  accountSettings?: Readonly<Partial<Pick<AccountSettings,
    'usageNightHoursV1' | 'usageModelPriceOverridesV1' | 'usageCoachPreferencesV1'>>>;
  accounting?: readonly UsageAccountingSourceSnapshot[];
  work?: readonly UsageWorkSourceSnapshot[];
  howYouWork?: readonly UsageHowYouWorkSourceSnapshot[];
  /** Account preference is available independently of private Session detail; null explicitly clears it. */
  nightHours?: UsageWorkIntervalsInput['nightHours'] | null;
  nowMs?: number;
  quota?: Readonly<Omit<UsageQuerySourceState, 'source'> & { value?: readonly ConnectedServiceQuotaGetResultV1[] }>;
  pools?: readonly UsagePoolSourceSnapshot[];
  sources?: readonly UsageQuerySourceState[];
  /** Already-opened machine labels authorized for this Account; absence withdraws retained labels. */
  sourceLocations?: readonly Readonly<{ machineId: string; displayLocation: string }>[];
  previous?: UsageQueryBatchResult;
  pricingOverrides?: UsageModelPriceOverridesV1;
  coachPreferences?: UsageCoachPreferencesV1 | null;
}>;

/** Shared B admission and source projection for accounting-backed and quota-only slices. */
function projectUsageQuotaFields(quota: UsagePageAggregationInput['quota'], observedPools: readonly UsageQueryPoolSnapshot[] | undefined,
  previousPools?: readonly UsageQueryPoolSnapshot[]) {
  const pools = observedPools?.map(pool => {
    const previous = previousPools?.find(candidate => sameStrictJsonValue(candidate.group, pool.group));
    if (!previous?.selection.value || !canRetainUsageReadFailure(pool.selection.errorCode)
      || (!['pending', 'not_loaded', 'error'].includes(pool.selection.status) && pool.selection.errorCode !== 'no_machine') || pool.selection.value
      || (pool.selection.machineId !== previous.selection.machineId && pool.selection.errorCode !== 'no_machine')
      || pool.activeAccountId !== previous.activeAccountId || !sameStrictJsonValue(pool.memberAccountIds, previous.memberAccountIds)) return pool;
    return { ...pool, selection: { ...pool.selection, machineId: previous.selection.machineId, value: previous.selection.value,
      status: 'stale' as const, ...(previous.selection.asOfMs === undefined ? {} : { asOfMs: previous.selection.asOfMs }) } };
  });
  const sources: UsageQuerySourceState[] = [
    { source: 'quota', status: quota?.status ?? 'not_loaded',
      ...(quota?.asOfMs === undefined ? {} : { asOfMs: quota.asOfMs }),
      ...(quota?.errorCode === undefined ? {} : { errorCode: quota.errorCode }) },
    ...(pools?.map(pool => ({ source: `selection:${pool.group.service.pluginId}/${pool.group.service.localId}:${pool.group.groupId}`,
      status: pool.selection.status, ...(pool.selection.asOfMs === undefined ? {} : { asOfMs: pool.selection.asOfMs }),
      ...(pool.selection.errorCode === undefined ? {} : { errorCode: pool.selection.errorCode }) })) ?? []),
  ];
  return { sources,
    ...(quota?.value && ['available', 'partial', 'stale'].includes(quota.status) ? { quota: [...quota.value] } : {}),
    ...(pools ? { pools: pools.map(pool => ({ ...pool, selection: ['available', 'stale'].includes(pool.selection.status)
      ? pool.selection : { ...pool.selection, value: undefined } })) } : {}),
  };
}

function retainPublicProfileEvidence(previous: NonNullable<UsageQueryResultSlice['publicProfileEvidence']>,
  retainDetail: boolean, retainWork: boolean): NonNullable<UsageQueryResultSlice['publicProfileEvidence']> {
  const keep = (key: string) => key === 'mergedPrs' ? retainWork : retainDetail;
  const facts = (value: typeof previous.facts) => Object.fromEntries(Object.entries(value).filter(([key]) => keep(key))) as typeof previous.facts;
  return {
    facts: facts(previous.facts),
    fieldCoverage: Object.fromEntries(Object.entries(previous.fieldCoverage).filter(([key]) => keep(key))),
    ...(retainDetail && previous.accountingFacts ? { accountingFacts: previous.accountingFacts } : {}),
    lenses: previous.lenses.map(lens => ({ execution: lens.execution, facts: facts(lens.facts),
      ...(retainDetail && lens.accountingFacts ? { accountingFacts: lens.accountingFacts } : {}) })),
  };
}

/** Quota-only demand uses the same admitted B snapshots and result identity, without touching A or private evidence. */
export function resolveUsageQuotaPageAggregation(input: Pick<UsagePageAggregationInput, 'queries' | 'quota' | 'pools' | 'sources' | 'previous' | 'nowMs'>): UsageQueryBatchResult {
  const poolsByQuery = new Map(input.pools?.map(snapshot => [getUsageQueryKey(snapshot.query), snapshot.value]));
  const queries = new Map(input.queries.map(candidate => {
    const query = normalizeUsageQuery(candidate);
    if (query.includeAccounting) throw new Error('Quota-only projection requires quota-only demand');
    return [getUsageQueryKey(query), query] as const;
  }));
  const results = [...queries].map(([key, query]): UsageQueryResultSlice => {
    const { sources: quotaSources, ...quotaFields } = projectUsageQuotaFields(input.quota, poolsByQuery.get(key),
      input.previous?.results.find(slice => slice.key === key)?.pools);
    const sources: UsageQuerySourceState[] = [
      { source: 'accounting', status: 'unsupported' },
      { source: 'work', status: 'not_loaded' },
      { source: 'how_you_work', status: 'not_loaded' },
      ...quotaSources,
      ...(input.sources ?? []).filter(source => source.source.startsWith('quota:')),
    ];
    return { key, requestedQuery: query, shownQuery: query,
      ...quotaFields,
      sources, pending: sources.some(source => (source.source === 'quota' || source.source.startsWith('quota:') || source.source.startsWith('selection:'))
        && (source.status === 'pending' || source.status === 'not_loaded')) };
  });
  return retainUsageQueryResultReferences({ v: 1, results }, input.previous);
}

export function resolveUsagePageAggregation(input: UsagePageAggregationInput): UsageQueryBatchResult {
  const pricingOverrides = input.pricingOverrides ?? input.accountSettings?.usageModelPriceOverridesV1;
  const coachPreferences = input.coachPreferences === undefined
    ? input.accountSettings?.usageCoachPreferencesV1 : input.coachPreferences;
  const configuredNightHours = input.nightHours === undefined
    ? input.accountSettings?.usageNightHoursV1 : input.nightHours;
  const queries = new Map<string, UsageQuery>();
  for (const candidate of input.queries) {
    const query = normalizeUsageQuery(candidate);
    const key = getUsageQueryKey(query);
    if (!queries.has(key)) queries.set(key, query);
  }
  const accounting = new Map<string, UsageAccountingSourceSnapshot>(input.accounting?.map(snapshot => [getUsageQueryKey(snapshot.query), {
    ...snapshot,
    asOfMs: snapshot.asOfMs ?? (snapshot.value ? resolveUsageAccountingAsOfMs(snapshot.value) : undefined),
  }]));
  const sourceLocations = new Map(input.sourceLocations?.map(location => [location.machineId, location.displayLocation]));
  const projectSourceLocations = (value: UsageAnalyticsQueryResponse) => {
    const coverage = value.coverage;
    if (!coverage) return value;
    const known = accountingSourceLocationProjections.get(value);
    if (known && sameStrictJsonValue(known.locations, input.sourceLocations)) return known.value;
    const sources = coverage.sources.map(candidate => {
      // Facts were admitted by the A boundary. Only the authorized client label
      // can expire here; removing it does not require parsing those facts again.
      const current = candidate as typeof candidate & { displayLocation?: string };
      const displayLocation = candidate.machineId ? sourceLocations.get(candidate.machineId) : undefined;
      if (current.displayLocation === displayLocation && (displayLocation !== undefined || !('displayLocation' in current))) return candidate;
      const { displayLocation: _previous, ...source } = current;
      return { ...source, ...(displayLocation === undefined ? {} : { displayLocation }) };
    });
    const projected = sources.every((source, index) => source === coverage.sources[index]) ? value
      : { ...value, coverage: { ...coverage, sources } };
    accountingSourceLocationProjections.set(value, { locations: input.sourceLocations, value: projected });
    return projected;
  };
  const projectPrices = (snapshot: UsageAccountingSourceSnapshot | undefined) => {
    if (!snapshot) return snapshot;
    const projected = projectUsageAccountingSnapshotPrices(snapshot, pricingOverrides, accounting.values());
    const key = getUsageQueryKey(projected.query);
    if (accounting.get(key)?.value === projected.value) accounting.set(key, projected);
    return projected.priceProjection ? { ...projected, value: projected.priceProjection.value } : projected;
  };
  const work = new Map(input.work?.map(snapshot => [getUsageQueryKey(snapshot.query), snapshot]));
  const howYouWork = new Map(input.howYouWork?.map(snapshot => [getUsageQueryKey(snapshot.query), snapshot]));
  const poolsByQuery = new Map(input.pools?.map(snapshot => [getUsageQueryKey(snapshot.query), snapshot.value]));
  const previous = new Map(input.previous?.results.map(slice => [slice.key, slice]));
  const results = [...queries].map(([key, query]) => {
    if (!query.includeAccounting) return resolveUsageQuotaPageAggregation({ ...input, queries: [query] }).results[0]!;
    const observed = accounting.get(key);
    const prior = previous.get(key);
    const admitted = (prior as ProjectedUsageSlice | undefined)?.[usagePageProjections];
    const pools = poolsByQuery.get(key);
    const { sources: quotaSources, ...quotaFields } = projectUsageQuotaFields(input.quota, pools, prior?.pools);
    const snapshot = projectPrices(retainAccountingOnReadFailure(observed, prior?.accounting,
      prior?.sources.find(source => source.source === 'accounting')?.asOfMs));
    const readPeriod = observed?.period ?? (input.nowMs !== undefined ? resolveUsageQueryPeriod(query, input.nowMs)
      : 'relative' in query.period ? snapshot?.value?.coverage?.range ?? query.period : query.period);
    // A failed refresh retains the prior accounting window as well as its
    // values; it cannot compare those values against a later requested range.
    const period = 'relative' in query.period ? readBoundedAccountingPeriod(snapshot?.value) ?? readPeriod : readPeriod;
    const comparisonQuery = resolveUsageComparisonQuery(query, period);
    const previousComparison = comparisonQuery && prior?.comparison
      && getUsageQueryKey(prior.comparison.query) === getUsageQueryKey(comparisonQuery) ? prior.comparison : undefined;
    const comparisonSnapshot = comparisonQuery ? projectPrices(retainAccountingOnReadFailure(accounting.get(getUsageQueryKey(comparisonQuery)),
      previousComparison?.accounting, previousComparison?.source.asOfMs)) : undefined;
    const comparisonSource: UsageQuerySourceState = { source: 'comparison', status: comparisonSnapshot?.status ?? 'not_loaded',
      ...(comparisonSnapshot?.asOfMs === undefined ? {} : { asOfMs: comparisonSnapshot.asOfMs }),
      ...(comparisonSnapshot?.errorCode === undefined ? {} : { errorCode: comparisonSnapshot.errorCode }) };
    const workSnapshot = work.get(key);
    const detailSnapshot = howYouWork.get(key);
    const detailAuthorized = canRetainUsageReadFailure(detailSnapshot?.errorCode);
    const readDetail = detailAuthorized ? detailSnapshot?.detail : undefined;
    const priorDetail = admitted?.howYouWork.inputs.detail as UsageHowYouWorkDetailInput | undefined;
    // The opened query has already selected its authorized membership. Keep
    // unchanged nested evidence identities when another source replaces its
    // snapshot, so interval work follows facts rather than source wrappers.
    const facts = readDetail?.facts && priorDetail?.facts && sameStrictJsonValue(readDetail.facts, priorDetail.facts)
      ? priorDetail.facts : readDetail?.facts;
    const activityAtMs = readDetail?.activityAtMs && priorDetail?.activityAtMs
      && sameStrictJsonValue(readDetail.activityAtMs, priorDetail.activityAtMs)
      ? priorDetail.activityAtMs : readDetail?.activityAtMs;
    const observedDetail = readDetail && (facts !== readDetail.facts || activityAtMs !== readDetail.activityAtMs)
      ? { ...readDetail, ...(facts === readDetail.facts ? {} : { facts }),
        ...(activityAtMs === readDetail.activityAtMs ? {} : { activityAtMs }) } : readDetail;
    const pendingDetail = !detailSnapshot && input.sources?.some(source => source.source === 'how_you_work' && source.status === 'pending');
    // A failed replacement has no new admission. A supplied detail (including
    // an unknown/refused result) supersedes old facts even if another read failed.
    const failedDetail = detailSnapshot?.errorCode !== undefined && !detailSnapshot.detail && detailAuthorized;
    // Public detail cannot retain turns that the current accounting population
    // no longer admits. Ordinary personal-history refresh keeps its existing behavior.
    const canRetainDetail = query.population !== 'public_eligible_personal' && query.execution === undefined
      || snapshot?.value?.contributions !== undefined && snapshot.value.contributions === prior?.accounting?.contributions
      || hasSameUsageQueryWorkEvidenceMembership({
      query, contributions: snapshot?.value?.contributions, previousContributions: prior?.accounting?.contributions,
      sessionMembership: readUsageAccountingSessionMembership(snapshot?.value),
      previousSessionMembership: readUsageAccountingSessionMembership(prior?.accounting),
    });
    const retainedDetail = canRetainDetail && (pendingDetail || failedDetail) ? prior : undefined;
    const retainedNightHours = retainedDetail?.howYouWork?.nightShift;
    // Missing evidence on an ordinary failed read is not a replacement. An
    // explicit empty admission/quarantine still withdraws the old witnesses.
    const failedWork = workSnapshot?.status === 'error' && workSnapshot.evidence === undefined
      && workSnapshot.branchEvidence === undefined && canRetainUsageReadFailure(workSnapshot.errorCode)
      && (prior?.work !== undefined || prior?.workSummary !== undefined || prior?.publicProfileEvidence?.facts.mergedPrs !== undefined);
    const retainWork = workSnapshot?.status === 'pending' || failedWork;
    const priorWorkSource = prior?.sources.find(source => source.source === 'work');
    const workAsOfMs = failedWork ? priorWorkSource?.asOfMs : workSnapshot?.asOfMs;
    // A reread has not replaced observed Work facts. Keep their currentness
    // until its answer changes them, including a completed retained failure.
    const workSource: UsageQuerySourceState = priorWorkSource?.errorCode === 'work_evidence_failed'
      && (workSnapshot?.status === 'pending' || failedWork && priorWorkSource.status === 'stale'
        && workSnapshot.errorCode === priorWorkSource.errorCode
        && workSnapshot.updateRequired === priorWorkSource.updateRequired) ? priorWorkSource
      : { source: 'work', status: failedWork ? 'stale' : workSnapshot?.status ?? 'not_loaded',
        ...(workAsOfMs === undefined ? {} : { asOfMs: workAsOfMs }),
        ...(workSnapshot?.errorCode === undefined ? {} : { errorCode: workSnapshot.errorCode }),
        ...(workSnapshot?.updateRequired === undefined ? {} : { updateRequired: workSnapshot.updateRequired }) };
    // Retained evidence remains attached to this exact query while its owner
    // rereads it. Allocation always recomputes over the current contributions;
    // a terminal refusal below removes that previously admitted evidence.
    const retainedWork = retainWork ? prior?.work : undefined;
    const readableWork = workSnapshot && ['available', 'partial', 'stale'].includes(workSnapshot.status);
    // An open query is projected only up to a witnessed source as-of. It is not
    // relabelled as a different bounded query or filled forward to this clock.
    const startMs = period.startMs ?? 0;
    const endMs = period.endMs ?? detailSnapshot?.asOfMs;
    const calendar = projectAdmittedUsageInputs(admitted?.calendar, {
      accounting: snapshot?.value, startMs, endMs, authorized: canRetainUsageReadFailure(snapshot?.errorCode),
    }, () => snapshot && endMs !== undefined && endMs >= startMs
      ? projectUsageAccountingSnapshotCalendar(snapshot, accounting.values(), { startMs, endMs }).agentCalendarAccounting : undefined);
    const currentSnapshot = accounting.get(key);
    if (calendar.value && currentSnapshot && currentSnapshot.value === observed?.value) accounting.set(key,
      { ...currentSnapshot, agentCalendarAccounting: calendar.value });
    const nightHours = configuredNightHours === undefined ? detailSnapshot?.nightHours ?? (retainedNightHours
      ? { startHour: retainedNightHours.startHour, endHour: retainedNightHours.endHour } : undefined) : configuredNightHours ?? undefined;
    const retainedHowYouWork = retainedDetail?.howYouWork;
    const detailNowMs = input.nowMs ?? detailSnapshot?.asOfMs;
    const calendarStartMs = endMs === undefined ? undefined
      : resolveUsageQueryPeriod(query, endMs).startMs === undefined ? undefined : startMs;
    const detailFacts = projectAdmittedUsageInputs(admitted?.howYouWork, {
      accounting: snapshot?.value, detail: observedDetail, calendar: calendar.value, startMs, endMs, calendarStartMs,
      sessionCoverage: detailAuthorized ? detailSnapshot?.sessionCoverage : undefined, nowMs: detailNowMs,
      nightStartHour: nightHours?.startHour, nightEndHour: nightHours?.endHour,
      retaining: retainedHowYouWork !== undefined,
      retained: retainedHowYouWork === admitted?.howYouWork.value && admitted?.howYouWork.inputs.retaining
        ? admitted.howYouWork.inputs.retained : retainedHowYouWork,
    }, () => endMs === undefined || endMs < startMs ? undefined : resolveUsageHowYouWork({
      period: { startMs, endMs }, timeZoneOffsetMinutes: query.timeZoneOffsetMinutes,
      accounting: snapshot?.value, detail: observedDetail,
      accountingCalendar: calendar.value,
      calendarPeriod: { startMs: calendarStartMs, endMs },
      includeSteering: query.includeTranscriptEvidence,
      includeAgentCalendar: query.includeActivity || query.includeModelTimeline,
      costMode: query.costBasis,
      sessionCoverage: detailAuthorized ? detailSnapshot?.sessionCoverage : undefined,
      retained: retainedHowYouWork,
      nowMs: detailNowMs, nightHours,
    }));
    const detailProjection = detailFacts.value;
    const admittedDetail = observedDetail?.status === 'unknown' ? undefined : observedDetail;
    const coachEvidence = admittedDetail?.coach;
    const coachAsOfMs = (admittedDetail ? detailSnapshot?.asOfMs : undefined) ?? snapshot?.asOfMs ?? retainedDetail?.coach?.asOfMs ?? null;
    const coachEndMs = endMs ?? coachAsOfMs;
    const coachCurrentness = coachAsOfMs === null ? 'unknown' : detailSnapshot?.errorCode || snapshot?.status === 'error' || snapshot?.status === 'stale' ? 'stale'
      : snapshot?.status === 'available' || admittedDetail ? 'current' : 'unknown';
    // Source-only initial progress has no observed Coach evidence to retain.
    const retainedCoach = coachPreferences === null || retainedDetail?.coach?.asOfMs === null ? undefined : retainedDetail?.coach;
    const coachFacts = projectAdmittedUsageInputs(admitted?.coach, {
      accounting: snapshot?.value, evidence: coachEvidence, hasDetail: admittedDetail !== undefined,
      permissions: admittedDetail?.permissions, startMs, endMs: coachEndMs, asOfMs: coachAsOfMs,
      currentness: coachCurrentness, pricingOverrides, preferences: coachPreferences,
      sessionCoverage: detailProjection?.sessionCoverage, retaining: retainedCoach !== undefined,
      retained: retainedCoach === admitted?.coach.value && admitted?.coach.inputs.retaining
        ? admitted.coach.inputs.retained : retainedCoach,
    }, () => {
      if (!query.includeSessionEvidence) return undefined;
      const coach = coachEndMs === null || coachEndMs === undefined || coachEndMs < startMs ? undefined : evaluateUsageCoach({
        ...coachEvidence,
        ...(admittedDetail ? { detail: { ...coachEvidence?.detail,
          coverage: coachEvidence?.detail?.coverage ?? 'partial',
          ...(admittedDetail.permissions === undefined ? {} : { permissions: admittedDetail.permissions }),
        } } : {}),
        queryKey: key, period: { startMs, endMs: coachEndMs }, asOfMs: coachAsOfMs,
        currentness: coachCurrentness,
        accounting: snapshot?.value,
        pricingOverrides,
        preferences: coachPreferences,
      });
      const retainedEvaluations = retainedCoach?.evaluations.map(evaluation => {
        const configured = coach?.evaluations.find(row => row.detectorId === evaluation.detectorId);
        // Retention must not revive evidence that the current evaluator's configuration refuses.
        if (configured?.status === 'disabled' || evaluation.status === 'disabled' || evaluation.detectorId === 'model_misfit'
          && coachPreferences?.modelSuggestion === 'complete_only') return configured ?? evaluation;
        return evaluation.status === 'finding'
          ? { ...evaluation, finding: { ...evaluation.finding, currentness: 'stale' as const, remedy: null, action: null } } : evaluation;
      });
      const coachProjection = retainedCoach && retainedEvaluations ? { ...retainedCoach, currentness: 'stale' as const,
        evaluations: retainedEvaluations, findings: retainedEvaluations.flatMap(evaluation => evaluation.status === 'finding' ? [evaluation.finding] : []) } : coach;
      const digestSuggestion = coachProjection && createUsageCoachDigestSuggestion(query, coachProjection.period);
      return coachProjection && { ...coachProjection,
        ...(detailProjection?.sessionCoverage === undefined ? {} : { sessionCoverage: detailProjection.sessionCoverage }),
        ...(digestSuggestion === undefined ? {} : { digestSuggestion }),
      };
    });
    const detailSourceStatus: UsageQuerySourceState['status'] = !detailSnapshot?.errorCode ? detailProjection?.detailStatus ?? 'unknown'
      : detailAuthorized && (retainedDetail?.howYouWork || retainedDetail?.publicProfileEvidence || observedDetail && observedDetail.status !== 'unknown') ? 'stale' : 'error';
    const detailAsOfMs = detailSnapshot?.asOfMs ?? retainedDetail?.sources.find(source => source.source === 'how_you_work')?.asOfMs;
    const sources: UsageQuerySourceState[] = [
      { source: 'accounting', status: snapshot?.status ?? 'not_loaded',
        ...(snapshot?.asOfMs === undefined ? {} : { asOfMs: snapshot.asOfMs }),
        ...(snapshot?.errorCode === undefined ? {} : { errorCode: snapshot.errorCode }) },
      ...(snapshot?.value?.coverage?.sources.map(source => ({ source: source.source, status: source.status,
        ...(source.asOfMs === undefined ? {} : { asOfMs: source.asOfMs }) })) ?? []),
      ...quotaSources,
      workSource,
      // An exact-query detail snapshot supersedes the batch-wide initial
      // source. Retaining both lets an unfinished sibling keep this slice
      // pending after its own private evidence has answered.
      ...(query.includeSessionEvidence ? (input.sources ?? []).filter(source => !detailSnapshot || source.source !== 'how_you_work') : [
        ...(input.sources ?? []).filter(source => source.source !== 'how_you_work'),
        { source: 'how_you_work', status: 'not_loaded' as const },
      ]),
      ...(detailSnapshot ? [{ source: 'how_you_work', status: detailSourceStatus,
        ...(detailSnapshot.errorCode === undefined ? {} : { errorCode: detailSnapshot.errorCode }),
        ...(detailSnapshot.updateRequired === undefined ? {} : { updateRequired: detailSnapshot.updateRequired }),
        ...(detailAsOfMs === undefined ? {} : { asOfMs: detailAsOfMs }) }] : []),
    ];
    // Inputs are admitted owner snapshots; this projection is not a wire boundary.
    // Parsing here clones the same full history for every widget on every source
    // revision. Keep its identity and validate the batch at the Action/Resource boundary.
    const workFacts = projectAdmittedUsageInputs(admitted?.work, {
      contributions: snapshot?.value?.contributions, evidence: readableWork ? workSnapshot?.evidence : undefined,
      branchEvidence: readableWork ? workSnapshot?.branchEvidence : undefined, retaining: retainWork,
      retained: retainedWork === admitted?.work.value && admitted?.work.inputs.retaining ? admitted.work.inputs.retained : retainedWork,
    }, () => !query.includeWorkEvidence || snapshot?.value?.contributions === undefined ? undefined : allocateUsageOutcomes({
      contributions: snapshot.value.contributions,
      evidence: retainWork ? retainedWork?.allocations.flatMap(row => row.evidence) ?? [] : readableWork ? workSnapshot?.evidence ?? [] : [],
      branchEvidence: retainWork ? retainedWork?.branchAllocations.flatMap(row => row.evidence) ?? [] : readableWork ? workSnapshot?.branchEvidence ?? [] : [],
    }));
    const workProjection = workFacts.value;
    const workSummary = readableWork && workSnapshot?.summary
      || retainWork && prior?.workSummary
      || workProjection && projectUsageWorkSummary(workProjection.outcomes) || undefined;
    const hasMergedOutcomes = retainWork && prior?.mergedOutcomes !== undefined || readableWork;
    const mergedFacts = projectAdmittedUsageInputs(admitted?.mergedOutcomes, {
      work: workProjection, startMs, endMs, observed: Boolean(hasMergedOutcomes),
    }, () => workProjection && endMs !== undefined && endMs >= startMs
      // An allocation scaffold also exists before Work has ever been read.
      // Only an observed summary can retain known counts through a reread.
      && hasMergedOutcomes
      ? summarizeUsageMergedOutcomes({ work: workProjection, period: { startMs, endMs }, timeZoneOffsetMinutes: query.timeZoneOffsetMinutes }) : undefined);
    const planInsights = projectAdmittedUsageInputs(admitted?.planInsights, {
      accounting: snapshot?.value, asOfMs: snapshot?.asOfMs, startMs: period.startMs, endMs: period.endMs,
      howYouWork: detailProjection, nowMs: input.nowMs,
      quota: input.quota?.value && ['available', 'partial', 'stale'].includes(input.quota.status) ? input.quota.value : undefined,
    }, () => projectUsagePlanInsights({ query: { ...query, period }, nowMs: input.nowMs, accounting: snapshot?.value, accountingAsOfMs: snapshot?.asOfMs,
      howYouWork: detailProjection,
      quota: input.quota?.value && ['available', 'partial', 'stale'].includes(input.quota.status) ? input.quota.value : undefined }));
    const costFactTotals = projectAdmittedUsageInputs(admitted?.costFactTotals, { facts: snapshot?.value?.costFacts, available: snapshot?.value !== undefined },
      () => snapshot?.value === undefined ? undefined : projectUsageCostFactTotals(snapshot.value.costFacts ?? []));
    const comparisonCostFactTotals = projectAdmittedUsageInputs(admitted?.comparisonCostFactTotals, { facts: comparisonSnapshot?.value?.costFacts,
      available: comparisonSnapshot?.value !== undefined },
      () => comparisonSnapshot?.value === undefined ? undefined : projectUsageCostFactTotals(comparisonSnapshot.value.costFacts ?? []));
    const projections: UsagePageProjections = { calendar, howYouWork: detailFacts, coach: coachFacts, work: workFacts, mergedOutcomes: mergedFacts,
      planInsights, costFactTotals, comparisonCostFactTotals };
    const slice: ProjectedUsageSlice = {
      key, requestedQuery: query, shownQuery: query,
      [usagePageProjections]: admitted && Object.entries(projections).every(([field, value]) => admitted[field as keyof UsagePageProjections] === value) ? admitted : projections,
      ...(snapshot?.value === undefined ? {} : { accounting: projectSourceLocations(snapshot.value), costFactTotals: costFactTotals.value }),
      planInsights: planInsights.value,
      ...quotaFields,
      ...(detailProjection === undefined ? {} : { howYouWork: detailProjection }),
      ...(coachFacts.value === undefined ? {} : { coach: coachFacts.value }),
      ...(comparisonQuery ? { comparison: { query: comparisonQuery, source: comparisonSource,
        ...(comparisonSnapshot?.value === undefined ? {} : { accounting: projectSourceLocations(comparisonSnapshot.value), costFactTotals: comparisonCostFactTotals.value }) } } : {}),
      ...(workProjection === undefined ? {} : { work: workProjection }),
      ...(workSummary === undefined ? {} : { workSummary }),
      ...(prior?.publicProfileEvidence && (retainedDetail || retainWork && canRetainDetail) ? {
        publicProfileEvidence: retainPublicProfileEvidence(prior.publicProfileEvidence, Boolean(retainedDetail), retainWork && canRetainDetail),
      } : {}),
      ...(mergedFacts.value === undefined ? {} : { mergedOutcomes: mergedFacts.value }),
      sources,
      pending: [...sources, ...(comparisonQuery ? [comparisonSource] : [])].some(source =>
        (source.status === 'pending' || source.status === 'not_loaded')
        && (source.source === 'work' ? query.includeWorkEvidence
          : source.source === 'how_you_work' ? query.includeSessionEvidence : true)),
    };
    return slice;
  });
  return retainUsageQueryResultReferences({ v: 1, results }, input.previous);
}
