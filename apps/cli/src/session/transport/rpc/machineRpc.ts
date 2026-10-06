import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import { fetchAccountMachineReplacements } from '@/api/machine/fetchAccountMachineReplacements';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
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
import { randomUUID } from 'node:crypto';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions';
import {
  createExternalActionAuthorizedRequestHeaders,
  createExternalActionMachineRpcExecution,
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
import { withUserScopedRpcSocket } from './withUserScopedRpcSocket';

export type MachineRpcRequestDisposition = RpcRequestDisposition;
export const readMachineRpcRequestDisposition = readRpcRequestDisposition;

export class MachineRpcEncryptionModeMismatchError extends Error {
  readonly code = 'machine_content_mode_mismatch' as const;

  constructor(readonly machineId: string) {
    super(`Machine ${machineId} content mode does not match the verified caller's expectation`);
    this.name = 'MachineRpcEncryptionModeMismatchError';
  }
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
              installationId: params.externalAction.installationId,
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
        dataEncryptionKey?: unknown;
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
  return resolvePublishedMachineContentCodec({
    credentials: params.credentials,
    machineId: params.machineId,
    publishedDataEncryptionKey: raw?.dataEncryptionKey,
    machineKind: raw?.kind,
    installationId: raw?.installationId,
    runnerContentKeyBinding: raw?.runnerContentKeyBinding,
    ...(params.expectedRunnerMachineContentKeyBinding
      ? { expectedRunnerMachineContentKeyBinding: params.expectedRunnerMachineContentKeyBinding }
      : {}),
  });
}

/** One exact account-scoped machine RPC; retry and target selection stay caller-owned. */
export async function callExactMachineRpc(params: Readonly<{
  credentials: StoredCredentials;
  machineId: string;
  serverUrl?: string;
  method: string;
  request: unknown;
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
  reattachOnReconnect?: true;
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
      : typeof params.timeoutMs === 'number' && params.timeoutMs > 0 ? params.timeoutMs : 20_000;
    const setupTimeoutMs = timeoutMs ?? 20_000;
    const connectTimeoutMs = typeof params.timeoutMs === 'number' && params.timeoutMs > 0
      ? setupTimeoutMs : resolveSessionControlSocketConnectTimeoutMs();
    return await withUserScopedRpcSocket({
      token: params.credentials.token,
      ...(params.serverUrl ? { serverUrl: params.serverUrl } : {}),
      connectTimeoutMs,
      signal: params.signal,
      ...(params.reattachOnReconnect ? { reattachOnReconnect: true } : {}),
      disconnectMessage: 'Machine RPC socket disconnected before acknowledgement',
    }, async (socket, connect, attemptSignal) => {
      const machineCodec = await resolveMachineRpcContentCodec({
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
      if (params.expectedEncryptionMode !== undefined && machineCodec.mode !== params.expectedEncryptionMode) {
        throw new MachineRpcEncryptionModeMismatchError(machineId);
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
      const createExternalActionExecution: Parameters<typeof callSocketRpc>[0]['createExternalActionExecution'] = externalAction
        ? (request) => {
          const execution = createExternalActionMachineRpcExecution({
            context: externalAction.context,
            effectActionId: externalAction.effectActionId,
            installationId: externalAction.installationId,
            ...request,
            privateKey: externalAction.privateKey,
          });
          if (!execution) throw new Error('External Action Machine RPC authorization is unavailable');
          return execution;
        } : undefined;
      return callSocketRpc({
        socket,
        target: { kind: 'machine', id: machineId },
        method: params.method,
        params: params.request,
        content,
        requestId: randomUUID(),
        timeoutMs,
        signal: attemptSignal,
        authorization: params.authorization,
        ...(createExternalActionExecution ? { createExternalActionExecution } : {}),
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
export async function callMachineRpc(params: Readonly<{
  credentials: StoredCredentials;
  machineId: string;
  method: string;
  request: unknown;
  authorization?: SocketRpcAuthorizationContext;
  timeoutMs?: number | null;
  signal?: AbortSignal;
}>): Promise<unknown> {
  try {
    return await callExactMachineRpc(params);
  } catch (error) {
    // Only "the server found no target for this machine" may be re-addressed:
    // it proves the request reached no machine at all.
    if (!isRpcMethodNotAvailableError(error)) throw error;
    const successorMachineId = await resolveSuccessorMachineId({
      credentials: params.credentials,
      machineId: params.machineId,
    });
    if (!successorMachineId) throw error;
    return await callExactMachineRpc({ ...params, machineId: successorMachineId });
  }
}
