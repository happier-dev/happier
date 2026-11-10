import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';

export const DaemonServerWorkCountersV1Schema = lazyZodSchema(() => z.looseObject({
    accepted: z._default(z.number().check(z.int(), z.nonnegative()), 0),
    coalesced: z._default(z.number().check(z.int(), z.nonnegative()), 0),
    suppressed: z._default(z.number().check(z.int(), z.nonnegative()), 0),
    written: z._default(z.number().check(z.int(), z.nonnegative()), 0),
    failed: z._default(z.number().check(z.int(), z.nonnegative()), 0),
    deferred: z._default(z.number().check(z.int(), z.nonnegative()), 0),
    retried: z._default(z.number().check(z.int(), z.nonnegative()), 0),
  }));
export type DaemonServerWorkCountersV1 = z.infer<typeof DaemonServerWorkCountersV1Schema>;

export const DaemonServerWorkPurposeStatusV1Schema = lazyZodSchema(() => z.looseObject({
    counters: DaemonServerWorkCountersV1Schema,
  }));
export type DaemonServerWorkPurposeStatusV1 = z.infer<typeof DaemonServerWorkPurposeStatusV1Schema>;

export const DaemonServerWorkKeyStatusV1Schema = lazyZodSchema(() => z.looseObject({
    timeSinceLastSuccessMs: z.nullable(z.number().check(z.int(), z.nonnegative())),
    backoffReason: z.nullable(z.string().check(z.minLength(1))),
    nextEligibleAt: z.nullable(z.number().check(z.int(), z.nonnegative())),
  }));
export type DaemonServerWorkKeyStatusV1 = z.infer<typeof DaemonServerWorkKeyStatusV1Schema>;

export const DaemonServerWorkStatusV1Schema = lazyZodSchema(() => z.looseObject({
    v: z.literal(1),
    pendingKeyCount: z.number().check(z.int(), z.nonnegative()),
    pendingPayloadBytes: z.number().check(z.int(), z.nonnegative()),
    purposes: z._default(z.record(z.string().check(z.minLength(1)), DaemonServerWorkPurposeStatusV1Schema), {}),
    keys: z._default(z.record(z.string().check(z.minLength(1)), DaemonServerWorkKeyStatusV1Schema), {}),
  }));
export type DaemonServerWorkStatusV1 = z.infer<typeof DaemonServerWorkStatusV1Schema>;
