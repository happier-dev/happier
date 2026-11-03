import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod/mini';
import { WorkspaceAddressV1Schema } from '../workspaces/workspaceRefV1.js';
import { SpawnFailureV1Schema } from '../machines/processes/spawnFailureV1.js';
import { TerminalGuardStateV1Schema } from '../machines/guard/terminalGuardStateV1.js';

export const DaemonTerminalErrorCodeSchema = lazyZodSchema(() => z.enum([
  'terminal_disabled',
  'terminal_not_found',
  'terminal_forbidden',
  'terminal_unavailable',
  'terminal_cwd_denied',
  'terminal_spawn_failed',
  'terminal_invalid_request',
  'terminal_busy',
  'service_generation_changed',
  'effect_in_progress',
  'service_unavailable',
  'service_admission_unavailable',
  'terminal_resize_unavailable',
  'agent_login_unsupported',
  'agent_cli_missing',
]));
export type DaemonTerminalErrorCode = z.infer<typeof DaemonTerminalErrorCodeSchema>;

export const DaemonTerminalErrorSchema = lazyZodSchema(() => z.looseObject({
  ok: z.literal(false),
  errorCode: DaemonTerminalErrorCodeSchema,
  error: z.string().check(z.minLength(1)),
  spawnFailure: z.optional(SpawnFailureV1Schema),
}));
export type DaemonTerminalError = z.infer<typeof DaemonTerminalErrorSchema>;

export const DaemonTerminalListRequestV1Schema = lazyZodSchema(() => z.strictObject({
  workspace: z.optional(WorkspaceAddressV1Schema),
}));
export type DaemonTerminalListRequestV1 = z.infer<typeof DaemonTerminalListRequestV1Schema>;

export const DaemonTerminalListEntryV1Schema = lazyZodSchema(() => z.strictObject({
  terminalId: z.string().check(z.minLength(1)),
  terminalKey: z.string().check(z.minLength(1), z.maxLength(2000)),
  cwd: z.string().check(z.minLength(1), z.maxLength(10_000)),
  sessionId: z.optional(z.string().check(z.minLength(1), z.maxLength(256))),
  ended: z.boolean(),
  terminalGuardStateV1: z.optional(TerminalGuardStateV1Schema),
  exit: z.nullable(z.strictObject({
    exitCode: z.nullable(z.number().check(z.int())),
    signal: z.nullable(z.number().check(z.int())),
  })),
}));
export type DaemonTerminalListEntryV1 = z.infer<typeof DaemonTerminalListEntryV1Schema>;

export const DaemonTerminalListResponseV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ ok: z.literal(true), terminals: z.array(DaemonTerminalListEntryV1Schema) }),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(DaemonTerminalErrorSchema),
]));
export type DaemonTerminalListResponseV1 = z.infer<typeof DaemonTerminalListResponseV1Schema>;

export const DaemonTerminalLaunchIntentSchema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('package_script'),
    runTargetId: z.string().check(z.trim(), z.minLength(1)),
  }),
  z.strictObject({
    kind: z.literal('service_shell'),
    serviceId: z.string().check(z.trim(), z.minLength(1)),
    expectedGeneration: z.string().check(z.trim(), z.minLength(1)),
  }),
  z.strictObject({
    kind: z.literal('agent_login'),
    agentId: z.string().check(z.trim(), z.minLength(1)),
    launchId: z.optional(z.enum(['primary', 'device_code'])),
  }),
  z.strictObject({
    kind: z.literal('session_attach'),
    sessionId: z.string().check(z.minLength(1), z.maxLength(256)),
  }),
  z.strictObject({
    kind: z.literal('happier_cli'),
    args: z.array(z.string().check(z.minLength(1), z.maxLength(1024))).check(z.minLength(1), z.maxLength(64)),
  }),
]));
export type DaemonTerminalLaunchIntent = z.infer<typeof DaemonTerminalLaunchIntentSchema>;

export const DaemonTerminalEnsureRequestSchema = lazyZodSchema(() => z.strictObject({
  terminalKey: z.string().check(z.minLength(1), z.maxLength(2000)),
  cwd: z.optional(z.string().check(z.minLength(1), z.maxLength(10_000))),
  workspace: z.optional(WorkspaceAddressV1Schema),
  cols: z.optional(z.number().check(z.int(), z.minimum(2), z.maximum(500))),
  rows: z.optional(z.number().check(z.int(), z.minimum(2), z.maximum(500))),
  initialCommand: z.optional(z.string().check(z.maxLength(100_000))),
  launch: z.optional(DaemonTerminalLaunchIntentSchema),
  // Attribution is not authority: the receiving Session owner must prove this
  // identity before admitting a Session-scoped terminal.
  sessionId: z.optional(z.string().check(z.minLength(1), z.maxLength(256))),
}).check(z.refine((value) => value.initialCommand === undefined || value.launch === undefined, { message: 'initialCommand and launch are mutually exclusive' }),
  z.refine(value => value.launch?.kind !== 'service_shell'
    || value.cwd === undefined && value.workspace === undefined && value.sessionId === undefined,
    { path: ['launch'], message: 'service_shell resolves its target context on the daemon' })));
export type DaemonTerminalEnsureRequest = z.infer<typeof DaemonTerminalEnsureRequestSchema>;

export const DaemonTerminalEnsureResponseSchema = lazyZodSchema(() => z.union([
  z.looseObject({
    ok: z.literal(true),
    terminalId: z.string().check(z.minLength(1)),
    reused: z.boolean(),
  }),
  DaemonTerminalErrorSchema,
]));
export type DaemonTerminalEnsureResponse = z.infer<typeof DaemonTerminalEnsureResponseSchema>;

export const DaemonTerminalStreamReadRequestSchema = lazyZodSchema(() => z.strictObject({
  terminalId: z.string().check(z.minLength(1)),
  cursor: z.number().check(z.int(), z.minimum(0)),
  maxBytes: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(1024 * 1024))),
  maxEvents: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(2048))),
}));
export type DaemonTerminalStreamReadRequest = z.infer<typeof DaemonTerminalStreamReadRequestSchema>;

export const DaemonTerminalStreamEventDataSchema = lazyZodSchema(() => z.looseObject({
  t: z.literal('data'),
  data: z.string(),
}));
export type DaemonTerminalStreamEventData = z.infer<typeof DaemonTerminalStreamEventDataSchema>;

export const DaemonTerminalStreamEventUrlSchema = lazyZodSchema(() => z.looseObject({
  t: z.literal('url'),
  url: z.string().check(z.url()),
  kind: z.enum(['auth', 'generic']),
  suggestOpen: z.optional(z.boolean()),
}));
export type DaemonTerminalStreamEventUrl = z.infer<typeof DaemonTerminalStreamEventUrlSchema>;

export const DaemonTerminalStreamEventGapSchema = lazyZodSchema(() => z.looseObject({
  t: z.literal('gap'),
  droppedBefore: z.number().check(z.int(), z.minimum(0)),
}));
export type DaemonTerminalStreamEventGap = z.infer<typeof DaemonTerminalStreamEventGapSchema>;

export const DaemonTerminalStreamEventExitSchema = lazyZodSchema(() => z.looseObject({
  t: z.literal('exit'),
  exitCode: z.nullable(z.number().check(z.int())),
  signal: z.nullable(z.number().check(z.int())),
}));
export type DaemonTerminalStreamEventExit = z.infer<typeof DaemonTerminalStreamEventExitSchema>;

export const DaemonTerminalStreamEventSchema = lazyZodSchema(() => z.discriminatedUnion('t', [
  DaemonTerminalStreamEventDataSchema,
  DaemonTerminalStreamEventUrlSchema,
  DaemonTerminalStreamEventGapSchema,
  DaemonTerminalStreamEventExitSchema,
]));
export type DaemonTerminalStreamEvent = z.infer<typeof DaemonTerminalStreamEventSchema>;

export const DaemonTerminalStreamReadResponseSchema = lazyZodSchema(() => z.union([
  z.looseObject({
    ok: z.literal(true),
    terminalId: z.string().check(z.minLength(1)),
    events: z.array(DaemonTerminalStreamEventSchema),
    nextCursor: z.number().check(z.int(), z.minimum(0)),
    done: z.boolean(),
  }),
  DaemonTerminalErrorSchema,
]));
export type DaemonTerminalStreamReadResponse = z.infer<typeof DaemonTerminalStreamReadResponseSchema>;

export const DaemonTerminalInputRequestSchema = lazyZodSchema(() => z.strictObject({
  terminalId: z.string().check(z.minLength(1)),
  data: z.string(),
}));
export type DaemonTerminalInputRequest = z.infer<typeof DaemonTerminalInputRequestSchema>;

export const DaemonTerminalInputResponseSchema = lazyZodSchema(() => z.union([
  z.looseObject({ ok: z.literal(true) }),
  DaemonTerminalErrorSchema,
]));
export type DaemonTerminalInputResponse = z.infer<typeof DaemonTerminalInputResponseSchema>;

export const DaemonTerminalResizeRequestSchema = lazyZodSchema(() => z.strictObject({
  terminalId: z.string().check(z.minLength(1)),
  cols: z.number().check(z.int(), z.minimum(2), z.maximum(500)),
  rows: z.number().check(z.int(), z.minimum(2), z.maximum(500)),
}));
export type DaemonTerminalResizeRequest = z.infer<typeof DaemonTerminalResizeRequestSchema>;

export const DaemonTerminalResizeResponseSchema = lazyZodSchema(() => z.union([
  z.looseObject({ ok: z.literal(true) }),
  DaemonTerminalErrorSchema,
]));
export type DaemonTerminalResizeResponse = z.infer<typeof DaemonTerminalResizeResponseSchema>;

export const DaemonTerminalCloseRequestSchema = lazyZodSchema(() => z.strictObject({
  terminalId: z.string().check(z.minLength(1)),
}));
export type DaemonTerminalCloseRequest = z.infer<typeof DaemonTerminalCloseRequestSchema>;

export const DaemonTerminalCloseResponseSchema = lazyZodSchema(() => z.union([
  z.looseObject({ ok: z.literal(true) }),
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
