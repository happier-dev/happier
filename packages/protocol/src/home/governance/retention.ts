import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

/**
 * Retention dry run (plan `2026-09-26-home-owner-console` §3.6): one sweep of the Home's effective
 * retention policy with deletion forced off, run under the retention sweep lock. The result is
 * request state only — per-domain would-delete counts and why each domain stopped — and is never
 * persisted. A worker sweep holding the lock answers `retention_sweep_in_progress`.
 */
export const HomeRetentionDryRunInputV1Schema = lazyZodSchema(() => z.strictObject({}));
export type HomeRetentionDryRunInputV1 = z.infer<typeof HomeRetentionDryRunInputV1Schema>;

export const HomeRetentionStopReasonV1Schema = lazyZodSchema(() => z.enum([
  'exhausted',
  'time_budget',
  'row_budget',
  'candidate_budget',
  'stalled',
]));
export type HomeRetentionStopReasonV1 = z.infer<typeof HomeRetentionStopReasonV1Schema>;

export const HomeRetentionDryRunDomainResultV1Schema = lazyZodSchema(() => z.strictObject({
  wouldDelete: z.number().check(z.int(), z.minimum(0)),
  candidatesExamined: z.number().check(z.int(), z.minimum(0)),
  stopReason: HomeRetentionStopReasonV1Schema,
}));
export type HomeRetentionDryRunDomainResultV1 = z.infer<typeof HomeRetentionDryRunDomainResultV1Schema>;

export const HomeRetentionDryRunResultV1Schema = lazyZodSchema(() => z.strictObject({
  /** When the sweep ran (ISO time). */
  ranAt: z.string().check(z.minLength(1)),
  /** Keyed by retention domain id (the ids `/v2/retention-policy` lists). */
  byDomain: z.record(z.string().check(z.minLength(1)), HomeRetentionDryRunDomainResultV1Schema),
}));
export type HomeRetentionDryRunResultV1 = z.infer<typeof HomeRetentionDryRunResultV1Schema>;
