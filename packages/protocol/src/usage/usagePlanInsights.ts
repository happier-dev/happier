import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import type { UsageQuery } from '../inputs/usageQuery.js';
import { ConnectedServiceQuotaGetResultV1Schema, type ConnectedServiceQuotaGetResultV1 } from '../connect/providerAccountUsageHistorySchemasV1.js';
import { projectProviderAccountSubscriptionMonetaryFacts } from '../connect/accountSubscription.js';
import { sameQualifiedConnectedAccountRef } from '../connect/qualifiedConnectedAccountPersistence.js';
import { deriveProviderAccountUsageHeadroom, resolveProviderAccountUsagePaceWindow } from '../connect/deriveProviderAccountUsagePace.js';
import { isConnectedServiceQuotaObservationFresh } from '../connect/quotaObservationTime.js';
import { getProviderAccountUsageQuotaPageFactsV1 } from '../connect/providerAccountUsagePageProjection.js';
import type { UsageAnalyticsQueryResponse } from './usageAnalyticsContracts.js';
import type { UsageHowYouWork } from './resolveUsageHowYouWork.js';
import { resolveUsageBucketBounds, resolveUsageCalendarDateStart } from './usageCalendar.js';
import { resolveUsageCostBasis, type UsageCostBasis } from './usageCostFacts.js';
import { addUsageMoney, readUsageMoney, usageMoneyFromNumber, usageMoneyToNumber } from './usageMoney.js';

const InsufficientSchema = lazyZodSchema(() => z.strictObject({ status: z.literal('insufficient_basis'), reason: z.string().check(z.minLength(1)) }));
const NonNegative = lazyZodSchema(() => z.number().check(z.nonnegative()));
const PriceMultipleSchema = lazyZodSchema(() => z.union([
  z.strictObject({ status: z.literal('available'), multiple: NonNegative,
    priceKind: z.enum(['entered', 'list', 'paid']), priceAmount: NonNegative, currency: z.literal('USD'),
    priceAsOfMs: z.number().check(z.int(), z.nonnegative()), priceSource: z.string().check(z.minLength(1)),
    period: z.strictObject({ startAtMs: z.number().check(z.int(), z.nonnegative()), endAtMs: z.number().check(z.int(), z.nonnegative()) }),
    method: z.literal('observed_api_equivalent_divided_by_period_price') }),
  InsufficientSchema,
]));
const AccountValueSchema = lazyZodSchema(() => z.union([
  z.strictObject({ status: z.literal('available'), kind: z.literal('api_equivalent'), amountUsd: NonNegative, currency: z.literal('USD'),
    period: z.strictObject({ startMs: z.optional(z.number().check(z.int(), z.nonnegative())), endMs: z.optional(z.number().check(z.int(), z.nonnegative())) }),
    coverage: z.enum(['complete', 'partial']), pricedContributionCount: z.number().check(z.int(), z.positive()),
    unpricedContributionCount: z.number().check(z.int(), z.nonnegative()), unknownAccountContributionCount: z.number().check(z.int(), z.nonnegative()),
    pricingSources: z.array(z.string().check(z.minLength(1))), priceMultiple: PriceMultipleSchema }),
  InsufficientSchema,
]));
const WindowSchema = lazyZodSchema(() => z.strictObject({ meterId: z.string().check(z.minLength(1)), label: z.string().check(z.minLength(1)), asOfMs: z.number().check(z.int(), z.nonnegative()) }));
const WeatherSchema = lazyZodSchema(() => z.union([
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.safeExtend(WindowSchema, { status: z.literal('available'), outlook: z.enum(['within_even_pace', 'ahead_of_even_pace']),
    projectedUsedFraction: NonNegative, sampleCount: z.number().check(z.int(), z.positive()), resetAtMs: z.number().check(z.int(), z.nonnegative()),
    method: z.literal('witnessed_linear_pace'), coverage: z.literal('observed_samples'), qualification: z.enum(['confirmed', 'estimated']) })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)((<A extends z.ZodMiniObject, B extends z.ZodMiniObject>(a: A, b: B) => z.core.util.merge(a, b) as z.ZodMiniObject<z.core.util.Extend<A['shape'], B['shape']>, B['_zod']['config']>)(WindowSchema, InsufficientSchema)),
]));
const ModelHeadroomSchema = lazyZodSchema(() => z.union([
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.safeExtend(WindowSchema, { status: z.literal('available'), modelId: z.string().check(z.minLength(1)), remainingFraction: z.number().check(z.minimum(0), z.maximum(1)),
    resetAtMs: z.number().check(z.int(), z.nonnegative()), method: z.literal('model_specific_quota_meter'), coverage: z.literal('current_meter'), qualification: z.enum(['confirmed', 'estimated']) })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.safeExtend((<A extends z.ZodMiniObject, B extends z.ZodMiniObject>(a: A, b: B) => z.core.util.merge(a, b) as z.ZodMiniObject<z.core.util.Extend<A['shape'], B['shape']>, B['_zod']['config']>)(WindowSchema, InsufficientSchema), { modelId: z.nullable(z.string().check(z.minLength(1))) })),
]));
const PricePerResetSchema = lazyZodSchema(() => z.union([
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.safeExtend(WindowSchema, { status: z.literal('available'), amount: NonNegative, currency: z.string().check(z.regex(/^[A-Z]{3}$/)),
    priceKind: z.enum(['entered', 'list', 'paid']), priceAmount: NonNegative, priceAsOfMs: z.number().check(z.int(), z.nonnegative()),
    priceSource: z.string().check(z.minLength(1)), period: z.strictObject({ startAtMs: z.number().check(z.int(), z.nonnegative()), endAtMs: z.number().check(z.int(), z.nonnegative()) }),
    recordedResetCount: z.number().check(z.int(), z.positive()), coverage: z.literal('recorded_subset'),
    method: z.literal('period_price_divided_by_recorded_resets') })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)((<A extends z.ZodMiniObject, B extends z.ZodMiniObject>(a: A, b: B) => z.core.util.merge(a, b) as z.ZodMiniObject<z.core.util.Extend<A['shape'], B['shape']>, B['_zod']['config']>)(WindowSchema, InsufficientSchema)),
]));
const RecordedWeekSchema = lazyZodSchema(() => z.union([
  z.strictObject({ status: z.literal('available'), startMs: z.number().check(z.int(), z.nonnegative()), endMs: z.number().check(z.int(), z.nonnegative()),
    timeZoneOffsetMinutes: z.number().check(z.int()), recordedActiveDays: z.number().check(z.int(), z.minimum(0), z.maximum(7)), recordedEvents: z.number().check(z.int(), z.nonnegative()),
    observedBusyMs: z.nullable(NonNegative), observedWaitMs: z.nullable(NonNegative), asOfMs: z.nullable(z.number().check(z.int(), z.nonnegative())),
    coverage: z.enum(['complete_recorded_history', 'partial']), accountingCoverage: z.enum(['complete', 'partial']),
    intervalCoverage: z.enum(['complete_for_supplied_facts', 'partial', 'unknown']), method: z.literal('recorded_calendar_week'), humanPresence: z.literal('unknown') }),
  InsufficientSchema,
]));

/** Read-only facts on the existing Usage result. Every envelope is closed; no input or authority is added. */
export const UsagePlanInsightsSchema = lazyZodSchema(() => z.strictObject({
  accounts: z.array(z.strictObject({ source: ConnectedServiceQuotaGetResultV1Schema.shape.source,
    value: AccountValueSchema, weather: z.array(WeatherSchema), pricePerReset: z.array(PricePerResetSchema), modelHeadroom: z.array(ModelHeadroomSchema) })),
  recordedWeek: RecordedWeekSchema,
}));
export type UsagePlanInsights = z.infer<typeof UsagePlanInsightsSchema>;

function accountValue(read: ConnectedServiceQuotaGetResultV1, input: Parameters<typeof projectUsagePlanInsights>[0],
  price: ReturnType<typeof projectProviderAccountSubscriptionMonetaryFacts> | null): UsagePlanInsights['accounts'][number]['value'] {
  const contributions = input.accounting?.contributions ?? [];
  const matched = contributions.filter(row => row.providerAttribution === 'known' && row.connectedAccount
    && sameQualifiedConnectedAccountRef(row.connectedAccount, read.source.ref));
  const compact = input.accounting?.contributions === undefined ? input.accounting?.summary?.accounts : undefined;
  const compactMatched = compact?.values.find(account => sameQualifiedConnectedAccountRef(account.ref, read.source.ref));
  const matchedCount = compactMatched?.contributionCount ?? matched.length;
  if (matchedCount === 0) return { status: 'insufficient_basis', reason: 'account_attribution_unavailable' };
  const unknownAccountContributionCount = compact?.unknownContributionCount ?? contributions.filter(row => row.providerAttribution !== 'known'
    || !row.connectedAccount && row.providerSource !== 'provider'
      && !(row.providerSource === 'native' && row.connectedAccount === null)).length;
  const priced = matched.map(row => resolveUsageCostBasis(row.cost, 'api_equivalent'))
    .filter((basis): basis is UsageCostBasis => basis?.kind === 'api_equivalent');
  const pricedCount = compactMatched?.pricedContributionCount ?? priced.length;
  if (pricedCount === 0) return { status: 'insufficient_basis', reason: 'account_usage_unpriced' };
  const amountUsd = compactMatched?.apiEquivalentUsd ?? usageMoneyToNumber(priced.reduce((sum, basis) =>
    addUsageMoney(sum, readUsageMoney(basis, 'amountUsd', basis.amountUsd)), usageMoneyFromNumber(0)));
  const selectedPrice = price?.entered ?? price?.paid ?? price?.list;
  const { startMs, endMs } = 'relative' in input.query.period
    ? input.accounting?.coverage?.range ?? {} : input.query.period;
  const priceMultiple: z.infer<typeof PriceMultipleSchema> = !selectedPrice
    ? { status: 'insufficient_basis', reason: 'period_price_unavailable' }
    : selectedPrice.currency !== 'USD' ? { status: 'insufficient_basis', reason: 'currency_mismatch' }
      : startMs === undefined || endMs === undefined || startMs < selectedPrice.period.startAtMs || endMs > selectedPrice.period.endAtMs
        ? { status: 'insufficient_basis', reason: 'period_mismatch' }
        : selectedPrice.amount === 0 ? { status: 'insufficient_basis', reason: 'zero_price' }
          : { status: 'available', multiple: amountUsd / selectedPrice.amount, priceKind: selectedPrice.kind,
            priceAmount: selectedPrice.amount, currency: 'USD', priceAsOfMs: selectedPrice.asOfMs,
            priceSource: `${selectedPrice.source.kind}:${selectedPrice.source.id}:${selectedPrice.source.version}`,
            period: selectedPrice.period, method: 'observed_api_equivalent_divided_by_period_price' };
  const unpricedContributionCount = matchedCount - pricedCount;
  return { status: 'available', kind: 'api_equivalent', amountUsd, currency: 'USD', period: { startMs, endMs },
    coverage: input.accounting?.coverage?.status === 'complete' && input.accounting.coverage.range.complete
      && unknownAccountContributionCount === 0 && unpricedContributionCount === 0 ? 'complete' : 'partial',
    pricedContributionCount: pricedCount, unpricedContributionCount, unknownAccountContributionCount,
    pricingSources: compactMatched?.pricingSources ?? [...new Set(priced.map(basis => basis.source))].sort(), priceMultiple };
}

function accountInsights(read: ConnectedServiceQuotaGetResultV1, input: Parameters<typeof projectUsagePlanInsights>[0]): UsagePlanInsights['accounts'][number] {
  const { nowMs } = input;
  const current = read.current;
  const fresh = current && nowMs !== undefined && current.state === 'loaded_data'
    && isConnectedServiceQuotaObservationFresh({ observedAtMs: current.observedAtMs, nowMs, maxAgeMs: current.staleAfterMs });
  const price = nowMs === undefined ? null : projectProviderAccountSubscriptionMonetaryFacts({ subscription: current?.subscription,
    nowMs, tier: current?.planLabel });
  const selectedPrice = price?.entered ?? price?.paid ?? price?.list;
  const weather: UsagePlanInsights['accounts'][number]['weather'] = [];
  const modelHeadroom: UsagePlanInsights['accounts'][number]['modelHeadroom'] = [];
  const pricePerReset: UsagePlanInsights['accounts'][number]['pricePerReset'] = [];
  const witnessedResets = getProviderAccountUsageQuotaPageFactsV1(read)?.witnessedResets ?? [];
  for (const meter of current?.meters ?? []) {
    const base = { meterId: meter.meterId, label: meter.label, asOfMs: current!.observedAtMs };
    const pace = read.pace.find(entry => entry.meterId === meter.meterId)?.value;
    const window = resolveProviderAccountUsagePaceWindow(current!, meter.meterId);
    const validPace = fresh && pace?.status === 'available' && window && window.resetAtMs === pace.window.resetAtMs
      && window.windowStartAtMs === pace.window.windowStartAtMs && nowMs! < window.resetAtMs;
    weather.push(validPace ? { ...base, status: 'available', outlook: pace.projectedResetUtilizationFraction > 1 ? 'ahead_of_even_pace' : 'within_even_pace',
      projectedUsedFraction: pace.projectedResetUtilizationFraction, sampleCount: pace.sampleCount, resetAtMs: window.resetAtMs,
      method: 'witnessed_linear_pace', coverage: 'observed_samples', qualification: pace.qualification }
      : { ...base, status: 'insufficient_basis', reason: !fresh ? 'stale' : pace?.status === 'unavailable' ? pace.reason : 'unknown_window' });
    const headroom = nowMs === undefined ? null : deriveProviderAccountUsageHeadroom({ snapshot: current!, meterId: meter.meterId, nowMs });
    modelHeadroom.push(!meter.modelId ? { ...base, modelId: null, status: 'insufficient_basis', reason: 'model_support_unavailable' }
      : headroom?.status === 'available' ? { ...base, modelId: meter.modelId, status: 'available', remainingFraction: headroom.remainingFraction,
        resetAtMs: headroom.window.resetAtMs, method: 'model_specific_quota_meter', coverage: 'current_meter', qualification: headroom.qualification }
        : { ...base, modelId: meter.modelId, status: 'insufficient_basis', reason: headroom?.reason ?? 'unknown_observation_time' });
    const resets = new Set<number>();
    if (selectedPrice && fresh && window) for (const ended of witnessedResets) {
      // Count only the adjacent actual cycles witnessed by B, not timestamp churn or inferred gap cycles.
      if (ended.meterId !== meter.meterId || ended.windowStartAtMs < selectedPrice.period.startAtMs
        || ended.resetAtMs > Math.min(nowMs!, selectedPrice.period.endAtMs)) continue;
      resets.add(ended.resetAtMs);
    }
    pricePerReset.push(selectedPrice && fresh && resets.size > 0 ? { ...base, status: 'available', amount: selectedPrice.amount / resets.size,
      currency: selectedPrice.currency, priceKind: selectedPrice.kind, priceAmount: selectedPrice.amount, priceAsOfMs: selectedPrice.asOfMs,
      priceSource: `${selectedPrice.source.kind}:${selectedPrice.source.id}:${selectedPrice.source.version}`,
      period: selectedPrice.period, recordedResetCount: resets.size, coverage: 'recorded_subset', method: 'period_price_divided_by_recorded_resets' }
      : { ...base, status: 'insufficient_basis', reason: !fresh ? 'stale' : !selectedPrice ? 'period_price_unavailable' : 'recorded_resets_unavailable' });
  }
  return { source: read.source, value: accountValue(read, input, price), weather, modelHeadroom, pricePerReset };
}

function recordedWeek(input: Parameters<typeof projectUsagePlanInsights>[0]): UsagePlanInsights['recordedWeek'] {
  const { startMs, endMs } = input.query.period;
  const week = startMs === undefined ? null : resolveUsageBucketBounds('week', startMs, input.query.timeZoneOffsetMinutes);
  if (!week || startMs !== week.bucketStartMs || endMs !== week.bucketEndMs) return { status: 'insufficient_basis', reason: 'whole_calendar_week_required' };
  if (input.nowMs === undefined || endMs > input.nowMs) return { status: 'insufficient_basis', reason: 'week_not_ended' };
  const days = input.accounting?.activity?.calendarDays;
  if (!days) return { status: 'insufficient_basis', reason: 'recorded_activity_unavailable' };
  const recorded = new Map<string, number>();
  for (const day of days) {
    const instant = resolveUsageCalendarDateStart(day.date, input.query.timeZoneOffsetMinutes);
    if (instant >= startMs && instant < endMs) recorded.set(day.date, day.eventCount);
  }
  const intervals = input.howYouWork?.intervals;
  const complete = input.accounting?.coverage?.range.complete === true && input.accounting.coverage.status === 'complete';
  return { status: 'available', startMs, endMs, timeZoneOffsetMinutes: input.query.timeZoneOffsetMinutes,
    recordedActiveDays: [...recorded.values()].filter(count => count > 0).length, recordedEvents: [...recorded.values()].reduce((sum, count) => sum + count, 0),
    observedBusyMs: intervals?.elapsedBusyMs ?? null, observedWaitMs: intervals?.elapsedWaitMs ?? null,
    asOfMs: input.accountingAsOfMs ?? null,
    coverage: complete && input.howYouWork?.detailStatus === 'available' && intervals?.coverage === 'complete_for_supplied_facts' ? 'complete_recorded_history' : 'partial',
    accountingCoverage: complete ? 'complete' : 'partial',
    intervalCoverage: input.howYouWork?.detailStatus === 'unknown' || !intervals ? 'unknown'
      : input.howYouWork.detailStatus === 'partial' ? 'partial' : intervals.coverage,
    method: 'recorded_calendar_week', humanPresence: 'unknown' };
}

/** Existing A/B/H composition only: no query, cache, inferred account link or model chooser. */
export function projectUsagePlanInsights(input: Readonly<{ query: UsageQuery; nowMs?: number; quota?: readonly ConnectedServiceQuotaGetResultV1[];
  accounting?: UsageAnalyticsQueryResponse; accountingAsOfMs?: number; howYouWork?: UsageHowYouWork }>): UsagePlanInsights {
  return { accounts: (input.quota ?? []).map(read => accountInsights(read, input)), recordedWeek: recordedWeek(input) };
}
