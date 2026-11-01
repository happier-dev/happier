import { z } from 'zod';
import { lazySchema } from '../lazySchema.js';

export const SessionTerminalComposerClearRequestV1Schema = lazySchema(() => z
  .object({
    sessionId: z.string().trim().min(1),
    expectedStateAtMs: z.number().int().nonnegative().optional(),
  })
  .passthrough());
export type SessionTerminalComposerClearRequestV1 = z.infer<typeof SessionTerminalComposerClearRequestV1Schema>;

export const SessionTerminalComposerClearSuccessStatusV1Schema = lazySchema(() => z.enum([
  'cleared',
  'already_empty',
]));
export type SessionTerminalComposerClearSuccessStatusV1 =
  z.infer<typeof SessionTerminalComposerClearSuccessStatusV1Schema>;

export const SessionTerminalComposerClearFailureStatusV1Schema = lazySchema(() => z.enum([
  'unsupported',
  'no_live_terminal',
  'not_safe',
  'generating',
  'dialog_open',
  'capture_unavailable',
  'clear_failed',
  'host_dead',
]));
export type SessionTerminalComposerClearFailureStatusV1 =
  z.infer<typeof SessionTerminalComposerClearFailureStatusV1Schema>;

export const SessionTerminalComposerClearResultV1Schema = lazySchema(() => z.discriminatedUnion('ok', [
  z
    .object({
      ok: z.literal(true),
      status: SessionTerminalComposerClearSuccessStatusV1Schema,
      sessionId: z.string().min(1).optional(),
    })
    .passthrough(),
  z
    .object({
      ok: z.literal(false),
      status: SessionTerminalComposerClearFailureStatusV1Schema,
      sessionId: z.string().min(1).optional(),
      errorCode: z.string().min(1).optional(),
      error: z.string().min(1).optional(),
    })
    .passthrough(),
]));
export type SessionTerminalComposerClearResultV1 =
  z.infer<typeof SessionTerminalComposerClearResultV1Schema>;

export function buildUnsupportedSessionTerminalComposerClearResult(
  sessionId: string,
  method: string,
): SessionTerminalComposerClearResultV1 {
  return SessionTerminalComposerClearResultV1Schema.parse({
    ok: false,
    status: 'unsupported',
    sessionId,
    errorCode: 'unsupported_session_runtime_method',
    error: `unsupported_session_runtime_method:${method}`,
  });
}
