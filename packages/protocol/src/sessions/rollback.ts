import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';

export const SessionRollbackTargetSchema = lazyZodSchema(() => z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('latest_turn') }),
  z.strictObject({
      type: z.literal('before_user_message'),
      userMessageSeq: z.number().check(z.int(), z.nonnegative()),
    }),
]));
export type SessionRollbackTarget = z.infer<typeof SessionRollbackTargetSchema>;

export const SessionRollbackRpcParamsSchema = lazyZodSchema(() => z.strictObject({
    v: z.literal(1),
    target: z._default(SessionRollbackTargetSchema, { type: 'latest_turn' }),
  }));
export type SessionRollbackRpcParams = z.infer<typeof SessionRollbackRpcParamsSchema>;

export const SessionRollbackRpcResultSchema = lazyZodSchema(() => z.union([
  z.looseObject({
      ok: z.literal(true),
      target: SessionRollbackTargetSchema,
      threadId: z.optional(z.string().check(z.minLength(1))),
    }),
  z.looseObject({
      ok: z.literal(false),
      errorCode: z.string().check(z.minLength(1)),
      errorMessage: z.string().check(z.minLength(1)),
    }),
]));
export type SessionRollbackRpcResult = z.infer<typeof SessionRollbackRpcResultSchema>;
