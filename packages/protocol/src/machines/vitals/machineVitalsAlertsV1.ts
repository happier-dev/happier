import { z } from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';

// Evaluators consume whole minute records and can read seven days of history.
const sustainMs = () => z.number().check(z.int(), z.minimum(60_000), z.maximum(7 * 24 * 60 * 60_000), z.multipleOf(60_000));
export const MachineVitalsDiskThresholdV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ freeFraction: z.number().check(z.minimum(0), z.maximum(1)) }),
  z.strictObject({ freeBytes: z.number().check(z.int(), z.nonnegative(), z.maximum(Number.MAX_SAFE_INTEGER)) }),
]));
export const MachineVitalsAlertsPolicyV1Schema = lazyZodSchema(() => z.strictObject({
  memory: z._default(z.strictObject({ enabled: z._default(z.boolean(), false), level: z._default(z.enum(['elevated', 'critical']), 'critical'),
    sustainMs: z._default(sustainMs(), 300_000) }), { enabled: false, level: 'critical', sustainMs: 300_000 }),
  cpu: z._default(z.strictObject({ enabled: z._default(z.boolean(), false), abovePct: z._default(z.number().check(z.minimum(1), z.maximum(100)), 90),
    sustainMs: z._default(sustainMs(), 900_000) }), { enabled: false, abovePct: 90, sustainMs: 900_000 }),
  disk: z._default(z.strictObject({ enabled: z._default(z.boolean(), false), threshold: z._default(MachineVitalsDiskThresholdV1Schema, { freeFraction: 0.1 }) }), { enabled: false, threshold: { freeFraction: 0.1 } }),
}));
export type MachineVitalsAlertsPolicyV1 = z.infer<typeof MachineVitalsAlertsPolicyV1Schema>;
export const MachineVitalsAlertsPolicyPatchV1Schema = lazyZodSchema(() => z.strictObject({
  memory: z.optional(z.strictObject({ enabled: z.optional(z.boolean()), level: z.optional(z.enum(['elevated', 'critical'])), sustainMs: z.optional(sustainMs()) })),
  cpu: z.optional(z.strictObject({ enabled: z.optional(z.boolean()), abovePct: z.optional(z.number().check(z.minimum(1), z.maximum(100))), sustainMs: z.optional(sustainMs()) })),
  disk: z.optional(z.strictObject({ enabled: z.optional(z.boolean()), threshold: z.optional(MachineVitalsDiskThresholdV1Schema) })),
}));
