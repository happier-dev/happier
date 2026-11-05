import type { UsageAnalyticsContribution, UsageAnalyticsCostFactKind, UsageAnalyticsQueryRequest, UsageAnalyticsQueryResponse, UsageObservationCost } from './usageAnalyticsContracts.js';
import { reprojectUsageLeaders } from './usageLeaderProjection.js';
import { aggregateUsageContributionCosts, resolveUsageContributionCosts, usageCostAggregationBasis, type AggregatedUsageCost } from './usageAggregation.js';
import { canonicalUsageModelPriceId } from './usageModelPriceSchemas.js';
import type { UsageModelPriceCatalog, UsageModelPriceOverridesV1 } from './usageModelPriceCatalog.js';
import { addUsageMoney, readUsageMoney, transferUsageMoney, usageMoneyFromNumber, usageMoneyToNumber, withUsageMoney } from './usageMoney.js';

export type UsageCostMode = NonNullable<UsageAnalyticsQueryRequest['costMode']> | 'auto';
export interface UsageCostBasis {
  kind: Exclude<UsageAnalyticsCostFactKind, 'unpriced'>;
  currency: string;
  amountUsd: number;
  source: string;
}
/** A best-available aggregate labels unlike witnessed kinds rather than calling them reported. */
export type UsageSelectedCostBasis = Omit<UsageCostBasis, 'kind'> & Readonly<{ kind: UsageCostBasis['kind'] | 'mixed' }>;

/** Covered fallback facts remain readable, but are not another selected charge or attributed zero. */
export function isUsageCostCoveredByReportedTotal(cost: UsageObservationCost, mode: UsageCostMode): boolean {
  return cost.reportedTotalId !== undefined && (mode === 'auto' || mode === 'reported');
}

/** Reported-total money is selectable only after the population owner resolves its scope. */
export function hasUnresolvedUsageReportedTotalScope(cost: UsageObservationCost, mode: UsageCostMode): boolean {
  return isUsageCostCoveredByReportedTotal(cost, mode)
    || cost.reportedTotalContributionIds !== undefined && (mode === 'auto' || mode === 'reported');
}

export function resolveUsageCostMode(mode: UsageAnalyticsQueryRequest['costMode']): UsageCostMode {
  return mode ?? 'auto';
}

function usageCostFactPriority(mode: UsageCostMode): readonly UsageCostBasis['kind'][] {
  return mode === 'auto' ? ['reported', 'api_equivalent', 'estimated', 'invoice'] : [mode];
}

export function resolveUsageCostFactForMode<Fact extends { kind: UsageAnalyticsCostFactKind }>(facts: readonly Fact[], mode: UsageCostMode): Fact | undefined {
  for (const kind of usageCostFactPriority(mode)) {
    const fact = facts.find(fact => fact.kind === kind);
    if (fact) return fact;
  }
  return undefined;
}

/** Currency stays fixed; best available resolves witnessed kinds independently within each row. */
export type UsagePageCostSelection = Readonly<Pick<UsageSelectedCostBasis, 'kind' | 'currency'> & { mode?: UsageCostMode }>;
export type UsagePageCostProjection = Readonly<{
  selection: UsagePageCostSelection | null;
  amountUsd: number | null;
  accounting: UsageAnalyticsQueryResponse;
}>;

// In-process provenance of a completed projection, not serialized money or a
// second cache. A copied response with a different population must recompute.
export const usagePageCostProjectionBasis = Symbol('usagePageCostProjectionBasis');
export type UsagePageCostProjectionBasis = {
  readonly response: UsageAnalyticsQueryResponse;
  readonly mode: UsageCostMode;
  readonly catalog: UsageModelPriceCatalog;
  readonly overrides: UsageModelPriceOverridesV1;
  readonly partitions?: import('./usageLeaderProjection.js').UsageAnalyticsPricingPartitions;
  pageInput?: UsageAnalyticsQueryResponse;
  pageProjection?: UsagePageCostProjection;
};

/** Only the validated query transport can witness the server's original prices.
 * A serialized private projection has the same catalog revision, so arbitrary
 * compact values must still replay their grouped operands when overrides clear.
 */
export function admitUsageAnalyticsServerPrices(value: UsageAnalyticsQueryResponse,
  query: UsageAnalyticsQueryRequest): UsageAnalyticsQueryResponse {
  const catalog = value.priceCatalog;
  const mode = query.costMode ?? 'auto';
  if (value.contributions || !value.summary || !catalog || value.summary.costMode !== mode
    || value.summary.catalogRevision !== catalog.provenance.revision) return value;
  // Each delivered shape owns its existing projection witness; sibling detail
  // borrowers can share the source totals without replacing each other's proof.
  const response = { ...value, totals: { ...value.totals, cost: { ...value.totals.cost } } };
  Object.defineProperty(response.totals.cost, usagePageCostProjectionBasis, { value: { response, mode, catalog, overrides: {} } });
  return response;
}

export function readUsagePageCostProjectionBasis(response: UsageAnalyticsQueryResponse): UsagePageCostProjectionBasis | undefined {
  const completed = (response.totals.cost as UsageObservationCost & {
    [usagePageCostProjectionBasis]?: UsagePageCostProjectionBasis;
  })[usagePageCostProjectionBasis];
  if (!completed) return undefined;
  const input = completed.response;
  // The page's authorized source labels decorate coverage without changing
  // any accounting/pricing input. Other changed members invalidate the work.
  const fields = ['contributions', 'totals', 'series', 'breakdowns', 'leaders', 'modelTimeline', 'engineTimeline', 'insights', 'priceCatalog'] as const;
  return fields.every(field => input[field] === response[field])
    && input.coverage?.status === response.coverage?.status
    && input.coverage?.reasons === response.coverage?.reasons
    && input.coverage?.ranked === response.coverage?.ranked ? completed : undefined;
}

function selectionMode(selection: UsagePageCostSelection): UsageCostMode {
  return selection.mode ?? (selection.kind === 'invoice' || selection.kind === 'mixed' ? 'auto' : selection.kind);
}

export function resolveUsageCostBasisForSelection(cost: UsageObservationCost, selection: UsagePageCostSelection | null): UsageSelectedCostBasis | null {
  if (!selection) return null;
  const fact = selection.mode === 'auto' || selection.kind === 'mixed' ? resolveUsageCostBasis(cost, 'auto')
    : selection.kind === 'invoice' ? resolveUsageCostFacts(cost).find(fact => fact.kind === 'invoice')
    : resolveUsageCostBasis(cost, selectionMode(selection));
  return fact && (selection.mode === 'auto' || selection.kind === 'mixed' || fact.kind === selection.kind)
    && fact.currency === selection.currency ? fact : null;
}

export function resolveUsageCostForSelection(cost: UsageObservationCost, selection: UsagePageCostSelection | null): number | null {
  return resolveUsageCostBasisForSelection(cost, selection)?.amountUsd ?? null;
}

/** Selection remains named even when an unpriced row makes the total unavailable. */
export function resolveUsagePageCostSelection(costs: readonly UsageObservationCost[], mode: UsageCostMode): UsagePageCostSelection | null {
  const facts = costs.flatMap(cost => { const fact = resolveUsageCostBasis(cost, mode); return fact ? [fact] : []; });
  const first = facts[0];
  return first ? { kind: facts.every(fact => fact.kind === first.kind) ? first.kind : 'mixed', currency: first.currency, mode } : null;
}

/**
 * Best available resolves reported -> API-priced -> estimated for every contribution and keeps
 * a mixed aggregate labelled. Explicit modes and unknown money remain unavailable. Raw facts
 * and query-time tariffs remain unchanged; leaders and buckets use the same aggregation owner.
 */
export function projectUsagePageCost(response: UsageAnalyticsQueryResponse, mode: UsageCostMode,
  selected?: UsagePageCostSelection | null): UsagePageCostProjection {
  const rows = response.contributions;
  const completed = readUsagePageCostProjectionBasis(response);
  const retain = (projection: UsagePageCostProjection) => {
    if (selected === undefined && completed?.mode === mode) {
      completed.pageInput = response;
      completed.pageProjection = projection;
    }
    return projection;
  };
  if (selected === undefined && completed?.mode === mode && completed.pageProjection) {
    const previous = completed.pageProjection;
    if (completed.pageInput === response) return previous;
    const projected = previous.accounting;
    return retain({ ...previous, accounting: { ...response, totals: projected.totals,
      series: projected.series, breakdowns: projected.breakdowns, leaders: projected.leaders,
      modelTimeline: projected.modelTimeline, engineTimeline: projected.engineTimeline,
      coverage: projected.coverage && { ...response.coverage!, status: projected.coverage.status,
        reasons: projected.coverage.reasons, ranked: projected.coverage.ranked },
    } });
  }
  // Raw aggregate facts cannot reconstruct per-row selection after JSON transport.
  // Responses without contribution detail already carry the selected presentation.
  const presentation = response.costPresentation;
  if (!rows && presentation?.mode === mode) {
    const rawBasis = resolveUsageCostBasis(response.totals.cost, mode);
    const kind = mode === 'auto' ? rawBasis?.source === presentation.source ? rawBasis.kind : 'mixed' : mode;
    const selection = selected === undefined ? { kind, currency: presentation.currency, mode } : selected;
    const matches = selection && selection.currency === presentation.currency && selectionMode(selection) === mode
      && (selection.mode === 'auto' || selection.kind === 'mixed' || selection.kind === kind);
    return { selection, amountUsd: matches ? presentation.effectiveUsd : null, accounting: response };
  }
  const costs = (rows ? resolveUsageContributionCosts(rows, mode) : [response.totals.cost])
    .filter(cost => !(cost as AggregatedUsageCost)[usageCostAggregationBasis]?.covered);
  // Compact partial populations have no selectable total. Their witnessed facts
  // still name the currency/mode for independently priced buckets and leaders;
  // they cannot supply an amount for the incomplete whole population.
  const availableFact = !rows ? response.costFacts?.find(fact => fact.kind !== 'unpriced'
    && fact.amountUsd !== null && (mode === 'auto' || fact.kind === mode)) : undefined;
  const selection = selected === undefined ? resolveUsagePageCostSelection(costs, mode)
    ?? (availableFact ? { kind: mode === 'auto' ? 'mixed' as const : mode, currency: availableFact.currency, mode } : null) : selected;
  const amounts = costs.map(cost => resolveUsageCostBasisForSelection(cost, selection));
  const amountUsd = selection && amounts.length > 0 && amounts.every(amount => amount !== null)
    ? usageMoneyToNumber(amounts.reduce((sum, amount) => addUsageMoney(sum,
      readUsageMoney(amount!, 'amountUsd', amount!.amountUsd)), usageMoneyFromNumber(0))) : null;
  if (!rows || !selection) return retain({ selection, amountUsd, accounting: response });
  const selectedMode = selectionMode(selection);
  const projectCost = (raw: UsageObservationCost, contributions: readonly UsageAnalyticsContribution[]): UsageObservationCost => {
    const selectedCosts = resolveUsageContributionCosts(contributions, selectedMode)
      .filter(cost => !(cost as AggregatedUsageCost)[usageCostAggregationBasis]?.covered);
    const amounts = selectedCosts.map(cost => resolveUsageCostForSelection(cost, selection));
    const { effectiveUsd: _old, selectedBasis: _selectedBasis, ...original } = raw;
    if (selectedCosts.length === 0 || amounts.some(amount => amount === null)) {
      const unavailable: AggregatedUsageCost = { ...original, costSource: 'none',
        [usageCostAggregationBasis]: { mode: selectedMode, available: false } };
      return unavailable;
    }
    return aggregateUsageContributionCosts(contributions, selectedMode);
  };
  const ranking = reprojectUsageLeaders(response, rows, selectedMode, projectCost);
  const projection = { selection, amountUsd, accounting: { ...response, ...ranking,
    totals: { ...response.totals, cost: projectCost(response.totals.cost, rows) },
  } };
  return retain(projection);
}

/** All observed monetary kinds remain separate, including simultaneous facts. */
function readUsageCostFact(cost: UsageObservationCost, kind: UsageCostBasis['kind']): UsageCostBasis | undefined {
  let amountUsd: number;
  let source: string;
  let field: string;
  if (kind === 'reported') {
    amountUsd = cost.reportedUsd;
    if (!(amountUsd > 0 || cost.costSource === 'provider_reported' || cost.costSource === 'provider_reported_api_equivalent')) return undefined;
    source = cost.costSource === 'provider_reported_api_equivalent' ? 'provider_reported_api_equivalent' : 'provider_reported';
    field = 'reportedUsd';
  } else if (kind === 'estimated') {
    amountUsd = cost.estimatedUsd;
    if (!(amountUsd > 0 || cost.costSource === 'pricing_estimate')) return undefined;
    source = 'pricing_estimate'; field = 'estimatedUsd';
  } else if (kind === 'invoice') {
    amountUsd = cost.invoiceUsd ?? 0;
    if (!(amountUsd > 0 || cost.costSource === 'invoice')) return undefined;
    source = 'invoice'; field = 'invoiceUsd';
  } else {
    if (cost.apiEquivalentUsd === undefined) return undefined;
    amountUsd = cost.apiEquivalentUsd; source = cost.pricingSource ?? 'catalog'; field = 'apiEquivalentUsd';
  }
  const fact = { kind, amountUsd, currency: kind === 'api_equivalent' ? 'USD' : cost.currency, source };
  return transferUsageMoney(cost, field, fact.amountUsd, fact, 'amountUsd');
}

export function resolveUsageCostFacts(cost: UsageObservationCost): UsageCostBasis[] {
  const kinds = ['reported', 'estimated', 'invoice', 'api_equivalent'] as const;
  return kinds.flatMap(kind => { const fact = readUsageCostFact(cost, kind); return fact ? [fact] : []; });
}

/** A monetary value is available only when its selected basis is witnessed. */
export function resolveUsageCostBasis(cost: UsageObservationCost, mode: UsageCostMode): UsageSelectedCostBasis | null {
  const aggregation = (cost as AggregatedUsageCost)[usageCostAggregationBasis];
  if (aggregation?.mode === mode) {
    return aggregation.available ? aggregation.selected ?? null : null;
  }
  if (cost.selectedBasis?.mode === mode) {
    return cost.selectedBasis.value && cost.effectiveUsd !== undefined
      ? withUsageMoney<UsageSelectedCostBasis>({ ...cost.selectedBasis.value, amountUsd: cost.effectiveUsd },
        { amountUsd: readUsageMoney(cost, 'effectiveUsd', cost.effectiveUsd) }) : null;
  }
  if (hasUnresolvedUsageReportedTotalScope(cost, mode)) return null;
  if (mode === 'api_equivalent') return readUsageCostFact(cost, mode) ?? null;
  if (cost.currency === 'MIXED' || cost.costSource === 'none' && cost.apiEquivalentUsd === undefined) return null;
  for (const kind of usageCostFactPriority(mode)) {
    const fact = readUsageCostFact(cost, kind);
    if (fact) return fact;
  }
  return null;
}

/** Compact delivery retains the resolved selection, not the private report-scope identifiers. */
export function serializeUsageCostBasis(cost: UsageObservationCost, mode: UsageCostMode): UsageObservationCost {
  const selected = resolveUsageCostBasis(cost, mode);
  const { effectiveUsd: _effective, selectedBasis: _previous, ...observed } = cost;
  return selected ? withUsageMoney<UsageObservationCost>({ ...observed, effectiveUsd: selected.amountUsd,
    selectedBasis: { mode, value: { kind: selected.kind, currency: selected.currency, source: selected.source } } },
    { effectiveUsd: readUsageMoney(selected, 'amountUsd', selected.amountUsd) })
    : { ...observed, selectedBasis: { mode, value: null } };
}

/** Legacy numeric adapter; absence is represented by the result's omitted presentation. */
export function resolveEffectiveUsageCostUsd(cost: UsageObservationCost, mode: UsageCostMode): number {
  return resolveUsageCostBasis(cost, mode)?.amountUsd ?? 0;
}

export function resolveUsageCostPresentationSource(cost: UsageObservationCost, mode: UsageCostMode): string {
  return resolveUsageCostBasis(cost, mode)?.source ?? 'none';
}

/** One grouping key is used by both query aggregation and price reprojection. */
export function resolveUsageContributionDimensionKey(row: Pick<UsageAnalyticsContribution,
  'agentId' | 'modelId' | 'sessionId' | 'projectKey' | 'workspaceId' | 'backendMode' | 'source'> & { machineId?: string | null },
  dimension: NonNullable<UsageAnalyticsQueryRequest['breakdowns']>[number] | 'engine'): string | null {
  if (dimension === 'engine') return row.agentId ? row.backendMode ? `${row.agentId}:${row.backendMode}` : row.agentId : null;
  if (dimension === 'model') return canonicalUsageModelPriceId(row.modelId);
  const fields = { agent: 'agentId', model: 'modelId', session: 'sessionId', project: 'projectKey', workspace: 'workspaceId',
    machine: 'machineId', backendMode: 'backendMode', source: 'source' } as const;
  return row[fields[dimension]] ?? null;
}
