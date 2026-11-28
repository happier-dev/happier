import type { UsageObservationTokens } from './usageAnalyticsContracts.js';
import { estimateUsageModelCost as estimateWithCatalog, type UsageModelCostEstimate } from './usageCostProjection.js';
import { bundledUsageModelPriceCatalog } from './usageModelPriceCatalog.js';
import type { UsageModelPriceCatalog, UsageModelPriceOverridesV1 } from './usageModelPriceSchemas.js';

export * from './usageCostProjection.js';

/** Price over nonoverlapping token categories with the bundled catalog as the default. */
export function estimateUsageModelCost(modelId: string | null | undefined, categories: UsageObservationTokens | null,
  catalog: UsageModelPriceCatalog = bundledUsageModelPriceCatalog, overrides: UsageModelPriceOverridesV1 = {}): UsageModelCostEstimate | null {
  return estimateWithCatalog(modelId, categories, catalog, overrides);
}
