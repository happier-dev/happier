import type { ExternalActionIssuerRefusal } from './externalActionIssuerRefusal';
import { deriveEd25519KeyPair, ED25519_PUBLIC_KEY_BYTES } from '@happier-dev/protocol/crypto/ed25519';
import { getActionSpec, projectExternalActionMachineRuntimeDemandV1 } from '@happier-dev/protocol/actions/actionSpecs';
import { computeActionInputApprovalDigestV1 } from '@happier-dev/protocol/actions/decisionAuthority';
import { isMachineTerminalOpenOrRestartActionIdV1 } from '@happier-dev/protocol/actions/specs/machineTerminalActionIdsV1';
import { isMachineSetupPlanOrApplyActionIdV1, isManagedEnrollmentRecoveryChildV1, SESSION_AGENT_READINESS_CHILDREN_V1 } from '@happier-dev/protocol/machines/managed/actionIdsV1';
import { readSessionAgentReadinessChildActionV1, resolveMachineRpcExternalActionEffectV1 } from '@happier-dev/protocol/machines/peer/mediation/rpc/routePolicyV1';
import { DaemonAgentInstallStartRequestSchema, DaemonAgentInstallReadRequestSchema } from '@happier-dev/protocol/daemon/agentInstallJobs';
import { buildMachineAgentsDetectRequest, MachineAcpInventoryRequestSchema } from '@happier-dev/protocol/capabilities/machineAgentInventory';
import { resolveSessionCreationAgentTarget } from '@/session/creation/resolveSessionCreationAgentTarget';
import { mintExternalActionExecutionAuthorization } from './externalActionAuthorizationHttp';
import { readActionCredentialScopeDeniedHttpFailureV1 } from '@happier-dev/protocol/actions/externalActionHttpError';
import { ExternalActionMachineNpmProfileAdmissionResponseV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import type { MachineNpmProfileAdmissionResponseV1 } from '@happier-dev/protocol/machines/machineAccessV1';
import { observeManagedChildApprovalExecution } from './managedChildApproval';
import { readDeploymentTargetRetentionMachineIds } from '@/deployments/targetEnablementRetention';
import { isDeploymentBackupActionIdV1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import { isProjectReadinessActionIdV1 } from '@happier-dev/protocol/actions/projectReadinessActionIdsV1';
import type { RecordedApprovalExecutionObservationArgs } from '@/session/actions/createCliActionExecutorHarness';
export { mintExternalActionExecutionAuthorization, type ExternalActionAuthorizationHttpResult } from './externalActionAuthorizationHttp';
import axios from '@/api/client/credentialAxios';
import { MachineAdminAccessSetInputV1Schema, MachineAgentIsolationPreviewInputV1Schema, MachineAgentIsolationSetInputV1Schema,
  type MachineAdminAccessActionInput, type MachineAgentIsolationPreviewInputV1, type MachineAgentIsolationSetInputV1 } from '@happier-dev/protocol';
import { ManagedMachineV1Schema, matchesManagedMachineEnrollmentAdminAccessV1, matchesManagedMachineEnrollmentAgentIsolationV1,
  type ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { MachineSetupApplyInputV1Schema, managedMachineActionEndpointPathV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { readManagedMachine } from '@/machines/managed/readManagedMachine';
import { ManagedMachinePresetGetResultV1Schema } from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';
import { machinePresetActionEndpointPathV1 } from '@happier-dev/protocol/machines/managed/machinePresetActionsV1';
import { projectExternalActionManagedAdmissionV1, projectDeploymentPreparationAdmissionV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { isManagedControllerCodecActionV1, isReviewedMachineSetupCodecV1, sealManagedControllerActionCodecV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { randomBytes } from 'node:crypto';

import { EXTERNAL_ACTION_EFFECT_ACTION_HEADER, EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER, EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER, EXTERNAL_ACTION_RESOLVED_TARGET_HEADER, ExternalActionActionIdV1Schema, ExternalActionExecutionAuthorizationV1Schema, ExternalActionExecutionAuthorizationVerifyResponseV1Schema, ExternalActionRequestEnvelopeSchema, externalActionTargetsEqualV1, bindExternalActionExecutionAuthorizationHttpPathV1, bindExternalActionExecutionAuthorizationVerifyHttpPathV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1, encodeExternalActionResolvedTargetV1, signExternalActionMachineRequestV1, signExternalActionMachineRpcRequestV1,
  encodeDeploymentChildExecutionV1, createDeploymentChildExecutionProofV1,
  readSessionSpawnNativeCredentialChildV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { EXTERNAL_ACTION_DEPLOYMENT_CHILD_EXECUTION_HEADER, EXTERNAL_ACTION_REVIEWED_CHILD_HEADER, isDeploymentReadActionIdV1,
  type ReviewedActionChildHttpProofV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { encodeReviewedActionChildHttpProofV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import type { ActionExecutorContext, ExternalActionExecutionAuthorizationV1, ExternalActionMachineRpcExecutionV1, ExternalActionRequestEnvelope, ExternalActionTargetV1 } from '@happier-dev/protocol';
import { readHostReviewedParentV1, readHostAdmittedReviewedChildV1,
  readHostReviewedChildOperationV1, isHostAdmittedReviewedChildPolicyV1 } from '@happier-dev/protocol/actions/actionExecutor';
import { readHostAdmittedReviewedRootV1 } from '@happier-dev/protocol/actions/executor/deploymentRoleChild';

import { buildDeploymentPreparationBriefV1, DeploymentPrepareInputV1Schema } from '@happier-dev/protocol/deployments/deploymentPreparationV1';
import { buildSessionActionChildCreationProofPayloadV1, deriveDeploymentPrepareSessionCreationIdentityV1 } from '@happier-dev/protocol/sessions/creation/sessionCreationAuthorizationV1';
import type { ActionRequiredAuthority } from '@happier-dev/protocol/actions/metadata';
import type { SessionInputSourceSessionV1 } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { SOCKET_RPC_EVENTS, SessionActionRpcOriginV1Schema, type WorkspaceSyncSourceWriterTargetRoutingV1,
  type WorkspaceSyncSourceExecutionV1 } from '@happier-dev/protocol/socketRpc';
import { signMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { projectNativeJsonValueForTransport, sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { EXTERNAL_ACTION_HTTP_PATH_PREFIX_V1, ExternalActionExecutionAuthorizationRequestV1Schema, ExternalActionHttpErrorSchema, ExternalActionResponseEnvelopeV1Schema, isExternalActionSubmittedUnknownHttpResponse, projectExternalActionPendingResetStartAdmissionV1, projectExternalActionApprovalDecisionAdmissionV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { openExternalActionRequestV2, openExternalActionResponseV2, sealExternalActionRequestV2, type ExternalActionEncryptionBindingV2 } from '@happier-dev/protocol/actions/externalActionEncryption';
import { isExternalActionAuthorizationBoundToEnvelope } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { ProjectServiceRelocateInputV1Schema, isProjectServiceMoveChildInputV1, readProjectServiceMoveChildEffectV1 } from '@happier-dev/protocol/workspaces/projectServiceRelocationV1';
import { TargetedActionRpcRequestV1Schema } from '@happier-dev/protocol/actions/actionRpcTransport';
import { DaemonLocalServiceLauncherStartRequestV1Schema, DaemonLocalServiceLauncherSnapshotRequestV1Schema } from '@happier-dev/protocol/local/services/launcher/v1';
import { projectApiTokenSessionSpawnAdmissionV1 } from '@happier-dev/protocol/auth/apiTokenGrant';
import type { AccountScopedCryptoMaterial } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { SessionSpawnNewInputV2Schema, SessionSpawnNewActionInputV2Schema, admitSessionSpawnNewActionInputV2,
  projectSessionSpawnNewActionInputV2, type SessionSpawnNewInputV2 } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import type { ActionExecuteResult } from '@happier-dev/protocol';
import { projectUnexpectedActionFailureV1, type ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ExternalActionExecutionAuthorizationRequestV1, ExternalActionRequesterHttpProjectionV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { assertResolvedHomeTargetIdentity, type ResolvedHomeTarget } from '@happier-dev/cli-common/homeTarget';
import { resolveCliHomeTarget } from '@/server/homeTarget';
import { normalizeServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { readAuthTokenProvenance } from '@happier-dev/protocol/auth/authToken';
import { deriveAccountMachineKeyFromRecoverySecret } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { decodeJwtPayload, readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { readAccountEncryptionModeOnce } from '@/api/client/accountEncryptionMode';
import { listCurrentAccountMachines, type CurrentAccountMachineInventoryItem } from '@/api/machine/resolveCurrentAccountMachineTarget';
import { resolveOriginalAccountMachineTarget } from '@/api/machine/originalAccountTarget';
import { requireAccountEncryptionCredentials } from '@/api/client/encryptionKey';
import { hasStoredSessionCredentialProvenance, type StoredCredentials } from '@/persistence';
import { ExternalActionSignedAuthenticationV1Schema, type ExternalActionSignedAuthenticationV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { AUTHORITY_CEILING_HEADER_V1, resolveInvocationAuthority } from '@happier-dev/protocol/actions/invocationAuthority';
import { isDeploymentObservationReadActionIdV1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import { z } from 'zod/mini';
import { ExternalActionMachineBootstrapV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { decodeBase64, encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { ExternalActionRequesterInvocationV1Schema, projectRequesterSessionCredentialDisclosure, sealExternalActionRequesterAccountContextV1, sealManagedCreationActionCodecV1, type ExternalActionRequesterInvocationV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { encodeStoredCredentials } from '@/persistence';
import { PROJECT_FINITE_ACTION_RPC_METHODS_V1 } from '@happier-dev/protocol/actions/projectActionFamily';
import { isProjectWorkspaceSyncPreparationActionV1 } from '@happier-dev/protocol/actions/projectActionIdsV1';
import { isMachineTerminalActionId } from '@happier-dev/protocol/actions/specs/machineTerminal';
import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import type { ManagedWakeTargetV1 } from '@happier-dev/protocol/machines/managed/managedIntentV1';
import { MachineSetupPlanInputV1Schema, ManagedEnrollmentInstallationV1Schema, readMachineSetupPlanChildInputV1, isMachineSetupPlanRpcChildV1, MANAGED_CONTROL_ACTION_IDS_V1,
  type MachineSetupApplyInputV1, type MachineSetupPlanInputV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { matchesMachineSetupCreationSourcesV1 } from '@happier-dev/protocol/machines/setup/machineSetupSourcesV1';
import { readRequesterAccountActionContext, rebindRequesterAccountActionContext, requesterAccountEncryptionMode, type RequesterAccountAuthorizationHeaders } from "@/daemon/sessionEncryption/requesterAccountActionContext";
import { refuseExternalActionPhase, traceExternalActionInnerStage, runTracedExternalActionInnerStage, readSessionInputAdmissionDiagnostic } from '@/daemon/externalActions/externalActionPhase';
import { projectExternalActionRunNowIdempotencyKeyV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { recordRequesterCurrentnessRefusal, rethrowRequesterHomeReadFailure,
  type RequesterCurrentnessRefusalBranch } from "@/daemon/sessionEncryption/requesterCurrentness";
import { createHttpStatusError } from '@/api/client/httpStatusError';
import { classifyServerEndpointError } from '@/api/client/classifyServerEndpointError';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { ACTION_ID_FAMILIES_V1, ActionIdSchema, SESSION_MESSAGE_SEND_ACTION_ID_V1, SESSION_SPAWN_NEW_ACTION_ID_V1, requiresOriginalAccountInvocationMachineProofV1, isWorkspaceSyncRelationshipWriteActionId, isWorkspaceSyncRelationshipControlActionId } from '@happier-dev/protocol/actions/actionIds';
import { isScmDiffSummaryRunAction } from '@happier-dev/protocol/actions/actionSpecs';
import { readDiscussionSecondOpinionModelChildV1, isDiscussionSecondOpinionModelRpcMethodV1 } from '@happier-dev/protocol/discussions/secondOpinionActions';
import { DiscussionDetailsResponseV1Schema, DiscussionListResponseV1Schema } from '@happier-dev/protocol/discussions/api';
import { DiscussionParticipantsListResponseV1Schema } from '@happier-dev/protocol/discussions/participants';
import { isServerProfileHomeIdentity } from '@/server/serverProfiles';
import type { RpcHandlerContext } from '@/api/rpc/types';
import type { RpcActionExecutorContext } from '@/rpc/handlers/_actionDispatchAdapter';
import { buildDiscussionModelSessionCreationProofPayloadV1, type SessionCreationAuthorizationV1 } from '@happier-dev/protocol/sessions/creation/sessionCreationAuthorizationV1';
import { deriveSessionCreationTagV1 } from '@happier-dev/protocol/sessions/creation/sessionCreationIdentityV1';
import { projectDiscussionModelParticipantLaunchV1 } from '@happier-dev/protocol/discussions/modelParticipantLaunch';
import { isSessionStopChildRootV1, isSessionStopChildV1 } from '@happier-dev/protocol/actions/sessionSections';
import { isDeploymentChildEffectActionIdV1, deploymentChildEffectActionIdForRootV1, readDeploymentChildRpcV1, type DeploymentChildRpcV1,
  type DeploymentChildRoutingV1, doesDeploymentChildInputMatchRootV1, DeploymentDeployActionInputV1Schema } from '@happier-dev/protocol';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import type { SessionTeamCredentialBindingIntentV1 } from '@happier-dev/protocol/teams/credentials/sessionBindingIntentV1';
import { ActionOperationAddressV1Schema } from '@happier-dev/protocol/actions/specs/actionOperations';
import { BOT_TEMPLATE_ACTION_IDS_V1 } from '@happier-dev/protocol/bots/templates/botTemplateActionIdsV1';

export type ExternalActionMachineRequestSigningKey = string | Uint8Array;
export type DeploymentArchiveOriginForHost = NonNullable<NonNullable<ExternalActionMachineRpcExecutionV1['deploymentChildExecution']>['archiveOrigin']>;

type RootOpenFailurePhase = Parameters<NonNullable<Parameters<typeof openExternalActionRequestV2>[0]['onFailure']>>[0]['phase'];
export type DeploymentChildDerivationRefusal = 'child_invalid' | 'child_input_mismatch'
  | 'root_envelope_invalid' | 'root_custody_unavailable' | 'root_cancelled'
  | 'root_binding_mismatch' | 'root_encryption_unavailable' | `root_open_${RootOpenFailurePhase}`;

/** A retained root is opened only with its admitted requester's material. */
export async function readReviewedExternalActionInput(input: Readonly<{
  authorization: ExternalActionExecutionAuthorizationV1; envelope: unknown; signal?: AbortSignal;
  onRefused?: (reason: DeploymentChildDerivationRefusal) => void;
}>): Promise<unknown> {
  const refuse = (reason: DeploymentChildDerivationRefusal) => { input.onRefused?.(reason); return null; };
  const binding = input.authorization.binding;
  const envelope = ExternalActionRequestEnvelopeSchema.safeParse(input.envelope);
  const requester = readRequesterAccountActionContext(input.authorization);
  if (!envelope.success) return refuse('root_envelope_invalid');
  if (!requester) return refuse('root_custody_unavailable');
  if (input.signal?.aborted) return refuse('root_cancelled');
  if (!isExternalActionAuthorizationBoundToEnvelope(binding,
    { actionId: binding.actionId, machineId: binding.machineId, envelope: envelope.data })) return refuse('root_binding_mismatch');
  let value: unknown = envelope.data.v === 1 ? envelope.data.input : undefined;
  if (envelope.data.v === 2) {
    const encryption = await requester.resolveEncryption(input.signal);
    if (!encryption || encryption.serverIdentityId !== binding.serverIdentityId) return refuse('root_encryption_unavailable');
    value = openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope: envelope.data, material: encryption.material, binding: {
      serverIdentityId: binding.serverIdentityId, accountId: binding.accountId, actionId: binding.actionId,
      requestId: binding.requestId, target: binding.target,
      ...('authentication' in binding ? { authentication: { kind: binding.authentication.kind,
        tokenEpoch: binding.authentication.tokenEpoch } } : { credentialId: binding.credentialId }),
    }, ...(input.onRefused ? { onFailure: failure => input.onRefused!(`root_open_${failure.phase}`) } : {}) })?.input;
  }
  return !input.signal?.aborted ? value : refuse('root_cancelled');
}

async function readReviewedSessionSpawnInput(
  input: Parameters<typeof readReviewedExternalActionInput>[0],
): Promise<SessionSpawnNewInputV2 | null> {
  const parsed = SessionSpawnNewActionInputV2Schema.safeParse(await readReviewedExternalActionInput(input));
  return parsed.success ? admitSessionSpawnNewActionInputV2(parsed.data) : null;
}

/** A finite target Plan retains the unchanged combined root and requester custody. */
export async function isReviewedMachineSetupPlanChild(input: Readonly<{
  authorization: ExternalActionExecutionAuthorizationV1; envelope: unknown; actionId: string;
  machineId: string; params: unknown; method?: string; signal?: AbortSignal;
}>): Promise<boolean> {
  if (input.actionId !== 'machines.setup.plan'
    || (input.method ?? RPC_METHODS.MACHINE_SETUP_PLAN) !== RPC_METHODS.MACHINE_SETUP_PLAN) return false;
  const rootInput = await readReviewedExternalActionInput(input);
  if (!rootInput || typeof rootInput !== 'object' || !('homeId' in rootInput)
    || rootInput.homeId !== input.authorization.binding.serverIdentityId) return false;
  return readMachineSetupPlanChildInputV1({ rootActionId: input.authorization.binding.actionId,
    rootInput, machineId: input.machineId, input: input.params }) !== null;
}

/** The effect owner opens the unchanged deploy root through existing requester custody. */
export async function readReviewedDeploymentDeployInput(input: Readonly<{
  authorization: ExternalActionExecutionAuthorizationV1; envelope: unknown; signal?: AbortSignal;
}>) {
  const actionId = input.authorization.binding.actionId;
  if (actionId !== 'deployments.deploy') return null;
  const root = await readReviewedExternalActionInput(input);
  const parsed = DeploymentDeployActionInputV1Schema.safeParse(root);
  return parsed.success ? parsed.data : null;
}

/** Cancellation spends only the operation Address opened from its fresh root. */
export async function readReviewedActionOperationCancelAddress(input: Readonly<{
  authorization: ExternalActionExecutionAuthorizationV1; envelope: unknown; signal?: AbortSignal;
}>): Promise<z.infer<typeof ActionOperationAddressV1Schema> | null> {
  const binding = input.authorization.binding;
  if (binding.actionId !== 'action.operations.cancel') return null;
  const parsed = ActionOperationAddressV1Schema.safeParse(await readReviewedExternalActionInput(input));
  if (!parsed.success || parsed.data.machineId !== binding.machineId
    || !await isServerProfileHomeIdentity(parsed.data.serverId, binding.serverIdentityId)) return null;
  return !input.signal?.aborted ? parsed.data : null;
}

/** Transport admission only; the receiver separately binds private candidate/receipt source before native work. */
export async function readReviewedDeploymentChildRoot(input: Readonly<{
  authorization: ExternalActionExecutionAuthorizationV1; envelope: unknown; actionId: string;
  machineId: string; params: unknown; method?: string; signal?: AbortSignal;
  reviewedChild?: ReviewedActionChildHttpProofV1;
  onRefused?: (reason: DeploymentChildDerivationRefusal) => void;
}>) {
  const child = readDeploymentChildRpcV1({ deploymentChildRoot: input.authorization.binding.deploymentChildRoot, rootActionId: input.authorization.binding.actionId,
    rootPreparationAdmission: input.authorization.binding.deploymentPreparationAdmission, reviewedChild: input.reviewedChild,
    effectActionId: input.actionId, method: input.method ?? RPC_METHODS.DAEMON_DEPLOYMENT_CHILD, params: input.params });
  if (!child || child.machineId !== input.machineId) { input.onRefused?.('child_invalid'); return null; }
  const rootInput = await readReviewedExternalActionInput(input);
  if (rootInput === null || rootInput === undefined) return null;
  const matches = doesDeploymentChildInputMatchRootV1({ rootActionId: input.authorization.binding.actionId, rootInput, child,
    rootBinding: input.authorization.binding,
    rootRequestId: input.authorization.binding.requestId,
    rootPreparationAdmission: input.authorization.binding.deploymentPreparationAdmission, reviewedChild: input.reviewedChild });
  if (!matches) { input.onRefused?.('child_input_mismatch'); return null; }
  const parentInput = projectNativeJsonValueForTransport(rootInput);
  const isParentInputRecord = (value: typeof parentInput): value is Readonly<Record<string, typeof parentInput>> =>
    Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  if (!isParentInputRecord(parentInput)) return null;
  return { actionId: input.authorization.binding.actionId, input: parentInput };
}

export async function isReviewedDeploymentChild(input: Parameters<typeof readReviewedDeploymentChildRoot>[0]): Promise<boolean> {
  return await readReviewedDeploymentChildRoot(input) !== null;
}

/** Bind the signed child digest to the Agent selected in the opened Session root. */
export async function isReviewedSessionAgentReadinessChild(input: Readonly<{
  authorization: ExternalActionExecutionAuthorizationV1; envelope: unknown; actionId: string;
  machineId: string; params: unknown; method?: string; signal?: AbortSignal;
  reviewedChild?: ReviewedActionChildHttpProofV1;
}>): Promise<boolean> {
  const binding = input.authorization.binding;
  const actionId = readSessionAgentReadinessChildActionV1(binding, input.reviewedChild);
  if (!actionId || actionId !== input.actionId || binding.machineId !== input.machineId
    || resolveMachineRpcExternalActionEffectV1(input.method ?? '', binding, undefined, input.reviewedChild) !== actionId) return false;
  const root = await readReviewedSessionSpawnInput(input);
  if (!root || root.executionTarget.machineId !== input.machineId) return false;
  const selected = resolveSessionCreationAgentTarget(root.agentTarget);
  if (!selected) return false;
  const agent = { agentId: selected.agentId,
    ...(root.agentTarget.definitionId === undefined ? {} : { definitionId: root.agentTarget.definitionId }) };
  let childInput: unknown;
  if (actionId === SESSION_AGENT_READINESS_CHILDREN_V1.inventory.action) {
    childInput = { machineId: input.machineId, serverId: root.executionTarget.serverId, ...agent, refresh: true };
    if (input.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) {
      if (!sameStrictJsonValue(input.params, { machineId: input.machineId, selection: 'agents' })) return false;
    } else {
      const requests: unknown = input.params && typeof input.params === 'object' ? Reflect.get(input.params, 'requests') : undefined;
      if (!Array.isArray(requests)) return false;
      const definitionRequest: unknown = requests.find(request => request && typeof request === 'object'
        && Reflect.get(request, 'id') === 'tool.acpAgentInventory');
      const definitions = definitionRequest && typeof definitionRequest === 'object'
        ? MachineAcpInventoryRequestSchema.safeParse(Reflect.get(definitionRequest, 'params')) : null;
      if (definitions && (!definitions.success || !agent.definitionId || definitions.data.definitions.length !== 1
        || definitions.data.definitions[0]?.definitionId !== agent.definitionId)) return false;
      const hasAgentProbe = requests.some(request => request && typeof request === 'object'
        && Reflect.get(request, 'id') === `cli.${agent.agentId}`);
      const expected = buildMachineAgentsDetectRequest({ agents: hasAgentProbe ? [{ agentId: agent.agentId, title: agent.agentId }] : [],
        ...(definitions?.success ? { definitions: definitions.data.definitions } : {}), refresh: true, readinessOnly: true });
      if (!expected.requests?.length || !sameStrictJsonValue(input.params, expected)) return false;
    }
  } else if (actionId === SESSION_AGENT_READINESS_CHILDREN_V1.acquire.action) {
    const request = DaemonAgentInstallStartRequestSchema.safeParse(input.params);
    if (!request.success || (request.data.intent !== 'install' && request.data.intent !== 'update')) return false;
    childInput = { machineId: input.machineId, ...agent, intent: request.data.intent,
      ...(root.agentInstallConsent === undefined ? {} : { consent: root.agentInstallConsent }) };
    if (!sameStrictJsonValue(input.params, { ...agent, intent: request.data.intent,
      consent: root.agentInstallConsent ?? { vendorRecipe: false } })) return false;
  } else {
    const request = DaemonAgentInstallReadRequestSchema.safeParse(input.params);
    if (!request.success || request.data.cursor !== 0) return false;
    childInput = { machineId: input.machineId, jobId: request.data.jobId, waitForTerminal: request.data.waitForTerminal };
  }
  const normalized = getActionSpec(actionId).inputSchema.safeParse(childInput);
  return normalized.success && computeActionInputApprovalDigestV1(actionId, normalized.data) === input.reviewedChild?.inputDigest;
}

/** Initial native delivery spends only the Team selection in the approved spawn. */
export async function isReviewedSessionSpawnNativeCredentialChild(input: Readonly<{
  authorization: ExternalActionExecutionAuthorizationV1; envelope: unknown; actionId: string;
  machineId: string; params: unknown;
  binding: Exclude<SessionTeamCredentialBindingIntentV1, { resourceId: null }>;
  agentTargetKey: string; modelId: string; signal?: AbortSignal;
}>): Promise<boolean> {
  const root = input.authorization.binding;
  const facet = input.binding.nativeDelivery;
  const request = readSessionSpawnNativeCredentialChildV1({ rootActionId: root.actionId,
    effectActionId: input.actionId, method: 'machines.managed.credentials.install',
    managedAdmission: projectExternalActionManagedAdmissionV1(input.actionId, input.params), params: input.params });
  if (!request || !facet || input.binding.slot.kind !== 'provider_model'
    || input.binding.deliveryMode !== 'vendor-native' || !input.binding.teamId
    || root.machineId !== input.machineId || root.installationId !== facet.guestInstallationId
    || request.homeId !== root.serverIdentityId || request.managedId !== facet.managedId
    || request.bindingKey !== facet.bindingKey || request.expectedResourceRevision !== input.binding.expectedResourceRevision
    || request.expectedSourceRevision !== facet.sourceRevision || request.expectedProviderTicket !== facet.providerTicket) return false;
  const reviewed = await readReviewedSessionSpawnInput(input);
  if (!reviewed || reviewed.executionTarget.machineId !== input.machineId
    || buildBackendTargetKeyV2(reviewed.agentTarget) !== input.agentTargetKey) return false;
  const selected = reviewed.teamCredentialBindings?.find(binding => binding.slot.kind === 'provider_model');
  if (!selected || selected.resourceId === null || selected.resourceId !== input.binding.resourceId
    || selected.expectedResourceRevision !== input.binding.expectedResourceRevision
    || selected.teamId !== input.binding.teamId || selected.deliveryMode !== 'vendor-native') return false;
  const model = selected.providerModelSelection;
  return !!model?.application && model.agentTargetKey === input.agentTargetKey && model.modelId === input.modelId
    && model.executionMachineId === input.machineId && model.nativeSource?.sourceRevision === facet.sourceRevision
    && model.nativeSource.providerTicket === facet.providerTicket
    && (input.binding.providerModelSelection === undefined || sameStrictJsonValue(model, input.binding.providerModelSelection));
}

/** Open the unchanged parent using its admitted requester custody. */
export async function isReviewedSessionStopChild(input: Readonly<{
  authorization: ExternalActionExecutionAuthorizationV1; envelope: unknown; actionId: string;
  machineId: string; params: unknown; method?: string; target?: unknown; signal?: AbortSignal;
}>): Promise<boolean> {
  if (!isSessionStopChildRootV1(input.authorization.binding.actionId) || input.actionId !== 'session.stop') return false;
  const rootInput = await readReviewedExternalActionInput(input);
  return rootInput != null && isSessionStopChildV1({ rootActionId: input.authorization.binding.actionId,
    effectActionId: input.actionId, method: input.method ?? RPC_METHODS.STOP_SESSION,
    target: input.target, params: input.params, rootInput });
}

/** The unchanged Move envelope is opened only with its admitted requester's material. */
export async function readReviewedServiceMoveInput(input: Readonly<{
  authorization: ExternalActionExecutionAuthorizationV1; envelope: unknown; signal?: AbortSignal;
}>) {
  if (input.authorization.binding.actionId !== 'projects.service.relocate') return null;
  const parsed = ProjectServiceRelocateInputV1Schema.safeParse(await readReviewedExternalActionInput(input));
  return parsed.success && parsed.data.workspace.serverId === input.authorization.binding.serverIdentityId ? parsed.data : null;
}

/** A source signature alone never authorizes arbitrary Session creation at another installation. */
export async function isReviewedSecondOpinionModelSpawnChild(input: Readonly<{
  authorization: ExternalActionExecutionAuthorizationV1; envelope: unknown; actionId: string;
  machineId: string; params: unknown; method?: string; signal?: AbortSignal;
}>): Promise<boolean> {
  if (input.authorization.binding.actionId !== 'discussion.second_opinion.start' || input.actionId !== 'session.spawn_new') return false;
  const wrapper = TargetedActionRpcRequestV1Schema.safeParse(input.params);
  const derived = readDiscussionSecondOpinionModelChildV1(await readReviewedExternalActionInput(input),
    input.machineId, wrapper.success ? wrapper.data.input : input.params, input.method);
  const requester = readRequesterAccountActionContext(input.authorization);
  const serverId = input.authorization.requesterAccountProjection?.serverId;
  if (!derived || !requester || !serverId || derived.spawn && !await isServerProfileHomeIdentity(serverId, derived.spawn.executionTarget.serverId)
    || !await isServerProfileHomeIdentity(serverId, derived.launch.executionTarget.serverId)) return false;
  const headers = { ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
    Authorization: `Bearer ${requester.credentials.token}`, [AUTHORITY_CEILING_HEADER_V1]: 'account_automation' };
  const read = async (path: string) => {
    if (input.signal?.aborted) return null;
    const response = await axios.get<unknown>(`${normalizeServerHttpBaseUrl(requester.serverHttpBaseUrl)}${path}`, {
      headers, ...(input.signal ? { signal: input.signal } : {}), validateStatus: () => true,
    });
    return response.status >= 200 && response.status < 300 && !input.signal?.aborted ? response.data : null;
  };
  try {
    const restored = derived.spawn ? null : DiscussionListResponseV1Schema.safeParse(await read(
      `/v1/discussions?creationLocalId=${encodeURIComponent(derived.root.retry.creationLocalId)}`));
    const discussionId = derived.spawn?.discussionParticipant?.discussionId
      ?? (restored?.success && restored.data.discussions.length === 1 ? restored.data.discussions[0]?.id : undefined);
    if (!discussionId) return false;
    const resource = DiscussionDetailsResponseV1Schema.safeParse(await read(`/v1/discussions/${encodeURIComponent(discussionId)}`));
    if (!resource.success || resource.data.discussion.id !== discussionId || resource.data.discussion.archivedAt !== null
      || resource.data.discussion.ownerAccountId !== input.authorization.binding.accountId
      || resource.data.discussion.creationLocalId !== derived.root.retry.creationLocalId) return false;
    const roster = DiscussionParticipantsListResponseV1Schema.safeParse(await read(`/v1/discussions/${encodeURIComponent(discussionId)}/participants`));
    if (!roster.success || roster.data.discussionId !== discussionId || roster.data.ownerAccountId !== input.authorization.binding.accountId) return false;
    const slot = roster.data.participants.find(participant => participant.participant.kind === 'model'
      && participant.participant.participantSlotId === derived.reviewer.participantSlotId);
    if (!slot || !('launch' in slot) || slot.answerPolicy !== 'when_addressed') return false;
    return sameStrictJsonValue({ ...slot.launch, executionTarget: { ...slot.launch.executionTarget,
      serverId: derived.launch.executionTarget.serverId } }, derived.launch)
      && !input.signal?.aborted;
  } catch (error) { rethrowRequesterHomeReadFailure(error); return false; }
}

/** The admitted Prepare receiver binds its one canonical Session child to the actual birth body. */
export function createPrepareSessionCreationAuthorization(input: Readonly<{
  context: ActionExecutorContext & Partial<Pick<RpcHandlerContext, 'machineAdmission' | 'verifyMachineAdmissionCurrent'>>;
  publicInput: SessionSpawnNewInputV2;
  installationId: string;
  privateKey: ExternalActionMachineRequestSigningKey;
}>): SessionCreationAuthorizationV1 | null {
  const { context } = input;
  const authorization = context.externalActionExecutionAuthorization;
  const parent = readHostReviewedParentV1(context);
  const child = readHostAdmittedReviewedChildV1(context);
  const root = DeploymentPrepareInputV1Schema.safeParse(parent?.input);
  const spawn = SessionSpawnNewInputV2Schema.safeParse(child?.input);
  const admission = context.machineAdmission;
  const identity = authorization && deriveDeploymentPrepareSessionCreationIdentityV1(authorization.binding);
  if (!authorization || !identity || !root.success || !spawn.success || root.data.sessionRef
    || parent?.actionId !== 'deployments.prepare' || child?.actionId !== 'session.spawn_new' || child.role !== 'prepare-session'
    || context.actionRequestId !== identity.requestId || !context.verifyMachineAdmissionCurrent || !admission
    || admission.machineId !== authorization.binding.machineId || admission.installationId !== input.installationId
    || admission.installationId !== authorization.binding.installationId
    || admission.actorAccountId !== authorization.binding.accountId
    || admission.custodianAccountId !== authorization.binding.custodianAccountId
    || spawn.data.executionTarget.machineId !== admission.machineId
    || spawn.data.executionTarget.serverId !== root.data.workspace.serverId
    || !sameStrictJsonValue(spawn.data.initialInput, { text: buildDeploymentPreparationBriefV1(root.data) })
    || !sameStrictJsonValue(input.publicInput.executionTarget, spawn.data.executionTarget)
    || !sameStrictJsonValue(input.publicInput.directory, spawn.data.directory)
    || !sameStrictJsonValue(input.publicInput.initialInput, spawn.data.initialInput)
    || !sameStrictJsonValue(input.publicInput.agentTarget, spawn.data.agentTarget)) return null;
  const envelope = context.originalActionEnvelope;
  if (!envelope || !isExternalActionAuthorizationBoundToEnvelope(authorization.binding, {
    actionId: 'deployments.prepare', machineId: admission.machineId, envelope,
  }) || envelope.v === 1 && !sameStrictJsonValue(envelope.input, root.data)) return null;
  const method = `${admission.machineId}:${RPC_METHODS.SESSION_SPAWN_NEW}`;
  // The native issuer already owns the opened E2EE child. Its signed body proof
  // carries no plaintext preparation brief or checkout path to Home.
  const params = envelope.v === 1 ? child.input : undefined;
  const execution = createExternalActionMachineRpcExecution({ context, effectActionId: 'session.spawn_new',
    installationId: input.installationId, method, requestId: identity.requestId,
    ...(params === undefined ? {} : { params }), privateKey: input.privateKey });
  if (!execution) return null;
  const sourceExecution = { requestId: identity.requestId, method,
    ...(params === undefined ? {} : { params }), externalActionExecution: execution, originalActionEnvelope: envelope };
  return { token: authorization.token, prepareRequestProof: async body => {
    if (!await context.verifyMachineAdmissionCurrent!() || context.signal?.aborted
      || body.tag !== identity.sessionCreationTag) throw new Error('prepare_session_creation_authorization_unavailable');
    return { v: 1, sourceExecution, machineAdmission: admission,
      proof: signMachineInstallationProof({ privateKey: input.privateKey,
        payload: buildSessionActionChildCreationProofPayloadV1({ sourceExecution, machineAdmission: admission, body }) }) };
  } };
}

/** Only the reached native receiver may bind the reviewed public child to its final HTTP birth body. */
export function createReviewedSecondOpinionSessionCreationAuthorization(input: Readonly<{
  context: ActionExecutorContext & Partial<Pick<RpcHandlerContext, 'workspaceSyncSourceExecution' | 'machineAdmission' | 'verifyMachineAdmissionCurrent'>>;
  publicInput: SessionSpawnNewInputV2;
  installationId: string;
  privateKey: ExternalActionMachineRequestSigningKey;
}>): SessionCreationAuthorizationV1 | null {
  const authorization = input.context.externalActionExecutionAuthorization;
  if (authorization?.binding.actionId !== 'discussion.second_opinion.start') return null;
  const sourceExecution = input.context.workspaceSyncSourceExecution;
  const machineAdmission = input.context.machineAdmission;
  const ref = input.publicInput.discussionParticipant;
  if (!sourceExecution || !machineAdmission || !ref || !input.context.verifyMachineAdmissionCurrent
    || sourceExecution.method !== `${machineAdmission.machineId}:${RPC_METHODS.SESSION_SPAWN_NEW}`
    || machineAdmission.machineId !== input.publicInput.executionTarget.machineId
    || machineAdmission.installationId !== input.installationId
    || sourceExecution.externalActionExecution.authorization.token !== authorization.token
    || !sameStrictJsonValue(sourceExecution.externalActionExecution.authorization.binding, authorization.binding)
    || !sameStrictJsonValue(sourceExecution.originalActionEnvelope, input.context.originalActionEnvelope)) return null;
  return { token: authorization.token, prepareRequestProof: async body => {
    if (!await input.context.verifyMachineAdmissionCurrent!()
      || !await isReviewedSecondOpinionModelSpawnChild({ authorization, envelope: input.context.originalActionEnvelope,
        machineId: machineAdmission.machineId, actionId: 'session.spawn_new', params: input.publicInput,
        ...(input.context.signal ? { signal: input.context.signal } : {}) })
      || body.originKind !== 'discussion' || !sameStrictJsonValue(body.discussionParticipant, ref)
      || !sameStrictJsonValue(body.discussionParticipantLaunch, projectDiscussionModelParticipantLaunchV1(input.publicInput))
      || body.tag !== deriveSessionCreationTagV1({ callerCreationNamespace: JSON.stringify(['discussion-participant', ref.discussionId]),
        creationKey: ref.participantSlotId })) throw new Error('discussion_model_creation_authorization_unavailable');
    return { v: 1, sourceExecution, machineAdmission,
      proof: signMachineInstallationProof({ privateKey: input.privateKey,
        payload: buildDiscussionModelSessionCreationProofPayloadV1({ sourceExecution, machineAdmission, body }) }) };
  } };
}

/** Exact current Account refs constrain the two child reads/starts that carry a root path. */
export async function isReviewedServiceMoveChild(input: Readonly<{
  authorization: ExternalActionExecutionAuthorizationV1; envelope: unknown; actionId: string;
  machineId: string; params: unknown; signal?: AbortSignal;
}>): Promise<boolean> {
  const move = await readReviewedServiceMoveInput(input);
  return isReviewedServiceMoveChildForInput(input, move);
}

async function isReviewedServiceMoveChildForInput(input: Parameters<typeof isReviewedServiceMoveChild>[0],
  move: Awaited<ReturnType<typeof readReviewedServiceMoveInput>>): Promise<boolean> {
  if (!move || input.signal?.aborted || !isProjectServiceMoveChildInputV1(move, input.actionId, input.machineId, input.params)) return false;
  if (input.actionId !== 'localServices.launcher.start' && input.actionId !== 'localServices.launcher.snapshot'
    && input.actionId !== 'projects.inspect') return true;
  const requester = readRequesterAccountActionContext(input.authorization);
  if (!requester) return false;
  const { readWorkspaceSyncWorkerTargetSnapshot, resolveWorkspaceSyncWorkerTarget } = await import('@/workspaces/sync/workspaceSyncPreparation');
  const snapshot = await readWorkspaceSyncWorkerTargetSnapshot({ serverId: move.workspace.serverId,
    serverHttpBaseUrl: requester.serverHttpBaseUrl, credentials: requester.credentials, authorization: input.authorization,
    sourceWorkspaceRefId: move.workspace.refId, targetMachineId: input.machineId, signal: input.signal });
  const wrapper = TargetedActionRpcRequestV1Schema.safeParse(input.params);
  const value = wrapper.success ? wrapper.data.input : input.params;
  if (input.actionId === 'projects.inspect') {
    const { ProjectDefinitionInspectInputSchema } = await import('@happier-dev/protocol/actions/projectDefinitionActionFamily');
    const inspection = ProjectDefinitionInspectInputSchema.parse(value);
    const source = snapshot.workspaceRefs.find(ref => ref.id === move.workspace.refId && ref.serverId === move.workspace.serverId);
    if (source?.machineId === input.machineId && inspection.workspace.workspaceId === source.id
      && inspection.workspace.rootPath === source.rootPath) return !input.signal?.aborted;
    if (!inspection.workspace.workspaceId) return false;
    const destination = resolveWorkspaceSyncWorkerTarget({ serverId: move.workspace.serverId, sourceWorkspaceRefId: move.workspace.refId,
      targetMachineId: move.selectedTarget.machineId, targetWorkspaceRefId: inspection.workspace.workspaceId,
      workspaceRefs: snapshot.workspaceRefs, relationships: snapshot.relationships, childMachines: snapshot.childMachines });
    return destination.ok && destination.target.machineId === input.machineId
      && inspection.workspace.rootPath === destination.target.rootPath && !input.signal?.aborted;
  }
  if (input.actionId === 'localServices.launcher.snapshot') {
    const request = DaemonLocalServiceLauncherSnapshotRequestV1Schema.parse(value);
    const incumbent = snapshot.workspaceRefs.find(ref => ref.serverId === move.workspace.serverId
      && ref.id === move.currentTarget.workspaceId && ref.machineId === move.currentTarget.machineId);
    return Boolean(incumbent && request.workspaceRoot === incumbent.rootPath && !input.signal?.aborted);
  }
  const request = DaemonLocalServiceLauncherStartRequestV1Schema.parse(value);
  if (!request.workspace?.workspaceId) return false;
  const destination = resolveWorkspaceSyncWorkerTarget({ serverId: move.workspace.serverId, sourceWorkspaceRefId: move.workspace.refId,
    targetMachineId: move.selectedTarget.machineId, targetWorkspaceRefId: request.workspace.workspaceId,
    workspaceRefs: snapshot.workspaceRefs, relationships: snapshot.relationships, childMachines: snapshot.childMachines });
  return destination.ok && request.workspace?.workspaceId === destination.target.id
    && request.workspace.rootPath === destination.target.rootPath && !input.signal?.aborted;
}

/** Consume the SOURCE operation's live Start permission after exact child verification. */
export async function claimReviewedServiceMoveStart(input: Readonly<{
  authorization: ExternalActionExecutionAuthorizationV1; envelope: unknown; signal: AbortSignal;
}>): Promise<import('@happier-dev/protocol/workspaces/projectServiceRelocationV1').ProjectServiceMoveStartClaimResultV1> {
  return claimReviewedServiceMoveStartForInput(input, await readReviewedServiceMoveInput(input));
}

async function claimReviewedServiceMoveStartForInput(input: Parameters<typeof claimReviewedServiceMoveStart>[0],
  move: Awaited<ReturnType<typeof readReviewedServiceMoveInput>>): ReturnType<typeof claimReviewedServiceMoveStart> {
  const unavailable = { kind: 'refused', reasonCode: 'service_move_start_authority_unavailable' } as const;
  const requester = readRequesterAccountActionContext(input.authorization);
  if (!requester || !move || input.signal.aborted) return unavailable;
  const { ProjectServiceMoveStartClaimV1Schema, ProjectServiceMoveStartClaimResultV1Schema } = await import('@happier-dev/protocol/workspaces/projectServiceRelocationV1');
  const { callExactMachineRpc } = await import('@/session/transport/rpc/machineRpc');
  try {
    const result = ProjectServiceMoveStartClaimResultV1Schema.safeParse(await callExactMachineRpc({
      credentials: requester.credentials, serverUrl: requester.serverHttpBaseUrl,
      machineId: input.authorization.binding.machineId, method: RPC_METHODS.DAEMON_SERVICE_MOVE_START_CLAIM,
      request: ProjectServiceMoveStartClaimV1Schema.parse({ requestId: input.authorization.binding.requestId,
        installationId: input.authorization.binding.installationId, input: move }),
      requireCurrentMachine: true, requiredMachineKind: 'persistent', timeoutMs: null, signal: input.signal,
      authorityCeiling: 'account_automation',
    }));
    return result.success && !input.signal.aborted ? result.data : unavailable;
  } catch { return unavailable; }
}

/** One admitted receiving invocation opens SOURCE once; current refs and the
 * operation's Start claim still belong to their existing owners below. */
export async function openReviewedServiceMove(input: Parameters<typeof claimReviewedServiceMoveStart>[0]) {
  const move = await readReviewedServiceMoveInput(input);
  if (!move) return null;
  return {
    input: move,
    isChild: (child: Pick<Parameters<typeof isReviewedServiceMoveChild>[0], 'actionId' | 'machineId' | 'params'>) =>
      isReviewedServiceMoveChildForInput({ ...input, ...child }, move),
    claimStart: () => claimReviewedServiceMoveStartForInput(input, move),
  };
}

export const ExternalActionInstalledMachineUnavailableSchema = z.strictObject({
  machineId: z.string(), status: z.number(),
  reason: z.enum(['http_refused', 'invalid_publication', 'machine_mismatch', 'machine_not_persistent',
    'installation_missing', 'installation_revoked', 'installation_replaced']),
});
type InstalledMachine = z.infer<typeof ExternalActionMachineBootstrapV1Schema>
  & Readonly<{ installationId: string; installationPublicKey?: string | null }>;

/** Fresh authenticated installation publication; offline is not revocation. */
export async function readExternalActionInstalledMachineResult(input: Readonly<{
  serverHttpBaseUrl: string;
  machineId: string;
  headers: Readonly<Record<string, string>>;
  signal?: AbortSignal;
}>): Promise<Readonly<{ ok: true; machine: InstalledMachine }>
  | Readonly<{ ok: false; details: z.infer<typeof ExternalActionInstalledMachineUnavailableSchema> }>> {
  const publication = await axios.get<unknown>(`${normalizeServerHttpBaseUrl(input.serverHttpBaseUrl)}/v1/machines/${encodeURIComponent(input.machineId)}`, {
    headers: { ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(), ...input.headers },
    ...(input.signal ? { signal: input.signal } : {}), validateStatus: () => true,
  });
  const raw = publication.data && typeof publication.data === 'object' && 'machine' in publication.data
    ? publication.data.machine : null;
  const installed = z.looseObject({ ...ExternalActionMachineBootstrapV1Schema.shape,
    installationPublicKey: z.nullish(z.string().check(z.base64())),
  }).safeParse(raw);
  if (publication.status < 200 || publication.status >= 300)
    return { ok: false, details: { machineId: input.machineId, status: publication.status, reason: 'http_refused' } };
  if (!installed.success)
    return { ok: false, details: { machineId: input.machineId, status: publication.status, reason: 'invalid_publication' } };
  if (!installed.data.installationId)
    return { ok: false, details: { machineId: input.machineId, status: publication.status, reason: 'installation_missing' } };
  const reason = installed.data.id !== input.machineId ? 'machine_mismatch'
    : installed.data.kind !== 'persistent' ? 'machine_not_persistent'
      : installed.data.revokedAt !== null ? 'installation_revoked'
        : installed.data.replacedByMachineId !== null ? 'installation_replaced' : null;
  if (reason) return { ok: false, details: { machineId: input.machineId, status: publication.status, reason } };
  return { ok: true, machine: { ...installed.data, installationId: installed.data.installationId } };
}

/** Existing callers need only an installed/not-installed answer from the same owner. */
export async function readExternalActionInstalledMachine(
  input: Parameters<typeof readExternalActionInstalledMachineResult>[0],
): Promise<InstalledMachine | null> {
  const read = await readExternalActionInstalledMachineResult(input);
  return read.ok ? read.machine : null;
}

/** Schema-checked provenance projection only; Home still verifies the issued root and current principal. */
export function resolveExternalActionRootInvocationAuthority(authorization: ExternalActionExecutionAuthorizationV1): ActionRequiredAuthority {
  const binding = authorization.binding;
  const credential = binding.sessionActionOrigin || binding.workflowActionOrigin ? 'agent'
    : 'authentication' in binding ? binding.authentication.kind : 'api_token';
  return resolveInvocationAuthority({ credential, surface: 'rpc' });
}

/** A terminal bearer cannot claim the UI approval floor; other admitted surfaces are preserved. */
export function resolveExternalActionAccountInvocationSurface(authenticationKind: 'account' | 'terminal' | undefined,
  surface?: ActionExecutorContext['surface']): NonNullable<ActionExecutorContext['surface']> {
  if (authenticationKind === 'terminal' && surface === 'ui') return 'cli';
  return surface ?? (authenticationKind === 'terminal' ? 'cli' : 'ui');
}

/**
 * The device-local profile id routes a request to one Home, while the observed
 * stable identity binds Home-issued authorization. They are deliberately
 * independent because a profile id is not cryptographic identity evidence.
 */
export type ExternalActionHomeBinding = Readonly<{
  serverId?: string;
  serverIdentityId?: string;
  externalActionMachineRequestPrivateKey?: ExternalActionMachineRequestSigningKey;
  externalActionMachineInstallationId?: string;
}>;

type OriginalAccountActionInput = Readonly<{
  actionId: string;
  input: unknown;
  requestId: string;
  target: ExternalActionTargetV1;
  credentials: StoredCredentials;
  serverHttpBaseUrl: string;
  serverIdentityId?: string;
  authority?: ActionExecutorContext['authority'];
  managedContinuation?: ExternalActionExecutionAuthorizationRequestV1['managedContinuation'];
  /** Host provenance retained inside the existing installation-bound private box. */
  invocation?: ExternalActionRequesterInvocationV1;
  /** Host-private installed Run origin. Home reads consent from that Run, never from this caller. */
  installedWorkflow?: Readonly<{
    context: ActionExecutorContext; machineId: string; installationId: string; privateKey: ExternalActionMachineRequestSigningKey;
  }>;
  /** The admitted original spawn authorizes only its exact native install child. */
  nativeCredentialSpawnChild?: Readonly<{
    context: ActionExecutorContext; machineId: string; installationId: string; privateKey: ExternalActionMachineRequestSigningKey;
    binding: Exclude<SessionTeamCredentialBindingIntentV1, { resourceId: null }>;
    agentTargetKey: string; modelId: string;
  }>;
  /** A human confidentiality decision, distinct from the target Action's Ask first policy. */
  onRequesterSessionCredentialDisclosure?: (disclosure: ReturnType<typeof projectRequesterSessionCredentialDisclosure>) => boolean | void | Promise<boolean | void>;
  isCurrent?: () => boolean | Promise<boolean>;
  signal?: AbortSignal;
}>;

/** Home-bound managed effects, Sync writes, native Agent inventory, finite work, owned-copy review and terminal access need Machine
 * admission even on an own target. Workflow birth also needs the authenticated
 * requester custody that private root control does not carry. */
export function requiresOriginalAccountMachineActionProof(actionId: string, input?: unknown): boolean {
  const sessionSpawn = actionId === SESSION_SPAWN_NEW_ACTION_ID_V1 ? SessionSpawnNewActionInputV2Schema.safeParse(input) : null;
  const hasSession = input !== null && typeof input === 'object' && 'sessionId' in input
    && typeof input.sessionId === 'string' && input.sessionId.trim().length > 0;
  const detachedRunLaunch = !hasSession && (actionId === 'execution.run.start' || actionId === 'execution.run.ensure'
    || actionId === 'execution.run.send' || actionId === 'execution.run.ensure_or_start');
  return isWorkspaceSyncRelationshipControlActionId(actionId) || Object.hasOwn(PROJECT_FINITE_ACTION_RPC_METHODS_V1, actionId) || actionId === 'projects.inspect'
    || isWorkspaceSyncRelationshipWriteActionId(actionId)
    || sessionSpawn?.success === true && sessionSpawn.data.machineSetupPlanInput !== undefined
    || readDeploymentTargetRetentionMachineIds(actionId, input).length > 0
    || actionId === 'agents.models.list' || actionId === 'agents.config_options.list'
    || actionId === 'machines.capabilities.install' || actionId === 'home.runtime.restart'
    || actionId === 'deployments.prepare' || actionId === 'deployments.publish.prepare'
    || actionId === 'deployments.deploy' || actionId === 'deployments.rollback'
    || actionId === 'deployments.promote' || actionId === 'deployments.teardown'
    || actionId === 'deployments.targets.link' && input !== null && typeof input === 'object' && !('contentArtifactId' in input)
    || actionId === 'deployments.receipts.observe'
    || isDeploymentObservationReadActionIdV1(actionId)
    || isDeploymentReadActionIdV1(actionId)
    || isDeploymentBackupActionIdV1(actionId) || isProjectReadinessActionIdV1(actionId)
    || actionId === 'deployments.templates.instantiate'
    || actionId === 'deployments.environments.create' && projectDeploymentPreparationAdmissionV1(actionId, input) !== undefined
    || actionId.startsWith('scm.diffSummary.result.') || isScmDiffSummaryRunAction(actionId)
    || actionId === 'projects.open' || actionId === 'projects.service.relocate'
    || actionId === 'localServices.launcher.start' || actionId === 'localServices.actions.stopManaged'
    || actionId === 'localServices.actions.restartManaged'
    || ACTION_ID_FAMILIES_V1.machine_processes.some(id => id === actionId)
    || actionId === 'machines.vitals.get' || actionId === 'machines.vitals.history.get'
    || ACTION_ID_FAMILIES_V1.machine_guard.some(id => id === actionId)
    || ACTION_ID_FAMILIES_V1.machine_storage.some(id => id === actionId)
    || actionId === 'machines.resources.policy.set'
    || ACTION_ID_FAMILIES_V1.machine_reachability.some(id => id === actionId)
    || actionId === 'machines.agentIsolation.status' || actionId === 'machines.command.run'
    || ACTION_ID_FAMILIES_V1.machine_work_summary.some(id => id === actionId)
    || ACTION_ID_FAMILIES_V1.usage_sources.some(id => id === actionId && id !== 'usage.sources.dismiss')
    || ACTION_ID_FAMILIES_V1.machine_agent_install.some(id => id === actionId)
    || actionId === 'workflow.run.start'
    || detachedRunLaunch
    || actionId === 'projects.worker.status' || actionId === 'projects.worker.copy.inspect' || actionId === 'projects.worker.copy.retire'
    || actionId === 'projects.execution.output.read' || actionId === 'projects.execution.output.copy'
    || actionId === 'machines.setup.apply' || actionId === 'machines.setup.remove' || actionId === 'machines.setup.updates.apply' || isMachineTerminalActionId(actionId)
    || actionId === 'machines.managed.acquire' || actionId === 'machines.managed.inspect'
    || actionId === 'machines.managed.bootstrap.retry' || actionId === 'machines.managed.credentials.install'
    || MANAGED_CONTROL_ACTION_IDS_V1.some(id => id === actionId);
}

export function dispatchOriginalAccountAction(input: OriginalAccountActionInput & Readonly<{ foreignTargetOnly: true }>): Promise<ActionExecuteResult | null>;
export function dispatchOriginalAccountAction(input: OriginalAccountActionInput): Promise<ActionExecuteResult>;
/** Original Account/terminal delivery enters Home before a retained guest can accept it.
 * Session input names its existing publisher custody; Machine targets retain
 * the incumbent disclosure and signed-requester-context admission.
 */
export async function dispatchOriginalAccountAction(input: OriginalAccountActionInput & Readonly<{ foreignTargetOnly?: true }>): Promise<ActionExecuteResult | null> {
  const fail = (errorCode: string): ActionExecuteFailure => ({ ok: false, errorCode, error: errorCode });
  const phase = <T>(name: string, read: () => T | Promise<T>) => runTracedExternalActionInnerStage(`dispatch.${name}`, read);
  input.signal?.throwIfAborted();
  const installedCaller = input.installedWorkflow?.context.actionCaller;
  if (input.installedWorkflow && installedCaller?.kind === 'workflowRun'
    && isReviewedMachineSetupCodecV1({ actionId: input.actionId, workflowActionOrigin: {
      runId: installedCaller.runId, requestId: input.requestId, reviewedChild: installedCaller.authorization.reviewedChild } })
    && installedCaller.authorization.externalActionExecutionAuthorization) {
    const { dispatchInstalledWorkflowNativeSetupAction } = await import('./installedWorkflowActionAuthorization');
    return await dispatchInstalledWorkflowNativeSetupAction(input);
  }
  const claims = decodeJwtPayload(input.credentials.token);
  const provenance = readAuthTokenProvenance(claims, { allowLegacyHome: input.installedWorkflow !== undefined });
  const publisherAccountId = readAccountIdFromToken(input.credentials.token);
  const homeUrl = normalizeServerHttpBaseUrl(input.serverHttpBaseUrl);
  if (input.target.kind === 'session' && input.actionId !== SESSION_MESSAGE_SEND_ACTION_ID_V1) return fail('target_unavailable');
  const requiresMachineProof = input.invocation?.caller.kind === 'plugin'
    || requiresOriginalAccountInvocationMachineProofV1(input.actionId) && input.invocation !== undefined
    || input.managedContinuation !== undefined
    || requiresOriginalAccountMachineActionProof(input.actionId, input.input);
  const workflow = input.installedWorkflow;
  const workflowCaller = workflow?.context.actionCaller;
  const workflowAuthorization = workflowCaller?.kind === 'workflowRun'
    ? workflowCaller.authorization.externalActionExecutionAuthorization : undefined;
  const workflowBinding = workflowAuthorization?.binding;
  const accountId = workflowBinding?.accountId ?? publisherAccountId;
  const spawnChild = input.nativeCredentialSpawnChild;
  const spawnRequester = spawnChild
    ? readRequesterAccountActionContext(spawnChild.context.externalActionExecutionAuthorization) : null;
  if (spawnChild) {
    const authorization = spawnChild.context.externalActionExecutionAuthorization;
    if (!authorization || !spawnRequester || authorization.binding.accountId !== accountId || authorization.binding.serverIdentityId !== input.serverIdentityId
      || spawnChild.installationId !== authorization.binding.installationId
      || !await isReviewedSessionSpawnNativeCredentialChild({ authorization, envelope: spawnChild.context.originalActionEnvelope,
        actionId: input.actionId, machineId: spawnChild.machineId, params: input.input,
        binding: spawnChild.binding, agentTargetKey: spawnChild.agentTargetKey, modelId: spawnChild.modelId,
        ...(input.signal ? { signal: input.signal } : {}) })) return fail('admission_unavailable');
  }
  if (workflow && (workflowCaller?.kind !== 'workflowRun'
    || workflow.context.executionRunWorkflowRunId !== workflowCaller.runId
    || workflow.context.actionRequestId !== input.requestId || !input.serverIdentityId
    || input.target.kind !== 'machine')) return fail('admission_unavailable');
  if (workflowCaller?.kind === 'workflowRun' && workflowCaller.authorization.principal.kind === 'api'
    && (!workflowBinding || 'authentication' in workflowBinding || workflowBinding.custodianAccountId !== publisherAccountId
      || workflowBinding.serverIdentityId !== input.serverIdentityId)) return fail('admission_unavailable');
  const isCurrent = async () => !input.signal?.aborted
    && (!spawnRequester || input.isCurrent === spawnRequester.isCurrent || await phase('spawn_custody', () => spawnRequester.isCurrent()))
    && (!input.isCurrent || await phase('currentness', () => input.isCurrent!()));
  if (!await isCurrent()) return fail('target_unavailable');
  // This branch only chooses the incumbent own-account path. Home still owns
  // authentication and the destination owns its Action admission.
  let machines: Awaited<ReturnType<typeof listCurrentAccountMachines>> | undefined;
  const managedAdmission = projectExternalActionManagedAdmissionV1(input.actionId, input.input);
  let scopedController: (NonNullable<ManagedMachineV1['controllerAccess']> & ManagedMachineV1['controller']) | undefined;
  if (managedAdmission && managedAdmission.actionId !== 'machines.managed.power.set'
    && managedAdmission.actionId !== 'machines.managed.delete'
    && accountId && input.serverIdentityId && input.target.kind === 'machine' && !workflow) {
    const managed = managedAdmission.input;
    const managedHomeId = 'homeId' in managed ? managed.homeId : managed.selection.homeId;
    if (managedHomeId !== input.serverIdentityId) return fail('server_target_mismatch');
    if ('managedId' in managed) {
      const row = await phase('managed_machine', () => readManagedMachine({ credentials: input.credentials,
        serverHttpBaseUrl: homeUrl, homeId: managed.homeId, managedId: managed.managedId,
        ...(input.signal ? { signal: input.signal } : {}) }));
      if (row.id !== managed.managedId || row.homeId !== managed.homeId
        || !row.controller || row.controller.machineId !== input.target.machineId) return fail('controller_retired');
      if (row.enrollmentAccountId === accountId && row.custodianAccountId !== accountId) {
        if (!row.controllerAccess) return fail('controller_unavailable');
        scopedController = { ...row.controller, ...row.controllerAccess };
      }
    } else if ('selection' in managed && managed.selection.kind === 'preset' && 'controller' in managed) {
      const response = await axios.post<unknown>(`${homeUrl}${machinePresetActionEndpointPathV1('machines.presets.get')}`,
        { homeId: managedHomeId, id: managed.selection.id }, { headers: { Authorization: `Bearer ${input.credentials.token}` },
          ...(input.signal ? { signal: input.signal } : {}) });
      const projected = ManagedMachinePresetGetResultV1Schema.safeParse(response.data);
      if (!projected.success) return fail('managed_response_invalid');
      if (projected.data.kind === 'refused') return fail(projected.data.code);
      const preset = projected.data.preset;
      if (preset.id !== managed.selection.id || preset.homeId !== managedHomeId
        || preset.revision !== managed.selection.revision) return fail('request_conflict');
      if (!preset.controller || !sameStrictJsonValue(preset.controller, managed.controller)
        || preset.controller.machineId !== input.target.machineId) return fail('controller_retired');
      const delegated = preset.delegatedAcquire;
      if (delegated?.kind === 'unavailable') return fail(delegated.code);
      if (delegated?.kind === 'ready') {
        if (preset.owner.kind !== 'team' || !preset.teamAcquireDelegated
          || !sameStrictJsonValue(managed.retention, delegated.reviewedFacts.retention)
          || managed.wakeOnAcceptedMessage !== delegated.reviewedFacts.wakeOnAcceptedMessage) return fail('permission_denied');
        scopedController = { ...preset.controller, ...delegated.controller };
      }
    }
    if (scopedController && (scopedController.machineId !== input.target.machineId
      || !await isCurrent())) return fail('controller_retired');
  }
  if (input.foreignTargetOnly && !workflow && !scopedController) {
    if (input.target.kind !== 'machine') return fail('target_unavailable');
    const machineId = input.target.machineId;
    machines = await phase('machine_inventory', () => listCurrentAccountMachines({ token: input.credentials.token,
      credentials: input.credentials, machineIds: [machineId], projection: 'hostFacts', serverHttpBaseUrl: homeUrl,
      ...(input.signal ? { signal: input.signal } : {}) }));
    if (!await isCurrent()) return fail('target_unavailable');
    const own = machines.find(row => row.id === machineId);
    const ordinary = readAuthTokenProvenance(claims, { allowLegacyHome: true });
    if (!requiresMachineProof && ordinary?.provenance.kind === 'account'
      && ordinary.provenance.authority === 'present_user' && input.authority !== 'account_automation'
      && accountId && own?.access?.custodian.accountId === accountId) return null;
  }
  const extras = claims && typeof claims.extras === 'object' && claims.extras !== null && !Array.isArray(claims.extras)
    ? claims.extras as Readonly<Record<string, unknown>> : {};
  const kind = provenance?.provenance.kind;
  const authentication = ExternalActionSignedAuthenticationV1Schema.safeParse(workflowBinding && 'authentication' in workflowBinding
    ? workflowBinding.authentication : { kind,
      tokenEpoch: claims?.tokenEpoch ?? extras.tokenEpoch ?? (workflow && provenance?.legacy ? 0 : undefined),
      ...(provenance?.provenance && 'evidence' in provenance.provenance ? { evidence: provenance.provenance.evidence } : {}) });
  if (!publisherAccountId || !accountId || !authentication.success
    || !((kind === 'account' && provenance?.provenance.authority === 'present_user')
      || (kind === 'terminal' && provenance?.provenance.authority === 'account_automation'))) return fail('admission_unavailable');
  const invocationAuthority = resolveInvocationAuthority({ credential: kind, surface: 'rpc' });
  const headers = { Authorization: `Bearer ${input.credentials.token}`, 'Content-Type': 'application/json',
    ...(invocationAuthority === 'account_automation' || input.authority === 'account_automation'
      ? { [AUTHORITY_CEILING_HEADER_V1]: 'account_automation' } : {}) };
  const readInstalledPublication = (machineId: string) => phase('installed_machine', () => readExternalActionInstalledMachine({
    serverHttpBaseUrl: homeUrl, machineId, headers, ...(input.signal ? { signal: input.signal } : {}),
  }));
  // These passive reads already have the exact target and authenticated requester. Join them
  // before interpreting mode/ownership, minting authority or disclosing material.
  const target = input.target;
  const [modeRead, inventoryRead, installedRead] = await Promise.allSettled([
    workflowBinding ? Promise.resolve(workflowBinding.accountEncryptionMode
      ? { kind: 'resolved' as const, mode: workflowBinding.accountEncryptionMode }
      : { kind: 'unavailable' as const })
      : phase('account_mode', () => readAccountEncryptionModeOnce({ credentials: input.credentials, request: () => axios.get<unknown>(`${homeUrl}/v1/account/encryption`, {
      headers, ...(input.signal ? { signal: input.signal } : {}), validateStatus: () => true,
    }) })),
    target.kind === 'machine' && !machines && !workflow && !scopedController
      ? phase('machine_inventory', () => listCurrentAccountMachines({ token: input.credentials.token,
        credentials: input.credentials, machineIds: [target.machineId], projection: 'hostFacts', serverHttpBaseUrl: homeUrl,
        ...(input.signal ? { signal: input.signal } : {}) })) : machines,
    input.target.kind === 'machine' && requiresMachineProof && input.serverIdentityId && !workflow && !scopedController
      ? readInstalledPublication(input.target.machineId) : undefined,
  ]);
  // Preserve mode refusal/error precedence while settling all passive reads.
  if (modeRead.status === 'rejected') throw modeRead.reason;
  const mode = modeRead.value;
  if (mode.kind !== 'resolved') return fail('content_unavailable');
  if (inventoryRead.status === 'rejected') throw inventoryRead.reason;
  machines = inventoryRead.value;
  let machine: CurrentAccountMachineInventoryItem | undefined;
  let foreign = scopedController ? scopedController.custodian.accountId !== accountId : false;
  if (input.target.kind === 'machine' && !workflow && !scopedController) {
    const selected = await resolveOriginalAccountMachineTarget({ actionId: input.actionId,
      machineId: input.target.machineId, machines, accountId, accountMode: mode.mode,
      authenticationKind: kind, authority: input.authority, credentialProvenance: input.credentials.credentialProvenance,
      managedAdmission: Boolean(managedAdmission), isCurrent });
    if (selected.kind === 'refused') return selected.execution;
    machine = selected.machine;
    foreign = selected.foreign;
  }
  let material: Extract<AccountScopedCryptoMaterial, { type: 'dataKey' }> | undefined;
  const workflowActionOrigin = workflow && workflowCaller?.kind === 'workflowRun'
    ? { runId: workflowCaller.runId, requestId: input.requestId,
      ...(workflowCaller.authorization.reviewedChild ? { reviewedChild: workflowCaller.authorization.reviewedChild } : {}) }
    : undefined;
  const controllerCodec = Boolean(foreign && (managedAdmission
    || isManagedControllerCodecActionV1({ actionId: input.actionId, managedAdmission }))
    || workflowActionOrigin && isReviewedMachineSetupCodecV1({ actionId: input.actionId, workflowActionOrigin }));
  if (controllerCodec) material = { type: 'dataKey', machineKey: randomBytes(32) };
  if (mode.mode === 'e2ee') {
    if (!input.serverIdentityId) return fail('admission_unavailable');
    if (workflowBinding && accountId !== publisherAccountId) return fail('content_unavailable');
    try { if (!controllerCodec) {
      const keyed = requireAccountEncryptionCredentials(input.credentials).encryption;
      material = { type: 'dataKey', machineKey: keyed.type === 'dataKey'
        ? keyed.machineKey : deriveAccountMachineKeyFromRecoverySecret(keyed.secret) }; }
    } catch { return fail('content_unavailable'); }
  }
  const actionId = ExternalActionActionIdV1Schema.parse(input.actionId);
  const binding = mode.mode === 'e2ee' && material ? { serverIdentityId: input.serverIdentityId!, accountId,
    ...(workflowBinding && !('authentication' in workflowBinding) ? { credentialId: workflowBinding.credentialId }
      : { authentication: { kind: authentication.data.kind, tokenEpoch: authentication.data.tokenEpoch } }),
    actionId, requestId: input.requestId, target: input.target } satisfies ExternalActionEncryptionBindingV2 : undefined;
  const idempotencyKey = projectExternalActionRunNowIdempotencyKeyV1(actionId, input.input);
  const envelope = binding && material ? sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding, material, input: input.input, randomBytes,
    ...(actionId === SESSION_SPAWN_NEW_ACTION_ID_V1 && input.input !== null && typeof input.input === 'object'
      && 'machineSetupPlanInput' in input.input && input.input.machineSetupPlanInput !== undefined ? {
      sessionSpawnAdmission: projectApiTokenSessionSpawnAdmissionV1(admitSessionSpawnNewActionInputV2(
        SessionSpawnNewActionInputV2Schema.parse(input.input))),
    } : {}),
  })
    : ExternalActionRequestEnvelopeSchema.parse({ v: 1, requestId: input.requestId, target: input.target, input: input.input,
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }) });
  let body: unknown = envelope;
  const access = machine?.access;
  const nativeCredentialSpawnChild = spawnChild ? (() => {
    if (managedAdmission?.actionId !== 'machines.managed.credentials.install') return null;
    const authorization = spawnChild.context.externalActionExecutionAuthorization!;
    const params = envelope.v === 1 ? envelope.input : envelope.payload.c;
    const method = `${input.target.kind === 'machine' ? input.target.machineId : ''}:machines.managed.credentials.install`;
    const execution = createExternalActionSourceMachineRpcExecution({ authorization,
      target: authorization.binding.target, sourceMachineId: spawnChild.machineId,
      sourceInstallationId: spawnChild.installationId, effectActionId: input.actionId,
      method, requestId: envelope.requestId, params, managedAdmission, privateKey: spawnChild.privateKey });
    return execution && spawnChild.context.originalActionEnvelope ? { externalActionExecution: execution,
      method, requestId: envelope.requestId, params, originalActionEnvelope: spawnChild.context.originalActionEnvelope } : null;
  })() : undefined;
  if (spawnChild && !nativeCredentialSpawnChild) return fail('admission_unavailable');
  if (workflow && workflowActionOrigin) {
    body = ExternalActionExecutionAuthorizationRequestV1Schema.parse({ v: 1, machineId: workflow.machineId,
      envelope, workflowActionOrigin,
      ...(workflowAuthorization ? { executionAuthorization: workflowAuthorization } : {}),
      installationProof: signMachineInstallationProof({ privateKey: workflow.privateKey,
        payload: { version: 1, accountId: publisherAccountId, machineId: workflow.machineId, installationId: workflow.installationId,
          externalActionOrigin: { homeId: input.serverIdentityId!, actionId, requestId: input.requestId,
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope), origin: workflowActionOrigin } } }) });
    const setupApply = actionId === 'machines.setup.apply' ? MachineSetupApplyInputV1Schema.safeParse(input.input) : null;
    if (isDeploymentChildEffectActionIdV1(actionId) || actionId === 'deployments.teardown'
      || actionId === 'deployments.templates.instantiate' || setupApply?.success) {
      // PAT authority never becomes the publisher's Account credential custody.
      if (workflowBinding && !('authentication' in workflowBinding)) return fail('admission_unavailable');
      if (publisherAccountId !== accountId) return fail('requester_credential_disclosure_required');
      if (input.target.kind !== 'machine') return fail('admission_unavailable');
      // A Workflow leaf is not an original own-Account invocation. Mint its
      // exact admitted root, then use the existing requester box; the receiver
      // must never borrow its custodian's ordinary credentials for this origin.
      const proposal = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
      const installed = await readInstalledPublication(input.target.machineId);
      if (!installed?.installationPublicKey || installed.access?.accessState !== 'ready'
        || !await isCurrent()) return fail('admission_unavailable');
      if (installed.access.custodian.accountId !== accountId) return fail('requester_credential_disclosure_required');
      const minted = await phase('mint_authorization', () => mintExternalActionExecutionAuthorization({
        actionId, envelope, machineId: workflow.machineId, pat: input.credentials.token, serverHttpBaseUrl: homeUrl,
        workflowActionOrigin, installationProof: proposal.installationProof,
        ...(workflowAuthorization ? { executionAuthorization: workflowAuthorization } : {}),
        ...(input.authority === 'account_automation' ? { authorityCeiling: 'account_automation' as const } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
      }));
      if (!minted.ok) return { ...fail(minted.code),
        ...(minted.details === undefined ? minted.diagnostic ? { details: minted.diagnostic } : {} : { details: minted.details }),
        ...(minted.failureCause === undefined ? {} : { failureCause: minted.failureCause }) };
      const root = minted.authorization.binding;
      if (!('authentication' in root) || !sameStrictJsonValue(root.authentication, authentication.data)
        || root.accountId !== accountId || root.custodianAccountId !== accountId
        || root.serverIdentityId !== input.serverIdentityId || root.machineId !== input.target.machineId
        || root.installationId !== installed.installationId || root.accountEncryptionMode !== mode.mode
        || !sameStrictJsonValue(root.workflowActionOrigin, workflowActionOrigin)
        || root.sessionActionOrigin || root.sessionActionSource || root.managedContinuation
        || root.handoffContinuation || root.handoffPreflight
        || !isExternalActionAuthorizationBoundToEnvelope(root, { actionId, machineId: input.target.machineId, envelope })
        || !await isCurrent()) return fail('admission_unavailable');
      try {
        const authorization = controllerCodec && material
          ? sealManagedControllerActionCodecV1({ authorization: minted.authorization, material,
            ...(input.invocation ? { invocation: input.invocation } : {}),
            installationPublicKey: decodeBase64(installed.installationPublicKey), randomBytes })
          : sealExternalActionRequesterAccountContextV1({ authorization: minted.authorization,
          credentials: { ...encodeStoredCredentials(input.credentials), token: input.credentials.token },
          purpose: { kind: 'external_action' }, installationPublicKey: decodeBase64(installed.installationPublicKey), randomBytes });
        if (!await isCurrent()) return fail('target_unavailable');
        body = ExternalActionExecutionAuthorizationRequestV1Schema.parse({ v: 1,
          machineId: root.machineId, envelope, executionAuthorization: authorization });
      } catch { return fail('content_unavailable'); }
    }
  } else if (scopedController || machine && access && (foreign || requiresMachineProof)) {
    if (!input.serverIdentityId) return fail('admission_unavailable');
    if (foreign && !controllerCodec && !input.onRequesterSessionCredentialDisclosure) return fail('requester_credential_disclosure_required');
    const readInstalledMachine = async (observed: CurrentAccountMachineInventoryItem) => {
      const isOriginalTarget = input.target.kind === 'machine' && observed.id === input.target.machineId && requiresMachineProof;
      if (isOriginalTarget && installedRead.status === 'rejected') throw installedRead.reason;
      const installed = isOriginalTarget && installedRead.status === 'fulfilled' ? installedRead.value
        : await readInstalledPublication(observed.id);
      if (!installed || installed.access?.accessState !== 'ready'
        || installed.access.custodian.accountId !== observed.access?.custodian.accountId
        || installed.access.resourceMode !== observed.access?.resourceMode || !await isCurrent()) return null;
      return installed;
    };
    const installed = scopedController ?? (machine ? await readInstalledMachine(machine) : null);
    if (!installed) return fail('admission_unavailable');
    const destinationId = scopedController?.machineId ?? machine!.id;
    const custodianAccountId = scopedController?.custodian.accountId ?? access!.custodian.accountId;
    const minted = await phase('mint_authorization', () => mintExternalActionExecutionAuthorization({ actionId, envelope, machineId: destinationId,
      pat: input.credentials.token, serverHttpBaseUrl: homeUrl,
      ...(nativeCredentialSpawnChild ? { nativeCredentialSpawnChild } : {}),
      ...(input.managedContinuation ? { managedContinuation: input.managedContinuation } : {}),
      ...(input.authority === 'account_automation' ? { authorityCeiling: 'account_automation' as const } : {}),
      ...(input.signal ? { signal: input.signal } : {}) }));
    if (!minted.ok) return { ...fail(minted.code),
      ...(minted.details === undefined ? minted.diagnostic ? { details: minted.diagnostic } : {} : { details: minted.details }),
      ...(minted.failureCause === undefined ? {} : { failureCause: minted.failureCause }) };
    const root = minted.authorization.binding;
    if (!('authentication' in root) || root.authentication.kind !== authentication.data.kind
      || root.authentication.tokenEpoch !== authentication.data.tokenEpoch || root.accountId !== accountId
      || root.custodianAccountId !== custodianAccountId || root.serverIdentityId !== input.serverIdentityId
      || root.machineId !== destinationId || root.installationId !== installed.installationId
      || root.accountEncryptionMode !== mode.mode || root.actionId !== actionId || root.requestId !== input.requestId
      || !isExternalActionAuthorizationBoundToEnvelope(root, { actionId, machineId: destinationId, envelope })
      // Acquire's compute projection is bound by the envelope digest above;
      // signed managedAdmission carries only exact-resource recovery scope.
      || actionId !== 'machines.managed.acquire' && !sameStrictJsonValue(root.managedAdmission, managedAdmission)
      || !sameStrictJsonValue(root.nativeCredentialSpawnChild, spawnChild ? {
        requestId: spawnChild.context.externalActionExecutionAuthorization!.binding.requestId,
        requestEnvelopeDigest: spawnChild.context.externalActionExecutionAuthorization!.binding.requestEnvelopeDigest,
      } : undefined)
      || !sameStrictJsonValue(root.approvalDecisionAdmission, actionId === 'approval.request.decide'
        ? projectExternalActionApprovalDecisionAdmissionV1(input.input) : undefined)
      || !externalActionTargetsEqualV1(root.target, input.target)
      || root.sessionActionOrigin || root.sessionActionSource || root.workflowActionOrigin || root.handoffContinuation
      || (input.managedContinuation ? !root.managedContinuation
        || root.managedContinuation.managedId !== input.managedContinuation.managedId
        || root.managedContinuation.creationRequestId !== input.managedContinuation.creationRequestId
        || root.managedContinuation.expectedIntentRevision !== input.managedContinuation.expectedIntentRevision
        : root.managedContinuation !== undefined)
      || !await isCurrent()) return fail('admission_unavailable');
    const confirmDisclosure = async (recipient: Readonly<{ id: string; custodian?: Readonly<{ accountId: string; displayName: string }> }>): Promise<ActionExecuteResult | null> => {
      if (kind === 'account' && input.authority === 'account_automation'
        || input.credentials.credentialProvenance === 'api_token') return fail('requester_account_material_unavailable');
      if (!input.onRequesterSessionCredentialDisclosure) return fail('requester_credential_disclosure_required');
      if (mode.mode === 'plain' && input.credentials.encryption !== null) return fail('content_unavailable');
      let confirmed: boolean | void;
      try {
        confirmed = await input.onRequesterSessionCredentialDisclosure(projectRequesterSessionCredentialDisclosure({
          disposition: 'ordinary_requester', accountId, machineId: recipient.id,
          ...(recipient.custodian ? { custodian: recipient.custodian } : {}),
        }));
      } catch { return fail(input.signal?.aborted ? 'cancelled' : 'requester_credential_disclosure_declined'); }
      if (confirmed !== true) return fail('requester_credential_disclosure_declined');
      return await isCurrent() ? null : fail(input.signal?.aborted ? 'cancelled' : 'target_unavailable');
    };
    let authorization = minted.authorization;
    try {
      if (controllerCodec) {
        if (!installed.installationPublicKey || !material || authorization.managedFiniteWake) return fail('admission_unavailable');
        authorization = sealManagedControllerActionCodecV1({ authorization, material,
          ...(input.invocation ? { invocation: input.invocation } : {}),
          installationPublicKey: decodeBase64(installed.installationPublicKey, scopedController ? 'base64url' : 'base64'), randomBytes });
      } else if (foreign || input.invocation) {
        if (!installed.installationPublicKey) return fail('admission_unavailable');
        if (foreign) {
          const refusal = await confirmDisclosure({ id: machine!.id, custodian: machine!.access?.custodian });
          if (refusal) return refusal;
        }
        authorization = sealExternalActionRequesterAccountContextV1({ authorization,
          credentials: { ...encodeStoredCredentials(input.credentials), token: input.credentials.token }, purpose: { kind: 'external_action' },
          ...(input.invocation ? { invocation: input.invocation } : {}),
          installationPublicKey: decodeBase64(installed.installationPublicKey), randomBytes });
      }
      const wake = authorization.managedFiniteWake;
      if (wake) {
        const wakeController = wake.target.controller;
        if (!wakeController) return fail('admission_unavailable');
        // Home already admitted this exact controller and key. Guest Use need
        // not grant controller inventory access, including delegated enrollment.
        if (wake.requesterCredentialDisclosure) {
          const refusal = await confirmDisclosure({ id: wakeController.machineId, custodian: wake.requesterCredentialDisclosure });
          if (refusal) return refusal;
        }
        authorization = sealExternalActionRequesterAccountContextV1({ authorization,
          credentials: { ...encodeStoredCredentials(input.credentials), token: input.credentials.token }, purpose: { kind: 'managed_finite_wake', target: wake.target },
          installationPublicKey: decodeBase64(wake.installationPublicKey, 'base64url'), randomBytes });
      }
      body = ExternalActionExecutionAuthorizationRequestV1Schema.parse({ v: 1, machineId: destinationId, envelope,
        executionAuthorization: authorization });
    } catch { return fail('content_unavailable'); }
  }
  return await deliverExternalActionRequest({ actionId, serverHttpBaseUrl: homeUrl, body, envelope, headers,
    ...(material ? { material } : {}), ...(binding ? { binding } : {}),
    ...(input.signal ? { signal: input.signal } : {}), isCurrent });
}

/** One response owner for original and installed Workflow Action delivery. */
export async function deliverExternalActionRequest(input: Readonly<{
  actionId: string; serverHttpBaseUrl: string; body: unknown; envelope: ExternalActionRequestEnvelope;
  headers: Readonly<Record<string, string>>; material?: Extract<AccountScopedCryptoMaterial, { type: 'dataKey' }>;
  binding?: ExternalActionEncryptionBindingV2; signal?: AbortSignal; isCurrent(): Promise<boolean>;
}>): Promise<ActionExecuteResult> {
  const fail = (errorCode: string): ActionExecuteFailure => ({ ok: false, errorCode, error: errorCode });
  const isCurrent = input.isCurrent;
  const phase = <T>(name: string, read: () => T | Promise<T>) => runTracedExternalActionInnerStage(`dispatch.${name}`, read);
  input.signal?.throwIfAborted();
  if (!await isCurrent()) return fail('target_unavailable');
  try {
    const response = await phase('delivery', () => axios.post<unknown>(`${input.serverHttpBaseUrl}${EXTERNAL_ACTION_HTTP_PATH_PREFIX_V1}${input.actionId}`, input.body, {
      headers: input.headers, ...(input.signal ? { signal: input.signal } : {}), validateStatus: () => true,
    }));
    // A received operation receipt remains true even when observation retired.
    if (isExternalActionSubmittedUnknownHttpResponse(response.status, response.data)) return fail('outcome_unknown');
    if (response.status < 200 || response.status >= 300) {
      const denied = readActionCredentialScopeDeniedHttpFailureV1(response.status, response.data);
      if (denied) return denied;
      const refusal = ExternalActionHttpErrorSchema.safeParse(response.data);
      if (refusal.success && 'requestId' in refusal.data && refusal.data.requestId !== undefined
        && refusal.data.requestId !== input.envelope.requestId) return fail('invalid_action_output');
      if (refusal.success && 'code' in refusal.data
        && (refusal.data.code === 'action_not_admitted' || refusal.data.code === 'action_outcome_unknown')) {
        return { ...projectUnexpectedActionFailureV1(refusal.data.code === 'action_not_admitted' ? false : null, refusal.data.requestId),
          ...('failureCause' in refusal.data && refusal.data.failureCause !== undefined ? { failureCause: refusal.data.failureCause } : {}),
          ...('diagnostic' in refusal.data ? { details: refusal.data } : {}) };
      }
      if (refusal.success && 'phase' in refusal.data && refusal.data.phase !== undefined) {
        return { ...fail(refusal.data.code), details: refusal.data };
      }
      if (refusal.success && 'code' in refusal.data && refusal.data.code === 'target_unavailable'
        && 'diagnostic' in refusal.data && refusal.data.diagnostic !== undefined) {
        return { ...fail(refusal.data.code), details: refusal.data.diagnostic };
      }
      return fail(refusal.success ? 'code' in refusal.data ? refusal.data.code : refusal.data.error : 'project_transport_unavailable');
    }
    if (input.envelope.v === 2 && input.material && input.binding) return openExternalActionResponseV2({ envelope: response.data,
      binding: input.binding, request: input.envelope, material: input.material }) ?? fail('invalid_action_output');
    const parsed = ExternalActionResponseEnvelopeV1Schema.safeParse(response.data);
    return parsed.success && parsed.data.actionId === input.actionId && parsed.data.requestId === input.envelope.requestId
      ? parsed.data.execution : fail('invalid_action_output');
  } catch { return fail('outcome_unknown'); }
}

export function createExternalActionMachineRpcExecution(input: Readonly<{
  context: ActionExecutorContext | undefined;
  effectActionId: string;
  installationId: string;
  method: string;
  requestId?: string;
  params?: unknown;
  workspaceSyncSourceRouting?: import('@happier-dev/protocol/socketRpc').WorkspaceSyncSourceRoutingV1;
  workspaceSyncSourceWriterTargetRouting?: WorkspaceSyncSourceWriterTargetRoutingV1;
  workspaceSyncSeedRouting?: import('@happier-dev/protocol/socketRpc').WorkspaceSyncSeedRoutingV1;
  deploymentChildRouting?: DeploymentChildRoutingV1;
  deploymentChildExecution?: WorkspaceSyncSourceExecutionV1;
  deploymentArchiveOrigin?: DeploymentArchiveOriginForHost;
  managedAdmission?: ExternalActionMachineRpcExecutionV1['managedAdmission'];
  privateKey: ExternalActionMachineRequestSigningKey;
}>): ExternalActionMachineRpcExecutionV1 | null {
  const authorization = input.context?.externalActionExecutionAuthorization;
  const target = input.context?.externalActionTarget;
  if (!authorization || !target || !input.requestId) return null;
  const effectActionId = ExternalActionActionIdV1Schema.parse(input.effectActionId);
  const admittedChild = readHostAdmittedReviewedChildV1(input.context);
  const reviewedChild = admittedChild?.actionId === effectActionId
    ? { actionId: admittedChild.actionId, role: admittedChild.role, inputDigest: admittedChild.inputDigest,
      ...(admittedChild.deploymentNativeAdmission ? { deploymentNativeAdmission: admittedChild.deploymentNativeAdmission } : {}) } : undefined;
  return {
    v: 1,
    authorization,
    effectActionId,
    target,
    installationId: input.installationId,
    ...(reviewedChild ? { reviewedChild } : {}),
    ...(input.managedAdmission ? { managedAdmission: input.managedAdmission } : {}),
    ...(input.deploymentChildRouting ? { deploymentChildRouting: input.deploymentChildRouting } : {}),
    ...(input.deploymentChildExecution ? { deploymentChildExecution: createDeploymentChildExecutionProofV1(input.deploymentChildExecution, input.deploymentArchiveOrigin) } : {}),
    machineSignature: signExternalActionMachineRpcRequestV1({
      authorizationToken: authorization.token,
      requesterAccountContext: authorization.requesterAccountContext,
      effectActionId,
      target,
      installationId: input.installationId,
      ...(reviewedChild ? { reviewedChild } : {}),
      event: SOCKET_RPC_EVENTS.CALL,
      method: input.method,
      requestId: input.requestId,
      ...(input.params === undefined ? {} : { params: input.params }),
      ...(input.managedAdmission ? { managedAdmission: input.managedAdmission } : {}),
      ...(input.workspaceSyncSourceRouting ? { workspaceSyncSourceRouting: input.workspaceSyncSourceRouting } : {}),
      ...(input.workspaceSyncSourceWriterTargetRouting ? { workspaceSyncSourceWriterTargetRouting: input.workspaceSyncSourceWriterTargetRouting } : {}),
      ...(input.workspaceSyncSeedRouting ? { workspaceSyncSeedRouting: input.workspaceSyncSeedRouting } : {}),
      ...(input.deploymentChildRouting ? { deploymentChildRouting: input.deploymentChildRouting } : {}),
      ...(input.deploymentChildExecution ? { deploymentChildExecution: input.deploymentChildExecution } : {}),
      ...(input.deploymentArchiveOrigin ? { deploymentArchiveOrigin: input.deploymentArchiveOrigin } : {}),
      privateKey: input.privateKey,
    }),
  };
}

/**
 * Original Session, exact handoff custody or the reviewed Move SOURCE may forward its Home-admitted request.
 * This uses the source key, while the signed bytes still name the actual
 * destination installation. It is never a destination-signature fallback.
 */
export function readExternalActionSourceMachineRpcSigner(
  authorization: ExternalActionExecutionAuthorizationV1,
): Readonly<{ machineId: string; installationId: string }> | null {
  const parsed = ExternalActionExecutionAuthorizationV1Schema.safeParse(authorization);
  if (!parsed.success) return null;
  const binding = parsed.data.binding;
  if ((binding.actionId === 'session.spawn_new' || binding.actionId === 'projects.service.relocate' || binding.actionId === 'discussion.second_opinion.start'
    || isSessionStopChildRootV1(binding.actionId) || (binding.deploymentChildRoot === true)
    || isMachineSetupPlanRpcChildV1({ rootActionId: binding.actionId, effectActionId: 'machines.setup.plan', method: RPC_METHODS.MACHINE_SETUP_PLAN })) && binding.target.kind === 'machine'
    && binding.target.machineId === binding.machineId) return { machineId: binding.machineId, installationId: binding.installationId };
  if ('authentication' in binding && binding.sessionActionOrigin && binding.sessionActionSource) {
    return binding.sessionActionSource;
  }
  const admission = binding.handoffAdmission;
  if (!(binding.handoffContinuation || binding.handoffPreflight) || !admission
    || !(binding.machineId === admission.sourceMachineId && binding.installationId === admission.sourceInstallationId
      || binding.machineId === admission.targetMachineId && binding.installationId === admission.targetInstallationId)) return null;
  return { machineId: admission.sourceMachineId, installationId: admission.sourceInstallationId };
}

export function createExternalActionSourceMachineRpcExecution(input: Readonly<{
  context?: ActionExecutorContext;
  authorization: ExternalActionExecutionAuthorizationV1;
  effectActionId: string;
  target: ExternalActionTargetV1;
  sourceMachineId: string;
  sourceInstallationId: string;
  method: string;
  requestId?: string;
  params?: unknown;
  deploymentChildRouting?: DeploymentChildRoutingV1;
  managedAdmission?: ExternalActionMachineRpcExecutionV1['managedAdmission'];
  privateKey: ExternalActionMachineRequestSigningKey;
}>): ExternalActionMachineRpcExecutionV1 | null {
  const parsed = ExternalActionExecutionAuthorizationV1Schema.safeParse(input.authorization);
  if (!parsed.success) return null;
  const binding = parsed.data.binding;
  const source = readExternalActionSourceMachineRpcSigner(parsed.data);
  const stopChild = isSessionStopChildV1({ rootActionId: binding.actionId,
    effectActionId: input.effectActionId, method: input.method.slice(input.method.indexOf(':') + 1),
    target: input.target, params: input.params });
  const deploymentChild = input.deploymentChildRouting;
  const setupPlanRoot = isMachineSetupPlanRpcChildV1({ rootActionId: binding.actionId,
    effectActionId: 'machines.setup.plan', method: RPC_METHODS.MACHINE_SETUP_PLAN });
  const setupPlanChild = isMachineSetupPlanRpcChildV1({ rootActionId: binding.actionId,
    effectActionId: input.effectActionId, method: input.method.slice(input.method.indexOf(':') + 1) });
  const nativeCredentialChild = readSessionSpawnNativeCredentialChildV1({ rootActionId: binding.actionId,
    effectActionId: input.effectActionId, method: input.method.slice(input.method.indexOf(':') + 1),
    managedAdmission: input.managedAdmission, params: input.params });
  const readinessProof = readHostAdmittedReviewedChildV1(input.context) ?? undefined;
  const readinessChild = readSessionAgentReadinessChildActionV1(binding, readinessProof,
    { machineId: input.sourceMachineId, installationId: input.sourceInstallationId });
  const signedReadinessChild = readinessChild === input.effectActionId
    && resolveMachineRpcExternalActionEffectV1(input.method.slice(input.method.indexOf(':') + 1), binding,
      { machineId: input.sourceMachineId, installationId: input.sourceInstallationId }, readinessProof) === readinessChild;
  if (!source || source.machineId !== input.sourceMachineId
    || source.installationId !== input.sourceInstallationId
    || binding.actionId === 'session.spawn_new' && !nativeCredentialChild && !signedReadinessChild
    || isSessionStopChildRootV1(binding.actionId) && !stopChild
    || setupPlanRoot && !setupPlanChild && (input.effectActionId !== binding.actionId
      || input.method !== `${binding.machineId}:${binding.actionId}`)
    || !stopChild && (input.target.kind !== 'machine' || binding.machineId !== input.target.machineId
      || !externalActionTargetsEqualV1(binding.target, input.target))
    || binding.actionId === 'projects.service.relocate'
      && readProjectServiceMoveChildEffectV1(input.method.slice(input.method.indexOf(':') + 1)) !== input.effectActionId
    || binding.actionId === 'discussion.second_opinion.start'
      && (input.effectActionId !== 'session.spawn_new' || !isDiscussionSecondOpinionModelRpcMethodV1(input.method.slice(input.method.indexOf(':') + 1)))
    || (binding.deploymentChildRoot === true) && (!deploymentChild
      || deploymentChild.actionId !== deploymentChildEffectActionIdForRootV1(binding.actionId, binding.deploymentPreparationAdmission, deploymentChild.actionId)
      || input.effectActionId !== deploymentChild.actionId
      || input.method !== `${deploymentChild.machineId}:${RPC_METHODS.DAEMON_DEPLOYMENT_CHILD}`)
    || binding.actionId !== 'projects.service.relocate' && binding.actionId !== 'discussion.second_opinion.start' && !stopChild && !deploymentChild && !nativeCredentialChild && !setupPlanChild
      && !input.method.startsWith(`${binding.machineId}:`)) return null;
  return createExternalActionMachineRpcExecution({
    context: { ...input.context, surface: 'rpc', externalActionExecutionAuthorization: input.authorization, externalActionTarget: input.target },
    effectActionId: input.effectActionId,
    installationId: binding.installationId,
    method: input.method,
    ...(input.requestId ? { requestId: input.requestId } : {}),
    ...(input.params === undefined ? {} : { params: input.params }),
    ...(deploymentChild ? { deploymentChildRouting: deploymentChild } : {}),
    ...(input.managedAdmission ? { managedAdmission: input.managedAdmission } : {}),
    privateKey: input.privateKey,
  });
}

export function createExternalActionAuthorizedRequestHeaders(input: Readonly<{
  authorization: ExternalActionExecutionAuthorizationV1;
  effectActionId: string;
  target: ExternalActionTargetV1;
  installationId: string;
  method: string;
  path: string;
  body?: unknown;
  idempotencyKey?: string;
  reviewedChild?: ReviewedActionChildHttpProofV1;
  deploymentChildExecution?: WorkspaceSyncSourceExecutionV1;
  deploymentArchiveOrigin?: DeploymentArchiveOriginForHost;
  deploymentNativeIncumbentSource?: import('@happier-dev/protocol/actions/externalActionExecutionAuthorization').DeploymentChildExecutionProofV1['nativeIncumbentSource'];
  privateKey: ExternalActionMachineRequestSigningKey;
}>): RequesterAccountAuthorizationHeaders {
  const mode = input.authorization.requesterAccountProjection?.accountEncryptionMode
    ?? input.authorization.binding.accountEncryptionMode;
  return {
    ...(mode === undefined ? {} : { [requesterAccountEncryptionMode]: mode }),
    ...(input.idempotencyKey === undefined ? {} : { 'Idempotency-Key': input.idempotencyKey }),
    [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: input.authorization.token,
    [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: input.effectActionId,
    [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(input.target),
    ...(input.reviewedChild ? { [EXTERNAL_ACTION_REVIEWED_CHILD_HEADER]: encodeReviewedActionChildHttpProofV1(input.reviewedChild) } : {}),
    ...(input.deploymentChildExecution ? { [EXTERNAL_ACTION_DEPLOYMENT_CHILD_EXECUTION_HEADER]:
      encodeDeploymentChildExecutionV1(input.deploymentChildExecution, input.deploymentArchiveOrigin, input.deploymentNativeIncumbentSource) } : {}),
    [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({
      authorizationToken: input.authorization.token,
      effectActionId: input.effectActionId,
      target: input.target,
      installationId: input.installationId,
      requestId: input.authorization.binding.requestId,
      method: input.method,
      path: input.path,
      ...(input.body === undefined ? {} : { body: input.body }),
      ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
      ...(input.reviewedChild ? { reviewedChild: input.reviewedChild } : {}),
      ...(input.deploymentChildExecution ? { deploymentChildExecution: input.deploymentChildExecution } : {}),
      ...(input.deploymentArchiveOrigin ? { deploymentArchiveOrigin: input.deploymentArchiveOrigin } : {}),
      ...(input.deploymentNativeIncumbentSource ? { deploymentNativeIncumbentSource: input.deploymentNativeIncumbentSource } : {}),
      privateKey: input.privateKey,
    }),
  };
}

/** Attach HTTP-only requester ports to the incumbent, Home-proved carrier. */
export async function projectExternalActionRequesterHttpAuthorization(input: Readonly<{
  authorization: ExternalActionExecutionAuthorizationV1;
  serverId: string;
  serverIdentityId: string;
  serverHttpBaseUrl: string;
  target: ExternalActionTargetV1;
  installationId: string;
  privateKey: ExternalActionMachineRequestSigningKey;
  isCurrent?: () => Promise<boolean>;
  /** The calling ingress already spent Home admission on this exact root. */
  rootAdmitted?: true;
  /** Exact child ingress already rechecks the retained SOURCE packet at Home. */
  forwardedMove?: Readonly<{ credentials: StoredCredentials; isCurrent(): Promise<boolean> }>;
  /** Present only after exact installed child ingress and its sealed purpose were admitted. */
  forwardedDeploymentChild?: DeploymentChildRpcV1;
  deploymentChildExecution?: WorkspaceSyncSourceExecutionV1;
  signal?: AbortSignal;
}>): Promise<ExternalActionExecutionAuthorizationV1 | null> {
  const parsed = ExternalActionExecutionAuthorizationV1Schema.safeParse(input.authorization);
  if (!parsed.success || parsed.data.binding.serverIdentityId !== input.serverIdentityId
    || (parsed.data.binding.installationId !== input.installationId && !input.forwardedMove)
    || input.forwardedMove && parsed.data.binding.actionId !== 'projects.service.relocate'
      && parsed.data.binding.actionId !== 'discussion.second_opinion.start'
      && !isSessionStopChildRootV1(parsed.data.binding.actionId)
      && !isMachineSetupPlanRpcChildV1({ rootActionId: parsed.data.binding.actionId,
        effectActionId: 'machines.setup.plan', method: RPC_METHODS.MACHINE_SETUP_PLAN })
      && !input.forwardedDeploymentChild
    || !input.serverId || !input.serverHttpBaseUrl) return null;
  const authorization: ExternalActionExecutionAuthorizationV1 = { ...parsed.data };
  const requesterAccountProjection = input.authorization.requesterAccountProjection;
  const requesterContext = readRequesterAccountActionContext(input.authorization);
  if (requesterContext && (requesterContext.authorization.token !== authorization.token
    || !sameStrictJsonValue(requesterContext.authorization.binding, authorization.binding))) return null;
  const admittedCustody = requesterContext?.isCustodyCurrent;
  const nativePreparationReadCustody = authorization.binding.actionId === 'projects.service.relocate'
    || authorization.binding.actionId === 'discussion.second_opinion.start'
    || isSessionStopChildRootV1(authorization.binding.actionId)
    || authorization.binding.actionId === 'execution.run.start'
    || authorization.binding.actionId === 'execution.run.ensure'
    || authorization.binding.actionId === 'execution.run.send'
    || authorization.binding.actionId === 'execution.run.ensure_or_start'
    || isScmDiffSummaryRunAction(authorization.binding.actionId)
    ? input.forwardedMove ?? (requesterContext ? {
      credentials: requesterContext.credentials,
      isCurrent: () => requesterContext.isCustodyCurrent
        ? requesterContext.isCustodyCurrent() : requesterContext.isCurrent(),
    } : undefined) : undefined;
  const projectMachineReadCustody = authorization.binding.actionId === 'projects.script.run'
    || authorization.binding.actionId === 'projects.compute.exec'
    || authorization.binding.actionId === 'localServices.launcher.start'
    || authorization.binding.actionId === 'projects.worker.status' ? requesterContext : undefined;
  const projectRowReadCustody = Object.hasOwn(PROJECT_FINITE_ACTION_RPC_METHODS_V1, authorization.binding.actionId)
    || isProjectWorkspaceSyncPreparationActionV1(authorization.binding.actionId)
    || isMachineTerminalOpenOrRestartActionIdV1(authorization.binding.actionId)
    || authorization.binding.actionId === 'projects.inspect'
    || authorization.binding.actionId === 'projects.worker.status'
    || authorization.binding.actionId === 'projects.execution.output.read'
    || authorization.binding.actionId === 'projects.execution.output.copy' ? requesterContext : undefined;
  if (requesterAccountProjection && (requesterAccountProjection.accountId !== authorization.binding.accountId
    || requesterAccountProjection.serverId !== input.serverId)) return null;
  const locallyCurrent = async (signal?: AbortSignal): Promise<boolean> => {
    const refused = (branch: RequesterCurrentnessRefusalBranch) => { recordRequesterCurrentnessRefusal(branch); return false; };
    try {
      if (input.signal?.aborted || signal?.aborted) return refused('local_abort_signal');
      // Installed custody supplies the Account projection's exact function as
      // its local guard. Read it once here; a distinct Machine guard still runs.
      const current = input.isCurrent && input.isCurrent !== requesterAccountProjection?.isCurrent
        ? await input.isCurrent() : true;
      if (!current) return refused('installation_custody');
      if (input.signal?.aborted || signal?.aborted) return refused('local_abort_signal');
      const accountCurrent = !requesterAccountProjection
        || await requesterAccountProjection.isCurrent();
      if (!accountCurrent) return refused('observed_account_encryption_currentness');
      return !input.signal?.aborted && !signal?.aborted || refused('local_abort_signal');
    } catch (error) {
      refuseExternalActionPhase('requester_http_local_currentness', authorization.binding.machineId, error);
      rethrowRequesterHomeReadFailure(error);
      return recordRequesterCurrentnessRefusal('currentness_exception');
    }
  };
  const verifyCurrent = async (signal?: AbortSignal): Promise<boolean> => {
    if (!await locallyCurrent(signal)) return false;
    if (input.forwardedMove) return await input.forwardedMove.isCurrent() && await locallyCurrent(signal);
    const current = await verifyExternalActionExecutionAuthorizationCurrent({
      authorization,
      effectActionId: authorization.binding.actionId,
      target: input.target,
      installationId: input.installationId,
      privateKey: input.privateKey,
      serverHttpBaseUrl: input.serverHttpBaseUrl,
      ...(signal ?? input.signal ? { signal: signal ?? input.signal } : {}),
    });
    return current && await locallyCurrent(signal);
  };
  // Rebuilding HTTP ports over an admitted root is the same authority decision.
  // A wire-only carrier spends one Home proof here; finite work then stays local
  // and the next signed request re-admits. A forwarded child keeps its receiver proof.
  const admitted = Boolean(admittedCustody || input.rootAdmitted);
  if (!await (admitted ? locallyCurrent() : verifyCurrent())) return null;
  const isCurrent = input.forwardedMove && !admitted ? verifyCurrent : locallyCurrent;
  if (requesterAccountProjection) {
    Object.defineProperty(authorization, 'requesterAccountProjection', {
      value: requesterAccountProjection, enumerable: false,
    });
  }
  if (input.authorization.requesterAccountExecutor) {
    Object.defineProperty(authorization, 'requesterAccountExecutor', {
      value: input.authorization.requesterAccountExecutor, enumerable: false,
    });
  }
  const requesterHttpProjection: ExternalActionRequesterHttpProjectionV1 = {
    accountId: authorization.binding.accountId,
    serverId: input.serverId,
    serverIdentityId: input.serverIdentityId,
    serverHttpBaseUrl: input.serverHttpBaseUrl,
    ...(authorization.binding.accountEncryptionMode
      ? { accountEncryptionMode: authorization.binding.accountEncryptionMode } : {}),
    isCurrent,
    createRequestHeaders: async (request) => {
      if (request.nativeIncumbentSource && (input.forwardedDeploymentChild?.kind !== 'review'
        || request.method !== 'GET' || request.body !== undefined)) return null;
      if (input.forwardedDeploymentChild) {
        const child = input.forwardedDeploymentChild;
        const packet = input.deploymentChildExecution;
        const domainController = child.kind === 'domain' && input.installationId === authorization.binding.installationId;
        const childReceiver = input.forwardedMove && child.installationId === input.installationId;
        if ((!domainController && !childReceiver) || !packet || child.actionId !== deploymentChildEffectActionIdForRootV1(
          authorization.binding.actionId, authorization.binding.deploymentPreparationAdmission, child.actionId)
          || request.effectActionId !== child.actionId) return null;
        // Home's child-purpose owner admits or refuses this exact address. The
        // backing Account custody is content material only: every scoped root
        // keeps its original grant in the signed child HTTP proof.
        // The retained packet already binds its review; no second root proof is needed.
        return await locallyCurrent(request.signal) ? createExternalActionAuthorizedRequestHeaders({
          authorization, effectActionId: child.actionId, target: input.target, installationId: input.installationId,
          privateKey: input.privateKey, method: request.method, path: request.path, body: request.body,
          deploymentChildExecution: packet,
          ...(request.nativeIncumbentSource ? { deploymentNativeIncumbentSource: request.nativeIncumbentSource } : {}),
        }) : null;
      }
      if (input.forwardedMove && isSessionStopChildRootV1(authorization.binding.actionId)
        && request.effectActionId !== 'session.stop') return null;
      // Topology is private Account data, not authority conferred by a Project
      // execution root. Spend only its exact, still-current requester read port.
      if (projectRowReadCustody && request.effectActionId === authorization.binding.actionId
        && request.method === 'POST' && (request.path === '/v1/account/project-rows/read'
          || request.path === '/v1/account/project-rows/list')) {
        return await (projectRowReadCustody.isCustodyCurrent ?? projectRowReadCustody.isCurrent)() && await isCurrent(request.signal)
          ? { Authorization: `Bearer ${projectRowReadCustody.credentials.token}` } : null;
      }
      // A worker-bound execution/service/status root cannot read SOURCE/controller Machine
      // content. Passive inspection and Sync topology use the same captured
      // requester read custody as Service Move; native effects keep their root.
      if (projectMachineReadCustody && request.effectActionId === authorization.binding.actionId
        && request.method === 'GET' && /^\/v1\/machines\/[^/]+$/u.test(request.path)
        && request.path !== `/v1/machines/${encodeURIComponent(authorization.binding.machineId)}`) {
        return await (projectMachineReadCustody.isCustodyCurrent ?? projectMachineReadCustody.isCurrent)() && await isCurrent(request.signal)
          ? { Authorization: `Bearer ${projectMachineReadCustody.credentials.token}` } : null;
      }
      if (nativePreparationReadCustody && (authorization.binding.actionId === 'projects.service.relocate'
        || authorization.binding.actionId === 'discussion.second_opinion.start' && request.effectActionId === 'session.spawn_new'
        || isSessionStopChildRootV1(authorization.binding.actionId) && request.effectActionId === 'session.stop'
        || request.effectActionId === authorization.binding.actionId)) {
        // Native preparation consumes its original requester's private Account
        // read ports, as SOURCE Sync does. No bearer is put on the RPC carrier.
        const stopChildRead = isSessionStopChildRootV1(authorization.binding.actionId);
        const read = stopChildRead ? request.effectActionId === 'session.stop' && request.method === 'GET'
          && (request.path === '/v1/account/encryption' || request.path === '/v1/account/encryption/currentness'
            || input.target.kind === 'session' && (request.path === `/v2/sessions/${encodeURIComponent(input.target.sessionId)}`
              || request.path === `/v2/sessions/${encodeURIComponent(input.target.sessionId)}?accessProjectionVersion=1`))
          : request.method === 'GET' && (request.path === '/v1/account/encryption'
            || /^\/v1\/machines\/[^/]+$/u.test(request.path))
          || request.method === 'POST' && ['/v1/account/project-rows/read', '/v1/account/project-rows/list',
            '/v1/account/project-trust/read', '/v1/account/project-trust/list', '/v1/projects/execution/config/read'].includes(request.path);
        if (read) return await nativePreparationReadCustody.isCurrent() && await isCurrent(request.signal)
          ? { Authorization: `Bearer ${nativePreparationReadCustody.credentials.token}` } : null;
        // SOURCE-owned placement writes retain their incumbent signed root;
        // a forwarded recipient never receives a general write port.
        if (input.forwardedMove) return null;
      }
      // Signing is synchronous and has no external effect. Check custody once
      // before releasing the headers; the destination admits the signed effect.
      const headers = createExternalActionAuthorizedRequestHeaders({
        authorization, effectActionId: request.effectActionId, target: input.target,
        installationId: input.installationId, privateKey: input.privateKey,
        method: request.method, path: request.path,
        ...(request.reviewedChild ? { reviewedChild: request.reviewedChild } : {}),
        ...(authorization.binding.actionId === 'workflow.trigger.run_now' && request.effectActionId === authorization.binding.actionId
          ? { idempotencyKey: authorization.binding.idempotencyKey } : {}),
        ...(request.body === undefined ? {} : { body: request.body }),
      });
      // An admitted installed invocation already proved the root. The HTTP
      // destination verifies this exact signed effect, including grant/epoch.
      // Keep observed encryption and installation custody here; native effects
      // consume the private context of this admitted invocation.
      return await isCurrent(request.signal) ? headers : null;
    },
  };
  Object.defineProperty(authorization, 'requesterHttpProjection', {
    value: Object.freeze(requesterHttpProjection), enumerable: false,
  });
  return Object.freeze(authorization);
}

/** Prepare an original Account invocation; only Home's minted binding admits it. */
export async function prepareExternalActionRequesterAccountAuthorizationResult(input: Readonly<{
  actionId: string;
  input: unknown;
  requestId: string;
  target: ExternalActionTargetV1;
  machineId: string;
  /** Account id and mode obtained from this authenticated Home's profile. */
  accountId: string;
  accountEncryptionMode: 'plain' | 'e2ee';
  /** Unverified associated-data candidate, never an authentication decision. */
  tokenEpochHint: number;
  token: string;
  /** Only the incumbent authenticated Session host supplies this origin. */
  sessionActionOrigin?: ExternalActionExecutionAuthorizationRequestV1['sessionActionOrigin'];
  workflowActionOrigin?: ExternalActionExecutionAuthorizationRequestV1['workflowActionOrigin'];
  executionAuthorization?: ExternalActionExecutionAuthorizationV1;
  /** Per-invocation envelope codec, never Account material. */
  controllerCodecMaterial?: Extract<AccountScopedCryptoMaterial, { type: 'dataKey' }>;
  /** Exact incumbent Session host, independently of the destination Machine. */
  sourceMachineId?: string;
  /** Accepted managed Session work rechecks current origin policy, not an ended turn. */
  isContinuationCurrent?: (authorization: ExternalActionExecutionAuthorizationV1) => Promise<boolean>;
  material?: Extract<AccountScopedCryptoMaterial, Readonly<{ type: 'dataKey' }>>;
  serverId: string;
  serverIdentityId: string;
  serverHttpBaseUrl: string;
  onRefused?: (code: string) => void;
  isCurrent?: () => Promise<boolean>;
  signal?: AbortSignal;
  installationId: string;
  privateKey: ExternalActionMachineRequestSigningKey;
}>):
Promise<Readonly<{ authorization: ExternalActionExecutionAuthorizationV1; envelope: ExternalActionRequestEnvelope }> | ExternalActionIssuerRefusal> {
  const refused = (phase: ExternalActionIssuerRefusal['phase'], requiredFact: string): ExternalActionIssuerRefusal =>
    ({ ok: false, phase, requiredFact });
  const isCurrent = async (): Promise<boolean> => {
    try {
      if (input.signal?.aborted) return false;
      const current = input.isCurrent ? await input.isCurrent() : true;
      return current && !input.signal?.aborted;
    } catch (error) { refuseExternalActionPhase('original_request_currentness', input.machineId, error); return false; }
  };
  // Envelope construction below is synchronous and has no external effect.
  // Check custody once immediately before minting, then again after Home replies.
  if (input.signal?.aborted) return refused('preparation', 'active_session_action');
  let actionId: string;
  let requesterIdentity: ExternalActionExecutionAuthorizationV1['binding'] | Readonly<{ authentication: ExternalActionSignedAuthenticationV1 }>;
  let publisherAccountId: string;
  let envelope: ExternalActionRequestEnvelope;
  let pendingResetStartAdmission: ExternalActionExecutionAuthorizationV1['binding']['pendingResetStartAdmission'];
  let approvalDecisionAdmission: ExternalActionExecutionAuthorizationV1['binding']['approvalDecisionAdmission'];
  let sessionActionOrigin: ExternalActionExecutionAuthorizationRequestV1['sessionActionOrigin'];
  try {
    actionId = ExternalActionActionIdV1Schema.parse(input.actionId);
    pendingResetStartAdmission = actionId === 'session.pending.resetStart.set'
      ? projectExternalActionPendingResetStartAdmissionV1(input.input) : undefined;
    approvalDecisionAdmission = actionId === 'approval.request.decide'
      ? projectExternalActionApprovalDecisionAdmissionV1(input.input) : undefined;
    sessionActionOrigin = input.sessionActionOrigin === undefined ? undefined
      : SessionActionRpcOriginV1Schema.parse(input.sessionActionOrigin);
    if (sessionActionOrigin && sessionActionOrigin.requestId !== input.requestId) return refused('preparation', 'session_request_identity');
    if (sessionActionOrigin && !input.sourceMachineId?.trim()) return refused('preparation', 'session_source_machine');
    // Installed Session proposals still use released paired Home credentials.
    // This is only an associated-data candidate: Home verifies the credential,
    // current Session and installation proof before issuing any authorization.
    // Original headless requests retain their structured-provenance requirement.
    const provenance = readAuthTokenProvenance(decodeJwtPayload(input.token), {
      allowLegacyHome: sessionActionOrigin !== undefined || input.workflowActionOrigin !== undefined,
    });
    let authenticationKind: 'account' | 'terminal';
    if (provenance?.provenance.kind === 'account' && provenance.provenance.authority === 'present_user') authenticationKind = 'account';
    else if (provenance?.provenance.kind === 'terminal' && provenance.provenance.authority === 'account_automation') authenticationKind = 'terminal';
    else return refused('preparation', 'requester_credential_provenance');
    const publisher = readAccountIdFromToken(input.token);
    if (!publisher) return refused('preparation', 'requester_credential_provenance');
    publisherAccountId = publisher;
    // Home retains the admitted parent's identity; the installed transport
    // authenticates delivery without replacing that signed provenance.
    const parentBinding = input.executionAuthorization?.binding;
    if (parentBinding && !('authentication' in parentBinding)) {
      if (sessionActionOrigin || !input.workflowActionOrigin || !isReviewedMachineSetupCodecV1({
        actionId, workflowActionOrigin: input.workflowActionOrigin,
      })) return refused('preparation', 'workflow_requester_identity');
      requesterIdentity = parentBinding;
    } else {
      const authentication = ExternalActionSignedAuthenticationV1Schema.parse(parentBinding?.authentication
        ?? { kind: authenticationKind, tokenEpoch: input.tokenEpochHint,
          ...('evidence' in provenance.provenance ? { evidence: provenance.provenance.evidence } : {}) });
      if (!Number.isSafeInteger(authentication.tokenEpoch)) return refused('preparation', 'requester_token_epoch');
      requesterIdentity = { authentication };
    }
    if (input.accountEncryptionMode === 'e2ee') {
      if (!input.material) return refused('preparation', 'account_encryption_material');
      envelope = sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1,
        binding: { serverIdentityId: input.serverIdentityId, accountId: input.accountId,
          ...('authentication' in requesterIdentity ? { authentication: {
            kind: requesterIdentity.authentication.kind, tokenEpoch: requesterIdentity.authentication.tokenEpoch,
          } } : { credentialId: requesterIdentity.credentialId }),
          actionId, requestId: input.requestId, target: input.target },
        input: input.input, material: input.material, randomBytes,
        // Setup-bearing Session authoring also binds the public setup presence;
        // ordinary Session authoring still inherits launch choices at agent start.
        ...(actionId === SESSION_SPAWN_NEW_ACTION_ID_V1 && (!sessionActionOrigin
          || input.input !== null && typeof input.input === 'object' && 'machineSetupPlanInput' in input.input
            && input.input.machineSetupPlanInput !== undefined)
          ? { sessionSpawnAdmission: projectApiTokenSessionSpawnAdmissionV1(admitSessionSpawnNewActionInputV2(SessionSpawnNewActionInputV2Schema.parse(input.input))) }
          : {}),
      });
    } else {
      const idempotencyKey = projectExternalActionRunNowIdempotencyKeyV1(actionId, input.input);
      envelope = ExternalActionRequestEnvelopeSchema.parse({
        v: 1, requestId: input.requestId, target: input.target, input: input.input,
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      });
    }
  } catch (error) { refuseExternalActionPhase('original_request_projection', input.machineId, error); return refused('preparation', 'original_request_envelope'); }
  if (!await isCurrent()) return refused('preparation', 'active_session_action');
  const minted = await mintExternalActionExecutionAuthorization({
    actionId, envelope, machineId: input.machineId, pat: input.token,
    serverHttpBaseUrl: input.serverHttpBaseUrl,
    ...(sessionActionOrigin ? { sessionActionOrigin,
      sessionActionSource: { machineId: input.sourceMachineId!, installationId: input.installationId },
      installationProof: signMachineInstallationProof({
      payload: { version: 1, machineId: input.sourceMachineId!, installationId: input.installationId, accountId: input.accountId,
        externalActionOrigin: { homeId: input.serverIdentityId, actionId, requestId: input.requestId,
          requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope), origin: sessionActionOrigin } },
      privateKey: input.privateKey,
    }) } : {}),
    ...(input.executionAuthorization ? { executionAuthorization: input.executionAuthorization } : {}),
    ...(input.workflowActionOrigin ? { workflowActionOrigin: input.workflowActionOrigin,
      installationProof: signMachineInstallationProof({
        payload: { version: 1, machineId: input.machineId, installationId: input.installationId, accountId: publisherAccountId,
          externalActionOrigin: { homeId: input.serverIdentityId, actionId, requestId: input.requestId,
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope), origin: input.workflowActionOrigin } },
        privateKey: input.privateKey,
      }) } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  });
  if (!minted.ok) {
    input.onRefused?.(minted.code);
    if (!input.signal?.aborted && minted.retryable) {
      rethrowRequesterHomeReadFailure({ ok: false, errorCode: 'server_unreachable' });
    }
    return { ...refused('mint', 'home_minted_authorization'), code: minted.code,
      ...(minted.details === undefined ? {} : { details: minted.details }),
      ...(minted.failureCause ? { failureCause: minted.failureCause } : {}) };
  }
  if (!await isCurrent()) return refused('binding', 'active_session_action');
  const binding = minted.authorization.binding;
  if (binding.accountId !== input.accountId
    || input.executionAuthorization && binding.custodianAccountId !== input.executionAuthorization.binding.custodianAccountId
    || ('authentication' in requesterIdentity
      ? !('authentication' in binding) || !sameStrictJsonValue(binding.authentication, requesterIdentity.authentication)
      : 'authentication' in binding || binding.principalId !== requesterIdentity.principalId
        || binding.credentialId !== requesterIdentity.credentialId || !sameStrictJsonValue(binding.grant, requesterIdentity.grant))
    || binding.accountEncryptionMode !== input.accountEncryptionMode
    || binding.serverIdentityId !== input.serverIdentityId
    || (!sessionActionOrigin || input.sourceMachineId === input.machineId) && binding.installationId !== input.installationId
    || binding.machineId !== input.machineId
    || binding.actionId !== actionId
    || binding.requestId !== input.requestId
    || !isExternalActionAuthorizationBoundToEnvelope(binding, { actionId, machineId: input.machineId, envelope })
    || !sameStrictJsonValue(binding.pendingResetStartAdmission, pendingResetStartAdmission)
    || !sameStrictJsonValue(binding.approvalDecisionAdmission, approvalDecisionAdmission)
    || !sameStrictJsonValue(binding.sessionActionOrigin, sessionActionOrigin)
    || !sameStrictJsonValue(binding.workflowActionOrigin, input.workflowActionOrigin)
    || !sameStrictJsonValue(binding.sessionActionSource, sessionActionOrigin
      ? { machineId: input.sourceMachineId, installationId: input.installationId } : undefined)
    || !externalActionTargetsEqualV1(binding.target, input.target)) return refused('binding', 'home_authorization_binding');
  // The destination daemon owns HTTP effect signatures. A remote source only
  // forwards the same Home proof; it must not impersonate the destination signer.
  if (sessionActionOrigin && input.sourceMachineId !== input.machineId)
    return { authorization: Object.freeze(minted.authorization), envelope };
  const continuationChecker = input.isContinuationCurrent;
  const continuationCurrent = sessionActionOrigin && continuationChecker
    ? async () => await continuationChecker(minted.authorization)
    : isCurrent;
  const carried = input.controllerCodecMaterial ? sealManagedControllerActionCodecV1({
    authorization: minted.authorization, material: input.controllerCodecMaterial,
    installationPublicKey: deriveEd25519KeyPair((typeof input.privateKey === 'string'
      ? decodeBase64(input.privateKey, 'base64url') : input.privateKey).slice(0, ED25519_PUBLIC_KEY_BYTES)).publicKey,
    randomBytes,
  }) : minted.authorization;
  const authorization = await projectExternalActionRequesterHttpAuthorization({
    authorization: carried,
    serverId: input.serverId, serverIdentityId: input.serverIdentityId,
    serverHttpBaseUrl: input.serverHttpBaseUrl, target: input.target,
    installationId: input.installationId, privateKey: input.privateKey, isCurrent: continuationCurrent,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  return authorization ? { authorization, envelope } : refused('binding', 'signed_requester_projection');
}

/** Existing nullable consumers project the same issuer decision without re-evaluating it. */
export async function prepareExternalActionRequesterAccountAuthorizationWithEnvelope(
  input: Parameters<typeof prepareExternalActionRequesterAccountAuthorizationResult>[0],
): Promise<Readonly<{ authorization: ExternalActionExecutionAuthorizationV1; envelope: ExternalActionRequestEnvelope }> | null> {
  const result = await prepareExternalActionRequesterAccountAuthorizationResult(input);
  return 'authorization' in result ? result : null;
}

/** Authorization-only consumers delegate to the same original-root producer. */
export async function prepareExternalActionRequesterAccountAuthorization(
  input: Parameters<typeof prepareExternalActionRequesterAccountAuthorizationWithEnvelope>[0],
): Promise<ExternalActionExecutionAuthorizationV1 | null> {
  return (await prepareExternalActionRequesterAccountAuthorizationWithEnvelope(input))?.authorization ?? null;
}

export { prepareInstalledWorkflowActionAuthorization, prepareInstalledWorkflowActionAuthorizationWithEnvelope }
  from './installedWorkflowActionAuthorization';

/** Spend the existing requester projection without substituting an Account bearer. */
export async function resolveExternalActionRequesterServerRequestHeaders(input: Readonly<{
  context: Pick<ActionExecutorContext, 'signal' | 'externalActionExecutionAuthorization'>;
  effectActionId: string;
  serverHttpBaseUrl: string;
  method: string;
  path: string;
  body?: unknown;
}>): Promise<RequesterAccountAuthorizationHeaders | null> {
  const authorization = input.context.externalActionExecutionAuthorization;
  const projection = authorization?.requesterHttpProjection;
  if (!authorization || !projection || projection.accountId !== authorization.binding.accountId
    || normalizeServerHttpBaseUrl(projection.serverHttpBaseUrl) !== normalizeServerHttpBaseUrl(input.serverHttpBaseUrl)
    || input.context.signal?.aborted || !await projection.isCurrent()) return null;
  const child = readHostAdmittedReviewedChildV1(input.context);
  const headers = await projection.createRequestHeaders({ effectActionId: input.effectActionId, method: input.method, path: input.path,
    ...(input.body === undefined ? {} : { body: input.body }),
    ...(input.context.signal ? { signal: input.context.signal } : {}),
    ...(child?.actionId === input.effectActionId ? { reviewedChild: {
      actionId: child.actionId, role: child.role, inputDigest: child.inputDigest,
      ...(child.deploymentNativeAdmission ? { deploymentNativeAdmission: child.deploymentNativeAdmission } : {}),
    } } : {}),
  });
  return headers ? { ...headers, ...(projection.accountEncryptionMode === undefined ? {}
    : { [requesterAccountEncryptionMode]: projection.accountEncryptionMode }) } : null;
}

/** Admit this private acquisition once, before the Machine profile materializes a credential. */
export async function admitExternalActionMachineNpmProfileAcquisition(input: Readonly<{
  authorization: ExternalActionExecutionAuthorizationV1;
  signal?: AbortSignal;
}>): Promise<MachineNpmProfileAdmissionResponseV1> {
  const projection = input.authorization.requesterHttpProjection;
  if (!projection) throw Object.assign(new Error('authentication_required'), { code: 'authentication_required' });
  const path = bindExternalActionExecutionAuthorizationVerifyHttpPathV1(input.authorization.binding.actionId);
  const body = { v: 1 as const, nativePurpose: 'machine_npm_profile_acquisition' as const,
    ...(input.authorization.binding.admittedMachineRole ? { admittedMachineRole: input.authorization.binding.admittedMachineRole } : {}) };
  const headers = await projection.createRequestHeaders({ effectActionId: input.authorization.binding.actionId,
    method: 'POST', path, body, ...(input.signal ? { signal: input.signal } : {}) });
  if (!headers) throw Object.assign(new Error('authentication_required'), { code: 'authentication_required' });
  const response = await axios.post<unknown>(`${projection.serverHttpBaseUrl}${path}`, body, {
    headers: { ...headers, 'Content-Type': 'application/json' },
    ...(input.signal ? { signal: input.signal } : {}), validateStatus: () => true,
  });
  const result = ExternalActionMachineNpmProfileAdmissionResponseV1Schema.safeParse(response.data);
  if (!result.success || result.data.ok && (response.status < 200 || response.status >= 300)) {
    throw Object.assign(new Error('authentication_failed'), { code: 'authentication_failed' });
  }
  return result.data;
}

/** The in-process reviewed-child issuer proves that this effect still spends its Bot parent. */
export function readAdmittedBotTemplateParentActionIdV1(context: ActionExecutorContext | undefined): string | null {
  const parent = readHostAdmittedReviewedRootV1(context);
  const actionId = context?.externalActionExecutionAuthorization?.binding.actionId;
  return parent?.actionId === actionId
    && BOT_TEMPLATE_ACTION_IDS_V1.some(candidate => candidate === parent.actionId) ? parent.actionId : null;
}

export function resolveExternalActionServerRequestHeaders(input: Readonly<{
  context: ActionExecutorContext | undefined;
  effectActionId: string;
  method: string;
  path: string;
  body?: unknown;
  daemonToken: string;
  serverIdentityId?: string;
  privateKey?: ExternalActionMachineRequestSigningKey;
  installationId?: string;
}>): Readonly<{ ok: true; headers: Readonly<Record<string, string>>;
  machineRpcAuthorization?: 'account' }> | Readonly<{ ok: false }> {
  const authorization = input.context?.externalActionExecutionAuthorization;
  if (!authorization) {
    // Public Action execution never falls through to the daemon credential.
    // A direct PAT request may still complete daemon-local work while its Home
    // is unreachable, but any Home-bound effect remains closed.
    if (input.context?.externalActionCredential) return { ok: false };
    return { ok: true, headers: { Authorization: `Bearer ${input.daemonToken}`,
      ...(input.context?.authority === 'account_automation' ? { [AUTHORITY_CEILING_HEADER_V1]: 'account_automation' } : {}) } };
  }
  if (
    !input.privateKey
    || !input.installationId
    || !input.context?.externalActionTarget
    || authorization.binding.serverIdentityId !== input.serverIdentityId
  ) {
    return { ok: false };
  }
  const binding = authorization.binding;
  if (binding.actionId === 'approval.request.create' && binding.actionId !== input.effectActionId
    && 'authentication' in binding) {
    // The proposal proof remains approval provenance, not an effect credential.
    // Replay has reopened the original requester's private custody. Spend that
    // Account at Home, as a direct Account Action does; never borrow the daemon.
    const approval = input.context.presentUserApproval;
    const replay = input.context.approvedActionReplay;
    const requester = readRequesterAccountActionContext(authorization);
    if (!requester || !approval || !replay || approval.actionId !== input.effectActionId
      || approval.artifactId !== replay.artifactId || approval.requestId !== binding.requestId
      || approval.decidingAccountId !== binding.accountId
      || binding.sessionActionOrigin || binding.workflowActionOrigin
      || (binding.authentication.kind !== 'account' && binding.authentication.kind !== 'terminal')) return { ok: false };
    return { ok: true, headers: { Authorization: `Bearer ${requester.credentials.token}`,
      ...(input.context.authority === 'account_automation' ? { [AUTHORITY_CEILING_HEADER_V1]: 'account_automation' } : {}) } };
  }
  const admittedChild = readHostAdmittedReviewedChildV1(input.context);
  // Setup already spends its own child grant and Home purpose. Retain that
  // exact private issuer proof before the incumbent parent-purpose fallback.
  const independentChild = admittedChild?.actionId === input.effectActionId
    && isMachineSetupPlanOrApplyActionIdV1(input.effectActionId);
  const templateParentActionId = independentChild ? null
    : readAdmittedBotTemplateParentActionIdV1(input.context);
  const templateChild = templateParentActionId !== null;
  if (templateChild && !('credentialId' in binding)) {
    if (binding.accountId !== readAccountIdFromToken(input.daemonToken)) return { ok: false };
    return { ok: true, machineRpcAuthorization: 'account', headers: { Authorization: `Bearer ${input.daemonToken}`,
      ...(input.context.authority === 'account_automation' ? { [AUTHORITY_CEILING_HEADER_V1]: 'account_automation' } : {}) } };
  }
  const effectActionId = templateParentActionId ?? input.effectActionId;
  const reviewedChild = admittedChild?.actionId === input.effectActionId
    && !templateChild ? { actionId: admittedChild.actionId, role: admittedChild.role, inputDigest: admittedChild.inputDigest } : undefined;
  return {
    ok: true,
    headers: createExternalActionAuthorizedRequestHeaders({
      authorization,
      effectActionId,
      target: input.context.externalActionTarget,
      installationId: input.installationId,
      method: input.method,
      path: input.path,
      ...(reviewedChild ? { reviewedChild } : {}),
      ...(input.body === undefined ? {} : { body: input.body }),
      privateKey: input.privateKey,
    }),
  };
}

/** A fresh managed continuation re-enters the same public Session Action owner.
 * The controller signs only its original acquire proof; Home admits and signs
 * the actual guest invocation with the original requester authority.
 */
export function isManagedSessionStartTransportAvailable(params: Readonly<{
  authorization?: ExternalActionExecutionAuthorizationV1;
  installationId: string;
  material?: Extract<AccountScopedCryptoMaterial, Readonly<{ type: 'dataKey' }>>;
}>): boolean {
  const root = params.authorization?.binding;
  return root?.actionId === 'machines.managed.acquire' && root.installationId === params.installationId
    && root.target.kind === 'machine' && root.target.machineId === root.machineId
    && (root.accountEncryptionMode === 'plain' || root.accountEncryptionMode === 'e2ee'
      && ('authentication' in root && root.accountId !== root.custodianAccountId || params.material?.machineKey.length === 32));
}

type ManagedChildDispatchParams = Readonly<{
  input: SessionSpawnNewInputV2;
  /** Host-local caller and parent projection only; never a serialized executor context. */
  context?: ActionExecutorContext;
  observeRecordedApprovalExecution?: (args: RecordedApprovalExecutionObservationArgs) => Promise<ActionExecuteResult>;
  authority?: ActionRequiredAuthority;
  invocation?: ExternalActionRequesterInvocationV1;
  continuation: NonNullable<ExternalActionExecutionAuthorizationRequestV1['managedContinuation']>;
  authorization: ExternalActionExecutionAuthorizationV1;
  installationId: string;
  privateKey: ExternalActionMachineRequestSigningKey;
  serverHttpBaseUrl: string;
  homeTarget?: ResolvedHomeTarget;
  material?: Extract<AccountScopedCryptoMaterial, Readonly<{ type: 'dataKey' }>>;
  signal?: AbortSignal;
}>;
export async function dispatchManagedSessionStart(params: ManagedChildDispatchParams): Promise<ActionExecuteResult> {
  return dispatchManagedChild({ ...params, actionId: 'session.spawn_new', serverId: params.input.executionTarget.serverId,
    targetMachineId: params.input.executionTarget.machineId });
}

async function dispatchManagedChild(params: Omit<ManagedChildDispatchParams, 'input'> & Readonly<{
  input: SessionSpawnNewInputV2 | MachineSetupApplyInputV1 | MachineSetupPlanInputV1 | ReturnType<typeof MachineAdminAccessSetInputV1Schema.parse>
    | MachineAgentIsolationPreviewInputV1 | MachineAgentIsolationSetInputV1;
  actionId: 'session.spawn_new' | 'machines.setup.plan' | 'machines.setup.apply' | 'machines.setup.adminAccess.set'
    | 'machines.agentIsolation.preview' | 'machines.agentIsolation.set'; serverId: string; targetMachineId: string;
  retainedCreationSetup?: Parameters<typeof matchesMachineSetupCreationSourcesV1>[1];
}>): Promise<ActionExecuteResult> {
  const fail = (code: string): ActionExecuteFailure => ({ ok: false, errorCode: code, error: code });
  const root = params.authorization.binding;
  const reviewedParent = readHostReviewedParentV1(params.context);
  const invocation = params.context ? readExternalActionRequesterInvocation(params.context) : params.invocation;
  const managedChildCodec = 'authentication' in root && root.accountId !== root.custodianAccountId
    && root.accountEncryptionMode === 'e2ee';
  const carriesInvocation = managedChildCodec || invocation !== undefined || reviewedParent !== null;
  const recoveryAvailable = isManagedEnrollmentRecoveryChildV1(root.actionId, params.actionId)
    && root.installationId === params.installationId && root.target.kind === 'machine' && root.target.machineId === root.machineId
    && (root.accountEncryptionMode === 'plain' || root.accountEncryptionMode === 'e2ee' && (managedChildCodec || params.material?.machineKey.length === 32));
  if (!(isManagedSessionStartTransportAvailable(params) || recoveryAvailable)
    || root.actionId === 'machines.managed.acquire' && root.requestId !== params.continuation.creationRequestId) return fail('admission_unavailable');
  if (params.signal?.aborted) return fail('cancelled');
  let input: typeof params.input;
  try {
    const home = params.homeTarget ?? await resolveCliHomeTarget({ kind: 'saved_profile', profileRef: params.serverId });
    const serverIdentityId = assertResolvedHomeTargetIdentity(home, root.serverIdentityId);
    const destination = normalizeServerHttpBaseUrl(params.serverHttpBaseUrl);
    const capturedHome = params.authorization.requesterHttpProjection;
    const capturedDestination = capturedHome?.accountId === root.accountId
      && capturedHome.serverIdentityId === serverIdentityId
      && normalizeServerHttpBaseUrl(capturedHome.serverHttpBaseUrl) === destination;
    // An Iroh runtime origin is not the descriptor's HTTPS application URL.
    // Only the existing verified private Home port can admit that destination.
    if (normalizeServerHttpBaseUrl(home.applicationUrl) !== destination
      && (!capturedDestination || !await capturedHome!.isCurrent())) return fail('target_unavailable');
    if (params.actionId === 'session.spawn_new') {
      const parsed = SessionSpawnNewInputV2Schema.parse(params.input);
      input = { ...parsed, executionTarget: { ...parsed.executionTarget, serverId: serverIdentityId } };
    } else if (params.actionId === 'machines.setup.adminAccess.set') {
      const parsed = MachineAdminAccessSetInputV1Schema.parse(params.input);
      if (parsed.serverId !== serverIdentityId || parsed.machineId !== params.targetMachineId) return fail('target_unavailable');
      input = parsed;
    } else if (params.actionId === 'machines.agentIsolation.preview' || params.actionId === 'machines.agentIsolation.set') {
      const parsed = (params.actionId === 'machines.agentIsolation.preview'
        ? MachineAgentIsolationPreviewInputV1Schema : MachineAgentIsolationSetInputV1Schema).parse(params.input);
      if (parsed.serverId !== serverIdentityId || parsed.machineId !== params.targetMachineId) return fail('target_unavailable');
      input = parsed;
    } else if (params.actionId === 'machines.setup.plan') {
      const parsed = MachineSetupPlanInputV1Schema.parse(params.input);
      if (parsed.homeId !== serverIdentityId || parsed.machineId !== params.targetMachineId
        || parsed.sources !== undefined && (parsed.mode !== 'effects' || !params.retainedCreationSetup
          || !matchesMachineSetupCreationSourcesV1(parsed.sources, params.retainedCreationSetup))) return fail('target_unavailable');
      input = parsed;
    } else {
      const parsed = MachineSetupApplyInputV1Schema.parse(params.input);
      if (parsed.homeId !== serverIdentityId || parsed.machineId !== params.targetMachineId) return fail('target_unavailable');
      input = parsed;
    }
  } catch (error) { refuseExternalActionPhase('managed_child_projection', params.targetMachineId, error); return fail('target_unavailable'); }
  if (params.signal?.aborted) return fail('cancelled');
  // The ordinary spawn owner namespaces identity by Action and requester.
  // Preserve its fresh acquisition correlation across an explicit retry.
  const requestId = root.requestId;
  const target = { kind: 'machine' as const, machineId: params.targetMachineId };
  const binding: ExternalActionEncryptionBindingV2 = { serverIdentityId: root.serverIdentityId,
    accountId: root.accountId, actionId: params.actionId, requestId, target,
    ...('authentication' in root ? { authentication: { kind: root.authentication.kind, tokenEpoch: root.authentication.tokenEpoch } }
      : { credentialId: root.credentialId }) };
  const actionInput = params.actionId === 'session.spawn_new'
    ? projectSessionSpawnNewActionInputV2(SessionSpawnNewInputV2Schema.parse(input)) : input;
  let recipient: ReturnType<typeof ManagedEnrollmentInstallationV1Schema.parse> | undefined;
  if (carriesInvocation) {
    const path = '/v1/machines/managed/controller/context';
    const body = { homeId: root.serverIdentityId, managedId: params.continuation.managedId,
      expectedIntentRevision: params.continuation.expectedIntentRevision,
      controller: { machineId: root.machineId, installationId: root.installationId }, includeEnrollmentInstallation: true as const };
    try {
      const response = await axios.post<unknown>(`${params.serverHttpBaseUrl}${path}`, body, {
        headers: createExternalActionAuthorizedRequestHeaders({ authorization: params.authorization,
          effectActionId: root.actionId, target: root.target, installationId: params.installationId,
          method: 'POST', path, body, privateKey: params.privateKey }),
        ...(params.signal ? { signal: params.signal } : {}), validateStatus: () => true,
      });
      const context = z.looseObject({ requestId: z.string(), enrollmentInstallation: ManagedEnrollmentInstallationV1Schema }).safeParse(response.data);
      if (response.status !== 200 || !context.success || context.data.requestId !== params.continuation.creationRequestId
        || context.data.enrollmentInstallation.machineId !== params.targetMachineId) return fail('admission_unavailable');
      recipient = context.data.enrollmentInstallation;
    } catch { return fail(params.signal?.aborted ? 'cancelled' : 'admission_unavailable'); }
  }
  // Each child is an independent invocation, not a reuse of the parent codec or
  // either Account's encryption key. Only the exact enrolled guest can open it.
  const childMaterial = managedChildCodec ? { type: 'dataKey' as const, machineKey: randomBytes(32) } : params.material;
  const baseEnvelope = ExternalActionRequestEnvelopeSchema.parse(projectNativeJsonValueForTransport(root.accountEncryptionMode === 'e2ee'
    ? sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding, input: actionInput, material: childMaterial!, randomBytes,
        ...(params.actionId === 'session.spawn_new' ? { sessionSpawnAdmission: projectApiTokenSessionSpawnAdmissionV1(SessionSpawnNewInputV2Schema.parse(input)) } : {}) })
    : { v: 1 as const, requestId, target, input: actionInput }));
  const envelope = recipient
    ? sealManagedCreationActionCodecV1({ authorization: params.authorization, actionId: params.actionId,
      continuation: params.continuation, envelope: baseEnvelope, recipient,
      ...(managedChildCodec && childMaterial ? { material: childMaterial } : {}), randomBytes,
      ...(invocation ? { invocation } : {}),
      ...(reviewedParent ? { reviewedParent } : {}) }) : baseEnvelope;
  const body = ExternalActionExecutionAuthorizationRequestV1Schema.parse({ v: 1, machineId: target.machineId,
    envelope, managedContinuation: params.continuation });
  const path = `${EXTERNAL_ACTION_HTTP_PATH_PREFIX_V1}${params.actionId}`;
  const headers = createExternalActionAuthorizedRequestHeaders({ authorization: params.authorization,
    effectActionId: root.actionId, target: root.target, installationId: params.installationId,
    method: 'POST', path, body, privateKey: params.privateKey });
  const observe = (execution: ActionExecuteResult) => observeManagedChildApprovalExecution({ execution,
    context: params.context, signal: params.signal,
    expectedOrigin: { actionId: params.actionId, requestId, accountId: root.accountId,
      serverIdentityId: root.serverIdentityId, machineId: target.machineId },
    isCurrent: () => params.authorization.requesterHttpProjection?.isCurrent() ?? Promise.resolve(false),
    observeRecordedApprovalExecution: params.observeRecordedApprovalExecution });
  try {
    const response = await axios.post<unknown>(`${params.serverHttpBaseUrl}${path}`, body, {
      headers: { ...headers, 'Content-Type': 'application/json',
        ...(params.authority === 'account_automation' ? { [AUTHORITY_CEILING_HEADER_V1]: params.authority } : {}) },
      ...(params.signal ? { signal: params.signal } : {}), validateStatus: () => true,
    });
    if (response.status < 200 || response.status >= 300) {
      const error = ExternalActionHttpErrorSchema.safeParse(response.data);
      if (error.success && 'requestId' in error.data && error.data.requestId !== undefined
        && error.data.requestId !== envelope.requestId) return fail('invalid_action_output');
      if (error.success && 'code' in error.data
        && (error.data.code === 'action_not_admitted' || error.data.code === 'action_outcome_unknown')) {
        return { ...projectUnexpectedActionFailureV1(error.data.code === 'action_not_admitted' ? false : null, error.data.requestId),
          ...('failureCause' in error.data && error.data.failureCause !== undefined ? { failureCause: error.data.failureCause } : {}),
          ...('diagnostic' in error.data ? { details: error.data } : {}) };
      }
      if (error.success && 'phase' in error.data && error.data.phase !== undefined) {
        return { ...fail(error.data.code), details: error.data };
      }
      if (error.success && 'code' in error.data && error.data.code === 'target_unavailable'
        && 'diagnostic' in error.data && error.data.diagnostic !== undefined) {
        return { ...fail(error.data.code), details: error.data.diagnostic };
      }
      return fail(error.success ? 'code' in error.data ? error.data.code : error.data.error : 'target_unavailable');
    }
    if (envelope.v === 2 && childMaterial) return await observe(openExternalActionResponseV2({ envelope: response.data,
      binding, request: envelope, material: childMaterial }) ?? fail('invalid_encrypted_envelope'));
    const responseEnvelope = ExternalActionResponseEnvelopeV1Schema.safeParse(response.data);
    return await observe(responseEnvelope.success && responseEnvelope.data.actionId === params.actionId
      && responseEnvelope.data.requestId === requestId ? responseEnvelope.data.execution : fail('invalid_envelope'));
  } catch (error) {
    refuseExternalActionPhase('managed_child_http', params.targetMachineId, error);
    return fail(params.signal?.aborted ? 'cancelled' : 'target_unavailable');
  }
}

/** Signed Session/Workflow origins retain their own provenance instead of becoming host callers. */
export function readExternalActionRequesterInvocation(context: ActionExecutorContext): ExternalActionRequesterInvocationV1 | undefined {
  // Runtime callers also carry local display/attribution facts. Project only
  // the private transport contract, deriving its fields from that owner.
  const caller = z.union(ExternalActionRequesterInvocationV1Schema.shape.caller.def.options.map(option =>
    z.object(option.shape))).safeParse(context.actionCaller ?? { kind: 'host' });
  if (!caller.success) return undefined;
  const parsed = ExternalActionRequesterInvocationV1Schema.safeParse({ caller: caller.data,
    surface: context.surface, authority: context.authority, callerPermissionMode: context.callerPermissionMode,
    callerInputConstraints: context.callerInputConstraints, workspaceWrites: context.workspaceWrites,
    defaultSessionId: context.defaultSessionId });
  return parsed.success ? parsed.data : undefined;
}

export async function dispatchManagedMachineSetup(params: Omit<Parameters<typeof dispatchManagedSessionStart>[0], 'input'> & Readonly<{
  input: MachineSetupApplyInputV1;
  serverId: string;
}>): Promise<ActionExecuteResult> {
  return dispatchManagedChild({ ...params, actionId: 'machines.setup.apply', targetMachineId: params.input.machineId });
}

/** The retained creation may read only its enrolled guest's current setup. */
export async function dispatchManagedMachineSetupPlan(params: Omit<ManagedChildDispatchParams, 'input'> & Readonly<{
  input: MachineSetupPlanInputV1; serverId: string;
  retainedCreationSetup?: Parameters<typeof matchesMachineSetupCreationSourcesV1>[1];
}>): Promise<ActionExecuteResult> {
  return dispatchManagedChild({ ...params, actionId: 'machines.setup.plan', targetMachineId: params.input.machineId });
}

/** Records creation intent through the existing signed child Action, on its exact guest. */
export async function dispatchManagedMachineAdminAccess(params: Omit<ManagedChildDispatchParams, 'input'> & Readonly<{
  input: ReturnType<typeof MachineAdminAccessSetInputV1Schema.parse>; serverId: string;
}>): Promise<ActionExecuteResult> {
  return dispatchManagedChild({ ...params, actionId: 'machines.setup.adminAccess.set', targetMachineId: params.input.machineId });
}

type ManagedAgentIsolationChild = Readonly<
  { actionId: 'machines.agentIsolation.preview'; input: MachineAgentIsolationPreviewInputV1 }
  | { actionId: 'machines.agentIsolation.set'; input: MachineAgentIsolationSetInputV1 }>;

export async function dispatchManagedMachineAgentIsolation(params: Omit<ManagedChildDispatchParams, 'input'>
  & ManagedAgentIsolationChild & Readonly<{ serverId: string }>): Promise<ActionExecuteResult> {
  return dispatchManagedChild({ ...params, targetMachineId: params.input.machineId });
}

/** Sealed creation children are compared with their retained review before target CAS. */
export async function verifyManagedCreationAdminAccessInput(input: Readonly<{
  request: MachineAdminAccessActionInput;
  context: ActionExecutorContext;
  serverHttpBaseUrl: string;
  daemonToken: string;
  serverIdentityId?: string;
  privateKey?: ExternalActionMachineRequestSigningKey;
  installationId?: string;
}>): Promise<boolean> {
  return verifyManagedCreationEnrollmentPolicyInput(input, 'machines.setup.adminAccess.set', row =>
    'adminAccess' in input.request && matchesManagedMachineEnrollmentAdminAccessV1({ homeId: row.homeId,
      machineId: input.request.machineId, enrollmentIdentity: row.enrollmentIdentity }, input.request));
}

export async function verifyManagedCreationAgentIsolationInput(input: Omit<Parameters<typeof verifyManagedCreationAdminAccessInput>[0], 'request'>
  & Readonly<{ actionId: 'machines.agentIsolation.preview' | 'machines.agentIsolation.set';
    request: MachineAgentIsolationPreviewInputV1 | MachineAgentIsolationSetInputV1 }>): Promise<boolean> {
  return verifyManagedCreationEnrollmentPolicyInput(input, input.actionId, row =>
    matchesManagedMachineEnrollmentAgentIsolationV1({ homeId: row.homeId, machineId: input.request.machineId,
      enrollmentIdentity: row.enrollmentIdentity }, input.request));
}

async function verifyManagedCreationEnrollmentPolicyInput(input: Omit<Parameters<typeof verifyManagedCreationAdminAccessInput>[0], 'request'>
  & Readonly<{ request: { serverId?: string; machineId: string } }>, actionId: string,
  matches: (row: ManagedMachineV1) => boolean): Promise<boolean> {
  const binding = input.context.externalActionExecutionAuthorization?.binding;
  const continuation = binding?.managedContinuation;
  if (!continuation) return true;
  if (binding.actionId !== actionId || binding.machineId !== input.request.machineId
    || binding.serverIdentityId !== input.serverIdentityId) return false;
  const path = managedMachineActionEndpointPathV1('machines.managed.get');
  const body = { homeId: binding.serverIdentityId, managedId: continuation.managedId };
  const headers = resolveExternalActionServerRequestHeaders({ ...input, method: 'POST', path, body,
    effectActionId: actionId });
  if (!headers.ok) return false;
  try {
    const response = await axios.post<unknown>(`${input.serverHttpBaseUrl}${path}`, body, {
      headers: headers.headers, signal: input.context.signal, validateStatus: () => true,
    });
    if (response.status !== 200) return false;
    const row = ManagedMachineV1Schema.parse(response.data);
    return row.id === continuation.managedId && row.homeId === binding.serverIdentityId
      && row.enrolledMachineId === binding.machineId && row.intentRevision === continuation.expectedIntentRevision
      && row.creationState === 'active' && row.allocation === 'bound' && row.desired !== 'delete'
      && sameStrictJsonValue(row.controller, continuation.controller)
      && matches(row);
  } catch { return false; }
}

/** Provenance for the incumbent local host Account path, not effect authority.
 * Home still mints and verifies every setup Action's exact target proof. */
export function isOriginalLocalManagedSetupContext(input: Readonly<{
  context: ActionExecutorContext; credentials: StoredCredentials; custodianAccountId: string; homeId: string;
}>): boolean {
  const { context, credentials } = input;
  const accountId = readAccountIdFromToken(credentials.token);
  const provenance = readAuthTokenProvenance(decodeJwtPayload(credentials.token), { allowLegacyHome: false });
  return Boolean(accountId && accountId === input.custodianAccountId
    && hasStoredSessionCredentialProvenance(credentials) && provenance?.provenance.kind === 'terminal'
    && (context.surface === 'cli' || context.surface === 'ui') && context.actionCaller?.kind === 'host'
    && context.actionRequestId && context.serverIdentityId === input.homeId
    && (!context.runtimeAccountId || context.runtimeAccountId === accountId)
    && !('machineAdmission' in context && context.machineAdmission) && !context.externalActionCredential && !context.externalActionExecutionAuthorization
    && !context.rpcSessionAuthorization && !context.causalPermissionAuthority && !context.sessionInputSource
    && !context.runtimeRunId && !context.executionRunWorkflowRunId);
}

/** An admitted in-process child may originate its own ordinary setup Action for this daemon's Account. */
function isAdmittedLocalReviewedSetupContext(input: Readonly<{
  actionId: string; input: Readonly<{ machineId: string }>;
  context: ActionExecutorContext; credentials: StoredCredentials; custodianAccountId: string; homeId: string;
}>): boolean {
  const { credentials } = input;
  const context: RpcActionExecutorContext = input.context;
  const operation = readHostReviewedChildOperationV1(context, input.actionId, input.input);
  if (!isHostAdmittedReviewedChildPolicyV1(operation, input.actionId, input.input)) return false;
  const authorization = context.externalActionExecutionAuthorization;
  const binding = authorization?.binding;
  const verified = context.verifiedExternalActionRequester;
  const accountId = readAccountIdFromToken(credentials.token);
  const provenance = readAuthTokenProvenance(decodeJwtPayload(credentials.token), { allowLegacyHome: false });
  return Boolean(context.actionRequestId && context.serverIdentityId === input.homeId
    && accountId && accountId === input.custodianAccountId
    && context.runtimeAccountId === accountId
    && hasStoredSessionCredentialProvenance(credentials) && provenance?.provenance.kind === 'terminal'
    && !context.externalActionCredential && !context.signal?.aborted
    && (!context.externalActionTarget || context.externalActionTarget.kind === 'machine'
      && context.externalActionTarget.machineId === input.input.machineId)
    && (!binding || verified?.authorization === authorization
      && operation?.parent.actionId === binding.actionId
      && binding.requestId === context.actionRequestId
      && binding.serverIdentityId === input.homeId
      && binding.machineId === input.input.machineId && binding.target.kind === 'machine'
      && binding.target.machineId === input.input.machineId
      && sameStrictJsonValue(context.externalActionTarget, binding.target)
      && accountId === binding.accountId && accountId === binding.custodianAccountId));
}

/** Original local host creation has no Session continuation proof. Its setup
 * re-enters the incumbent Account Action ingress, never an unsigned guest RPC. */
export async function dispatchLocalManagedMachineSetup(params: Readonly<{
  input: MachineSetupApplyInputV1;
  context: ActionExecutorContext;
  credentials: StoredCredentials;
  custodianAccountId: string;
  serverHttpBaseUrl: string;
  isCurrent(): Promise<boolean>;
  observeRecordedApprovalExecution?: (args: RecordedApprovalExecutionObservationArgs) => Promise<ActionExecuteResult>;
}>): Promise<ActionExecuteResult> {
  return dispatchLocalManagedCreationAction({ ...params, actionId: 'machines.setup.apply', homeId: params.input.homeId,
    admittedSetupChild: true });
}

export async function dispatchLocalManagedMachineSetupPlan(params: Omit<Parameters<typeof dispatchLocalManagedMachineSetup>[0], 'input'> & Readonly<{
  input: MachineSetupPlanInputV1;
  retainedCreationSetup?: Parameters<typeof matchesMachineSetupCreationSourcesV1>[1];
}>): Promise<ActionExecuteResult> {
  if (params.input.sources !== undefined && (params.input.mode !== 'effects' || !params.retainedCreationSetup
    || !matchesMachineSetupCreationSourcesV1(params.input.sources, params.retainedCreationSetup))
    && !isAdmittedLocalReviewedSetupContext({ ...params, actionId: 'machines.setup.plan', homeId: params.input.homeId })) {
    return { ok: false, errorCode: 'admission_unavailable', error: 'admission_unavailable' };
  }
  return dispatchLocalManagedCreationAction({ ...params, actionId: 'machines.setup.plan', homeId: params.input.homeId,
    admittedSetupChild: true });
}

export async function dispatchLocalManagedMachineAdminAccess(params: Omit<Parameters<typeof dispatchLocalManagedMachineSetup>[0], 'input'> & Readonly<{
  input: ReturnType<typeof MachineAdminAccessSetInputV1Schema.parse>; homeId: string;
  managedContinuation?: ExternalActionExecutionAuthorizationRequestV1['managedContinuation'];
}>): Promise<ActionExecuteResult> {
  return dispatchLocalManagedCreationAction({ ...params, actionId: 'machines.setup.adminAccess.set' });
}

export async function dispatchLocalManagedMachineAgentIsolation(params: Omit<Parameters<typeof dispatchLocalManagedMachineSetup>[0], 'input'>
  & ManagedAgentIsolationChild & Readonly<{ homeId: string;
    managedContinuation: NonNullable<ExternalActionExecutionAuthorizationRequestV1['managedContinuation']> }>): Promise<ActionExecuteResult> {
  return dispatchLocalManagedCreationAction(params);
}

async function dispatchLocalManagedCreationAction(params: Omit<Parameters<typeof dispatchLocalManagedMachineSetup>[0], 'input'> & Readonly<{
  input: MachineSetupApplyInputV1 | MachineSetupPlanInputV1 | ReturnType<typeof MachineAdminAccessSetInputV1Schema.parse>
    | MachineAgentIsolationPreviewInputV1 | MachineAgentIsolationSetInputV1;
  homeId: string; actionId: 'machines.setup.plan' | 'machines.setup.apply' | 'machines.setup.adminAccess.set'
    | 'machines.agentIsolation.preview' | 'machines.agentIsolation.set';
  managedContinuation?: ExternalActionExecutionAuthorizationRequestV1['managedContinuation'];
  admittedSetupChild?: true;
}>): Promise<ActionExecuteResult> {
  if (!isOriginalLocalManagedSetupContext({ ...params, homeId: params.homeId })
    && !(params.admittedSetupChild && isAdmittedLocalReviewedSetupContext(params)))
    return { ok: false, errorCode: 'admission_unavailable', error: 'admission_unavailable' };
  const reviewedParent = readHostReviewedParentV1(params.context);
  const invocation = reviewedParent && params.managedContinuation ? readExternalActionRequesterInvocation(params.context) : undefined;
  const execution = await dispatchOriginalAccountAction({ actionId: params.actionId, input: params.input,
    requestId: params.context.actionRequestId!, target: { kind: 'machine', machineId: params.input.machineId },
    credentials: params.credentials, serverHttpBaseUrl: params.serverHttpBaseUrl, serverIdentityId: params.homeId,
    ...(params.managedContinuation ? { managedContinuation: params.managedContinuation } : {}),
    ...(invocation && reviewedParent ? { invocation: { ...invocation, reviewedParent } } : {}),
    ...(params.context.authority ? { authority: params.context.authority } : {}), isCurrent: params.isCurrent,
    ...(params.context.signal ? { signal: params.context.signal } : {}) });
  return observeManagedChildApprovalExecution({ execution, context: params.context, isCurrent: params.isCurrent,
    expectedOrigin: { actionId: params.actionId, requestId: params.context.actionRequestId!,
      accountId: params.custodianAccountId, serverIdentityId: params.homeId, machineId: params.input.machineId },
    observeRecordedApprovalExecution: params.observeRecordedApprovalExecution });
}

/** Continue the accepted handoff after its original Session publisher quiesces. */
export async function prepareExternalActionHandoffContinuationAuthorization(input: Readonly<{
  authorization: ExternalActionExecutionAuthorizationV1;
  handoffId: string;
  actionId: string;
  input: unknown;
  machineId: string;
  sourceMachineId: string;
  sourceInstallationId: string;
  privateKey: ExternalActionMachineRequestSigningKey;
  serverHttpBaseUrl: string;
  material?: Extract<AccountScopedCryptoMaterial, Readonly<{ type: 'dataKey' }>>;
  signal?: AbortSignal;
}>): Promise<ExternalActionExecutionAuthorizationV1 | null> {
  return prepareExternalActionHandoffAuthorization({ ...input, phase: 'continuation' });
}

/** Read only the exact admitted peers while the original Session publisher remains current. */
export async function prepareExternalActionHandoffPreflightAuthorization(input: Omit<
  Parameters<typeof prepareExternalActionHandoffContinuationAuthorization>[0], 'handoffId' | 'actionId'
>): Promise<ExternalActionExecutionAuthorizationV1 | null> {
  return prepareExternalActionHandoffAuthorization({ ...input, phase: 'preflight', actionId: 'session.handoff' });
}

async function prepareExternalActionHandoffAuthorization(input: Omit<
  Parameters<typeof prepareExternalActionHandoffContinuationAuthorization>[0], 'handoffId'
> & Readonly<{ phase: 'preflight'; handoffId?: never } | { phase: 'continuation'; handoffId: string }>): Promise<ExternalActionExecutionAuthorizationV1 | null> {
  try {
    if (input.signal?.aborted) return null;
    const root = ExternalActionExecutionAuthorizationV1Schema.parse(input.authorization);
    const binding = root.binding;
    const admission = binding.handoffAdmission;
    if (binding.actionId !== 'session.handoff' || binding.handoffContinuation || binding.handoffPreflight || !admission
      || binding.machineId !== input.sourceMachineId || binding.installationId !== input.sourceInstallationId
      || admission.sourceMachineId !== input.sourceMachineId || admission.sourceInstallationId !== input.sourceInstallationId
      || ![admission.sourceMachineId, admission.targetMachineId].includes(input.machineId)) return null;
    const target = { kind: 'machine' as const, machineId: input.machineId };
    const actionId = ExternalActionActionIdV1Schema.parse(input.actionId);
    const handoffAdmission = { sessionId: admission.sessionId, sourceMachineId: admission.sourceMachineId,
      targetMachineId: admission.targetMachineId };
    if (binding.accountEncryptionMode === 'e2ee' && !input.material) return null;
    const envelope = binding.accountEncryptionMode === 'e2ee' && input.material
      ? { ...sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding: { serverIdentityId: binding.serverIdentityId,
          accountId: binding.accountId,
          ...('authentication' in binding ? { authentication: binding.authentication }
            : { credentialId: binding.credentialId }), actionId, requestId: binding.requestId, target },
          input: input.input, material: input.material, randomBytes }), handoffAdmission }
      : { v: 1 as const, requestId: binding.requestId, target, input: input.input, handoffAdmission };
    const body = ExternalActionExecutionAuthorizationRequestV1Schema.parse({ v: 1, machineId: input.machineId,
      envelope,
      ...(input.phase === 'preflight' ? { handoffPreflight: { authorization: root } }
        : { handoffContinuation: { authorization: root, handoffId: input.handoffId } }),
    });
    const path = bindExternalActionExecutionAuthorizationHttpPathV1(actionId);
    const response = await axios.post<unknown>(`${input.serverHttpBaseUrl}${path}`, body, {
      headers: { ...createExternalActionAuthorizedRequestHeaders({ authorization: root,
        effectActionId: 'session.handoff', target: binding.target, installationId: input.sourceInstallationId,
        privateKey: input.privateKey, method: 'POST', path, body }), 'Content-Type': 'application/json' },
      timeout: input.signal ? 0 : 15_000,
      ...(input.signal ? { signal: input.signal } : {}), validateStatus: () => true,
    });
    if (input.signal?.aborted || response.status < 200 || response.status >= 300) return null;
    const child = ExternalActionExecutionAuthorizationV1Schema.safeParse(response.data);
    if (!child.success) return null;
    const next = child.data.binding;
    const expectedInstallation = input.machineId === admission.sourceMachineId
      ? admission.sourceInstallationId : admission.targetInstallationId;
    if (next.accountId !== binding.accountId || next.serverIdentityId !== binding.serverIdentityId
      || next.accountEncryptionMode !== binding.accountEncryptionMode
      || next.machineId !== input.machineId || next.installationId !== expectedInstallation
      || next.actionId !== actionId || next.requestId !== binding.requestId
      || next.requestEnvelopeDigest !== computeExternalActionRequestEnvelopeDigestV1(body.envelope)
      || !externalActionTargetsEqualV1(next.target, target)
      || !sameStrictJsonValue(next.handoffAdmission, admission)
      || !sameStrictJsonValue(next.sessionActionOrigin, binding.sessionActionOrigin)
      || !sameStrictJsonValue(next.sessionActionSource, binding.sessionActionSource)
      || !sameStrictJsonValue(next.handoffContinuation, input.phase === 'preflight' ? undefined : {
        rootRequestId: binding.requestId, rootRequestEnvelopeDigest: binding.requestEnvelopeDigest, handoffId: input.handoffId })
      || !sameStrictJsonValue(next.handoffPreflight, input.phase === 'preflight' ? {
        rootRequestId: binding.requestId, rootRequestEnvelopeDigest: binding.requestEnvelopeDigest } : undefined)
      || ('authentication' in binding ? !('authentication' in next)
        || !sameStrictJsonValue(next.authentication, binding.authentication)
        : !('credentialId' in next) || next.credentialId !== binding.credentialId
          || next.principalId !== binding.principalId || !sameStrictJsonValue(next.grant, binding.grant))) return null;
    return child.data;
  } catch (error) { refuseExternalActionPhase('handoff_authorization', input.machineId, error); return null; }
}

export async function verifyExternalActionExecutionAuthorizationCurrent(input: Readonly<{
  authorization: ExternalActionExecutionAuthorizationV1;
  effectActionId: string;
  target: ExternalActionTargetV1;
  privateKey: ExternalActionMachineRequestSigningKey;
  installationId: string;
  serverHttpBaseUrl: string;
  managedFiniteWakeTarget?: ManagedWakeTargetV1;
  retainedDiscussionSource?: SessionInputSourceSessionV1;
  signal?: AbortSignal;
}>): Promise<boolean> {
  const path = bindExternalActionExecutionAuthorizationVerifyHttpPathV1(
    input.authorization.binding.actionId,
  );
  const body = { v: 1 as const,
    ...(input.authorization.binding.admittedMachineRole ? { admittedMachineRole: input.authorization.binding.admittedMachineRole } : {}),
    ...(input.managedFiniteWakeTarget ? { managedFiniteWakeTarget: input.managedFiniteWakeTarget } : {}),
    ...(input.retainedDiscussionSource ? { retainedDiscussionSource: input.retainedDiscussionSource } : {}) };
  const headers = createExternalActionAuthorizedRequestHeaders({
    authorization: input.authorization,
    effectActionId: input.effectActionId,
    target: input.target,
    installationId: input.installationId,
    method: 'POST',
    path,
    body,
    privateKey: input.privateKey,
  });
  try {
    const response = await axios.post<unknown>(`${input.serverHttpBaseUrl}${path}`, body, {
      headers: { ...headers, 'Content-Type': 'application/json' },
      timeout: input.signal ? 0 : 15_000,
      ...(input.signal ? { signal: input.signal } : {}),
      validateStatus: () => true,
    });
    traceExternalActionInnerStage('requester.root_verification.http', { httpStatus: response.status });
    if (response.status < 200 || response.status >= 300) {
      const failure = createHttpStatusError(response.status, 'External Action authorization is unavailable');
      refuseExternalActionPhase('signed_root_http_status', input.authorization.binding.machineId, failure,
        readSessionInputAdmissionDiagnostic(input.authorization.binding));
      rethrowRequesterHomeReadFailure(failure);
      return false;
    }
    const parsed = ExternalActionExecutionAuthorizationVerifyResponseV1Schema.safeParse(response.data);
    if (!parsed.success) refuseExternalActionPhase('signed_root_http_response', input.authorization.binding.machineId, parsed.error);
    return parsed.success;
  } catch (error) {
    refuseExternalActionPhase('signed_root_http_request', input.authorization.binding.machineId, error);
    rethrowRequesterHomeReadFailure(error);
    return false;
  }
}
