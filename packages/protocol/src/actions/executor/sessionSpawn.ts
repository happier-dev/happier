import type { ActionExecutorContext, ActionExecutorDeps } from './types.js';
import { deriveSessionCreationTagV1, SessionCreationKeyV1Schema, type SessionCreationKeyV1 } from '../../sessions/creation/sessionCreationIdentityV1.js';
import { readNonEmptyString } from '../../inputs/inputRecords.js';
import { SessionSpawnNewInputV2Schema, SessionSpawnNewActionInputV2Schema } from '../../sessions/creation/sessionSpawnNewInputV2.js';
import { projectDiscussionModelParticipantLaunchV1, type DiscussionModelParticipantLaunchV1 } from '../../discussions/modelParticipantLaunch.js';
import { SessionDiscussionParticipantV1Schema } from '../../sessions/creation/sessionDiscussionParticipantV1.js';
import { normalizeId, assignIfDefined } from './inputReading.js';
import { isAgentCaller } from './callerContext.js';
import { snapshotSessionRolesAtSpawnV1 } from '../../prompts/roles/sessionRolesSnapshot.js';
import { SessionCreationDirectoryApprovalV1Schema, type SessionCreationDirectoryApprovalV1 } from '../../sessions/creation/sessionCreationTargetPreparationV1.js';

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
export function materializeSessionSpawnApprovalInput(
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

export function buildSessionSpawnNewArgs(
  data: Readonly<Record<string, unknown>>,
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
  if (!callerCreationNamespace) return null;
  const args: Record<string, unknown> = {
    ...data,
    ...(!discussionParticipant && isAgentCaller(ctx) && data.manager === undefined && ctx.defaultSessionId
      ? { manager: { sessionId: normalizeId(ctx.defaultSessionId) } } : {}),
    creationKey,
    sessionCreationTag: deriveSessionCreationTagV1({
      callerCreationNamespace,
      creationKey,
    }),
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
  if (ctx.externalActionExecutionAuthorization) {
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
