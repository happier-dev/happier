import { UsageAnalyticsContributionSchema, UsageAnalyticsQueryResponseSchema } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import { bundledUsageModelPriceCatalog } from '@happier-dev/protocol/usage/usageModelPriceCatalog';
import accounting from './usageQaAccounting';
import observations from './usageQaContributions';

/** Read-only agent-qa-usage-insights usage.query capture, 2026-10-11. Opaque identities anonymized.
 * Tuples retain time, dimensions, source, raw/category tokens, money and witnessed event counts.
 */
export function usageQaAccountingFixture() {
    return UsageAnalyticsQueryResponseSchema.parse({ ...UsageAnalyticsQueryResponseSchema.parse(accounting), priceCatalog: bundledUsageModelPriceCatalog,
        contributions: observations.map(row => UsageAnalyticsContributionSchema.parse({
            id: row[0], observedAtMs: row[1], sessionId: row[2], turnId: row[3], agentId: row[4], modelId: row[5],
            machineId: row[6], projectKey: row[7], workspaceId: row[8], source: row[9], sourceContext: row[10],
            tokens: row[11], ...(row[12] === null ? {} : { tokenCategories: row[12] }), cost: row[13],
            ...(row[14] === null ? {} : { eventCount: row[14] }),
        })) });
}
