import { z } from 'zod/mini';
import { lazyZodSchema } from '../../lazyZodSchema.js';

/** The same native phase/readiness fact is presented by Machine and Environment reads. */
export const ManagedServiceNativeStateV1Schema = lazyZodSchema(() => z.strictObject({
  phase: z.enum(['running', 'stopped', 'unknown']),
  readiness: z.enum(['ready', 'not_ready', 'not_reported']),
  /** Native owner presentation, independent of the person's service/watch label. */
  displayName: z.optional(z.string().check(z.minLength(1))),
}));
export type ManagedServiceNativeStateV1 = z.infer<typeof ManagedServiceNativeStateV1Schema>;
