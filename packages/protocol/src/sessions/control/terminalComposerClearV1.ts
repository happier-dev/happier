import { z } from 'zod';

const SessionTerminalComposerClearSessionIdSchema = z.string().trim().min(1);

export const SESSION_TERMINAL_COMPOSER_CLEAR_SUCCESS_STATUSES = [
  'cleared',
  'already_empty',
] as const;
export type SessionTerminalComposerClearSuccessStatusV1 =
  typeof SESSION_TERMINAL_COMPOSER_CLEAR_SUCCESS_STATUSES[number];

export const SESSION_TERMINAL_COMPOSER_CLEAR_FAILURE_STATUSES = [
  'unsupported',
  'no_live_terminal',
  'not_safe',
  'generating',
  'dialog_open',
  'capture_unavailable',
  'clear_failed',
  'host_dead',
  'stale_state',
  'failed',
] as const;
export type SessionTerminalComposerClearFailureStatusV1 =
  typeof SESSION_TERMINAL_COMPOSER_CLEAR_FAILURE_STATUSES[number];

export const SESSION_TERMINAL_COMPOSER_CLEAR_STATUSES = [
  ...SESSION_TERMINAL_COMPOSER_CLEAR_SUCCESS_STATUSES,
  ...SESSION_TERMINAL_COMPOSER_CLEAR_FAILURE_STATUSES,
] as const;
export type SessionTerminalComposerClearStatusV1 =
  typeof SESSION_TERMINAL_COMPOSER_CLEAR_STATUSES[number];

export const SessionTerminalComposerClearRequestV1Schema = z.object({
  sessionId: SessionTerminalComposerClearSessionIdSchema,
  expectedStateAtMs: z.number().int().nonnegative().optional(),
}).passthrough();
export type SessionTerminalComposerClearRequestV1 = z.infer<typeof SessionTerminalComposerClearRequestV1Schema>;

export const SessionTerminalComposerClearResultV1Schema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    status: z.enum(SESSION_TERMINAL_COMPOSER_CLEAR_SUCCESS_STATUSES),
    sessionId: SessionTerminalComposerClearSessionIdSchema,
  }).passthrough(),
  z.object({
    ok: z.literal(false),
    status: z.enum(SESSION_TERMINAL_COMPOSER_CLEAR_FAILURE_STATUSES),
    sessionId: SessionTerminalComposerClearSessionIdSchema,
    errorCode: z.string().min(1).optional(),
    error: z.string().min(1).optional(),
  }).passthrough(),
]);
export type SessionTerminalComposerClearResultV1 = z.infer<typeof SessionTerminalComposerClearResultV1Schema>;

export function buildUnsupportedSessionTerminalComposerClearResult(
  sessionId: string,
  method: string,
): SessionTerminalComposerClearResultV1 {
  return {
    ok: false,
    status: 'unsupported',
    sessionId: SessionTerminalComposerClearSessionIdSchema.parse(sessionId),
    errorCode: 'unsupported_session_runtime_method',
    error: `unsupported_session_runtime_method:${method}`,
  };
}
