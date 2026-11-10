import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

const SessionIdSchema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1)));
const LocalIdSchema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1)));

export const SessionPendingInputInterruptAndRunRequestV1Schema = lazyZodSchema(() => z.looseObject({
  sessionId: SessionIdSchema,
  localId: LocalIdSchema,
  expectedStateAtMs: z.optional(z.number().check(z.int(), z.nonnegative())),
}));
export type SessionPendingInputInterruptAndRunRequestV1 =
  z.infer<typeof SessionPendingInputInterruptAndRunRequestV1Schema>;

export const SessionPendingInputInterruptAndRunResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('ok', [
  z.looseObject({
    ok: z.literal(true),
    status: z.literal('interrupted'),
    sessionId: SessionIdSchema,
    localId: LocalIdSchema,
  }),
  z.looseObject({
    ok: z.literal(false),
    status: z.enum([
      'unsupported',
      'no_live_terminal',
      'stale_state',
      'not_safe',
      'capture_unavailable',
      'interrupt_failed',
    ]),
    sessionId: SessionIdSchema,
    localId: LocalIdSchema,
    errorCode: z.optional(z.string().check(z.minLength(1))),
    error: z.optional(z.string().check(z.minLength(1))),
  }),
]));
export type SessionPendingInputInterruptAndRunResultV1 =
  z.infer<typeof SessionPendingInputInterruptAndRunResultV1Schema>;

export function buildUnsupportedSessionPendingInputInterruptAndRunResult(
  sessionId: string,
  localId: string,
  method: string,
): SessionPendingInputInterruptAndRunResultV1 {
  return {
    ok: false,
    status: 'unsupported',
    sessionId: SessionIdSchema.parse(sessionId),
    localId: LocalIdSchema.parse(localId),
    errorCode: 'unsupported_session_runtime_method',
    error: `unsupported_session_runtime_method:${method}`,
  };
}
