import { z } from 'zod';

export const DaemonTerminalErrorCodeSchema = z.enum([
  'terminal_disabled',
  'terminal_not_found',
  'terminal_cwd_denied',
  'terminal_spawn_failed',
  'terminal_invalid_request',
  'terminal_busy',
]);
export type DaemonTerminalErrorCode = z.infer<typeof DaemonTerminalErrorCodeSchema>;

export const DaemonTerminalErrorSchema = z.object({
  ok: z.literal(false),
  errorCode: DaemonTerminalErrorCodeSchema,
  error: z.string().min(1),
}).passthrough();
export type DaemonTerminalError = z.infer<typeof DaemonTerminalErrorSchema>;

export const DaemonTerminalEnsureRequestSchema = z.object({
  terminalKey: z.string().min(1).max(2000),
  cwd: z.string().min(1).max(10_000).optional(),
  cols: z.number().int().min(2).max(500).optional(),
  rows: z.number().int().min(2).max(500).optional(),
  initialCommand: z.string().max(100_000).optional(),
}).passthrough();
export type DaemonTerminalEnsureRequest = z.infer<typeof DaemonTerminalEnsureRequestSchema>;

export const DaemonTerminalEnsureResponseSchema = z.union([
  z.object({
    ok: z.literal(true),
    terminalId: z.string().min(1),
    reused: z.boolean(),
  }).passthrough(),
  DaemonTerminalErrorSchema,
]);
export type DaemonTerminalEnsureResponse = z.infer<typeof DaemonTerminalEnsureResponseSchema>;

export const DaemonTerminalStreamReadRequestSchema = z.object({
  terminalId: z.string().min(1),
  cursor: z.number().int().min(0),
  maxBytes: z.number().int().min(1).max(1024 * 1024).optional(),
  maxEvents: z.number().int().min(1).max(2048).optional(),
}).passthrough();
export type DaemonTerminalStreamReadRequest = z.infer<typeof DaemonTerminalStreamReadRequestSchema>;

export const DaemonTerminalStreamEventDataSchema = z.object({
  t: z.literal('data'),
  data: z.string(),
}).passthrough();
export type DaemonTerminalStreamEventData = z.infer<typeof DaemonTerminalStreamEventDataSchema>;

export const DaemonTerminalStreamEventUrlSchema = z.object({
  t: z.literal('url'),
  url: z.string().url(),
  kind: z.enum(['auth', 'generic']),
  suggestOpen: z.boolean().optional(),
}).passthrough();
export type DaemonTerminalStreamEventUrl = z.infer<typeof DaemonTerminalStreamEventUrlSchema>;

export const DaemonTerminalStreamEventGapSchema = z.object({
  t: z.literal('gap'),
  droppedBefore: z.number().int().min(0),
}).passthrough();
export type DaemonTerminalStreamEventGap = z.infer<typeof DaemonTerminalStreamEventGapSchema>;

export const DaemonTerminalStreamEventExitSchema = z.object({
  t: z.literal('exit'),
  exitCode: z.number().int().nullable(),
  signal: z.number().int().nullable(),
}).passthrough();
export type DaemonTerminalStreamEventExit = z.infer<typeof DaemonTerminalStreamEventExitSchema>;

export const DaemonTerminalStreamEventSchema = z.discriminatedUnion('t', [
  DaemonTerminalStreamEventDataSchema,
  DaemonTerminalStreamEventUrlSchema,
  DaemonTerminalStreamEventGapSchema,
  DaemonTerminalStreamEventExitSchema,
]);
export type DaemonTerminalStreamEvent = z.infer<typeof DaemonTerminalStreamEventSchema>;

export const DaemonTerminalStreamReadResponseSchema = z.union([
  z.object({
    ok: z.literal(true),
    terminalId: z.string().min(1),
    events: z.array(DaemonTerminalStreamEventSchema),
    nextCursor: z.number().int().min(0),
    done: z.boolean(),
  }).passthrough(),
  DaemonTerminalErrorSchema,
]);
export type DaemonTerminalStreamReadResponse = z.infer<typeof DaemonTerminalStreamReadResponseSchema>;

export const DaemonTerminalInputRequestSchema = z.object({
  terminalId: z.string().min(1),
  data: z.string(),
}).passthrough();
export type DaemonTerminalInputRequest = z.infer<typeof DaemonTerminalInputRequestSchema>;

export const DaemonTerminalInputResponseSchema = z.union([
  z.object({ ok: z.literal(true) }).passthrough(),
  DaemonTerminalErrorSchema,
]);
export type DaemonTerminalInputResponse = z.infer<typeof DaemonTerminalInputResponseSchema>;

export const DaemonTerminalResizeRequestSchema = z.object({
  terminalId: z.string().min(1),
  cols: z.number().int().min(2).max(500),
  rows: z.number().int().min(2).max(500),
}).passthrough();
export type DaemonTerminalResizeRequest = z.infer<typeof DaemonTerminalResizeRequestSchema>;

export const DaemonTerminalResizeResponseSchema = z.union([
  z.object({ ok: z.literal(true) }).passthrough(),
  DaemonTerminalErrorSchema,
]);
export type DaemonTerminalResizeResponse = z.infer<typeof DaemonTerminalResizeResponseSchema>;

export const DaemonTerminalCloseRequestSchema = z.object({
  terminalId: z.string().min(1),
}).passthrough();
export type DaemonTerminalCloseRequest = z.infer<typeof DaemonTerminalCloseRequestSchema>;

export const DaemonTerminalCloseResponseSchema = z.union([
  z.object({ ok: z.literal(true) }).passthrough(),
  DaemonTerminalErrorSchema,
]);
export type DaemonTerminalCloseResponse = z.infer<typeof DaemonTerminalCloseResponseSchema>;

export const DaemonTerminalRestartRequestSchema = z.object({
  terminalKey: z.string().min(1).max(2000),
  cwd: z.string().min(1).max(10_000).optional(),
  cols: z.number().int().min(2).max(500).optional(),
  rows: z.number().int().min(2).max(500).optional(),
  initialCommand: z.string().max(100_000).optional(),
}).passthrough();
export type DaemonTerminalRestartRequest = z.infer<typeof DaemonTerminalRestartRequestSchema>;

export const DaemonTerminalRestartResponseSchema = DaemonTerminalEnsureResponseSchema;
export type DaemonTerminalRestartResponse = z.infer<typeof DaemonTerminalRestartResponseSchema>;
