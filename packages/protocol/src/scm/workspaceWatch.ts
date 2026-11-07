import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';

/** One parked request retains observation; revision requests consume native changes. */
export const ScmWorkspaceWatchRequestSchema = lazyZodSchema(() => z.strictObject({
    directory: z.string().check(z.minLength(1)),
    observationOnly: z.optional(z.literal(true)),
    sinceRevision: z.optional(z.int().check(z.nonnegative())),
}));
export type ScmWorkspaceWatchRequest = z.infer<typeof ScmWorkspaceWatchRequestSchema>;

export const ScmWorkspaceWatchUnavailableSchema = lazyZodSchema(() => z.strictObject({
    code: z.string(),
    message: z.string(),
}));
export type ScmWorkspaceWatchUnavailable = z.infer<typeof ScmWorkspaceWatchUnavailableSchema>;

export const ScmWorkspaceWatchResponseSchema = lazyZodSchema(() => z.discriminatedUnion('status', [
    z.strictObject({ status: z.enum(['ready', 'changed']), revision: z.int().check(z.nonnegative()) }),
    z.strictObject({ status: z.literal('unavailable'), reason: ScmWorkspaceWatchUnavailableSchema }),
    z.strictObject({ status: z.literal('cancelled') }),
]));
export type ScmWorkspaceWatchResponse = z.infer<typeof ScmWorkspaceWatchResponseSchema>;
