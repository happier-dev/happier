import { createCliActionAutomationPortV1 } from '@/api/actionAutomations';
import { refuseDeploymentArtifactRead } from '@/deployments/deploymentFailure';
import { resolveSessionApprovalProfileReferenceV1 } from '@happier-dev/protocol/actions/approvalProfiles';
import { createCliPrivateLabelActionOpener } from '@/api/privateLabels';
import { bindApprovalProfileV1 } from '@happier-dev/protocol/actions/approvalProfileArtifactV1';
import { refreshActiveApprovalProfileCatalog } from '@/settings/profiles/hydrateProfileCatalog';
import { createActionRefusalDetailsV1, isActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { PROJECT_SOURCE_MOVE_TO_TEAM_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIds';
import { prepareCliProjectSourceTeamMove } from './projectSourceTeamMove';
import { readAuthTokenProvenance } from '@happier-dev/protocol/auth/authToken';
import { projectExternalActionRequesterInvocationV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { requireExternalActionHeaders, createExternalActionHeaderRefusalError } from '@/api/externalActionHeaderRefusal';
import { projectDeploymentFailure } from '@/deployments/deploymentFailure';
import { prepareCliDeploymentAlertDefaults } from './cliActionDeps/deploymentDefaults';
import { createCliWorkspaceSyncActionDeps } from './cliActionDeps/workspaceSync';
import { createDeploymentArtifactHeaderReader } from '@/deployments/readArtifactHeadersForHost';
import { prepareCliManagedProvisionerAdmission } from '@/machines/managed/provisionerAdmission';
import { prepareCliManagedMachinePresetAuthoring } from '@/machines/managed/presetAuthoring';
import { prepareCliManagedMachineWake } from './cliActionDeps/managedMachineWake';
import { prepareDeploymentTargetEnablementRetention } from '@/deployments/targetEnablementRetention';
import { resolveSessionInputTargetMachineId } from '@/session/services/sessionInputAdmissionIdentity';
import { createCliOccurrenceAction } from './cliActionDeps/occurrences';
import { createPrepareDeployment } from '@/workspaces/prepareDeployment';
import { resolveAdmittedRepositoryWorkspace } from '@/workspaces/admittedRepositoryWorkspace';
import { createMachineUpdatesRolloutActionDeps } from '@/machines/setup/composeMachineUpdates';
import { createCombinedMachineSetupActionDeps, createMachineSetupApplyDispatcher } from '@/machines/setup/composeMachineSetup';
import { readRequesterAccountEncryptionMaterialSnapshot } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import { SESSION_SPAWN_MACHINE_SETUP_CHILDREN_V1 } from '@happier-dev/protocol/machines/managed/actionIdsV1';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { ACTION_INVOKE_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIds';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { importBrowserProfileCookiesV1 } from '@happier-dev/protocol/browser/profile/v1';
import { importCliSavedSecretPasskeysForOperation } from './cliActionDeps/browserProfileLogins';
import { createCliSessionActionTransport } from '@/session/transport/cliActionTransport';
import { createCliAgentStartContext } from './cliActionDeps/agentStart';
import { createCliSessionStatusActionDeps } from '@/session/services/cliStatusActionDeps';
import { createCliSessionHandoffActionDeps } from '@/session/handoff/cliActionDeps';
import { createCliSessionLifecycleActionDeps } from '@/session/actions/lifecycle/cliActionDeps';
import { createCliAgentCatalogActionDeps } from './cliActionDeps/agentCatalog';
import { createCliSessionModelActionDeps } from '@/session/services/cliModelActionDeps';
import { createCliApprovalActionDeps } from './approvals/cliActionDeps';
import { createCliLaunchProfilesActionDeps } from './cliActionDeps/launchProfiles';
import { createCliMetadataActionDeps } from '@/session/services/cliMetadataActionDeps';
import { createCliTasksActionDeps } from './cliActionDeps/tasks';
import { createCliPendingActionDeps } from '@/session/services/cliPendingActionDeps';
import { createCliLocalServiceActionDeps } from './cliActionDeps/localServices';
import { prepareProjectServiceMoveChildren } from '@/daemon/local/services/actions/projectServiceMoveChildren';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { ProjectServiceRelocateInputV1Schema } from '@happier-dev/protocol/workspaces/projectServiceRelocationV1';
import { createCliControlActionDeps } from '@/session/services/cliControlActionDeps';
import { createCliPluginAdministrationActionDeps } from './cliActionDeps/pluginAdministration';
import { createCliPluginCollectionSharingActionDeps } from './cliActionDeps/pluginCollectionSharing';
import { createCliManagedMachineReferences, createCliMachineRebootReferenceReader } from './cliActionDeps/machineReferences';
import { createCliSessionCatalogActionDeps } from '@/session/catalogControls/cliActionDeps';
import { createCliPromptsActionDeps } from './cliActionDeps/prompts';
import { createCliUsageLimitRecoveryActionDeps } from '@/session/usageLimitRecoveryControls/cliActionDeps';
import { createCliRolesActionDeps } from './cliActionDeps/roles';
import { RoleActionRefusalV1, type RawRoleSettingsMutationV1 } from '@happier-dev/protocol/prompts/roles/accountRoleActions';
import { createCliAdmittedProjectRowsReader } from './cliActionDeps/projectAdmission';
import { createCliWidgetActionDeps } from './cliActionDeps/widgets';
import { createCliExecutionRunActionDeps } from './cliActionDeps/executionRuns';
import { createCliConnectionsActionDeps } from './cliActionDeps/connections';
import { createCliMachineResourceActionDeps } from './cliActionDeps/machineResources';
import { createCliProjectActionDeps } from './cliActionDeps/projects';
import { createCliProjectSessionDefaultsActionDeps } from './cliActionDeps/projectSessionDefaults';
import { createCliPermissionActionDeps } from '@/session/services/cliPermissionActionDeps';
import { createCliProjectAdmission } from './cliActionDeps/projectAdmission';
import { createCliMachineActionDeps } from './cliActionDeps/machine';
import { createCliSettingsActionDeps } from './cliActionDeps/settings';
import { createCliMessageActionDeps } from '@/session/services/cliMessageActionDeps';
import { createCliArtifactsActionDeps } from './cliActionDeps/artifacts';
import { createCliBotTemplateActionDeps } from './cliActionDeps/botTemplates';
import { createCliMachineInventoryActionDeps } from './cliActionDeps/machineInventory';
import { createCliWorkflowRunStorage } from './workflowRunStorage';
import { createCliWorkflowFamily, type CliWorkflowFamilyHost } from './workflowFamily';
import { readRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionContext';
import { hasStoredSessionCredentialProvenance } from '@/persistence';
import { createCliSpawnActionDeps } from '@/session/creation/cliActionDeps';
import { createCliAwarenessActionDeps } from './cliActionDeps/awareness';
import { createCliFilesystemActionDeps } from './cliActionDeps/filesystem';
import { createCliTranscriptActionDeps } from './cliActionDeps/transcript';
import { createCliGoalActionDeps } from '@/session/goalControls/cliActionDeps';
import type { CliActionDepsParams, CliActionExactHomeTarget } from './cliActionDeps/types';
export type { ResumeInactiveSessionWhenUsageLimitReady, ScheduleInactiveSessionUsageLimitRecoveryCheck, CancelInactiveSessionUsageLimitRecoveryCheck, ReadInactiveSessionUsageLimitRecovery, CancelConnectedServiceRuntimeAuthRecovery, RetryTemporaryThrottleNow, SessionSpawnDirectTargetTransport, SessionActionRpcTransport, MachineActionDirectTargetTransport, MachineServiceActionDirectTargetInvocation, CliActionExactHomeTarget } from './cliActionDeps/types';
import { createSessionBoundScmAction } from '@/scm/actions/sessionBoundAction';
import { createCliMemoryActionDeps } from './cliActionDeps/memory';
import { createCliMachineActionTransport } from './cliActionDeps/machineTransport';
import type { isOriginalSessionInputAccountActionCustody } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import type { getServerProfile } from '@/server/serverProfiles';
import type { SessionModelSelectionV1, SessionSpawnNewInputV2, SessionCreationDirectoryApprovalV1, AgentExecutionTargetV1, SessionInputAdmissionResultV1 } from '@happier-dev/protocol';
import { AcpConfigOptionOverridesV1Schema } from '@happier-dev/protocol/sessions/metadata/overrides';
import { AccountSettingMutationV1Schema } from '@happier-dev/protocol/account/settings/accountSettingMutationV1';
import { RuntimeDescriptorV1Schema } from '@happier-dev/protocol/sessions/metadata/runtime-descriptor';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { SessionModelSelectionResolutionError, resolveSessionModelSelectionInputRefV1 } from '@happier-dev/protocol/providers/model-selection';
import { normalizeSpawnSessionNonceResolution } from '@happier-dev/protocol/sessions/spawnSessionNonce';
import { mergeSpawnConfigOptionAliases } from '@happier-dev/protocol/actions/sessionSpawnConfigOptions';
import { resolveActionBackendTargetSelection } from '@happier-dev/protocol/actions/resolveActionBackendTargetSelection';
import { readRuntimeDescriptorV1FromMetadata } from '@happier-dev/protocol/sessions/metadata/runtime-descriptor-compat';
import { StrictJsonValueSchema } from '@happier-dev/protocol/json/strictJsonValue';
import type { AGENT_IDS, DEFAULT_AGENT_ID, resolvePermissionIntentFromSessionMetadata, resolveCanonicalAgentIdFromFlavor, AgentId } from '@happier-dev/agents';
import type { resolveCurrentAccountMachineTarget } from '@/api/machine/resolveCurrentAccountMachineTarget';
import type { fetchSessionsQueryPage } from '@/session/transport/http/sessionsHttp';
import { deriveSettingsSecretsReadKeysForCredentials } from '@/settings/secrets/settingsSecretsKey';
import { createCliNotificationActionDeps } from './cliActionDeps/notifications';
import { createCliSubagentActionDeps } from './cliActionDeps/subagents';
export { projectSessionInitialAccessEnvelopeHostErrorResult } from './cliActionDeps/sessionSpawnErrors';

import { setModelFavoriteV1 } from '@happier-dev/protocol/providers/modelFavoritesV1';
import type { updateAccountSettingsV2OnceAgainstLatest } from '@/settings/accountSettings/updateAccountSettingsV2WithRetry';
import { MachineDeploymentReferencesPageV1Schema } from '@happier-dev/protocol/machines/machineReferenceCensusV1';


import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { readSessionAccessProjectionRoleV1 } from '@happier-dev/protocol/sessions/access/sessionEffectiveAccessV1';
import { resolveProjectContextSourceV1 } from '@happier-dev/protocol/projects/projectListProjectionV1';

import type { isServerProfileHomeIdentity } from '@/server/serverProfiles';

import { areServerProfileIdentifiersEquivalent } from '@happier-dev/protocol/features/payload/capabilities/serverIdentityCapabilities';
import type { readCliMemoryInheritedContext, readCliMemoryScopeContext } from './readCliMemoryInheritedContext';
import { createCliProjectSourceActionDeps } from './projectSourceActionDeps';
import { createCliDeploymentActionDeps } from '@/deployments/createCliDeploymentActionDeps';
import { createPrepareEnvironmentContentForHost } from '@/deployments/prepareEnvironmentContentForHost';
import { readDeploymentHealthCurrentPlacementFailure } from '@/deployments/healthChecks/currentHealthPlacement';
import { createPrepareDeploymentBindingsForHost } from '@/deployments/secrets/prepareDeploymentBindingsForHost';
import { DeploymentActionInputSchemasV1, DeploymentActionOutputSchemasV1, DeploymentEnvironmentGetResultV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { isDeploymentReadActionIdV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { DEPLOYMENT_BINDINGS_SET_ACTION_ID_V1, DEPLOYMENT_ENVIRONMENT_CREATE_ACTION_ID_V1, DEPLOYMENT_ENVIRONMENT_UPDATE_ACTION_ID_V1, DEPLOYMENT_HEALTH_CURRENT_ACTION_ID_V1, isDeploymentObservationReadActionIdV1, isDeploymentTargetLinkActionIdV1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import { DeploymentEnvironmentCreateIntentInputV1Schema, resolveDeploymentPreviewExecutionMachineIdV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { resolveExternalActionMachineTarget } from '@/daemon/externalActions/reconcileExternalActionTarget';
import type { withCliPromptLibraryArtifactReader } from '@/agent/prompts/library/resolveCliPromptStackSystemAppendBlocks';
import { createHomeHubArtifactPortV1 } from '@happier-dev/protocol/home/homeHubArtifactV1';
import { createCliConnectedServiceAction } from './connectedServiceActionDeps';
import { createCliSessionCapabilitiesActionDeps } from './cliActionDeps/createCliSessionCapabilitiesActionDeps';
import { randomUUID } from 'node:crypto';





import type { SessionPullRequestBindingInputV1 } from '@happier-dev/channels-protocol/v1';
import { DeploymentTemplateInstantiateResultV1Schema } from '@happier-dev/protocol/deployments/deploymentTemplateInstantiationV1';
import { resolveDeploymentTemplateExecutionMachineIdV1 } from '@happier-dev/protocol/deployments/deploymentTemplateInstantiationV1';
import { DeploymentMoveToRepositoryResultV1Schema, resolveDeploymentMoveToRepositoryExecutionMachineIdV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { createTargetedActionRpcRequestV1 } from '@happier-dev/protocol/actions/actionRpcTransport';




import { createWorkBoardArtifactPortV1 } from '@happier-dev/protocol/boards/workBoardArtifactV1';
import { readSessionManagerSessionIdV1 } from '@happier-dev/protocol/sessions/follow/sessionManagerV1';
import type { SessionFollowSourceKeyPreparationResultV1, SpawnConfigOptionValue, ActionExecutorDeps, ActionExecutorContext, PersistedBackendTargetRefV2 } from '@happier-dev/protocol';





import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';









import type { resolveAgentIdFromSessionMetadata, isBundledAgentId } from '@happier-dev/agents';
import { configuration } from '@/configuration';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';

import { createCliApprovalsArtifactStore } from '@/session/actions/approvals/artifactStore';
import { createAcknowledgedAccountArtifactTransport, createCredentialedAccountArtifactStore,
  type ArtifactRequestAuthorizationHeaders } from '@/api/artifacts/accountArtifactStore';
import { createCliInboxReadAction } from './inboxActions';
import { createRoleSourceReader, type RoleSourceReader } from '@/session/roles/roleSources';
import { readAccountIdFromToken, decodeJwtPayload } from '@/cloud/decodeJwtPayload';
import type { createSessionFollowSourceKeyPreparationAfterSet } from '@/agent/runtime/session/follow/createSessionFollowSourceKeyPreparationAfterSet';
import type { readAgentCatalogSnapshot } from '@/agent/catalog/snapshot';
import type { readSettings } from '@/persistence';
import { createDiscussionActionDeps } from '@/discussions/discussionActionDeps';
import { createSessionListActionDeps } from './sessionListActionDependency';
import { createCliBoundSessionMetadataReader, readCliActionBoundSessionId, resolveCliActionCallerSession } from './resolveCliActionCallerSession';
import { dispatchOriginalAccountAction, readAdmittedBotTemplateParentActionIdV1,
  resolveExternalActionServerRequestHeaders } from '@/api/externalActionExecutionAuthorization';

import type { resolveSessionCreationAgentTarget } from '@/session/creation/resolveSessionCreationAgentTarget';


import type { resolveSessionTransportContext } from '@/session/services/resolveSessionTransportContext';
import { readSessionOwnerLocality } from '@/session/transport/encryption/sessionEncryptionContext';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import type { resolveBackendTargetFromSessionMetadata } from '@/session/backendTargets/resolveBackendTargetFromSessionMetadata';
import { createCliActionInventoryDeps } from './cliActionDeps/createCliActionInventoryDeps';

import { createAutomationConversationActionExecutor } from '@/plugins/runtime/automations/automationConversationActionExecutor';
import { createAutomationEventActionExecutor, type CommittedAutomationEventObservationV1 } from '@/plugins/runtime/automations/automationEventActionExecutor';






import { createCliReviewCommentActionExecutorFromCredentials } from '@/agent/reviews/comments/executor';
import { createHostExternalSessionActionTransport } from './externalSessions/hostExternalSessionActionTransport';
import type { bootstrapAccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';




import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { getActiveAccountSettingsSnapshotLifetimeToken, isActiveAccountSettingsSnapshotLifetimeCurrent, readAccountRoleOverridesFromSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { readPreparedAccountRoleOverrides } from '@/session/roles/sessionRoleContext';
import type { prepareActiveAccountRoleOverrides } from '@/settings/prompts/hydratePromptLibraryCatalog';

import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import type { CliServerFeaturesSnapshot } from '@/features/serverFeaturesClient';

/** Private Session adapter receives IDs already resolved by Workflow/SCM admission. */
export type ResolvedSessionPullRequestBindingInputV1 = SessionPullRequestBindingInputV1 & Readonly<{ sessionId: string }>;

function notSupported(): never {
  throw new Error('action_not_supported_in_cli');
}

function normalizeStringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function executionRunActionFailure(
  code: string,
  message?: string,
  details?: unknown,
): Readonly<{ ok: false; errorCode: string; error: string; details?: unknown }> {
  return {
    ok: false,
    errorCode: code,
    error: message ?? code,
    ...(details !== undefined ? { details } : {}),
  };
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function isExecutionRunActionAbort(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true || readRecord(error).name === 'AbortError';
}

function readStringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>);
  if (!entries.every(([, entryValue]) => typeof entryValue === 'string')) return undefined;
  return Object.fromEntries(entries) as Record<string, string>;
}

function readConfigOptionsRecord(value: unknown): Record<string, SpawnConfigOptionValue> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>);
  if (!entries.every(([, entryValue]) => (
    typeof entryValue === 'string'
    || typeof entryValue === 'number' && Number.isFinite(entryValue)
    || typeof entryValue === 'boolean'
    || entryValue === null
  ))) {
    return undefined;
  }
  return Object.fromEntries(entries) as Record<string, SpawnConfigOptionValue>;
}

export type ControllerDeploymentMutationActionId =
  'deployments.deploy' | 'deployments.rollback' | 'deployments.promote' | 'deployments.teardown' | typeof DEPLOYMENT_ENVIRONMENT_UPDATE_ACTION_ID_V1 | typeof DEPLOYMENT_BINDINGS_SET_ACTION_ID_V1;

export function isControllerDeploymentMutationAction(actionId: string, input: unknown): actionId is ControllerDeploymentMutationActionId {
  if (actionId === DEPLOYMENT_BINDINGS_SET_ACTION_ID_V1) {
    const parsed = DeploymentActionInputSchemasV1[DEPLOYMENT_BINDINGS_SET_ACTION_ID_V1].safeParse(input);
    return parsed.success && 'set' in parsed.data
      && parsed.data.set.some(binding => binding.purpose === 'dataRole' && 'service' in binding);
  }
  return actionId === 'deployments.deploy' || actionId === 'deployments.rollback'
    || actionId === 'deployments.promote' || actionId === 'deployments.teardown'
    || actionId === DEPLOYMENT_ENVIRONMENT_UPDATE_ACTION_ID_V1
      && getActionSpec(DEPLOYMENT_ENVIRONMENT_UPDATE_ACTION_ID_V1).safetyForInput?.(input) !== 'safe';
}

export type CliActionDeps = ActionExecutorDeps & Required<Pick<ActionExecutorDeps, 'sessionSpawnNew' | 'sessionSendMessage' | 'sessionList' | 'daemonMemorySearch' | 'daemonMemoryEnsureUpToDate' | 'executionRunStart' | 'agentsModelsList' | 'sessionActivityGet' | 'executionRunList' | 'detachedExecutionRunSend' | 'executionRunWait' | 'executionRunGet' | 'sessionFork' | 'daemonMemoryGetWindow' | 'sessionOpen' | 'sessionRollback'>> & Readonly<{
  prepareNativeGoalOwner: (signal?: AbortSignal) => Promise<void>;
}>;

export function projectCliAccountCallerContext(context: ActionExecutorContext, homeAccountId: string | null): ActionExecutorContext {
  const binding = context.externalActionExecutionAuthorization?.binding;
  const credential = context.externalActionCredential;
  const admittedPatAccountId = binding && 'credentialId' in binding && credential
    && binding.accountId === credential.accountId && binding.principalId === credential.principalId
    && binding.credentialId === credential.credentialId ? binding.accountId : null;
  const accountId = admittedPatAccountId ?? homeAccountId;
  return { ...context, ...(accountId ? { runtimeAccountId: accountId } : {}) };
}

export function createCliActionDeps(params: CliActionDepsParams,
  readEffectiveDeps?: () => ActionExecutorDeps,
): CliActionDeps {
  const roleAccountScopeKey = params.serverHttpBaseUrl
    ? runWithServerHttpBaseUrl(params.serverHttpBaseUrl, () => resolveAccountSettingsScopeKeyForToken(params.token))
    : resolveAccountSettingsScopeKeyForToken(params.token);
  const roleAccountLifetimeToken = getActiveAccountSettingsSnapshotLifetimeToken();
  const roleSettingsProvider = params.actionsSettingsProvider ?? createActionSettingsProvider({
    scopeKey: roleAccountScopeKey, credentials: params.credentials });
  const profileSettingsProvider = roleSettingsProvider.getApprovalProfiles ? roleSettingsProvider
    : createActionSettingsProvider({ scopeKey: roleAccountScopeKey, credentials: params.credentials });
  const readAccountRoleOverrides = () => {
    if (params.savedSecretOperationContext) {
      const snapshot = params.savedSecretOperationContext.readSnapshot();
      return snapshot ? readAccountRoleOverridesFromSnapshot(snapshot)
        : { status: 'unavailable' as const, reason: 'scope-retired' as const };
    }
    return roleSettingsProvider.getAccountRoleOverrides?.()
      ?? { status: 'unavailable' as const, reason: 'source-unavailable' };
  };
  const prepareAccountRoleOverrides = async (signal?: AbortSignal): Promise<void> => {
    const sessionRoles = params.getSessionRoleContext?.();
    if (sessionRoles) { await sessionRoles.prepare(signal, true); return; }
    const credentials = params.credentials;
    if (!credentials) return;
    const { prepareActiveAccountRoleOverrides } = await import("@/settings/prompts/hydratePromptLibraryCatalog");
    const prepare = () => prepareActiveAccountRoleOverrides({ credentials,
      scopeKey: roleAccountScopeKey, lifetimeToken: roleAccountLifetimeToken, signal,
      operationContext: params.savedSecretOperationContext });
    const prepared = await (params.serverHttpBaseUrl ? runWithServerHttpBaseUrl(params.serverHttpBaseUrl, prepare) : prepare());
    if (prepared.status === 'unavailable' && prepared.reason === 'scope-retired') {
      throw Object.assign(new Error('account_role_overrides_unavailable'), {
        code: 'account_role_overrides_unavailable', reason: 'scope-retired',
      });
    }
  };
  const readReadyAccountRoleOverrides = (signal?: AbortSignal) => params.getSessionRoleContext?.().readAccountOverrides(signal)
    ?? readPreparedAccountRoleOverrides({ read: readAccountRoleOverrides, prepare: prepareAccountRoleOverrides }, signal);
  // Re-formed once so the proven pair travels to every Home-bound owner
  // together; the two params fields decorrelate as soon as they are spread apart.
  const exactHome: CliActionExactHomeTarget =
    params.serverId !== undefined && params.serverHttpBaseUrl !== undefined
      ? { serverId: params.serverId, serverHttpBaseUrl: params.serverHttpBaseUrl }
      : {};
  const readServerFeaturesSnapshot = async (): Promise<CliServerFeaturesSnapshot | undefined> =>
    await params.resolveServerFeaturesSnapshot?.();
  const projectHomeId = params.serverId ?? configuration.activeServerId;
  const actionHomeId = params.serverIdentityId ?? projectHomeId;
  const localMachineId = params.machineActionDirectTargetTransport?.machineId
    ?? params.sessionSpawnDirectTargetTransport?.machineId;
  const { resolveProjectHomeIdentity, projectHomeAdmission, projectAccountAdmission, withProjectHome, projectRowsAuthority, assertProjectRequesterCurrent, readProjectRows, readProjectRequesterArtifact } = createCliProjectAdmission(params, { projectHomeId, actionHomeId, executionRunActionFailure });

  const isSameActionHomeId = (serverId: string) => areServerProfileIdentifiersEquivalent(actionHomeId, serverId, identifier =>
    identifier === projectHomeId || identifier === params.serverIdentityId ? params.serverIdentityId : undefined);
  const resolveServerRequestHeaders = (
    context: ActionExecutorContext | undefined,
    effectActionId: string,
    request: Readonly<{ method: string; path: string; body?: unknown }>,
  ): Readonly<Record<string, string>> | null => {
    const resolved = resolveExternalActionServerRequestHeaders({
      context,
      effectActionId,
      method: request.method,
      path: request.path,
      ...(request.body === undefined ? {} : { body: request.body }),
      daemonToken: params.token,
      serverIdentityId: params.serverIdentityId,
      ...(params.externalActionMachineRequestPrivateKey
        ? { privateKey: params.externalActionMachineRequestPrivateKey }
        : {}),
      ...(params.externalActionMachineInstallationId
        ? { installationId: params.externalActionMachineInstallationId }
        : {}),
    });
    return requireExternalActionHeaders(resolved);
  };
  const admitAccountStorage = async (serverId: string, context: ActionExecutorContext) => {
    const denied = await projectHomeAdmission(serverId, context);
    if (denied) return denied;
    if (context.externalActionExecutionAuthorization) {
      const http = context.externalActionExecutionAuthorization.requesterHttpProjection;
      if (http && (http.accountId !== context.externalActionExecutionAuthorization.binding.accountId
        || http.serverId !== projectHomeId || http.serverHttpBaseUrl.replace(/\/+$/, '') !== todoHomeBaseUrl.replace(/\/+$/, '')
        || !await http.isCurrent())) return executionRunActionFailure('project_requester_authority_unavailable');
      return null;
    }
    const accountDenied = await projectAccountAdmission(serverId, context);
    if (accountDenied) return accountDenied;
    if (params.token !== params.credentials?.token) return executionRunActionFailure('not_authenticated');
    if (!params.serverId && configuration.activeServerId !== projectHomeId) return executionRunActionFailure('server_scope_mismatch');
    return null;
  };
  const resolveAccountStorageHeaders = async (context: ActionExecutorContext, effectActionId: string,
    request: Readonly<{ method: string; path: string; body?: unknown }>) => {
    const projection = context.externalActionExecutionAuthorization?.requesterHttpProjection;
    if (!projection) return resolveServerRequestHeaders(context, effectActionId, request);
    return projection.createRequestHeaders({ ...request, effectActionId, ...(context.signal ? { signal: context.signal } : {}) });
  };
  const prepareSourceKeyAfterCommit = async (input: Readonly<{
    effectActionId: 'session.manager.set' | 'session.spawn_new';
    sourceSessionId: string;
    destinationSessionId: string;
    context?: ActionExecutorContext;
    signal?: AbortSignal;
  }>): Promise<SessionFollowSourceKeyPreparationResultV1> => {
    if (!params.credentials) return { kind: 'waiting', reason: 'runner_unreachable', cause: 'credentials_unavailable' };
    if (!input.context) return { kind: 'waiting', reason: 'runner_unreachable', cause: 'action_context_unavailable' };
    try {
      const { createSessionFollowSourceKeyPreparationAfterSet } = await import("@/agent/runtime/session/follow/createSessionFollowSourceKeyPreparationAfterSet");
      return await createSessionFollowSourceKeyPreparationAfterSet({
        credentials: params.credentials,
        effectActionId: input.effectActionId,
        ...(params.serverHttpBaseUrl ? { serverHttpBaseUrl: params.serverHttpBaseUrl } : {}),
        ...(params.serverIdentityId ? { serverIdentityId: params.serverIdentityId } : {}),
        ...(params.resolveServerFeaturesSnapshot ? { resolveServerFeaturesSnapshot: params.resolveServerFeaturesSnapshot } : {}),
        ...(params.externalActionMachineRequestPrivateKey ? { externalActionMachineRequestPrivateKey: params.externalActionMachineRequestPrivateKey } : {}),
        ...(params.externalActionMachineInstallationId ? { externalActionMachineInstallationId: params.externalActionMachineInstallationId } : {}),
      })({ sourceSessionId: input.sourceSessionId, destinationSessionId: input.destinationSessionId,
        context: input.context, ...(input.signal ? { signal: input.signal } : {}) });
    } catch {
      return { kind: 'waiting', reason: 'runner_unreachable', cause: 'preparation_exception' };
    }
  };
  const roleArtifactStore = params.credentials ? createCredentialedAccountArtifactStore(params.credentials) : undefined;
  const homeAccountId = params.credentials ? readAccountIdFromToken(params.credentials.token) : null;
  // Widget surfaces are shared Home addresses, not this device's credential profile.
  const widgetHomeId = params.serverIdentityId ?? params.serverId ?? configuration.activeServerId;
  const accountCallerContext = (context: ActionExecutorContext): ActionExecutorContext =>
    projectCliAccountCallerContext(context, homeAccountId);
  const artifactCallerContext = (context: ActionExecutorContext): ActionExecutorContext => ({ ...accountCallerContext(context),
    ...(!context.defaultSessionId && params.sessionId ? { defaultSessionId: params.sessionId } : {}) });
  const todoHomeServerId = params.serverId ?? configuration.activeServerId;
  const todoHomeBaseUrl = params.serverHttpBaseUrl ?? resolveServerHttpBaseUrl();
  const homeHubArtifactPort = roleArtifactStore && homeAccountId ? createHomeHubArtifactPortV1(createAcknowledgedAccountArtifactTransport(roleArtifactStore), {
    accountId: homeAccountId, readWidgets: (signal, layout) => readHomeWidgets(signal, layout),
  }) : null;
  const readRawRoleSettings = params.credentials ? async (options?: Readonly<{ requireCurrentNetwork: boolean }>) => {
    if (params.savedSecretOperationContext && !await params.savedSecretOperationContext.isCurrent()) {
      throw Object.assign(new Error('scope-retired'), { code: 'scope-retired' });
    }
    if (params.savedSecretOperationContext && !options?.requireCurrentNetwork) {
      const captured = params.savedSecretOperationContext.readSnapshot();
      if (!captured?.rawSettings || captured.source === 'none') {
        throw Object.assign(new Error('account_settings_content_unavailable'), { code: 'account_settings_content_unavailable' });
      }
      return captured.rawSettings;
    }
    const { bootstrapAccountSettingsContext } = await import("@/settings/accountSettings/bootstrapAccountSettingsContext");
    const current = await bootstrapAccountSettingsContext({ credentials: params.credentials!, mode: 'blocking',
      ...(params.savedSecretOperationContext ? { publication: 'invocation' as const, refresh: 'force' as const, honorAccountSettingsModeEnv: false } : {}),
      ...(options?.requireCurrentNetwork ? { refresh: 'force', publication: 'invocation', honorAccountSettingsModeEnv: false } as const : {}) });
    if (!current.rawSettings || (options?.requireCurrentNetwork && current.source !== 'network')) {
      throw Object.assign(new Error('account_settings_content_unavailable'), { code: 'account_settings_content_unavailable' });
    }
    return current.rawSettings;
  } : undefined;
  const mutateRawAccountSettings: RawRoleSettingsMutationV1 | undefined = params.credentials ? async (mutate, signal) => {
    if (params.savedSecretOperationContext && !await params.savedSecretOperationContext.isCurrent(signal)) {
      throw new RoleActionRefusalV1('scope-retired');
    }
    const { updateAccountSettingsV2OnceAgainstLatest } = await import('@/settings/accountSettings/updateAccountSettingsV2WithRetry');
    const shouldSubmit = () => params.savedSecretOperationContext
      ? params.savedSecretOperationContext.readSnapshot() !== null
      : isActiveAccountSettingsSnapshotLifetimeCurrent({ scopeKey: roleAccountScopeKey, lifetimeToken: roleAccountLifetimeToken });
    const update = () => updateAccountSettingsV2OnceAgainstLatest({ credentials: params.credentials!, mutate, signal, shouldSubmit });
    const result = await (params.serverHttpBaseUrl ? runWithServerHttpBaseUrl(params.serverHttpBaseUrl, update) : update());
    if (result.status === 'applied' || result.status === 'unchanged' || result.status === 'satisfied') return;
    const code = result.status === 'conflict' ? 'currentness_conflict'
      : result.status === 'outcomeUnknown' ? 'outcome_unknown'
      : result.status === 'cancelled' ? 'cancelled'
      : result.status === 'unavailable' ? result.reason ?? 'account_settings_content_unavailable'
      : 'account_settings_content_unavailable';
    throw new RoleActionRefusalV1(code);
  } : undefined;
  const machineReferenceServerUrl = params.serverHttpBaseUrl ?? resolveServerHttpBaseUrl();
  const managedMachineReferences = createCliManagedMachineReferences(params, { machineReferenceServerUrl, projectAccountAdmission, projectHomeId, readRawRoleSettings, roleArtifactStore });
  const machineRebootReferences = createCliMachineRebootReferenceReader(params, { machineReferenceServerUrl, projectAccountAdmission, projectHomeId });
  const sourceReader = params.readRoleSources ?? createRoleSourceReader({
    artifactStore: roleArtifactStore, readPluginRoles: params.readPluginRoles,
    accountId: params.credentials ? readAccountIdFromToken(params.credentials.token) ?? undefined : undefined,
    readRawAccountSettings: readRawRoleSettings,
  });
  const readRoleSources: RoleSourceReader = async (signal, options) => {
    const read = () => params.serverHttpBaseUrl
      ? runWithServerHttpBaseUrl(params.serverHttpBaseUrl, () => sourceReader(signal, options)) : sourceReader(signal, options);
    const sources = await read();
    signal?.throwIfAborted();
    if (params.savedSecretOperationContext && !await params.savedSecretOperationContext.isCurrent()) {
      throw Object.assign(new Error('scope-retired'), { code: 'scope-retired' });
    }
    return sources;
  };
  const callerSessionResolution = (context: ActionExecutorContext): Parameters<typeof resolveCliActionCallerSession>[0] => ({
    context, credentials: params.credentials, boundSessionId: params.sessionId, resolveTransportForSession, callSessionRpcForTransport,
    readBoundSession: async () => {
      const metadata = await readCurrentSessionMetadata(context.signal);
      const { resolveBackendTargetFromSessionMetadata } = await import("@/session/backendTargets/resolveBackendTargetFromSessionMetadata");
      return { metadata, workDepth: params.getCurrentSessionWorkDepth?.() ?? params.rawSession?.workDepth,
        backendTarget: params.getCurrentSessionBackendTarget?.() ?? resolveBackendTargetFromSessionMetadata(metadata),
        machineId: await resolveCurrentSessionValue('machineId', context.signal), directory: await resolveCurrentSessionValue('path', context.signal) };
    },
  });
  const resolveActionCallerSession = async (context: ActionExecutorContext) => await resolveCliActionCallerSession(callerSessionResolution(context));
  const resolveAgentStartContext = createCliAgentStartContext(params, { prepareAccountRoleOverrides, readReadyAccountRoleOverrides, readRoleSources, resolveActionCallerSession,
    readWorkflowActionStartContext: context => readWorkflowActionStartContext(context) }, () => readEffectiveDeps?.() ?? actionDeps);
  const approvalsStore = params.credentials ? createCliApprovalsArtifactStore({ credentials: params.credentials,
    serverId: params.serverId ?? configuration.activeServerId, serverHttpBaseUrl: params.serverHttpBaseUrl,
    operationContext: params.savedSecretOperationContext,
    ...(params.admittedAccountEncryptionMode !== undefined
      ? { getAccountEncryptionMode: async () => params.admittedAccountEncryptionMode! } : {}) }) : null;
  const artifactAuthorizationForContext = (context: ActionExecutorContext | undefined, effectActionId: string) => {
    const root = context?.externalActionExecutionAuthorization;
    if (!context?.externalActionCredential && (!root || root.binding.accountId === homeAccountId)) return null;
    return async (request: Parameters<ArtifactRequestAuthorizationHeaders>[0]) => {
      const headers = resolveServerRequestHeaders(context, root?.binding.actionId ?? effectActionId, request);
      if (!headers) throw Object.assign(new Error('execution_not_authorized'), { code: 'execution_not_authorized' });
      return { ...headers };
    };
  };
  const promptLibraryStoreForContext = (context: ActionExecutorContext | undefined, effectActionId: string) => {
    if (!approvalsStore) return null;
    const authorization = artifactAuthorizationForContext(context, effectActionId);
    return authorization ? approvalsStore.promptLibraryStoreForAuthorization(authorization) : approvalsStore.promptLibraryStore;
  };
  const skillRulesForContext = (context: ActionExecutorContext, effectActionId: string) => {
    if (!approvalsStore) return null;
    const authorization = artifactAuthorizationForContext(context, effectActionId);
    return authorization ? approvalsStore.skillRulesForAuthorization(authorization) : approvalsStore.skillRules;
  };
  const resolveSessionAgentIdentity = async (metadata: Record<string, unknown> | null | undefined, backendTarget?: PersistedBackendTargetRefV2 | null) => {
    // The admitted Agent target already carries its identity; only routing refs need the catalog.
    if (backendTarget?.kind === 'agent' && backendTarget.definitionId === undefined) return backendTarget.identity;
    const [{ resolveAgentIdFromSessionMetadata, isBundledAgentId }, { readAgentCatalogSnapshot }, { BUNDLED_AGENT_CONTRIBUTION_IDENTITIES }] = await Promise.all([import("@happier-dev/agents"), import("@/agent/catalog/snapshot"), import('@happier-dev/agents/agent-ids')]);
    const builtInAgentId = backendTarget?.kind === 'backend' && backendTarget.sourceKind === 'built_in' ? backendTarget.backendId : null;
    const agentId = builtInAgentId ?? resolveAgentIdFromSessionMetadata(metadata);
    return agentId ? (builtInAgentId && isBundledAgentId(agentId) ? BUNDLED_AGENT_CONTRIBUTION_IDENTITIES[agentId]
      : readAgentCatalogSnapshot().agentDefinitionsById.get(agentId)?.identity) : undefined;
  };
  const invokeSessionPullRequestBinding = async (input: ResolvedSessionPullRequestBindingInputV1, caller?: ActionExecutorContext) => {
    const { SESSION_PULL_REQUEST_BINDING_ACTION_ID_V1, SessionPullRequestBindingResultV1Schema } = await import(
      '@happier-dev/channels-protocol/v1'
    );
    caller?.signal?.throwIfAborted();
    const transport = await resolveTransportForSession(input.sessionId, caller?.signal);
    if (!transport.ok) throw Object.assign(new Error('target_unavailable'), { code: 'target_unavailable', details: createActionRefusalDetailsV1('target_unavailable', 'session_transport_absent') });
    const metadata = readTransportSessionOwnerMetadata(transport);
    const machineId = normalizeStringValue(transport.rawSession.machineId) ?? normalizeStringValue(metadata?.machineId);
    if (!machineId) throw Object.assign(new Error('target_unavailable'), { code: 'target_unavailable', details: createActionRefusalDetailsV1('target_unavailable', 'session_machine_absent') });
    const action = { pluginId: 'happier.channels', localId: SESSION_PULL_REQUEST_BINDING_ACTION_ID_V1 };
    // The Account collection owns the link. Keep the actual invoking host's
    // caller/target authority; the Session identifies the binding, not a new principal.
    const context: ActionExecutorContext = { ...caller, defaultSessionId: input.sessionId };
    let response: unknown;
    if (params.invokeContributedAction) {
      const result = await params.invokeContributedAction({ action, input, context, ...(caller?.signal ? { signal: caller.signal } : {}) });
      if (!result.ok) throw Object.assign(new Error(result.errorCode), { code: result.errorCode, details: result.details });
      response = result.result;
    } else {
      if ((caller?.actionCaller && caller.actionCaller.kind !== 'host') || caller?.surface === 'agent' || caller?.surface === 'mcp') {
        throw Object.assign(new Error('target_unavailable'), { code: 'target_unavailable', details: createActionRefusalDetailsV1('target_unavailable', 'caller_fallback_unsupported') });
      }
      response = await callMachineAction({ machineId, method: 'action.invoke',
        request: createTargetedActionRpcRequestV1({ action, input }, { kind: 'machine', machineId }, { defaultSessionId: input.sessionId }),
        ...(caller?.signal ? { signal: caller.signal } : {}) });
    }
    caller?.signal?.throwIfAborted();
    if (isActionExecuteFailure(response)) {
      throw Object.assign(new Error(response.errorCode), { code: response.errorCode, details: response.details });
    }
    const parsed = SessionPullRequestBindingResultV1Schema.safeParse(response);
    if (!parsed.success) throw Object.assign(new Error('target_unavailable'), { code: 'target_unavailable', details: createActionRefusalDetailsV1('target_unavailable', 'channels_result_invalid') });
    if (parsed.data.kind === 'links' && parsed.data.sessionId !== input.sessionId) {
      throw Object.assign(new Error('target_unavailable'), { code: 'target_unavailable', details: createActionRefusalDetailsV1('target_unavailable', 'channels_session_mismatch') });
    }
    return parsed.data;
  };
  const { sessionList, sessionRead, sessionFollowPreview } = params.credentials
    ? createSessionListActionDeps({
        ...(params.isCredentialCurrent ? { isCredentialCurrent: params.isCredentialCurrent } : {}),
        readWorkspaceRefs: async input => {
          const denied = await projectAccountAdmission(input.project?.serverId, input.context);
          if (denied) throw Object.assign(new Error(denied.errorCode), { code: denied.errorCode });
          const rows = await readProjectRows({ kinds: ['workspace-ref'], serverId: await resolveProjectHomeIdentity() },
            input.signal, input.context, input.context.externalActionExecutionAuthorization?.binding.actionId ?? 'session.list');
          await assertProjectRequesterCurrent(input.context);
          return rows.workspaceRefs;
        },
        credentials: params.credentials,
        ...(params.actionsSettingsProvider?.getAccountSettings
          ? { resolveAccountSettings: params.actionsSettingsProvider.getAccountSettings }
          : {}),
        ...(params.serverId ? { serverId: params.serverId } : {}),
        ...(params.serverIdentityId ? { serverIdentityId: params.serverIdentityId } : {}),
        ...(params.serverHttpBaseUrl ? { serverHttpBaseUrl: params.serverHttpBaseUrl } : {}),
        ...(params.externalActionMachineRequestPrivateKey
          ? { externalActionMachineRequestPrivateKey: params.externalActionMachineRequestPrivateKey }
          : {}),
        ...(params.externalActionMachineInstallationId
          ? { externalActionMachineInstallationId: params.externalActionMachineInstallationId }
          : {}),
      })
    : { sessionList: async () => ({ ok: false as const, errorCode: 'not_authenticated', error: 'not_authenticated' }), sessionRead: undefined,
      sessionFollowPreview: async () => ({ ok: false as const, errorCode: 'not_authenticated', error: 'not_authenticated' }) };
  const automationConversationAction = params.credentials
    ? createAutomationConversationActionExecutor({
      credentials: params.credentials,
      ...(params.resolveAuthenticatedAccountId ? { resolveAccountId: params.resolveAuthenticatedAccountId } : {}),
      ...(params.revalidatePluginActionCallerMaterialization
        ? { revalidateCallerMaterialization: params.revalidatePluginActionCallerMaterialization }
        : {}),
      ...(params.revalidatePluginActionCallerOccurrence
        ? { revalidateCallerOccurrence: params.revalidatePluginActionCallerOccurrence }
        : {}),
    })
    : null;
  const automationEventAction = params.credentials && params.resolveAutomationEventAdoptedDefinitionSet
    ? createAutomationEventActionExecutor({
      credentials: params.credentials,
      ...(params.resolveAuthenticatedAccountId ? { resolveAccountId: params.resolveAuthenticatedAccountId } : {}),
      resolveAdoptedDefinitionSet: params.resolveAutomationEventAdoptedDefinitionSet,
      nativeCompletion: {
        get port() {
          const port = actionDeps.actionAutomations;
          if (!port) throw new Error('automation_action_admission_unavailable');
          return port;
        },
        resolveDeclaration: async eventRef => {
          const lease = await params.acquireAutomationEventObservationRegistry?.();
          if (!lease) throw new Error('automation_event_declaration_unavailable');
          try {
            const entry = lease.registry.contributes.events?.find(entry => entry.pluginId === eventRef.pluginId
              && entry.definition.localId === eventRef.localId);
            return entry?.definition.kind === 'event' ? entry.definition.automation ?? null : null;
          } finally { await lease.release(); }
        },
        readDefinition: async automationId => {
          const { getAutomationDefinition } = await import('@/api/automations');
          return runWithServerHttpBaseUrl(todoHomeBaseUrl, () => getAutomationDefinition({
            token: params.credentials!.token, automationId,
          }));
        },
        resolveEncryption: async () => {
          const { createCliAutomationEncryptionResolver } = await import('./workflowTriggers');
          return createCliAutomationEncryptionResolver({ credentials: params.credentials!, serverHttpBaseUrl: todoHomeBaseUrl })();
        },
      },
      onCommittedObservation: async (observation: CommittedAutomationEventObservationV1) => {
        const noticeHomeIdentity = await resolveProjectHomeIdentity();
        const { createConfiguredHealthCheckNotices } = await import('@/deployments/deploymentServiceHealthNotices');
        const health = await createConfiguredHealthCheckNotices({ credentials: params.credentials!, serverId: noticeHomeIdentity,
          serverHttpBaseUrl: todoHomeBaseUrl, machineId: observation.caller.machineId,
          executeAction: async (action, input, options) => {
            if (!params.invokeContributedAction) return { ok: false, errorCode: 'target_unavailable', effectAttempted: false };
            const result = await params.invokeContributedAction({ action, input, context: {
              surface: 'plugin', serverId: projectHomeId, serverIdentityId: noticeHomeIdentity,
              actionCaller: observation.actionCaller, signal: options?.signal,
            },
              ...(options?.signal ? { signal: options.signal } : {}) });
            return StrictJsonValueSchema.parse(result);
          },
          readEnvironment: (environmentId, signal) => readOpenedDeploymentEnvironment(environmentId, { signal }),
          readService: async (subject, signal) => {
            const { MachineServicesDetailResultV1Schema } = await import('@happier-dev/protocol/actions/specs/machine/services');
            const result = MachineServicesDetailResultV1Schema.parse(await machineResourceDeps.machineServiceAction!({
              actionId: 'machines.services.detail', input: { serverId: projectHomeId, machineId: subject.machineId, serviceId: subject.serviceId }, context: { signal }, signal,
            }));
            return result.kind === 'service' ? result.service : null;
          },
        })(observation);
        if (health.kind === 'consumed') return;
        if (!params.acquireAutomationEventObservationRegistry) return;
        const { createPlatformFailureNotices } = await import('@/deployments/platformFailureNotices');
        const consume = createPlatformFailureNotices({ credentials: params.credentials!, serverId: noticeHomeIdentity,
          serverHttpBaseUrl: todoHomeBaseUrl, machineId: observation.caller.machineId,
          acquirePluginRuntimeRegistryLease: params.acquireAutomationEventObservationRegistry!,
          readReceipt: async ({ environmentId, deploymentId, context }) => {
            const { DeploymentReceiptGetResultV1Schema } = await import('@happier-dev/protocol/deployments/deploymentActionsV1');
            const { readDeploymentReceiptForHost } = await import('@/deployments/readReceiptForHost');
            return readDeploymentReceiptForHost({ environmentId, deploymentId, context }, {
              readMetadata: async request => {
                const result = DeploymentReceiptGetResultV1Schema.parse(await deploymentStorage('deployments.receipts.get', {
                  serverId: projectHomeId, environmentId: request.environmentId, deploymentId: request.deploymentId,
                }, request.context));
                if (!result.ok) throw Object.assign(new Error(result.error), { code: result.error });
                return result;
              },
              open: openDeploymentArtifact, assertCurrent: assertDeploymentReadCurrent,
            });
          },
          readEnvironment: async ({ environmentId, context }) => {
            const detail = await readOpenedDeploymentEnvironment(environmentId, context);
            const { readDeploymentTargetLinkArtifactV1 } = await import('@happier-dev/deployment-protocol');
            const targetLinks = await Promise.all(detail.targetLinks.map(async targetLink => {
              if (targetLink.id !== detail.environment.runtimeTargetLinkId) return { targetLink };
              const opened = readDeploymentTargetLinkArtifactV1(targetLink,
                await openDeploymentArtifact(targetLink.contentArtifactId, context));
              if (!opened.ok) return refuseDeploymentArtifactRead(opened);
              return { targetLink, content: opened.content };
            }));
            return { ...detail, targetLinks };
          },
        });
        await consume(observation);
      },
      ...(params.revalidatePluginActionCallerMaterialization
        ? { revalidateCallerMaterialization: params.revalidatePluginActionCallerMaterialization }
        : {}),
      ...(params.revalidatePluginActionCallerOccurrence
        ? { revalidateCallerOccurrence: params.revalidatePluginActionCallerOccurrence }
        : {}),
    })
    : null;
  const reviewCommentAction = params.credentials
    ? createCliReviewCommentActionExecutorFromCredentials({ credentials: params.credentials })
    : null;
  const { callMachineAction, isMachineActionServerScopeCurrent } = createCliMachineActionTransport(params);
  const inventoryDeps = createCliActionInventoryDeps({ ...params, callMachineAction,
    localMachineId,
    authorizeConnectedAccountRequest: (context, request) => resolveServerRequestHeaders(context,
      context?.externalActionExecutionAuthorization?.binding.actionId ?? 'sessions.spawn.connected_services.list', request),
    readCurrentSessionMetadata: () => readCurrentSessionMetadata(),
    resolveTransportForSession: (id, signal) => resolveTransportForSession(id, signal),
  });

  const readCurrentSessionMetadata = createCliBoundSessionMetadataReader({ ...params,
    // Transport resolution is lazy; the owner is constructed later in this composition.
    resolveTransportForSession: (id, signal) => resolveTransportForSession(id, signal),
  });

  const resolveCurrentSessionValue = async (key: 'path' | 'host' | 'machineId', signal?: AbortSignal): Promise<string | null> => {
    const rawValue = params.rawSession?.[key];
    if (typeof rawValue === 'string' && rawValue.trim().length > 0) {
      return rawValue.trim();
    }

    const metadata = await readCurrentSessionMetadata(signal);
    const metadataValue = metadata?.[key];
    return typeof metadataValue === 'string' && metadataValue.trim().length > 0
      ? metadataValue.trim()
      : null;
  };
  const pluginAdministrationDeps = createCliPluginAdministrationActionDeps(params, { approvalsStore, notSupported, readRecord, resolveCurrentSessionValue });

  const { pluginInstallApprovalChangeServices, resolvePluginInstallWorkspaceRoot, resolvePluginInstallRegistry } = pluginAdministrationDeps;
  const approvalActionDeps = createCliApprovalActionDeps(params, { approvalsStore, managedMachineReferences, normalizeStringValue, pluginInstallApprovalChangeServices, readRecord, resolvePluginInstallWorkspaceRoot, resolvePluginInstallRegistry });
  const artifactApprovalStore = approvalActionDeps.artifactApprovalStore;
  const { readTransportSessionOwnerMetadata, readCurrentMachineControlIdentity, resolveTransportForSession, resumeInactiveSessionTransport, callSessionRpcForTransport, readSessionActionRpcOrigin, callSessionActionRpc, dispatchSessionLifecycleHookEvent, callResolvedSessionRpc } = createCliSessionActionTransport(params, { callMachineAction, normalizeStringValue, readCurrentSessionMetadata, readServerFeaturesSnapshot, resolveCurrentSessionValue, resolveServerRequestHeaders, withProjectHome });


  const resolveSessionSpawnAgentInventorySelection: NonNullable<
    ActionExecutorDeps['resolveSessionSpawnAgentInventorySelection']
  > = async ({ agentTarget }) => {
    const { resolveSessionCreationAgentTarget } = await import("@/session/creation/resolveSessionCreationAgentTarget");
    const resolvedTarget = resolveSessionCreationAgentTarget(agentTarget);
    return resolvedTarget
      ? {
          agentId: resolvedTarget.agentId,
          backendTargetKey: buildBackendTargetKeyV2(resolvedTarget.backendTarget),
        }
      : null;
  };

  const requireLocalPromptActionMachine = async (machineId: string): Promise<Readonly<{
    ok: true;
  }> | Readonly<{
    ok: false;
    errorCode: 'machine_not_found';
    error: 'machine_not_found';
  }>> => {
    const current = await readCurrentMachineControlIdentity();
    return current.machineId === machineId
      ? { ok: true }
      : { ok: false, errorCode: 'machine_not_found', error: 'machine_not_found' };
  };
  const goalActionDeps = createCliGoalActionDeps(params, { callMachineAction, callSessionRpcForTransport, normalizeStringValue, readCurrentMachineControlIdentity, readTransportSessionOwnerMetadata, resolveTransportForSession });

  const executeSessionBoundScmAction = createSessionBoundScmAction(params, {
    callMachineAction, isMachineActionServerScopeCurrent, invokeSessionPullRequestBinding,
    normalizeStringValue, readCurrentMachineControlIdentity, readTransportSessionOwnerMetadata,
    resolveServerRequestHeaders, resolveTransportForSession,
  });

  const resolveWorkspacePublishCaller = async (context: ActionExecutorContext) => {
    const caller = await resolveActionCallerSession(context);
    if (!caller?.directory || !caller.machineId || !(await requireLocalPromptActionMachine(caller.machineId)).ok) return null;
    return { sessionId: caller.sessionId, machineId: caller.machineId, directory: caller.directory,
      ...(context.runtimeRunId ? { runId: context.runtimeRunId } : {}) };
  };
  const sessionContentCredentials = params.credentials ?? params.sessionContentCredentials;
  const connectedServiceAction = params.credentials ? createCliConnectedServiceAction({
    credentials: params.credentials, ...exactHome, serverId: projectHomeId, resolveHeaders: resolveServerRequestHeaders, callMachineAction,
    ...(params.connectedAccountAuthenticationHost ? { authenticationHost: params.connectedAccountAuthenticationHost } : {}),
    readHomeDomainAction: () => (readEffectiveDeps?.() ?? actionDeps).homeDomainAction,
    ...(params.savedSecretOperationContext ? { operationContext: params.savedSecretOperationContext } : {}),
    ...(params.isCredentialCurrent ? { isCredentialCurrent: params.isCredentialCurrent } : {}),
  }) : undefined;
  const deploymentStorageDeps = createCliDeploymentActionDeps({
    serverHttpBaseUrl: todoHomeBaseUrl, admitAccount: admitAccountStorage,
    ...(homeAccountId && params.credentials ? { localAccount: { accountId: homeAccountId, token: params.credentials.token } } : {}),
    resolveRequestHeaders: resolveAccountStorageHeaders,
    prepareEnvironment: async request => {
      if (!params.credentials) return executionRunActionFailure('client_required');
      return createPrepareEnvironmentContentForHost({ credentials: params.credentials,
        serverHttpBaseUrl: todoHomeBaseUrl, resolveRequestHeaders: resolveAccountStorageHeaders })(request);
    },
    prepareBindings: async request => {
      if (!params.credentials) return executionRunActionFailure('client_required');
      const { readSettings } = await import('@/persistence');
      const machineId = request.context.externalActionExecutionAuthorization?.binding.machineId
        ?? params.machineActionDirectTargetTransport?.machineId ?? (await readSettings()).machineId;
      if (!machineId) return executionRunActionFailure('machine_not_found');
      return createPrepareDeploymentBindingsForHost({ credentials: params.credentials,
        serverId: request.input.serverId, serverHttpBaseUrl: todoHomeBaseUrl, machineId, resolveRequestHeaders: resolveAccountStorageHeaders,
        ...(params.savedSecretOperationContext ? { savedSecretOperationContext: params.savedSecretOperationContext } : {}),
      })(request);
    },
    dispatchReceipt: async () => executionRunActionFailure('deployment_executor_unavailable'),
  });
  const deploymentStorage = deploymentStorageDeps.deploymentAction!;
  const transcriptDeps = createCliTranscriptActionDeps(params, { resolveServerRequestHeaders });
  const filesystemDeps = createCliFilesystemActionDeps(params, { callMachineAction, isMachineActionServerScopeCurrent, readRecord });
  const awarenessDeps = createCliAwarenessActionDeps(params, { resolveServerRequestHeaders, readServerFeaturesSnapshot, isSameActionHomeId });
  const { actionDeps: executionRunActionDeps, callDetachedExecutionRunRpc, readExecutionRunTransportMachineId } = createCliExecutionRunActionDeps(params, {
    resolveTransportForSession, readCurrentMachineControlIdentity, readTransportSessionOwnerMetadata, resumeInactiveSessionTransport, callMachineAction, isMachineActionServerScopeCurrent, normalizeStringValue, isExecutionRunActionAbort, executionRunActionFailure,
  });

  const assertDeploymentReadCurrent = async (context: ActionExecutorContext) => {
    context.signal?.throwIfAborted();
    const denied = await admitAccountStorage(projectHomeId, context);
    if (denied) throw Object.assign(new Error(denied.errorCode), { code: denied.errorCode });
    await assertProjectRequesterCurrent(context);
    if (params.isCredentialCurrent && !await params.isCredentialCurrent()) {
      throw Object.assign(new Error('action_account_scope_changed'), { code: 'action_account_scope_changed' });
    }
  };
  const openDeploymentArtifact = async (artifactId: string, context: ActionExecutorContext) => {
    await assertDeploymentReadCurrent(context);
    if (context.externalActionExecutionAuthorization) return (await readProjectRequesterArtifact({
      kind: 'doc', serverId: projectHomeId, artifactId,
    }, { signal: context.signal }, context))?.document ?? null;
    if (!roleArtifactStore) throw Object.assign(new Error('not_authenticated'), { code: 'not_authenticated' });
    return withProjectHome(() => roleArtifactStore.read(artifactId, { signal: context.signal,
      prepareRecipients: false, includeSharedAudience: false }));
  };
  const readOpenedDeploymentEnvironment = async (environmentId: string, context: ActionExecutorContext,
    backupPolicy?: import('@happier-dev/protocol/deployments/deploymentBackupActionsV1').DeploymentBackupPolicyV1,
    serverId = projectHomeId) => {
    const { readDeploymentEnvironmentForHost } = await import('@/deployments/readEnvironmentForHost');
    await assertDeploymentReadCurrent(context);
    return readDeploymentEnvironmentForHost({ environmentId, context, ...(backupPolicy ? { backupPolicy } : {}) }, {
      readMetadata: async request => {
        const loaded = await deploymentStorage('deployments.environments.get', {
          serverId, environmentId: request.environmentId,
        }, request.context);
        const parsed = DeploymentEnvironmentGetResultV1Schema.safeParse(loaded);
        if (!parsed.success || !parsed.data.ok) {
          const code = 'errorCode' in loaded ? loaded.errorCode : parsed.success && !parsed.data.ok ? parsed.data.error : 'invalid_action_output';
          throw Object.assign(new Error(code), { code });
        }
        return parsed.data;
      },
      open: openDeploymentArtifact,
      assertCurrent: assertDeploymentReadCurrent,
    });
  };
  const nativeAccount = homeAccountId && hasStoredSessionCredentialProvenance(params.credentials)
    ? { accountId: homeAccountId, serverId: projectHomeId,
      isCurrent: async () => Boolean(params.isCredentialCurrent && await params.isCredentialCurrent()
        && roleAccountLifetimeToken === getActiveAccountSettingsSnapshotLifetimeToken()) }
    : undefined;
  const workflowRunStorageHost = createCliWorkflowRunStorage(params, resolveCurrentSessionValue, resolveServerRequestHeaders, normalizeStringValue);
  const workflowFamilyHost: CliWorkflowFamilyHost = {
    listContributedActionDefinitions: selection => (readEffectiveDeps?.() ?? actionDeps).listContributedActionDefinitions?.(selection) ?? [],
    readLocalActionSpec: async (input, target) => {
      const installedMachineId = localMachineId ?? (await readCurrentMachineControlIdentity()).machineId;
      if (target.machineId !== installedMachineId) return null;
      return createActionExecutor(readEffectiveDeps?.() ?? actionDeps).execute('action.spec.get', input, {
        surface: 'cli', authority: 'account_automation',
        externalActionTarget: { kind: 'machine', machineId: target.machineId,
          project: { machineId: target.machineId, directory: target.directory } },
        ...(target.signal ? { signal: target.signal } : {}),
      });
    },
    ...(nativeAccount ? { nativeAccount } : {}), deploymentAction: (...args) => actionDeps.deploymentAction!(...args),
    roleArtifactStore, readRoleSources, projectHomeId, actionHomeId, callMachineAction, sessionList, sessionRead, approvalsStore, readCurrentSessionMetadata, resolveAgentStartContext, isSameActionHomeId, resolveServerRequestHeaders, resolveCurrentSessionValue, readProjectRows, resolveProjectHomeIdentity, readServerFeaturesSnapshot, resolveActionCallerSession, resolveSessionAgentIdentity, invokeSessionPullRequestBinding, resolveTransportForSession, readTransportSessionOwnerMetadata, callSessionRpcForTransport, callDetachedExecutionRunRpc, accountCallerContext, callerSessionResolution, normalizeStringValue, readExecutionRunTransportMachineId,
  };
  const workflowFamily = createCliWorkflowFamily(params, workflowFamilyHost, workflowRunStorageHost);
  const { workflowTriggers, prepareNativeGoalOwner, readWorkflowApprovedOperation, readWorkflowActionStartContext, workflowAction, workflowActionPort, prepareWorkflowRunStartApproval,
    startCombinedWorkflow, waitForCombinedWorkflow, readCombinedWorkflowInvocations } = workflowFamily;
  params.registerWorkflowTriggerList?.(async (input, context) => {
    const requester = readRequesterAccountActionContext(context?.externalActionExecutionAuthorization);
    if (context?.externalActionExecutionAuthorization && !requester) {
      throw Object.assign(new Error('source_unavailable'), { code: 'source_unavailable' });
    }
    // Approval replay restores its requester after this executor was constructed.
    // Rebind the same family at its Artifact/Automation boundaries for this read.
    const family = requester && (requester.credentials.token !== params.token
      || requester.serverHttpBaseUrl !== params.serverHttpBaseUrl)
      ? createCliWorkflowFamily({ ...params, credentials: requester.credentials, token: requester.credentials.token,
        serverHttpBaseUrl: requester.serverHttpBaseUrl,
        serverIdentityId: requester.authorization.binding.serverIdentityId,
        admittedAccountEncryptionMode: requester.accountEncryptionCurrentness.mode,
        savedSecretOperationContext: requester.savedSecretOperationContext,
        isCredentialCurrent: requester.isCurrent, workflowRequesterCustody: undefined, workflowAction: undefined,
      }, { ...workflowFamilyHost, roleArtifactStore: createCredentialedAccountArtifactStore(requester.credentials),
        nativeAccount: { accountId: requester.authorization.binding.accountId, serverId: projectHomeId,
          isCurrent: requester.isCurrent },
      }, workflowRunStorageHost) : workflowFamily;
    if (!family.workflowTriggers) throw Object.assign(new Error('source_unavailable'), { code: 'source_unavailable' });
    return family.workflowTriggers.list(input, context);
  });
  const spawnActionDeps = createCliSpawnActionDeps(params, { callMachineAction, isSameActionHomeId, machineReferenceServerUrl, normalizeStringValue, prepareAccountRoleOverrides, prepareSourceKeyAfterCommit, projectHomeId, readAccountRoleOverrides, readRecord, readRoleSources, resolveServerRequestHeaders, roleSettingsProvider, spawnConnectedServicesList: inventoryDeps.spawnConnectedServicesList, workflowTriggers });
  const machineInventoryDeps = createCliMachineInventoryActionDeps(params, { callMachineAction, inventoryDeps });
  const artifactsDeps = createCliArtifactsActionDeps(params, { artifactCallerContext, callMachineAction, homeAccountId, readRawRoleSettings, mutateRawAccountSettings, requireLocalPromptActionMachine, resolveServerRequestHeaders, resolveWorkspacePublishCaller, roleAccountLifetimeToken, roleAccountScopeKey, roleArtifactStore,
    readWidgetTitles: (...args) => widgetDeps.readWidgetTitles(...args), widgetAccountScope: () => widgetDeps.widgetAccountScope?.() ?? null,
    isWidgetScopeCurrent: () => widgetDeps.isWidgetScopeCurrent() });
  const messageActionDeps = createCliMessageActionDeps(params, { assertProjectRequesterCurrent, callSessionActionRpc, callSessionRpcForTransport, dispatchSessionLifecycleHookEvent, projectAccountAdmission, readServerFeaturesSnapshot, resolveServerRequestHeaders, resolveTransportForSession, withProjectHome });
  const settingsDeps = createCliSettingsActionDeps(params, { callMachineAction });
  const machineDeps = createCliMachineActionDeps(params, { callMachineAction, isMachineActionServerScopeCurrent });
  const updatesRolloutDeps = createMachineUpdatesRolloutActionDeps({ orchestrationDirectory: configuration.happyHomeDir,
    startCombined: startCombinedWorkflow, waitForRun: request => waitForCombinedWorkflow(request, request.start.runId) });
  const setupDeps = createCombinedMachineSetupActionDeps({
    readDeps: () => readEffectiveDeps?.() ?? actionDeps,
    targetPlan: machineDeps.machineSetupPlan!,
    orchestrationDirectory: configuration.happyHomeDir,
    startCombined: startCombinedWorkflow,
    waitForRun: request => waitForCombinedWorkflow(request, request.start.runId),
    readInvocations: readCombinedWorkflowInvocations,
    readHostFacts: async (context, selectedMachineId, requestedTargetMachineIds) => {
      const authorization = context.externalActionExecutionAuthorization;
      const binding = authorization?.binding;
      // A new combined Run persists Account content. Its ordinary preparation
      // consumes the token owner's material availability before asking for consent.
      // Accepted native leaves already receive their opened Run content.
      if (binding && 'credentialId' in binding && binding.accountEncryptionMode === 'e2ee'
        && binding.actionId !== SESSION_SPAWN_MACHINE_SETUP_CHILDREN_V1.plan.action
        && !binding.workflowActionOrigin && !binding.managedContinuation
        && context.actionCaller?.kind !== 'workflowRun'
        && !readRequesterAccountEncryptionMaterialSnapshot(authorization)) {
        throw Object.assign(new Error('api_token_encryption_access_unavailable'), { code: 'content_unavailable' });
      }
      const directMachineId = params.machineActionDirectTargetTransport?.machineId;
      if (directMachineId && selectedMachineId === directMachineId
        && requestedTargetMachineIds?.every(machineId => machineId === directMachineId) !== false) {
        return { machines: [{ machineId: directMachineId, online: true }], offlineMachineIds: [] };
      }
      const [{ listCurrentAccountMachines }, { isMachineReachableV1 }] = await Promise.all([
        import('@/api/machine/resolveCurrentAccountMachineTarget'), import('@happier-dev/protocol/machines/machineReachabilityV1'),
      ]);
      const agentSession = selectedMachineId === undefined && (context.actionCaller?.kind === 'session'
        || context.surface === 'agent' || context.surface === 'mcp') ? await resolveActionCallerSession(context) : null;
      const machines = await listCurrentAccountMachines({ token: params.token, credentials: params.credentials,
        projection: 'hostFacts', ...(selectedMachineId
          ? { machineIds: [...new Set([selectedMachineId, ...(requestedTargetMachineIds ?? [])])] } : {}),
        authorization: context.externalActionExecutionAuthorization,
        effectActionId: context.externalActionExecutionAuthorization?.binding.actionId === 'machines.setup.plan'
          ? 'machines.setup.plan' : 'machines.setup.apply', serverHttpBaseUrl: todoHomeBaseUrl, signal: context.signal });
      return { ...(agentSession?.machineId ? { agentMachineId: agentSession.machineId } : {}),
        // Only admitted current presence classifies a recoverable offline row.
        // Missing, retired or access-denied rows still reach their target owner.
        // The direct target also keeps its transport-owned reachability decision.
        offlineMachineIds: machines.filter(machine => machine.id !== params.machineActionDirectTargetTransport?.machineId
          && machine.revokedAt === null && machine.replacedByMachineId === null
          && (!machine.access || machine.access.accessState === 'ready')
          && !isMachineReachableV1({ machine, nowMs: Date.now() })).map(machine => machine.id),
        machines: machines.filter(machine => !selectedMachineId || machine.id === selectedMachineId).map(machine => ({ machineId: machine.id,
        online: !machine.replacedByMachineId && (!machine.access || machine.access.accessState === 'ready')
          && isMachineReachableV1({ machine, nowMs: Date.now() }) })) };
    },
  });
  const { sessionPermissionModeSet, ...permissionActionDeps } = createCliPermissionActionDeps(params, { callSessionActionRpc, readSessionActionRpcOrigin, resolveServerRequestHeaders, resolveTransportForSession, resumeInactiveSessionTransport, withProjectHome });
  const readAdmittedProjectRows = createCliAdmittedProjectRowsReader({ widgetHomeId, projectAccountAdmission, readProjectRows, assertProjectRequesterCurrent });
  const readRepositoryWorkspaceMachine = async (
    workspace: Parameters<typeof resolveAdmittedRepositoryWorkspace>[0]['workspace'], context: ActionExecutorContext, actionId: string,
  ): ReturnType<typeof resolveDeploymentTemplateExecutionMachineIdV1> => {
    const selected = await resolveAdmittedRepositoryWorkspace({ workspace, context,
      readWorkspaceRows: readAdmittedProjectRows, fallbackActionId: actionId });
    if (!('kind' in selected)) return selected;
    return selected.kind === 'resolved' ? { ok: true, machineId: selected.workspace.machineId }
      : executionRunActionFailure(selected.reason);
  };
  const dispatchOriginalDeploymentRoot = async (
    actionId: Parameters<typeof dispatchOriginalAccountAction>[0]['actionId'], input: unknown, context: ActionExecutorContext,
    readMachine: () => ReturnType<typeof resolveDeploymentTemplateExecutionMachineIdV1>,
  ) => {
    const workflow = context.actionCaller?.kind === 'workflowRun';
    if (!params.credentials || context.externalActionCredential || context.externalActionExecutionAuthorization
      || context.rpcSessionAuthorization || context.actionCaller && context.actionCaller.kind !== 'host' && !workflow)
      return executionRunActionFailure('deployment_executor_unavailable');
    if (!context.actionRequestId || workflow && context.runtimeAccountId && context.runtimeAccountId !== homeAccountId)
      return executionRunActionFailure('admission_unavailable');
    const publisherMachineId = params.machineActionDirectTargetTransport?.machineId;
    const installedWorkflow = workflow && publisherMachineId && params.serverIdentityId
      && params.externalActionMachineRequestPrivateKey && params.externalActionMachineInstallationId
      ? { context, machineId: publisherMachineId, installationId: params.externalActionMachineInstallationId,
          privateKey: params.externalActionMachineRequestPrivateKey } : undefined;
    if (workflow && !installedWorkflow) return executionRunActionFailure('admission_unavailable');
    const selected = await readMachine();
    if (!selected.ok) return selected;
    const target = { kind: 'machine' as const, machineId: selected.machineId };
    const invocation = installedWorkflow ? null : homeAccountId ? projectExternalActionRequesterInvocationV1({
      actionId, context: { ...context, actionCaller: { kind: 'host' }, surface: context.surface ?? 'cli',
        authority: context.authority ?? 'account_automation' },
      account: { accountId: homeAccountId, serverId: actionHomeId,
        ...(params.serverIdentityId ? { serverIdentityId: params.serverIdentityId } : {}) }, target,
      authentication: { kind: readAuthTokenProvenance(decodeJwtPayload(params.credentials.token))?.provenance.kind === 'terminal'
        ? 'terminal' : 'account' },
    }) : null;
    if (!installedWorkflow && !invocation) return executionRunActionFailure('admission_unavailable');
    return dispatchOriginalAccountAction({ actionId, input, requestId: context.actionRequestId,
      target, credentials: params.credentials,
      ...(installedWorkflow ? { authority: 'account_automation' as const, installedWorkflow }
        : { authority: context.authority, invocation: invocation! }),
      serverHttpBaseUrl: todoHomeBaseUrl,
      ...(params.serverIdentityId ? { serverIdentityId: params.serverIdentityId } : {}),
      ...(params.onRequesterSessionCredentialDisclosure ? { onRequesterSessionCredentialDisclosure: params.onRequesterSessionCredentialDisclosure } : {}),
      ...(params.isCredentialCurrent ? { isCurrent: params.isCredentialCurrent } : {}),
      ...(context.signal ? { signal: context.signal } : {}) });
  };

  const projectDeps = createCliProjectActionDeps(params, { readAdmittedProjectRows, callMachineAction, isMachineActionServerScopeCurrent, executionRunActionFailure, isExecutionRunActionAbort, projectAccountAdmission, projectRowsAuthority, readProjectRows, resolveProjectHomeIdentity, withProjectHome, assertProjectRequesterCurrent, readProjectRequesterArtifact, projectHomeId, widgetHomeId, homeAccountId, todoHomeBaseUrl, todoHomeServerId, approvalsStore, exactHome });
  const machineResourceDeps = createCliMachineResourceActionDeps(params, { projectHomeAdmission, callMachineAction, assertProjectRequesterCurrent, projectAccountAdmission, withProjectHome, projectHomeId, machineRebootReferences,
    readEnvironmentAccess: deploymentStorageDeps.readEnvironmentAccess,
    observeEnvironmentAccessChanges: deploymentStorageDeps.observeEnvironmentAccessChanges, executionRunActionFailure });
  const connectionsDeps = createCliConnectionsActionDeps(params, { callMachineAction, connectedServiceAction, projectHomeId,
    resolveAuthorizationHeaders: (actionId, context, request) => resolveServerRequestHeaders(context, actionId, request),
    registryActionExecute: request => { if (!actionDeps.registryActionExecute) throw new Error('registry_unavailable'); return actionDeps.registryActionExecute(request); } });

  const widgetDeps = createCliWidgetActionDeps(params, { callMachineAction, exactHome, homeAccountId, isSameActionHomeId, normalizeStringValue, readTransportSessionOwnerMetadata, requireLocalPromptActionMachine, resolveCurrentSessionValue, resolveProjectHomeIdentity, readAdmittedProjectRows, resolveServerRequestHeaders, resolveTransportForSession, resolveWorkspacePublishCaller, roleArtifactStore, sessionContentCredentials, todoHomeBaseUrl, todoHomeServerId, widgetHomeId },
    () => readEffectiveDeps?.() ?? actionDeps, () => actionDeps);
  const readHomeWidgets = widgetDeps.readHomeWidgets;
  const rolesDeps = createCliRolesActionDeps(params, { artifactCallerContext, callSessionActionRpc, prepareAccountRoleOverrides, readRawRoleSettings, mutateRawAccountSettings, readReadyAccountRoleOverrides, readRoleSources, resolveActionCallerSession, resolveAgentStartContext, resolveServerRequestHeaders, resolveTransportForSession, roleAccountLifetimeToken, roleAccountScopeKey, roleArtifactStore, sessionList, sessionRead, readAccountRoleOverrides }, () => readEffectiveDeps?.() ?? actionDeps);
  const { sessionUsageLimitWaitResumeEnable, sessionUsageLimitWaitResumeCancel, sessionUsageLimitCheckNow, sessionUsageLimitSwitchAccountNow, sessionUsageLimitConsumeResetCredit } = createCliUsageLimitRecoveryActionDeps(params, { callSessionRpcForTransport, normalizeStringValue, readTransportSessionOwnerMetadata, resolveTransportForSession });
  const promptsDeps = createCliPromptsActionDeps(params, { approvalsStore, callMachineAction, callSessionActionRpc, notSupported, projectHomeId, promptLibraryStoreForContext, skillRulesForContext, readCurrentMachineControlIdentity, requireLocalPromptActionMachine, resolveServerRequestHeaders, resolveTransportForSession,
    readRegistryAppEnvironment: readOpenedDeploymentEnvironment,
  });
  const { sessionVendorPluginCatalogList, sessionSkillCatalogList } = createCliSessionCatalogActionDeps(params, { callSessionRpcForTransport, readCurrentMachineControlIdentity, readTransportSessionOwnerMetadata, resolveTransportForSession });
  const { sessionExchangePrepare, sessionExchangeControl, sessionTurnCancel, sessionCompact, sessionRuntimeRefresh, sessionStop, sessionControlSwitch, sessionModeSet, sessionConnectedServicesAuthSet } = createCliControlActionDeps(params, { callMachineAction, readServerFeaturesSnapshot, resolveServerRequestHeaders, resolveTransportForSession, withProjectHome });
  const { homeRuntimeTaskRpc, prepareLocalServiceStartApproval, runtimeActionExecute } = createCliLocalServiceActionDeps(params, {
    callMachineAction, projectHomeId, projectHomeAdmission, withProjectHome, executionRunActionFailure,
  });
  const { sessionTerminalComposerClear, sessionPendingInputInterruptAndRun, sessionPendingRequeue, sessionPendingActionSet, sessionPendingWithdraw, sessionPendingMarkHandled, sessionPendingDismiss, sessionPendingSendAsNew, sessionPendingResetStartSet, sessionPendingResetStartCancel } = createCliPendingActionDeps(params, { assertProjectRequesterCurrent, callResolvedSessionRpc, executionRunActionFailure, projectHomeAdmission, readServerFeaturesSnapshot, resolveServerRequestHeaders, withProjectHome });
  const tasksDeps = createCliTasksActionDeps(params, { homeAccountId, resolveServerRequestHeaders, todoHomeBaseUrl, todoHomeServerId, actionHomeId });
  const { sessionUpdatePost, sessionManagerSet, sessionOrganizationPinSet, sessionAttentionSet, sessionApprovalReviewerSet, sessionStateFieldSet, currentSessionPresentationApply } = createCliMetadataActionDeps(params, { callSessionActionRpc, executionRunActionFailure, isSameActionHomeId, normalizeStringValue, prepareSourceKeyAfterCommit, projectHomeId, readServerFeaturesSnapshot, resolveServerRequestHeaders, resolveTransportForSession, withProjectHome });
  const launchProfilesDeps = createCliLaunchProfilesActionDeps(params, { artifactCallerContext, projectAccountAdmission, roleArtifactStore });
  const { sessionModelUnarm, sessionModelSet } = createCliSessionModelActionDeps(params, { projectHomeId, resolveServerRequestHeaders });
  const agentCatalogDeps = createCliAgentCatalogActionDeps(params, { todoHomeBaseUrl });
  const { sessionOpen, sessionFork, sessionContinueWithReplay, sessionRollback, checkpointCodeRollback, sessionCheckpoint, sessionRestore, sessionContinuationInspect, sessionAgentTransition, sessionArchiveSet } = createCliSessionLifecycleActionDeps(params, { callMachineAction, callResolvedSessionRpc, normalizeStringValue, notSupported, readCurrentMachineControlIdentity, readTransportSessionOwnerMetadata, resolveServerRequestHeaders, resolveTransportForSession, resumeInactiveSessionTransport,
    sessionStop: input => (readEffectiveDeps?.() ?? actionDeps).sessionStop!(input),
  });
  const { sessionHandoffTargetReplacementApprovalPreflight, sessionHandoffStart, sessionHandoffStatusGet, sessionHandoffPrepareTargetResume } = createCliSessionHandoffActionDeps(params, { callMachineAction, notSupported, resolveTransportForSession });
  const { sessionStatusGet, sessionWorkStateGet, sessionWaitIdle } = createCliSessionStatusActionDeps(params, { assertProjectRequesterCurrent, callMachineAction, callResolvedSessionRpc, executionRunActionFailure, homeAccountId, isSameActionHomeId, projectAccountAdmission, projectHomeId, projectRowsAuthority, readServerFeaturesSnapshot, resolveProjectHomeIdentity, resolveServerRequestHeaders, withProjectHome, machinesAgentsList: machineInventoryDeps.machinesAgentsList!, readHomeDomainAction: () => (readEffectiveDeps?.() ?? actionDeps).homeDomainAction });
  const workspaceSyncDeps = createCliWorkspaceSyncActionDeps(params, { actionHomeId, callMachineAction, normalizeStringValue, notSupported, projectHomeAdmission, projectHomeId, readProjectRows, readRecord, resolveProjectHomeIdentity });































  const openPrivateLabel = createCliPrivateLabelActionOpener(params.credentials?.token === params.token ? params.credentials.encryption : null);
  const actionDeps: CliActionDeps = {
    actionAutomations: createCliActionAutomationPortV1({ token: params.token,
      serverHttpBaseUrl: params.serverHttpBaseUrl ?? resolveServerHttpBaseUrl(),
      isCredentialCurrent: params.isCredentialCurrent,
    }),
    prepareNativeGoalOwner,
    machinePresetPrepare: params.machinePresetPrepare,
    machinePresetArchive: params.machinePresetArchive,
    privateLabelOpen: async (request, context) => {
      if (context.serverId && !await isSameActionHomeId(context.serverId)) return null;
      if (params.isCredentialCurrent && !await params.isCredentialCurrent()) {
        throw Object.assign(new Error('The Account credential is no longer current.'), { code: 'action_account_scope_changed' });
      }
      return await openPrivateLabel(request, context);
    },
    readActionApprovalProfileId: async context => {
      const callerSessionId = context.actionCaller?.kind === 'session'
        ? context.actionCaller.sessionId : context.defaultSessionId;
      const applies = context.actionCaller?.kind === 'session'
        || (typeof callerSessionId === 'string' && callerSessionId === params.sessionId
          && readCliActionBoundSessionId(callerSessionId) !== null);
      if (!applies) return undefined;
      const caller = await resolveActionCallerSession(context).catch(() => {
        context.signal?.throwIfAborted();
        return null;
      });
      if (!caller?.metadata) return { ok: false, errorCode: 'approval_context_unavailable', error: 'approval_context_unavailable' };
      const approvalProfileId = resolveSessionApprovalProfileReferenceV1(caller.metadata);
      return { approvalProfileId, approvalProfileTeamOrGroupDerived: caller.metadata.approvalProfileTeamOrGroupDerived === true };
    },
    readApprovalProfile: async (id, context) => {
      const read = () => params.savedSecretOperationContext
        ? params.savedSecretOperationContext.readSnapshot()?.approvalProfileCatalog
        : profileSettingsProvider.getApprovalProfiles?.();
      let catalog = read();
      if (catalog === undefined && params.credentials) {
        const activate = async () => {
          if (params.savedSecretOperationContext) await refreshActiveApprovalProfileCatalog({ credentials: params.credentials!,
            operationContext: params.savedSecretOperationContext, signal: context.signal });
          else await profileSettingsProvider.prepareApprovalProfiles?.(context.signal);
        };
        await (params.serverHttpBaseUrl ? runWithServerHttpBaseUrl(params.serverHttpBaseUrl, activate) : activate());
        catalog = read();
      }
      return bindApprovalProfileV1(catalog ?? [], id);
    },
    resolveEnvironmentApprovalScope: params.resolveEnvironmentApprovalScope ?? deploymentStorageDeps.resolveEnvironmentApprovalScope,
    ...(params.prepareDeploymentAction ? { prepareDeploymentAction: params.prepareDeploymentAction } : {}),
    ...(params.prepareDeploymentTeardown ? { prepareDeploymentTeardown: params.prepareDeploymentTeardown } : {}),
    ...(params.prepareDeploymentEnvironmentCreate ? { prepareDeploymentEnvironmentCreate: params.prepareDeploymentEnvironmentCreate } : {}),
    prepareHostReviewedChildren: async request => {
      const presetAuthoring = await prepareCliManagedMachinePresetAuthoring(request, {
        credentials: params.credentials, serverUrl: todoHomeBaseUrl,
      });
      if (presetAuthoring) return presetAuthoring;
      const sourceMove = request.actionId === PROJECT_SOURCE_MOVE_TO_TEAM_ACTION_ID_V1 ? await prepareCliProjectSourceTeamMove(request, {
        accountId: homeAccountId,
        credentialAuthorityKind: readAuthTokenProvenance(decodeJwtPayload(params.token), { allowLegacyHome: true })?.provenance.kind ?? 'none',
        homeId: actionHomeId, serverHttpBaseUrl: todoHomeBaseUrl,
        readDeps: () => readEffectiveDeps?.() ?? actionDeps,
        isSameHomeId: isSameActionHomeId, assertCurrent: assertDeploymentReadCurrent,
        openArtifact: openDeploymentArtifact, headers: resolveAccountStorageHeaders,
      }) : null;
      if (sourceMove) return sourceMove;
      const refusal = await prepareCliManagedProvisionerAdmission(request, {
        credentials: params.credentials, serverUrl: todoHomeBaseUrl,
        managedMachineAction: (readEffectiveDeps?.() ?? actionDeps).managedMachineAction,
        machinePresetAction: (readEffectiveDeps?.() ?? actionDeps).machinePresetAction,
      });
      if (refusal) return refusal;
      const wake = await prepareCliManagedMachineWake(request, {
        localMachineId,
        provisionerAccount: { token: params.token, credentials: params.credentials, serverUrl: todoHomeBaseUrl },
        managedMachineAction: (readEffectiveDeps?.() ?? actionDeps).managedMachineAction,
        readSessionMachineId: async (target, context) => {
          const transport = await resolveTransportForSession(target.sessionId, context.signal,
            { actionId: request.actionId, context }, context.expectedSessionAddress);
          if (!transport.ok) return executionRunActionFailure(transport.code);
          return resolveSessionInputTargetMachineId({ rawSession: transport.rawSession,
            decryptedMetadata: readTransportSessionOwnerMetadata(transport) });
        },
      });
      if (wake) return wake;
      const workflow = await prepareWorkflowRunStartApproval(request, readEffectiveDeps?.() ?? actionDeps);
      if (workflow) return workflow;
      const prepared = request.actionId === 'projects.service.relocate'
        ? await prepareProjectServiceMoveChildren({ request: ProjectServiceRelocateInputV1Schema.parse(request.input),
            context: request.context, credentials: params.credentials, serverBaseUrl: todoHomeBaseUrl,
            inspectSetup: workspace => projectDeps.projectDefinitionAction!({ actionId: 'projects.inspect',
              input: { workspace: { serverId: workspace.serverId, machineId: workspace.machineId,
                workspaceId: workspace.id, rootPath: workspace.rootPath }, read: { kind: 'setup' } }, context: request.context }),
            readRelationshipStatuses: async machineId => {
              const { WorkspaceSyncStatusV1Schema } = await import('@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas');
              const response = await callMachineAction({ machineId, method: RPC_METHODS.DAEMON_WORKSPACE_SYNC_LIST,
                request: {}, context: request.context, effectActionId: request.actionId,
                ...(request.context.signal ? { signal: request.context.signal } : {}) });
              const statuses = readRecord(response).statuses;
              return Array.isArray(statuses) ? statuses.map(value => WorkspaceSyncStatusV1Schema.parse(value)) : [];
            } })
        : await params.prepareHostReviewedChildren?.(request) ?? null;
      if (prepared && 'ok' in prepared) return prepared;
      return prepareDeploymentTargetEnablementRetention(request, { homeId: actionHomeId,
        managedMachineAction: (readEffectiveDeps?.() ?? actionDeps).managedMachineAction }, prepared);
    },
    ...(params.prepareDeploymentTemplateInstantiation ? { prepareDeploymentTemplateInstantiation: params.prepareDeploymentTemplateInstantiation } : {}),
    deploymentMoveToRepository: params.deploymentMoveToRepository ?? (async (input, context) => {
      const actionId = 'deployments.environments.moveToRepository';
      const execution = await dispatchOriginalDeploymentRoot(actionId, input, context,
        () => resolveDeploymentMoveToRepositoryExecutionMachineIdV1(input,
          workspace => readRepositoryWorkspaceMachine(workspace, context, actionId)));
      if (!execution.ok) return execution;
      const approval = ActionApprovalRequestCreatedResultSchema.safeParse(execution.result);
      if (approval.success && approval.data.actionId === actionId) return approval.data;
      const output = DeploymentMoveToRepositoryResultV1Schema.safeParse(execution.result);
      return output.success ? output.data : executionRunActionFailure('invalid_action_output');
    }),
    deploymentTemplateInstantiate: params.deploymentTemplateInstantiate ?? (async (input, context) => {
      const actionId = 'deployments.templates.instantiate';
      const execution = await dispatchOriginalDeploymentRoot(actionId, input, context, () => resolveDeploymentTemplateExecutionMachineIdV1(input, async request => {
        const loaded = await deploymentStorage('deployments.environments.get', request, context);
        return 'errorCode' in loaded ? loaded : DeploymentEnvironmentGetResultV1Schema.parse(loaded);
      }, request => readRepositoryWorkspaceMachine(request.workspace, context, actionId)));
      if (!execution.ok) return execution;
      const approval = ActionApprovalRequestCreatedResultSchema.safeParse(execution.result);
      if (approval.success && approval.data.actionId === actionId) return approval.data;
      const output = DeploymentTemplateInstantiateResultV1Schema.safeParse(execution.result);
      return output.success ? output.data : executionRunActionFailure('invalid_action_output');
    }),
    deploymentPrepare: params.deploymentPrepare ?? createPrepareDeployment({ serverId: projectHomeId,
      serverIdentityId: params.serverIdentityId, serverHttpBaseUrl: todoHomeBaseUrl,
      machineId: localMachineId,
      credentials: params.credentials, isCredentialCurrent: params.isCredentialCurrent,
      readWorkspaceRows: readAdmittedProjectRows,
      readSource: (input, context) => (readEffectiveDeps?.() ?? actionDeps).projectSourcesRead!(input, context) }),
    deploymentReadArtifactHeaders: createDeploymentArtifactHeaderReader({ serverHttpBaseUrl: todoHomeBaseUrl, assertCurrent: assertDeploymentReadCurrent,
      ...(roleArtifactStore ? { artifacts: roleArtifactStore } : {}) }),
    deploymentAction: async (actionId, input, context, hostChild) => {
      if (actionId === 'deployments.environments.get' && 'backupPolicy' in input && input.backupPolicy) {
        try {
          const opened = await readOpenedDeploymentEnvironment(input.environmentId, context, input.backupPolicy, input.serverId);
          return DeploymentEnvironmentGetResultV1Schema.parse({ ok: true, environment: opened.environment,
            targetLinks: opened.targetLinks, backupTarget: opened.backupTarget, backupPolicy: opened.backupPolicy });
        } catch (error) {
          return projectDeploymentFailure(error instanceof Error && 'code' in error && typeof error.code === 'string'
            ? error.code : 'deployment_content_unavailable', error);
        }
      }
      if (params.deploymentAction) return params.deploymentAction(actionId, input, context, hostChild);
      if (actionId === DEPLOYMENT_ENVIRONMENT_CREATE_ACTION_ID_V1) {
        const authored = DeploymentEnvironmentCreateIntentInputV1Schema.safeParse(input);
        if (authored.success && authored.data.preview) {
          const execution = await dispatchOriginalDeploymentRoot(actionId, input, context, async () => {
            const selected = await resolveDeploymentPreviewExecutionMachineIdV1(authored.data, {
              listEnvironments: query => deploymentStorage('deployments.environments.list', query, context),
              async readTemplateController() {
                const loaded = await deploymentStorage('deployments.environments.get', {
                  serverId: authored.data.serverId, environmentId: authored.data.preview!.templateEnvironmentId }, context);
                if ('errorCode' in loaded) return loaded;
                const result = DeploymentEnvironmentGetResultV1Schema.parse(loaded);
                return result.ok ? { ok: true, machineId: result.environment.controllerMachineId }
                  : executionRunActionFailure(result.error);
              },
            });
            if (!selected.ok) return selected;
            const target = resolveExternalActionMachineTarget({ actionId, rawInput: input,
              target: context.externalActionTarget, ownerMachineId: selected.machineId, context });
            return target.kind === 'rejected' ? target.execution : selected;
          });
          if (!execution.ok) return execution;
          const approval = ActionApprovalRequestCreatedResultSchema.safeParse(execution.result);
          if (approval.success && approval.data.actionId === actionId) return approval.data;
          const output = DeploymentActionOutputSchemasV1[actionId].safeParse(execution.result);
          return output.success ? output.data : executionRunActionFailure('invalid_action_output');
        }
      }
      const authorization = context.externalActionExecutionAuthorization;
      const contributedMachineChild = context.actionCaller?.kind === 'plugin'
        && authorization?.binding.actionId === ACTION_INVOKE_ACTION_ID_V1
        && authorization.binding.target.kind === 'machine';
      if (authorization?.requesterAccountExecutor && (contributedMachineChild
        || isDeploymentObservationReadActionIdV1(actionId) && isDeploymentTargetLinkActionIdV1(authorization.binding.actionId))) {
        // Machine ingress supplies the private native executor. Its explicit
        // deploymentAction above ends delegation; retain the signed caller and
        // custody instead of re-entering controller placement from the SDK.
        const execution = await authorization.requesterAccountExecutor.execute(actionId, input, context);
        return execution.ok ? DeploymentActionOutputSchemasV1[actionId].parse(execution.result) : execution;
      }
      if (actionId === DEPLOYMENT_ENVIRONMENT_UPDATE_ACTION_ID_V1 && 'mode' in input && input.mode === 'preview'
        && input.defaultsFor === 'alerts' && getActionSpec(actionId).safetyForInput?.(input) === 'safe') {
        if (!params.credentials) return executionRunActionFailure('client_required');
        try {
          return await prepareCliDeploymentAlertDefaults(input, context, {
            credentials: params.credentials, serverId: input.serverId, serverHttpBaseUrl: todoHomeBaseUrl,
            ...(params.savedSecretOperationContext ? { savedSecretOperationContext: params.savedSecretOperationContext } : {}),
            readEnvironment: () => deploymentStorage('deployments.environments.get', {
              serverId: input.serverId, environmentId: input.environmentId,
            }, context),
            assertCurrent: assertDeploymentReadCurrent, open: openDeploymentArtifact,
            async headers(readContext, actionId, request) {
              const headers = await resolveAccountStorageHeaders(readContext, actionId, request);
              if (!headers) throw createExternalActionHeaderRefusalError();
              return headers;
            },
          });
        } catch (error) {
          return projectDeploymentFailure(error instanceof Error && 'code' in error && typeof error.code === 'string'
            ? error.code : 'deployment_content_unavailable', error);
        }
      }
      if (actionId === 'deployments.publish.prepare') {
        const selected = DeploymentActionInputSchemasV1[actionId].parse(input);
        if (context.actionCaller && context.actionCaller.kind !== 'host')
          return executionRunActionFailure('deployment_executor_unavailable');
        const execution = await dispatchOriginalDeploymentRoot(actionId, selected, context,
          async () => ({ ok: true, machineId: selected.machineId }));
        if (!execution.ok) return execution;
        const approval = ActionApprovalRequestCreatedResultSchema.safeParse(execution.result);
        if (approval.success && approval.data.actionId === actionId) return approval.data;
        const output = DeploymentActionOutputSchemasV1[actionId].safeParse(execution.result);
        return output.success ? output.data : executionRunActionFailure('invalid_action_output');
      }
      const nativeRead = isDeploymentReadActionIdV1(actionId);
      const linkPreparation = actionId === 'deployments.targets.link';
      if (!isControllerDeploymentMutationAction(actionId, input) && !nativeRead && !linkPreparation) return deploymentStorage(actionId, input, context);
      if (!('environmentId' in input)) return executionRunActionFailure('invalid_parameters');
      const loaded = await deploymentStorage('deployments.environments.get', {
        serverId: input.serverId, environmentId: input.environmentId,
      }, context);
      if ('errorCode' in loaded || 'kind' in loaded) return loaded;
      const opened = DeploymentEnvironmentGetResultV1Schema.parse(loaded);
      if (!opened.ok) return opened;
      // The same original-root owner retains requester review for every controller dispatch.
      if (actionId === DEPLOYMENT_HEALTH_CURRENT_ACTION_ID_V1) {
        const health = DeploymentActionInputSchemasV1[actionId].safeParse(input);
        if (!health.success) return executionRunActionFailure('invalid_parameters');
        // Settle placement before Home is asked to admit a read no Machine can serve.
        const placement = readDeploymentHealthCurrentPlacementFailure(health.data, opened.environment, opened.targetLinks);
        if (placement) return placement;
      }
      const execution = await dispatchOriginalDeploymentRoot(actionId, input, context, async () => ({ ok: true,
        machineId: nativeRead && 'machineId' in input && typeof input.machineId === 'string'
          ? input.machineId : opened.environment.controllerMachineId }));
      if (!execution.ok) return execution;
      const approval = ActionApprovalRequestCreatedResultSchema.safeParse(execution.result);
      if (approval.success && approval.data.actionId === actionId) return approval.data;
      const output = DeploymentActionOutputSchemasV1[actionId].safeParse(execution.result);
      return output.success ? output.data : executionRunActionFailure('invalid_action_output');
    },
    ...(params.readAdmittedInputTypeOptions ? { readAdmittedInputTypeOptions: params.readAdmittedInputTypeOptions } : {}),
    registryActionExecute: promptsDeps.registryActionExecute,
    homeRuntimeTaskRpc,
    ...(approvalsStore?.promptLibraryStore.organization ? { artifactFolders: approvalsStore.promptLibraryStore.organization,
      promptStacks: approvalsStore.promptLibraryStore.organization, skillRules: approvalsStore.skillRules } : {}),
    prepareLocalServiceStartApproval,
    browserProfileLoginsImport: async ({ input, context }) => {
      const rpc = (call: Readonly<{ machineId: string; method: string; input: unknown }>) => callMachineAction({ machineId: call.machineId,
        method: call.method, request: call.input, context, signal: context.signal, exactMachine: true,
        effectActionId: 'browser.profile.logins.import', timeoutMs: null });
      if (input.kind === 'cookies') return importBrowserProfileCookiesV1(input, rpc, context.signal);
      const activate = () => importCliSavedSecretPasskeysForOperation({ input, rpc, expectedScopeKey: roleAccountScopeKey,
        operationContext: params.savedSecretOperationContext, signal: context.signal });
      return params.serverHttpBaseUrl ? runWithServerHttpBaseUrl(params.serverHttpBaseUrl, activate) : activate();
    },
    runtimeActionExecute,
    ...(approvalsStore ? { memoryLibrary: {
      serverId: actionHomeId,
      isSameServerId: isSameActionHomeId,
      store: approvalsStore.promptLibraryStore,
      storeForContext: context => promptLibraryStoreForContext(context,
        context.externalActionExecutionAuthorization?.binding.actionId ?? 'memory.remember') ?? approvalsStore.promptLibraryStore,
      randomId: randomUUID,
      readExposure: async (artifactId, context) => {
        if (!roleArtifactStore) throw Object.assign(new Error('memory_exposure_unavailable'), { code: 'memory_exposure_unavailable' });
        return withProjectHome(() => roleArtifactStore.readExposure(artifactId, { signal: context.signal,
          authorizationHeaders: async request => {
            const headers = resolveServerRequestHeaders(context, 'artifact.access.grants.list', request);
            if (!headers) throw Object.assign(new Error('execution_not_authorized'), { code: 'execution_not_authorized' });
            return { ...headers };
          } }));
      },
      readSession: async (ref, context) => {
        if (!params.credentials) throw Object.assign(new Error('not_authenticated'), { code: 'not_authenticated' });
        const templateParentActionId = readAdmittedBotTemplateParentActionIdV1(context);
        const requesterAccountId = templateParentActionId
          && context.externalActionExecutionAuthorization && 'credentialId' in context.externalActionExecutionAuthorization.binding
          ? context.externalActionExecutionAuthorization.binding.accountId : homeAccountId;
        if (!homeAccountId || await (templateParentActionId ? projectHomeAdmission : projectAccountAdmission)(ref.serverId, context)) {
          throw Object.assign(new Error('session_target_unavailable'), { code: 'session_target_unavailable' });
        }
        const read = async () => {
          const { resolveSessionTransportContext } = await import("@/session/services/resolveSessionTransportContext");
          const target = await resolveSessionTransportContext({ reason: 'session-action', credentials: params.credentials!, idOrPrefix: ref.sessionId,
            signal: context.signal, resolveAuthorizationHeaders: request => resolveServerRequestHeaders(context, 'memory.remember', request) });
          if (!target.ok || target.sessionId !== ref.sessionId) throw Object.assign(new Error('session_target_unavailable'), { code: 'session_target_unavailable' });
          // Legacy metadata is readable by recipients too. Only an explicit
          // canonical owner role can authorize this captured Account's private context.
          const raw = target.rawSession;
          if (raw.effectiveAccess === undefined && raw.share === undefined
            || readSessionAccessProjectionRoleV1(raw) !== 'owner'
            || raw.ownerAccountId !== undefined && raw.ownerAccountId !== requesterAccountId) {
            throw Object.assign(new Error('session_target_unavailable'), { code: 'session_target_unavailable' });
          }
          const metadata = readTransportSessionOwnerMetadata(target);
          if (!metadata) throw Object.assign(new Error('session_target_unavailable'), { code: 'session_target_unavailable' });
          const machineId = readSessionOwnerLocality({ metadata, rawSession: target.rawSession })?.machineId;
          return { metadata, revision: target.rawSession.metadataVersion, ...(machineId ? { machineId } : {}) };
        };
        return params.serverHttpBaseUrl ? runWithServerHttpBaseUrl(params.serverHttpBaseUrl, read) : read();
      },
      readInheritedContext: async (snapshot, context) => {
        if (!params.credentials) throw Object.assign(new Error('not_authenticated'), { code: 'not_authenticated' });
        const { readCliMemoryInheritedContext } = await import("./readCliMemoryInheritedContext");
        const read = () => readCliMemoryInheritedContext({ credentials: params.credentials!,
          serverId: actionHomeId, snapshot, context });
        return params.serverHttpBaseUrl ? runWithServerHttpBaseUrl(params.serverHttpBaseUrl, read) : read();
      },
      readScopeContext: async (target, context) => {
        if (!params.credentials) throw Object.assign(new Error('not_authenticated'), { code: 'not_authenticated' });
        if (target.scope === 'project' && await projectAccountAdmission(target.projectRef.serverId, context)) {
          throw Object.assign(new Error('project_context_access_denied'), { code: 'project_context_access_denied' });
        }
        if (!actionDeps.projectsContextUpdate || !actionDeps.projectSourcesRead || !actionDeps.projectSourcesUpdate) {
          throw Object.assign(new Error('project_context_unavailable'), { code: 'project_context_unavailable' });
        }
        const { readCliMemoryScopeContext } = await import("./readCliMemoryInheritedContext");
        const projectRef = target.scope === 'project'
          ? { ...target.projectRef, serverId: await resolveProjectHomeIdentity() } : null;
        const read = () => readCliMemoryScopeContext({ credentials: params.credentials!,
          serverId: projectRef?.serverId ?? todoHomeServerId, target: projectRef ? { scope: 'project', projectRef } : target, context,
          // The Account branch never invokes the Project-row port.
          readProjectRows: async () => {
            const refs = await readProjectRows({ kinds: ['workspace-ref'], serverId: projectRef!.serverId }, context.signal, context, 'memory.remember');
            const association = resolveProjectContextSourceV1({ projectRef: projectRef!, workspaceRefs: refs.workspaceRefs, organizationPresent: false });
            if (association.kind === 'source') return refs;
            const organization = await readProjectRows({ key: { kind: 'project-organization', ...projectRef! } }, context.signal, context, 'memory.remember');
            return { ...refs, organizations: organization.organizations, rows: [...refs.rows, ...organization.rows] };
          },
          projectsContextUpdate: actionDeps.projectsContextUpdate!, projectSourcesRead: actionDeps.projectSourcesRead!,
          projectSourcesUpdate: actionDeps.projectSourcesUpdate!,
        });
        return runWithServerHttpBaseUrl(todoHomeBaseUrl, read);
      },
      readArtifactHeaders: async (refs, context) => {
        const serverId = params.credentials?.requesterSessionCredentialScope?.serverId
          ?? params.serverId ?? configuration.activeServerId;
        if ((params.credentials?.requesterSessionCredentialScope || context.externalActionCredential
          || context.externalActionExecutionAuthorization)
          && (!isSameActionHomeId(serverId) || refs.some(ref => ref.serverId?.trim() && !isSameActionHomeId(ref.serverId)))) {
          throw Object.assign(new Error('server_target_mismatch'), { code: 'server_target_mismatch' });
        }
        const { withCliPromptLibraryArtifactReader } = await import("@/agent/prompts/library/resolveCliPromptStackSystemAppendBlocks");
        return withCliPromptLibraryArtifactReader(reader => Promise.all(refs.map(async ref =>
          (await reader.readArtifactHeader(ref.serverId && isSameActionHomeId(ref.serverId)
            ? { ...ref, serverId } : ref))?.header ?? null)), {
          credentials: params.credentials, serverId, signal: context.signal,
        });
      },
    } } : {}),
    projectsWorkspaceUpdate: projectDeps.projectsWorkspaceUpdate,
    projectsWorkspaceForget: projectDeps.projectsWorkspaceForget,
    projectsServicesPin: projectDeps.projectsServicesPin,
    ...createCliProjectSourceActionDeps({
      serverHttpBaseUrl: todoHomeBaseUrl,
      admitAccount: admitAccountStorage,
      resolveRequestHeaders: resolveAccountStorageHeaders,
      readArtifact: async (ref, options, context) => {
        if (context.externalActionExecutionAuthorization) return readProjectRequesterArtifact(ref, options, context);
        if (await projectAccountAdmission(projectHomeId, context) || !roleArtifactStore) return null;
        const [{ isServerProfileHomeIdentity }, { withCliPromptLibraryArtifactReader }] = await Promise.all([import("@/server/serverProfiles"), import("@/agent/prompts/library/resolveCliPromptStackSystemAppendBlocks")]);
        if (await isServerProfileHomeIdentity(projectHomeId, ref.serverId)) {
          return runWithServerHttpBaseUrl(todoHomeBaseUrl, () => roleArtifactStore.read(ref.artifactId, options));
        }
        // Signed Source HTTP authority carries no foreign Home Artifact reader;
        // it cannot borrow the custodian's saved-profile credentials.
        if (context.externalActionCredential || context.externalActionExecutionAuthorization) return null;
        return withCliPromptLibraryArtifactReader(async reader => {
          const artifact = await reader.readArtifact(ref);
          return artifact ? { artifactId: artifact.id, header: artifact.header } : null;
        }, { serverId: projectHomeId, signal: options?.signal });
      },
    }),
    ...widgetDeps.area,
    ...widgetDeps.definition,
    ...widgetDeps.input,
    widgetAccountScope: widgetDeps.widgetAccountScope,
    widgetCatalog: widgetDeps.widgetCatalog,
    ...(roleArtifactStore && homeAccountId ? { appShellAction: createCliInboxReadAction({
      store: { list: options => withProjectHome(() => roleArtifactStore.list(options)),
        readBodies: (items, signal) => withProjectHome(() => roleArtifactStore.readBodies(items, signal)),
        read: (artifactId, options) => withProjectHome(() => roleArtifactStore.read(artifactId, options)),
        update: request => withProjectHome(() => roleArtifactStore.update(request)) },
      accountId: homeAccountId, serverId: todoHomeServerId,
      isCurrent: async () => !await projectHomeAdmission() && (!params.isCredentialCurrent || await params.isCredentialCurrent()),
    }) } : {}),
    artifactAction: artifactsDeps.artifactAction,
    artifactAccessAction: artifactsDeps.artifactAccessAction,
    ...createCliBotTemplateActionDeps(params, { artifactCallerContext, homeAccountId, isSameActionHomeId,
      content: promptsDeps,
      registryPort: approvalsStore?.promptLibraryStore.organization,
      roleArtifactStore, resolveServerRequestHeaders, resolveTransportForSession, readTransportSessionOwnerMetadata }),
    connectedServiceAction,
    profileActionExecute: connectionsDeps.profileActionExecute,
    mcpServerAction: connectionsDeps.mcpServerAction,
    providerActionExecute: connectionsDeps.providerActionExecute,
    remoteHostActionExecute: connectionsDeps.remoteHostActionExecute,
    launchProfilePublish: launchProfilesDeps.launchProfilePublish,
    resolveSessionSpawnAgentInventorySelection,

    ...createCliNotificationActionDeps(params, workflowAction),
    machineCommandRun: machineDeps.machineCommandRun,
    getCurrentWorkspaceWrites: rolesDeps.getCurrentWorkspaceWrites,
    roleActionExecute: rolesDeps.roleActionExecute,
    scmActionExecute: executeSessionBoundScmAction,
    ...executionRunActionDeps,
    ...(reviewCommentAction
      ? {
        reviewCommentAction: async ({ actionId, input, reviewCommentPrincipal, signal }) =>
          await reviewCommentAction(actionId, input, {
            ...(reviewCommentPrincipal ? { principal: reviewCommentPrincipal } : {}),
            ...(signal ? { signal } : {}),
          }),
      }
      : {}),

    ...createCliMemoryActionDeps(params, { callMachineAction, isMachineActionServerScopeCurrent, notSupported }),
    ...(homeHubArtifactPort ? { homeHubArtifacts: {
      read: signal => params.serverHttpBaseUrl
        ? runWithServerHttpBaseUrl(params.serverHttpBaseUrl, () => homeHubArtifactPort.read(signal)) : homeHubArtifactPort.read(signal),
      apply: (intent, signal) => params.serverHttpBaseUrl
        ? runWithServerHttpBaseUrl(params.serverHttpBaseUrl, () => homeHubArtifactPort.apply(intent, signal)) : homeHubArtifactPort.apply(intent, signal),
      describe: (layout, signal) => params.serverHttpBaseUrl
        ? runWithServerHttpBaseUrl(params.serverHttpBaseUrl, () => homeHubArtifactPort.describe(layout, signal)) : homeHubArtifactPort.describe(layout, signal),
      captureWidgetPresentation: (layout, instanceId, signal) => params.serverHttpBaseUrl
        ? runWithServerHttpBaseUrl(params.serverHttpBaseUrl, () => homeHubArtifactPort.captureWidgetPresentation(layout, instanceId, signal))
        : homeHubArtifactPort.captureWidgetPresentation(layout, instanceId, signal),
    } } : {}),
    ...(roleArtifactStore ? { workBoardArtifacts: {
      readBoardAccess: (boardId, signal) => params.serverHttpBaseUrl
        ? runWithServerHttpBaseUrl(params.serverHttpBaseUrl, () => createWorkBoardArtifactPortV1(roleArtifactStore).readBoardAccess(boardId, signal))
        : createWorkBoardArtifactPortV1(roleArtifactStore).readBoardAccess(boardId, signal),
      readBoard: (boardId, signal) => params.serverHttpBaseUrl
        ? runWithServerHttpBaseUrl(params.serverHttpBaseUrl, () => createWorkBoardArtifactPortV1(roleArtifactStore).readBoard(boardId, signal))
        : createWorkBoardArtifactPortV1(roleArtifactStore).readBoard(boardId, signal),
      read: (signal) => params.serverHttpBaseUrl
        ? runWithServerHttpBaseUrl(params.serverHttpBaseUrl, () => createWorkBoardArtifactPortV1(roleArtifactStore).read(signal))
        : createWorkBoardArtifactPortV1(roleArtifactStore).read(signal),
      apply: (intent, signal, context) => params.serverHttpBaseUrl
        ? runWithServerHttpBaseUrl(params.serverHttpBaseUrl, () => createWorkBoardArtifactPortV1(roleArtifactStore).apply(intent, signal, context ? artifactCallerContext(context) : undefined))
        : createWorkBoardArtifactPortV1(roleArtifactStore).apply(intent, signal, context ? artifactCallerContext(context) : undefined),
    } } : {}),
    internalTaskAction: tasksDeps.internalTaskAction,
    listReorder: tasksDeps.listReorder,
    todoSessionLink: tasksDeps.todoSessionLink,
    updateAccountAcpCatalogSettings: agentCatalogDeps.updateAccountAcpCatalogSettings,
    projectsContextUpdate: projectDeps.projectsContextUpdate,
    projectAction: projectDeps.projectAction,
    promptDocGet: promptsDeps.promptDocGet,
    promptDocCreate: promptsDeps.promptDocCreate,
    promptDocFavoriteSet: promptsDeps.promptDocFavoriteSet,
    promptsLibraryList: promptsDeps.promptsLibraryList,
    promptInvocationsList: promptsDeps.promptInvocationsList,
    promptInvocationResolve: promptsDeps.promptInvocationResolve,
    promptDocUpdate: promptsDeps.promptDocUpdate,
    skillsRead: promptsDeps.skillsRead,
    skillActionExecute: promptsDeps.skillActionExecute,
    skillMachineActionExecute: promptsDeps.skillMachineActionExecute,
    promptBundleUpdate: promptsDeps.promptBundleUpdate,
    promptRegistryInstall: promptsDeps.promptRegistryInstall,
    sessionOpen,
    sessionFork,
    sessionContinueWithReplay,
    sessionRollback,
    checkpointCodeRollback,
    sessionCheckpoint,
    sessionRestore,
    sessionHandoffTargetReplacementApprovalPreflight,
    workspaceSyncRelationshipCreate: workspaceSyncDeps.workspaceSyncRelationshipCreate,
    workspaceSyncRelationshipObserveCreation: workspaceSyncDeps.workspaceSyncRelationshipObserveCreation,
    workspaceSyncRelationshipTerminate: workspaceSyncDeps.workspaceSyncRelationshipTerminate,
    workspaceSyncRelationshipDisable: workspaceSyncDeps.workspaceSyncRelationshipDisable,
    workspaceSyncRelationshipEnable: workspaceSyncDeps.workspaceSyncRelationshipEnable,
    workspaceSyncRelationshipFlush: workspaceSyncDeps.workspaceSyncRelationshipFlush,
    workspaceSyncConflictResolve: workspaceSyncDeps.workspaceSyncConflictResolve,
    workspaceSyncRelationshipsList: workspaceSyncDeps.workspaceSyncRelationshipsList,
    workspaceSyncConflictsList: workspaceSyncDeps.workspaceSyncConflictsList,
    workspaceSyncConflictInspect: workspaceSyncDeps.workspaceSyncConflictInspect,
    sessionHandoffStart,
    sessionHandoffStatusGet,
    sessionHandoffPrepareTargetResume,
    resolveAgentStartContext,
    ...spawnActionDeps,
    ...(artifactApprovalStore ?? {}),
    ...(approvalActionDeps.executionRunHostActionApprovalReplay ? { executionRunHostActionApprovalReplay: approvalActionDeps.executionRunHostActionApprovalReplay } : {}),
    ...(approvalActionDeps.recordApprovalRetirementWarning ? { recordApprovalRetirementWarning: approvalActionDeps.recordApprovalRetirementWarning } : {}),
    ...inventoryDeps,
    ...(params.credentials && approvalsStore ? createCliSessionCapabilitiesActionDeps({ credentials: params.credentials,
      serverId: params.serverId ?? configuration.activeServerId, serverHttpBaseUrl: params.serverHttpBaseUrl ?? resolveServerHttpBaseUrl(),
      operationContext: params.savedSecretOperationContext,
      skillRulesForContext: context => skillRulesForContext(context, 'session.capabilities.set') ?? approvalsStore.skillRules,
      callMachineAction,
      resolveAuthorizationHeaders: (actionId, context, request) => resolveServerRequestHeaders(context, actionId, request),
    }) : {}),
    projectsSetupSet: projectDeps.projectsSetupSet,
    ...createCliProjectSessionDefaultsActionDeps({ projectAccountAdmission, projectHomeAdmission, projectRowsAuthority, withProjectHome, resolveProjectHomeIdentity },
      () => readEffectiveDeps?.() ?? actionDeps),
    projectsOrganizationUpdate: projectDeps.projectsOrganizationUpdate,
    projectsVisibilitySet: projectDeps.projectsVisibilitySet,
    projectsList: projectDeps.projectsList,
    projectWorkspaceRefs: projectDeps.projectWorkspaceRefs,
    projectWorkerAction: projectDeps.projectWorkerAction,
    projectDefinitionAction: projectDeps.projectDefinitionAction,
    machineWorkSummaryGet: machineDeps.machineWorkSummaryGet,
    machineStorageAction: machineResourceDeps.machineStorageAction,
    machineScheduledAction: machineResourceDeps.machineScheduledAction,
    machineProcessesAction: machineResourceDeps.machineProcessesAction,
    machineVitalsAction: machineResourceDeps.machineVitalsAction,
    machineAgentIsolationAction: machineResourceDeps.machineAgentIsolationAction,
    machineServiceAction: machineResourceDeps.machineServiceAction,
    machineServiceScope: machineResourceDeps.machineServiceScope,
    machineServiceControl: machineResourceDeps.machineServiceControl,
    machineServiceExec: machineResourceDeps.machineServiceExec,
    machineServiceLogsRead: machineResourceDeps.machineServiceLogsRead,
    machineAdminAccessAction: machineResourceDeps.machineAdminAccessAction,
    machineReachabilityAction: machineResourceDeps.machineReachabilityAction,
    machineReboot: machineResourceDeps.machineReboot,
    machineRebootReferences,
    machineResourcesPolicyAction: machineResourceDeps.machineResourcesPolicyAction,
    machineRolesAction: machineResourceDeps.machineRolesAction,
    machineIsolationAction: machineResourceDeps.machineIsolationAction,
    machineGuardAction: machineResourceDeps.machineGuardAction,
    usageSourceAction: machineResourceDeps.usageSourceAction,
    projectsOpen: projectDeps.projectsOpen,
    filesystemActionExecute: filesystemDeps.filesystemActionExecute,
    workspaceFilesReplacePreview: filesystemDeps.workspaceFilesReplacePreview,
    workspaceFilesReplace: filesystemDeps.workspaceFilesReplace,
    languageIntelligenceQuery: filesystemDeps.languageIntelligenceQuery,
    languageIntelligenceApply: filesystemDeps.languageIntelligenceApply,
    languageIntelligenceRestart: filesystemDeps.languageIntelligenceRestart,
    workspaceFilesSearch: filesystemDeps.workspaceFilesSearch,
    workflowEventsList: machineInventoryDeps.workflowEventsList,
    machinesAgentsList: machineInventoryDeps.machinesAgentsList,
    machinePluginProjectionRead: machineInventoryDeps.machinePluginProjectionRead,
    machineAgentSignInStart: machineInventoryDeps.machineAgentSignInStart,
    machineAgentSignInStatus: machineInventoryDeps.machineAgentSignInStatus,
    machineAgentSignInCancel: machineInventoryDeps.machineAgentSignInCancel,
    machineAgentSignInRestart: machineInventoryDeps.machineAgentSignInRestart,
    actionOperationAction: machineDeps.actionOperationAction,
    machinePageAction: machineDeps.machinePageAction,
    machineTerminalAction: machineDeps.machineTerminalAction,
    machineAgentInstallStart: machineDeps.machineAgentInstallStart,
    machineAgentInstallRead: machineDeps.machineAgentInstallRead,
    machineAgentInstallCancel: machineDeps.machineAgentInstallCancel,
    sessionContinuationInspect,
    sessionAgentTransition,
    ...messageActionDeps,
    sessionExchangePrepare,
    sessionExchangeControl,
    sessionTurnCancel,
    sessionCompact,
    sessionRuntimeRefresh,
    sessionStop,
    sessionUpdatePost,
    sessionManagerSet,
    sessionOrganizationPinSet,
    sessionAttentionSet,
    sessionApprovalReviewerSet,
    sessionStateFieldSet,
    sessionPermissionModeSet,

    modelFavoriteSet: async (input, context) => {
      const credentials = params.credentials;
      if (!credentials) throw Object.assign(new Error('not_authenticated'), { code: 'not_authenticated' });
      const { updateAccountSettingsV2OnceAgainstLatest } = await import("@/settings/accountSettings/updateAccountSettingsV2WithRetry");
      const mutate = () => updateAccountSettingsV2OnceAgainstLatest({ credentials,
        signal: context.signal, mutate: raw => setModelFavoriteV1(raw, input) });
      return params.serverHttpBaseUrl ? runWithServerHttpBaseUrl(params.serverHttpBaseUrl, mutate) : mutate();
    },
    sessionModelUnarm,
    sessionModelSet,
    sessionArchiveSet,
    sessionStatusGet,
    sessionWorkStateGet,
    sessionTerminalComposerClear,
    sessionPendingInputInterruptAndRun,
    sessionPendingRequeue,
    sessionPendingActionSet,
    sessionPendingWithdraw,
    sessionPendingMarkHandled,
    sessionPendingDismiss,
    sessionPendingSendAsNew,
    sessionPendingResetStartSet,
    sessionPendingResetStartCancel,
    ...goalActionDeps,
    sessionUsageLimitWaitResumeEnable,
    sessionUsageLimitWaitResumeCancel,
    sessionUsageLimitCheckNow,
    sessionUsageLimitSwitchAccountNow,
    sessionUsageLimitConsumeResetCredit,
    sessionVendorPluginCatalogList,
    sessionSkillCatalogList,
    sessionHistoryGet: transcriptDeps.sessionHistoryGet,
    sessionInputResultGet: transcriptDeps.sessionInputResultGet,
    sessionTranscriptGet: transcriptDeps.sessionTranscriptGet,
    sessionEventsGet: transcriptDeps.sessionEventsGet,
    sessionWaitIdle,
    ...permissionActionDeps,
    sessionControlSwitch,
    sessionModeSet,
    sessionConnectedServicesAuthSet,
    sessionBoardAction: widgetDeps.sessionBoardAction,
    ...(widgetDeps.sessionBoardPrepareItem ? { sessionBoardPrepareItem: widgetDeps.sessionBoardPrepareItem } : {}),
    readAgentHtmlNetworkPolicy: async () => params.actionsSettingsProvider?.getAccountSettings?.()?.agentHtmlNetworkPolicy ?? 'ask',
    currentSessionPresentationApply,

    discussionAction: params.credentials
      ? createDiscussionActionDeps({
          credentials: params.credentials,
          ...(params.postAgentDiscussionMessage ? { postAgentMessage: params.postAgentDiscussionMessage } : {}),
          ...(params.postWorkflowDiscussionMessage ? { postWorkflowMessage: params.postWorkflowDiscussionMessage } : {}),
          ...(params.resolveServerFeaturesSnapshot
            ? { resolveServerFeaturesSnapshot: params.resolveServerFeaturesSnapshot }
            : {}),
          ...exactHome,
          ...(params.serverIdentityId ? { serverIdentityId: params.serverIdentityId } : {}),
          ...(params.externalActionMachineRequestPrivateKey
            ? { externalActionMachineRequestPrivateKey: params.externalActionMachineRequestPrivateKey }
            : {}),
          ...(params.externalActionMachineInstallationId
            ? { externalActionMachineInstallationId: params.externalActionMachineInstallationId }
            : {}),
        }).discussionAction
      : async () => ({ ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' }),

    sessionList,
    sessionRead,
    sessionFollowPreview,

    resolveSessionReference: async ({ sessionId, context, actionId, signal }) => {
      const operationSignal = signal ?? context.signal;
      operationSignal?.throwIfAborted();
      if (!sessionId || !actionId || await projectHomeAdmission(undefined, context)) return { kind: 'incomplete' };
      // The host binding proves this exact Session, without Account credentials.
      // Restricted descendant references use the shared server-proved subtree reader.
      if (!params.credentials && sessionId === params.sessionId && context.defaultSessionId === params.sessionId
        && context.sessionListAccess === 'current_session') {
        return { kind: 'unique', address: { serverId: actionHomeId, sessionId } };
      }
      try {
        const target = await resolveTransportForSession(sessionId, operationSignal, { context, actionId });
        operationSignal?.throwIfAborted();
        if (target.ok) return { kind: 'unique', address: { serverId: actionHomeId, sessionId: target.sessionId } };
        if (target.code === 'session_not_found') return { kind: 'none' };
        if (target.code === 'session_id_ambiguous') return { kind: 'ambiguous',
          candidates: (target.candidates ?? []).map(sessionId => ({ serverId: actionHomeId, sessionId })) };
        return { kind: 'incomplete' };
      } catch {
        operationSignal?.throwIfAborted();
        return { kind: 'incomplete' };
      }
    },

    readSessionManager: async ({ address, context, actionId, signal }) => {
      const operationSignal = signal ?? context.signal;
      operationSignal?.throwIfAborted();
      if (await projectHomeAdmission(address.serverId, context)) return { kind: 'unavailable' };
      try {
        const target = await resolveTransportForSession(address.sessionId, operationSignal, { context, actionId });
        operationSignal?.throwIfAborted();
        if (!target.ok || target.sessionId !== address.sessionId) return { kind: 'unavailable' };
        const managerSessionId = readSessionManagerSessionIdV1(target.rawSession);
        return { kind: 'manager', address: managerSessionId ? { serverId: address.serverId, sessionId: managerSessionId } : null };
      } catch {
        operationSignal?.throwIfAborted();
        return { kind: 'unavailable' };
      }
    },
    sessionAwarenessWait: awarenessDeps.sessionAwarenessWait,
    sessionActivityGet: awarenessDeps.sessionActivityGet,
    sessionRecentMessagesGet: transcriptDeps.sessionRecentMessagesGet,

    ...createCliSubagentActionDeps(),
    pluginsDevLoopAction: pluginAdministrationDeps.pluginsDevLoopAction,
    pluginSettingsAdministrationAction: pluginAdministrationDeps.pluginSettingsAdministrationAction,
    pluginPermissionGrantAction: pluginAdministrationDeps.pluginPermissionGrantAction,
    pluginWebhookAction: pluginAdministrationDeps.pluginWebhookAction,
    ...createCliPluginCollectionSharingActionDeps(params, { serverId: projectHomeId, serverHttpBaseUrl: todoHomeBaseUrl,
      admitAccount: admitAccountStorage, resolveHeaders: resolveAccountStorageHeaders }),

    ...(automationEventAction ? {
      automationEventAction: async (args) => await automationEventAction(args),
    } : {}),

    ...(readWorkflowApprovedOperation || params.readApprovedOperation ? { readApprovedOperation: async request => {
      if (request.runId && readWorkflowApprovedOperation) return readWorkflowApprovedOperation({ ...request, runId: request.runId });
      return await params.readApprovedOperation?.(request) ?? null;
    } } : {}),
    workflowAction: workflowActionPort,
    automationOccurrenceAction: createCliOccurrenceAction(params, {
      serverId: projectHomeId, serverHttpBaseUrl: todoHomeBaseUrl, accountId: homeAccountId,
    }),

    automationConversationAction: async (args) => automationConversationAction
      ? await automationConversationAction(args)
      : { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' },
    pluginSessionHookManagementAction: pluginAdministrationDeps.pluginSessionHookManagementAction,

    resolveApiTokenGrantSessionMachineId: async ({ actionId, sessionId, context }) => {
      if (!params.credentials || !context.externalActionCredential) return null;
      const { resolveSessionTransportContext } = await import("@/session/services/resolveSessionTransportContext");
      const transport = await resolveSessionTransportContext({
        reason: 'session-action',
        credentials: params.credentials,
        idOrPrefix: sessionId,
        resolveAuthorizationHeaders: request => resolveServerRequestHeaders(context, actionId, request),
        ...(context.signal ? { signal: context.signal } : {}),
      });
      if (!transport.ok || transport.sessionId !== sessionId || transport.rawSession.id !== sessionId) return null;
      return readSessionOwnerLocality({ metadata: readTransportSessionOwnerMetadata(transport),
        rawSession: transport.rawSession })?.machineId ?? null;
    },

    hostExternalSessionAction: params.credentials ? createHostExternalSessionActionTransport({
      credentials: params.credentials,
      serverId: params.serverId ?? configuration.activeServerId,
      serverHttpBaseUrl: params.serverHttpBaseUrl ?? resolveServerHttpBaseUrl(),
      resolveSessionMachineId: async (sessionId, signal) => {
        const transport = await resolveTransportForSession(sessionId, signal);
        return transport.ok ? normalizeStringValue(readTransportSessionOwnerMetadata(transport)?.machineId) : null;
      },
    }) : undefined,
    externalSessionAction: pluginAdministrationDeps.externalSessionAction,

    managedMachineReferences,
    machineSetupPlan: setupDeps.machineSetupPlan,
    machineSetupRemove: machineDeps.machineSetupRemove,
    machineSetupUpdatesApply: machineDeps.machineSetupUpdatesApply,
    machineSetupUpdatesRollout: updatesRolloutDeps.machineSetupUpdatesRollout,
    prepareMachineSetupApply: setupDeps.prepareMachineSetupApply,
    machineSetupApply: createMachineSetupApplyDispatcher({ readDeps: () => readEffectiveDeps?.() ?? actionDeps,
      native: machineDeps.machineSetupApply!, compose: setupDeps.machineSetupApply! }),
    buildApprovalPreview: approvalActionDeps.buildApprovalPreview,
    settingsDeclarationAction: settingsDeps.settingsDeclarationAction,
    resetGlobalVoiceAgent: () => {},
  };
  return actionDeps;
}
