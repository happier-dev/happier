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
  breakdown: z.optional(z.record(z.string(), NonNegativeNumberSchema)),
  effectiveUsd: z.optional(NonNegativeNumberSchema),
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
  promptCache: z.optional(UsagePromptCacheSchema),
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
export const UsageAnalyticsCostModeSchema = lazyZodSchema(() => z.enum(['auto', 'reported', 'estimated', 'api_equivalent']));

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
  breakdowns: z.optional(z.array(UsageAnalyticsBreakdownDimensionSchema).check(z.maxLength(8))),
  filters: z.optional(UsageAnalyticsQueryFiltersSchema),
  includeSeries: z._default(z.boolean(), true),
  includeInsights: z.optional(z.boolean()),
  includeActivity: z.optional(z.boolean()),
  includeLeaders: z.optional(z.boolean()),
  includeModelTimeline: z.optional(z.boolean()),
  includeMessageStats: z.optional(z.boolean()),
  activityResolution: z.optional(z.enum(['calendar', 'weekdayHour', 'both'])),
  topLimit: z._default(z.number().check(z.int(), z.minimum(1), z.maximum(100)), 20),
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
  tokenCategories: z.optional(UsageObservationTokensSchema),
}));
export type UsageAnalyticsQueryResponse = z.infer<typeof UsageAnalyticsQueryResponseSchema>;

/** Opened machine labels belong to authorized client reads, never the server accounting response. */
export const UsageQueryAccountingSchema = lazyZodSchema(() => z.extend(UsageAnalyticsQueryResponseSchema, {
  coverage: z.optional((<T extends zMini.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as zMini.ZodMiniObject<T['shape'], zMini.core.$strict>)(z.extend(UsageAnalyticsCoverageSchema, { sources: z.array((<T extends zMini.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as zMini.ZodMiniObject<T['shape'], zMini.core.$strict>)(z.extend(UsageAnalyticsSourceCoverageSchema, {
    displayLocation: z.optional(z.string().check(z.trim(), z.minLength(1))),
  }))) }))),
}));

export const ServerUsageAnalyticsCapabilitiesSchema = lazyZodSchema(() => z.strictObject({
  version: z.literal(1),
  eventsIngest: z.strictObject({
    path: z.string().check(z.trim(), z.minLength(1)),
  }),
  query: z.strictObject({
    path: z.string().check(z.trim(), z.minLength(1)),
  }),
  legacy: z.strictObject({
    usageReportsPath: z.string().check(z.trim(), z.minLength(1)),
    usageQueryPath: z.string().check(z.trim(), z.minLength(1)),
  }),
}));
export type ServerUsageAnalyticsCapabilities = z.infer<typeof ServerUsageAnalyticsCapabilitiesSchema>;
