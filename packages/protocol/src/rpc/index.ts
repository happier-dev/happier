import {
  SessionPermissionDecisionActorV1Schema,
  type SessionPermissionDecisionActorV1,
} from '../sessions/permissions/v1.js';

export {
  DaemonPluginSettingsWatchRequestSchema,
  DaemonPluginSettingsWatchResponseSchema,
  type DaemonPluginSettingsWatchRequest,
  type DaemonPluginSettingsWatchResponse,
} from '../daemon/contributionRegistryProjection.js';

import { RPC_METHODS, SESSION_RPC_METHODS } from './methods.js';

export { RPC_METHODS, SESSION_RPC_METHODS } from './methods.js';

export * from './providers.js';
export * from './npmRegistryProfiles.js';

export type RpcMethod = (typeof RPC_METHODS)[keyof typeof RPC_METHODS];

export const RPC_ERROR_CODES = {
  METHOD_NOT_AVAILABLE: 'RPC_METHOD_NOT_AVAILABLE',
  METHOD_NOT_FOUND: 'RPC_METHOD_NOT_FOUND',
  FORBIDDEN: 'RPC_FORBIDDEN',
  SESSION_MACHINE_CONTROL_UNAVAILABLE: 'RPC_SESSION_MACHINE_CONTROL_UNAVAILABLE',
} as const;

export type RpcErrorCode = (typeof RPC_ERROR_CODES)[keyof typeof RPC_ERROR_CODES];

export const RPC_ERROR_MESSAGES = {
  METHOD_NOT_AVAILABLE: 'RPC method not available',
  METHOD_NOT_FOUND: 'Method not found',
  FORBIDDEN: 'Forbidden',
  SESSION_MACHINE_CONTROL_UNAVAILABLE: 'Session machine control unavailable',
} as const;

// Session-scoped RPC method names (used with `${sessionId}:${method}` over socket RPC).

export function isRpcMethodNotFoundResult(value: unknown): value is { error: string; errorCode?: string } {
  if (!value || typeof value !== 'object') return false;
  const maybe = value as { error?: unknown; errorCode?: unknown };
  if (maybe.errorCode === RPC_ERROR_CODES.METHOD_NOT_FOUND) return true;
  return maybe.error === RPC_ERROR_MESSAGES.METHOD_NOT_FOUND;
}

export const SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS = {
  SESSION_WRITE: 'session.write',
  SESSION_PERMISSION_RESPOND: 'session.permission.respond',
  AUTOMATION_REPLY_HANDOFF_SERVER_ORIGIN: 'automation.replyHandoff.serverOrigin',
  SESSION_SERVER_START_SERVER_ORIGIN: 'session.serverStart.serverOrigin',
  ACTION_API_SERVER_ORIGIN: 'action.api.serverOrigin',
} as const;

export type SocketRpcAuthorizationContextKind =
  (typeof SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS)[keyof typeof SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS];

export type SocketRpcSessionWriteAuthorizationContext = Readonly<{
  kind: typeof SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.SESSION_WRITE;
  sessionId: string;
}>;

/**
 * Account identity proven by the authenticated server after resolving a
 * permission decision's session owner/share grant. It is intentionally not a
 * client-supplied input or a general caller identity carrier.
 */
export type SocketRpcSessionPermissionRespondAuthorizationContext = Readonly<{
  kind: typeof SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.SESSION_PERMISSION_RESPOND;
  sessionId: string;
  actor: Extract<SessionPermissionDecisionActorV1, Readonly<{ kind: 'accountUser' }>>;
}>;

/**
 * A server-only transport origin for the one Automation reply-handoff daemon
 * dispatch. Generic client `CALL` rejects that method before forwarding, so a
 * caller-supplied marker never reaches the daemon as this authority.
 */
export type SocketRpcAutomationReplyHandoffServerOriginAuthorizationContext = Readonly<{
  kind: typeof SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.AUTOMATION_REPLY_HANDOFF_SERVER_ORIGIN;
}>;

/**
 * A server-only transport origin for the one reserved Session start dispatch.
 * Generic client `CALL` rejects the method before forwarding, so a
 * caller-supplied marker never becomes this authority at the daemon.
 */
export type SocketRpcSessionServerStartServerOriginAuthorizationContext = Readonly<{
  kind: typeof SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.SESSION_SERVER_START_SERVER_ORIGIN;
}>;

/**
 * A server-only transport origin for the reserved external Action dispatch.
 * Generic client `CALL` rejects that method before forwarding, so a
 * caller-supplied marker never becomes Action API authority at the daemon.
 */
export type SocketRpcActionApiServerOriginAuthorizationContext = Readonly<{
  kind: typeof SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.ACTION_API_SERVER_ORIGIN;
}>;

/** The exact server stamp for the closed external Action RPC seam. */
export const ACTION_API_SERVER_ORIGIN: SocketRpcActionApiServerOriginAuthorizationContext = Object.freeze({
  kind: SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.ACTION_API_SERVER_ORIGIN,
});

/**
 * Generic client-call authorization is deliberately limited to the shapes
 * carrying a session id. The server-only Automation origin is transported in
 * the broader union but must never be accepted by this parser.
 */
export type SocketRpcSessionAuthorizationContext =
  | SocketRpcSessionWriteAuthorizationContext
  | SocketRpcSessionPermissionRespondAuthorizationContext;

export type SocketRpcAuthorizationContext =
  | SocketRpcSessionAuthorizationContext
  | SocketRpcAutomationReplyHandoffServerOriginAuthorizationContext
  | SocketRpcSessionServerStartServerOriginAuthorizationContext
  | SocketRpcActionApiServerOriginAuthorizationContext;

const SOCKET_RPC_AUTHORIZATION_SESSION_ID_MAX_LENGTH = 512;

const SOCKET_RPC_SESSION_WRITE_AUTHORIZATION_METHODS = new Set<string>([
  RPC_METHODS.STOP_SESSION,
  RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART,
  RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART_V2,
  RPC_METHODS.SESSION_AGENT_TRANSITION,
  'session.permission.remote.grants.list',
  'session.permission.remote.grants.revoke',
]);

const SOCKET_RPC_SESSION_PERMISSION_DECISION_AUTHORIZATION_METHODS = new Set<string>([
  RPC_METHODS.SESSION_PERMISSION_RESPOND,
  'permission',
]);

const SOCKET_RPC_PROVIDER_STARTING_METHODS = new Set<string>([
  RPC_METHODS.SPAWN_HAPPY_SESSION,
  RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE,
  RPC_METHODS.SESSION_SPAWN_NEW,
  RPC_METHODS.SESSION_CONTINUE_WITH_REPLAY,
  RPC_METHODS.SESSION_FORK,
  RPC_METHODS.SESSION_FORK_PROVIDER_SAFE,
  RPC_METHODS.SESSION_AGENT_TRANSITION,
  RPC_METHODS.DAEMON_SESSION_CONNECTED_SERVICE_AUTH_SWITCH,
  RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART,
  RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART_V2,
  RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART_ALL,
  RPC_METHODS.DAEMON_SESSION_USAGE_LIMIT_WAIT_RESUME_ENABLE,
  RPC_METHODS.DAEMON_SESSION_USAGE_LIMIT_CHECK_NOW,
  RPC_METHODS.DAEMON_SESSION_USAGE_LIMIT_CONSUME_RESET_CREDIT,
  RPC_METHODS.DAEMON_EXTERNAL_SESSION_TAKEOVER,
  RPC_METHODS.DAEMON_DIRECT_SESSION_TAKEOVER_LEGACY,
  RPC_METHODS.DAEMON_DIRECT_SESSION_TAKEOVER_PERSIST_LEGACY,
]);

function resolveUnscopedSocketRpcMethod(method: string): string {
  const separatorIndex = method.lastIndexOf(':');
  if (separatorIndex < 0) return method;
  return method.slice(separatorIndex + 1);
}

export function resolveSocketRpcSessionWriteAuthorizationMethod(method: string): string | null {
  const normalized = resolveUnscopedSocketRpcMethod(String(method ?? '').trim());
  return SOCKET_RPC_SESSION_WRITE_AUTHORIZATION_METHODS.has(normalized) ? normalized : null;
}

/**
 * This includes the retained `permission` wire alias only so the server can
 * stamp the exact same account actor at the authenticated boundary. The daemon
 * still requires that stamp and does not grant actor authority to raw/local
 * callers.
 */
export function resolveSocketRpcSessionPermissionDecisionAuthorizationMethod(method: string): string | null {
  const normalized = resolveUnscopedSocketRpcMethod(String(method ?? '').trim());
  return SOCKET_RPC_SESSION_PERMISSION_DECISION_AUTHORIZATION_METHODS.has(normalized) ? normalized : null;
}

export function resolveSocketRpcProviderStartingMethod(method: string): string | null {
  const normalized = resolveUnscopedSocketRpcMethod(String(method ?? '').trim());
  return SOCKET_RPC_PROVIDER_STARTING_METHODS.has(normalized) ? normalized : null;
}

export function isSocketRpcAutomationReplyHandoffServerOriginAuthorizationContext(
  value: unknown,
): value is SocketRpcAutomationReplyHandoffServerOriginAuthorizationContext {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as { kind?: unknown };
  return Object.hasOwn(candidate, 'kind')
    && Object.keys(candidate).length === 1
    && candidate.kind === SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.AUTOMATION_REPLY_HANDOFF_SERVER_ORIGIN;
}

export function isSocketRpcSessionServerStartServerOriginAuthorizationContext(
  value: unknown,
): value is SocketRpcSessionServerStartServerOriginAuthorizationContext {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as { kind?: unknown };
  return Object.hasOwn(candidate, 'kind')
    && Object.keys(candidate).length === 1
    && candidate.kind === SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.SESSION_SERVER_START_SERVER_ORIGIN;
}

export function isSocketRpcActionApiServerOriginAuthorizationContext(
  value: unknown,
): value is SocketRpcActionApiServerOriginAuthorizationContext {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as { kind?: unknown };
  return Object.hasOwn(candidate, 'kind')
    && Object.keys(candidate).length === 1
    && candidate.kind === SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.ACTION_API_SERVER_ORIGIN;
}

export function parseSocketRpcAuthorizationContext(value: unknown): SocketRpcSessionAuthorizationContext | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as { kind?: unknown; sessionId?: unknown; actor?: unknown };
  if (candidate.kind === SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.SESSION_WRITE) {
    if (typeof candidate.sessionId !== 'string') return null;
    const sessionId = candidate.sessionId.trim();
    if (!sessionId || sessionId.length > SOCKET_RPC_AUTHORIZATION_SESSION_ID_MAX_LENGTH) return null;
    return {
      kind: SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.SESSION_WRITE,
      sessionId,
    };
  }
  if (candidate.kind !== SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.SESSION_PERMISSION_RESPOND) return null;
  if (
    !Object.hasOwn(candidate, 'kind')
    || !Object.hasOwn(candidate, 'sessionId')
    || !Object.hasOwn(candidate, 'actor')
    || Object.keys(candidate).some((key) => key !== 'kind' && key !== 'sessionId' && key !== 'actor')
  ) {
    return null;
  }
  if (typeof candidate.sessionId !== 'string') return null;
  const sessionId = candidate.sessionId.trim();
  if (!sessionId || sessionId.length > SOCKET_RPC_AUTHORIZATION_SESSION_ID_MAX_LENGTH) return null;
  const actor = SessionPermissionDecisionActorV1Schema.safeParse(candidate.actor);
  if (!actor.success || actor.data.kind !== 'accountUser') return null;
  return {
    kind: SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.SESSION_PERMISSION_RESPOND,
    sessionId,
    actor: actor.data,
  };
}
