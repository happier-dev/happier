import { z } from 'zod';
import { VoiceAssistantActionSchema } from './voiceActions.js';

/**
 * Public contract for execution runs (sub-agents / reviews / planning / delegation / voice agent).
 *
 * Notes:
 * - This schema is used by session-scoped RPC + MCP and must remain stable and bounded.
 * - Rich/large UI payloads (e.g. full review findings) are carried via transcript message `meta.happier`.
 */

export const ExecutionRunIntentSchema = z.enum([
  'review',
  'plan',
  'delegate',
  'voice_agent',
  'memory_hints',
]);
export type ExecutionRunIntent = z.infer<typeof ExecutionRunIntentSchema>;

// Canonical, stable error code vocabulary for RPC `errorCode` and MCP `error.code`.
// Keep this pinned and deterministic; clients should branch on these strings.
export const ExecutionRunTransportErrorCodeSchema = z.enum([
  'execution_run_not_allowed',
  'execution_run_not_found',
  'execution_run_action_not_supported',
  'execution_run_invalid_action_input',
  'execution_run_stream_not_found',
  'execution_run_busy',
  'execution_run_failed',
  'execution_run_budget_exceeded',
  'run_depth_exceeded',
  'permission_denied',
]);
export type ExecutionRunTransportErrorCode = z.infer<typeof ExecutionRunTransportErrorCodeSchema>;

export const ExecutionRunStatusSchema = z.enum([
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'timeout',
]);
export type ExecutionRunStatus = z.infer<typeof ExecutionRunStatusSchema>;

export const ExecutionRunErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string().optional(),
}).passthrough();
export type ExecutionRunError = z.infer<typeof ExecutionRunErrorSchema>;

export const ExecutionRunRetentionPolicySchema = z.enum(['ephemeral', 'resumable']);
export type ExecutionRunRetentionPolicy = z.infer<typeof ExecutionRunRetentionPolicySchema>;

export const ExecutionRunClassSchema = z.enum(['bounded', 'long_lived']);
export type ExecutionRunClass = z.infer<typeof ExecutionRunClassSchema>;

export const ExecutionRunIoModeSchema = z.enum(['request_response', 'streaming']);
export type ExecutionRunIoMode = z.infer<typeof ExecutionRunIoModeSchema>;

export const ExecutionRunResumeHandleVendorSessionV1Schema = z.object({
  kind: z.literal('vendor_session.v1'),
  backendId: z.string().min(1),
  vendorSessionId: z.string().min(1),
}).passthrough();
export type ExecutionRunResumeHandleVendorSessionV1 = z.infer<typeof ExecutionRunResumeHandleVendorSessionV1Schema>;

export const ExecutionRunResumeHandleVoiceAgentSessionsV1Schema = z.object({
  kind: z.literal('voice_agent_sessions.v1'),
  backendId: z.string().min(1),
  chatVendorSessionId: z.string().min(1),
  commitVendorSessionId: z.string().min(1),
}).passthrough();
export type ExecutionRunResumeHandleVoiceAgentSessionsV1 = z.infer<typeof ExecutionRunResumeHandleVoiceAgentSessionsV1Schema>;

export const ExecutionRunResumeHandleSchema = z.discriminatedUnion('kind', [
  ExecutionRunResumeHandleVendorSessionV1Schema,
  ExecutionRunResumeHandleVoiceAgentSessionsV1Schema,
]);
export type ExecutionRunResumeHandle = z.infer<typeof ExecutionRunResumeHandleSchema>;

export const ExecutionRunDisplaySchema = z.object({
  /**
   * Optional user-facing label/title for the run (used for future group chat + participant labeling).
   */
  title: z.string().min(1).max(200).optional(),
  /**
   * Optional short participant label (e.g. "Reviewer A") for merged/group views.
   */
  participantLabel: z.string().min(1).max(80).optional(),
  /**
   * Optional group ID used to render multiple runs as a logical "group chat" in UI.
   */
  groupId: z.string().min(1).max(120).optional(),
}).passthrough();
export type ExecutionRunDisplay = z.infer<typeof ExecutionRunDisplaySchema>;

export const ExecutionRunPublicStateSchema = z.object({
  runId: z.string().min(1),
  callId: z.string().min(1),
  sidechainId: z.string().min(1),
  intent: ExecutionRunIntentSchema,
  backendId: z.string().min(1),
  display: ExecutionRunDisplaySchema.optional(),
  // Policy/class fields are required for client surfaces (e.g. to decide if send/resume controls apply).
  permissionMode: z.string().min(1),
  retentionPolicy: ExecutionRunRetentionPolicySchema,
  runClass: ExecutionRunClassSchema,
  ioMode: ExecutionRunIoModeSchema,
  status: ExecutionRunStatusSchema,
  resumeHandle: ExecutionRunResumeHandleSchema.optional(),
  startedAtMs: z.number().int().nonnegative(),
  finishedAtMs: z.number().int().nonnegative().optional(),
  error: ExecutionRunErrorSchema.optional(),
}).passthrough();
export type ExecutionRunPublicState = z.infer<typeof ExecutionRunPublicStateSchema>;

export const ExecutionRunStartRequestSchema = z.object({
  intent: ExecutionRunIntentSchema,
  backendId: z.string().min(1),
  instructions: z.string().optional(),
  display: ExecutionRunDisplaySchema.optional(),
  permissionMode: z.string().min(1),
  retentionPolicy: ExecutionRunRetentionPolicySchema,
  runClass: ExecutionRunClassSchema,
  ioMode: ExecutionRunIoModeSchema,
  resumeHandle: ExecutionRunResumeHandleSchema.nullable().optional(),
}).passthrough();
export type ExecutionRunStartRequest = z.infer<typeof ExecutionRunStartRequestSchema>;

export const ExecutionRunStartResponseSchema = z.object({
  runId: z.string().min(1),
  callId: z.string().min(1),
  sidechainId: z.string().min(1),
}).passthrough();
export type ExecutionRunStartResponse = z.infer<typeof ExecutionRunStartResponseSchema>;

export const ExecutionRunListRequestSchema = z.object({}).passthrough();
export type ExecutionRunListRequest = z.infer<typeof ExecutionRunListRequestSchema>;

export const ExecutionRunListResponseSchema = z.object({
  runs: z.array(ExecutionRunPublicStateSchema),
}).passthrough();
export type ExecutionRunListResponse = z.infer<typeof ExecutionRunListResponseSchema>;

export const ExecutionRunGetRequestSchema = z.object({
  runId: z.string().min(1),
  includeStructured: z.boolean().optional(),
}).passthrough();
export type ExecutionRunGetRequest = z.infer<typeof ExecutionRunGetRequestSchema>;

export const ExecutionRunGetResponseSchema = z.object({
  run: ExecutionRunPublicStateSchema,
  latestToolResult: z.unknown().optional(),
  structuredMeta: z.object({ kind: z.string(), payload: z.unknown() }).passthrough().optional(),
  structuredMetaArtifactRef: z.object({ artifactId: z.string().min(1) }).passthrough().optional(),
}).passthrough();
export type ExecutionRunGetResponse = z.infer<typeof ExecutionRunGetResponseSchema>;

export const ExecutionRunSendRequestSchema = z.object({
  runId: z.string().min(1),
  message: z.string().min(1),
  resume: z.boolean().optional(),
}).passthrough();
export type ExecutionRunSendRequest = z.infer<typeof ExecutionRunSendRequestSchema>;

export const ExecutionRunSendResponseSchema = z.object({ ok: z.literal(true) }).passthrough();
export type ExecutionRunSendResponse = z.infer<typeof ExecutionRunSendResponseSchema>;

export const ExecutionRunStopRequestSchema = z.object({ runId: z.string().min(1) }).passthrough();
export type ExecutionRunStopRequest = z.infer<typeof ExecutionRunStopRequestSchema>;

export const ExecutionRunStopResponseSchema = z.object({ ok: z.literal(true) }).passthrough();
export type ExecutionRunStopResponse = z.infer<typeof ExecutionRunStopResponseSchema>;

export const ExecutionRunEnsureRequestSchema = z.object({
  runId: z.string().min(1),
  resume: z.boolean().optional(),
}).passthrough();
export type ExecutionRunEnsureRequest = z.infer<typeof ExecutionRunEnsureRequestSchema>;

export const ExecutionRunEnsureResponseSchema = z.union([
  z.object({ ok: z.literal(true) }).passthrough(),
  z.object({ ok: z.literal(false), error: z.string().min(1), errorCode: z.string().min(1).optional() }).passthrough(),
]);
export type ExecutionRunEnsureResponse = z.infer<typeof ExecutionRunEnsureResponseSchema>;

export const ExecutionRunEnsureOrStartRequestSchema = z.object({
  runId: z.string().min(1).nullable().optional(),
  start: ExecutionRunStartRequestSchema.optional(),
  resume: z.boolean().optional(),
}).passthrough().superRefine((value, ctx) => {
  const runId = typeof value.runId === 'string' ? value.runId.trim() : '';
  if (!runId) {
    if (!value.start) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'start is required when runId is missing' });
    }
  }
});
export type ExecutionRunEnsureOrStartRequest = z.infer<typeof ExecutionRunEnsureOrStartRequestSchema>;

export const ExecutionRunEnsureOrStartResponseSchema = z.union([
  z.object({ ok: z.literal(true), runId: z.string().min(1), created: z.boolean() }).passthrough(),
  z.object({ ok: z.literal(false), error: z.string().min(1), errorCode: z.string().min(1).optional() }).passthrough(),
]);
export type ExecutionRunEnsureOrStartResponse = z.infer<typeof ExecutionRunEnsureOrStartResponseSchema>;

export const ExecutionRunActionRequestSchema = z.object({
  runId: z.string().min(1),
  actionId: z.string().min(1),
  input: z.unknown().optional(),
}).passthrough();
export type ExecutionRunActionRequest = z.infer<typeof ExecutionRunActionRequestSchema>;

export const ExecutionRunActionResponseSchema = z.object({
  ok: z.boolean(),
  updatedToolResult: z.unknown().optional(),
}).passthrough();
export type ExecutionRunActionResponse = z.infer<typeof ExecutionRunActionResponseSchema>;

// Streaming turn IO (V1: used for intent='voice_agent').
export const ExecutionRunTurnStreamStartRequestSchema = z.object({
  runId: z.string().min(1),
  message: z.string().min(1),
  resume: z.boolean().optional(),
}).passthrough();
export type ExecutionRunTurnStreamStartRequest = z.infer<typeof ExecutionRunTurnStreamStartRequestSchema>;

export const ExecutionRunTurnStreamStartResponseSchema = z.object({
  streamId: z.string().min(1),
}).passthrough();
export type ExecutionRunTurnStreamStartResponse = z.infer<typeof ExecutionRunTurnStreamStartResponseSchema>;

export const ExecutionRunTurnStreamReadRequestSchema = z.object({
  runId: z.string().min(1),
  streamId: z.string().min(1),
  cursor: z.number().int().min(0),
  maxEvents: z.number().int().min(1).max(256).optional(),
}).passthrough();
export type ExecutionRunTurnStreamReadRequest = z.infer<typeof ExecutionRunTurnStreamReadRequestSchema>;

export const ExecutionRunTurnStreamEventDeltaSchema = z.object({
  t: z.literal('delta'),
  textDelta: z.string(),
}).passthrough();
export type ExecutionRunTurnStreamEventDelta = z.infer<typeof ExecutionRunTurnStreamEventDeltaSchema>;

export const ExecutionRunTurnStreamEventDoneSchema = z.object({
  t: z.literal('done'),
  assistantText: z.string(),
  actions: z.array(VoiceAssistantActionSchema).optional(),
}).passthrough();
export type ExecutionRunTurnStreamEventDone = z.infer<typeof ExecutionRunTurnStreamEventDoneSchema>;

export const ExecutionRunTurnStreamEventErrorSchema = z.object({
  t: z.literal('error'),
  error: z.string(),
  errorCode: z.string().optional(),
}).passthrough();
export type ExecutionRunTurnStreamEventError = z.infer<typeof ExecutionRunTurnStreamEventErrorSchema>;

export const ExecutionRunTurnStreamEventSchema = z.discriminatedUnion('t', [
  ExecutionRunTurnStreamEventDeltaSchema,
  ExecutionRunTurnStreamEventDoneSchema,
  ExecutionRunTurnStreamEventErrorSchema,
]);
export type ExecutionRunTurnStreamEvent = z.infer<typeof ExecutionRunTurnStreamEventSchema>;

export const ExecutionRunTurnStreamReadResponseSchema = z.object({
  streamId: z.string().min(1),
  events: z.array(ExecutionRunTurnStreamEventSchema),
  nextCursor: z.number().int().min(0),
  done: z.boolean(),
}).passthrough();
export type ExecutionRunTurnStreamReadResponse = z.infer<typeof ExecutionRunTurnStreamReadResponseSchema>;

export const ExecutionRunTurnStreamCancelRequestSchema = z.object({
  runId: z.string().min(1),
  streamId: z.string().min(1),
}).passthrough();
export type ExecutionRunTurnStreamCancelRequest = z.infer<typeof ExecutionRunTurnStreamCancelRequestSchema>;

export const ExecutionRunTurnStreamCancelResponseSchema = z.object({
  ok: z.literal(true),
}).passthrough();
export type ExecutionRunTurnStreamCancelResponse = z.infer<typeof ExecutionRunTurnStreamCancelResponseSchema>;
