import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';

const NonNegativeNumberSchema = lazyZodSchema(() => z.number().finite().min(0));
const OptionalNonEmptyStringSchema = lazyZodSchema(() => z.string().trim().min(1).optional().nullable());

export const UsageObservationScopeSchema = lazyZodSchema(() => z.enum([
  'turn_delta',
  'session_cumulative',
  'session_final',
]));
export type UsageObservationScope = z.infer<typeof UsageObservationScopeSchema>;

export const UsageObservationTokensSchema = lazyZodSchema(() => z.object({
  input: NonNegativeNumberSchema,
  output: NonNegativeNumberSchema,
  reasoning: NonNegativeNumberSchema,
  cacheRead: NonNegativeNumberSchema,
  cacheWrite: NonNegativeNumberSchema,
  total: NonNegativeNumberSchema,
}).strict());
export type UsageObservationTokens = z.infer<typeof UsageObservationTokensSchema>;

export const UsageObservationCostSchema = lazyZodSchema(() => z.object({
  reportedUsd: NonNegativeNumberSchema,
  estimatedUsd: NonNegativeNumberSchema,
  invoiceUsd: NonNegativeNumberSchema.optional(),
  billingContext: z.enum([
    'api_usage',
    'subscription_included',
    'subscription_with_possible_overage',
    'unknown',
  ]).optional(),
  costSource: z.enum([
    'provider_reported',
    'provider_reported_api_equivalent',
    'pricing_estimate',
    'invoice',
    'none',
  ]).optional(),
  currency: z.string().trim().min(1),
  breakdown: z.record(z.string(), NonNegativeNumberSchema).optional(),
  effectiveUsd: NonNegativeNumberSchema.optional(),
}).strict());
export type UsageObservationCost = z.infer<typeof UsageObservationCostSchema>;

export const UsageObservationContextSchema = lazyZodSchema(() => z.object({
  usedTokens: NonNegativeNumberSchema.nullable().optional(),
  windowTokens: NonNegativeNumberSchema.nullable().optional(),
}).strict());
export type UsageObservationContext = z.infer<typeof UsageObservationContextSchema>;

export const UsageEventIngestRequestSchema = lazyZodSchema(() => z.object({
  sessionId: z.string().trim().min(1),
  observedAt: z.number().int().min(0),
  agentId: z.string().trim().min(1),
  backendMode: OptionalNonEmptyStringSchema,
  modelId: OptionalNonEmptyStringSchema,
  projectKey: OptionalNonEmptyStringSchema,
  workspaceId: OptionalNonEmptyStringSchema,
  machineId: OptionalNonEmptyStringSchema,
  source: z.string().trim().min(1),
  scope: UsageObservationScopeSchema,
  externalKey: OptionalNonEmptyStringSchema,
  turnId: OptionalNonEmptyStringSchema,
  isCumulative: z.boolean(),
  tokens: UsageObservationTokensSchema,
  cost: UsageObservationCostSchema,
  context: UsageObservationContextSchema.optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).strict());
export type UsageEventIngestRequest = z.infer<typeof UsageEventIngestRequestSchema>;

export const UsageAnalyticsGranularitySchema = lazyZodSchema(() => z.enum([
  'hour',
  'day',
  'week',
  'month',
]));
export type UsageAnalyticsGranularity = z.infer<typeof UsageAnalyticsGranularitySchema>;

export const UsageAnalyticsBreakdownDimensionSchema = lazyZodSchema(() => z.enum([
  'agent',
  'model',
  'session',
  'project',
  'workspace',
  'backendMode',
  'source',
]));
export type UsageAnalyticsBreakdownDimension = z.infer<typeof UsageAnalyticsBreakdownDimensionSchema>;

export const UsageAnalyticsQueryFiltersSchema = lazyZodSchema(() => z.object({
  sessionIds: z.array(z.string().trim().min(1)).optional(),
  agentIds: z.array(z.string().trim().min(1)).optional(),
  modelIds: z.array(z.string().trim().min(1)).optional(),
  projectKeys: z.array(z.string().trim().min(1)).optional(),
  workspaceIds: z.array(z.string().trim().min(1)).optional(),
  backendModes: z.array(z.string().trim().min(1)).optional(),
  sources: z.array(z.string().trim().min(1)).optional(),
}).strict());
export type UsageAnalyticsQueryFilters = z.infer<typeof UsageAnalyticsQueryFiltersSchema>;

export const UsageAnalyticsQueryRequestSchema = lazyZodSchema(() => z.object({
  dateRange: z.object({
    startMs: z.number().int().min(0).optional(),
    endMs: z.number().int().min(0).optional(),
  }).strict().optional(),
  granularity: UsageAnalyticsGranularitySchema.default('day'),
  timeZoneOffsetMinutes: z.number().int().min(-840).max(840).default(0),
  costMode: z.enum(['auto', 'reported', 'estimated']).optional(),
  breakdowns: z.array(UsageAnalyticsBreakdownDimensionSchema).max(7).optional(),
  filters: UsageAnalyticsQueryFiltersSchema.optional(),
  includeSeries: z.boolean().default(true),
  includeInsights: z.boolean().optional(),
  includeActivity: z.boolean().optional(),
  includeLeaders: z.boolean().optional(),
  includeModelTimeline: z.boolean().optional(),
  includeMessageStats: z.boolean().optional(),
  activityResolution: z.enum(['calendar', 'weekdayHour', 'both']).optional(),
  topLimit: z.number().int().min(1).max(100).default(20),
}).strict());
export type UsageAnalyticsQueryRequest = z.infer<typeof UsageAnalyticsQueryRequestSchema>;

export const UsageAnalyticsTotalsSchema = lazyZodSchema(() => z.object({
  eventCount: z.number().int().min(0),
  /** Number of admitted inference requests; omitted for legacy/personal responses. */
  requestCount: z.number().int().min(0).optional(),
  tokens: UsageObservationTokensSchema,
  cost: UsageObservationCostSchema,
  context: UsageObservationContextSchema.optional(),
}).strict());
export type UsageAnalyticsTotals = z.infer<typeof UsageAnalyticsTotalsSchema>;

export const UsageAnalyticsSeriesBucketSchema = lazyZodSchema(() => z.object({
  bucketStartMs: z.number().int().min(0),
  bucketEndMs: z.number().int().min(0),
  eventCount: z.number().int().min(0),
  requestCount: z.number().int().min(0).optional(),
  tokens: UsageObservationTokensSchema,
  cost: UsageObservationCostSchema,
  context: UsageObservationContextSchema.optional(),
}).strict());
export type UsageAnalyticsSeriesBucket = z.infer<typeof UsageAnalyticsSeriesBucketSchema>;

export const UsageAnalyticsBreakdownEntrySchema = lazyZodSchema(() => z.object({
  key: z.string().trim().min(1),
  label: z.string().trim().min(1).optional(),
  eventCount: z.number().int().min(0),
  requestCount: z.number().int().min(0).optional(),
  tokens: UsageObservationTokensSchema,
  cost: UsageObservationCostSchema,
  context: UsageObservationContextSchema.optional(),
  latestContextUsedTokens: NonNegativeNumberSchema.optional(),
  latestContextWindowTokens: NonNegativeNumberSchema.optional(),
}).strict());
export type UsageAnalyticsBreakdownEntry = z.infer<typeof UsageAnalyticsBreakdownEntrySchema>;

export const UsageAnalyticsBreakdownsSchema = lazyZodSchema(() => z.object({
  agent: z.array(UsageAnalyticsBreakdownEntrySchema).optional(),
  model: z.array(UsageAnalyticsBreakdownEntrySchema).optional(),
  session: z.array(UsageAnalyticsBreakdownEntrySchema).optional(),
  project: z.array(UsageAnalyticsBreakdownEntrySchema).optional(),
  workspace: z.array(UsageAnalyticsBreakdownEntrySchema).optional(),
  backendMode: z.array(UsageAnalyticsBreakdownEntrySchema).optional(),
  source: z.array(UsageAnalyticsBreakdownEntrySchema).optional(),
}).strict());
export type UsageAnalyticsBreakdowns = z.infer<typeof UsageAnalyticsBreakdownsSchema>;

const UsageAnalyticsKeyedLabelSchema = lazyZodSchema(() => z.object({
  key: z.string().trim().min(1),
  label: z.string().trim().min(1),
}).strict());

const UsageAnalyticsActivityCalendarDaySchema = lazyZodSchema(() => z.object({
  date: z.string().trim().min(1),
  eventCount: z.number().int().min(0),
}).strict());

const UsageAnalyticsActivityWeekdayHourBucketSchema = lazyZodSchema(() => z.object({
  weekday: z.number().int().min(0).max(6),
  hour: z.number().int().min(0).max(23),
  eventCount: z.number().int().min(0),
}).strict());

const UsageAnalyticsActivitySchema = lazyZodSchema(() => z.object({
  calendarDays: z.array(UsageAnalyticsActivityCalendarDaySchema).optional(),
  weekdayHourBuckets: z.array(UsageAnalyticsActivityWeekdayHourBucketSchema).optional(),
}).strict());

const UsageAnalyticsInsightsSchema = lazyZodSchema(() => z.object({
  activeDays: z.number().int().min(0),
  longestStreakDays: z.number().int().min(0),
  sessionsUsed: z.number().int().min(0),
  messagesUsed: z.number().int().min(0),
  modelsTried: z.number().int().min(0),
  favoriteModel: UsageAnalyticsKeyedLabelSchema.optional(),
  favoriteModelChangeCount: z.number().int().min(0),
  busiestMonth: UsageAnalyticsKeyedLabelSchema.optional(),
  busiestDay: UsageAnalyticsKeyedLabelSchema.optional(),
  busiestHour: UsageAnalyticsKeyedLabelSchema.optional(),
  cacheSavingsUsd: NonNegativeNumberSchema.optional(),
}).strict());

const UsageAnalyticsLeaderSchema = lazyZodSchema(() => z.object({
  key: z.string().trim().min(1),
  label: z.string().trim().min(1).optional(),
  eventCount: z.number().int().min(0),
  tokens: UsageObservationTokensSchema.optional(),
  cost: UsageObservationCostSchema.optional(),
}).strict());

const UsageAnalyticsLeadersSchema = lazyZodSchema(() => z.object({
  agents: z.array(UsageAnalyticsLeaderSchema).optional(),
  models: z.array(UsageAnalyticsLeaderSchema).optional(),
  sessions: z.array(UsageAnalyticsLeaderSchema).optional(),
  projects: z.array(UsageAnalyticsLeaderSchema).optional(),
  workspaces: z.array(UsageAnalyticsLeaderSchema).optional(),
  engines: z.array(UsageAnalyticsLeaderSchema).optional(),
}).strict());

const UsageAnalyticsTimelineLeaderBucketSchema = lazyZodSchema(() => z.object({
  bucketStartMs: z.number().int().min(0),
  bucketEndMs: z.number().int().min(0),
  leaders: z.array(UsageAnalyticsLeaderSchema),
}).strict());

const UsageAnalyticsMessageStatsSchema = lazyZodSchema(() => z.object({
  /** Usage-contributing sessions selected by the query; identical to insights.sessionsUsed when insights are present. */
  sessionCount: z.number().int().min(0),
  /** Messages created in those sessions within the query's date window. */
  messageCount: z.number().int().min(0),
}).strict());

const UsageAnalyticsCostPresentationSchema = lazyZodSchema(() => z.object({
  mode: z.enum(['auto', 'reported', 'estimated']),
  effectiveUsd: NonNegativeNumberSchema,
  currency: z.string().trim().min(1),
  source: z.string().trim().min(1),
}).strict());

export const UsageAnalyticsQueryResponseSchema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  totals: UsageAnalyticsTotalsSchema,
  series: z.array(UsageAnalyticsSeriesBucketSchema).optional(),
  breakdowns: UsageAnalyticsBreakdownsSchema.optional(),
  insights: UsageAnalyticsInsightsSchema.optional(),
  activity: UsageAnalyticsActivitySchema.optional(),
  leaders: UsageAnalyticsLeadersSchema.optional(),
  modelTimeline: z.array(UsageAnalyticsTimelineLeaderBucketSchema).optional(),
  engineTimeline: z.array(UsageAnalyticsTimelineLeaderBucketSchema).optional(),
  messageStats: UsageAnalyticsMessageStatsSchema.optional(),
  costPresentation: UsageAnalyticsCostPresentationSchema.optional(),
}).strict());
export type UsageAnalyticsQueryResponse = z.infer<typeof UsageAnalyticsQueryResponseSchema>;

export const ServerUsageAnalyticsCapabilitiesSchema = lazyZodSchema(() => z.object({
  version: z.literal(1),
  eventsIngest: z.object({
    path: z.string().trim().min(1),
  }).strict(),
  query: z.object({
    path: z.string().trim().min(1),
  }).strict(),
  legacy: z.object({
    usageReportsPath: z.string().trim().min(1),
    usageQueryPath: z.string().trim().min(1),
  }).strict(),
}).strict());
export type ServerUsageAnalyticsCapabilities = z.infer<typeof ServerUsageAnalyticsCapabilitiesSchema>;
