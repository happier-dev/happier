import { z } from 'zod/mini';
import { lazyZodSchema } from '../../lazyZodSchema.js';

/** Presentation-only cause of an already failed launch; carries no execution authority. */
export const SpawnFailureV1Schema = lazyZodSchema(() => z.strictObject({
    reason: z.enum(['too_many_open_files', 'no_ptys', 'process_limit', 'out_of_memory', 'other']),
    errno: z.optional(z.string().check(z.regex(/^E[A-Z0-9_]+$/u))),
    nativeErrno: z.optional(z.number().check(z.int())),
    cwd: z.optional(z.string().check(z.refine(value => value.trim().length > 0))),
}));
export type SpawnFailureV1 = z.infer<typeof SpawnFailureV1Schema>;
