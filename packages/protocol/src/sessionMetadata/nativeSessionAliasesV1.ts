import { z } from 'zod';
import { lazySchema } from '../lazySchema.js';

/** Assignment evidence follows the owning Session's metadata storage mode. */
export const NativeSessionAliasAssignmentV1Schema = lazySchema(() => z.object({
  providerId: z.string().min(1),
  providerSessionId: z.string().min(1),
  alias: z.string().min(1),
  assignedAt: z.number().int().positive().safe(),
  observedAt: z.number().int().positive().safe(),
}).refine(value => value.assignedAt <= value.observedAt));

export const NativeSessionAliasesV1Schema = lazySchema(() => z.object({
  v: z.literal(1),
  assignments: z.array(NativeSessionAliasAssignmentV1Schema),
}));

export type NativeSessionAliasAssignmentV1 = z.infer<typeof NativeSessionAliasAssignmentV1Schema>;
export type NativeSessionAliasesV1 = z.infer<typeof NativeSessionAliasesV1Schema>;
