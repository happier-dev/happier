import { z } from '../zodRuntimePolicy.js';
import type { UsageCoachPreferencesV1 } from '../account/settings/usageCoachPreferencesV1.js';
import type { AccountSettings } from '../account/settings/accountSettings.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { sameStrictJsonValue } from '../json/strictJsonValue.js';
import { getUsageQueryKey, normalizeUsageQuery, resolveUsageQueryPeriod, usageQueryToAnalyticsRequest, usageQueryNeedsContributionRows, UsageQuerySchema, type UsageQuery } from '../inputs/usageQuery.js';
import { UsageQueryAccountingSchema, type UsageAnalyticsQueryResponse } from './usageAnalyticsContracts.js';
import { UsageCostFactTotalSchema, projectUsageCostFactTotals } from './usageCostFactTotals.js';
import { allocateUsageOutcomes, summarizeUsageMergedOutcomes, projectUsageWorkSummary, resolveUsageWorkOutcomeAdmissions, UsageWorkSummarySchema, UsageMergedOutcomeSummarySchema, UsageWorkProjectionSchema, type UsageMergedOutcomeSummary, type UsageWorkEvidence } from './usageOutcomeAllocation.js';
import { hasUsagePullRequestRead, projectUsagePublicWorkLenses, readUsageWorkSessionTurns } from './usageWorkSources.js';
import type { ScmBranchWorkEvidence } from '../scm/branches.js';
import { resolveUsageHowYouWork, UsageHowYouWorkSchema, type UsageHowYouWorkDetailInput, type UsageSessionEvidenceCoverage } from './resolveUsageHowYouWork.js';
import type { UsageWorkIntervalsInput } from './usageWorkIntervals.js';
import { ConnectedServiceQuotaGetResultV1Schema, type ConnectedServiceQuotaGetResultV1 } from '../connect/providerAccountUsageHistorySchemasV1.js';
import { isConnectedServiceCredentialHealthStatusReconnectRequired, type ConnectedServiceCredentialHealthStatusV1 } from '../connect/connectedServiceSchemas.js';
import type { PluginContributionIdentityV1 } from '../plugins/contributionIdentity.js';
import { isConnectedServiceQuotaObservationFresh, wasConnectedServiceQuotaObserved } from '../connect/quotaObservationTime.js';
import { evaluateUsageCoach } from './coach/evaluateUsageCoach.js';
import { createUsageCoachDigestSuggestion } from './coach/coachDigestSuggestion.js';
import { UsageCoachEvaluationSchema } from './coach/coachFinding.js';
import { QualifiedConnectedAccountGroupRefSchema } from '../connect/qualifiedConnectedAccountProjectionsV4.js';
import { ConnectedServicePoolSelectionGetResponseV1Schema } from '../connect/connectedServicePoolSelection.js';
import { createUsagePricingReuse, projectUsageAnalyticsSummary, repriceUsageAnalyticsResponse, type UsagePricingReuse, type UsagePricingReuseSource } from './usageCost.js';
import type { UsageModelPriceCatalog, UsageModelPriceOverridesV1 } from './usageModelPriceCatalog.js';
import { projectUsagePlanInsights, UsagePlanInsightsSchema } from './usagePlanInsights.js';
import { hasSameUsageQueryWorkEvidenceMembership } from './usageWorkEvidence.js';
import { projectUsageAgentAccountingCalendar, resolveUsageAccountingCalendarPeriod, type UsageAgentAccountingCalendar } from './usageAgentCalendar.js';
import { RPC_ERROR_CODES } from '../rpc/errors.js';
import { ActionExecuteFailureSchema } from '../actions/actionExecutionResult.js';
import { OperationUpdateRequiredV1Schema, type OperationUpdateRequiredV1 } from '../compat/operationUpdateRequiredV1.js';
import { PublicProfilePrivateFactsSchema, PublicProfilePrivateFieldCoverageSchema, PublicProfilePrivateAccountingFactsSchema } from '../account/publicProfileAccounting.js';
import { readUsageAccountingSessionMembership } from './usageAccountingMembership.js';
import { resolveUsageBucketBounds } from './usageCalendar.js';
export type { UsagePlanInsights } from './usagePlanInsights.js';

/** One finite accounting publication shares tariff operands across its periods. */
export function createUsagePricingReuseResolver() {
  const pricingReuses: Array<{ revision: string; overrides: UsageModelPriceOverridesV1;
    mode: UsageQuery['costBasis']; reuse: UsagePricingReuse }> = [];
  return (value: NonNullable<UsageAccountingSourceSnapshot['value']>, overrides: UsageModelPriceOverridesV1 | undefined,
    mode: UsageQuery['costBasis']) => {
    if (!value.priceCatalog) return undefined;
    const effectiveOverrides = overrides ?? {};
    // The catalog owner publishes `provenance.revision` as its content identity;
    // decoded responses may wrap equal catalog bytes in different objects.
    const revision = value.priceCatalog.provenance.revision;
    const existing = pricingReuses.find(candidate => candidate.revision === revision
      && candidate.mode === mode && sameStrictJsonValue(candidate.overrides, effectiveOverrides));
    if (existing) return existing.reuse;
    const reuse = createUsagePricingReuse(value.priceCatalog, effectiveOverrides, mode);
    pricingReuses.push({ revision, overrides: effectiveOverrides, mode, reuse });
    return reuse;
  };
}

/** Source transport currentness is separate from accounting completeness. */
export const UsageQuerySourceStatusSchema = lazyZodSchema(() => z.enum([
  'available', 'stale', 'not_loaded', 'pending', 'error', 'unsupported', 'unknown', 'partial',
]));
const UsageWorkUnreadSessionsSchema = lazyZodSchema(() => {
  const count = z.optional(z.number().check(z.int(), z.positive()));
  return z.strictObject({ machine_unavailable: count, not_entitled: count, timed_out: count, failed: count });
});
export const UsageQuerySourceStateSchema = lazyZodSchema(() => z.strictObject({
  source: z.string().check(z.trim(), z.minLength(1)),
  status: UsageQuerySourceStatusSchema,
  asOfMs: z.optional(z.number().check(z.int(), z.nonnegative())),
  errorCode: z.optional(z.string().check(z.trim(), z.minLength(1))),
  details: ActionExecuteFailureSchema.shape.details,
  failureCause: ActionExecuteFailureSchema.shape.failureCause,
  updateRequired: z.optional(OperationUpdateRequiredV1Schema),
  /** Private Work read coverage, grouped by reason without Session identifiers. */
  unreadSessions: z.optional(UsageWorkUnreadSessionsSchema),
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

function readWitnessedUsageComparisonPeriod(accounting: UsageAnalyticsQueryResponse | undefined,
  coachPeriod: Readonly<{ startMs: number; endMs: number }> | undefined) {
  return readBoundedAccountingPeriod(accounting) ?? coachPeriod ?? accounting?.coverage?.range;
}

export const USAGE_QUERY_EVIDENCE_SECTIONS = ['work', 'workSessionDetail', 'howYouWork', 'coach'] as const;

function readMergedLinkFacts({ outcomes, ...facts }: UsageMergedOutcomeSummary) {
  return { ...facts, outcomes: outcomes.map(({ key, mergedAtMs }) => ({ key, mergedAtMs })) };
}

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
    /** Work includes its Session detail and dependent merged-outcome summary. */
    omittedSections: z.array(z.enum(USAGE_QUERY_EVIDENCE_SECTIONS)).check(z.minLength(1), z.refine(sections => new Set(sections).size === sections.length)),
    recovery: z.literal('narrow_query'),
  })),
  sources: z.array(UsageQuerySourceStateSchema),
  pending: z.boolean(),
}).check(z.superRefine((slice, context) => {
  const omissions = slice.incomplete?.omittedSections ?? [];
  const compactWork = omissions.includes('workSessionDetail');
  const contributions = slice.accounting?.contributions;
  const work = slice.work;
  const compactWorkInputs = work && slice.accounting && contributions === undefined
    && work.allocations.length === 0 && work.branchAllocations.length === 0;
  const completeWorkInputs = work && contributions && new Set(contributions.map(row => row.id)).size === contributions.length
    && [work.allocations, work.branchAllocations].every(rows => rows.length === contributions.length
      && rows.every((row, index) => row.contributionId === contributions[index]!.id));
  for (const section of omissions) {
    if (section === 'workSessionDetail') {
      if (!compactWorkInputs || omissions.includes('work')) {
        context.addIssue({ code: 'custom', path: ['incomplete'], message: 'Omitted Work Session detail requires only Work links and summaries' });
      }
      continue;
    }
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
    ? readWitnessedUsageComparisonPeriod(slice.accounting, slice.coach?.period)
    : slice.shownQuery.period;
  if (slice.comparison) {
    const expected = resolveUsageComparisonQuery(slice.requestedQuery, accountingPeriod);
    if (!expected || getUsageQueryKey(slice.comparison.query) !== getUsageQueryKey(expected)) {
      context.addIssue({ code: 'custom', path: ['comparison', 'query'], message: 'Comparison must identify the exact preceding range' });
    }
  }
  if (work && (!slice.requestedQuery.includeWorkEvidence || !compactWork && !completeWorkInputs)) {
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
  const pullRequestsRead = slice.workSummary?.pullRequestsRead === true;
  if (!pullRequestsRead && (slice.workSummary?.mergedPrCount !== undefined || slice.workSummary?.mergedSessionCount !== undefined)) {
    context.addIssue({ code: 'custom', path: ['workSummary'], message: 'Exact merged counts require admitted PR coverage' });
  }
  // All-time accounting has a witnessed end and no lower bound. The Work
  // projection represents that open start as zero, without bounding the query.
  const readableWorkSource = slice.sources.some(source => source.source === 'work'
    && ['available', 'partial', 'stale', 'pending'].includes(source.status));
  if (slice.mergedOutcomes) {
    const expected = work && witnessedPeriod?.endMs !== undefined && readableWorkSource
      && (compactWork ? compactWorkInputs : completeWorkInputs)
      ? summarizeUsageMergedOutcomes({ work, contributions: contributions ?? [],
        period: { startMs: witnessedPeriod.startMs ?? 0, endMs: witnessedPeriod.endMs },
        timeZoneOffsetMinutes: slice.shownQuery.timeZoneOffsetMinutes, pullRequestsRead })
      : undefined;
    // Session detail is needed to reconstruct Agent attribution. The other
    // summary facts still have their exact admitted PR witnesses.
    const conforms = expected && (compactWork
      ? sameStrictJsonValue(readMergedLinkFacts(slice.mergedOutcomes), readMergedLinkFacts(expected))
      : sameStrictJsonValue(slice.mergedOutcomes, expected));
    if (!conforms) {
      context.addIssue({ code: 'custom', path: ['mergedOutcomes'], message: 'Merged outcomes must preserve the admitted Work, period and calendar' });
    }
  }
  if (week?.status === 'available' && (!slice.accounting?.activity
    || week.startMs !== accountingPeriod?.startMs || week.endMs !== accountingPeriod?.endMs
    || week.timeZoneOffsetMinutes !== slice.shownQuery.timeZoneOffsetMinutes)) {
    context.addIssue({ code: 'custom', path: ['planInsights', 'recordedWeek'], message: 'Recorded week must preserve admitted accounting period and calendar' });
  }
  if ((slice.work?.outcomes.length || slice.work?.branches.length || slice.work?.allocations.some(row => row.evidence.length > 0)
    || slice.work?.branchAllocations.some(row => row.evidence.length > 0)) && !readableWorkSource) {
    context.addIssue({ code: 'custom', path: ['work'], message: 'Unavailable Work sources cannot disclose private evidence' });
  }
  const intervals = slice.howYouWork?.intervals;
  // A pending or ordinarily failed detail replacement may carry the same
  // rolling query's witnessed window while accounting has already advanced.
  const retainedDetailPeriod = intervals && 'relative' in slice.shownQuery.period
    && witnessedPeriod?.endMs !== undefined && intervals.period.endMs < witnessedPeriod.endMs
    && intervals.period.startMs === (resolveUsageQueryPeriod(slice.shownQuery, intervals.period.endMs).startMs ?? 0)
    && slice.sources.some(source => (source.status === 'pending' || (source.status === 'stale' && source.errorCode !== undefined))
      && isUsageDetailSourceReadable(source) && source.asOfMs !== undefined && intervals.period.endMs <= source.asOfMs)
    ? intervals.period : undefined;
  const detailPeriod = retainedDetailPeriod ?? witnessedPeriod;
  if (intervals && (intervals.timeZoneOffsetMinutes !== slice.shownQuery.timeZoneOffsetMinutes
    || (detailPeriod?.startMs !== undefined && intervals.period.startMs !== detailPeriod.startMs)
    || (detailPeriod?.endMs !== undefined && intervals.period.endMs !== detailPeriod.endMs))) {
    context.addIssue({ code: 'custom', path: ['howYouWork'], message: 'Intervals must identify the shown period and calendar' });
  }
  if (intervals && !slice.sources.some(isUsageDetailSourceReadable)) {
    context.addIssue({ code: 'custom', path: ['howYouWork'], message: 'Unavailable detail cannot disclose private intervals' });
  }
  const agentCalendar = slice.howYouWork?.agentCalendar;
  const calendarPeriod = retainedDetailPeriod?.endMs === agentCalendar?.period.endMs
    ? detailPeriod : witnessedPeriod;
  const calendarRequestedPeriod = agentCalendar && resolveUsageQueryPeriod(slice.shownQuery,
    calendarPeriod?.endMs ?? agentCalendar.period.endMs);
  if (agentCalendar && (agentCalendar.timeZoneOffsetMinutes !== slice.shownQuery.timeZoneOffsetMinutes
    || agentCalendar.period.startMs > agentCalendar.period.endMs
    || calendarRequestedPeriod?.startMs !== undefined && calendarPeriod?.startMs !== undefined && agentCalendar.period.startMs !== calendarPeriod.startMs
    || calendarPeriod?.endMs !== undefined && agentCalendar.period.endMs !== calendarPeriod.endMs)) {
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
type UsageWorkReadProjection = Readonly<{
  work: UsageQueryResultSlice['work'];
  summary: UsageQueryResultSlice['workSummary'];
  profileLenses: ReturnType<typeof projectUsagePublicWorkLenses>;
}>;
type UsagePageProjections = {
  accountingReadAtMs?: number;
  calendar: AdmittedUsageProjection<UsageAgentAccountingCalendar | undefined>;
  howYouWork: AdmittedUsageProjection<UsageQueryResultSlice['howYouWork']> & Readonly<{ period?: UsageWorkIntervalsInput['period'] }>;
  coach: AdmittedUsageProjection<UsageQueryResultSlice['coach']>;
  work: AdmittedUsageProjection<UsageWorkReadProjection>;
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

/** The admitted local read of the displayed accounting value. */
export function readUsageAccountingReadAtMs(slice: Pick<UsageQueryResultSlice, 'sources'>): number | undefined {
  return (slice as ProjectedUsageSlice)[usagePageProjections]?.accountingReadAtMs;
}

/** Shares and their legends read the admitted accounting cohort even when a sibling supplies private activity. */
export function readUsageAgentAccountingCalendar(slice: UsageQueryResultSlice): UsageAgentAccountingCalendar['projection'] | null {
  if (!slice.accounting) return null;
  const admitted = (slice as ProjectedUsageSlice)[usagePageProjections];
  if (admitted) return admitted.calendar.value?.projection ?? null;
  // A restored slice has no in-process projection metadata. Use the same accounting owner on its displayed range.
  const calendar = slice.howYouWork?.agentCalendar;
  return projectUsageAccountingSnapshotCalendar({ query: slice.shownQuery, status: 'available', value: slice.accounting },
    undefined, calendar?.period).agentCalendarAccounting?.projection ?? null;
}

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
  // Public profile delivery omits private members after deriving consented
  // facts. That omission must not erase their admitted calculation inputs.
  const projected: UsagePageProjections = { ...admitted,
    howYouWork: Object.prototype.hasOwnProperty.call(value, 'howYouWork')
      ? withValue(admitted.howYouWork, value.howYouWork) : admitted.howYouWork,
    coach: Object.prototype.hasOwnProperty.call(value, 'coach')
      ? withValue(admitted.coach, value.coach) : admitted.coach,
    work: Object.prototype.hasOwnProperty.call(value, 'work')
      && value.work !== admitted.work.value.work
      ? withValue(admitted.work, { ...admitted.work.value, work: value.work }) : admitted.work,
    mergedOutcomes: Object.prototype.hasOwnProperty.call(value, 'mergedOutcomes')
      ? withValue(admitted.mergedOutcomes, value.mergedOutcomes) : admitted.mergedOutcomes,
    planInsights: withValue(admitted.planInsights, value.planInsights), costFactTotals: withValue(admitted.costFactTotals, value.costFactTotals),
    comparisonCostFactTotals: withValue(admitted.comparisonCostFactTotals, value.comparison?.costFactTotals),
  };
  const current = (value as ProjectedUsageSlice)[usagePageProjections];
  if (current && current.accountingReadAtMs === admitted.accountingReadAtMs) {
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

/** A changed private fact must not re-key the calendar, runs or interval lanes used by other bodies. */
function retainUsageHowYouWorkReferences(value: NonNullable<UsageQueryResultSlice['howYouWork']>,
  previous: UsageQueryResultSlice['howYouWork']): NonNullable<UsageQueryResultSlice['howYouWork']> {
  if (!previous || value === previous) return value;
  const intervals = value.intervals && previous.intervals ? retainUsageMembers(value.intervals, previous.intervals) : value.intervals;
  const agentCalendar = value.agentCalendar && previous.agentCalendar
    ? retainUsageMembers(value.agentCalendar, previous.agentCalendar) : value.agentCalendar;
  return retainUsageMembers({ ...value, intervals, agentCalendar }, previous, ['intervals', 'agentCalendar']);
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
    // Coverage can repeat a source name. Match the complete admitted state,
    // rather than treating its name as an immutable or unique source fact.
    if (slice.sources !== retained.sources) {
      // Primitive fields narrow candidates; complete state still decides reuse.
      const sourceBucketKey = (source: UsageQuerySourceState) => JSON.stringify([
        source.source, source.status, source.asOfMs, source.errorCode,
      ]);
      const priorSources = new Map<string, UsageQuerySourceState[]>();
      for (const source of retained.sources) {
        const key = sourceBucketKey(source);
        const rows = priorSources.get(key) ?? [];
        rows.push(source);
        priorSources.set(key, rows);
      }
      const rows = slice.sources.map((source, index) => {
        const matches = (previous: UsageQuerySourceState | undefined) => previous !== undefined && (previous === source
          || sameStrictJsonValue(source, previous, { omitUndefinedObjectMembers: true }));
        // Source-only progress preserves coverage order. Admit that complete
        // fact once before searching repeated names for a reordered match.
        const atIndex = retained.sources[index];
        return matches(atIndex) ? atIndex! : priorSources.get(sourceBucketKey(source))?.find(matches) ?? source;
      });
      const sources = rows.length === retained.sources.length && rows.every((row, index) => row === retained.sources[index])
        ? retained.sources : rows;
      reconciled = { ...reconciled, sources };
    }
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
        .filter(key => (key === 'work' ? retainedProjections.work.value.work : retainedProjections[key].value) === retained[key]) : [];
    const result = retainUsageMembers(reconciled, retained, ['accounting', 'sources', ...projectedKeys, ...(slice.comparison?.accounting && retained.comparison?.accounting
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
  /** Successful Account acquisition of the value, carried locally across retained reads. */
  readAtMs?: number;
  errorCode?: string;
  details?: UsageQuerySourceState['details'];
  failureCause?: UsageQuerySourceState['failureCause'];
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
  fallbackCatalog: UsageModelPriceCatalog,
  siblings?: Iterable<UsageAccountingSourceSnapshot>,
  previous?: UsageAnalyticsQueryResponse,
  reuse?: UsagePricingReuseSource): UsageAccountingSourceSnapshot {
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
  const priced = repriceUsageAnalyticsResponse(value, value.priceCatalog ?? fallbackCatalog, overrides, snapshot.query.costBasis, undefined, reuse);
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

/** The producer record that supplies the accounting observation witness. */
export function readUsageOldestAccountingObservation(value: UsageAnalyticsQueryResponse) {
  let oldestSource: string | undefined;
  let oldestAtMs: number | undefined;
  for (const { source, status, asOfMs } of value.coverage?.sources ?? []) {
    if ((status === 'available' || status === 'partial') && asOfMs !== undefined
      && (oldestAtMs === undefined || asOfMs < oldestAtMs)) {
      oldestSource = source;
      oldestAtMs = asOfMs;
    }
  }
  return oldestSource !== undefined && oldestAtMs !== undefined ? { source: oldestSource, asOfMs: oldestAtMs } : undefined;
}

/** An accounting witness dates the producer's observation. */
export function resolveUsageAccountingAsOfMs(value: UsageAnalyticsQueryResponse): number | undefined {
  return readUsageOldestAccountingObservation(value)?.asOfMs;
}

/** Display currentness has no Machine/path dimension; preserve each distinct status. */
function projectUsageAccountingSourceStates(value: UsageAnalyticsQueryResponse | undefined): UsageQuerySourceState[] {
  const states = new Map<string, UsageQuerySourceState>();
  for (const source of value?.coverage?.sources ?? []) {
    const key = JSON.stringify([source.source, source.status]);
    const previous = states.get(key);
    if (!previous || source.asOfMs !== undefined && (previous.asOfMs === undefined || source.asOfMs > previous.asOfMs)) {
      states.set(key, { source: source.source, status: source.status,
        ...(source.asOfMs === undefined ? {} : { asOfMs: source.asOfMs }) });
    }
  }
  return [...states.values()];
}

export type UsageWorkSourceSnapshot = Readonly<{
  query: UsageQuery;
  evidence?: readonly UsageWorkEvidence[];
  branchEvidence?: readonly ScmBranchWorkEvidence[];
  pullRequestReadSessions?: readonly string[];
  status: UsageQuerySourceState['status'];
  asOfMs?: number;
  errorCode?: string;
  updateRequired?: OperationUpdateRequiredV1;
  unreadSessions?: UsageQuerySourceState['unreadSessions'];
  /** During acquisition, only Sessions without a replacement can lend old witnesses. */
  retainWorkSessionIds?: readonly string[];
  /** Local acquisition facts used to apply a Session-scoped refusal before delivery. */
  unreadBySession?: readonly (readonly [string, keyof NonNullable<UsageQuerySourceState['unreadSessions']>])[];
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

/** Whether one source of a query slice is still being read; the slice is pending while any one is. */
export function isUsageQuerySourceOutstanding(query: UsageQuery, source: UsageQuerySourceState): boolean {
  return (source.status === 'pending' || source.status === 'not_loaded')
    && (source.source === 'work' ? query.includeWorkEvidence === true
      : source.source === 'how_you_work' ? query.includeSessionEvidence === true : true);
}

/** Translate an admitted Session or transcript observation into its Usage source state. */
export function projectUsageActivitySourceStatus(requested: boolean, settled: boolean, covered: boolean) {
  if (!requested) return 'not_loaded';
  if (!settled) return 'pending';
  return covered ? 'available' : 'partial';
}

export const USAGE_COACH_PREFERENCES_READ_SOURCE = 'how_you_work:coach';

function isUsageDetailPhase(source: UsageQuerySourceState): boolean {
  return source.source.startsWith('how_you_work:');
}

/** Usage refusals that require new authority before private evidence can be read. */
export function readUsageAuthorityRefusalCode(errorCode?: string) {
  switch (errorCode) {
    case 'denied':
    case 'permission_denied':
    case 'credential_scope_denied':
    case 'credential_origin_denied':
    case 'present_user_required':
    case 'provider-required':
    case 'not-eligible':
    case 'unauthorized':
    case 'forbidden':
    case 'team_authentication_required':
    case RPC_ERROR_CODES.FORBIDDEN:
    case RPC_ERROR_CODES.TEAM_AUTHENTICATION_REQUIRED:
      return errorCode;
    default:
      return null;
  }
}

export function canRetainUsageReadFailure(errorCode?: string): boolean {
  return readUsageAuthorityRefusalCode(errorCode) === null
    && !['ownership_unproven', 'stale_surface', 'cancelled', 'plugin_resource_context_unavailable',
      RPC_ERROR_CODES.TEAM_AUTHENTICATION_UNAVAILABLE].includes(errorCode ?? '');
}

function isUsageDetailSourceReadable(source: UsageQuerySourceState): boolean {
  return source.source === 'how_you_work' && ['available', 'partial', 'stale', 'pending'].includes(source.status)
    && canRetainUsageReadFailure(source.errorCode);
}

export function retainAccountingOnReadFailure(observed: UsageAccountingSourceSnapshot | undefined,
  value: UsageAnalyticsQueryResponse | undefined, asOfMs: number | undefined, readAtMs?: number): UsageAccountingSourceSnapshot | undefined {
  // Authority loss/cancellation never revives previously disclosed facts.
  if (!observed || observed.value !== undefined || value === undefined || observed.status !== 'error'
    || !canRetainUsageReadFailure(observed.errorCode)) return observed;
  return { ...observed, value, ...(asOfMs === undefined ? {} : { asOfMs }), ...(readAtMs === undefined ? {} : { readAtMs }) };
}

function projectUsageAccountingReadState(source: 'accounting' | 'comparison', snapshot: UsageAccountingSourceSnapshot | undefined,
  previous: UsageQuerySourceState | undefined): UsageQuerySourceState {
  const retained = snapshot?.value && (snapshot.status === 'pending' || snapshot.status === 'stale') ? previous : undefined;
  const asOfMs = snapshot?.asOfMs ?? retained?.asOfMs;
  const errorCode = snapshot?.errorCode ?? retained?.errorCode;
  const refusal = snapshot?.errorCode === undefined ? retained : snapshot;
  return { source, status: snapshot?.status ?? 'not_loaded',
    ...(asOfMs === undefined ? {} : { asOfMs }),
    ...(errorCode === undefined ? {} : { errorCode }),
    ...(refusal?.details === undefined ? {} : { details: refusal.details }),
    ...(refusal?.failureCause === undefined ? {} : { failureCause: refusal.failureCause }),
    ...(retained?.updateRequired === undefined ? {} : { updateRequired: retained.updateRequired }) };
}

/**
 * One deterministic page composition over already-authorized owner snapshots.
 * No accounting, vendor refresh, transport, cache or authority is invented here.
 */
export type UsageQuotaSourceSnapshot = Readonly<Omit<UsageQuerySourceState, 'source'> & {
  value?: readonly ConnectedServiceQuotaGetResultV1[];
  sources?: readonly UsageQuerySourceState[];
}>;

/** Distinguish an Account with no eligible sources from a completed empty quota read. */
export function projectUsageQuotaAccountSources<Account extends Readonly<{
    ref: Readonly<{ service: PluginContributionIdentityV1 }>;
    status: ConnectedServiceCredentialHealthStatusV1;
}>>(
    accounts: readonly Account[],
    // An unknown declaration (undefined) can be settled by Home. A conflict (null) stays refused.
    readCapabilities: (service: PluginContributionIdentityV1) => readonly string[] | null | undefined,
): Readonly<{ accounts: readonly Account[]; unavailable?: UsageQuotaSourceSnapshot }> {
    if (accounts.length === 0) {
        return { accounts: [], unavailable: { status: 'unsupported', errorCode: 'no_connected_accounts' } };
    }
    const capable = accounts.filter(({ ref: { service } }) => {
        const capabilities = readCapabilities(service);
        return capabilities === undefined || capabilities?.includes('usage') === true;
    });
    if (capable.length === 0) {
        return { accounts: [], unavailable: { status: 'unsupported', errorCode: 'no_quota_capable_accounts' } };
    }
    const eligible = capable.filter(({ status }) => !isConnectedServiceCredentialHealthStatusReconnectRequired(status));
    return eligible.length > 0 ? { accounts: eligible }
        : { accounts: [], unavailable: { status: 'error', errorCode: 'connected_account_needs_reauth' } };
}

export type UsageQuotaCoverageRead = Readonly<{
    value: ConnectedServiceQuotaGetResultV1 | null;
    state?: UsageQuerySourceState;
    pending?: boolean;
    unavailable?: boolean;
}>;

/** Project settled coverage from the admitted head and its history evidence. */
export function projectUsageQuotaSourceCoverage(source: string, value: ConnectedServiceQuotaGetResultV1 | null,
    nowMs: number, historyRequested: boolean): UsageQuerySourceState {
    const continuing = value?.history?.nextCursor != null;
    const partialHistory = value?.pageFacts?.historyStatus === 'partial';
    const current = value?.current ?? null;
    if (current && wasConnectedServiceQuotaObserved(current)) {
        const fresh = isConnectedServiceQuotaObservationFresh({
            observedAtMs: current.observedAtMs, nowMs, maxAgeMs: current.staleAfterMs,
        });
        // A finite continuation is an incomplete read. A settled day-summary
        // gap qualifies a fresh head and leaves an expired head stale.
        const status = continuing ? 'partial' : !fresh ? 'stale' : partialHistory ? 'partial' : 'available';
        return { source, status, asOfMs: current.fetchedAtMs };
    }
    // A completed head-only read can answer before the first provider observation.
    const completeEmptyRead = value !== null && !historyRequested && !continuing && !partialHistory
        && (current === null || current.state === 'not_loaded');
    return { source, status: completeEmptyRead ? 'available' : 'partial' };
}

/** Project the same aggregate from opened, progressing or retained qualified reads. */
export function projectUsageQuotaCoverage(reads: readonly UsageQuotaCoverageRead[],
    emptyStatus: UsageQuotaSourceSnapshot['status'], requestedHistoryPending = false): UsageQuotaSourceSnapshot {
    const value = reads.flatMap(read => read.value ? [read.value] : []);
    const sources = reads.flatMap(read => read.state ? [read.state] : []);
    const pending = reads.some(read => read.pending || read.state?.status === 'pending');
    const failure = sources.find(state => state.status !== 'unsupported' && state.errorCode);
    if (!value.length) {
        const unsupported = sources.length > 0 && sources.every(state => state.status === 'unsupported');
        const status = pending || requestedHistoryPending ? 'pending' : failure ? 'error' : unsupported ? 'unsupported' : emptyStatus;
        return { status, sources, ...(status === 'available' ? { value } : {}),
            ...(failure ? { errorCode: failure.errorCode } : {}) };
    }
    // Complete retained readings remain usable during replacement. A failed
    // reply cannot settle the batch while another requested history is held.
    const partial = pending || (requestedHistoryPending && failure !== undefined)
        || reads.some(({ state, value, unavailable }) => !value || unavailable
        || (state?.status !== 'available' && state?.status !== 'stale'));
    const clocks = value.flatMap(read => read.current && wasConnectedServiceQuotaObserved(read.current) ? [read.current.fetchedAtMs] : []);
    return { status: partial ? 'partial' : sources.some(state => state.status === 'stale') ? 'stale' : 'available',
        value, sources, ...(clocks.length ? { asOfMs: Math.min(...clocks) } : {}) };
}

export type UsagePageAggregationInput = Readonly<{
  queries: readonly UsageQuery[];
  /** Opened Account preferences share one resolution path across UI, CLI and daemon callers. */
  accountSettings?: Readonly<Partial<Pick<AccountSettings,
    'usageNightHoursV1' | 'usageModelPriceOverridesV1' | 'usageCoachPreferencesV1'>>>;
  accounting?: readonly UsageAccountingSourceSnapshot[];
  work?: readonly UsageWorkSourceSnapshot[];
  howYouWork?: readonly UsageHowYouWorkSourceSnapshot[];
  /** Per-query progress for the staged private evidence read. */
  howYouWorkProgress?: ReadonlyMap<string, Readonly<{ pending: boolean; sources?: readonly UsageQuerySourceState[] }>>;
  /** Account preference is available independently of private Session detail; null explicitly clears it. */
  nightHours?: UsageWorkIntervalsInput['nightHours'] | null;
  nowMs?: number;
  quota?: UsageQuotaSourceSnapshot;
  /** Host-side finite reads keyed by their admitted query; never serialized. */
  quotaByQuery?: ReadonlyMap<string, UsageQuotaSourceSnapshot>;
  pools?: readonly UsagePoolSourceSnapshot[];
  sources?: readonly UsageQuerySourceState[];
  /** Already-opened machine labels authorized for this Account; absence withdraws retained labels. */
  sourceLocations?: readonly Readonly<{ machineId: string; displayLocation: string }>[];
  previous?: UsageQueryBatchResult;
  /** This finite read's last projection; reuses calculations without claiming a replacement read. */
  projectionPrevious?: UsageQueryBatchResult;
  pricingOverrides?: UsageModelPriceOverridesV1;
  coachPreferences?: UsageCoachPreferencesV1 | null;
}>;

/** A scoped read never borrows a sibling period's value or currentness. */
export function resolveUsageQuotaSourceSnapshot(input: Pick<UsagePageAggregationInput, 'quota' | 'quotaByQuery'>,
  query: UsageQuery): UsageQuotaSourceSnapshot | undefined {
  return input.quotaByQuery ? input.quotaByQuery.get(getUsageQueryKey(query)) : input.quota;
}

/** Shared B admission and source projection for accounting-backed and quota-only slices. */
function projectUsageQuotaFields(query: UsageQuery, quota: UsagePageAggregationInput['quota'], observedPools: readonly UsageQueryPoolSnapshot[] | undefined,
  previousPools?: readonly UsageQueryPoolSnapshot[]) {
  if (query.includeQuota === false) return { sources: [] as UsageQuerySourceState[] };
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
    ...(quota?.sources ?? []),
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

function retainPublicProfileDetail(previous: NonNullable<UsageQueryResultSlice['publicProfileEvidence']>): NonNullable<UsageQueryResultSlice['publicProfileEvidence']> {
  const { mergedPrs: _mergedPrs, ...facts } = previous.facts;
  const { mergedPrs: _mergedPrCoverage, ...fieldCoverage } = previous.fieldCoverage;
  return {
    ...previous, facts, fieldCoverage,
    lenses: previous.lenses.map(lens => {
      const { mergedPrs: _mergedPrs, ...facts } = lens.facts;
      return { ...lens, facts };
    }),
  };
}

/** Reallocate the same accounting facts after a sibling read withdraws Work admission. */
export function withdrawUsageQueryWork(slice: UsageQueryResultSlice, input: Readonly<{
  sessionIds: readonly string[];
  source?: UsageWorkSourceSnapshot;
}>, refused: ReadonlySet<string>): Readonly<{ slice: UsageQueryResultSlice; source?: UsageWorkSourceSnapshot }> {
  const unreadBySession = new Map(input.source?.unreadBySession);
  const withdrawn = input.sessionIds.filter(id => refused.has(id) && unreadBySession.get(id) !== 'not_entitled');
  if (!withdrawn.length) return { slice, source: input.source };
  for (const id of withdrawn) unreadBySession.set(id, 'not_entitled');
  const unreadSessions: NonNullable<UsageWorkSourceSnapshot['unreadSessions']> = {};
  for (const reason of unreadBySession.values()) unreadSessions[reason] = (unreadSessions[reason] ?? 0) + 1;

  const evidence = (input.source?.evidence ?? slice.work?.allocations.flatMap(row => row.evidence) ?? [])
    .filter(witness => unreadBySession.get(witness.sessionId) !== 'not_entitled');
  const branchEvidence = (input.source?.branchEvidence ?? slice.work?.branchAllocations.flatMap(row => row.evidence) ?? [])
    .filter(witness => unreadBySession.get(witness.sessionId) !== 'not_entitled');
  const pullRequestReadSessions = (input.source?.pullRequestReadSessions ?? [])
    .filter(id => unreadBySession.get(id) !== 'not_entitled');
  const readable = evidence.length > 0 || branchEvidence.length > 0 || pullRequestReadSessions.length > 0;
  const previous = slice.sources.find(source => source.source === 'work');
  const asOfMs = readable ? previous?.asOfMs : undefined;
  const status = readable ? 'partial' : 'error';
  const errorCode = 'work_evidence_failed';
  const clock = asOfMs === undefined ? {} : { asOfMs };
  const source: UsageWorkSourceSnapshot = { query: slice.requestedQuery, status, errorCode, ...clock,
    evidence, branchEvidence, pullRequestReadSessions, unreadSessions, unreadBySession: [...unreadBySession] };

  const { work: priorWork, workSummary: _summary, mergedOutcomes: priorMerged, publicProfileEvidence,
    [usagePageProjections]: projections, ...other } = slice as ProjectedUsageSlice;
  const contributions = slice.accounting?.contributions;
  const work = priorWork && contributions && allocateUsageOutcomes({ contributions, evidence, branchEvidence });
  const mergedOutcomes = work && contributions && priorMerged && summarizeUsageMergedOutcomes({ work, contributions, period: priorMerged.period,
    timeZoneOffsetMinutes: priorMerged.timeZoneOffsetMinutes, pullRequestsRead: false });
  const workSummary = readable && work && contributions
    ? projectUsageWorkSummary(work.outcomes, false, { work, contributions }) : undefined;
  const pending = previous?.status === 'pending' && input.sessionIds.some(id => unreadBySession.get(id) !== 'not_entitled');
  const sources = slice.sources.map((current): UsageQuerySourceState => current.source === 'work' ? {
    source: 'work', status: pending ? 'pending' : status, errorCode, ...clock, unreadSessions,
  } : current);
  const replacement: ProjectedUsageSlice = { ...other, sources,
    pending: slice.pending && (sources.some(current => !isUsageDetailPhase(current)
      && isUsageQuerySourceOutstanding(slice.requestedQuery, current))
      || !!slice.comparison && isUsageQuerySourceOutstanding(slice.requestedQuery, slice.comparison.source)),
    ...(work === undefined ? {} : { work }), ...(workSummary === undefined ? {} : { workSummary }),
    ...(mergedOutcomes && mergedOutcomes.linkedMergedCount > 0 ? { mergedOutcomes } : {}),
    ...(publicProfileEvidence === undefined ? {} : { publicProfileEvidence: retainPublicProfileDetail(publicProfileEvidence) }),
  };
  if (projections) {
    // Keep accounting and detail projections while dropping the former Work inputs.
    replacement[usagePageProjections] = { ...projections,
      work: { inputs: {}, value: { work, summary: workSummary, profileLenses: [] } },
      mergedOutcomes: { inputs: {}, value: replacement.mergedOutcomes } };
  }
  return { source, slice: replacement };
}

/** Quota-only demand uses the same admitted B snapshots and result identity, without touching A or private evidence. */
export function resolveUsageQuotaPageAggregation(input: Pick<UsagePageAggregationInput, 'queries' | 'quota' | 'quotaByQuery' | 'pools' | 'sources' | 'previous' | 'nowMs'>): UsageQueryBatchResult {
  const poolsByQuery = new Map(input.pools?.map(snapshot => [getUsageQueryKey(snapshot.query), snapshot.value]));
  const queries = new Map(input.queries.map(candidate => {
    const query = normalizeUsageQuery(candidate);
    if (query.includeAccounting) throw new Error('Quota-only projection requires quota-only demand');
    return [getUsageQueryKey(query), query] as const;
  }));
  const results = [...queries].map(([key, query]): UsageQueryResultSlice => {
    const quota = resolveUsageQuotaSourceSnapshot(input, query);
    const { sources: quotaSources, ...quotaFields } = projectUsageQuotaFields(query, quota, poolsByQuery.get(key),
      input.previous?.results.find(slice => slice.key === key)?.pools);
    const sources: UsageQuerySourceState[] = [
      { source: 'accounting', status: 'unsupported' },
      { source: 'work', status: 'not_loaded' },
      { source: 'how_you_work', status: 'not_loaded' },
      ...quotaSources,
      ...(!input.quotaByQuery && !quota?.sources ? input.sources ?? [] : [])
        .filter(source => query.includeQuota !== false && source.source.startsWith('quota:')),
    ];
    return { key, requestedQuery: query, shownQuery: query,
      ...quotaFields,
      sources, pending: sources.some(source => (source.source === 'quota' || source.source.startsWith('quota:') || source.source.startsWith('selection:'))
        && (source.status === 'pending' || source.status === 'not_loaded')) };
  });
  return retainUsageQueryResultReferences({ v: 1, results }, input.previous);
}

export function resolveUsagePageAggregation(input: UsagePageAggregationInput, fallbackCatalog: UsageModelPriceCatalog): UsageQueryBatchResult {
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
  const pricingReuseFor = createUsagePricingReuseResolver();
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
    const projected = projectUsageAccountingSnapshotPrices(snapshot, pricingOverrides, fallbackCatalog, accounting.values(), undefined,
      () => snapshot.value ? pricingReuseFor(snapshot.value, pricingOverrides, snapshot.query.costBasis) : undefined);
    const key = getUsageQueryKey(projected.query);
    if (accounting.get(key)?.value === projected.value) accounting.set(key, projected);
    return projected.priceProjection ? { ...projected, value: projected.priceProjection.value } : projected;
  };
  const work = new Map(input.work?.map(snapshot => [getUsageQueryKey(snapshot.query), snapshot]));
  const howYouWork = new Map(input.howYouWork?.map(snapshot => [getUsageQueryKey(snapshot.query), snapshot]));
  const poolsByQuery = new Map(input.pools?.map(snapshot => [getUsageQueryKey(snapshot.query), snapshot.value]));
  const previous = new Map(input.previous?.results.map(slice => [slice.key, slice]));
  const projectionPrevious = new Map((input.projectionPrevious ?? input.previous)?.results.map(slice => [slice.key, slice]));
  const results = [...queries].map(([key, query]) => {
    if (!query.includeAccounting) return resolveUsageQuotaPageAggregation({ ...input, queries: [query] }).results[0]!;
    const observed = accounting.get(key);
    const prior = previous.get(key);
    const admitted = (projectionPrevious.get(key) as ProjectedUsageSlice | undefined)?.[usagePageProjections];
    const pools = poolsByQuery.get(key);
    const quota = resolveUsageQuotaSourceSnapshot(input, query);
    const { sources: quotaSources, ...quotaFields } = projectUsageQuotaFields(query, quota, pools, prior?.pools);
    const sourceStates = (input.sources ?? []).filter(source => !source.source.startsWith('quota:')
      || query.includeQuota !== false && !input.quotaByQuery && !quota?.sources);
    const priorAccountingSource = prior?.accounting ? prior.sources.find(source => source.source === 'accounting') : undefined;
    const snapshot = projectPrices(retainAccountingOnReadFailure(observed, prior?.accounting,
      priorAccountingSource?.asOfMs, prior && readUsageAccountingReadAtMs(prior)));
    const readPeriod = observed?.period ?? (input.nowMs !== undefined ? resolveUsageQueryPeriod(query, input.nowMs)
      : 'relative' in query.period ? snapshot?.value?.coverage?.range ?? query.period : query.period);
    // A failed refresh retains the prior accounting window as well as its
    // values; it cannot compare those values against a later requested range.
    const period = 'relative' in query.period ? readBoundedAccountingPeriod(snapshot?.value) ?? readPeriod : readPeriod;
    const workSnapshot = work.get(key);
    const detailSnapshot = howYouWork.get(key);
    const detailProgress = input.howYouWorkProgress?.get(key);
    const initialDetailSource = sourceStates.find(source => source.source === 'how_you_work');
    const detailAuthorized = canRetainUsageReadFailure(detailSnapshot?.errorCode);
    const readDetail = detailAuthorized ? detailSnapshot?.detail : undefined;
    const priorDetail = admitted?.howYouWork.inputs.detail as UsageHowYouWorkDetailInput | undefined;
    // Reconcile the complete admitted detail, including its wrapper. Source
    // phases rebuild equal arrays; retaining only facts still re-runs every
    // downstream detail reducer for those unchanged publications.
    const observedDetail = readDetail && priorDetail ? retainUsageMembers(readDetail, priorDetail) : readDetail;
    const pendingDetail = !detailSnapshot && (detailProgress?.pending ?? initialDetailSource?.status === 'pending');
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
    const priorWorkSource = prior?.sources.find(source => source.source === 'work');
    // Missing evidence on an ordinary failed read is not a replacement. An
    // explicit empty admission/quarantine still withdraws the old witnesses.
    const failedWork = workSnapshot?.status === 'error' && workSnapshot.evidence === undefined
      && workSnapshot.branchEvidence === undefined && canRetainUsageReadFailure(workSnapshot.errorCode)
      && (prior?.workSummary !== undefined || prior?.mergedOutcomes !== undefined
        || prior?.publicProfileEvidence?.facts.mergedPrs !== undefined
        || prior?.work !== undefined && (priorWorkSource?.status === 'available'
          || priorWorkSource?.status === 'partial' || priorWorkSource?.status === 'stale'));
    const pendingWork = workSnapshot?.status === 'pending';
    const pendingWorkRetention = pendingWork ? workSnapshot.retainWorkSessionIds : undefined;
    const progressingWork = pendingWorkRetention !== undefined;
    const retainWork = pendingWork || failedWork;
    // Only a readable answer can lend its date to a replacement. Pending and
    // stale dates already came from a readable answer through this projection.
    const priorWorkReadable = retainWork && (priorWorkSource?.status === 'available'
      || priorWorkSource?.status === 'pending' || priorWorkSource?.status === 'stale'
      || priorWorkSource?.status === 'partial' && (prior?.workSummary?.pullRequestsRead === true
        || (prior?.work?.outcomes.length ?? 0) > 0 || (prior?.work?.branches.length ?? 0) > 0
        || prior?.work?.allocations.some(row => row.evidence.length > 0)
        || prior?.work?.branchAllocations.some(row => row.evidence.length > 0)));
    const workAsOfMs = retainWork ? (priorWorkReadable ? priorWorkSource?.asOfMs : undefined) : workSnapshot?.asOfMs;
    // The pending snapshot can lend the old links and date, never its old unread counts.
    const unreadWorkSessions = workSnapshot?.unreadSessions;
    // Accounting admits the Work turns. With no turns to read, an equal
    // unknown answer stays admitted until accounting supplies new membership.
    const awaitingWorkMembership = pendingWork && priorWorkSource?.status === 'unknown'
      && priorWorkSource.errorCode === undefined && priorWorkSource.unreadSessions === undefined
      && snapshot?.value !== undefined && !readUsageWorkSessionTurns(snapshot.value)?.length;
    // A pending reread carries readable witnesses and their date, while its
    // status describes the replacement. An identical settled failure can reuse its state.
    const workSource: UsageQuerySourceState = awaitingWorkMembership || priorWorkSource?.errorCode === 'work_evidence_failed'
      && failedWork && priorWorkSource.status === 'stale'
      && workSnapshot.errorCode === priorWorkSource.errorCode
      && workSnapshot.updateRequired === priorWorkSource.updateRequired
      && sameStrictJsonValue(unreadWorkSessions ?? null, priorWorkSource.unreadSessions ?? null) ? priorWorkSource
      : { source: 'work', status: failedWork ? 'stale' : workSnapshot?.status ?? 'not_loaded',
        ...(workAsOfMs === undefined ? {} : { asOfMs: workAsOfMs }),
        ...(workSnapshot?.errorCode === undefined ? {} : { errorCode: workSnapshot.errorCode }),
        ...(unreadWorkSessions === undefined ? {} : { unreadSessions: unreadWorkSessions }),
        ...(workSnapshot?.updateRequired === undefined ? {} : { updateRequired: workSnapshot.updateRequired }) };
    // Retained evidence remains attached to this exact query while its owner
    // rereads it. Allocation always recomputes over the current contributions;
    // a terminal refusal below removes that previously admitted evidence.
    const retainedWork = retainWork ? prior?.work : undefined;
    const currentWork = workSnapshot?.status === 'available' || workSnapshot?.status === 'partial';
    const readableWork = currentWork || progressingWork || workSnapshot?.status === 'stale';
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
    const sessionCoverage = detailAuthorized ? detailSnapshot?.sessionCoverage : undefined;
    const calendarStartMs = endMs === undefined ? undefined
      : resolveUsageQueryPeriod(query, endMs).startMs === undefined ? undefined : startMs;
    const priorDetailPeriod = admitted?.howYouWork.period;
    const detailPeriod = endMs === undefined || endMs < startMs ? undefined
      : priorDetailPeriod?.startMs === startMs && priorDetailPeriod.endMs === endMs ? priorDetailPeriod : { startMs, endMs };
    const projectedDetailFacts = projectAdmittedUsageInputs(admitted?.howYouWork, {
      accounting: snapshot?.value, detail: observedDetail, calendar: calendar.value, startMs, endMs, calendarStartMs,
      selectedSessions: sessionCoverage?.selected, admittedSessions: sessionCoverage?.admitted, unreadSessions: sessionCoverage?.notRead,
      // The resolver uses this clock only to select today's calendar day.
      todayStartMs: detailNowMs === undefined ? undefined
        : resolveUsageBucketBounds('day', detailNowMs, query.timeZoneOffsetMinutes).bucketStartMs,
      nightStartHour: nightHours?.startHour, nightEndHour: nightHours?.endHour,
      retaining: retainedHowYouWork !== undefined,
      retained: retainedHowYouWork === admitted?.howYouWork.value && admitted?.howYouWork.inputs.retaining
        ? admitted.howYouWork.inputs.retained : retainedHowYouWork,
    }, () => !detailPeriod ? undefined : retainUsageHowYouWorkReferences(resolveUsageHowYouWork({
      period: detailPeriod, timeZoneOffsetMinutes: query.timeZoneOffsetMinutes,
      accounting: snapshot?.value, detail: observedDetail,
      accountingCalendar: calendar.value,
      calendarPeriod: { startMs: calendarStartMs, endMs: detailPeriod.endMs },
      includeSteering: query.includeTranscriptEvidence,
      includeAgentCalendar: query.includeActivity || query.includeModelTimeline,
      costMode: query.costBasis,
      sessionCoverage,
      retained: retainedHowYouWork,
      nowMs: detailNowMs, nightHours,
    }), admitted?.howYouWork.value));
    const detailFacts: UsagePageProjections['howYouWork'] = projectedDetailFacts === admitted?.howYouWork
      ? projectedDetailFacts : { ...projectedDetailFacts, period: detailPeriod };
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
      if (!query.includeSessionEvidence || query.includeCoach === false) return undefined;
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
      }, fallbackCatalog);
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
    // For rolling queries, only published coverage or Coach evidence identifies
    // the current window, including while prior accounting is retained.
    const comparisonPeriod = 'relative' in query.period
      ? readWitnessedUsageComparisonPeriod(snapshot?.value, coachFacts.value?.period)
      : period;
    const comparisonQuery = resolveUsageComparisonQuery(query, comparisonPeriod);
    const previousComparison = comparisonQuery && prior?.comparison
      && getUsageQueryKey(prior.comparison.query) === getUsageQueryKey(comparisonQuery) ? prior.comparison : undefined;
    const comparisonSnapshot = comparisonQuery ? projectPrices(retainAccountingOnReadFailure(accounting.get(getUsageQueryKey(comparisonQuery)),
      previousComparison?.accounting, previousComparison?.source.asOfMs)) : undefined;
    const comparisonSource = projectUsageAccountingReadState('comparison', comparisonSnapshot,
      previousComparison?.accounting ? previousComparison.source : undefined);
    // The accounting-only envelope is not a private observation. Copy this
    // metadata only when the retained private detail was actually projected.
    const retainedPrivateDetail = detailProjection && detailProjection.detailStatus !== 'unknown' ? retainedDetail : undefined;
    const priorDetailSource = retainedPrivateDetail?.sources.find(source => source.source === 'how_you_work');
    const detailSourceStatus: UsageQuerySourceState['status'] = detailProgress?.pending ? 'pending'
      : !detailSnapshot?.errorCode ? detailProjection?.detailStatus ?? 'unknown'
        : detailAuthorized && (retainedDetail?.howYouWork || retainedDetail?.publicProfileEvidence || observedDetail && observedDetail.status !== 'unknown') ? 'stale' : 'error';
    const detailAsOfMs = detailSnapshot?.asOfMs ?? priorDetailSource?.asOfMs;
    const detailErrorCode = detailSnapshot?.errorCode ?? priorDetailSource?.errorCode;
    const detailUpdateRequired = detailSnapshot?.updateRequired ?? priorDetailSource?.updateRequired;
    const detailSource: UsageQuerySourceState | undefined = !query.includeSessionEvidence ? { source: 'how_you_work', status: 'not_loaded' }
      : detailSnapshot || detailProgress ? {
        source: 'how_you_work', status: detailSourceStatus,
        ...(detailErrorCode === undefined ? {} : { errorCode: detailErrorCode }),
        ...(detailUpdateRequired === undefined ? {} : { updateRequired: detailUpdateRequired }),
        ...(detailAsOfMs === undefined ? {} : { asOfMs: detailAsOfMs }),
      } : initialDetailSource && { ...priorDetailSource, ...initialDetailSource };
    const currentDetailPhases = query.includeSessionEvidence
      ? detailProgress?.sources ?? sourceStates.filter(isUsageDetailPhase) : [];
    // Retained Activity carries its own phases. Coach preferences report the
    // current acquisition, independently of whether Activity could be read.
    const detailPhases = !query.includeSessionEvidence ? [] : retainedPrivateDetail
      ? [
        ...retainedPrivateDetail.sources.filter(source => isUsageDetailPhase(source) && source.source !== USAGE_COACH_PREFERENCES_READ_SOURCE),
        ...currentDetailPhases.filter(source => source.source === USAGE_COACH_PREFERENCES_READ_SOURCE),
      ]
      : currentDetailPhases;
    const sources: UsageQuerySourceState[] = [
      projectUsageAccountingReadState('accounting', snapshot, priorAccountingSource),
      ...projectUsageAccountingSourceStates(snapshot?.value),
      ...quotaSources,
      workSource,
      ...sourceStates.filter(source => source.source !== 'how_you_work' && !isUsageDetailPhase(source)),
      ...(detailSource ? [detailSource] : []),
      ...detailPhases,
    ];
    // Inputs are admitted owner snapshots; this projection is not a wire boundary.
    // Parsing here clones the same full history for every widget on every source
    // revision. Keep its identity and validate the batch at the Action/Resource boundary.
    const accountingValue = snapshot?.value;
    const workEvidence = readableWork ? workSnapshot?.evidence : undefined;
    const branchEvidence = readableWork ? workSnapshot?.branchEvidence : undefined;
    // Retained links are witnesses, but only this read establishes PR coverage.
    const readSessions = currentWork ? workSnapshot.pullRequestReadSessions : undefined;
    const workFacts = projectAdmittedUsageInputs(admitted?.work, {
      accounting: accountingValue, evidence: workEvidence, branchEvidence, readSessions,
      readable: readableWork, retaining: retainWork, pendingRetention: pendingWorkRetention,
      retained: retainedWork === admitted?.work.value.work && admitted?.work.inputs.retaining ? admitted.work.inputs.retained : retainedWork,
    }, (): UsageWorkReadProjection => {
      const retainSessions = pendingWorkRetention && new Set(pendingWorkRetention);
      const retainedEvidence = retainedWork?.allocations.flatMap(row => row.evidence) ?? [];
      const retainedBranches = retainedWork?.branchAllocations.flatMap(row => row.evidence) ?? [];
      const work = !query.includeWorkEvidence || accountingValue?.contributions === undefined ? undefined : allocateUsageOutcomes({
        contributions: accountingValue.contributions,
        evidence: retainSessions ? [...retainedEvidence.filter(row => retainSessions.has(row.sessionId)), ...(workEvidence ?? [])]
          : retainWork ? retainedEvidence : workEvidence ?? [],
        branchEvidence: retainSessions ? [...retainedBranches.filter(row => retainSessions.has(row.sessionId)), ...(branchEvidence ?? [])]
          : retainWork ? retainedBranches : branchEvidence ?? [],
      });
      const admittedTurns = readableWork && query.includeWorkEvidence ? readUsageWorkSessionTurns(accountingValue) : undefined;
      const pullRequestsRead = hasUsagePullRequestRead(admittedTurns, readSessions);
      const summary = work && accountingValue?.contributions && (readableWork || retainWork)
        ? projectUsageWorkSummary(work.outcomes, pullRequestsRead, { work, contributions: accountingValue.contributions })
        : admittedTurns ? projectUsageWorkSummary(resolveUsageWorkOutcomeAdmissions({ turns: admittedTurns, evidence: workEvidence ?? [] }).outcomes,
          pullRequestsRead) : undefined;
      const profileLenses = query.population === 'public_eligible_personal' && query.includeWorkEvidence && accountingValue
        && (workEvidence !== undefined || readSessions !== undefined)
        ? projectUsagePublicWorkLenses(accountingValue, workEvidence ?? [], readSessions) : [];
      return { work, summary, profileLenses };
    });
    const { work: workProjection, summary: workSummary, profileLenses } = workFacts.value;
    const pullRequestsRead = workSummary?.pullRequestsRead === true;
    const workContributions = workProjection ? accountingValue?.contributions : undefined;
    const mergedFacts = projectAdmittedUsageInputs(admitted?.mergedOutcomes, {
      work: workProjection, contributions: workContributions, startMs, endMs, pullRequestsRead,
    }, () => {
      if (!workProjection || !workContributions || endMs === undefined || endMs < startMs) return undefined;
      const evidence = summarizeUsageMergedOutcomes({ work: workProjection, contributions: workContributions, period: { startMs, endMs },
        timeZoneOffsetMinutes: query.timeZoneOffsetMinutes, pullRequestsRead });
      return pullRequestsRead || evidence.linkedMergedCount > 0 ? evidence : undefined;
    });
    const retainedProfile = retainedDetail?.publicProfileEvidence
      ? retainPublicProfileDetail(retainedDetail.publicProfileEvidence) : undefined;
    const publicProfileEvidence = profileLenses.length ? {
      ...retainedProfile, facts: { ...retainedProfile?.facts, ...(workSummary?.mergedPrCount === undefined ? {} : { mergedPrs: workSummary.mergedPrCount }) },
      fieldCoverage: retainedProfile?.fieldCoverage ?? {},
      lenses: profileLenses.map(lens => {
        const previous = retainedProfile?.lenses.find(row => row.execution === lens.execution);
        return { ...previous, ...lens, facts: { ...previous?.facts, ...lens.facts } };
      }),
    } : retainedProfile;
    const planInsights = projectAdmittedUsageInputs(admitted?.planInsights, {
      accounting: snapshot?.value, asOfMs: snapshot?.asOfMs, startMs: period.startMs, endMs: period.endMs,
      howYouWork: detailProjection, nowMs: input.nowMs,
      quota: query.includeQuota !== false && quota?.value && ['available', 'partial', 'stale'].includes(quota.status) ? quota.value : undefined,
    }, () => projectUsagePlanInsights({ query: { ...query, period }, nowMs: input.nowMs, accounting: snapshot?.value, accountingAsOfMs: snapshot?.asOfMs,
      howYouWork: detailProjection,
      quota: query.includeQuota !== false && quota?.value && ['available', 'partial', 'stale'].includes(quota.status) ? quota.value : undefined }));
    const costFactTotals = projectAdmittedUsageInputs(admitted?.costFactTotals, { facts: snapshot?.value?.costFacts, available: snapshot?.value !== undefined },
      () => snapshot?.value === undefined ? undefined : projectUsageCostFactTotals(snapshot.value.costFacts ?? []));
    const comparisonCostFactTotals = projectAdmittedUsageInputs(admitted?.comparisonCostFactTotals, { facts: comparisonSnapshot?.value?.costFacts,
      available: comparisonSnapshot?.value !== undefined },
      () => comparisonSnapshot?.value === undefined ? undefined : projectUsageCostFactTotals(comparisonSnapshot.value.costFacts ?? []));
    const projections: UsagePageProjections = { accountingReadAtMs: snapshot?.readAtMs, calendar, howYouWork: detailFacts, coach: coachFacts, work: workFacts, mergedOutcomes: mergedFacts,
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
      ...(publicProfileEvidence === undefined ? {} : { publicProfileEvidence }),
      ...(mergedFacts.value === undefined ? {} : { mergedOutcomes: mergedFacts.value }),
      sources,
      // Qualified phases describe the observations behind the base source,
      // whose own status owns whether this query is still reading.
      pending: sources.some(source => !isUsageDetailPhase(source) && isUsageQuerySourceOutstanding(query, source))
        || (comparisonQuery !== null && isUsageQuerySourceOutstanding(query, comparisonSource)),
    };
    return slice;
  });
  return retainUsageQueryResultReferences({ v: 1, results }, input.projectionPrevious ?? input.previous);
}
