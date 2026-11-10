import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { AgentIdV1Schema } from '../agents/agentIdV1.js';
import { UsageNightHoursV1Schema } from '../usage/usageWorkIntervals.js';
import { UsageAnalyticsQueryRequestSchema } from '../usage/usageAnalyticsContracts.js';
import { createStoredReadSchema, defineStoredReadProjection } from '../json/storedReadSchema.js';

/** PublicProfileV1 is the disclosure schema, independent of package versions. */
export const PUBLIC_PROFILE_FIELDS_V1 = ['name', 'avatar', 'bio', 'links', 'since', 'tokens', 'activeDays', 'agentTime',
  'mergedPrs', 'currentStreak', 'bestStreak', 'peakParallel', 'calendar', 'agentMix', 'sourceSplit', 'punch',
  'highlights', 'projects', 'footprint', 'agentActiveDays', 'weeklyAgentMix', 'weeklyPeakParallel',
  'sessionDurations', 'machineKinds', 'dayNightActivity'] as const;
export const PublicProfileFieldV1Schema = z.enum(PUBLIC_PROFILE_FIELDS_V1);
export type PublicProfileField = z.infer<typeof PublicProfileFieldV1Schema>;
const policyFields = z.record(PublicProfileFieldV1Schema, z.boolean());
defineStoredReadProjection(policyFields, () => z.pipe(z.record(z.string(), z.unknown()), z.pipe(z.transform((fields: Record<string, unknown>) =>
  Object.fromEntries(PUBLIC_PROFILE_FIELDS_V1.map(field => [field, Object.hasOwn(fields, field) ? fields[field] : false]))), policyFields)));
export const PublicProfilePolicyV1Schema = lazyZodSchema(() => z.strictObject({
  fields: policyFields, indexable: z.boolean(),
}));
export type PublicProfilePolicyV1 = z.infer<typeof PublicProfilePolicyV1Schema>;
export const DEFAULT_PUBLIC_PROFILE_POLICY_V1: PublicProfilePolicyV1 = {
  fields: Object.fromEntries(PUBLIC_PROFILE_FIELDS_V1.map(field => [field,
    ['name', 'avatar', 'since', 'tokens', 'activeDays', 'agentTime', 'mergedPrs', 'currentStreak', 'bestStreak', 'peakParallel', 'calendar', 'agentMix', 'sourceSplit', 'highlights'].includes(field),
  ])) as Record<PublicProfileField, boolean>, indexable: false,
};

const count = z.number().check(z.int(), z.nonnegative());
const amount = z.number().check(z.nonnegative());
const share = z.number().check(z.minimum(0), z.maximum(1));
const label = z.string().check(z.trim(), z.minLength(1));
export const PublicProfileHttpsUrlV1Schema = z.string().check(z.url(), z.refine(value => {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password; } catch { return false; }
}));
export const PublicCoverageV1Schema = lazyZodSchema(() => z.strictObject({
  status: z.enum(['complete_for_supplied_facts', 'partial', 'unknown', 'unavailable']),
  method: z.enum(['runtime', 'logs', 'context_only', 'mixed', 'unknown']),
}));
export type PublicCoverage = z.infer<typeof PublicCoverageV1Schema>;
export const PublicPeriodV1Schema = lazyZodSchema(() => z.strictObject({
  startMs: count, endMs: count, timeZoneOffsetMinutes: UsageAnalyticsQueryRequestSchema.shape.timeZoneOffsetMinutes._zod.def.innerType,
}).check(z.refine(period => period.endMs > period.startMs)));
export type PublicPeriod = z.infer<typeof PublicPeriodV1Schema>;
const level = z.nullable(z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4)]));
export const PublicDayV1Schema = lazyZodSchema(() => z.strictObject({ date: z.iso.date(), level }));
const agentMixEntry = z.strictObject({ agentId: AgentIdV1Schema, share, tokens: z.optional(count), coverage: PublicCoverageV1Schema });
const window = { startMs: count, endMs: count };
function uniqueBy<T>(values: readonly T[], key: (value: T) => string) { return new Set(values.map(key)).size === values.length; }
export const PublicUsageFactsV1Schema = lazyZodSchema(() => z.strictObject({
  tokens: z.optional(count), activeDays: z.optional(count), agentTimeMs: z.optional(amount), mergedPrs: z.optional(count),
  currentStreakDays: z.optional(count), bestStreakDays: z.optional(count), peakParallel: z.optional(count),
  calendar: z.optional(z.array(PublicDayV1Schema).check(z.refine(days => uniqueBy(days, day => day.date)))),
  agentMix: z.optional(z.array(agentMixEntry).check(z.refine(rows => uniqueBy(rows, row => row.agentId)))),
  sourceSplit: z.optional(z.array(z.strictObject({ execution: z.enum(['happier', 'outside', 'unknown']), share,
    tokens: z.optional(count) })).check(z.refine(rows => uniqueBy(rows, row => row.execution)))),
  punch: z.optional(z.array(z.strictObject({ weekday: z.number().check(z.int(), z.minimum(0), z.maximum(6)),
    hour: z.number().check(z.int(), z.minimum(0), z.maximum(23)), level })).check(z.refine(rows => uniqueBy(rows, row => `${row.weekday}:${row.hour}`)))),
  highlights: z.optional(z.array(z.strictObject({ kind: z.enum(['merged_prs', 'peak_parallel', 'active_days']), count }))),
  footprint: z.optional(z.strictObject({ status: z.literal('insufficient_basis'), reason: z.literal('no_applicable_versioned_method') })),
  agentActiveDays: z.optional(z.array(z.strictObject({ agentId: AgentIdV1Schema, days: count, coverage: PublicCoverageV1Schema }))
    .check(z.refine(rows => uniqueBy(rows, row => row.agentId)))),
  weeklyAgentMix: z.optional(z.array(z.strictObject({ ...window, mix: z.array(z.omit(agentMixEntry, { tokens: true })) })
    .check(z.refine(row => row.endMs > row.startMs && uniqueBy(row.mix, item => item.agentId))))
    .check(z.refine(rows => uniqueBy(rows, row => `${row.startMs}:${row.endMs}`)))),
  weeklyPeakParallel: z.optional(z.array(z.strictObject({ ...window, peak: count, coverage: PublicCoverageV1Schema })
    .check(z.refine(row => row.endMs > row.startMs))).check(z.refine(rows => uniqueBy(rows, row => `${row.startMs}:${row.endMs}`)))),
  sessionDurations: z.optional(z.array(z.strictObject({ agentId: AgentIdV1Schema, durationMs: amount }))),
  machineKinds: z.optional(z.array(z.strictObject({ kind: label, count, agentTimeShare: share, coverage: PublicCoverageV1Schema }))
    .check(z.refine(rows => uniqueBy(rows, row => row.kind)))),
  dayNightActivity: z.optional(z.strictObject({ window: UsageNightHoursV1Schema, dayShare: share, nightShare: share, coverage: PublicCoverageV1Schema })),
}));
export type PublicUsageFactsV1 = z.infer<typeof PublicUsageFactsV1Schema>;
const fieldCoverage = z.partialRecord(PublicProfileFieldV1Schema, PublicCoverageV1Schema);
defineStoredReadProjection(fieldCoverage, () => z.pipe(z.record(z.string(), z.unknown()), z.pipe(z.transform((fields: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(fields).filter(([field]) => PUBLIC_PROFILE_FIELDS_V1.includes(field as PublicProfileField)))), fieldCoverage)));
export const PublicProfileSnapshotV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1), computedAtMs: count, period: PublicPeriodV1Schema, coverage: PublicCoverageV1Schema,
  fieldCoverage, facts: PublicUsageFactsV1Schema,
  lenses: z.optional(z.array(z.strictObject({ execution: z.enum(['happier', 'outside']), facts: PublicUsageFactsV1Schema }))
    .check(z.refine(rows => uniqueBy(rows, row => row.execution)))),
}));
export type PublicProfileSnapshotV1 = z.infer<typeof PublicProfileSnapshotV1Schema>;
export const PublicProfileLinkV1Schema = lazyZodSchema(() => z.strictObject({ label, url: PublicProfileHttpsUrlV1Schema }));
export const PublicProfileMetadataV1Schema = lazyZodSchema(() => z.strictObject({
  bio: z.optional(z.string()), links: z.optional(z.array(PublicProfileLinkV1Schema)), projects: z.optional(z.array(PublicProfileLinkV1Schema)),
  avatar: z.optional(z.strictObject({ kind: z.enum(['account', 'planet']) })),
}));
export type PublicProfileMetadataV1 = z.infer<typeof PublicProfileMetadataV1Schema>;
export const PublicProfileIdentityV1Schema = lazyZodSchema(() => z.strictObject({
  name: z.optional(z.string()), sinceMs: z.optional(count), avatarUrl: z.optional(PublicProfileHttpsUrlV1Schema),
  /** Account media has no admitted anonymous URL; the producer explains the safe Brand fallback. */
  avatar: z.optional(z.strictObject({ kind: z.literal('planet'), reason: z.literal('account_image_unavailable') })),
}));
export type PublicProfileIdentityV1 = z.infer<typeof PublicProfileIdentityV1Schema>;
export const PublicProfilePolicyV1StoredSchema = createStoredReadSchema(PublicProfilePolicyV1Schema);
export const PublicProfileSnapshotV1StoredSchema = createStoredReadSchema(PublicProfileSnapshotV1Schema);
export const PublicProfileMetadataV1StoredSchema = createStoredReadSchema(PublicProfileMetadataV1Schema);
