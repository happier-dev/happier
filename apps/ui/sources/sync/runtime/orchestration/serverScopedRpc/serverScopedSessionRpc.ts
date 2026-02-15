import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';

import { createRpcCallError } from '@/sync/runtime/rpcErrors';
import { apiSocket } from '@/sync/api/session/apiSocket';
import { createEphemeralServerSocketClient } from '@/sync/runtime/orchestration/serverScopedRpc/createEphemeralServerSocketClient';
import { resolveScopedSessionDataKey } from '@/sync/runtime/orchestration/serverScopedRpc/resolveScopedSessionDataKey';
import { resolveServerScopedSessionContext } from '@/sync/runtime/orchestration/serverScopedRpc/resolveServerScopedSessionContext';

import type { SocketRpcResult } from './serverScopedRpcTypes';

function normalizeId(raw: unknown): string {
  return String(raw ?? '').trim();
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
    return await apiSocket.sessionRPC<R, A>(sessionId, params.method, params.payload);
  }

  const sessionDataKey = await resolveScopedSessionDataKey({
    serverId: context.targetServerId,
    serverUrl: context.targetServerUrl,
    token: context.token,
    sessionId,
    timeoutMs: context.timeoutMs,
    decryptEncryptionKey: (value) => context.encryption.decryptEncryptionKey(value),
  });

  await context.encryption.initializeSessions(new Map([[sessionId, sessionDataKey]]));
  const sessionEncryption = context.encryption.getSessionEncryption(sessionId);
  if (!sessionEncryption) {
    throw new Error(`Session encryption not found for ${sessionId}`);
  }

  const socket = await createEphemeralServerSocketClient({
    serverUrl: context.targetServerUrl,
    token: context.token,
    timeoutMs: context.timeoutMs,
  });
  try {
    const result = (await socket
      .timeout(context.timeoutMs)
      .emitWithAck(SOCKET_RPC_EVENTS.CALL, {
        method: `${sessionId}:${params.method}`,
        params: await sessionEncryption.encryptRaw(params.payload),
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

