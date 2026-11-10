import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';

/** Material stays with the mounted human recovery flow, never in an Action. */
export const AccountHomeContinuationInputV1Schema = lazyZodSchema(() => z.discriminatedUnion('operation', [
  z.strictObject({ operation: z.literal('choose'), commandId: z.string().check(z.trim(), z.minLength(1)),
    homeServerIdentityId: z.string().check(z.trim(), z.minLength(1)) }),
  z.strictObject({ operation: z.enum(['retry', 'refresh', 'stop_waiting', 'relink', 'open']),
    commandId: z.string().check(z.trim(), z.minLength(1)) }),
]));
export type AccountHomeContinuationInputV1 = z.infer<typeof AccountHomeContinuationInputV1Schema>;
export type AccountHomeContinuationOperationV1 = AccountHomeContinuationInputV1['operation'];
export const AccountHomeContinuationResultV1Schema = lazyZodSchema(() => z.strictObject({ status: z.literal('completed') }));
