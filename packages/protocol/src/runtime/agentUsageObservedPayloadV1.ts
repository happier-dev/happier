import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { maxCodeUnits } from '../strings/maxCodeUnits.js';
import { UsagePromptCacheSchema, UsageRequestAttributionSchema } from '../usage/usageAnalyticsContracts.js';
import { exactString, HostIdSchema, ProviderIdSchema, SafeIntegerSchema } from './agentSessionScalarsV1.js';
import { AGENT_SESSION_RUNTIME_LIMITS_CANDIDATE_V1 as LIMITS } from './agentSessionLimitsV1.js';

const MODEL_ID_MAX = LIMITS.modelIdMaxCodeUnits;
const SOURCE_MAX = LIMITS.usageSourceMaxCodeUnits;

const UsageTokensSchema = lazyZodSchema(() => z.strictObject({
  input: z.nullable(SafeIntegerSchema),
  output: z.nullable(SafeIntegerSchema),
  reasoning: z.nullable(SafeIntegerSchema),
  cacheRead: z.nullable(SafeIntegerSchema),
  cacheWrite: z.nullable(SafeIntegerSchema),
  total: z.nullable(SafeIntegerSchema),
}));

const UsageCostBreakdownKeysSchema = lazyZodSchema(() => z.array(
  exactString(LIMITS.usage.breakdownKeyMaxCodeUnits),
).check(z.maxLength(LIMITS.usage.breakdownMaxEntries)));

const UsageCostSchema = lazyZodSchema(() => z.strictObject({
  reportedUsd: z.nullable(z.number().check(z.nonnegative())),
  estimatedUsd: z.nullable(z.number().check(z.nonnegative())),
  invoiceUsd: z.optional(z.nullable(z.number().check(z.nonnegative()))),
  billingContext: z.optional(z.enum([
    'api_usage',
    'subscription_included',
    'subscription_with_possible_overage',
    'unknown',
  ])),
  costSource: z.optional(z.enum([
    'provider_reported',
    'provider_reported_api_equivalent',
    'pricing_estimate',
    'invoice',
    'none',
  ])),
  currency: exactString(LIMITS.usage.currencyMaxCodeUnits),
  // Exact-money Symbol provenance is internal; runtime JSON contains string keys only.
  breakdown: z.optional(z.catchall(z.object({}), z.number().check(z.nonnegative()))
    .check(z.refine((value) => UsageCostBreakdownKeysSchema.safeParse(Object.keys(value)).success,
      'Usage breakdown keys or entry count exceed their bounds'))),
  effectiveUsd: z.optional(z.number().check(z.nonnegative())),
}));

const ContextUsageSchema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  modelId: z.nullable(exactString(MODEL_ID_MAX)),
  usedTokens: SafeIntegerSchema,
  windowTokens: z.nullable(SafeIntegerSchema),
  totalProcessedTokens: z.nullable(SafeIntegerSchema),
  baselineTokens: z.nullable(SafeIntegerSchema),
  isAutoCompactEnabled: z.nullable(z.boolean()),
  categories: z.nullable(z.array(z.strictObject({
    key: exactString(LIMITS.usage.contextCategoryKeyMaxCodeUnits),
    label: z.nullable(z.string().check(maxCodeUnits(LIMITS.usage.contextCategoryLabelMaxCodeUnits))),
    tokens: SafeIntegerSchema,
  })).check(z.maxLength(LIMITS.usage.contextCategoriesMaxItems))),
  observedAtMs: SafeIntegerSchema,
  source: z.enum(['provider_live', 'provider_turn', 'derived_estimate']),
}));

const UsageMeasurementShape = {
  promptCache: z.optional(UsagePromptCacheSchema),
  tokens: z.optional(UsageTokensSchema),
  cost: z.optional(UsageCostSchema),
  context: z.optional(ContextUsageSchema),
};

/** Shared Session/finite-Run payload. Missing measurements remain unknown, never zero. */
export const AgentUsageObservedPayloadV1Schema = lazyZodSchema(() => z.strictObject({
    kind: z.literal('usage-observed'),
    observationId: ProviderIdSchema,
    attribution: z.optional(UsageRequestAttributionSchema),
    turnId: z.optional(HostIdSchema),
    source: exactString(SOURCE_MAX),
    scope: z.enum(['turn_delta', 'session_cumulative', 'session_final']),
    modelId: z.optional(exactString(MODEL_ID_MAX)),
    accounting: z.optional(z.strictObject({
      nativeSessionId: z.optional(ProviderIdSchema),
      inferenceId: z.optional(ProviderIdSchema),
      inputIncludesCache: z.optional(z.boolean()),
      outputIncludesReasoning: z.optional(z.boolean()),
      historyComplete: z.optional(z.boolean()),
    })),
    ...UsageMeasurementShape,
}).check(z.refine((value) => value.accounting?.nativeSessionId !== undefined
  || value.tokens !== undefined || value.cost !== undefined || value.context !== undefined || value.promptCache !== undefined,
  'A native accounting identity or usage measurement is required')));
export type AgentUsageObservedPayloadV1 = z.infer<typeof AgentUsageObservedPayloadV1Schema>;
