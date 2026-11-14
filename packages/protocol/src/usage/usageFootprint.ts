import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { UsageAnalyticsTokensSchema, type UsageAnalyticsQueryResponse, type UsageAnalyticsTokens } from './usageAnalyticsContracts.js';

export const UsageFootprintProjectionSchema = lazyZodSchema(() => z.strictObject({
  status: z.literal('insufficient_basis'), reason: z.literal('no_applicable_versioned_method'),
  method: z.null(), energyWh: z.null(), emissionsGCo2e: z.null(),
  coverage: z.strictObject({ accountedTokens: UsageAnalyticsTokensSchema, estimatedTokenCount: z.literal(0) }),
}));

export type UsageFootprintProjection = Readonly<{
  status: 'insufficient_basis';
  reason: 'no_applicable_versioned_method';
  method: null;
  energyWh: null;
  emissionsGCo2e: null;
  coverage: Readonly<{
    accountedTokens: UsageAnalyticsTokens;
    estimatedTokenCount: 0;
  }>;
}>;

/**
 * Accounting tokens are a proxy, not an energy measurement. Available accounting
 * lacks the model/serving/date facts required by the versioned primary methods;
 * the development Usage contract in docs/actions.md records this evidence basis.
 * Model attribution or an empty period does not establish measured zero impact.
 */
export function projectUsageFootprint(response: UsageAnalyticsQueryResponse): UsageFootprintProjection {
  return {
    status: 'insufficient_basis',
    reason: 'no_applicable_versioned_method',
    method: null,
    energyWh: null,
    emissionsGCo2e: null,
    coverage: { accountedTokens: response.totals.tokens, estimatedTokenCount: 0 },
  };
}
