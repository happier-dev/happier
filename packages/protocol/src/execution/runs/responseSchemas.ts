import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';
import { ExecutionRunPreparedInstructionsForSchema } from './runPrimitives.js';
import { ExecutionRunPermissionRequestIdentitySchema } from './runPrimitives.js';
import { ExecutionRunTransportErrorCodeSchema } from './runPrimitives.js';
export { ExecutionRunTransportErrorCodeSchema, type ExecutionRunTransportErrorCode } from './runPrimitives.js';

import { BackendTargetRefSchema } from '../../backends/targets/backendTargetRef.js';
import {
  ExecutionRunClassSchema,
  ExecutionRunDisplaySchema,
  ExecutionRunIntentSchema,
  ExecutionRunIoModeSchema,
  ExecutionRunLaunchOriginSchema,
  ExecutionRunResumeHandleSchema,
  ExecutionRunRetentionPolicySchema,
  ExecutionRunVoiceAgentIntentInputV1Schema,
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
import { ExecutionRunRequestedConfigurationSchema, ExecutionRunResolvedSelectionSchema } from './requestedConfiguration.js';
import {
  ExecutionRunLifecycleV1Schema,
  type ExecutionRunLifecycleV1,
} from './executionRunLifecycleV1.js';
import { OperationUpdateRequiredV1Schema } from '../../compat/operationUpdateRequiredV1.js';
import { ExecutionRunOutputObservationSchema, ExecutionRunOutputRefV1Schema } from '../../reviews/reviewNarration.js';
import { ExecutionRunFollowOutputV1Schema } from '../../sessions/follow/sessionFollowInputV1.js';
import { ProviderAgentTargetKeySchema } from '../../providers/ids.js';
import { ProviderBoundModelRefSchema } from '../../providers/selection/v1.js';
import { ProviderErrorV1Schema } from '../../providers/errors.js';
import { ReviewFindingsV2Schema } from '../../messages/structured/reviewFindingsV2.js';
import { SessionRuntimeIssueV1Schema } from '../../sessions/control/runtimeIssueV1.js';
import { ActionInputIssueSchema } from '../../actions/executor/actionInputValidation.js';
import { ActionErrorClassV1Schema, type ActionErrorClassV1 } from '../../actions/actionErrorClassV1.js';
import { WorkflowTargetUnavailableReasonV1Schema } from '../../workflows/workflowTargetUnavailableReasonV1.js';

/** A refusal offers choices, never credential material or permission to use a route. */
export const ExecutionRunChildChoiceV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1), agentTargetKey: ProviderAgentTargetKeySchema,
  parentRouteCompatibility: z.enum(['incompatible', 'unverified']),
  parentModelSelection: z.nullable(ProviderBoundModelRefSchema),
  options: z.tuple([z.literal('agentDefault'), z.literal('explicitModel')]),
}));
export type ExecutionRunChildChoiceV1 = z.infer<typeof ExecutionRunChildChoiceV1Schema>;
export function projectExecutionRunChildChoiceV1(input: Readonly<{
  agentTargetKey: string; parentModelSelection?: z.infer<typeof ProviderBoundModelRefSchema> | null;
  parentRouteCompatibility?: 'incompatible' | 'unverified';
}>): ExecutionRunChildChoiceV1 {
  return ExecutionRunChildChoiceV1Schema.parse({ v: 1, agentTargetKey: input.agentTargetKey,
    parentModelSelection: input.parentModelSelection ?? null, parentRouteCompatibility: input.parentRouteCompatibility ?? 'incompatible',
    options: ['agentDefault', 'explicitModel'] });
}

export const ExecutionRunStartRunCreationSchema = lazyZodSchema(() => z.enum(['noRunCreated', 'outcomeUnknown']));
export type ExecutionRunStartRunCreation = z.infer<typeof ExecutionRunStartRunCreationSchema>;

const ExecutionRunStartRefusalV1Schema = lazyZodSchema(() => z.strictObject({
  code: WorkflowTargetUnavailableReasonV1Schema,
  phase: z.literal('agent_start_context'),
}));

const ExecutionRunStartFailureEvidenceV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  runCreation: ExecutionRunStartRunCreationSchema,
  errorClass: z.optional(ActionErrorClassV1Schema),
  refusal: z.optional(ExecutionRunStartRefusalV1Schema),
}));

/**
 * Strict, versioned evidence emitted by the execution-run start owner. A caller
 * may consider a fresh attempt only after `noRunCreated` and its own durable
 * policy authorizes one; absent, malformed, or contradictory evidence must be
 * treated as `outcomeUnknown`.
 */
export const ExecutionRunStartFailureDetailsV1Schema = lazyZodSchema(() => z.strictObject({
  executionRunStart: ExecutionRunStartFailureEvidenceV1Schema,
  updateRequired: z.optional(OperationUpdateRequiredV1Schema),
  childChoice: z.optional(ExecutionRunChildChoiceV1Schema),
  providerError: z.optional(ProviderErrorV1Schema),
  issues: z.optional(z.array(ActionInputIssueSchema)),
}));
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
  errorClass?: ActionErrorClassV1,
): ExecutionRunStartFailureDetailsV1 {
  const evidence = details && typeof details === 'object' && 'executionRunStart' in details
    ? details.executionRunStart : undefined;
  const parsedClass = ActionErrorClassV1Schema.safeParse(errorClass ?? (
    evidence && typeof evidence === 'object' && 'errorClass' in evidence ? evidence.errorClass : undefined));
  const refusal = ExecutionRunStartRefusalV1Schema.safeParse(evidence && typeof evidence === 'object'
    && 'refusal' in evidence ? evidence.refusal : undefined);
  const updateRequired = details && typeof details === 'object' && !Array.isArray(details)
    ? OperationUpdateRequiredV1Schema.safeParse(
        (details as Readonly<Record<string, unknown>>).updateRequired,
      )
    : null;
  const childChoice = ExecutionRunChildChoiceV1Schema.safeParse(details && typeof details === 'object'
    && 'childChoice' in details ? details.childChoice : undefined);
  const providerError = ProviderErrorV1Schema.safeParse(details && typeof details === 'object'
    && 'providerError' in details ? details.providerError : undefined);
  const issues = z.array(ActionInputIssueSchema).safeParse(details && typeof details === 'object'
    && 'issues' in details ? details.issues : undefined);
  return {
    executionRunStart: { v: 1, runCreation, ...(parsedClass.success ? { errorClass: parsedClass.data } : {}),
      ...(refusal.success ? { refusal: refusal.data } : {}) },
    ...(updateRequired?.success ? { updateRequired: updateRequired.data } : {}),
    ...(childChoice.success ? { childChoice: childChoice.data } : {}),
    ...(providerError.success ? { providerError: providerError.data } : {}),
    ...(issues.success ? { issues: issues.data } : {}),
  };
}

export const ExecutionRunStatusSchema = ExecutionRunStatusSchemaBase;
export type ExecutionRunStatus = ExecutionRunStatusBase;
export const ExecutionRunListRequestSchema = ExecutionRunListRequestSchemaBase;
export type ExecutionRunListRequest = ExecutionRunListRequestBase;

export const ExecutionRunErrorSchema = lazyZodSchema(() => z.looseObject({
  code: z.string().check(z.minLength(1)),
  message: z.optional(z.string()),
  runtimeIssueV1: z.optional(SessionRuntimeIssueV1Schema),
}));
export type ExecutionRunError = z.infer<typeof ExecutionRunErrorSchema>;

export const ExecutionRunTranscriptSchema = lazyZodSchema(() => z.looseObject({
  persistenceMode: z.enum(['ephemeral', 'persistent']),
  epoch: z.number().check(z.int(), z.minimum(0)),
}));
export type ExecutionRunTranscript = z.infer<typeof ExecutionRunTranscriptSchema>;

/** Native acceptance and terminal evidence for one retained runtime turn. */
export const ExecutionRunTurnResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('text'), value: z.string() }),
  z.strictObject({ kind: z.literal('json'), value: StrictJsonValueSchema }),
  z.strictObject({ kind: z.literal('decision'), value: z.string() }),
]));
export type ExecutionRunTurnResultV1 = z.infer<typeof ExecutionRunTurnResultV1Schema>;

export const ExecutionRunInputTurnV1Schema = lazyZodSchema(() => z.strictObject({
  turnId: z.string().check(z.minLength(1)),
  inputIds: z.array(z.string().check(z.minLength(1))).check(z.minLength(1)),
  state: z.enum(['active', 'completed', 'failed', 'cancelled']),
  result: z.optional(ExecutionRunTurnResultV1Schema),
}));
export type ExecutionRunInputTurnV1 = z.infer<typeof ExecutionRunInputTurnV1Schema>;

const ExecutionRunInputTurnsV1Schema = lazyZodSchema(() => z.strictObject({
  occurrenceId: z.string().check(z.minLength(1)),
  current: z.optional(ExecutionRunInputTurnV1Schema),
  last: z.optional(ExecutionRunInputTurnV1Schema),
}));

export const ExecutionRunPermissionAttentionSchema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('permission_required'),
  requestIds: z.array(z.string().check(z.minLength(1))).check(z.minLength(1)),
  requests: z.optional(z.array(ExecutionRunPermissionRequestIdentitySchema).check(z.minLength(1))),
}).check(z.refine(value => value.requests === undefined || value.requests.length === value.requestIds.length
  && new Set(value.requestIds).size === value.requestIds.length
  && new Set(value.requests.map(request => request.requestId)).size === value.requests.length
  && value.requests.every(request => value.requestIds.includes(request.requestId)), { message: 'Permission occurrence identities must match request ids' })));
export const ExecutionRunPublicStateSchema = lazyZodSchema(() => z.looseObject({
  runId: z.string().check(z.minLength(1)),
  /** Retained host launch provenance, never authored execution input. */
  originWorkflowRunId: z.optional(z.string().check(z.minLength(1))),
  callId: z.string().check(z.minLength(1)),
  sidechainId: z.string().check(z.minLength(1)),
  intent: ExecutionRunIntentSchema,
  backendTarget: BackendTargetRefSchema,
  display: z.optional(ExecutionRunDisplaySchema),
  launchOrigin: z.optional(ExecutionRunLaunchOriginSchema),
  requestedConfiguration: z.optional(ExecutionRunRequestedConfigurationSchema),
  resolvedSelection: z.optional(ExecutionRunResolvedSelectionSchema),
  // Policy/class fields are required for client surfaces (e.g. to decide if send/resume controls apply).
  permissionMode: z.string().check(z.minLength(1)),
  retentionPolicy: ExecutionRunRetentionPolicySchema,
  runClass: ExecutionRunClassSchema,
  ioMode: ExecutionRunIoModeSchema,
  status: ExecutionRunStatusSchema,
  turnInFlight: z.optional(z.boolean()),
  /** Current/last native turn only; reconstructed history never supplies this proof. */
  inputTurns: z.optional(ExecutionRunInputTurnsV1Schema),
  /**
   * Present only for a live run currently backed by the retained Agent Session
   * adapter. Its absence means read-only; clients must not infer interaction
   * from status, intent, run class, or Agent id.
   */
  interaction: z.optional(ExecutionRunInteractionV1Schema),
  /** Current permission-store evidence for this exact live Run occurrence. */
  attention: z.optional(ExecutionRunPermissionAttentionSchema),
  /** Canonical host lifecycle; clients must not infer recovery from status or resumeHandle. */
  lifecycle: z.optional(ExecutionRunLifecycleV1Schema),
  availableActionIds: z.optional(z.array(z.string().check(z.minLength(1)))),
  resumeHandle: z.optional(ExecutionRunResumeHandleSchema),
  transcript: z.optional(ExecutionRunTranscriptSchema),
  /** Retained admission policy; reconnecting clients must not replace it with current preferences. */
  voicePolicy: ExecutionRunVoiceAgentIntentInputV1Schema.shape.voicePolicy,
  startedAtMs: z.number().check(z.int(), z.nonnegative()),
  finishedAtMs: z.optional(z.number().check(z.int(), z.nonnegative())),
  error: z.optional(ExecutionRunErrorSchema),
}));
export type ExecutionRunPublicState = z.infer<typeof ExecutionRunPublicStateSchema>;

/** Retained lifetime and current work are separate: an idle interactive run remains sendable. */
export function isExecutionRunActive(run: Readonly<{
  status?: string | null;
  runClass?: string | null;
  turnInFlight?: boolean | null;
}>): boolean {
  // A bounded run still owns outcome processing after its provider turn settles. Older producers
  // and provisioning runs without a turn observation remain conservatively active.
  return run.status === 'running' && (run.runClass !== 'long_lived' || run.turnInFlight !== false);
}


export const ExecutionRunListResponseSchema = lazyZodSchema(() => z.looseObject({
  runs: z.array(ExecutionRunPublicStateSchema),
}));
export type ExecutionRunListResponse = z.infer<typeof ExecutionRunListResponseSchema>;

export const ExecutionRunGetRequestSchema = lazyZodSchema(() => z.looseObject({
  runId: z.string().check(z.minLength(1)),
  includeStructured: z.optional(z.boolean()),
  /** Content-free callers explicitly omit the result body; legacy reads retain it by default. */
  includeLatestToolResult: z.optional(z.boolean()),
  /** Await this exact current/last input turn before returning the Run snapshot. */
  waitForInputId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  waitForOutput: z.optional(ExecutionRunOutputObservationSchema),
}));
export type ExecutionRunGetRequest = z.infer<typeof ExecutionRunGetRequestSchema>;

export const ExecutionRunGetResponseSchema = lazyZodSchema(() => z.looseObject({
  run: ExecutionRunPublicStateSchema,
  latestToolResult: z.optional(z.unknown()),
  structuredMeta: z.optional(z.looseObject({ kind: z.string(), payload: z.unknown() })),
  reviewFindings: z.optional(ReviewFindingsV2Schema),
}));
export type ExecutionRunGetResponse = z.infer<typeof ExecutionRunGetResponseSchema>;

/** Retained source identity only; unlike get, this read never returns Run content. */
const executionRunFollowFrontierRequestFields = () => ({
  runId: z.string().check(z.minLength(1)), outputRefs: z.optional(z.array(ExecutionRunOutputRefV1Schema)),
});
export const ExecutionRunFollowFrontierRequestSchema = lazyZodSchema(() => z.union([
  z.strictObject({ ...executionRunFollowFrontierRequestFields(), sessionId: z.string().check(z.minLength(1)) }),
  z.strictObject({ ...executionRunFollowFrontierRequestFields(), machineId: z.string().check(z.minLength(1)) }),
]));
const executionRunFollowFrontierResponseFields = () => ({
  runId: z.string().check(z.minLength(1)),
  status: ExecutionRunStatusSchema,
  terminalEventId: z.nullable(z.string().check(z.minLength(1))),
  /** Existing sanitized recovery facts, never a Run result body or read grant. */
  runtimeIssueV1: z.optional(SessionRuntimeIssueV1Schema),
  attention: z.optional(ExecutionRunPermissionAttentionSchema),
  outputs: z.optional(z.array(ExecutionRunFollowOutputV1Schema)),
});
export const ExecutionRunFollowFrontierResponseSchema = lazyZodSchema(() => z.union([
  z.strictObject({ ...executionRunFollowFrontierResponseFields(), sessionId: z.string().check(z.minLength(1)) }),
  z.strictObject({ ...executionRunFollowFrontierResponseFields(), machineId: z.string().check(z.minLength(1)), sessionId: z.null() }),
]));
export type ExecutionRunFollowFrontierResponse = z.infer<typeof ExecutionRunFollowFrontierResponseSchema>;

/**
 * One public observation disposition for `execution.run.wait` and optional
 * `execution.run.start({ waitForCompletion: true })` composition. It says
 * nothing about starting, stopping, retrying, or re-targeting the run.
 */
const ExecutionRunWaitCompletedResultSchema = lazyZodSchema(() => z.strictObject({
  ok: z.literal(true),
  status: ExecutionRunTerminalStatusSchema,
  result: ExecutionRunGetResponseSchema,
}).check(z.superRefine((value, ctx) => {
  if (value.result.run.status !== value.status) {
    ctx.addIssue({
      code: "custom",
      path: ['result', 'run', 'status'],
      message: 'wait terminal status must match the observed run status',
    });
  }
})));

const ExecutionRunWaitObservationTimeoutSchema = lazyZodSchema(() => z.strictObject({
  ok: z.literal(true),
  status: z.literal('running'),
  disposition: z.literal('observation_timeout'),
  runId: z.string().check(z.minLength(1)),
  timeoutMs: z.number().check(z.positive()),
  observedAtMs: z.number(),
  deadlineAtMs: z.number(),
}));

export const ExecutionRunWaitResultSchema = lazyZodSchema(() => z.union([
  ExecutionRunWaitCompletedResultSchema,
  z.strictObject({ ok: z.literal(true), status: z.literal('running'), disposition: z.literal('needs_attention'),
    result: ExecutionRunGetResponseSchema }).check(z.superRefine((value, ctx) => {
      if (value.result.run.status !== 'running' || !value.result.run.attention) {
        ctx.addIssue({ code: "custom", path: ['result', 'run'], message: 'attention requires current permission facts' });
      }
    })),
  z.strictObject({ ok: z.literal(true), status: ExecutionRunStatusSchema, disposition: z.literal('snapshot'),
    result: ExecutionRunGetResponseSchema }).check(z.superRefine((value, ctx) => {
      if (value.result.run.status !== value.status) ctx.addIssue({ code: "custom",
        path: ['result', 'run', 'status'], message: 'snapshot status must match the observed run status' });
    })),
  ExecutionRunWaitObservationTimeoutSchema,
  z.extend(ExecutionRunWaitObservationTimeoutSchema, {
    status: ExecutionRunTerminalStatusSchema,
    result: ExecutionRunGetResponseSchema,
  }).check(z.superRefine((value, ctx) => {
    if (value.result.run.status !== value.status) ctx.addIssue({ code: "custom",
      path: ['result', 'run', 'status'], message: 'timeout status must match the observed run status' });
  })),
  z.strictObject({ ok: z.literal(false), code: z.literal('cancelled') }),
  z.strictObject({ ok: z.literal(false), code: ExecutionRunTransportErrorCodeSchema }),
]));
export type ExecutionRunWaitResult = z.infer<typeof ExecutionRunWaitResultSchema>;

export const ExecutionRunStartResponseSchema = lazyZodSchema(() => z.looseObject({
  runId: z.string().check(z.minLength(1)),
  callId: z.string().check(z.minLength(1)),
  sidechainId: z.string().check(z.minLength(1)),
  requestedConfiguration: z.optional(ExecutionRunRequestedConfigurationSchema),
  resolvedSelection: z.optional(ExecutionRunResolvedSelectionSchema),
  wait: z.optional(ExecutionRunWaitResultSchema),
  preparedInstructionsFor: z.optional(ExecutionRunPreparedInstructionsForSchema),
}));
export type ExecutionRunStartResponse = z.infer<typeof ExecutionRunStartResponseSchema>;

export const ExecutionRunSendResponseSchema = lazyZodSchema(() => z.looseObject({ ok: z.literal(true) }));
export type ExecutionRunSendResponse = z.infer<typeof ExecutionRunSendResponseSchema>;

export const ExecutionRunStopResponseSchema = lazyZodSchema(() => z.looseObject({ ok: z.literal(true) }));
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
