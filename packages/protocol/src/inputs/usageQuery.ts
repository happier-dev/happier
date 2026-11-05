import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { createCanonicalJsonSigningInput } from '../crypto/canonicalJson.js';
import { projectNativeJsonValueForTransport } from '../json/strictJsonValue.js';
import { UsageAnalyticsQueryRequestSchema, UsageAnalyticsQueryFiltersSchema, UsageAnalyticsBreakdownDimensionSchema, type UsageAnalyticsQueryRequest } from '../usage/usageAnalyticsContracts.js';
import type { InputFieldHint, InputOption } from './inputFields.js';
import { resolveUsageBucketBounds } from '../usage/usageCalendar.js';

export const UsageRelativePeriodSchema = z.enum(['today', '7days', '30days', '90days', 'year', 'all']);
export type UsageRelativePeriod = z.infer<typeof UsageRelativePeriodSchema>;

/** Presentation identity, not an accounting HTTP clause. Evidence-backed measures retain their unit. */
export const UsageAccountingMetricSchema = z.enum(['tokens', 'cost']);
export type UsageAccountingMetric = z.infer<typeof UsageAccountingMetricSchema>;
export const UsagePresentationMetricSchema = z.enum(['tokens', 'cost', 'sessions', 'busy', 'steering', 'peakParallel']);
export type UsagePresentationMetric = z.infer<typeof UsagePresentationMetricSchema>;

/** Personal usage input. Authority is captured by the host, never carried by the query. */
export const UsageQuerySchema = lazyZodSchema(() => {
  const clauses = UsageAnalyticsQueryRequestSchema.shape;
  const filters = UsageAnalyticsQueryFiltersSchema.shape;
  return z.strictObject({
    // Explicit exclusion keeps stored-read projections from dropping rolling intent into an empty absolute range.
    period: z._default(z.union([z.extend(clauses.dateRange._zod.def.innerType, { relative: z.optional(z.never()) }), z.strictObject({ relative: UsageRelativePeriodSchema,
      startMs: z.optional(z.never()), endMs: z.optional(z.never()) })]), {}),
    agents: z._default(filters.agentIds._zod.def.innerType, []),
    machines: z._default(filters.machineIds._zod.def.innerType, []),
    projects: z._default(filters.projectKeys._zod.def.innerType, []),
    sources: z._default(filters.sources._zod.def.innerType, []),
    execution: filters.execution,
    session: z._default(z.nullable(z.union([filters.sessionIds._zod.def.innerType._zod.def.element, filters.sessionIds._zod.def.innerType])), null),
    costBasis: z._default(clauses.costMode._zod.def.innerType, 'auto'),
    metric: z._default(UsagePresentationMetricSchema, 'tokens'),
    // Host projection demand; accounting transport never receives this clause.
    includeAccounting: z._default(z.boolean(), true),
    includeContributions: z._default(z.boolean(), false),
    includeComparison: z._default(z.boolean(), true),
    includeQuotaHistory: z._default(z.boolean(), true),
    includeSessionEvidence: z._default(z.boolean(), true),
    includeTranscriptEvidence: z._default(z.boolean(), true),
    includeWorkEvidence: z._default(z.boolean(), true),
    workProjection: z._default(z.enum(['summary', 'detail']), 'detail'),
    breakdown: z._default(clauses.breakdowns._zod.def.innerType, []),
    modelIds: z._default(filters.modelIds._zod.def.innerType, []),
    workspaceIds: z._default(filters.workspaceIds._zod.def.innerType, []),
    backendModes: z._default(filters.backendModes._zod.def.innerType, []),
    ...z.omit(UsageAnalyticsQueryRequestSchema, { dateRange: true, costMode: true, breakdowns: true, filters: true }).shape,
  });
});
export type UsageQuery = z.infer<typeof UsageQuerySchema>;

/** Private transcript evidence uses admitted turns; only allocation and export consume event rows. */
export function usageQueryNeedsContributionRows(query: UsageQuery): boolean {
  return query.includeContributions || query.population !== 'public_eligible_personal'
    && query.includeWorkEvidence && query.workProjection !== 'summary';
}

/** Source inventory is metadata, independent of accounting period, metric and cost basis. */
export const UsageSourceInventoryScopeSchema = lazyZodSchema(() => z.pick(UsageQuerySchema, { agents: true, machines: true, sources: true }));
export type UsageSourceInventoryScope = z.infer<typeof UsageSourceInventoryScopeSchema>;

export const UsageQueryBatchInputSchema = lazyZodSchema(() => z.strictObject({ queries: z.array(UsageQuerySchema).check(z.minLength(1)) }));
export type UsageQueryBatchInput = z.infer<typeof UsageQueryBatchInputSchema>;

const sortedSet = (values: readonly string[]) => [...new Set(values)].sort();
// Only the owner inserts frozen copies. Unknown caller objects are always revalidated.
const normalizedQueryKeys = new WeakMap<UsageQuery, string | null>();
const normalizedBatchKeys = new WeakMap<UsageQueryBatchInput, string | null>();

/** Canonical semantic identity includes every admitted filter and output clause. */
export function normalizeUsageQuery(value: unknown): UsageQuery {
  if (typeof value === 'object' && value !== null && normalizedQueryKeys.has(value as UsageQuery)) return value as UsageQuery;
  const query = UsageQuerySchema.parse(value);
  const sessions = query.session === null ? [] : typeof query.session === 'string' ? [query.session] : query.session;
  const normalized: UsageQuery = { ...query,
    population: query.population ?? 'all_personal_history',
    agents: sortedSet(query.agents), machines: sortedSet(query.machines), projects: sortedSet(query.projects),
    sources: sortedSet(query.sources), session: sessions.length ? sortedSet(sessions) : null,
    modelIds: sortedSet(query.modelIds), workspaceIds: sortedSet(query.workspaceIds), backendModes: sortedSet(query.backendModes),
    breakdown: [...new Set(query.breakdown)].sort(),
    includeInsights: query.includeInsights ?? false, includeActivity: query.includeActivity ?? false,
    includeLeaders: query.includeLeaders ?? false, includeModelTimeline: query.includeModelTimeline ?? false,
    includeMessageStats: query.includeMessageStats ?? false,
    ...(query.includeActivity ? { activityResolution: query.activityResolution ?? 'both' } : { activityResolution: undefined }),
  };
  Object.freeze(normalized.period);
  for (const values of [normalized.agents, normalized.machines, normalized.projects, normalized.sources,
    normalized.modelIds, normalized.workspaceIds, normalized.backendModes, normalized.breakdown]) Object.freeze(values);
  if (normalized.session !== null && Array.isArray(normalized.session)) Object.freeze(normalized.session);
  Object.freeze(normalized);
  normalizedQueryKeys.set(normalized, null);
  return normalized;
}

export function getUsageQueryKey(value: unknown): string {
  const query = normalizeUsageQuery(value);
  let key = normalizedQueryKeys.get(query);
  if (key == null) {
    key = createCanonicalJsonSigningInput(projectNativeJsonValueForTransport(query));
    normalizedQueryKeys.set(query, key);
  }
  return key;
}

/** A batch is a semantic set, not a source of result ordering or another query dialect. */
export function normalizeUsageQueryBatchInput(value: unknown): UsageQueryBatchInput {
  if (typeof value === 'object' && value !== null && normalizedBatchKeys.has(value as UsageQueryBatchInput)) return value as UsageQueryBatchInput;
  const input = UsageQueryBatchInputSchema.parse(value);
  const keyed = new Map(input.queries.map(candidate => {
    const query = normalizeUsageQuery(candidate);
    return [getUsageQueryKey(query), query] as const;
  }));
  const normalized = { queries: [...keyed].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([, query]) => query) };
  Object.freeze(normalized.queries);
  Object.freeze(normalized);
  normalizedBatchKeys.set(normalized, null);
  return normalized;
}

export function getUsageQueryBatchKey(value: unknown): string {
  const batch = normalizeUsageQueryBatchInput(value);
  let key = normalizedBatchKeys.get(batch);
  if (key == null) {
    key = createCanonicalJsonSigningInput(projectNativeJsonValueForTransport(batch));
    normalizedBatchKeys.set(batch, key);
  }
  return key;
}

/** Resolve rolling intent only at the read boundary; persisted inputs and semantic keys stay relative. */
export function resolveUsageQueryPeriod(query: Pick<UsageQuery, 'period' | 'timeZoneOffsetMinutes'>, nowMs: number): NonNullable<UsageAnalyticsQueryRequest['dateRange']> {
  if (query.period.relative === undefined) return query.period;
  const relative = query.period.relative;
  const today = resolveUsageBucketBounds('day', nowMs, query.timeZoneOffsetMinutes).bucketStartMs;
  if (relative === 'today') return { startMs: today, endMs: nowMs };
  if (relative === 'all') return { endMs: nowMs };
  const days = { '7days': 7, '30days': 30, '90days': 90, year: 365 }[relative];
  return { startMs: today - (days - 1) * 86_400_000, endMs: nowMs };
}

export function usageQueryToAnalyticsRequest(value: UsageQuery, nowMs = Date.now()): UsageAnalyticsQueryRequest {
  const query = normalizeUsageQuery(value);
  const { period: _period, agents, machines, projects, sources, execution, session, costBasis, metric: _metric,
    includeAccounting: _accounting, includeContributions: _contributions, includeComparison: _comparison,
    includeQuotaHistory: _quotaHistory, includeSessionEvidence: _sessionEvidence, includeTranscriptEvidence: _transcriptEvidence,
    includeWorkEvidence: _workEvidence, workProjection: _workProjection, breakdown,
    modelIds, workspaceIds, backendModes, population, ...clauses } = query;
  const selected = (values: string[]) => values.length ? values : undefined;
  return UsageAnalyticsQueryRequestSchema.parse({ ...clauses,
    ...(population === 'public_eligible_personal' ? { population } : {}),
    dateRange: resolveUsageQueryPeriod(query, nowMs), costMode: costBasis, breakdowns: breakdown,
    filters: { agentIds: selected(agents), machineIds: selected(machines), projectKeys: selected(projects), sources: selected(sources),
      ...(execution === undefined ? {} : { execution }),
      sessionIds: session === null ? undefined : typeof session === 'string' ? [session] : session,
      modelIds: selected(modelIds), workspaceIds: selected(workspaceIds), backendModes: selected(backendModes) },
  });
}

export function usageAnalyticsRequestToQuery(value: z.input<typeof UsageAnalyticsQueryRequestSchema>, presentation: Readonly<{ metric?: UsageQuery['metric'] }> = {}): UsageQuery {
  const { dateRange, filters, costMode, breakdowns, ...clauses } = UsageAnalyticsQueryRequestSchema.parse(value);
  return normalizeUsageQuery({ ...clauses, period: dateRange, agents: filters?.agentIds, machines: filters?.machineIds,
    projects: filters?.projectKeys, sources: filters?.sources, ...(filters?.execution === undefined ? {} : { execution: filters.execution }), session: filters?.sessionIds ?? null,
    costBasis: costMode, breakdown: breakdowns, modelIds: filters?.modelIds, workspaceIds: filters?.workspaceIds,
    backendModes: filters?.backendModes, ...presentation });
}

const breakdownLabels = {
  agent: 'Agent', model: 'Model', session: 'Session', project: 'Project', workspace: 'Workspace',
  backendMode: 'Backend mode', source: 'Source', machine: 'Machine',
} satisfies Record<z.infer<typeof UsageAnalyticsBreakdownDimensionSchema>, string>;
const editableBreakdownDimensions = ['agent', 'model', 'project', 'source', 'machine'] as const satisfies readonly z.infer<typeof UsageAnalyticsBreakdownDimensionSchema>[];

/** Array-valued choices keep the UsageQuery contract, including existing multi-dimension pins. */
export function readUsageGroupByOptions(value: unknown): readonly InputOption[] {
  const options: InputOption[] = [{ value: [], label: 'Default' },
    ...editableBreakdownDimensions.map(dimension => ({ value: [dimension], label: breakdownLabels[dimension] }))];
  const stored = UsageQuerySchema.shape.breakdown.safeParse(value);
  if (stored.success && !options.some(option => JSON.stringify(option.value) === JSON.stringify(stored.data))) {
    options.push({ value: stored.data, label: stored.data.map(dimension => breakdownLabels[dimension]).join(' · ') });
  }
  return options;
}

/** The Period presets' English names: the Period choice here and an anonymous profile's period title. */
export const USAGE_RELATIVE_PERIOD_LABELS_EN = {
  today: 'Today', '7days': 'Last 7 days', '30days': 'Last 30 days', '90days': 'Last 90 days', year: 'Last year', all: 'All time',
} satisfies Record<UsageRelativePeriod, string>;

/**
 * The Period's few named choices, offered in place like any other fixed choice. A stored range that is
 * not one of them (a custom range copied from the Usage page) stays listed, so it keeps its name.
 */
export function readUsagePeriodOptions(value: unknown): readonly InputOption[] {
  const stored = value === undefined ? undefined : UsageQuerySchema.shape.period.safeParse(value);
  const range = stored?.success && stored.data.relative === undefined ? stored.data : null;
  // An unbounded range is All time as the Usage page stores it; it takes the All time slot, never a second one.
  const unbounded = range !== null && range.startMs === undefined && range.endMs === undefined;
  const options = UsageRelativePeriodSchema.options.map((relative): InputOption => {
    const value: InputOption['value'] = relative === 'all' && unbounded ? {} : { relative };
    return { value, label: USAGE_RELATIVE_PERIOD_LABELS_EN[relative] };
  });
  if (range !== null && !unbounded) options.push({ value: projectNativeJsonValueForTransport(range), label: 'Custom range' });
  return options;
}

/** The breakdowns widget really draws several dimensions; ordinary widgets choose one grouping. */
export const USAGE_MULTI_BREAKDOWN_INPUT_FIELD: InputFieldHint = {
  path: 'breakdown', title: 'Breakdown', widget: 'multiselect', contextMode: 'own', required: false,
  options: editableBreakdownDimensions.map(value => ({ value, label: breakdownLabels[value] })),
};

/** Same independently editable paths for widget, group and ordinary input editors. */
export const USAGE_QUERY_INPUT_FIELDS: readonly InputFieldHint[] = [
  { path: 'period', title: 'Period', widget: 'select', inputType: { hostType: 'usageQuery', field: 'period' }, optionsSourceId: 'usage.query.period', contextMode: 'follow' },
  { path: 'agents', title: 'Agents', widget: 'multiselect', optionsSourceId: 'usage.filters.agents', placeholder: 'All agents', contextMode: 'follow', required: false },
  { path: 'machines', title: 'Machines', widget: 'multiselect', optionsSourceId: 'usage.filters.machines', placeholder: 'All machines', contextMode: 'follow', required: false },
  { path: 'projects', title: 'Projects', widget: 'multiselect', optionsSourceId: 'usage.filters.projects', placeholder: 'All projects', contextMode: 'follow', required: false },
  { path: 'sources', title: 'Sources', widget: 'multiselect', optionsSourceId: 'usage.filters.sources', placeholder: 'All sources', contextMode: 'follow', required: false },
  { path: 'session', title: 'Session', widget: 'select', inputType: { hostType: 'usageQuery', field: 'session' }, contextMode: 'follow', visibleWhenContextSlot: 'session' },
  { path: 'costBasis', title: 'Cost basis', widget: 'select', contextMode: 'follow',
    options: UsageAnalyticsQueryRequestSchema.shape.costMode._zod.def.innerType.options.map(value => ({ value,
      label: { auto: 'Automatic', reported: 'Reported', estimated: 'Estimated', api_equivalent: 'API equivalent' }[value] })) },
  { path: 'metric', title: 'Metric', widget: 'select', contextMode: 'own', options: [
    { value: 'tokens', label: 'Tokens' }, { value: 'cost', label: 'Cost' },
    { value: 'sessions', label: 'Sessions' }, { value: 'busy', label: 'Busy time' },
    { value: 'steering', label: 'Accepted steers' }, { value: 'peakParallel', label: 'Peak parallel' },
  ] },
  { path: 'breakdown', title: 'Group by', widget: 'select', contextMode: 'own', optionsSourceId: 'usage.query.breakdown' },
];
