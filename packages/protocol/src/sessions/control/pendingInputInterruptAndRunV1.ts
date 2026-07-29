import { z } from 'zod';

const SessionIdSchema = z.string().trim().min(1);
const LocalIdSchema = z.string().trim().min(1);

export const SessionPendingInputInterruptAndRunRequestV1Schema = z.object({
  sessionId: SessionIdSchema,
  localId: LocalIdSchema,
  expectedStateAtMs: z.number().int().nonnegative().optional(),
}).passthrough();
export type SessionPendingInputInterruptAndRunRequestV1 =
  z.infer<typeof SessionPendingInputInterruptAndRunRequestV1Schema>;

export const SessionPendingInputInterruptAndRunResultV1Schema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    status: z.literal('interrupted'),
    sessionId: SessionIdSchema,
    localId: LocalIdSchema,
  }).passthrough(),
  z.object({
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
    errorCode: z.string().min(1).optional(),
    error: z.string().min(1).optional(),
  }).passthrough(),
]);
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
