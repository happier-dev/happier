import { maxCodeUnits } from '../strings/maxCodeUnits.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { ApprovalRequestV2StatusSchema } from './approvalRequestStatus.js';
import { z } from 'zod/mini';
import { createStoredReadSchema } from '../json/storedReadSchema.js';
import {
  ApprovalExecutionOriginV1Schema,
  ApprovalExecutionV2Schema,
  ApprovalRequestCreatedBySchema,
  ApprovalRequesterConfirmationV1Schema,
  ApprovalDecisionV2Schema,
  isApprovalRequesterConfirmationBoundToOriginV1,
} from './approvalRequestV1.js';
import { parseQualifiedPluginActionId } from '../plugins/actions/qualifiedActionId.js';
import { computeActionInputApprovalDigestV1 } from '../actions/decisionAuthority.js';
import { AgentRuntimeJsonValueV1Schema } from '../runtime/agentSessionV1.js';
import { PluginSourceCustodyV1Schema } from '../plugins/runtime/sourceCustody.js';
import { InputPathSchema } from '../inputs/inputPredicates.js';

export const TARGET_ACTION_APPROVAL_LIMITS_V1 = Object.freeze({
  artifactJsonBytes: 64 * 1024,
  idUtf16Units: 512,
  surfaceUtf16Units: 64,
  summaryUtf16Units: 1_024,
  detailUtf16Units: 4_096,
});

const boundedId = z.string().check(z.minLength(1), maxCodeUnits(TARGET_ACTION_APPROVAL_LIMITS_V1.idUtf16Units));

/**
 * Host-stamped routing evidence for an automated or live-only-input Action approval. It is
 * durable approval subject data, never caller-supplied Action input.
 */
export const TargetActionApprovalReplayPlacementV1Schema = lazyZodSchema(() => z.strictObject({
  serverId: boundedId,
  machineId: boundedId,
  defaultSessionId: z.optional(boundedId),
}));
export type TargetActionApprovalReplayPlacementV1 = z.infer<
  typeof TargetActionApprovalReplayPlacementV1Schema
>;

export const TargetActionApprovalRequestV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1), kind: z.literal('plugin_target_action'), status: ApprovalRequestV2StatusSchema,
  createdAtMs: z.number().check(z.int(), z.minimum(0)), updatedAtMs: z.number().check(z.int(), z.minimum(0)),
  createdBy: ApprovalRequestCreatedBySchema,
  requestedSurface: z.string().check(z.minLength(1), maxCodeUnits(TARGET_ACTION_APPROVAL_LIMITS_V1.surfaceUtf16Units)),
  qualifiedActionId: z.string().check(maxCodeUnits(TARGET_ACTION_APPROVAL_LIMITS_V1.idUtf16Units), z.regex(/^[a-z0-9][a-z0-9._-]*\/actions\/[a-z0-9][a-z0-9/-]*$/)),
  input: AgentRuntimeJsonValueV1Schema, accountId: z.optional(boundedId), resourceId: z.optional(boundedId),
  /** Absent on older development requests, which remain readable but cannot disclose their input safely. */
  secretInputPaths: z.optional(z.array(InputPathSchema)),
  secretInputLabels: z.optional(z.record(InputPathSchema, z.string())),
  /** Replay requires the original live invocation, including any confidential raw operands. */
  approvalInputCustody: z.optional(z.literal('live_only')),
  sourceCustody: PluginSourceCustodyV1Schema,
  policyFingerprint: z.string().check(z.regex(/^[a-f0-9]{64}$/)),
  subjectFingerprint: z.string().check(z.regex(/^[a-f0-9]{64}$/)),
  replayPlacement: z.optional(TargetActionApprovalReplayPlacementV1Schema),
  executionOriginV1: z.optional(ApprovalExecutionOriginV1Schema),
  requesterConfirmation: z.optional(ApprovalRequesterConfirmationV1Schema),
  summary: z.string().check(z.minLength(1), maxCodeUnits(TARGET_ACTION_APPROVAL_LIMITS_V1.summaryUtf16Units)),
  detail: z.optional(z.string().check(z.minLength(1), maxCodeUnits(TARGET_ACTION_APPROVAL_LIMITS_V1.detailUtf16Units))),
  decision: z.optional(ApprovalDecisionV2Schema), execution: z.optional(ApprovalExecutionV2Schema),
}).check(z.superRefine((value, ctx) => {
  if (value.requesterConfirmation) {
    const invocation = projectTargetActionApprovalInvocationV1(value);
    if (!value.executionOriginV1 || !isApprovalRequesterConfirmationBoundToOriginV1(value.requesterConfirmation, value.executionOriginV1)
      || !invocation || value.requesterConfirmation.inputDigest !== computeActionInputApprovalDigestV1(invocation.actionId, invocation.actionArgs)) {
      ctx.addIssue({ code: 'custom', path: ['requesterConfirmation'], message: 'Requester confirmation must bind the original target Action and execution origin' });
    }
    if (value.decision && (!ApprovalDecisionV2Schema.safeParse(value.decision).success
      || value.decision.authority !== 'present_user'
      || value.decision.decidingAccountId !== value.requesterConfirmation.requesterAccountId
      || value.decision.narrowedInput !== undefined)) {
      ctx.addIssue({ code: 'custom', path: ['decision'], message: 'Requester confirmation requires the exact deciding person' });
    }
  }
  if (value.status === 'open' && (value.decision || value.execution)) ctx.addIssue({ code: 'custom', message: 'open target-action approval cannot contain a decision or execution' });
  if ((value.status === 'approved' || value.status === 'executing' || value.status === 'executed' || value.status === 'failed' || value.status === 'outcome_unknown') && value.decision?.kind !== 'approve') ctx.addIssue({ code: 'custom', message: `${value.status} target-action approval requires approve` });
  if (value.status === 'rejected' && value.decision?.kind !== 'reject') ctx.addIssue({ code: 'custom', message: 'rejected target-action approval requires reject' });
  if (value.status === 'canceled' && value.decision) ctx.addIssue({ code: 'custom', message: 'canceled target-action approval cannot contain a decision' });
  if ((value.status === 'executed' || value.status === 'failed' || value.status === 'outcome_unknown') !== Boolean(value.execution)) ctx.addIssue({ code: 'custom', message: 'target-action approval execution/status mismatch' });
  if (value.status === 'outcome_unknown' && (value.execution?.ok !== false || value.execution.effectAttempted !== true)) {
    ctx.addIssue({ code: 'custom', message: 'Unknown target-action approval outcomes require a possibly attempted execution' });
  }
  if (value.requestedSurface === 'api' && value.replayPlacement === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['replayPlacement'],
      message: 'API target-action approval requires an exact daemon replay placement',
    });
  }
  if (value.requestedSurface === 'api' && value.executionOriginV1 === undefined) {
    ctx.addIssue({ code: 'custom', path: ['executionOriginV1'], message: 'API target-action approval requires its immutable execution origin' });
  }
  if (value.executionOriginV1 !== undefined && value.executionOriginV1.actionId !== 'action.invoke') {
    ctx.addIssue({ code: 'custom', path: ['executionOriginV1', 'actionId'], message: 'Target-action approval origin must bind action.invoke' });
  }
  if (value.replayPlacement && value.executionOriginV1 && (
    value.executionOriginV1.serverId !== value.replayPlacement.serverId
    || value.executionOriginV1.machineId !== value.replayPlacement.machineId
    || (value.replayPlacement.defaultSessionId !== undefined
      && value.executionOriginV1.sessionId !== value.replayPlacement.defaultSessionId)
  )) {
    ctx.addIssue({ code: 'custom', path: ['executionOriginV1'], message: 'Target-action approval origin must match its exact replay placement' });
  }
  const strictJson = AgentRuntimeJsonValueV1Schema.safeParse(value);
  if (!strictJson.success) {
    ctx.addIssue({ code: 'custom', message: 'target-action approval artifact must be strict JSON' });
  } else if (new TextEncoder().encode(JSON.stringify(strictJson.data)).byteLength > TARGET_ACTION_APPROVAL_LIMITS_V1.artifactJsonBytes) {
    ctx.addIssue({ code: 'custom', message: 'target-action approval artifact byte limit exceeded' });
  }
})));
export type TargetActionApprovalRequestV1 = z.infer<typeof TargetActionApprovalRequestV1Schema>;
export const StoredTargetActionApprovalRequestV1Schema = createStoredReadSchema(TargetActionApprovalRequestV1Schema);

/** One canonical public invocation retained by the target approval subject. */
export function projectTargetActionApprovalInvocationV1(
  request: Pick<TargetActionApprovalRequestV1, 'qualifiedActionId' | 'input'>,
): { actionId: 'action.invoke'; actionArgs: {
  action: { pluginId: string; localId: string }; input: TargetActionApprovalRequestV1['input'];
} } | null {
  const action = parseQualifiedPluginActionId(request.qualifiedActionId);
  return action ? { actionId: 'action.invoke' as const, actionArgs: {
    action: { pluginId: action.pluginId, localId: action.localId }, input: request.input,
  } } : null;
}
