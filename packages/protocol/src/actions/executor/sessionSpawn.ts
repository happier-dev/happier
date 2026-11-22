import type { ActionExecutorContext, ActionExecutorDeps } from './types.js';
import { deriveSessionCreationTagV1, deriveWorkflowSessionCreationTag, SessionCreationKeyV1Schema, type SessionCreationKeyV1 } from '../../sessions/creation/sessionCreationIdentityV1.js';
import { readNonEmptyString, readRecord } from '../../inputs/inputRecords.js';
import { SessionSpawnNewInputV2Schema, SessionSpawnNewActionInputV2BaseSchema, SessionSpawnNewActionInputV2Schema, type SessionSpawnNewActionInputV2 } from '../../sessions/creation/sessionSpawnNewInputV2.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import * as z from '../../zodRuntimePolicy.js';
import { projectDiscussionModelParticipantLaunchV1, type DiscussionModelParticipantLaunchV1 } from '../../discussions/modelParticipantLaunch.js';
import { SessionDiscussionParticipantV1Schema } from '../../sessions/creation/sessionDiscussionParticipantV1.js';
import { normalizeId, assignIfDefined } from './inputReading.js';
import { isAgentCaller } from './callerContext.js';
import { snapshotSessionRolesAtSpawnV1 } from '../../prompts/roles/sessionRolesSnapshot.js';
import { SessionCreationDirectoryApprovalV1Schema, type SessionCreationDirectoryApprovalV1 } from '../../sessions/creation/sessionCreationTargetPreparationV1.js';
import { resolveInheritedApprovalProfileIdV1 } from '../approvalProfiles.js';
import { SESSION_SPAWN_NEW_ACTION_ID_V1, type ActionId } from '../actionIds.js';
import { BOT_TEMPLATE_INSTANTIATE_ACTION_ID_V1 } from '../../bots/templates/botTemplateActionIdsV1.js';
import { deriveDeploymentPrepareSessionCreationIdentityV1 } from '../../sessions/creation/sessionCreationAuthorizationV1.js';
import { buildBackendTargetKeyV2, type PersistedBackendTargetRefV2 } from '../../backends/targets/backendTargetRefV2.js';
import { readAuthoredSessionModelSelection } from '../../teams/credentials/sessionBindingIntentV1.js';
import { createPersonalSessionModelSelection, type SessionModelSelection } from '../../providers/selection/v2.js';
import type { AgentStartContextV1 } from '../../account/settings/admitAgentStartV1.js';

type SpawnConfigurationInput = Pick<SessionSpawnNewActionInputV2,
  'sourceContext' | 'configuration' | 'projectContext' | 'roleId' | 'discussionParticipant'>;

function selectsNewSessionProject(input: SpawnConfigurationInput): boolean {
  return (input.projectContext?.projectRef !== undefined || input.projectContext?.sourceRef !== undefined)
    && input.sourceContext === undefined && input.configuration?.providerSessionResume === undefined;
}

/** Retained and ordinary attached Sessions consume captured choices, rather than current defaults. */
export function readSessionSpawnConfigurationSource(
  input: SpawnConfigurationInput, parentSessionId?: string | null,
): 'retained' | 'parent' | 'defaults' {
  if (input.sourceContext !== undefined || input.configuration?.providerSessionResume !== undefined) return 'retained';
  return parentSessionId && !selectsNewSessionProject(input) && !input.roleId && !input.discussionParticipant ? 'parent' : 'defaults';
}

/** An omitted choice can inherit. Automatic and an authored model slot both occupy the model facet. */
export function readSessionSpawnModelChoice(
  input: Pick<SessionSpawnNewActionInputV2, 'modelSelection' | 'configuration' | 'teamCredentialBindings'>,
  agentTarget: PersistedBackendTargetRefV2,
): SessionModelSelection | null | undefined {
  const selection = readAuthoredSessionModelSelection({ ...input, agentTarget });
  if (selection) return selection;
  const model = input.configuration?.model;
  if (model?.value) return { v: 1, updatedAt: model.updatedAtMs,
    ref: { agentTargetKey: buildBackendTargetKeyV2(agentTarget), providerConnectionId: null, modelId: model.value } };
  if (model?.value === null && model.selectionSource !== 'inherited') return null;
  if (input.teamCredentialBindings?.some(intent => intent.slot.kind === 'provider_model')) return null;
  return undefined;
}

const capturedModelOperand = lazyZodSchema(() => z.object(z.pick(SessionSpawnNewActionInputV2BaseSchema, {
  agentTarget: true, sourceContext: true, configuration: true, projectContext: true, roleId: true,
  discussionParticipant: true, modelSelection: true, teamCredentialBindings: true,
}).shape));

/** Freeze the current applied parent model into the admitted operand, including Machine RPC replay. */
export function projectCapturedSessionSpawnModel(
  input: Readonly<Record<string, unknown>>,
  context: AgentStartContextV1,
): Readonly<Record<string, unknown>> {
  const captured = context.baseline.configuration?.modelSelection;
  if (context.caller.kind !== 'session' || !captured) return input;
  const operand = capturedModelOperand.safeParse(input);
  if (!operand.success || !operand.data.agentTarget
    || readSessionSpawnConfigurationSource(operand.data, context.caller.sessionId) !== 'parent'
    || readSessionSpawnModelChoice(operand.data, operand.data.agentTarget) !== undefined) return input;
  const selection = 'ref' in captured ? captured : createPersonalSessionModelSelection(captured, 0);
  return selection.ref.agentTargetKey === buildBackendTargetKeyV2(operand.data.agentTarget) ? { ...input, modelSelection: selection } : input;
}

function resolveSessionSpawnNewCreationKey(
  data: Readonly<Record<string, unknown>>,
  ctx: ActionExecutorContext,
): SessionCreationKeyV1 | null {
  const explicitCreationKey = SessionCreationKeyV1Schema.safeParse(data.creationKey);
  const actionRequestId = readNonEmptyString(ctx.actionRequestId);
  const creationKey = explicitCreationKey.success
    ? explicitCreationKey.data
    : actionRequestId
      ? SessionCreationKeyV1Schema.parse(`action-request:${actionRequestId}`)
      : null;
  return creationKey;
}

/**
 * A deferred Session spawn must retain the same durable creation identity that
 * a live API invocation derives from its host-stamped request id. The approval
 * artifact is the only replay input; the later present-user decision has its
 * own context and must not need (or inherit) the original external request.
 */
function materializeSessionSpawnApprovalInput(
  input: unknown,
  ctx: ActionExecutorContext,
): unknown {
  const canonical = SessionSpawnNewActionInputV2Schema.safeParse(input);
  if (!canonical.success) return input;
  const creationKey = resolveSessionSpawnNewCreationKey(canonical.data, ctx);
  return creationKey
    ? { ...canonical.data, creationKey }
    : canonical.data;
}

/** Bind ordinary and template-backed creation before reviewed children or deferred approval. */
export function materializeSessionCreationActionInput(
  actionId: ActionId,
  input: unknown,
  ctx: ActionExecutorContext,
): unknown {
  if (actionId === SESSION_SPAWN_NEW_ACTION_ID_V1) return materializeSessionSpawnApprovalInput(input, ctx);
  if (actionId !== BOT_TEMPLATE_INSTANTIATE_ACTION_ID_V1) return input;
  const data = readRecord(input);
  return { ...data, creation: materializeSessionSpawnApprovalInput(data.creation, ctx) };
}

export function buildSessionSpawnNewArgs(
  data: Readonly<Record<string, unknown>> & Pick<SessionSpawnNewActionInputV2,
    'approvalProfileId' | 'configuration' | 'projectContext' | 'sourceContext'>,
  ctx: ActionExecutorContext,
  legacyMetadataLabel?: string,
  discussionParticipantLaunch?: DiscussionModelParticipantLaunchV1,
): Parameters<NonNullable<ActionExecutorDeps['sessionSpawnNew']>>[0] | null {
  const participant = SessionDiscussionParticipantV1Schema.safeParse(data.discussionParticipant);
  const discussionParticipant = participant.success ? participant.data : null;
  const creationKey = discussionParticipant?.participantSlotId ?? resolveSessionSpawnNewCreationKey(data, ctx);
  if (!creationKey) return null;

  if (
    !discussionParticipant && ctx.actionCaller?.kind === 'automationRun'
    && creationKey !== `automation-run:${ctx.actionCaller.runId}`
  ) {
    return null;
  }

  // The actual Home's Account/tag index already supplies Home scope. A local
  // server-profile alias or the current caller must not create another slot.
  const callerCreationNamespace = discussionParticipant
    ? JSON.stringify(['discussion-participant', discussionParticipant.discussionId])
    : ctx.actionCaller?.kind === 'automationRun'
    ? `automation:${ctx.actionCaller.automationId}`
    : ctx.surface === 'plugin'
    && ctx.actionCaller?.kind === 'plugin'
    ? `plugin:${ctx.actionCaller.pluginId}`
    : ctx.authority === 'account_automation'
    && ctx.externalActionCredential
    && normalizeId(ctx.externalActionCredential.accountId)
    && normalizeId(ctx.externalActionCredential.principalId)
    ? `api-principal:${normalizeId(ctx.externalActionCredential.accountId)}:${normalizeId(ctx.externalActionCredential.principalId)}`
    : ctx.authority === 'account_automation'
    && ctx.surface === 'agent'
    && normalizeId(ctx.serverId)
    && normalizeId(ctx.runtimeAccountId)
    && normalizeId(ctx.defaultSessionId)
    // The existing creation identity accepts an opaque caller namespace. Bind
    // ordinary Agent retries to their admitted parent, not a human message author.
    ? JSON.stringify(['session', normalizeId(ctx.serverId), normalizeId(ctx.runtimeAccountId), normalizeId(ctx.defaultSessionId)])
    : ctx.authority === 'account_automation'
    && (ctx.surface === 'voice' || ctx.surface === 'cli')
    && (!ctx.actionCaller || ctx.actionCaller.kind === 'host')
    && normalizeId(ctx.serverId)
    && normalizeId(ctx.runtimeAccountId)
    // Voice and CLI can create before any parent Session exists. The admitted
    // Home and Account scope retries without granting present-user authority.
    ? JSON.stringify([ctx.surface, normalizeId(ctx.serverId), normalizeId(ctx.runtimeAccountId)])
    : ctx.authority === 'present_user'
    ? 'user'
    : null;
  const workflowCreationTag = !discussionParticipant && ctx.actionCaller?.kind === 'workflowRun' && normalizeId(ctx.serverId)
    ? deriveWorkflowSessionCreationTag(normalizeId(ctx.serverId), ctx.actionCaller.runId, creationKey) : null;
  const prepareIdentity = ctx.externalActionExecutionAuthorization
    ? deriveDeploymentPrepareSessionCreationIdentityV1(ctx.externalActionExecutionAuthorization.binding) : null;
  const sessionCreationTag = ctx.managedContinuationSessionCreationTag ?? prepareIdentity?.sessionCreationTag ?? workflowCreationTag ?? (callerCreationNamespace
    ? deriveSessionCreationTagV1({ callerCreationNamespace, creationKey }) : null);
  if (!sessionCreationTag) return null;
  const selectsNewProject = selectsNewSessionProject(data);
  const args: Record<string, unknown> = {
    ...data,
    // A new Project launch selects its own defaults. Ordinary attached or
    // retained launches inherit their Session's choice, including no profile.
    approvalProfileId: data.approvalProfileId === undefined
        && (selectsNewProject || (!normalizeId(ctx.defaultSessionId) && ctx.approvalProfileId == null))
      ? undefined
      : resolveInheritedApprovalProfileIdV1(data.approvalProfileId, ctx.approvalProfileId),
    ...(!discussionParticipant && isAgentCaller(ctx) && data.manager === undefined && ctx.defaultSessionId
      ? { manager: { sessionId: normalizeId(ctx.defaultSessionId) } } : {}),
    creationKey,
    sessionCreationTag,
    actionCaller: ctx.actionCaller ?? { kind: 'host' },
    context: ctx,
  };
  const leadSessionId = normalizeId(ctx.defaultSessionId);
  if (leadSessionId && ctx.agentStartContext) {
    args.initialSessionRolesV1 = {
      ...snapshotSessionRolesAtSpawnV1({
        leadSessionId,
        roles: ctx.agentStartContext.roles,
        notes: ctx.sessionRoleConfiguration?.notes,
      }),
      ...(typeof data.roleId === 'string' ? { roleId: data.roleId } : {}),
    };
  }
  assignIfDefined(args, 'legacyMetadataLabel', legacyMetadataLabel);
  assignIfDefined(args, 'actionRequestId', ctx.actionRequestId ?? undefined);
  assignIfDefined(args, 'resumeActionRequest', ctx.resumeActionRequest === true ? true : undefined);
  assignIfDefined(args, 'signal', ctx.signal);
  const callerGrant = ctx.externalActionCredential?.grant;
  if (callerGrant) {
    args.callerInputConstraints = { models: callerGrant.models, permissionModes: callerGrant.permissionModes };
  }
  if (ctx.externalActionExecutionAuthorization?.binding.actionId === SESSION_SPAWN_NEW_ACTION_ID_V1) {
    args.creationAuthorization = { token: ctx.externalActionExecutionAuthorization.token };
  }
  assignIfDefined(args, 'workDepth', ctx.agentStartWorkDepth);
  if (discussionParticipant) {
    args.originKind = 'discussion';
    args.discussionParticipant = discussionParticipant;
    args.discussionParticipantLaunch = discussionParticipantLaunch
      ?? projectDiscussionModelParticipantLaunchV1(SessionSpawnNewInputV2Schema.parse(data));
  } else if (ctx.agentStartWorkDepth !== undefined) {
    args.originKind = ctx.actionCaller?.kind === 'workflowRun' ? 'run_step' : ctx.runtimeRunId ? 'execution_run' : 'session';
    if (ctx.actionCaller?.kind === 'workflowRun') args.originRunId = ctx.actionCaller.runId;
    if (ctx.defaultSessionId) args.originSessionId = ctx.defaultSessionId;
  }
  const directoryApproval = SessionCreationDirectoryApprovalV1Schema.safeParse(
    ctx.sessionCreationDirectoryApproval,
  );
  if (directoryApproval.success) {
    assignIfDefined(args, 'sessionCreationDirectoryApproval', directoryApproval.data);
  }
  if (ctx.surface) {
    assignIfDefined(args, 'callerSurface', ctx.surface);
  }
  if (ctx.surface === 'agent') {
    assignIfDefined(args, 'sessionAgentSpawnPolicyV1', ctx.sessionAgentSpawnPolicyV1);
  }
  return args as Parameters<NonNullable<ActionExecutorDeps['sessionSpawnNew']>>[0];
}

export function sameSessionCreationDirectoryApproval(
  left: SessionCreationDirectoryApprovalV1 | null | undefined,
  right: SessionCreationDirectoryApprovalV1 | null | undefined,
): boolean {
  return left?.v === right?.v
    && left?.executionTarget.serverId === right?.executionTarget.serverId
    && left?.executionTarget.machineId === right?.executionTarget.machineId
    && left?.directory === right?.directory;
}
