import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

import { KEYSET_CURSOR_MAX_LENGTH_V1 } from '../../pagination/keysetCursorV1.js';
import {
  UsageAnalyticsGranularitySchema,
  UsageObservationCostSchema,
  UsageObservationTokensSchema,
} from '../../usage/usageAnalyticsContracts.js';

export const TeamCredentialUsageLimitSubjectKindV1Schema = lazyZodSchema(() => z.enum([
  'resource',
  'each_member',
  'team_group',
  'team_member',
]));
export type TeamCredentialUsageLimitSubjectKindV1 = z.infer<typeof TeamCredentialUsageLimitSubjectKindV1Schema>;

export const TeamCredentialUsageLimitPeriodV1Schema = lazyZodSchema(() => z.enum(['day', 'week', 'month']));
export type TeamCredentialUsageLimitPeriodV1 = z.infer<typeof TeamCredentialUsageLimitPeriodV1Schema>;

export const TeamCredentialUsageLimitMetricV1Schema = lazyZodSchema(() => z.enum([
  'inference_requests',
  'total_tokens',
  'cost_usd',
]));
export type TeamCredentialUsageLimitMetricV1 = z.infer<typeof TeamCredentialUsageLimitMetricV1Schema>;

/**
 * Resource-wide enforcement availability, derived from the current canonical
 * route catalog. Absence on an older Home is read fail-closed by clients.
 */
export const TeamCredentialUsageCapabilitiesV1Schema = lazyZodSchema(() => z.object({
  inferenceRequests: z.enum(['available', 'unavailable']),
  totalTokens: z.enum(['available', 'unavailable']),
  costUsd: z.enum(['available', 'unavailable']),
  /** Limits are enforced only before brokered Provider requests. Directly
   * disclosed material cannot be observed or constrained by the Home. */
  limitCoverage: z.enum(['brokered_only', 'unavailable']),
}).strict());
export type TeamCredentialUsageCapabilitiesV1 = z.infer<typeof TeamCredentialUsageCapabilitiesV1Schema>;

/** Recipient-safe exhaustion facts. Limit identity, audience, maximum and
 * other members' recorded use stay manager-private. */
export const TeamCredentialUsageLimitDenialV1Schema = lazyZodSchema(() => z.object({
  metric: TeamCredentialUsageLimitMetricV1Schema,
  remaining: z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d{1,8})?$/u, 'remaining must be a canonical decimal'),
  resetsAtUtc: z.string().datetime({ offset: true }),
}).strict());
export type TeamCredentialUsageLimitDenialV1 = z.infer<typeof TeamCredentialUsageLimitDenialV1Schema>;

const DecimalValueV1Schema = lazyZodSchema(() => z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d{1,8})?$/u, 'value must be a canonical decimal'));
const DecimalMaximumV1Schema = lazyZodSchema(() => DecimalValueV1Schema.refine((value) => Number(value) > 0, 'maximum must be positive'));

export const TeamCredentialUsageLimitV1Schema = lazyZodSchema(() => z.object({
  id: z.string().min(1),
  subjectKind: TeamCredentialUsageLimitSubjectKindV1Schema,
  subjectId: z.string(),
  period: TeamCredentialUsageLimitPeriodV1Schema,
  metric: TeamCredentialUsageLimitMetricV1Schema,
  maximum: DecimalMaximumV1Schema,
  enabled: z.boolean(),
  currentWindow: z.object({
    recorded: DecimalValueV1Schema,
    resetsAtUtc: z.string().datetime({ offset: true }),
  }).strict(),
}).strict());
export type TeamCredentialUsageLimitV1 = z.infer<typeof TeamCredentialUsageLimitV1Schema>;

export const TeamCredentialUsageLimitDefinitionV1Schema = lazyZodSchema(() => z.object({
  subjectKind: TeamCredentialUsageLimitSubjectKindV1Schema,
  subjectId: z.string(),
  period: TeamCredentialUsageLimitPeriodV1Schema,
  metric: TeamCredentialUsageLimitMetricV1Schema,
  maximum: DecimalMaximumV1Schema,
  enabled: z.boolean(),
}).strict().superRefine((value, ctx) => {
  if ((value.subjectKind === 'resource' || value.subjectKind === 'each_member') && value.subjectId !== '') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['subjectId'], message: 'subjectId must be empty for this audience' });
  }
  if ((value.subjectKind === 'team_group' || value.subjectKind === 'team_member') && value.subjectId.trim() === '') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['subjectId'], message: 'subjectId is required for this audience' });
  }
  if (value.metric === 'inference_requests' || value.metric === 'total_tokens') {
    if (!/^\d+$/u.test(value.maximum)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['maximum'], message: 'request and token ceilings must be integers' });
    }
  }
}));

export const TeamCredentialUsageLimitUpsertInputV1Schema = lazyZodSchema(() => z.object({
  resourceId: z.string().min(1),
  expectedRevision: z.number().int().nonnegative(),
  limit: TeamCredentialUsageLimitDefinitionV1Schema.extend({ id: z.string().min(1).optional() }),
}).strict());
export type TeamCredentialUsageLimitDefinitionV1 = z.infer<typeof TeamCredentialUsageLimitDefinitionV1Schema>;
export type TeamCredentialUsageLimitUpsertInputV1 = z.infer<typeof TeamCredentialUsageLimitUpsertInputV1Schema>;

export const TeamCredentialUsageLimitListInputV1Schema = lazyZodSchema(() => z.object({
  resourceId: z.string().min(1),
  cursor: z.string().min(1).max(512).optional(),
  limit: z.number().int().min(1).max(100).default(50),
}).strict());
export const TeamCredentialUsageLimitDeleteInputV1Schema = lazyZodSchema(() => z.object({
  resourceId: z.string().min(1),
  expectedRevision: z.number().int().nonnegative(),
  limitId: z.string().min(1),
}).strict());

export const TeamCredentialUsageLimitListOutputV1Schema = lazyZodSchema(() => z.object({
  limits: z.array(TeamCredentialUsageLimitV1Schema),
  nextCursor: z.string().min(1).max(512).nullable(),
}).strict());
export type TeamCredentialUsageLimitListOutputV1 = z.infer<typeof TeamCredentialUsageLimitListOutputV1Schema>;

export const TeamCredentialUsageLimitUpsertOutputV1Schema = lazyZodSchema(() => z.object({
  resourceId: z.string().min(1),
  revision: z.number().int().nonnegative(),
  limit: TeamCredentialUsageLimitV1Schema,
}).strict());
export type TeamCredentialUsageLimitUpsertOutputV1 = z.infer<typeof TeamCredentialUsageLimitUpsertOutputV1Schema>;

export const TeamCredentialUsageBreakdownDimensionV1Schema = lazyZodSchema(() => z.enum([
  'member',
  'external_api_key',
  'model',
  'session',
  'source_member',
  'worker_machine',
  'broker_machine',
  'delivery_mode',
]));
export type TeamCredentialUsageBreakdownDimensionV1 = z.infer<typeof TeamCredentialUsageBreakdownDimensionV1Schema>;

export const TeamCredentialUsageQueryInputV1Schema = lazyZodSchema(() => z.object({
  resourceId: z.string().min(1),
  startMs: z.number().int().min(0),
  endMs: z.number().int().min(0),
  granularity: UsageAnalyticsGranularitySchema.default('day'),
  costMode: z.enum(['auto', 'reported', 'estimated']).default('auto'),
  breakdown: TeamCredentialUsageBreakdownDimensionV1Schema.optional(),
  cursor: z.string().min(1).max(KEYSET_CURSOR_MAX_LENGTH_V1).optional(),
}).strict().refine((value) => value.endMs >= value.startMs, {
  path: ['endMs'], message: 'endMs must be greater than or equal to startMs',
}));
export type TeamCredentialUsageQueryInputV1 = z.infer<typeof TeamCredentialUsageQueryInputV1Schema>;

export const TeamCredentialUsageTotalsV1Schema = lazyZodSchema(() => z.object({
  eventCount: z.number().int().min(0),
  requestCount: z.number().int().min(0),
  tokens: UsageObservationTokensSchema,
  cost: UsageObservationCostSchema,
}).strict());

export const TeamCredentialUsageCoverageV1Schema = lazyZodSchema(() => z.object({
  requestAdmissionCount: z.number().int().min(0),
  agentObservationCount: z.number().int().min(0),
  externalTerminalObservationCount: z.number().int().min(0),
  directRecordedUseOnly: z.boolean(),
  requestCountCoverage: z.enum(['complete', 'brokered_only']),
  tokenCoverage: z.enum(['complete', 'partial', 'unavailable']),
  costCoverage: z.enum(['complete', 'partial', 'unavailable']),
  unobservedExternalRequestCount: z.number().int().min(0),
}).strict());

export const TeamCredentialUsageQueryResultV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  totals: TeamCredentialUsageTotalsV1Schema,
  coverage: TeamCredentialUsageCoverageV1Schema,
  series: z.array(z.object({
    bucketStartMs: z.number().int().min(0),
    bucketEndMs: z.number().int().min(0),
    totals: TeamCredentialUsageTotalsV1Schema,
  }).strict()),
  breakdown: z.array(z.object({
    key: z.string().min(1),
    label: z.string().min(1).optional(),
    totals: TeamCredentialUsageTotalsV1Schema,
  }).strict()).optional(),
  nextCursor: z.string().min(1).max(KEYSET_CURSOR_MAX_LENGTH_V1).nullable(),
  limits: z.array(TeamCredentialUsageLimitV1Schema),
}).strict());
export type TeamCredentialUsageQueryResultV1 = z.infer<typeof TeamCredentialUsageQueryResultV1Schema>;
