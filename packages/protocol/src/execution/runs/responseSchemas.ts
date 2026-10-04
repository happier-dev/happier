import { z } from 'zod';

import { BackendTargetRefSchema } from '../../backends/targets/backendTargetRef.js';
import {
  ExecutionRunClassSchema,
  ExecutionRunDisplaySchema,
  ExecutionRunIntentSchema,
  ExecutionRunIoModeSchema,
  ExecutionRunLaunchOriginSchema,
  ExecutionRunResumeHandleSchema,
  ExecutionRunRetentionPolicySchema,
  type ExecutionRunClass,
  type ExecutionRunDisplay,
  type ExecutionRunIntent,
  type ExecutionRunIoMode,
  type ExecutionRunLaunchOrigin,
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
import {
  ExecutionRunInteractionV1Schema,
  type ExecutionRunInteractionV1,
} from './executionRunInteractionV1.js';
import { StrictJsonValueSchema } from '../../json/strictJsonValue.js';
import { ExecutionRunRequestedConfigurationSchema } from './requestedConfiguration.js';
import {
  ExecutionRunLifecycleV1Schema,
  type ExecutionRunLifecycleV1,
} from './executionRunLifecycleV1.js';
import { OperationUpdateRequiredV1Schema } from '../../compat/operationUpdateRequiredV1.js';
import { ReviewWalkthroughObservationSchema } from '../../reviews/reviewNarration.js';

// Canonical, stable error code vocabulary for RPC `errorCode` and MCP `error.code`.
// Keep this pinned and deterministic; clients should branch on these strings.
export const ExecutionRunTransportErrorCodeSchema = z.enum([
  'execution_run_not_allowed',
  'execution_run_not_found',
  'execution_run_action_not_supported',
  'execution_run_invalid_action_input',
  'execution_run_stream_not_found',
  'execution_run_busy',
  'execution_run_send_outcome_unknown',
  'execution_run_failed',
  'execution_run_budget_exceeded',
  'execution_run_output_limit_exceeded',
  'execution_run_protocol_unsupported',
  'execution_run_target_not_selected',
  'execution_run_target_unavailable',
  'execution_run_start_ambiguous',
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
  updateRequired: OperationUpdateRequiredV1Schema.optional(),
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
  details: unknown,
  runCreation: ExecutionRunStartRunCreation,
): ExecutionRunStartFailureDetailsV1 {
  const updateRequired = details && typeof details === 'object' && !Array.isArray(details)
    ? OperationUpdateRequiredV1Schema.safeParse(
        (details as Readonly<Record<string, unknown>>).updateRequired,
      )
    : null;
  return {
    executionRunStart: { v: 1, runCreation },
    ...(updateRequired?.success ? { updateRequired: updateRequired.data } : {}),
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

/** Native acceptance and terminal evidence for one retained runtime turn. */
export const ExecutionRunTurnResultV1Schema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), value: z.string() }).strict(),
  z.object({ kind: z.literal('json'), value: StrictJsonValueSchema }).strict(),
  z.object({ kind: z.literal('decision'), value: z.string() }).strict(),
]);
export type ExecutionRunTurnResultV1 = z.infer<typeof ExecutionRunTurnResultV1Schema>;

export const ExecutionRunInputTurnV1Schema = z.object({
  turnId: z.string().min(1),
  inputIds: z.array(z.string().min(1)).nonempty(),
  state: z.enum(['active', 'completed', 'failed', 'cancelled']),
  result: ExecutionRunTurnResultV1Schema.optional(),
}).strict();
export type ExecutionRunInputTurnV1 = z.infer<typeof ExecutionRunInputTurnV1Schema>;

const ExecutionRunInputTurnsV1Schema = z.object({
  occurrenceId: z.string().min(1),
  current: ExecutionRunInputTurnV1Schema.optional(),
  last: ExecutionRunInputTurnV1Schema.optional(),
}).strict();

export const ExecutionRunPublicStateSchema = z.object({
  runId: z.string().min(1),
  callId: z.string().min(1),
  sidechainId: z.string().min(1),
  intent: ExecutionRunIntentSchema,
  backendTarget: BackendTargetRefSchema,
  display: ExecutionRunDisplaySchema.optional(),
  launchOrigin: ExecutionRunLaunchOriginSchema.optional(),
  requestedConfiguration: ExecutionRunRequestedConfigurationSchema.optional(),
  // Policy/class fields are required for client surfaces (e.g. to decide if send/resume controls apply).
  permissionMode: z.string().min(1),
  retentionPolicy: ExecutionRunRetentionPolicySchema,
  runClass: ExecutionRunClassSchema,
  ioMode: ExecutionRunIoModeSchema,
  status: ExecutionRunStatusSchema,
  turnInFlight: z.boolean().optional(),
  /** Current/last native turn only; reconstructed history never supplies this proof. */
  inputTurns: ExecutionRunInputTurnsV1Schema.optional(),
  /**
   * Present only for a live run currently backed by the retained Agent Session
   * adapter. Its absence means read-only; clients must not infer interaction
   * from status, intent, run class, or Agent id.
   */
  interaction: ExecutionRunInteractionV1Schema.optional(),
  /** Current permission-store evidence for this exact live Run occurrence. */
  attention: z.object({
    kind: z.literal('permission_required'),
    requestIds: z.array(z.string().min(1)).min(1),
  }).strict().optional(),
  /** Canonical host lifecycle; clients must not infer recovery from status or resumeHandle. */
  lifecycle: ExecutionRunLifecycleV1Schema.optional(),
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
  /** Await this exact current/last input turn before returning the Run snapshot. */
  waitForInputId: z.string().trim().min(1).optional(),
  waitForOutput: ReviewWalkthroughObservationSchema.optional(),
}).passthrough();
export type ExecutionRunGetRequest = z.infer<typeof ExecutionRunGetRequestSchema>;

export const ExecutionRunGetResponseSchema = z.object({
  run: ExecutionRunPublicStateSchema,
  latestToolResult: z.unknown().optional(),
  structuredMeta: z.object({ kind: z.string(), payload: z.unknown() }).passthrough().optional(),
}).passthrough();
export type ExecutionRunGetResponse = z.infer<typeof ExecutionRunGetResponseSchema>;

/**
 * One public observation disposition for `execution.run.wait` and optional
 * `execution.run.start({ waitForCompletion: true })` composition. It says
 * nothing about starting, stopping, retrying, or re-targeting the run.
 */
const ExecutionRunWaitCompletedResultSchema = z.object({
  ok: z.literal(true),
  status: ExecutionRunTerminalStatusSchema,
  result: ExecutionRunGetResponseSchema,
}).strict().superRefine((value, ctx) => {
  if (value.result.run.status !== value.status) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['result', 'run', 'status'],
      message: 'wait terminal status must match the observed run status',
    });
  }
});

const ExecutionRunWaitObservationTimeoutSchema = z.object({
  ok: z.literal(true),
  status: z.literal('running'),
  disposition: z.literal('observation_timeout'),
  runId: z.string().min(1),
  timeoutMs: z.number().finite().positive(),
  observedAtMs: z.number().finite(),
  deadlineAtMs: z.number().finite(),
}).strict();

export const ExecutionRunWaitResultSchema = z.union([
  ExecutionRunWaitCompletedResultSchema,
  z.object({ ok: z.literal(true), status: z.literal('running'), disposition: z.literal('needs_attention'),
    result: ExecutionRunGetResponseSchema }).strict().superRefine((value, ctx) => {
      if (value.result.run.status !== 'running' || !value.result.run.attention) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['result', 'run'], message: 'attention requires current permission facts' });
      }
    }),
  z.object({ ok: z.literal(true), status: ExecutionRunStatusSchema, disposition: z.literal('snapshot'),
    result: ExecutionRunGetResponseSchema }).strict().superRefine((value, ctx) => {
      if (value.result.run.status !== value.status) ctx.addIssue({ code: z.ZodIssueCode.custom,
        path: ['result', 'run', 'status'], message: 'snapshot status must match the observed run status' });
    }),
  ExecutionRunWaitObservationTimeoutSchema,
  ExecutionRunWaitObservationTimeoutSchema.extend({
    status: ExecutionRunTerminalStatusSchema,
    result: ExecutionRunGetResponseSchema,
  }).superRefine((value, ctx) => {
    if (value.result.run.status !== value.status) ctx.addIssue({ code: z.ZodIssueCode.custom,
      path: ['result', 'run', 'status'], message: 'timeout status must match the observed run status' });
  }),
  z.object({ ok: z.literal(false), code: z.literal('cancelled') }).strict(),
  z.object({ ok: z.literal(false), code: ExecutionRunTransportErrorCodeSchema }).strict(),
]);
export type ExecutionRunWaitResult = z.infer<typeof ExecutionRunWaitResultSchema>;

export const ExecutionRunStartResponseSchema = z.object({
  runId: z.string().min(1),
  callId: z.string().min(1),
  sidechainId: z.string().min(1),
  requestedConfiguration: ExecutionRunRequestedConfigurationSchema.optional(),
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
  ExecutionRunLaunchOrigin,
  ExecutionRunResumeHandle,
  ExecutionRunRetentionPolicy,
  ExecutionRunLifecycleV1,
};
