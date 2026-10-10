import { z } from 'zod';
import { lazyZodSchema } from '../lazyZodSchema.js';

/** Material stays with the mounted human recovery flow, never in an Action. */
export const AccountHomeContinuationInputV1Schema = lazyZodSchema(() => z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('choose'), commandId: z.string().trim().min(1),
    homeServerIdentityId: z.string().trim().min(1) }).strict(),
  z.object({ operation: z.enum(['retry', 'refresh', 'stop_waiting', 'relink', 'open']),
    commandId: z.string().trim().min(1) }).strict(),
]));
export type AccountHomeContinuationInputV1 = z.infer<typeof AccountHomeContinuationInputV1Schema>;
export type AccountHomeContinuationOperationV1 = AccountHomeContinuationInputV1['operation'];
export const AccountHomeContinuationResultV1Schema = lazyZodSchema(() => z.object({ status: z.literal('completed') }).strict());
