import * as zMini from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod/mini';
import { PluginContributionIdentityV1Schema } from '../plugins/contributionIdentity.js';
import { asProtocolZod } from '../plugins/actions/internalProtocolZodAdapter.js';
import { NonBlankOpaqueIdentifierSchema } from '../strings/opaqueIdentifier.js';
import { ProviderConnectionIdSchema, ProviderContributionKeySchema } from '../providers/ids.js';
import { UsageModelPriceCatalogSchema } from './usageModelPriceSchemas.js';
import { QualifiedConnectedAccountRefSchema } from '../connect/qualifiedConnectedAccountPersistence.js';
import { createStoredReadSchema } from '../json/storedReadSchema.js';
import { createCanonicalJsonSigningInput } from '../crypto/canonicalJson.js';
import { projectNativeJsonValueForTransport } from '../json/strictJsonValue.js';
import { UsageAgentCalendarSchema } from './usageAgentCalendar.js';
import { PublicProfileAccountingProjectionSchema } from '../account/publicProfileAccountingContracts.js';
import { UsageAccountingSessionMembershipSchema } from './usageAccountingMembership.js';

const NonNegativeNumberSchema = lazyZodSchema(() => z.number().check(z.minimum(0)));
const OptionalNonEmptyStringSchema = lazyZodSchema(() => z.nullable(z.optional(z.string().check(z.trim(), z.minLength(1)))));

export const UsageObservationScopeSchema = lazyZodSchema(() => z.enum([
  'turn_delta',
  'session_cumulative',
  'session_final',
]));
export type UsageObservationScope = z.infer<typeof UsageObservationScopeSchema>;

export const UsageObservationTokensSchema = lazyZodSchema(() => z.strictObject({
  input: NonNegativeNumberSchema,
  output: NonNegativeNumberSchema,
  reasoning: NonNegativeNumberSchema,
  cacheRead: NonNegativeNumberSchema,
  cacheWrite: NonNegativeNumberSchema,
  total: NonNegativeNumberSchema,
}));
export type UsageObservationTokens = z.infer<typeof UsageObservationTokensSchema>;

export const UsageAnalyticsCostModeSchema = lazyZodSchema(() => z.enum(['auto', 'reported', 'estimated', 'api_equivalent']));

export const UsageObservationCostSchema = lazyZodSchema(() => z.strictObject({
  reportedUsd: NonNegativeNumberSchema,
  estimatedUsd: NonNegativeNumberSchema,
  /** Query projection only; never the authority for vendor-reported or stored estimated costs. */
  apiEquivalentUsd: z.optional(NonNegativeNumberSchema),
  pricingSource: z.optional(z.string().check(z.trim(), z.minLength(1))),
  /** Query-only overlap witness: this row's fallback money is covered by that reported total. */
  reportedTotalId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  /** Query-only scope of a money-only reported total; subsets cannot apportion this charge. */
  reportedTotalContributionIds: z.optional(z.array(z.string().check(z.trim(), z.minLength(1)))),
  invoiceUsd: z.optional(NonNegativeNumberSchema),
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
  currency: z.string().check(z.trim(), z.minLength(1)),
  // Exact-money Symbol provenance is internal; this public map contains only string keys.
  breakdown: z.optional(z.catchall(z.object({}), NonNegativeNumberSchema)),
  effectiveUsd: z.optional(NonNegativeNumberSchema),
  /** Compact query projection only: selected availability survives JSON without report member identities. */
  selectedBasis: z.optional(z.strictObject({ mode: UsageAnalyticsCostModeSchema,
    value: z.nullable(z.strictObject({ kind: z.enum(['reported', 'estimated', 'invoice', 'api_equivalent', 'mixed']),
      currency: z.string().check(z.minLength(1)), source: z.string().check(z.minLength(1)) })) })),
}));
export type UsageObservationCost = z.infer<typeof UsageObservationCostSchema>;

export const UsageObservationContextSchema = lazyZodSchema(() => z.strictObject({
  usedTokens: z.optional(z.nullable(NonNegativeNumberSchema)),
  windowTokens: z.optional(z.nullable(NonNegativeNumberSchema)),
}));
export type UsageObservationContext = z.infer<typeof UsageObservationContextSchema>;

/** Device-keyed identifiers identify native accounting without disclosing source paths. */
export const UsageNativeAccountingSubjectSchema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('native'),
  machineId: z.string().check(z.trim(), z.minLength(1)),
  agent: asProtocolZod(PluginContributionIdentityV1Schema),
  sourceRootKey: NonBlankOpaqueIdentifierSchema,
  nativeSessionKey: NonBlankOpaqueIdentifierSchema,
  linkedSessionId: z.optional(z.string().check(z.trim(), z.minLength(1))),
}));
export type UsageNativeAccountingSubject = z.infer<typeof UsageNativeAccountingSubjectSchema>;

/** Explicit native evidence; lineage and correlation authority remain server-owned. */
export const UsageNativeAccountingEvidenceSchema = lazyZodSchema(() => (<T extends zMini.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as zMini.ZodMiniObject<T['shape'], zMini.core.$strict>)(z.extend(z.pick(UsageAccountingMetadataSchema, {
  historyComplete: true, asOfMs: true, counterEpoch: true, inputIncludesCache: true, outputIncludesReasoning: true,
}), {
  status: z.enum(['available', 'partial']),
  inferenceKey: zMini.optional(NonBlankOpaqueIdentifierSchema),
})));
export type UsageNativeAccountingEvidence = z.infer<typeof UsageNativeAccountingEvidenceSchema>;

export const UsageNativeHistoryDeleteRequestSchema = lazyZodSchema(() => z.strictObject({
  machineId: z.string().check(z.trim(), z.minLength(1)),
  sourceRootKey: NonBlankOpaqueIdentifierSchema,
  dateRange: z.optional(z.strictObject({
    startMs: z.optional(z.number().check(z.int(), z.minimum(0))),
    endMs: z.optional(z.number().check(z.int(), z.minimum(0))),
  }).check(z.refine((range) => range.startMs === undefined || range.endMs === undefined || range.startMs <= range.endMs))),
}));
export type UsageNativeHistoryDeleteRequest = z.infer<typeof UsageNativeHistoryDeleteRequestSchema>;

/** Host-captured request source; never reconstructed from current Session metadata. */
export const UsageRequestAttributionSchema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  turnId: z.string().check(z.trim(), z.minLength(1)),
  source: z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('native'),
      connectedAccount: zMini.nullable(asProtocolZod(QualifiedConnectedAccountRefSchema)),
      /** Native account classification witnessed for this request; omission is unknown. */
      accountScope: z.optional(z.enum(['personal', 'workspace'])),
    }),
    z.strictObject({ kind: z.literal('provider'), providerId: zMini.nullable(ProviderContributionKeySchema), providerConnectionId: ProviderConnectionIdSchema }),
  ]),
}));
export type UsageRequestAttribution = z.infer<typeof UsageRequestAttributionSchema>;

export function readUsageRequestAttribution(metadata: unknown): UsageRequestAttribution | null {
  const parsed = UsageRequestAttributionSchema.safeParse(metadata && typeof metadata === 'object' ? Reflect.get(metadata, 'usageAttribution') : undefined);
  return parsed.success ? parsed.data : null;
}

/** Provider request clock, with a detected cache lifetime only when known. */
export const UsagePromptCacheSchema = lazyZodSchema(() => z.strictObject({
  lastUseAtMs: z.number().check(z.refine(Number.isFinite, 'Expected a finite request clock')),
  ttlMs: z.optional(z.number().check(z.refine((value) => Number.isFinite(value) && value > 0, 'Expected a finite positive cache lifetime'))),
}));
export type UsagePromptCache = z.infer<typeof UsagePromptCacheSchema>;

export const UsageEventIngestRequestSchema = lazyZodSchema(() => z.strictObject({
  sessionId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  subject: z.optional(UsageNativeAccountingSubjectSchema),
  accounting: z.optional(UsageNativeAccountingEvidenceSchema),
  attribution: z.optional(UsageRequestAttributionSchema),
  observedAt: z.number().check(z.int(), z.minimum(0)),
  agentId: z.string().check(z.trim(), z.minLength(1)),
  backendMode: OptionalNonEmptyStringSchema,
  modelId: OptionalNonEmptyStringSchema,
  projectKey: OptionalNonEmptyStringSchema,
  workspaceId: OptionalNonEmptyStringSchema,
  machineId: OptionalNonEmptyStringSchema,
  source: z.string().check(z.trim(), z.minLength(1)),
  scope: UsageObservationScopeSchema,
  externalKey: OptionalNonEmptyStringSchema,
  turnId: OptionalNonEmptyStringSchema,
  isCumulative: z.boolean(),
  tokens: UsageObservationTokensSchema,
  cost: UsageObservationCostSchema,
  context: z.optional(UsageObservationContextSchema),
  promptCache: z.optional(UsagePromptCacheSchema),
  metadata: z.optional(z.record(z.string(), z.unknown())),
}).check(z.superRefine((request, ctx) => {
  if (request.attribution && (request.subject || request.scope !== 'turn_delta' || request.isCumulative || request.turnId !== request.attribution.turnId)) {
    ctx.addIssue({ code: 'custom', path: ['attribution'], message: 'Request attribution requires a matching runtime turn delta.' });
  }
  if (Boolean(request.sessionId) === Boolean(request.subject)) {
    ctx.addIssue({ code: 'custom', path: ['subject'], message: 'Exactly one accounting subject is required.' });
  }
  if (request.subject) {
    if (!request.externalKey) ctx.addIssue({ code: 'custom', path: ['externalKey'], message: 'Native accounting requires replay identity.' });
    if (request.metadata !== undefined) ctx.addIssue({ code: 'custom', path: ['metadata'], message: 'Native accounting does not accept arbitrary metadata.' });
    if (request.machineId && request.machineId !== request.subject.machineId) ctx.addIssue({ code: 'custom', path: ['machineId'], message: 'Machine identity must agree with the subject.' });
    if (request.agentId !== request.subject.agent.localId && request.agentId !== `${request.subject.agent.pluginId}/${request.subject.agent.localId}`) ctx.addIssue({ code: 'custom', path: ['agentId'], message: 'Agent identity must agree with the subject.' });
  }
  if (request.accounting && !request.subject) ctx.addIssue({ code: 'custom', path: ['accounting'], message: 'Native evidence requires a native subject.' });
})));
export type UsageEventIngestRequest = z.infer<typeof UsageEventIngestRequestSchema>;

export const UsageAnalyticsGranularitySchema = lazyZodSchema(() => z.enum([
  'hour',
  'day',
  'week',
  'month',
]));
export type UsageAnalyticsGranularity = z.infer<typeof UsageAnalyticsGranularitySchema>;

/** The one cost-mode vocabulary of the usage query, its presentation and Team credential usage. */

export const UsageAnalyticsBreakdownDimensionSchema = lazyZodSchema(() => z.enum([
  'agent',
  'model',
  'session',
  'project',
  'workspace',
  'backendMode',
  'source',
  'machine',
]));
export type UsageAnalyticsBreakdownDimension = z.infer<typeof UsageAnalyticsBreakdownDimensionSchema>;

export const UsageAnalyticsExecutionSchema = lazyZodSchema(() => z.enum(['happier', 'outside', 'unknown']));

export const UsageAnalyticsQueryFiltersSchema = lazyZodSchema(() => z.strictObject({
  sessionIds: z.optional(z.array(z.string().check(z.trim(), z.minLength(1)))),
  agentIds: z.optional(z.array(z.string().check(z.trim(), z.minLength(1)))),
  modelIds: z.optional(z.array(z.string().check(z.trim(), z.minLength(1)))),
  projectKeys: z.optional(z.array(z.string().check(z.trim(), z.minLength(1)))),
  workspaceIds: z.optional(z.array(z.string().check(z.trim(), z.minLength(1)))),
  backendModes: z.optional(z.array(z.string().check(z.trim(), z.minLength(1)))),
  sources: z.optional(z.array(z.string().check(z.trim(), z.minLength(1)))),
  execution: z.optional(UsageAnalyticsExecutionSchema),
  machineIds: z.optional(z.array(z.string().check(z.trim(), z.minLength(1)))),
}));
export type UsageAnalyticsQueryFilters = z.infer<typeof UsageAnalyticsQueryFiltersSchema>;

export const UsageAnalyticsQueryRequestSchema = lazyZodSchema(() => z.strictObject({
  /** Omitted retains ordinary personal history; public selection requires supporting capability. */
  population: z.optional(z.enum(['all_personal_history', 'public_eligible_personal'])),
  dateRange: z.optional(z.strictObject({
    startMs: z.optional(z.number().check(z.int(), z.minimum(0))),
    endMs: z.optional(z.number().check(z.int(), z.minimum(0))),
  })),
  granularity: z._default(UsageAnalyticsGranularitySchema, 'day'),
  timeZoneOffsetMinutes: z._default(z.number().check(z.int(), z.minimum(-840), z.maximum(840)), 0),
  costMode: z.optional(UsageAnalyticsCostModeSchema),
  breakdowns: z.optional(z.array(UsageAnalyticsBreakdownDimensionSchema).check(z.refine(
    dimensions => new Set(dimensions).size === dimensions.length, 'Breakdown dimensions must be unique'))),
  filters: z.optional(UsageAnalyticsQueryFiltersSchema),
  includeSeries: z._default(z.boolean(), true),
  includeInsights: z.optional(z.boolean()),
  includeActivity: z.optional(z.boolean()),
  includeLeaders: z.optional(z.boolean()),
  includeModelTimeline: z.optional(z.boolean()),
  includeMessageStats: z.optional(z.boolean()),
  activityResolution: z.optional(z.enum(['calendar', 'weekdayHour', 'both'])),
  topLimit: z._default(z.number().check(z.int(), z.minimum(1)), 20),
}));
export type UsageAnalyticsQueryRequest = z.infer<typeof UsageAnalyticsQueryRequestSchema>;

export const UsageAnalyticsTotalsSchema = lazyZodSchema(() => z.strictObject({
  eventCount: z.number().check(z.int(), z.minimum(0)),
  /** Number of admitted inference requests; omitted for legacy/personal responses. */
  requestCount: z.optional(z.number().check(z.int(), z.minimum(0))),
  tokens: UsageObservationTokensSchema,
  cost: UsageObservationCostSchema,
  context: z.optional(UsageObservationContextSchema),
}));
export type UsageAnalyticsTotals = z.infer<typeof UsageAnalyticsTotalsSchema>;

export const UsageAnalyticsSeriesBucketSchema = lazyZodSchema(() => z.strictObject({
  bucketStartMs: z.number().check(z.int(), z.minimum(0)),
  bucketEndMs: z.number().check(z.int(), z.minimum(0)),
  eventCount: z.number().check(z.int(), z.minimum(0)),
  requestCount: z.optional(z.number().check(z.int(), z.minimum(0))),
  tokens: UsageObservationTokensSchema,
  cost: UsageObservationCostSchema,
  context: z.optional(UsageObservationContextSchema),
}));
export type UsageAnalyticsSeriesBucket = z.infer<typeof UsageAnalyticsSeriesBucketSchema>;

export const UsageAnalyticsBreakdownEntrySchema = lazyZodSchema(() => z.strictObject({
  key: z.string().check(z.trim(), z.minLength(1)),
  label: z.optional(z.string().check(z.trim(), z.minLength(1))),
  eventCount: z.number().check(z.int(), z.minimum(0)),
  requestCount: z.optional(z.number().check(z.int(), z.minimum(0))),
  tokens: UsageObservationTokensSchema,
  cost: UsageObservationCostSchema,
  context: z.optional(UsageObservationContextSchema),
  latestContextUsedTokens: z.optional(NonNegativeNumberSchema),
  latestContextWindowTokens: z.optional(NonNegativeNumberSchema),
}));
export type UsageAnalyticsBreakdownEntry = z.infer<typeof UsageAnalyticsBreakdownEntrySchema>;

export const UsageAnalyticsBreakdownsSchema = lazyZodSchema(() => z.strictObject({
  agent: z.optional(z.array(UsageAnalyticsBreakdownEntrySchema)),
  model: z.optional(z.array(UsageAnalyticsBreakdownEntrySchema)),
  session: z.optional(z.array(UsageAnalyticsBreakdownEntrySchema)),
  project: z.optional(z.array(UsageAnalyticsBreakdownEntrySchema)),
  workspace: z.optional(z.array(UsageAnalyticsBreakdownEntrySchema)),
  backendMode: z.optional(z.array(UsageAnalyticsBreakdownEntrySchema)),
  source: z.optional(z.array(UsageAnalyticsBreakdownEntrySchema)),
  machine: z.optional(z.array(UsageAnalyticsBreakdownEntrySchema)),
}));
export type UsageAnalyticsBreakdowns = z.infer<typeof UsageAnalyticsBreakdownsSchema>;

const UsageAnalyticsKeyedLabelSchema = lazyZodSchema(() => z.strictObject({
  key: z.string().check(z.trim(), z.minLength(1)),
  label: z.string().check(z.trim(), z.minLength(1)),
}));

const UsageAnalyticsActivityCalendarDaySchema = lazyZodSchema(() => z.strictObject({
  date: z.string().check(z.trim(), z.minLength(1)),
  eventCount: z.number().check(z.int(), z.minimum(0)),
}));

const UsageAnalyticsActivityWeekdayHourBucketSchema = lazyZodSchema(() => z.strictObject({
  weekday: z.number().check(z.int(), z.minimum(0), z.maximum(6)),
  hour: z.number().check(z.int(), z.minimum(0), z.maximum(23)),
  eventCount: z.number().check(z.int(), z.minimum(0)),
}));

const UsageAnalyticsActivitySchema = lazyZodSchema(() => z.strictObject({
  calendarDays: z.optional(z.array(UsageAnalyticsActivityCalendarDaySchema)),
  weekdayHourBuckets: z.optional(z.array(UsageAnalyticsActivityWeekdayHourBucketSchema)),
}));

const UsageAnalyticsInsightsSchema = lazyZodSchema(() => z.strictObject({
  activeDays: z.number().check(z.int(), z.minimum(0)),
  longestStreakDays: z.number().check(z.int(), z.minimum(0)),
  sessionsUsed: z.number().check(z.int(), z.minimum(0)),
  messagesUsed: z.number().check(z.int(), z.minimum(0)),
  modelsTried: z.number().check(z.int(), z.minimum(0)),
  favoriteModel: z.optional(UsageAnalyticsKeyedLabelSchema),
  favoriteModelChangeCount: z.number().check(z.int(), z.minimum(0)),
  busiestMonth: z.optional(UsageAnalyticsKeyedLabelSchema),
  busiestDay: z.optional(UsageAnalyticsKeyedLabelSchema),
  busiestHour: z.optional(UsageAnalyticsKeyedLabelSchema),
  cacheSavingsUsd: z.optional(NonNegativeNumberSchema),
}));

/** Capture path and execution attribution are independent; native replay can be linked to Happier. */
export const UsageAnalyticsSourceContextSchema = lazyZodSchema(() => z.strictObject({
  path: z.enum(['runtime', 'native', 'legacy', 'unknown']),
  execution: UsageAnalyticsExecutionSchema,
}));
export type UsageAnalyticsSourceContext = z.infer<typeof UsageAnalyticsSourceContextSchema>;

export const UsageAnalyticsTimelineSourceSchema = lazyZodSchema(() => (<T extends zMini.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as zMini.ZodMiniObject<T['shape'], zMini.core.$strict>)(z.extend(UsageAnalyticsSourceContextSchema, {
  source: z.string().check(z.trim(), z.minLength(1)),
  eventCount: z.number().check(z.int(), z.minimum(0)),
  tokens: UsageObservationTokensSchema,
  cost: UsageObservationCostSchema,
})));
export type UsageAnalyticsTimelineSource = z.infer<typeof UsageAnalyticsTimelineSourceSchema>;

const UsageAnalyticsLeaderSchema = lazyZodSchema(() => z.strictObject({
  key: z.string().check(z.trim(), z.minLength(1)),
  label: z.optional(z.string().check(z.trim(), z.minLength(1))),
  eventCount: z.number().check(z.int(), z.minimum(0)),
  tokens: z.optional(UsageObservationTokensSchema),
  cost: z.optional(UsageObservationCostSchema),
  /** Only timeline leaders carry source partitions; older responses may omit them. */
  sources: z.optional(z.array(UsageAnalyticsTimelineSourceSchema)),
}));

const UsageAnalyticsLeadersSchema = lazyZodSchema(() => z.strictObject({
  agents: z.optional(z.array(UsageAnalyticsLeaderSchema)),
  models: z.optional(z.array(UsageAnalyticsLeaderSchema)),
  sessions: z.optional(z.array(UsageAnalyticsLeaderSchema)),
  projects: z.optional(z.array(UsageAnalyticsLeaderSchema)),
  workspaces: z.optional(z.array(UsageAnalyticsLeaderSchema)),
  engines: z.optional(z.array(UsageAnalyticsLeaderSchema)),
}));

const UsageAnalyticsTimelineLeaderBucketSchema = lazyZodSchema(() => z.strictObject({
  bucketStartMs: z.number().check(z.int(), z.minimum(0)),
  bucketEndMs: z.number().check(z.int(), z.minimum(0)),
  leaders: z.array(UsageAnalyticsLeaderSchema),
}));

const UsageAnalyticsMessageStatsSchema = lazyZodSchema(() => z.strictObject({
  /** Usage-contributing sessions selected by the query; identical to insights.sessionsUsed when insights are present. */
  sessionCount: z.number().check(z.int(), z.minimum(0)),
  /** Messages created in those sessions within the query's date window. */
  messageCount: z.number().check(z.int(), z.minimum(0)),
}));

const UsageAnalyticsCostPresentationSchema = lazyZodSchema(() => z.strictObject({
  mode: UsageAnalyticsCostModeSchema,
  effectiveUsd: NonNegativeNumberSchema,
  currency: z.string().check(z.trim(), z.minLength(1)),
  source: z.string().check(z.trim(), z.minLength(1)),
}));

export const UsageAccountingMetadataSchema = lazyZodSchema(() => z.strictObject({
  path: z.optional(z.enum(['runtime', 'native', 'legacy', 'unknown'])),
  status: z.optional(z.enum(['available', 'partial', 'unknown', 'unsupported', 'pending', 'error'])),
  historyComplete: z.optional(z.boolean()),
  asOfMs: z.optional(z.number().check(z.int(), z.minimum(0))),
  nativeSessionId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  inferenceId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  counterEpoch: z.optional(z.string().check(z.trim(), z.minLength(1))),
  /** Existing host runtime ordering, only comparable within that incarnation. */
  runtimeEventOrder: z.optional(z.strictObject({
    runtimeIncarnationId: z.string().check(z.trim(), z.minLength(1)),
    sequence: z.number().check(z.int(), z.minimum(0)),
  })),
  inputIncludesCache: z.optional(z.boolean()),
  outputIncludesReasoning: z.optional(z.boolean()),
}));
export type UsageAccountingMetadata = z.infer<typeof UsageAccountingMetadataSchema>;

const StoredUsageAccountingMetadataSchema = createStoredReadSchema(UsageAccountingMetadataSchema);

/** Stored diagnostic read projection: drop extras, never infer admission authority. */
export function readUsageAccountingMetadata(metadata: unknown): UsageAccountingMetadata | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const value = Reflect.get(metadata, 'usageAccounting');
  const result = StoredUsageAccountingMetadataSchema.safeParse(value);
  return result.success ? result.data : null;
}

export const UsageAccountingCoverageReasonSchema = lazyZodSchema(() => z.enum([
  'missing_baseline', 'counter_discontinuity', 'ambiguous_overlap', 'unattributed_model',
  'unpriced_tokens', 'unknown_source', 'incomplete_history', 'ranked_truncation',
  'unknown_token_categories',
]));
export type UsageAccountingCoverageReason = z.infer<typeof UsageAccountingCoverageReasonSchema>;

export const UsageAnalyticsCostFactKindSchema = lazyZodSchema(() => z.enum([
  'reported', 'estimated', 'api_equivalent', 'invoice', 'unpriced',
]));
export type UsageAnalyticsCostFactKind = z.infer<typeof UsageAnalyticsCostFactKindSchema>;

/** Monetary truth independent of the private accounting source identity. */
export const UsageAnalyticsCostFactValueSchema = lazyZodSchema(() => z.strictObject({
  kind: UsageAnalyticsCostFactKindSchema,
  currency: z.string().check(z.trim(), z.minLength(1)),
  amountUsd: z.nullable(NonNegativeNumberSchema),
  tokens: UsageObservationTokensSchema,
  eventCount: z.number().check(z.int(), z.minimum(0)),
  asOfMs: z.number().check(z.int(), z.minimum(0)),
  complete: z.boolean(),
}).check(z.superRefine((fact, ctx) => {
  if ((fact.kind === 'unpriced') !== (fact.amountUsd === null)) {
    ctx.addIssue({ code: 'custom', path: ['amountUsd'], message: 'Unpriced facts require null money; monetary facts require an amount' });
  }
})));
export const UsageAnalyticsCostFactSchema = lazyZodSchema(() => z.safeExtend(UsageAnalyticsCostFactValueSchema, {
  source: z.string().check(z.trim(), z.minLength(1)),
}));
export type UsageAnalyticsCostFact = z.infer<typeof UsageAnalyticsCostFactSchema>;

/** Server-queryable provenance contains witnessed identities, never machine names or filesystem locations. */
export const UsageAnalyticsSourceCoverageSchema = lazyZodSchema(() => z.strictObject({
    source: z.string().check(z.trim(), z.minLength(1)),
    path: z.enum(['runtime', 'native', 'legacy', 'unknown']),
    status: z.enum(['available', 'partial', 'unknown', 'unsupported', 'pending', 'error']),
    machineId: z.optional(z.string().check(z.trim(), z.minLength(1))),
    captureKind: z.optional(z.enum(['measured', 'from_logs', 'not_added'])),
    asOfMs: z.optional(z.number().check(z.int(), z.minimum(0))),
    eventCount: z.number().check(z.int(), z.minimum(0)),
    historyComplete: z.optional(z.boolean()),
}));

export const UsageAnalyticsCoverageSchema = lazyZodSchema(() => z.strictObject({
  status: z.enum(['complete', 'partial', 'unknown']),
  reasons: z.array(UsageAccountingCoverageReasonSchema),
  sources: z.array(UsageAnalyticsSourceCoverageSchema),
  missingDimensions: z.array(UsageAnalyticsBreakdownDimensionSchema),
  range: z.strictObject({
    startMs: z.optional(z.number().check(z.int(), z.minimum(0))),
    endMs: z.optional(z.number().check(z.int(), z.minimum(0))),
    complete: z.boolean(),
  }),
  ranked: z.array(z.strictObject({
    dimension: UsageAnalyticsBreakdownDimensionSchema,
    totalEntries: z.number().check(z.int(), z.minimum(0)),
    returnedEntries: z.number().check(z.int(), z.minimum(0)),
    complete: z.boolean(),
  })),
}));
export type UsageAnalyticsCoverage = z.infer<typeof UsageAnalyticsCoverageSchema>;

export const UsageAnalyticsContributionSchema = lazyZodSchema(() => z.strictObject({
  id: z.string().check(z.trim(), z.minLength(1)),
  eventCount: z.optional(z.number().check(z.int(), z.minimum(0))),
  context: z.optional(UsageObservationContextSchema),
  observedAtMs: z.number().check(z.int(), z.minimum(0)),
  sessionId: z.nullable(z.string().check(z.trim(), z.minLength(1))),
  turnId: z.nullable(z.string().check(z.trim(), z.minLength(1))),
  agentId: z.nullable(z.string().check(z.trim(), z.minLength(1))),
  modelId: z.nullable(z.string().check(z.trim(), z.minLength(1))),
  // Applied model-source identity, never inferred from Agent or model labels.
  backendMode: z.optional(z.nullable(z.string().check(z.trim(), z.minLength(1)))),
  providerId: zMini.optional(zMini.nullable(ProviderContributionKeySchema)),
  providerConnectionId: zMini.optional(zMini.nullable(zMini.pipe(ProviderConnectionIdSchema, zMini.transform(value => String(value))))),
  /** Missing older responses remain unknown, including a null connection dimension. */
  /** Response-bound source certainty; absent and current-metadata-only dimensions are unknown. */
  providerAttribution: z.optional(z.enum(['known', 'unknown'])),
  providerSource: z.optional(z.enum(['native', 'provider', 'unknown'])),
  connectedAccount: zMini.optional(zMini.nullable(asProtocolZod(QualifiedConnectedAccountRefSchema))),
  machineId: z.nullable(z.string().check(z.trim(), z.minLength(1))),
  projectKey: z.nullable(z.string().check(z.trim(), z.minLength(1))),
  workspaceId: z.nullable(z.string().check(z.trim(), z.minLength(1))),
  source: z.nullable(z.string().check(z.trim(), z.minLength(1))),
  sourceContext: z.optional(UsageAnalyticsSourceContextSchema),
  tokens: UsageObservationTokensSchema,
  tokenCategories: z.optional(UsageObservationTokensSchema),
  cost: UsageObservationCostSchema,
}));
export type UsageAnalyticsContribution = z.infer<typeof UsageAnalyticsContributionSchema>;

const UsageExactDecimalSchema = lazyZodSchema(() => z.strictObject({ units: z.string().check(z.regex(/^-?\d+$/)),
  scale: z.number().check(z.int(), z.nonnegative()) }));
const UsagePricingSelectionStateSchema = lazyZodSchema(() => z.enum(['plain', 'covered', 'unavailable', 'total']));
/** Tariff-linear sufficient statistics, never observation or Session identities. */
export const UsagePricingPopulationSchema = lazyZodSchema(() => z.strictObject({ groups: z.array(z.strictObject({
  modelId: z.nullable(z.string()), categories: z.nullable(UsageObservationTokensSchema),
  categoryUnits: z.record(z.string(), UsageExactDecimalSchema), cost: UsageObservationCostSchema,
  costUnits: z.record(z.string(), UsageExactDecimalSchema),
  tokens: UsageObservationTokensSchema,
  contributionCount: z.number().check(z.int(), z.nonnegative()), eventCount: z.number().check(z.int(), z.nonnegative()),
  asOfMs: z.number(), complete: z.boolean(),
  selection: z.strictObject({ auto: UsagePricingSelectionStateSchema, reported: UsagePricingSelectionStateSchema,
    estimated: UsagePricingSelectionStateSchema }),
})) }));
export type UsagePricingPopulation = z.infer<typeof UsagePricingPopulationSchema>;

/** Rendered facts and grouped tariff operands for local private repricing. */
export const UsageAnalyticsSummarySchema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1), catalogRevision: z.string(), costMode: UsageAnalyticsCostModeSchema,
  /** Actual observation bounds, retained without event rows for all-time presentation. */
  observationRange: z.optional(z.strictObject({ startMs: z.number().check(z.int(), z.nonnegative()),
    endMs: z.number().check(z.int(), z.nonnegative()) })),
  pricing: z.optional(z.record(z.string(), UsagePricingPopulationSchema)),
  countedPricing: z.optional(z.boolean()),
  rankedPricing: z.optional(z.record(z.string(), z.array(z.strictObject({ value: z.omit(UsageAnalyticsBreakdownEntrySchema, { cost: true }),
    population: UsagePricingPopulationSchema, sources: z.optional(z.array(z.strictObject({
      value: z.omit(UsageAnalyticsTimelineSourceSchema, { cost: true }), population: UsagePricingPopulationSchema }))) })))),
  accountingCalendar: z.optional(z.strictObject({ value: UsageAgentCalendarSchema,
    pricing: z.optional(z.record(z.string(), UsagePricingPopulationSchema)) })),
  publicProfileAccounting: z.optional(PublicProfileAccountingProjectionSchema),
  accounts: z.strictObject({ unknownContributionCount: z.number().check(z.int(), z.nonnegative()),
    values: z.array(z.strictObject({ ref: asProtocolZod(QualifiedConnectedAccountRefSchema),
      contributionCount: z.number().check(z.int(), z.nonnegative()), pricedContributionCount: z.number().check(z.int(), z.nonnegative()),
      apiEquivalentUsd: NonNegativeNumberSchema, pricingSources: z.array(z.string().check(z.minLength(1))) })) }),
  execution: z.strictObject({ coverage: z.enum(['complete', 'partial', 'unknown']), totalTokens: z.nullable(NonNegativeNumberSchema),
    groups: z.array(z.strictObject({ execution: UsageAnalyticsExecutionSchema, tokens: NonNegativeNumberSchema,
      share: z.nullable(NonNegativeNumberSchema) })) }),
}));
export type UsageAnalyticsSummary = z.infer<typeof UsageAnalyticsSummarySchema>;

export const UsageAnalyticsQueryResponseSchema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  totals: UsageAnalyticsTotalsSchema,
  series: z.optional(z.array(UsageAnalyticsSeriesBucketSchema)),
  breakdowns: z.optional(UsageAnalyticsBreakdownsSchema),
  insights: z.optional(UsageAnalyticsInsightsSchema),
  activity: z.optional(UsageAnalyticsActivitySchema),
  leaders: z.optional(UsageAnalyticsLeadersSchema),
  modelTimeline: z.optional(z.array(UsageAnalyticsTimelineLeaderBucketSchema)),
  engineTimeline: z.optional(z.array(UsageAnalyticsTimelineLeaderBucketSchema)),
  messageStats: z.optional(UsageAnalyticsMessageStatsSchema),
  costPresentation: z.optional(UsageAnalyticsCostPresentationSchema),
  costFacts: z.optional(z.array(UsageAnalyticsCostFactSchema)),
  priceCatalog: zMini.optional(UsageModelPriceCatalogSchema),
  coverage: z.optional(UsageAnalyticsCoverageSchema),
  contributions: z.optional(z.array(UsageAnalyticsContributionSchema)),
  /** Contributing Session membership, supplied only to an active private-evidence reader. */
  sessionIds: z.optional(z.array(z.string().check(z.minLength(1)))),
  /** Historical turn membership for private projections, without per-event accounting or prices. */
  sessionMembership: z.optional(UsageAccountingSessionMembershipSchema),
  summary: z.optional(UsageAnalyticsSummarySchema),
  tokenCategories: z.optional(UsageObservationTokensSchema),
}));
export type UsageAnalyticsQueryResponse = z.infer<typeof UsageAnalyticsQueryResponseSchema>;

/** One accounting acquisition for a page's distinct slices. Raw rows are opt-in. */
export const UsageAnalyticsQueryBatchRequestSchema = lazyZodSchema(() => z.strictObject({
  queries: z.array(UsageAnalyticsQueryRequestSchema).check(z.minLength(1)),
  includeContributions: z._default(z.boolean(), false),
  /** Presence selects summary delivery; only these visible detail consumers receive row pages. */
  contributionQueries: z.optional(z.array(UsageAnalyticsQueryRequestSchema)),
  sessionQueries: z.optional(z.array(UsageAnalyticsQueryRequestSchema)),
  /** JSON callers can continue detail; NDJSON carries all pages from one captured read. */
  contributionOffset: z.optional(z.number().check(z.int(), z.minimum(0))),
}).check(z.refine(input => {
  if (input.contributionQueries === undefined) return input.contributionOffset === undefined && input.sessionQueries === undefined;
  if (input.includeContributions) return false;
  const queries = new Set(input.queries.map(getUsageAnalyticsQueryRequestKey));
  return [...input.contributionQueries, ...(input.sessionQueries ?? [])].every(query => queries.has(getUsageAnalyticsQueryRequestKey(query)));
}, 'Contribution demand must select queries in this summary batch')));
export type UsageAnalyticsQueryBatchRequest = z.infer<typeof UsageAnalyticsQueryBatchRequestSchema>;

/** Page-local references only: no dictionary survives a line or changes row semantics. */
const UsageContributionDictionarySchema = lazyZodSchema(() => z.strictObject({
  fields: z.array(z.keyof(UsageAnalyticsContributionSchema)),
  values: z.array(z.unknown()),
  indices: z.array(z.array(z.nullable(z.number()))),
}).check(z.refine(page => new Set(page.fields).size === page.fields.length
  && page.indices.every(row => row.length === page.fields.length
    && row.every(index => index === null || (Number.isSafeInteger(index) && index >= 0 && index < page.values.length))),
  'Invalid contribution dictionary')));
const UsageContributionPageRowsSchema = lazyZodSchema(() => z.union([
  z.array(UsageAnalyticsContributionSchema),
  z.pipe(z.pipe(UsageContributionDictionarySchema, z.transform(page => page.indices.map(row => {
    const contribution: Record<string, unknown> = {};
    for (let column = 0; column < page.fields.length; column++) {
      const index = row[column];
      if (index !== null) contribution[page.fields[column]!] = page.values[index!];
    }
    return contribution;
  }))),
  z.array(UsageAnalyticsContributionSchema)),
]));
export const UsageAnalyticsQueryBatchResponseSchema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  // A tariff belongs to the acquisition, never copied into every slice.
  priceCatalog: z.optional(UsageModelPriceCatalogSchema),
  results: z.array(z.union([
    z.strictObject({ query: UsageAnalyticsQueryRequestSchema, value: z.omit(UsageAnalyticsQueryResponseSchema, { priceCatalog: true }) }),
    z.strictObject({ query: UsageAnalyticsQueryRequestSchema, error: z.enum(['not_found', 'usage_query_failed']) }),
  ])),
  contributionPages: z.optional(z.array(z.strictObject({
    query: UsageAnalyticsQueryRequestSchema,
    offset: z.number().check(z.int(), z.minimum(0)),
    totalCount: z.number().check(z.int(), z.minimum(0)),
    nextOffset: z.nullable(z.number().check(z.int(), z.minimum(0))),
    rows: UsageContributionPageRowsSchema,
  }))),
}));
export type UsageAnalyticsQueryBatchResponse = z.infer<typeof UsageAnalyticsQueryBatchResponseSchema>;
export type UsageAnalyticsQueryBatchWireResponse = z.input<typeof UsageAnalyticsQueryBatchResponseSchema>;

type UsageValidationIssue = Readonly<{ code: string; path: readonly PropertyKey[];
  errors?: readonly (readonly UsageValidationIssue[])[] }>;
export type UsageQueryResultIssue = { code: string; path: Array<string | number> };

function usageIssuePathSchemas(schema: z.core.$ZodType): z.core.$ZodTypes[] {
  // Zod Core's discriminated definitions supply the admitted schema structure.
  const typed = schema as z.core.$ZodTypes;
  const definition = typed._zod.def;
  if (definition.type === 'lazy') return usageIssuePathSchemas(definition.getter());
  if ('innerType' in definition) return usageIssuePathSchemas(definition.innerType);
  if (definition.type === 'union') return definition.options.flatMap(usageIssuePathSchemas);
  if (definition.type === 'intersection') return [definition.left, definition.right].flatMap(usageIssuePathSchemas);
  if (definition.type === 'pipe') return [definition.in, definition.out].flatMap(usageIssuePathSchemas);
  return [typed];
}

/** Keep declared field names/array indexes, never dictionary keys from response content. */
function publicUsageIssuePath(schema: z.core.$ZodType, path: readonly PropertyKey[]): Array<string | number> {
  let schemas = usageIssuePathSchemas(schema);
  return path.map(part => {
    const children = schemas.flatMap((candidate): Array<{ schema: z.core.$ZodType; declared: boolean }> => {
      const definition = candidate._zod.def;
      if (definition.type === 'object' && typeof part === 'string') {
        const child = Object.prototype.hasOwnProperty.call(definition.shape, part) ? definition.shape[part] : undefined;
        if (child) return [{ schema: child, declared: true }];
        if (definition.catchall) return [{ schema: definition.catchall, declared: false }];
      }
      if (definition.type === 'array' && typeof part === 'number') return [{ schema: definition.element, declared: true }];
      if (definition.type === 'tuple' && typeof part === 'number') {
        const child = definition.items[part] ?? definition.rest;
        if (child) return [{ schema: child, declared: true }];
      }
      if (definition.type === 'record') return [{ schema: definition.valueType, declared: false }];
      return [];
    });
    schemas = children.flatMap(child => usageIssuePathSchemas(child.schema));
    return children.some(child => child.declared) && typeof part !== 'symbol' ? part : '*';
  });
}

/** Content-free validation evidence: codes and schema paths, never rejected data or prose. */
export function projectUsageQueryResultIssues(issues: readonly UsageValidationIssue[], schema: z.core.$ZodType): UsageQueryResultIssue[] {
  const flatten = (selected: readonly UsageValidationIssue[], prefix: readonly PropertyKey[]): UsageQueryResultIssue[] =>
    selected.flatMap(issue => {
      const path = [...prefix, ...issue.path];
      return issue.code === 'invalid_union' && issue.errors
        ? issue.errors.flatMap(branch => flatten(branch, path))
        : [{ code: issue.code, path: publicUsageIssuePath(schema, path) }];
    });
  return flatten(issues, []);
}

/** Inputs have been admitted by the request schema; identity adds no second parser. */
export function getUsageAnalyticsQueryRequestKey(query: UsageAnalyticsQueryRequest): string {
  return createCanonicalJsonSigningInput(projectNativeJsonValueForTransport(query));
}

/** Opened machine labels belong to authorized client reads, never the server accounting response. */
export const UsageQueryAccountingSchema = lazyZodSchema(() => z.extend(UsageAnalyticsQueryResponseSchema, {
  coverage: z.optional((<T extends zMini.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as zMini.ZodMiniObject<T['shape'], zMini.core.$strict>)(z.extend(UsageAnalyticsCoverageSchema, { sources: z.array((<T extends zMini.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as zMini.ZodMiniObject<T['shape'], zMini.core.$strict>)(z.extend(UsageAnalyticsSourceCoverageSchema, {
    displayLocation: z.optional(z.string().check(z.trim(), z.minLength(1))),
  }))) }))),
}));

export const ServerUsageAnalyticsCapabilitiesSchema = lazyZodSchema(() => z.object({
  version: z.literal(1),
  eventsIngest: z.object({
    path: z.string().check(z.trim(), z.minLength(1)),
  }),
  query: z.object({
    path: z.string().check(z.trim(), z.minLength(1)),
  }),
  legacy: z.object({
    usageReportsPath: z.string().check(z.trim(), z.minLength(1)),
    usageQueryPath: z.string().check(z.trim(), z.minLength(1)),
  }),
}));
export type ServerUsageAnalyticsCapabilities = z.infer<typeof ServerUsageAnalyticsCapabilitiesSchema>;
