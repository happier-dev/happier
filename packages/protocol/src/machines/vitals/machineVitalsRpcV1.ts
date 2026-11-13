import { z } from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { MachineResourceAttentionV1Schema } from '../resources/machineResourceSummaryV1.js';
import { MachineVitalsSampleV1Schema } from './machineVitalsSampleV1.js';

// V1 Machine RPC inputs and envelopes are closed. The sample owner classifies
// optional presentation leaves separately (GPU facts are additive-open/drop).
const target = () => ({ serverId: z.optional(z.string().check(z.minLength(1))), machineId: z.string().check(z.minLength(1)) });
export const MachineVitalsGetInputV1Schema = lazyZodSchema(() => z.strictObject({
    ...target(), view: z.optional(z.enum(['summary', 'overview'])),
}));
export type MachineVitalsGetInputV1 = z.infer<typeof MachineVitalsGetInputV1Schema>;
export const MachineVitalsHistoryGetInputV1Schema = lazyZodSchema(() => z.strictObject({
    ...target(), range: z.enum(['1h', '24h', '7d']), serviceId: z.optional(z.string().check(z.minLength(1))),
}));
export type MachineVitalsHistoryGetInputV1 = z.infer<typeof MachineVitalsHistoryGetInputV1Schema>;
export const MachineVitalsWatchInputV1Schema = lazyZodSchema(() => z.strictObject({
    ...target(), view: z.enum(['summary', 'overview']), sinceSampledAt: z.optional(z.number().check(z.minimum(0))),
}));
export type MachineVitalsWatchInputV1 = z.infer<typeof MachineVitalsWatchInputV1Schema>;

const series = () => z.array(z.strictObject({ t: z.number().check(z.minimum(0)), y: z.nullable(z.number().check(z.minimum(0))) }));
export const MachineVitalsSnapshotV1Schema = lazyZodSchema(() => z.strictObject({
    state: z.enum(['reporting', 'unavailable']),
    reason: z.optional(z.enum(['helper_missing', 'reader_failed', 'helper_failing'])),
    sample: z.nullable(MachineVitalsSampleV1Schema),
    series5m: z.strictObject({ cpu: series(), memory: series(), networkRx: series(), networkTx: series() }),
    attention: z.optional(MachineResourceAttentionV1Schema),
}));
export type MachineVitalsSnapshotV1 = z.infer<typeof MachineVitalsSnapshotV1Schema>;
export const MachineVitalsWatchResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('changed', [
    z.strictObject({ changed: z.literal(true), samples: z.array(MachineVitalsSampleV1Schema) }),
    z.strictObject({ changed: z.literal(false) }),
]));
export type MachineVitalsWatchResultV1 = z.infer<typeof MachineVitalsWatchResultV1Schema>;
