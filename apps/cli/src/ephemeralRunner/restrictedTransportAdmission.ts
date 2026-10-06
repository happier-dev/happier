import { RPC_ERROR_CODES, RPC_ERROR_MESSAGES } from '@happier-dev/protocol/rpcErrors';
import { isSocketRpcActionApiServerOriginAuthorizationContext, parseSocketRpcAuthorizationContext } from '@happier-dev/protocol/rpc';
import { resolveEphemeralRunnerMachineRpcAuthority } from '@happier-dev/protocol/machines/peer/mediation/rpc/routePolicyV1';
import type { SocketRpcAuthorizationContext } from '@happier-dev/protocol/rpc';
import { EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1, ExternalActionDaemonPlacementV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import type { VerifiedEphemeralSessionRunnerPrincipal } from '@happier-dev/protocol/ephemeralRunner/principal';
import { SessionFollowSourceKeyPrepareAuthorizationV1Schema } from '@happier-dev/protocol/sessions/follow/sessionFollowSourceKeyPreparationV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';

import type { RpcAuthorizationResult } from '@/api/rpc/types';

const CALLER_AUTHORITY_KEYS = new Set([
  'accountId', 'authority', 'bearer', 'credentials', 'isAdmin', 'principal', 'token', 'userId',
]);

function forbidden(): RpcAuthorizationResult {
  return { ok: false, error: RPC_ERROR_MESSAGES.FORBIDDEN, errorCode: RPC_ERROR_CODES.FORBIDDEN };
}

function inspectResourceAssertions(
  value: unknown,
  principal: VerifiedEphemeralSessionRunnerPrincipal,
  seen = new Set<object>(),
): boolean {
  if (!value || typeof value !== 'object') return true;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.every((entry) => inspectResourceAssertions(entry, principal, seen));
  for (const [key, nested] of Object.entries(value as Readonly<Record<string, unknown>>)) {
    if (CALLER_AUTHORITY_KEYS.has(key)) return false;
    if (key === 'sessionId' && nested !== principal.sessionId) return false;
    if (key === 'machineId' && nested !== principal.machineId) return false;
    if (key === 'activationId' && nested !== principal.activationId) return false;
    if (key === 'installationId' && nested !== principal.installationId) return false;
    if (!inspectResourceAssertions(nested, principal, seen)) return false;
  }
  return true;
}

export function createEphemeralRunnerRestrictedRpcAdmission(input: Readonly<{
  principal: VerifiedEphemeralSessionRunnerPrincipal;
}>) {
  const machinePrefix = `${input.principal.machineId}:`;

  const authorizeRpc = async (request: Readonly<{
    method: string;
    params: unknown;
    authorization?: SocketRpcAuthorizationContext;
  }>): Promise<RpcAuthorizationResult> => {
    if (!request.method.startsWith(machinePrefix)) return forbidden();
    const method = request.method.slice(machinePrefix.length);
    if (resolveEphemeralRunnerMachineRpcAuthority(method) === null) return forbidden();
    if (method === EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1) {
      // The Home relays this request under its own Account-minted invocation
      // authority, so the Session capability vocabulary does not apply here.
      // Admission is exactly the closed server origin plus this Runner's own
      // placement; the receiver then verifies that authorization, opens the
      // envelope with its own Machine content key, and executes only inside
      // its own Session.
      if (!isSocketRpcActionApiServerOriginAuthorizationContext(request.authorization)) return forbidden();
      const params = request.params;
      const placement = ExternalActionDaemonPlacementV1Schema.safeParse(
        params && typeof params === 'object' && !Array.isArray(params)
          ? (params as Readonly<Record<string, unknown>>).placement
          : undefined,
      );
      return placement.success && placement.data.machineId === input.principal.machineId
        ? { ok: true }
        : forbidden();
    }
    if (method === RPC_METHODS.DAEMON_SESSION_FOLLOW_SOURCE_KEY_PREPARE) {
      const authorization = SessionFollowSourceKeyPrepareAuthorizationV1Schema.safeParse(request.authorization);
      if (!authorization.success || authorization.data.destinationSessionId !== input.principal.sessionId) return forbidden();
      return { ok: true };
    }
    if (!inspectResourceAssertions(request.params, input.principal)) return forbidden();
    const authorization = parseSocketRpcAuthorizationContext(request.authorization);
    if (!authorization || authorization.sessionId !== input.principal.sessionId) return forbidden();
    if (authorization.kind === 'session.write') {
      const raw = request.authorization as unknown as Readonly<Record<string, unknown>>;
      if (Object.keys(raw).some((key) => key !== 'kind' && key !== 'sessionId')) return forbidden();
    }
    return { ok: true };
  };

  return Object.freeze({ authorizeRpc });
}
