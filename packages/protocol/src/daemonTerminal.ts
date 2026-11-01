import { z } from 'zod';
import { lazySchema } from './lazySchema.js';

export const DaemonTerminalErrorCodeSchema = lazySchema(() => z.enum([
  'terminal_disabled',
  'terminal_not_found',
  'terminal_cwd_denied',
  'terminal_spawn_failed',
  'terminal_invalid_request',
  'terminal_busy',
  'terminal_resize_unavailable',
]));
export type DaemonTerminalErrorCode = z.infer<typeof DaemonTerminalErrorCodeSchema>;

export const DaemonTerminalErrorSchema = lazySchema(() => z.object({
  ok: z.literal(false),
  errorCode: DaemonTerminalErrorCodeSchema,
  error: z.string().min(1),
}).passthrough());
export type DaemonTerminalError = z.infer<typeof DaemonTerminalErrorSchema>;

export const DaemonTerminalLaunchIntentSchema = lazySchema(() => z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('session_attach'),
    sessionId: z.string().trim().min(1).max(512),
  }),
  z.object({
    kind: z.literal('happier_cli'),
    args: z.array(z.string().min(1).max(1024)).min(1).max(64),
  }),
]));
export type DaemonTerminalLaunchIntent = z.infer<typeof DaemonTerminalLaunchIntentSchema>;

function buildDaemonTerminalLaunchRequestSchema() {
  return z.object({
  terminalKey: z.string().min(1).max(2000).optional(),
  cwd: z.string().min(1).max(10_000).optional(),
  cols: z.number().int().min(2).max(500).optional(),
  rows: z.number().int().min(2).max(500).optional(),
  initialCommand: z.string().max(100_000).optional(),
  launch: DaemonTerminalLaunchIntentSchema.optional(),
  }).passthrough().superRefine((value, ctx) => {
    if (!value.terminalKey && !value.launch) {
      ctx.addIssue({ code: 'custom', path: ['terminalKey'], message: 'terminalKey or launch is required' });
    }
    if (value.launch && value.initialCommand !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['initialCommand'], message: 'initialCommand cannot be combined with launch' });
    }
  });
}

export const DaemonTerminalEnsureRequestSchema = lazySchema(() => buildDaemonTerminalLaunchRequestSchema());
export type DaemonTerminalEnsureRequest = z.infer<typeof DaemonTerminalEnsureRequestSchema>;

export const DaemonTerminalEnsureResponseSchema = lazySchema(() => z.union([
  z.object({
    ok: z.literal(true),
    terminalId: z.string().min(1),
    reused: z.boolean(),
  }).passthrough(),
  DaemonTerminalErrorSchema,
]));
export type DaemonTerminalEnsureResponse = z.infer<typeof DaemonTerminalEnsureResponseSchema>;

export const DaemonTerminalStreamReadRequestSchema = lazySchema(() => z.object({
  terminalId: z.string().min(1),
  cursor: z.number().int().min(0),
  maxBytes: z.number().int().min(1).max(1024 * 1024).optional(),
  maxEvents: z.number().int().min(1).max(2048).optional(),
}).passthrough());
export type DaemonTerminalStreamReadRequest = z.infer<typeof DaemonTerminalStreamReadRequestSchema>;

export const DaemonTerminalStreamEventDataSchema = lazySchema(() => z.object({
  t: z.literal('data'),
  data: z.string(),
}).passthrough());
export type DaemonTerminalStreamEventData = z.infer<typeof DaemonTerminalStreamEventDataSchema>;

export const DaemonTerminalStreamEventUrlSchema = lazySchema(() => z.object({
  t: z.literal('url'),
  url: z.string().url(),
  kind: z.enum(['auth', 'generic']),
  suggestOpen: z.boolean().optional(),
}).passthrough());
export type DaemonTerminalStreamEventUrl = z.infer<typeof DaemonTerminalStreamEventUrlSchema>;

export const DaemonTerminalStreamEventGapSchema = lazySchema(() => z.object({
  t: z.literal('gap'),
  droppedBefore: z.number().int().min(0),
}).passthrough());
export type DaemonTerminalStreamEventGap = z.infer<typeof DaemonTerminalStreamEventGapSchema>;

export const DaemonTerminalStreamEventExitSchema = lazySchema(() => z.object({
  t: z.literal('exit'),
  exitCode: z.number().int().nullable(),
  signal: z.number().int().nullable(),
}).passthrough());
export type DaemonTerminalStreamEventExit = z.infer<typeof DaemonTerminalStreamEventExitSchema>;

export const DaemonTerminalStreamEventSchema = lazySchema(() => z.discriminatedUnion('t', [
  DaemonTerminalStreamEventDataSchema,
  DaemonTerminalStreamEventUrlSchema,
  DaemonTerminalStreamEventGapSchema,
  DaemonTerminalStreamEventExitSchema,
]));
export type DaemonTerminalStreamEvent = z.infer<typeof DaemonTerminalStreamEventSchema>;

export const DaemonTerminalStreamReadResponseSchema = lazySchema(() => z.union([
  z.object({
    ok: z.literal(true),
    terminalId: z.string().min(1),
    events: z.array(DaemonTerminalStreamEventSchema),
    nextCursor: z.number().int().min(0),
    done: z.boolean(),
  }).passthrough(),
  DaemonTerminalErrorSchema,
]));
export type DaemonTerminalStreamReadResponse = z.infer<typeof DaemonTerminalStreamReadResponseSchema>;

export const DaemonTerminalInputRequestSchema = lazySchema(() => z.object({
  terminalId: z.string().min(1),
  data: z.string(),
}).passthrough());
export type DaemonTerminalInputRequest = z.infer<typeof DaemonTerminalInputRequestSchema>;

export const DaemonTerminalInputResponseSchema = lazySchema(() => z.union([
  z.object({ ok: z.literal(true) }).passthrough(),
  DaemonTerminalErrorSchema,
]));
export type DaemonTerminalInputResponse = z.infer<typeof DaemonTerminalInputResponseSchema>;

export const DaemonTerminalResizeRequestSchema = lazySchema(() => z.object({
  terminalId: z.string().min(1),
  cols: z.number().int().min(2).max(500),
  rows: z.number().int().min(2).max(500),
}).passthrough());
export type DaemonTerminalResizeRequest = z.infer<typeof DaemonTerminalResizeRequestSchema>;

export const DaemonTerminalResizeResponseSchema = lazySchema(() => z.union([
  z.object({ ok: z.literal(true) }).passthrough(),
  DaemonTerminalErrorSchema,
]));
export type DaemonTerminalResizeResponse = z.infer<typeof DaemonTerminalResizeResponseSchema>;

export const DaemonTerminalCloseRequestSchema = lazySchema(() => z.object({
  terminalId: z.string().min(1),
}).passthrough());
export type DaemonTerminalCloseRequest = z.infer<typeof DaemonTerminalCloseRequestSchema>;

export const DaemonTerminalCloseResponseSchema = lazySchema(() => z.union([
  z.object({ ok: z.literal(true) }).passthrough(),
  DaemonTerminalErrorSchema,
]));
export type DaemonTerminalCloseResponse = z.infer<typeof DaemonTerminalCloseResponseSchema>;

export const DaemonTerminalRestartRequestSchema = lazySchema(() => buildDaemonTerminalLaunchRequestSchema());
export type DaemonTerminalRestartRequest = z.infer<typeof DaemonTerminalRestartRequestSchema>;

export const DaemonTerminalRestartResponseSchema = DaemonTerminalEnsureResponseSchema;
export type DaemonTerminalRestartResponse = z.infer<typeof DaemonTerminalRestartResponseSchema>;
