import { z } from '../../zodRuntimePolicy.js';

import { createStoredReadSchema } from '../../json/storedReadSchema.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';

/** t is the end of the measured minute; null preserves unavailable counter deltas. */
export const MachineVitalsMinuteRecordV1Schema = lazyZodSchema(() => z.strictObject({
  t: z.number().check(z.int(), z.nonnegative()),
  cpu: z.nullable(z.number().check(z.minimum(0), z.maximum(100))),
  cpuMax: z.nullable(z.number().check(z.minimum(0), z.maximum(100))),
  mem: z.nullable(z.number().check(z.nonnegative())),
  memMax: z.nullable(z.number().check(z.nonnegative())),
  lvl: z.enum(['calm', 'elevated', 'critical', 'not_reported']),
  swp: z.nullable(z.number().check(z.nonnegative())),
  rx: z.nullable(z.number().check(z.nonnegative())),
  tx: z.nullable(z.number().check(z.nonnegative())),
}));
export type MachineVitalsMinuteRecordV1 = z.infer<typeof MachineVitalsMinuteRecordV1Schema>;
export const MachineVitalsMinuteRecordV1StoredReadSchema = createStoredReadSchema(MachineVitalsMinuteRecordV1Schema);

export const MachineVitalsAlertEpisodeV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('alert'),
  rule: z.enum(['memory', 'cpu', 'disk']),
  volumeId: z.optional(z.string().check(z.minLength(1))),
  state: z.enum(['fired', 'recovered']),
  at: z.number().check(z.int(), z.nonnegative()),
}));
export type MachineVitalsAlertEpisodeV1 = z.infer<typeof MachineVitalsAlertEpisodeV1Schema>;
export const MachineVitalsAlertEpisodeV1StoredReadSchema = createStoredReadSchema(MachineVitalsAlertEpisodeV1Schema);

/** Transient history projections carry measured traffic duration; stored minutes remain unchanged. */
export const MachineVitalsHistoryPointV1Schema = lazyZodSchema(() => z.extend(MachineVitalsMinuteRecordV1Schema, {
  rxObservedMs: z.optional(z.number().check(z.positive())),
  txObservedMs: z.optional(z.number().check(z.positive())),
}));
export type MachineVitalsHistoryPointV1 = z.infer<typeof MachineVitalsHistoryPointV1Schema>;

/** Chart buckets use t at the bucket start; network bytes cover only the observed duration. */
export const MachineVitalsHistoryV1Schema = lazyZodSchema(() => z.strictObject({
  range: z.enum(['1h', '24h', '7d']),
  bucketMs: z.number().check(z.int(), z.positive()),
  points: z.array(z.nullable(MachineVitalsHistoryPointV1Schema)),
  today: z.strictObject({ rxBytes: z.number().check(z.nonnegative()), txBytes: z.number().check(z.nonnegative()) }),
}));
export type MachineVitalsHistoryV1 = z.infer<typeof MachineVitalsHistoryV1Schema>;
