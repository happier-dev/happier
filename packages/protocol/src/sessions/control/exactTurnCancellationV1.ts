import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

const SessionIdSchema = lazyZodSchema(() => z.string().trim().min(1));
const LocalIdSchema = lazyZodSchema(() => z.string().trim().min(1));

export const SessionInputCancelExactTurnRequestV1Schema = lazyZodSchema(() => z.object({
  sessionId: SessionIdSchema,
  localId: LocalIdSchema,
}).strict());
export type SessionInputCancelExactTurnRequestV1 =
  z.infer<typeof SessionInputCancelExactTurnRequestV1Schema>;

export const SessionInputCancelExactTurnResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    status: z.literal('cancelled'),
    sessionId: SessionIdSchema,
    localId: LocalIdSchema,
  }).strict(),
  z.object({
    ok: z.literal(false),
    status: z.enum(['notCurrent', 'notRunning', 'unsupported', 'cancel_failed']),
    sessionId: SessionIdSchema,
    localId: LocalIdSchema,
    errorCode: z.string().min(1).optional(),
    error: z.string().min(1).optional(),
  }).strict(),
]));
export type SessionInputCancelExactTurnResultV1 =
  z.infer<typeof SessionInputCancelExactTurnResultV1Schema>;

export function buildUnsupportedSessionInputCancelExactTurnResultV1(
  sessionId: string,
  localId: string,
  method: string,
): SessionInputCancelExactTurnResultV1 {
  return {
    ok: false,
    status: 'unsupported',
    sessionId: SessionIdSchema.parse(sessionId),
    localId: LocalIdSchema.parse(localId),
    errorCode: 'unsupported_session_runtime_method',
    error: `unsupported_session_runtime_method:${method}`,
  };
}
