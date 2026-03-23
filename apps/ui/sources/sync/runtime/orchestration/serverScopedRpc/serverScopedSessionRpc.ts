import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';

import { createRpcCallError } from '@/sync/runtime/rpcErrors';
import { apiSocket } from '@/sync/api/session/apiSocket';
import { createEphemeralServerSocketClient } from '@/sync/runtime/orchestration/serverScopedRpc/createEphemeralServerSocketClient';
import { resolveScopedSessionCryptoContext } from '@/sync/runtime/orchestration/serverScopedRpc/resolveScopedSessionDataKey';
import { resolveServerScopedSessionContext } from '@/sync/runtime/orchestration/serverScopedRpc/resolveServerScopedSessionContext';
import type { ResolvedServerSessionRpcContext } from '@/sync/runtime/orchestration/serverScopedRpc/resolveServerScopedSessionContext';
import { readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';

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
}>): Promise<R> {
  const cryptoContext = await resolveScopedSessionCryptoContext({
    serverId: params.context.targetServerId,
    serverUrl: params.context.targetServerUrl,
    token: params.context.token,
    sessionId: params.sessionId,
    timeoutMs: params.context.timeoutMs,
    decryptEncryptionKey: (value) => params.context.encryption.decryptEncryptionKey(value),
  });

  const socket = await createEphemeralServerSocketClient({
    serverUrl: params.context.targetServerUrl,
    token: params.context.token,
    timeoutMs: params.context.timeoutMs,
  });
  try {
    if (cryptoContext.encryptionMode === 'plain') {
      const result = (await socket
        .timeout(params.context.timeoutMs)
        .emitWithAck(SOCKET_RPC_EVENTS.CALL, {
          method: `${params.sessionId}:${params.method}`,
          params: params.payload,
          timeoutMs: params.context.timeoutMs,
        })) as SocketRpcResult;

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

    const result = (await socket
      .timeout(params.context.timeoutMs)
      .emitWithAck(SOCKET_RPC_EVENTS.CALL, {
        method: `${params.sessionId}:${params.method}`,
        params: await sessionEncryption.encryptRaw(params.payload),
        timeoutMs: params.context.timeoutMs,
      })) as SocketRpcResult;

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
  timeoutMs?: number;
}>): Promise<R> {
  const sessionId = normalizeId(params.sessionId);
  const context = await resolveServerScopedSessionContext({ serverId: params.serverId, timeoutMs: params.timeoutMs });

  if (context.scope === 'active') {
    try {
      return await apiSocket.sessionRPC<R, A>(sessionId, params.method, params.payload, {
        timeoutMs: context.timeoutMs,
      });
    } catch (error) {
      if (!shouldRetryWithScopedSessionContext(error)) throw error;
      const retryContext = await resolveServerScopedSessionContext({
        serverId: params.serverId,
        timeoutMs: params.timeoutMs,
        preferScoped: true,
      });
      if (retryContext.scope !== 'scoped') throw error;
      return await callScopedSessionRpc({
        sessionId,
        method: params.method,
        payload: params.payload,
        context: retryContext,
      });
    }
  }
  return await callScopedSessionRpc({
    sessionId,
    method: params.method,
    payload: params.payload,
    context,
  });
}
