import { readSessionStopChildTargetV1 } from '@happier-dev/protocol/actions/sessionSections';
import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import { fetchAccountMachineReplacements } from '@/api/machine/fetchAccountMachineReplacements';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { logger } from '@/ui/logger';
import { readAccountEncryptionModeOnce } from '@/api/client/accountEncryptionMode';
import { AccessibleMachineAccessV1Schema } from '@happier-dev/protocol/machines/machineAccessV1';
import { assertMachineNotReportedOfflineV1 } from '@happier-dev/protocol/machines/machineReachabilityV1';
import {
  resolvePublishedMachineContentCodec,
  type ExpectedRunnerMachineContentKeyBindingScope,
} from '@/api/machine/machineDataEncryptionKey';
import type { StoredCredentials } from '@/persistence';
import { resolveSessionControlSocketConnectTimeoutMs } from '@/session/transport/shared/sessionTimeouts';
import type { SocketRpcAuthorizationContext } from '@happier-dev/protocol/socketRpc';
import { isRpcMethodNotAvailableError, RpcError } from '@happier-dev/protocol/rpcErrors';
import { resolveCanonicalMachineId } from '@happier-dev/protocol/machines/identity/canonicalMachineId';
import axios from '@/api/client/credentialAxios';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createUserScopedSocketConnection } from '@/api/session/sockets';
import { decodeBase64, encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { ACTION_OPERATION_RPC_METHODS_V1 } from '@happier-dev/protocol/actions/operations/v1';
import { SessionRequesterBootstrapRpcRequestV1Schema, sealSessionRequesterBootstrapRpcRequestV1,
  SessionRequesterHandoffBootstrapRpcRequestV1Schema, sealSessionRequesterHandoffBootstrapRpcRequestV1,
  SessionRequesterHandoffPreflightBootstrapRpcRequestV1Schema, sealSessionRequesterHandoffPreflightBootstrapRpcRequestV1,
  SessionRequesterHandoffWorkspaceCaptureRpcRequestV1Schema, sealSessionRequesterHandoffWorkspaceCaptureRpcRequestV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { SessionSpawnNewInputV2Schema, projectSessionSpawnNewActionInputV2 } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import { SessionSpawnNewResultV1Schema, SessionSpawnNewActionResultV1Schema, readSessionSpawnNewActionResultV1 } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { fetchAccountProfile } from '@/api/accountProfile';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions';
import { readHostReviewedChildOperationV1, readHostAdmittedReviewedChildV1 } from '@happier-dev/protocol/actions/actionExecutor';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { ActionIdSchema } from '@happier-dev/protocol/actions/actionIds';
import { TargetedActionRpcRequestV1Schema } from '@happier-dev/protocol/actions/actionRpcTransport';
import { projectNativeJsonValueForTransport } from '@happier-dev/protocol/json/strictJsonValue';
import { readDeploymentReferenceServiceListEnvironmentIdV1 } from '@happier-dev/protocol/actions/specs/deploymentPreparationScope';
import { createExternalActionHeaderRefusalError } from '@/api/externalActionHeaderRefusal';
import {
  createExternalActionAuthorizedRequestHeaders,
  resolveExternalActionRequesterServerRequestHeaders,
  resolveExternalActionServerRequestHeaders,
  createExternalActionMachineRpcExecution,
  createExternalActionSourceMachineRpcExecution,
  readExternalActionSourceMachineRpcSigner,
  isReviewedMachineRpcChild,
  isReviewedSessionActionCreationChild,
  dispatchOriginalAccountAction,
  readExternalActionRequesterInvocation,
  type ExternalActionMachineRequestSigningKey,
  type DeploymentArchiveOriginForHost,
  type DeploymentChildDerivationRefusal,
} from '@/api/externalActionExecutionAuthorization';
import { readReviewedMachineRpcChildFamilyV1 } from '@happier-dev/protocol/machines/peer/mediation/rpc/reviewedChildFamilyV1';
import {
  callSocketRpc,
  isSocketIoAckTimeoutError,
  raceSocketIoAckTimeout,
  markRpcRequestDisposition,
  readRpcRequestDisposition,
  type RpcRequestDisposition,
  type SocketRpcContent,
} from '@happier-dev/sync-client';
import {
  awaitUserScopedRpcConnect,
  readRpcObservation,
  runWithNotSentRpcDisposition,
  withUserScopedRpcSocket,
  type RpcObservationOptions,
} from './withUserScopedRpcSocket';
import { readRequesterAccountActionContext, readRequesterAccountActionTransportContext } from "@/daemon/sessionEncryption/requesterAccountActionContext";
import { reportRequesterMachineUse } from '@/api/machine/requesterMachineNotice';
import type { RpcHandlerContext } from '@/api/rpc/types';
import { createWorkspaceSyncSourceOperationContinuation } from '@/api/rpc/workspaceSyncOperationContinuation';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { readDeploymentChildRpcV1 } from '@happier-dev/protocol/deployments/deploymentChildRpcV1';
import { projectDeploymentChildRoutingV1 } from '@happier-dev/protocol/deployments/deploymentChildRoutingV1';
import { readDeploymentArchiveRpcEffectV1 } from '@happier-dev/protocol/deployments/deploymentArchiveRpcV1';
import { WorkspaceSyncSourceExecutionV1Schema, type WorkspaceSyncSourceExecutionV1 } from '@happier-dev/protocol/socketRpc';
import { assertDeploymentArchiveChildCurrentForHost } from '@/api/deploymentChildExecutionAuthorization';
import { readMachineIrohEndpointAuthorityV1 } from '@happier-dev/protocol/machines/operationProtocolCapabilitiesV1';

export function executionRunAuthorityCeiling(opts?: Pick<ActionExecutorContext, 'authority'>): Readonly<{
  authorityCeiling?: 'account_automation';
}> {
  return opts?.authority === 'account_automation' ? { authorityCeiling: 'account_automation' } : {};
}

export type MachineRpcRequestDisposition = RpcRequestDisposition;
export const readMachineRpcRequestDisposition = readRpcRequestDisposition;
const DEFAULT_MACHINE_RPC_TIMEOUT_MS = 20_000;

type SharedMachineRpcConnection = {
  readonly connection: ReturnType<typeof createUserScopedSocketConnection>;
  readonly connected: Promise<void>;
  readonly target: Promise<Awaited<ReturnType<typeof resolveMachineRpcContentCodec>>>;
  hasConnected: boolean;
};
const sharedMachineRpcTransportStorage = new AsyncLocalStorage<Map<string, SharedMachineRpcConnection>>();

async function destroySharedMachineRpcConnection(entry: SharedMachineRpcConnection): Promise<void> {
  try { await entry.connection.transport.destroy(); } catch { /* Preserve result. */ }
  try { entry.connection.socket.close(); } catch { /* Preserve result. */ }
}

function sharedCredentialsEncryptionDiscriminator(credentials: StoredCredentials): string {
  const encryption = credentials.encryption;
  const custody = 'accountE2eeCustody' in credentials ? credentials.accountE2eeCustody ?? null : null;
  if (!encryption) return JSON.stringify(['plain', custody]);
  if (encryption.type === 'legacy') {
    const secretDigest = createHash('sha256').update(encryption.secret).digest('hex');
    return JSON.stringify(['legacy', secretDigest, custody]);
  }
  const keyDigest = createHash('sha256')
    .update(encryption.publicKey)
    .update(encryption.machineKey)
    .digest('hex');
  return JSON.stringify(['dataKey', keyDigest, custody]);
}

/**
 * Reuses one user-scoped socket and resolved machine codec across sequential
 * RPCs within a single composite Action invocation (such as operation lookup +
 * terminal byte read in projects.execution.output.read), then closes it on exit.
 */
export async function withSharedMachineRpcTransport<R>(run: () => Promise<R>): Promise<R> {
  const existing = sharedMachineRpcTransportStorage.getStore();
  if (existing) return await run();
  const pool = new Map<string, SharedMachineRpcConnection>();
  try {
    return await sharedMachineRpcTransportStorage.run(pool, run);
  } finally {
    await Promise.all([...pool.values()].map(destroySharedMachineRpcConnection));
    pool.clear();
  }
}

type MachineRpcExternalAction = Readonly<{
  context: ActionExecutorContext;
  effectActionId: string;
  installationId: string;
  privateKey: ExternalActionMachineRequestSigningKey;
  deploymentArchiveOrigin?: DeploymentArchiveOriginForHost;
}>;

export class MachineRpcEncryptionModeMismatchError extends RpcError {
  readonly code = 'machine_content_mode_mismatch' as const;

  constructor(readonly machineId: string) {
    super(`Machine ${machineId} content mode does not match the verified caller's expectation`, 'machine_content_mode_mismatch');
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
}>): Promise<ActionExecuteResult | null> {
  const parsed = SessionSpawnNewInputV2Schema.safeParse(params.input);
  if (!parsed.success || parsed.data.executionTarget.serverId !== params.serverId) return null;
  const signal = params.context?.signal;
  const machineId = parsed.data.executionTarget.machineId;
  const root = params.context?.externalActionExecutionAuthorization;
  if (root?.binding.actionId === 'discussion.second_opinion.start') {
    const requester = readRequesterAccountActionContext(root);
    if (!params.context || !params.externalActionMachineInstallationId || !params.externalActionMachineRequestPrivateKey
      || !await isReviewedSessionActionCreationChild({ authorization: root, envelope: params.context.originalActionEnvelope,
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
  const target = await resolveMachineRpcContentCodec({ credentials: params.credentials, machineId, method: RPC_METHODS.SESSION_SPAWN_NEW,
    serverUrl: params.serverUrl, timeoutMs: DEFAULT_MACHINE_RPC_TIMEOUT_MS, requireCurrentMachine: true,
    requiredMachineKind: 'persistent', ...(signal ? { signal } : {}) });
  if (!target.access) return null;
  const profile = await runWithServerHttpBaseUrl(params.serverUrl,
    () => fetchAccountProfile({ token: params.credentials.token, projection: 'self', ...(signal ? { signal } : {}) }));
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
    input: projectSessionSpawnNewActionInputV2(parsed.data), target: { kind: 'machine', machineId }, serverHttpBaseUrl: params.serverUrl,
    serverIdentityId: params.serverIdentityId, requestId: params.context?.actionRequestId ?? randomUUID(),
    ...(params.context ? { invocation: readExternalActionRequesterInvocation(params.context) } : {}),
    ...(params.context?.authority ? { authority: params.context.authority } : {}),
    ...(signal ? { signal } : {}) });
  if (!execution.ok) return execution;
  const approval = ActionApprovalRequestCreatedResultSchema.safeParse(execution.result);
  if (approval.success) return { ...execution, result: approval.data };
  const output = SessionSpawnNewActionResultV1Schema.safeParse(execution.result);
  return output.success ? { ok: true, result: readSessionSpawnNewActionResultV1(output.data) }
    : { ok: false, errorCode: 'invalid_action_transport_output', error: 'invalid_action_transport_output' };
}

export type MachineRpcTargetNotCurrentReason =
  | 'requester_unavailable' | 'requester_credentials_mismatch' | 'requester_not_current'
  | 'child_not_derived' | 'machine_revoked_or_replaced' | 'installation_mismatch'
  | 'installation_key_unavailable' | 'installation_key_invalid' | 'root_target_mismatch'
  | 'archive_child_unavailable' | 'archive_origin_mismatch' | 'setup_manage_required'
  | 'private_target_mismatch';

export class MachineRpcTargetNotCurrentError extends RpcError {
  readonly code = 'machine_target_not_current' as const;

  constructor(readonly machineId: string, readonly reason: MachineRpcTargetNotCurrentReason,
    readonly derivationReason?: DeploymentChildDerivationRefusal) {
    super(`Machine ${machineId} RPC target refused: ${reason}${derivationReason ? `/${derivationReason}` : ''}`, 'machine_target_not_current');
    this.name = 'MachineRpcTargetNotCurrentError';
  }
}

export class MachineRpcMachineKindMismatchError extends RpcError {
  readonly code = 'machine_kind_mismatch' as const;

  constructor(
    readonly machineId: string,
    readonly expectedKind: 'persistent' | 'ephemeral_session_runner',
  ) {
    super(`Machine ${machineId} is not a ${expectedKind}`, 'machine_kind_mismatch');
    this.name = 'MachineRpcMachineKindMismatchError';
  }
}

/** The calling Session host's installation, when this context names it. */
function readSessionHostSigner(externalAction: NonNullable<Parameters<typeof callExactMachineRpc>[0]['externalAction']>) {
  const machineId = externalAction.context.defaultSessionMachineId;
  return machineId ? { machineId, installationId: externalAction.installationId } : undefined;
}

function isOriginalRequesterSource(externalAction: NonNullable<Parameters<typeof callExactMachineRpc>[0]['externalAction']>): boolean {
  const authorization = externalAction.context.externalActionExecutionAuthorization;
  const source = authorization ? readExternalActionSourceMachineRpcSigner(authorization, readSessionHostSigner(externalAction)) : null;
  return Boolean(source
    && (externalAction.context.defaultSessionMachineId === undefined
      || externalAction.context.defaultSessionMachineId === source.machineId)
    && externalAction.installationId === source.installationId);
}

async function resolveMachineRpcContentCodec(params: Readonly<{
  credentials: StoredCredentials;
  method: string;
  machineId: string;
  serverUrl?: string;
  timeoutMs: number;
  signal?: AbortSignal;
  expectedRunnerMachineContentKeyBinding?: ExpectedRunnerMachineContentKeyBindingScope;
  requireCurrentMachine?: boolean;
  requiredMachineKind?: 'persistent' | 'ephemeral_session_runner';
  deploymentSetupExecution?: WorkspaceSyncSourceExecutionV1;
  deploymentArchiveExecution?: WorkspaceSyncSourceExecutionV1;
  expectedInstallationId?: string;
  externalAction?: MachineRpcExternalAction;
}>) {
  const path = `/v1/machines/${encodeURIComponent(params.machineId)}`;
  const externalAuthorization = params.externalAction?.context.externalActionExecutionAuthorization;
  const externalTarget = params.externalAction?.context.externalActionTarget;
  const referenceServiceList = params.method === RPC_METHODS.MACHINES_SERVICE_LIST
    && readDeploymentReferenceServiceListEnvironmentIdV1(externalAuthorization?.binding, params.externalAction?.effectActionId,
      readHostAdmittedReviewedChildV1(params.externalAction?.context) ?? undefined);
  const childFamily = params.externalAction ? readReviewedMachineRpcChildFamilyV1({ binding: externalAuthorization?.binding,
    effectActionId: params.externalAction.effectActionId, method: params.method,
    target: { machineId: params.machineId, installationId: params.externalAction.installationId },
    reviewedChild: readHostAdmittedReviewedChildV1(params.externalAction.context) ?? undefined }) : null;
  // A Backup receiver read spends its reviewed child's own requester projection
  // (Home admits it by that proof); other cross-Machine families read under the signed root carrier.
  const moveChildRead = childFamily !== null && childFamily !== 'backup_receiver_setup';
  if (params.externalAction && (!externalAuthorization || !externalTarget)) {
    throw new Error('External Action Machine HTTP authorization is unavailable');
  }
  // Only the already-verified finite archive branch may use its original
  // requester's private codec custody. Socket authentication stays receiver-owned.
  const contentCredentials = params.deploymentArchiveExecution
    ? readRequesterAccountActionContext(externalAuthorization)?.credentials
    : params.credentials;
  if (!contentCredentials) throw new MachineRpcTargetNotCurrentError(params.machineId, 'requester_unavailable');
  const referenceHeaders = referenceServiceList && params.externalAction
    ? await resolveExternalActionRequesterServerRequestHeaders({ context: params.externalAction.context,
      effectActionId: params.externalAction.effectActionId,
      serverHttpBaseUrl: params.serverUrl ?? resolveServerHttpBaseUrl(), method: 'GET', path }) : undefined;
  if (referenceServiceList && !referenceHeaders) throw new MachineRpcTargetNotCurrentError(params.machineId, 'requester_unavailable');
  const requesterProjection = !referenceServiceList && params.externalAction && externalAuthorization && externalTarget
    && !params.deploymentArchiveExecution && !params.deploymentSetupExecution
    ? resolveExternalActionServerRequestHeaders({
        context: params.externalAction.context,
        effectActionId: params.externalAction.effectActionId,
        daemonToken: params.credentials.token,
        serverIdentityId: externalAuthorization.binding.serverIdentityId,
        installationId: isOriginalRequesterSource(params.externalAction)
          ? externalAuthorization.binding.installationId : params.externalAction.installationId,
        privateKey: params.externalAction.privateKey,
        method: 'GET', path,
      }) : undefined;
  // The requester owner selects native Account transport for admitted Template
  // children. Other finite children keep their existing codec-custody read.
  const requesterHeaders = !moveChildRead || requesterProjection?.ok && requesterProjection.machineRpcAuthorization === 'account'
    ? requesterProjection : undefined;
  if (requesterHeaders && !requesterHeaders.ok) {
    throw createExternalActionHeaderRefusalError(requesterHeaders);
  }
  const headers = {
        ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
        ...(referenceHeaders || (requesterHeaders?.ok ? requesterHeaders.headers
          : params.externalAction && externalAuthorization && externalTarget && (!moveChildRead || params.deploymentArchiveExecution || params.deploymentSetupExecution)
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
          : { Authorization: `Bearer ${params.credentials.token}` })),
      };
  const response = await axios.get(
    `${params.serverUrl ?? resolveServerHttpBaseUrl()}${path}`,
    {
      headers,
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
        operationProtocolCapabilities?: unknown;
        operationProtocolCapabilitiesRevision?: unknown;
        dataEncryptionKey?: unknown;
        storageMode?: 'plain' | 'e2ee';
        access?: unknown;
        active?: unknown;
        presenceProtocolVersion?: unknown;
        runnerContentKeyBinding?: unknown;
        revokedAt?: unknown;
        replacedByMachineId?: unknown;
      }
    | null
    | undefined;
  if (!raw || String(raw.id ?? '').trim() !== params.machineId) {
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
  // Setup on a Machine is Manage work, for each Setup family the owner names.
  if ((childFamily === 'setup_plan' || childFamily === 'backup_receiver_setup') && access?.role !== 'manage') {
    throw new MachineRpcTargetNotCurrentError(params.machineId, 'setup_manage_required');
  }
  if (access && access.accessState !== 'ready') throw new MachineRpcEncryptionModeMismatchError(params.machineId);
  // The exact lookup already carries Home's presence decision. Keep predecessor
  // and legacy routing unchanged when it cannot answer for the current Machine.
  if (params.method === RPC_METHODS.SCM_WORK_EVIDENCE_READ) assertMachineNotReportedOfflineV1(raw);
  if (params.expectedInstallationId && raw?.installationId !== params.expectedInstallationId) {
    throw new MachineRpcTargetNotCurrentError(params.machineId, 'installation_mismatch');
  }
  let expectedAccountMode: 'plain' | 'e2ee' | 'unknown' = access?.resourceMode ?? raw?.storageMode ?? 'unknown';
  if (expectedAccountMode === 'unknown' && !params.deploymentArchiveExecution && !params.deploymentSetupExecution) {
    const mode = await readAccountEncryptionModeOnce({ credentials: params.credentials, request: () => axios.get(
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
    installationPublicKey: raw?.installationPublicKey,
    machineRpcAuthorization: requesterHeaders?.ok ? requesterHeaders.machineRpcAuthorization : undefined,
    endpoint: readMachineIrohEndpointAuthorityV1({ capabilities: raw?.operationProtocolCapabilities,
      revision: raw?.operationProtocolCapabilitiesRevision }) };
}

/** The same proof-scoped exact Machine read attests archive origin before any
 * local reuse or finite dial. It never opens a socket or grants filesystem work. */
export async function verifyDeploymentArchiveOriginForHost(input: Readonly<{
  credentials: StoredCredentials; machineId: string; serverUrl?: string; signal?: AbortSignal;
  expectedInstallationId?: string;
  externalAction: MachineRpcExternalAction & Readonly<{ deploymentArchiveOrigin: DeploymentArchiveOriginForHost }>;
}>) {
  const job = readRequesterAccountActionContext(input.externalAction.context.externalActionExecutionAuthorization)?.deploymentChild;
  if (!job) throw new MachineRpcTargetNotCurrentError(input.machineId, 'archive_child_unavailable');
  const admitted = await assertDeploymentArchiveChildCurrentForHost({ context: input.externalAction.context,
    machineId: job.machineId,
    installationId: input.externalAction.installationId });
  const origin = input.externalAction.deploymentArchiveOrigin;
  const expectedInstallationId = input.machineId === origin.holderMachineId ? origin.holderInstallationId
    : input.machineId === admitted.job.machineId ? admitted.job.installationId : null;
  if (!expectedInstallationId || input.expectedInstallationId && input.expectedInstallationId !== expectedInstallationId) {
    throw new MachineRpcTargetNotCurrentError(input.machineId, 'archive_origin_mismatch');
  }
  const target = await resolveMachineRpcContentCodec({ ...input, timeoutMs: DEFAULT_MACHINE_RPC_TIMEOUT_MS,
    requireCurrentMachine: true, requiredMachineKind: 'persistent', expectedInstallationId,
    deploymentArchiveExecution: admitted.execution });
  await assertDeploymentArchiveChildCurrentForHost({ context: input.externalAction.context,
    machineId: admitted.job.machineId, installationId: input.externalAction.installationId });
  return { installationId: expectedInstallationId, endpoint: target.endpoint };
}

/** Home consumes the same signed child job whether its executor is local or reached by RPC. */
export async function buildDeploymentChildMachineReadProof(input: Readonly<{
  child: import('@happier-dev/protocol').DeploymentChildRpcV1;
  originalActionEnvelope: unknown;
  requestId?: string;
  sign: NonNullable<Parameters<typeof callSocketRpc>[0]['createExternalActionExecution']>;
}>): Promise<WorkspaceSyncSourceExecutionV1> {
  const method = `${input.child.machineId}:${RPC_METHODS.DAEMON_DEPLOYMENT_CHILD}`;
  const requestId = input.requestId ?? randomUUID();
  return WorkspaceSyncSourceExecutionV1Schema.parse({ method, requestId, params: input.child,
    originalActionEnvelope: input.originalActionEnvelope,
    externalActionExecution: await input.sign({ method, requestId, params: input.child }) });
}

/** One exact account-scoped machine RPC; retry and target selection stay caller-owned. */
export async function callExactMachineRpc(params: Readonly<{
  credentials: StoredCredentials;
  operationContext?: RpcHandlerContext['localActionContext'];
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
  const removalContinuation = !!params.operationContext && params.method === RPC_METHODS.DAEMON_WORKSPACE_SYNC_COMMITTED_COPY_REMOVE;
  const waitForResultOnCancel = params.waitForResultOnCancel || removalContinuation;
  const deadlineController = new AbortController();
  const signal = params.signal ? AbortSignal.any([params.signal, deadlineController.signal]) : deadlineController.signal;
  try {
    signal.throwIfAborted();
    const machineId = params.machineId.trim();
    if (!machineId) throw new Error('Machine id is required');
    const moveAuthorization = params.externalAction?.context.externalActionExecutionAuthorization;
    const reviewedChild = readHostAdmittedReviewedChildV1(params.externalAction?.context) ?? undefined;
    // The one owner decides whether this reviewed child may reach another Machine.
    const childFamily = params.externalAction ? readReviewedMachineRpcChildFamilyV1({ binding: moveAuthorization?.binding,
      effectActionId: params.externalAction.effectActionId, method: params.method,
      target: { machineId, installationId: params.externalAction.installationId }, reviewedChild }) : null;
    const stopChild = childFamily === 'stop';
    const stopChildTarget = stopChild ? readSessionStopChildTargetV1(params.request) : null;
    const setupPlanChild = childFamily === 'setup_plan';
    const referenceServiceList = params.method === RPC_METHODS.MACHINES_SERVICE_LIST
      && readDeploymentReferenceServiceListEnvironmentIdV1(moveAuthorization?.binding, params.externalAction?.effectActionId, reviewedChild);
    const referenceExecution = referenceServiceList ? readRequesterAccountActionContext(moveAuthorization)?.deploymentChildExecution : undefined;
    const creationChild = childFamily === 'creation';
    const readinessChild = childFamily === 'readiness';
    const deploymentChild = moveAuthorization && params.externalAction ? readDeploymentChildRpcV1({ deploymentChildRoot: moveAuthorization.binding.deploymentChildRoot,
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
    if (moveAuthorization && (moveAuthorization.binding.deploymentChildRoot === true)
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
    const moveChild = childFamily !== null;
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
        const sourceMachineId = authorization
          ? readExternalActionSourceMachineRpcSigner(authorization, readSessionHostSigner(externalAction))?.machineId : undefined;
        const execution = !deploymentArchive && !referenceServiceList && isOriginalRequesterSource(externalAction) && authorization && target && sourceMachineId
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
          ...(referenceExecution ? { deploymentChildExecution: referenceExecution } : {}),
          ...request,
          privateKey: externalAction.privateKey,
        });
        if (!execution) throw new Error('External Action Machine RPC authorization is unavailable');
        return execution;
      } : undefined;
    let deploymentChildRequestId: string | undefined;
    let deploymentSetupExecution: WorkspaceSyncSourceExecutionV1 | undefined;
    if (deploymentChild) {
      // The final encrypted RPC is separately signed with the same request id.
      const sign = createExecution();
      if (!sign) throw new Error('External Action Machine RPC authorization is unavailable');
      deploymentSetupExecution = await buildDeploymentChildMachineReadProof({ child: deploymentChild,
        originalActionEnvelope: externalAction?.context.originalActionEnvelope,
        ...(params.requestId === undefined ? {} : { requestId: params.requestId }), sign });
      deploymentChildRequestId = deploymentSetupExecution.requestId;
    }
    const sharedPool = sharedMachineRpcTransportStorage.getStore();
    const canReuseShared = Boolean(
      sharedPool
      && !params.externalAction
      && !params.reattachOnReconnect
      && !params.authorization
      && !params.prepareRequest
      && !params.requireCurrentMachine
      && !params.requiredMachineKind
      && !params.expectedRunnerMachineContentKeyBinding
      && !params.operationContext,
    );
    const effectiveServerUrl = canReuseShared ? (params.serverUrl ?? resolveServerHttpBaseUrl()) : params.serverUrl;
    const sharedKey = canReuseShared
      ? JSON.stringify([
          params.credentials.token,
          sharedCredentialsEncryptionDiscriminator(params.credentials),
          params.authorityCeiling ?? null,
          effectiveServerUrl,
          machineId,
        ])
      : null;
    const runWithSocket = <R>(
      runner: (
        socket: ReturnType<typeof createUserScopedSocketConnection>['socket'],
        connect: () => Promise<void>,
        attemptSignal?: AbortSignal,
        reusedTarget?: Promise<Awaited<ReturnType<typeof resolveMachineRpcContentCodec>>>,
      ) => Promise<R>,
    ): Promise<R> => {
      if (sharedPool && sharedKey) {
        let entry = sharedPool.get(sharedKey);
        if (entry && entry.hasConnected && !entry.connection.socket.connected) {
          sharedPool.delete(sharedKey);
          void destroySharedMachineRpcConnection(entry);
          entry = undefined;
        }
        if (!entry) {
          const connection = createUserScopedSocketConnection({
            token: params.credentials.token,
            ...(params.authorityCeiling ? { authorityCeiling: params.authorityCeiling } : {}),
            ...(effectiveServerUrl ? { serverUrl: effectiveServerUrl } : {}),
            connectTimeoutMs,
            clientPurpose: 'scoped-rpc',
          });
          let created!: SharedMachineRpcConnection;
          const evictIfCurrent = () => {
            if (sharedPool.get(sharedKey) === created) {
              sharedPool.delete(sharedKey);
              void destroySharedMachineRpcConnection(created);
            }
          };
          const connected = connection.transport.connect().then(
            () => { created.hasConnected = true; },
            (error) => {
              evictIfCurrent();
              throw error;
            },
          );
          void connected.catch(() => {});
          const target = resolveMachineRpcContentCodec({
            credentials: params.credentials,
            method: params.method,
            machineId,
            serverUrl: effectiveServerUrl,
            timeoutMs: remainingTimeoutMs() ?? setupTimeoutMs,
            ...(signal ? { signal } : {}),
          }).catch((error) => {
            evictIfCurrent();
            throw error;
          });
          void target.catch(() => {});
          created = { connection, connected, target, hasConnected: false };
          entry = created;
          sharedPool.set(sharedKey, entry);
        }
        const active = entry;
        return runWithNotSentRpcDisposition(() => runner(
          active.connection.socket,
          () => awaitUserScopedRpcConnect(active.connected, signal),
          signal,
          active.target,
        ));
      }
      return withUserScopedRpcSocket({
        token: params.credentials.token,
        ...(params.authorityCeiling ? { authorityCeiling: params.authorityCeiling } : {}),
        ...(params.serverUrl ? { serverUrl: params.serverUrl } : {}),
        connectTimeoutMs,
        signal,
        ...(params.reattachOnReconnect ? { reattachOnReconnect: true } : {}),
      }, (socket, connect, attemptSignal) => runner(socket, connect, attemptSignal));
    };
    const operation = runWithSocket(async (socket, connect, attemptSignal, reusedTarget) => {
      const machineTarget = reusedTarget ? await reusedTarget : await resolveMachineRpcContentCodec({
        credentials: params.credentials,
        method: params.method,
        machineId,
        serverUrl: params.serverUrl,
        timeoutMs: remainingTimeoutMs() ?? setupTimeoutMs,
        ...(params.expectedRunnerMachineContentKeyBinding ? { expectedRunnerMachineContentKeyBinding: params.expectedRunnerMachineContentKeyBinding } : {}),
        ...(params.requireCurrentMachine ? { requireCurrentMachine: true } : {}),
        ...(params.requiredMachineKind ? { requiredMachineKind: params.requiredMachineKind } : {}),
        ...(params.externalAction ? { externalAction: params.externalAction } : {}),
        ...(deploymentSetupExecution ? { deploymentSetupExecution } : {}),
        ...(deploymentArchive ? { deploymentArchiveExecution: deploymentArchive.execution } : {}),
        ...(archiveInstallationId ? { expectedInstallationId: archiveInstallationId } : {}),
        ...(attemptSignal ? { signal: attemptSignal } : {}),
      });
      const accountRpc = machineTarget.machineRpcAuthorization === 'account';
      const reviewedMove = !accountRpc && moveChild && params.externalAction && moveAuthorization;
      const requester = reviewedMove ? readRequesterAccountActionTransportContext(reviewedMove) : null;
      if (reviewedMove && params.externalAction) {
        if (childFamily === 'service_move') {
          const { readProjectServiceMoveReviewedStopInput } = await import('@/daemon/local/services/actions/projectServiceMoveChildren');
          const child = ActionIdSchema.safeParse(params.externalAction.effectActionId);
          const wrapper = TargetedActionRpcRequestV1Schema.safeParse(params.request);
          // Execution stamps Stop's derived confirmation nonce after review; the receiver
          // compares the reviewed operand through the same projection.
          const normalized = child.success ? getActionSpec(child.data).inputSchema.safeParse(
            readProjectServiceMoveReviewedStopInput(wrapper.success ? wrapper.data.input : params.request)) : null;
          if (!child.success || !normalized?.success || !readHostReviewedChildOperationV1(params.externalAction.context,
            child.data, projectNativeJsonValueForTransport(normalized.data))) throw new MachineRpcTargetNotCurrentError(machineId, 'child_not_derived');
        }
        if (!requester) throw new MachineRpcTargetNotCurrentError(machineId, 'requester_unavailable');
        if (requester.credentials.token !== params.credentials.token) throw new MachineRpcTargetNotCurrentError(machineId, 'requester_credentials_mismatch');
        if (!await requester.isCurrent()) throw new MachineRpcTargetNotCurrentError(machineId, 'requester_not_current');
        let derivationReason: DeploymentChildDerivationRefusal | undefined;
        if (!childFamily || !await isReviewedMachineRpcChild(childFamily, { authorization: reviewedMove,
          envelope: params.externalAction.context.originalActionEnvelope, signal,
          actionId: params.externalAction.effectActionId, machineId, params: params.request, method: params.method,
          target: stopChildTarget, reviewedChild, onRefused: reason => { derivationReason = reason; } })) {
          throw new MachineRpcTargetNotCurrentError(machineId, 'child_not_derived', derivationReason);
        }
      }
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
          || request.kind === 'requester_session_handoff_preflight_bootstrap_v1'
          || request.kind === 'requester_session_handoff_workspace_capture_v1')) {
        const privateRequest = request.kind === 'requester_session_bootstrap_v1'
          ? SessionRequesterBootstrapRpcRequestV1Schema.parse(request) : request.kind === 'requester_session_handoff_bootstrap_v1'
            ? SessionRequesterHandoffBootstrapRpcRequestV1Schema.parse(request)
            : request.kind === 'requester_session_handoff_workspace_capture_v1'
              ? SessionRequesterHandoffWorkspaceCaptureRpcRequestV1Schema.parse(request)
              : SessionRequesterHandoffPreflightBootstrapRpcRequestV1Schema.parse(request);
        const expectedMethod = privateRequest.kind === 'requester_session_bootstrap_v1'
          ? (privateRequest.scope === 'workflow_trigger' ? RPC_METHODS.DAEMON_WORKFLOW_REQUESTER_CUSTODY : RPC_METHODS.SESSION_SPAWN_NEW)
          : privateRequest.kind === 'requester_session_handoff_bootstrap_v1'
            ? RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_V3
            : privateRequest.kind === 'requester_session_handoff_workspace_capture_v1'
              ? RPC_METHODS.DAEMON_SESSION_HANDOFF_WORKSPACE_CAPTURE_V3 : RPC_METHODS.DAEMON_SESSION_HANDOFF_EXISTING_STATE_CHECK_V3;
        const targetMachineId = privateRequest.kind === 'requester_session_bootstrap_v1'
          ? privateRequest.input.executionTarget.machineId : privateRequest.input.targetMachineId;
        if (params.method !== expectedMethod || targetMachineId !== machineId) throw new MachineRpcTargetNotCurrentError(machineId, 'private_target_mismatch');
        const bootstrap = privateRequest.requesterBootstrap;
        if (expectedMethod === RPC_METHODS.DAEMON_WORKFLOW_REQUESTER_CUSTODY && !('kind' in bootstrap)) {
          throw new MachineRpcTargetNotCurrentError(machineId, 'private_target_mismatch');
        }
        if ('kind' in bootstrap) {
          if (bootstrap.installationId !== machineTarget.installationId) throw new MachineRpcTargetNotCurrentError(machineId, 'installation_mismatch');
        } else if (privateRequest.kind === 'requester_session_handoff_preflight_bootstrap_v1'
          || privateRequest.kind === 'requester_session_handoff_workspace_capture_v1'
          || machineCodec.mode === 'plain' && bootstrap.credentials.encryption) {
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
              : privateRequest.kind === 'requester_session_handoff_workspace_capture_v1'
                ? sealSessionRequesterHandoffWorkspaceCaptureRpcRequestV1({ ...sealing, request: { ...privateRequest, requesterBootstrap: bootstrap } })
                : sealSessionRequesterHandoffPreflightBootstrapRpcRequestV1({ ...sealing, request: { ...privateRequest, requesterBootstrap: bootstrap } });
        }
      }
      await connect();
      const content: SocketRpcContent = machineCodec.mode === 'plain' ? { mode: 'plain' } : {
        mode: 'e2ee',
        responseContentVersion: 1,
        cipher: {
          encryptRaw: async (value) => machineCodec.encodeRpc(value),
          decryptRaw: async (ciphertext) => machineCodec.decodeRpc(ciphertext),
        },
      };
      return await readRpcObservation({ request, signal: attemptSignal,
        observation: params.reattachOnReconnect === true ? undefined : params.reattachOnReconnect,
        read: async request => {
          // The existing requester projection owns Account-vs-root transport.
          // An admitted Account template child uses native Account admission;
          // its controller root cannot be resealed as destination authority.
          let transportAuthorization = accountRpc ? undefined : externalAction?.context.externalActionExecutionAuthorization;
          if (referenceServiceList && transportAuthorization?.requesterAccountContext) {
            const { requesterAccountContext: _privateCustody, ...carrier } = transportAuthorization;
            transportAuthorization = carrier;
          }
          const seal = transportAuthorization?.requesterAccountProjection?.sealRequesterAccountContext;
          const hasPrivateBootstrap = request && typeof request === 'object'
            && (Reflect.get(request, 'kind') === 'requester_session_bootstrap_v1'
              || Reflect.get(request, 'kind') === 'requester_session_handoff_bootstrap_v1'
              || Reflect.get(request, 'kind') === 'requester_session_handoff_preflight_bootstrap_v1'
              || Reflect.get(request, 'kind') === 'requester_session_handoff_workspace_capture_v1');
          if (deploymentArchive) await assertDeploymentArchiveChildCurrentForHost({ context: externalAction!.context,
            machineId: deploymentArchive.job.machineId, installationId: externalAction!.installationId });
          let foreignCustodian = false;
          if (seal && transportAuthorization && !hasPrivateBootstrap && !deploymentArchive && !referenceServiceList) {
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
                ...((creationChild || childFamily === 'backup_receiver_setup' || childFamily === 'session_project_files_source') && reviewedChild ? { reviewedChild } : {}),
                ...(moveChild && !readinessChild ? { recipient: { machineId, installationId: machineTarget.installationId } } : {}) }, installationPublicKey: publicKey });
            if (!sealed || !sealed.requesterAccountContext) throw new Error('Requester Account custody unavailable');
            const custodian = machineTarget.access?.custodian;
            foreignCustodian = Boolean(requester && custodian && custodian.accountId !== sealed.binding.accountId);
            transportAuthorization = sealed;
          }
          if (!accountRpc && moveChild && !seal) throw new Error('Requester Account custody unavailable');
          const createExternalActionExecution = accountRpc ? undefined : createExecution(transportAuthorization);
          return await callSocketRpc({
            socket,
            target: { kind: 'machine', id: machineId },
            method: params.method,
            params: request,
            content,
            ...(params.operationContext && removalContinuation
              ? { onContinuation: createWorkspaceSyncSourceOperationContinuation(params.operationContext), waitForResultOnCancel: true } : {}),
            requestId: deploymentChildRequestId ?? params.requestId ?? randomUUID(),
            timeoutMs: remainingTimeoutMs(),
            onIssued: () => {
              issued = true;
              if (foreignCustodian && requester) reportRequesterMachineUse({ credentials: requester.credentials,
                serverBaseUrl: requester.serverHttpBaseUrl, machineId, surface: 'agent' });
            },
            signal: attemptSignal,
            ...(waitForResultOnCancel ? { waitForResultOnCancel: true } : {}),
            authorization: params.authorization,
            ...(createExternalActionExecution ? { createExternalActionExecution } : {}),
            ...(!accountRpc && (params.method === RPC_METHODS.PROJECTS_OPEN || params.method === RPC_METHODS.DAEMON_PROJECTS_SCRIPT_RUN
              || params.method === RPC_METHODS.DAEMON_PROJECTS_COMPUTE_EXEC || moveChild
              || (params.method === ACTION_OPERATION_RPC_METHODS_V1.cancel
                && transportAuthorization?.binding.actionId === 'action.operations.cancel')) && externalAction?.context.originalActionEnvelope
              ? { originalActionEnvelope: externalAction.context.originalActionEnvelope } : {}),
          });
        },
      });
    });
    return await raceSocketIoAckTimeout(operation, timeoutMs ?? undefined, waitForResultOnCancel ? undefined : signal);
  } catch (error) {
    if (error instanceof MachineRpcTargetNotCurrentError) logger.debug('[MachineRPC] exact target refused', {
      code: error.code, reason: error.reason, machineId: error.machineId, method: params.method,
      ...(error.derivationReason ? { derivationReason: error.derivationReason } : {}),
      operationId: params.externalAction?.context.operationAcceptance?.operationId,
    });
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
