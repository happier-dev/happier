import {
  resolveMachineRpcRoutePolicy,
  resolveMachineRpcExternalActionEffectV1,
} from '@happier-dev/protocol/machines/peer/mediation/rpc/routePolicyV1';
import {
  isHostRequesterUnrestrictedOwner,
  selectHostRequesterExecutionIdentity,
} from '@/daemon/agentIsolation/agentIsolationLaunchPolicy';
import { PROJECT_FINITE_ACTION_RPC_METHODS_V1 } from '@happier-dev/protocol/actions/projectActionFamily';
import {
  collectActionSpecRpcMethodsForScopes,
  SESSION_SPAWN_NEW_RPC_SCOPES,
  MACHINE_SESSION_LIFECYCLE_RPC_SCOPES,
} from '@/rpc/handlers/actionSpecRpcRegistration';
import { ACTION_SPECS } from '@happier-dev/protocol/actions/actionSpecs';
import {
  PRIVATE_SPAWN_SESSION_RPC_METHODS,
  SpawnDaemonSessionRequestSchema,
} from '@/rpc/handlers/spawnSessionOptionsContract';
import { RPC_ERROR_CODES, RPC_ERROR_MESSAGES } from '@happier-dev/protocol/rpcErrors';
import { isProjectWorkspaceSyncPreparationActionV1 } from '@happier-dev/protocol/actions/projectActionFamily';
import { DaemonLocalServiceLauncherStartRequestV1Schema } from '@happier-dev/protocol/local/services/launcher/v1';
import axios from 'axios';
import { signMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { RequesterSessionCurrentnessPurposeV1Schema, type RequesterSessionCurrentnessPurposeV1 } from '@happier-dev/protocol/machines/identity/installationIdentity';
import type { SessionApprovalDecisionCurrentnessV1 } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { MachineAccessLossCustodyRequestV1Schema, MachineAdmissionVerifyResponseV1Schema } from '@happier-dev/protocol/machines/machineAccessV1';
import { isSocketRpcLocalServicesPreviewAdmissionServerOriginAuthorizationContext, isSocketRpcMachineAccessLossServerOriginAuthorizationContext, parseSocketRpcAuthorizationContext, resolveSocketRpcSessionWriteAuthorizationMethod, resolveSocketRpcSessionAuthorization } from '@happier-dev/protocol/socketRpc';
import { isSocketRpcMachineReadServerOriginAuthorizationContext, SOCKET_RPC_SERVER_ORIGIN_MACHINE_READ_METHODS } from '@happier-dev/protocol/socketRpc';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { PreparedTransferRpcRequestV1Schema, resolvePreparedTransferRpcPhaseV1 } from '@happier-dev/protocol/machines/transfer/preparedTransferRpcV1';
import { SessionTransferRpcMethodV1Schema } from '@happier-dev/protocol/socketRpc';
import type { SocketRpcAuthorizationContext } from '@happier-dev/protocol/socketRpc';
import { SocketRpcMachineAdmissionContextV1Schema, type SocketRpcMachineAdmissionContextV1,
  WorkspaceSyncSourceRoutingV1Schema, type WorkspaceSyncSourceRoutingV1,
  WorkspaceSyncSourceExecutionV1Schema, type WorkspaceSyncSourceExecutionV1,
  WorkspaceSyncTargetRoutingV1Schema, type WorkspaceSyncTargetRoutingV1,
  WorkspaceSyncSeedRoutingV1Schema, type WorkspaceSyncSeedRoutingV1,
  WorkspaceSyncSourceWriterTargetRoutingV1Schema, type WorkspaceSyncSourceWriterTargetRoutingV1 } from '@happier-dev/protocol/socketRpc';
import { WorkspaceSyncHandoffSourcePhaseRequestV1Schema, HandoffTargetReplacementPreflightV1Schema,
  WorkspaceSyncTargetBootstrapPrepareV1Schema, WorkspaceSyncTargetBootstrapReleaseV1Schema,
  WorkspaceSyncTargetConflictRecoverV1Schema, type WorkspaceSyncTargetConflictRecoverV1,
  WorkspaceSyncSeedExportPrepareV1Schema, WorkspaceSyncPrepareBetweenRequestV1Schema } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import { WorkspaceSyncCommittedCopyPreviewV1Schema } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncCommittedCopyV1';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { ExternalActionExecutionAuthorizationV1Schema, type ExternalActionExecutionAuthorizationV1 } from '@happier-dev/protocol/actions/externalActionApi';

import type { RpcAuthorizationResult, RpcAdmissionPredicate } from '@/api/rpc/types';
import { ManagedActivityReadRequestV1Schema, type ManagedActivityReadRequestV1 } from '@happier-dev/protocol/machines/managed/managedIntentV1';
import { ManagedGuestCurrentOutputV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { resolveExternalActionRootInvocationAuthority } from '@/api/externalActionExecutionAuthorization';
import { isExternalActionAuthorizationBoundToEnvelope } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { OpenProjectInputV1Schema } from '@happier-dev/protocol/projects/openProjectV1';
import { PROJECT_ACTION_INPUT_SCHEMAS_V1 } from '@happier-dev/protocol/actions/projectActionFamily';
import { ProjectServiceRelocateInputV1Schema } from '@happier-dev/protocol/workspaces/projectServiceRelocationV1';
import { logger } from '@/ui/logger';
import { classifyServerEndpointError } from '@/api/client/classifyServerEndpointError';
import { createHttpStatusError, readHttpStatus } from '@/api/client/httpStatusError';
import { deriveWorkspaceSyncRelationshipId } from '@/workspaces/sync/workspaceSyncRelationshipIdentity';
import type { RetainedWorkspaceSyncPrivateExecution } from '@/workspaces/sync/workspaceSyncHandoffAdapter';

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
const nativeSessionMethods = collectActionSpecRpcMethodsForScopes(
  ACTION_SPECS,
  [...SESSION_SPAWN_NEW_RPC_SCOPES, ...MACHINE_SESSION_LIFECYCLE_RPC_SCOPES],
);
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
export function doesWorkspaceSyncSourceRootMatchRouting(authorization: ExternalActionExecutionAuthorizationV1, source: WorkspaceSyncSourceRoutingV1): boolean {
  const binding = authorization.binding;
  const context = source.sourceContext;
  const handoff = binding.handoffAdmission;
  if (binding.actionId === 'projects.open' || isProjectWorkspaceSyncPreparationActionV1(binding.actionId)) {
    const envelope = source.originalActionEnvelope;
    const constraints = 'grant' in binding ? { models: binding.grant.models, permissionModes: binding.grant.permissionModes } : undefined;
    return !!context && !!envelope && source.phase === 'prepare' && source.sourceSessionId === undefined
      && source.accountServerId === binding.serverIdentityId
      && context.machineAdmission.machineId === source.sourceMachineId
      && context.machineAdmission.actorAccountId === binding.accountId
      && (context.callerAuthority === 'account_automation' || context.callerAuthority === resolveExternalActionRootInvocationAuthority(authorization))
      && sameStrictJsonValue(binding.sessionActionOrigin ?? null, context.sessionActionOrigin ?? null)
      && sameStrictJsonValue(constraints ?? null, context.callerInputConstraints ?? null)
      && binding.target.kind === 'machine' && binding.target.machineId === binding.machineId
      && isExternalActionAuthorizationBoundToEnvelope(binding, { actionId: binding.actionId, machineId: binding.machineId, envelope });
  }
  if (!context || !handoff) return false;
  const admission = context.machineAdmission;
  const constraints = 'grant' in binding ? { models: binding.grant.models, permissionModes: binding.grant.permissionModes } : undefined;
  return binding.actionId === 'session.handoff' && !binding.handoffContinuation
    && (source.phase === 'prepare' || source.phase === 'finalize')
    && binding.machineId === handoff.sourceMachineId && binding.installationId === handoff.sourceInstallationId
    && admission.machineId === binding.machineId && admission.installationId === binding.installationId
    && admission.actorAccountId === binding.accountId && admission.custodianAccountId === binding.custodianAccountId
    && binding.target.kind === 'machine' && binding.target.machineId === binding.machineId
    && source.sourceMachineId === handoff.sourceMachineId && source.sourceSessionId === handoff.sessionId
    && source.operationId === binding.requestId && source.accountServerId === binding.serverIdentityId
    && (context.callerAuthority === 'account_automation' || context.callerAuthority === resolveExternalActionRootInvocationAuthority(authorization))
    && sameStrictJsonValue(binding.sessionActionOrigin ?? null, context.sessionActionOrigin ?? null)
    && sameStrictJsonValue(constraints ?? null, context.callerInputConstraints ?? null);
}

/** Signed Project roots retain their logical source; current Account refs prove the target at the controller. */
export function doesWorkspaceSyncFinitePrepareRequestMatchRouting(params: unknown, authorization: ExternalActionExecutionAuthorizationV1,
  source: WorkspaceSyncSourceRoutingV1): boolean {
  const actionId = authorization.binding.actionId;
  const body = WorkspaceSyncPrepareBetweenRequestV1Schema.safeParse(params);
  if (!isProjectWorkspaceSyncPreparationActionV1(actionId) || !body.success
    || !doesWorkspaceSyncSourceRootMatchRouting(authorization, source)) return false;
  const envelope = source.originalActionEnvelope!;
  // Protected input is opened only by the controller's admitted requester custody,
  // before the runtime resolves either WorkspaceRef. Never use custodian keys here.
  if (envelope.v === 2) return true;
  if (actionId === 'projects.service.relocate') {
    const input = ProjectServiceRelocateInputV1Schema.safeParse(envelope.input);
    return input.success && input.data.workspace.refId === body.data.sourceWorkspaceRefId
      && input.data.workspace.serverId === source.accountServerId;
  }
  const input = actionId === 'localServices.launcher.start'
    ? DaemonLocalServiceLauncherStartRequestV1Schema.safeParse(envelope.input)
    : PROJECT_ACTION_INPUT_SCHEMAS_V1[actionId].safeParse(envelope.input);
  return input.success && !!input.data.workspace && input.data.workspace.workspaceId === body.data.sourceWorkspaceRefId
    && input.data.workspace.serverId === source.accountServerId
    && input.data.workspace.machineId === source.sourceMachineId && input.data.workspace.rootPath === source.sourceRootPath;
}

/** The named Project SOURCE body retains its original chosen child and namespace. */
export function doesWorkspaceSyncProjectSourceRequestMatchRouting(params: unknown, authorization: ExternalActionExecutionAuthorizationV1,
  source: WorkspaceSyncSourceRoutingV1): boolean {
  const input = OpenProjectInputV1Schema.safeParse(params);
  if (authorization.binding.actionId !== 'projects.open' || !input.success || !doesWorkspaceSyncSourceRootMatchRouting(authorization, source)
    || input.data.machineId !== authorization.binding.machineId || input.data.serverId !== source.accountServerId
    || input.data.materialization.kind !== 'sync'
    || !['copy_once', 'create_relationship'].includes(input.data.materialization.workspaceAction.kind)) return false;
  const selected = input.data.source.kind === 'workspace' ? input.data.source.checkout
    : input.data.source.kind === 'source' ? input.data.source.checkout : undefined;
  if (!selected || selected.serverId !== source.accountServerId
    || selected.machineId !== source.sourceMachineId || selected.rootPath !== source.sourceRootPath) return false;
  const envelope = source.originalActionEnvelope!;
  return envelope.v !== 1 || sameStrictJsonValue(envelope.input, input.data);
}

export function doesWorkspaceSyncSourceWriterTargetRootMatchRouting(authorization: ExternalActionExecutionAuthorizationV1,
  routing: WorkspaceSyncSourceWriterTargetRoutingV1, admission?: SocketRpcMachineAdmissionContextV1): boolean {
  if (authorization.binding.actionId === 'projects.open') {
    return doesWorkspaceSyncSourceRootMatchRouting(authorization, routing.source)
      && routing.target.targetMachineId === authorization.binding.machineId
      && routing.target.accountServerId === authorization.binding.serverIdentityId
      && (!admission || admission.machineId === authorization.binding.machineId
        && admission.installationId === authorization.binding.installationId
        && admission.actorAccountId === authorization.binding.accountId);
  }
  const handoff = authorization.binding.handoffAdmission;
  return doesWorkspaceSyncSourceRootMatchRouting(authorization, routing.source) && !!handoff
    && routing.target.targetMachineId === handoff.targetMachineId
    && routing.target.accountServerId === authorization.binding.serverIdentityId
    && (!admission || admission.machineId === handoff.targetMachineId
      && admission.installationId === handoff.targetInstallationId && admission.actorAccountId === authorization.binding.accountId);
}

/** The second hop keeps the writer's snapshot and the chosen child's exact admitted caller ceiling. */
export function doesWorkspaceSyncTargetRoutingMatchWriterTarget(target: WorkspaceSyncTargetRoutingV1,
  writer: WorkspaceSyncSourceWriterTargetRoutingV1): boolean {
  const { targetContext, ...purpose } = target;
  const sourceContext = writer.source.sourceContext;
  return sameStrictJsonValue(purpose, writer.target)
    && targetContext.machineAdmission.machineId === writer.target.targetMachineId
    && (['callerAuthority', 'sessionActionOrigin', 'callerInputConstraints', 'callerPermissionMode',
      'causalPermissionAuthority', 'workspaceWrites'] as const)
      .every(key => sameStrictJsonValue(targetContext[key] ?? null, sourceContext[key] ?? null));
}

/** Seed retains the independently verified Project root and chosen child's original SOURCE packet. */
export function doesWorkspaceSyncSeedRootMatchRouting(authorization: ExternalActionExecutionAuthorizationV1,
  seed: WorkspaceSyncSeedRoutingV1, execution: WorkspaceSyncSourceExecutionV1): boolean {
  return authorization.binding.actionId === 'projects.open'
    && doesWorkspaceSyncSourceWriterTargetRootMatchRouting(authorization, seed.sourceWriterTarget,
      seed.target.targetContext.machineAdmission)
    && doesWorkspaceSyncTargetRoutingMatchWriterTarget(seed.target, seed.sourceWriterTarget)
    && execution.method === `${seed.sourceWriterTarget.sourceWriter.machineId}:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_MATERIALIZE_FOR_OPEN}`
    && execution.externalActionExecution.effectActionId === 'projects.open'
    && execution.externalActionExecution.installationId === authorization.binding.installationId
    && sameStrictJsonValue(execution.externalActionExecution.authorization, authorization);
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
  | Readonly<{ kind: 'private_unavailable' }>
  | Readonly<{ kind: 'no_private_capture' }>;

export type MachineRpcAdmissionBoundary = Readonly<{
  machineId: string;
  resolveCustodianAccountId: (signal?: AbortSignal) => Promise<string | null>;
  resolveInstallationId: () => string | null;
  /** Cheap exact active-operation lookup; never selects a requester or re-evaluates permissions. */
  resolvePrivateWorkspaceSyncTargetExecution?: (input: PrivateWorkspaceSyncTargetAdmission) => PrivateWorkspaceSyncTargetExecutionResolution;
  verifyMachineAdmission: (input: Readonly<{
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
  }>) => Promise<boolean | ReturnType<typeof MachineAdmissionVerifyResponseV1Schema.parse> | null>;

resolveHomeServerIdentityId?: (
    signal?: AbortSignal,
  ) => Promise<string | null>;
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
  target: Readonly<{ machineId: string; installationId: string; custodianAccountId: string | null }> | null,
  onDenial?: (predicate: RpcAdmissionPredicate) => void,
): boolean {
  const deny = (predicate: RpcAdmissionPredicate) => { onDenial?.(predicate); return false; };
  if (!target || !admission) return deny('machine_admission');
  if (admission.machineId !== target.machineId) return deny('machine_target');
  if (admission.installationId !== target.installationId) return deny('machine_installation');
  if (admission.custodianAccountId !== target.custodianAccountId) return deny('machine_custodian');
  if (request && typeof request === 'object' && 'machineId' in request && request.machineId !== admission.machineId) {
    return deny('machine_request_target');
  }
  return true;
}

/** This read proves current access; the signed context is not a reusable admission ticket. */
export type MachineRpcAdmissionCurrentInput = Readonly<{
  context: SocketRpcMachineAdmissionContextV1;
  sessionDecision?: SessionApprovalDecisionCurrentnessV1;
  custodySubjectAccountId?: string;
  workspaceSyncSourceRouting?: WorkspaceSyncSourceRoutingV1;
  workspaceSyncSourceExecution?: WorkspaceSyncSourceExecutionV1;
  workspaceSyncTargetRouting?: WorkspaceSyncTargetRoutingV1;
  workspaceSyncSourceWriterTargetRouting?: WorkspaceSyncSourceWriterTargetRoutingV1;
  workspaceSyncSeedRouting?: WorkspaceSyncSeedRoutingV1;
  callerInputAuthorization?: ExternalActionExecutionAuthorizationV1;
  /** Actual local signer, usable only for the exact private physical SOURCE purpose. */
  workspaceSyncSourceReceiver?: Readonly<{ machineId: string; installationId: string;
    /** Installed original Project target discovers only its verified physical SOURCE recipient. */
    destinationMachineId?: string; accountId?: string }>;
  /** Actual local signer, usable only for the exact private physical TARGET purposes. */
  workspaceSyncTargetReceiver?: Readonly<{ machineId: string; installationId: string;
    /** Outgoing installed D -> P2 joint purpose; the proof remains signed by D. */
    destinationMachineId?: string }>;
  /** Actual installed writer/receiver; its own Account is independent of the retained actor. */
  workspaceSyncSourceWriterTargetReceiver?: Readonly<{ machineId: string; installationId: string; accountId: string; destinationMachineId?: string }>;
  /** Actual installed seed sender/receiver; Home verifies both physical writers independently. */
  workspaceSyncSeedReceiver?: Readonly<{ machineId: string; installationId: string; accountId: string; destinationMachineId?: string }>;
  privateKey: string | Uint8Array;
  daemonToken: string;
  serverHttpBaseUrl: string;
  signal?: AbortSignal;
}> & (Readonly<{ method: string; purpose?: never }> | Readonly<{ purpose: RequesterSessionCurrentnessPurposeV1; method?: never }>);

export async function verifyMachineRpcAdmissionCurrent(input: MachineRpcAdmissionCurrentInput): Promise<boolean> {
  return await readMachineRpcAdmissionCurrent(input) !== null;
}

/** Same verification owner, retaining the Home-proven destination identity for the physical writer. */
export async function readMachineRpcAdmissionCurrent(input: MachineRpcAdmissionCurrentInput): Promise<ReturnType<typeof MachineAdmissionVerifyResponseV1Schema.parse> | null> {
  try { return await readMachineRpcAdmissionCurrentOrThrow(input); }
  catch { return null; }
}

/** Requester custody must distinguish unavailable Home evidence from a denial.
 * The boolean/null adapters retain their existing fail-closed contract. */
export async function readMachineRpcAdmissionCurrentOrThrow(input: MachineRpcAdmissionCurrentInput): Promise<ReturnType<typeof MachineAdmissionVerifyResponseV1Schema.parse> | null> {
  type VerificationStage = 'input_validation' | 'proof_signing' | 'transport' | 'request_cancelled' | 'response_status' | 'response_schema';
  let stage: VerificationStage = 'input_validation';
  const failed = (failureStage: VerificationStage, status?: number, transportCode?: string) => {
    const candidateMethod = input.method?.slice(input.method.indexOf(':') + 1);
    const method = input.purpose?.kind === 'requester_session_currentness' ? input.purpose.kind
      : Object.values(RPC_METHODS).some(known => known === candidateMethod) ? candidateMethod : '<unregistered>';
    logger.infoFile('[RPC] Machine admission verification failed', { method, stage: failureStage,
      ...(status === undefined ? {} : { status }), ...(transportCode ? { transportCode } : {}) });
    return null;
  };
  try {
    const context = SocketRpcMachineAdmissionContextV1Schema.parse(input.context);
    const purpose = input.purpose === undefined ? undefined : RequesterSessionCurrentnessPurposeV1Schema.parse(input.purpose);
    if (purpose && (input.custodySubjectAccountId !== undefined || input.workspaceSyncSourceRouting !== undefined || input.workspaceSyncSourceExecution !== undefined
      || input.workspaceSyncTargetRouting !== undefined || input.workspaceSyncSourceReceiver !== undefined
      || input.workspaceSyncTargetReceiver !== undefined || input.callerInputAuthorization !== undefined
      || input.workspaceSyncSeedRouting !== undefined || input.workspaceSyncSeedReceiver !== undefined
      || input.workspaceSyncSourceWriterTargetRouting !== undefined || input.workspaceSyncSourceWriterTargetReceiver !== undefined)) return null;
    const admissionPurpose = purpose ? { purpose } : { method: input.method! };
    const custody = input.custodySubjectAccountId === undefined ? {} : { custodySubjectAccountId: input.custodySubjectAccountId };
    const sourceRouting = input.workspaceSyncSourceRouting === undefined
      ? undefined : WorkspaceSyncSourceRoutingV1Schema.parse(input.workspaceSyncSourceRouting);
    const sourceExecution = input.workspaceSyncSourceExecution === undefined ? undefined
      : WorkspaceSyncSourceExecutionV1Schema.parse(input.workspaceSyncSourceExecution);
    const originalRoot = input.callerInputAuthorization === undefined
      ? undefined : ExternalActionExecutionAuthorizationV1Schema.parse(input.callerInputAuthorization);
    const moveChild = Boolean((originalRoot?.binding.actionId === 'projects.service.relocate'
      || originalRoot?.binding.actionId === 'discussion.second_opinion.start'
        && sourceExecution?.externalActionExecution.effectActionId === 'session.spawn_new'
        && (input.method === `${context.machineId}:${RPC_METHODS.SESSION_SPAWN_NEW}`
          || input.method === `${context.machineId}:${RPC_METHODS.DAEMON_SESSION_CREATION_DIRECTORY_PREFLIGHT}`))
      && sourceExecution?.originalActionEnvelope && !sourceRouting && !input.workspaceSyncTargetRouting
      && !input.workspaceSyncSourceWriterTargetRouting && !input.workspaceSyncSeedRouting
      && sourceExecution.method === input.method && input.method?.startsWith(`${context.machineId}:`)
      && context.actorAccountId === originalRoot.binding.accountId
      && sameStrictJsonValue(sourceExecution.externalActionExecution.authorization, originalRoot));
    const seed = input.workspaceSyncSeedRouting === undefined ? undefined
      : WorkspaceSyncSeedRoutingV1Schema.parse(input.workspaceSyncSeedRouting);
    const seedReceiver = input.workspaceSyncSeedReceiver;
    if (seed && (!seedReceiver || !originalRoot || !sourceExecution
      || input.workspaceSyncSourceRouting || input.workspaceSyncTargetRouting || input.workspaceSyncSourceWriterTargetRouting
      || input.workspaceSyncSourceReceiver || input.workspaceSyncTargetReceiver || input.workspaceSyncSourceWriterTargetReceiver
      || input.custodySubjectAccountId
      || input.method !== `${seedReceiver.destinationMachineId ?? seedReceiver.machineId}:${RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_PREPARE}`
      || (seedReceiver.destinationMachineId ?? seedReceiver.machineId) !== seed.sourceWriterTarget.sourceWriter.machineId
      || !seedReceiver.destinationMachineId && seedReceiver.installationId !== seed.sourceWriterTarget.sourceWriter.installationId
      || !sameStrictJsonValue(context, seed.sourceWriterTarget.source.sourceContext.machineAdmission)
      || !doesWorkspaceSyncSeedRootMatchRouting(originalRoot, seed, sourceExecution))
      || seedReceiver && !seed) return null;
    const projectSource = originalRoot?.binding.actionId === 'projects.open' && sourceRouting !== undefined;
    const finiteSource = sourceRouting !== undefined && isProjectWorkspaceSyncPreparationActionV1(originalRoot?.binding.actionId);
    const projectSourceMethod = finiteSource ? RPC_METHODS.DAEMON_WORKSPACE_SYNC_PREPARE_BETWEEN
      : RPC_METHODS.DAEMON_WORKSPACE_SYNC_MATERIALIZE_FOR_OPEN;
    const sourceReceiver = input.workspaceSyncSourceReceiver;
    if (sourceRouting && (!sourceReceiver
      || input.method !== `${sourceReceiver.destinationMachineId ?? sourceReceiver.machineId}:${projectSource || finiteSource
        ? projectSourceMethod : RPC_METHODS.DAEMON_WORKSPACE_SYNC_HANDOFF_SOURCE_PHASE}`
      || sourceRouting.sourceMachineId !== context.machineId)
      || sourceReceiver && !sourceRouting) return null;
    if (sourceReceiver?.destinationMachineId !== undefined && (!(projectSource || finiteSource) || !originalRoot
      || originalRoot.binding.machineId !== sourceReceiver.machineId || originalRoot.binding.installationId !== sourceReceiver.installationId
      || !doesWorkspaceSyncSourceRootMatchRouting(originalRoot, sourceRouting!))) return null;
    const writerTarget = input.workspaceSyncSourceWriterTargetRouting === undefined ? undefined
      : WorkspaceSyncSourceWriterTargetRoutingV1Schema.parse(input.workspaceSyncSourceWriterTargetRouting);
    const writerTargetReceiver = input.workspaceSyncSourceWriterTargetReceiver;
    if (sourceExecution && (!(moveChild || seed || projectSource || finiteSource || writerTarget && originalRoot?.binding.actionId === 'projects.open')
      || sourceReceiver?.destinationMachineId !== undefined)) return null;
    const targetRouting = input.workspaceSyncTargetRouting === undefined
      ? undefined : WorkspaceSyncTargetRoutingV1Schema.parse(input.workspaceSyncTargetRouting);
    const targetReceiver = input.workspaceSyncTargetReceiver;
    if (targetReceiver?.destinationMachineId !== undefined && (!writerTarget || !targetRouting
      || typeof targetReceiver.destinationMachineId !== 'string' || !targetReceiver.destinationMachineId.trim()
      || targetReceiver.destinationMachineId !== targetReceiver.destinationMachineId.trim()
      || targetReceiver.machineId !== targetRouting.targetMachineId
      || targetReceiver.installationId !== targetRouting.targetContext.machineAdmission.installationId
      || !sameStrictJsonValue(context, targetRouting.targetContext.machineAdmission))) return null;
    const targetMethodMachineId = targetReceiver?.destinationMachineId ?? targetReceiver?.machineId;
    if (writerTarget && (sourceRouting || sourceReceiver
      || targetRouting && (!targetReceiver || writerTargetReceiver || !doesWorkspaceSyncTargetRoutingMatchWriterTarget(targetRouting, writerTarget))
      || !targetRouting && targetReceiver
      || input.method !== `${targetMethodMachineId ?? writerTargetReceiver?.destinationMachineId ?? writerTargetReceiver?.machineId ?? context.machineId}:${readWorkspaceSyncTargetMethod(writerTarget.target.phase)}`
      || writerTarget.target.phase !== 'release' && (!originalRoot || !doesWorkspaceSyncSourceWriterTargetRootMatchRouting(originalRoot, writerTarget)))
      || writerTargetReceiver && !writerTarget) return null;
    if (writerTargetReceiver?.destinationMachineId && (!writerTarget
      || writerTargetReceiver.machineId !== writerTarget.sourceWriter.machineId
      || writerTargetReceiver.installationId !== writerTarget.sourceWriter.installationId
      || !sameStrictJsonValue(context, writerTarget.source.sourceContext.machineAdmission))) return null;
    if (originalRoot && !moveChild && !writerTarget && !seed && (!sourceRouting || !sourceReceiver
      || sourceRouting.phase !== 'prepare' && sourceRouting.phase !== 'finalize'
      || !(originalRoot.binding.actionId === 'session.handoff' || originalRoot.binding.actionId === 'projects.open'
        || isProjectWorkspaceSyncPreparationActionV1(originalRoot.binding.actionId)))) return null;
    const retainedRoot = originalRoot ? { callerInputAuthorization: originalRoot } : {};
    if (sourceRouting && targetRouting || sourceReceiver && targetReceiver
      || targetRouting && (!targetReceiver || targetRouting.targetMachineId !== context.machineId
        || input.method !== `${targetMethodMachineId}:${readWorkspaceSyncTargetMethod(targetRouting.phase)}`)
      || targetReceiver && !targetRouting) return null;
    const signer = seedReceiver ?? writerTargetReceiver ?? sourceReceiver ?? targetReceiver ?? { machineId: context.machineId, installationId: context.installationId };
    const routing = { ...(sourceRouting ? { workspaceSyncSourceRouting: sourceRouting } : {}),
      ...(sourceExecution ? { workspaceSyncSourceExecution: sourceExecution } : {}),
      ...(targetRouting ? { workspaceSyncTargetRouting: targetRouting } : {}),
      ...(writerTarget ? { workspaceSyncSourceWriterTargetRouting: writerTarget } : {}),
      ...(seed ? { workspaceSyncSeedRouting: seed } : {}) };
    stage = 'proof_signing';
    const sessionDecision = input.sessionDecision ? { sessionDecision: input.sessionDecision } : {};
    const proof = signMachineInstallationProof({ payload: {
      version: 1, machineId: signer.machineId, installationId: signer.installationId,
      accountId: seedReceiver?.accountId ?? writerTargetReceiver?.accountId ?? sourceReceiver?.accountId ?? context.custodianAccountId, rpcAdmission: { context, ...admissionPurpose, ...custody, ...routing, ...retainedRoot, ...sessionDecision },
    }, privateKey: input.privateKey });
    stage = 'transport';
    const response = await axios.post<unknown>(
      `${input.serverHttpBaseUrl}/v1/machines/${encodeURIComponent(signer.machineId)}/admission/verify`,
      { v: 1, context, ...admissionPurpose, proof, ...custody, ...routing, ...retainedRoot, ...sessionDecision },
      { headers: { Authorization: `Bearer ${input.daemonToken}`, 'Content-Type': 'application/json' },
        // The containing RPC owns its deadline and cancellation. A second,
        // shorter HTTP cutoff must not turn a still-valid read into a denial.
        timeout: input.signal ? 0 : 15_000, validateStatus: () => true,
        ...(input.signal ? { signal: input.signal } : {}) },
    );
    if (input.signal?.aborted) return failed('request_cancelled');
    if (response.status < 200 || response.status >= 300) {
      stage = 'response_status';
      const error = createHttpStatusError(response.status, 'Machine admission Home verification failed');
      if (classifyServerEndpointError(error).retryable) throw error;
      return failed('response_status', response.status);
    }
    const result = MachineAdmissionVerifyResponseV1Schema.safeParse(response.data);
    return result.success ? result.data : failed('response_schema', response.status);
  } catch (error) {
    if (input.signal?.aborted) return failed('request_cancelled');
    // Axios errors carry credentials and response bodies. Retain only known transport codes.
    const code = axios.isAxiosError(error) && ['ECONNABORTED', 'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED',
      'EPIPE', 'ENOTFOUND', 'EAI_AGAIN', 'ERR_NETWORK', 'ERR_CANCELED'].includes(error.code ?? '') ? error.code : undefined;
    failed(stage, stage === 'response_status' ? readHttpStatus(error) ?? undefined : undefined, code);
    if (classifyServerEndpointError(error).retryable) throw error;
    return null;
  }
}

/** Retention decisions require the guest and current controller to agree on the same retained row. */
export async function verifyManagedActivityTargetCurrent(input: Readonly<{
  context: SocketRpcMachineAdmissionContextV1;
  managedTarget: ManagedActivityReadRequestV1;
  method: string;
  privateKey: string | Uint8Array;
  daemonToken: string;
  serverHttpBaseUrl: string;
  signal?: AbortSignal;
}>): Promise<boolean> {
  try {
    const context = SocketRpcMachineAdmissionContextV1Schema.parse(input.context);
    const managedTarget = ManagedActivityReadRequestV1Schema.parse(input.managedTarget);
    const method = `${context.machineId}:${input.method}`;
    const proof = signMachineInstallationProof({ payload: {
      version: 1, machineId: context.machineId, installationId: context.installationId,
      accountId: context.custodianAccountId, rpcAdmission: { context, method, managedTarget },
    }, privateKey: input.privateKey });
    const response = await axios.post<unknown>(`${input.serverHttpBaseUrl}/v1/machines/managed/guest/current`,
      { v: 1, context, method, managedTarget, proof },
      { headers: { Authorization: `Bearer ${input.daemonToken}`, 'Content-Type': 'application/json' },
        validateStatus: () => true, ...(input.signal ? { signal: input.signal } : {}) });
    const parsed = ManagedGuestCurrentOutputV1Schema.safeParse(response.data);
    return !input.signal?.aborted && response.status >= 200 && response.status < 300
      && parsed.success && parsed.data.current;
  } catch { return false; }
}

function readSessionIdFromParams(params: unknown, method: string): string | null {
  if (!params || typeof params !== 'object') return null;
  const unscopedMethod = method.slice(method.lastIndexOf(':') + 1);
  const replay = Reflect.get(params, 'replay');
  const sessionId = unscopedMethod === RPC_METHODS.SESSION_FORK || unscopedMethod === RPC_METHODS.SESSION_FORK_PROVIDER_SAFE
    ? Reflect.get(params, 'parentSessionId')
    : unscopedMethod === RPC_METHODS.SESSION_CONTINUE_WITH_REPLAY
      ? replay && typeof replay === 'object' ? Reflect.get(replay, 'previousSessionId') : undefined
      : Reflect.get(params, resolveSocketRpcSessionAuthorization(method)?.sessionIdParam ?? 'sessionId');
  return typeof sessionId === 'string' && sessionId.trim().length > 0 ? sessionId.trim() : null;
}

function forbidden(admissionPredicate: RpcAdmissionPredicate = 'machine_admission'): RpcAuthorizationResult {
  return {
    ok: false,
    error: RPC_ERROR_MESSAGES.FORBIDDEN,
    errorCode: RPC_ERROR_CODES.FORBIDDEN,
    admissionPredicate,
  };
}

export function readWorkspaceSyncTargetMethod(phase: WorkspaceSyncTargetRoutingV1['phase']): string {
  switch (phase) {
    case 'preflight': return RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_REPLACEMENT_PREFLIGHT;
    case 'prepare': return RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_BOOTSTRAP_PREPARE;
    case 'release': return RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_BOOTSTRAP_RELEASE;
  }
}

/** One strict binding for both the installed child sender and physical receiver. */
export function doesWorkspaceSyncTargetRequestMatchRouting(params: unknown, routing: WorkspaceSyncTargetRoutingV1): boolean {
  if (routing.phase === 'preflight') {
    const body = HandoffTargetReplacementPreflightV1Schema.safeParse(params);
    return body.success && body.data.operationId === routing.operationId && body.data.serverId === routing.accountServerId
      && body.data.machineId === routing.targetMachineId && body.data.targetPath === routing.targetRootPath;
  }
  const body = routing.phase === 'prepare' ? WorkspaceSyncTargetBootstrapPrepareV1Schema.safeParse(params)
    : WorkspaceSyncTargetBootstrapReleaseV1Schema.safeParse(params);
  if (!body.success) return false;
  if (body.data.bootstrapOperationId === routing.operationId) return true;
  // This is a request binding, never authority: the receiver below also
  // requires the exact already-admitted private Open capture for this form.
  const relationshipId = deriveWorkspaceSyncRelationshipId(routing.operationId);
  return body.data.bootstrapOperationId === relationshipId
    && (routing.phase === 'release' || 'owner' in body.data && body.data.owner.kind === 'relationship'
      && body.data.owner.relationshipId === relationshipId
      && body.data.transientRelationship?.relationshipId === relationshipId);
}

export async function authorizeMachineRpcRequest(request: Readonly<{
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
  receivingMachineAdmission?: SocketRpcMachineAdmissionContextV1;
  workspaceSyncSourceRouting?: WorkspaceSyncSourceRoutingV1;
  workspaceSyncSourceExecution?: WorkspaceSyncSourceExecutionV1;
  workspaceSyncTargetRouting?: WorkspaceSyncTargetRoutingV1;
  workspaceSyncSourceWriterTargetRouting?: WorkspaceSyncSourceWriterTargetRoutingV1;
  workspaceSyncSeedRouting?: WorkspaceSyncSeedRoutingV1;
  callerInputAuthorization?: ExternalActionExecutionAuthorizationV1;
  signal?: AbortSignal;
}>, machine?: MachineRpcAdmissionBoundary, source?: 'authenticated_home_socket'): Promise<RpcAuthorizationResult> {
  if (isSocketRpcMachineReadServerOriginAuthorizationContext(request.authorization)) {
    const authority = request.authorization;
    if (!machine || authority.machineId !== machine.machineId
      || !SOCKET_RPC_SERVER_ORIGIN_MACHINE_READ_METHODS.some(method => request.method === `${machine.machineId}:${method}`))
      return forbidden('machine_target');
    try {
      const custodianAccountId = await machine.resolveCustodianAccountId(request.signal);
      if (request.signal?.aborted) return forbidden('request_cancelled');
      if (authority.accountId !== custodianAccountId) return forbidden('machine_custodian');
    } catch { return forbidden('authorization_unavailable'); }
    // Read scope is stamped by the authenticated Home, never the generic client CALL parser.
    // Keep any additional installed-Machine admission below intact.
  }
  const isSourcePhase = request.method === RPC_METHODS.DAEMON_WORKSPACE_SYNC_HANDOFF_SOURCE_PHASE
    || request.method.endsWith(`:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_HANDOFF_SOURCE_PHASE}`);
  const isProjectSource = request.method.endsWith(`:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_MATERIALIZE_FOR_OPEN}`);
  const isFiniteSource = request.method.endsWith(`:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_PREPARE_BETWEEN}`)
    && request.workspaceSyncSourceRouting !== undefined;
  let sourceRouting: WorkspaceSyncSourceRoutingV1 | undefined;
  let targetRouting: WorkspaceSyncTargetRoutingV1 | undefined;
  let writerTargetRouting: WorkspaceSyncSourceWriterTargetRoutingV1 | undefined;
  let seedRouting: WorkspaceSyncSeedRoutingV1 | undefined;
  if (request.workspaceSyncSeedRouting !== undefined) {
    const seed = WorkspaceSyncSeedRoutingV1Schema.safeParse(request.workspaceSyncSeedRouting);
    const execution = WorkspaceSyncSourceExecutionV1Schema.safeParse(request.workspaceSyncSourceExecution);
    const body = WorkspaceSyncSeedExportPrepareV1Schema.safeParse(request.params);
    if (!machine || !request.machineAdmission || !seed.success || !execution.success || !body.success
      || !request.callerInputAuthorization || request.workspaceSyncSourceRouting || request.workspaceSyncTargetRouting
      || request.workspaceSyncSourceWriterTargetRouting
      || request.method !== `${machine.machineId}:${RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_PREPARE}`
      || seed.data.sourceWriterTarget.sourceWriter.machineId !== machine.machineId
      || !sameStrictJsonValue(request.machineAdmission, seed.data.sourceWriterTarget.source.sourceContext.machineAdmission)
      || body.data.operationId !== seed.data.sourceWriterTarget.source.operationId
      || !doesWorkspaceSyncSeedRootMatchRouting(request.callerInputAuthorization, seed.data, execution.data)) return forbidden();
    seedRouting = seed.data;
  }
  if (request.workspaceSyncSourceWriterTargetRouting !== undefined) {
    const routing = WorkspaceSyncSourceWriterTargetRoutingV1Schema.safeParse(request.workspaceSyncSourceWriterTargetRouting);
    if (!machine || !request.machineAdmission || !routing.success || request.workspaceSyncSourceRouting
      || request.method !== `${machine.machineId}:${readWorkspaceSyncTargetMethod(routing.data.target.phase)}`
      || !doesWorkspaceSyncTargetRequestMatchRouting(request.params, { ...routing.data.target, targetContext: routing.data.source.sourceContext })
      || routing.data.target.phase !== 'release' && (!request.callerInputAuthorization
        || !doesWorkspaceSyncSourceWriterTargetRootMatchRouting(request.callerInputAuthorization, routing.data, request.machineAdmission))) return forbidden();
    if (routing.data.target.phase === 'release' && !request.workspaceSyncTargetRouting && (request.machineAdmission.machineId !== routing.data.sourceWriter.machineId
      || request.machineAdmission.installationId !== routing.data.sourceWriter.installationId
      || request.machineAdmission.actorAccountId !== request.machineAdmission.custodianAccountId
      || request.machineAdmission.custodianAccountId !== routing.data.source.sourceContext.machineAdmission.custodianAccountId)) return forbidden();
    writerTargetRouting = routing.data;
  }
  if (request.workspaceSyncSourceRouting !== undefined && request.workspaceSyncTargetRouting !== undefined) return forbidden();
  if (isProjectSource || isFiniteSource) {
    const routing = WorkspaceSyncSourceRoutingV1Schema.safeParse(request.workspaceSyncSourceRouting);
    const execution = WorkspaceSyncSourceExecutionV1Schema.safeParse(request.workspaceSyncSourceExecution);
    if (!machine || !request.machineAdmission || !routing.success || !execution.success || !request.callerInputAuthorization
      || request.method !== `${machine.machineId}:${isFiniteSource ? RPC_METHODS.DAEMON_WORKSPACE_SYNC_PREPARE_BETWEEN
        : RPC_METHODS.DAEMON_WORKSPACE_SYNC_MATERIALIZE_FOR_OPEN}`
      || execution.data.method !== request.method
      || !sameStrictJsonValue(execution.data.externalActionExecution.authorization, request.callerInputAuthorization)
      || routing.data.sourceMachineId !== request.machineAdmission.machineId
      || !sameStrictJsonValue(routing.data.sourceContext?.machineAdmission, request.machineAdmission)
      || !(isFiniteSource ? doesWorkspaceSyncFinitePrepareRequestMatchRouting(request.params, request.callerInputAuthorization, routing.data)
        : doesWorkspaceSyncProjectSourceRequestMatchRouting(request.params, request.callerInputAuthorization, routing.data))) return forbidden();
    sourceRouting = routing.data;
  } else if (isSourcePhase || request.workspaceSyncSourceRouting !== undefined) {
    const routing = WorkspaceSyncSourceRoutingV1Schema.safeParse(request.workspaceSyncSourceRouting);
    const phase = WorkspaceSyncHandoffSourcePhaseRequestV1Schema.safeParse(request.params);
    if (!machine || !request.machineAdmission || !routing.success || !phase.success
      || request.method !== `${machine.machineId}:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_HANDOFF_SOURCE_PHASE}`
      || routing.data.phase !== phase.data.phase
      || routing.data.operationId !== phase.data.input.operationId
      || routing.data.accountServerId !== phase.data.input.accountServerId
      || routing.data.sourceMachineId !== phase.data.input.sourceMachineId
      || routing.data.sourceRootPath !== phase.data.input.sourceRootPath
      || routing.data.sourceSessionId !== phase.data.input.sourceSessionId
      || routing.data.sourceMachineId !== request.machineAdmission.machineId
      || routing.data.sourceContext && !sameStrictJsonValue(routing.data.sourceContext.machineAdmission, request.machineAdmission)) return forbidden();
    sourceRouting = routing.data;
  }
  if (request.workspaceSyncTargetRouting !== undefined) {
    const routing = WorkspaceSyncTargetRoutingV1Schema.safeParse(request.workspaceSyncTargetRouting);
    if (!machine || !request.machineAdmission || !routing.success
      || request.method !== `${machine.machineId}:${readWorkspaceSyncTargetMethod(routing.data.phase)}`
      || routing.data.targetMachineId !== request.machineAdmission.machineId
      || !sameStrictJsonValue(routing.data.targetContext.machineAdmission, request.machineAdmission)
      || writerTargetRouting && !doesWorkspaceSyncTargetRoutingMatchWriterTarget(routing.data, writerTargetRouting)) return forbidden();
    if (!doesWorkspaceSyncTargetRequestMatchRouting(request.params, routing.data)) return forbidden();
    // The canonical TARGET owner resolves the selected child to this exact physical WorkspaceRef before effects.
    targetRouting = routing.data;
  }
  const isPreviewAdmission = request.method === RPC_METHODS.DAEMON_LOCAL_SERVICES_PREVIEW_ADMISSION
    || request.method.endsWith(`:${RPC_METHODS.DAEMON_LOCAL_SERVICES_PREVIEW_ADMISSION}`);
  if (isPreviewAdmission && (!machine
    || request.method !== `${machine.machineId}:${RPC_METHODS.DAEMON_LOCAL_SERVICES_PREVIEW_ADMISSION}`
    || !request.machineAdmission
    || !isSocketRpcLocalServicesPreviewAdmissionServerOriginAuthorizationContext(request.authorization))) return forbidden();
  const isAccessLoss = request.method.endsWith(`:${RPC_METHODS.DAEMON_MACHINE_ACCESS_LOSS}`);
  const custodyRequest = isAccessLoss ? MachineAccessLossCustodyRequestV1Schema.safeParse(request.params) : null;
  if (isAccessLoss && (!custodyRequest?.success || !request.machineAdmission
    || !isSocketRpcMachineAccessLossServerOriginAuthorizationContext(request.authorization))) return forbidden();
  if (request.machineAdmission !== undefined) {
    const admission = SocketRpcMachineAdmissionContextV1Schema.safeParse(request.machineAdmission);
    if (!admission.success || !machine) return forbidden();
    const context = admission.data;
    if (isAccessLoss && context.actorAccountId !== context.custodianAccountId) return forbidden();
    try {
      const installationId = machine.resolveInstallationId();
      const custodianAccountId = !writerTargetRouting && !seedRouting
        ? await machine.resolveCustodianAccountId(request.signal) : null;
      if (request.signal?.aborted) return forbidden('request_cancelled');
      if (!installationId) return forbidden('machine_installation');
      // Passive copy review retains its controller identity on the second hop.
      // Only this exact method's strict preview may bind to the physical target;
      // the same installation, custodian and current Home checks still apply.
      const copyPreview = request.method === `${machine.machineId}:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_COMMITTED_COPY_INSPECT}`
        ? WorkspaceSyncCommittedCopyPreviewV1Schema.safeParse(request.params) : null;
      const targetRequest = copyPreview?.success && copyPreview.data.targetMachineId === machine.machineId
        ? { machineId: copyPreview.data.targetMachineId } : request.params;
      let targetPredicate: RpcAdmissionPredicate = 'machine_target';
      if (!sourceRouting && !targetRouting && !writerTargetRouting && !seedRouting
        && !doesMachineRpcTargetMatchAdmission(targetRequest, context, {
          machineId: machine.machineId, installationId, custodianAccountId,
        }, predicate => { targetPredicate = predicate; })) return forbidden(targetPredicate);
      if (!request.method.startsWith(`${machine.machineId}:`)) return forbidden('machine_scope');
      // A finite prepare packet retains the logical source's custodian. Home
      // independently verifies the installed relationship controller's signer.
      if (!writerTargetRouting && !seedRouting && !isFiniteSource
        && context.custodianAccountId !== custodianAccountId) return forbidden('machine_custodian');
      const rpcMethod = request.method.slice(machine.machineId.length + 1);
      const privateSpawn = privateSessionMethods.includes(rpcMethod)
        ? SpawnDaemonSessionRequestSchema.safeParse(request.params)
        : null;
      // Resume resolves the stored Session owner/birth before runner launch.
      // Its local transport consumes the Action's admission, not the distinct
      // custodian-only raw spawn permission. Fresh spawns still use raw admission.
      const nativeSessionResume = privateSpawn?.success
        && privateSpawn.data.type === 'resume-session' && !!privateSpawn.data.sessionId;
      const verifiedAdmission = nativeSessionResume && request.verifyMachineAdmissionCurrent
        ? await request.verifyMachineAdmissionCurrent()
        : await machine.verifyMachineAdmission({ context, method: request.method,
          ...(sourceRouting ? { workspaceSyncSourceRouting: sourceRouting } : {}),
          ...((request.workspaceSyncSourceExecution?.originalActionEnvelope || seedRouting || isProjectSource || isFiniteSource || writerTargetRouting && request.callerInputAuthorization?.binding.actionId === 'projects.open')
            && request.workspaceSyncSourceExecution ? { workspaceSyncSourceExecution: request.workspaceSyncSourceExecution } : {}),
          ...(targetRouting ? { workspaceSyncTargetRouting: targetRouting } : {}),
          ...(writerTargetRouting ? { workspaceSyncSourceWriterTargetRouting: writerTargetRouting } : {}),
          ...(seedRouting ? { workspaceSyncSeedRouting: seedRouting } : {}),
          ...((request.workspaceSyncSourceExecution?.originalActionEnvelope || sourceRouting || writerTargetRouting || seedRouting) && request.callerInputAuthorization ? { callerInputAuthorization: request.callerInputAuthorization } : {}),
          ...(custodyRequest?.success && 'subjectAccountId' in custodyRequest.data
            ? { custodySubjectAccountId: custodyRequest.data.subjectAccountId } : {}),
          ...(request.signal ? { signal: request.signal } : {}) });
      if (!verifiedAdmission) return forbidden('machine_currentness');
      const privateRecovery = rpcMethod === RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_CONFLICT_RECOVER
        && context.actorAccountId !== context.custodianAccountId
        && !sourceRouting && !targetRouting && !writerTargetRouting && !seedRouting
        ? WorkspaceSyncTargetConflictRecoverV1Schema.safeParse(request.params) : null;
      if (privateRecovery && !privateRecovery.success) return forbidden('machine_target');
      const recoveryHome = privateRecovery?.success ? await machine.resolveHomeServerIdentityId?.(request.signal) : null;
      if (installationId !== machine.resolveInstallationId()) return forbidden('machine_installation');
      if (request.signal?.aborted) return forbidden('request_cancelled');
      // These native bind phases do not launch requester processes. Home has
      // just verified the exact child/controller route; the workspace owner
      // must still map its own current native root before any copy, and retain
      // exact input/claimant/operation custody for settlement. Raw files and
      // commands, Project/finite SOURCE and seed transport keep isolation.
      const nativeManagedBindPhase =
        context.machineId !== machine.machineId &&
        !seedRouting &&
        request.callerInputAuthorization?.binding.actionId !==
          'projects.open' &&
        !isProjectWorkspaceSyncPreparationActionV1(
          request.callerInputAuthorization?.binding.actionId,
        ) &&
        ((isSourcePhase && sourceRouting?.sourceContext !== undefined) ||
          targetRouting !== undefined);
      const nativeSessionEffect = resolveMachineRpcExternalActionEffectV1(
        rpcMethod,
        request.callerInputAuthorization?.binding,
        { machineId: machine.machineId, installationId },
      );
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
        context.machineId === machine.machineId &&
        !sourceRouting &&
        !targetRouting &&
        !writerTargetRouting &&
        !seedRouting &&
        (finiteProjectMethods.includes(rpcMethod) ||
          // Workspace linking and read-back own native root mapping and copy
          // custody. Neither launches a requester command or needs raw Session authority.
          rpcMethod === RPC_METHODS.DAEMON_WORKSPACE_SYNC_RELATIONSHIP_CREATE ||
          rpcMethod === RPC_METHODS.DAEMON_WORKSPACE_SYNC_RELATIONSHIP_CREATION_OBSERVE ||
          rpcMethod === RPC_METHODS.BASH ||
          nativeFilesystemMethods.includes(rpcMethod) ||
          rpcMethod === RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_START ||
          rpcMethod === RPC_METHODS.DAEMON_MCP_SERVERS_TEST ||
          rpcMethod === RPC_METHODS.PROJECTS_OPEN ||
          rpcMethod === RPC_METHODS.CAPABILITIES_DETECT ||
          rpcMethod === RPC_METHODS.CAPABILITIES_INVOKE ||
          nativeSessionMethods.includes(rpcMethod) ||
          nativeSessionResume ||
          nativeSessionEffect === 'session.spawn_new' ||
          nativeSessionEffect === 'session.agent.transition');
      const nativeRequesterControl =
        context.machineId === machine.machineId &&
        !sourceRouting &&
        !targetRouting &&
        !writerTargetRouting &&
        !seedRouting;
      const nativePersonTerminal = nativeRequesterControl && nativeTerminalMethods.includes(rpcMethod);
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
      if (privateSyncLookup?.kind === 'private_unavailable' || privateRecovery && !privateSyncExecution) {
        return { ok: false, errorCode: 'agent_isolation_unavailable', error: 'Private workspace Sync execution is unavailable' };
      }
      if (privateTargetBody && privateTargetRouting
        && privateTargetBody.bootstrapOperationId !== privateTargetRouting.operationId && !privateSyncExecution) {
        return { ok: false, errorCode: 'agent_isolation_unavailable', error: 'Private workspace Sync execution is unavailable' };
      }
      if (privateSyncExecution) return { ok: true, workspaceSyncPrivateExecution: privateSyncExecution };
      if (
        !nativeManagedBindPhase &&
        !nativeEffectOwner &&
        // The scoped computer owner selects and verifies the requester's desktop.
        !nativePersonalComputer &&
        // Byte reads acquire no execution identity: the registered terminal
        // owner distinguishes finite output and enforces retained custody.
        // Keep the route flag for Session admission and older-receiver floors.
        !(nativePersonTerminal && rpcMethod === RPC_METHODS.DAEMON_TERMINAL_STREAM_READ_BYTES) &&
        (workspaceTargetPhase && !privateTargetRouting || resolveMachineRpcRoutePolicy(rpcMethod)
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
          // Rootless release and unrelated routed work cannot mint this fact.
          ...(request.callerInputAuthorization &&
          (sourceRouting ||
            seedRouting ||
            (writerTargetRouting && writerTargetRouting.target.phase !== 'release'))
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
        // Home-admitted Manage on this physical receiver permits raw work.
        // Otherwise retain owner custody and identity-bound terminal protection.
        if (
          !receivingManager && !isHostRequesterUnrestrictedOwner(identity) &&
          !(
            nativePersonTerminal &&
            identity.kind === 'isolated' &&
            (identity.presentPerson === true ||
              (rpcMethod === RPC_METHODS.DAEMON_TERMINAL_ENSURE &&
                !identity.separationRequired))
          )
        ) {
          return {
            ok: false,
            errorCode: 'agent_isolation_unavailable',
            error: 'Requester execution protection is unavailable',
          };
        }
      }
      if (SessionTransferRpcMethodV1Schema.safeParse(request.method.slice(machine.machineId.length + 1)).success) {
        const preparedTransfer = PreparedTransferRpcRequestV1Schema.safeParse(request.params);
        if (preparedTransfer.success && request.method === `${machine.machineId}:${resolvePreparedTransferRpcPhaseV1(
          preparedTransfer.data.path, preparedTransfer.data.httpMethod, preparedTransfer.data.body,
        )}`) return { ok: true };
      }
    } catch {
      return forbidden('authorization_unavailable');
    }
  }
  if (isSocketRpcMachineReadServerOriginAuthorizationContext(request.authorization)) return { ok: true };
  const sessionRule = resolveSocketRpcSessionAuthorization(request.method);
  if (sessionRule?.serverMintedContext === 'session.read') {
    const authorization = parseSocketRpcAuthorizationContext(request.authorization);
    if (authorization?.kind !== 'session.read') return forbidden('session_authorization');
    const requestedSessionId = readSessionIdFromParams(request.params, request.method);
    return requestedSessionId && requestedSessionId === authorization.sessionId
      ? { ok: true }
      : forbidden('session_target');
  }
  if (sessionRule?.machineScope === true && request.machineAdmission !== undefined) {
    // The exact installation and current Home admission were verified above.
    // Dual-scope Run methods use that Machine custody, not a fabricated Session
    // write proof. Keep detached control custodian-only, as on the Home relay.
    if (request.machineAdmission.actorAccountId !== request.machineAdmission.custodianAccountId) return forbidden('machine_custodian');
    return request.authorization === undefined ? { ok: true } : forbidden('session_authorization');
  }
  if (sessionRule?.optionalSessionScope) {
    if (request.authorization === undefined) return { ok: true };
    return parseSocketRpcAuthorizationContext(request.authorization)?.kind === 'session.write' ? { ok: true } : forbidden('session_authorization');
  }
  const authorizationMethod = resolveSocketRpcSessionWriteAuthorizationMethod(request.method);
  if (!authorizationMethod) {
    return { ok: true };
  }

  const requestedSessionId = readSessionIdFromParams(request.params, request.method);
  if (
    authorizationMethod === RPC_METHODS.STOP_SESSION
    && !request.authorization
    && request.transportResponseEnvelopeVersion === undefined
    && requestedSessionId
  ) {
    // `server-v0.2.1` (4913c1e533c872a0712ba1c25b3104fd470aacc2)
    // forwarded encrypted Stop params only after authenticating both sockets,
    // before session-write proof and response envelopes existed. Keep exactly
    // that released direction working. Current servers always stamp the proof
    // and envelope, so a current request missing proof still fails closed.
    return { ok: true };
  }

  const authorization = parseSocketRpcAuthorizationContext(request.authorization);
  if (!authorization || authorization.kind === 'session.read') return forbidden('session_authorization');

  if (!requestedSessionId || requestedSessionId !== authorization.sessionId) {
    return forbidden('session_target');
  }

  return { ok: true };
}
