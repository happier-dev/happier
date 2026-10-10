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
import { encodeStoredCredentials } from '@/persistence';
import { fetchAccountProfile } from '@/api/accountProfile';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions';
import {
  createExternalActionAuthorizedRequestHeaders,
  createExternalActionMachineRpcExecution,
  createExternalActionSourceMachineRpcExecution,
  readExternalActionSourceMachineRpcSigner,
  type ExternalActionMachineRequestSigningKey,
} from '@/api/externalActionExecutionAuthorization';
import {
  callSocketRpc,
  isSocketIoAckTimeoutError,
  markRpcRequestDisposition,
  readRpcRequestDisposition,
  type RpcRequestDisposition,
  type SocketRpcContent,
} from '@happier-dev/sync-client';
import { readRpcObservation, withUserScopedRpcSocket, type RpcObservationOptions } from './withUserScopedRpcSocket';

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
  credentials: StoredCredentials; input: unknown; serverId: string; serverUrl: string;
  context?: ActionExecutorContext;
  onRequesterSessionCredentialDisclosure?: (disclosure: ReturnType<typeof projectRequesterSessionCredentialDisclosure>) => boolean | void | Promise<boolean | void>;
}>): Promise<ActionExecuteResult | null> {
  const parsed = SessionSpawnNewInputV2Schema.safeParse(params.input);
  if (!parsed.success || parsed.data.executionTarget.serverId !== params.serverId) return null;
  const signal = params.context?.signal;
  const machineId = parsed.data.executionTarget.machineId;
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
  const mode = await readAccountEncryptionModeOnce({ request: () => axios.get(`${params.serverUrl}/v1/account/encryption`, {
    headers: { Authorization: `Bearer ${params.credentials.token}` }, ...(signal ? { signal } : {}),
  }) });
  if (mode.kind !== 'resolved' || mode.mode === 'e2ee' && !params.credentials.encryption) {
    return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
  }
  const credentials = mode.mode === 'plain' ? { ...params.credentials, encryption: null } : params.credentials;
  if (!params.onRequesterSessionCredentialDisclosure) {
    return { ok: false, errorCode: 'target_unavailable', error: 'requester_credential_disclosure_required' };
  }
  const confirmed = await params.onRequesterSessionCredentialDisclosure(projectRequesterSessionCredentialDisclosure({
    disposition: 'ordinary_requester', accountId: profile.id, machineId,
  }));
  if (confirmed !== true || signal?.aborted) return { ok: false, errorCode: 'cancelled', error: 'cancelled' };
  const result = await callExactMachineRpc({ credentials: params.credentials, machineId, serverUrl: params.serverUrl,
    method: RPC_METHODS.SESSION_SPAWN_NEW, request: { kind: 'requester_session_bootstrap_v1', input: parsed.data,
      requesterBootstrap: { v: 1, disposition: 'ordinary_requester', credentials: encodeStoredCredentials(credentials) } },
    requireCurrentMachine: true, requiredMachineKind: 'persistent',
    ...(params.context?.actionRequestId ? { requestId: params.context.actionRequestId } : {}),
    ...(signal ? { signal } : {}) });
  if (result && typeof result === 'object' && 'ok' in result && result.ok === false
    && 'errorCode' in result && typeof result.errorCode === 'string') {
    return { ok: false, errorCode: result.errorCode, error: result.errorCode };
  }
  const output = SessionSpawnNewResultV1Schema.safeParse(result);
  return output.success ? { ok: true, result: output.data }
    : { ok: false, errorCode: 'invalid_action_transport_output', error: 'invalid_action_transport_output' };
}

export class MachineRpcTargetNotCurrentError extends Error {
  readonly code = 'machine_target_not_current' as const;

  constructor(readonly machineId: string) {
    super(`Machine ${machineId} is revoked or has been replaced`);
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
  externalAction?: Readonly<{
    context: ActionExecutorContext;
    effectActionId: string;
    installationId: string;
    privateKey: ExternalActionMachineRequestSigningKey;
  }>;
}>) {
  const path = `/v1/machines/${encodeURIComponent(params.machineId)}`;
  const externalAuthorization = params.externalAction?.context.externalActionExecutionAuthorization;
  const externalTarget = params.externalAction?.context.externalActionTarget;
  if (params.externalAction && (!externalAuthorization || !externalTarget)) {
    throw new Error('External Action Machine HTTP authorization is unavailable');
  }
  const response = await axios.get(
    `${params.serverUrl ?? resolveServerHttpBaseUrl()}${path}`,
    {
      headers: {
        ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
        ...(params.externalAction && externalAuthorization && externalTarget
          ? createExternalActionAuthorizedRequestHeaders({
              authorization: externalAuthorization,
              effectActionId: params.externalAction.effectActionId,
              target: externalTarget,
              installationId: isOriginalRequesterSource(params.externalAction)
                ? externalAuthorization.binding.installationId : params.externalAction.installationId,
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
    throw new MachineRpcTargetNotCurrentError(params.machineId);
  }
  const actualMachineKind = raw?.kind ?? 'persistent';
  if (params.requiredMachineKind && actualMachineKind !== params.requiredMachineKind) {
    throw new MachineRpcMachineKindMismatchError(params.machineId, params.requiredMachineKind);
  }
  const access = raw?.access === undefined ? undefined : AccessibleMachineAccessV1Schema.parse(raw.access);
  if (access && access.accessState !== 'ready') throw new MachineRpcEncryptionModeMismatchError(params.machineId);
  let expectedAccountMode: 'plain' | 'e2ee' | 'unknown' = access?.resourceMode ?? raw?.storageMode ?? 'unknown';
  if (expectedAccountMode === 'unknown') {
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
    credentials: params.credentials,
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
  request: unknown;
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
  /** Only read-only observations may be repeated after transport reconnect. */
  reattachOnReconnect?: true | RpcObservationOptions;
  signal?: AbortSignal;
  externalAction?: Readonly<{
    context: ActionExecutorContext;
    effectActionId: string;
    installationId: string;
    privateKey: ExternalActionMachineRequestSigningKey;
  }>;
}>): Promise<unknown> {
  try {
    params.signal?.throwIfAborted();
    const machineId = params.machineId.trim();
    if (!machineId) throw new Error('Machine id is required');
    const timeoutMs = params.timeoutMs === null ? null
      : typeof params.timeoutMs === 'number' && params.timeoutMs > 0 ? params.timeoutMs : DEFAULT_MACHINE_RPC_TIMEOUT_MS;
    const setupTimeoutMs = timeoutMs ?? DEFAULT_MACHINE_RPC_TIMEOUT_MS;
    const connectTimeoutMs = typeof params.timeoutMs === 'number' && params.timeoutMs > 0
      ? setupTimeoutMs : resolveSessionControlSocketConnectTimeoutMs();
    return await withUserScopedRpcSocket({
      token: params.credentials.token,
      ...(params.authorityCeiling ? { authorityCeiling: params.authorityCeiling } : {}),
      ...(params.serverUrl ? { serverUrl: params.serverUrl } : {}),
      connectTimeoutMs,
      signal: params.signal,
      ...(params.reattachOnReconnect ? { reattachOnReconnect: true } : {}),
      disconnectMessage: 'Machine RPC socket disconnected before acknowledgement',
    }, async (socket, connect, attemptSignal) => {
      const machineTarget = await resolveMachineRpcContentCodec({
        credentials: params.credentials,
        machineId,
        serverUrl: params.serverUrl,
        timeoutMs: setupTimeoutMs,
        ...(params.expectedRunnerMachineContentKeyBinding ? { expectedRunnerMachineContentKeyBinding: params.expectedRunnerMachineContentKeyBinding } : {}),
        ...(params.requireCurrentMachine ? { requireCurrentMachine: true } : {}),
        ...(params.requiredMachineKind ? { requiredMachineKind: params.requiredMachineKind } : {}),
        ...(params.externalAction ? { externalAction: params.externalAction } : {}),
        ...(attemptSignal ? { signal: attemptSignal } : {}),
      });
      const machineCodec = machineTarget.codec;
      if (params.expectedEncryptionMode !== undefined && machineCodec.mode !== params.expectedEncryptionMode) {
        throw new MachineRpcEncryptionModeMismatchError(machineId);
      }
      let request = params.request;
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
        if (params.method !== expectedMethod || targetMachineId !== machineId) throw new MachineRpcTargetNotCurrentError(machineId);
        const bootstrap = privateRequest.requesterBootstrap;
        if ('kind' in bootstrap) {
          if (bootstrap.installationId !== machineTarget.installationId) throw new MachineRpcTargetNotCurrentError(machineId);
        } else if (privateRequest.kind === 'requester_session_handoff_preflight_bootstrap_v1'
          || machineCodec.mode === 'plain' && (bootstrap.credentials.secret || bootstrap.credentials.encryption)) {
          const installationId = machineTarget.installationId;
          const encodedKey = machineTarget.installationPublicKey;
          if (!installationId || typeof encodedKey !== 'string') throw new MachineRpcTargetNotCurrentError(machineId);
          const publicKey = decodeBase64(encodedKey, 'base64');
          if (encodeBase64(publicKey, 'base64') !== encodedKey) throw new MachineRpcTargetNotCurrentError(machineId);
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
      const externalAction = params.externalAction;
      const createExecution = (transportAuthorization = externalAction?.context.externalActionExecutionAuthorization): Parameters<typeof callSocketRpc>[0]['createExternalActionExecution'] => externalAction
        ? (request) => {
          const authorization = transportAuthorization;
          const target = externalAction.context.externalActionTarget;
          const sourceMachineId = authorization ? readExternalActionSourceMachineRpcSigner(authorization)?.machineId : undefined;
          const execution = isOriginalRequesterSource(externalAction) && authorization && target && sourceMachineId
            ? createExternalActionSourceMachineRpcExecution({ authorization, target, sourceMachineId,
              sourceInstallationId: externalAction.installationId, effectActionId: externalAction.effectActionId,
              ...request, privateKey: externalAction.privateKey })
            : createExternalActionMachineRpcExecution({
            context: { ...externalAction.context, externalActionExecutionAuthorization: authorization },
            effectActionId: externalAction.effectActionId,
            installationId: externalAction.installationId,
            ...request,
            privateKey: externalAction.privateKey,
          });
          if (!execution) throw new Error('External Action Machine RPC authorization is unavailable');
          return execution;
        } : undefined;
      return await readRpcObservation({ request, signal: attemptSignal,
        observation: params.reattachOnReconnect === true ? undefined : params.reattachOnReconnect,
        read: async request => {
          let transportAuthorization = externalAction?.context.externalActionExecutionAuthorization;
          const seal = transportAuthorization?.requesterAccountProjection?.sealRequesterAccountContext;
          const hasPrivateBootstrap = request && typeof request === 'object'
            && (Reflect.get(request, 'kind') === 'requester_session_bootstrap_v1'
              || Reflect.get(request, 'kind') === 'requester_session_handoff_bootstrap_v1'
              || Reflect.get(request, 'kind') === 'requester_session_handoff_preflight_bootstrap_v1');
          if (seal && transportAuthorization && !hasPrivateBootstrap) {
            const encodedKey = machineTarget.installationPublicKey;
            if (machineTarget.installationId !== transportAuthorization.binding.installationId
              || transportAuthorization.binding.machineId !== machineId || typeof encodedKey !== 'string') {
              throw new MachineRpcTargetNotCurrentError(machineId);
            }
            const publicKey = decodeBase64(encodedKey, 'base64');
            if (encodeBase64(publicKey, 'base64') !== encodedKey) throw new MachineRpcTargetNotCurrentError(machineId);
            const sealed = await seal({ authorization: transportAuthorization,
              purpose: { kind: 'machine_rpc', method: params.method, params: request }, installationPublicKey: publicKey });
            if (!sealed || !sealed.requesterAccountContext) throw new Error('Requester Account custody unavailable');
            transportAuthorization = sealed;
          }
          const createExternalActionExecution = createExecution(transportAuthorization);
          return await callSocketRpc({
            socket,
            target: { kind: 'machine', id: machineId },
            method: params.method,
            params: request,
            content,
            requestId: params.requestId ?? randomUUID(),
            timeoutMs,
            signal: attemptSignal,
            authorization: params.authorization,
            ...(createExternalActionExecution ? { createExternalActionExecution } : {}),
            ...(params.method === RPC_METHODS.PROJECTS_OPEN && externalAction?.context.originalActionEnvelope
              ? { originalActionEnvelope: externalAction.context.originalActionEnvelope } : {}),
          });
        },
      });
    });
  } catch (error) {
    if (isSocketIoAckTimeoutError(error)) {
      throw markRpcRequestDisposition(Object.assign(new Error('Machine RPC call timeout'), { code: 'MACHINE_RPC_TIMEOUT' }), 'outcomeUnknown');
    }
    throw readRpcRequestDisposition(error) === null ? markRpcRequestDisposition(error, 'notSent') : error;
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
}>): Promise<string | null> {
  const machines = await fetchAccountMachineReplacements({ credentials: params.credentials });
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
    });
    if (!successorMachineId) throw error;
    return await callExactMachineRpc({ ...params, machineId: successorMachineId });
  }
}
