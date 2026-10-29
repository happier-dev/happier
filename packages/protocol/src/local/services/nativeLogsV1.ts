import { z } from 'zod/mini';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { MachineRecipeReferenceV1Schema } from '../../machines/setup/machineRecipeReferenceV1.js';

export const ManagedServiceUnavailableReasonV1Schema = lazyZodSchema(() => z.enum([
  'unsupported', 'unavailable', 'admission_unavailable', 'secret_redaction_unavailable', 'denied', 'cancelled',
]));
export type ManagedServiceUnavailableReasonV1 = z.infer<typeof ManagedServiceUnavailableReasonV1Schema>;

export const ManagedServiceNativeLogCursorV1Schema = lazyZodSchema(() => z.strictObject({
  sourceRevision: z.string().check(z.minLength(1)), token: z.string(),
}));
export type ManagedServiceNativeLogCursorV1 = z.infer<typeof ManagedServiceNativeLogCursorV1Schema>;

export const MachineServiceLogsReadInputV1Schema = lazyZodSchema(() => z.strictObject({
  serverId: z.string().check(z.trim(), z.minLength(1)),
  machineId: z.string().check(z.trim(), z.minLength(1)),
  serviceId: z.string().check(z.trim(), z.minLength(1)),
  cursor: z.optional(ManagedServiceNativeLogCursorV1Schema),
}));
export type MachineServiceLogsReadInputV1 = z.infer<typeof MachineServiceLogsReadInputV1Schema>;

export const ManagedServiceNativeLogPageV1Schema = lazyZodSchema(() => z.strictObject({
  sourceRevision: z.string().check(z.minLength(1)), text: z.string(),
  nextCursor: z.nullable(ManagedServiceNativeLogCursorV1Schema), truncated: z.boolean(),
}));
export type ManagedServiceNativeLogPageV1 = z.infer<typeof ManagedServiceNativeLogPageV1Schema>;

export const ManagedServiceNativeLogResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('page'), page: ManagedServiceNativeLogPageV1Schema }),
  z.strictObject({ kind: z.literal('source-changed'), sourceRevision: z.string().check(z.minLength(1)) }),
  z.strictObject({ kind: z.literal('unavailable'), reason: ManagedServiceUnavailableReasonV1Schema,
    recipeRemedy: z.optional(MachineRecipeReferenceV1Schema) }),
]));
export type ManagedServiceNativeLogResultV1 = z.infer<typeof ManagedServiceNativeLogResultV1Schema>;

/** The host supplies its existing diagnostic budget, never a public caller limit. */
export type ManagedServiceNativeLogReadV1 = Readonly<{
  kind: 'read'; maxBytes: number; cursor?: ManagedServiceNativeLogCursorV1; signal?: AbortSignal;
}>;
