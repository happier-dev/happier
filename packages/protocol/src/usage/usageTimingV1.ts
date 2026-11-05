import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';

const Time = lazyZodSchema(() => z.number().check(z.int(), z.nonnegative(), z.maximum(Number.MAX_SAFE_INTEGER)));

/** Inclusive conservative bounds. Both null means empty; a null maximum means an open interval. */
export const UsageTimingBoundsV1Schema = lazyZodSchema(() => z.union([
    z.strictObject({ v: z.literal(1), minMs: z.null(), maxMs: z.null() }),
    z.strictObject({ v: z.literal(1), minMs: Time, maxMs: z.nullable(Time) }).check(z.refine(
        value => value.maxMs === null || value.maxMs >= value.minMs,
        { message: 'Usage timing maximum must follow its minimum' },
    )),
]));
export type UsageTimingBoundsV1 = z.infer<typeof UsageTimingBoundsV1Schema>;

/** A null component is unknown, including writes by producers without timing support. */
export const UsageSessionTimingV1Schema = lazyZodSchema(() => z.strictObject({
    v: z.literal(1),
    metadata: z.nullable(UsageTimingBoundsV1Schema),
    agentState: z.nullable(UsageTimingBoundsV1Schema),
}));
export type UsageSessionTimingV1 = z.infer<typeof UsageSessionTimingV1Schema>;

/** Add an authored component delta without turning unknown retained coverage into known coverage. */
export function mergeUsageTimingBoundsV1(left: UsageTimingBoundsV1 | null,
    right: UsageTimingBoundsV1 | null): UsageTimingBoundsV1 | null {
    if (left === null || right === null) return null;
    if (left.minMs === null) return right;
    if (right.minMs === null) return left;
    return { v: 1, minMs: Math.min(left.minMs, right.minMs),
        maxMs: left.maxMs === null || right.maxMs === null ? null : Math.max(left.maxMs, right.maxMs) };
}
