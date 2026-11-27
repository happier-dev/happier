import { readDaemonHostResourceActionFailure } from '@/rpc/handlers/daemonHostResourceRead';
import { projectContributedActionFailure } from '@/plugins/runtime/invocation/actions/contributedActionFailure';
import { doesExternalActionConsumeRequesterAccountContentV1, projectExternalActionMachineRuntimeDemandV1 } from '@happier-dev/protocol/actions/actionSpecs';
import { projectExternalActionWorkflowSessionLeafContextV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { randomBytes, randomUUID } from 'node:crypto';
import { apiTokenEncryptionAccessRequired, retainApiTokenDeploymentContentAccess } from '@/auth/apiTokenDeploymentCustody';
import { prepareApiTokenDeploymentAccountProjection } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import { isProjectWorkspaceSyncPreparationActionV1 } from '@happier-dev/protocol/actions/projectActionFamily';
import { ACTION_INVOKE_ACTION_ID_V1, isWorkspaceSyncRelationshipWriteActionId, SESSION_MESSAGE_SEND_ACTION_ID_V1, WORKFLOW_RUN_START_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIds';
import { ACTION_OPERATION_CANCEL_ACTION_ID_V1 } from '@happier-dev/protocol/actions/operations/actionIdsV1';
import { SESSION_WORKSPACE_RETURN_PREPARE_ACTION_ID_V1 } from '@happier-dev/protocol/actions/sessionWorkspaceReturnActionIdsV1';
import { ActionOperationAddressV1Schema } from '@happier-dev/protocol/actions/operations/addressV1';
import { isReviewedMachineSetupChildRootV1 } from '@happier-dev/protocol/machines/peer/mediation/rpc/reviewedChildFamilyV1';
import { isSessionAgentReadinessRootActionIdV1, MANAGED_ACQUIRE_ACTION_ID_V1 } from '@happier-dev/protocol/machines/managed/actionIdsV1';
import { isPluginError } from '@happier-dev/plugin-sdk';

import { ExternalActionActionIdV1Schema, ExternalActionExecutionAuthorizationV1Schema, ExternalActionRequestEnvelopeSchema, externalActionTargetsEqualV1, isExternalActionRequestWithinLimit, isExternalActionRequestVersionAllowedForAccountModeV1, projectExternalActionExecutionResultV1, readExternalActionProtectedRequestId } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1, signExternalActionApprovalInputV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { projectExternalActionRunNowIdempotencyKeyV1, projectExternalActionApprovalDecisionAdmissionV1,
  projectRegistryAppUpdateAdmissionV1, projectExternalActionManagedAdmissionV1, projectExternalActionManagedAdmissionOperandV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { projectDeploymentReadAdmissionV1, projectExternalActionDeploymentLinkEnvironmentIdV1,
  projectExternalActionDeploymentMetadataEnvironmentIdV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { projectPrivateMountedDatabaseReadInputV1, readDeploymentReadAdmissionHomeIdV1 } from '@happier-dev/protocol/deployments/deploymentReadAdmissionV1';
import { projectDeploymentPreparationAdmissionV1, projectDeploymentNativeAdmissionV1, isDeploymentBackupNativeAdmissionV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { isServerProfileHomeIdentity } from '@/server/serverProfiles';
import { MACHINE_REBOOT_ACTION_IDS } from '@happier-dev/protocol/machines/rebootActionIdsV1';
import { openExternalActionRequestV2, prepareExternalActionResponseV2 } from '@happier-dev/protocol/actions/externalActionEncryption';
import { SIGNED_ROOT_ACTION_OUTPUT_SCHEMAS, PublicActionIdSchema, SignedRootActionIdSchema, isPluginProvenanceOnlyActionId } from '@happier-dev/protocol/actions/actionSpecs';
import type { ActionExecuteResult, ActionExecutorContext, ExternalActionResponseEnvelopeV1, ExternalActionTargetV1, PreparedExternalActionResponseEnvelope, ExternalActionEncryptionBindingV2, ExternalActionExecutionAuthorizationV1, ExternalActionServerPrincipalV1, SignedRootActionId } from '@happier-dev/protocol/actions';
import type { ActionStartDiagnosticV1 } from '@happier-dev/protocol/actions/executor/actionStartDiagnostics';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { projectDeploymentReviewedCandidateV1 } from '@happier-dev/protocol/deployments/deploymentCandidatePublicationV1';
import { readRecord } from '@happier-dev/protocol/inputs/inputRecords';
import type { HostReviewedParentV1 } from '@happier-dev/protocol/actions/actionExecutor';
import { completeSpawnActionResult, settleActionOutput } from '@happier-dev/protocol/actions/executor/resultProjection';
import type { SessionSpawnNewResultV1 } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { invokeAdmittedReviewedChild } from './managedReviewedChild';
import { projectApiTokenSessionSpawnAdmissionV1 } from '@happier-dev/protocol/auth/apiTokenGrant';
import { admitSessionSpawnNewActionInputV2, SessionSpawnNewActionInputV2Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';

import { reconcileExternalActionTarget } from './reconcileExternalActionTarget';
import { projectExternalActionRequesterHttpAuthorization, resolveExternalActionAccountInvocationSurface,
  resolveExternalActionRootInvocationAuthority } from '@/api/externalActionExecutionAuthorization';
import { admitExternalActionRequesterInvocationAttributionV1, isManagedControllerCodecRootV1, isReviewedMachineSetupCodecV1, openManagedControllerActionCodecV1, openManagedCreationActionCodecV1,
  type ExternalActionRequesterAccountContextPurposeV1, type ExternalActionRequesterInvocationV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { decodeBase64 } from '@happier-dev/protocol/crypto/base64';
import type { ManagedMachinePolicyRequest } from '../startup/managedMachineActionAdapter';
import { computePluginUiSelectedActionInputDigestV1 } from '@happier-dev/protocol/plugins/ui/selectedActionInput';
import { ActionInvokeInputSchema } from '@happier-dev/protocol/actions/actionInvokeInput';
import { readResolvedActionContribution } from '@/plugins/projection/registry/actions';
import { admitMountedSelectedActionInput, deriveMountedPluginInvocationCaller, type MountedAccountPluginExecutionSelectionResolver } from '@/plugins/runtime/invocation/mountedPluginInvocationCaller';
import { resolvePluginActionCaller } from '@/plugins/runtime/invocation/services/actionCaller';
import type { PluginRuntimeRegistryLease } from '@/plugins/runtime/reload/controller';
import { isManagedEnrollmentPolicyChildAccountCustody, isOriginalOwnAccountActionCustody,
  isOriginalSessionInputAccountActionCustody, readWorkflowSetupRequesterRunId } from '../sessionEncryption/requesterAccountActionProjection';
import { readRequesterAccountActionContext } from "@/daemon/sessionEncryption/requesterAccountActionContext";
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createCliApprovalsArtifactStore } from '@/session/actions/approvals/artifactStore';
import { matchesExecutingWorkflowStepApproval } from '@/daemon/workflows/actionApproval';
import { isDeploymentBackupEvidenceActionIdV1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import { createExternalActionStartDiagnosticRecorder, refuseExternalActionPhase, runExternalActionPhase, traceExternalActionStage, readSessionInputAdmissionDiagnostic } from './externalActionPhase';
import { setApprovalTraceArtifactId, timeApprovalPhase, timeApprovalPhaseSync, timeWebLatencyPhase, withApprovalActionTrace, withWebLatencyTrace } from './webLatencyTrace';
import { AccountSettingsContentInvalidError } from '@/settings/accountSettings/accountSettingsRefreshError';
import { parseActionExecuteFailure, projectActionFailureCauseV1, projectUnexpectedActionFailureV1,
  type ActionExecuteFailure, type ActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { readRequesterHomeActionFailure, rethrowRequesterHomeReadFailure } from '@/daemon/sessionEncryption/requesterCurrentness';
import { ManagedMachineControllerError } from '@/machines/managed/controllerErrors';
import { logger } from '@/ui/logger';
import type { RpcActionExecutorContext } from '@/rpc/handlers/_actionDispatchAdapter';
import { preparedResponse, beforeEffectResponse } from './response';
import { retainVerifiedExternalActionRequester } from '@/daemon/agentIsolation/agentIsolationLaunchPolicy';
import { sameMachineServiceLogsResourceInput, parseMachineServiceLogsResourceResponse } from './machineServiceLogsResource';
import type { RpcHandlerContext } from '@/api/rpc/types';
import { projectRpcRequesterWorkAttribution } from '@/daemon/lifecycle/requesterWorkAttribution';

type PublicOutputValidationResult =
  | Readonly<{ success: true; data: unknown }>
  | Readonly<{ success: false }>;

type PublicOutputRuntimeSchema = Readonly<{
  safeParse(value: unknown): PublicOutputValidationResult;
}>;

// The generated map retains exact per-Action result types for SDK consumers.
// This transport needs only its shared runtime parser contract; erasing the
// per-key generic here avoids asking TypeScript to instantiate the complete
// public Action result cross-product for one dynamic Action id.
const SIGNED_ROOT_ACTION_OUTPUT_RUNTIME_SCHEMAS: Readonly<Record<SignedRootActionId, PublicOutputRuntimeSchema>> =
  SIGNED_ROOT_ACTION_OUTPUT_SCHEMAS;

export type ExternalActionPrincipal =
  | ExternalActionServerPrincipalV1
  | Readonly<{
      authority: NonNullable<ActionExecutorContext['authority']>;
    }>;

export type ExternalActionExecutor = Readonly<{
  execute: (
    actionId: SignedRootActionId,
    input: unknown,
    context?: ActionExecutorContext,
  ) => Promise<ActionExecuteResult>;
  observeSessionBirth?: (actionInput: unknown, context: ActionExecutorContext) =>
    Promise<SessionSpawnNewResultV1 | null>;
}>;

/**
 * The daemon's target owner resolves the request target immediately before the
 * canonical Action executor runs. `null` means this daemon must not execute it.
 */
export type ResolveExternalActionTarget = (input: Readonly<{
  actionId: SignedRootActionId;
  /** Decoded Action input when checking live ingress placement. Origin-only checks have no input. */
  actionInput?: unknown;
  target: ExternalActionTargetV1 | undefined;
  currentMachineId: string;
  context?: Pick<ActionExecutorContext, 'actionCaller' | 'surface'>;
  onAdmittedSessionMachine?: (machineId: string) => void;
  signal?: AbortSignal;
}>) => Promise<ExternalActionTargetV1 | null>;

/** Existing daemon credential and stable Home identity, resolved at invocation. */
export type ResolveExternalActionEncryption = (signal?: AbortSignal, authorization?: ExternalActionExecutionAuthorizationV1) => Promise<Readonly<{
  serverIdentityId: string;
  material: Readonly<{ type: 'dataKey'; machineKey: Uint8Array }>;
}> | null>;

/** Home currentness at the reached executor admission boundary, not a cached grant. */
export type VerifyExternalActionExecutionAuthorization = (input: Readonly<{
  authorization: ExternalActionExecutionAuthorizationV1;
  effectActionId: string;
  target: ExternalActionTargetV1;
  signal?: AbortSignal;
}>) => Promise<boolean>;

/**
 * Installation-admitted private custody selects the existing invocation factory.
 * Its canonical preparation owner proves fresh Home admission before using
 * requester credentials; the resolved effect is verified separately below.
 */
export type PrepareExternalActionRequesterAccountContext = (input: Readonly<{
  authorization: ExternalActionExecutionAuthorizationV1;
  purpose?: ExternalActionRequesterAccountContextPurposeV1;
  /** Private SOURCE admission rechecks the installed controller without impersonating the finite worker. */
  verifyWorkspaceSyncPrepareCurrent?: () => Promise<boolean>;
  verifyServiceMoveChildCurrent?: () => Promise<boolean>;
  /** Already Home-admitted original child packet; a private continuation, never Action input. */
  deploymentChildExecution?: import('@happier-dev/protocol/socketRpc').WorkspaceSyncSourceExecutionV1;
  signal?: AbortSignal;
}>) => Promise<Readonly<{
  authorization: ExternalActionExecutionAuthorizationV1;
  executor: ExternalActionExecutor;
  /** Verified HTTP PAT captured only for this live request and its original waiter. */
  resolveEncryption: ResolveExternalActionEncryption;
  /** Admitted policy from this requester holder for reviewed-child approval replay. */
  actionsSettings?: NonNullable<ActionExecutorContext['actionsSettings']>;
  /** Target reads use the same privately admitted Account as the effect. */
  resolveTarget?: ResolveExternalActionTarget;
  invocation?: import('@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1').ExternalActionRequesterInvocationV1;
  /** Host-only continuation of this exact finite wake, never a public executor ABI. */
  executeManagedFiniteWake?: (request: ManagedMachinePolicyRequest) => Promise<ActionExecuteResult>;
  dispose(): Promise<void>;
}> | null>;

export type ExecuteExternalActionResult = Readonly<
  | {
    kind: 'invalid_request';
    errorCode: 'invalid_action' | 'invalid_envelope' | 'invalid_encrypted_envelope' | 'encrypted_action_unsupported' | 'request_too_large' | 'target_required' | 'target_unavailable' | 'project_requester_home_unavailable' | 'internal_error' | 'credential_scope_denied' | 'invalid_token' | 'cancelled';
    requestId?: string;
    failureCause?: ActionFailureCauseV1;
  }
  | {
    kind: 'response';
    /** Semantic envelope for local inspection; transport adapters use `prepared`. */
    response: PreparedExternalActionResponseEnvelope['response'];
    /** Both HTTP origins consume this one canonical serialized projection. */
    prepared: PreparedExternalActionResponseEnvelope;
  }
>;

/**
 * Transport-neutral external Action admission. Authentication and target
 * ownership are supplied by the daemon boundary. A mounted-plugin claim can
 * narrow the caller only after local runtime admission; it cannot supply Action
 * authority, trusted caller provenance, or execution context.
 */
export async function executeExternalAction(input: Parameters<typeof executeExternalActionRequest>[0]): Promise<ExecuteExternalActionResult> {
  if (input.actionId !== 'approval.request.decide') return executeExternalActionRequest(input);
  return withApprovalActionTrace(input.actionId,
    () => timeApprovalPhase('approval.external_dispatch', () => executeExternalActionRequest(input)),
    input.executionAuthorization?.binding.approvalDecisionAdmission?.artifactId, input.transportRequestId);
}

async function executeExternalActionRequest(input: Readonly<{
  actionId: unknown;
  envelope: unknown;
  principal: ExternalActionPrincipal;
  currentMachineId: string;
  /**
   * The exact Session this receiver executes inside, when it has exactly one —
   * a restricted Runner. It makes the Session arm of the pre-open target guard
   * decidable here, symmetric to `currentMachineId`. An ordinary daemon hosts
   * many Sessions, supplies none, and keeps deciding at `resolveTarget`.
   */
  currentSessionId?: string;
  /** Daemon-owned local profile id used for routing; never accepted from the envelope. */
  currentServerId?: string;
  /** Account admitted by the private receiving host; never an envelope field. */
  currentAccountId?: string;
  /** Produced only by the authenticated installed private-root route. */
  authenticatedLocalRootCustody?: RpcActionExecutorContext['authenticatedLocalRootCustody'];
  /** Stamped by authenticated private terminal ingress, never accepted from an envelope. */
  localRootInvocation?: ExternalActionRequesterInvocationV1;
  /** Exact Home URL captured by the receiving host, never supplied by the envelope. */
  currentServerHttpBaseUrl?: string;
  /** Exact receiving installation, supplied by the host rather than the envelope. */
  currentInstallationId?: string;
  /** Live installed-key witness; embeddings without it retain their admission verifier guard. */
  isInstallationCurrent?: () => boolean;
  verifyExecutionAuthorization?: VerifyExternalActionExecutionAuthorization;
  resolveEncryption?: ResolveExternalActionEncryption;
  prepareRequesterAccountContext?: PrepareExternalActionRequesterAccountContext;
  resolveTarget: ResolveExternalActionTarget;
  executor: ExternalActionExecutor;
  /** Only the authenticated Home transport may request this passive observation. */
  observeSessionBirth?: true;
  /** The daemon's existing runtime lease owner, never chosen by the caller. */
  acquirePluginRuntimeRegistryLease?: () => Promise<PluginRuntimeRegistryLease>;
  /** Live receiving Home/Machine identity from the canonical machine owner. */
  resolvePluginExecutionOriginContext?: Parameters<typeof deriveMountedPluginInvocationCaller>[0]['resolveExecutionOriginContext'];
  resolveAccountPluginExecutionSelection?: MountedAccountPluginExecutionSelectionResolver;
  /** Host-owned ingress classification; never accepted from an external envelope. */
  surface?: 'ui' | 'cli' | 'mcp';
  /** Home-minted invocation authority relayed or exchanged at admission. */
  executionAuthorization?: ExternalActionExecutionAuthorizationV1;
  /** Existing installation private key; never serialized into Action context or approval storage. */
  externalActionMachineRequestPrivateKey?: string | Uint8Array;
  /** Host transport diagnostics only; never authority or Action input. */
  transportRequestId?: string;
  /** Home-produced Machine facts from the closed receiving transport, never Action input. */
  machineAdmission?: RpcActionExecutorContext['machineAdmission'];
  /** Exact installed Resource dispatcher; only the verified original logs invocation reaches it. */
  sendHostResourceWatchFrame?: RpcHandlerContext['sendHostResourceWatchFrame'];
  invokeResource?: (method: string, params: unknown, context: RpcHandlerContext) => Promise<unknown>;
  signal?: AbortSignal;
  /** Receiving host progress sink; never accepted from an Action envelope. */
  operationOwnerUpdate?: ActionExecutorContext['operationOwnerUpdate'];
}>): Promise<ExecuteExternalActionResult> {
  // Keep both public HTTP origins deterministic: first accept the bounded path
  // scalar, then validate the transport envelope, and only then ask the
  // daemon-owned registry whether that scalar names a public Action.
  const externalActionId = ExternalActionActionIdV1Schema.safeParse(input.actionId);
  if (!externalActionId.success) {
    const requestId = readExternalActionProtectedRequestId(input.envelope);
    return {
      kind: 'invalid_request',
      errorCode: 'invalid_action',
      ...(requestId === undefined ? {} : { requestId }),
    };
  }

  const envelope = ExternalActionRequestEnvelopeSchema.safeParse(input.envelope);
  if (!envelope.success) {
    const requestId = readExternalActionProtectedRequestId(input.envelope);
    return {
      kind: 'invalid_request',
      errorCode: 'invalid_envelope',
      ...(requestId === undefined ? {} : { requestId }),
    };
  }
  if (!isExternalActionRequestWithinLimit(envelope.data)) {
    return {
      kind: 'invalid_request',
      errorCode: 'request_too_large',
      ...(envelope.data.v === 2 ? { requestId: envelope.data.requestId } : {}),
    };
  }

  const trace = (stage: string) => traceExternalActionStage(input.actionId, envelope.data.requestId, stage, input.transportRequestId);
  trace('daemon.admitted_envelope');

  const apiTokenPrincipal = 'credentialId' in input.principal ? input.principal : null;
  const accountPrincipal = 'authentication' in input.principal ? input.principal : null;
  const sessionActionOrigin = accountPrincipal && 'sessionActionOrigin' in accountPrincipal
    ? accountPrincipal.sessionActionOrigin : null;
  const workflowActionOrigin = accountPrincipal && 'workflowActionOrigin' in accountPrincipal
    ? accountPrincipal.workflowActionOrigin : null;
  const actionId = apiTokenPrincipal
    ? PublicActionIdSchema.safeParse(externalActionId.data)
    : SignedRootActionIdSchema.safeParse(externalActionId.data);
  if (!actionId.success || (isPluginProvenanceOnlyActionId(externalActionId.data) && !envelope.data.pluginInvocation)) {
    return {
      kind: 'invalid_request',
      errorCode: 'invalid_action',
      ...(envelope.data.v === 2 ? { requestId: envelope.data.requestId } : {}),
    };
  }

  const executionAuthorization = input.executionAuthorization === undefined
    ? undefined
    : ExternalActionExecutionAuthorizationV1Schema.safeParse(input.executionAuthorization);
  const authorizationPrincipalMatches = executionAuthorization?.success && (
    accountPrincipal
      ? 'authentication' in executionAuthorization.data.binding
        && executionAuthorization.data.binding.accountId === accountPrincipal.accountId
        && sameStrictJsonValue(executionAuthorization.data.binding.authentication, accountPrincipal.authentication)
        && sameStrictJsonValue(executionAuthorization.data.binding.sessionActionOrigin, sessionActionOrigin ?? undefined)
        && sameStrictJsonValue(executionAuthorization.data.binding.workflowActionOrigin, workflowActionOrigin ?? undefined)
      : apiTokenPrincipal && 'credentialId' in executionAuthorization.data.binding
        && executionAuthorization.data.binding.accountId === apiTokenPrincipal.accountId
        && executionAuthorization.data.binding.principalId === apiTokenPrincipal.principalId
        && executionAuthorization.data.binding.credentialId === apiTokenPrincipal.credentialId
  );
  const refusedAuthorizationPhase = accountPrincipal && executionAuthorization === undefined ? 'authorization_required'
    : executionAuthorization === undefined ? null
    : !executionAuthorization.success ? 'authorization_schema'
    : !input.externalActionMachineRequestPrivateKey ? 'authorization_signing_key'
    : !authorizationPrincipalMatches ? 'authorization_principal'
    : input.currentServerId === undefined ? 'authorization_home'
    : input.currentInstallationId === undefined ? 'authorization_receiving_installation'
    : !input.verifyExecutionAuthorization ? 'authorization_verifier'
    : executionAuthorization.data.binding.machineId !== input.currentMachineId ? 'authorization_machine'
    : executionAuthorization.data.binding.installationId !== input.currentInstallationId ? 'authorization_installation'
    : executionAuthorization.data.binding.actionId !== actionId.data ? 'authorization_action'
    // Ordinary PAT V1 deliberately permits Home-readable transport. Account
    // mode requires V2 for signed private origination, as at Home issuance.
    : (accountPrincipal && executionAuthorization.data.binding.accountEncryptionMode !== undefined
        && !isExternalActionRequestVersionAllowedForAccountModeV1({
          accountEncryptionMode: executionAuthorization.data.binding.accountEncryptionMode, envelopeVersion: envelope.data.v,
        })) ? 'authorization_account_mode'
    : executionAuthorization.data.binding.requestEnvelopeDigest !== computeExternalActionRequestEnvelopeDigestV1(envelope.data) ? 'authorization_envelope_digest'
    : (envelope.data.requestId !== undefined && executionAuthorization.data.binding.requestId !== envelope.data.requestId) ? 'authorization_request_id'
    : !externalActionTargetsEqualV1(
        executionAuthorization.data.binding.target,
        envelope.data.target ?? { kind: 'machine', machineId: input.currentMachineId },
      ) ? 'authorization_target' : null;
  if (refusedAuthorizationPhase) {
    refuseExternalActionPhase(refusedAuthorizationPhase, input.currentMachineId, undefined, {
      ...readSessionInputAdmissionDiagnostic({ actionId: actionId.data, requestId: envelope.data.requestId,
        accountEncryptionMode: executionAuthorization?.success ? executionAuthorization.data.binding.accountEncryptionMode : undefined }),
      envelopeVersion: envelope.data.v,
      refusalBranch: refusedAuthorizationPhase,
    });
    return {
      kind: 'invalid_request',
      errorCode: envelope.data.v === 2 ? 'invalid_encrypted_envelope' : 'invalid_envelope',
      ...(envelope.data.requestId === undefined ? {} : { requestId: envelope.data.requestId }),
    };
  }

  const cancelledBeforeOpen = () => ({ kind: 'invalid_request', errorCode: 'cancelled',
    ...(envelope.data.requestId === undefined ? {} : { requestId: envelope.data.requestId }) } as const);
  let requesterContext: Awaited<ReturnType<PrepareExternalActionRequesterAccountContext>> = null;
  const managedControllerCodec = executionAuthorization?.success
    && (executionAuthorization.data.binding.accountId !== executionAuthorization.data.binding.custodianAccountId
      || executionAuthorization.data.binding.requesterOperationRead
      || executionAuthorization.data.binding.telemetryCollectorCodec
      || isReviewedMachineSetupCodecV1(executionAuthorization.data.binding))
    && isManagedControllerCodecRootV1(executionAuthorization.data.binding);
  let envelopeCodecMaterial: Readonly<{ type: 'dataKey'; machineKey: Uint8Array }> | null = null;
  let controllerInvocation: import('@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1').ExternalActionRequesterInvocationV1 | undefined;
  let machineSetupAppBlockIds: ActionExecutorContext['machineSetupAppBlockIds'];
  let managedReviewedParent: HostReviewedParentV1 | undefined;
  let managedSessionCreationTag: ActionExecutorContext['managedContinuationSessionCreationTag'];
  // The opening target Home already proved for this root; an unchanged resolved
  // target spends that one admission rather than repeating the same POST.
  let rootAdmittedTarget: ExternalActionTargetV1 | undefined;
  if (managedControllerCodec && executionAuthorization?.success) {
    const authorization = executionAuthorization.data;
    if (authorization.binding.requesterOperationRead && (envelope.data.v !== 2 || !envelope.data.requesterOperationRead
      || input.machineAdmission?.actorAccountId !== authorization.binding.accountId
      || input.machineAdmission.installationId !== authorization.binding.installationId)) {
      return { kind: 'invalid_request', errorCode: 'invalid_encrypted_envelope', requestId: envelope.data.requestId };
    }
    const current = await runExternalActionPhase('managed_controller_codec_currentness', input.currentMachineId, () =>
      input.verifyExecutionAuthorization!({ authorization, effectActionId: actionId.data,
        target: authorization.binding.target, ...(input.signal ? { signal: input.signal } : {}) }), input.signal);
    if (current.ok && input.signal?.aborted) return cancelledBeforeOpen();
    const opened = current.ok && current.value ? openManagedControllerActionCodecV1({
      authorization, machineId: input.currentMachineId, installationId: input.currentInstallationId!,
      includeInvocation: true,
      serverIdentityId: authorization.binding.serverIdentityId,
      installationPrivateKey: typeof input.externalActionMachineRequestPrivateKey === 'string'
        ? decodeBase64(input.externalActionMachineRequestPrivateKey, 'base64url') : input.externalActionMachineRequestPrivateKey!,
    }) : null;
    envelopeCodecMaterial = opened?.material ?? null;
    controllerInvocation = opened?.invocation;
    machineSetupAppBlockIds = opened?.machineSetupAppBlockIds;
    if (!envelopeCodecMaterial) return { kind: 'invalid_request',
      errorCode: !current.ok && current.executionFailure ? current.executionFailure.errorCode
        : envelope.data.v === 2 ? 'invalid_encrypted_envelope' : 'invalid_envelope',
      ...(!current.ok && current.executionFailure?.failureCause ? { failureCause: current.executionFailure.failureCause } : {}),
      ...(envelope.data.requestId ? { requestId: envelope.data.requestId } : {}) };
    rootAdmittedTarget = authorization.binding.target;
  }
  if (envelope.data.managedCreationCodec) {
    const authorization = executionAuthorization?.success ? executionAuthorization.data : undefined;
    const current = authorization && await runExternalActionPhase('managed_creation_codec_currentness', input.currentMachineId, () =>
      input.verifyExecutionAuthorization!({ authorization, effectActionId: actionId.data,
        target: authorization.binding.target, ...(input.signal ? { signal: input.signal } : {}) }), input.signal);
    if (current?.ok && input.signal?.aborted) return cancelledBeforeOpen();
    const opened = authorization && current && current.ok && current.value
      ? openManagedCreationActionCodecV1({ authorization, envelope: envelope.data, includeInvocation: true,
        machineId: input.currentMachineId, installationId: input.currentInstallationId!,
        serverIdentityId: authorization.binding.serverIdentityId,
        installationPrivateKey: typeof input.externalActionMachineRequestPrivateKey === 'string'
          ? decodeBase64(input.externalActionMachineRequestPrivateKey, 'base64url') : input.externalActionMachineRequestPrivateKey!,
      }) : null;
    envelopeCodecMaterial = opened?.material ?? null;
    controllerInvocation = opened?.invocation;
    if (!opened || managedControllerCodec) return { kind: 'invalid_request',
      errorCode: current && !current.ok && current.executionFailure ? current.executionFailure.errorCode
        : envelope.data.v === 2 ? 'invalid_encrypted_envelope' : 'invalid_envelope',
      ...(current && !current.ok && current.executionFailure?.failureCause ? { failureCause: current.executionFailure.failureCause } : {}),
      requestId: envelope.data.requestId };
    managedReviewedParent = opened.reviewedParent;
    managedSessionCreationTag = opened.sessionCreationTag;
    rootAdmittedTarget = authorization?.binding.target;
  }
  let pluginRuntimeLease: PluginRuntimeRegistryLease | null = null;
  // Diagnose the ordinary input corridor without serializing its carrier or
  // amplifying unrelated background Action traffic. Logs never affect admission.
  const diagnoseSessionInput = (stage: string, branch: string) => {
    const diagnostic = readSessionInputAdmissionDiagnostic({ actionId: actionId.data, requestId: envelope.data.requestId,
      accountEncryptionMode: executionAuthorization?.success ? executionAuthorization.data.binding.accountEncryptionMode : undefined });
    if (!diagnostic) return;
    try { logger.infoFile('[SessionInputAdmission]', {
      ...diagnostic, stage, branch, envelopeVersion: envelope.data.v,
    }); } catch { /* File diagnostics cannot change custody. */ }
  };
  const prepareOwnAccount = executionAuthorization?.success && input.prepareRequesterAccountContext !== undefined
    && (isOriginalOwnAccountActionCustody(executionAuthorization.data.binding)
      || isOriginalSessionInputAccountActionCustody(executionAuthorization.data.binding)
      || (managedReviewedParent?.actionId === MANAGED_ACQUIRE_ACTION_ID_V1
        && isManagedEnrollmentPolicyChildAccountCustody(executionAuthorization.data.binding)));
  // A member's reviewed Setup leaf keeps its codec for the envelope and spends its
  // Run's retained requester custody when this installation hosts that Run.
  const workflowSetupRequester = managedControllerCodec && executionAuthorization?.success
    && input.prepareRequesterAccountContext !== undefined
    && readWorkflowSetupRequesterRunId(executionAuthorization.data.binding) !== null;
  if ((!managedControllerCodec || workflowSetupRequester) && executionAuthorization?.success
    && (executionAuthorization.data.requesterAccountContext || prepareOwnAccount)) {
    const authorization = executionAuthorization.data;
    diagnoseSessionInput('requester_prepare', 'started');
    if (!input.prepareRequesterAccountContext) return { kind: 'invalid_request',
      errorCode: envelope.data.v === 2 ? 'invalid_encrypted_envelope' : 'invalid_envelope',
      ...(envelope.data.requestId ? { requestId: envelope.data.requestId } : {}) };
    trace('requester_prepare.begin');
    const preparedRequester = await runExternalActionPhase('requester_prepare', input.currentMachineId, () =>
      input.prepareRequesterAccountContext!({ authorization,
        ...(input.signal ? { signal: input.signal } : {}) }), input.signal);
    trace('requester_prepare.end');
    requesterContext = preparedRequester.ok ? preparedRequester.value : null;
    // A Run hosted on another Machine leaves no custody here: the leaf stays
    // codec-only, and a member's own opaque copy refuses typed at its opener.
    if (!requesterContext && !(workflowSetupRequester && !preparedRequester.ok && !preparedRequester.executionFailure)) {
      const requesterFailure = !preparedRequester.ok ? preparedRequester.executionFailure : undefined;
      const requesterHomeUnavailable = requesterFailure?.errorCode === 'project_requester_home_unavailable';
      diagnoseSessionInput('requester_prepare', requesterHomeUnavailable ? 'home_unavailable' : 'refused');
      if (requesterHomeUnavailable) refuseExternalActionPhase('requester_prepare', input.currentMachineId, undefined, {
        ...readSessionInputAdmissionDiagnostic({ actionId: actionId.data, requestId: envelope.data.requestId,
          accountEncryptionMode: executionAuthorization.data.binding.accountEncryptionMode }),
        refusalBranch: 'requester_home_unavailable',
      });
      return { kind: 'invalid_request',
        errorCode: requesterFailure?.errorCode ?? (envelope.data.v === 2 ? 'invalid_encrypted_envelope' : 'invalid_envelope'),
        ...(requesterFailure?.failureCause ? { failureCause: requesterFailure.failureCause } : {}),
        ...(envelope.data.requestId ? { requestId: envelope.data.requestId } : {}) };
    }
    diagnoseSessionInput('requester_prepare', 'prepared');
    rootAdmittedTarget = authorization.binding.target;
  }
  let releaseTokenContentAccess: (() => void) | undefined;
  let releaseTokenAccountProjection: (() => void) | undefined;
  try {
  if (input.signal?.aborted) return cancelledBeforeOpen();
  let decodedInput: unknown;
  let decodedWorkflowPreparation: ActionExecutorContext['workflowPreparation'];
  let registryThemeContent: ActionExecutorContext['registryThemeContent'];
  let selectedActionInputDigest: string | undefined;
  let decodedTokenContentAccess: NonNullable<ReturnType<typeof openExternalActionRequestV2>>['apiTokenContentAccess'];
  let hasProtectedLogsOperands = false;
  let logsOperands: Pick<NonNullable<ReturnType<typeof openExternalActionRequestV2>>, 'resourceContinuation' | 'machineServiceLogsGeneration'> = {};
  let prepare = preparedResponse;
  if (envelope.data.v === 2) {
    const request = envelope.data;
    if (!request.target) {
      return { kind: 'invalid_request', errorCode: 'target_required', requestId: request.requestId };
    }
    const resolveEncryption: ResolveExternalActionEncryption | undefined = envelopeCodecMaterial && executionAuthorization?.success
      ? async () => ({ serverIdentityId: executionAuthorization.data.binding.serverIdentityId, material: envelopeCodecMaterial! })
      : requesterContext?.resolveEncryption ?? input.resolveEncryption;
    if (!resolveEncryption) return {
      kind: 'invalid_request', errorCode: 'encrypted_action_unsupported', requestId: request.requestId,
    };
    trace('encryption_resolution.begin');
    const encryptionPhase = await runExternalActionPhase('encryption_resolution', input.currentMachineId, () => resolveEncryption(
      input.signal,
      executionAuthorization?.success ? executionAuthorization.data : undefined,
    ), input.signal);
    trace('encryption_resolution.end');
    if (encryptionPhase.ok ? input.signal?.aborted : encryptionPhase.executionFailure?.errorCode === 'cancelled') {
      return cancelledBeforeOpen();
    }
    const encryption = encryptionPhase.ok ? encryptionPhase.value : null;
    diagnoseSessionInput('encryption_resolution', encryption ? 'resolved' : 'unavailable');
    if (!encryption) return {
      kind: 'invalid_request', errorCode: 'encrypted_action_unsupported', requestId: request.requestId,
    };
    if (!apiTokenPrincipal && !accountPrincipal) {
      diagnoseSessionInput('strict_envelope_open', 'principal_refused');
      refuseExternalActionPhase('encryption_principal', input.currentMachineId);
      return { kind: 'invalid_request', errorCode: 'invalid_encrypted_envelope', requestId: request.requestId };
    }
    const binding: ExternalActionEncryptionBindingV2 = {
      serverIdentityId: encryption.serverIdentityId, accountId: apiTokenPrincipal?.accountId ?? accountPrincipal!.accountId,
      ...(apiTokenPrincipal ? { credentialId: apiTokenPrincipal.credentialId }
        : { authentication: { kind: accountPrincipal!.authentication.kind, tokenEpoch: accountPrincipal!.authentication.tokenEpoch } }),
      actionId: actionId.data,
      requestId: request.requestId, target: request.target,
    };
    // A target this receiver cannot be is refused before anything is opened.
    // Both arms are the same question — is this envelope addressed to me — and
    // a receiver bound to one Session can answer the Session arm here, so a
    // Home-authored Session-to-Runner correspondence cannot redirect a request
    // into another Runner's plaintext.
    const foreignTarget = request.target.kind === 'machine'
      ? request.target.machineId !== input.currentMachineId
      : input.currentSessionId !== undefined && request.target.sessionId !== input.currentSessionId;
    if (foreignTarget) {
      diagnoseSessionInput('strict_envelope_open', 'receiver_refused');
      refuseExternalActionPhase('encryption_receiver', input.currentMachineId);
      return { kind: 'invalid_request', errorCode: 'invalid_encrypted_envelope', requestId: request.requestId };
    }
    const opened = timeApprovalPhaseSync('approval.external.request_open', () => openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope: request, binding, material: encryption.material,
      onFailure: failure => { refuseExternalActionPhase(failure.phase, input.currentMachineId, failure.error, {
        ...readSessionInputAdmissionDiagnostic({ actionId: actionId.data, requestId: request.requestId,
          accountEncryptionMode: executionAuthorization?.success ? executionAuthorization.data.binding.accountEncryptionMode : undefined }),
        envelopeVersion: request.v,
        refusalBranch: 'strict_open',
      }); } }));
    diagnoseSessionInput('strict_envelope_open', opened ? 'opened' : 'refused');
    if (!opened) {
      return { kind: 'invalid_request', errorCode: 'invalid_encrypted_envelope', requestId: request.requestId };
    }
    decodedInput = opened.input;
    decodedWorkflowPreparation = opened.workflowPreparation;
    registryThemeContent = opened.registryThemeContent;
    selectedActionInputDigest = opened.selectedActionInputDigest;
    // Whole-Action transport encryption does not imply Account content custody.
    decodedTokenContentAccess = doesExternalActionConsumeRequesterAccountContentV1({ actionId: actionId.data,
      input: opened.input, target: binding.target })
      ? opened.apiTokenContentAccess : undefined;
    if (decodedTokenContentAccess && (!apiTokenPrincipal || !executionAuthorization?.success
      || executionAuthorization.data.binding.accountEncryptionMode !== 'e2ee')) {
      return { kind: 'invalid_request', errorCode: 'invalid_encrypted_envelope', requestId: request.requestId };
    }
    logsOperands = { ...(opened.resourceContinuation ? { resourceContinuation: opened.resourceContinuation } : {}),
      ...(opened.machineServiceLogsGeneration ? { machineServiceLogsGeneration: opened.machineServiceLogsGeneration } : {}) };
    hasProtectedLogsOperands = opened.resourceContinuation !== undefined || opened.machineServiceLogsGeneration !== undefined;
    prepare = (response) => timeApprovalPhaseSync('approval.external.response_prepare', () => {
      const prepared = prepareExternalActionResponseV2({ binding, request, execution: response.execution,
        executedMachineId: input.currentMachineId, material: encryption.material, randomBytes });
      return { kind: 'response', response: prepared.response, prepared };
    });
  } else {
    diagnoseSessionInput('strict_envelope_open', 'plain_v1');
    decodedInput = envelope.data.input;
    decodedWorkflowPreparation = envelope.data.workflowPreparation;
    registryThemeContent = envelope.data.registryThemeContent;
    selectedActionInputDigest = envelope.data.selectedActionInputDigest;
    logsOperands = envelope.data;
    hasProtectedLogsOperands = envelope.data.resourceContinuation !== undefined || envelope.data.machineServiceLogsGeneration !== undefined;
  }

  // Native inventory retains its admitted invocation codec without Account
  // credentials. Credential-consuming Resources still need requester custody.
  if (hasProtectedLogsOperands && ((!requesterContext && !managedControllerCodec)
    || !executionAuthorization?.success || logsOperands.resourceContinuation && !input.invokeResource
    || !sameMachineServiceLogsResourceInput(decodedInput, logsOperands, input.currentMachineId, actionId.data))) return { kind: 'invalid_request',
    errorCode: envelope.data.v === 2 ? 'invalid_encrypted_envelope' : 'invalid_envelope',
    ...(envelope.data.requestId ? { requestId: envelope.data.requestId } : {}) };

  if (input.sendHostResourceWatchFrame && (logsOperands.resourceContinuation?.method !== RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_OPEN
    || logsOperands.resourceContinuation.params.resource.hostRead === 'database.connection')) {
    return { kind: 'invalid_request', errorCode: envelope.data.v === 2 ? 'invalid_encrypted_envelope' : 'invalid_envelope',
      requestId: envelope.data.requestId };
  }

  let effectMayHaveStarted = false;
  const prepareResponse = prepare;
  prepare = response => prepareResponse(effectMayHaveStarted ? response : beforeEffectResponse(response));

  const selection = requesterContext?.invocation?.selectedActionInput;
  const selectedCarrier = selection?.carrier;
  if (selectedActionInputDigest !== undefined || selection !== undefined) {
    const projection = selection && projectPrivateMountedDatabaseReadInputV1(selection.input);
    const outerOperands = readRecord(readRecord(selection?.input).input);
    const selectedOperands = readRecord(selection?.carrier.result.input);
    if (!executionAuthorization?.success || !envelope.data.pluginInvocation || actionId.data !== ACTION_INVOKE_ACTION_ID_V1
      || !selection || !projection || computePluginUiSelectedActionInputDigestV1(selection) !== selectedActionInputDigest
      || !sameStrictJsonValue(projection, decodedInput)
      || !sameStrictJsonValue(selectedOperands.target, projection.input.target)
      || !sameStrictJsonValue(selectedOperands.recordKey, outerOperands.recordKey)
      || (outerOperands.sourceSelection !== undefined
        && !sameStrictJsonValue(outerOperands.sourceSelection, selection.carrier.result.selection))
      || (outerOperands.role !== undefined && outerOperands.role !== selection.carrier.operation.role)) {
      return prepare({ v: 1, actionId: actionId.data, requestId: envelope.data.requestId,
        execution: { ok: false, errorCode: 'plugin_selected_action_input_invalid', error: 'plugin_selected_action_input_invalid' } });
    }
    decodedInput = selection.input;
  }

  // Signed outer admission facts and private opened input must describe the
  // same invocation before approval, native submission or Session birth.
  try {
    const appAdmission = executionAuthorization?.success ? executionAuthorization.data.binding.registryAppUpdateAdmission : undefined;
    if (executionAuthorization?.success
      && (!sameStrictJsonValue(appAdmission, projectRegistryAppUpdateAdmissionV1(actionId.data, decodedInput))
        || envelope.data.v === 2 && !sameStrictJsonValue(appAdmission, envelope.data.registryAppUpdateAdmission)))
      throw new TypeError('Registry app update admission mismatch');
    const decisionAdmission = executionAuthorization?.success ? executionAuthorization.data.binding.approvalDecisionAdmission : undefined;
    const expectedRead = projectDeploymentReadAdmissionV1(actionId.data, decodedInput);
    const metadataEnvironmentId = projectExternalActionDeploymentMetadataEnvironmentIdV1(actionId.data, decodedInput);
    if (executionAuthorization?.success && metadataEnvironmentId !== undefined
      && executionAuthorization.data.binding.environmentId !== metadataEnvironmentId) {
      throw new TypeError('Metadata Environment admission mismatch');
    }
    if (executionAuthorization?.success && executionAuthorization.data.binding.deploymentLinkAdmission !== undefined
      && executionAuthorization.data.binding.deploymentLinkAdmission.environmentId
        !== projectExternalActionDeploymentLinkEnvironmentIdV1(actionId.data, decodedInput)) {
      throw new TypeError('Link Environment admission mismatch');
    }
    const preparationAdmission = executionAuthorization?.success ? executionAuthorization.data.binding.deploymentPreparationAdmission : undefined;
    const expectedNative = projectDeploymentNativeAdmissionV1(actionId.data, decodedInput);
    const nativeAdmission = executionAuthorization?.success ? executionAuthorization.data.binding.deploymentNativeAdmission : undefined;
    if (executionAuthorization?.success && ((nativeAdmission?.environmentId
      ?? (actionId.data === 'action.operations.get' || actionId.data === 'deployments.teardown'
        ? executionAuthorization.data.binding.environmentId : executionAuthorization.data.binding.deploymentCandidatePublication?.environmentId))
      !== expectedNative?.environmentId
      || isDeploymentBackupNativeAdmissionV1(expectedNative)
        && (!sameStrictJsonValue(nativeAdmission, expectedNative)
          || envelope.data.v === 2 && !sameStrictJsonValue(nativeAdmission, envelope.data.deploymentNativeAdmission)))) {
      throw new TypeError('Native deployment admission mismatch');
    }
    if (executionAuthorization?.success
      && (!sameStrictJsonValue(preparationAdmission, projectDeploymentPreparationAdmissionV1(actionId.data, decodedInput))
        || envelope.data.v === 2 && !sameStrictJsonValue(preparationAdmission, envelope.data.deploymentPreparationAdmission)))
      throw new TypeError('Deployment preparation admission mismatch');
    if (preparationAdmission && executionAuthorization?.success) {
      const root = decodedInput && typeof decodedInput === 'object' ? decodedInput : null;
      const workspace = root && 'workspace' in root && root.workspace && typeof root.workspace === 'object' ? root.workspace : null;
      // Setup roots name their Home as homeId; Reboot spends the same admission but its public input names serverId.
      const setupHomeField = MACHINE_REBOOT_ACTION_IDS.some(id => id === actionId.data) ? 'serverId' : 'homeId';
      const home = preparationAdmission.operation === 'setup' ? root && setupHomeField in root ? Reflect.get(root, setupHomeField) : null
        : preparationAdmission.operation === 'prepare' ? workspace && 'serverId' in workspace ? workspace.serverId : null
          : root && 'serverId' in root ? root.serverId : null;
      if (typeof home !== 'string' || !await isServerProfileHomeIdentity(home, executionAuthorization.data.binding.serverIdentityId))
        throw new TypeError('Deployment preparation Home mismatch');
    }
    const readAdmission = executionAuthorization?.success ? executionAuthorization.data.binding.deploymentReadAdmission : undefined;
    if (executionAuthorization?.success
      && (!sameStrictJsonValue(expectedRead, readAdmission)
        || envelope.data.v === 2 && !sameStrictJsonValue(readAdmission, envelope.data.deploymentReadAdmission)))
      throw new TypeError('Deployment read admission mismatch');
    if (expectedRead && executionAuthorization?.success) {
      const home = readDeploymentReadAdmissionHomeIdV1(expectedRead, decodedInput);
      if (!home || !await isServerProfileHomeIdentity(home, executionAuthorization.data.binding.serverIdentityId))
        throw new TypeError('Deployment read Home mismatch');
    }
    if (decisionAdmission && (actionId.data !== 'approval.request.decide'
      || !sameStrictJsonValue(decisionAdmission, projectExternalActionApprovalDecisionAdmissionV1(decodedInput)))
      || envelope.data.v === 2 && !sameStrictJsonValue(decisionAdmission, envelope.data.approvalDecisionAdmission)) {
      throw new TypeError('Approval decision admission mismatch');
    }
    if (actionId.data === 'approval.request.decide' && decisionAdmission) setApprovalTraceArtifactId(decisionAdmission.artifactId);
    if (projectExternalActionRunNowIdempotencyKeyV1(actionId.data, decodedInput) !== envelope.data.idempotencyKey
      || executionAuthorization?.success && executionAuthorization.data.binding.idempotencyKey !== envelope.data.idempotencyKey) {
      throw new TypeError('Manual retry identity mismatch');
    }
    const managedAdmission = projectExternalActionManagedAdmissionV1(actionId.data, decodedInput);
    if (envelope.data.managedAdmission && !sameStrictJsonValue(managedAdmission, envelope.data.managedAdmission)) {
      throw new TypeError('Managed admission input mismatch');
    } else if (managedAdmission && envelope.data.v === 2 && !envelope.data.managedAdmission) {
      throw new TypeError('Missing managed admission projection');
    }
    const recoveryAdmission = executionAuthorization?.success ? executionAuthorization.data.binding.managedAdmission : undefined;
    const recoveryOperand = projectExternalActionManagedAdmissionOperandV1(recoveryAdmission);
    if (recoveryOperand && !sameStrictJsonValue(managedAdmission, recoveryOperand)) {
      throw new TypeError('Managed recovery input mismatch');
    }
    const sessionPresetAcquisition = executionAuthorization?.success
      ? executionAuthorization.data.binding.sessionPresetAcquisition : undefined;
    if (envelope.data.sessionSpawnAdmission || sessionPresetAcquisition || envelope.data.v === 2 && actionId.data === 'session.spawn_new'
      && decodedInput && typeof decodedInput === 'object' && 'machineSetupPlanInput' in decodedInput
      && decodedInput.machineSetupPlanInput !== undefined) {
      const spawnTarget = executionAuthorization?.success
        ? executionAuthorization.data.binding.target
        : envelope.data.target;
      const serverIdentityId = executionAuthorization?.success
        ? executionAuthorization.data.binding.serverIdentityId
        : input.currentServerId;
      const admittedSpawn = actionId.data === 'session.spawn_new' && spawnTarget?.kind === 'machine'
        && serverIdentityId
        ? admitSessionSpawnNewActionInputV2(SessionSpawnNewActionInputV2Schema.parse({
            ...(decodedInput as Readonly<Record<string, unknown>>),
            executionTarget: { serverId: serverIdentityId, machineId: spawnTarget.machineId },
          }))
        : null;
      const defaults = (requesterContext?.invocation ?? controllerInvocation ?? input.localRootInvocation)?.sessionCreationDefaults;
      const projectedSpawn = admittedSpawn ? projectApiTokenSessionSpawnAdmissionV1(admittedSpawn,
        admittedSpawn.sessionPlacement?.kind === 'preset' && defaults?.managedPresetAcquisition
          ? { managedPresetAcquisition: defaults.managedPresetAcquisition } : undefined) : undefined;
      if (!projectedSpawn || !sameStrictJsonValue(projectedSpawn, envelope.data.sessionSpawnAdmission)
        || !sameStrictJsonValue(projectedSpawn.managedPresetAcquisition, sessionPresetAcquisition
          ? { selection: sessionPresetAcquisition.selection, controller: sessionPresetAcquisition.controller } : undefined))
        throw new TypeError('Session admission input mismatch');
    }
  } catch (error) {
    refuseExternalActionPhase('opened_input_admission', input.currentMachineId, error);
    return { kind: 'invalid_request', errorCode: envelope.data.v === 2 ? 'invalid_encrypted_envelope' : 'invalid_envelope',
      ...(envelope.data.requestId === undefined ? {} : { requestId: envelope.data.requestId }) };
  }

  const invocation = requesterContext?.invocation ?? controllerInvocation ?? input.localRootInvocation;
  // A creation codec is the SOURCE's packet, which may belong to another person.
  // Surface selects this Account's Require and a named Session opens delegated
  // decisions, so those facts come only from this Account's own admitted invocation.
  const ownInvocation = envelope.data.managedCreationCodec ? requesterContext?.invocation : invocation;
  const pressedSend = requesterContext?.invocation?.presentUserSessionSend;
  const sessionCreationDefaults = managedSessionCreationTag ? controllerInvocation?.sessionCreationDefaults : ownInvocation?.sessionCreationDefaults;
  const actionSurface = sessionActionOrigin || workflowActionOrigin ? 'agent' : apiTokenPrincipal ? 'api'
    : resolveExternalActionAccountInvocationSurface(accountPrincipal?.authentication.kind, ownInvocation?.surface ?? input.surface);
  const placementContext = { actionCaller: sessionActionOrigin?.caller ?? invocation?.caller, surface: actionSurface };
  const reconciliation = reconcileExternalActionTarget({
    actionId: actionId.data,
    rawInput: decodedInput,
    target: envelope.data.target,
    currentMachineId: input.currentMachineId,
    context: placementContext,
  });
  if (reconciliation.kind === 'rejected') {
    return prepare({
      v: 1,
      actionId: actionId.data,
      ...(envelope.data.requestId ? { requestId: envelope.data.requestId } : {}),
      execution: reconciliation.execution,
    });
  }

  // The final target resolver is deliberately after parsed-input reconciliation
  // so an explicit or input-derived Session is proved current immediately
  // before the canonical Action executor runs.
  let target: ExternalActionTargetV1 | null;
  let expectedSessionMachineId: string | undefined;
  trace('target_resolution.begin');
  try {
    target = await timeApprovalPhase('approval.external.target_resolution', () => (requesterContext?.resolveTarget ?? input.resolveTarget)({
      actionId: actionId.data,
      actionInput: decodedInput,
      target: reconciliation.target,
      currentMachineId: input.currentMachineId,
      context: placementContext,
      onAdmittedSessionMachine: machineId => { expectedSessionMachineId = machineId; },
      ...(input.signal ? { signal: input.signal } : {}),
    }));
  } catch (error) {
    trace('target_resolution.threw');
    refuseExternalActionPhase('target_resolution', input.currentMachineId, error, {
      ...(envelope.data.requestId ? { requestId: envelope.data.requestId } : {}),
      refusalBranch: 'target_resolution_threw',
    });
    return prepare({
      v: 1,
      actionId: actionId.data,
      ...(envelope.data.requestId ? { requestId: envelope.data.requestId } : {}),
      execution: targetUnavailable(),
    });
  }
  trace('target_resolution.end');
  if (!target) {
    return prepare({
      v: 1,
      actionId: actionId.data,
      ...(envelope.data.requestId ? { requestId: envelope.data.requestId } : {}),
      execution: targetNotLocal(reconciliation.target?.kind === 'session' ? 'target_session_locality' : 'target_machine_locality'),
    });
  }

  if (executionAuthorization?.success && !(rootAdmittedTarget && externalActionTargetsEqualV1(rootAdmittedTarget, target))) {
    trace('effect_root_currentness.begin');
    const current = await runExternalActionPhase('effect_root_currentness', input.currentMachineId, () =>
      input.verifyExecutionAuthorization!({
        authorization: executionAuthorization.data,
        effectActionId: actionId.data,
        target,
        ...(input.signal ? { signal: input.signal } : {}),
      }), input.signal);
    trace('effect_root_currentness.end');
    if (!current.ok || input.signal?.aborted) {
      return prepare({
        v: 1,
        actionId: actionId.data,
        ...(envelope.data.requestId ? { requestId: envelope.data.requestId } : {}),
        execution: current.ok ? { ok: false, errorCode: 'cancelled', error: 'cancelled' }
          : current.executionFailure ?? { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' },
      });
    }
  }

  let admittedAuthorization: ExternalActionExecutionAuthorizationV1 | undefined = executionAuthorization?.success
    ? { ...(requesterContext?.authorization ?? executionAuthorization.data) } : undefined;
  const requesterProjection = requesterContext?.authorization.requesterAccountProjection
    ?? input.executionAuthorization?.requesterAccountProjection;
  if (requesterProjection && admittedAuthorization) {
    trace('requester_account_currentness.begin');
    const current = requesterProjection.accountId === admittedAuthorization.binding.accountId
      && requesterProjection.serverId === input.currentServerId && !input.signal?.aborted
      ? await runExternalActionPhase('requester_account_currentness', input.currentMachineId,
          () => requesterProjection.isCurrent()) : null;
    if (!current?.ok) {
      return prepare({ v: 1, actionId: actionId.data,
        ...(envelope.data.requestId ? { requestId: envelope.data.requestId } : {}),
        execution: current?.executionFailure ?? { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' } });
    }
    // Strict wire parsing never accepts private ports. Preserve only the
    // already-admitted host facet; it must remain absent from serialization.
    Object.defineProperty(admittedAuthorization, 'requesterAccountProjection', { value: requesterProjection, enumerable: false });
    trace('requester_account_currentness.end');
  }
  const requesterHttpProjection = requesterContext?.authorization.requesterHttpProjection
    ?? input.executionAuthorization?.requesterHttpProjection;
  if (requesterHttpProjection && admittedAuthorization) {
    trace('requester_http_currentness.begin');
    const current = requesterHttpProjection.accountId === admittedAuthorization.binding.accountId
      && requesterHttpProjection.serverId === input.currentServerId
      && requesterHttpProjection.serverIdentityId === admittedAuthorization.binding.serverIdentityId
      && (admittedAuthorization.binding.accountEncryptionMode === undefined
        || requesterHttpProjection.accountEncryptionMode === admittedAuthorization.binding.accountEncryptionMode)
      && !input.signal?.aborted
      ? await runExternalActionPhase('requester_http_currentness', input.currentMachineId,
          () => requesterHttpProjection.isCurrent()) : null;
    if (!current?.ok || Boolean(input.signal?.aborted)) {
      return prepare({ v: 1, actionId: actionId.data,
        ...(envelope.data.requestId ? { requestId: envelope.data.requestId } : {}),
        execution: current && !current.ok && current.executionFailure
          ? current.executionFailure : { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' } });
    }
    Object.defineProperty(admittedAuthorization, 'requesterHttpProjection', { value: requesterHttpProjection, enumerable: false });
    trace('requester_http_currentness.end');
  }
  if (admittedAuthorization && input.currentServerHttpBaseUrl) {
    const projectionAuthorization = admittedAuthorization;
    const serverHttpBaseUrl = input.currentServerHttpBaseUrl;
    // A durable pending Deploy may spend the same opened Cancel through its exact Home owner.
    const cancelAddress = projectionAuthorization.binding.requesterOperationRead && actionId.data === ACTION_OPERATION_CANCEL_ACTION_ID_V1
      ? ActionOperationAddressV1Schema.safeParse(decodedInput) : undefined;
    trace('requester_http_projection.begin');
    const projection = await runExternalActionPhase('requester_http_projection', input.currentMachineId, () => projectExternalActionRequesterHttpAuthorization({
      authorization: projectionAuthorization,
      serverId: input.currentServerId!,
      serverIdentityId: projectionAuthorization.binding.serverIdentityId,
      serverHttpBaseUrl,
      target,
      installationId: input.currentInstallationId!,
      privateKey: input.externalActionMachineRequestPrivateKey!,
      rootAdmitted: true,
      ...(cancelAddress?.success ? { requesterOperationCancelAddress: cancelAddress.data } : {}),
      isCurrent: input.isInstallationCurrent
        ? async () => input.isInstallationCurrent!()
        : readRequesterAccountActionContext(projectionAuthorization)?.isCustodyCurrent ?? (() => input.verifyExecutionAuthorization!({
          authorization: admittedAuthorization!, effectActionId: actionId.data, target,
          ...(input.signal ? { signal: input.signal } : {}),
        })),
      ...(input.signal ? { signal: input.signal } : {}),
    }));
    trace('requester_http_projection.end');
    if (!projection.ok) {
      return prepare({ v: 1, actionId: actionId.data,
        ...(envelope.data.requestId ? { requestId: envelope.data.requestId } : {}),
        execution: projection.executionFailure ?? { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' } });
    }
    admittedAuthorization = projection.value;
  }
  let mountedCaller: Awaited<ReturnType<typeof deriveMountedPluginInvocationCaller>> = { status: 'absent' };
  if (envelope.data.pluginInvocation) {
    const invocation = envelope.data.pluginInvocation;
    const binding = invocation.kind === 'mountedPluginSurface' ? invocation.mountedBinding : invocation.clientActionBinding;
    try {
      if (binding.sourceCustody && input.acquirePluginRuntimeRegistryLease && input.resolvePluginExecutionOriginContext
        && !apiTokenPrincipal && accountPrincipal?.authentication.kind !== 'terminal'
        && !sessionActionOrigin && !input.signal?.aborted) {
        trace('mounted_runtime_lease.begin');
        pluginRuntimeLease = await timeApprovalPhase('approval.external.plugin_lease_acquire', () => input.acquirePluginRuntimeRegistryLease!());
        trace('mounted_runtime_lease.end');
        trace('mounted_caller.begin');
        mountedCaller = await deriveMountedPluginInvocationCaller({
          request: { machineId: input.currentMachineId, invocationSurface: input.surface ?? 'ui', invocation },
          registry: pluginRuntimeLease.registry,
          resolveCurrentPluginMaterializationRef: pluginRuntimeLease.resolveCurrentPluginMaterializationRef,
          resolveExecutionOriginContext: input.resolvePluginExecutionOriginContext,
          resolveAccountExecutionSelection: async pluginId => {
            const runtime = readRequesterAccountActionContext(requesterContext?.authorization);
            if (runtime) {
              const { readCurrentMountedAccountPluginExecutionSelection } = await import('@/plugins/runtime/accountPluginActivationSource');
              return await readCurrentMountedAccountPluginExecutionSelection({ pluginId, runtime, ...(input.signal ? { signal: input.signal } : {}) });
            }
            // A foreign requester cannot borrow the custodian's enabled selection.
            if (accountPrincipal?.accountId && accountPrincipal.accountId !== input.currentAccountId) {
              return { kind: 'unavailable', code: 'plugin_account_execution_unavailable' };
            }
            return await input.resolveAccountPluginExecutionSelection?.(pluginId, input.signal)
              ?? { kind: 'unavailable', code: 'plugin_account_execution_unavailable' };
          },
        });
      }
      if (mountedCaller.status !== 'available' || !await mountedCaller.isMountedCallerCurrent()) {
        mountedCaller = { status: 'unavailable' };
      }
      trace('mounted_caller.end');
    } catch (error) { refuseExternalActionPhase('mounted_caller', input.currentMachineId, error); mountedCaller = { status: 'unavailable' }; }
    if (mountedCaller.status !== 'available') return prepare({ v: 1, actionId: actionId.data,
      ...(envelope.data.requestId ? { requestId: envelope.data.requestId } : {}),
      execution: { ok: false, errorCode: 'plugin_mounted_caller_unavailable', error: 'plugin_mounted_caller_unavailable' } });
  }
  if (selectedCarrier && pluginRuntimeLease && mountedCaller.status === 'available') {
    const outer = ActionInvokeInputSchema.safeParse(decodedInput);
    const registry = pluginRuntimeLease.registry;
    const outerAction = outer.success
      ? readResolvedActionContribution(registry.contributes, outer.data.action) : undefined;
    const refusal = admitMountedSelectedActionInput(selectedCarrier, mountedCaller,
      outerAction?.definition.readOnly === true ? outerAction.pluginId : undefined, registry);
    if (refusal) return prepare({ v: 1, actionId: actionId.data, requestId: envelope.data.requestId,
      execution: { ok: false, errorCode: refusal, error: refusal } });
  }
  const pluginCaller = mountedCaller.status === 'available' ? resolvePluginActionCaller({
    plugin: { id: mountedCaller.caller.pluginId }, contribution: mountedCaller.caller.contribution,
    occurrenceId: mountedCaller.caller.occurrenceId, sourceCustody: mountedCaller.caller.sourceCustody,
    resolveCurrentPluginMaterializationRef: () => mountedCaller.status === 'available'
      ? mountedCaller.caller.materialization ?? null : null,
  }) : null;
  if (envelope.data.pluginInvocation && !pluginCaller) return prepare({ v: 1, actionId: actionId.data,
    ...(envelope.data.requestId ? { requestId: envelope.data.requestId } : {}),
    execution: { ok: false, errorCode: 'plugin_mounted_caller_unavailable', error: 'plugin_mounted_caller_unavailable' } });
  const invocationAttribution = admitExternalActionRequesterInvocationAttributionV1(invocation, admittedAuthorization?.binding,
    pluginCaller ?? invocation?.caller);
  if (!invocationAttribution.ok) {
    return prepare({ v: 1, actionId: actionId.data, requestId: envelope.data.requestId,
      execution: { ok: false, errorCode: 'forbidden', error: 'forbidden' } });
  }
  // The new child codec cannot turn an unstamped Account request into a human
  // click via the ordinary Account surface default. Signed causal origins and
  // explicit invocation stamps retain their existing authority owner.
  const unstampedManagedChild = envelope.data.managedCreationCodec
    && !invocation && !sessionActionOrigin && !workflowActionOrigin;
  // This new same-Session mutation must retain its initiating cause. An Account
  // credential on the destination is custody, never evidence of a human click.
  if (actionId.data === 'session.agent.transition' && !sessionActionOrigin && !apiTokenPrincipal && !invocation) {
    return prepare({ v: 1, actionId: actionId.data, ...(envelope.data.requestId ? { requestId: envelope.data.requestId } : {}),
      execution: { ok: false, errorCode: 'forbidden', error: 'forbidden' } });
  }
  let actionRefusalWitnessed = false;
  const baseActionStartDiagnosticRecorder = createExternalActionStartDiagnosticRecorder(
    input.actionId, envelope.data.requestId, input.currentMachineId, input.transportRequestId,
  );
  const recordActionStartDiagnostic = baseActionStartDiagnosticRecorder
    ? (event: ActionStartDiagnosticV1) => {
        if (event.refusalReason) actionRefusalWitnessed = true;
        baseActionStartDiagnosticRecorder(event);
      }
    : undefined;
  const originalAuthorization = executionAuthorization?.success ? executionAuthorization.data : undefined;
  const hasProtectedTokenContentAccess = decodedTokenContentAccess !== undefined;
  // Home admitted this exact root above. Finite work keeps the same local port
  // as RPC ingress; withdrawal applies at the next signed request.
  const originalRootCurrentness = originalAuthorization
    ? async () => !input.signal?.aborted && input.isInstallationCurrent?.() !== false
    : undefined;
  if (admittedAuthorization && (requesterContext || managedControllerCodec && logsOperands.resourceContinuation)) {
    // Resources retain the finite Action's selected owner, including native
    // codecs without Account credentials, rather than selecting a launcher factory.
    // HTTP projection is immutable; preserve its private ports on the local carrier.
    admittedAuthorization = Object.defineProperties({ ...admittedAuthorization }, Object.getOwnPropertyDescriptors(admittedAuthorization));
    Object.defineProperty(admittedAuthorization, 'requesterAccountExecutor', { value: requesterContext?.executor ?? input.executor, enumerable: false });
  }
  if (admittedAuthorization && 'credentialId' in admittedAuthorization.binding
    && (hasProtectedTokenContentAccess || admittedAuthorization.binding.actionId === 'deployments.deploy')) {
    // The signed HTTP projector freezes its carrier. Retain its exact immutable
    // wire/private descriptors on an extensible invocation before adding custody.
    admittedAuthorization = Object.defineProperties({ ...admittedAuthorization }, Object.getOwnPropertyDescriptors(admittedAuthorization));
  }
  if (decodedTokenContentAccess) {
    if (!admittedAuthorization || !originalRootCurrentness) return { kind: 'invalid_request',
      errorCode: 'invalid_encrypted_envelope', requestId: envelope.data.requestId };
    releaseTokenContentAccess = retainApiTokenDeploymentContentAccess(admittedAuthorization, decodedTokenContentAccess);
    decodedTokenContentAccess = undefined;
  }
  if (admittedAuthorization && 'credentialId' in admittedAuthorization.binding
    && (hasProtectedTokenContentAccess || admittedAuthorization.binding.actionId === 'deployments.deploy')
    && !admittedAuthorization.requesterAccountProjection) {
    const projected = await prepareApiTokenDeploymentAccountProjection(admittedAuthorization, input.signal);
    // The projection refused. An encrypted Account root without same-token access
    // is the caller's missing credential; every other refusal stays unavailable.
    if (!projected) return prepare({ v: 1, actionId: actionId.data, requestId: envelope.data.requestId,
      execution: admittedAuthorization.binding.accountEncryptionMode === 'e2ee' && !hasProtectedTokenContentAccess
        ? apiTokenEncryptionAccessRequired()
        : { ok: false, errorCode: 'content_unavailable', error: 'api_token_encryption_access_unavailable' } });
    releaseTokenAccountProjection = projected.dispose;
  }
  if (admittedAuthorization && originalRootCurrentness) admittedAuthorization = retainVerifiedExternalActionRequester({
    authorization: admittedAuthorization, isCurrent: originalRootCurrentness,
  });
  // Home has already admitted this exact reduced lifetime effect, or the
  // signed child of the approved spawn. The marker is never read from Action
  // input; the verified root and exact managed admission remain effect authority.
  const nativeAdmission = admittedAuthorization?.binding.managedAdmission;
  const approvedNativeLifetimeEffect = actionId.data === 'machines.managed.credentials.install'
    && originalRootCurrentness !== undefined && nativeAdmission?.actionId === actionId.data
    && sameStrictJsonValue(nativeAdmission.input, decodedInput)
    && (nativeAdmission.input.operation === 'release'
      || admittedAuthorization?.binding.nativeCredentialSpawnChild !== undefined);
  // Home already admitted the exact custodian-reviewed preset. Consume that
  // signed decision instead of creating a requester Ask in custodian custody.
  const approvedDelegatedAcquire = actionId.data === 'machines.managed.acquire'
    && originalRootCurrentness !== undefined
    && admittedAuthorization?.binding.managedAcquireDelegation === true;
  const approvedCreationRecovery = (actionId.data === 'machines.managed.cancel' || actionId.data === 'machines.managed.delete')
    && originalRootCurrentness !== undefined && managedControllerCodec
    && nativeAdmission?.actionId === actionId.data && 'authority' in nativeAdmission
    && nativeAdmission.authority === 'creator_recovery' && sameStrictJsonValue(nativeAdmission.input, decodedInput);
  // Home admitted this exact Start or Stop under the Manage grant. Creating an Ask here
  // would use the controller's credential for a private requester Artifact.
  const approvedManagedPower = actionId.data === 'machines.managed.power.set'
    && originalRootCurrentness !== undefined && managedControllerCodec
    && nativeAdmission?.actionId === actionId.data
    && (nativeAdmission.input.intent === 'start' || nativeAdmission.input.intent === 'stop')
    && sameStrictJsonValue(nativeAdmission.input, decodedInput);
  // This exact request spends the admitted Account operation's cancellation
  // scope. The requesting client owns Action policy, confirmation and automation admission.
  const admittedRequesterOperationCancellation = managedControllerCodec && originalRootCurrentness !== undefined
    && actionId.data === ACTION_OPERATION_CANCEL_ACTION_ID_V1 && admittedAuthorization?.binding.requesterOperationRead === true;
  const workflowStepApprovalId = admittedAuthorization?.binding.workflowActionOrigin?.stepApprovalArtifactId;
  if (admittedAuthorization && workflowStepApprovalId) {
    // Use only the requester whose private credentials this installation just opened.
    const requester = readRequesterAccountActionContext(admittedAuthorization);
    const binding = admittedAuthorization.binding;
    const refuse = (failure: ActionExecuteFailure) => prepare({
      v: 1, actionId: actionId.data, requestId: envelope.data.requestId,
      execution: { ...failure, effectAttempted: false },
    });
    if (!isDeploymentBackupEvidenceActionIdV1(actionId.data) || !requester || !originalRootCurrentness) {
      return refuse({ ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' });
    }
    const read = await runExternalActionPhase('workflow_step_approval', input.currentMachineId, async () => {
      const store = createCliApprovalsArtifactStore({ credentials: requester.credentials,
        serverHttpBaseUrl: requester.serverHttpBaseUrl,
        getAccountEncryptionMode: async () => requester.accountEncryptionCurrentness.mode });
      try {
        const receipt = await runWithServerHttpBaseUrl(requester.serverHttpBaseUrl, () => store.approvalsGet({
          artifactId: workflowStepApprovalId, serverId: binding.serverIdentityId,
        }));
        return { receipt };
      } catch (error) {
        rethrowRequesterHomeReadFailure(error);
        const failure = parseActionExecuteFailure(error);
        if (!failure) throw error;
        return { failure: { ok: false as const, errorCode: failure.errorCode, error: failure.errorCode,
          ...(failure.failureCause ? { failureCause: failure.failureCause } : {}) } };
      }
    });
    if (!read.ok) return refuse(read.executionFailure ?? projectUnexpectedActionFailureV1(false, binding.requestId));
    if (read.value.failure) return refuse(read.value.failure);
    if (!matchesExecutingWorkflowStepApproval({ receipt: read.value.receipt, binding, operand: decodedInput })) {
      return refuse({ ok: false, errorCode: 'approval_stale', error: 'approval_stale' });
    }
    const current = await runExternalActionPhase('workflow_step_approval_currentness', input.currentMachineId,
      originalRootCurrentness);
    if (!current.ok) return refuse(current.executionFailure ?? { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' });
  }
  const logsReference = logsOperands.resourceContinuation?.params.resource;
  const logsGeneration = logsOperands.machineServiceLogsGeneration?.expectedGeneration
    ?? (logsReference?.hostRead === 'machines.services.logs' ? logsReference.expectedGeneration : undefined);
  const context: RpcActionExecutorContext = {
    ...(managedSessionCreationTag ? { managedContinuationSessionCreationTag: managedSessionCreationTag } : {}),
    ...(input.operationOwnerUpdate ? { operationOwnerUpdate: input.operationOwnerUpdate } : {}),
    ...(!admittedAuthorization && !input.machineAdmission && !accountPrincipal && !apiTokenPrincipal
      && !pluginCaller
      // Session placement has already proved locality through resolveTarget.
      // It consumes the same authenticated private root as Machine placement.
      && (target.kind === 'session' || target.machineId === input.currentMachineId)
      && input.authenticatedLocalRootCustody?.machineId === input.currentMachineId
      && input.authenticatedLocalRootCustody.accountId === input.currentAccountId
      ? { authenticatedLocalRootCustody: input.authenticatedLocalRootCustody,
        requesterWorkAttributionV1: projectRpcRequesterWorkAttribution({
          authenticatedLocalRootCustody: input.authenticatedLocalRootCustody,
        }, input.currentServerId) } : {}),
    // The verified Workflow receipt continues the coordinator's Automation admission.
    ...(admittedRequesterOperationCancellation || workflowStepApprovalId ? { externalActionContinuation: true } : {}),
    ...(approvedNativeLifetimeEffect || approvedDelegatedAcquire || approvedCreationRecovery || approvedManagedPower
      || admittedRequesterOperationCancellation || workflowStepApprovalId ? { bypassApprovals: true } : {}),
    // The exact compute effect is already admitted by Home; reading a source
    // Session profile here would borrow the controller's Account credential.
    ...(approvedDelegatedAcquire ? { approvalProfileId: null } : {}),
    ...(input.machineAdmission ? { machineAdmission: input.machineAdmission } : {}),
    ...(machineSetupAppBlockIds ? { machineSetupAppBlockIds } : {}),
    ...(admittedAuthorization && originalRootCurrentness ? {
      verifiedExternalActionRequester: { authorization: admittedAuthorization, isCurrent: originalRootCurrentness },
      verifyMachineAdmissionCurrent: originalRootCurrentness,
    } : {}),
    ...(recordActionStartDiagnostic ? { recordActionStartDiagnostic } : {}),
    surface: pluginCaller ? 'plugin' : actionSurface,
    authority: unstampedManagedChild || invocation && invocation.authority !== 'present_user'
      ? 'account_automation'
      // The restored private host invocation establishes the person's CLI use
      // for both Account and terminal continuations at an automation floor.
      : (requesterContext?.invocation || controllerInvocation) && admittedAuthorization
        ? resolveExternalActionRootInvocationAuthority(admittedAuthorization)
        : input.principal.authority,
    actionCaller: pluginCaller ?? sessionActionOrigin?.caller ?? invocation?.caller ?? { kind: 'host' },
    ...(selectedCarrier && mountedCaller.status === 'available' ? { mountedSelectedActionInput: {
      carrier: selectedCarrier, isMountedCallerCurrent: mountedCaller.isMountedCallerCurrent,
    } } : {}),
    ...(pressedSend && actionId.data === SESSION_MESSAGE_SEND_ACTION_ID_V1 && accountPrincipal?.authentication.kind === 'account'
      && !sessionActionOrigin && !workflowActionOrigin && pressedSend === readRecord(decodedInput).sessionId
      ? { presentUserSessionSend: pressedSend } : {}),
    ...(actionId.data === ACTION_INVOKE_ACTION_ID_V1 && ownInvocation?.sessionListAccess
      ? { sessionListAccess: ownInvocation.sessionListAccess } : {}),
    ...(invocation ? { callerPermissionMode: invocation.callerPermissionMode,
      ...(invocationAttribution.actionRequestAttributionV1 ? { actionRequestAttributionV1: invocationAttribution.actionRequestAttributionV1 } : {}),
      ...(!envelope.data.managedCreationCodec && invocation.presentUserConfirmation
        ? { presentUserConfirmation: invocation.presentUserConfirmation } : {}),
      ...(invocation.callerInputConstraints ? { callerInputConstraints: invocation.callerInputConstraints } : {}),
      ...(invocation.workspaceWrites ? { workspaceWrites: invocation.workspaceWrites } : {}),
      ...(ownInvocation?.defaultSessionId ? { defaultSessionId: ownInvocation.defaultSessionId } : {}),
      ...(sessionCreationDefaults ? { sessionCreationDefaults } : {}),
    } : {}),
    ...(admittedAuthorization ? projectExternalActionWorkflowSessionLeafContextV1(admittedAuthorization) : {}),
    ...(sessionActionOrigin ? {
      defaultSessionId: sessionActionOrigin.caller.sessionId,
      callerPermissionMode: sessionActionOrigin.callerPermissionMode,
      causalPermissionAuthority: sessionActionOrigin.causalPermissionAuthority ?? null,
      ...(sessionActionOrigin.actionRequestAttributionV1
        ? { actionRequestAttributionV1: sessionActionOrigin.actionRequestAttributionV1 } : {}),
      ...(sessionActionOrigin.workspaceWrites ? { workspaceWrites: sessionActionOrigin.workspaceWrites } : {}),
      sessionInputSource: { sourceSessionId: sessionActionOrigin.caller.sessionId,
        sourceTurnId: sessionActionOrigin.sourceTurnId,
        ...(sessionActionOrigin.sourceInputId ? { sourceInputId: sessionActionOrigin.sourceInputId } : {}),
        via: 'action' as const },
    } : {}),
    ...(registryThemeContent ? { registryThemeContent } : {}),
    ...(apiTokenPrincipal
      ? {
          externalActionCredential: {
            accountId: apiTokenPrincipal.accountId,
            principalId: apiTokenPrincipal.principalId,
            credentialId: apiTokenPrincipal.credentialId,
            grant: executionAuthorization?.success && 'grant' in executionAuthorization.data.binding
              ? executionAuthorization.data.binding.grant
              : apiTokenPrincipal.grant,
          },
        }
      : {}),
    ...(executionAuthorization?.success
      ? {
          externalActionExecutionAuthorization: admittedAuthorization!,
          ...(actionId.data === WORKFLOW_RUN_START_ACTION_ID_V1 && decodedWorkflowPreparation
            ? { workflowPreparation: decodedWorkflowPreparation } : {}),
          ...(hasProtectedTokenContentAccess || hasProtectedLogsOperands || isSessionAgentReadinessRootActionIdV1(actionId.data) || actionId.data === 'projects.open'
            || actionId.data === SESSION_WORKSPACE_RETURN_PREPARE_ACTION_ID_V1
            || actionId.data === WORKFLOW_RUN_START_ACTION_ID_V1
            || actionId.data === 'machines.managed.acquire'
            || actionId.data === 'action.operations.cancel' || isProjectWorkspaceSyncPreparationActionV1(actionId.data)
            || isWorkspaceSyncRelationshipWriteActionId(actionId.data)
            || executionAuthorization.data.binding.deploymentChildRoot === true
            || actionId.data === 'deployments.teardown'
            || isReviewedMachineSetupChildRootV1(executionAuthorization.data.binding)
            ? { originalActionEnvelope: envelope.data } : {}),
          signExternalActionApprovalInput: ({ actionId: approvalActionId, input: approvalInput, target: approvalTarget, requesterConfirmation, sessionTargetsV1 }) =>
            signExternalActionApprovalInputV1({
              authorizationToken: executionAuthorization.data.token,
              actionId: approvalActionId,
              target: approvalTarget,
              input: approvalInput,
              ...(requesterConfirmation ? { requesterConfirmation } : {}),
              ...(sessionTargetsV1 ? { sessionTargetsV1 } : {}),
              privateKey: input.externalActionMachineRequestPrivateKey!,
            }),
        }
      : {}),
    // An unqualified Account operation has no Machine resource restriction.
    // Keep the resolved relay for transport/currentness above, while explicit
    // and signed targets retain their exact scope at the Action owner.
    ...(reconciliation.target !== undefined || executionAuthorization?.success
      || reconciliation.executionPlacement !== 'account'
      ? { externalActionTarget: target } : {}),
    ...(target.kind === 'session' && expectedSessionMachineId ? { expectedSessionMachineId } : {}),
    // Both requester Account admission and durable approval origins consume
    // this exact receiving daemon fact, including fresh Machine-targeted starts.
    defaultSessionMachineId: input.currentMachineId,
    ...(admittedAuthorization ? { serverIdentityId: admittedAuthorization.binding.serverIdentityId } : {}),
    ...(input.currentServerId !== undefined ? { serverId: input.currentServerId } : {}),
    ...('accountId' in input.principal ? { runtimeAccountId: input.principal.accountId }
      : input.currentAccountId ? { runtimeAccountId: input.currentAccountId } : {}),
    ...reconciliation.context,
    ...(reconciliation.executionRunRequiresMachineTarget && target.kind === 'machine'
      ? { executionRunTargetMachineId: target.machineId }
      : {}),
    ...(executionAuthorization?.success
      ? { actionRequestId: executionAuthorization.data.binding.requestId }
      : envelope.data.requestId
        ? { actionRequestId: envelope.data.requestId }
        : {}),
    ...(input.signal ? { signal: input.signal } : {}),
    ...(logsGeneration !== undefined ? { machineServiceLogsResource: {
      expectedGeneration: logsGeneration,
      ...(logsReference?.hostRead === 'machines.services.logs' ? { sourceRevision: logsReference.sourceRevision } : {}),
    } } : {}),
  };
  const failureRequestId = () => envelope.data.requestId ?? admittedAuthorization?.binding.requestId
    ?? input.transportRequestId ?? randomUUID();
  const recordExecutionThrow = (error: unknown, requestId: string) => {
    trace('action_execution.threw');
    return refuseExternalActionPhase('action_execution', input.currentMachineId, error, { actionId: actionId.data, requestId });
  };
  const projectPreparationFailure = (error: unknown, requestId: string, phase: ReturnType<typeof recordExecutionThrow>): ActionExecuteFailure => {
    // Only the typed identity and validated cause can leave this phase.
    // Author details, exception prose, stacks and raw schema input stay private.
    if (error instanceof AccountSettingsContentInvalidError) {
      return { ok: false, errorCode: error.code, error: error.code, effectAttempted: false };
    }
    const typed = phase.executionFailure ?? (error instanceof ManagedMachineControllerError
      ? error.toActionFailure(actionId.data) : parseActionExecuteFailure(error));
    const code = typed?.errorCode ?? (isPluginError(error) ? error.code : undefined);
    return code ? { ok: false, errorCode: code, error: code, effectAttempted: false,
      failureCause: typed?.failureCause ?? projectActionFailureCauseV1(error, actionId.data) }
      : { ...projectUnexpectedActionFailureV1(false, requestId), effectAttempted: false };
  };
  let internalExecution: ActionExecuteResult;
  try {
    trace('action_execution.begin');
    internalExecution = await withWebLatencyTrace(envelope.data.requestId, () => timeWebLatencyPhase('daemon.action.execute', async () => {
      const executor = requesterContext?.executor ?? input.executor;
      if (input.observeSessionBirth) {
        // This request observes a previous daemon dispatch with a lost acknowledgement.
        effectMayHaveStarted = true;
        const observed = actionId.data === 'session.spawn_new' && admittedAuthorization && originalRootCurrentness
          && await originalRootCurrentness()
          ? await executor.observeSessionBirth?.(decodedInput, context) : null;
        return observed ? completeSpawnActionResult(observed)
          : projectUnexpectedActionFailureV1(null, envelope.data.requestId);
      }
      if (!logsOperands.resourceContinuation) {
        const execute = (value: unknown, executionContext: ActionExecutorContext) => {
          effectMayHaveStarted = true;
          return executor.execute(actionId.data, value, {
            ...executionContext,
            reportActionEffectDispatch: dispatched => { effectMayHaveStarted = dispatched; },
          });
        };
        const reviewed = await invokeAdmittedReviewedChild({ parent: managedReviewedParent ?? requesterContext?.invocation?.reviewedParent,
          requesterOwnedReview: !managedReviewedParent && Boolean(requesterContext?.invocation?.reviewedParent),
          context, actionId: actionId.data, actionInput: decodedInput,
          ...(input.machineAdmission ? { receivingAdmission: input.machineAdmission } : {}),
          execute });
        return reviewed ?? execute(decodedInput, context);
      }
      const continuation = logsOperands.resourceContinuation;
      const selectedSourceWatch = continuation.method === RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_OPEN
        && continuation.params.resource.hostRead === 'database.insightSource'
        && actionSurface === 'ui' && context.actionCaller?.kind === 'plugin' && context.mountedSelectedActionInput !== undefined
        && input.sendHostResourceWatchFrame !== undefined;
      if ((!selectedSourceWatch && (context.surface !== 'ui' || context.actionCaller?.kind !== 'host')) || !context.signal
        || !originalRootCurrentness || !admittedAuthorization) return { ok: false, errorCode: 'service_admission_unavailable', error: 'service_admission_unavailable' };
      if (selectedSourceWatch) {
        // The original read owns database admission; the watch consumes that result once at open.
        effectMayHaveStarted = true;
        const admitted = await executor.execute(actionId.data, decodedInput, context);
        if (!admitted.ok) return admitted;
        const native = readRecord(admitted.result);
        if (native.ok === false) {
          const code = typeof native.code === 'string' ? native.code : 'invalid_action_output';
          return projectContributedActionFailure({ errorCode: code, error: code, details: admitted.result });
        }
      }
      const sendResourceFrame = input.sendHostResourceWatchFrame;
      const send = async (value: unknown) => {
        const response = prepare({ v: 1, actionId: actionId.data, requestId: envelope.data.requestId,
          execution: { ok: true, result: value } });
        if (response.kind !== 'response') throw new Error('Host Resource delivery could not be prepared');
        await sendResourceFrame!(response.prepared.response);
      };
      effectMayHaveStarted = true;
      const result = await input.invokeResource!(continuation.method, continuation.params, {
        signal: context.signal, callerInputAuthorization: admittedAuthorization,
        ...(input.machineAdmission ? { machineAdmission: input.machineAdmission } : {}),
        verifyMachineAdmissionCurrent: originalRootCurrentness, originalActionEnvelope: envelope.data,
        localActionContext: context,
        ...(sendResourceFrame ? { followHostResource: {
          onOpen: opened => send({ ok: true, ...opened }),
          onEvent: event => send({ ok: true, status: 'event', event }),
        } } : {}),
      });
      const response = parseMachineServiceLogsResourceResponse(continuation.method, result);
      return response.success ? { ok: true, result: response.data }
        : { ok: false, errorCode: 'invalid_action_output', error: 'invalid_action_output' };
    }));
    trace('action_execution.end');
  } catch (error) {
    const requestId = failureRequestId();
    const phase = recordExecutionThrow(error, requestId);
    const resource = logsOperands.resourceContinuation;
    let execution: ActionExecuteFailure;
    if (!effectMayHaveStarted) {
      execution = projectPreparationFailure(error, requestId, phase);
    } else if (resource && context.signal?.aborted) {
      execution = { ok: false, errorCode: 'cancelled', error: 'cancelled' };
    } else {
      execution = (resource ? readDaemonHostResourceActionFailure(error) : null)
        ?? readRequesterHomeActionFailure(error)
        ?? ((resource && isPluginError(error)) || error instanceof AccountSettingsContentInvalidError
          ? { ok: false, errorCode: error.code, error: error.code }
          : projectUnexpectedActionFailureV1(null, requestId));
    }
    return prepare({ v: 1, actionId: actionId.data, requestId, execution });
  }
  const reviewedCandidate = context.externalActionExecutionAuthorization?.binding.deploymentCandidatePublication?.reviewed;
  if (!internalExecution.ok && reviewedCandidate
    && (internalExecution.errorCode === 'action_interactive_review_required' || internalExecution.errorCode === 'approval_stale')) {
    const details = readRecord(internalExecution.details);
    const current = projectDeploymentReviewedCandidateV1(readRecord(details.review).actionArgs);
    logger.warn('[deployment.review.refused]', { reasonCode: internalExecution.errorCode,
      reviewedCandidateId: reviewedCandidate.contentArtifactId, currentCandidateId: current?.contentArtifactId,
      reviewedDigest: context.presentUserConfirmation?.reviewDigest,
      currentDigest: typeof details.reviewDigest === 'string' ? details.reviewDigest : undefined });
  }
  if (!internalExecution.ok && internalExecution.errorCode === 'target_unavailable' && !actionRefusalWitnessed) {
    const details = internalExecution.details && typeof internalExecution.details === 'object'
      && !Array.isArray(internalExecution.details) ? internalExecution.details as Readonly<Record<string, unknown>> : null;
    refuseExternalActionPhase('action_execution', input.currentMachineId, undefined, {
      ...(envelope.data.requestId ? { requestId: envelope.data.requestId } : {}),
      refusalBranch: typeof details?.reason === 'string' ? details.reason : 'action_result_target_unavailable',
    });
  }
  let execution = projectExternalActionExecutionResultV1(internalExecution) ?? {
    ok: false as const,
    errorCode: 'invalid_action_output',
    error: 'invalid_action_output',
  };
  if (execution.ok && !logsOperands.resourceContinuation) {
    execution = settleActionOutput(actionId.data, execution, envelope.data.requestId,
      SIGNED_ROOT_ACTION_OUTPUT_RUNTIME_SCHEMAS[actionId.data]);
  }

  return prepare({
    v: 1,
    actionId: actionId.data,
    ...(envelope.data.requestId ? { requestId: envelope.data.requestId } : {}),
    execution,
  });
  } finally {
    releaseTokenAccountProjection?.();
    releaseTokenContentAccess?.();
    trace('daemon.cleanup.begin');
    try { await timeApprovalPhase('approval.external.plugin_lease_release', () => pluginRuntimeLease?.release()); }
    finally { await timeApprovalPhase('approval.external.requester_dispose', () => requesterContext?.dispose()); }
    trace('daemon.cleanup.end');
  }
}

function targetNotLocal(phase: 'target_machine_locality' | 'target_session_locality'): ActionExecuteResult {
  return {
    ok: false,
    errorCode: 'target_not_local',
    error: 'target_not_local',
    details: { phase },
  };
}

function targetUnavailable(): ActionExecuteResult {
  return {
    ok: false,
    errorCode: 'target_unavailable',
    error: 'target_unavailable',
  };
}
