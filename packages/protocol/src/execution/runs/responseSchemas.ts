import { z } from 'zod';

import { BackendTargetRefSchema } from '../../backends/targets/backendTargetRef.js';
import {
  ExecutionRunClassSchema,
  ExecutionRunDisplaySchema,
  ExecutionRunIntentSchema,
  ExecutionRunIoModeSchema,
  ExecutionRunResumeHandleSchema,
  ExecutionRunRetentionPolicySchema,
  type ExecutionRunClass,
  type ExecutionRunDisplay,
  type ExecutionRunIntent,
  type ExecutionRunIoMode,
  type ExecutionRunResumeHandle,
  type ExecutionRunRetentionPolicy,
} from './startRequest.js';
import {
  ExecutionRunListRequestSchema as ExecutionRunListRequestSchemaBase,
  ExecutionRunStatusSchema as ExecutionRunStatusSchemaBase,
  type ExecutionRunListRequest as ExecutionRunListRequestBase,
  type ExecutionRunStatus as ExecutionRunStatusBase,
} from './listRequest.js';
import { ExecutionRunTerminalStatusSchema } from './waitForTerminal.js';

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
  'execution_run_output_limit_exceeded',
  'execution_run_protocol_unsupported',
  'execution_run_target_not_selected',
  'execution_run_target_unavailable',
  'execution_run_scope_mismatch',
  'execution_run_connected_service_generation_refresh_required',
  'run_depth_exceeded',
  'permission_denied',
]);
export type ExecutionRunTransportErrorCode = z.infer<typeof ExecutionRunTransportErrorCodeSchema>;

export const ExecutionRunStartRunCreationSchema = z.enum(['noRunCreated', 'outcomeUnknown']);
export type ExecutionRunStartRunCreation = z.infer<typeof ExecutionRunStartRunCreationSchema>;

const ExecutionRunStartFailureEvidenceV1Schema = z.object({
  v: z.literal(1),
  runCreation: ExecutionRunStartRunCreationSchema,
}).strict();

/**
 * Strict, versioned evidence emitted by the execution-run start owner. A caller
 * may consider a fresh attempt only after `noRunCreated` and its own durable
 * policy authorizes one; absent, malformed, or contradictory evidence must be
 * treated as `outcomeUnknown`.
 */
export const ExecutionRunStartFailureDetailsV1Schema = z.object({
  executionRunStart: ExecutionRunStartFailureEvidenceV1Schema,
}).strict();
export type ExecutionRunStartFailureDetailsV1 = z.infer<typeof ExecutionRunStartFailureDetailsV1Schema>;

export function readExecutionRunStartRunCreation(details: unknown): ExecutionRunStartRunCreation {
  const evidence = details && typeof details === 'object' && !Array.isArray(details)
    ? (details as Record<string, unknown>).executionRunStart
    : undefined;
  const parsed = ExecutionRunStartFailureEvidenceV1Schema.safeParse(evidence);
  return parsed.success ? parsed.data.runCreation : 'outcomeUnknown';
}

export function withExecutionRunStartFailureDetails(
  _details: unknown,
  runCreation: ExecutionRunStartRunCreation,
): ExecutionRunStartFailureDetailsV1 {
  return {
    executionRunStart: { v: 1, runCreation },
  };
}

export const ExecutionRunStatusSchema = ExecutionRunStatusSchemaBase;
export type ExecutionRunStatus = ExecutionRunStatusBase;
export const ExecutionRunListRequestSchema = ExecutionRunListRequestSchemaBase;
export type ExecutionRunListRequest = ExecutionRunListRequestBase;

export const ExecutionRunErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string().optional(),
}).passthrough();
export type ExecutionRunError = z.infer<typeof ExecutionRunErrorSchema>;

export const ExecutionRunTranscriptSchema = z.object({
  persistenceMode: z.enum(['ephemeral', 'persistent']),
  epoch: z.number().int().min(0),
}).passthrough();
export type ExecutionRunTranscript = z.infer<typeof ExecutionRunTranscriptSchema>;

export const ExecutionRunPublicStateSchema = z.object({
  runId: z.string().min(1),
  callId: z.string().min(1),
  sidechainId: z.string().min(1),
  intent: ExecutionRunIntentSchema,
  backendTarget: BackendTargetRefSchema,
  display: ExecutionRunDisplaySchema.optional(),
  // Policy/class fields are required for client surfaces (e.g. to decide if send/resume controls apply).
  permissionMode: z.string().min(1),
  retentionPolicy: ExecutionRunRetentionPolicySchema,
  runClass: ExecutionRunClassSchema,
  ioMode: ExecutionRunIoModeSchema,
  status: ExecutionRunStatusSchema,
  turnInFlight: z.boolean().optional(),
  availableActionIds: z.array(z.string().min(1)).optional(),
  resumeHandle: ExecutionRunResumeHandleSchema.optional(),
  transcript: ExecutionRunTranscriptSchema.optional(),
  startedAtMs: z.number().int().nonnegative(),
  finishedAtMs: z.number().int().nonnegative().optional(),
  error: ExecutionRunErrorSchema.optional(),
}).passthrough();
export type ExecutionRunPublicState = z.infer<typeof ExecutionRunPublicStateSchema>;

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

const ExecutionRunWaitTerminalRunSchema = z.object({
  runId: z.string().min(1),
  status: ExecutionRunTerminalStatusSchema,
}).strict();

/**
 * One public observation disposition for `execution.run.wait` and optional
 * `execution.run.start({ waitForCompletion: true })` composition. It says
 * nothing about starting, stopping, retrying, or re-targeting the run.
 */
const ExecutionRunWaitCompletedResultSchema = z.object({
  ok: z.literal(true),
  status: ExecutionRunTerminalStatusSchema,
  result: z.object({ run: ExecutionRunWaitTerminalRunSchema }).strict(),
}).strict().superRefine((value, ctx) => {
  if (value.result.run.status !== value.status) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['result', 'run', 'status'],
      message: 'wait terminal status must match the observed run status',
    });
  }
});

export const ExecutionRunWaitResultSchema = z.union([
  ExecutionRunWaitCompletedResultSchema,
  z.object({ ok: z.literal(false), code: z.literal('timeout') }).strict(),
  z.object({ ok: z.literal(false), code: z.literal('cancelled') }).strict(),
  z.object({ ok: z.literal(false), code: ExecutionRunTransportErrorCodeSchema }).strict(),
]);
export type ExecutionRunWaitResult = z.infer<typeof ExecutionRunWaitResultSchema>;

export const ExecutionRunStartResponseSchema = z.object({
  runId: z.string().min(1),
  callId: z.string().min(1),
  sidechainId: z.string().min(1),
  wait: ExecutionRunWaitResultSchema.optional(),
}).passthrough();
export type ExecutionRunStartResponse = z.infer<typeof ExecutionRunStartResponseSchema>;

export const ExecutionRunSendResponseSchema = z.object({ ok: z.literal(true) }).passthrough();
export type ExecutionRunSendResponse = z.infer<typeof ExecutionRunSendResponseSchema>;

export const ExecutionRunStopResponseSchema = z.object({ ok: z.literal(true) }).passthrough();
export type ExecutionRunStopResponse = z.infer<typeof ExecutionRunStopResponseSchema>;

// Keep the schema-owner imports explicit: these aliases are the public contract types
// consumed by Action Specs and the execution-run package barrel.
export type {
  ExecutionRunClass,
  ExecutionRunDisplay,
  ExecutionRunIntent,
  ExecutionRunIoMode,
  ExecutionRunResumeHandle,
  ExecutionRunRetentionPolicy,
};
