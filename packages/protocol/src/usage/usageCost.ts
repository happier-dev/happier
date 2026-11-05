import type { UsageAnalyticsContribution, UsageAnalyticsQueryRequest, UsageAnalyticsQueryResponse, UsageObservationCost, UsageObservationTokens } from './usageAnalyticsContracts.js';
import { bundledUsageModelPriceCatalog, resolveUsageModelPrice, type ResolvedUsageModelPrice, type UsageModelPriceCatalog, type UsageModelPriceOverridesV1 } from './usageModelPriceCatalog.js';
import { resolveUsageTokenCategories } from './usageTokenCategories.js';
import { createUsageSourceCostFacts } from './usageCostFactTotals.js';
import { reprojectUsageLeadersSteps, usageTimelinePartitionKey, type UsageAnalyticsPricingPartitions } from './usageLeaderProjection.js';
import { usageCostAggregationBasis } from './usageAggregation.js';
import { addUsageMoney, subtractUsageMoney, multiplyUsageMoney, divideUsageMoneyByMillion, usageMoneyFromNumber,
  usageMoneyToNumber, readUsageMoney, serializeUsageMoneyProvenance, withUsageMoney, type ExactUsageMoney } from './usageMoney.js';

import { resolveUsageCostBasis, resolveUsageCostFacts, readUsagePageCostProjectionBasis, usagePageCostProjectionBasis, type UsageCostMode } from './usageCostFacts.js';
import { hasCompleteUsageCostEvidence, repriceUsageAnalyticsCoverage } from './usageAnalyticsDemandProjection.js';
export { hasCompleteUsageCostEvidence, repriceUsageAnalyticsCoverage } from './usageAnalyticsDemandProjection.js';
import { sameStrictJsonValue } from '../json/strictJsonValue.js';
import { repriceUsageAnalyticsSummary } from './usageSummary.js';
import { createUsagePricedPartitionBuilder, resolveUsagePricingPopulationStates } from './usagePricingPopulation.js';
export { projectUsageAnalyticsSummary, projectUsageAnalyticsSummarySteps } from './usageSummary.js';
export { collectUsageAnalyticsBatchDelivery, projectUsageAnalyticsBatchDelivery, readUsageContributionProjection,
    encodeUsageAnalyticsBatchDelivery, readUsageContributionEncoding,
    type UsageContributionProjection } from './usageAnalyticsBatchDelivery.js';
export * from './usageCostFacts.js';

/** Standard catalog USD tariff over nonoverlapping token categories, never an invoice. */
export interface UsageModelCostEstimate {
  total: number;
  input: number;
  output: number;
  estimatedUsd: number;
  price: ResolvedUsageModelPrice;
  breakdown?: Readonly<{ cacheSavingsUsd: number }>;
}

export function estimateUsageModelCost(modelId: string | null | undefined, categories: UsageObservationTokens | null,
  catalog: UsageModelPriceCatalog = bundledUsageModelPriceCatalog, overrides: UsageModelPriceOverridesV1 = {}): UsageModelCostEstimate | null {
  return estimateResolvedUsageModelCost(resolveUsageModelPrice(modelId, catalog, overrides), categories);
}

/** One projection resolves each model and calculates each distinct exact token operand once. */
export function createUsageModelCostEstimator(catalog: UsageModelPriceCatalog, overrides: UsageModelPriceOverridesV1 = {}) {
  const prices = new Map<string | null | undefined, { price: ResolvedUsageModelPrice | null; operands?: UsageModelCostOperands;
    estimates: Map<string, UsageModelCostEstimate | null> }>();
  return (modelId: string | null | undefined, categories: UsageObservationTokens | null): UsageModelCostEstimate | null => {
    if (!prices.has(modelId)) {
      const price = resolveUsageModelPrice(modelId, catalog, overrides);
      prices.set(modelId, { price, ...(price ? { operands: admitUsageModelCostOperands(price) } : {}), estimates: new Map() });
    }
    const resolved = prices.get(modelId)!;
    if (!resolved.price || !categories) return null;
    // Public token numbers alone can hide admitted decimal precision. Include
    // its witnessed sidecar; the memo lives only for this projection's catalog.
    const key = JSON.stringify([categories.input, categories.output, categories.reasoning,
      categories.cacheRead, categories.cacheWrite, serializeUsageMoneyProvenance(categories)]);
    if (!resolved.estimates.has(key)) resolved.estimates.set(key,
      estimateResolvedUsageModelCost(resolved.price, categories, resolved.operands));
    return resolved.estimates.get(key)!;
  };
}

type UsageModelCostOperands = Readonly<Record<'input' | 'output' | 'reasoning' | 'cacheRead' | 'cacheWrite' | 'cacheSavings', ExactUsageMoney>>;
function admitUsageModelCostOperands({ rates }: ResolvedUsageModelPrice): UsageModelCostOperands {
  const input = usageMoneyFromNumber(rates.inputUsdPerMillion);
  const output = usageMoneyFromNumber(rates.outputUsdPerMillion);
  return { input, output, reasoning: rates.reasoningUsdPerMillion === undefined ? output : usageMoneyFromNumber(rates.reasoningUsdPerMillion),
    cacheRead: usageMoneyFromNumber(rates.cacheReadUsdPerMillion ?? 0), cacheWrite: usageMoneyFromNumber(rates.cacheWriteUsdPerMillion ?? 0),
    cacheSavings: subtractUsageMoney(input, rates.cacheReadUsdPerMillion === undefined ? input : usageMoneyFromNumber(rates.cacheReadUsdPerMillion)) };
}

function estimateResolvedUsageModelCost(price: ResolvedUsageModelPrice | null, categories: UsageObservationTokens | null,
  admitted?: UsageModelCostOperands): UsageModelCostEstimate | null {
  if (!price || !categories) return null;
  const { rates } = price;
  if (categories.cacheRead > 0 && rates.cacheReadUsdPerMillion === undefined
    || categories.cacheWrite > 0 && rates.cacheWriteUsdPerMillion === undefined) return null;
  const operands = admitted ?? admitUsageModelCostOperands(price);
  const component = (field: Exclude<keyof UsageObservationTokens, 'total'>) => multiplyUsageMoney(
    readUsageMoney(categories, field, categories[field]), operands[field]);
  const inputMoney = divideUsageMoneyByMillion(addUsageMoney(addUsageMoney(component('input'), component('cacheRead')), component('cacheWrite')));
  const outputMoney = divideUsageMoneyByMillion(addUsageMoney(component('output'), component('reasoning')));
  const totalMoney = addUsageMoney(inputMoney, outputMoney);
  const input = usageMoneyToNumber(inputMoney);
  const output = usageMoneyToNumber(outputMoney);
  const total = usageMoneyToNumber(totalMoney);
  if (!Number.isFinite(total)) return null;
  const cacheSavings = divideUsageMoneyByMillion(multiplyUsageMoney(readUsageMoney(categories, 'cacheRead', categories.cacheRead),
    operands.cacheSavings));
  return withUsageMoney({ total, input, output, estimatedUsd: total, price,
    ...(cacheSavings.units > 0n ? { breakdown: withUsageMoney({ cacheSavingsUsd: usageMoneyToNumber(cacheSavings) },
      { cacheSavingsUsd: cacheSavings }) } : {}) },
    { total: totalMoney, input: inputMoney, output: outputMoney, estimatedUsd: totalMoney });
}

/** Query-only price projection. Original reported/invoice/legacy estimate fields are immutable inputs. */
export function repriceUsageObservationCost(rawCost: UsageObservationCost, modelId: string | null | undefined,
  categories: UsageObservationTokens | null, catalog: UsageModelPriceCatalog = bundledUsageModelPriceCatalog,
  overrides: UsageModelPriceOverridesV1 = {}, mode: UsageCostMode = 'auto'): UsageObservationCost {
  return priceUsageObservation(rawCost, modelId, categories, catalog, overrides, mode).cost;
}

/** Selected money and cache savings consume the same tariff calculation. */
export function priceUsageObservation(rawCost: UsageObservationCost, modelId: string | null | undefined,
  categories: UsageObservationTokens | null, catalog: UsageModelPriceCatalog,
  overrides: UsageModelPriceOverridesV1, mode: UsageCostMode,
  estimate: UsageModelCostEstimate | null = estimateUsageModelCost(modelId, categories, catalog, overrides),
): { cost: UsageObservationCost; estimate: UsageModelCostEstimate | null } {
  const { apiEquivalentUsd: _old, pricingSource: _source, effectiveUsd: _effective, selectedBasis: _selectedBasis, ...observed } = rawCost;
  // Admit each raw decimal once before the same cost fans out to rankings,
  // calendars and compact pricing groups. Numeric replacements still invalidate
  // provenance through readUsageMoney's existing public-value witness.
  const breakdown = observed.breakdown ? withUsageMoney(observed.breakdown, Object.fromEntries(
    Object.entries(observed.breakdown).map(([field, amount]) => [field, readUsageMoney(observed.breakdown!, field, amount)]))) : undefined;
  const money = Object.fromEntries((['reportedUsd', 'estimatedUsd', 'invoiceUsd'] as const)
    .map(field => [field, readUsageMoney(observed, field, observed[field] ?? 0)]));
  const projected: UsageObservationCost = observed;
  if (breakdown) projected.breakdown = breakdown;
  const source = estimate ? estimate.price.source === 'catalog' ? `litellm:${catalog.provenance.revision}`
    : `user:${estimate.price.source}:${modelId}` : undefined;
  // A money-only observation adds no token-tariff population. Its unknown model
  // must not make otherwise fully priced tokens incomplete.
  const noTokens = categories !== null && Object.values(categories).every(value => value === 0);
  const apiMoney = estimate ? readUsageMoney(estimate, 'total', estimate.total) : noTokens ? usageMoneyFromNumber(0) : undefined;
  // This rest object is owned by this call. Build its monetary fields before
  // publishing provenance, rather than copying a JSON-shaped cost per phase.
  if (apiMoney) {
    projected.apiEquivalentUsd = usageMoneyToNumber(apiMoney);
    projected.pricingSource = estimate ? source : 'no_tokens';
    money.apiEquivalentUsd = apiMoney;
  }
  const priced = withUsageMoney(projected, money);
  const selected = resolveUsageCostBasis(priced, mode);
  if (!selected) return { estimate, cost: priced };
  priced.effectiveUsd = selected.amountUsd;
  return { estimate, cost: withUsageMoney(priced,
    { effectiveUsd: readUsageMoney(selected, 'amountUsd', selected.amountUsd) }) };
}

/** Recompute history from the admitted contribution projection, retaining the original money facts. */
export function repriceUsageAnalyticsResponse(value: UsageAnalyticsQueryResponse, catalog: UsageModelPriceCatalog = value.priceCatalog ?? bundledUsageModelPriceCatalog,
  overrides: UsageModelPriceOverridesV1 = {}, mode: UsageCostMode = 'auto',
  rankingDemand?: Pick<UsageAnalyticsQueryRequest, 'breakdowns' | 'includeLeaders' | 'topLimit'>): UsageAnalyticsQueryResponse {
  const steps = repriceUsageAnalyticsResponseSteps(value, catalog, overrides, mode, rankingDemand, () => false);
  let next = steps.next();
  while (!next.done) next = steps.next();
  return next.value;
}

/** The server services I/O between committed pricing operands; synchronous callers drain the same owner. */
export function* repriceUsageAnalyticsResponseSteps(value: UsageAnalyticsQueryResponse, catalog: UsageModelPriceCatalog = value.priceCatalog ?? bundledUsageModelPriceCatalog,
  overrides: UsageModelPriceOverridesV1 = {}, mode: UsageCostMode = 'auto',
  rankingDemand?: Pick<UsageAnalyticsQueryRequest, 'breakdowns' | 'includeLeaders' | 'topLimit'>,
  shouldYield: () => boolean = () => true): Generator<void, UsageAnalyticsQueryResponse, void> {
  const completed = readUsagePageCostProjectionBasis(value);
  if (!rankingDemand && completed?.mode === mode && completed.catalog === catalog && sameStrictJsonValue(completed.overrides, overrides)) return value;
  if (value.summary && !value.contributions) return repriceUsageAnalyticsSummary(value, catalog, overrides, mode);
  if (!value.contributions) return { ...value, priceCatalog: catalog };
  const facts = createUsageSourceCostFacts();
  let cacheSavings = usageMoneyFromNumber(0);
  let cacheSavingsComplete = true;
  const estimateCost = createUsageModelCostEstimator(catalog, overrides);
  const contributions: UsageAnalyticsContribution[] = [];
  for (const row of value.contributions) {
    const categories = row.tokenCategories ?? resolveUsageTokenCategories(row.tokens, null);
    const { estimate, cost } = priceUsageObservation(row.cost, row.modelId, categories, catalog, overrides, mode, estimateCost(row.modelId, categories));
    if (!estimate && row.tokens.cacheRead > 0) cacheSavingsComplete = false;
    cacheSavings = addUsageMoney(cacheSavings, readUsageMoney(estimate?.breakdown ?? {}, 'cacheSavingsUsd', estimate?.breakdown?.cacheSavingsUsd ?? 0));
    const existing = resolveUsageCostFacts(cost);
    const base = { tokens: row.tokens, eventCount: row.eventCount ?? 1, asOfMs: row.observedAtMs,
      complete: row.eventCount !== undefined && hasCompleteUsageCostEvidence(value) };
    for (const fact of existing) facts.add({ ...base, ...fact, currency: fact.kind === 'api_equivalent' ? 'USD' : fact.currency });
    if (!estimate && row.tokens.total > 0) facts.add({ ...base, kind: 'unpriced', currency: 'USD', amountUsd: null,
      source: categories ? 'model_price_unknown' : 'token_categories_unknown', complete: false });
    contributions.push({ ...row, cost });
    if (shouldYield()) yield;
  }
  const states = resolveUsagePricingPopulationStates(contributions);
  const buildPartition = createUsagePricedPartitionBuilder(mode, shouldYield).steps;
  const totalPartition = yield* buildPartition(contributions, states);
  const totalPopulation = totalPartition.population;
  const partitions: UsageAnalyticsPricingPartitions = { totals: totalPopulation, series: new Map(), ranked: new Map(), timelines: new Map() };
  const pricePartition = function* (rows: readonly UsageAnalyticsContribution[], queryScoped: boolean) {
    return rows.length === contributions.length ? totalPartition
      : yield* buildPartition(rows, queryScoped ? states : undefined);
  };
  const totalCost = totalPartition.cost;
  const projectCost = function* (raw: UsageObservationCost, rows: readonly UsageAnalyticsContribution[], range?: { bucketStartMs: number; bucketEndMs: number }): Generator<void, UsageObservationCost, void> {
    const part = yield* pricePartition(rows, range !== undefined);
    if (range) partitions.series.set(usageTimelinePartitionKey('series', range), part.population);
    const { apiEquivalentUsd: _old, pricingSource: _source, effectiveUsd: _effective, selectedBasis: _selected, ...observed } = raw;
    const allPriced = part.allPriced;
    const exactApi = part.api;
    const updated: UsageObservationCost = allPriced ? withUsageMoney({ ...observed,
      apiEquivalentUsd: usageMoneyToNumber(exactApi),
      pricingSource: rows.length ? part.pricingSource : `litellm:${catalog.provenance.revision}`,
    }, { apiEquivalentUsd: exactApi }) : observed;
    const aggregated = part.cost;
    const selected = resolveUsageCostBasis(aggregated, mode);
    const selectedCost = { ...updated, [usageCostAggregationBasis]: aggregated[usageCostAggregationBasis] };
    return selected ? withUsageMoney({ ...selectedCost, effectiveUsd: selected.amountUsd },
      { effectiveUsd: readUsageMoney(selected, 'amountUsd', selected.amountUsd) }) : selectedCost;
  };
  const ranking = yield* reprojectUsageLeadersSteps(value, contributions, mode, projectCost, rankingDemand, { partitions, price: pricePartition });
  const totals = { ...value.totals, cost: yield* projectCost(value.totals.cost, contributions) };
  const selected = resolveUsageCostBasis(totalCost, mode);
  const costPresentation = selected ? { mode, effectiveUsd: selected.amountUsd, currency: selected.currency, source: selected.source } : undefined;
  const groupedFacts = facts.values();
  const unknown = groupedFacts.some(fact => fact.kind === 'unpriced');
  const coverage = repriceUsageAnalyticsCoverage(value.coverage, ranking.coverage, unknown);
  let insights = value.insights;
  if (insights) {
    const { cacheSavingsUsd: _oldSavings, ...otherInsights } = insights;
    insights = { ...otherInsights, ...(cacheSavingsComplete ? { cacheSavingsUsd: usageMoneyToNumber(cacheSavings) } : {}) };
  }
  const response = { ...value, totals, contributions, costFacts: groupedFacts, priceCatalog: catalog, costPresentation, coverage, insights,
    series: ranking.series,
    breakdowns: ranking.breakdowns, leaders: ranking.leaders, modelTimeline: ranking.modelTimeline, engineTimeline: ranking.engineTimeline };
  Object.defineProperty(totals.cost, usagePageCostProjectionBasis, { value: { response, mode, catalog, overrides, partitions } });
  return response;
}
