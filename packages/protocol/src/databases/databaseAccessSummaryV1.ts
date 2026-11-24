import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';

export const DatabaseAccessRefusalV1Schema = lazyZodSchema(() => z.enum([
    'database_editing_off', 'database_not_an_editor', 'database_agent_access_none', 'database_agent_access_read_only',
]));
export type DatabaseAccessRefusalV1 = z.infer<typeof DatabaseAccessRefusalV1Schema>;

/** The access decision for one requester. Database Actions and their presenters carry the same result. */
export const DatabaseAccessSummaryV1Schema = lazyZodSchema(() => z.strictObject({
    canRead: z.boolean(), canWrite: z.boolean(), reason: z.optional(DatabaseAccessRefusalV1Schema),
}));
export type DatabaseAccessSummaryV1 = z.infer<typeof DatabaseAccessSummaryV1Schema>;
