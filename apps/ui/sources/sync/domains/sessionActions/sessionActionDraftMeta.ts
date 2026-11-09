import { z } from 'zod/mini';

const SessionActionDraftStatusSchema = z.enum([
    'editing',
    'running',
    'succeeded',
    'failed',
    'cancelled',
]);

/** Historical device-local card format, read only by the one-way launcher import. */
export const SessionActionDraftSchema = z.strictObject({
    id: z.string().check(z.minLength(1)),
    address: z.strictObject({
        serverId: z.string().check(z.minLength(1)),
        sessionId: z.string().check(z.minLength(1)),
    }),
    accountId: z.string().check(z.minLength(1)),
    actionId: z.string().check(z.minLength(1)),
    createdAt: z.number(),
    status: SessionActionDraftStatusSchema,
    input: z.record(z.string(), z.unknown()),
    error: z.optional(z.nullable(z.string())),
});
