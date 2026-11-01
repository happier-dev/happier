import { z } from 'zod';
import { lazySchema } from './lazySchema.js';

export const SessionRollbackTargetSchema = lazySchema(() => z.discriminatedUnion('type', [
  z.object({ type: z.literal('latest_turn') }).strict(),
  z
    .object({
      type: z.literal('before_user_message'),
      userMessageSeq: z.number().int().nonnegative(),
    })
    .strict(),
]));
export type SessionRollbackTarget = z.infer<typeof SessionRollbackTargetSchema>;

export const SessionRollbackRpcParamsSchema = lazySchema(() => z
  .object({
    v: z.literal(1),
    target: SessionRollbackTargetSchema.default({ type: 'latest_turn' }),
  })
  .strict());
export type SessionRollbackRpcParams = z.infer<typeof SessionRollbackRpcParamsSchema>;

export const SessionRollbackRpcResultSchema = lazySchema(() => z.union([
  z
    .object({
      ok: z.literal(true),
      target: SessionRollbackTargetSchema,
      threadId: z.string().min(1).optional(),
    })
    .passthrough(),
  z
    .object({
      ok: z.literal(false),
      errorCode: z.string().min(1),
      errorMessage: z.string().min(1),
    })
    .passthrough(),
]));
export type SessionRollbackRpcResult = z.infer<typeof SessionRollbackRpcResultSchema>;
