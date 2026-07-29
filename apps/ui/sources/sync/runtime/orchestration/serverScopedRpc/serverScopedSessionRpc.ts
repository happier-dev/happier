import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';

import { createRpcCallError } from '@/sync/runtime/rpcErrors';
import { apiSocket } from '@/sync/api/session/apiSocket';
import { createEphemeralServerSocketClient } from '@/sync/runtime/orchestration/serverScopedRpc/createEphemeralServerSocketClient';
import { resolveScopedSessionCryptoContext } from '@/sync/runtime/orchestration/serverScopedRpc/resolveScopedSessionDataKey';
import { resolveServerScopedSessionContext } from '@/sync/runtime/orchestration/serverScopedRpc/resolveServerScopedSessionContext';
import type { ResolvedServerSessionRpcContext } from '@/sync/runtime/orchestration/serverScopedRpc/resolveServerScopedSessionContext';
import { readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';
import {
  areServerAccountScopesEqual,
  createServerAccountScope,
  type ServerAccountScope,
} from '@/sync/domains/scope/serverAccountScope';

import type { SocketRpcResult } from './serverScopedRpcTypes';
import { scopedSocketEmitWithAck } from './scopedSocketEmitWithAck';

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
  onIssued?: () => void;
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
      const result = await scopedSocketEmitWithAck<SocketRpcResult>({
        socket,
        event: SOCKET_RPC_EVENTS.CALL,
        timeoutMs: params.context.timeoutMs,
        payload: {
          method: `${params.sessionId}:${params.method}`,
          params: params.payload,
          timeoutMs: params.context.timeoutMs,
        },
        onIssued: params.onIssued,
      });

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

    const result = await scopedSocketEmitWithAck<SocketRpcResult>({
      socket,
      event: SOCKET_RPC_EVENTS.CALL,
      timeoutMs: params.context.timeoutMs,
      payload: {
        method: `${params.sessionId}:${params.method}`,
        params: await sessionEncryption.encryptRaw(params.payload),
        timeoutMs: params.context.timeoutMs,
      },
      onIssued: params.onIssued,
    });

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
  onIssued?: () => void;
}>): Promise<R> {
  const sessionId = normalizeId(params.sessionId);
  const context = await resolveServerScopedSessionContext({ serverId: params.serverId, timeoutMs: params.timeoutMs });
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
        timeoutMs: context.timeoutMs,
        ...(onIssued ? { onIssued } : {}),
      });
    } catch (error) {
      if (exactIssuanceAttempted) throw error;
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
        onIssued,
      });
    }
  }
  return await callScopedSessionRpc({
    sessionId,
    method: params.method,
    payload: params.payload,
    context,
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
}>): Promise<R> {
  const context = await resolveServerScopedSessionContext({
    serverId: params.scope.serverId,
    timeoutMs: params.timeoutMs,
    preferScoped: true,
  });
  if (context.scope !== 'scoped') {
    throw new Error('Exact pending dispatch scope did not resolve to scoped credentials');
  }
  const resolvedScope = createServerAccountScope(context.targetServerId, context.targetAccountId);
  if (!areServerAccountScopesEqual(resolvedScope, params.scope)) {
    throw new Error('Exact pending dispatch authenticated account does not match persisted scope');
  }
  return await callScopedSessionRpc({
    sessionId: normalizeId(params.sessionId),
    method: params.method,
    payload: params.payload,
    context,
    onIssued: params.onIssued,
  });
}
