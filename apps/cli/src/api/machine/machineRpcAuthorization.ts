import {
  MANAGED_PLUGIN_WEBHOOK_DAEMON_RPC_METHOD_V1,
  ManagedPluginWebhookOriginV1Schema,
  ManagedPluginWebhookRequestV1Schema,
} from '@happier-dev/protocol/plugins/webhooks/managedRepositoryWebhookRpcV1';
import { projectActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { TargetedActionRpcRequestV1Schema, listActionSpecRpcRegistrations } from '@happier-dev/protocol/actions/actionRpcTransport';
import { WORKSPACE_SYNC_RELATIONSHIP_WRITE_ACTION_INPUT_SCHEMAS_V1 } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import { isProjectWorkspaceSyncOpenActionV1 } from '@happier-dev/protocol/actions/projectActionIdsV1';
import { isWorkspaceSyncRelationshipWriteActionId, readWorkspaceSyncSeedProofKindV1, SESSION_HANDOFF_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIds';
import {
  RPC_ERROR_CODES,
  RPC_ERROR_MESSAGES,
} from '@happier-dev/protocol/rpcErrors';
import {
  resolveMachineRpcRoutePolicy,
  resolveMachineRpcExternalActionEffectV1,
} from '@happier-dev/protocol/machines/peer/mediation/rpc/routePolicyV1';
import {
  canExecuteRequesterWorkspaceOnDaemonForHost,
  isHostRequesterUnrestrictedOwner,
  isRequesterOwnWorkPlacedOnDaemonForHost,
  selectHostRequesterExecutionIdentity,
  type HostRequesterExecutionIdentity,
} from '@/daemon/agentIsolation/agentIsolationLaunchPolicy';
import { readRetainedVerifiedExternalActionRequester } from '@/daemon/agentIsolation/verifiedExternalActionRequester';
import { isProjectWorkspaceSyncPreparationActionV1 } from '@happier-dev/protocol/actions/projectActionFamily';
import { DaemonLocalServiceLauncherStartRequestV1Schema } from '@happier-dev/protocol/local/services/launcher/v1';
import axios from '@/api/client/credentialAxios';
import { signMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import {
  RequesterSessionCurrentnessPurposeV1Schema,
  type RequesterSessionCurrentnessPurposeV1,
} from '@happier-dev/protocol/machines/identity/installationIdentity';
import {
  MachineAccessLossCustodyRequestV1Schema,
  MachineAdmissionVerifyResponseV1Schema,
} from '@happier-dev/protocol/machines/machineAccessV1';
import {
  isSocketRpcLocalServicesPreviewAdmissionServerOriginAuthorizationContext,
  isSocketRpcMachineAccessLossServerOriginAuthorizationContext,
  parseSocketRpcAuthorizationContext,
  resolveSocketRpcSessionWriteAuthorizationMethod,
  resolveSocketRpcSessionAuthorization,
  isSocketRpcSessionBrowserAuthorizationContext,
  resolveSessionBrowserRpcCapabilityV1,
} from '@happier-dev/protocol/socketRpc';
import {
  isSocketRpcMachineReadServerOriginAuthorizationContext,
  SOCKET_RPC_SERVER_ORIGIN_MACHINE_READ_METHODS,
} from '@happier-dev/protocol/socketRpc';
import { RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { ScmWorkEvidenceAdmissionSchema } from '@happier-dev/protocol/scm';
import { getScmRpcSideEffectClass, isScmHostingCredentialRpcMethod, isScmLocalRepositoryReadRpcMethod, isScmMemberFolderRpcMethod } from '@happier-dev/protocol/actions/scmGitActionSpecs';
import {
  PreparedTransferRpcRequestV1Schema,
  resolvePreparedTransferRpcPhaseV1,
} from '@happier-dev/protocol/machines/transfer/preparedTransferRpcV1';
import { SessionTransferRpcMethodV1Schema } from '@happier-dev/protocol/socketRpc';
import { hasFilesystemEffectTransferCustody } from '@/rpc/handlers/fileSystem/filesystemEffectTransferCustody';
import type { SocketRpcAuthorizationContext } from '@happier-dev/protocol/socketRpc';
import {
  SocketRpcMachineAdmissionContextV1Schema,
  type SocketRpcMachineAdmissionContextV1,
  WorkspaceSyncSourceRoutingV1Schema,
  type WorkspaceSyncSourceRoutingV1,
  WorkspaceSyncSourceExecutionV1Schema,
  type WorkspaceSyncSourceExecutionV1,
  WorkspaceSyncTargetRoutingV1Schema,
  type WorkspaceSyncTargetRoutingV1,
  WorkspaceSyncSeedRoutingV1Schema,
  type WorkspaceSyncSeedRoutingV1,
  WorkspaceSyncSourceWriterTargetRoutingV1Schema,
  type WorkspaceSyncSourceWriterTargetRoutingV1,
  isSignedWorkspaceSyncHandoffReleaseV1,
  isWorkspaceSyncSourceWriterCleanupPhaseV1,
  readWorkspaceSyncTargetMethodV1 as readWorkspaceSyncTargetMethod,
  isWorkspaceSyncSourceWriterTargetMethodV1,
  isWorkspaceSyncTargetReadMethodV1,
} from '@happier-dev/protocol/socketRpc';
import {
  WorkspaceSyncHandoffSourcePhaseRequestV1Schema,
  HandoffTargetReplacementPreflightV1Schema,
  WorkspaceSyncTargetBootstrapPrepareV1Schema,
  type WorkspaceSyncTargetBootstrapPrepareV1,
  type HandoffWorkspaceActionV1,
  WorkspaceSyncTargetBootstrapReleaseV1Schema,
  WorkspaceSyncTargetConflictRecoverV1Schema,
  WorkspaceSyncTargetEntryObserveV1Schema,
  WorkspaceSyncTargetFileReadV1Schema,
  type WorkspaceSyncTargetConflictRecoverV1,
  WorkspaceSyncSeedExportPrepareV1Schema,
  WorkspaceSyncRelationshipCreateRpcRequestV1Schema,
  WorkspaceSyncPrepareBetweenRequestV1Schema,
} from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import { WorkspaceSyncCommittedCopyPreviewV1Schema, WorkspaceSyncCommittedCopyTargetV1Schema,
  doesWorkspaceSyncCopyRetirementRootMatchV1 } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncCommittedCopyV1';
import { ProjectWorkerDependencyQueryV1Schema } from '@happier-dev/protocol/workspaces/projectWorkerExecutionV1';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import {
  ExternalActionExecutionAuthorizationV1Schema,
  ExternalActionDaemonDispatchRequestSchema,
  EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1,
  type ExternalActionExecutionAuthorizationV1,
} from '@happier-dev/protocol/actions/externalActionApi';
import { isSocketRpcActionApiServerOriginAuthorizationContext } from '@happier-dev/protocol/socketRpc';

import type {
  RpcAuthorizationResult,
  RpcAdmissionPredicate,
} from '@/api/rpc/types';
import { readReviewedMachineRpcChildFamilyV1 } from '@happier-dev/protocol/machines/peer/mediation/rpc/reviewedChildFamilyV1';
import { resolveExternalActionRootInvocationAuthority } from '@/api/externalActionExecutionAuthorization';
import { isExternalActionAuthorizationBoundToEnvelope } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { OpenProjectInputV1Schema } from '@happier-dev/protocol/projects/openProjectV1';
import {
  PROJECT_ACTION_INPUT_SCHEMAS_V1,
  PROJECT_FINITE_ACTION_RPC_METHODS_V1,
} from '@happier-dev/protocol/actions/projectActionFamily';
import {
  collectActionSpecRpcMethodsForScopes,
  SESSION_SPAWN_NEW_RPC_SCOPES,
  MACHINE_SESSION_LIFECYCLE_RPC_SCOPES,
} from '@/rpc/handlers/actionSpecRpcRegistration';
import {
  PRIVATE_SPAWN_SESSION_RPC_METHODS,
  SpawnDaemonSessionRequestSchema,
} from '@/rpc/handlers/spawnSessionOptionsContract';
import { ProjectServiceRelocateInputV1Schema } from '@happier-dev/protocol/workspaces/projectServiceRelocationV1';
import { logger } from '@/ui/logger';
import { classifyServerEndpointError } from '@/api/client/classifyServerEndpointError';
import { deriveWorkspaceSyncRelationshipId } from '@/workspaces/sync/workspaceSyncRelationshipIdentity';
import type { RetainedWorkspaceSyncPrivateExecution } from '@/workspaces/sync/workspaceSyncHandoffAdapter';
import {
  createHttpStatusError,
  readHttpStatus,
} from '@/api/client/httpStatusError';
import { isSessionStopChildV1 } from '@happier-dev/protocol/actions/sessionSections';
import { readDeploymentReferenceServiceListEnvironmentIdV1 } from '@happier-dev/protocol/actions/specs/deploymentPreparationScope';
import {
  ManagedInstallationServerOriginV1Schema,
  ManagedInstallationCapabilityRequestV1Schema,
  readManagedInstallationPurposeV1,
} from '@happier-dev/protocol/machines/managed/actionsV1';

const finiteProjectMethods: readonly string[] = Object.values(
  PROJECT_FINITE_ACTION_RPC_METHODS_V1,
);
// Only registered file owners with the consumed whole-operation native
// transport may finalize member payloads after this single admission.
const nativeFilesystemMethods: readonly string[] = [
  RPC_METHODS.DAEMON_SESSION_CREATION_DIRECTORY_PREFLIGHT,
  RPC_METHODS.READ_FILE,
  RPC_METHODS.DAEMON_FILESYSTEM_READ_FILE,
  RPC_METHODS.WRITE_FILE,
  RPC_METHODS.DAEMON_FILESYSTEM_WRITE_FILE,
  RPC_METHODS.LIST_DIRECTORY,
  RPC_METHODS.GET_DIRECTORY_TREE,
  RPC_METHODS.DAEMON_FILESYSTEM_GET_DIRECTORY_TREE,
  RPC_METHODS.CREATE_DIRECTORY,
  RPC_METHODS.DAEMON_FILESYSTEM_CREATE_DIRECTORY,
  RPC_METHODS.RENAME_PATH,
  RPC_METHODS.DAEMON_FILESYSTEM_RENAME,
  RPC_METHODS.DELETE_PATH,
  RPC_METHODS.DAEMON_FILESYSTEM_DELETE,
  RPC_METHODS.COPY_PATH,
  RPC_METHODS.DAEMON_FILESYSTEM_COPY,
  RPC_METHODS.STAT_FILE,
  RPC_METHODS.DAEMON_FILESYSTEM_LIST_ROOTS,
  RPC_METHODS.DAEMON_FILESYSTEM_LIST_DIRECTORY,
  RPC_METHODS.DAEMON_WORKSPACE_FILES_LIST,
  RPC_METHODS.DAEMON_WORKSPACE_FILES_SEARCH,
  RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT,
  RPC_METHODS.DAEMON_TRANSFER_UPLOAD_CHUNK,
  RPC_METHODS.DAEMON_TRANSFER_UPLOAD_FINALIZE,
  RPC_METHODS.DAEMON_TRANSFER_UPLOAD_ABORT,
  RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_INIT,
  RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_CHUNK,
  RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_FINALIZE,
  RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_ABORT,
  RPC_METHODS.DAEMON_FILESYSTEM_UPLOAD,
  RPC_METHODS.DAEMON_FILESYSTEM_DOWNLOAD,
  RPC_METHODS.DAEMON_FILESYSTEM_TRANSFER_CANCEL,
];
// Derived on the first authorization that reaches it: deriving it at module
// evaluation built the whole Action catalog in every importing process.
let nativeSessionMethods: readonly string[] | undefined;
function readNativeSessionMethods(): readonly string[] {
  return nativeSessionMethods ??= collectActionSpecRpcMethodsForScopes(
    listActionSpecRpcRegistrations(),
    [...SESSION_SPAWN_NEW_RPC_SCOPES, ...MACHINE_SESSION_LIFECYCLE_RPC_SCOPES],
  );
}
const privateSessionMethods: readonly string[] = Object.values(
  PRIVATE_SPAWN_SESSION_RPC_METHODS,
);
// These terminal owners finalize native birth and retain its exact identity for
// subsequent controls. Verified people gain member delegation; the owner's
// Agent may open through the same placement owner, but cannot gain raw controls.
const nativeTerminalMethods: readonly string[] = [
  RPC_METHODS.DAEMON_TERMINAL_ENSURE,
  RPC_METHODS.DAEMON_TERMINAL_RESTART,
  RPC_METHODS.DAEMON_TERMINAL_CLOSE,
  RPC_METHODS.DAEMON_TERMINAL_LIST,
  RPC_METHODS.DAEMON_TERMINAL_INPUT,
  RPC_METHODS.DAEMON_TERMINAL_RESIZE,
  RPC_METHODS.DAEMON_TERMINAL_STREAM_READ,
  RPC_METHODS.DAEMON_TERMINAL_STREAM_READ_BYTES,
  RPC_METHODS.DAEMON_TERMINAL_STREAM_ACK,
  RPC_METHODS.DAEMON_TERMINAL_STREAM_INPUT,
];

/** Local binding only; Home must independently verify the original root and current grants. */
export function doesWorkspaceSyncSourceRootMatchRouting(
  authorization: ExternalActionExecutionAuthorizationV1,
  source: WorkspaceSyncSourceRoutingV1,
): boolean {
  const binding = authorization.binding;
  const context = source.sourceContext;
  const handoff = binding.handoffAdmission;
  if (isWorkspaceSyncRelationshipWriteActionId(binding.actionId)) {
    const envelope = source.originalActionEnvelope;
    const constraints = 'grant' in binding
      ? { models: binding.grant.models, permissionModes: binding.grant.permissionModes } : undefined;
    return !!context && !!envelope && source.phase === 'prepare'
      && source.sourceSessionId === undefined && source.operationId === binding.requestId
      && source.accountServerId === binding.serverIdentityId && source.sourceMachineId === binding.machineId
      && context.machineAdmission.machineId === binding.machineId
      && context.machineAdmission.installationId === binding.installationId
      && context.machineAdmission.actorAccountId === binding.accountId
      && context.machineAdmission.custodianAccountId === binding.custodianAccountId
      && (context.callerAuthority === 'account_automation'
        || context.callerAuthority === resolveExternalActionRootInvocationAuthority(authorization))
      && sameStrictJsonValue(binding.sessionActionOrigin ?? null, context.sessionActionOrigin ?? null)
      && sameStrictJsonValue(constraints ?? null, context.callerInputConstraints ?? null)
      && binding.target.kind === 'machine' && binding.target.machineId === binding.machineId
      && isExternalActionAuthorizationBoundToEnvelope(binding, {
        actionId: binding.actionId, machineId: binding.machineId, envelope });
  }
  if (
    isProjectWorkspaceSyncOpenActionV1(binding.actionId) ||
    isProjectWorkspaceSyncPreparationActionV1(binding.actionId)
  ) {
    const envelope = source.originalActionEnvelope;
    const constraints =
      'grant' in binding
        ? {
            models: binding.grant.models,
            permissionModes: binding.grant.permissionModes,
          }
        : undefined;
    return (
      !!context &&
      !!envelope &&
      source.phase === 'prepare' &&
      source.sourceSessionId === undefined &&
      source.accountServerId === binding.serverIdentityId &&
      context.machineAdmission.machineId === source.sourceMachineId &&
      context.machineAdmission.actorAccountId === binding.accountId &&
      (context.callerAuthority === 'account_automation' ||
        context.callerAuthority ===
          resolveExternalActionRootInvocationAuthority(authorization)) &&
      sameStrictJsonValue(
        binding.sessionActionOrigin ?? null,
        context.sessionActionOrigin ?? null,
      ) &&
      sameStrictJsonValue(
        constraints ?? null,
        context.callerInputConstraints ?? null,
      ) &&
      binding.target.kind === 'machine' &&
      binding.target.machineId === binding.machineId &&
      isExternalActionAuthorizationBoundToEnvelope(binding, {
        actionId: binding.actionId,
        machineId: binding.machineId,
        envelope,
      })
    );
  }
  if (!context || !handoff) return false;
  const admission = context.machineAdmission;
  const constraints =
    'grant' in binding
      ? {
          models: binding.grant.models,
          permissionModes: binding.grant.permissionModes,
        }
      : undefined;
  return (
    binding.actionId === 'session.handoff' &&
    !binding.handoffContinuation &&
    (source.phase === 'prepare' || source.phase === 'finalize') &&
    binding.machineId === handoff.sourceMachineId &&
    binding.installationId === handoff.sourceInstallationId &&
    admission.machineId === binding.machineId &&
    admission.installationId === binding.installationId &&
    admission.actorAccountId === binding.accountId &&
    admission.custodianAccountId === binding.custodianAccountId &&
    ((binding.admittedMachineRole ?? (binding.custodianAccountId === binding.accountId ? 'manage' : 'use')) === 'manage' || admission.role === 'use') &&
    binding.target.kind === 'machine' &&
    binding.target.machineId === binding.machineId &&
    source.sourceMachineId === handoff.sourceMachineId &&
    source.sourceSessionId === handoff.sessionId &&
    source.operationId === binding.requestId &&
    source.accountServerId === binding.serverIdentityId &&
    (context.callerAuthority === 'account_automation' ||
      context.callerAuthority ===
        resolveExternalActionRootInvocationAuthority(authorization)) &&
    sameStrictJsonValue(
      binding.sessionActionOrigin ?? null,
      context.sessionActionOrigin ?? null,
    ) &&
    sameStrictJsonValue(
      constraints ?? null,
      context.callerInputConstraints ?? null,
    )
  );
}

/** Signed Project roots retain their logical source; current Account refs prove the target at the controller. */
export function doesWorkspaceSyncFinitePrepareRequestMatchRouting(
  params: unknown,
  authorization: ExternalActionExecutionAuthorizationV1,
  source: WorkspaceSyncSourceRoutingV1,
): boolean {
  const actionId = authorization.binding.actionId;
  const body = WorkspaceSyncPrepareBetweenRequestV1Schema.safeParse(params);
  if (
    !isProjectWorkspaceSyncPreparationActionV1(actionId) ||
    !body.success ||
    !doesWorkspaceSyncSourceRootMatchRouting(authorization, source)
  )
    return false;
  const envelope = source.originalActionEnvelope!;
  // Protected input is opened only by the controller's admitted requester custody,
  // before the runtime resolves either WorkspaceRef. Never use custodian keys here.
  if (envelope.v === 2) return true;
  if (actionId === 'projects.service.relocate') {
    const input = ProjectServiceRelocateInputV1Schema.safeParse(envelope.input);
    return (
      input.success &&
      input.data.workspace.refId === body.data.sourceWorkspaceRefId &&
      input.data.workspace.serverId === source.accountServerId
    );
  }
  const input =
    actionId === 'localServices.launcher.start'
      ? DaemonLocalServiceLauncherStartRequestV1Schema.safeParse(envelope.input)
      : PROJECT_ACTION_INPUT_SCHEMAS_V1[actionId].safeParse(envelope.input);
  return (
    input.success &&
    !!input.data.workspace &&
    input.data.workspace.workspaceId === body.data.sourceWorkspaceRefId &&
    input.data.workspace.serverId === source.accountServerId &&
    input.data.workspace.machineId === source.sourceMachineId &&
    input.data.workspace.rootPath === source.sourceRootPath
  );
}

/**
 * A TARGET bootstrap prepare carries exactly the definition its requester's admitted
 * workspace action names: owner kind, content policy and, for a relationship, mode.
 * Boundary (ruling 2026-11-24 23:56Z (3)): a handoff to an owner or Manage TARGET retains no capture,
 * so Home's admission of the session.handoff root is its whole admission; this check applies where a capture exists.
 */
export function doesWorkspaceSyncTargetPrepareMatchAdmittedAction(
  request: WorkspaceSyncTargetBootstrapPrepareV1,
  action: HandoffWorkspaceActionV1,
): boolean {
  if (action.kind !== 'copy_once' && action.kind !== 'create_relationship') return false;
  const operation = request.owner.kind === 'copy_once' ? request.owner.operation : request.transientRelationship;
  if (!operation || request.policyDigest !== action.contentPolicy.policyDigest
    || !sameStrictJsonValue(operation.contentPolicy, action.contentPolicy)) return false;
  return request.owner.kind === 'relationship'
    ? action.kind === 'create_relationship' && 'mode' in operation && operation.mode === action.mode
    : action.kind === 'copy_once';
}

/** The named Project SOURCE body retains its original chosen child and namespace. */
export function doesWorkspaceSyncProjectSourceRequestMatchRouting(
  params: unknown,
  authorization: ExternalActionExecutionAuthorizationV1,
  source: WorkspaceSyncSourceRoutingV1,
): boolean {
  const input = OpenProjectInputV1Schema.safeParse(params);
  if (
    !isProjectWorkspaceSyncOpenActionV1(authorization.binding.actionId) ||
    !input.success ||
    !doesWorkspaceSyncSourceRootMatchRouting(authorization, source) ||
    input.data.machineId !== authorization.binding.machineId ||
    input.data.serverId !== source.accountServerId ||
    input.data.materialization.kind !== 'sync' ||
    !['copy_once', 'create_relationship'].includes(
      input.data.materialization.workspaceAction.kind,
    )
  )
    return false;
  const selected =
    input.data.source.kind === 'workspace'
      ? input.data.source.checkout
      : input.data.source.kind === 'source'
        ? input.data.source.checkout
        : undefined;
  if (
    !selected ||
    selected.serverId !== source.accountServerId ||
    selected.machineId !== source.sourceMachineId ||
    selected.rootPath !== source.sourceRootPath
  )
    return false;
  const envelope = source.originalActionEnvelope!;
  return envelope.v !== 1 || sameStrictJsonValue(envelope.input, input.data);
}

export function doesWorkspaceSyncSourceWriterTargetRootMatchRouting(
  authorization: ExternalActionExecutionAuthorizationV1,
  routing: WorkspaceSyncSourceWriterTargetRoutingV1,
  admission?: SocketRpcMachineAdmissionContextV1,
): boolean {
  if ((routing.target.phase === 'inspect' || routing.target.phase === 'remove')
    && doesWorkspaceSyncCopyRetirementRootMatchV1(authorization, routing)) {
    return !admission || admission.machineId === routing.sourceWriter.machineId
      && admission.installationId === routing.sourceWriter.installationId
      && admission.actorAccountId === admission.custodianAccountId;
  }
  if (isWorkspaceSyncRelationshipWriteActionId(authorization.binding.actionId)) {
    const envelope = routing.source.originalActionEnvelope;
    const inputSchema = WORKSPACE_SYNC_RELATIONSHIP_WRITE_ACTION_INPUT_SCHEMAS_V1[authorization.binding.actionId];
    const original = envelope?.v === 1 ? inputSchema.safeParse(envelope.input) : undefined;
    return doesWorkspaceSyncSourceRootMatchRouting(authorization, routing.source)
      && routing.target.accountServerId === authorization.binding.serverIdentityId
      // Protected input is opened and matched by the admitted source controller.
      // Home and the target retain its signed envelope without reading content.
      && (envelope?.v === 2 || !!original?.success
        && original.data !== null && typeof original.data === 'object'
        && 'targetMachineId' in original.data && original.data.targetMachineId === routing.target.targetMachineId
        && 'targetPath' in original.data && original.data.targetPath === routing.target.targetRootPath)
      && (!admission || admission.machineId === routing.target.targetMachineId
        && admission.actorAccountId === authorization.binding.accountId);
  }
  if (isProjectWorkspaceSyncOpenActionV1(authorization.binding.actionId)) {
    return (
      doesWorkspaceSyncSourceRootMatchRouting(authorization, routing.source) &&
      routing.target.targetMachineId === authorization.binding.machineId &&
      routing.target.accountServerId ===
        authorization.binding.serverIdentityId &&
      (!admission ||
        (admission.machineId === authorization.binding.machineId &&
          admission.installationId === authorization.binding.installationId &&
          admission.actorAccountId === authorization.binding.accountId))
    );
  }
  const handoff = authorization.binding.handoffAdmission;
  return (
    doesWorkspaceSyncSourceRootMatchRouting(authorization, routing.source) &&
    !!handoff &&
    routing.target.targetMachineId === handoff.targetMachineId &&
    routing.target.accountServerId === authorization.binding.serverIdentityId &&
    (routing.target.phase !== 'release' ||
      routing.target.operationId === routing.source.operationId ||
      routing.target.operationId === deriveWorkspaceSyncRelationshipId(routing.source.operationId)) &&
    (!admission ||
      (admission.machineId === handoff.targetMachineId &&
        admission.installationId === handoff.targetInstallationId &&
        admission.actorAccountId === authorization.binding.accountId))
  );
}

/** The second hop keeps the writer's snapshot and the chosen child's exact admitted caller ceiling. */
export function doesWorkspaceSyncTargetRoutingMatchWriterTarget(
  target: WorkspaceSyncTargetRoutingV1,
  writer: WorkspaceSyncSourceWriterTargetRoutingV1,
): boolean {
  const { targetContext, ...purpose } = target;
  const sourceContext = writer.source.sourceContext;
  return (
    sameStrictJsonValue(purpose, writer.target) &&
    targetContext.machineAdmission.machineId ===
      writer.target.targetMachineId &&
    (
      [
        'callerAuthority',
        'sessionActionOrigin',
        'callerInputConstraints',
        'callerPermissionMode',
        'causalPermissionAuthority',
        'workspaceWrites',
      ] as const
    ).every((key) =>
      sameStrictJsonValue(
        targetContext[key] ?? null,
        sourceContext[key] ?? null,
      ),
    )
  );
}

/** Seed retains the admitted source writer and target; Project Open also retains its original SOURCE packet. */
export function doesWorkspaceSyncSeedRootMatchRouting(
  authorization: ExternalActionExecutionAuthorizationV1,
  seed: WorkspaceSyncSeedRoutingV1,
  execution?: WorkspaceSyncSourceExecutionV1,
  operationId?: string,
): boolean {
  if (!doesWorkspaceSyncSourceWriterTargetRootMatchRouting(
      authorization,
      seed.sourceWriterTarget,
      seed.target.targetContext.machineAdmission,
    ) || !doesWorkspaceSyncTargetRoutingMatchWriterTarget(
      seed.target,
      seed.sourceWriterTarget,
    )) return false;
  const seedProof = readWorkspaceSyncSeedProofKindV1(authorization.binding.actionId);
  if (!seedProof) return false;
  if (operationId !== undefined && operationId !== seed.sourceWriterTarget.source.operationId
      && !(seedProof === 'writer_target' && operationId === deriveWorkspaceSyncRelationshipId(seed.sourceWriterTarget.source.operationId))) return false;
  if (authorization.binding.actionId === SESSION_HANDOFF_ACTION_ID_V1
      && authorization.binding.custodianAccountId !== authorization.binding.accountId
      && authorization.binding.admittedMachineRole !== 'manage'
      && seed.target.targetContext.machineAdmission.custodianAccountId !== authorization.binding.accountId) {
    return false;
  }
  if (seedProof === 'writer_target') return execution === undefined;
  return (
    isProjectWorkspaceSyncOpenActionV1(authorization.binding.actionId) && !!execution &&
    execution.method ===
      `${seed.sourceWriterTarget.sourceWriter.machineId}:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_MATERIALIZE_FOR_OPEN}` &&
    isProjectWorkspaceSyncOpenActionV1(execution.externalActionExecution.effectActionId) &&
    execution.externalActionExecution.installationId ===
      authorization.binding.installationId &&
    sameStrictJsonValue(
      execution.externalActionExecution.authorization,
      authorization,
    )
  );
}

/** Local installation facts and the current Home verification boundary. */
export type PrivateWorkspaceSyncTargetAdmission = Readonly<{
  context: SocketRpcMachineAdmissionContextV1;
  receivingMachine: Readonly<{ machineId: string; installationId: string }>;
  request: unknown;
  /** Signed target phase or an authenticated continuation of the bound job. */
  routing: WorkspaceSyncSourceWriterTargetRoutingV1['target'] | Readonly<{
    phase: 'recover'; accountServerId: string;
  } & WorkspaceSyncTargetConflictRecoverV1>;
  targetWorkspaceRefId?: string;
}>;

export type PrivateWorkspaceSyncTargetExecutionResolution =
  | Readonly<{ kind: 'matched'; capture: RetainedWorkspaceSyncPrivateExecution }>
  | Readonly<{ kind: 'native_admitted' }>
  | Readonly<{ kind: 'private_unavailable' }>
  | Readonly<{ kind: 'no_private_capture' }>;

export type MachineRpcAdmissionBoundary = Readonly<{
  machineId: string;
  isDaemonShuttingDown?: () => boolean;
  resolveHomeServerIdentityId?: (
    signal?: AbortSignal,
  ) => Promise<string | null>;
  resolveCustodianAccountId: (signal?: AbortSignal) => Promise<string | null>;
  resolveInstallationId: () => string | null;
  readAgentIsolation?: Parameters<typeof canExecuteRequesterWorkspaceOnDaemonForHost>[1];
  /** Cheap exact active-operation lookup; never selects a requester or re-evaluates permissions. */
  resolvePrivateWorkspaceSyncTargetExecution?: (input: PrivateWorkspaceSyncTargetAdmission) => PrivateWorkspaceSyncTargetExecutionResolution;
  verifyMachineAdmission: (
    input: Readonly<{
      context: SocketRpcMachineAdmissionContextV1;
      method: string;
      custodySubjectAccountId?: string;
      workspaceSyncSourceRouting?: WorkspaceSyncSourceRoutingV1;
      workspaceSyncSourceExecution?: WorkspaceSyncSourceExecutionV1;
      workspaceSyncTargetRouting?: WorkspaceSyncTargetRoutingV1;
      workspaceSyncSourceWriterTargetRouting?: WorkspaceSyncSourceWriterTargetRoutingV1;
      workspaceSyncSeedRouting?: WorkspaceSyncSeedRoutingV1;
      callerInputAuthorization?: ExternalActionExecutionAuthorizationV1;
      signal?: AbortSignal;
    }>,
  ) => Promise<boolean | ReturnType<typeof MachineAdmissionVerifyResponseV1Schema.parse> | null>;
}>;

/**
 * Home is the authenticated connection, not a caller-local server profile label.
 * Bind Machine inputs to that connection's admitted installation and custodian.
 * Session/indirect inputs may omit machineId; explicit Machine targets must match.
 * Callers still reverify current admission at their effect/disclosure boundary.
 */
export function doesMachineRpcTargetMatchAdmission(
  request: unknown,
  admission: SocketRpcMachineAdmissionContextV1 | undefined,
  target: Readonly<{
    machineId: string;
    installationId: string;
    custodianAccountId: string | null;
  }> | null,
  onDenial?: (predicate: RpcAdmissionPredicate) => void,
): boolean {
  const deny = (predicate: RpcAdmissionPredicate) => {
    onDenial?.(predicate);
    return false;
  };
  if (!target || !admission) return deny('machine_admission');
  if (admission.machineId !== target.machineId) return deny('machine_target');
  if (admission.installationId !== target.installationId)
    return deny('machine_installation');
  if (admission.custodianAccountId !== target.custodianAccountId)
    return deny('machine_custodian');
  if (
    request &&
    typeof request === 'object' &&
    'machineId' in request &&
    request.machineId !== admission.machineId
  ) {
    return deny('machine_request_target');
  }
  return true;
}

/** This read proves current access; the signed context is not a reusable admission ticket. */
export type MachineRpcAdmissionCurrentInput = Readonly<{
  context: SocketRpcMachineAdmissionContextV1;
  custodySubjectAccountId?: string;
  workspaceSyncSourceRouting?: WorkspaceSyncSourceRoutingV1;
  workspaceSyncSourceExecution?: WorkspaceSyncSourceExecutionV1;
  workspaceSyncTargetRouting?: WorkspaceSyncTargetRoutingV1;
  workspaceSyncSourceWriterTargetRouting?: WorkspaceSyncSourceWriterTargetRoutingV1;
  workspaceSyncSeedRouting?: WorkspaceSyncSeedRoutingV1;
  callerInputAuthorization?: ExternalActionExecutionAuthorizationV1;
  /** Actual local signer, usable only for the exact private physical SOURCE purpose. */
  workspaceSyncSourceReceiver?: Readonly<{
    machineId: string;
    installationId: string;
    /** Installed original Project target discovers only its verified physical SOURCE recipient. */
    destinationMachineId?: string;
    accountId?: string;
  }>;
  /** Actual local signer, usable only for the exact private physical TARGET purposes. */
  workspaceSyncTargetReceiver?: Readonly<{
    machineId: string;
    installationId: string;
    /** Outgoing installed D -> P2 joint purpose; the proof remains signed by D. */
    destinationMachineId?: string;
    accountId?: string;
  }>;
  /** Actual installed writer/receiver; its own Account is independent of the retained actor. */
  workspaceSyncSourceWriterTargetReceiver?: Readonly<{
    machineId: string;
    installationId: string;
    accountId: string;
    destinationMachineId?: string;
  }>;
  /** Actual installed seed sender/receiver; Home verifies both physical writers independently. */
  workspaceSyncSeedReceiver?: Readonly<{
    machineId: string;
    installationId: string;
    accountId: string;
    destinationMachineId?: string;
  }>;
  privateKey: string | Uint8Array;
  daemonToken: string;
  serverHttpBaseUrl: string;
  signal?: AbortSignal;
}> &
  (
    | Readonly<{ method: string; purpose?: never }>
    | Readonly<{
        purpose: RequesterSessionCurrentnessPurposeV1;
        method?: never;
      }>
  );

export async function verifyMachineRpcAdmissionCurrent(
  input: MachineRpcAdmissionCurrentInput,
): Promise<boolean> {
  return (await readMachineRpcAdmissionCurrent(input)) !== null;
}

export type MachineRpcAdmissionVerificationFailure = Readonly<{
  stage: 'input_validation' | 'proof_signing' | 'transport' | 'request_cancelled' | 'response_status' | 'response_schema';
  status?: number;
  transportCode?: string;
}>;

/** Same verification owner, retaining the Home-proven destination identity for the physical writer. */
export async function readMachineRpcAdmissionCurrent(
  input: MachineRpcAdmissionCurrentInput,
  onFailure?: (failure: MachineRpcAdmissionVerificationFailure) => void,
): Promise<ReturnType<
  typeof MachineAdmissionVerifyResponseV1Schema.parse
> | null> {
  try {
    return await readMachineRpcAdmissionCurrentOrThrow(input, onFailure);
  } catch {
    return null;
  }
}

/** Requester custody must distinguish unavailable Home evidence from a denial.
 * The boolean/null adapters retain their existing fail-closed contract. */
export async function readMachineRpcAdmissionCurrentOrThrow(
  input: MachineRpcAdmissionCurrentInput,
  onFailure?: (failure: MachineRpcAdmissionVerificationFailure) => void,
): Promise<ReturnType<
  typeof MachineAdmissionVerifyResponseV1Schema.parse
> | null> {
  type VerificationStage = MachineRpcAdmissionVerificationFailure['stage'];
  let stage: VerificationStage = 'input_validation';
  const failed = (
    failureStage: VerificationStage,
    status?: number,
    transportCode?: string,
  ) => {
    if (onFailure) {
      onFailure({ stage: failureStage,
        ...(status === undefined ? {} : { status }),
        ...(transportCode ? { transportCode } : {}) });
      return null;
    }
    const candidateMethod = input.method?.slice(input.method.indexOf(':') + 1);
    const method =
      input.purpose?.kind === 'requester_session_currentness'
        ? input.purpose.kind
        : Object.values(RPC_METHODS).some((known) => known === candidateMethod)
          ? candidateMethod
          : '<unregistered>';
    logger.infoFile('[RPC] Machine admission verification failed', {
      method,
      ...(input.purpose?.kind === 'requester_session_currentness' ? { sessionId: input.purpose.sessionId } : {}),
      stage: failureStage,
      ...(status === undefined ? {} : { status }),
      ...(transportCode ? { transportCode } : {}),
    });
    return null;
  };
  // The signed preflight caller logs its Action request once, including local
  // validation exits which never reached the Home HTTP boundary.
  const refuseInput = () => onFailure ? failed('input_validation') : null;
  try {
    const context = SocketRpcMachineAdmissionContextV1Schema.parse(
      input.context,
    );
    const purpose =
      input.purpose === undefined
        ? undefined
        : RequesterSessionCurrentnessPurposeV1Schema.parse(input.purpose);
    if (
      purpose &&
      (input.custodySubjectAccountId !== undefined ||
        input.workspaceSyncSourceRouting !== undefined ||
        input.workspaceSyncSourceExecution !== undefined ||
        input.workspaceSyncTargetRouting !== undefined ||
        input.workspaceSyncSourceReceiver !== undefined ||
        input.workspaceSyncTargetReceiver !== undefined ||
        input.callerInputAuthorization !== undefined ||
        input.workspaceSyncSeedRouting !== undefined ||
        input.workspaceSyncSeedReceiver !== undefined ||
        input.workspaceSyncSourceWriterTargetRouting !== undefined ||
        input.workspaceSyncSourceWriterTargetReceiver !== undefined)
    )
      return refuseInput();
    const admissionPurpose = purpose ? { purpose } : { method: input.method! };
    const custody =
      input.custodySubjectAccountId === undefined
        ? {}
        : { custodySubjectAccountId: input.custodySubjectAccountId };
    const sourceRouting =
      input.workspaceSyncSourceRouting === undefined
        ? undefined
        : WorkspaceSyncSourceRoutingV1Schema.parse(
            input.workspaceSyncSourceRouting,
          );
    const sourceExecution =
      input.workspaceSyncSourceExecution === undefined
        ? undefined
        : WorkspaceSyncSourceExecutionV1Schema.parse(
            input.workspaceSyncSourceExecution,
          );
    const originalRoot =
      input.callerInputAuthorization === undefined
        ? undefined
        : ExternalActionExecutionAuthorizationV1Schema.parse(
            input.callerInputAuthorization,
          );
    const deploymentRouting =
      sourceExecution?.externalActionExecution.deploymentChildRouting;
    // The one cross-Machine child owner names the family; this receiver keeps
    // the family's operand facts and its exact signed source packet below.
    const childFamily = originalRoot && sourceExecution && input.method?.startsWith(`${context.machineId}:`)
      ? readReviewedMachineRpcChildFamilyV1({
          binding: originalRoot.binding,
          effectActionId: sourceExecution.externalActionExecution.effectActionId,
          method: input.method.slice(input.method.indexOf(':') + 1),
          target: context,
          reviewedChild: sourceExecution.externalActionExecution.reviewedChild,
        })
      : null;
    const childOperandAdmitted =
      childFamily === 'deployment'
        ? deploymentRouting?.actionId === sourceExecution?.externalActionExecution.effectActionId &&
          deploymentRouting?.machineId === context.machineId &&
          deploymentRouting.installationId === context.installationId
        : childFamily === 'stop'
          ? sourceExecution !== undefined && isSessionStopChildV1({
              rootActionId: originalRoot?.binding.actionId ?? '',
              effectActionId: sourceExecution.externalActionExecution.effectActionId,
              method: RPC_METHODS.STOP_SESSION,
              target: sourceExecution.externalActionExecution.target,
              params: sourceExecution.params,
            })
          : childFamily === 'setup_plan' || childFamily === 'backup_receiver_setup'
            ? context.role === 'manage'
            : childFamily !== null;
    const moveChild = Boolean(
      originalRoot &&
      childOperandAdmitted &&
      sourceExecution?.originalActionEnvelope &&
      !sourceRouting &&
      !input.workspaceSyncTargetRouting &&
      !input.workspaceSyncSourceWriterTargetRouting &&
      !input.workspaceSyncSeedRouting &&
      sourceExecution.method === input.method &&
      input.method?.startsWith(`${context.machineId}:`) &&
      context.actorAccountId === originalRoot.binding.accountId &&
      sameStrictJsonValue(
        sourceExecution.externalActionExecution.authorization,
        originalRoot,
      ),
    );
    const seed =
      input.workspaceSyncSeedRouting === undefined
        ? undefined
        : WorkspaceSyncSeedRoutingV1Schema.parse(
            input.workspaceSyncSeedRouting,
          );
    const seedReceiver = input.workspaceSyncSeedReceiver;
    if (
      (seed &&
        (!seedReceiver ||
          !originalRoot ||
          input.workspaceSyncSourceRouting ||
          input.workspaceSyncTargetRouting ||
          input.workspaceSyncSourceWriterTargetRouting ||
          input.workspaceSyncSourceReceiver ||
          input.workspaceSyncTargetReceiver ||
          input.workspaceSyncSourceWriterTargetReceiver ||
          input.custodySubjectAccountId ||
          input.method !==
            `${seedReceiver.destinationMachineId ?? seedReceiver.machineId}:${RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_PREPARE}` ||
          (seedReceiver.destinationMachineId ?? seedReceiver.machineId) !==
            seed.sourceWriterTarget.sourceWriter.machineId ||
          (!seedReceiver.destinationMachineId &&
            seedReceiver.installationId !==
              seed.sourceWriterTarget.sourceWriter.installationId) ||
          !sameStrictJsonValue(
            context,
            seed.sourceWriterTarget.source.sourceContext.machineAdmission,
          ) ||
          !doesWorkspaceSyncSeedRootMatchRouting(
            originalRoot,
            seed,
            sourceExecution,
          ))) ||
      (seedReceiver && !seed)
    )
      return null;
    const projectSource =
      isProjectWorkspaceSyncOpenActionV1(originalRoot?.binding.actionId) &&
      sourceRouting !== undefined;
    const finiteSource =
      sourceRouting !== undefined &&
      isProjectWorkspaceSyncPreparationActionV1(originalRoot?.binding.actionId);
    const projectSourceMethod = finiteSource
      ? RPC_METHODS.DAEMON_WORKSPACE_SYNC_PREPARE_BETWEEN
      : RPC_METHODS.DAEMON_WORKSPACE_SYNC_MATERIALIZE_FOR_OPEN;
    const sourceReceiver = input.workspaceSyncSourceReceiver;
    if (
      (sourceRouting &&
        (!sourceReceiver ||
          input.method !==
            `${sourceReceiver.destinationMachineId ?? sourceReceiver.machineId}:${
              projectSource || finiteSource
                ? projectSourceMethod
                : RPC_METHODS.DAEMON_WORKSPACE_SYNC_HANDOFF_SOURCE_PHASE
            }` ||
          sourceRouting.sourceMachineId !== context.machineId)) ||
      (sourceReceiver && !sourceRouting)
    )
      return null;
    if (
      sourceReceiver?.destinationMachineId !== undefined &&
      (!(projectSource || finiteSource) ||
        !originalRoot ||
        originalRoot.binding.machineId !== sourceReceiver.machineId ||
        originalRoot.binding.installationId !== sourceReceiver.installationId ||
        !doesWorkspaceSyncSourceRootMatchRouting(originalRoot, sourceRouting!))
    )
      return null;
    const writerTarget =
      input.workspaceSyncSourceWriterTargetRouting === undefined
        ? undefined
        : WorkspaceSyncSourceWriterTargetRoutingV1Schema.parse(
            input.workspaceSyncSourceWriterTargetRouting,
          );
    const writerTargetReceiver = input.workspaceSyncSourceWriterTargetReceiver;
    if (
      sourceExecution &&
      (!(
        moveChild ||
        seed ||
        projectSource ||
        finiteSource ||
        (writerTarget && isProjectWorkspaceSyncOpenActionV1(originalRoot?.binding.actionId))
      ) ||
        sourceReceiver?.destinationMachineId !== undefined)
    )
      return null;
    const targetRouting =
      input.workspaceSyncTargetRouting === undefined
        ? undefined
        : WorkspaceSyncTargetRoutingV1Schema.parse(
            input.workspaceSyncTargetRouting,
          );
    const targetReceiver = input.workspaceSyncTargetReceiver;
    if (
      targetReceiver?.destinationMachineId !== undefined &&
      (!writerTarget ||
        !targetRouting ||
        typeof targetReceiver.destinationMachineId !== 'string' ||
        !targetReceiver.destinationMachineId.trim() ||
        targetReceiver.destinationMachineId !==
          targetReceiver.destinationMachineId.trim() ||
        targetReceiver.machineId !== targetRouting.targetMachineId ||
        targetReceiver.installationId !==
          targetRouting.targetContext.machineAdmission.installationId ||
        !sameStrictJsonValue(
          context,
          targetRouting.targetContext.machineAdmission,
        ))
    )
      return refuseInput();
    const targetMethodMachineId =
      targetReceiver?.destinationMachineId ?? targetReceiver?.machineId;
    if (
      (writerTarget &&
        (sourceRouting ||
          sourceReceiver ||
          (targetRouting &&
            (!targetReceiver ||
              writerTargetReceiver ||
              !doesWorkspaceSyncTargetRoutingMatchWriterTarget(
                targetRouting,
                writerTarget,
              ))) ||
          (!targetRouting && targetReceiver) ||
          !isWorkspaceSyncSourceWriterTargetMethodV1(writerTarget.target.phase, input.method,
            targetMethodMachineId ?? writerTargetReceiver?.destinationMachineId ?? writerTargetReceiver?.machineId ?? context.machineId) ||
          (isWorkspaceSyncSourceWriterCleanupPhaseV1(writerTarget.target.phase) && writerTarget.target.phase !== 'release' &&
            (Boolean(targetRouting || sourceExecution)
              || (originalRoot ? !doesWorkspaceSyncCopyRetirementRootMatchV1(originalRoot, writerTarget)
                : writerTarget.target.phase === 'remove'))) ||
          (writerTarget.target.phase === 'release' && originalRoot !== undefined &&
            (Boolean(targetRouting || sourceExecution)
              || !isSignedWorkspaceSyncHandoffReleaseV1(writerTarget, originalRoot)
              || !doesWorkspaceSyncSourceWriterTargetRootMatchRouting(
                originalRoot,
                writerTarget,
              ))) ||
          (!isWorkspaceSyncSourceWriterCleanupPhaseV1(writerTarget.target.phase) &&
            (!originalRoot ||
              !doesWorkspaceSyncSourceWriterTargetRootMatchRouting(
                originalRoot,
                writerTarget,
              ))))) ||
      (writerTargetReceiver && !writerTarget)
    )
      return refuseInput();
    if (
      writerTargetReceiver?.destinationMachineId &&
      (!writerTarget ||
        writerTargetReceiver.machineId !==
          writerTarget.sourceWriter.machineId ||
        writerTargetReceiver.installationId !==
          writerTarget.sourceWriter.installationId ||
        ((!isWorkspaceSyncSourceWriterCleanupPhaseV1(writerTarget.target.phase)
            || isSignedWorkspaceSyncHandoffReleaseV1(writerTarget, originalRoot)) &&
          !sameStrictJsonValue(
            context,
            writerTarget.source.sourceContext.machineAdmission,
          )))
    )
      return refuseInput();
    if (
      originalRoot &&
      !moveChild &&
      !writerTarget &&
      !seed &&
      (!sourceRouting ||
        !sourceReceiver ||
        (sourceRouting.phase !== 'prepare' &&
          sourceRouting.phase !== 'finalize') ||
        !(
          originalRoot.binding.actionId === 'session.handoff' ||
          isProjectWorkspaceSyncOpenActionV1(originalRoot.binding.actionId) ||
          isProjectWorkspaceSyncPreparationActionV1(
            originalRoot.binding.actionId,
          )
        ))
    )
      return null;
    const retainedRoot = originalRoot
      ? { callerInputAuthorization: originalRoot }
      : {};
    if (
      (sourceRouting && targetRouting) ||
      (sourceReceiver && targetReceiver) ||
      (targetRouting &&
        (isWorkspaceSyncSourceWriterCleanupPhaseV1(targetRouting.phase) && targetRouting.phase !== 'release' ||
          !targetReceiver ||
          targetRouting.targetMachineId !== context.machineId ||
          input.method !==
            `${targetMethodMachineId}:${readWorkspaceSyncTargetMethod(targetRouting.phase)}`)) ||
      (targetReceiver && !targetRouting)
    )
      return null;
    const signer = seedReceiver ??
      writerTargetReceiver ??
      sourceReceiver ??
      targetReceiver ?? {
        machineId: context.machineId,
        installationId: context.installationId,
      };
    const routing = {
      ...(sourceRouting ? { workspaceSyncSourceRouting: sourceRouting } : {}),
      ...(sourceExecution
        ? { workspaceSyncSourceExecution: sourceExecution }
        : {}),
      ...(targetRouting ? { workspaceSyncTargetRouting: targetRouting } : {}),
      ...(writerTarget
        ? { workspaceSyncSourceWriterTargetRouting: writerTarget }
        : {}),
      ...(seed ? { workspaceSyncSeedRouting: seed } : {}),
    };
    stage = 'proof_signing';
    const proof = signMachineInstallationProof({
      payload: {
        version: 1,
        machineId: signer.machineId,
        installationId: signer.installationId,
        accountId:
          seedReceiver?.accountId ??
          writerTargetReceiver?.accountId ??
          sourceReceiver?.accountId ??
          targetReceiver?.accountId ??
          context.custodianAccountId,
        rpcAdmission: {
          context,
          ...admissionPurpose,
          ...custody,
          ...routing,
          ...retainedRoot,
        },
      },
      privateKey: input.privateKey,
    });
    stage = 'transport';
    const response = await axios.post<unknown>(
      `${input.serverHttpBaseUrl}/v1/machines/${encodeURIComponent(signer.machineId)}/admission/verify`,
      {
        v: 1,
        context,
        ...admissionPurpose,
        proof,
        ...custody,
        ...routing,
        ...retainedRoot,
      },
      {
        headers: {
          Authorization: `Bearer ${input.daemonToken}`,
          'Content-Type': 'application/json',
        },
        // The containing RPC owns its deadline and cancellation. A second,
        // shorter HTTP cutoff must not turn a still-valid read into a denial.
        timeout: input.signal ? 0 : 15_000,
        validateStatus: () => true,
        ...(input.signal ? { signal: input.signal } : {}),
      },
    );
    if (input.signal?.aborted) return failed('request_cancelled');
    if (response.status < 200 || response.status >= 300) {
      stage = 'response_status';
      const error = createHttpStatusError(
        response.status,
        'Machine admission Home verification failed',
      );
      if (classifyServerEndpointError(error).kind !== 'auth_failed')
        throw error;
      return failed('response_status', response.status);
    }
    const result = MachineAdmissionVerifyResponseV1Schema.safeParse(
      response.data,
    );
    if (result.success) return result.data;
    stage = 'response_schema';
    failed(stage, response.status);
    throw new Error('machine_admission_invalid_response');
  } catch (error) {
    if (input.signal?.aborted) return failed('request_cancelled');
    if (stage === 'response_schema') throw error;
    // Axios errors carry credentials and response bodies. Retain only known transport codes.
    const code =
      axios.isAxiosError(error) &&
      [
        'ECONNABORTED',
        'ETIMEDOUT',
        'ECONNRESET',
        'ECONNREFUSED',
        'EPIPE',
        'ENOTFOUND',
        'EAI_AGAIN',
        'ERR_NETWORK',
        'ERR_CANCELED',
      ].includes(error.code ?? '')
        ? error.code
        : undefined;
    failed(
      stage,
      stage === 'response_status'
        ? (readHttpStatus(error) ?? undefined)
        : undefined,
      code,
    );
    const classification = classifyServerEndpointError(error);
    if (classification.retryable) throw error;
    if (classification.kind !== 'auth_failed')
      throw new Error('machine_admission_verification_unavailable');
    return null;
  }
}

function readSessionIdFromParams(
  params: unknown,
  method: string,
): string | null {
  if (!params || typeof params !== 'object') return null;
  const unscopedMethod = method.slice(method.lastIndexOf(':') + 1);
  const replay = Reflect.get(params, 'replay');
  const sessionId =
    unscopedMethod === RPC_METHODS.SESSION_FORK ||
    unscopedMethod === RPC_METHODS.SESSION_FORK_PROVIDER_SAFE
      ? Reflect.get(params, 'parentSessionId')
      : unscopedMethod === RPC_METHODS.SESSION_CONTINUE_WITH_REPLAY
        ? replay && typeof replay === 'object'
          ? Reflect.get(replay, 'previousSessionId')
          : undefined
        : Reflect.get(params, resolveSocketRpcSessionAuthorization(method)?.sessionIdParam ?? 'sessionId');
  return typeof sessionId === 'string' && sessionId.trim().length > 0
    ? sessionId.trim()
    : null;
}

function forbidden(
  admissionPredicate: RpcAdmissionPredicate = 'machine_admission',
): RpcAuthorizationResult {
  return {
    ok: false,
    error: RPC_ERROR_MESSAGES.FORBIDDEN,
    errorCode: RPC_ERROR_CODES.FORBIDDEN,
    admissionPredicate,
  };
}

export { readWorkspaceSyncTargetMethodV1 as readWorkspaceSyncTargetMethod } from '@happier-dev/protocol/socketRpc';

/**
 * The one capture-required decision. On another person's Machine, a requester
 * without Manage gets TARGET workspace effects only inside their own member
 * capture (owner rulings 2026-10-31, 2026-11-14, 2026-11-15). The custodian and
 * Manage grantees keep native placement. Ingress, the in-process entry and the
 * handoff capture owner all consume this result.
 */
export function requiresRequesterWorkspaceCapture(
  admission: Pick<SocketRpcMachineAdmissionContextV1, 'actorAccountId' | 'custodianAccountId' | 'role'>,
): boolean {
  return admission.actorAccountId !== admission.custodianAccountId && admission.role !== 'manage';
}

export function requesterWorkspaceCaptureRequired(): Extract<RpcAuthorizationResult, { ok: false }> {
  return { ok: false, errorCode: 'machine_manage_required',
    error: 'Writing outside your own folder needs Manage access to this Machine' };
}

/**
 * In-process admission for a SOURCE-writer TARGET phase on this same Machine.
 * Home never delivers a daemon's own signed call back to its socket, so this is
 * the delivery Home and this ingress apply to a writer-target phase, decided from
 * what the writer already holds: the SOURCE admission Home minted on this Machine
 * is the target admission Home resolves for the same actor here. Cleanup runs as
 * this installed writer. No Home round-trip: the root was admitted once at mint.
 */
export function admitSameMachineWorkspaceSyncTargetPhase(input: Readonly<{
  /** Built by this writer for a TARGET on this Machine; the caller selects same-Machine placement. */
  routing: WorkspaceSyncSourceWriterTargetRoutingV1;
  /** The admitted root for preflight/prepare; the current reviewed retirement for copy phases. */
  callerInputAuthorization?: ExternalActionExecutionAuthorizationV1;
  /** The phase body, for the requester capture lookup ingress also applies. */
  request?: unknown;
  resolvePrivateCapture?: (admission: PrivateWorkspaceSyncTargetAdmission) => PrivateWorkspaceSyncTargetExecutionResolution;
}>): Readonly<{ ok: true; machineAdmission: SocketRpcMachineAdmissionContextV1;
  callerInputAuthorization?: ExternalActionExecutionAuthorizationV1;
  workspaceSyncPrivateExecution?: RetainedWorkspaceSyncPrivateExecution }> | Extract<RpcAuthorizationResult, { ok: false }> {
  const { routing, callerInputAuthorization: root } = input;
  const source = routing.source.sourceContext.machineAdmission;
  if (isWorkspaceSyncSourceWriterCleanupPhaseV1(routing.target.phase)) {
    // Home's writer delivery: the SOURCE custodian with Manage on this Machine.
    // The retained TARGET owner matches the retirement; release spends no root.
    return { ok: true, machineAdmission: { ...source, actorAccountId: source.custodianAccountId, role: 'manage' },
      ...(routing.target.phase !== 'release' && root ? { callerInputAuthorization: root } : {}) };
  }
  if (!root || !doesWorkspaceSyncSourceWriterTargetRootMatchRouting(root, routing, source)) {
    return forbidden('machine_target') as Extract<RpcAuthorizationResult, { ok: false }>;
  }
  // Home's target role: relationship writes use the replacement route's access; Project Open needs Use.
  const required = isWorkspaceSyncRelationshipWriteActionId(root.binding.actionId)
    ? resolveMachineRpcRoutePolicy(RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_REPLACEMENT_PREFLIGHT).sharedMachineAccess : 'use';
  if (required !== 'use' && source.role !== 'manage') {
    return { ok: false, errorCode: 'machine_manage_required', error: 'Replacing a destination folder needs Manage access to this Machine' };
  }
  if (requiresRequesterWorkspaceCapture(source)) {
    const body = routing.target.phase === 'prepare' ? WorkspaceSyncTargetBootstrapPrepareV1Schema.safeParse(input.request) : null;
    const lookup = input.resolvePrivateCapture?.({ context: source, request: input.request, routing: routing.target,
      receivingMachine: { machineId: source.machineId, installationId: source.installationId },
      ...(body?.success ? { targetWorkspaceRefId: body.data.targetWorkspaceRefId } : {}) });
    if (lookup?.kind !== 'matched') return requesterWorkspaceCaptureRequired();
    return { ok: true, machineAdmission: source, callerInputAuthorization: root, workspaceSyncPrivateExecution: lookup.capture };
  }
  return { ok: true, machineAdmission: source, callerInputAuthorization: root };
}

/** One strict binding for both the installed child sender and physical receiver. */
export function doesWorkspaceSyncTargetRequestMatchRouting(
  params: unknown,
  routing: WorkspaceSyncTargetRoutingV1,
  method?: string,
): boolean {
  if (routing.phase === 'preflight') {
    const body = HandoffTargetReplacementPreflightV1Schema.safeParse(params);
    return (
      body.success &&
      body.data.operationId === routing.operationId &&
      body.data.serverId === routing.accountServerId &&
      body.data.machineId === routing.targetMachineId &&
      body.data.targetPath === routing.targetRootPath
    );
  }
  const matchesRelationship = (relationshipId: string) => relationshipId === routing.operationId
    || relationshipId === deriveWorkspaceSyncRelationshipId(routing.operationId);
  if (routing.phase === 'inspect' && method !== undefined && isWorkspaceSyncTargetReadMethodV1(method)) {
    const body = (method === RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_FILE_READ
      ? WorkspaceSyncTargetFileReadV1Schema : WorkspaceSyncTargetEntryObserveV1Schema).safeParse(params);
    return body.success && matchesRelationship(body.data.relationshipId);
  }
  if (routing.phase === 'dependencies') {
    const body = ProjectWorkerDependencyQueryV1Schema.safeParse(params);
    return body.success && body.data.serverId === routing.accountServerId
      && body.data.machineId === routing.targetMachineId && matchesRelationship(body.data.relationshipId);
  }
  if (routing.phase === 'remove' || routing.phase === 'inspect' && !WorkspaceSyncCommittedCopyPreviewV1Schema.safeParse(params).success) {
    const body = WorkspaceSyncCommittedCopyTargetV1Schema.safeParse(params);
    if (!body.success) return false;
    const input = body.data.actionInput;
    const relationship = input.expectedRelationship;
    return matchesRelationship(relationship.relationshipId)
      && input.workspace.serverId === routing.accountServerId
      && input.machineId === relationship.controllerMachineId
      && (input.workspace.refId === relationship.alphaWorkspaceRefId || input.workspace.refId === relationship.betaWorkspaceRefId)
      && (input.removeTargetCopy?.workspaceRefId === relationship.alphaWorkspaceRefId
        || input.removeTargetCopy?.workspaceRefId === relationship.betaWorkspaceRefId);
  }
  if (routing.phase === 'inspect') {
    const body = WorkspaceSyncCommittedCopyPreviewV1Schema.safeParse(params);
    if (!body.success) return false;
    const relationship = body.data.expectedRelationship;
    return (relationship.relationshipId === routing.operationId
        || relationship.relationshipId === deriveWorkspaceSyncRelationshipId(routing.operationId))
      && body.data.workspace.serverId === routing.accountServerId
      && body.data.targetMachineId === routing.targetMachineId
      && body.data.machineId === relationship.controllerMachineId
      && (body.data.workspace.refId === relationship.alphaWorkspaceRefId
        || body.data.workspace.refId === relationship.betaWorkspaceRefId)
      && (body.data.targetWorkspaceRefId === relationship.alphaWorkspaceRefId
        || body.data.targetWorkspaceRefId === relationship.betaWorkspaceRefId);
  }
  const body =
    routing.phase === 'prepare'
      ? WorkspaceSyncTargetBootstrapPrepareV1Schema.safeParse(params)
      : WorkspaceSyncTargetBootstrapReleaseV1Schema.safeParse(params);
  if (!body.success) return false;
  if (body.data.bootstrapOperationId === routing.operationId) return true;
  // This is a request binding, never authority: the receiver selects native
  // owner custody or the exact already-admitted private Open capture below.
  const relationshipId = deriveWorkspaceSyncRelationshipId(routing.operationId);
  return body.data.bootstrapOperationId === relationshipId
    && (routing.phase === 'release' || 'owner' in body.data && body.data.owner.kind === 'relationship'
      && body.data.owner.relationshipId === relationshipId
      && body.data.transientRelationship?.relationshipId === relationshipId);
}

/** A raw receipt admits the method. A retained Use root admits local reads in
 * its member folder, or inside a resolved Session workspace it can edit. */
function selectRequesterWorkspacePlacement(
  identity: HostRequesterExecutionIdentity,
  method: string,
  admission: 'machine' | 'editable_session' | 'member_folder' | 'owner_only',
  readPolicy: MachineRpcAdmissionBoundary['readAgentIsolation'],
): 'owner' | 'daemon' | 'member' | 'unavailable' {
  if (isHostRequesterUnrestrictedOwner(identity)) return 'owner';
  if (identity.kind !== 'isolated' || admission === 'owner_only') return 'unavailable';
  const personOrAccountAutomation = identity.presentPerson === true || identity.accountAutomation === true;
  const daemonScope = admission === 'machine' || (admission === 'editable_session' && personOrAccountAutomation);
  if (isRequesterOwnWorkPlacedOnDaemonForHost(identity, readPolicy)) return daemonScope ? 'daemon' : 'unavailable';
  return personOrAccountAutomation && (isScmMemberFolderRpcMethod(method) || isScmHostingCredentialRpcMethod(method))
    ? 'member' : 'unavailable';
}

export async function authorizeMachineRpcRequest(
  request: Readonly<{
    method: string;
    params: unknown;
    callerAuthority?: import('@/api/rpc/types').RpcHandlerContext['callerAuthority'];
    sessionActionOrigin?: import('@/api/rpc/types').RpcHandlerContext['sessionActionOrigin'];
    localActionContext?: import('@/api/rpc/types').RpcHandlerContext['localActionContext'];
    inheritedLocalActionContext?: import('@/api/rpc/types').RpcHandlerContext['localActionContext'];
    requesterSessionBootstrap?: import('@/api/rpc/types').RpcHandlerContext['requesterSessionBootstrap'];
    authorization?: SocketRpcAuthorizationContext;
    transportResponseEnvelopeVersion?: 1;
    machineAdmission?: SocketRpcMachineAdmissionContextV1;
    /** Host-private admitted Session wake lifetime; never read from RPC input. */
    verifyMachineAdmissionCurrent?: () => Promise<boolean>;
    /** Consumed only from the authenticated Home socket, never a peer's wire claim. */
    receivingMachineAdmission?: SocketRpcMachineAdmissionContextV1;
    workspaceSyncSourceRouting?: WorkspaceSyncSourceRoutingV1;
    workspaceSyncSourceExecution?: WorkspaceSyncSourceExecutionV1;
    workspaceSyncTargetRouting?: WorkspaceSyncTargetRoutingV1;
    workspaceSyncSourceWriterTargetRouting?: WorkspaceSyncSourceWriterTargetRoutingV1;
    workspaceSyncSeedRouting?: WorkspaceSyncSeedRoutingV1;
    callerInputAuthorization?: ExternalActionExecutionAuthorizationV1;
    signal?: AbortSignal;
  }>,
  machine?: MachineRpcAdmissionBoundary,
  source?: 'authenticated_home_socket',
): Promise<RpcAuthorizationResult> {
  // Fresh SCM calls share this ingress. A handler already past admission
  // retains its execution and transport through the existing drain.
  if (machine?.isDaemonShuttingDown?.() && request.method.startsWith(`${machine.machineId}:`)) {
    const method = request.method.slice(machine.machineId.length + 1);
    if (getScmRpcSideEffectClass(method) !== undefined || isScmLocalRepositoryReadRpcMethod(method)) {
      const errorCode = 'daemon_shutting_down';
      return { ok: false, errorCode, error: 'The daemon is shutting down.',
        failureCause: projectActionFailureCauseV1({ code: errorCode }, 'rpc.admission', { allowUnknownErrorCode: true }) };
    }
  }
  if (request.method === MANAGED_PLUGIN_WEBHOOK_DAEMON_RPC_METHOD_V1
    || request.method.endsWith(`:${MANAGED_PLUGIN_WEBHOOK_DAEMON_RPC_METHOD_V1}`)) {
    if (source !== 'authenticated_home_socket' || !machine
      || request.method !== `${machine.machineId}:${MANAGED_PLUGIN_WEBHOOK_DAEMON_RPC_METHOD_V1}`)
      return forbidden('machine_target');
    const origin = ManagedPluginWebhookOriginV1Schema.safeParse(request.authorization);
    const operation = ManagedPluginWebhookRequestV1Schema.safeParse(request.params);
    if (!origin.success || !operation.success || origin.data.machineId !== machine.machineId)
      return forbidden('machine_target');
    try {
      if (origin.data.accountId !== await machine.resolveCustodianAccountId(request.signal))
        return forbidden('machine_custodian');
      if (request.signal?.aborted) return forbidden('request_cancelled');
      return { ok: true };
    } catch {
      return forbidden('authorization_unavailable');
    }
  }
  const referenceExecution = request.workspaceSyncSourceExecution?.externalActionExecution;
  const referenceEnvironmentId = readDeploymentReferenceServiceListEnvironmentIdV1(referenceExecution?.authorization.binding.actionId,
    referenceExecution?.effectActionId, referenceExecution?.reviewedChild);
  if (referenceEnvironmentId && referenceExecution && (source !== 'authenticated_home_socket' || !machine || !request.machineAdmission
    || request.method !== `${machine.machineId}:${RPC_METHODS.MACHINES_SERVICE_LIST}`
    || request.machineAdmission.actorAccountId !== referenceExecution.authorization.binding.accountId
    || !sameStrictJsonValue(request.params, { serverId: referenceExecution.authorization.binding.serverIdentityId,
      machineId: machine.machineId, environmentId: referenceEnvironmentId }))) return forbidden('machine_target');
  if (request.authorization?.kind === 'session.browser') {
    const access = request.authorization;
    const method = machine && request.method.startsWith(`${machine.machineId}:`)
      ? request.method.slice(machine.machineId.length + 1) : '';
    const capability = resolveSessionBrowserRpcCapabilityV1(method);
    // The authenticated Home already resolved the Session share. Bind its
    // decision to this installed source; never synthesize a Machine grant.
    if (source !== 'authenticated_home_socket' || !machine
      || !isSocketRpcSessionBrowserAuthorizationContext(access) || !capability
      || !access.effectiveAccess.capabilities[capability]
      || access.machineId !== machine.machineId
      || access.installationId !== machine.resolveInstallationId()) return forbidden('session_authorization');
    const params = request.params && typeof request.params === 'object' && !Array.isArray(request.params)
      ? request.params as Record<string, unknown> : null;
    if (!params || params.machineId !== undefined && params.machineId !== access.machineId) return forbidden('machine_target');
    if (method === RPC_METHODS.DAEMON_BROWSER_VIEW_LIST || method === RPC_METHODS.DAEMON_BROWSER_VIEW_WATCH) {
      if (params.browserSessionId !== access.sessionId) return forbidden('session_authorization');
    } else if (method === RPC_METHODS.DAEMON_BROWSER_CONTROL_DISPATCH) {
      const command = params.command;
      if (!command || typeof command !== 'object' || !('browserSessionId' in command)
        || command.browserSessionId !== access.sessionId) return forbidden('session_authorization');
    } else if (method === RPC_METHODS.DAEMON_MACHINE_LIVE_STREAM_SOURCE_ADMIT && params.streamFamily !== 'browser.streamed') {
      return forbidden('session_authorization');
    }
    try {
      return access.custodianAccountId === await machine.resolveCustodianAccountId(request.signal)
        ? { ok: true } : forbidden('machine_custodian');
    } catch {
      return forbidden('authorization_unavailable');
    }
  }
  if (
    request.machineAdmission !== undefined &&
    isSocketRpcActionApiServerOriginAuthorizationContext(request.authorization)
  ) {
    // Both Home relays carry the original signed Action. The receiving
    // handler verifies its root and binds any watch to the selected Resource.
    const dispatch = ExternalActionDaemonDispatchRequestSchema.safeParse(
      request.params,
    );
    const admission = SocketRpcMachineAdmissionContextV1Schema.safeParse(
      request.machineAdmission,
    );
    if (
      !machine ||
      !dispatch.success ||
      !admission.success ||
      (request.method !== `${machine.machineId}:${EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1}`
        && (source !== 'authenticated_home_socket'
          || request.method !== `${machine.machineId}:${RPC_METHODS.DAEMON_PLUGIN_UI_HOST_RESOURCE_FOLLOW}`))
    )
      return forbidden('machine_target');
    const root = dispatch.data.executionAuthorization?.binding;
    const context = admission.data;
    if (
      !root ||
      context.actorAccountId !== root.accountId ||
      context.custodianAccountId !== root.custodianAccountId ||
      context.machineId !== root.machineId ||
      context.installationId !== root.installationId ||
      dispatch.data.placement.machineId !== machine.machineId ||
      dispatch.data.placement.target.machineId !== machine.machineId ||
      root.machineId !== machine.machineId
    )
      return forbidden('machine_target');
    try {
      if (context.installationId !== machine.resolveInstallationId())
        return forbidden('machine_installation');
      if (
        context.custodianAccountId !==
        (await machine.resolveCustodianAccountId(request.signal))
      )
        return forbidden('machine_custodian');
      if (request.signal?.aborted) return forbidden('request_cancelled');
      return { ok: true };
    } catch {
      return forbidden('authorization_unavailable');
    }
  }
  if (
    request.authorization?.kind === 'machine.managedInstallation.serverOrigin'
  ) {
    // Only Home mints this stamp, after admitting the purpose, and only its
    // authenticated socket can carry it; local and other ingress never can.
    const stamp = ManagedInstallationServerOriginV1Schema.safeParse(
      request.authorization,
    );
    const body = ManagedInstallationCapabilityRequestV1Schema.safeParse(
      request.params,
    );
    if (
      source !== 'authenticated_home_socket' ||
      !stamp.success ||
      !stamp.data.purpose.controller ||
      !body.success ||
      !machine ||
      request.machineAdmission ||
      request.method !==
        `${machine.machineId}:${RPC_METHODS.CAPABILITIES_INVOKE}` ||
      stamp.data.purpose.controller.machineId !== machine.machineId ||
      stamp.data.purpose.controller.installationId !==
        machine.resolveInstallationId() ||
      !sameStrictJsonValue(
        readManagedInstallationPurposeV1(body.data.params),
        stamp.data.purpose,
      )
    )
      return forbidden();
    try {
      if (
        (await machine.resolveCustodianAccountId(request.signal)) !==
          stamp.data.custodianAccountId ||
        request.signal?.aborted ||
        machine.resolveInstallationId() !==
          stamp.data.purpose.controller.installationId
      )
        return forbidden();
      return { ok: true };
    } catch {
      return forbidden('authorization_unavailable');
    }
  }
  if (
    isSocketRpcMachineReadServerOriginAuthorizationContext(
      request.authorization,
    )
  ) {
    const authority = request.authorization;
    if (
      !machine ||
      authority.machineId !== machine.machineId ||
      !SOCKET_RPC_SERVER_ORIGIN_MACHINE_READ_METHODS.some(
        (method) => request.method === `${machine.machineId}:${method}`,
      )
    )
      return forbidden('machine_target');
    try {
      const custodianAccountId = await machine.resolveCustodianAccountId(
        request.signal,
      );
      if (request.signal?.aborted) return forbidden('request_cancelled');
      if (authority.accountId !== custodianAccountId)
        return forbidden('machine_custodian');
    } catch {
      return forbidden('authorization_unavailable');
    }
    // Read scope is stamped by the authenticated Home, never the generic client CALL parser.
    // Keep any additional installed-Machine admission below intact.
  }
  const isSourcePhase =
    request.method === RPC_METHODS.DAEMON_WORKSPACE_SYNC_HANDOFF_SOURCE_PHASE ||
    request.method.endsWith(
      `:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_HANDOFF_SOURCE_PHASE}`,
    );
  const isProjectSource = request.method.endsWith(
    `:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_MATERIALIZE_FOR_OPEN}`,
  );
  const isFiniteSource =
    request.method.endsWith(
      `:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_PREPARE_BETWEEN}`,
    ) && request.workspaceSyncSourceRouting !== undefined;
  let sourceRouting: WorkspaceSyncSourceRoutingV1 | undefined;
  let targetRouting: WorkspaceSyncTargetRoutingV1 | undefined;
  let writerTargetRouting: WorkspaceSyncSourceWriterTargetRoutingV1 | undefined;
  let seedRouting: WorkspaceSyncSeedRoutingV1 | undefined;
  if (request.workspaceSyncSeedRouting !== undefined) {
    const seed = WorkspaceSyncSeedRoutingV1Schema.safeParse(
      request.workspaceSyncSeedRouting,
    );
    const execution = WorkspaceSyncSourceExecutionV1Schema.safeParse(
      request.workspaceSyncSourceExecution,
    );
    const body = WorkspaceSyncSeedExportPrepareV1Schema.safeParse(
      request.params,
    );
    if (
      !machine ||
      !request.machineAdmission ||
      !seed.success ||
      request.workspaceSyncSourceExecution !== undefined && !execution.success ||
      !body.success ||
      !request.callerInputAuthorization ||
      request.workspaceSyncSourceRouting ||
      request.workspaceSyncTargetRouting ||
      request.workspaceSyncSourceWriterTargetRouting ||
      request.method !==
        `${machine.machineId}:${RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_PREPARE}` ||
      seed.data.sourceWriterTarget.sourceWriter.machineId !==
        machine.machineId ||
      !sameStrictJsonValue(
        request.machineAdmission,
        seed.data.sourceWriterTarget.source.sourceContext.machineAdmission,
      ) ||
      !doesWorkspaceSyncSeedRootMatchRouting(
        request.callerInputAuthorization,
        seed.data,
        execution.success ? execution.data : undefined,
        body.data.operationId,
      )
    )
      return forbidden();
    seedRouting = seed.data;
  }
  if (request.workspaceSyncSourceWriterTargetRouting !== undefined) {
    const routing = WorkspaceSyncSourceWriterTargetRoutingV1Schema.safeParse(
      request.workspaceSyncSourceWriterTargetRouting,
    );
    const signedHandoffRelease = routing.success
      && isSignedWorkspaceSyncHandoffReleaseV1(routing.data, request.callerInputAuthorization);
    if (
      !machine ||
      !request.machineAdmission ||
      !routing.success ||
      request.workspaceSyncSourceRouting ||
      !isWorkspaceSyncSourceWriterTargetMethodV1(routing.data.target.phase, request.method, machine.machineId) ||
      !doesWorkspaceSyncTargetRequestMatchRouting(request.params, {
        ...routing.data.target,
        targetContext: routing.data.source.sourceContext,
      }, request.method.slice(machine.machineId.length + 1)) ||
      ((!isWorkspaceSyncSourceWriterCleanupPhaseV1(routing.data.target.phase) ||
        signedHandoffRelease) &&
        (!request.callerInputAuthorization ||
          !doesWorkspaceSyncSourceWriterTargetRootMatchRouting(
            request.callerInputAuthorization,
            routing.data,
            request.machineAdmission,
          )))
    )
      return forbidden();
    if (
      isWorkspaceSyncSourceWriterCleanupPhaseV1(routing.data.target.phase) &&
      !signedHandoffRelease &&
      !request.workspaceSyncTargetRouting &&
      (request.machineAdmission.machineId !==
        routing.data.sourceWriter.machineId ||
        request.machineAdmission.installationId !==
          routing.data.sourceWriter.installationId ||
        request.machineAdmission.actorAccountId !==
          request.machineAdmission.custodianAccountId ||
        request.machineAdmission.custodianAccountId !==
          routing.data.source.sourceContext.machineAdmission.custodianAccountId)
    )
      return forbidden();
    writerTargetRouting = routing.data;
  }
  if (
    request.workspaceSyncSourceRouting !== undefined &&
    request.workspaceSyncTargetRouting !== undefined
  )
    return forbidden();
  if (isProjectSource || isFiniteSource) {
    const routing = WorkspaceSyncSourceRoutingV1Schema.safeParse(
      request.workspaceSyncSourceRouting,
    );
    const execution = WorkspaceSyncSourceExecutionV1Schema.safeParse(
      request.workspaceSyncSourceExecution,
    );
    if (
      !machine ||
      !request.machineAdmission ||
      !routing.success ||
      !execution.success ||
      !request.callerInputAuthorization ||
      request.method !==
        `${machine.machineId}:${
          isFiniteSource
            ? RPC_METHODS.DAEMON_WORKSPACE_SYNC_PREPARE_BETWEEN
            : RPC_METHODS.DAEMON_WORKSPACE_SYNC_MATERIALIZE_FOR_OPEN
        }` ||
      execution.data.method !== request.method ||
      !sameStrictJsonValue(
        execution.data.externalActionExecution.authorization,
        request.callerInputAuthorization,
      ) ||
      routing.data.sourceMachineId !== request.machineAdmission.machineId ||
      !sameStrictJsonValue(
        routing.data.sourceContext?.machineAdmission,
        request.machineAdmission,
      ) ||
      !(isFiniteSource
        ? doesWorkspaceSyncFinitePrepareRequestMatchRouting(
            request.params,
            request.callerInputAuthorization,
            routing.data,
          )
        : doesWorkspaceSyncProjectSourceRequestMatchRouting(
            request.params,
            request.callerInputAuthorization,
            routing.data,
          ))
    )
      return forbidden();
    sourceRouting = routing.data;
  } else if (
    isSourcePhase ||
    request.workspaceSyncSourceRouting !== undefined
  ) {
    const routing = WorkspaceSyncSourceRoutingV1Schema.safeParse(
      request.workspaceSyncSourceRouting,
    );
    const phase = WorkspaceSyncHandoffSourcePhaseRequestV1Schema.safeParse(
      request.params,
    );
    if (
      !machine ||
      !request.machineAdmission ||
      !routing.success ||
      !phase.success ||
      request.method !==
        `${machine.machineId}:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_HANDOFF_SOURCE_PHASE}` ||
      routing.data.phase !== phase.data.phase ||
      routing.data.operationId !== phase.data.input.operationId ||
      routing.data.accountServerId !== phase.data.input.accountServerId ||
      routing.data.sourceMachineId !== phase.data.input.sourceMachineId ||
      routing.data.sourceRootPath !== phase.data.input.sourceRootPath ||
      routing.data.sourceSessionId !== phase.data.input.sourceSessionId ||
      routing.data.sourceMachineId !== request.machineAdmission.machineId ||
      (routing.data.sourceContext &&
        !sameStrictJsonValue(
          routing.data.sourceContext.machineAdmission,
          request.machineAdmission,
        ))
    )
      return forbidden();
    sourceRouting = routing.data;
  }
  if (request.workspaceSyncTargetRouting !== undefined) {
    const routing = WorkspaceSyncTargetRoutingV1Schema.safeParse(
      request.workspaceSyncTargetRouting,
    );
    if (
      !machine ||
      !request.machineAdmission ||
      !routing.success ||
      isWorkspaceSyncSourceWriterCleanupPhaseV1(routing.data.phase) && routing.data.phase !== 'release' ||
      request.method !==
        `${machine.machineId}:${readWorkspaceSyncTargetMethod(routing.data.phase)}` ||
      routing.data.targetMachineId !== request.machineAdmission.machineId ||
      !sameStrictJsonValue(
        routing.data.targetContext.machineAdmission,
        request.machineAdmission,
      ) ||
      (writerTargetRouting &&
        !doesWorkspaceSyncTargetRoutingMatchWriterTarget(
          routing.data,
          writerTargetRouting,
        ))
    )
      return forbidden();
    if (
      !doesWorkspaceSyncTargetRequestMatchRouting(request.params, routing.data)
    )
      return forbidden();
    // The canonical TARGET owner resolves the selected child to this exact physical WorkspaceRef before effects.
    targetRouting = routing.data;
  }
  const isPreviewAdmission =
    request.method === RPC_METHODS.DAEMON_LOCAL_SERVICES_PREVIEW_ADMISSION ||
    request.method.endsWith(
      `:${RPC_METHODS.DAEMON_LOCAL_SERVICES_PREVIEW_ADMISSION}`,
    );
  if (
    isPreviewAdmission &&
    (!machine ||
      request.method !==
        `${machine.machineId}:${RPC_METHODS.DAEMON_LOCAL_SERVICES_PREVIEW_ADMISSION}` ||
      !request.machineAdmission ||
      !isSocketRpcLocalServicesPreviewAdmissionServerOriginAuthorizationContext(
        request.authorization,
      ))
  )
    return forbidden();
  const isAccessLoss = request.method.endsWith(
    `:${RPC_METHODS.DAEMON_MACHINE_ACCESS_LOSS}`,
  );
  const custodyRequest = isAccessLoss
    ? MachineAccessLossCustodyRequestV1Schema.safeParse(request.params)
    : null;
  if (
    isAccessLoss &&
    (!custodyRequest?.success ||
      !request.machineAdmission ||
      !isSocketRpcMachineAccessLossServerOriginAuthorizationContext(
        request.authorization,
      ))
  )
    return forbidden();
  let authorized: Extract<RpcAuthorizationResult, { ok: true }> = { ok: true };
  // Original Action ingress can retain requester custody without a raw Machine
  // RPC stamp. The identity owner binds that custody to this physical receiver.
  const retainedRequester = readRetainedVerifiedExternalActionRequester(
    request.localActionContext?.externalActionExecutionAuthorization);
  const localRootCustody = request.localActionContext?.authenticatedLocalRootCustody;
  if (!request.machineAdmission && (retainedRequester || localRootCustody)) {
    if (!machine) return forbidden('machine_target');
    const method = request.method.startsWith(`${machine.machineId}:`)
      ? request.method.slice(machine.machineId.length + 1) : undefined;
    if (!method) return forbidden('machine_target');
    const localRepositoryRead = isScmLocalRepositoryReadRpcMethod(method);
    if ((retainedRequester || localRootCustody && localRepositoryRead)
      && resolveMachineRpcRoutePolicy(method).requesterExecutionIsolationRequired === true) {
      try {
        const installationId = machine.resolveInstallationId();
        const identity = selectHostRequesterExecutionIdentity({ actionContext: {
          ...request.localActionContext,
          authority: request.callerAuthority,
          callerInputAuthorization: request.callerInputAuthorization,
          verifyMachineAdmissionCurrent: retainedRequester?.isCurrent,
          sessionActionOrigin: request.sessionActionOrigin,
          requesterSessionBootstrap: request.requesterSessionBootstrap,
          signal: request.signal,
        }, hostHomeServerIdentityId: await machine.resolveHomeServerIdentityId?.(request.signal),
          hostCustodianAccountId: await machine.resolveCustodianAccountId(request.signal),
          hostExecutionTarget: installationId ? { machineId: machine.machineId, installationId } : undefined });
        if (identity.kind === 'unknown') return forbidden('machine_admission');
        const useRead = localRepositoryRead && retainedRequester?.authorization.binding.admittedMachineRole === 'use';
        const placement = selectRequesterWorkspacePlacement(identity, method, useRead
          ? request.localActionContext?.hasEditableScmSessionWorkspace ? 'editable_session' : 'member_folder'
          : 'owner_only', machine.readAgentIsolation);
        if (placement === 'unavailable') return forbidden('machine_admission');
        if (request.signal?.aborted || (retainedRequester && !await retainedRequester.isCurrent())) return forbidden('request_cancelled');
        authorized = { ok: true, directWorkspaceRequester: placement === 'member'
          ? { ...identity, scmPlacement: 'member' } : identity };
      } catch { return forbidden('authorization_unavailable'); }
    }
  }
  if (request.machineAdmission !== undefined) {
    const admission = SocketRpcMachineAdmissionContextV1Schema.safeParse(
      request.machineAdmission,
    );
    if (!admission.success || !machine) return forbidden();
    const context = admission.data;
    if (isAccessLoss && context.actorAccountId !== context.custodianAccountId)
      return forbidden();
    try {
      const installationId = machine.resolveInstallationId();
      const custodianAccountId =
        !writerTargetRouting && !seedRouting
          ? await machine.resolveCustodianAccountId(request.signal)
          : null;
      if (request.signal?.aborted) return forbidden('request_cancelled');
      if (!installationId) return forbidden('machine_installation');
      // Passive copy review retains its controller identity on the second hop.
      // Only this exact method's strict preview may bind to the physical target;
      // the same installation, custodian and current Home checks still apply.
      const copyPreview =
        request.method ===
        `${machine.machineId}:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_COMMITTED_COPY_INSPECT}`
          ? WorkspaceSyncCommittedCopyPreviewV1Schema.safeParse(request.params)
          : null;
      const targetRequest =
        copyPreview?.success &&
        copyPreview.data.targetMachineId === machine.machineId
          ? { machineId: copyPreview.data.targetMachineId }
          : request.params;
      let targetPredicate: RpcAdmissionPredicate = 'machine_target';
      if (
        !sourceRouting &&
        !targetRouting &&
        !writerTargetRouting &&
        !seedRouting &&
        !doesMachineRpcTargetMatchAdmission(
          targetRequest,
          context,
          {
            machineId: machine.machineId,
            installationId,
            custodianAccountId,
          },
          (predicate) => {
            targetPredicate = predicate;
          },
        )
      )
        return forbidden(targetPredicate);
      if (!request.method.startsWith(`${machine.machineId}:`))
        return forbidden('machine_scope');
      // Routed workspace packets retain the child's custodian. Home independently
      // verifies this installed physical controller's own Account and signer.
      if (
        !sourceRouting &&
        !targetRouting &&
        !writerTargetRouting &&
        !seedRouting &&
        context.custodianAccountId !== custodianAccountId
      )
        return forbidden('machine_custodian');
      const rpcMethod = request.method.slice(machine.machineId.length + 1);
      const privateSpawn = privateSessionMethods.includes(rpcMethod)
        ? SpawnDaemonSessionRequestSchema.safeParse(request.params)
        : null;
      // Resume resolves the stored Session owner/birth before runner launch.
      // Its local transport consumes the Action's admission, not the distinct
      // custodian-only raw spawn permission. Fresh spawns still use raw admission.
      const nativeSessionResume = privateSpawn?.success
        && privateSpawn.data.type === 'resume-session' && !!privateSpawn.data.sessionId;
      // Retain the result of this one admission; peer ingress must not borrow
      // a receiving role from an unverified field on its incoming request.
      const verifiedAdmission = source === 'authenticated_home_socket' ? null
        : nativeSessionResume && request.verifyMachineAdmissionCurrent
        ? await request.verifyMachineAdmissionCurrent()
        : await machine.verifyMachineAdmission({
          context,
          method: request.method,
          ...(sourceRouting
            ? { workspaceSyncSourceRouting: sourceRouting }
            : {}),
          ...((request.workspaceSyncSourceExecution?.originalActionEnvelope ||
            seedRouting ||
            isProjectSource ||
            isFiniteSource ||
            (writerTargetRouting &&
              isProjectWorkspaceSyncOpenActionV1(request.callerInputAuthorization?.binding.actionId))) &&
          request.workspaceSyncSourceExecution
            ? {
                workspaceSyncSourceExecution:
                  request.workspaceSyncSourceExecution,
              }
            : {}),
          ...(targetRouting
            ? { workspaceSyncTargetRouting: targetRouting }
            : {}),
          ...(writerTargetRouting
            ? { workspaceSyncSourceWriterTargetRouting: writerTargetRouting }
            : {}),
          ...(seedRouting ? { workspaceSyncSeedRouting: seedRouting } : {}),
          ...((request.workspaceSyncSourceExecution?.originalActionEnvelope ||
            sourceRouting ||
            writerTargetRouting ||
            seedRouting) &&
          request.callerInputAuthorization
            ? { callerInputAuthorization: request.callerInputAuthorization }
            : {}),
          ...(custodyRequest?.success &&
          'subjectAccountId' in custodyRequest.data
            ? { custodySubjectAccountId: custodyRequest.data.subjectAccountId }
            : {}),
          ...(request.signal ? { signal: request.signal } : {}),
        });
      if (source !== 'authenticated_home_socket' && !verifiedAdmission)
        return forbidden('machine_currentness');
      const privateRecovery = rpcMethod === RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_CONFLICT_RECOVER
        && context.actorAccountId !== context.custodianAccountId
        && !sourceRouting && !targetRouting && !writerTargetRouting && !seedRouting
        ? WorkspaceSyncTargetConflictRecoverV1Schema.safeParse(request.params) : null;
      if (privateRecovery && !privateRecovery.success) return forbidden('machine_target');
      const recoveryHome = privateRecovery?.success ? await machine.resolveHomeServerIdentityId?.(request.signal) : null;
      if (installationId !== machine.resolveInstallationId())
        return forbidden('machine_installation');
      if (request.signal?.aborted) return forbidden('request_cancelled');
      // These native bind phases do not launch requester processes. Home has
      // just verified the exact child/controller route; the workspace owner
      // must still map its own current native root before any copy, and retain
      // exact input/claimant/operation custody for settlement. Raw files and
      // commands, Project/finite SOURCE and seed transport keep isolation.
      const nativeManagedBindPhase =
        context.machineId !== machine.machineId &&
        !seedRouting &&
        !isProjectWorkspaceSyncOpenActionV1(request.callerInputAuthorization?.binding.actionId) &&
        !isProjectWorkspaceSyncPreparationActionV1(
          request.callerInputAuthorization?.binding.actionId,
        ) &&
        ((isSourcePhase && sourceRouting?.sourceContext !== undefined) ||
          targetRouting !== undefined);
      const nativeSessionEffect = resolveMachineRpcExternalActionEffectV1(
        rpcMethod,
        request.callerInputAuthorization?.binding,
        { machineId: machine.machineId, installationId },
        request.workspaceSyncSourceExecution?.externalActionExecution.reviewedChild,
      );
      const nativeRequesterControl =
        context.machineId === machine.machineId &&
        !sourceRouting &&
        !targetRouting &&
        !writerTargetRouting &&
        !seedRouting;
      const replica = rpcMethod === RPC_METHODS.DAEMON_WORKSPACE_SYNC_RELATIONSHIP_CREATE
        ? WorkspaceSyncRelationshipCreateRpcRequestV1Schema.safeParse(request.params)
        : undefined;
      const nativeSyncRequester = nativeRequesterControl &&
        (rpcMethod === RPC_METHODS.DAEMON_WORKSPACE_SYNC_RELATIONSHIPS_LIST ||
          replica?.success && replica.data.actionInput.mode === 'keep_synced' &&
            !('replaceRelationshipId' in replica.data.actionInput));
      // These registered owners already consume the P11 payload finalizer.
      // Session creation leaves the trusted runner unchanged and records birth
      // attribution before its payload; finite Project Exec carries ingress
      // selection through both native helpers and the final tuple. File owners
      // execute their whole effect in that tuple; Project Open forces private
      // member checkout or refuses. Capabilities select their classified whole
      // effect at the same native owner; machine_install retains Manage.
      // Routed deputies and
      // unrelated spawn-looking method names retain their separate refusals.
      const nativeEffectOwner =
        // This exact installed SOURCE writer cleanup already passed strict
        // routing/body and Home admission above. The retained TARGET owner
        // alone matches operation, WorkspaceRef and writer before cleanup.
        (writerTargetRouting && isWorkspaceSyncSourceWriterCleanupPhaseV1(writerTargetRouting.target.phase) &&
          isWorkspaceSyncSourceWriterTargetMethodV1(writerTargetRouting.target.phase, rpcMethod) &&
          !targetRouting && !seedRouting) ||
        (nativeRequesterControl &&
        (finiteProjectMethods.includes(rpcMethod) ||
          // Workspace linking and read-back own native root mapping and copy
          // custody. Neither launches a requester command or needs raw Session authority.
          // Requester-scoped inventory only projects Account rows and native
          // directories; its owner never executes a requester command.
          rpcMethod === RPC_METHODS.DAEMON_WORKSPACE_SYNC_RELATIONSHIPS_LIST ||
          rpcMethod === RPC_METHODS.DAEMON_WORKSPACE_SYNC_RELATIONSHIP_CREATE ||
          rpcMethod === RPC_METHODS.DAEMON_WORKSPACE_SYNC_RELATIONSHIP_CREATION_OBSERVE ||
          rpcMethod === RPC_METHODS.BASH ||
          nativeFilesystemMethods.includes(rpcMethod) ||
          rpcMethod === RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_START ||
          rpcMethod === RPC_METHODS.DAEMON_MCP_SERVERS_TEST ||
          rpcMethod === RPC_METHODS.PROJECTS_OPEN ||
          rpcMethod === RPC_METHODS.CAPABILITIES_DETECT ||
          rpcMethod === RPC_METHODS.CAPABILITIES_INVOKE ||
          readNativeSessionMethods().includes(rpcMethod) ||
          nativeSessionResume ||
          nativeSessionEffect === 'session.spawn_new' ||
          nativeSessionEffect === 'session.agent.transition'));
      const nativeTerminal = nativeRequesterControl && nativeTerminalMethods.includes(rpcMethod);
      const nativePersonalComputer = nativeRequesterControl && (rpcMethod === RPC_METHODS.DAEMON_COMPUTER_PERSONAL_ACTION_EXECUTE
        || rpcMethod === RPC_METHODS.DAEMON_MACHINE_LIVE_STREAM_SOURCE_ADMIT
        || rpcMethod === RPC_METHODS.DAEMON_MACHINE_LIVE_STREAM_PERSONAL_RELAY_START);
      const workspaceTargetPhase = rpcMethod === RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_REPLACEMENT_PREFLIGHT
        || rpcMethod === RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_BOOTSTRAP_PREPARE
        || rpcMethod === RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_BOOTSTRAP_RELEASE;
      const privateTargetRouting = targetRouting ?? writerTargetRouting?.target;
      const privateTargetBody = privateTargetRouting?.phase === 'prepare'
        ? WorkspaceSyncTargetBootstrapPrepareV1Schema.parse(request.params)
        : privateTargetRouting?.phase === 'release'
          ? WorkspaceSyncTargetBootstrapReleaseV1Schema.parse(request.params) : undefined;
      const privateSyncLookup = workspaceTargetPhase && privateTargetRouting !== undefined
        ? machine.resolvePrivateWorkspaceSyncTargetExecution?.({ context,
          receivingMachine: { machineId: machine.machineId, installationId }, routing: privateTargetRouting,
          ...(privateTargetBody ? { targetWorkspaceRefId: privateTargetBody.targetWorkspaceRefId } : {}),
          request: request.params,
        }) ?? null : privateRecovery?.success && recoveryHome
          ? machine.resolvePrivateWorkspaceSyncTargetExecution?.({ context,
            receivingMachine: { machineId: machine.machineId, installationId }, request: privateRecovery.data,
            routing: { phase: 'recover', accountServerId: recoveryHome, ...privateRecovery.data },
            targetWorkspaceRefId: privateRecovery.data.targetWorkspaceRefId,
          }) ?? null : null;
      const privateSyncExecution = privateSyncLookup?.kind === 'matched' ? privateSyncLookup.capture : null;
      if (privateRecovery?.success && privateSyncLookup?.kind === 'native_admitted') return { ok: true };
      if (privateSyncLookup?.kind === 'private_unavailable' || privateRecovery && !privateSyncExecution) {
        return { ok: false, errorCode: 'agent_isolation_unavailable', error: 'Private workspace Sync execution is unavailable' };
      }
      if (privateSyncExecution) return { ok: true, workspaceSyncPrivateExecution: privateSyncExecution };
      if (writerTargetRouting && workspaceTargetPhase
        && !isWorkspaceSyncSourceWriterCleanupPhaseV1(writerTargetRouting.target.phase)
        && requiresRequesterWorkspaceCapture(context)) return requesterWorkspaceCaptureRequired();
      if (
        !nativeManagedBindPhase &&
        (!nativeEffectOwner || nativeSyncRequester) &&
        // The scoped computer owner selects and verifies the requester's desktop.
        !nativePersonalComputer &&
        // The registered terminal owner selects native placement at creation
        // and enforces retained requester custody on every later terminal call.
        !nativeTerminal &&
        (workspaceTargetPhase && (!privateTargetRouting
          || privateTargetBody && privateTargetBody.bootstrapOperationId !== privateTargetRouting.operationId)
          || resolveMachineRpcRoutePolicy(rpcMethod)
          .requesterExecutionIsolationRequired === true)
      ) {
        const physicalCustodianAccountId = custodianAccountId
          ?? await machine.resolveCustodianAccountId(request.signal);
        const receivingAdmission = source === 'authenticated_home_socket'
          ? request.receivingMachineAdmission
          : verifiedAdmission && typeof verifiedAdmission === 'object'
            ? verifiedAdmission.receivingMachineAdmission : undefined;
        const receivingManager = receivingAdmission?.role === 'manage'
          && receivingAdmission.actorAccountId === context.actorAccountId
          && receivingAdmission.actorAccountId === request.callerInputAuthorization?.binding.accountId
          && receivingAdmission.machineId === machine.machineId
          && receivingAdmission.installationId === installationId;
        const identity = selectHostRequesterExecutionIdentity({
          actionContext: {
            authority: request.callerAuthority,
            machineAdmission: context,
            sessionActionOrigin: request.sessionActionOrigin,
            callerInputAuthorization: request.callerInputAuthorization,
            localActionContext: request.localActionContext,
            inheritedLocalActionContext: request.inheritedLocalActionContext,
            requesterSessionBootstrap: request.requesterSessionBootstrap,
            signal: request.signal,
            verifyMachineAdmissionCurrent: async () => true,
          },
          hostHomeServerIdentityId: await machine.resolveHomeServerIdentityId?.(
            request.signal,
          ),
          hostCustodianAccountId: physicalCustodianAccountId,
          hostExecutionTarget: { machineId: machine.machineId, installationId },
          // Exact route/root/phase checks and Home admission above bind the
          // retained SOURCE actor across placement. Physical receiver custody,
          // not the original child's custodian or role, still decides ownership.
          // Rootless cleanup and unrelated routed work cannot mint this fact.
          ...(request.callerInputAuthorization &&
          (sourceRouting ||
            seedRouting ||
            (writerTargetRouting && !isWorkspaceSyncSourceWriterCleanupPhaseV1(writerTargetRouting.target.phase)))
            ? {
                verifiedReceivingChild: {
                  actorAccountId: context.actorAccountId,
                  custodianAccountId: context.custodianAccountId,
                  machineId: context.machineId,
                  installationId: context.installationId,
                },
              }
            : {}),
        });
        if (request.signal?.aborted) return forbidden('request_cancelled');
        if (installationId !== machine.resolveInstallationId())
          return forbidden('machine_installation');
        const placement = selectRequesterWorkspacePlacement(identity, rpcMethod, 'machine', machine.readAgentIsolation);
        if (placement === 'daemon' && identity.kind === 'isolated') {
          // Placement never substitutes for the method's remaining authorization checks.
          authorized = { ok: true, directWorkspaceRequester: identity };
        } else if (!nativeEffectOwner && !receivingManager && placement === 'unavailable') {
          const refuseExecution = (errorCode: string, error: string): RpcAuthorizationResult => ({
            ok: false, errorCode, error,
            failureCause: projectActionFailureCauseV1({ code: errorCode }, 'rpc.admission.requester_execution_isolation',
              { allowUnknownErrorCode: true }),
          });
          // Comparisons, saved results, commit plans and Project worktrees stay with Manage (owner ruling 2026-10-31).
          if (getScmRpcSideEffectClass(rpcMethod) !== undefined && context.role !== 'manage') {
            return refuseExecution('machine_manage_required', 'This source-control action needs Manage access to this Machine');
          }
          return refuseExecution('agent_isolation_unavailable', 'Requester execution protection is unavailable');
        }
      }
      if (
        SessionTransferRpcMethodV1Schema.safeParse(
          request.method.slice(machine.machineId.length + 1),
        ).success
      ) {
        const preparedTransfer = PreparedTransferRpcRequestV1Schema.safeParse(
          request.params,
        );
        if (preparedTransfer.success) {
          if (
            request.method ===
            `${machine.machineId}:${resolvePreparedTransferRpcPhaseV1(
              preparedTransfer.data.path,
              preparedTransfer.data.httpMethod,
              preparedTransfer.data.body,
            )}`
          )
            return { ok: true };
          return forbidden('prepared_transfer_phase');
        }
        // Raw filesystem transfer phases consume the same installed native
        // byte owner as file operations. Their member custody is not the
        // detached-Run custodian rule used by other dual-scope methods.
        if (
          nativeEffectOwner &&
          nativeFilesystemMethods.includes(rpcMethod)
        ) {
          return hasFilesystemEffectTransferCustody(rpcMethod, request.params)
            ? { ok: true }
            : forbidden('session_authorization');
        }
      }
    } catch {
      return forbidden('authorization_unavailable');
    }
  }
  if (
    isSocketRpcMachineReadServerOriginAuthorizationContext(
      request.authorization,
    )
  )
    return { ok: true };
  const sessionRule = resolveSocketRpcSessionAuthorization(request.method);
  if (sessionRule?.serverMintedContext === 'session.read') {
    const authorization = parseSocketRpcAuthorizationContext(request.authorization);
    if (authorization?.kind !== 'session.read') return forbidden('session_authorization');
    const requestedSessionId = readSessionIdFromParams(request.params, request.method);
    return requestedSessionId && requestedSessionId === authorization.sessionId
      ? { ok: true }
      : forbidden('session_target');
  }
  if (sessionRule?.method === SESSION_RPC_METHODS.SESSION_DELETE && request.machineAdmission !== undefined) {
    const targeted = TargetedActionRpcRequestV1Schema.safeParse(request.params);
    const sessionId = readSessionIdFromParams(targeted.success ? targeted.data.input : request.params, request.method);
    if (sessionId) {
      // Home decides ownership once. Bind its admission to the decrypted target;
      // detached Run admission must never authorize native checkout teardown.
      const authorization = parseSocketRpcAuthorizationContext(request.authorization);
      if (source !== 'authenticated_home_socket' || authorization?.kind !== 'session.write')
        return forbidden('session_authorization');
      return authorization.sessionId === sessionId ? { ok: true } : forbidden('session_target');
    }
  }
  if (
    sessionRule?.machineScope === true &&
    request.machineAdmission !== undefined
  ) {
    // The exact installation and current Home admission were verified above.
    // Home already enforced the method declaration's sharedMachineAccess.
    // Requester-owned Runs retain their Account isolation at the Run store.
    return request.authorization === undefined
      ? { ok: true }
      : forbidden('session_authorization');
  }
  if (sessionRule?.method === RPC_METHODS.SCM_WORK_EVIDENCE_READ) {
    // Machine admission above retains its existing target/resource checks.
    // Session proofs are Home's admission result, never a direct peer's claim.
    return source === 'authenticated_home_socket'
      && ScmWorkEvidenceAdmissionSchema.safeParse(request.authorization).success
      ? { ok: true }
      : forbidden('session_authorization');
  }
  if (sessionRule?.optionalSessionScope) {
    if (request.authorization === undefined) return authorized;
    return parseSocketRpcAuthorizationContext(request.authorization)?.kind ===
      'session.write'
      ? authorized
      : forbidden('session_authorization');
  }
  const authorizationMethod = resolveSocketRpcSessionWriteAuthorizationMethod(
    request.method,
  );
  if (!authorizationMethod) {
    return authorized;
  }

  const requestedSessionId = readSessionIdFromParams(
    request.params,
    request.method,
  );
  if (
    authorizationMethod === RPC_METHODS.STOP_SESSION &&
    !request.authorization &&
    request.transportResponseEnvelopeVersion === undefined &&
    requestedSessionId
  ) {
    // `server-v0.2.1` (4913c1e533c872a0712ba1c25b3104fd470aacc2)
    // forwarded encrypted Stop params only after authenticating both sockets,
    // before session-write proof and response envelopes existed. Keep exactly
    // that released direction working. Current servers always stamp the proof
    // and envelope, so a current request missing proof still fails closed.
    return { ok: true };
  }

  const authorization = parseSocketRpcAuthorizationContext(
    request.authorization,
  );
  if (!authorization || authorization.kind === 'session.read') return forbidden('session_authorization');

  if (!requestedSessionId || requestedSessionId !== authorization.sessionId) {
    return forbidden('session_target');
  }

  return { ok: true };
}
