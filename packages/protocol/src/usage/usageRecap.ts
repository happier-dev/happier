import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { UsageQuerySchema, type UsageQuery } from '../inputs/usageQuery.js';
import { UsageObservationTokensSchema, UsageAnalyticsCostFactValueSchema, UsageAnalyticsQueryResponseSchema } from './usageAnalyticsContracts.js';
import { UsageQuerySourceStatusSchema } from './resolveUsagePageAggregation.js';
import { UsageHowYouWorkSchema } from './resolveUsageHowYouWork.js';
import { UsageFileResultSchema } from './usageExport.js';
import { PublicProfileSnapshotV1Schema } from '../account/publicProfile.js';

export const USAGE_RECAP_STYLES = ['daybreak', 'sigil', 'editorial', 'glass', 'holo', 'skyline', 'terminal'] as const;
export const USAGE_RECAP_FORMATS = ['square', 'story', 'link-preview'] as const;
export const USAGE_RECAP_FIELDS = ['tokens', 'activeDays', 'streak', 'modelMix', 'agentMix', 'cache', 'rhythm', 'parallel', 'night', 'work', 'coach', 'highlights', 'names', 'dollars'] as const;
export const UsageRecapFieldSchema = lazyZodSchema(() => z.enum(USAGE_RECAP_FIELDS));
export type UsageRecapField = z.infer<typeof UsageRecapFieldSchema>;
export const UsageRecapSourceSelectionSchema = lazyZodSchema(() => z.enum(['whole_usage', 'happier_only']));
export type UsageRecapSourceSelection = z.infer<typeof UsageRecapSourceSelectionSchema>;

/** One closed input for private preview and subsequent client image rendering. */
export const UsageRecapPrivateComposeInputSchema = lazyZodSchema(() => z.strictObject({
  query: UsageQuerySchema,
  sourceSelection: z._default(UsageRecapSourceSelectionSchema, 'whole_usage'),
  style: z._default(z.enum(USAGE_RECAP_STYLES), 'daybreak'),
  format: z._default(z.enum(USAGE_RECAP_FORMATS), 'square'),
  selectedFields: z._default(z.array(UsageRecapFieldSchema), ['tokens', 'activeDays', 'modelMix', 'cache', 'rhythm', 'highlights']),
}));
export type UsageRecapPrivateComposeInput = z.infer<typeof UsageRecapPrivateComposeInputSchema>;

/** Recap source intent is independent of producer filters on the originating page. */
export function resolveUsageRecapQuery(input: Pick<UsageRecapPrivateComposeInput, 'query' | 'sourceSelection'>): UsageQuery {
  const { execution: _execution, ...query } = input.query;
  return { ...query, sources: [], ...(input.sourceSelection === 'happier_only' ? { execution: 'happier' } : {}) };
}
export const USAGE_RECAP_PUBLIC_FIELDS = ['tokens', 'activeDays', 'streak', 'agentMix', 'rhythm', 'parallel', 'work', 'highlights'] as const;
/** The captured Account selects the current public view; a caller cannot provide public data or a target. */
export const UsageRecapPublicComposeInputSchema = lazyZodSchema(() => z.strictObject({
  source: z.strictObject({ kind: z.literal('public_profile') }),
  style: z._default(z.enum(USAGE_RECAP_STYLES), 'daybreak'),
  format: z._default(z.enum(USAGE_RECAP_FORMATS), 'square'),
  selectedFields: z._default(z.array(z.enum(USAGE_RECAP_PUBLIC_FIELDS)), [...USAGE_RECAP_PUBLIC_FIELDS]),
}));
export type UsageRecapPublicComposeInput = z.infer<typeof UsageRecapPublicComposeInputSchema>;
export const UsageRecapComposeInputSchema = lazyZodSchema(() => z.union([UsageRecapPrivateComposeInputSchema, UsageRecapPublicComposeInputSchema]));
export type UsageRecapComposeInput = z.infer<typeof UsageRecapComposeInputSchema>;

/** Device effects accept source intent only, never caller-supplied bytes or paths. */
export const UsageRecapPrivateDeliveryInputSchema = lazyZodSchema(() => z.extend(UsageRecapPrivateComposeInputSchema, { intent: z.enum(['copy', 'save', 'share']) }));
export const UsageRecapPublicDeliveryInputSchema = lazyZodSchema(() => z.extend(UsageRecapPublicComposeInputSchema, { intent: z.enum(['copy', 'save', 'share']) }));
export const UsageRecapDeliveryInputSchema = lazyZodSchema(() => z.union([
  UsageRecapPrivateDeliveryInputSchema, UsageRecapPublicDeliveryInputSchema,
]));
export type UsageRecapDeliveryInput = z.infer<typeof UsageRecapDeliveryInputSchema>;

const count = lazyZodSchema(() => z.number().check(z.int(), z.nonnegative()));
const amount = lazyZodSchema(() => z.number().check(z.nonnegative()));
const mixRow = lazyZodSchema(() => z.strictObject({ tokens: amount, events: count, name: z.optional(z.string()) }));
const agentMixRow = lazyZodSchema(() => z.extend(mixRow, { agentId: z.optional(z.string().check(z.minLength(1))) }));
const highlight = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('observed_peak'), bucketStartMs: count, bucketEndMs: count, tokens: amount }),
  z.strictObject({ kind: z.literal('linked_outcomes'), count }),
]));

export const UsageRecapFactsSchema = lazyZodSchema(() => z.strictObject({
  tokens: z.optional(UsageObservationTokensSchema),
  activeDays: z.optional(count),
  streak: z.optional(z.strictObject({ longestDays: count })),
  modelMix: z.optional(z.array(mixRow)),
  agentMix: z.optional(z.array(agentMixRow)),
  cache: z.optional(z.strictObject({ readTokens: amount, writeTokens: amount })),
  rhythm: z.optional(z.strictObject({ calendarDays: UsageAnalyticsQueryResponseSchema.shape.activity._zod.def.innerType.shape.calendarDays._zod.def.innerType,
    weekdayHourBuckets: UsageAnalyticsQueryResponseSchema.shape.activity._zod.def.innerType.shape.weekdayHourBuckets._zod.def.innerType })),
  parallel: z.optional(z.strictObject({ sumAgentMs: amount, unionElapsedMs: amount, maximumConcurrency: count })),
  night: z.optional(UsageHowYouWorkSchema.shape.nightShift._zod.def.innerType),
  work: z.optional(z.strictObject({ linkedOutcomes: count, allocatedContributions: count, unallocatedContributions: count })),
  coach: z.optional(z.strictObject({ findings: z.array(z.strictObject({ detectorId: z.string().check(z.minLength(1)), evidenceCount: count })) })),
  highlights: z.optional(z.array(highlight)),
  dollars: z.optional(z.strictObject({ basis: UsageQuerySchema.shape.costBasis,
    // Current development read projection: selected money is not a sum of raw comparison facts.
    selected: z.nullable(z.strictObject({ kind: z.enum(['reported', 'estimated', 'api_equivalent', 'invoice', 'mixed']),
      currency: z.string().check(z.minLength(1)), amountUsd: amount })),
    facts: z.array(UsageAnalyticsCostFactValueSchema) })),
}));
export type UsageRecapFacts = z.infer<typeof UsageRecapFactsSchema>;

/** Privacy projection of existing coverage: no source identity, scope key or error text. */
export const UsageRecapCoverageSchema = lazyZodSchema(() => z.strictObject({
  accounting: z.nullable(z.omit(UsageAnalyticsQueryResponseSchema.shape.coverage._zod.def.innerType, { sources: true })),
  sourceCoverage: z.array(z.strictObject({ status: UsageQuerySourceStatusSchema, asOfMs: z.optional(count), eventCount: count, historyComplete: z.nullable(z.boolean()) })),
  sourceStatuses: z.array(z.strictObject({ status: UsageQuerySourceStatusSchema, asOfMs: z.optional(count) })),
  pending: z.boolean(),
  execution: z.optional(z.strictObject({ status: z.enum(['complete', 'partial', 'unknown']) })),
  night: z.optional(z.strictObject({ detailStatus: z.enum(['available', 'partial', 'unknown']) })),
  coach: z.optional(z.strictObject({ currentness: z.enum(['current', 'stale', 'unknown']), asOfMs: z.nullable(count),
    findings: z.array(z.enum(['complete', 'partial', 'unknown'])) })),
  intervals: z.optional(z.strictObject({ method: z.literal('witnessed_intervals_v1'), status: z.enum(['complete_for_supplied_facts', 'partial']),
    detailStatus: z.enum(['available', 'partial', 'unknown']),
    unknownEndCount: count, invalidIntervalCount: count })),
}));

export const UsageRecapComposeResultSchema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('composed'), v: z.literal(1),
    style: z.enum(USAGE_RECAP_STYLES), format: z.enum(USAGE_RECAP_FORMATS),
    selectedFields: z.array(UsageRecapFieldSchema), unavailableFields: z.array(UsageRecapFieldSchema),
    period: z.strictObject({ startMs: count, endMs: count, timeZoneOffsetMinutes: UsageQuerySchema.shape.timeZoneOffsetMinutes }),
    asOfMs: z.nullable(count), coverage: UsageRecapCoverageSchema, facts: UsageRecapFactsSchema,
    source: z.optional(z.literal('public_profile')), publicSnapshot: z.optional(PublicProfileSnapshotV1Schema),
    sourceSelection: z.optional(UsageRecapSourceSelectionSchema),
  }),
  z.strictObject({ kind: z.literal('unavailable'), reason: z.enum(['query_mismatch', 'accounting_unavailable', 'period_unavailable',
    'public_profile_source_unavailable', 'public_profile_unavailable']) }),
]).check(z.superRefine((result, context) => {
  if (result.kind !== 'composed') return;
  if ((result.source === 'public_profile') !== (result.publicSnapshot !== undefined)
    || result.source === 'public_profile' && (Object.keys(result.facts).length > 0
      || result.selectedFields.some(field => !USAGE_RECAP_PUBLIC_FIELDS.some(allowed => allowed === field)))) {
    context.addIssue({ code: 'custom', message: 'Public recap requires only admitted public facts and compatible fields' });
  }
  for (const [field, value] of Object.entries(result.facts)) {
    if (value !== undefined && !result.selectedFields.some(selected => selected === field)) {
      context.addIssue({ code: 'custom', path: ['facts', field], message: 'Fact is outside the selected manifest' });
    }
  }
  if (!result.selectedFields.includes('names')) {
    for (const field of ['modelMix', 'agentMix'] as const) {
      result.facts[field]?.forEach((row, index) => {
        if (row.name !== undefined) context.addIssue({ code: 'custom', path: ['facts', field, index, 'name'], message: 'Names are not selected' });
      });
    }
  }
})));
export type UsageRecapComposeResult = z.infer<typeof UsageRecapComposeResultSchema>;
export type UsageRecapComposed = Extract<UsageRecapComposeResult, { kind: 'composed' }>;

/** Same file-byte boundary as data exports, with the recap's selected-field vocabulary. */
export const UsageRecapImageResultSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(z.omit(UsageFileResultSchema, { fields: true }), {
  mediaType: z.literal('image/png'), selectedFields: z.array(UsageRecapFieldSchema),
})));
export type UsageRecapImageResult = z.infer<typeof UsageRecapImageResultSchema>;

export const UsageRecapExportResultSchema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('exported'), compose: UsageRecapComposeResultSchema, file: UsageRecapImageResultSchema }),
  z.strictObject({ kind: z.literal('unavailable'), reason: z.enum(['render_target_unavailable', 'render_failed', 'compose_unavailable']),
    compose: UsageRecapComposeResultSchema }),
]).check(z.superRefine((result, context) => {
  if (result.kind !== 'exported') return;
  if (result.compose.kind !== 'composed') {
    context.addIssue({ code: 'custom', path: ['compose'], message: 'Image requires composed facts' });
    return;
  }
  if (result.file.asOfMs !== result.compose.asOfMs
    || JSON.stringify(result.file.selectedFields) !== JSON.stringify(result.compose.selectedFields)
    || result.file.fileName !== usageRecapImageFileName(result.compose)) {
    context.addIssue({ code: 'custom', path: ['file'], message: 'Image does not match its composed manifest' });
  }
})));
export type UsageRecapExportResult = z.infer<typeof UsageRecapExportResultSchema>;

export const UsageRecapDeliveryOutcomeSchema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('delivered') }),
  z.strictObject({ kind: z.literal('cancelled') }),
  z.strictObject({ kind: z.literal('unavailable'), reason: z.enum(['delivery_target_unavailable', 'clipboard_unavailable']) }),
  z.strictObject({ kind: z.literal('failed'), reason: z.enum(['delivery_failed', 'outcome_unobservable']),
    handoff: z.optional(z.literal('presented')) }),
]));
export type UsageRecapDeliveryOutcome = z.infer<typeof UsageRecapDeliveryOutcomeSchema>;

export const UsageRecapDeliveryResultSchema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('delivered'), compose: UsageRecapComposeResultSchema }),
  z.strictObject({ kind: z.literal('cancelled'), compose: UsageRecapComposeResultSchema }),
  z.strictObject({ kind: z.literal('unavailable'), compose: UsageRecapComposeResultSchema,
    reason: z.enum(['render_target_unavailable', 'render_failed', 'compose_unavailable', 'delivery_target_unavailable', 'clipboard_unavailable']) }),
  z.strictObject({ kind: z.literal('failed'), compose: UsageRecapComposeResultSchema,
    reason: z.enum(['delivery_failed', 'outcome_unobservable']), handoff: z.optional(z.literal('presented')) }),
]));
export type UsageRecapDeliveryResult = z.infer<typeof UsageRecapDeliveryResultSchema>;

/** Nameless display name from style, format and the last covered calendar date. */
export function usageRecapImageFileName(result: UsageRecapComposed): string {
  const end = new Date(Math.max(result.period.startMs, result.period.endMs - 1)
    + (result.period.timeZoneOffsetMinutes ?? 0) * 60_000);
  const stamp = `${end.getUTCFullYear()}${String(end.getUTCMonth() + 1).padStart(2, '0')}${String(end.getUTCDate()).padStart(2, '0')}`;
  return `happier-usage-${result.style}-${result.format}-${stamp}.png`;
}
