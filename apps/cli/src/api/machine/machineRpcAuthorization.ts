import {
  RPC_ERROR_CODES,
  RPC_ERROR_MESSAGES,
  parseSocketRpcAuthorizationContext,
  RPC_METHODS,
  resolveSocketRpcSessionWriteAuthorizationMethod,
  type SocketRpcAuthorizationContext,
} from '@happier-dev/protocol';

type MachineRpcAuthorizationRequest = Readonly<{
  method: string;
  params: unknown;
  authorization?: SocketRpcAuthorizationContext;
  transportResponseEnvelopeVersion?: 1;
}>;

type MachineRpcAuthorizationResult =
  | { ok: true }
  | { ok: false; error: string; errorCode: string };

function readSessionIdFromParams(params: unknown): string | null {
  if (!params || typeof params !== 'object') return null;
  const sessionId = (params as { sessionId?: unknown }).sessionId;
  if (typeof sessionId !== 'string') return null;
  const trimmed = sessionId.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function authorizeMachineRpcRequest(
  request: MachineRpcAuthorizationRequest,
): MachineRpcAuthorizationResult {
  const sessionWriteMethod = resolveSocketRpcSessionWriteAuthorizationMethod(request.method);
  if (!sessionWriteMethod) return { ok: true };

  const authorization = parseSocketRpcAuthorizationContext(request.authorization);
  const authorizedSessionId = authorization?.sessionId ?? null;
  const requestSessionId = readSessionIdFromParams(request.params);
  if (
    sessionWriteMethod === RPC_METHODS.STOP_SESSION
    && !request.authorization
    && request.transportResponseEnvelopeVersion === undefined
    && requestSessionId
  ) {
    // Compatibility seam for server-v0.2.1 at 4913c1e533c872a0712ba1c25b3104fd470aacc2.
    // That released relay routes machine RPC only within the authenticated account and
    // forwards the encrypted params, but predates both session-write authorization
    // forwarding and the v1 transport-response envelope. Permit only its exact Stop
    // shape and delegate the operation to the canonical physical Stop owner. Current
    // relays attach the v1 envelope and reject missing authorization before forwarding,
    // so they cannot enter this adapter. Remove it when server-v0.2.1 leaves support.
    return { ok: true };
  }
  if (!authorizedSessionId || !requestSessionId || requestSessionId !== authorizedSessionId) {
    return {
      ok: false,
      error: RPC_ERROR_MESSAGES.FORBIDDEN,
      errorCode: RPC_ERROR_CODES.FORBIDDEN,
    };
  }

  return { ok: true };
}
