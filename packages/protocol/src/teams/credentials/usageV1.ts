import { lazyZodSchema } from '../../lazyZodSchema.js';
import { PrivateLabelReadV1Schema } from '../../crypto/privateLabelV1.js';
import { z } from '../../zodRuntimePolicy.js';

import { KEYSET_CURSOR_MAX_LENGTH_V1 } from '../../pagination/keysetCursorV1.js';
import {
  UsageAnalyticsCostModeSchema,
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
export const TeamCredentialUsageCapabilitiesV1Schema = lazyZodSchema(() => z.strictObject({
  inferenceRequests: z.enum(['available', 'unavailable']),
  totalTokens: z.enum(['available', 'unavailable']),
  costUsd: z.enum(['available', 'unavailable']),
  /** Limits are enforced only before brokered Provider requests. Directly
   * disclosed material cannot be observed or constrained by the Home. */
  limitCoverage: z.enum(['brokered_only', 'unavailable']),
}));
export type TeamCredentialUsageCapabilitiesV1 = z.infer<typeof TeamCredentialUsageCapabilitiesV1Schema>;

/** Recipient-safe exhaustion facts. Limit identity, audience, maximum and
 * other members' recorded use stay manager-private. */
export const TeamCredentialUsageLimitDenialV1Schema = lazyZodSchema(() => z.strictObject({
  metric: TeamCredentialUsageLimitMetricV1Schema,
  remaining: z.string().check(z.regex(/^(?:0|[1-9]\d*)(?:\.\d{1,8})?$/u, 'remaining must be a canonical decimal')),
  resetsAtUtc: z.string().check(z.iso.datetime({ offset: true })),
}));
export type TeamCredentialUsageLimitDenialV1 = z.infer<typeof TeamCredentialUsageLimitDenialV1Schema>;

const DecimalValueV1Schema = lazyZodSchema(() => z.string().check(z.regex(/^(?:0|[1-9]\d*)(?:\.\d{1,8})?$/u, 'value must be a canonical decimal')));
const DecimalMaximumV1Schema = lazyZodSchema(() => DecimalValueV1Schema.check(z.refine((value) => Number(value) > 0, 'maximum must be positive')));

export const TeamCredentialUsageLimitV1Schema = lazyZodSchema(() => z.strictObject({
  id: z.string().check(z.minLength(1)),
  subjectKind: TeamCredentialUsageLimitSubjectKindV1Schema,
  subjectId: z.string(),
  period: TeamCredentialUsageLimitPeriodV1Schema,
  metric: TeamCredentialUsageLimitMetricV1Schema,
  maximum: DecimalMaximumV1Schema,
  enabled: z.boolean(),
  currentWindow: z.strictObject({
    recorded: DecimalValueV1Schema,
    resetsAtUtc: z.string().check(z.iso.datetime({ offset: true })),
  }),
}));
export type TeamCredentialUsageLimitV1 = z.infer<typeof TeamCredentialUsageLimitV1Schema>;

export const TeamCredentialUsageLimitDefinitionV1Schema = lazyZodSchema(() => z.strictObject({
  subjectKind: TeamCredentialUsageLimitSubjectKindV1Schema,
  subjectId: z.string(),
  period: TeamCredentialUsageLimitPeriodV1Schema,
  metric: TeamCredentialUsageLimitMetricV1Schema,
  maximum: DecimalMaximumV1Schema,
  enabled: z.boolean(),
}).check(z.superRefine((value, ctx) => {
  if ((value.subjectKind === 'resource' || value.subjectKind === 'each_member') && value.subjectId !== '') {
    ctx.addIssue({ code: "custom", path: ['subjectId'], message: 'subjectId must be empty for this audience' });
  }
  if ((value.subjectKind === 'team_group' || value.subjectKind === 'team_member') && value.subjectId.trim() === '') {
    ctx.addIssue({ code: "custom", path: ['subjectId'], message: 'subjectId is required for this audience' });
  }
  if (value.metric === 'inference_requests' || value.metric === 'total_tokens') {
    if (!/^\d+$/u.test(value.maximum)) {
      ctx.addIssue({ code: "custom", path: ['maximum'], message: 'request and token ceilings must be integers' });
    }
  }
})));

export const TeamCredentialUsageLimitUpsertInputV1Schema = lazyZodSchema(() => z.strictObject({
  resourceId: z.string().check(z.minLength(1)),
  expectedRevision: z.number().check(z.int(), z.nonnegative()),
  limit: z.extend(TeamCredentialUsageLimitDefinitionV1Schema, { id: z.optional(z.string().check(z.minLength(1))) }),
}));
export type TeamCredentialUsageLimitDefinitionV1 = z.infer<typeof TeamCredentialUsageLimitDefinitionV1Schema>;
export type TeamCredentialUsageLimitUpsertInputV1 = z.infer<typeof TeamCredentialUsageLimitUpsertInputV1Schema>;

export const TeamCredentialUsageLimitListInputV1Schema = lazyZodSchema(() => z.strictObject({
  resourceId: z.string().check(z.minLength(1)),
  cursor: z.optional(z.string().check(z.minLength(1), z.maxLength(512))),
  limit: z._default(z.number().check(z.int(), z.minimum(1), z.maximum(100)), 50),
}));
export const TeamCredentialUsageLimitDeleteInputV1Schema = lazyZodSchema(() => z.strictObject({
  resourceId: z.string().check(z.minLength(1)),
  expectedRevision: z.number().check(z.int(), z.nonnegative()),
  limitId: z.string().check(z.minLength(1)),
}));

export const TeamCredentialUsageLimitListOutputV1Schema = lazyZodSchema(() => z.strictObject({
  limits: z.array(TeamCredentialUsageLimitV1Schema),
  nextCursor: z.nullable(z.string().check(z.minLength(1), z.maxLength(512))),
}));
export type TeamCredentialUsageLimitListOutputV1 = z.infer<typeof TeamCredentialUsageLimitListOutputV1Schema>;

export const TeamCredentialUsageLimitUpsertOutputV1Schema = lazyZodSchema(() => z.strictObject({
  resourceId: z.string().check(z.minLength(1)),
  revision: z.number().check(z.int(), z.nonnegative()),
  limit: TeamCredentialUsageLimitV1Schema,
}));
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

export const TeamCredentialUsageQueryInputV1Schema = lazyZodSchema(() => z.strictObject({
  resourceId: z.optional(z.string().check(z.minLength(1))),
  subject: z.optional(z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('team'), teamId: z.string().check(z.minLength(1)) }),
    z.strictObject({ kind: z.literal('home') }),
  ])),
  startMs: z.number().check(z.int(), z.minimum(0)),
  endMs: z.number().check(z.int(), z.minimum(0)),
  granularity: z._default(UsageAnalyticsGranularitySchema, 'day'),
  costMode: z._default(UsageAnalyticsCostModeSchema, 'auto'),
  breakdown: z.optional(TeamCredentialUsageBreakdownDimensionV1Schema),
  cursor: z.optional(z.string().check(z.minLength(1), z.maxLength(KEYSET_CURSOR_MAX_LENGTH_V1))),
}).check(z.refine((value) => (value.resourceId === undefined) !== (value.subject === undefined), {
  path: ['subject'], message: 'Choose exactly one resource or aggregate subject',
}), z.refine((value) => value.endMs >= value.startMs, {
  path: ['endMs'], message: 'endMs must be greater than or equal to startMs',
})));
export type TeamCredentialUsageQueryInputV1 = z.infer<typeof TeamCredentialUsageQueryInputV1Schema>;

export const TeamCredentialUsageTotalsV1Schema = lazyZodSchema(() => z.strictObject({
  eventCount: z.number().check(z.int(), z.minimum(0)),
  requestCount: z.number().check(z.int(), z.minimum(0)),
  tokens: UsageObservationTokensSchema,
  cost: UsageObservationCostSchema,
}));

export const TeamCredentialUsageCoverageV1Schema = lazyZodSchema(() => z.strictObject({
  requestAdmissionCount: z.number().check(z.int(), z.minimum(0)),
  agentObservationCount: z.number().check(z.int(), z.minimum(0)),
  externalTerminalObservationCount: z.number().check(z.int(), z.minimum(0)),
  directRecordedUseOnly: z.boolean(),
  requestCountCoverage: z.enum(['complete', 'brokered_only']),
  tokenCoverage: z.enum(['complete', 'partial', 'unavailable']),
  costCoverage: z.enum(['complete', 'partial', 'unavailable']),
  unobservedExternalRequestCount: z.number().check(z.int(), z.minimum(0)),
}));

export const TeamCredentialUsageQueryResultV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  /** Recipient-only label for a single resource query; aggregate subjects have none. */
  resourceDisplayName: z.optional(PrivateLabelReadV1Schema),
  totals: TeamCredentialUsageTotalsV1Schema,
  coverage: TeamCredentialUsageCoverageV1Schema,
  series: z.array(z.strictObject({
    bucketStartMs: z.number().check(z.int(), z.minimum(0)),
    bucketEndMs: z.number().check(z.int(), z.minimum(0)),
    totals: TeamCredentialUsageTotalsV1Schema,
  })),
  breakdown: z.optional(z.array(z.strictObject({
    key: z.string().check(z.minLength(1)),
    label: z.optional(z.string().check(z.minLength(1))),
    /** Present only for recipient-projected external API-key labels. */
    privateLabel: z.optional(PrivateLabelReadV1Schema),
    totals: TeamCredentialUsageTotalsV1Schema,
  }))),
  nextCursor: z.nullable(z.string().check(z.minLength(1), z.maxLength(KEYSET_CURSOR_MAX_LENGTH_V1))),
  limits: z.array(TeamCredentialUsageLimitV1Schema),
}));
export type TeamCredentialUsageQueryResultV1 = z.infer<typeof TeamCredentialUsageQueryResultV1Schema>;

/** UI and file exports retain the same ranked identities and latest Home totals across pages. */
export function mergeTeamCredentialUsagePages(
  previous: TeamCredentialUsageQueryResultV1,
  next: TeamCredentialUsageQueryResultV1,
): TeamCredentialUsageQueryResultV1 {
  const series = new Map(previous.series.map(entry => [`${entry.bucketStartMs}:${entry.bucketEndMs}`, entry] as const));
  for (const entry of next.series) series.set(`${entry.bucketStartMs}:${entry.bucketEndMs}`, entry);
  const breakdown = new Map((previous.breakdown ?? []).map(entry => [entry.key, entry] as const));
  for (const entry of next.breakdown ?? []) breakdown.set(entry.key, entry);
  return Object.freeze({ ...next, series: [...series.values()],
    ...(previous.breakdown !== undefined || next.breakdown !== undefined ? { breakdown: [...breakdown.values()] } : {}),
  });
}
