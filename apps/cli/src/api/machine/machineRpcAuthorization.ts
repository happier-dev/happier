import {
  RPC_ERROR_CODES,
  RPC_ERROR_MESSAGES,
  parseSocketRpcAuthorizationContext,
  resolveSocketRpcSessionWriteAuthorizationMethod,
  type SocketRpcAuthorizationContext,
} from '@happier-dev/protocol/rpc';

import type { RpcAuthorizationResult } from '@/api/rpc/types';

function readSessionIdFromParams(params: unknown): string | null {
  if (!params || typeof params !== 'object') return null;
  const sessionId = (params as { sessionId?: unknown }).sessionId;
  return typeof sessionId === 'string' && sessionId.trim().length > 0 ? sessionId.trim() : null;
}

function forbidden(): RpcAuthorizationResult {
  return {
    ok: false,
    error: RPC_ERROR_MESSAGES.FORBIDDEN,
    errorCode: RPC_ERROR_CODES.FORBIDDEN,
  };
}

export async function authorizeMachineRpcRequest(request: Readonly<{
  method: string;
  params: unknown;
  authorization?: SocketRpcAuthorizationContext;
}>): Promise<RpcAuthorizationResult> {
  if (!resolveSocketRpcSessionWriteAuthorizationMethod(request.method)) {
    return { ok: true };
  }

  const authorization = parseSocketRpcAuthorizationContext(request.authorization);
  if (!authorization) return forbidden();

  const requestedSessionId = readSessionIdFromParams(request.params);
  if (!requestedSessionId || requestedSessionId !== authorization.sessionId) {
    return forbidden();
  }

  return { ok: true };
}
