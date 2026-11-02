import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod/mini';
import { ProviderAccountUsageRecordIdSchema } from '../connect/providerAccountUsagePrimitives.js';
import { ProviderAccountUsagePaceWindowV1Schema } from '../connect/deriveProviderAccountUsagePace.js';
import { UsageQuotaNotificationKindV1Schema } from '../account/settings/usagePacingPreferencesV1.js';
import { MachineVitalsDiskThresholdV1Schema } from '../machines/vitals/machineVitalsAlertsV1.js';

const UsageResetNotificationEvidenceV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(ProviderAccountUsagePaceWindowV1Schema, {
  observedAtMs: z.number().check(z.int(), z.nonnegative()), previousObservedAtMs: z.number().check(z.int(), z.nonnegative()),
  witnessedAtMs: z.optional(z.number().check(z.int(), z.nonnegative())),
})));
const UsageWindowNotificationEvidenceV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(UsageResetNotificationEvidenceV1Schema, {
  usedFraction: z.number().check(z.nonnegative()), elapsedFraction: z.number().check(z.positive(), z.maximum(1)),
  pace: z.number().check(z.nonnegative()), projectedResetUtilizationFraction: z.number().check(z.nonnegative()),
  qualification: z.enum(['confirmed', 'estimated']), sampleCount: z.number().check(z.int(), z.positive()),
})));
const UsageCreditNotificationEvidenceV1Schema = lazyZodSchema(() => z.strictObject({
  recordId: ProviderAccountUsageRecordIdSchema, creditId: z.string().check(z.minLength(1)), expiresAtMs: z.number().check(z.int(), z.nonnegative()),
  observedAtMs: z.number().check(z.int(), z.nonnegative()), previousObservedAtMs: z.number().check(z.int(), z.nonnegative()),
}));
export const ConnectedServiceUsageNotificationV1Schema = lazyZodSchema(() => z.strictObject({
  topic: z.literal('connected_service_usage'), kind: UsageQuotaNotificationKindV1Schema,
  serviceId: z.string().check(z.minLength(1)), profileId: z.string().check(z.minLength(1)), issueFingerprint: z.string().check(z.minLength(1)),
  evidence: z.union([UsageWindowNotificationEvidenceV1Schema, UsageResetNotificationEvidenceV1Schema, UsageCreditNotificationEvidenceV1Schema]),
}).check(z.superRefine((event, ctx) => {
  if ((event.kind === 'credit_expiry') !== ('creditId' in event.evidence)
    || (event.kind !== 'reset' && !('creditId' in event.evidence) && !('pace' in event.evidence))) {
    ctx.addIssue({ code: 'custom', path: ['evidence'], message: 'Evidence must match notification kind' });
  }
})));
export type ConnectedServiceUsageNotificationV1 = z.infer<typeof ConnectedServiceUsageNotificationV1Schema>;

/** Closed V1 evidence envelope; no process identities or private Session labels. */
export const MachineVitalsNotificationV1Schema = lazyZodSchema(() => {
  const common = {
    topic: z.literal('resource_limit'), phase: z.enum(['started', 'recovered']),
    machineId: z.string().check(z.minLength(1)), machineName: z.optional(z.string().check(z.minLength(1))),
    at: z.number().check(z.nonnegative()), since: z.number().check(z.nonnegative()),
    workingSessionCount: z.optional(z.number().check(z.int(), z.nonnegative())), guardEnabled: z.boolean(),
  };
  return z.discriminatedUnion('kind', [
    z.strictObject({ ...common, kind: z.literal('memory_pressure'), evidence: z.strictObject({
      level: z.enum(['elevated', 'critical']), sustainMs: z.number().check(z.positive()),
      swapUsedBytes: z.optional(z.number().check(z.nonnegative())), swapTotalBytes: z.optional(z.number().check(z.nonnegative())),
    }) }),
    z.strictObject({ ...common, kind: z.literal('cpu_busy'), evidence: z.strictObject({
      abovePct: z.number().check(z.minimum(1), z.maximum(100)), sustainMs: z.number().check(z.positive()),
      busyPct: z.number().check(z.minimum(0), z.maximum(100)),
    }) }),
    z.strictObject({ ...common, kind: z.literal('disk_nearly_full'), volumeId: z.string().check(z.minLength(1)),
      volumeLabel: z.optional(z.string()), evidence: z.strictObject({
        freeBytes: z.number().check(z.nonnegative()), totalBytes: z.number().check(z.nonnegative()),
        threshold: MachineVitalsDiskThresholdV1Schema,
      }) }),
  ]).check(z.refine(notice => notice.since <= notice.at, { path: ['since'], message: 'Evidence window starts after occurrence' }));
});
export type MachineVitalsNotificationV1 = z.infer<typeof MachineVitalsNotificationV1Schema>;
