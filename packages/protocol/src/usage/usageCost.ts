import type { UsageAnalyticsContribution, UsageAnalyticsCostFact, UsageAnalyticsCostFactKind, UsageAnalyticsQueryRequest, UsageAnalyticsQueryResponse, UsageObservationCost, UsageObservationTokens } from './usageAnalyticsContracts.js';
import { bundledUsageModelPriceCatalog, resolveUsageModelPrice, type ResolvedUsageModelPrice, type UsageModelPriceCatalog, type UsageModelPriceOverridesV1 } from './usageModelPriceCatalog.js';
import { resolveUsageTokenCategories } from './usageTokenCategories.js';
import { projectUsageCostFactTotals } from './usageCostFactTotals.js';
import { reprojectUsageLeaders } from './usageLeaderProjection.js';

export type UsageCostMode = NonNullable<UsageAnalyticsQueryRequest['costMode']> | 'auto';
export interface UsageCostBasis {
  kind: Exclude<UsageAnalyticsCostFactKind, 'unpriced'>;
  currency: string;
  amountUsd: number;
  source: string;
}

export function resolveUsageCostMode(mode: UsageAnalyticsQueryRequest['costMode']): UsageCostMode {
  return mode ?? 'auto';
}

export function resolveUsageCostFactForMode<Fact extends { kind: UsageAnalyticsCostFactKind }>(facts: readonly Fact[], mode: UsageCostMode): Fact | undefined {
  if (mode === 'api_equivalent') return facts.find((fact) => fact.kind === 'api_equivalent');
  if (mode === 'reported') return facts.find((fact) => fact.kind === 'reported');
  if (mode === 'estimated') return facts.find((fact) => fact.kind === 'estimated');
  return facts.find((fact) => fact.kind === 'invoice')
    ?? facts.find((fact) => fact.kind === 'reported')
    ?? facts.find((fact) => fact.kind === 'api_equivalent')
    ?? facts.find((fact) => fact.kind === 'estimated');
}

/** All observed monetary kinds remain separate, including simultaneous facts. */
export function resolveUsageCostFacts(cost: UsageObservationCost): UsageCostBasis[] {
  const reportedSource = cost.costSource === 'provider_reported_api_equivalent' ? 'provider_reported_api_equivalent' : 'provider_reported';
  const hasReported = cost.reportedUsd > 0 || cost.costSource === 'provider_reported' || cost.costSource === 'provider_reported_api_equivalent';
  const hasEstimated = cost.estimatedUsd > 0 || cost.costSource === 'pricing_estimate';
  const hasInvoice = (cost.invoiceUsd ?? 0) > 0 || cost.costSource === 'invoice';
  const basis = (kind: UsageCostBasis['kind'], amountUsd: number, source: string): UsageCostBasis => ({ kind, amountUsd, currency: cost.currency, source });
  const facts: UsageCostBasis[] = [];
  if (hasReported) facts.push(basis('reported', cost.reportedUsd, reportedSource));
  if (hasEstimated) facts.push(basis('estimated', cost.estimatedUsd, 'pricing_estimate'));
  if (hasInvoice) facts.push(basis('invoice', cost.invoiceUsd ?? 0, 'invoice'));
  if (cost.apiEquivalentUsd !== undefined) facts.push({ kind: 'api_equivalent', currency: 'USD', amountUsd: cost.apiEquivalentUsd, source: cost.pricingSource ?? 'catalog' });
  return facts;
}

/** A monetary value is available only when its selected basis is witnessed. */
export function resolveUsageCostBasis(cost: UsageObservationCost, mode: UsageCostMode): UsageCostBasis | null {
  if (mode === 'api_equivalent') return cost.apiEquivalentUsd === undefined ? null
    : { kind: 'api_equivalent', currency: 'USD', amountUsd: cost.apiEquivalentUsd, source: cost.pricingSource ?? 'catalog' };
  if (cost.currency === 'MIXED' || cost.costSource === 'none' && cost.apiEquivalentUsd === undefined) return null;
  return resolveUsageCostFactForMode(resolveUsageCostFacts(cost), mode) ?? null;
}

/** Legacy numeric adapter; absence is represented by the result's omitted presentation. */
export function resolveEffectiveUsageCostUsd(cost: UsageObservationCost, mode: UsageCostMode): number {
  return resolveUsageCostBasis(cost, mode)?.amountUsd ?? 0;
}

export function resolveUsageCostPresentationSource(cost: UsageObservationCost, mode: UsageCostMode): string {
  return resolveUsageCostBasis(cost, mode)?.source ?? 'none';
}

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
  const price = resolveUsageModelPrice(modelId, catalog, overrides);
  if (!price || !categories) return null;
  const { rates } = price;
  if (categories.cacheRead > 0 && rates.cacheReadUsdPerMillion === undefined
    || categories.cacheWrite > 0 && rates.cacheWriteUsdPerMillion === undefined) return null;
  const input = (categories.input * rates.inputUsdPerMillion + categories.cacheRead * (rates.cacheReadUsdPerMillion ?? 0)
    + categories.cacheWrite * (rates.cacheWriteUsdPerMillion ?? 0)) / 1_000_000;
  const output = (categories.output * rates.outputUsdPerMillion + categories.reasoning * (rates.reasoningUsdPerMillion ?? rates.outputUsdPerMillion)) / 1_000_000;
  const total = input + output;
  if (!Number.isFinite(total)) return null;
  const cacheSavingsUsd = categories.cacheRead * (rates.inputUsdPerMillion - (rates.cacheReadUsdPerMillion ?? rates.inputUsdPerMillion)) / 1_000_000;
  return { total, input, output, estimatedUsd: total, price,
    ...(cacheSavingsUsd > 0 ? { breakdown: { cacheSavingsUsd } } : {}) };
}

/** Query-only price projection. Original reported/invoice/legacy estimate fields are immutable inputs. */
export function repriceUsageObservationCost(rawCost: UsageObservationCost, modelId: string | null | undefined,
  categories: UsageObservationTokens | null, catalog: UsageModelPriceCatalog = bundledUsageModelPriceCatalog,
  overrides: UsageModelPriceOverridesV1 = {}, mode: UsageCostMode = 'auto'): UsageObservationCost {
  const estimate = estimateUsageModelCost(modelId, categories, catalog, overrides);
  const { apiEquivalentUsd: _old, pricingSource: _source, effectiveUsd: _effective, ...raw } = rawCost;
  const source = estimate ? estimate.price.source === 'catalog' ? `litellm:${catalog.provenance.revision}`
    : `user:${estimate.price.source}:${modelId}` : undefined;
  const priced = estimate ? { ...raw, apiEquivalentUsd: estimate.total, pricingSource: source } : raw;
  const selected = resolveUsageCostBasis(priced, mode);
  return selected ? { ...priced, effectiveUsd: selected.amountUsd } : priced;
}

/** One grouping key is used by both query aggregation and price reprojection. */
export function resolveUsageContributionDimensionKey(row: Pick<UsageAnalyticsContribution,
  'agentId' | 'modelId' | 'sessionId' | 'projectKey' | 'workspaceId' | 'backendMode' | 'source'> & { machineId?: string | null },
  dimension: NonNullable<UsageAnalyticsQueryRequest['breakdowns']>[number] | 'engine'): string | null {
  if (dimension === 'engine') return row.agentId ? row.backendMode ? `${row.agentId}:${row.backendMode}` : row.agentId : null;
  const fields = { agent: 'agentId', model: 'modelId', session: 'sessionId', project: 'projectKey', workspace: 'workspaceId',
    machine: 'machineId', backendMode: 'backendMode', source: 'source' } as const;
  return row[fields[dimension]] ?? null;
}

/** Recompute history from the admitted contribution projection, retaining the original money facts. */
export function repriceUsageAnalyticsResponse(value: UsageAnalyticsQueryResponse, catalog: UsageModelPriceCatalog = value.priceCatalog ?? bundledUsageModelPriceCatalog,
  overrides: UsageModelPriceOverridesV1 = {}, mode: UsageCostMode = 'auto'): UsageAnalyticsQueryResponse {
  if (!value.contributions) return { ...value, priceCatalog: catalog };
  const facts: UsageAnalyticsCostFact[] = [];
  let cacheSavingsUsd = 0;
  let cacheSavingsComplete = true;
  const contributions = value.contributions.map(row => {
    const categories = row.tokenCategories ?? resolveUsageTokenCategories(row.tokens, null);
    const estimate = estimateUsageModelCost(row.modelId, categories, catalog, overrides);
    if (!estimate && row.tokens.cacheRead > 0) cacheSavingsComplete = false;
    cacheSavingsUsd += estimate?.breakdown?.cacheSavingsUsd ?? 0;
    const cost = repriceUsageObservationCost(row.cost, row.modelId, categories, catalog, overrides, mode);
    const existing = resolveUsageCostFacts(cost);
    const base = { tokens: row.tokens, eventCount: 1, asOfMs: row.observedAtMs,
      complete: value.coverage?.status === 'complete' };
    for (const fact of existing) facts.push({ ...base, ...fact, currency: fact.kind === 'api_equivalent' ? 'USD' : fact.currency });
    if (!estimate && row.tokens.total > 0) facts.push({ ...base, kind: 'unpriced', currency: 'USD', amountUsd: null,
      source: categories ? 'model_price_unknown' : 'token_categories_unknown', complete: false });
    return { ...row, cost };
  });
  const projectCost = (raw: UsageObservationCost, rows: readonly UsageAnalyticsContribution[]): UsageObservationCost => {
    const { apiEquivalentUsd: _old, pricingSource: _source, effectiveUsd: _effective, ...observed } = raw;
    const allPriced = rows.every(row => row.cost.apiEquivalentUsd !== undefined);
    const updated: UsageObservationCost = allPriced ? { ...observed,
      apiEquivalentUsd: rows.reduce((sum, row) => sum + row.cost.apiEquivalentUsd!, 0),
      pricingSource: rows.every(row => row.cost.pricingSource === rows[0]?.cost.pricingSource)
        ? rows[0]?.cost.pricingSource ?? `litellm:${catalog.provenance.revision}` : 'effective_model_prices',
    } : observed;
    const selected = rows.map(row => resolveUsageCostBasis(row.cost, mode));
    const first = selected[0];
    if (!first || selected.some(fact => !fact || fact.kind !== first.kind || fact.currency !== first.currency)) return updated;
    return { ...updated, effectiveUsd: selected.reduce((sum, fact) => sum + fact!.amountUsd, 0) };
  };
  const rowsFor = (dimension: Parameters<typeof resolveUsageContributionDimensionKey>[1], key: string,
    rows: readonly UsageAnalyticsContribution[] = contributions) => rows.filter(row => (resolveUsageContributionDimensionKey(row, dimension) ?? 'unknown') === key);
  const breakdowns = value.breakdowns && Object.fromEntries(Object.entries(value.breakdowns).map(([dimension, entries]) =>
    [dimension, entries?.map(entry => ({ ...entry, cost: projectCost(entry.cost, rowsFor(dimension as Parameters<typeof rowsFor>[0], entry.key)) }))]));
  const ranking = reprojectUsageLeaders(value, contributions, mode, projectCost);
  const totals = { ...value.totals, cost: projectCost(value.totals.cost, contributions) };
  const selected = contributions.map(row => resolveUsageCostBasis(row.cost, mode));
  const first = selected[0];
  const oneBasis = first && selected.every(fact => fact && fact.kind === first.kind && fact.currency === first.currency);
  const costPresentation = oneBasis ? { mode, effectiveUsd: selected.reduce((sum, fact) => sum + fact!.amountUsd, 0), currency: first.currency,
    source: selected.every(fact => fact!.source === first.source) ? first.source : 'effective_model_prices' } : undefined;
  const factGroups = new Map<string, UsageAnalyticsCostFact[]>();
  for (const fact of facts) {
    const key = JSON.stringify([fact.kind, fact.currency, fact.source]);
    const group = factGroups.get(key);
    if (group) group.push(fact); else factGroups.set(key, [fact]);
  }
  const groupedFacts = [...factGroups.values()].map(group => {
    const { sources, ...fact } = projectUsageCostFactTotals(group)[0]!;
    return { ...fact, source: sources[0]! };
  });
  const unknown = groupedFacts.some(fact => fact.kind === 'unpriced');
  const coverage = ranking.coverage && { ...ranking.coverage, status: unknown && ranking.coverage.status === 'complete' ? 'partial' as const : ranking.coverage.status,
    reasons: [...ranking.coverage.reasons.filter(reason => reason !== 'unpriced_tokens'), ...(unknown ? ['unpriced_tokens' as const] : [])] };
  let insights = value.insights;
  if (insights) {
    const { cacheSavingsUsd: _oldSavings, ...otherInsights } = insights;
    insights = { ...otherInsights, ...(cacheSavingsComplete ? { cacheSavingsUsd } : {}) };
  }
  return { ...value, totals, contributions, costFacts: groupedFacts, priceCatalog: catalog, costPresentation, coverage, insights,
    series: value.series?.map(bucket => ({ ...bucket, cost: projectCost(bucket.cost,
      contributions.filter(row => row.observedAtMs >= bucket.bucketStartMs && row.observedAtMs < bucket.bucketEndMs)) })),
    breakdowns, leaders: ranking.leaders, modelTimeline: ranking.modelTimeline, engineTimeline: ranking.engineTimeline };
}
