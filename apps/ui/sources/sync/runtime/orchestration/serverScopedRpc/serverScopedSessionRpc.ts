import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';

import { createRpcCallError } from '@/sync/runtime/rpcErrors';
import { apiSocket } from '@/sync/api/session/apiSocket';
import { createEphemeralServerSocketClient } from '@/sync/runtime/orchestration/serverScopedRpc/createEphemeralServerSocketClient';
import { resolveScopedSessionCryptoContext } from '@/sync/runtime/orchestration/serverScopedRpc/resolveScopedSessionDataKey';
import { resolveServerScopedSessionContext } from '@/sync/runtime/orchestration/serverScopedRpc/resolveServerScopedSessionContext';
import type { ResolvedServerSessionRpcContext } from '@/sync/runtime/orchestration/serverScopedRpc/resolveServerScopedSessionContext';
import { areServerAccountScopesEqual, createServerAccountScope, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';
import { raceSocketIoAckTimeout } from '@/sync/runtime/socketIoAckTimeout';

import type { SocketRpcResult } from './serverScopedRpcTypes';

function normalizeId(raw: unknown): string {
  return String(raw ?? '').trim();
}

function shouldRetryWithScopedSessionContext(error: unknown): boolean {
  if (readRpcErrorCode(error) === RPC_ERROR_CODES.METHOD_NOT_AVAILABLE) {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /session encryption not found/i.test(message);
}

async function callScopedSessionRpc<R, A>(params: Readonly<{
  sessionId: string;
  method: string;
  payload: A;
  context: Extract<ResolvedServerSessionRpcContext, { scope: 'scoped' }>;
  operationTimeoutMs: number | null;
  onIssued?: () => void;
  networkMode?: 'background-task';
  signal?: AbortSignal;
}>): Promise<R> {
  const assertActive = () => {
    if (params.signal?.aborted) throw new Error('Scoped RPC aborted');
  };
  assertActive();
  const cryptoContext = await resolveScopedSessionCryptoContext({
    serverId: params.context.targetServerId,
    serverUrl: params.context.targetServerUrl,
    token: params.context.token,
    sessionId: params.sessionId,
    timeoutMs: params.context.timeoutMs,
    networkMode: params.networkMode,
    decryptEncryptionKey: (value) => params.context.encryption.decryptEncryptionKey(value),
  });

    assertActive();
    const socket = await createEphemeralServerSocketClient({
        serverUrl: params.context.targetServerUrl,
        token: params.context.token,
        timeoutMs: params.context.timeoutMs,
        networkMode: params.networkMode,
        signal: params.signal,
    });
    try {
        // A connection may complete in the same turn as cancellation. Never
        // prepare/emit with a late socket; finally releases it immediately.
        assertActive();
        if (cryptoContext.encryptionMode === 'plain') {
            const socketEmission = params.operationTimeoutMs === null
                ? socket
                : socket.timeout(params.operationTimeoutMs);
            params.onIssued?.();
            const result = (await raceSocketIoAckTimeout(
                socketEmission.emitWithAck(SOCKET_RPC_EVENTS.CALL, {
                    method: `${params.sessionId}:${params.method}`,
                    params: params.payload,
                    ...(params.operationTimeoutMs === null ? {} : { timeoutMs: params.operationTimeoutMs }),
                }) as Promise<SocketRpcResult>,
                params.operationTimeoutMs ?? undefined,
            )) as SocketRpcResult;

      if (result.ok) return result.result as R;

      throw createRpcCallError({
        error: typeof result.error === 'string' ? result.error : 'RPC call failed',
        errorCode: typeof result.errorCode === 'string' ? result.errorCode : undefined,
      });
    }

    if (cryptoContext.encryptionMode !== 'e2ee') {
      throw createRpcCallError({
        error: 'Unable to resolve session encryption for scoped RPC',
        errorCode: 'scoped_session_encryption_unavailable',
      });
    }

    await params.context.encryption.initializeSessions(new Map([[params.sessionId, cryptoContext.sessionDataKey]]));
    const sessionEncryption = params.context.encryption.getSessionEncryption(params.sessionId);
    if (!sessionEncryption) {
      throw createRpcCallError({
        error: `Session encryption not found for ${params.sessionId}`,
        errorCode: 'session_encryption_not_found',
      });
    }

    const encryptedPayload = await sessionEncryption.encryptRaw(params.payload);
    const socketEmission = params.operationTimeoutMs === null
      ? socket
      : socket.timeout(params.operationTimeoutMs);
    assertActive();
    params.onIssued?.();
    const result = (await raceSocketIoAckTimeout(
      socketEmission.emitWithAck(SOCKET_RPC_EVENTS.CALL, {
        method: `${params.sessionId}:${params.method}`,
        params: encryptedPayload,
        ...(params.operationTimeoutMs === null ? {} : { timeoutMs: params.operationTimeoutMs }),
      }) as Promise<SocketRpcResult>,
      params.operationTimeoutMs ?? undefined,
    )) as SocketRpcResult;

    if (result.ok) {
      return (await sessionEncryption.decryptRaw(result.result)) as R;
    }

    throw createRpcCallError({
      error: typeof result.error === 'string' ? result.error : 'RPC call failed',
      errorCode: typeof result.errorCode === 'string' ? result.errorCode : undefined,
    });
  } finally {
    socket.disconnect();
  }
}

export async function sessionRpcWithServerScope<R, A>(params: Readonly<{
  sessionId: string;
  serverId?: string | null;
  method: string;
  payload: A;
  timeoutMs?: number | null;
  onIssued?: () => void;
}>): Promise<R> {
  const sessionId = normalizeId(params.sessionId);
  const context = await resolveServerScopedSessionContext({
    serverId: params.serverId,
    ...(typeof params.timeoutMs === 'number' ? { timeoutMs: params.timeoutMs } : {}),
  });
  const operationTimeoutMs = params.timeoutMs === null ? null : context.timeoutMs;
  let exactIssuanceAttempted = false;
  const onIssued = params.onIssued
    ? () => {
        exactIssuanceAttempted = true;
        params.onIssued?.();
      }
    : undefined;

  if (context.scope === 'active') {
    try {
      return await apiSocket.sessionRPC<R, A>(sessionId, params.method, params.payload, {
        timeoutMs: operationTimeoutMs,
        ...(onIssued ? { onIssued } : {}),
      });
    } catch (error) {
      if (exactIssuanceAttempted) throw error;
      if (!shouldRetryWithScopedSessionContext(error)) throw error;
      const retryContext = await resolveServerScopedSessionContext({
        serverId: params.serverId,
        ...(typeof params.timeoutMs === 'number' ? { timeoutMs: params.timeoutMs } : {}),
        preferScoped: true,
      });
      if (retryContext.scope !== 'scoped') throw error;
      return await callScopedSessionRpc({
        sessionId,
        method: params.method,
        payload: params.payload,
        context: retryContext,
        operationTimeoutMs,
        onIssued,
      });
    }
  }
  return await callScopedSessionRpc({
    sessionId,
    method: params.method,
    payload: params.payload,
    context,
    operationTimeoutMs,
    onIssued,
  });
}

export async function sessionRpcWithServerAccountScope<R, A>(params: Readonly<{
  sessionId: string;
  scope: ServerAccountScope;
  method: string;
  payload: A;
  timeoutMs?: number;
  onIssued?: () => void;
  networkMode?: 'background-task';
  signal?: AbortSignal;
}>): Promise<R> {
  const context = await resolveServerScopedSessionContext({
    serverId: params.scope.serverId,
    timeoutMs: params.timeoutMs,
    preferScoped: true,
  });
  if (context.scope !== 'scoped') {
    throw new Error('Requested session scope did not resolve to scoped credentials');
  }
  const resolvedScope = createServerAccountScope(context.targetServerId, context.targetAccountId);
  if (!areServerAccountScopesEqual(resolvedScope, params.scope)) {
    throw new Error('Authenticated account does not match the requested session scope');
  }
  return await callScopedSessionRpc({
    sessionId: normalizeId(params.sessionId),
    method: params.method,
    payload: params.payload,
    context,
    operationTimeoutMs: context.timeoutMs,
    onIssued: params.onIssued,
    networkMode: params.networkMode,
    signal: params.signal,
  });
}
