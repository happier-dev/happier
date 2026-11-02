import { isPresentUserHostInvocation } from '../invocationAuthority.js';
import { ApprovalExecutionOriginV1Schema, ApprovalRequestOriginV1Schema, isApprovalRequesterConfirmationBoundToOriginV1, type ApprovalRequesterConfirmationV1, type ApprovalExecutionOriginCallerV1, type ApprovalExecutionOriginV1, type ApprovalRequest, type ApprovalRequestOriginV1 } from '../../approvals/approvalRequestV1.js';
import { type ActionId } from '../actionIds.js';
import { getActionSpec, resolveActionExecutionPlacementForInput } from '../actionSpecs.js';
import type { ActionCaller, ActionExecutorContext } from './types.js';
import { normalizeId } from './inputReading.js';
import { AgentStartSessionCallerV1Schema } from '../../account/settings/admitAgentStartV1.js';
import { PluginSourceCustodyV1Schema } from '../../plugins/runtime/sourceCustody.js';
import { resolveWorkflowRunStartedByForActionCallerV1 } from '../../workflows/materializeWorkflowAcceptedSnapshotV1.js';
import { parseActionSurfaceKey, isAgentCaller } from './callerContext.js';
import { readRecord } from '../../inputs/inputRecords.js';
import { ArtifactActionInputSchemasV1 } from '../../artifacts/artifactActionsV1.js';
import { parseAgentPermissionIntentV1Alias } from '../../runtime/permissionIntentV1.js';
import { SessionAgentSpawnPolicyV1StrictSchema } from '../../account/settings/accountSettings.js';
import { PluginSettingsAdministrationActionIdV1Schema, resolvePluginSettingsAdministrationTargetV1 } from '../../plugins/settingsAdministration.js';
import { NpmRegistryProfileActionIdV1Schema, NpmRegistryProfileActionInputSchemasV1 } from '../npmRegistryProfileActionFamily.js';
import { readLocalServiceControlActionRequest } from '../specs/localServices.js';
import { isProjectWorkspaceSyncPreparationActionV1 } from '../projectActionIdsV1.js';
import { isInternalActionId } from '../pluginActionSurface.js';
import { isDeploymentChildRootActionIdV1 } from '../../deployments/deploymentActionIdsV1.js';
import { computeExternalActionRequestEnvelopeDigestV1 } from '../externalActionExecutionAuthorization.js';
import { sameStrictJsonValue } from '../../json/strictJsonValue.js';
import { MachineServiceLogsReadInputV1Schema } from '../../local/services/nativeLogsV1.js';

/** The same live signed logs invocation owns its non-serializable observation. */
export function resolveMachineServiceLogsApprovalLifetime(actionId: ActionId | null, input: unknown, context: ActionExecutorContext) {
  const resource = context.machineServiceLogsResource;
  const authorization = context.externalActionExecutionAuthorization;
  const envelope = context.originalActionEnvelope;
  if (actionId !== 'machines.services.logs.read' || !resource || !context.signal || context.signal.aborted
    || context.surface !== 'ui' || context.actionCaller && context.actionCaller.kind !== 'host'
    || !authorization || !envelope || authorization.binding.actionId !== actionId
    || authorization.binding.target.kind !== 'machine' || envelope.target?.kind !== 'machine'
    || envelope.target.machineId !== authorization.binding.machineId
    || envelope.requestId !== authorization.binding.requestId
    || computeExternalActionRequestEnvelopeDigestV1(envelope) !== authorization.binding.requestEnvelopeDigest) return undefined;
  if (envelope.v === 1) {
    const admitted = MachineServiceLogsReadInputV1Schema.safeParse(input);
    const original = MachineServiceLogsReadInputV1Schema.safeParse(envelope.input);
    const reference = envelope.resourceContinuation?.params.resource;
    if (!admitted.success || !original.success || !sameStrictJsonValue(admitted.data, original.data)
      || (envelope.machineServiceLogsGeneration?.expectedGeneration ?? reference?.expectedGeneration) !== resource.expectedGeneration
      || envelope.machineServiceLogsGeneration && envelope.machineServiceLogsGeneration.expectedGeneration !== resource.expectedGeneration
      || reference && (reference.expectedGeneration !== resource.expectedGeneration
        || reference.sourceRevision !== resource.sourceRevision || !sameStrictJsonValue(reference.input, admitted.data))) return undefined;
  }
  return { actionId, surface: 'ui' as const, signal: context.signal };
}

export function resolveApprovalOriginForRequest(
  origin: unknown,
  sessionId: string | null,
): ApprovalRequestOriginV1 | null {
  const parsed = ApprovalRequestOriginV1Schema.safeParse(origin);
  if (!parsed.success) return null;
  if (sessionId && parsed.data.sessionId !== sessionId) return null;
  return parsed.data;
}

/** Correlation is durable; a transcript's copy of live-only input is not. */
export function projectActionApprovalOrigin(
  actionId: ActionId,
  origin: ApprovalRequestOriginV1 | null,
  observationOnly = false,
): ApprovalRequestOriginV1 | null {
  if (!origin || getActionSpec(actionId).approvalInputCustody !== 'live_only'
    && !(observationOnly && actionId === 'plugins.settings.set')) return origin;
  const { toolInput: _privateInput, ...provenance } = origin;
  return provenance;
}

export function projectActionObservationContext(actionId: ActionId, context: ActionExecutorContext): ActionExecutorContext {
  if (getActionSpec(actionId).approvalInputCustody !== 'live_only' && actionId !== 'plugins.settings.set'
    || !context.approvalOrigin) return context;
  return { ...context, approvalOrigin: projectActionApprovalOrigin(actionId,
    resolveApprovalOriginForRequest(context.approvalOrigin, null), true) };
}

export function resolvePolicyApprovalRequestingSessionId(
  rawOrigin: unknown,
  ctx: ActionExecutorContext,
  targetSessionId: string | null,
): string | null {
  const origin = resolveApprovalOriginForRequest(rawOrigin, null);
  const originSessionId = normalizeId(origin?.sessionId);
  if (originSessionId) return originSessionId;

  const defaultSessionId = normalizeId(ctx.defaultSessionId);
  if (defaultSessionId) return defaultSessionId;

  return targetSessionId;
}

/**
 * The one projection from the live `ActionCaller` union onto the durable
 * approval-origin caller. It is exhaustive by construction: a new live caller
 * arm is a compile error here, and an unmapped arm fails closed with `null`
 * rather than being persisted as `host`. A durable approval must never lose the
 * principal that replay currentness has to recheck.
 */
export function projectApprovalExecutionOriginCaller(
  rawCaller: ActionCaller,
): ApprovalExecutionOriginCallerV1 | null {
  switch (rawCaller.kind) {
    case 'host':
      return { kind: 'host' };
    case 'session': {
      const caller = AgentStartSessionCallerV1Schema.safeParse(rawCaller);
      return caller.success ? caller.data : null;
    }
    case 'plugin': {
      const sourceCustody = PluginSourceCustodyV1Schema.safeParse(rawCaller.sourceCustody);
      const pluginId = normalizeId(rawCaller.pluginId);
      const contributionLocalId = normalizeId(rawCaller.contributionLocalId);
      if (!pluginId || !contributionLocalId || !sourceCustody.success) return null;
      return { kind: 'plugin', pluginId, contributionLocalId, sourceCustody: sourceCustody.data,
        startedBy: resolveWorkflowRunStartedByForActionCallerV1(rawCaller) };
    }
    case 'automationRun':
      return {
        kind: 'automationRun',
        runId: rawCaller.runId,
        automationId: rawCaller.automationId,
        cause: rawCaller.cause,
      };
    case 'workflowRun':
      return {
        kind: 'workflowRun',
        runId: rawCaller.runId,
        authorization: rawCaller.authorization,
        ...(rawCaller.authenticatedStarterV1 ? { authenticatedStarterV1: rawCaller.authenticatedStarterV1 } : {}),
        ...(rawCaller.discussionModelReservation ? { discussionModelReservation: rawCaller.discussionModelReservation } : {}),
      };
    default:
      return refuseUnmappedApprovalCaller(rawCaller);
  }
}

/**
 * Compile-time exhaustiveness for the projection above: adding a live caller arm
 * without mapping it is a type error here, and an untyped arm reaching this at
 * runtime yields no durable approval at all.
 */
function refuseUnmappedApprovalCaller(_caller: never): null {
  return null;
}

export function buildApprovalExecutionOriginV1(params: Readonly<{
  actionId: ActionId;
  input: unknown;
  admittedInput?: unknown;
  context: ActionExecutorContext;
  targetSessionId: string | null;
  requesterConfirmation?: ApprovalRequesterConfirmationV1;
}>): ApprovalExecutionOriginV1 | null {
  const authority = params.context.authority ?? 'account_automation';
  const requestedSurface = parseActionSurfaceKey(params.context.surface);
  const inputRecord = readRecord(params.input);
  const inputExecutionTarget = readRecord(inputRecord.executionTarget);
  const serverId = normalizeId(params.context.serverId) || normalizeId(inputExecutionTarget.serverId);
  if (!requestedSurface || !serverId) return null;

  const caller = projectApprovalExecutionOriginCaller(
    params.context.actionCaller ?? { kind: 'host' as const },
  );
  if (!caller) return null;

  const recipient = readRecord(inputRecord.recipient);
  const runId = normalizeId(params.context.runtimeRunId)
    || (recipient.kind === 'execution_run' ? normalizeId(recipient.runId) : '')
    || normalizeId(inputRecord.runId);
  const externalCredential = params.context.externalActionCredential;
  const externalAuthorization = params.context.externalActionExecutionAuthorization;
  if (externalCredential && !externalAuthorization) return null;
  // Preserve the Home-admitted principal family, rather than turning genuine
  // Account/UI or Session automation into descriptive PAT provenance.
  const accountBinding = externalAuthorization && 'authentication' in externalAuthorization.binding
    ? externalAuthorization.binding : null;
  const sessionActionOrigin = accountBinding?.sessionActionOrigin;
  if (sessionActionOrigin && params.context.workspaceWrites !== sessionActionOrigin.workspaceWrites) return null;
  const surface = externalAuthorization
    ? accountBinding
      ? sessionActionOrigin || accountBinding.workflowActionOrigin
        ? requestedSurface === 'plugin' && caller.kind === 'plugin' ? 'plugin' as const : 'agent' as const
        : requestedSurface === 'plugin' && caller.kind === 'plugin' ? 'plugin' as const
          : requestedSurface === 'cli' && caller.kind === 'host' ? 'cli' as const : 'ui' as const
      : 'api' as const
    : requestedSurface;
  let externalActionInputSignature: string | undefined;
  if (externalAuthorization) {
    if (!params.context.signExternalActionApprovalInput) return null;
    try {
      externalActionInputSignature = params.context.signExternalActionApprovalInput({
        actionId: params.actionId, input: params.input, authorization: externalAuthorization,
        target: params.context.externalActionTarget ?? externalAuthorization.binding.target,
        ...(params.requesterConfirmation ? { requesterConfirmation: params.requesterConfirmation } : {}),
        ...(params.context.sessionTargetsV1 ? { sessionTargetsV1: params.context.sessionTargetsV1 } : {}),
      });
    } catch { return null; }
  }
  const externalTarget = params.context.externalActionTarget;
  const publication = params.actionId === 'artifact.publish_from_file'
    ? ArtifactActionInputSchemasV1['artifact.publish_from_file'].safeParse(params.admittedInput ?? params.input) : null;
  if (publication && !publication.success) return null;
  const publicationMachineId = publication?.success ? publication.data.workspace?.machineId : undefined;
  if (publicationMachineId && ((externalTarget?.kind === 'machine' && externalTarget.machineId !== publicationMachineId)
    || (externalAuthorization && externalAuthorization.binding.machineId !== publicationMachineId))) return null;
  const targetSessionId = params.targetSessionId
    || (externalTarget?.kind === 'session' ? normalizeId(externalTarget.sessionId) : '')
    // Account-placed automatic returns still retain their exact original
    // input custody. This does not turn ordinary Account work into a Session target.
    || (params.context.discussionReplyReturn ? normalizeId(params.context.defaultSessionId) : '');
  const observedServerIdentityId = normalizeId(params.context.serverIdentityId);
  if (
    externalAuthorization
    && observedServerIdentityId
    && observedServerIdentityId !== externalAuthorization.binding.serverIdentityId
  ) return null;
  const rawCallerPermissionMode = params.context.callerPermissionMode;
  const callerPermissionMode = typeof rawCallerPermissionMode === 'string'
    ? parseAgentPermissionIntentV1Alias(rawCallerPermissionMode)
    : rawCallerPermissionMode;
  if (typeof rawCallerPermissionMode === 'string' && callerPermissionMode === null) return null;
  const spawnPolicy = isAgentCaller(params.context)
    ? SessionAgentSpawnPolicyV1StrictSchema.safeParse(params.context.sessionAgentSpawnPolicyV1 ?? {})
    : null;
  if (spawnPolicy && !spawnPolicy.success) return null;
  const settingsActionId = PluginSettingsAdministrationActionIdV1Schema.safeParse(params.actionId);
  let settingsTarget: ReturnType<typeof resolvePluginSettingsAdministrationTargetV1> | null = null;
  if (settingsActionId.success) {
    try { settingsTarget = resolvePluginSettingsAdministrationTargetV1(settingsActionId.data, params.input); }
    catch { return null; }
  }
  const npmProfileActionId = NpmRegistryProfileActionIdV1Schema.safeParse(params.actionId);
  if (npmProfileActionId.success) {
    const npmInput = NpmRegistryProfileActionInputSchemasV1[npmProfileActionId.data].safeParse(params.input);
    if (!npmInput.success) return null;
    settingsTarget = { kind: 'daemon', ...npmInput.data.target };
  }
  const capturedServerIdentityId = externalAuthorization?.binding.serverIdentityId ?? observedServerIdentityId;
  if (settingsTarget?.kind === 'daemon' && capturedServerIdentityId
    && settingsTarget.serverIdentityId !== capturedServerIdentityId) return null;
  const serverIdentityId = capturedServerIdentityId || (settingsTarget?.kind === 'daemon' ? settingsTarget.serverIdentityId : '');
  // Account storage does not erase the originating invocation's replay custody.
  // An unsigned Account/UI edit still needs no Machine; explicit invocation
  // targets, signed invocations and Session callers retain their replay custody.
  const machineId = settingsTarget?.kind === 'daemon'
    ? settingsTarget.machineId
    : settingsTarget?.kind === 'account' && !externalAuthorization && caller.kind === 'host'
      && externalTarget?.kind !== 'machine'
      ? ''
    : normalizeId(publicationMachineId)
    || normalizeId(params.context.executionRunTargetMachineId)
    || externalAuthorization?.binding.machineId
    // Placement parses the admitted payload; durable approval input may omit live-only values.
    || (resolveActionExecutionPlacementForInput(getActionSpec(params.actionId), params.admittedInput ?? params.input) === 'machine'
      ? normalizeId(inputRecord.machineId) : '')
    || readLocalServiceControlActionRequest(params.actionId, params.input)?.target.machineId
    || normalizeId(params.context.defaultSessionMachineId)
    || normalizeId(inputExecutionTarget.machineId)
    || (externalTarget?.kind === 'machine' ? normalizeId(externalTarget.machineId) : '')
    // A daemon plugin can request Account work without a Session or explicit
    // target. Retain its host-stamped Machine as origin, not execution input.
    || (params.context.actionCaller?.kind === 'plugin'
      ? normalizeId(params.context.actionCaller.materialization?.machineId) : '');
  const candidate = {
    v: 1,
    authority,
    surface,
    caller,
    serverId,
    ...(serverIdentityId
      ? { serverIdentityId }
      : {}),
    ...(normalizeId(params.context.runtimeAccountId)
      ? { accountId: normalizeId(params.context.runtimeAccountId) }
      : externalCredential
        ? { accountId: externalCredential.accountId }
        : {}),
    ...(externalCredential
      ? {
          principalId: externalCredential.principalId,
          credentialId: externalCredential.credentialId,
        }
      : {}),
    ...(externalAuthorization ? { externalActionExecutionAuthorization: externalAuthorization } : {}),
    ...((params.actionId === 'projects.open' || isProjectWorkspaceSyncPreparationActionV1(params.actionId)
      || isDeploymentChildRootActionIdV1(params.actionId) || params.actionId === 'deployments.teardown'
      || params.actionId === 'machines.services.logs.read' && params.context.machineServiceLogsResource)
      && externalAuthorization?.binding.actionId === params.actionId && params.context.originalActionEnvelope
      ? { originalActionEnvelope: params.context.originalActionEnvelope } : {}),
    ...(externalActionInputSignature ? { externalActionInputSignature } : {}),
    ...(targetSessionId ? { sessionId: targetSessionId } : {}),
    ...(params.context.sessionTargetsV1 ? { sessionTargetsV1: params.context.sessionTargetsV1 } : {}),
    ...(params.context.sessionListAccess !== undefined
      ? { sessionListAccess: params.context.sessionListAccess }
      : {}),
    ...(machineId ? { machineId } : {}),
    ...(runId ? { runId } : {}),
    ...(normalizeId(params.context.runtimeRunOccurrenceId)
      ? { runOccurrenceId: normalizeId(params.context.runtimeRunOccurrenceId) }
      : {}),
    ...(callerPermissionMode !== undefined ? { callerPermissionMode } : {}),
    ...(spawnPolicy?.success ? { sessionAgentSpawnPolicyV1: spawnPolicy.data } : {}),
    ...(params.context.causalPermissionAuthority !== undefined
      ? { causalPermissionAuthority: params.context.causalPermissionAuthority }
      : {}),
    ...(params.context.sessionInputSource !== undefined
      ? { sessionInputSource: params.context.sessionInputSource }
      : {}),
    ...(params.context.discussionReplyReturn ? { discussionReplyReturn: params.context.discussionReplyReturn } : {}),
    ...(params.context.actionRequestAttributionV1 ? { actionRequestAttributionV1: params.context.actionRequestAttributionV1 } : {}),
    ...(externalTarget ? { target: externalTarget } : {}),
    actionId: params.actionId,
    requestId: normalizeId(params.context.actionRequestId) || normalizeId(inputRecord.creationKey),
  };
  const parsed = ApprovalExecutionOriginV1Schema.safeParse(candidate);
  if (!parsed.success || params.requesterConfirmation
    && !isApprovalRequesterConfirmationBoundToOriginV1(params.requesterConfirmation, parsed.data)) return null;
  return parsed.data;
}

export function resolveExplicitApprovalRequestingSessionId(
  rawOrigin: unknown,
  ctx: ActionExecutorContext,
  targetSessionId: string | null,
): string | null {
  const defaultSessionId = normalizeId(ctx.defaultSessionId);
  if (defaultSessionId) return defaultSessionId;

  const origin = resolveApprovalOriginForRequest(rawOrigin, null);
  const originSessionId = normalizeId(origin?.sessionId);
  if (originSessionId) return originSessionId;

  return targetSessionId;
}

export function isApprovalActionId(actionId: ActionId): boolean {
  return actionId === 'approval.request.list'
    || actionId === 'approval.request.get'
    || actionId === 'approval.request.create'
    || actionId === 'approval.request.decide';
}

export function isApprovalRequestActionReplayAdmitted(request: ApprovalRequest, context: ActionExecutorContext): boolean {
  if (!isInternalActionId(request.actionId)) return true;
  if (request.actionId !== 'session.presentation.apply' || request.v !== 2) return false;
  const origin = request.executionOriginV1;
  // This reversible current-Session UI operation can be configured Ask-first.
  // Its own host UI must settle the sealed request; this does not make any
  // internal Action callable by an external principal or a daemon replay.
  return origin.actionId === request.actionId
    && origin.surface === 'ui'
    && origin.authority === 'present_user'
    && origin.caller.kind === 'host'
    && Boolean(origin.sessionId)
    && origin.principalId === undefined
    && origin.credentialId === undefined
    && origin.externalActionExecutionAuthorization === undefined
    && origin.externalActionInputSignature === undefined
    && context.surface === 'ui'
    && context.authority === 'present_user'
    && (context.actionCaller === undefined || context.actionCaller.kind === 'host')
    && context.externalActionCredential === undefined
    && context.externalActionExecutionAuthorization === undefined
    && context.rpcSessionAuthorization === undefined;
}

export function isBlockingApprovalRequest(request: ApprovalRequest): boolean {
  return request.approval?.flow === 'blocking';
}

export function isPresentUserApprovalDecisionForOrigin(input: Readonly<{
  context: ActionExecutorContext;
  artifactId: string;
  origin: ApprovalExecutionOriginV1;
}>): boolean {
  const { context, artifactId, origin } = input;
  if (isPresentUserHostInvocation(context)) return true;
  const binding = context.externalActionExecutionAuthorization?.binding;
  return context.authority === 'present_user'
    && (context.surface === 'ui' || context.surface === 'cli' || context.surface === 'voice')
    && context.actionCaller?.kind === 'host' && !context.externalActionCredential && !context.rpcSessionAuthorization
    && binding !== undefined && 'authentication' in binding && binding.authentication.kind === 'account'
    && binding.actionId === 'approval.request.decide'
    && binding.approvalDecisionAdmission?.artifactId === artifactId && binding.approvalDecisionAdmission.decision === 'approve'
    && binding.accountId === origin.accountId && binding.serverIdentityId === origin.serverIdentityId
    && binding.machineId === origin.machineId;
}
