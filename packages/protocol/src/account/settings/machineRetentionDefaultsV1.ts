import * as z from 'zod/mini';
import { lazyDefinition } from '../../lazyZodSchema.js';
import { RetentionV1Schema, ReusableRetentionV1Schema, type RetentionV1 } from '../../machines/managed/managedMachineV1.js';
import { createStoredReadSchema } from '../../json/storedReadSchema.js';

export const MACHINE_RETENTION_CATEGORIES_V1 = ['local', 'running-only', 'stopped-billed', 'unknown'] as const;
export type MachineRetentionCategoryV1 = typeof MACHINE_RETENTION_CATEGORIES_V1[number];

export const MachineRetentionPolicyV1Schema = lazyDefinition(() => z.strictObject({
  retention: RetentionV1Schema,
  wakeOnAcceptedMessage: z.boolean(),
}));
export type MachineRetentionPolicyV1 = Readonly<z.infer<typeof MachineRetentionPolicyV1Schema>>;
export type MachineRetentionOverrideV1 = Readonly<{
  retention?: RetentionV1;
  wakeOnAcceptedMessage?: boolean;
}>;

const ReusableMachineRetentionPolicyV1Schema = lazyDefinition(() => z.strictObject({
  ...MachineRetentionPolicyV1Schema.shape,
  retention: ReusableRetentionV1Schema,
}));

/** Preferences only: never resource identity, native expiry, or live activity. */
export const MachineRetentionDefaultsV1Schema = lazyDefinition(() => z.strictObject({
  v: z.literal(1),
  local: z.optional(ReusableMachineRetentionPolicyV1Schema),
  'running-only': z.optional(ReusableMachineRetentionPolicyV1Schema),
  'stopped-billed': z.optional(ReusableMachineRetentionPolicyV1Schema),
  unknown: z.optional(ReusableMachineRetentionPolicyV1Schema),
}));
export const MachineRetentionDefaultsV1ReadSchema = createStoredReadSchema(MachineRetentionDefaultsV1Schema);
export type MachineRetentionDefaultsV1 = z.infer<typeof MachineRetentionDefaultsV1Schema>;
export const DEFAULT_MACHINE_RETENTION_DEFAULTS_V1: MachineRetentionDefaultsV1 = Object.freeze({ v: 1 });

/** A null category choice is Reset to default; siblings remain untouched on CAS rebases. */
export function updateMachineRetentionCategoryPreferenceV1(
  current: MachineRetentionDefaultsV1,
  category: MachineRetentionCategoryV1,
  policy: MachineRetentionPolicyV1 | null,
): MachineRetentionDefaultsV1 {
  const next = MachineRetentionDefaultsV1ReadSchema.parse(current);
  if (policy === null) delete next[category];
  else next[category] = ReusableMachineRetentionPolicyV1Schema.parse(policy);
  return MachineRetentionDefaultsV1Schema.parse(next);
}
