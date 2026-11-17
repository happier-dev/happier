import { isMachineManagedInstallationActionIdV1 } from '@happier-dev/protocol/actions/specs/machineConnectionActionIdsV1';
import { createCliManagedInstallationRespond } from '@/machines/managed/installationResponse';
import { BotTemplateInstantiateInputV1Schema, projectBotTemplateInstantiationRequesterInputV1 } from '@happier-dev/protocol/bots/templates/botTemplateActionsV1';
import { readDeploymentReadReceiverMachineId } from '@/deployments/deploymentReadReceiver';
import { createSessionFollowActionDeps, createSessionTrackedTargetCompatibilityDep } from '@/api/sessionFollowActionDeps';
import { measureActionStartPhaseV1 } from '@happier-dev/protocol/actions/executor/agentStartAdmission';
import { randomUUID } from 'node:crypto';
import { createOriginDaemonApprovalOutcomePublisher } from './approvals/publishOutcome';
import { timeApprovalPhase, withApprovalActionTrace } from '@/daemon/externalActions/webLatencyTrace';
import { createSessionReadStateActionDeps } from '@/api/sessionReadStateActionDeps';
import {
  DEFAULT_SESSION_TRANSCRIPT_FOLLOW_LEASE_IDLE_TTL_MS,
  createSessionTranscriptFollowLeaseRegistry,
  type SessionTranscriptFollowLeaseRegistry,
} from '@/api/session/followSessionTranscript';
import type { SessionTranscriptActionItem } from '@/api/session/sessionTranscriptActionInput';
import { createAccountServerActionDeps } from '@/api/accountServerActionDeps';
import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import { createCliDeploymentActionDeps } from '@/deployments/createCliDeploymentActionDeps';
import { DeploymentEnvironmentGetResultV1Schema, DeploymentEnvironmentCreateIntentInputV1Schema, resolveDeploymentPreviewExecutionMachineIdV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { DEPLOYMENT_ENVIRONMENT_CREATE_ACTION_ID_V1, DEPLOYMENT_ENVIRONMENT_MOVE_TO_REPOSITORY_ACTION_ID_V1, DEPLOYMENT_TEMPLATE_INSTANTIATE_ACTION_ID_V1, isDeploymentReceiptObservationActionIdV1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import { DeploymentMoveToRepositoryInputV1Schema, resolveDeploymentMoveToRepositoryExecutionMachineIdV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { DeploymentTemplateInstantiateInputV1Schema, resolveDeploymentTemplateExecutionMachineIdV1 } from '@happier-dev/protocol/deployments/deploymentTemplateInstantiationV1';
import { resolveCurrentAccountAdministrationMachine, resolveCurrentAccountMachineTarget } from '@/api/machine/resolveCurrentAccountMachineTarget';
import { configuration } from '@/configuration';
import { isServerProfileHomeIdentity, resolveServerProfileHomeIdentityId } from '@/server/serverProfiles';
import { getDaemonMachineAdmissionTransport, getDaemonClientActionExecutor, getDaemonConfidentialSecretFillExecutor, getDaemonConfidentialActionInputsExecutor, MachineAdmissionTransportUnavailableError } from '@/daemon/machineAdmissionTransport';
import { resolveCliApiTokenForSdk } from '@/auth/cliApiToken';
import {
  normalizeServerHttpBaseUrl,
  runWithServerHttpBaseUrl,
} from '@/api/client/serverHttpBaseUrl';
import {
  hasStoredSessionCredentialProvenance,
  readSettings,
  readStoredCredentialsForServerId,
  type StoredCredentials,
} from '@/persistence';
import {
  isFullSessionId,
  resolveSessionIdOrPrefixFromSessionList,
  type SessionSelectorListPage,
} from '@/session/query/resolveSessionId';
import {
  resolveSessionEncryptionContextFromCredentials,
  tryDecryptSessionOwnerMetadataView,
  type SessionTransportEncryptionMaterial,
} from '@/session/transport/encryption/sessionEncryptionContext';
import { resolveSessionTransportContext } from '@/session/services/resolveSessionTransportContext';
import { resolveCliActionCallerWorkflowTarget } from './resolveCliActionCallerSession';
import { requiresMachineAdmissionForSessionInput, resolveSessionInputTargetMachineId, resolveProtectedSessionInputActionTarget } from '@/session/services/sessionInputAdmissionIdentity';
export { resolveProtectedSessionInputActionTarget } from '@/session/services/sessionInputAdmissionIdentity';
import { buildTrustedHostSessionInputAdmissionV1 } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { createSessionFollowSourceKeyPreparationAfterSet } from '@/agent/runtime/session/follow/createSessionFollowSourceKeyPreparationAfterSet';
import type { FilesystemAccessPolicy } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemAccessPolicy';
import { getActionSpec, hasDeclaredActionDaemonIngress, resolveActionExecutionPlacementForInput, PublicActionIdSchema, SignedRootActionIdSchema, projectSessionSpawnNewApiRequest } from '@happier-dev/protocol/actions/actionSpecs';
import { bindCallerInput } from '@happier-dev/protocol/actions/actionExecutor';
import { normalizeActionExecutorThrownError } from '@happier-dev/protocol/actions/executor/resultProjection';
import { parseActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { readActionOutputDiagnostic } from '@happier-dev/protocol/actions/executor/actionFailureDiagnostic';
import { ManagedMachineControllerError } from '@/machines/managed/controllerErrors';
import { isPluginActionExecutionDispatchId, type PluginActionExecutionRequestOwner } from './createDaemonPluginActionExecutor';
import { parseQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import { withExecutionRunStartFailureDetails } from '@happier-dev/protocol/execution/runs/responseSchemas';
import { ActionIdSchema, isLocalServiceStopActionIdV1 } from '@happier-dev/protocol/actions/actionIds';
import { isSettingsDeclarationActionIdV1, SettingsDeclarationActionInputSchemasV1 } from '@happier-dev/protocol/actions/settingsDeclarationActionFamily';
import { deploymentPreparationOperationForActionV1 } from '@happier-dev/protocol/deployments/deploymentPreparationAdmissionV1';
import { enrichCliActionApprovalContext } from './enrichCliActionApprovalContext';
import { createCliApprovalsArtifactStore } from './approvals/artifactStore';
import { replayLiveCliApprovalOrigin } from './approvals/replayLiveOrigin';
import { readPluginInstallApprovalPendingReview } from '@happier-dev/protocol/actions/actionApprovalPresentation';
import { selectApprovalReplayCredentials } from './approvals/replayCredentials';
import { createExecutionRunHostApprovalReplay } from './approvals/replayExecutionRunHost';
import { createTargetActionApprovalDecision } from '@happier-dev/protocol/actions/targetActionApprovalDecision';
import { TargetActionApprovalRequestV1Schema } from '@happier-dev/protocol/approvals/targetActionApprovalRequestV1';
import { normalizeServerIdentityIdCapability } from '@happier-dev/protocol/features/payload/capabilities/serverIdentityCapabilities';
import { resolveActionSessionListAccessFailure } from '@happier-dev/protocol/actions/executor/sessionListAccess';
import { readActionSessionTargetField, replaceActionSessionTargetField } from '@happier-dev/protocol/actions/executor/sessionTargets';
import { normalizeSessionTargetV1 } from '@happier-dev/protocol/actions/sessionTargetV1';
import { SessionListResultSchema } from '@happier-dev/protocol/sessions/control/listResult';
import type { ApprovalExecutionOriginV1, ActionExecuteFailure, ActionExecuteResult, ActionExecutorContext, ActionExecutorDeps, RuntimeActionExecute, TargetActionApprovalRequestV1 } from '@happier-dev/protocol';
import type { RpcActionExecutorContext } from '@/rpc/handlers/_actionDispatchAdapter';
import type {
  ActionTarget,
  PublicActionInputById,
} from '@happier-dev/sdk';
import type { sendSessionMessage } from '@/session/services/sendSessionMessage';
import type {
  ExternalSessionPluginAdmissionOwner,
} from './externalSessions/pluginExternalSessionAdmissionOwner';
import type {
  ResolveAutomationEventAdoptedDefinitionSetV1,
} from '@/plugins/runtime/automations/automationEventActionExecutor';
import type {
  RevalidatePluginActionCallerOccurrence,
  RevalidatePluginActionCallerMaterialization,
} from '@/plugins/runtime/invocation/services/actionCaller';
import type { ComposerAttachmentSendPreparationRegistryV1 } from '@/session/composer/prepareComposerAttachmentDraftsForSendV1';
import type {
  createCliActionDeps,
  CliActionExactHomeTarget,
  MachineActionDirectTargetTransport,
  SessionActionRpcTransport,
  SessionSpawnDirectTargetTransport,
} from './createCliActionDeps';
import { createCliActionExecutor } from './createCliActionExecutor';
import { createCliTeamCredentialUsageExportAction } from './teamCredentialUsageExportAction';
import { isControllerDeploymentMutationAction } from './createCliActionDeps';
import { consumeDeferredCliApprovalResult, isUnpreservableOriginalCliApproval, type RecordedApprovalExecutionObservationArgs } from './createCliActionExecutorHarness';
import { executeLiveCliApprovalRequest } from './approvals/deferredResult';
import { executeOriginalAccountCliApprovalRequest } from './approvals/originalAccountRequest';
import { readControllerDeploymentDispatch } from './controllerDeploymentDispatch';
import { createCredentialedWorkflowActionAdmissionReader } from '@/daemon/workflows/workflowActionAdmission';
import { readWorkflowActionPolicyContext } from '@/daemon/workflows/workflowActionContext';
import { readRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionContext';
import { resolveActionOriginationPreferenceFailureV1 } from '@happier-dev/protocol/actions/executor/actionOriginationPreferences';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { resolveFilesystemTransferCustodyFailure } from './filesystemTransferCustody';
import { ensureCliActionPolicySettings } from './ensureCliActionPolicySettings';
import { reconcileExternalActionTarget, requiresManagedMachineDaemonIngress, resolveManagedControlControllerTarget, resolveExternalActionMachineTarget, resolveSelectedExternalActionMachineTarget } from '@/daemon/externalActions/reconcileExternalActionTarget';
import { dispatchLocalManagedMachineSetup, dispatchLocalManagedMachineSetupPlan, dispatchOriginalAccountAction, prepareOriginalAccountPresetAcquire, readExternalActionRequesterInvocation, requiresOriginalAccountMachineActionProof, resolveExternalActionServerRequestHeaders, type ExternalActionMachineRequestSigningKey } from '@/api/externalActionExecutionAuthorization';
import { observeManagedChildApprovalExecution } from '@/api/managedChildApproval';
import { MachineSetupApplyInputV1Schema, MachineSetupPlanInputV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { isMachineSetupPlanOrApplyActionIdV1, MACHINE_SETUP_APPLY_ACTION_ID_V1 } from '@happier-dev/protocol/machines/managed/actionIdsV1';
import { isHostAdmittedReviewedChildPolicyV1, readHostReviewedChildOperationV1 } from '@happier-dev/protocol/actions/actionExecutor';
import {
  fetchServerFeaturesSnapshot,
  type CliServerFeaturesSnapshot,
} from '@/features/serverFeaturesClient';
import type { RuntimeActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { isSessionBoardActionIdV1 } from '@happier-dev/protocol/sessions/board/actionIds';
import { ProjectServiceRelocateInputV1Schema } from '@happier-dev/protocol/workspaces/projectServiceRelocationV1';
import { DeploymentPrepareInputV1Schema } from '@happier-dev/protocol/deployments/deploymentPreparationV1';
import { LOCAL_SERVICE_CONTROL_ACTION_RPC_METHODS, readLocalServiceControlActionRequest } from '@happier-dev/protocol/actions/specs/localServices';
import { PROJECT_FINITE_ACTION_RPC_METHODS_V1 } from '@happier-dev/protocol/actions/projectActionFamily';
import { readAuthTokenProvenance } from '@happier-dev/protocol/auth/authToken';
import { decodeJwtPayload, readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { readProjectAccountRows } from '@/workspaces/projectAccountRows';
import { resolveWorkspaceRefById } from '@/workspaces/workspaceRefsV1';
import { FilesystemPreparedCopyInputSchema, FilesystemTargetCopyInputSchema, FilesystemUploadOutputSchema } from '@happier-dev/protocol/actions/filesystemActionFamily';
import { ActionApprovalRequestCreatedResultSchema, ActionExecuteFailureSchema,
  type ActionApprovalRequestCreatedResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { resolveActionApprovalFlow } from '@happier-dev/protocol/actions/actionSpecs';
import { resolveActionApprovalRouting } from '@happier-dev/protocol/actions/actionApprovalPolicy';
import { isActionEnabledByActionsSettings } from '@happier-dev/protocol/actions/actionSettings';
import { resolveInvocationAuthority } from '@happier-dev/protocol/actions/invocationAuthority';
import { projectExternalActionRequesterInvocationV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { createTargetedActionRpcRequestV1 } from '@happier-dev/protocol/actions/actionRpcTransport';
import { callExactMachineRpc, readMachineRpcRequestDisposition } from '@/session/transport/rpc/machineRpc';
import { callSessionRpc } from '@/session/transport/rpc/sessionRpc';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import type { createCredentialedFilesystemTransferClient } from '@/machines/transfer/createCredentialedFilesystemTransferClient';
import type { createPreparedFilesystemTransferClient } from '@/machines/transfer/preparedFilesystemTransferClient';
import { resolveActionCliCredentialTarget } from '@/cli/actions/actionServerTarget';
import { assertDeploymentArchiveChildCurrentForHost, assertReviewedDeploymentArchiveSourceForHost } from '@/api/deploymentChildExecutionAuthorization';
import { projectDeploymentFailure } from '@/deployments/deploymentFailure';
import { executeActionOperationActionV1 } from '@happier-dev/protocol/actions/executor/actionOperationActions';
import { ActionOperationActionInputSchemasV1 } from '@happier-dev/protocol/actions/specs/actionOperations';
import { getServerProfile } from '@/server/serverProfiles';
import { areServerProfileIdentifiersEquivalent } from '@happier-dev/protocol/features/payload/capabilities/serverIdentityCapabilities';
import { readSessionMemoryEnabledV1 } from '@happier-dev/protocol/sessions/context/sessionContextV1';
import type { dispatchRequesterSessionSpawnNewRpc } from '@/session/transport/rpc/machineRpc';
import { SessionSpawnNewActionInputV2Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { getActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshotLifetimeToken } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createInvocationSavedSecretOperationContextV1 } from "@/settings/secrets/savedSecretOperationContext";
import { createCliPersonalSavedSecretActionExecute } from '@/settings/secrets/personalSavedSecretActionHost';
import { readApprovalRequesterDecisionV1, readLiveCliApprovalOriginScope, resolveApprovalExecutor, type ApprovalRequestV2, type StoredApprovalRequestV2 } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { isApprovalDecisionReviewerBindingV1 } from '@happier-dev/protocol/actions/externalActionBindingAuthority';
import { isMachineTerminalActionId } from '@happier-dev/protocol/actions/specs/machineTerminal';
import { createHostApprovalOriginCurrentness } from './approvals/hostOriginCurrentness';
import { runTracedExternalActionStage, runTracedExternalActionInnerStage } from '@/daemon/externalActions/externalActionPhase';
import { rethrowRequesterHomeReadFailure } from "@/daemon/sessionEncryption/requesterCurrentness";

type CliActionExecutor = ReturnType<typeof createCliActionExecutor>;

type PatActionTransportPlan =
  | Readonly<{ kind: 'ready'; input: unknown; target?: ActionTarget }>
  | Readonly<{ kind: 'settled'; result: ActionExecuteResult }>;
type PatReadyActionTransportPlan = Extract<PatActionTransportPlan, Readonly<{ kind: 'ready' }>>;

type CliActionSessionTarget =
  | Readonly<{ ok: true; sessionId: string }>
  | Readonly<{ ok: false; code: string; candidates?: readonly string[] }>;
type CliActionMachineTarget =
  | Readonly<{ ok: true; machineId: string }>
  | Readonly<{ ok: false; code: string; candidates?: readonly string[]; details?: Readonly<Record<string, unknown>> }>;

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized ? normalized : null;
}

function isOriginalCliActionContext(context: ActionExecutorContext): boolean {
  return (context.surface === undefined || context.surface === 'cli')
    && (!context.actionCaller || context.actionCaller.kind === 'host')
    && !context.externalActionCredential && !context.externalActionExecutionAuthorization
    && !context.rpcSessionAuthorization && !context.causalPermissionAuthority;
}

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function readPatSessionListPage(value: unknown): SessionSelectorListPage {
  const parsed = SessionListResultSchema.safeParse(value);
  if (!parsed.success) throw new Error('invalid_session_list_result');
  return {
    sessions: parsed.data.sessions.map((session) => ({
      id: session.id,
      ...(session.tag ? { tag: session.tag } : {}),
    })),
    nextCursor: parsed.data.nextCursor ?? null,
    hasNext: parsed.data.hasNext === true,
  };
}

function actionResolutionFailure(params: Readonly<{
  code: string;
  candidates?: readonly string[];
  details?: Readonly<Record<string, unknown>>;
}>): ActionExecuteResult {
  return {
    ok: false,
    errorCode: params.code,
    error: params.code,
    ...(params.details || params.candidates && params.candidates.length > 0
      ? { details: { ...params.details, ...(params.candidates?.length ? { candidates: params.candidates } : {}) } }
      : {}),
  };
}

function actionFailure(errorCode: string): ActionExecuteFailure {
  return { ok: false, errorCode, error: errorCode };
}

function withExactSessionId(input: unknown, sessionId: string): unknown {
  const record = readRecord(input);
  return record ? { ...record, sessionId } : input;
}

async function resolveConfiguredMachineTarget(): Promise<ActionTarget | null> {
  const settings = await readSettings();
  const machineId = readNonEmptyString(settings.machineId);
  return machineId ? { kind: 'machine', machineId } : null;
}

async function resolveDaemonLocalActionMachineId(serverApiUrl: string): Promise<string | null> {
  const { resolveLiveDaemonExternalActionEndpoint } = await import('@/daemon/multiDaemon');
  const endpoint = await resolveLiveDaemonExternalActionEndpoint(serverApiUrl);
  return endpoint?.machineId ?? null;
}

function encryptedDaemonTarget(credentials: StoredCredentials, machineId: string): ActionTarget | undefined {
  // V2 authenticates an explicit target. The existing live-daemon publication
  // supplies it; bearer-only V1 keeps its implicit local placement contract.
  return resolveCliApiTokenForSdk(credentials.token) !== credentials.token
    ? { kind: 'machine', machineId }
    : undefined;
}

async function resolvePatMachineTarget(params: Readonly<{
  credentials: StoredCredentials;
  requestedMachineId?: string;
  signal?: AbortSignal;
  serverApiUrl: string;
  allowConfiguredMachineTarget: boolean;
}>): Promise<CliActionMachineTarget> {
  const daemonLocalMachineId = await resolveDaemonLocalActionMachineId(params.serverApiUrl);
  if (daemonLocalMachineId) {
    if (params.requestedMachineId !== undefined && params.requestedMachineId !== daemonLocalMachineId) {
      return { ok: false, code: 'target_unavailable' };
    }
    return { ok: true, machineId: daemonLocalMachineId };
  }

  if (params.allowConfiguredMachineTarget && params.requestedMachineId === undefined) {
    const configuredTarget = await resolveConfiguredMachineTarget();
    if (configuredTarget?.kind === 'machine') {
      return { ok: true, machineId: configuredTarget.machineId };
    }
  }

  const resolved = await resolveCurrentAccountMachineTarget({
    token: params.credentials.token,
    ...(params.requestedMachineId !== undefined ? { requestedMachineId: params.requestedMachineId } : {}),
    ...(!params.allowConfiguredMachineTarget ? { serverHttpBaseUrl: params.serverApiUrl } : {}),
    ...(params.signal ? { signal: params.signal } : {}),
  });
  if (resolved.kind === 'selected') return { ok: true, machineId: resolved.target.machineId };
  if (resolved.kind === 'selection_required') {
    return { ok: false, code: 'machine_selection_required', candidates: resolved.candidates.map(({ machineId }) => machineId) };
  }
  return { ok: false, code: resolved.code, ...(resolved.details ? { details: resolved.details } : {}) };
}

async function resolvePatSessionTarget(params: Readonly<{
  credentials: StoredCredentials;
  idOrPrefix: string;
  machineId?: string;
  signal?: AbortSignal;
  serverApiUrl: string;
  allowConfiguredMachineTarget: boolean;
}>): Promise<CliActionSessionTarget> {
  if (isFullSessionId(params.idOrPrefix)) {
    return { ok: true, sessionId: params.idOrPrefix };
  }
  const daemonLocalMachineId = await resolveDaemonLocalActionMachineId(params.serverApiUrl);
  if (daemonLocalMachineId && params.machineId !== undefined && params.machineId !== daemonLocalMachineId) {
    return { ok: false, code: 'target_unavailable' };
  }
  const machineTarget = daemonLocalMachineId
    ? null
    : await resolvePatMachineTarget({
        credentials: params.credentials,
        ...(params.machineId !== undefined ? { requestedMachineId: params.machineId } : {}),
        ...(params.signal ? { signal: params.signal } : {}),
        serverApiUrl: params.serverApiUrl,
        allowConfiguredMachineTarget: params.allowConfiguredMachineTarget,
      });
  if (machineTarget && !machineTarget.ok) return machineTarget;
  return await resolveSessionIdOrPrefixFromSessionList({
    idOrPrefix: params.idOrPrefix,
    ...(params.signal ? { signal: params.signal } : {}),
    listPage: async ({ limit, cursor, archivedOnly }) => {
      const { connect } = await import('@happier-dev/sdk');
      const client = connect({
        endpoint: params.serverApiUrl,
        token: resolveCliApiTokenForSdk(params.credentials.token),
      });
      try {
        const result = await client.actions.execute(
          'session.list',
          {
            limit,
            archivedOnly,
            ...(cursor ? { cursor } : {}),
          },
          {
            ...(machineTarget ? { target: { kind: 'machine', machineId: machineTarget.machineId } }
              : daemonLocalMachineId ? { target: encryptedDaemonTarget(params.credentials, daemonLocalMachineId) } : {}),
            ...(params.signal ? { signal: params.signal } : {}),
          },
        );
        return readPatSessionListPage(result);
      } finally {
        await client.close();
      }
    },
  });
}

function combineInvocationSignals(
  invocationSignal: AbortSignal | undefined,
  requestSignal: AbortSignal | undefined,
): AbortSignal | undefined {
  if (!invocationSignal) return requestSignal;
  if (!requestSignal || requestSignal === invocationSignal) return invocationSignal;
  return AbortSignal.any([invocationSignal, requestSignal]);
}

export async function resolveAccountWorkspaceMachine(params: Readonly<{
  credentials: StoredCredentials; workspace: Readonly<{ serverId: string; id: string }>; serverId: string; serverIdentityId?: string;
  serverApiUrl: string; signal?: AbortSignal;
}>): Promise<CliActionMachineTarget> {
  const workspaceServerId = params.serverIdentityId
    ?? await resolveServerProfileHomeIdentityId(params.serverId)
    ?? params.serverId;
  if (params.workspace.serverId !== params.serverIdentityId
    && !await isServerProfileHomeIdentity(params.serverId, params.workspace.serverId)) {
    return { ok: false, code: 'server_target_mismatch' };
  }
  try {
    const rows = await runWithServerHttpBaseUrl(params.serverApiUrl, async () => await readProjectAccountRows({
      credentials: params.credentials, serverId: workspaceServerId, ...(params.signal ? { signal: params.signal } : {}),
      selection: { key: { kind: 'workspace-ref', serverId: workspaceServerId, id: params.workspace.id } },
    }));
    const ref = resolveWorkspaceRefById(rows.workspaceRefs, params.workspace.id, workspaceServerId);
    return ref ? { ok: true, machineId: ref.machineId } : { ok: false, code: 'workspace_ref_unavailable' };
  } catch {
    return { ok: false, code: params.signal?.aborted ? 'cancelled' : 'workspace_ref_unavailable' };
  }
}

async function resolvePatActionTransportPlan(params: Readonly<{
  actionId: string;
  credentials: StoredCredentials;
  input: unknown;
  context: ActionExecutorContext | undefined;
  machineId?: string;
  invocationSignal?: AbortSignal;
  serverId: string;
  serverIdentityId?: string;
  serverApiUrl: string;
  allowConfiguredMachineTarget: boolean;
}>): Promise<PatActionTransportPlan> {
  const publicActionId = PublicActionIdSchema.safeParse(params.actionId);
  if (!publicActionId.success) {
    return { kind: 'settled', result: actionFailure('unsupported') };
  }

  const spec = getActionSpec(publicActionId.data);
  if (params.context?.surface === 'mcp') {
    // Preserve the originating MCP contract before the public API projection
    // changes the input shape. API admission and credential authority stay at Home.
    const bound = await bindCallerInput(spec, params.input, params.context);
    if (!bound.ok) return { kind: 'settled', result: bound };
    params = { ...params, input: bound.input };
  }
  const signal = combineInvocationSignals(params.invocationSignal, params.context?.signal);
  if (publicActionId.data === 'projects.service.relocate' || publicActionId.data === 'deployments.prepare') {
    const relocated = publicActionId.data === 'projects.service.relocate' ? ProjectServiceRelocateInputV1Schema.safeParse(params.input) : null;
    const prepared = publicActionId.data === 'deployments.prepare' ? DeploymentPrepareInputV1Schema.safeParse(params.input) : null;
    const workspace = relocated?.success ? { serverId: relocated.data.workspace.serverId, id: relocated.data.workspace.refId }
      : prepared?.success ? prepared.data.workspace : null;
    if (!workspace) return { kind: 'settled', result: actionFailure('invalid_parameters') };
    const source = await resolveAccountWorkspaceMachine({ ...params, workspace, ...(signal ? { signal } : {}) });
    if (!source.ok) return { kind: 'settled', result: actionResolutionFailure(source) };
    const capturedTarget = params.context?.externalActionTarget;
    if ((params.machineId !== undefined && params.machineId !== source.machineId)
      || (capturedTarget && (capturedTarget.kind !== 'machine' || capturedTarget.machineId !== source.machineId))) {
      return { kind: 'settled', result: actionFailure('target_unavailable') };
    }
    const local = await resolveDaemonLocalActionMachineId(params.serverApiUrl);
    if (local && local !== source.machineId) return { kind: 'settled', result: actionFailure('target_not_local') };
    return { kind: 'ready', input: params.input,
      target: capturedTarget ?? (local ? encryptedDaemonTarget(params.credentials, local)
        : { kind: 'machine', machineId: source.machineId }) };
  }
  if (Object.hasOwn(LOCAL_SERVICE_CONTROL_ACTION_RPC_METHODS, publicActionId.data)) {
    const request = readLocalServiceControlActionRequest(publicActionId.data, params.input);
    if (!request) return { kind: 'settled', result: actionFailure('invalid_parameters') };
    const machineId = request.target.machineId;
    const capturedTarget = params.context?.externalActionTarget;
    if ((params.machineId !== undefined && params.machineId !== machineId)
      || (capturedTarget && (capturedTarget.kind !== 'machine' || capturedTarget.machineId !== machineId))) {
      return { kind: 'settled', result: actionFailure('target_unavailable') };
    }
    const local = await resolveDaemonLocalActionMachineId(params.serverApiUrl);
    if (local && local !== machineId) return { kind: 'settled', result: actionFailure('target_unavailable') };
    if (local) {
      return { kind: 'ready', input: request,
        target: capturedTarget ?? encryptedDaemonTarget(params.credentials, local) };
    }
    const target = await resolvePatMachineTarget({
      credentials: params.credentials,
      requestedMachineId: machineId,
      ...(signal ? { signal } : {}),
      serverApiUrl: params.serverApiUrl,
      allowConfiguredMachineTarget: params.allowConfiguredMachineTarget,
    });
    if (!target.ok) return { kind: 'settled', result: actionResolutionFailure(target) };
    return { kind: 'ready', input: request,
      target: capturedTarget ?? { kind: 'machine', machineId: target.machineId } };
  }
  const workflowProjectTarget = publicActionId.data === 'workflow.run.start'
    && params.context?.externalActionTarget?.kind === 'machine'
    ? params.context.externalActionTarget.project
    : undefined;
  if (publicActionId.data === 'workflow.run.start' && !workflowProjectTarget) {
    return { kind: 'settled', result: actionFailure('target_required') };
  }
  const daemonLocalMachineId = await resolveDaemonLocalActionMachineId(params.serverApiUrl);
  if (daemonLocalMachineId && params.machineId !== undefined && params.machineId !== daemonLocalMachineId) {
    return { kind: 'settled', result: actionFailure('target_unavailable') };
  }
  if (publicActionId.data === 'session.spawn_new') {
    // The shared spawn projection retains canonical input for every caller.
    // API admission derives placement from the stamped envelope and Home.
    try {
      const projection = projectSessionSpawnNewApiRequest(params.input);
      return {
        kind: 'ready',
        input: projection.input,
        ...(daemonLocalMachineId
          ? { target: encryptedDaemonTarget(params.credentials, daemonLocalMachineId) }
          : { target: projection.target }),
      };
    } catch {
      return { kind: 'settled', result: actionFailure('invalid_parameters') };
    }
  }
  const inputSessionId = readNonEmptyString(readRecord(params.input)?.sessionId);
  let placementInput = params.input;
  if (spec.executionPlacementForInput) {
    const admittedInput = spec.inputSchema.safeParse(params.input);
    if (!admittedInput.success) return { kind: 'settled', result: actionFailure('invalid_parameters') };
    placementInput = admittedInput.data;
  }
  const executionPlacement = resolveActionExecutionPlacementForInput(spec, placementInput, params.context?.actionCaller, params.context?.surface ?? 'cli');
  const targetInput = readRecord(params.input);
  if (spec.sessionTarget && targetInput) {
    const rawTarget = readActionSessionTargetField(targetInput, spec.sessionTarget.field);
    if (rawTarget !== undefined && rawTarget !== null) {
      let target;
      try { target = normalizeSessionTargetV1(rawTarget); }
      catch { return { kind: 'settled', result: actionFailure('invalid_parameters') }; }
      if (typeof target !== 'string') {
        // Placement reaches the admitted daemon. Only the shared Action front
        // door enumerates the selector and freezes its approval/effect targets.
        const base = readNonEmptyString(params.context?.defaultSessionId);
        const input = !target.of && base
          ? replaceActionSessionTargetField(targetInput, spec.sessionTarget.field, { ...target, of: base })
          : params.input;
        if (daemonLocalMachineId) return { kind: 'ready', input,
          target: encryptedDaemonTarget(params.credentials, daemonLocalMachineId) };
        const machine = await resolvePatMachineTarget({ credentials: params.credentials,
          ...(params.machineId !== undefined ? { requestedMachineId: params.machineId } : {}),
          ...(signal ? { signal } : {}), serverApiUrl: params.serverApiUrl,
          allowConfiguredMachineTarget: params.allowConfiguredMachineTarget });
        if (!machine.ok) return { kind: 'settled', result: actionResolutionFailure(machine) };
        return { kind: 'ready', input, target: { kind: 'machine', machineId: machine.machineId } };
      }
    }
  }
  // The generic Session command resolves its positional selector before
  // invoking this adapter; first-class CLI and MCP Actions carry `sessionId`.
  // In each case the selector remains this adapter's only Session-target input
  // and is resolved to the immutable Session id before crossing the API seam.
  const requestedSessionId = executionPlacement === 'session'
    ? (spec.contextualDefaults?.sessionId === 'current_session'
      ? readNonEmptyString(params.context?.defaultSessionId)
      : null) ?? inputSessionId ?? readNonEmptyString(params.context?.defaultSessionId)
    : null;
  if (requestedSessionId) {
    const resolved = await resolvePatSessionTarget({
      credentials: params.credentials,
      idOrPrefix: requestedSessionId,
      ...(params.machineId !== undefined ? { machineId: params.machineId } : {}),
      ...(signal ? { signal } : {}),
      serverApiUrl: params.serverApiUrl,
      allowConfiguredMachineTarget: params.allowConfiguredMachineTarget,
    });
    if (!resolved.ok) {
      return {
        kind: 'settled',
        result: actionResolutionFailure({
          code: resolved.code,
          ...(resolved.candidates ? { candidates: resolved.candidates } : {}),
        }),
      };
    }
    return {
      kind: 'ready',
      // Board authorization is revalidated at its exact Session-owned effect
      // route. Local daemon delivery does not change that authority target.
      ...(isSessionBoardActionIdV1(publicActionId.data)
        ? { target: { kind: 'session' as const, sessionId: resolved.sessionId } }
        : daemonLocalMachineId
          ? { target: encryptedDaemonTarget(params.credentials, daemonLocalMachineId) }
          : params.machineId !== undefined
            ? { target: { kind: 'machine' as const, machineId: params.machineId } }
            : { target: { kind: 'session' as const, sessionId: resolved.sessionId } }),
      input: inputSessionId || spec.contextualDefaults?.sessionId === 'current_session'
        ? withExactSessionId(params.input, resolved.sessionId)
        : params.input,
    };
  }

  if (executionPlacement === 'session') {
    return { kind: 'settled', result: actionFailure('target_required') };
  }

  if (daemonLocalMachineId) {
    if (workflowProjectTarget && workflowProjectTarget.machineId !== daemonLocalMachineId) {
      return { kind: 'settled', result: actionFailure('target_unavailable') };
    }
    const target = encryptedDaemonTarget(params.credentials, daemonLocalMachineId);
    return {
      kind: 'ready',
      input: params.input,
      ...(target
        ? { target: { ...target, ...(workflowProjectTarget ? { project: workflowProjectTarget } : {}) } }
        : workflowProjectTarget
          ? { target: { kind: 'machine', machineId: daemonLocalMachineId, project: workflowProjectTarget } }
          : {}),
    };
  }

  const target = await resolvePatMachineTarget({
    credentials: params.credentials,
    ...(params.machineId !== undefined ? { requestedMachineId: params.machineId } : {}),
    ...(signal ? { signal } : {}),
    serverApiUrl: params.serverApiUrl,
    allowConfiguredMachineTarget: params.allowConfiguredMachineTarget,
  });
  if (!target.ok) return { kind: 'settled', result: actionResolutionFailure(target) };
  if (workflowProjectTarget && workflowProjectTarget.machineId !== target.machineId) {
    return { kind: 'settled', result: actionFailure('target_unavailable') };
  }
  return {
    kind: 'ready',
    target: { kind: 'machine', machineId: target.machineId, ...(workflowProjectTarget ? { project: workflowProjectTarget } : {}) },
    input: params.input,
  };
}

function createOneShotPatInvocation(runOnce: () => Promise<ActionExecuteResult>) {
  let resultPromise: Promise<ActionExecuteResult> | null = null;
  return Object.freeze({
    run: () => {
      resultPromise ??= Promise.resolve().then(runOnce);
      return resultPromise;
    },
  });
}

// Target selection is already settled in the resolved plan; this executor only
// dispatches it, so it never re-reads the configured-machine allowance.
async function executePatPublicActionPlan(params: Readonly<{
  actionId: string;
  credentials: StoredCredentials;
  plan: PatReadyActionTransportPlan;
  context: ActionExecutorContext | undefined;
  invocationSignal?: AbortSignal;
  serverApiUrl: string;
}>): Promise<ActionExecuteResult> {
  const publicActionId = PublicActionIdSchema.parse(params.actionId);
  const signal = combineInvocationSignals(params.invocationSignal, params.context?.signal);
  const { connect, HappierActionError } = await import('@happier-dev/sdk');
  const client = connect({ endpoint: params.serverApiUrl, token: resolveCliApiTokenForSdk(params.credentials.token) });
  try {
    // `createCliActionExecutor` accepts unknown because it is the canonical
    // Action owner. The daemon ingress validates the public input schema.
    const result = await client.actions.execute(
      publicActionId,
      params.plan.input as PublicActionInputById[typeof publicActionId],
      {
        ...(params.plan.target ? { target: params.plan.target } : {}),
        ...(params.context?.actionRequestId
          ? { requestId: params.context.actionRequestId }
          : {}),
        ...(signal ? { signal } : {}),
      },
    );
    return { ok: true, result };
  } catch (error) {
    if (error instanceof HappierActionError) {
      return parseActionExecuteFailure(error.cause) ?? {
        ok: false,
        errorCode: error.code,
        error: error.message,
        ...(error.requestId === undefined ? {} : { requestId: error.requestId }),
        ...(error.details === undefined ? {} : { details: error.details }),
      };
    }
    throw error;
  } finally {
    await client.close();
  }
}

async function executePatPublicAction(params: Readonly<{
  actionId: string;
  credentials: StoredCredentials;
  input: unknown;
  context: ActionExecutorContext | undefined;
  machineId?: string;
  invocationSignal?: AbortSignal;
  serverId: string;
  serverIdentityId?: string;
  serverApiUrl: string;
  allowConfiguredMachineTarget: boolean;
}>): Promise<ActionExecuteResult> {
  const plan = await resolvePatActionTransportPlan(params);
  if (plan.kind === 'settled') return plan.result;
  return await executePatPublicActionPlan({
    actionId: params.actionId,
    credentials: params.credentials,
    plan,
    context: params.context,
    ...(params.invocationSignal ? { invocationSignal: params.invocationSignal } : {}),
    serverApiUrl: params.serverApiUrl,
  });
}

/**
 * Whether an approved replay re-enters requester admission with a fresh
 * `approval.request.decide` root. The stored origin has no private
 * credentials, so the deciding requester supplies them; Workflow roots need
 * the same custody even on the requester's own controller. A retained plugin
 * review is delivered to its daemon instead, like the UI replay adapter.
 */
function readApprovalReplayDecisionAdmission(request: ApprovalRequestV2 | StoredApprovalRequestV2): 'fresh' | 'foreign_target_only' | null {
  if (request.actionId === 'plugins.install' && readPluginInstallApprovalPendingReview(request.preview) !== null) return null;
  // A stored Artifact carries the root as JSON; parse it once with its schema.
  const authorization = request.executionOriginV1.externalActionExecutionAuthorization;
  if (authorization === undefined) return 'foreign_target_only';
  const parsed = ExternalActionExecutionAuthorizationV1Schema.safeParse(authorization);
  if (!parsed.success) return null;
  const binding = parsed.data.binding;
  return 'authentication' in binding && (binding.accountId !== binding.custodianAccountId
    || binding.workflowActionOrigin && !binding.workflowActionOrigin.sessionLeaf
      && !binding.workflowActionOrigin.sessionAuthority) ? 'fresh' : null;
}

function shouldUsePatPublicActionTransport(
  credentials: StoredCredentials,
  _context: ActionExecutorContext | undefined,
): boolean {
  return credentials.credentialProvenance === 'api_token';
}

type CliActionFixedServerTarget =
  | Readonly<{ serverId?: undefined; serverApiUrl?: undefined }>
  | Readonly<{ serverId: string; serverApiUrl: string }>;

export type CliActionMachineAdmissionTransport = NonNullable<
  Parameters<typeof sendSessionMessage>[0]['machineAdmissionTransport']
>;

function createApprovalRoutingContext(
  params: Pick<Parameters<typeof createCliActionExecutionCoreFromCredentials>[0],
    'serverIdentityId' | 'machineId' | 'resolveServerFeaturesSnapshot'>,
  fixedServerId: string | null,
  approvalServerApiUrl: string,
) {
  const resolveServerFeaturesSnapshotForCredentials = async (
    credentials: StoredCredentials,
  ): Promise<CliServerFeaturesSnapshot | undefined> => params.resolveServerFeaturesSnapshot
    ? await params.resolveServerFeaturesSnapshot()
    : await fetchServerFeaturesSnapshot({
        serverUrl: approvalServerApiUrl,
        token: credentials.token,
      });
  const enrichApprovalRoutingContext = async (
    context: ActionExecutorContext | undefined,
    credentials: StoredCredentials,
  ): Promise<ActionExecutorContext> => enrichCliActionApprovalContext({
    context,
    serverIdentityId: params.serverIdentityId,
    machineId: params.machineId,
    fixedServerId,
    resolveServerFeaturesSnapshot: () => resolveServerFeaturesSnapshotForCredentials(credentials),
  });
  const resolveInvocationRoutingContext = async (context: ActionExecutorContext | undefined, credentials: StoredCredentials,
    actionId?: string) => {
    // Resolve dependency Home identity without caller fields, then reuse that
    // exact observation for context enrichment and factory binding. Nothing is
    // retained across invocations; caller-provided identity remains descriptive.
    // Ordinary original-host Account reads do not consume cryptographic Home
    // identity. Approval-origin construction owns that demand if policy asks.
    const deferHomeIdentity = actionId === 'account.security.get' && isOriginalCliActionContext(context ?? {});
    const runtimeContext = deferHomeIdentity
      ? await enrichCliActionApprovalContext({ serverIdentityId: params.serverIdentityId,
          machineId: params.machineId, fixedServerId, resolveServerFeaturesSnapshot: async () => undefined })
      : await enrichApprovalRoutingContext(undefined, credentials);
    return {
      serverIdentityId: runtimeContext.serverIdentityId,
      ...(deferHomeIdentity ? { prepareApprovalExecutionOriginContext: async () => ({
        serverIdentityId: runtimeContext.serverIdentityId
          ?? (await enrichApprovalRoutingContext(undefined, credentials)).serverIdentityId,
      }) } : {}),
      context: await enrichCliActionApprovalContext({
        context, serverIdentityId: runtimeContext.serverIdentityId,
        machineId: runtimeContext.defaultSessionMachineId, fixedServerId,
        resolveServerFeaturesSnapshot: async () => undefined,
      }),
    };
  };
  return { resolveServerFeaturesSnapshotForCredentials, enrichApprovalRoutingContext, resolveInvocationRoutingContext };
}

function createCliActionExecutionCoreFromCredentials(params: Readonly<{
  credentials: StoredCredentials;
  happyHomeDir?: Parameters<typeof createCliActionExecutor>[0]['happyHomeDir'];
  admittedAccountEncryptionMode?: Parameters<typeof createCliActionDeps>[0]['admittedAccountEncryptionMode'];
  connectedAccountAuthenticationHost?: Parameters<typeof createCliActionDeps>[0]['connectedAccountAuthenticationHost'];
  executeTeamCredentialBrokerAction?: Parameters<typeof createCliActionExecutor>[0]['executeTeamCredentialBrokerAction'];
  requesterSessionBootstrap?: Parameters<typeof createCliActionDeps>[0]['requesterSessionBootstrap'];
  savedSecretOperationContext?: Parameters<typeof createCliActionDeps>[0]['savedSecretOperationContext'];
  providerPreparedSavedSecret?: Parameters<typeof createCliActionDeps>[0]['providerPreparedSavedSecret'];
  projectModelsForAccount?: Parameters<typeof createCliActionDeps>[0]['projectModelsForAccount'];
  readProviderForAccount?: Parameters<typeof createCliActionDeps>[0]['readProviderForAccount'];
  sessionMessageReplyPublisher?: Parameters<typeof createCliActionDeps>[0]['sessionMessageReplyPublisher'];
  postAgentDiscussionMessage?: Parameters<typeof createCliActionDeps>[0]['postAgentDiscussionMessage'];
  postWorkflowDiscussionMessage?: Parameters<typeof createCliActionDeps>[0]['postWorkflowDiscussionMessage'];
  workflowRequesterCustody?: Parameters<typeof createCliActionDeps>[0]['workflowRequesterCustody'];
  onRequesterSessionCredentialDisclosure?: Parameters<typeof dispatchRequesterSessionSpawnNewRpc>[0]['onRequesterSessionCredentialDisclosure'];
  scmFilesystemAccessPolicy?: FilesystemAccessPolicy;
  /** Receives the exact dispatch boundary for Home-owned HTTP Actions. */
  onAccountServerRequestIssued?: () => void;
  onApprovalRequested?: Parameters<typeof createCliActionExecutor>[0]['onApprovalRequested'];
  /**
   * Stored-content material this composition already holds for one exact
   * Session, for a host whose credentials carry no Account encryption material.
   */
  resolveExactSessionEncryptionMaterial?: (sessionId: string) => SessionTransportEncryptionMaterial | null;
  /** Credential-scoped canonical policy shared with pre-execution discovery. */
  actionsSettingsProvider?: RuntimeActionSettingsProvider;
  /** Exact admitted-turn depth supplied by the authenticated Session host. */
  getCurrentTurnWorkDepth?: Parameters<typeof createCliActionExecutor>[0]['getCurrentTurnWorkDepth'];
  resolvePluginNotifications?: Parameters<typeof createCliActionExecutor>[0]['resolvePluginNotifications'];
  readPluginVoiceProviders?: Parameters<typeof createCliActionExecutor>[0]['readPluginVoiceProviders'];
  /** Explicit CLI machine selector for public Action transport. */
  machineId?: string;
  readCredentials?: () => Promise<StoredCredentials | null>;
  resolveAutomationEventAdoptedDefinitionSet?: ResolveAutomationEventAdoptedDefinitionSetV1;
  resolveAuthenticatedAccountId?: (signal?: AbortSignal) => Promise<string>;
  acquireAutomationEventObservationRegistry?: Parameters<typeof createCliActionExecutor>[0]['acquireAutomationEventObservationRegistry'];
  revalidatePluginActionCallerMaterialization?: RevalidatePluginActionCallerMaterialization;
  revalidatePluginActionCallerOccurrence?: RevalidatePluginActionCallerOccurrence;
  runtimeActionExecute?: RuntimeActionExecute;
  prepareLocalServiceStartApproval?: ActionExecutorDeps['prepareLocalServiceStartApproval'];
  clientActionExecute?: ActionExecutorDeps['clientActionExecute'];
  confidentialSecretFill?: ActionExecutorDeps['confidentialSecretFill'];
  confidentialActionInputs?: ActionExecutorDeps['confidentialActionInputs'];
  workflowAction?: ActionExecutorDeps['workflowAction'];
  registerWorkflowTriggerList?: Parameters<typeof createCliActionDeps>[0]['registerWorkflowTriggerList'];
  managedMachineAction?: ActionExecutorDeps['managedMachineAction'];
  machinePresetPrepare?: ActionExecutorDeps['machinePresetPrepare'];
  acquireSessionIsolationSandbox?: Parameters<typeof createCliActionDeps>[0]['acquireSessionIsolationSandbox'];
  machineRecipesRead?: ActionExecutorDeps['machineRecipesRead'];
  machineSetupPlan?: ActionExecutorDeps['machineSetupPlan'];
  machineReachabilityAction?: ActionExecutorDeps['machineReachabilityAction'];
  sessionStop?: ActionExecutorDeps['sessionStop'];
  hostActionApprovalLifetime?: ActionExecutorDeps['hostActionApprovalLifetime'];
  runActionOperation?: ActionExecutorDeps['runActionOperation'];
  projectAction?: ActionExecutorDeps['projectAction'];
  deploymentAction?: ActionExecutorDeps['deploymentAction'];
  deploymentBackupAction?: ActionExecutorDeps['deploymentBackupAction'];
  deploymentRestore?: ActionExecutorDeps['deploymentRestore'];
  projectReadinessRead?: ActionExecutorDeps['projectReadinessRead'];
  deploymentTemplateInstantiate?: ActionExecutorDeps['deploymentTemplateInstantiate'];
  deploymentMoveToRepository?: ActionExecutorDeps['deploymentMoveToRepository'];
  prepareDeploymentTemplateInstantiation?: ActionExecutorDeps['prepareDeploymentTemplateInstantiation'];
  resolveEnvironmentApprovalScope?: ActionExecutorDeps['resolveEnvironmentApprovalScope'];
  prepareDeploymentAction?: ActionExecutorDeps['prepareDeploymentAction'];
  prepareDeploymentTeardown?: ActionExecutorDeps['prepareDeploymentTeardown'];
  prepareDeploymentEnvironmentCreate?: ActionExecutorDeps['prepareDeploymentEnvironmentCreate'];
  prepareHostReviewedChildren?: ActionExecutorDeps['prepareHostReviewedChildren'];
  readApprovedOperation?: ActionExecutorDeps['readApprovedOperation'];
  deploymentPrepare?: ActionExecutorDeps['deploymentPrepare'];
  machineGuardAction?: ActionExecutorDeps['machineGuardAction'];
  projectWorkerAction?: ActionExecutorDeps['projectWorkerAction'];
  projectDefinitionAction?: ActionExecutorDeps['projectDefinitionAction'];
  filesystemActionExecute?: ActionExecutorDeps['filesystemActionExecute'];
  workspaceFilesReplace?: ActionExecutorDeps['workspaceFilesReplace'];
  workspaceFilesReplacePreview?: ActionExecutorDeps['workspaceFilesReplacePreview'];
  languageIntelligenceApply?: ActionExecutorDeps['languageIntelligenceApply'];
  skillMachineActionExecute?: ActionExecutorDeps['skillMachineActionExecute'];
  workflowAcceptedAuthorizationCurrentness?: Parameters<typeof createCliActionExecutor>[0]['workflowAcceptedAuthorizationCurrentness'];
  sessionActionConfirmation?: ActionExecutorDeps['sessionActionConfirmation'];
  /** Current committed contributed Action declarations for catalog discovery. */
  listContributedActionDefinitions?: ActionExecutorDeps['listContributedActionDefinitions'];
  inputTypeDeps?: Pick<ActionExecutorDeps, 'resolveInputType' | 'readInputTypeResource'>;
  /** Daemon-owned execution bypasses its own authenticated control bridge. */
  pluginActionExecutionOwner?: 'daemon_control' | 'current_process';
  /** Credentialed capability receiver; not an Account grant or source selector. */
  accountPluginActions?: true;
  /** In-process daemon owner for plugin review/apply custody. */
  pluginChangeService?: Parameters<typeof createCliActionDeps>[0]['pluginChangeService'];
  /** Root `happier actions` is a signed client of the daemon External Action API. */
  externalActionClient?: true;
  externalSessionPluginAdmissionOwner?: ExternalSessionPluginAdmissionOwner;
  /** The committed plugin-runtime owner for the built-in `action.invoke` Action. */
  invokeContributedAction?: ActionExecutorDeps['invokeContributedAction'];
  /** Exact daemon replay for API target-action approvals. */
  targetActionApprovalReplay?: ActionExecutorDeps['targetActionApprovalReplay'];
  /** Current Account/Home/target proof for durable core Action replay. */
  isApprovalExecutionOriginCurrent?: ActionExecutorDeps['isApprovalExecutionOriginCurrent'];
  prepareApprovalExecutionAuthorization?: ActionExecutorDeps['prepareApprovalExecutionAuthorization'];
  bindApprovedApiTokenExecution?: (execute: NonNullable<ActionExecutorDeps['accountApiTokensCreateAction']>) =>
    NonNullable<ActionExecutorDeps['prepareApprovedApiTokenExecution']>;
  /** Canonical daemon Automation occurrence owner for durable replay. */
  isAutomationRunCurrent?: (caller: Extract<
    ApprovalExecutionOriginV1['caller'],
    Readonly<{ kind: 'automationRun' }>
  >) => Promise<boolean> | boolean;
  /** The exact daemon external-session RPC owner for host-stamped API requests. */
  hostExternalSessionAction?: ActionExecutorDeps['hostExternalSessionAction'];
  /** Canonical daemon-owned workspace conflict Action execution. */
  /** Exact daemon-owned Session spawn transport; never a generic peer forwarder. */
  sessionSpawnDirectTargetTransport?: SessionSpawnDirectTargetTransport;
  /** In-process transport to the current daemon's canonical machine Action handlers. */
  machineActionDirectTargetTransport?: MachineActionDirectTargetTransport;
  sessionActionRpcTransport?: SessionActionRpcTransport;
  machineAdmissionTransport?: CliActionMachineAdmissionTransport;
  /** Late-bound plugin-runtime Composer attachments for declared Session input. */
  resolveComposerAttachmentSendPreparation?: () => ComposerAttachmentSendPreparationRegistryV1 | null;
  sessionLogAccess?: Readonly<{
    workingDirectory: string;
    accessPolicy: FilesystemAccessPolicy;
    getAdditionalAllowedReadDirs?: () => ReadonlyArray<string>;
  }>;
  /**
   * Daemon composition injects its process-lifetime registry so finite Action
   * requests can release leases retained by earlier requests.
   */
  transcriptFollowLeaseRegistry?: SessionTranscriptFollowLeaseRegistry;
  /** Exact installation key used only for proof-bound external Action Home requests. */
  externalActionMachineRequestPrivateKey?: ExternalActionMachineRequestSigningKey;
  externalActionMachineInstallationId?: string;
  /** Cryptographic identity observed from this exact Home endpoint. */
  serverIdentityId?: string;
  /** Exact Action Home's existing feature snapshot source; never probes from a detail read. */
  resolveServerFeaturesSnapshot?: () =>
    | CliServerFeaturesSnapshot
    | undefined
    | Promise<CliServerFeaturesSnapshot | undefined>;
}> & CliActionFixedServerTarget): ReturnType<typeof createCliActionExecutor> & Readonly<{
  bindInvocation(signal: AbortSignal, approvalLifetime?: ActionExecutorDeps['hostActionApprovalLifetime']): ReturnType<typeof createCliActionExecutor>;
  resolveSessionTarget(idOrPrefix: string): Promise<CliActionSessionTarget>;
  resolveMachineTarget(): Promise<CliActionMachineTarget>;
}> {
  if (
    (params.serverId === undefined) !== (params.serverApiUrl === undefined)
    || (params.serverId !== undefined && params.serverId.trim().length === 0)
    || (params.serverApiUrl !== undefined && params.serverApiUrl.trim().length === 0)
  ) {
    throw new Error('fixed_action_server_target_incomplete');
  }
  // The guard above already proved both halves travel together; keeping them as
  // one value is what lets the pair reach each Home-bound dependency owner intact.
  const fixedHome: CliActionExactHomeTarget =
    params.serverId !== undefined && params.serverApiUrl !== undefined
      ? {
          serverId: params.serverId.trim(),
          serverHttpBaseUrl: normalizeServerHttpBaseUrl(params.serverApiUrl),
        }
      : {};
  const fixedServerId = fixedHome.serverId ?? null;
  const fixedServerApiUrl = fixedHome.serverHttpBaseUrl ?? null;
  const approvalServerId = fixedServerId ?? configuration.activeServerId;
  const daemonMachineAdmissionTransport = getDaemonMachineAdmissionTransport(approvalServerId);
  if (configuration.isDaemonProcess && !daemonMachineAdmissionTransport) {
    throw new MachineAdmissionTransportUnavailableError();
  }
  const machineAdmissionTransport = daemonMachineAdmissionTransport ?? params.machineAdmissionTransport;
  const approvalServerApiUrl = fixedServerApiUrl ?? resolveServerHttpBaseUrl();
  const resolveActionServerApiUrl = (): string => fixedServerApiUrl ?? resolveServerHttpBaseUrl();
  const runWithActionServer = <T>(run: () => T): T => fixedServerApiUrl
    ? runWithServerHttpBaseUrl(fixedServerApiUrl, run)
    : run();
  const { resolveServerFeaturesSnapshotForCredentials, enrichApprovalRoutingContext, resolveInvocationRoutingContext } =
    createApprovalRoutingContext(params, fixedServerId, approvalServerApiUrl);
  const bindExecutorToActionServer = (source: CliActionExecutor): CliActionExecutor => ({
    observeRecordedApprovalExecution: async args => await runWithActionServer(() => source.observeRecordedApprovalExecution(args)),
    prepare: async (...args) => {
      const prepared = await runWithActionServer(async () => await source.prepare(...args));
      if (prepared.kind !== 'ready') return prepared;
      const invocation = prepared.invocation;
      return {
        ...prepared,
        invocation: {
          ...invocation,
          run: () => runWithActionServer(() => invocation.run()),
        },
      };
    },
    execute: async (...args) => await runWithActionServer(async () => await source.execute(...args)),
    continueConfidentialApprovalRequest: async (...args) => await runWithActionServer(
      async () => await source.continueConfidentialApprovalRequest(...args),
    ),
    replayApprovedApprovalRequest: async (...args) => await runWithActionServer(
      async () => await source.replayApprovedApprovalRequest(...args),
    ),
  });
  const createFollowLeaseRegistry = (): SessionTranscriptFollowLeaseRegistry => (
    params.transcriptFollowLeaseRegistry
    ?? createSessionTranscriptFollowLeaseRegistry({
      idleTtlMs: DEFAULT_SESSION_TRANSCRIPT_FOLLOW_LEASE_IDLE_TTL_MS,
    })
  );
  const readCurrentCredentials = async (): Promise<StoredCredentials | null> => params.readCredentials
    ? await params.readCredentials().catch(error => { rethrowRequesterHomeReadFailure(error); return null; })
    : params.credentials;
  const readApprovalReplayCredentials = async (expectedAccountId?: string) => selectApprovalReplayCredentials(
    params.credentials, await readCurrentCredentials(), expectedAccountId);
  const createExecutor = (
    credentials: StoredCredentials,
    invocationSignal: AbortSignal | undefined,
    transcriptFollowLeaseRegistry: ReturnType<typeof createFollowLeaseRegistry>,
    sessionMemoryEnabled?: boolean,
    serverIdentityId = params.serverIdentityId,
    readAdmittedInputTypeOptions?: ActionExecutorDeps['readAdmittedInputTypeOptions'],
    approvalLifetime?: ActionExecutorDeps['hostActionApprovalLifetime'],
    routeHostChildAction?: ActionExecutorDeps['routeHostChildAction'],
    prepareApprovalExecutionOriginContext?: ActionExecutorDeps['prepareApprovalExecutionOriginContext'],
  ): ReturnType<typeof createCliActionExecutor> => {
    const resolveServerFeaturesSnapshot = params.resolveServerFeaturesSnapshot
      ?? (async () => await resolveServerFeaturesSnapshotForCredentials(credentials));
    const ctx = resolveSessionEncryptionContextFromCredentials(credentials);
    const cryptoContext = ctx
      ? { mode: 'e2ee' as const, ctx }
      : { mode: 'plain' as const, ctx: null };
    const snapshot = getActiveAccountSettingsSnapshot();
    const snapshotLifetime = getActiveAccountSettingsSnapshotLifetimeToken();
    // Ordinary invocation bootstrap already admitted this exact Account. Its
    // material readers must use the factory's credentials, not ambient disk.
    // Explicit daemon custody and the admitted Session bootstrap retain their
    // own holder; an ambient Account snapshot cannot replace either one.
    const savedSecretOperationContext = params.savedSecretOperationContext
      ?? params.requesterSessionBootstrap?.savedSecretOperationContext
      ?? (snapshot?.scopeKey === resolveAccountSettingsScopeKeyForToken(credentials.token)
        ? createInvocationSavedSecretOperationContextV1({ credentials, snapshot, serverHttpBaseUrl: approvalServerApiUrl,
            isCurrent: async () => getActiveAccountSettingsSnapshotLifetimeToken() === snapshotLifetime
              && getActiveAccountSettingsSnapshot()?.scopeKey === snapshot.scopeKey
              && !invocationSignal?.aborted })
        : undefined);

    const isApprovalExecutionOriginCurrent = createHostApprovalOriginCurrentness({
      credentials, serverId: approvalServerId, serverApiUrl: approvalServerApiUrl, resolveServerFeaturesSnapshot,
      checkDaemonOrigin: async args => {
        // A daemon's live-custody callback owns exact replay, not an Account proposal.
        if (params.isApprovalExecutionOriginCurrent) return await params.isApprovalExecutionOriginCurrent(args);
        // A standalone fixed-Home terminal approval already names its exact
        // Machine. Reconcile that signed request through the existing selector;
        // the currentness checker still verifies Home, Account and installation.
        const terminalTarget = isMachineTerminalActionId(args.request.actionId)
          ? resolveExternalActionMachineTarget({ actionId: args.request.actionId,
              rawInput: args.request.actionArgs, target: args.origin.target,
              context: { actionCaller: args.origin.caller, surface: args.origin.surface } }) : null;
        if (terminalTarget?.kind === 'rejected') return false;
        const currentMachineId = readNonEmptyString(params.machineId)
          ?? (terminalTarget?.kind === 'ready' ? terminalTarget.machineId : null)
          ?? (fixedServerId === null
            ? readNonEmptyString((await readSettings().catch(() => null))?.machineId)
            : null);
        if (!currentMachineId) return false;
        const { createDaemonApprovalExecutionOriginCurrentnessFromCredentials } = await import(
          '@/daemon/externalActions/daemonExternalActionTargetResolver'
        );
        const checker = createDaemonApprovalExecutionOriginCurrentnessFromCredentials({
          credentials,
          machineId: currentMachineId,
          serverId: approvalServerId,
          serverApiUrl: approvalServerApiUrl,
          resolveServerFeaturesSnapshot,
          ...(params.isAutomationRunCurrent ? { isAutomationRunCurrent: params.isAutomationRunCurrent } : {}),
        });
        return checker ? await checker(args) : false;
      },
    });

    const sessionFollowActionDeps = createSessionFollowActionDeps({
      token: credentials.token,
      credentials,
      ...fixedHome,
      ...(serverIdentityId ? { serverIdentityId } : {}),
      ...(params.externalActionMachineRequestPrivateKey
        ? { externalActionMachineRequestPrivateKey: params.externalActionMachineRequestPrivateKey }
        : {}),
      ...(params.externalActionMachineInstallationId
        ? { externalActionMachineInstallationId: params.externalActionMachineInstallationId }
        : {}),
      prepareSourceKeyAfterSet: createSessionFollowSourceKeyPreparationAfterSet({
        credentials,
        serverHttpBaseUrl: approvalServerApiUrl,
        ...(serverIdentityId ? { serverIdentityId } : {}),
        resolveServerFeaturesSnapshot,
        ...(params.externalActionMachineRequestPrivateKey
          ? { externalActionMachineRequestPrivateKey: params.externalActionMachineRequestPrivateKey }
          : {}),
        ...(params.externalActionMachineInstallationId
          ? { externalActionMachineInstallationId: params.externalActionMachineInstallationId }
          : {}),
      }),
    });
    const accountServerActionDeps = createAccountServerActionDeps({
      token: credentials.token,
      ...(params.onAccountServerRequestIssued ? { onRequestIssued: params.onAccountServerRequestIssued } : {}),
      credentials,
      ...fixedHome,
      ...(serverIdentityId ? { serverIdentityId } : {}),
      ...(params.externalActionMachineRequestPrivateKey
        ? { externalActionMachineRequestPrivateKey: params.externalActionMachineRequestPrivateKey } : {}),
      ...(params.externalActionMachineInstallationId
        ? { externalActionMachineInstallationId: params.externalActionMachineInstallationId } : {}),
      resolveServerFeaturesSnapshot,
    });
    const personalSavedSecretActionExecute = accountServerActionDeps.homeDomainAction
      ? createCliPersonalSavedSecretActionExecute({ credentials, home: accountServerActionDeps.homeDomainAction,
          operationContext: savedSecretOperationContext, serverHttpBaseUrl: approvalServerApiUrl,
          resolveNativeSecretSourceRuntime: async (contribution, signal) => {
            const { resolveExecutablePluginRuntimeRegistry } = await import('@/plugins/runtime/resolveExecutablePluginRuntimeRegistry');
            return await resolveExecutablePluginRuntimeRegistry({
              ...(params.happyHomeDir ? { happyHomeDir: params.happyHomeDir } : {}),
              ...(signal ? { signal } : {}),
              pluginIds: [contribution.pluginId],
              scopedActionRuntime: { credentials,
                actionsSettingsProvider: params.actionsSettingsProvider ?? createActionSettingsProvider({
                  scopeKey: resolveAccountSettingsScopeKeyForToken(credentials.token),
                }),
                ...(savedSecretOperationContext ? { savedSecretOperationContext } : {}) },
            });
          } }) : undefined;
    const teamCredentialUsageExport = accountServerActionDeps.homeDomainAction
      ? createCliTeamCredentialUsageExportAction({
          credentials,
          homeDomainAction: accountServerActionDeps.homeDomainAction,
        })
      : undefined;
    return createCliActionExecutor({
      ...cryptoContext,
      ...(params.onApprovalRequested ? { onApprovalRequested: params.onApprovalRequested } : {}),
      ...(params.happyHomeDir ? { happyHomeDir: params.happyHomeDir } : {}),
      ...(personalSavedSecretActionExecute ? { personalSavedSecretActionExecute } : {}),
      ...(params.admittedAccountEncryptionMode !== undefined
        ? { admittedAccountEncryptionMode: params.admittedAccountEncryptionMode } : {}),
      ...(params.connectedAccountAuthenticationHost ? { connectedAccountAuthenticationHost: params.connectedAccountAuthenticationHost } : {}),
      ...(params.executeTeamCredentialBrokerAction ? { executeTeamCredentialBrokerAction: params.executeTeamCredentialBrokerAction } : {}),
      ...(routeHostChildAction ? { routeHostChildAction } : {}),
      ...(readAdmittedInputTypeOptions ? { readAdmittedInputTypeOptions } : {}),
      ...(sessionMemoryEnabled !== undefined ? { sessionMemoryEnabled } : {}),
      ...(teamCredentialUsageExport ? { teamCredentialUsageExport } : {}),
      ...(params.externalActionClient ? { machineManagedInstallationRespond: createCliManagedInstallationRespond({
        credentials, serverId: approvalServerId, serverIdentityId, serverUrl: approvalServerApiUrl,
      }) } : {}),
      clientActionExecute: params.clientActionExecute ?? getDaemonClientActionExecutor(approvalServerId),
      confidentialSecretFill: params.confidentialSecretFill ?? getDaemonConfidentialSecretFillExecutor(approvalServerId),
      confidentialActionInputs: params.confidentialActionInputs ?? getDaemonConfidentialActionInputsExecutor(approvalServerId),
      ...(params.scmFilesystemAccessPolicy ? { scmFilesystemAccessPolicy: params.scmFilesystemAccessPolicy } : {}),
      ...(params.resolveExactSessionEncryptionMaterial
        ? { resolveExactSessionEncryptionMaterial: params.resolveExactSessionEncryptionMaterial }
        : {}),
      ...(params.actionsSettingsProvider ? { actionsSettingsProvider: params.actionsSettingsProvider } : {}),
      ...(params.pluginChangeService ? { pluginChangeService: params.pluginChangeService } : {}),
      ...(params.managedMachineAction ? { managedMachineAction: params.managedMachineAction } : {}),
      ...(params.machinePresetPrepare ? { machinePresetPrepare: params.machinePresetPrepare } : {}),
      ...(params.machineRecipesRead ? { machineRecipesRead: params.machineRecipesRead } : {}),
      ...(params.machineSetupPlan ? { machineSetupPlan: params.machineSetupPlan } : {}),
      ...(params.machineReachabilityAction ? { machineReachabilityAction: params.machineReachabilityAction } : {}),
      ...(params.sessionStop ? { sessionStop: params.sessionStop } : {}),
      ...((approvalLifetime ?? params.hostActionApprovalLifetime) ? { hostActionApprovalLifetime: approvalLifetime ?? params.hostActionApprovalLifetime } : {}),
      ...(params.runActionOperation ? { runActionOperation: params.runActionOperation } : {}),
      ...(params.projectAction ? { projectAction: params.projectAction } : {}),
      ...(params.deploymentAction ? { deploymentAction: params.deploymentAction } : {}),
      ...(params.deploymentBackupAction ? { deploymentBackupAction: params.deploymentBackupAction } : {}),
      ...(params.deploymentRestore ? { deploymentRestore: params.deploymentRestore } : {}),
      ...(params.projectReadinessRead ? { projectReadinessRead: params.projectReadinessRead } : {}),
      ...(params.deploymentTemplateInstantiate ? { deploymentTemplateInstantiate: params.deploymentTemplateInstantiate } : {}),
      ...(params.deploymentMoveToRepository ? { deploymentMoveToRepository: params.deploymentMoveToRepository } : {}),
      ...(params.prepareDeploymentTemplateInstantiation ? { prepareDeploymentTemplateInstantiation: params.prepareDeploymentTemplateInstantiation } : {}),
      ...(params.resolveEnvironmentApprovalScope ? { resolveEnvironmentApprovalScope: params.resolveEnvironmentApprovalScope } : {}),
      ...(params.prepareDeploymentAction ? { prepareDeploymentAction: params.prepareDeploymentAction } : {}),
      ...(params.prepareDeploymentTeardown ? { prepareDeploymentTeardown: params.prepareDeploymentTeardown } : {}),
      ...(params.prepareDeploymentEnvironmentCreate ? { prepareDeploymentEnvironmentCreate: params.prepareDeploymentEnvironmentCreate } : {}),
      ...(params.prepareHostReviewedChildren ? { prepareHostReviewedChildren: params.prepareHostReviewedChildren } : {}),
      ...(params.readApprovedOperation ? { readApprovedOperation: params.readApprovedOperation } : {}),
      ...(params.deploymentPrepare ? { deploymentPrepare: params.deploymentPrepare } : {}),
      ...(params.projectWorkerAction ? { projectWorkerAction: params.projectWorkerAction } : {}),
      ...(params.projectDefinitionAction ? { projectDefinitionAction: params.projectDefinitionAction } : {}),
      ...(params.filesystemActionExecute ? { filesystemActionExecute: params.filesystemActionExecute } : {}),
      ...(params.workspaceFilesReplace ? { workspaceFilesReplace: params.workspaceFilesReplace } : {}),
      ...(params.workspaceFilesReplacePreview ? { workspaceFilesReplacePreview: params.workspaceFilesReplacePreview } : {}),
      ...(params.languageIntelligenceApply ? { languageIntelligenceApply: params.languageIntelligenceApply } : {}),
      ...(params.skillMachineActionExecute ? { skillMachineActionExecute: params.skillMachineActionExecute } : {}),
      serverId: approvalServerId,
      ...(serverIdentityId ? { serverIdentityId } : {}),
      serverHttpBaseUrl: approvalServerApiUrl,
      ...(params.externalActionMachineRequestPrivateKey
        ? { externalActionMachineRequestPrivateKey: params.externalActionMachineRequestPrivateKey }
        : {}),
      ...(params.externalActionMachineInstallationId
        ? { externalActionMachineInstallationId: params.externalActionMachineInstallationId }
        : {}),
      sessionFollowActionDeps,
      sessionTrackedTargetCompatibilityDeps: createSessionTrackedTargetCompatibilityDep({
        serverId: approvalServerId,
        replaceSessionVoiceInclusions: sessionFollowActionDeps.replaceSessionVoiceInclusions,
      }),
      sessionReadStateActionDeps: createSessionReadStateActionDeps({
        token: credentials.token,
        ...fixedHome,
        ...(serverIdentityId ? { serverIdentityId } : {}),
        ...(params.externalActionMachineRequestPrivateKey
          ? { externalActionMachineRequestPrivateKey: params.externalActionMachineRequestPrivateKey }
          : {}),
        ...(params.externalActionMachineInstallationId
          ? { externalActionMachineInstallationId: params.externalActionMachineInstallationId }
          : {}),
      }),
      accountServerActionDeps,
      token: credentials.token,
      credentials,
      ...(prepareApprovalExecutionOriginContext ? { prepareApprovalExecutionOriginContext } : {}),
      ...(params.onRequesterSessionCredentialDisclosure
        ? { onRequesterSessionCredentialDisclosure: params.onRequesterSessionCredentialDisclosure } : {}),
      ...(params.requesterSessionBootstrap ? { requesterSessionBootstrap: params.requesterSessionBootstrap } : {}),
      ...(savedSecretOperationContext ? { savedSecretOperationContext } : {}),
      ...(params.providerPreparedSavedSecret ? { providerPreparedSavedSecret: params.providerPreparedSavedSecret } : {}),
      ...(params.projectModelsForAccount ? { projectModelsForAccount: params.projectModelsForAccount } : {}),
      ...(params.readProviderForAccount ? { readProviderForAccount: params.readProviderForAccount } : {}),
      resolveServerFeaturesSnapshot,
      ...(params.resolvePluginNotifications ? { resolvePluginNotifications: params.resolvePluginNotifications } : {}),
      ...(params.readPluginVoiceProviders ? { readPluginVoiceProviders: params.readPluginVoiceProviders } : {}),
      ...(params.pluginActionExecutionOwner
        ? { pluginActionExecutionOwner: params.pluginActionExecutionOwner }
        : {}),
      ...(routeHostChildAction ? { requestPluginActionExecution: async (...[request, options, invocation]: Parameters<PluginActionExecutionRequestOwner>) => {
        const context = invocation?.context;
        if (invocation && context && isOriginalCliActionContext(context)
          // Turn-bound occurrence/read-only custody stays on its incumbent
          // private transport; it is not an original public CLI invocation.
          && !request.expectedContributorOccurrenceId && !request.requiredDangerLevel
          && (params.machineId || context.externalActionTarget?.kind === 'machine')) {
          // Account placement has already had first refusal. Reuse the original
          // CLI admission owner for this exact selector, retaining its authority
          // and credentials rather than borrowing the caller's local daemon.
          const action = parseQualifiedPluginActionId(invocation.actionId);
          const result = await routeHostChildAction({
            actionId: action ? 'action.invoke' : ActionIdSchema.parse(invocation.actionId),
            input: action ? { action, input: request.input } : request.input,
            context,
          });
          if (result) return { matched: true as const, result };
        }
        const { requestDaemonPluginActionExecution } = await import('@/daemon/controlClient');
        return await requestDaemonPluginActionExecution(request, options);
      } } : {}),
      ...(params.accountPluginActions ? { accountPluginActions: true as const } : {}),
      sessionId: 'cli-global',
      ...(params.sessionMessageReplyPublisher ? { sessionMessageReplyPublisher: params.sessionMessageReplyPublisher } : {}),
      ...(params.postAgentDiscussionMessage ? { postAgentDiscussionMessage: params.postAgentDiscussionMessage } : {}),
      ...(params.postWorkflowDiscussionMessage ? { postWorkflowDiscussionMessage: params.postWorkflowDiscussionMessage } : {}),
      ...(params.workflowRequesterCustody ? { workflowRequesterCustody: params.workflowRequesterCustody } : {}),
      ...(params.getCurrentTurnWorkDepth ? { getCurrentTurnWorkDepth: params.getCurrentTurnWorkDepth } : {}),
      ...(params.resolveAutomationEventAdoptedDefinitionSet
        ? { resolveAutomationEventAdoptedDefinitionSet: params.resolveAutomationEventAdoptedDefinitionSet }
        : {}),
      ...(params.resolveAuthenticatedAccountId
        ? { resolveAuthenticatedAccountId: params.resolveAuthenticatedAccountId }
        : {}),
      ...(params.acquireAutomationEventObservationRegistry
        ? { acquireAutomationEventObservationRegistry: params.acquireAutomationEventObservationRegistry }
        : {}),
      ...(params.revalidatePluginActionCallerMaterialization
        ? { revalidatePluginActionCallerMaterialization: params.revalidatePluginActionCallerMaterialization }
        : {}),
      ...(params.revalidatePluginActionCallerOccurrence
        ? { revalidatePluginActionCallerOccurrence: params.revalidatePluginActionCallerOccurrence }
        : {}),
      ...(params.sessionActionConfirmation ? { sessionActionConfirmation: params.sessionActionConfirmation } : {}),
      ...(params.machineId ? { runtimeActionMachineId: params.machineId } : {}),
      ...(params.runtimeActionExecute
        ? { runtimeActionExecute: params.runtimeActionExecute }
        : {}),
      ...(params.machineGuardAction ? { machineGuardAction: params.machineGuardAction } : {}),
      ...(params.workflowAction ? { workflowAction: params.workflowAction } : {}),
      ...(params.registerWorkflowTriggerList ? { registerWorkflowTriggerList: params.registerWorkflowTriggerList } : {}),
      ...(params.workflowAcceptedAuthorizationCurrentness
        ? { workflowAcceptedAuthorizationCurrentness: params.workflowAcceptedAuthorizationCurrentness }
        : {}),
      ...(params.invokeContributedAction
        ? { invokeContributedAction: params.invokeContributedAction }
        : {}),
      ...(params.targetActionApprovalReplay
        ? { targetActionApprovalReplay: params.targetActionApprovalReplay }
        : !machineAdmissionTransport && params.pluginActionExecutionOwner !== 'current_process'
          ? { targetActionApprovalReplay: (async ({ artifactId, decision, initialRead, context, callerGrant, signal }) => {
            // Account live-only decisions use the same Artifact decision owner;
            // Machine custody still returns to its exact admitting daemon.
            const store = createCliApprovalsArtifactStore({ credentials, serverId: approvalServerId,
              serverHttpBaseUrl: approvalServerApiUrl,
              ...(params.admittedAccountEncryptionMode !== undefined
                ? { getAccountEncryptionMode: async () => params.admittedAccountEncryptionMode! } : {}) });
            let request: TargetActionApprovalRequestV1 | null;
            try {
              const initial = initialRead ? TargetActionApprovalRequestV1Schema.safeParse(initialRead.request) : null;
              request = initialRead ? initial?.success ? initial.data : null
                : await runWithServerHttpBaseUrl(approvalServerApiUrl, () => store.targetActionApprovalsGet({ artifactId }));
            }
            catch { return actionFailure('approval_unavailable'); }
            if (!request) return null;
            const origin = request.executionOriginV1;
            const executor = resolveApprovalExecutor(request);
            if (executor.kind === 'unavailable') return actionFailure('approval_origin_unavailable');
            const machineId = executor.kind === 'daemon' ? executor.machineId
              : executor.kind === 'live_invocation' ? executor.daemonMachineId : null;
            const localLiveDecision = executor.kind === 'live_invocation' && !executor.daemonMachineId;
            if (!localLiveDecision && (!origin?.serverIdentityId || !machineId)) return actionFailure('approval_origin_unavailable');
            if (origin) {
              if (signal?.aborted) return actionFailure('cancelled');
              const snapshot = await resolveServerFeaturesSnapshot();
              const currentHome = snapshot?.status === 'ready' && snapshot.provenance === 'authenticated'
                ? normalizeServerIdentityIdCapability(snapshot.features.capabilities.serverIdentity?.serverIdentityId) : null;
              if (!currentHome) return actionFailure('approval_origin_unavailable');
              if (currentHome !== origin.serverIdentityId) return actionFailure('approval_stale');
            }
            // Origin may include a contextual Machine; only replay placement selects an
            // exact remote owner. Account operands stay in the live invocation.
            if (localLiveDecision) {
              // Settled receipts and active claims are read by the decision owner;
              // their original process may already have closed its live endpoint.
              const live = request.status === 'open' || request.status === 'approved'
                ? await replayLiveCliApprovalOrigin({ artifactId, request, decision, context: context ?? {}, ...(signal ? { signal } : {}) }, {
                  token: credentials.token, serverUrl: approvalServerApiUrl,
                }) : null;
              if (live) return live;
              if (signal?.aborted) return actionFailure('cancelled');
              const result = await createTargetActionApprovalDecision({
                read: id => runWithServerHttpBaseUrl(approvalServerApiUrl,
                  () => store.targetActionApprovalsGet({ artifactId: id })),
                update: async args => {
                  if (signal?.aborted) return { ok: false, errorCode: 'cancelled', error: 'cancelled' };
                  return runWithServerHttpBaseUrl(approvalServerApiUrl, () => store.targetActionApprovalsUpdate(args));
                },
              })({ artifactId, decision, context, ...(callerGrant ? { callerGrant } : {}), ...(signal ? { signal } : {}) });
              return result;
            }
            // Narrow the Machine branch after the local live decision above.
            if (!origin?.serverIdentityId || !machineId) return actionFailure('approval_origin_unavailable');
            if (signal?.aborted) return actionFailure('cancelled');
            // The requester owns this Account approval, including when its
            // original invocation ran on a shared Machine. Reuse signed Action
            // admission; the unsigned public decision RPC remains custodian-only.
            const invocation = readExternalActionRequesterInvocation(context);
            if (!invocation) return actionFailure('admission_unavailable');
            return await dispatchOriginalAccountAction({ actionId: 'approval.request.decide',
              input: { artifactId, decision, serverIdentityId: origin.serverIdentityId, originServerId: origin.serverId },
              target: { kind: 'machine', machineId }, requestId: context?.actionRequestId ?? randomUUID(), credentials,
              serverHttpBaseUrl: approvalServerApiUrl, serverIdentityId: origin.serverIdentityId,
              invocation, authority: invocation.authority,
              onRequesterSessionCredentialDisclosure: params.onRequesterSessionCredentialDisclosure,
              ...(signal ? { signal } : {}) });
          }) satisfies NonNullable<ActionExecutorDeps['targetActionApprovalReplay']> }
          : {}),
      ...(!machineAdmissionTransport && params.pluginActionExecutionOwner !== 'current_process' ? {
        executionRunHostActionApprovalReplay: createExecutionRunHostApprovalReplay({ credentials,
          serverId: approvalServerId, serverHttpBaseUrl: approvalServerApiUrl,
          isCurrent: async () => hasStoredSessionCredentialProvenance(credentials)
            && !invocationSignal?.aborted,
        }),
      } : {}),
      // Refuse before consent is recorded when the replay below would mint a
      // fresh decision root this stored terminal credential can never obtain.
      ...(hasStoredSessionCredentialProvenance(credentials) ? {
        approvalRequestApproveRefusal: ({ request }) => {
          if (machineAdmissionTransport || params.machineActionDirectTargetTransport
            || params.pluginActionExecutionOwner === 'current_process'
            || readLiveCliApprovalOriginScope(request) !== null || readApprovalRequesterDecisionV1(request, 'approve')) return null;
          const executor = resolveApprovalExecutor(request);
          if (executor.kind !== 'daemon' && executor.kind !== 'live_invocation'
            || readApprovalReplayDecisionAdmission(request) !== 'fresh') return null;
          const provenance = readAuthTokenProvenance(decodeJwtPayload(credentials.token), { allowLegacyHome: true })?.provenance;
          if (provenance?.kind !== 'terminal' || isApprovalDecisionReviewerBindingV1({ authentication: { kind: 'terminal' } })) return null;
          return { ok: false, errorCode: 'present_user_required', error: 'present_user_required', effectAttempted: false,
            details: { reason: 'approval_reviewer_required' } };
        },
      } satisfies Pick<ActionExecutorDeps, 'approvalRequestApproveRefusal'> : {}),
      ...(!machineAdmissionTransport && !params.machineActionDirectTargetTransport
        && params.pluginActionExecutionOwner !== 'current_process'
        && hasStoredSessionCredentialProvenance(credentials)
        ? { approvalRequestOutcomePublication: createOriginDaemonApprovalOutcomePublisher({ credentials, serverUrl: approvalServerApiUrl }) }
        : {}),
      approvalRequestApprovedReplay: async args => {
        const { artifactId, request, decision, context, requestId, signal, onReplayDispatched } = args;
        try {
        const live = await replayLiveCliApprovalOrigin(args, { token: credentials.token,
          serverUrl: approvalServerApiUrl,
        });
        if (live) return live;
        const requesterDecision = readApprovalRequesterDecisionV1(request, decision);
        if (requesterDecision) {
          const { subject, decision } = requesterDecision;
          if (!serverIdentityId || request.executionOriginV1?.serverIdentityId !== serverIdentityId) return actionFailure('approval_stale');
          const result = await runWithServerHttpBaseUrl(approvalServerApiUrl, async () => {
            const transport = await resolveSessionTransportContext({ reason: 'session-action', credentials, idOrPrefix: subject.personaSessionRef.sessionId,
              ...(signal ? { signal } : {}) });
            if (!transport.ok || transport.sessionId !== subject.personaSessionRef.sessionId) return actionFailure('approval_stale');
            onReplayDispatched?.();
            return await callSessionRpc({ ...transport, token: credentials.token, sessionId: transport.sessionId,
              method: `${transport.sessionId}:${RPC_METHODS.APPROVAL_REQUEST_DECIDE}`,
              request: { artifactId, sessionId: transport.sessionId, decision }, timeoutMs: null,
              ...(signal ? { signal } : {}) });
          });
          const value = readRecord(result);
          if (value?.ok === true && Object.hasOwn(value, 'result')) return { ok: true, result: value.result };
          const failure = ActionExecuteFailureSchema.safeParse(result);
          return failure.success ? failure.data : actionFailure('invalid_action_transport_output');
        }
        if (request.v !== 2) return null;
        const executor = resolveApprovalExecutor(request);
        if (executor.kind === 'unavailable') return actionFailure('approval_origin_unavailable');
        const remoteClientReplay = executor.kind === 'app' && executor.placement === 'client'
          && !params.clientActionExecute && !getDaemonClientActionExecutor(approvalServerId);
        const origin = request.executionOriginV1;
        // Client delivery may have entered through local MCP control, without
        // a signed external carrier. A Session target retains its admitting
        // Machine separately; the target itself must remain the Session.
        // This is placement only: the existing replay owner admits the decision.
        const clientReplayMachineId = remoteClientReplay && origin.target
          ? origin.target.kind === 'machine' ? origin.target.machineId : origin.machineId
          : undefined;
        if (remoteClientReplay && !clientReplayMachineId) return actionFailure('approval_origin_unavailable');
        if (machineAdmissionTransport || params.machineActionDirectTargetTransport
          || params.pluginActionExecutionOwner === 'current_process'
          || executor.kind === 'app' && !remoteClientReplay) return null;
        // A live effect stays in its original waiter. Machine RPC only carries
        // the authenticated decision to that process; it never rebuilds input.
        const machineId = executor.kind === 'daemon' ? executor.machineId
          : executor.kind === 'live_invocation' ? executor.daemonMachineId : clientReplayMachineId;
        if (!machineId) return actionFailure('approval_origin_unavailable');
        const forwardedDecision = decision ?? (executor.kind === 'live_invocation' ? 'approve' as const : undefined);
        if (!request.executionOriginV1.serverIdentityId) return actionFailure('approval_origin_unavailable');
        if (signal?.aborted) return actionFailure('cancelled');
        onReplayDispatched?.();
        const decisionAdmission = readApprovalReplayDecisionAdmission(request);
        if (decisionAdmission) {
          const invocation = readExternalActionRequesterInvocation(context);
          if (!invocation) return actionFailure('admission_unavailable');
          const admittedDecision = await dispatchOriginalAccountAction({ actionId: 'approval.request.decide',
            input: { artifactId, decision: forwardedDecision ?? 'approve',
              serverIdentityId: request.executionOriginV1.serverIdentityId,
              originServerId: request.executionOriginV1.serverId },
            target: { kind: 'machine', machineId }, requestId: requestId ?? randomUUID(), credentials,
            serverHttpBaseUrl: approvalServerApiUrl, serverIdentityId: request.executionOriginV1.serverIdentityId,
            invocation, authority: invocation.authority,
            ...(decisionAdmission === 'foreign_target_only' ? { foreignTargetOnly: true as const } : {}),
            onRequesterSessionCredentialDisclosure: params.onRequesterSessionCredentialDisclosure,
            ...(signal ? { signal } : {}) });
          if (admittedDecision) return admittedDecision;
        }
        const replay = await callExactMachineRpc({ credentials, serverUrl: approvalServerApiUrl,
          machineId,
          method: forwardedDecision ? RPC_METHODS.APPROVAL_REQUEST_DECIDE : RPC_METHODS.APPROVAL_REQUEST_REPLAY_APPROVED,
          request: forwardedDecision ? { artifactId, decision: forwardedDecision, serverIdentityId: request.executionOriginV1.serverIdentityId,
            originServerId: request.executionOriginV1.serverId } : { artifactId },
          ...(requestId ? { requestId } : {}), requireCurrentMachine: true, timeoutMs: null,
          ...(signal ? { signal } : {}) });
        if (forwardedDecision) {
          const failure = ActionExecuteFailureSchema.safeParse(replay);
          if (failure.success) return failure.data;
          const value = readRecord(replay);
          const output = getActionSpec('approval.request.decide').outputSchema?.safeParse(
            value?.ok === true && Object.hasOwn(value, 'result') ? value.result : replay);
          return output?.success ? { ok: true, result: output.data } : actionFailure('invalid_action_transport_output');
        }
        const result = readRecord(replay);
        if (result?.ok === true && Object.hasOwn(result, 'result')) return { ok: true, result: result.result };
        const failure = ActionExecuteFailureSchema.safeParse(replay);
        return failure.success ? failure.data : actionFailure('invalid_action_transport_output');
        } catch (error) {
          if (readMachineRpcRequestDisposition(error) === 'notSent') {
            onReplayDispatched?.(false);
            return { ok: false, ...normalizeActionExecutorThrownError(error), effectAttempted: false };
          }
          throw error;
        }
      },
      isApprovalExecutionOriginCurrent,
      ...(params.prepareApprovalExecutionAuthorization
        ? { prepareApprovalExecutionAuthorization: params.prepareApprovalExecutionAuthorization }
        : {}),
      ...(params.prepareLocalServiceStartApproval ? { prepareLocalServiceStartApproval: params.prepareLocalServiceStartApproval } : {}),
      ...(params.bindApprovedApiTokenExecution && accountServerActionDeps.accountApiTokensCreateAction
        ? { prepareApprovedApiTokenExecution: params.bindApprovedApiTokenExecution(accountServerActionDeps.accountApiTokensCreateAction) } : {}),
      ...(params.listContributedActionDefinitions
        ? { listContributedActionDefinitions: params.listContributedActionDefinitions }
        : {}),
      ...(params.inputTypeDeps ? { inputTypeDeps: params.inputTypeDeps } : {}),
      ...(params.hostExternalSessionAction
        ? { hostExternalSessionAction: params.hostExternalSessionAction }
        : {}),
      ...(params.sessionSpawnDirectTargetTransport
        ? { sessionSpawnDirectTargetTransport: params.sessionSpawnDirectTargetTransport }
        : {}),
      ...(params.acquireSessionIsolationSandbox ? { acquireSessionIsolationSandbox: params.acquireSessionIsolationSandbox } : {}),
      ...(params.machineActionDirectTargetTransport
        ? { machineActionDirectTargetTransport: params.machineActionDirectTargetTransport }
        : {}),
      ...(params.machineId ? { explicitMachineId: params.machineId } : {}),
      ...(params.sessionActionRpcTransport ? { sessionActionRpcTransport: params.sessionActionRpcTransport } : {}),
      ...(params.externalSessionPluginAdmissionOwner
        ? {
            externalSessionPluginAdmissionOwner:
              params.externalSessionPluginAdmissionOwner,
          }
        : {}),
      ...(machineAdmissionTransport
        ? { machineAdmissionTransport }
        : {}),
      ...(params.resolveComposerAttachmentSendPreparation
        ? {
            resolveComposerAttachmentSendPreparation:
              params.resolveComposerAttachmentSendPreparation,
          }
        : {}),
      resolveTranscriptStore: async (sessionId) => {
        const [{ createServerBackedSessionTranscriptStore }, { fetchOpenedSessionStateFromServer }] = await Promise.all([
          import('@/api/session/createServerBackedSessionTranscriptStore'), import('@/api/session/snapshotSync'),
        ]);
        const serverFeaturesSnapshot = await resolveServerFeaturesSnapshotForCredentials(credentials);
        const transport = await resolveSessionTransportContext({
          reason: 'session-action',
          credentials,
          idOrPrefix: sessionId,
          ...(serverFeaturesSnapshot ? { serverFeaturesSnapshot } : {}),
        });
        if (!transport.ok) {
          throw Object.assign(new Error(transport.code), { code: transport.code });
        }
        return createServerBackedSessionTranscriptStore({
          token: credentials.token,
          sessionId: transport.sessionId,
          ...(transport.mode === 'plain' ? { mode: transport.mode, ctx: null } : { mode: transport.mode, ctx: transport.ctx }),
          readOpenedSessionState: (versions) => fetchOpenedSessionStateFromServer({
            reason: 'session-action',
            token: credentials.token,
            sessionId: transport.sessionId,
            credentials,
            accountEncryptionCurrentness: transport.accountEncryptionCurrentness,
            currentMetadataLayoutVersion: transport.rawSession.metadataLayoutVersion ?? 0,
            currentMetadataVersion: versions.sharedMetadataVersion,
            currentAgentStateVersion: versions.agentStateVersion,
            ...(transport.mode === 'plain' ? { mode: transport.mode, ctx: null } : { mode: transport.mode, ctx: transport.ctx }),
          }),
        });
      },
      transcriptFollowLeaseRegistry,
      writeTranscriptItems: async (sessionId: string, items: readonly SessionTranscriptActionItem[]) =>
        await (await import('@/session/transport/http/sessionsHttp')).importHistoricalSessionTranscript({
          token: credentials.token,
          sessionId,
          items,
        }),
      ...(params.sessionLogAccess ? { sessionLogAccess: params.sessionLogAccess } : {}),
    });
  };

  const createCredentialRefreshingExecutor = (
    transcriptFollowLeaseRegistry: ReturnType<typeof createFollowLeaseRegistry>,
    invocationSignal?: AbortSignal,
    approvalLifetime?: ActionExecutorDeps['hostActionApprovalLifetime'],
  ): CliActionExecutor => {
    // Routing refusals precede Start transport. Dispatched failures retain the
    // receiver's own evidence and must never be relabeled as an uncreated Run.
    const routingFailure = (actionId: string, result: ActionExecuteResult): ActionExecuteResult =>
      actionId === 'execution.run.start' && !result.ok
        ? { ...result, details: withExecutionRunStartFailureDetails(result.details, 'noRunCreated') } : result;
    const routeHostChildAction = (credentials: StoredCredentials): NonNullable<ActionExecutorDeps['routeHostChildAction']> =>
      async ({ actionId, input, context }) => {
        if (params.pluginActionExecutionOwner === 'current_process') {
          // Account plugin runtimes also own their local plugin invocation;
          // only a daemon-applied registry establishes Machine runtime custody.
          const { tryAcquireAuthoritativePluginRuntimeRegistryLease } = await import('@/plugins/runtime/reload/runtimeLease');
          const lease = tryAcquireAuthoritativePluginRuntimeRegistryLease();
          if (lease) { await lease.release(); return null; }
        }
        if (!isOriginalCliActionContext(context)) {
          // A receiving RPC already owns its host-stamped route. Keep its
          // existing local dependency/Session transport after the same semantic
          // selector proves that this child does not retarget that receiver.
          const receiverMachineId = params.machineActionDirectTargetTransport?.machineId
            ?? (context.externalActionTarget?.kind === 'machine' ? context.externalActionTarget.machineId : null);
          if (!receiverMachineId) return routingFailure(actionId, actionFailure('target_unavailable'));
          const selected = resolveExternalActionMachineTarget({ actionId, rawInput: input,
            target: context.externalActionTarget, ownerMachineId: receiverMachineId, context });
          if (selected.kind === 'rejected') return routingFailure(actionId, selected.execution);
          if (isMachineSetupPlanOrApplyActionIdV1(actionId)) {
            const operation = readHostReviewedChildOperationV1(context, actionId, input);
            if (isHostAdmittedReviewedChildPolicyV1(operation, actionId, input)) {
              // A signed child already carries its requester's root and grant.
              // Continue through the ordinary executor rather than minting an
              // unrelated root with the installed Account's credential.
              if (context.externalActionExecutionAuthorization) return null;
              if (context.externalActionCredential) return actionFailure('credential_scope_denied');
              const accountId = readAccountIdFromToken(credentials.token);
              if (!accountId) return actionFailure('admission_unavailable');
              const localContext: RpcActionExecutorContext = context;
              const common = { context, credentials, custodianAccountId: accountId,
                serverHttpBaseUrl: resolveActionServerApiUrl(),
                isCurrent: async () => !localContext.signal?.aborted
                  && (!localContext.verifiedExternalActionRequester || await localContext.verifiedExternalActionRequester.isCurrent()),
                observeRecordedApprovalExecution: async (args: RecordedApprovalExecutionObservationArgs) =>
                  await (await resolveExecutor(credentials)).observeRecordedApprovalExecution(args) };
              if (actionId === MACHINE_SETUP_APPLY_ACTION_ID_V1) {
                const setup = MachineSetupApplyInputV1Schema.safeParse(input);
                return setup.success ? await dispatchLocalManagedMachineSetup({ ...common, input: setup.data })
                  : actionFailure('invalid_input');
              }
              const setup = MachineSetupPlanInputV1Schema.safeParse(input);
              return setup.success ? await dispatchLocalManagedMachineSetupPlan({ ...common, input: setup.data })
                : actionFailure('invalid_input');
            }
          }
          return null;
        }
        const prepared = await prepareOriginalCliActionInvocation(actionId, input, context, credentials, true);
        return prepared.invocation ? await prepared.invocation.run() : routingFailure(actionId, actionFailure('target_unavailable'));
      };
    const readInputTypeOptions = (credentials: StoredCredentials): NonNullable<ActionExecutorDeps['readAdmittedInputTypeOptions']> =>
      async ({ input, context }) => {
        // The schema/consumer was admitted by the local input owner. Resolve
        // live choices through the same authenticated built-in ingress, never
        // the contributed-plugin endpoint or a locally invented registry.
        if (!isOriginalCliActionContext(context)) return actionFailure('input_type_options_unavailable');
        const prepared = await prepareOriginalCliActionInvocation('action.options.resolve', input, context, credentials, true);
        if (!prepared.invocation) return actionFailure('input_type_options_unavailable');
        const result = await prepared.invocation.run();
        return result.ok ? result.result : result;
      };
    // Default policy readers capture the Account lifetime at construction.
    // Bind them only after the first invocation has bootstrapped that Account;
    // an explicitly admitted runtime provider already owns its lifetime.
    let fixedExecutor = params.readCredentials || !params.actionsSettingsProvider
      ? null
      : shouldUsePatPublicActionTransport(params.credentials, undefined)
        ? null
        : createExecutor(params.credentials, invocationSignal, transcriptFollowLeaseRegistry, undefined, params.serverIdentityId, readInputTypeOptions(params.credentials), approvalLifetime, routeHostChildAction(params.credentials));
    let fixedExecutorServerIdentityId = params.serverIdentityId;
    const resolveExecutor = async (credentials: StoredCredentials, sessionMemoryEnabled?: boolean,
      routing?: Pick<ActionExecutorContext, 'serverIdentityId'> & Pick<ActionExecutorDeps, 'prepareApprovalExecutionOriginContext'>) => {
      // Resolve at the invocation boundary, not during synchronous composition.
      // Caller context never supplies dependency Home authority.
      const serverIdentityId = routing ? routing.serverIdentityId : params.serverIdentityId
        ?? (await enrichApprovalRoutingContext(undefined, credentials)).serverIdentityId;
      if (routing?.prepareApprovalExecutionOriginContext) {
        // This deferred Home fact belongs to this invocation, not the reused
        // executor of another Action whose eager lookup may have failed.
        return createExecutor(credentials, invocationSignal, transcriptFollowLeaseRegistry, sessionMemoryEnabled, serverIdentityId,
          readInputTypeOptions(credentials), approvalLifetime, routeHostChildAction(credentials), routing.prepareApprovalExecutionOriginContext);
      }
      if (!fixedExecutor || sessionMemoryEnabled !== undefined) {
        const executor = createExecutor(credentials, invocationSignal, transcriptFollowLeaseRegistry, sessionMemoryEnabled, serverIdentityId, readInputTypeOptions(credentials), approvalLifetime, routeHostChildAction(credentials));
        if (!params.readCredentials && sessionMemoryEnabled === undefined) {
          fixedExecutor = executor;
          fixedExecutorServerIdentityId = serverIdentityId;
        }
        return executor;
      }
      if (fixedExecutorServerIdentityId !== serverIdentityId) {
        fixedExecutor = createExecutor(credentials, invocationSignal, transcriptFollowLeaseRegistry, undefined, serverIdentityId, readInputTypeOptions(credentials), approvalLifetime, routeHostChildAction(credentials));
        fixedExecutorServerIdentityId = serverIdentityId;
      }
      return fixedExecutor;
    };
    const originationPreferenceFailure = async (actionId: string, credentials: StoredCredentials,
      context: ActionExecutorContext | undefined) => {
      if (actionId !== 'machines.managed.acquire' || context?.externalActionExecutionAuthorization || context?.surface === 'rpc') return null;
      if (!params.actionsSettingsProvider) await ensureCliActionPolicySettings(credentials, resolveActionServerApiUrl());
      const provider = params.actionsSettingsProvider ?? createActionSettingsProvider({
        scopeKey: resolveAccountSettingsScopeKeyForToken(credentials.token),
      });
      return resolveActionOriginationPreferenceFailureV1(actionId, {
        managedMachineCreationEnabled: provider.getAccountSettings?.()?.managedMachineCreationEnabled,
      });
    };
    const prepareOriginalCliActionInvocation = async (actionId: string, input: unknown,
      context: ActionExecutorContext, credentials: StoredCredentials, requireDaemonIngress = false) => {
      // A Machine-hosted SDK caller defaults to its own host. Retain the plugin
      // invocation in Home admission, just as an explicitly placed CLI root does.
      // Signed children already belong to their receiving execution owner.
      if (context.surface === 'plugin' && context.actionCaller?.kind === 'plugin'
        && !context.externalActionExecutionAuthorization && params.machineId
        && (params.pluginActionExecutionOwner !== 'current_process' || isDeploymentReceiptObservationActionIdV1(actionId))
        && !isPluginActionExecutionDispatchId(actionId)
        && resolveActionExecutionPlacementForInput(getActionSpec(ActionIdSchema.parse(actionId)), input, context.actionCaller, context.surface) === 'machine') {
        const invocation = readExternalActionRequesterInvocation(context);
        const serverIdentityId = context.serverIdentityId ?? params.serverIdentityId;
        const originalTarget = context.externalActionTarget ?? { kind: 'machine' as const, machineId: params.machineId };
        return { context, invocation: createOneShotPatInvocation(async () => {
          if (!invocation || !serverIdentityId) return actionFailure('admission_unavailable');
          const serverHttpBaseUrl = resolveActionServerApiUrl();
          let target = originalTarget;
          if (actionId === DEPLOYMENT_ENVIRONMENT_CREATE_ACTION_ID_V1) {
            const authored = DeploymentEnvironmentCreateIntentInputV1Schema.safeParse(input);
            if (authored.success && authored.data.preview) {
              const { deploymentAction } = createCliDeploymentActionDeps({ serverHttpBaseUrl,
                admitAccount: async serverId => await isServerProfileHomeIdentity(approvalServerId, serverId)
                  ? null : actionFailure('server_scope_mismatch'),
                resolveRequestHeaders: () => ({ ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
                  Authorization: `Bearer ${credentials.token}` }),
                dispatchReceipt: async () => actionFailure('deployment_executor_unavailable') });
              const selected = await resolveDeploymentPreviewExecutionMachineIdV1(authored.data, {
                listEnvironments: query => deploymentAction!('deployments.environments.list', query, context),
                async readTemplateController() {
                  const loaded = await deploymentAction!('deployments.environments.get', { serverId: authored.data.serverId,
                    environmentId: authored.data.preview!.templateEnvironmentId }, context);
                  if ('errorCode' in loaded) return loaded;
                  const result = DeploymentEnvironmentGetResultV1Schema.parse(loaded);
                  return result.ok ? { ok: true, machineId: result.environment.controllerMachineId } : actionFailure(result.error);
                },
              });
              if (!selected.ok) return selected;
              const resolved = resolveExternalActionMachineTarget({ actionId, rawInput: input,
                target: context.externalActionTarget, ownerMachineId: selected.machineId, context });
              if (resolved.kind === 'rejected') return resolved.execution;
              target = { kind: 'machine', machineId: selected.machineId };
            }
          }
          const readRepositoryWorkspaceMachine = async (workspace: Parameters<typeof resolveAccountWorkspaceMachine>[0]['workspace']) => {
            const resolved = await resolveAccountWorkspaceMachine({ credentials, workspace, serverId: approvalServerId,
              serverIdentityId, serverApiUrl: serverHttpBaseUrl, ...(context.signal ? { signal: context.signal } : {}) });
            return resolved.ok ? resolved : actionFailure(resolved.code);
          };
          if (actionId === DEPLOYMENT_ENVIRONMENT_MOVE_TO_REPOSITORY_ACTION_ID_V1) {
            const parsed = DeploymentMoveToRepositoryInputV1Schema.safeParse(input);
            if (!parsed.success) return actionFailure('invalid_parameters');
            const selected = await resolveDeploymentMoveToRepositoryExecutionMachineIdV1(parsed.data, readRepositoryWorkspaceMachine);
            if (!selected.ok) return selected;
            target = { kind: 'machine', machineId: selected.machineId };
          }
          if (actionId === DEPLOYMENT_TEMPLATE_INSTANTIATE_ACTION_ID_V1) {
            const parsed = DeploymentTemplateInstantiateInputV1Schema.safeParse(input);
            if (!parsed.success) return actionFailure('invalid_parameters');
            const selected = await resolveDeploymentTemplateExecutionMachineIdV1(parsed.data, async request => {
              const { deploymentAction } = createCliDeploymentActionDeps({ serverHttpBaseUrl,
                admitAccount: async serverId => await isServerProfileHomeIdentity(approvalServerId, serverId)
                  ? null : actionFailure('server_scope_mismatch'),
                resolveRequestHeaders: () => ({ ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
                  Authorization: `Bearer ${credentials.token}` }),
                dispatchReceipt: async () => actionFailure('deployment_executor_unavailable'),
              });
              const loaded = await deploymentAction!('deployments.environments.get', request, context);
              return 'errorCode' in loaded ? loaded : DeploymentEnvironmentGetResultV1Schema.parse(loaded);
            }, request => readRepositoryWorkspaceMachine(request.workspace));
            if (!selected.ok) return selected;
            target = { kind: 'machine', machineId: selected.machineId };
          }
          return dispatchOriginalAccountAction({ actionId: SignedRootActionIdSchema.parse(actionId), input,
            requestId: context.actionRequestId ?? randomUUID(), target,
            credentials, serverHttpBaseUrl, serverIdentityId,
            authority: invocation.authority, invocation,
            ...(context.signal ? { signal: context.signal } : {}) });
        }) };
      }
      // Use the approval credential owner before issuing a person-start root.
      // Private Session custody authenticates the Account, never a present person.
      if (actionId === 'workflow.run.start' && isOriginalCliActionContext(context)
        && !hasStoredSessionCredentialProvenance(credentials)) return { context,
          invocation: createOneShotPatInvocation(async () => actionFailure('approval_requester_unavailable')) };
      const binding = context.externalActionExecutionAuthorization?.binding;
      const workflowOrigin = binding?.workflowActionOrigin;
      if (!context.approvedActionReplay && isControllerDeploymentMutationAction(actionId, input) && binding?.actionId === actionId && workflowOrigin
        && !workflowOrigin.sessionLeaf && !workflowOrigin.sessionAuthority) {
        try {
          const requester = readRequesterAccountActionContext(context.externalActionExecutionAuthorization);
          const serverBaseUrl = requester?.serverHttpBaseUrl ?? resolveActionServerApiUrl();
          const readAdmission = createCredentialedWorkflowActionAdmissionReader({ credentials, serverHttpBaseUrl: serverBaseUrl });
          const admission = await readAdmission({ runId: workflowOrigin.runId, context });
          const policy = admission && admission.run.ownerAccountId === binding.accountId
            && binding.accountId === readAccountIdFromToken(credentials.token)
            ? await readWorkflowActionPolicyContext({ admission, actionId, input, context }) : null;
          if (!policy || !admission) return { context,
            invocation: createOneShotPatInvocation(async () => actionFailure('admission_unavailable')) };
          // The signed root admits the effect; its accepted Run owns caller provenance and selected policy.
          context = { ...context, ...policy };
        } catch {
          return { context, invocation: createOneShotPatInvocation(async () => actionFailure('admission_unavailable')) };
        }
      }
      // This receiver already owns admission and execution. A Machine selector
      // must not send its host/CLI context back through its own root endpoint.
      if (params.pluginActionExecutionOwner === 'current_process' && !requireDaemonIngress) return { context };
      // Plugin Actions and their discovery/invocation meta-Actions belong to
      // the placement-aware plugin owner, not the finite root transport map.
      // Credential admission and approval context are already established;
      // carry them unchanged to that owner rather than fabricating API custody.
      // An admitted input-type callback explicitly requests the existing root
      // ingress; ordinary CLI plugin discovery still selects placement first.
      if (!requireDaemonIngress && isPluginActionExecutionDispatchId(actionId)) return { context };
      // Consent belongs to the Account approval owner, regardless of the outer
      // Machine selector. Its approved-Artifact continuation owns placement.
      if (actionId === 'approval.request.decide' && hasStoredSessionCredentialProvenance(credentials)) return { context };
      // Stop's exact handle needs no requester credentials. Keep its proposal
      // and Ask at this Account; native delivery spends a new signed Stop.
      if (isOriginalCliActionContext(context) && isLocalServiceStopActionIdV1(actionId)) return { context };
      const mountedFilesystemCopy = params.filesystemActionExecute && actionId === 'daemon.filesystem.copy'
        && (FilesystemPreparedCopyInputSchema.safeParse(input).success || FilesystemTargetCopyInputSchema.safeParse(input).success);
      // Finite original CLI work is admitted at Home before the selected
      // retained guest is online. Keep policy/approval in the shared executor;
      // admitted Session/Run origins retain their existing credentialed owner.
      const originalCliCaller = isOriginalCliActionContext(context);
      // The deployment owner resolves the Environment controller for original
      // template roots and unselected mutations, preserving host policy before
      // admitting preparation/Ask.
      if (!requireDaemonIngress && readControllerDeploymentDispatch({ credentials,
        deploymentAction: params.deploymentAction, deploymentTemplateInstantiate: params.deploymentTemplateInstantiate,
        deploymentMoveToRepository: params.deploymentMoveToRepository,
        machineId: params.machineId }, actionId, input, context)?.caller === 'host') return {
          context: { ...context, actionRequestId: context.actionRequestId ?? randomUUID() },
        };
      // Update preparation reads its owned Session before its software setup
      // hook; ordinary metadata-only work uses the captured Account credential.
      if (originalCliCaller && actionId === 'template.updates.apply') return { context };
      const boundWorkflowStart = originalCliCaller && actionId === 'workflow.run.start'
        ? readNonEmptyString(context.defaultSessionId) : null;
      if (boundWorkflowStart && !(context.externalActionTarget?.kind === 'machine' && context.externalActionTarget.project)) {
        const target = await resolveCliActionCallerWorkflowTarget({ context, credentials,
          boundSessionId: boundWorkflowStart,
          resolveTransportForSession: async (sessionId, signal) => {
            const serverFeaturesSnapshot = await resolveServerFeaturesSnapshotForCredentials(credentials);
            return await resolveSessionTransportContext({ reason: 'session-action', credentials, idOrPrefix: sessionId,
              ...(serverFeaturesSnapshot ? { serverFeaturesSnapshot } : {}), ...(signal ? { signal } : {}) });
          },
          ...(context.externalActionTarget ? { target: context.externalActionTarget } : {}),
        });
        if (!target) return { context,
          invocation: createOneShotPatInvocation(async () => actionFailure('target_unavailable')) };
        context = { ...context, externalActionTarget: target };
      }
      // Archive state belongs to Home. The archive service requests Stop only
      // when Home reports an active Session; an inactive record must remain
      // archivable after its worker grant or daemon has gone away.
      if (originalCliCaller && (actionId === 'session.archive' || actionId === 'session.unarchive')) return { context };
      const provenance = readAuthTokenProvenance(decodeJwtPayload(credentials.token), { allowLegacyHome: true });
      const ordinary = provenance?.provenance.kind === 'account' && provenance.provenance.authority === 'present_user'
        && context.authority !== 'account_automation';
      // A paired terminal uses its own daemon ingress when locally placed;
      // another selected Machine uses Home's named Session-start admission.
      // Both retain terminal policy and exact Machine admission.
      const pairedSessionCreation = actionId === 'session.spawn_new' && provenance?.provenance.kind === 'terminal'
        ? SessionSpawnNewActionInputV2Schema.safeParse(input) : null;
      // A standalone CLI has no UI reverse-dispatch connection. The own daemon
      // already owns client placement, Account binding and terminal policy.
      const settingsAction = isSettingsDeclarationActionIdV1(actionId);
      const settingsInput = settingsAction ? SettingsDeclarationActionInputSchemasV1[actionId].safeParse(input) : null;
      let admittedInput = settingsInput?.success ? settingsInput.data : input;
      const spec = getActionSpec(ActionIdSchema.parse(actionId));
      if (originalCliCaller && spec.cli?.wholeInputSchema) {
        // Raw Session Actions and prepared/signed-root dispatch use the same
        // terminal authoring admission as compiled whole-input CLI commands.
        const cliInput = spec.cli.wholeInputSchema.safeParse(admittedInput);
        if (!cliInput.success) return { context,
          invocation: createOneShotPatInvocation(async () => actionFailure('invalid_parameters')) };
        admittedInput = cliInput.data;
      }
      // A local profile is routing state of this CLI. Seal its declared Home
      // selector as the portable identity before another Machine stores/replays it.
      const selectedServerId = spec.invocationServerIdForInput?.(admittedInput);
      if (originalCliCaller && selectedServerId && context.serverIdentityId && selectedServerId === approvalServerId
        && readRecord(admittedInput)?.serverId === selectedServerId) {
        admittedInput = { ...readRecord(admittedInput), serverId: context.serverIdentityId };
      }
      // A show-once result needs the same live invocation that receives the
      // authenticated decision. The daemon already owns exact approval replay;
      // retaining this signed request there also retains its private return path.
      let liveResultCustody = spec.approvalResultCustody === 'live_only'
        && resolveActionApprovalFlow(spec.approval) === 'blocking';
      if (liveResultCustody && originalCliCaller && hasStoredSessionCredentialProvenance(credentials)
        && !params.externalActionClient) {
        // Only an implicit daemon hop depends on whether approval is needed.
        // Read the same credential-scoped policy and authority owners as the
        // executor; a confirmation alone cannot waive explicit Ask or elevate
        // an automation caller. Core admission still rechecks before effects.
        if (!params.actionsSettingsProvider) {
          await ensureCliActionPolicySettings(credentials, resolveActionServerApiUrl());
        }
        const policy = params.actionsSettingsProvider ?? createActionSettingsProvider({
          scopeKey: resolveAccountSettingsScopeKeyForToken(credentials.token),
        });
        const authority = context.authority === 'account_automation' ? 'account_automation' : resolveInvocationAuthority({
          credential: 'terminal', surface: 'cli',
        });
        liveResultCustody = resolveActionApprovalRouting({ actionId: spec.id, spec, input: admittedInput,
          settings: policy.getActionsSettings(), context: { ...context, surface: 'cli', authority } }).required;
      }
      const executionPlacement = resolveActionExecutionPlacementForInput(spec, admittedInput, context.actionCaller, context.surface ?? 'cli');
      // This invocation owns native answering-client custody; retain ordinary Action admission locally.
      if (originalCliCaller && params.externalActionClient && isMachineManagedInstallationActionIdV1(actionId)
        && executionPlacement === 'client') return { context, invocation: null };
      if (originalCliCaller && actionId === 'template.instantiate' && executionPlacement === 'account') {
        const parsed = BotTemplateInstantiateInputV1Schema.safeParse(admittedInput);
        if (!parsed.success) return { context,
          invocation: createOneShotPatInvocation(async () => actionFailure('invalid_parameters')) };
        const selected = resolveExternalActionMachineTarget({ actionId, rawInput: parsed.data,
          target: context.externalActionTarget ?? (params.machineId ? { kind: 'machine', machineId: params.machineId } : undefined),
          ownerMachineId: parsed.data.creation.executionTarget.machineId, context });
        if (selected.kind === 'rejected') return { context,
          invocation: createOneShotPatInvocation(async () => selected.execution) };
        const requestId = context.actionRequestId ?? randomUUID();
        const requesterContext = { ...context, actionRequestId: requestId };
        return { context: requesterContext, invocation: createOneShotPatInvocation(() => dispatchOriginalAccountAction({
          actionId, input: parsed.data, requestId, target: { kind: 'machine', machineId: parsed.data.creation.executionTarget.machineId },
          credentials, serverHttpBaseUrl: resolveActionServerApiUrl(), serverIdentityId: context.serverIdentityId ?? params.serverIdentityId,
          authority: context.authority, ...(context.signal ? { signal: context.signal } : {}),
          // The shared Account dispatcher admits the root; the ordinary executor
          // owns its local policy, source read, review and composed children.
          executeOnRequester: {
            input: { ...readRecord(spec.projectObservationInput?.(parsed.data) ?? parsed.data),
              creation: projectBotTemplateInstantiationRequesterInputV1(parsed.data).creation },
            run: async () => (await resolveExecutor(credentials)).execute(actionId, parsed.data, requesterContext),
          },
        })) };
      }
      if (originalCliCaller && actionId === 'machines.managed.acquire' && executionPlacement === 'account') {
        const invocation = readExternalActionRequesterInvocation({ ...context, surface: 'cli',
          authority: context.authority ?? 'account_automation' });
        if (!invocation) return { context,
          invocation: createOneShotPatInvocation(async () => actionFailure('admission_unavailable')) };
        const selected = await prepareOriginalAccountPresetAcquire({ actionId, input: admittedInput,
          requestId: context.actionRequestId ?? randomUUID(), credentials,
          serverHttpBaseUrl: resolveActionServerApiUrl(), serverIdentityId: context.serverIdentityId ?? params.serverIdentityId,
          invocation, authority: invocation.authority, ...(context.signal ? { signal: context.signal } : {}) });
        if (selected) return { context, invocation: createOneShotPatInvocation(selected) };
      }
      const pairedTerminal = originalCliCaller && provenance?.provenance.kind === 'terminal';
      let controlControllerTarget: Awaited<ReturnType<typeof resolveManagedControlControllerTarget>> = null;
      try {
        if (originalCliCaller) controlControllerTarget = await resolveManagedControlControllerTarget({
          actionId, rawInput: admittedInput, credentials, serverHttpBaseUrl: resolveActionServerApiUrl(),
          ...(context.signal ? { signal: context.signal } : {}),
        });
      } catch (error) {
        if (!(error instanceof ManagedMachineControllerError)) throw error;
        return { context, invocation: createOneShotPatInvocation(async () => ({
          ok: false, ...normalizeActionExecutorThrownError(error, actionId),
        })) };
      }
      const managedMachineDaemonIngress = requiresManagedMachineDaemonIngress(spec.id, executionPlacement, controlControllerTarget,
        ordinary || pairedTerminal ? admittedInput : undefined);
      const clientAction = spec.cli !== undefined && (!settingsAction || settingsInput?.success)
        && executionPlacement === 'client';
      const declaredDaemonIngress = hasDeclaredActionDaemonIngress(spec, 'cli');
      const allowsDaemonIngress = spec.originalExecution?.daemonIngressSurfaces === undefined || declaredDaemonIngress;
      // An external client's Machine-placed Action keeps its signed original
      // carrier; UI-only ingress declarations narrow Session delivery below.
      const selectedOriginalMachine = (requireDaemonIngress || params.externalActionClient || managedMachineDaemonIngress
        || spec.id === 'session.spawn_new' && requiresOriginalAccountMachineActionProof(spec.id, admittedInput, context)
        || declaredDaemonIngress)
        && (executionPlacement === 'machine' || controlControllerTarget !== null) && originalCliCaller
        ? resolveSelectedExternalActionMachineTarget({ actionId: spec.id, rawInput: admittedInput,
          target: context.externalActionTarget ?? controlControllerTarget ?? undefined, fallbackMachineId: params.machineId, context }) : null;
      if (selectedOriginalMachine && (selectedOriginalMachine.kind === 'rejected'
        || params.machineId && params.machineId !== selectedOriginalMachine.machineId)) return { context,
          invocation: createOneShotPatInvocation(async () => routingFailure(actionId,
            selectedOriginalMachine.kind === 'rejected' ? selectedOriginalMachine.execution : actionFailure('target_unavailable'))) };
      let requiresSessionDaemonAdmission = false;
      let sessionDispatch: Readonly<{
        sessionId: string;
        machineId: string;
        active: boolean;
      }> | null = null;
      // Reuse ingress's schema-admitted Session selector/placement owner. Group
      // selector intent stays with the executor rather than naming one publisher.
      const sessionPlaced = executionPlacement === 'session';
      const sessionDefault = readNonEmptyString(context.defaultSessionId);
      if (originalCliCaller && sessionDefault && sessionPlaced
        && !readRecord(admittedInput)?.sessionId) {
        const withDefault = { ...readRecord(admittedInput), sessionId: sessionDefault };
        if (spec.inputSchema.safeParse(withDefault).success) admittedInput = withDefault;
      }
      const reconciliation = reconcileExternalActionTarget({ actionId: spec.id, rawInput: admittedInput,
        target: context.externalActionTarget, currentMachineId: params.machineId ?? '', context });
      const sessionTarget = sessionPlaced && reconciliation.kind === 'ready' && reconciliation.target?.kind === 'session'
        ? reconciliation.target.sessionId : null;
      if (sessionTarget && originalCliCaller && !machineAdmissionTransport
        && allowsDaemonIngress
        && hasStoredSessionCredentialProvenance(credentials)) {
        const signal = combineInvocationSignals(invocationSignal, context.signal);
        const transport = await resolveSessionTransportContext({
          reason: 'session-action',
          credentials, idOrPrefix: sessionTarget,
          ...(signal ? { signal } : {}),
        });
        if (!transport.ok) return { context,
          invocation: createOneShotPatInvocation(async () => actionResolutionFailure(transport)) };
        // Session Actions enter their owning daemon. Protected message input
        // retains publisher custody; plain human sends retain HTTP Pending admission.
        requiresSessionDaemonAdmission = actionId !== 'session.message.send' || requiresMachineAdmissionForSessionInput({
          request: buildTrustedHostSessionInputAdmissionV1(context.surface).request,
          mode: transport.mode,
        });
        if (requiresSessionDaemonAdmission) {
          const machineId = resolveSessionInputTargetMachineId({ rawSession: transport.rawSession,
            decryptedMetadata: tryDecryptSessionOwnerMetadataView({ credentials, rawSession: transport.rawSession,
              accountEncryptionMode: transport.accountEncryptionCurrentness.mode }),
            ...(params.machineId ? { targetMachineId: params.machineId } : {}),
          });
          const selectedTarget = context.externalActionTarget;
          if (!machineId || selectedTarget && (selectedTarget.kind === 'machine'
            ? selectedTarget.machineId !== machineId : selectedTarget.sessionId !== transport.sessionId)) {
            return { context, invocation: createOneShotPatInvocation(async () => actionFailure('target_unavailable')) };
          }
          sessionDispatch = {
            sessionId: transport.sessionId,
            machineId,
            active: transport.rawSession.active !== false,
          };
          // The resolved id must also reach receiver reconciliation and the
          // Action owner; routing a prefix while retaining it as an operand
          // would disagree with the exact Session target at the destination.
          if (readRecord(admittedInput)?.sessionId === sessionTarget) {
            admittedInput = { ...readRecord(admittedInput), sessionId: transport.sessionId };
          }
        }
      }
      let workspaceMachineId: string | undefined;
      if (originalCliCaller && (actionId === 'projects.service.relocate' || actionId === 'deployments.prepare')) {
        const relocated = actionId === 'projects.service.relocate' ? ProjectServiceRelocateInputV1Schema.safeParse(input) : null;
        const prepared = actionId === 'deployments.prepare' ? DeploymentPrepareInputV1Schema.safeParse(input) : null;
        const workspace = relocated?.success ? { serverId: relocated.data.workspace.serverId, id: relocated.data.workspace.refId }
          : prepared?.success ? prepared.data.workspace : null;
        if (!workspace) return { context, invocation: createOneShotPatInvocation(async () => actionFailure('invalid_parameters')) };
        const signal = combineInvocationSignals(invocationSignal, context.signal);
        const source = await resolveAccountWorkspaceMachine({ credentials, workspace, serverId: approvalServerId,
          ...(context.serverIdentityId ?? params.serverIdentityId
            ? { serverIdentityId: context.serverIdentityId ?? params.serverIdentityId } : {}),
          serverApiUrl: resolveActionServerApiUrl(), ...(signal ? { signal } : {}) });
        if (!source.ok) return { context, invocation: createOneShotPatInvocation(async () => actionResolutionFailure(source)) };
        const captured = context.externalActionTarget;
        if (params.machineId && params.machineId !== source.machineId
          || captured && (captured.kind !== 'machine' || captured.machineId !== source.machineId)) {
          return { context, invocation: createOneShotPatInvocation(async () => actionFailure('target_unavailable')) };
        }
        workspaceMachineId = source.machineId;
      }
      // A semantic Machine selector needs the same admitted delivery as an
      // outer CLI selector, even for Machine-placed friendly commands.
      const usesDaemonIngress = params.externalActionClient && allowsDaemonIngress || managedMachineDaemonIngress || Boolean(boundWorkflowStart) || requiresSessionDaemonAdmission
        || selectedOriginalMachine?.kind === 'ready' || workspaceMachineId !== undefined || liveResultCustody || requireDaemonIngress || declaredDaemonIngress;
      const originalDaemonTarget = usesDaemonIngress && originalCliCaller
        ? await (await import('@/daemon/multiDaemon')).resolveLiveDaemonControlTargetForServer(
          fixedServerId ?? approvalServerId,
        ).catch(() => null)
        : undefined;
      const ownDaemon = originalDaemonTarget?.accountId
        && originalDaemonTarget.accountId === readAccountIdFromToken(credentials.token);
      const originalContext = context;
      const originalMachineSetup = actionId === 'machines.setup.apply' && originalCliCaller
        ? MachineSetupApplyInputV1Schema.safeParse(input) : null;
      if (originalMachineSetup && (!originalMachineSetup.success
        || originalMachineSetup.data.homeId !== context.serverIdentityId)) return { context: originalContext,
          invocation: createOneShotPatInvocation(async () => actionFailure('target_unavailable')) };
      const liveResultMachineId = liveResultCustody && originalCliCaller
        && hasStoredSessionCredentialProvenance(credentials) && !ownDaemon
        && !params.machineId && !context.externalActionTarget && !workspaceMachineId
        && selectedOriginalMachine?.kind !== 'ready'
        ? await resolveCurrentAccountAdministrationMachine({ token: credentials.token,
          serverHttpBaseUrl: resolveActionServerApiUrl(),
          signal: combineInvocationSignals(invocationSignal, context.signal) }) : null;
      const originalMachineTarget = workspaceMachineId !== undefined || sessionDispatch !== null || selectedOriginalMachine?.kind === 'ready' || (context.externalActionTarget
        ? context.externalActionTarget.kind === 'machine' : Boolean(params.machineId || liveResultMachineId));
      const ownManagedNativeIngress = (ordinary || pairedTerminal) && managedMachineDaemonIngress && executionPlacement === 'account'
        && !controlControllerTarget && !originalMachineTarget;
      if (ownManagedNativeIngress && !ownDaemon) return { context: originalContext,
          invocation: createOneShotPatInvocation(async () => ({ ok: false, errorCode: 'daemon_unavailable',
            error: 'No daemon is running for this Account and Home.', effectAttempted: false,
            details: { phase: 'managed_machine_daemon_ingress',
              remedy: 'Start a daemon using this CLI identity and Home, then retry.' } })) };
      if (originalCliCaller && hasStoredSessionCredentialProvenance(credentials) && executionPlacement === 'machine'
        && deploymentPreparationOperationForActionV1(spec.id) === 'create' && !ownDaemon && !originalMachineTarget) {
        const configuredTarget = await resolveConfiguredMachineTarget();
        const machineId = configuredTarget?.kind === 'machine' ? configuredTarget.machineId : undefined;
        return { context: originalContext, invocation: createOneShotPatInvocation(async () => ({
          ok: false, errorCode: 'daemon_unavailable', effectAttempted: false,
          error: `${machineId ? `Machine ${machineId}` : 'This CLI Machine'} has no running daemon for this Account and server. Select a running Machine with --machine-id <machineId>.`,
          ...(machineId ? { details: { machineId } } : {}),
        })) };
      }
      if (liveResultCustody && originalCliCaller && hasStoredSessionCredentialProvenance(credentials)
        && !ownDaemon && !originalMachineTarget) return { context: originalContext,
          invocation: createOneShotPatInvocation(async () => actionFailure('daemon_unavailable')) };
      const originalFiniteProjectAction = Object.hasOwn(PROJECT_FINITE_ACTION_RPC_METHODS_V1, actionId) && originalCliCaller;
      if (usesDaemonIngress && hasStoredSessionCredentialProvenance(credentials)
        && originalCliCaller && (!settingsAction || clientAction && (ownDaemon || originalMachineTarget))
        && (ordinary || pairedSessionCreation?.success || (pairedTerminal && ownDaemon) || originalMachineTarget || actionId === 'projects.service.relocate')
        && !mountedFilesystemCopy && !originalFiniteProjectAction) {
        const parsedActionId = SignedRootActionIdSchema.safeParse(actionId);
        if (!parsedActionId.success) return { context: originalContext,
          invocation: createOneShotPatInvocation(async () => actionFailure('unsupported')) };
        const signal = combineInvocationSignals(invocationSignal, context?.signal);
        const executeApprovalAction = async (...args: Parameters<ReturnType<typeof createCliActionExecutor>['execute']>) => {
          // A fresh deciding-person invocation owns its Account custody. Bootstrap
          // before the lazy executor captures it, as ordinary CLI execution does.
          if (!params.actionsSettingsProvider && !args[2]?.externalActionExecutionAuthorization) {
            await ensureCliActionPolicySettings(credentials, resolveActionServerApiUrl());
          }
          return (await resolveExecutor(credentials)).execute(...args);
        };
        // A deployment read is minted for the Machine its admission names, wherever this CLI runs.
        const readReceiverMachineId = readDeploymentReadReceiverMachineId(actionId, admittedInput);
        let target = context?.externalActionTarget
          ?? (readReceiverMachineId ? { kind: 'machine' as const, machineId: readReceiverMachineId } : undefined)
          ?? (params.machineId ? { kind: 'machine' as const, machineId: params.machineId } : undefined)
          ?? (liveResultMachineId ? { kind: 'machine' as const, machineId: liveResultMachineId } : undefined)
          ?? (selectedOriginalMachine?.kind === 'ready'
            ? { kind: 'machine' as const, machineId: selectedOriginalMachine.machineId } : undefined)
          ?? (workspaceMachineId ? { kind: 'machine' as const, machineId: workspaceMachineId } : undefined);
        if (sessionDispatch) {
          // Message input uses its live publisher or the Machine enqueue/resume
          // path. Other Session Actions enter the owning Machine's executor.
          target = actionId === 'session.message.send' ? resolveProtectedSessionInputActionTarget(sessionDispatch)
            : { kind: 'machine', machineId: sessionDispatch.machineId };
        }
        if (originalMachineSetup?.success) {
          if (target && (target.kind !== 'machine' || target.machineId !== originalMachineSetup.data.machineId)) return { context: originalContext,
            invocation: createOneShotPatInvocation(async () => actionFailure('target_unavailable')) };
          target ??= { kind: 'machine', machineId: originalMachineSetup.data.machineId };
        }
        // Public V2 already names the Machine. Keep the same exact Account /
        // publication check when the caller omits the optional outer flag.
        if (!target && pairedSessionCreation?.success) {
          target = { kind: 'machine', machineId: pairedSessionCreation.data.executionTarget.machineId };
        }
        const daemonControlTarget = originalDaemonTarget;
        if (!target && !ownManagedNativeIngress && requiresOriginalAccountMachineActionProof(parsedActionId.data, admittedInput, context)
          && ownDaemon && daemonControlTarget?.machineId) {
          target = { kind: 'machine', machineId: daemonControlTarget.machineId };
        }
        return { context: originalContext, invocation: createOneShotPatInvocation(async () => {
          // Preparation captured the credential used by every receiving call.
          if (signal?.aborted) return actionFailure('cancelled');
          if (sessionDispatch && target?.kind === 'session') {
            try {
              return await dispatchOriginalAccountAction({ actionId: parsedActionId.data,
                input: { ...readRecord(admittedInput), sessionId: sessionDispatch.sessionId },
                requestId: context.actionRequestId ?? randomUUID(), target, credentials,
                serverHttpBaseUrl: resolveActionServerApiUrl(), serverIdentityId: context.serverIdentityId,
                ...(originalContext.authority ? { authority: originalContext.authority } : {}),
                ...(signal ? { signal } : {}) });
            } catch { return actionFailure(signal?.aborted ? 'cancelled' : 'target_unavailable'); }
          }
          if (target?.kind === 'machine') {
            // Home's API URL need not be the daemon's control URL. Preserve
            // the fixed-Home publication's own Account/Machine offline dispatcher.
            const { resolveLiveDaemonExternalActionEndpoint } = await import('@/daemon/multiDaemon');
            const localEndpoint = await resolveLiveDaemonExternalActionEndpoint(resolveActionServerApiUrl()).catch(() => null);
            const accountId = readAccountIdFromToken(credentials.token);
            const localPublication = daemonControlTarget ?? localEndpoint;
            const ownLocal = (ordinary || pairedTerminal) && accountId && localPublication?.machineId === target.machineId
              && localPublication.accountId === accountId;
            if (!ownLocal || requiresOriginalAccountMachineActionProof(parsedActionId.data, admittedInput, context)) {
              try {
                if (requiresOriginalAccountMachineActionProof(parsedActionId.data, admittedInput, context)) {
                  if (!params.actionsSettingsProvider) await ensureCliActionPolicySettings(credentials, resolveActionServerApiUrl());
                  const policy = params.actionsSettingsProvider ?? createActionSettingsProvider({
                    scopeKey: resolveAccountSettingsScopeKeyForToken(credentials.token),
                  });
                  const settings = policy.getActionsSettings();
                  if (!isActionEnabledByActionsSettings(parsedActionId.data, settings, { surface: 'cli', placement: context.placement ?? null })) {
                    return actionFailure('action_disabled');
                  }
                  if (isUnpreservableOriginalCliApproval(parsedActionId.data, admittedInput, originalContext, settings, policy)) {
                    return actionFailure('approval_context_unavailable');
                  }
                }
                const requestId = context.actionRequestId ?? randomUUID();
                const requesterTarget = target;
                const invocation = accountId ? projectExternalActionRequesterInvocationV1({
                  actionId: parsedActionId.data,
                  context: { ...originalContext, actionCaller: { kind: 'host' }, surface: 'cli',
                    // Stored CLI credentials establish presence before sealing;
                    // the canonical projector retains their exact host review.
                    authority: originalContext.authority ?? resolveInvocationAuthority({ credential: 'terminal', surface: 'cli' }) },
                  account: { accountId, serverId: approvalServerId,
                    ...(context.serverIdentityId ? { serverIdentityId: context.serverIdentityId } : {}) },
                  target: requesterTarget, authentication: { kind: pairedTerminal ? 'terminal' : 'account' },
                }) : null;
                if (!invocation) return actionFailure('admission_unavailable');
                const run = (requestSignal?: AbortSignal) => dispatchOriginalAccountAction({ actionId: parsedActionId.data, input: admittedInput,
                  requestId, target: requesterTarget, credentials,
                  serverHttpBaseUrl: resolveActionServerApiUrl(), serverIdentityId: context.serverIdentityId,
                  invocation,
                  // Accepted legacy publications omit Account identity. Keep their
                  // incumbent own-target bridge while Home still admits foreign work.
                  ...(ordinary && localPublication && !localPublication.accountId ? { foreignTargetOnly: true as const } : {}),
                  ...(originalContext.authority ? { authority: originalContext.authority } : {}),
                  ...(params.onRequesterSessionCredentialDisclosure
                    ? { onRequesterSessionCredentialDisclosure: params.onRequesterSessionCredentialDisclosure } : {}),
                  ...(requestSignal ? { signal: requestSignal } : {}) });
                const requester = params.onApprovalRequested && accountId && context.serverIdentityId
                  ? await executeOriginalAccountCliApprovalRequest({ actionId: parsedActionId.data, requestId,
                    target: requesterTarget, accountId, homeId: context.serverIdentityId,
                    token: credentials.token, serverHttpBaseUrl: resolveActionServerApiUrl(),
                    onApprovalRequested: params.onApprovalRequested,
                    execute: executeApprovalAction,
                    context: signal ? { ...context, signal } : context, run })
                  : await run(signal);
                if (requester) return await consumeDeferredCliApprovalResult(requester, { onApprovalRequested: params.onApprovalRequested,
                  token: credentials.token, serverHttpBaseUrl: resolveActionServerApiUrl(),
                  execute: executeApprovalAction,
                  context: signal ? { ...context, signal } : context });
              } catch { return actionFailure(signal?.aborted ? 'cancelled' : 'target_unavailable'); }
            }
          }
          if (fixedServerId && !daemonControlTarget) return actionFailure('daemon_unavailable');
          const { requestDaemonSignedRootActionExecution } = await import('@/daemon/controlClient');
          if (signal?.aborted) return actionFailure('cancelled');
          const run = (requestSignal?: AbortSignal,
            onApprovalRequested?: (approval: ActionApprovalRequestCreatedResult) => void) => requestDaemonSignedRootActionExecution({
            actionId: parsedActionId.data,
            input: admittedInput,
            ...(target ? { target } : {}),
            ...(context?.actionRequestId ? { actionRequestId: context.actionRequestId } : {}),
          }, {
            signal: requestSignal,
            ...(onApprovalRequested ? { onApprovalRequested } : {}),
            ...(liveResultCustody || params.onApprovalRequested ? { timeoutMs: null } : {}),
            ...(daemonControlTarget ? { target: daemonControlTarget } : {}),
            ...(pairedTerminal && context.authority === 'account_automation'
              ? { authorityCeiling: 'account_automation' as const }
              : {}),
          });
          const result = params.onApprovalRequested
            ? await executeLiveCliApprovalRequest({ onApprovalRequested: params.onApprovalRequested,
              execute: executeApprovalAction,
              context: signal ? { ...context, signal } : context, run })
            : await run(signal);
          return await consumeDeferredCliApprovalResult(result, { onApprovalRequested: params.onApprovalRequested,
            token: credentials.token, serverHttpBaseUrl: resolveActionServerApiUrl(),
            execute: executeApprovalAction,
            context: signal ? { ...context, signal } : context });
        }) };
      }
      return { context: originalContext, invocation: null };
    };
    return bindExecutorToActionServer({
      observeRecordedApprovalExecution: async args => {
        const selection = await readApprovalReplayCredentials(args.expectedOrigin.accountId);
        if (!selection.ok) return selection;
        const { credentials } = selection;
        const executor = await resolveExecutor(credentials);
        const signal = combineInvocationSignals(invocationSignal, args.signal) ?? args.signal;
        return await executor.observeRecordedApprovalExecution({ ...args, signal });
      },
      prepare: async (...args) => {
        const listAccessFailure = resolveActionSessionListAccessFailure(args[0], args[2]);
        if (listAccessFailure) return { kind: 'settled' as const, result: listAccessFailure };
        const selection = args[0] === 'approval.request.decide'
          ? await readApprovalReplayCredentials(args[2]?.runtimeAccountId) : null;
        if (selection && !selection.ok) return { kind: 'settled' as const, result: selection };
        const credentials = selection?.ok ? selection.credentials : await readCurrentCredentials();
        if (!credentials) {
          return {
            kind: 'settled' as const,
            result: { ok: false as const, errorCode: 'not_authenticated', error: 'not_authenticated' },
          };
        }
        const [actionId, input, rawContext] = args;
        if (params.providerPreparedSavedSecret && shouldUsePatPublicActionTransport(credentials, rawContext)) {
          // The public relay admits serialized operands, not this invocation's
          // private prompted material. Never turn its reference into a detached write.
          return { kind: 'settled' as const, result: actionFailure('private_action_preparation_transport_unsupported') };
        }
        const preferenceFailure = await originationPreferenceFailure(actionId, credentials, rawContext);
        if (preferenceFailure) return { kind: 'settled' as const, result: preferenceFailure };
        if (shouldUsePatPublicActionTransport(credentials, rawContext)) {
          const plan = await resolvePatActionTransportPlan({
            actionId,
            input,
            context: rawContext,
            credentials,
            ...(params.machineId !== undefined ? { machineId: params.machineId } : {}),
            ...(invocationSignal ? { invocationSignal } : {}),
            serverId: approvalServerId,
            ...(params.serverIdentityId ? { serverIdentityId: params.serverIdentityId } : {}),
            serverApiUrl: resolveActionServerApiUrl(),
            allowConfiguredMachineTarget: fixedServerId === null,
          });
          if (plan.kind === 'settled') {
            return { kind: 'settled' as const, result: plan.result };
          }
          return {
            kind: 'ready' as const,
            invocation: createOneShotPatInvocation(async () => await executePatPublicActionPlan({
              actionId,
              credentials,
              plan,
              context: rawContext,
              ...(invocationSignal ? { invocationSignal } : {}),
              serverApiUrl: resolveActionServerApiUrl(),
            })),
          };
        }
        const routing = await resolveInvocationRoutingContext(rawContext, credentials, actionId);
        const signal = combineInvocationSignals(invocationSignal, routing.context?.signal);
        let context = signal ? { ...routing.context, signal } : routing.context;
        const prepared = await prepareOriginalCliActionInvocation(actionId, input, context, credentials);
        if (prepared.invocation) return { kind: 'ready' as const, invocation: prepared.invocation };
        context = prepared.context;
        // An explicitly supplied policy provider is already the admitted
        // principal's policy authority. Do not widen it by bootstrapping
        // ambient Account settings before execution.
        if (
          !params.actionsSettingsProvider
          && !context?.externalActionExecutionAuthorization
          && actionId !== 'machines.managed.acquire'
        ) {
          await measureActionStartPhaseV1(context, 'account_settings',
            () => runTracedExternalActionInnerStage('cli.account_settings',
              () => ensureCliActionPolicySettings(credentials, resolveActionServerApiUrl())));
        }
        const executor = await resolveExecutor(credentials, undefined, routing);
        return await executor.prepare(actionId, input, context);
      },
      execute: async (...args) => withApprovalActionTrace(args[0], () => timeApprovalPhase<ActionExecuteResult>('approval.execute', async () => {
        const listAccessFailure = resolveActionSessionListAccessFailure(args[0], args[2]);
        if (listAccessFailure) return listAccessFailure;
        const [actionId, input, rawContext] = args;
        const trace = <T>(stage: string, operation: () => T | Promise<T>) => rawContext?.actionRequestId
          ? runTracedExternalActionStage(actionId, rawContext.actionRequestId, stage, operation)
          : runTracedExternalActionInnerStage(stage, operation);
        const selection = actionId === 'approval.request.decide'
          ? await trace('cli.credentials', () => readApprovalReplayCredentials(rawContext?.runtimeAccountId)) : null;
        if (selection && !selection.ok) return selection;
        const credentials = selection?.ok ? selection.credentials : await trace('cli.credentials', readCurrentCredentials);
        if (!credentials) {
          return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
        }
        if (params.providerPreparedSavedSecret && shouldUsePatPublicActionTransport(credentials, rawContext)) {
          return actionFailure('private_action_preparation_transport_unsupported');
        }
        const preferenceFailure = await trace('cli.origination_preference', () => originationPreferenceFailure(actionId, credentials, rawContext));
        if (preferenceFailure) return preferenceFailure;
        if (shouldUsePatPublicActionTransport(credentials, rawContext)) {
          return await executePatPublicAction({
            actionId,
            input,
            context: rawContext,
            credentials,
            ...(params.machineId !== undefined ? { machineId: params.machineId } : {}),
            ...(invocationSignal ? { invocationSignal } : {}),
            serverId: approvalServerId,
            ...(params.serverIdentityId ? { serverIdentityId: params.serverIdentityId } : {}),
            serverApiUrl: resolveActionServerApiUrl(),
            allowConfiguredMachineTarget: fixedServerId === null,
          });
        }
        const routing = await trace('cli.approval_context', () => resolveInvocationRoutingContext(rawContext, credentials, actionId));
        const context = routing.context;
        const { context: originalContext, invocation } = await trace('cli.original_invocation', () => prepareOriginalCliActionInvocation(actionId, input, context, credentials));
        if (invocation) return await invocation.run();
        const signal = combineInvocationSignals(invocationSignal, context?.signal);
        let sessionMemoryEnabled: boolean | undefined;
        const catalogSessionId = readNonEmptyString(context?.defaultSessionId);
        if (params.pluginActionExecutionOwner === 'current_process' && context?.surface === 'agent'
          && catalogSessionId && (actionId === 'action.spec.get' || actionId === 'action.spec.search')) {
          const { createCliBoundSessionMetadataReader } = await import('./resolveCliActionCallerSession');
          // A reader belongs to one invocation: its preparation-local cache must
          // never turn a daemon's long-lived catalog into a stale Session policy.
          const ctx = resolveSessionEncryptionContextFromCredentials(credentials);
          const readMetadata = createCliBoundSessionMetadataReader({
            credentials, token: credentials.token, sessionId: catalogSessionId,
            ...(ctx ? { mode: 'e2ee' as const, ctx } : { mode: 'plain' as const, ctx: null }),
            resolveTransportForSession: (sessionId) => resolveSessionTransportContext({
              reason: 'session-action',
              credentials, idOrPrefix: sessionId, ...(signal ? { signal } : {}),
            }),
          });
          const metadata = await readMetadata();
          if (signal?.aborted) return actionFailure('cancelled');
          if (!metadata) return actionFailure('target_unavailable');
          sessionMemoryEnabled = readSessionMemoryEnabledV1(metadata);
        }
        if (
          !params.actionsSettingsProvider
          && !context?.externalActionExecutionAuthorization
          && actionId !== 'machines.managed.acquire'
        ) {
          await measureActionStartPhaseV1(context, 'account_settings',
            () => runTracedExternalActionInnerStage('cli.account_settings',
              () => ensureCliActionPolicySettings(credentials, resolveActionServerApiUrl())));
        }
        const executor = await measureActionStartPhaseV1(originalContext, 'credentialed_factory',
          () => resolveExecutor(credentials, sessionMemoryEnabled, routing));
        return await executor.execute(actionId, input, {
          ...originalContext,
          ...(params.machineId && !originalContext?.executionRunTargetMachineId
            ? { executionRunTargetMachineId: params.machineId } : {}),
          ...(signal ? { signal } : {}),
        });
      }), undefined, args[2]?.actionRequestId),
      continueConfidentialApprovalRequest: async (input, context) => {
        const selection = await readApprovalReplayCredentials(context?.runtimeAccountId);
        if (!selection.ok) return selection;
        const { credentials } = selection;
        const signal = combineInvocationSignals(invocationSignal, context?.signal);
        const routing = await resolveInvocationRoutingContext(
          // The receiver's bound or authenticated Home identity admits a private
          // claim; an invocation context cannot substitute another Home's stamp.
          { ...context, ...(signal ? { signal } : {}), serverIdentityId: params.serverIdentityId },
          credentials,
        );
        const executor = await resolveExecutor(credentials, undefined, routing);
        return await executor.continueConfidentialApprovalRequest(input, routing.context);
      },
      replayApprovedApprovalRequest: async (args, machineIngress) => withApprovalActionTrace('approval.request.decide', () => timeApprovalPhase('approval.replay', async () => {
        const selection = await timeApprovalPhase('approval.replay.credentials', readApprovalReplayCredentials);
        if (!selection.ok) return selection;
        const { credentials } = selection;
        const executor = await timeApprovalPhase('approval.replay.executor', () => resolveExecutor(credentials));
        const signal = combineInvocationSignals(invocationSignal, args.signal);
        return await executor.replayApprovedApprovalRequest({
          ...args,
          ...(signal ? { signal } : {}),
        }, machineIngress);
      }), args.artifactId),
    });
  };

  const executor = createCredentialRefreshingExecutor(createFollowLeaseRegistry());
  const resolveSessionTarget = async (idOrPrefix: string): Promise<CliActionSessionTarget> =>
    await runWithActionServer(async () => {
      const credentials = await readCurrentCredentials();
      if (!credentials) {
        return { ok: false, code: 'not_authenticated' };
      }
      // A canonical ID needs no selector or stored-content read. The receiving
      // Action owns current access and effect authorization, including Stop
      // when Account encryption material is unavailable.
      const sessionId = idOrPrefix.trim();
      if (isFullSessionId(sessionId)) return { ok: true, sessionId };
      if (shouldUsePatPublicActionTransport(credentials, { surface: 'cli' })) {
        return await resolvePatSessionTarget({
          credentials,
          idOrPrefix,
          ...(params.machineId !== undefined ? { machineId: params.machineId } : {}),
          serverApiUrl: resolveActionServerApiUrl(),
          allowConfiguredMachineTarget: fixedServerId === null,
        });
      }
      const serverFeaturesSnapshot = await resolveServerFeaturesSnapshotForCredentials(credentials);
      const resolved = await resolveSessionTransportContext({
        reason: 'session-action',
        credentials,
        idOrPrefix,
        ...(serverFeaturesSnapshot ? { serverFeaturesSnapshot } : {}),
      });
      return resolved.ok
        ? { ok: true, sessionId: resolved.sessionId }
        : {
            ok: false,
            code: resolved.code,
            ...(resolved.candidates ? { candidates: resolved.candidates } : {}),
          };
    });
  return Object.freeze({
    ...executor,
    resolveSessionTarget,
    async resolveMachineTarget() {
      return await runWithActionServer(async () => {
        const credentials = await readCurrentCredentials();
        if (!credentials) return { ok: false as const, code: 'not_authenticated' };
        return await resolvePatMachineTarget({
          credentials,
          ...(params.machineId !== undefined ? { requestedMachineId: params.machineId } : {}),
          serverApiUrl: resolveActionServerApiUrl(),
          allowConfiguredMachineTarget: fixedServerId === null,
        });
      });
    },
    bindInvocation(signal: AbortSignal, approvalLifetime?: ActionExecutorDeps['hostActionApprovalLifetime']) {
      if (params.transcriptFollowLeaseRegistry) {
        return createCredentialRefreshingExecutor(params.transcriptFollowLeaseRegistry, signal, approvalLifetime);
      }
      const transcriptFollowLeaseRegistry = createFollowLeaseRegistry();
      const dispose = (): void => {
        void transcriptFollowLeaseRegistry.dispose().catch(() => undefined);
      };
      if (signal.aborted) dispose();
      else signal.addEventListener('abort', dispose, { once: true });
      return createCredentialRefreshingExecutor(transcriptFollowLeaseRegistry, signal, approvalLifetime);
    },
  });
}

/** Public caller ingress; concrete byte drivers alone consume the private transport core. */
export type DeploymentChildFilesystemActionRequest = Readonly<{
  actionId: 'daemon.filesystem.copy'; input: unknown; context: ActionExecutorContext; assertCurrent(): Promise<void>;
  archiveOrigin: Readonly<{ environmentId: string; deploymentId: string; holderMachineId: string; holderInstallationId: string }>;
}>;
type DeploymentChildFilesystemExecutor = Readonly<{
  executeDeploymentChildFilesystemAction(request: DeploymentChildFilesystemActionRequest): Promise<ActionExecuteResult>;
}>;

export function createCliActionExecutorFromCredentials(params: Parameters<typeof createCliActionExecutionCoreFromCredentials>[0]): ReturnType<typeof createCliActionExecutionCoreFromCredentials> & DeploymentChildFilesystemExecutor {
  const core = createCliActionExecutionCoreFromCredentials(params);
  const { enrichApprovalRoutingContext } = createApprovalRoutingContext(
    params,
    params.serverId?.trim() ?? null,
    params.serverApiUrl ? normalizeServerHttpBaseUrl(params.serverApiUrl.trim()) : resolveServerHttpBaseUrl(),
  );
  const wrap = (executor: CliActionExecutor, invocationSignal?: AbortSignal): CliActionExecutor & DeploymentChildFilesystemExecutor => {
    const prepareConcreteCopy = async (input: unknown, context: ActionExecutorContext | undefined, deploymentAdmission?: Readonly<{
      assertCurrent(): Promise<void>; archiveOrigin: DeploymentChildFilesystemActionRequest['archiveOrigin'];
    }>) => {
      const copy = FilesystemPreparedCopyInputSchema.safeParse(input);
      const targetCopy = copy.success ? null : FilesystemTargetCopyInputSchema.safeParse(input);
      const parsed = copy.success ? copy.data : targetCopy?.success ? targetCopy.data : null;
      if (!parsed) return null;
      if (parsed.kind === 'prepared_transfer' && parsed.source.kind === 'entry_tree') {
        return { failure: actionFailure('filesystem_transfer_custody_required') };
      }
      const signal = combineInvocationSignals(invocationSignal, context?.signal);
      try {
        signal?.throwIfAborted();
        const outerCredentials = params.readCredentials ? await params.readCredentials() : params.credentials;
        if (!outerCredentials) return { failure: actionFailure('not_authenticated') };
        const pat = !deploymentAdmission && shouldUsePatPublicActionTransport(outerCredentials, context);
        if (pat && parsed.kind === 'target_copy') {
          return { failure: actionFailure('filesystem_transfer_custody_required') };
        }
        if ((params.serverId && !await isServerProfileHomeIdentity(params.serverId, parsed.destination.serverId))
          || (context?.serverId && !await isServerProfileHomeIdentity(context.serverId, parsed.destination.serverId))
          || (params.machineId && params.machineId !== parsed.destination.machineId)
          || (context?.externalActionTarget && (context.externalActionTarget.kind !== 'machine'
            || context.externalActionTarget.machineId !== parsed.destination.machineId))) return { failure: actionFailure('target_unavailable') };
        const resolveHome = async (serverId: string, capturedCredentials?: StoredCredentials) => {
          const target = await resolveActionCliCredentialTarget({ requestedServerId: serverId,
            deps: { readCredentialsFn: async () => null,
              readCredentialsForServerIdFn: capturedCredentials ? async () => capturedCredentials : readStoredCredentialsForServerId,
              getServerProfileFn: getServerProfile } });
          const fixedServer = target.fixedServer;
          if (!target.credentials || !fixedServer || !areServerProfileIdentifiersEquivalent(fixedServer.serverId, serverId,
            identifier => identifier === fixedServer.serverId || identifier === fixedServer.serverIdentityId
              ? fixedServer.serverIdentityId ?? fixedServer.serverId : null)) throw new Error('Exact copy Home credentials are unavailable');
          return { credentials: target.credentials, ...fixedServer };
        };
        // Capture local custody before policy/approval awaits; the effect never
        // resolves a replacement Account after the containing Action is admitted.
        const destinationHomePromise = resolveHome(parsed.destination.serverId, outerCredentials);
        const [sourceHome, destinationHome] = await Promise.all([
          await isServerProfileHomeIdentity(parsed.source.serverId, parsed.destination.serverId) ? destinationHomePromise : resolveHome(parsed.source.serverId),
          destinationHomePromise,
        ]);
        const matchesCapturedHome = (home: typeof sourceHome, serverId: string | null | undefined) =>
          areServerProfileIdentifiersEquivalent(home.serverId, serverId,
            identifier => identifier === home.serverId || identifier === home.serverIdentityId ? home.serverIdentityId ?? home.serverId : null);
        if (params.serverApiUrl && normalizeServerHttpBaseUrl(params.serverApiUrl) !== normalizeServerHttpBaseUrl(destinationHome.serverApiUrl)) {
          return { failure: actionFailure('not_authenticated') };
        }
        const assertCurrent = async () => {
          signal?.throwIfAborted();
          await deploymentAdmission?.assertCurrent();
        };
        const currentCredentialsFor = (home: typeof sourceHome) => async () => {
          await assertCurrent();
          return home.credentials;
        };
        const concreteContext: ActionExecutorContext = { ...context, serverId: destinationHome.serverId,
          externalActionTarget: { kind: 'machine', machineId: parsed.destination.machineId }, ...(signal ? { signal } : {}) };
        const run = async (admittedContext: ActionExecutorContext): Promise<ActionExecuteResult> => {
          const signal = combineInvocationSignals(invocationSignal, context?.signal);
          let sourceTransport: Awaited<ReturnType<typeof createCredentialedFilesystemTransferClient>> | undefined;
          let destinationTransport: Awaited<ReturnType<typeof createCredentialedFilesystemTransferClient>> | undefined;
          let preparedAdmission: Extract<ReturnType<typeof FilesystemUploadOutputSchema.parse>, { success: true; status: 'accepted' }> | undefined;
          try {
            await assertCurrent();
            const [{ createCredentialedFilesystemTransferClient }, { createPreparedFilesystemTransferClient }] = await Promise.all([
              import('@/machines/transfer/createCredentialedFilesystemTransferClient'),
              import('@/machines/transfer/preparedFilesystemTransferClient'),
            ]);
            const invoke = (home: typeof sourceHome, machineId: string): Parameters<typeof createPreparedFilesystemTransferClient>[0]['executeAction'] => async (id, value, targetContext) => {
              await assertCurrent();
              if (deploymentAdmission && id !== 'daemon.filesystem.download' && id !== 'daemon.filesystem.copy'
                && id !== 'action.operations.get') return actionFailure('action_forbidden');
              if (!matchesCapturedHome(home, targetContext.serverId) || targetContext.externalActionTarget?.kind !== 'machine'
                || targetContext.externalActionTarget.machineId !== machineId) return actionFailure('target_unavailable');
              const endpointContext = { ...(deploymentAdmission ? admittedContext : {}), ...targetContext,
                ...(admittedContext.surface ? { surface: admittedContext.surface } : {}), ...(admittedContext.authority ? { authority: admittedContext.authority } : {}),
                ...(admittedContext.actionRequestId ? { actionRequestId: admittedContext.actionRequestId } : {}) };
              let result: ActionExecuteResult;
              if (!deploymentAdmission && shouldUsePatPublicActionTransport(home.credentials, endpointContext)) {
                const endpointExecutor = createCliActionExecutionCoreFromCredentials({ ...home, machineId,
                  readCredentials: currentCredentialsFor(home) });
                result = await endpointExecutor.execute(id, value, endpointContext);
              } else {
                const invokePhase = async (method: string, payload: unknown) => callExactMachineRpc({ credentials: home.credentials, serverUrl: home.serverApiUrl,
                  machineId, method, request: payload,
                  requireCurrentMachine: true, timeoutMs: null,
                  ...(deploymentAdmission && params.externalActionMachineInstallationId && params.externalActionMachineRequestPrivateKey
                    ? { externalAction: { context: { ...endpointContext,
                        externalActionTarget: endpointContext.externalActionExecutionAuthorization?.binding.target }, effectActionId: id,
                        installationId: params.externalActionMachineInstallationId, privateKey: params.externalActionMachineRequestPrivateKey,
                        deploymentArchiveOrigin: deploymentAdmission.archiveOrigin } } : {}),
                  ...(admittedContext.authority === 'account_automation' ? { authorityCeiling: 'account_automation' as const } : {}),
                  ...(admittedContext.actionRequestId ? { requestId: admittedContext.actionRequestId } : {}), ...(signal ? { signal } : {}) });
                const method = getActionSpec(id).bindings?.rpcMethod;
                const response = id === 'action.operations.get'
                  ? await executeActionOperationActionV1({ actionId: id,
                      input: ActionOperationActionInputSchemasV1[id].parse(value), ...(signal ? { signal } : {}),
                      transport: ({ method, payload }) => invokePhase(method, payload) })
                  : method ? await invokePhase(method, createTargetedActionRpcRequestV1(value, { kind: 'machine', machineId }, admittedContext))
                    : actionFailure('unsupported');
                const failure = ActionExecuteFailureSchema.safeParse(response);
                result = failure.success ? failure.data : { ok: true, result: response };
              }
              await assertCurrent();
              return result;
            };
            const executeSource = invoke(sourceHome, parsed.source.machineId);
            const executeDestination = invoke(destinationHome, parsed.destination.machineId);
            const deploymentArchive = deploymentAdmission && params.machineId && params.externalActionMachineInstallationId
              && params.externalActionMachineRequestPrivateKey ? {
                context: { ...admittedContext, externalActionTarget: admittedContext.externalActionExecutionAuthorization?.binding.target },
                machineId: params.machineId, installationId: params.externalActionMachineInstallationId,
                privateKey: params.externalActionMachineRequestPrivateKey, archiveOrigin: deploymentAdmission.archiveOrigin, assertCurrent,
              } : undefined;
            if (pat) {
              // The existing API admits this exact prepared-file write once.
              // Deferred approval is preserved without preparing a source.
              const admission = await executeDestination('daemon.filesystem.copy', parsed, concreteContext);
              if (!admission.ok) return admission;
              if (ActionApprovalRequestCreatedResultSchema.safeParse(admission.result).success) return admission;
              const receipt = FilesystemUploadOutputSchema.parse(admission.result);
              if (!receipt.success || receipt.status !== 'accepted') return admission;
              preparedAdmission = receipt;
            }
            const client = createPreparedFilesystemTransferClient({
              openMachineTunnel: async request => {
                await assertCurrent();
                let transport: typeof sourceTransport;
                if (matchesCapturedHome(sourceHome, request.serverId) && request.targetMachineId === parsed.source.machineId) {
                  sourceTransport ??= await createCredentialedFilesystemTransferClient({ ...sourceHome, executeAction: executeSource,
                    ...(deploymentArchive ? { deploymentArchive } : {}), ...(signal ? { signal } : {}) });
                  transport = sourceTransport;
                } else if (matchesCapturedHome(destinationHome, request.serverId) && request.targetMachineId === parsed.destination.machineId) {
                  destinationTransport ??= await createCredentialedFilesystemTransferClient({ ...destinationHome, executeAction: executeDestination,
                    ...(deploymentArchive ? { deploymentArchive } : {}), ...(signal ? { signal } : {}) });
                  transport = destinationTransport;
                } else throw new Error('Copy endpoint is outside the captured operation');
                await assertCurrent();
                const tunnel = await transport.openMachineTunnel(request);
                try { await assertCurrent(); } catch (error) { await tunnel.close(); throw error; }
                return tunnel;
              },
              executeAction: async (id, value, targetContext) => {
                if (matchesCapturedHome(sourceHome, targetContext.serverId) && targetContext.externalActionTarget?.kind === 'machine'
                  && targetContext.externalActionTarget.machineId === parsed.source.machineId) return await executeSource(id, value, targetContext);
                if (matchesCapturedHome(destinationHome, targetContext.serverId) && targetContext.externalActionTarget?.kind === 'machine'
                  && targetContext.externalActionTarget.machineId === parsed.destination.machineId) return await executeDestination(id, value, targetContext);
                return actionFailure('target_unavailable');
              },
            });
            const result = await client.copy({ ...parsed, ...(preparedAdmission ? { preparedAdmission } : {}), ...(signal ? { signal } : {}) });
            const failureCause = readActionOutputDiagnostic(result)?.failureCause;
            return 'kind' in result || result.success ? { ok: true, result }
              : { ok: false, errorCode: result.errorCode ?? 'filesystem_transfer_failed', error: result.error, details: result,
                  ...(failureCause ? { failureCause } : {}) };
          } catch (error) {
            if (preparedAdmission) return { ok: false, errorCode: 'indeterminate',
              error: 'The admitted copy could not confirm its terminal outcome',
              details: { success: false, status: 'unknown', operationId: preparedAdmission.operationId, errorCode: 'indeterminate' } };
            return { ok: false, errorCode: signal?.aborted ? 'cancelled'
              : error && typeof error === 'object' && 'errorCode' in error && typeof error.errorCode === 'string' ? error.errorCode : 'target_unavailable',
              error: error instanceof Error ? error.message : 'Copy target is unavailable' };
          } finally {
            try { await sourceTransport?.close(); } finally { await destinationTransport?.close(); }
          }
        };
        if (pat) return { patRun: () => run(concreteContext) };
        const mounted = createCliActionExecutionCoreFromCredentials({ ...params, ...destinationHome,
          readCredentials: currentCredentialsFor(destinationHome), filesystemActionExecute: async request => {
            const result = await run(request.context);
            return result.ok ? result.result : result;
          } });
        return { executor: invocationSignal ? mounted.bindInvocation(invocationSignal) : mounted, context: concreteContext,
          ...(deploymentAdmission ? { deploymentRun: () => run(concreteContext) } : {}) };
      } catch (error) {
        return { failure: { ok: false as const, errorCode: signal?.aborted ? 'cancelled' : 'target_unavailable',
          error: error instanceof Error ? error.message : 'Copy target is unavailable' } };
      }
    };
    const execute: CliActionExecutor['execute'] = async (actionId, input, context) => {
      if (!params.filesystemActionExecute && actionId === 'daemon.filesystem.copy') {
        const copy = await prepareConcreteCopy(input, context);
        if (copy?.failure) return copy.failure;
        if (copy?.patRun) return await copy.patRun();
        if (copy?.executor) return await copy.executor.execute(actionId, input, copy.context);
      }
      const custodyFailure = params.filesystemActionExecute ? null : resolveFilesystemTransferCustodyFailure(actionId, context ?? {});
      return custodyFailure ?? await executor.execute(actionId, input, context);
    };
    return {
      ...executor, execute,
      executeDeploymentChildFilesystemAction: async request => {
        if (!params.machineId || !params.externalActionMachineInstallationId || !params.externalActionMachineRequestPrivateKey
          || !FilesystemTargetCopyInputSchema.safeParse(request.input).success) return actionFailure('action_forbidden');
        const readCurrent = async () => {
          const admitted = await assertDeploymentArchiveChildCurrentForHost({ context: request.context, machineId: params.machineId!,
            installationId: params.externalActionMachineInstallationId! });
          await request.assertCurrent();
          return admitted;
        };
        const assertCurrent = async () => { await readCurrent(); };
        try {
          const admitted = await readCurrent();
          const authorization = request.context.externalActionExecutionAuthorization;
          if (!authorization) return actionFailure('action_forbidden');
          // The installed receiver proves source intent before signing its
          // byte continuation. Archive holders receive no requester keys.
          await assertReviewedDeploymentArchiveSourceForHost({ authorization,
            envelope: admitted.execution.originalActionEnvelope, contentArtifactId: admitted.job.input.contentArtifactId,
            signal: request.context.signal });
          await assertCurrent();
          const copy = await prepareConcreteCopy(request.input, { ...request.context,
            externalActionTarget: { kind: 'machine', machineId: params.machineId } }, { assertCurrent, archiveOrigin: request.archiveOrigin });
          if (copy?.failure) return copy.failure;
          if (!copy || !('deploymentRun' in copy) || !copy.deploymentRun) return actionFailure('filesystem_transfer_custody_required');
          return await copy.deploymentRun();
        } catch (error) {
          // The deployment failure owner keeps typed causes and recovery; refusals stay content-free.
          return projectDeploymentFailure(request.context.signal?.aborted ? 'cancelled'
            : error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'action_forbidden',
          error, 'deployment.archive.copy');
        }
      },
      prepare: async (actionId, input, context) => {
        const custodyFailure = !params.filesystemActionExecute && resolveFilesystemTransferCustodyFailure(actionId, context ?? {});
        if (custodyFailure) return { kind: 'settled', result: custodyFailure };
        if (!params.filesystemActionExecute && actionId === 'daemon.filesystem.copy'
          && (FilesystemPreparedCopyInputSchema.safeParse(input).success || FilesystemTargetCopyInputSchema.safeParse(input).success)) {
          const copy = await prepareConcreteCopy(input, context);
          if (copy?.failure) return { kind: 'settled', result: copy.failure };
          if (copy?.patRun) return { kind: 'ready', invocation: createOneShotPatInvocation(copy.patRun) };
          if (copy?.executor) return await copy.executor.prepare(actionId, input, copy.context);
        }
        return await executor.prepare(actionId, input, context);
      },
    };
  };
  return Object.freeze({ ...core, ...wrap(core), bindInvocation: (signal, approvalLifetime) => wrap(core.bindInvocation(signal, approvalLifetime), signal) });
}
