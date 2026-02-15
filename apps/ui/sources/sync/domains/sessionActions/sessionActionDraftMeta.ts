import { z } from 'zod';

export const SessionActionDraftStatusSchema = z.enum([
    'editing',
    'running',
    'succeeded',
    'failed',
    'cancelled',
]);

export const SessionActionDraftSchema = z.object({
    id: z.string().min(1),
    sessionId: z.string().min(1),
    actionId: z.string().min(1),
    createdAt: z.number().finite(),
    status: SessionActionDraftStatusSchema,
    input: z.record(z.unknown()),
    error: z.string().nullable().optional(),
}).strict();

