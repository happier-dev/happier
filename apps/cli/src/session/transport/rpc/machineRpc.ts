import { isSessionStopChildRootV1, readSessionStopChildTargetV1 } from '@happier-dev/protocol/actions/sessionSections';
import { isMachineSetupPlanRpcChildV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { readHostAdmittedReviewedChildV1 } from '@happier-dev/protocol/actions/actionExecutor';
import { isReviewedSessionStopChild, isReviewedMachineSetupPlanChild, isReviewedDeploymentChild, type DeploymentArchiveOriginForHost, type DeploymentChildDerivationRefusal } from '@/api/externalActionExecutionAuthorization';
import { readDeploymentChildRpcV1, projectDeploymentChildRoutingV1, readDeploymentArchiveRpcEffectV1, isDeploymentChildRootActionIdV1 } from '@happier-dev/protocol';
import { WorkspaceSyncSourceExecutionV1Schema, type WorkspaceSyncSourceExecutionV1 } from '@happier-dev/protocol/socketRpc';
import { assertDeploymentArchiveChildCurrentForHost } from '@/api/deploymentChildExecutionAuthorization';
import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import { fetchAccountMachineReplacements } from '@/api/machine/fetchAccountMachineReplacements';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { readAccountEncryptionModeOnce } from '@/api/client/accountEncryptionMode';
import { AccessibleMachineAccessV1Schema } from '@happier-dev/protocol/machines/machineAccessV1';
import {
  resolvePublishedMachineContentCodec,
  type ExpectedRunnerMachineContentKeyBindingScope,
} from '@/api/machine/machineDataEncryptionKey';
import type { StoredCredentials } from '@/persistence';
import { resolveSessionControlSocketConnectTimeoutMs } from '@/session/transport/shared/sessionTimeouts';
import type { SocketRpcAuthorizationContext } from '@happier-dev/protocol/socketRpc';
import { isRpcMethodNotAvailableError } from '@happier-dev/protocol/rpcErrors';
import { resolveCanonicalMachineId } from '@happier-dev/protocol/machines/identity/canonicalMachineId';
import axios from 'axios';
import { randomBytes, randomUUID } from 'node:crypto';
import { decodeBase64, encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { SessionRequesterBootstrapRpcRequestV1Schema, sealSessionRequesterBootstrapRpcRequestV1,
  SessionRequesterHandoffBootstrapRpcRequestV1Schema, sealSessionRequesterHandoffBootstrapRpcRequestV1,
  SessionRequesterHandoffPreflightBootstrapRpcRequestV1Schema, sealSessionRequesterHandoffPreflightBootstrapRpcRequestV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { projectRequesterSessionCredentialDisclosure } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { SessionSpawnNewInputV2Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import { SessionSpawnNewResultV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { fetchAccountProfile } from '@/api/accountProfile';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions';
import {
  createExternalActionAuthorizedRequestHeaders,
  createExternalActionMachineRpcExecution,
  createExternalActionSourceMachineRpcExecution,
  readExternalActionSourceMachineRpcSigner,
  isReviewedServiceMoveChild,
  isReviewedSecondOpinionModelSpawnChild,
  dispatchOriginalAccountAction,
  type ExternalActionMachineRequestSigningKey,
} from '@/api/externalActionExecutionAuthorization';
import {
  callSocketRpc,
  isSocketIoAckTimeoutError,
  raceSocketIoAckTimeout,
  markRpcRequestDisposition,
  readRpcRequestDisposition,
  type RpcRequestDisposition,
  type SocketRpcContent,
} from '@happier-dev/sync-client';
import { readRpcObservation, withUserScopedRpcSocket, type RpcObservationOptions } from './withUserScopedRpcSocket';
import { readRequesterAccountActionContext } from "@/daemon/sessionEncryption/requesterAccountActionContext";
import { isDiscussionSecondOpinionModelRpcMethodV1 } from '@happier-dev/protocol/discussions/secondOpinionActions';
import type { RpcHandlerContext } from '@/api/rpc/types';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';

export type MachineRpcRequestDisposition = RpcRequestDisposition;
export const readMachineRpcRequestDisposition = readRpcRequestDisposition;
const DEFAULT_MACHINE_RPC_TIMEOUT_MS = 20_000;

export class MachineRpcEncryptionModeMismatchError extends Error {
  readonly code = 'machine_content_mode_mismatch' as const;

  constructor(readonly machineId: string) {
    super(`Machine ${machineId} content mode does not match the verified caller's expectation`);
    this.name = 'MachineRpcEncryptionModeMismatchError';
  }
}

/** The public caller retains V2 creation identity; the existing exact target reader selects private custody. */
export async function dispatchRequesterSessionSpawnNewRpc(params: Readonly<{
  credentials: StoredCredentials; input: unknown; serverId: string; serverUrl: string; serverIdentityId?: string;
  context?: ActionExecutorContext & Partial<Pick<RpcHandlerContext, 'workspaceSyncSourceExecution'
    | 'machineAdmission' | 'verifyMachineAdmissionCurrent'>>;
  externalActionMachineInstallationId?: string;
  externalActionMachineRequestPrivateKey?: ExternalActionMachineRequestSigningKey;
  onRequesterSessionCredentialDisclosure?: (disclosure: ReturnType<typeof projectRequesterSessionCredentialDisclosure>) => boolean | void | Promise<boolean | void>;
}>): Promise<ActionExecuteResult | null> {
  const parsed = SessionSpawnNewInputV2Schema.safeParse(params.input);
  if (!parsed.success || parsed.data.executionTarget.serverId !== params.serverId) return null;
  const signal = params.context?.signal;
  const machineId = parsed.data.executionTarget.machineId;
  const root = params.context?.externalActionExecutionAuthorization;
  if (root?.binding.actionId === 'discussion.second_opinion.start') {
    const requester = readRequesterAccountActionContext(root);
    if (!params.context || !params.externalActionMachineInstallationId || !params.externalActionMachineRequestPrivateKey
      || !await isReviewedSecondOpinionModelSpawnChild({ authorization: root, envelope: params.context.originalActionEnvelope,
        actionId: 'session.spawn_new', machineId, params: parsed.data, ...(signal ? { signal } : {}) })) {
      return { ok: false, errorCode: 'target_unavailable', error: 'target_unavailable' };
    }
    if (!requester) return { ok: false, errorCode: 'target_unavailable', error: 'target_unavailable' };
    const packet = params.context.workspaceSyncSourceExecution;
    if (packet && params.context.machineAdmission?.machineId === machineId
      && params.context.machineAdmission.actorAccountId === root.binding.accountId
      && packet.method === `${machineId}:${RPC_METHODS.SESSION_SPAWN_NEW}`
      && packet.externalActionExecution.effectActionId === 'session.spawn_new'
      && packet.externalActionExecution.authorization.token === root.token
      && sameStrictJsonValue(packet.externalActionExecution.authorization.binding, root.binding)
      && sameStrictJsonValue(packet.originalActionEnvelope, params.context.originalActionEnvelope)
      && params.context.verifyMachineAdmissionCurrent && await params.context.verifyMachineAdmissionCurrent()) return null;
    const result = SessionSpawnNewResultV1Schema.safeParse(await callExactMachineRpc({ credentials: requester.credentials,
      serverUrl: params.serverUrl, machineId, method: RPC_METHODS.SESSION_SPAWN_NEW, request: parsed.data,
      authorityCeiling: 'account_automation', timeoutMs: null, requireCurrentMachine: true, requiredMachineKind: 'persistent',
      externalAction: { context: params.context, effectActionId: 'session.spawn_new',
        installationId: params.externalActionMachineInstallationId, privateKey: params.externalActionMachineRequestPrivateKey },
      ...(signal ? { signal } : {}) }));
    return result.success ? { ok: true, result: result.data }
      : { ok: false, errorCode: 'invalid_action_transport_output', error: 'invalid_action_transport_output' };
  }
  const target = await resolveMachineRpcContentCodec({ credentials: params.credentials, machineId,
    serverUrl: params.serverUrl, timeoutMs: DEFAULT_MACHINE_RPC_TIMEOUT_MS, requireCurrentMachine: true,
    requiredMachineKind: 'persistent', ...(signal ? { signal } : {}) });
  if (!target.access) return null;
  const profile = await runWithServerHttpBaseUrl(params.serverUrl,
    () => fetchAccountProfile({ token: params.credentials.token, ...(signal ? { signal } : {}) }));
  if (target.access.custodian.accountId === profile.id) return null;
  // Raw public V2 input carries no authenticated source Session/permission witness.
  // A nonhuman caller must retain its original authority through the existing
  // signed Action carrier rather than upgrading to a full Account bootstrap.
  if (params.context?.surface === 'agent' || params.context?.surface === 'mcp'
    || params.context?.actionCaller && params.context.actionCaller.kind !== 'host'
    || params.context?.causalPermissionAuthority) {
    return { ok: false, errorCode: 'target_unavailable', error: 'target_unavailable' };
  }
  const execution = await dispatchOriginalAccountAction({ credentials: params.credentials, actionId: 'session.spawn_new',
    input: parsed.data, target: { kind: 'machine', machineId }, serverHttpBaseUrl: params.serverUrl,
    serverIdentityId: params.serverIdentityId, requestId: params.context?.actionRequestId ?? randomUUID(),
    ...(params.context?.authority ? { authority: params.context.authority } : {}),
    ...(params.onRequesterSessionCredentialDisclosure ? { onRequesterSessionCredentialDisclosure: params.onRequesterSessionCredentialDisclosure } : {}),
    ...(signal ? { signal } : {}) });
  if (!execution.ok) return execution;
  const output = SessionSpawnNewResultV1Schema.safeParse(execution.result);
  return output.success ? { ok: true, result: output.data }
    : { ok: false, errorCode: 'invalid_action_transport_output', error: 'invalid_action_transport_output' };
}

export class MachineRpcTargetNotCurrentError extends Error {
  readonly code = 'machine_target_not_current' as const;

  constructor(readonly machineId: string, readonly reason: MachineRpcTargetNotCurrentReason,
    readonly derivationReason?: DeploymentChildDerivationRefusal) {
    super(`Machine ${machineId} RPC target refused: ${reason}${derivationReason ? `/${derivationReason}` : ''}`);
    this.name = 'MachineRpcTargetNotCurrentError';
  }
}

export class MachineRpcMachineKindMismatchError extends Error {
  readonly code = 'machine_kind_mismatch' as const;

  constructor(
    readonly machineId: string,
    readonly expectedKind: 'persistent' | 'ephemeral_session_runner',
  ) {
    super(`Machine ${machineId} is not a ${expectedKind}`);
    this.name = 'MachineRpcMachineKindMismatchError';
  }
}

function isOriginalRequesterSource(externalAction: NonNullable<Parameters<typeof callExactMachineRpc>[0]['externalAction']>): boolean {
  const authorization = externalAction.context.externalActionExecutionAuthorization;
  const source = authorization ? readExternalActionSourceMachineRpcSigner(authorization) : null;
  return Boolean(source
    && (externalAction.context.defaultSessionMachineId === undefined
      || externalAction.context.defaultSessionMachineId === source.machineId)
    && externalAction.installationId === source.installationId);
}

async function resolveMachineRpcContentCodec(params: Readonly<{
  credentials: StoredCredentials;
  machineId: string;
  serverUrl?: string;
  timeoutMs: number;
  signal?: AbortSignal;
  expectedRunnerMachineContentKeyBinding?: ExpectedRunnerMachineContentKeyBindingScope;
  requireCurrentMachine?: boolean;
  requiredMachineKind?: 'persistent' | 'ephemeral_session_runner';
  deploymentChild?: Readonly<{ machineId: string; installationId: string }>;
  deploymentSetupExecution?: WorkspaceSyncSourceExecutionV1;
  deploymentArchiveExecution?: WorkspaceSyncSourceExecutionV1;
  expectedInstallationId?: string;
  externalAction?: MachineRpcExternalAction;
}>) {
  const path = `/v1/machines/${encodeURIComponent(params.machineId)}`;
  const externalAuthorization = params.externalAction?.context.externalActionExecutionAuthorization;
  const externalTarget = params.externalAction?.context.externalActionTarget;
  const moveChildRead = (externalAuthorization?.binding.actionId === 'projects.service.relocate'
    && params.externalAction?.effectActionId !== externalAuthorization.binding.actionId)
    || externalAuthorization?.binding.actionId === 'discussion.second_opinion.start'
      && params.externalAction?.effectActionId === 'session.spawn_new'
    || isMachineSetupPlanRpcChildV1({ rootActionId: externalAuthorization?.binding.actionId,
      effectActionId: params.externalAction?.effectActionId, method: RPC_METHODS.MACHINE_SETUP_PLAN })
    || params.deploymentChild !== undefined
    || isSessionStopChildRootV1(externalAuthorization?.binding.actionId) && params.externalAction?.effectActionId === 'session.stop';
  if (params.externalAction && (!externalAuthorization || !externalTarget)) {
    throw new Error('External Action Machine HTTP authorization is unavailable');
  }
  // Only the already-verified finite archive branch may use its original
  // requester's private codec custody. Socket authentication stays receiver-owned.
  const contentCredentials = params.deploymentArchiveExecution
    ? readRequesterAccountActionContext(externalAuthorization)?.credentials
    : params.credentials;
  if (!contentCredentials) throw new MachineRpcTargetNotCurrentError(params.machineId, 'requester_unavailable');
  const response = await axios.get(
    `${params.serverUrl ?? resolveServerHttpBaseUrl()}${path}`,
    {
      headers: {
        ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
        ...(params.externalAction && externalAuthorization && externalTarget && (!moveChildRead || params.deploymentArchiveExecution || params.deploymentSetupExecution)
          ? createExternalActionAuthorizedRequestHeaders({
              authorization: externalAuthorization,
              effectActionId: params.deploymentArchiveExecution || externalAuthorization.binding.actionId === 'projects.service.relocate'
                ? externalAuthorization.binding.actionId : params.externalAction.effectActionId,
              target: externalTarget,
              installationId: !params.deploymentArchiveExecution && isOriginalRequesterSource(params.externalAction)
                ? externalAuthorization.binding.installationId : params.externalAction.installationId,
              ...(params.deploymentArchiveExecution ? { deploymentChildExecution: params.deploymentArchiveExecution,
                deploymentArchiveOrigin: params.externalAction.deploymentArchiveOrigin } : {}),
              ...(params.deploymentSetupExecution ? { deploymentChildExecution: params.deploymentSetupExecution } : {}),
              method: 'GET',
              path,
              privateKey: params.externalAction.privateKey,
            })
          : { Authorization: `Bearer ${params.credentials.token}` }),
      },
      timeout: params.timeoutMs,
      ...(params.signal ? { signal: params.signal } : {}),
    },
  );
  const raw = response.data?.machine as
    | {
        id?: unknown;
        kind?: 'persistent' | 'ephemeral_session_runner';
        installationId?: string | null;
        installationPublicKey?: unknown;
        dataEncryptionKey?: unknown;
        storageMode?: 'plain' | 'e2ee';
        access?: unknown;
        runnerContentKeyBinding?: unknown;
        revokedAt?: unknown;
        replacedByMachineId?: unknown;
      }
    | null
    | undefined;
  if (String(raw?.id ?? '').trim() !== params.machineId) {
    throw new Error(`Machine ${params.machineId} was not returned by the server`);
  }
  if (
    params.requireCurrentMachine === true
    && (
      (raw?.revokedAt !== null && raw?.revokedAt !== undefined)
      || (typeof raw?.replacedByMachineId === 'string' && raw.replacedByMachineId.trim().length > 0)
    )
  ) {
    throw new MachineRpcTargetNotCurrentError(params.machineId, 'machine_revoked_or_replaced');
  }
  const actualMachineKind = raw?.kind ?? 'persistent';
  if (params.requiredMachineKind && actualMachineKind !== params.requiredMachineKind) {
    throw new MachineRpcMachineKindMismatchError(params.machineId, params.requiredMachineKind);
  }
  const access = raw?.access === undefined ? undefined : AccessibleMachineAccessV1Schema.parse(raw.access);
  if (isMachineSetupPlanRpcChildV1({ rootActionId: externalAuthorization?.binding.actionId,
    effectActionId: params.externalAction?.effectActionId, method: RPC_METHODS.MACHINE_SETUP_PLAN }) && access?.role !== 'manage') {
    throw new MachineRpcTargetNotCurrentError(params.machineId, 'setup_manage_required');
  }
  if (access && access.accessState !== 'ready') throw new MachineRpcEncryptionModeMismatchError(params.machineId);
  if (params.expectedInstallationId && raw?.installationId !== params.expectedInstallationId) {
    throw new MachineRpcTargetNotCurrentError(params.machineId, 'installation_mismatch');
  }
  let expectedAccountMode: 'plain' | 'e2ee' | 'unknown' = access?.resourceMode ?? raw?.storageMode ?? 'unknown';
  if (expectedAccountMode === 'unknown' && !params.deploymentArchiveExecution && !params.deploymentSetupExecution) {
    const mode = await readAccountEncryptionModeOnce({ request: () => axios.get(
      `${params.serverUrl ?? resolveServerHttpBaseUrl()}/v1/account/encryption`, {
        headers: { Authorization: `Bearer ${params.credentials.token}` },
        timeout: params.timeoutMs,
        ...(params.signal ? { signal: params.signal } : {}),
      },
    ) });
    if (mode.kind === 'resolved') expectedAccountMode = mode.mode;
  }
  const codec = resolvePublishedMachineContentCodec({
    credentials: contentCredentials,
    machineId: params.machineId,
    expectedAccountMode,
    access: raw?.access,
    publishedDataEncryptionKey: raw?.dataEncryptionKey,
    machineKind: raw?.kind,
    installationId: raw?.installationId,
    runnerContentKeyBinding: raw?.runnerContentKeyBinding,
    ...(params.expectedRunnerMachineContentKeyBinding
      ? { expectedRunnerMachineContentKeyBinding: params.expectedRunnerMachineContentKeyBinding }
      : {}),
  });
  return { codec, access, installationId: raw?.installationId,
    installationPublicKey: raw?.installationPublicKey };
}

/** One exact account-scoped machine RPC; retry and target selection stay caller-owned. */
export async function callExactMachineRpc(params: Readonly<{
  credentials: StoredCredentials;
  authorityCeiling?: 'account_automation';
  machineId: string;
  serverUrl?: string;
  method: string;
  /** Host-owned original invocation correlation; ordinary calls retain a fresh id. */
  requestId?: string;
  authorization?: SocketRpcAuthorizationContext;
  /** Captured from verified Account/Machine context, never inferred from key presence. */
  expectedEncryptionMode?: 'plain' | 'e2ee';
  /** Independently trusted Home/Account/Machine scope required for an encrypted Runner Machine. */
  expectedRunnerMachineContentKeyBinding?: ExpectedRunnerMachineContentKeyBindingScope;
  /** Reject a revoked/replaced row before encryption or socket emission. */
  requireCurrentMachine?: boolean;
  /** Reject a different Machine class before encryption or socket emission. */
  requiredMachineKind?: 'persistent' | 'ephemeral_session_runner';
  /** Null delegates acknowledgement lifetime to the caller signal/server lifecycle. */
  timeoutMs?: number | null;
  /** Cooperative cancellation retains this call's acknowledgement after emission. */
  waitForResultOnCancel?: boolean;
  /** Only read-only observations may be repeated after transport reconnect. */
  reattachOnReconnect?: true | RpcObservationOptions;
  signal?: AbortSignal;
  externalAction?: MachineRpcExternalAction;
}> & (
  | Readonly<{ request: unknown; prepareRequest?: never }>
  | Readonly<{ request?: never; prepareRequest: () => unknown }>
)): Promise<unknown> {
  let issued = false;
  const deadlineController = new AbortController();
  const signal = params.signal ? AbortSignal.any([params.signal, deadlineController.signal]) : deadlineController.signal;
  try {
    signal.throwIfAborted();
    const machineId = params.machineId.trim();
    if (!machineId) throw new Error('Machine id is required');
    const moveAuthorization = params.externalAction?.context.externalActionExecutionAuthorization;
    const opinionChild = moveAuthorization?.binding.actionId === 'discussion.second_opinion.start'
      && params.externalAction?.effectActionId === 'session.spawn_new' && isDiscussionSecondOpinionModelRpcMethodV1(params.method);
    const stopChild = isSessionStopChildRootV1(moveAuthorization?.binding.actionId)
      && params.externalAction?.effectActionId === 'session.stop' && params.method === RPC_METHODS.STOP_SESSION;
    const stopChildTarget = stopChild ? readSessionStopChildTargetV1(params.request) : null;
    const setupPlanChild = isMachineSetupPlanRpcChildV1({ rootActionId: moveAuthorization?.binding.actionId,
      effectActionId: params.externalAction?.effectActionId, method: params.method });
    const reviewedChild = readHostAdmittedReviewedChildV1(params.externalAction?.context) ?? undefined;
    const deploymentChild = moveAuthorization && params.externalAction ? readDeploymentChildRpcV1({
      rootActionId: moveAuthorization.binding.actionId, effectActionId: params.externalAction.effectActionId,
      rootPreparationAdmission: moveAuthorization.binding.deploymentPreparationAdmission, reviewedChild,
      method: params.method, params: params.request }) : null;
    const archiveEffect = readDeploymentArchiveRpcEffectV1(params.method);
    const archiveRequester = moveAuthorization ? readRequesterAccountActionContext(moveAuthorization) : null;
    const archiveJob = archiveRequester?.deploymentChild;
    const deploymentArchive = params.externalAction && archiveEffect === params.externalAction.effectActionId
      && archiveJob && (archiveJob.kind === 'build' || archiveJob.kind === 'member')
      ? await assertDeploymentArchiveChildCurrentForHost({ context: params.externalAction.context,
          machineId: archiveJob.machineId, installationId: params.externalAction.installationId }) : null;
    if (moveAuthorization && isDeploymentChildRootActionIdV1(moveAuthorization.binding.actionId, moveAuthorization.binding.deploymentPreparationAdmission)
      && archiveEffect && !deploymentArchive) throw new MachineRpcTargetNotCurrentError(machineId, 'archive_child_unavailable');
    const archiveOrigin = params.externalAction?.deploymentArchiveOrigin;
    const archiveInstallationId = deploymentArchive && archiveOrigin
      ? machineId === archiveOrigin.holderMachineId ? archiveOrigin.holderInstallationId
        : machineId === deploymentArchive.job.machineId ? deploymentArchive.job.installationId : null
      : undefined;
    if (deploymentArchive && (!archiveOrigin || !archiveInstallationId
      || archiveEffect === 'daemon.filesystem.download' && machineId !== archiveOrigin.holderMachineId
      || archiveEffect === 'daemon.filesystem.copy' && machineId !== deploymentArchive.job.machineId)) {
      throw new MachineRpcTargetNotCurrentError(machineId, 'archive_origin_mismatch');
    }
    const moveChild = (moveAuthorization?.binding.actionId === 'projects.service.relocate'
      && params.externalAction?.effectActionId !== moveAuthorization.binding.actionId) || opinionChild || setupPlanChild || deploymentChild !== null || stopChild;
    if (moveChild && params.externalAction && moveAuthorization) {
      const requester = readRequesterAccountActionContext(moveAuthorization);
      if (!requester) throw new MachineRpcTargetNotCurrentError(machineId, 'requester_unavailable');
      if (requester.credentials.token !== params.credentials.token) throw new MachineRpcTargetNotCurrentError(machineId, 'requester_credentials_mismatch');
      if (!await requester.isCurrent()) throw new MachineRpcTargetNotCurrentError(machineId, 'requester_not_current');
      const review = stopChild ? isReviewedSessionStopChild : setupPlanChild ? isReviewedMachineSetupPlanChild : deploymentChild ? isReviewedDeploymentChild
        : opinionChild ? isReviewedSecondOpinionModelSpawnChild : isReviewedServiceMoveChild;
      let derivationReason: DeploymentChildDerivationRefusal | undefined;
      const reviewInput = { authorization: moveAuthorization,
        envelope: params.externalAction.context.originalActionEnvelope, signal,
        actionId: params.externalAction.effectActionId, machineId, params: params.request,
        ...(opinionChild || deploymentChild || setupPlanChild || stopChild ? { method: params.method } : {}),
        ...(stopChild ? { target: stopChildTarget } : {}),
        ...(deploymentChild ? { reviewedChild, onRefused: (reason: DeploymentChildDerivationRefusal) => { derivationReason = reason; } } : {}),
      };
      if (!await review(reviewInput)) {
        throw new MachineRpcTargetNotCurrentError(machineId, 'child_not_derived', derivationReason);
      }
    }
    const timeoutMs = params.timeoutMs === null ? null
      : typeof params.timeoutMs === 'number' && params.timeoutMs > 0 ? params.timeoutMs : DEFAULT_MACHINE_RPC_TIMEOUT_MS;
    const setupTimeoutMs = timeoutMs ?? DEFAULT_MACHINE_RPC_TIMEOUT_MS;
    const connectTimeoutMs = typeof params.timeoutMs === 'number' && params.timeoutMs > 0
      ? setupTimeoutMs : resolveSessionControlSocketConnectTimeoutMs();
    const deadlineAtMs = timeoutMs === null ? null : Date.now() + timeoutMs;
    const remainingTimeoutMs = () => deadlineAtMs === null ? null : Math.max(1, deadlineAtMs - Date.now());
    const externalAction = params.externalAction;
    const createExecution = (transportAuthorization = externalAction?.context.externalActionExecutionAuthorization): Parameters<typeof callSocketRpc>[0]['createExternalActionExecution'] => externalAction
      ? (request) => {
        const authorization = transportAuthorization;
        const target = stopChildTarget ?? externalAction.context.externalActionTarget;
        const sourceMachineId = authorization ? readExternalActionSourceMachineRpcSigner(authorization)?.machineId : undefined;
        const execution = !deploymentArchive && isOriginalRequesterSource(externalAction) && authorization && target && sourceMachineId
          ? createExternalActionSourceMachineRpcExecution({ authorization, target, sourceMachineId, context: externalAction.context,
            sourceInstallationId: externalAction.installationId, effectActionId: externalAction.effectActionId,
            ...(deploymentChild ? { deploymentChildRouting: projectDeploymentChildRoutingV1(deploymentChild) } : {}),
            ...request, privateKey: externalAction.privateKey })
          : createExternalActionMachineRpcExecution({
          context: { ...externalAction.context, externalActionExecutionAuthorization: authorization },
          effectActionId: externalAction.effectActionId,
          installationId: externalAction.installationId,
          ...(deploymentChild ? { deploymentChildRouting: projectDeploymentChildRoutingV1(deploymentChild) } : {}),
          ...(deploymentArchive ? { deploymentChildExecution: deploymentArchive.execution,
            deploymentArchiveOrigin: archiveOrigin } : {}),
          ...request,
          privateKey: externalAction.privateKey,
        });
        if (!execution) throw new Error('External Action Machine RPC authorization is unavailable');
        return execution;
      } : undefined;
    let deploymentChildRequestId: string | undefined;
    let deploymentSetupExecution: WorkspaceSyncSourceExecutionV1 | undefined;
    if (deploymentChild) {
      deploymentChildRequestId = params.requestId ?? randomUUID();
      const method = `${machineId}:${params.method}`;
      // The exact known job is source-signed before its destination codec can
      // be opened. Its final encrypted RPC is separately signed below.
      deploymentSetupExecution = WorkspaceSyncSourceExecutionV1Schema.parse({ method,
        requestId: deploymentChildRequestId, params: deploymentChild,
        originalActionEnvelope: externalAction?.context.originalActionEnvelope,
        externalActionExecution: await createExecution()?.({ method,
          requestId: deploymentChildRequestId, params: deploymentChild }),
      });
    }
    const operation = withUserScopedRpcSocket({
      token: params.credentials.token,
      ...(params.authorityCeiling ? { authorityCeiling: params.authorityCeiling } : {}),
      ...(params.serverUrl ? { serverUrl: params.serverUrl } : {}),
      connectTimeoutMs,
      signal,
      ...(params.reattachOnReconnect ? { reattachOnReconnect: true } : {}),
      disconnectMessage: 'Machine RPC socket disconnected before acknowledgement',
    }, async (socket, connect, attemptSignal) => {
      const machineTarget = await resolveMachineRpcContentCodec({
        credentials: params.credentials,
        machineId,
        serverUrl: params.serverUrl,
        timeoutMs: remainingTimeoutMs() ?? setupTimeoutMs,
        ...(params.expectedRunnerMachineContentKeyBinding ? { expectedRunnerMachineContentKeyBinding: params.expectedRunnerMachineContentKeyBinding } : {}),
        ...(params.requireCurrentMachine ? { requireCurrentMachine: true } : {}),
        ...(params.requiredMachineKind ? { requiredMachineKind: params.requiredMachineKind } : {}),
        ...(params.externalAction ? { externalAction: params.externalAction } : {}),
        ...(deploymentChild ? { deploymentChild } : {}),
        ...(deploymentSetupExecution ? { deploymentSetupExecution } : {}),
        ...(deploymentArchive ? { deploymentArchiveExecution: deploymentArchive.execution } : {}),
        ...(archiveInstallationId ? { expectedInstallationId: archiveInstallationId } : {}),
        ...(attemptSignal ? { signal: attemptSignal } : {}),
      });
      const machineCodec = machineTarget.codec;
      if (deploymentChild && (deploymentChild.machineId !== machineId
        || deploymentChild.installationId !== machineTarget.installationId)) throw new MachineRpcTargetNotCurrentError(machineId, 'installation_mismatch');
      if (params.expectedEncryptionMode !== undefined && machineCodec.mode !== params.expectedEncryptionMode) {
        throw new MachineRpcEncryptionModeMismatchError(machineId);
      }
      // Some private payloads are meaningful only after the exact Machine
      // class and content authority have been admitted. Keep that check with
      // the transport owner rather than asking callers to read the row twice.
      let request = params.prepareRequest ? params.prepareRequest() : params.request;
      if (request && typeof request === 'object' && 'kind' in request
        && (request.kind === 'requester_session_bootstrap_v1' || request.kind === 'requester_session_handoff_bootstrap_v1'
          || request.kind === 'requester_session_handoff_preflight_bootstrap_v1')) {
        const privateRequest = request.kind === 'requester_session_bootstrap_v1'
          ? SessionRequesterBootstrapRpcRequestV1Schema.parse(request) : request.kind === 'requester_session_handoff_bootstrap_v1'
            ? SessionRequesterHandoffBootstrapRpcRequestV1Schema.parse(request) : SessionRequesterHandoffPreflightBootstrapRpcRequestV1Schema.parse(request);
        const expectedMethod = privateRequest.kind === 'requester_session_bootstrap_v1'
          ? RPC_METHODS.SESSION_SPAWN_NEW : privateRequest.kind === 'requester_session_handoff_bootstrap_v1'
            ? RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_V3 : RPC_METHODS.DAEMON_SESSION_HANDOFF_EXISTING_STATE_CHECK_V3;
        const targetMachineId = privateRequest.kind === 'requester_session_bootstrap_v1'
          ? privateRequest.input.executionTarget.machineId : privateRequest.input.targetMachineId;
        if (params.method !== expectedMethod || targetMachineId !== machineId) throw new MachineRpcTargetNotCurrentError(machineId, 'private_target_mismatch');
        const bootstrap = privateRequest.requesterBootstrap;
        if ('kind' in bootstrap) {
          if (bootstrap.installationId !== machineTarget.installationId) throw new MachineRpcTargetNotCurrentError(machineId, 'installation_mismatch');
        } else if (privateRequest.kind === 'requester_session_handoff_preflight_bootstrap_v1'
          || machineCodec.mode === 'plain' && (bootstrap.credentials.secret || bootstrap.credentials.encryption)) {
          const installationId = machineTarget.installationId;
          const encodedKey = machineTarget.installationPublicKey;
          if (!installationId || typeof encodedKey !== 'string') throw new MachineRpcTargetNotCurrentError(machineId, 'installation_key_unavailable');
          const publicKey = decodeBase64(encodedKey, 'base64');
          if (encodeBase64(publicKey, 'base64') !== encodedKey) throw new MachineRpcTargetNotCurrentError(machineId, 'installation_key_invalid');
          const sealing = { installationId, installationPublicKey: publicKey,
            randomBytes: (length: number) => new Uint8Array(randomBytes(length)) };
          request = privateRequest.kind === 'requester_session_bootstrap_v1'
            ? sealSessionRequesterBootstrapRpcRequestV1({ ...sealing, request: { ...privateRequest, requesterBootstrap: bootstrap } })
            : privateRequest.kind === 'requester_session_handoff_bootstrap_v1'
              ? sealSessionRequesterHandoffBootstrapRpcRequestV1({ ...sealing, request: { ...privateRequest, requesterBootstrap: bootstrap } })
              : sealSessionRequesterHandoffPreflightBootstrapRpcRequestV1({ ...sealing, request: { ...privateRequest, requesterBootstrap: bootstrap } });
        }
      }
      await connect();
      const content: SocketRpcContent = machineCodec.mode === 'plain' ? { mode: 'plain' } : {
        mode: 'e2ee',
        cipher: {
          encryptRaw: async (value) => machineCodec.encodeRpc(value),
          decryptRaw: async (ciphertext) => machineCodec.decodeRpc(ciphertext),
        },
      };
      return await readRpcObservation({ request, signal: attemptSignal,
        observation: params.reattachOnReconnect === true ? undefined : params.reattachOnReconnect,
        read: async request => {
          let transportAuthorization = externalAction?.context.externalActionExecutionAuthorization;
          const seal = transportAuthorization?.requesterAccountProjection?.sealRequesterAccountContext;
          const hasPrivateBootstrap = request && typeof request === 'object'
            && (Reflect.get(request, 'kind') === 'requester_session_bootstrap_v1'
              || Reflect.get(request, 'kind') === 'requester_session_handoff_bootstrap_v1'
              || Reflect.get(request, 'kind') === 'requester_session_handoff_preflight_bootstrap_v1');
          if (deploymentArchive) await assertDeploymentArchiveChildCurrentForHost({ context: externalAction!.context,
            machineId: deploymentArchive.job.machineId, installationId: externalAction!.installationId });
          if (seal && transportAuthorization && !hasPrivateBootstrap && !deploymentArchive) {
            const encodedKey = machineTarget.installationPublicKey;
            if (!moveChild && (machineTarget.installationId !== transportAuthorization.binding.installationId
              || transportAuthorization.binding.machineId !== machineId)) {
              throw new MachineRpcTargetNotCurrentError(machineId, 'root_target_mismatch');
            }
            if (!machineTarget.installationId || typeof encodedKey !== 'string') throw new MachineRpcTargetNotCurrentError(machineId, 'installation_key_unavailable');
            const publicKey = decodeBase64(encodedKey, 'base64');
            if (encodeBase64(publicKey, 'base64') !== encodedKey) throw new MachineRpcTargetNotCurrentError(machineId, 'installation_key_invalid');
            const sealed = await seal({ authorization: transportAuthorization,
              purpose: { kind: 'machine_rpc', method: params.method, params: request,
                ...(moveChild ? { recipient: { machineId, installationId: machineTarget.installationId } } : {}) }, installationPublicKey: publicKey });
            if (!sealed || !sealed.requesterAccountContext) throw new Error('Requester Account custody unavailable');
            transportAuthorization = sealed;
          }
          if (moveChild && !seal) throw new Error('Requester Account custody unavailable');
          const createExternalActionExecution = createExecution(transportAuthorization);
          return await callSocketRpc({
            socket,
            target: { kind: 'machine', id: machineId },
            method: params.method,
            params: request,
            content,
            requestId: deploymentChildRequestId ?? params.requestId ?? randomUUID(),
            timeoutMs: remainingTimeoutMs(),
            onIssued: () => { issued = true; },
            signal: attemptSignal,
            ...(params.waitForResultOnCancel ? { waitForResultOnCancel: true } : {}),
            authorization: params.authorization,
            ...(createExternalActionExecution ? { createExternalActionExecution } : {}),
            ...((params.method === RPC_METHODS.PROJECTS_OPEN || params.method === RPC_METHODS.DAEMON_PROJECTS_SCRIPT_RUN
              || params.method === RPC_METHODS.DAEMON_PROJECTS_COMPUTE_EXEC || moveChild) && externalAction?.context.originalActionEnvelope
              ? { originalActionEnvelope: externalAction.context.originalActionEnvelope } : {}),
          });
        },
      });
    });
    return await raceSocketIoAckTimeout(operation, timeoutMs ?? undefined, params.waitForResultOnCancel ? undefined : signal);
  } catch (error) {
    if (isSocketIoAckTimeoutError(error)) {
      throw markRpcRequestDisposition(Object.assign(new Error('Machine RPC call timeout'), { code: 'MACHINE_RPC_TIMEOUT' }), issued ? 'outcomeUnknown' : 'notSent');
    }
    throw readRpcRequestDisposition(error) === null ? markRpcRequestDisposition(error, 'notSent') : error;
  } finally {
    deadlineController.abort();
  }
}

/**
 * The machine this recorded id IS now, when the recorded one could not be
 * reached and only then.
 *
 * A replaced machine keeps its row and gains a forward pointer, and nothing
 * re-homes the Sessions, recent paths or RPC targets that named it — so the
 * recorded id stays the predecessor forever. Resolution reuses the one
 * replacement walk the UI target resolvers and the daemon-side entitlement gate
 * already share; a second walk would let this client address a successor the
 * daemon then refuses as foreign.
 *
 * `null` whenever nothing changes hands: no chain recorded, an unreadable chain,
 * or a canonical id equal to the one already tried. The caller's fallback is the
 * original error, so every failure here is inert.
 */
async function resolveSuccessorMachineId(params: Readonly<{
  credentials: StoredCredentials;
  machineId: string;
  serverUrl?: string;
}>): Promise<string | null> {
  const machines = await fetchAccountMachineReplacements({ credentials: params.credentials, serverUrl: params.serverUrl });
  if (!machines) return null;
  const canonicalMachineId = resolveCanonicalMachineId(params.machineId, machines)?.machineId ?? null;
  return canonicalMachineId && canonicalMachineId !== params.machineId.trim()
    ? canonicalMachineId
    : null;
}

/**
 * One account-scoped machine RPC, addressed to the machine the recorded id names
 * TODAY.
 *
 * A user who replaces a machine keeps the Sessions the previous one hosted, so a
 * CLI- or MCP-driven send or resume must not die with the predecessor. Resolving
 * the replacement chain is a no-op unless a replacement was actually recorded,
 * so it is paid on FAILURE rather than on every call: the recorded id is
 * addressed exactly as before, and only a machine the server could find no
 * target for is re-addressed — exactly once, and only when the chain names a
 * different machine. A reached machine, including one that answered with an
 * error, pays nothing and is never re-addressed; re-running an answered call
 * against a different machine would be a correctness bug, and an unknown outcome
 * could execute twice. When nothing changes hands the ORIGINAL error surfaces
 * unchanged, because the user's problem is the RPC and not the lookup.
 *
 * Private material delivery uses callExactMachineRpc directly: replacement
 * resolution is deliberately absent from that operation.
 */
export async function callMachineRpc(params: Parameters<typeof callExactMachineRpc>[0]): Promise<unknown> {
  try {
    return await callExactMachineRpc(params);
  } catch (error) {
    // Only "the server found no target for this machine" may be re-addressed:
    // it proves the request reached no machine at all.
    if (!isRpcMethodNotAvailableError(error)) throw error;
    // A captured handoff admission names two exact installations, not their successors.
    if (params.externalAction?.context.externalActionExecutionAuthorization?.binding.handoffAdmission) throw error;
    const successorMachineId = await resolveSuccessorMachineId({
      credentials: params.credentials,
      machineId: params.machineId,
      serverUrl: params.serverUrl,
    });
    if (!successorMachineId) throw error;
    return await callExactMachineRpc({ ...params, machineId: successorMachineId });
  }
}

type MachineRpcExternalAction = Readonly<{
  context: ActionExecutorContext;
  effectActionId: string;
  installationId: string;
  privateKey: ExternalActionMachineRequestSigningKey;
  deploymentArchiveOrigin?: DeploymentArchiveOriginForHost;
}>;
export type MachineRpcTargetNotCurrentReason =
  | 'requester_unavailable' | 'requester_credentials_mismatch' | 'requester_not_current'
  | 'child_not_derived' | 'machine_revoked_or_replaced' | 'installation_mismatch'
  | 'installation_key_unavailable' | 'installation_key_invalid' | 'root_target_mismatch'
  | 'archive_child_unavailable' | 'archive_origin_mismatch' | 'setup_manage_required'
  | 'private_target_mismatch';
