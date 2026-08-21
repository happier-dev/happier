import {
  RPC_ERROR_CODES,
  RPC_ERROR_MESSAGES,
  RPC_METHODS,
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
  transportResponseEnvelopeVersion?: 1;
}>): Promise<RpcAuthorizationResult> {
  const authorizationMethod = resolveSocketRpcSessionWriteAuthorizationMethod(request.method);
  if (!authorizationMethod) {
    return { ok: true };
  }

  const requestedSessionId = readSessionIdFromParams(request.params);
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
  if (!authorization) return forbidden();

  if (!requestedSessionId || requestedSessionId !== authorization.sessionId) {
    return forbidden();
  }

  return { ok: true };
}
