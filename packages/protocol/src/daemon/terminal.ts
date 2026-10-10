import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';
import { WorkspaceAddressV1Schema } from '../workspaces/workspaceRefV1.js';

export const DaemonTerminalErrorCodeSchema = lazyZodSchema(() => z.enum([
  'terminal_disabled',
  'terminal_not_found',
  'terminal_forbidden',
  'terminal_unavailable',
  'terminal_cwd_denied',
  'terminal_spawn_failed',
  'terminal_invalid_request',
  'terminal_busy',
  'terminal_resize_unavailable',
  'agent_login_unsupported',
  'agent_cli_missing',
]));
export type DaemonTerminalErrorCode = z.infer<typeof DaemonTerminalErrorCodeSchema>;

export const DaemonTerminalErrorSchema = lazyZodSchema(() => z.object({
  ok: z.literal(false),
  errorCode: DaemonTerminalErrorCodeSchema,
  error: z.string().min(1),
}).passthrough());
export type DaemonTerminalError = z.infer<typeof DaemonTerminalErrorSchema>;

export const DaemonTerminalListRequestV1Schema = lazyZodSchema(() => z.object({
  workspace: WorkspaceAddressV1Schema.optional(),
}).strict());
export type DaemonTerminalListRequestV1 = z.infer<typeof DaemonTerminalListRequestV1Schema>;

export const DaemonTerminalListEntryV1Schema = lazyZodSchema(() => z.object({
  terminalId: z.string().min(1),
  terminalKey: z.string().min(1).max(2000),
  cwd: z.string().min(1).max(10_000),
  sessionId: z.string().min(1).max(256).optional(),
  ended: z.boolean(),
  exit: z.object({
    exitCode: z.number().int().nullable(),
    signal: z.number().int().nullable(),
  }).strict().nullable(),
}).strict());
export type DaemonTerminalListEntryV1 = z.infer<typeof DaemonTerminalListEntryV1Schema>;

export const DaemonTerminalListResponseV1Schema = lazyZodSchema(() => z.union([
  z.object({ ok: z.literal(true), terminals: z.array(DaemonTerminalListEntryV1Schema) }).strict(),
  DaemonTerminalErrorSchema.strict(),
]));
export type DaemonTerminalListResponseV1 = z.infer<typeof DaemonTerminalListResponseV1Schema>;

export const DaemonTerminalLaunchIntentSchema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('package_script'),
    runTargetId: z.string().trim().min(1),
  }).strict(),
  z.object({
    kind: z.literal('agent_login'),
    agentId: z.string().trim().min(1),
    launchId: z.enum(['primary', 'device_code']).optional(),
  }).strict(),
  z.object({
    kind: z.literal('session_attach'),
    sessionId: z.string().min(1).max(256),
  }).strict(),
  z.object({
    kind: z.literal('happier_cli'),
    args: z.array(z.string().min(1).max(1024)).min(1).max(64),
  }).strict(),
]));
export type DaemonTerminalLaunchIntent = z.infer<typeof DaemonTerminalLaunchIntentSchema>;

export const DaemonTerminalEnsureRequestSchema = lazyZodSchema(() => z.object({
  terminalKey: z.string().min(1).max(2000),
  cwd: z.string().min(1).max(10_000).optional(),
  workspace: WorkspaceAddressV1Schema.optional(),
  cols: z.number().int().min(2).max(500).optional(),
  rows: z.number().int().min(2).max(500).optional(),
  initialCommand: z.string().max(100_000).optional(),
  launch: DaemonTerminalLaunchIntentSchema.optional(),
  // Attribution is not authority: the receiving Session owner must prove this
  // identity before admitting a Session-scoped terminal.
  sessionId: z.string().min(1).max(256).optional(),
}).strict().refine(
  (value) => value.initialCommand === undefined || value.launch === undefined,
  { message: 'initialCommand and launch are mutually exclusive' },
));
export type DaemonTerminalEnsureRequest = z.infer<typeof DaemonTerminalEnsureRequestSchema>;

export const DaemonTerminalEnsureResponseSchema = lazyZodSchema(() => z.union([
  z.object({
    ok: z.literal(true),
    terminalId: z.string().min(1),
    reused: z.boolean(),
  }).passthrough(),
  DaemonTerminalErrorSchema,
]));
export type DaemonTerminalEnsureResponse = z.infer<typeof DaemonTerminalEnsureResponseSchema>;

export const DaemonTerminalStreamReadRequestSchema = lazyZodSchema(() => z.object({
  terminalId: z.string().min(1),
  cursor: z.number().int().min(0),
  maxBytes: z.number().int().min(1).max(1024 * 1024).optional(),
  maxEvents: z.number().int().min(1).max(2048).optional(),
}).strict());
export type DaemonTerminalStreamReadRequest = z.infer<typeof DaemonTerminalStreamReadRequestSchema>;

export const DaemonTerminalStreamEventDataSchema = lazyZodSchema(() => z.object({
  t: z.literal('data'),
  data: z.string(),
}).passthrough());
export type DaemonTerminalStreamEventData = z.infer<typeof DaemonTerminalStreamEventDataSchema>;

export const DaemonTerminalStreamEventUrlSchema = lazyZodSchema(() => z.object({
  t: z.literal('url'),
  url: z.string().url(),
  kind: z.enum(['auth', 'generic']),
  suggestOpen: z.boolean().optional(),
}).passthrough());
export type DaemonTerminalStreamEventUrl = z.infer<typeof DaemonTerminalStreamEventUrlSchema>;

export const DaemonTerminalStreamEventGapSchema = lazyZodSchema(() => z.object({
  t: z.literal('gap'),
  droppedBefore: z.number().int().min(0),
}).passthrough());
export type DaemonTerminalStreamEventGap = z.infer<typeof DaemonTerminalStreamEventGapSchema>;

export const DaemonTerminalStreamEventExitSchema = lazyZodSchema(() => z.object({
  t: z.literal('exit'),
  exitCode: z.number().int().nullable(),
  signal: z.number().int().nullable(),
}).passthrough());
export type DaemonTerminalStreamEventExit = z.infer<typeof DaemonTerminalStreamEventExitSchema>;

export const DaemonTerminalStreamEventSchema = lazyZodSchema(() => z.discriminatedUnion('t', [
  DaemonTerminalStreamEventDataSchema,
  DaemonTerminalStreamEventUrlSchema,
  DaemonTerminalStreamEventGapSchema,
  DaemonTerminalStreamEventExitSchema,
]));
export type DaemonTerminalStreamEvent = z.infer<typeof DaemonTerminalStreamEventSchema>;

export const DaemonTerminalStreamReadResponseSchema = lazyZodSchema(() => z.union([
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

export const DaemonTerminalInputRequestSchema = lazyZodSchema(() => z.object({
  terminalId: z.string().min(1),
  data: z.string(),
}).strict());
export type DaemonTerminalInputRequest = z.infer<typeof DaemonTerminalInputRequestSchema>;

export const DaemonTerminalInputResponseSchema = lazyZodSchema(() => z.union([
  z.object({ ok: z.literal(true) }).passthrough(),
  DaemonTerminalErrorSchema,
]));
export type DaemonTerminalInputResponse = z.infer<typeof DaemonTerminalInputResponseSchema>;

export const DaemonTerminalResizeRequestSchema = lazyZodSchema(() => z.object({
  terminalId: z.string().min(1),
  cols: z.number().int().min(2).max(500),
  rows: z.number().int().min(2).max(500),
}).strict());
export type DaemonTerminalResizeRequest = z.infer<typeof DaemonTerminalResizeRequestSchema>;

export const DaemonTerminalResizeResponseSchema = lazyZodSchema(() => z.union([
  z.object({ ok: z.literal(true) }).passthrough(),
  DaemonTerminalErrorSchema,
]));
export type DaemonTerminalResizeResponse = z.infer<typeof DaemonTerminalResizeResponseSchema>;

export const DaemonTerminalCloseRequestSchema = lazyZodSchema(() => z.object({
  terminalId: z.string().min(1),
}).strict());
export type DaemonTerminalCloseRequest = z.infer<typeof DaemonTerminalCloseRequestSchema>;

export const DaemonTerminalCloseResponseSchema = lazyZodSchema(() => z.union([
  z.object({ ok: z.literal(true) }).passthrough(),
  DaemonTerminalErrorSchema,
]));
export type DaemonTerminalCloseResponse = z.infer<typeof DaemonTerminalCloseResponseSchema>;

export const DaemonTerminalRestartRequestSchema = DaemonTerminalEnsureRequestSchema;
export type DaemonTerminalRestartRequest = z.infer<typeof DaemonTerminalRestartRequestSchema>;

export const DaemonTerminalRestartResponseSchema = DaemonTerminalEnsureResponseSchema;
export type DaemonTerminalRestartResponse = z.infer<typeof DaemonTerminalRestartResponseSchema>;

export {
  TerminalStreamAckRequestSchema,
  TerminalStreamAckResponseSchema,
  TerminalStreamBytesEncodingSchema,
  TerminalStreamBytesFrameSchema,
  TerminalStreamControlFrameSchema,
  TerminalStreamFrameSchema,
  TerminalStreamReadRequestSchema,
  TerminalStreamReadResponseSchema,
  decodeTerminalStreamBytesFrame,
  encodeTerminalStreamBytes,
  type TerminalStreamAckRequest,
  type TerminalStreamAckResponse,
  type TerminalStreamBytesEncoding,
  type TerminalStreamBytesFrame,
  type TerminalStreamControlFrame,
  type TerminalStreamFrame,
  type TerminalStreamReadRequest,
  type TerminalStreamReadResponse,
} from '../terminal/stream.js';

export {
  TerminalInputEventSchema,
  TerminalStreamInputRequestSchema,
  TerminalStreamInputResponseSchema,
  type TerminalInputEvent,
  type TerminalStreamInputRequest,
  type TerminalStreamInputResponse,
} from '../terminal/input.js';
