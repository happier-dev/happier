import { isWorkspaceSyncRelationshipWriteActionId } from '../actions/actionIds.js';
import * as zMini from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { resolveApprovalExecutor } from './resolveApprovalExecutor.js';
import { ApprovalRequestStatusSchema, ApprovalRequestV2StatusSchema } from './approvalRequestStatus.js';
export { ApprovalRequestStatusSchema, ApprovalRequestV2StatusSchema, isApprovalRequestV2InFlightStatus, isApprovalRequestV2TerminalStatus, type ApprovalRequestStatus } from './approvalRequestStatus.js';
import { z } from '../zodRuntimePolicy.js';
import { createStoredReadSchema } from '../json/storedReadSchema.js';
import { asProtocolZod } from "../plugins/actions/internalProtocolZodAdapter.js";

import { ActionApprovalSchema, resolveActionApprovalFlow } from '../actions/actionApprovalMetadata.js';
import { ActionIdSchema, WORKFLOW_RUN_START_ACTION_ID_V1 } from '../actions/actionIds.js';
import { ApprovalProfileIdV1Schema } from '../actions/approvalProfiles.js';
import { ActionResolvedSessionTargetsV1Schema, normalizeSessionTargetV1 } from '../actions/sessionTargetV1.js';
import { InputPathSchema } from '../inputs/inputPredicates.js';
import { bindActionSessionTargetOperands, readActionSessionTargetOperands } from '../actions/executor/sessionTargets.js';
import { PluginContributionLocalIdSchema } from '../plugins/contributionIdentity.js';
import { PluginIdSchema } from '../plugins/pluginId.js';
import {
  SessionCreationDirectoryApprovalV1Schema,
} from '../sessions/creation/sessionCreationTargetPreparationV1.js';
import { HandoffTargetReplacementApprovalV1Schema } from '../sessions/control/handoff/handoffTargetReplacementApprovalV1.js';
import { ActionRequiredAuthoritySchema, ActionSurfaceSchema } from '../actions/metadata.js';
import { computeActionInputApprovalDigestV1 } from '../actions/decisionAuthority.js';
import type { ActionId } from '../actions/actionIds.js';
import type { ActionExecutorContext } from '../actions/executor/types.js';
import { ActionCallerSurfaceV1Schema } from '../actions/actionSettings.js';
import { ActionRequestAttributionV1Schema, isSharedRequesterActionV1 } from '../actions/actionRequestAttributionV1.js';
import { ActionFailureCauseV1Schema, ActionOperationCredentialUseV1Schema } from '../actions/actionExecutionResult.js';
import { SessionMessageRefV1Schema } from '../sessions/messages/sessionMessageRefV1.js';
import { DiscussionReplyReturnV1Schema } from '../workflows/workflowDiscussionPublicationV1.js';
import { DiscussionIdSchema } from '../discussions/references.js';
import { SessionMessageAccountActorV1Schema } from '../sessions/messages/sessionMessageAccountActorV1.js';
import { getActionSpec, resolveActionExecutionPlacementForInput } from '../actions/actionSpecs.js';
import {
  ExternalActionTargetV1Schema,
  ExternalActionExecutionAuthorizationV1Schema,
  ExternalActionRequestEnvelopeSchema,
  isExternalActionResolvedTargetAllowedV1,
  isExternalActionMachineWorkflowActionIdV1,
} from '../actions/externalActionApi.js';
import { isExternalActionAuthorizationBoundToEnvelope } from '../actions/externalActionExecutionAuthorization.js';
export { resolveApprovalExecutor, type ApprovalExecutor } from './resolveApprovalExecutor.js';
export { liveCliApprovalOriginScope, readLiveCliApprovalOriginScope, LIVE_CLI_APPROVAL_DECIDE_METHOD, isLiveCliApprovalOriginMethod } from './liveCliOrigin.js';
import { AutomationRunCauseSchema } from '../automations/automationRunCause.js';
import { AgentPermissionIntentV1Schema } from '../runtime/permissionIntentV1.js';
import { SessionAgentSpawnPolicyV1StrictSchema } from '../account/settings/sessionAgentSpawnPolicyV1.js';
import { SessionWorkDepthV1Schema } from '../sessions/creation/sessionCreateOriginV1.js';
import {
  SessionInputCausalPermissionAuthorityV1Schema,
  SessionInputSourceSessionV1Schema,
} from '../sessions/messages/sessionInputAdmission.js';
import { PluginSourceCustodyV1Schema } from '../plugins/runtime/sourceCustody.js';
import { WorkflowAcceptedAuthorizationV1Schema, WorkflowAcceptedOriginV1Schema, WorkflowRunStartedByV1Schema } from '../workflows/workflowDefinitionV1.js';
import { AgentStartSessionCallerV1Schema } from '../account/settings/admitAgentStartV1.js';
import { sameStrictJsonValue, StrictJsonValueSchema } from '../json/strictJsonValue.js';
import { validateConfidentialApprovalRequest } from './confidential.js';
import { MachineStorageTrashMoveInputV1Schema, PileApplyResultStoredV1Schema, PileApplyResultV1Schema } from '../storage/storageV1.js';
import { prepareDocDiscussionMutationV1 } from '../artifacts/artifactCollaborationActionsV1.js';
import { RETIRED_DEPLOYMENT_PUBLISH_ACTION_ID_V1 } from '../deployments/deploymentActionIdsV1.js';
export { ApprovalStaleReasonSchema, ApprovalStaleFailureDetailsSchema, type ApprovalStaleReason } from './approvalStaleReason.js';

const ApprovalRequestedSurfaceSchema = lazyZodSchema(() => z.string().check(z.minLength(1)));

/**
 * Released ApprovalRequestV1 artifacts may name this retired interactive
 * picker. It remains history-only: current Action catalog and V2 replay use
 * ActionIdSchema directly.
 */
const ApprovalRequestV1HistoricalActionIdSchema = lazyZodSchema(() => z.union([
  ActionIdSchema,
  z.literal('session.spawn_picker'),
  z.literal(RETIRED_DEPLOYMENT_PUBLISH_ACTION_ID_V1),
]));

export const ApprovalRequestOriginV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('transcript_tool_call'),
  sessionId: z.string().check(z.minLength(1)),
  messageId: z.optional(z.string().check(z.minLength(1))),
  parentMessageId: z.optional(z.string().check(z.minLength(1))),
  toolCallId: z.optional(z.string().check(z.minLength(1))),
  mcpRequestId: z.optional(z.string().check(z.minLength(1))),
  toolName: z.optional(z.string().check(z.minLength(1))),
  toolInput: z.optional(z.unknown()),
}).check(z.superRefine((value, ctx) => {
  if (value.messageId || value.parentMessageId || value.toolCallId || value.toolName) {
    return;
  }
  ctx.addIssue({
    code: "custom",
    path: ['origin'],
    message: 'transcript tool-call approval origins require a messageId, parentMessageId, toolCallId, or toolName',
  });
})));
export type ApprovalRequestOriginV1 = z.infer<typeof ApprovalRequestOriginV1Schema>;

export const ApprovalRequestCreatedBySchema = lazyZodSchema(() => z.strictObject({
  surface: z.enum(['voice', 'agent', 'session_agent', 'mcp', 'cli', 'system']),
  agentId: z.optional(z.string().check(z.minLength(1))),
  pluginId: zMini.optional(asProtocolZod(PluginIdSchema)),
  contributionLocalId: zMini.optional(asProtocolZod(PluginContributionLocalIdSchema)),
  sessionId: z.optional(z.string().check(z.minLength(1))),
}));
export type ApprovalRequestCreatedBy = z.infer<typeof ApprovalRequestCreatedBySchema>;

export const ApprovalDecisionV1Schema = lazyZodSchema(() => z.looseObject({
  kind: z.enum(['approve', 'reject']),
  decidedAtMs: z.number().check(z.int(), z.minimum(0)),
}));
export type ApprovalDecisionV1 = z.infer<typeof ApprovalDecisionV1Schema>;

// Current decision authority is host-stamped. Released V1 history retains its
// original passthrough schema and never authorizes current operand edits.
export const ApprovalDecisionV2Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(ApprovalDecisionV1Schema, {
  authority: z.optional(z.literal('present_user')),
  decidingAccountId: z.optional(SessionMessageAccountActorV1Schema.shape.accountId),
  /** Host-stamped delegated decision modality; absence preserves historical unknown. */
  decidedVia: z.optional(z.literal('voice')),
  narrowedInput: zMini.optional(StrictJsonValueSchema),
})));

/** Host-captured exact requester subject, covered by the incumbent installation signature. */
export const ApprovalRequesterConfirmationV1Schema = lazyZodSchema(() => z.strictObject({
  requestRef: z.string().check(z.minLength(1)),
  requesterAccountId: SessionMessageAccountActorV1Schema.shape.accountId,
  /** Admitting Bot Session, not the original cause persona preserved in attribution. */
  personaSessionRef: SessionMessageRefV1Schema.shape.session,
  executionAccountId: SessionMessageAccountActorV1Schema.shape.accountId,
  inputDigest: z.string().check(z.regex(/^[A-Za-z0-9_-]{43}$/u)),
}));
export type ApprovalRequesterConfirmationV1 = z.infer<typeof ApprovalRequesterConfirmationV1Schema>;

/** A decision on an ordinary approval does not carry requester-specific replay custody. */
export function readApprovalRequesterDecisionV1(
  request: Readonly<{ v: number; requesterConfirmation?: ApprovalRequesterConfirmationV1 }>,
  decision: 'approve' | 'reject' | 'cancel' | undefined,
): Readonly<{ subject: ApprovalRequesterConfirmationV1; decision: 'approve' | 'reject' | 'cancel' }> | null {
  return decision && request.requesterConfirmation ? { subject: request.requesterConfirmation, decision } : null;
}

export const ApprovalExecutionV1Schema = lazyZodSchema(() => z.looseObject({
  executedAtMs: z.number().check(z.int(), z.minimum(0)),
  ok: z.boolean(),
  result: z.optional(z.unknown()),
  errorCode: z.optional(z.string().check(z.minLength(1))),
  error: z.optional(z.string().check(z.minLength(1))),
}));
export type ApprovalExecutionV1 = z.infer<typeof ApprovalExecutionV1Schema>;

/**
 * Current execution history. Failure details are admitted only by the
 * request-bound validator below; this field is not an arbitrary error bag.
 */
export const ApprovalExecutionV2Schema = lazyZodSchema(() => z.strictObject({
  executedAtMs: z.number().check(z.int(), z.minimum(0)),
  /** False only when the approval settled before its Action effect was invoked. */
  effectAttempted: z.optional(z.boolean()),
  ok: z.boolean(),
  result: z.optional(z.unknown()),
  errorCode: z.optional(z.string().check(z.minLength(1))),
  error: z.optional(z.string().check(z.minLength(1))),
  details: z.optional(z.unknown()),
  failureCause: z.optional(ActionFailureCauseV1Schema),
  /** Host-stamped actual credential admissions, not plugin result data or replay authority. */
  operationCredentialUses: z.optional(z.array(ActionOperationCredentialUseV1Schema)),
}).check(z.superRefine((value, ctx) => {
  if (value.effectAttempted === false && value.operationCredentialUses?.length) {
    ctx.addIssue({ code: 'custom', path: ['operationCredentialUses'], message: 'Unattempted effects cannot claim credential use' });
  }
})));
export type ApprovalExecutionV2 = z.infer<typeof ApprovalExecutionV2Schema>;

/**
 * Read-only receipt from the public approval projection, never replay authority.
 * Additive display metadata is dropped; private execution origins are not parsed.
 */
export const ApprovalRequestPublicSettlementSchema = lazyZodSchema(() => z.object({
  v: z.union([z.literal(1), z.literal(2)]),
  actionId: ApprovalRequestV1HistoricalActionIdSchema,
  status: z.enum(['executed', 'failed', 'outcome_unknown']),
  execution: ApprovalExecutionV2Schema,
}).check(z.refine(value => value.execution.ok === (value.status === 'executed'),
  'Public approval status must match its execution outcome')));

const ApprovalExecutionOriginSurfaceV1Schema = lazyZodSchema(() => z.enum([
  'ui',
  'voice',
  'agent',
  'mcp',
  'cli',
  'rpc',
  'api',
  'plugin',
]));

export const ApprovalExecutionOriginCallerV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('host') }),
  AgentStartSessionCallerV1Schema,
  z.strictObject({
    kind: z.literal('plugin'),
    pluginId: asProtocolZod(PluginIdSchema),
    contributionLocalId: asProtocolZod(PluginContributionLocalIdSchema),
    sourceCustody: PluginSourceCustodyV1Schema,
    /** Bounded descriptive admission fact for durable replay, never recursive authority. */
    startedBy: zMini.optional(WorkflowRunStartedByV1Schema),
  }),
  z.strictObject({
    kind: z.literal('automationRun'),
    runId: z.string().check(z.trim(), z.minLength(1)),
    automationId: z.string().check(z.trim(), z.minLength(1)),
    cause: AutomationRunCauseSchema,
  }),
  /**
   * Host-stamped provenance for an admitted Workflow Run, carrying the exact
   * accepted authorization the live Workflow admission already owns. Replay
   * currentness resolves the admitted Run and invocation; the Run identity is immutable.
   */
  z.strictObject({
    kind: z.literal('workflowRun'),
    runId: z.string().check(z.trim(), z.minLength(1)),
    authorization: WorkflowAcceptedAuthorizationV1Schema,
    authenticatedStarterV1: WorkflowAcceptedOriginV1Schema.shape.authenticatedStarterV1,
    discussionModelReservation: z.optional(z.strictObject({
      discussionId: DiscussionIdSchema, participantSlotId: DiscussionIdSchema,
      policySurface: z.optional(z.keyof(ActionSurfaceSchema)),
    })),
  }),
]));
export type ApprovalExecutionOriginCallerV1 = z.infer<typeof ApprovalExecutionOriginCallerV1Schema>;

/**
 * Immutable authority and routing facts captured when a durable approval is
 * admitted. External invocation authorization is Machine-bound authorization
 * material; it contains no PAT bearer and cannot authenticate without that
 * Machine's signature. Descriptive `createdBy`/`origin` is display metadata.
 */
export const ApprovalExecutionOriginV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  authority: ActionRequiredAuthoritySchema,
  surface: ApprovalExecutionOriginSurfaceV1Schema,
  /** Host-observed originating policy audience, not an execution grant. */
  callerSurface: z.optional(ActionCallerSurfaceV1Schema),
  /** Original admitted preference reference; replay must not inherit the deciding caller's selection. */
  approvalProfileId: z.optional(z.nullable(ApprovalProfileIdV1Schema)),
  /** Host-admitted native Workflow leaf depth, retained through its approval. */
  agentStartWorkDepth: z.optional(SessionWorkDepthV1Schema),
  caller: ApprovalExecutionOriginCallerV1Schema,
  /** Local profile identifier used to route the replay to its configured Home. */
  serverId: z.string().check(z.trim(), z.minLength(1)),
  /** Cryptographic Home identity, required for a Home-signed external invocation. */
  serverIdentityId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  accountId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  principalId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  credentialId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  externalActionExecutionAuthorization: zMini.optional(ExternalActionExecutionAuthorizationV1Schema),
  /** Exact signed invocation input retained only while finite daemon replay still needs it. */
  originalActionEnvelope: zMini.optional(ExternalActionRequestEnvelopeSchema),
  externalActionInputSignature: z.optional(z.string().check(z.regex(/^[A-Za-z0-9_-]{86}$/u))),
  sessionId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  /** Original host corpus binding; current resource admission remains mandatory. */
  sessionListAccess: z.optional(z.enum(['current_session', 'led_subtree', 'unavailable', 'mounted_ui'])),
  /** Immutable qualified targets selected before confirmation; never re-expand a selector on replay. */
  sessionTargetsV1: z.optional(ActionResolvedSessionTargetsV1Schema),
  machineId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  runId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  runOccurrenceId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  /** Original admitted permission inputs; current runtime policy is rechecked before replay. */
  callerPermissionMode: zMini.optional(zMini.nullable(asProtocolZod(AgentPermissionIntentV1Schema))),
  sessionAgentSpawnPolicyV1: zMini.optional(SessionAgentSpawnPolicyV1StrictSchema),
  causalPermissionAuthority: zMini.optional(zMini.nullable(SessionInputCausalPermissionAuthorityV1Schema)),
  sessionInputSource: zMini.optional(zMini.nullable(SessionInputSourceSessionV1Schema)),
  discussionReplyReturn: z.optional(DiscussionReplyReturnV1Schema),
  /** Exact admitted cause; never itself a deciding-person credential. */
  actionRequestAttributionV1: z.optional(ActionRequestAttributionV1Schema),
  target: zMini.optional(ExternalActionTargetV1Schema),
  actionId: ActionIdSchema,
  requestId: z.string().check(z.trim(), z.minLength(1)),
}).check(z.superRefine((value, ctx) => {
  const starter = !value.actionRequestAttributionV1 && value.caller.kind === 'workflowRun'
    ? value.caller.authenticatedStarterV1 : undefined;
  if (starter && (starter.requester.accountId !== value.accountId
    || starter.requester.serverId !== (value.serverIdentityId ?? value.serverId))) {
    ctx.addIssue({ code: 'custom', path: ['caller', 'authenticatedStarterV1'], message: 'Workflow starter must match its admitted Account and Home' });
  }
  if (value.caller.kind === 'workflowRun' && value.caller.discussionModelReservation
    && value.actionId !== 'discussion.invite') {
    ctx.addIssue({ code: 'custom', path: ['caller', 'discussionModelReservation'], message: 'Reservation scope requires an invitation' });
  }
  const returned = value.discussionReplyReturn;
  const workflowCaller = value.caller.kind === 'workflowRun' && returned
    && value.caller.runId === ('kind' in returned ? returned.producer.runId : returned.workflow?.runId);
  const discussionReturnSessionId = value.caller.kind === 'session' ? value.caller.sessionId
    : (value.caller.kind === 'host' || workflowCaller) && value.machineId ? value.sessionId : undefined;
  if (returned && 'kind' in returned) {
    if (value.actionId !== 'discussion.reply' || !workflowCaller || !value.machineId || !value.accountId
      || value.sessionId !== undefined || value.sessionInputSource != null || returned.serverId !== value.serverIdentityId) {
      ctx.addIssue({ code: 'custom', path: ['discussionReplyReturn'], message: 'Workflow return must retain its exact Machine, Account and Home' });
    }
  } else if (returned && (value.actionId !== 'discussion.reply' || !discussionReturnSessionId
    || value.sessionId !== undefined && value.sessionId !== discussionReturnSessionId || returned.serverId !== value.serverIdentityId
    || value.sessionInputSource && (value.sessionInputSource.sourceSessionId !== discussionReturnSessionId
      || value.sessionInputSource.sourceInputId !== returned.requestLocalId
      || value.sessionInputSource.sourceTurnId !== returned.acceptedTurnId))) {
    ctx.addIssue({ code: 'custom', path: ['discussionReplyReturn'], message: 'Discussion return must retain its exact original Session and Home' });
  }
  if (value.sessionTargetsV1) {
    const declaration = getActionSpec(value.actionId).sessionTarget;
    const targets = value.sessionTargetsV1;
    // The wrapper's declaration is supplied by the current contributed Action,
    // not a second static entry in the host catalog. Its request schema binds
    // this canonical input-prefixed snapshot to the parsed invocation below.
    const contributedOperand = value.actionId === 'action.invoke' && targets.field.startsWith('input.')
      && InputPathSchema.safeParse(targets.field.slice('input.'.length)).success;
    if (targets.actionId !== value.actionId || (!contributedOperand && (!declaration
      || targets.field !== declaration.field
      // Collection operands each select one Session; their union can contain many.
      || declaration.cardinality === 'one' && (targets.selector
        || !declaration.field.includes('*') && targets.targets.length !== 1)))) {
      ctx.addIssue({ code: 'custom', path: ['sessionTargetsV1'], message: 'Resolved targets must match the declared Action operand and cardinality' });
    }
  }
  if (value.sessionListAccess === 'mounted_ui' && (value.surface !== 'plugin' || value.caller.kind !== 'plugin')) {
    ctx.addIssue({ code: 'custom', path: ['sessionListAccess'],
      message: 'Mounted UI Session-list scope requires an exact plugin contribution origin' });
  }
  if ((value.sessionListAccess === 'current_session' || value.sessionListAccess === 'led_subtree') && !value.sessionId) {
    ctx.addIssue({ code: "custom", path: ['sessionListAccess'],
      message: 'Current-Session list scope requires an exact Session binding' });
  }
  if (
    value.actionId === 'session.list'
    && (value.surface === 'agent' || value.surface === 'mcp' || value.surface === 'plugin')
    && value.sessionListAccess !== 'current_session'
    && value.sessionListAccess !== 'led_subtree'
    && value.sessionListAccess !== 'mounted_ui'
  ) {
    ctx.addIssue({
      code: "custom",
      path: ['sessionListAccess'],
      message: 'Autonomous Session-list approval origins require their exact admitted Session corpus',
    });
  }
  const authorization = value.externalActionExecutionAuthorization;
  if (value.originalActionEnvelope && (!authorization
    || !isExternalActionAuthorizationBoundToEnvelope(authorization.binding, { actionId: value.actionId,
      machineId: value.machineId ?? '', envelope: value.originalActionEnvelope }))) {
    ctx.addIssue({ code: 'custom', path: ['originalActionEnvelope'], message: 'Original envelope must match the exact signed invocation' });
  }
  if (authorization) {
    const binding = authorization.binding;
    // A Workflow leaf has its own correlation ID while retaining the exact
    // Home-admitted Run root. The active Run/invocation reader owns admission.
    const retainedWorkflowRoot = value.caller.kind === 'workflowRun'
      && binding.actionId === WORKFLOW_RUN_START_ACTION_ID_V1
      && sameStrictJsonValue(value.caller.authorization.externalActionExecutionAuthorization, authorization);
    const admittedTarget = value.target !== undefined
      && isExternalActionResolvedTargetAllowedV1({
        authorizedTarget: binding.target,
        resolvedTarget: value.target,
        selectedMachineId: binding.machineId,
      });
    const principalMatches = 'authentication' in binding
      ? value.principalId === undefined && value.credentialId === undefined
        && (retainedWorkflowRoot
          ? value.authority === 'account_automation' && value.surface === 'agent'
          : binding.sessionActionOrigin
          ? value.authority === 'account_automation'
            && (value.surface === 'agent' && sameStrictJsonValue(value.caller, binding.sessionActionOrigin.caller)
              // A nested plugin remains the immediate caller; the original
              // Session admission is retained by the signed source binding.
              || value.surface === 'plugin' && value.caller.kind === 'plugin')
            && value.callerPermissionMode === binding.sessionActionOrigin.callerPermissionMode
            && sameStrictJsonValue(value.causalPermissionAuthority ?? null, binding.sessionActionOrigin.causalPermissionAuthority ?? null)
            && sameStrictJsonValue(value.actionRequestAttributionV1 ?? null, binding.sessionActionOrigin.actionRequestAttributionV1 ?? null)
            && value.sessionInputSource?.sourceSessionId === binding.sessionActionOrigin.caller.sessionId
            && value.sessionInputSource.sourceTurnId === binding.sessionActionOrigin.sourceTurnId
            && value.sessionInputSource.via === 'action'
          : binding.workflowActionOrigin
            ? value.authority === 'account_automation' && value.surface === 'agent' && value.caller.kind === 'host'
              && binding.target.kind === 'machine' && isExternalActionMachineWorkflowActionIdV1(binding.actionId)
              && value.sessionId === undefined && value.sessionInputSource == null
            : ((value.surface === 'ui' || value.surface === 'cli'
                || value.surface === 'voice' && value.authority === 'present_user' && binding.authentication.kind === 'account')
                && value.caller.kind === 'host'
              || value.surface === 'plugin' && value.caller.kind === 'plugin')
            && (value.authority === 'present_user'
              // A Home-admitted paired terminal can propose an approval while
              // retaining automation authority; only the decision grants consent.
              || value.authority === 'account_automation'))
      : value.surface === 'api' && value.authority === 'account_automation'
        && value.principalId === binding.principalId && value.credentialId === binding.credentialId;
    if (!principalMatches || value.serverIdentityId !== binding.serverIdentityId
      || value.accountId !== binding.accountId
      || (!retainedWorkflowRoot && value.requestId !== binding.requestId)
      || value.machineId !== binding.machineId || !admittedTarget) {
      ctx.addIssue({ code: "custom", path: ['externalActionExecutionAuthorization'],
        message: 'Execution authorization must match the exact originating invocation' });
    }
  }
  const credentialFieldCount = [value.principalId, value.credentialId]
    .filter((field) => field !== undefined).length;
  if (credentialFieldCount === 1 || (credentialFieldCount === 2 && !value.accountId)) {
    ctx.addIssue({
      code: "custom",
      path: ['credentialId'],
      message: 'external approval origins require accountId, principalId, and credentialId together',
    });
  }
  if (value.surface === 'api' && (!value.accountId || credentialFieldCount !== 2)) {
    ctx.addIssue({
      code: "custom",
      path: ['credentialId'],
      message: 'API approval origins require verified credential provenance',
    });
  }
  if (value.target?.kind === 'session' && value.sessionId !== value.target.sessionId) {
    ctx.addIssue({
      code: "custom",
      path: ['sessionId'],
      message: 'Session-target approval origins require the same exact Session id',
    });
  }
  if (value.target?.kind === 'machine' && value.machineId !== value.target.machineId) {
    ctx.addIssue({
      code: "custom",
      path: ['machineId'],
      message: 'Machine-target approval origins require the same exact machine id',
    });
  }
  if (value.caller.kind === 'automationRun' && value.runId !== value.caller.runId) {
    ctx.addIssue({
      code: "custom",
      path: ['runId'],
      message: 'Automation-run approval origins require the same exact Run id',
    });
  }
})));
export type ApprovalExecutionOriginV1 = z.infer<typeof ApprovalExecutionOriginV1Schema>;

export function buildApprovalRequesterConfirmationV1(params: Readonly<{
  context: ActionExecutorContext; actionId: ActionId; input: unknown;
}>): ApprovalRequesterConfirmationV1 | null {
  const cause = params.context.actionRequestAttributionV1;
  const executionAccountId = params.context.runtimeAccountId;
  const sessionId = params.context.defaultSessionId;
  const serverId = params.context.serverId;
  if (!cause?.requester || !executionAccountId || cause.requester.accountId === executionAccountId
    || !sessionId || !serverId || cause.requester.serverId !== cause.persona.serverId) return null;
  const parsed = ApprovalRequesterConfirmationV1Schema.safeParse({
    requestRef: cause.requestRef, requesterAccountId: cause.requester.accountId,
    personaSessionRef: { serverId, sessionId }, executionAccountId,
    inputDigest: computeActionInputApprovalDigestV1(params.actionId, params.input),
  });
  return parsed.success ? parsed.data : null;
}

export const APPROVAL_REQUESTER_UNAVAILABLE_MESSAGE_V1 =
  'This action needs confirmation, but the person who requested it could not be identified. Send a new request from your signed-in Happier app.';

/** Required requester consent never falls back to the executor's Account owner. */
export function resolveApprovalRequesterConfirmationV1(params: Readonly<{
  context?: ActionExecutorContext; actionId: ActionId; input: unknown; required: boolean;
}>): Readonly<{ ok: true; requesterConfirmation: ApprovalRequesterConfirmationV1 | null }>
  | Readonly<{ ok: false; errorCode: 'approval_requester_unavailable'; error: typeof APPROVAL_REQUESTER_UNAVAILABLE_MESSAGE_V1 }> {
  let caller = params.context?.actionCaller;
  while (caller?.kind === 'plugin' && caller.initiatingCaller) caller = caller.initiatingCaller;
  // An origin Session and daemon custody do not identify a Workflow's person.
  // Refuse before artifact creation, including explicit and nested requests.
  const context = params.context;
  const starter = caller?.kind === 'workflowRun' && !context?.actionRequestAttributionV1
    ? caller.authenticatedStarterV1 : undefined;
  const starterBound = starter && starter.requester.accountId === context?.runtimeAccountId
    && starter.requester.serverId === (context?.serverIdentityId ?? context?.serverId);
  if (caller?.kind === 'workflowRun' && !context?.actionRequestAttributionV1?.requester && !starterBound) {
    return { ok: false, errorCode: 'approval_requester_unavailable', error: APPROVAL_REQUESTER_UNAVAILABLE_MESSAGE_V1 };
  }
  // A detached Workflow Agent has no Session persona to bind requester
  // confirmation. This owner runs only when an approval is being prepared.
  if (params.context?.executionRunWorkflowRunId && !params.context.defaultSessionId) {
    // A detached Agent's root is its native contribution.
    if (caller?.kind === 'plugin') {
      return { ok: false, errorCode: 'approval_requester_unavailable', error: APPROVAL_REQUESTER_UNAVAILABLE_MESSAGE_V1 };
    }
  }
  if (!params.required) return { ok: true, requesterConfirmation: null };
  const requesterConfirmation = params.context
    ? buildApprovalRequesterConfirmationV1({ ...params, context: params.context }) : null;
  return requesterConfirmation
    ? { ok: true, requesterConfirmation }
    : { ok: false, errorCode: 'approval_requester_unavailable', error: APPROVAL_REQUESTER_UNAVAILABLE_MESSAGE_V1 };
}

export function isApprovalRequesterConfirmationBoundToOriginV1(
  subject: ApprovalRequesterConfirmationV1, origin: ApprovalExecutionOriginV1,
): boolean {
  const cause = origin.actionRequestAttributionV1;
  const binding = origin.externalActionExecutionAuthorization?.binding;
  const sessionId = origin.sessionInputSource?.sourceSessionId
    ?? (origin.caller.kind === 'session' ? origin.caller.sessionId : undefined)
    ?? (binding && 'authentication' in binding ? binding.sessionActionOrigin?.caller.sessionId : undefined);
  // Shared requester consent must bind to the same immutable signed source
  // that the original daemon's existing replay/currentness owner verifies.
  return Boolean(origin.externalActionExecutionAuthorization && origin.externalActionInputSignature)
    && subject.executionAccountId === origin.accountId
    && subject.requesterAccountId !== subject.executionAccountId
    && cause?.requestRef === subject.requestRef
    && cause.requester?.accountId === subject.requesterAccountId
    && cause.requester.serverId === cause.persona.serverId
    && origin.serverId === subject.personaSessionRef.serverId
    && (sessionId === undefined || sessionId === subject.personaSessionRef.sessionId);
}

/** Admission only: execution still rechecks its existing signed origin/currentness owner. */
export async function admitApprovalRequesterDecisionV1(params: Readonly<{
  request: Readonly<{ requesterConfirmation?: ApprovalRequesterConfirmationV1;
    executionOriginV1?: StoredApprovalRequestV2['executionOriginV1']; actionId: ApprovalRequestV1['actionId']; actionArgs: unknown; status: string }>;
  context: ActionExecutorContext;
}>): Promise<Readonly<{ ok: true }> | Readonly<{
  ok: false; errorCode: 'present_user_required' | 'approval_stale' | 'approval_requester_unavailable';
  error: 'present_user_required' | 'approval_stale' | typeof APPROVAL_REQUESTER_UNAVAILABLE_MESSAGE_V1;
}>> {
  const { request, context } = params;
  const subject = request.requesterConfirmation;
  if (!subject) {
    const origin = request.executionOriginV1;
    const starter = !origin?.actionRequestAttributionV1 && origin?.caller.kind === 'workflowRun'
      ? origin.caller.authenticatedStarterV1 : undefined;
    if (!['executed', 'failed', 'rejected', 'canceled'].includes(request.status)
      && origin?.caller.kind === 'workflowRun' && !origin.actionRequestAttributionV1?.requester && !starter) {
      return { ok: false, errorCode: 'approval_requester_unavailable', error: APPROVAL_REQUESTER_UNAVAILABLE_MESSAGE_V1 };
    }
    if (starter && (context.authority !== 'present_user'
      || context.runtimeAccountId !== starter.requester.accountId
      || (context.serverIdentityId ?? context.serverId) !== starter.requester.serverId)) {
      return { ok: false, errorCode: 'present_user_required', error: 'present_user_required' };
    }
    // Session-only proof cannot authorize an ordinary Account-owned request.
    // Retained shared/unknown requests cannot infer a replacement approver;
    // attribution-absent history and settled observation retain their custody.
    if (context.requesterApprovalDecision
      || !['executed', 'failed', 'rejected', 'canceled'].includes(request.status)
        && origin?.actionRequestAttributionV1
        && (!origin.accountId || isSharedRequesterActionV1({
          actionRequestAttributionV1: origin.actionRequestAttributionV1, runtimeAccountId: origin.accountId,
        }))) {
      return { ok: false, errorCode: 'approval_requester_unavailable', error: APPROVAL_REQUESTER_UNAVAILABLE_MESSAGE_V1 };
    }
    return { ok: true };
  }
  const proof = context.requesterApprovalDecision;
  if (context.authority !== 'present_user' || !proof || proof.actor.kind !== 'accountUser'
    || proof.actor.accountId !== subject.requesterAccountId || proof.sessionId !== subject.personaSessionRef.sessionId) {
    return { ok: false, errorCode: 'present_user_required', error: 'present_user_required' };
  }
  const actionId = ActionIdSchema.safeParse(request.actionId);
  const origin = request.executionOriginV1;
  if (!origin || origin.actionId === RETIRED_DEPLOYMENT_PUBLISH_ACTION_ID_V1
    || !isApprovalRequesterConfirmationBoundToOriginV1(subject, origin)
    || !actionId.success
    || context.runtimeAccountId !== undefined && context.runtimeAccountId !== subject.executionAccountId
    || !['executed', 'failed', 'rejected', 'canceled'].includes(request.status)
      && computeActionInputApprovalDigestV1(actionId.data, request.actionArgs) !== subject.inputDigest
    || context.signal?.aborted || !await proof.isCurrent().catch(() => false) || context.signal?.aborted) {
    return { ok: false, errorCode: 'approval_stale', error: 'approval_stale' };
  }
  return { ok: true };
}

function validateApprovalRequestLifecycle(
  value: Readonly<Record<string, unknown>>,
  ctx: z.core.$RefinementCtx,
): void {
  const status = value.status as z.infer<typeof ApprovalRequestV2StatusSchema>;
  const decision = value.decision as ApprovalDecisionV1 | undefined;
  const execution = value.execution as ApprovalExecutionV1 | undefined;
  const requiresDecision = status === 'approved'
    || status === 'executing'
    || status === 'rejected'
    || status === 'executed'
    || status === 'failed' || status === 'outcome_unknown';
  const requiresExecution = status === 'executed' || status === 'failed' || status === 'outcome_unknown';

  if (status === 'open') {
    if (decision != null) ctx.addIssue({ code: "custom", path: ['decision'], message: 'open approval requests must not include a decision' });
    if (execution != null) ctx.addIssue({ code: "custom", path: ['execution'], message: 'open approval requests must not include execution metadata' });
  }
  if (requiresDecision && decision == null) ctx.addIssue({ code: "custom", path: ['decision'], message: `status ${status} requires a decision` });
  if (requiresExecution && execution == null) ctx.addIssue({ code: "custom", path: ['execution'], message: `status ${status} requires execution metadata` });
  if (!requiresExecution && execution != null) ctx.addIssue({ code: "custom", path: ['execution'], message: `status ${status} must not include execution metadata` });
  if ((status === 'approved' || status === 'executing' || status === 'executed' || status === 'failed' || status === 'outcome_unknown') && decision?.kind !== 'approve') {
    ctx.addIssue({ code: "custom", path: ['decision'], message: `status ${status} requires an approve decision` });
  }
  if (status === 'rejected' && decision?.kind !== 'reject') ctx.addIssue({ code: "custom", path: ['decision'], message: 'status rejected requires a reject decision' });
  if (status === 'canceled' && decision != null) ctx.addIssue({ code: "custom", path: ['decision'], message: 'canceled approval requests must not include a decision' });
  if (status === 'executed' && execution?.ok !== true) ctx.addIssue({ code: "custom", path: ['execution'], message: 'status executed requires a successful execution result' });
  if (status === 'failed' && execution?.ok !== false) ctx.addIssue({ code: "custom", path: ['execution'], message: 'status failed requires a failed execution result' });
  if (status === 'outcome_unknown' && (value.v !== 2 || execution?.ok !== false
    || (execution as ApprovalExecutionV2).effectAttempted === false)) {
    ctx.addIssue({ code: 'custom', path: ['execution'], message: 'Unknown approval outcomes require a possibly attempted V2 execution' });
  }
  if (value.v === 2 && execution?.ok === true && Object.hasOwn(execution, 'details')) {
    ctx.addIssue({ code: "custom", path: ['execution', 'details'], message: 'successful approval execution cannot include failure details' });
  }

  if (value.sessionCreationDirectoryApproval !== undefined && value.actionId !== 'session.spawn_new') {
    ctx.addIssue({ code: "custom", path: ['sessionCreationDirectoryApproval'], message: 'Directory creation approval evidence belongs only to session.spawn_new.' });
  }
  if (value.handoffTargetReplacementApproval !== undefined
    && value.actionId !== 'session.handoff'
    && !(value.v === 2 && isWorkspaceSyncRelationshipWriteActionId(value.actionId))) {
    ctx.addIssue({ code: "custom", path: ['handoffTargetReplacementApproval'], message: 'Workspace target approval evidence belongs only to destination-choosing Actions.' });
  }
  validateConfidentialApprovalRequest(value, ctx);
}

/** Read-only retry receipts belong to the original failed items, never to replay authority. */
function validateStorageRetryResults(value: Readonly<Record<string, unknown>>, ctx: z.core.$RefinementCtx): void {
  if (value.storageRetryResults === undefined) return;
  const issue = () => ctx.addIssue({ code: "custom", path: ['storageRetryResults'],
    message: 'Storage retry receipts require distinct settled batches for the proposal’s unsuccessful items' });
  const original = PileApplyResultStoredV1Schema.safeParse((value.execution as ApprovalExecutionV2 | undefined)?.result);
  const args = MachineStorageTrashMoveInputV1Schema.safeParse(value.actionArgs);
  const retries = z.array(PileApplyResultV1Schema).check(z.minLength(1)).safeParse(value.storageRetryResults);
  if (value.v !== 2 || value.status !== 'executed' || value.actionId !== 'machines.storage.trash.move'
    || !original.success || !args.success || !retries.success) { issue(); return; }
  const requested = new Set(args.data.items.map(item => item.ref.itemId));
  const unsuccessful = new Set(original.data.outcomes.filter(outcome => requested.has(outcome.itemId)
    && outcome.status !== 'moved' && outcome.status !== 'deleted').map(outcome => outcome.itemId));
  const batches = new Set([original.data.batchId]);
  const entries = new Set(original.data.trashEntryIds ?? []);
  for (const retry of retries.data) {
    const items = new Set<string>();
    if (retry.mode !== 'trash' || batches.has(retry.batchId) || retry.trashEntryIds === undefined
      || retry.outcomes.length === 0 || retry.trashEntryIds.length > retry.outcomes.filter(outcome => outcome.status === 'moved').length) {
      issue(); return;
    }
    batches.add(retry.batchId);
    for (const outcome of retry.outcomes) {
      if (!unsuccessful.has(outcome.itemId) || items.has(outcome.itemId)) { issue(); return; }
      items.add(outcome.itemId);
      if (outcome.status === 'moved' || outcome.status === 'deleted') unsuccessful.delete(outcome.itemId);
    }
    for (const entryId of retry.trashEntryIds) {
      if (entries.has(entryId)) { issue(); return; }
      entries.add(entryId);
    }
  }
}

export const ApprovalRequestV1Schema = lazyZodSchema(() => z.looseObject({
  v: z.literal(1),
  status: ApprovalRequestStatusSchema,
  createdAtMs: z.number().check(z.int(), z.minimum(0)),
  updatedAtMs: z.number().check(z.int(), z.minimum(0)),
  createdBy: ApprovalRequestCreatedBySchema,
  requestedSurface: z.optional(ApprovalRequestedSurfaceSchema),
  origin: z.optional(ApprovalRequestOriginV1Schema),
  approval: zMini.optional(ActionApprovalSchema),
  actionId: ApprovalRequestV1HistoricalActionIdSchema,
  actionArgs: z.unknown(),
  summary: z.string().check(z.minLength(1)),
  preview: z.optional(z.unknown()),
  /**
   * Host-stamped target evidence for a deferred `session.spawn_new` directory
   * creation approval. It is not Action input and cannot authorize another
   * Action family.
   */
  sessionCreationDirectoryApproval: zMini.optional(SessionCreationDirectoryApprovalV1Schema),
  /** Host-stamped workspace destination evidence; never Action input. */
  handoffTargetReplacementApproval: zMini.optional(HandoffTargetReplacementApprovalV1Schema),
  decision: z.optional(ApprovalDecisionV1Schema),
  execution: z.optional(ApprovalExecutionV1Schema),
}).check(z.superRefine((value, ctx) => {
  validateApprovalRequestLifecycle(value, ctx);
})));
export type ApprovalRequestV1 = z.infer<typeof ApprovalRequestV1Schema>;

/** Current durable replay format. V1 remains readable history but carries no replay authority. */
export const ApprovalRequestV2Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(2),
  status: ApprovalRequestV2StatusSchema,
  createdAtMs: z.number().check(z.int(), z.minimum(0)),
  updatedAtMs: z.number().check(z.int(), z.minimum(0)),
  createdBy: ApprovalRequestCreatedBySchema,
  requestedSurface: z.optional(ApprovalRequestedSurfaceSchema),
  origin: z.optional(ApprovalRequestOriginV1Schema),
  executionOriginV1: ApprovalExecutionOriginV1Schema,
  /** Private binding of the original admitted input, including live-only operands. */
  requestInputDigest: z.optional(z.string().check(z.regex(/^[A-Za-z0-9_-]{43}$/u))),
  requesterConfirmation: z.optional(ApprovalRequesterConfirmationV1Schema),
  /** Immutable private presentation fact; it grants no publication or decision authority. */
  discussionDraftReview: z.optional(z.literal(true)),
  approval: zMini.optional(ActionApprovalSchema),
  actionId: ActionIdSchema,
  actionArgs: z.unknown(),
  summary: z.string().check(z.minLength(1)),
  preview: z.optional(z.unknown()),
  sessionCreationDirectoryApproval: zMini.optional(SessionCreationDirectoryApprovalV1Schema),
  handoffTargetReplacementApproval: zMini.optional(HandoffTargetReplacementApprovalV1Schema),
  decision: z.optional(ApprovalDecisionV2Schema),
  execution: z.optional(ApprovalExecutionV2Schema),
  /** Settled results of new UI retries; original execution and approval authority stay immutable. */
  storageRetryResults: z.optional(z.array(PileApplyResultV1Schema).check(z.minLength(1))),
}).check(z.superRefine((value, ctx) => {
  validateApprovalRequestLifecycle(value, ctx);
  validateStorageRetryResults(value, ctx);
  if (value.discussionDraftReview && value.actionId !== 'discussion.post' && value.actionId !== 'discussion.reply') {
    ctx.addIssue({ code: 'custom', path: ['discussionDraftReview'], message: 'Draft review describes a Discussion publication' });
  }
  if (value.requesterConfirmation && !isApprovalRequesterConfirmationBoundToOriginV1(value.requesterConfirmation, value.executionOriginV1)) {
    ctx.addIssue({ code: 'custom', path: ['requesterConfirmation'], message: 'Requester confirmation must match the exact admitted cause and original executor' });
  }
  if (value.executionOriginV1.actionId !== value.actionId) {
    ctx.addIssue({ code: "custom", path: ['executionOriginV1', 'actionId'], message: 'execution origin Action must match the approved Action' });
  }
  const targets = value.executionOriginV1.sessionTargetsV1;
  if (value.actionId === 'action.invoke' && targets) {
    const invocation = getActionSpec('action.invoke').inputSchema.safeParse(value.actionArgs);
    let matches = false;
    if (invocation.success && invocation.data && typeof invocation.data === 'object' && !Array.isArray(invocation.data)) {
      const input = invocation.data as Readonly<Record<string, unknown>>;
      if (targets.operands) matches = bindActionSessionTargetOperands(input, targets,
        { field: targets.field, cardinality: 'one' }, true) !== null;
      else {
        const operands = readActionSessionTargetOperands(input, targets.field);
        if (operands.length === 1) {
          try {
            const operand = normalizeSessionTargetV1(operands[0]!.value);
            matches = typeof operand === 'string'
              ? targets.targets.length === 1 && operand === targets.targets[0]!.sessionId
              : targets.selector;
          } catch { /* The canonical operand schema refuses malformed retained input. */ }
        }
      }
    }
    if (!matches) ctx.addIssue({ code: 'custom', path: ['actionArgs'],
      message: 'Contributed Session approval targets must match the original invocation operand' });
  }
  // A signed external invocation retains its nested descriptive caller surface.
  // PAT origins stay `api`; ordinary Account host automation stays `ui`/`cli`.
  // The strict origin above owns principal, proof, target and replay authority;
  // a descriptive surface cannot turn automation into a present-user gesture.
  const approvalOrigin = value.executionOriginV1;
  const externalBinding = approvalOrigin.externalActionExecutionAuthorization?.binding;
  const nestedExternalInvocation = externalBinding !== undefined
    && (approvalOrigin.surface === 'api'
      || 'authentication' in externalBinding && !externalBinding.sessionActionOrigin && !externalBinding.workflowActionOrigin
        && approvalOrigin.authority === 'account_automation' && approvalOrigin.caller.kind === 'host'
        && (approvalOrigin.surface === 'ui' || approvalOrigin.surface === 'cli'));
  if (
    value.requestedSurface !== undefined
    && value.requestedSurface !== value.executionOriginV1.surface
    && !nestedExternalInvocation
  ) {
    ctx.addIssue({ code: "custom", path: ['requestedSurface'], message: 'requested surface must match the immutable execution origin' });
  }
  const originCaller = value.executionOriginV1.caller;
  if (originCaller.kind === 'plugin') {
    if (value.createdBy.pluginId !== undefined && value.createdBy.pluginId !== originCaller.pluginId) {
      ctx.addIssue({ code: "custom", path: ['createdBy', 'pluginId'], message: 'display plugin must match the immutable execution origin' });
    }
    if (
      value.createdBy.contributionLocalId !== undefined
      && value.createdBy.contributionLocalId !== originCaller.contributionLocalId
    ) {
      ctx.addIssue({ code: "custom", path: ['createdBy', 'contributionLocalId'], message: 'display contribution must match the immutable execution origin' });
    }
  } else if (value.createdBy.pluginId !== undefined || value.createdBy.contributionLocalId !== undefined) {
    ctx.addIssue({ code: "custom", path: ['createdBy'], message: 'display plugin identity requires a plugin execution origin' });
  }
})));
export type ApprovalRequestV2 = z.infer<typeof ApprovalRequestV2Schema>;

export const ApprovalRequestSchema = lazyZodSchema(() => z.discriminatedUnion('v', [
  ApprovalRequestV1Schema,
  ApprovalRequestV2Schema,
]));
export type CurrentApprovalRequest = z.infer<typeof ApprovalRequestSchema>;
/** Retired combined Publish approvals retain their exact private history, never replay authority. */
export const HistoricalPublishApprovalRequestV2Schema = lazyZodSchema(() => z.strictObject({
  ...ApprovalRequestV2Schema.shape,
  actionId: z.literal(RETIRED_DEPLOYMENT_PUBLISH_ACTION_ID_V1),
  executionOriginV1: z.strictObject({
    ...ApprovalExecutionOriginV1Schema.shape,
    actionId: z.literal(RETIRED_DEPLOYMENT_PUBLISH_ACTION_ID_V1),
    externalActionExecutionAuthorization: z.optional(StrictJsonValueSchema),
    originalActionEnvelope: z.optional(StrictJsonValueSchema),
  }),
}).check(z.superRefine((value, ctx) => {
  validateApprovalRequestLifecycle(value, ctx);
})));
/** Update candidates retain strict validation before the stored subject/transition admission. */
export const ApprovalRequestUpdateSchema = lazyZodSchema(() => z.union([
  ApprovalRequestSchema,
  HistoricalPublishApprovalRequestV2Schema,
]));
export const StoredApprovalRequestSchema = createStoredReadSchema(ApprovalRequestUpdateSchema);
export type ApprovalRequest = z.infer<typeof StoredApprovalRequestSchema>;
export type StoredApprovalRequestV2 = Extract<ApprovalRequest, { v: 2 }>;
export type HistoricalPublishApprovalRequestV2 = z.infer<typeof HistoricalPublishApprovalRequestV2Schema>;

export function isHistoricalPublishApprovalRequestV2(request: ApprovalRequest): request is HistoricalPublishApprovalRequestV2 {
  return request.v === 2 && request.actionId === RETIRED_DEPLOYMENT_PUBLISH_ACTION_ID_V1;
}

export function resolveApprovalRequestAppExecutionPlacement(approval: ApprovalRequest): 'account' | 'client' | null {
  const actionId = ActionIdSchema.safeParse(approval.actionId);
  const spec = actionId.success ? getActionSpec(actionId.data) : null;
  const input = spec?.inputSchema.safeParse(approval.actionArgs);
  // The admitted request owns its flow; authored specs may omit the default
  // or be routed as deferred proposals. A blocking show-once result belongs
  // to the original invocation, never the approving app or durable history.
  const retainedLiveResult = spec?.approvalResultCustody === 'live_only'
    && resolveActionApprovalFlow(approval.approval ?? spec.approval) === 'blocking';
  if (!spec || !input?.success || spec.workspaceWrite === true
    || spec.approvalInputCustody === 'live_only' || retainedLiveResult) return null;
  const placement = resolveActionExecutionPlacementForInput(spec, input.data,
    approval.v === 2 ? approval.executionOriginV1.caller : undefined,
    approval.v === 2 ? approval.executionOriginV1.surface
      : approval.createdBy.surface === 'session_agent' ? 'agent'
        : approval.createdBy.surface === 'system' ? 'ui' : approval.createdBy.surface);
  return placement === 'account' || placement === 'client' ? placement : null;
}

/** Eligibility only: the host must still prove current source custody and own the live waiter. */
export function isMountedPluginBlockingApprovalEligibleForLiveClient(approval: ApprovalRequest): boolean {
  if (approval.v !== 2 || !approval.approval || resolveActionApprovalFlow(approval.approval) !== 'blocking'
    || resolveApprovalRequestAppExecutionPlacement(approval) === null) return false;
  const origin = approval.executionOriginV1;
  return origin.surface === 'plugin' && origin.authority === 'account_automation'
    && origin.caller.kind === 'plugin' && Boolean(origin.serverIdentityId && origin.accountId && origin.machineId)
    && origin.externalActionExecutionAuthorization === undefined && origin.externalActionInputSignature === undefined
    && origin.originalActionEnvelope === undefined && origin.principalId === undefined && origin.credentialId === undefined
    && origin.sessionId === undefined && origin.sessionListAccess === undefined && origin.sessionInputSource === undefined
    && origin.runId === undefined && origin.runOccurrenceId === undefined && origin.callerPermissionMode === undefined
    && origin.causalPermissionAuthority === undefined && origin.sessionAgentSpawnPolicyV1 === undefined
    && (origin.target === undefined || origin.target.kind === 'machine' && origin.target.machineId === origin.machineId);
}

/** Compatibility projection; execution custody is decided by the canonical resolver. */
export function requiresExactDaemonApprovalReplay(approval: ApprovalRequest): boolean {
  const executor = resolveApprovalExecutor(approval);
  return executor.kind === 'daemon'
    || executor.kind === 'live_invocation' && Boolean(executor.daemonMachineId)
    || executor.kind === 'unavailable' && executor.reason !== 'legacy_request';
}


/** Session and accepted Workflow publication custody share this replay classification. */
export function isSessionDiscussionApprovalPublicationV1(approval: ApprovalRequest): boolean {
  if (approval.v !== 2) return false;
  const origin = approval.executionOriginV1;
  if (origin.caller.kind !== 'session' && !((origin.caller.kind === 'host' || origin.caller.kind === 'workflowRun')
    && origin.discussionReplyReturn && origin.machineId
    && ('kind' in origin.discussionReplyReturn || origin.sessionId))) return false;
  let publicationActionId = approval.actionId;
  if (approval.actionId === 'doc.comment.reply' || approval.actionId === 'doc.edit.propose') {
    const serverId = approval.executionOriginV1.serverId;
    // Unresolved/invalid publication intent never transfers to the approving
    // app. Execution admission still validates before issuing a replay witness.
    if (!serverId) return true;
    const input = getActionSpec(approval.actionId).inputSchema.safeParse(approval.actionArgs);
    if (!input.success) return true;
    publicationActionId = prepareDocDiscussionMutationV1(approval.actionId, input.data, serverId).actionId;
  }
  return publicationActionId === 'discussion.create' || publicationActionId === 'discussion.post' || publicationActionId === 'discussion.reply'
    || publicationActionId === 'discussion.second_opinion.start';
}
