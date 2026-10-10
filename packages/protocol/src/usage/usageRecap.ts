import { z } from 'zod';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { UsageQuerySchema } from '../inputs/usageQuery.js';
import { UsageObservationTokensSchema, UsageAnalyticsCostFactValueSchema, UsageAnalyticsQueryResponseSchema } from './usageAnalyticsContracts.js';
import { UsageQuerySourceStatusSchema } from './resolveUsagePageAggregation.js';
import { UsageHowYouWorkSchema } from './resolveUsageHowYouWork.js';
import { UsageFileResultSchema } from './usageExport.js';

export const USAGE_RECAP_STYLES = ['daybreak', 'sigil', 'editorial', 'glass', 'holo', 'skyline', 'terminal'] as const;
export const USAGE_RECAP_FORMATS = ['square', 'story', 'link-preview'] as const;
export const USAGE_RECAP_FIELDS = ['tokens', 'activeDays', 'streak', 'modelMix', 'agentMix', 'cache', 'rhythm', 'parallel', 'night', 'work', 'coach', 'highlights', 'names', 'dollars'] as const;
export const UsageRecapFieldSchema = lazyZodSchema(() => z.enum(USAGE_RECAP_FIELDS));
export type UsageRecapField = z.infer<typeof UsageRecapFieldSchema>;

/** One closed input for private preview and subsequent client image rendering. */
export const UsageRecapComposeInputSchema = lazyZodSchema(() => z.object({
  query: UsageQuerySchema,
  style: z.enum(USAGE_RECAP_STYLES).default('daybreak'),
  format: z.enum(USAGE_RECAP_FORMATS).default('square'),
  selectedFields: z.array(UsageRecapFieldSchema).default(['tokens', 'activeDays', 'modelMix', 'cache', 'rhythm', 'highlights']),
}).strict());
export type UsageRecapComposeInput = z.infer<typeof UsageRecapComposeInputSchema>;

const count = lazyZodSchema(() => z.number().int().nonnegative());
const amount = lazyZodSchema(() => z.number().finite().nonnegative());
const mixRow = lazyZodSchema(() => z.object({ tokens: amount, events: count, name: z.string().optional() }).strict());
const highlight = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('observed_peak'), bucketStartMs: count, bucketEndMs: count, tokens: amount }).strict(),
  z.object({ kind: z.literal('linked_outcomes'), count }).strict(),
]));

export const UsageRecapFactsSchema = lazyZodSchema(() => z.object({
  tokens: UsageObservationTokensSchema.optional(),
  activeDays: count.optional(),
  streak: z.object({ longestDays: count }).strict().optional(),
  modelMix: z.array(mixRow).optional(),
  agentMix: z.array(mixRow).optional(),
  cache: z.object({ readTokens: amount, writeTokens: amount }).strict().optional(),
  rhythm: z.object({ calendarDays: UsageAnalyticsQueryResponseSchema.shape.activity.unwrap().shape.calendarDays.unwrap(),
    weekdayHourBuckets: UsageAnalyticsQueryResponseSchema.shape.activity.unwrap().shape.weekdayHourBuckets.unwrap() }).strict().optional(),
  parallel: z.object({ sumAgentMs: amount, unionElapsedMs: amount, maximumConcurrency: count }).strict().optional(),
  night: UsageHowYouWorkSchema.shape.nightShift.unwrap().optional(),
  work: z.object({ linkedOutcomes: count, allocatedContributions: count, unallocatedContributions: count }).strict().optional(),
  coach: z.object({ findings: z.array(z.object({ detectorId: z.string().min(1), evidenceCount: count }).strict()) }).strict().optional(),
  highlights: z.array(highlight).optional(),
  dollars: z.object({ basis: UsageQuerySchema.shape.costBasis,
    facts: z.array(UsageAnalyticsCostFactValueSchema).min(1) }).strict().optional(),
}).strict());
export type UsageRecapFacts = z.infer<typeof UsageRecapFactsSchema>;

/** Privacy projection of existing coverage: no source identity, scope key or error text. */
export const UsageRecapCoverageSchema = lazyZodSchema(() => z.object({
  accounting: UsageAnalyticsQueryResponseSchema.shape.coverage.unwrap().omit({ sources: true }).nullable(),
  sourceCoverage: z.array(z.object({ status: UsageQuerySourceStatusSchema, asOfMs: count.optional(), eventCount: count, historyComplete: z.boolean().nullable() }).strict()),
  sourceStatuses: z.array(z.object({ status: UsageQuerySourceStatusSchema, asOfMs: count.optional() }).strict()),
  pending: z.boolean(),
  night: z.object({ detailStatus: z.enum(['available', 'partial', 'unknown']) }).strict().optional(),
  coach: z.object({ currentness: z.enum(['current', 'stale', 'unknown']), asOfMs: count.nullable(),
    findings: z.array(z.enum(['complete', 'partial', 'unknown'])) }).strict().optional(),
  intervals: z.object({ method: z.literal('witnessed_intervals_v1'), status: z.enum(['complete_for_supplied_facts', 'partial']),
    detailStatus: z.enum(['available', 'partial', 'unknown']),
    unknownEndCount: count, invalidIntervalCount: count }).strict().optional(),
}).strict());

export const UsageRecapComposeResultSchema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('composed'), v: z.literal(1),
    style: z.enum(USAGE_RECAP_STYLES), format: z.enum(USAGE_RECAP_FORMATS),
    selectedFields: z.array(UsageRecapFieldSchema), unavailableFields: z.array(UsageRecapFieldSchema),
    period: z.object({ startMs: count, endMs: count, timeZoneOffsetMinutes: UsageQuerySchema.shape.timeZoneOffsetMinutes }).strict(),
    asOfMs: count.nullable(), coverage: UsageRecapCoverageSchema, facts: UsageRecapFactsSchema,
  }).strict(),
  z.object({ kind: z.literal('unavailable'), reason: z.enum(['query_mismatch', 'accounting_unavailable', 'period_unavailable']) }).strict(),
]).superRefine((result, context) => {
  if (result.kind !== 'composed') return;
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
}));
export type UsageRecapComposeResult = z.infer<typeof UsageRecapComposeResultSchema>;
export type UsageRecapComposed = Extract<UsageRecapComposeResult, { kind: 'composed' }>;

/** Same file-byte boundary as data exports, with the recap's selected-field vocabulary. */
export const UsageRecapImageResultSchema = lazyZodSchema(() => UsageFileResultSchema.omit({ fields: true }).extend({
  mediaType: z.literal('image/png'), selectedFields: z.array(UsageRecapFieldSchema),
}).strict());
export type UsageRecapImageResult = z.infer<typeof UsageRecapImageResultSchema>;

export const UsageRecapExportResultSchema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('exported'), compose: UsageRecapComposeResultSchema, file: UsageRecapImageResultSchema }).strict(),
  z.object({ kind: z.literal('unavailable'), reason: z.enum(['render_target_unavailable', 'render_failed', 'compose_unavailable']),
    compose: UsageRecapComposeResultSchema }).strict(),
]).superRefine((result, context) => {
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
}));
export type UsageRecapExportResult = z.infer<typeof UsageRecapExportResultSchema>;

/** Nameless display name from style, format and the last covered calendar date. */
export function usageRecapImageFileName(result: UsageRecapComposed): string {
  const end = new Date(Math.max(result.period.startMs, result.period.endMs - 1)
    + (result.period.timeZoneOffsetMinutes ?? 0) * 60_000);
  const stamp = `${end.getUTCFullYear()}${String(end.getUTCMonth() + 1).padStart(2, '0')}${String(end.getUTCDate()).padStart(2, '0')}`;
  return `happier-usage-${result.style}-${result.format}-${stamp}.png`;
}
