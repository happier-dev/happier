import { expect, it } from 'vitest';
import { UsageAnalyticsQueryRequestSchema } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import { bundledUsageModelPriceCatalog } from '@happier-dev/protocol/usage/usageModelPriceCatalog';
import { resolveUsageCostBasis } from '@happier-dev/protocol/usage/usageCostFacts';
import { prepareUsageAnalyticsProjection } from './usageQueryService';
import type { ScopedUsageContribution } from './query/resolveScopedUsageContributions';

it('prices a charge-less Vercel gateway terminal observation through the shared tariff without inventing a reported charge', () => {
    const query = UsageAnalyticsQueryRequestSchema.parse({ includeSeries: true });
    const catalog = { ...bundledUsageModelPriceCatalog,
        models: { 'gateway-model': { provider: 'anthropic', inputUsdPerMillion: 3, outputUsdPerMillion: 15 } } };
    const row: ScopedUsageContribution = {
        id: 'gateway-turn', sessionId: 'gateway-session', turnId: 'turn',
        observedAt: new Date(0), createdAt: new Date(0),
        agentId: 'claude', backendMode: 'remote', modelId: 'anthropic/gateway-model',
        machineId: 'machine', projectKey: null, workspaceId: null,
        source: 'claude_sdk', scope: 'turn_delta', isCumulative: false,
        metadata: { providerId: 'happier.provider.vercel-ai-gateway/vercel-ai-gateway',
            usageAccounting: { path: 'runtime', status: 'available', historyComplete: true } },
        contextUsedTokens: null, contextWindowTokens: null, contributingEventIds: ['gateway-turn'],
        tokens: { input: 100, output: 20, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 120 },
        cost: { reportedUsd: null, estimatedUsd: null, invoiceUsd: null, currency: 'USD' },
    };
    const project = (contribution: ScopedUsageContribution) => prepareUsageAnalyticsProjection(
        { messageCountsBySession: undefined }, query, catalog,
        { totalContributions: [contribution], evidenceRows: [], costMode: 'auto' }).value;

    const priced = project(row);
    const cost = priced.contributions![0]!.cost;
    expect(priced.contributions![0]!.providerId).toBe('happier.provider.vercel-ai-gateway/vercel-ai-gateway');
    // Catalog estimates use the existing API-equivalent basis, separate from vendor-reported charges.
    expect(cost).toMatchObject({ reportedUsd: null, estimatedUsd: null, apiEquivalentUsd: 0.0006,
        pricingSource: `litellm:${catalog.provenance.revision}` });
    expect(resolveUsageCostBasis(cost, 'auto')).toMatchObject({ kind: 'api_equivalent', amountUsd: 0.0006 });
    expect(resolveUsageCostBasis(cost, 'reported')).toBeNull();
    expect(resolveUsageCostBasis(priced.totals.cost, 'auto')).toMatchObject({ kind: 'api_equivalent', amountUsd: 0.0006 });
    expect(row.cost).toEqual({ reportedUsd: null, estimatedUsd: null, invoiceUsd: null, currency: 'USD' });

    const unknown = project({ ...row, modelId: 'anthropic/no-tariff' }).contributions![0]!.cost;
    expect(unknown.reportedUsd).toBeNull();
    expect(resolveUsageCostBasis(unknown, 'auto')).toBeNull();
    const reported = project({ ...row, cost: { ...row.cost, reportedUsd: 0, costSource: 'provider_reported' } })
        .contributions![0]!.cost;
    expect(resolveUsageCostBasis(reported, 'auto')).toMatchObject({ kind: 'reported', amountUsd: 0 });
});
