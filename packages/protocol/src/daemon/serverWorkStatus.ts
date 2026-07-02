import { z } from 'zod';

export const DaemonServerWorkCountersV1Schema = z
  .object({
    accepted: z.number().int().nonnegative().default(0),
    coalesced: z.number().int().nonnegative().default(0),
    suppressed: z.number().int().nonnegative().default(0),
    written: z.number().int().nonnegative().default(0),
    failed: z.number().int().nonnegative().default(0),
    deferred: z.number().int().nonnegative().default(0),
    retried: z.number().int().nonnegative().default(0),
  })
  .passthrough();
export type DaemonServerWorkCountersV1 = z.infer<typeof DaemonServerWorkCountersV1Schema>;

export const DaemonServerWorkPurposeStatusV1Schema = z
  .object({
    counters: DaemonServerWorkCountersV1Schema,
  })
  .passthrough();
export type DaemonServerWorkPurposeStatusV1 = z.infer<typeof DaemonServerWorkPurposeStatusV1Schema>;

export const DaemonServerWorkKeyStatusV1Schema = z
  .object({
    timeSinceLastSuccessMs: z.number().int().nonnegative().nullable(),
    backoffReason: z.string().min(1).nullable(),
    nextEligibleAt: z.number().int().nonnegative().nullable(),
  })
  .passthrough();
export type DaemonServerWorkKeyStatusV1 = z.infer<typeof DaemonServerWorkKeyStatusV1Schema>;

export const DaemonServerWorkStatusV1Schema = z
  .object({
    v: z.literal(1),
    pendingKeyCount: z.number().int().nonnegative(),
    pendingPayloadBytes: z.number().int().nonnegative(),
    purposes: z.record(z.string().min(1), DaemonServerWorkPurposeStatusV1Schema).default({}),
    keys: z.record(z.string().min(1), DaemonServerWorkKeyStatusV1Schema).default({}),
  })
  .passthrough();
export type DaemonServerWorkStatusV1 = z.infer<typeof DaemonServerWorkStatusV1Schema>;
