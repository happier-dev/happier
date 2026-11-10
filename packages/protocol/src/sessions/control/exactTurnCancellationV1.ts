import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

const SessionIdSchema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1)));
const LocalIdSchema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1)));

export const SessionInputCancelExactTurnRequestV1Schema = lazyZodSchema(() => z.strictObject({
  sessionId: SessionIdSchema,
  localId: LocalIdSchema,
}));
export type SessionInputCancelExactTurnRequestV1 =
  z.infer<typeof SessionInputCancelExactTurnRequestV1Schema>;

export const SessionInputCancelExactTurnResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('ok', [
  z.strictObject({
    ok: z.literal(true),
    status: z.literal('cancelled'),
    sessionId: SessionIdSchema,
    localId: LocalIdSchema,
  }),
  z.strictObject({
    ok: z.literal(false),
    status: z.enum(['notCurrent', 'notRunning', 'unsupported', 'cancel_failed']),
    sessionId: SessionIdSchema,
    localId: LocalIdSchema,
    errorCode: z.optional(z.string().check(z.minLength(1))),
    error: z.optional(z.string().check(z.minLength(1))),
  }),
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
