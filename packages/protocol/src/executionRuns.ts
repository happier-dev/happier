import { z } from 'zod';

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

export const ExecutionRunPublicStateSchema = z.object({
  runId: z.string().min(1),
  callId: z.string().min(1),
  sidechainId: z.string().min(1),
  intent: ExecutionRunIntentSchema,
  backendId: z.string().min(1),
  status: ExecutionRunStatusSchema,
  startedAtMs: z.number().int().nonnegative(),
  finishedAtMs: z.number().int().nonnegative().optional(),
  error: ExecutionRunErrorSchema.optional(),
}).passthrough();
export type ExecutionRunPublicState = z.infer<typeof ExecutionRunPublicStateSchema>;

export const ExecutionRunRetentionPolicySchema = z.enum(['ephemeral', 'resumable']);
export type ExecutionRunRetentionPolicy = z.infer<typeof ExecutionRunRetentionPolicySchema>;

export const ExecutionRunClassSchema = z.enum(['bounded', 'long_lived']);
export type ExecutionRunClass = z.infer<typeof ExecutionRunClassSchema>;

export const ExecutionRunIoModeSchema = z.enum(['request_response', 'streaming']);
export type ExecutionRunIoMode = z.infer<typeof ExecutionRunIoModeSchema>;

export const ExecutionRunStartRequestSchema = z.object({
  intent: ExecutionRunIntentSchema,
  backendId: z.string().min(1),
  instructions: z.string().optional(),
  permissionMode: z.string().min(1),
  retentionPolicy: ExecutionRunRetentionPolicySchema,
  runClass: ExecutionRunClassSchema,
  ioMode: ExecutionRunIoModeSchema,
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
