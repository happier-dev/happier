import {
  SessionPermissionDecisionActorV1Schema,
  type SessionPermissionDecisionActorV1,
} from '../sessions/permissions/v1.js';
import type { SessionCapabilityV1 } from '../sessions/access/sessionEffectiveAccessV1.js';
import type { ActionId } from '../actions/actionIds.js';
import type { SessionFollowSourceKeyPrepareAuthorizationV1 } from '../sessions/follow/sessionFollowSourceKeyPreparationV1.js';
import { SocketRpcSessionActionAuthorizationContextSchema, type SocketRpcSessionActionAuthorizationContext } from './socket.js';
import {
  CURRENT_SESSION_PRESENTATION_ACK_RPC_METHOD,
  CURRENT_SESSION_PRESENTATION_BIND_RPC_METHOD,
  CURRENT_SESSION_PRESENTATION_UNBIND_RPC_METHOD,
} from '../sessions/presentation/currentSessionPresentationV1.js';

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
export {
  resolveEphemeralRunnerMachineRpcAuthority,
  type EphemeralRunnerMachineRpcAuthority,
} from '../machines/peer/mediation/rpc/routePolicyV1.js';

export type RpcMethod = (typeof RPC_METHODS)[keyof typeof RPC_METHODS];

/** Optional expensive byte-identity request for the incumbent STAT_FILE owner. */
export type WorkspaceStatFileRequestV1 = Readonly<{
  path: string;
  includeContentHash?: boolean;
}>;

export const RPC_ERROR_CODES = {
  UPDATE_REQUIRED: 'RPC_UPDATE_REQUIRED',
  METHOD_NOT_AVAILABLE: 'RPC_METHOD_NOT_AVAILABLE',
  METHOD_NOT_FOUND: 'RPC_METHOD_NOT_FOUND',
  FORBIDDEN: 'RPC_FORBIDDEN',
  SESSION_MACHINE_CONTROL_UNAVAILABLE: 'RPC_SESSION_MACHINE_CONTROL_UNAVAILABLE',
  /**
   * The Session is reachable but the caller's Team policy is not satisfied by
   * the credential it presented. It is the socket-RPC spelling of the HTTP
   * Session routes' `team_authentication_required` (403), and it exists because
   * collapsing it into `FORBIDDEN` or `METHOD_NOT_AVAILABLE` hides the one
   * recovery the caller can perform: go and authenticate for that Team.
   */
  TEAM_AUTHENTICATION_REQUIRED: 'RPC_TEAM_AUTHENTICATION_REQUIRED',
  /** Nothing the caller could present satisfies the policy right now (HTTP 503). */
  TEAM_AUTHENTICATION_UNAVAILABLE: 'RPC_TEAM_AUTHENTICATION_UNAVAILABLE',
} as const;

export type RpcErrorCode = (typeof RPC_ERROR_CODES)[keyof typeof RPC_ERROR_CODES];

export const RPC_ERROR_MESSAGES = {
  METHOD_NOT_AVAILABLE: 'RPC method not available',
  METHOD_NOT_FOUND: 'Method not found',
  FORBIDDEN: 'Forbidden',
  SESSION_MACHINE_CONTROL_UNAVAILABLE: 'Session machine control unavailable',
  TEAM_AUTHENTICATION_REQUIRED: 'Team authentication required',
  TEAM_AUTHENTICATION_UNAVAILABLE: 'Team authentication unavailable',
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
  SESSION_ACTION: 'session.action',
  SESSION_PERMISSION_RESPOND: 'session.permission.respond',
  AUTOMATION_REPLY_HANDOFF_SERVER_ORIGIN: 'automation.replyHandoff.serverOrigin',
  SESSION_SERVER_START_SERVER_ORIGIN: 'session.serverStart.serverOrigin',
  ACTION_API_SERVER_ORIGIN: 'action.api.serverOrigin',
  CURRENT_SESSION_PRESENTATION_ORIGIN: 'session.presentation.origin',
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

/**
 * Server-minted custody for one authenticated socket connection presenting an
 * exact Session. Public callers cannot provide or parse this authority.
 */
export type SocketRpcCurrentSessionPresentationOriginAuthorizationContext = Readonly<{
  kind: typeof SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.CURRENT_SESSION_PRESENTATION_ORIGIN;
  sessionId: string;
  accountId: string;
  connectionId: string;
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
  | SocketRpcSessionActionAuthorizationContext
  | SocketRpcSessionPermissionRespondAuthorizationContext;

export type SocketRpcAuthorizationContext =
  | SocketRpcSessionAuthorizationContext
  | SessionFollowSourceKeyPrepareAuthorizationV1
  | SocketRpcAutomationReplyHandoffServerOriginAuthorizationContext
  | SocketRpcSessionServerStartServerOriginAuthorizationContext
  | SocketRpcActionApiServerOriginAuthorizationContext
  | SocketRpcCurrentSessionPresentationOriginAuthorizationContext;

const SOCKET_RPC_AUTHORIZATION_SESSION_ID_MAX_LENGTH = 512;

/**
 * The exact Session authority a Session-owned write RPC requires. `sessionOwner`
 * exists because Lane 04 currently defines `stopSession` as owner-only: neither
 * `manageAccess` nor being the Run creator widens it.
 */
export type SocketRpcSessionWriteAuthorityV1 = SessionCapabilityV1 | 'sessionOwner';

export type SocketRpcSessionWriteClassificationV1 = Readonly<{
  method: string;
  authority: SocketRpcSessionWriteAuthorityV1;
  /** Token calls are admitted only when the canonical row declares an Action. */
  actionId?: ActionId;
  serverMintedContext?: 'session.permission.respond' | 'session.presentation.origin';
  /**
   * True when the mutation must execute on the Session owner's daemon. A shared
   * collaborator holding the required capability needs no personal AccessKey for
   * that Machine, and the call is never forwarded to the caller's own user room.
   */
  routeToSessionOwnerDaemon: boolean;
}>;

/**
 * Closed matrix of every currently registered Session RPC plus the retained
 * machine-routed Session controls. Registration and final dispatch consume this
 * same map; a method absent here is unavailable rather than inheriting authority
 * from a prefix or from its daemon handler.
 */
type DeclaredSessionRpcMethod = (typeof SESSION_RPC_METHODS)[keyof typeof SESSION_RPC_METHODS];

/**
 * Every declared Session RPC chooses its authority here. The exhaustive Record
 * is intentional: extending SESSION_RPC_METHODS without classifying the new
 * method is a compile error, rather than silently granting submitAgentInput.
 */
const SESSION_RPC_DECLARED_AUTHORITIES = Object.freeze({
  [SESSION_RPC_METHODS.SESSION_WORKFLOW_STEP_WITHDRAW]: 'sessionOwner',
  [SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND]: { authority: 'submitAgentInput', actionId: 'session.message.send' },
  [SESSION_RPC_METHODS.SESSION_AGENT_TOOL_CALL_V1]: 'sessionOwner',
  [SESSION_RPC_METHODS.SESSION_PENDING_MESSAGE_COMPOSER_ADMISSION_PREPARE_V1]: 'submitAgentInput',
  [SESSION_RPC_METHODS.SESSION_PENDING_MESSAGE_COMPOSER_ADMISSION_ACCEPTED_V1]: 'submitAgentInput',
  [SESSION_RPC_METHODS.SESSION_PENDING_MESSAGE_COMPOSER_ADMISSION_ABANDONED_V1]: 'submitAgentInput',
  [SESSION_RPC_METHODS.SESSION_WORK_STATE_GET]: { authority: 'readTranscript', actionId: 'session.work_state.get' },
  [SESSION_RPC_METHODS.SESSION_GOAL_GET]: 'readTranscript',
  [SESSION_RPC_METHODS.SESSION_GOAL_SET]: 'submitAgentInput',
  [SESSION_RPC_METHODS.SESSION_GOAL_CLEAR]: 'submitAgentInput',
  [SESSION_RPC_METHODS.SESSION_CONNECTED_SERVICE_AUTH_INVALIDATE_TRANSPORTS]: 'sessionOwner',
  [SESSION_RPC_METHODS.SESSION_CONNECTED_SERVICE_AUTH_APPLY_GENERATION]: 'sessionOwner',
  [SESSION_RPC_METHODS.SESSION_CONNECTED_SERVICE_AUTH_READ_RUNTIME_IDENTITY]: 'readTranscript',
  [SESSION_RPC_METHODS.SESSION_PROVIDER_INPUT_ADMISSION]: 'sessionOwner',
  [SESSION_RPC_METHODS.SESSION_PROVIDER_CLI_ATTACH_PREPARE]: 'sessionOwner',
  [SESSION_RPC_METHODS.SESSION_MODEL_TRANSITION]: { authority: 'submitAgentInput', actionId: 'session.model.set' },
  [SESSION_RPC_METHODS.SESSION_ROLE_SET]: 'submitAgentInput',
  [SESSION_RPC_METHODS.SESSION_ROLES_CONFIGURATION_SET]: 'submitAgentInput',
  [SESSION_RPC_METHODS.SESSION_ROLES_OVERRIDE_SET]: 'submitAgentInput',
  [SESSION_RPC_METHODS.SESSION_ROLES_OVERRIDE_CLEAR]: 'submitAgentInput',
  [SESSION_RPC_METHODS.SESSION_ROLES_ADD]: 'submitAgentInput',
  [SESSION_RPC_METHODS.SESSION_ROLES_REMOVE]: 'submitAgentInput',
  [SESSION_RPC_METHODS.SESSION_NOTES_SET]: 'submitAgentInput',
  [SESSION_RPC_METHODS.SESSION_ROLES_APPLY_TO_REPORTS]: 'submitAgentInput',
  [SESSION_RPC_METHODS.SESSION_PENDING_QUEUE_MATERIALIZE_NEXT]: 'sessionOwner',
  [SESSION_RPC_METHODS.SESSION_PENDING_QUEUE_WAKE_CAPABILITY_GET_V1]: 'readTranscript',
  [SESSION_RPC_METHODS.SESSION_PENDING_QUEUE_WAKE_V1]: 'submitAgentInput',
  [SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_WAIT_RESUME_ENABLE]: 'submitAgentInput',
  [SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_WAIT_RESUME_CANCEL]: 'submitAgentInput',
  [SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_CHECK_NOW]: 'submitAgentInput',
  [SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_CONSUME_RESET_CREDIT]: 'submitAgentInput',
  [SESSION_RPC_METHODS.SESSION_TERMINAL_COMPOSER_CLEAR]: 'submitAgentInput',
  [SESSION_RPC_METHODS.SESSION_PENDING_INPUT_INTERRUPT_AND_RUN]: 'submitAgentInput',
  [SESSION_RPC_METHODS.SESSION_INPUT_CANCEL_EXACT_TURN_V1]: 'submitAgentInput',
  [SESSION_RPC_METHODS.SESSION_REVIEW_START_INLINE]: 'submitAgentInput',
  [SESSION_RPC_METHODS.SESSION_VENDOR_PLUGIN_CATALOG_LIST]: 'readTranscript',
  [SESSION_RPC_METHODS.SESSION_SKILL_CATALOG_LIST]: 'readTranscript',
  [SESSION_RPC_METHODS.EXECUTION_RUN_START]: 'submitAgentInput',
  [SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE]: 'submitAgentInput',
  [SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START]: 'sessionOwner',
  [SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START_PROVIDER_SAFE_V1]: 'sessionOwner',
  [SESSION_RPC_METHODS.EXECUTION_RUN_SEND]: 'submitAgentInput',
  [SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START]: 'sessionOwner',
  [SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START_V2]: 'sessionOwner',
  [SESSION_RPC_METHODS.EXECUTION_RUN_USER_TRANSCRIPT_COMMIT_V1]: 'sessionOwner',
  [SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_READ]: 'readTranscript',
  [SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_CANCEL]: 'sessionOwner',
  [SESSION_RPC_METHODS.EXECUTION_RUN_CANCEL_TURN_V1]: 'sessionOwner',
  [SESSION_RPC_METHODS.EXECUTION_RUN_STOP]: 'sessionOwner',
  [SESSION_RPC_METHODS.EXECUTION_RUN_LIST]: 'readTranscript',
  [SESSION_RPC_METHODS.EXECUTION_RUN_GET]: 'readTranscript',
  [SESSION_RPC_METHODS.EXECUTION_RUN_WAIT]: 'readTranscript',
  [SESSION_RPC_METHODS.EXECUTION_RUN_BROKER_AUTHORITY_RESOLVE_V1]: 'sessionOwner',
  [SESSION_RPC_METHODS.EXECUTION_RUN_ACTION]: 'sessionOwner',
  [SESSION_RPC_METHODS.SESSION_ROLLBACK]: 'submitAgentInput',
  [SESSION_RPC_METHODS.SESSION_CHECKPOINT_CODE_ROLLBACK]: 'submitAgentInput',
  [SESSION_RPC_METHODS.SESSION_CHECKPOINT]: 'submitAgentInput',
  [SESSION_RPC_METHODS.SESSION_RESTORE]: 'submitAgentInput',
  [SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_INSPECT]: 'readTranscript',
  [SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_START]: 'submitAgentInput',
  [SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_STOP]: 'submitAgentInput',
  [SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_WATCH]: 'readTranscript',
  [SESSION_RPC_METHODS.SESSION_MANAGED_SERVICE_ENDPOINT_READ_OPEN_V1]: 'readTranscript',
  [SESSION_RPC_METHODS.SESSION_MANAGED_SERVICE_ENDPOINT_READ_NEXT_V1]: 'readTranscript',
  [SESSION_RPC_METHODS.SESSION_MANAGED_SERVICE_ENDPOINT_READ_CANCEL_V1]: 'readTranscript',
} as const satisfies Record<DeclaredSessionRpcMethod, SocketRpcSessionWriteAuthorityV1 | Pick<SocketRpcSessionWriteClassificationV1, 'authority' | 'actionId'>>);

const SESSION_RPC_AUTHORIZATION_ROWS: readonly SocketRpcSessionWriteClassificationV1[] =
  Object.entries(SESSION_RPC_DECLARED_AUTHORITIES).map(([method, declaration]) => Object.freeze({
    method,
    ...(typeof declaration === 'string' ? { authority: declaration } : declaration),
    routeToSessionOwnerDaemon: true,
  }));

const ADDITIONAL_SESSION_RPC_AUTHORIZATION_ROWS = [
  ...[
    RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT,
    RPC_METHODS.DAEMON_TRANSFER_UPLOAD_CHUNK,
    RPC_METHODS.DAEMON_TRANSFER_UPLOAD_FINALIZE,
    RPC_METHODS.DAEMON_TRANSFER_UPLOAD_ABORT,
    RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_INIT,
    RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_CHUNK,
    RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_FINALIZE,
    RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_ABORT,
  ].map((method) => ({ method, authority: 'submitAgentInput' as const, actionId: 'session.message.send' as const, routeToSessionOwnerDaemon: true })),
  { method: RPC_METHODS.SESSION_LOG_TAIL, authority: 'readTranscript', routeToSessionOwnerDaemon: true },
  { method: RPC_METHODS.TRANSCRIPT_PAGE, authority: 'readTranscript', actionId: 'transcript.page', routeToSessionOwnerDaemon: true },
  { method: RPC_METHODS.TRANSCRIPT_READ_AFTER, authority: 'readTranscript', actionId: 'transcript.readAfter', routeToSessionOwnerDaemon: true },
  { method: RPC_METHODS.TRANSCRIPT_FOLLOW, authority: 'readTranscript', actionId: 'session.transcript.get', routeToSessionOwnerDaemon: true },
  { method: RPC_METHODS.TRANSCRIPT_UNFOLLOW, authority: 'readTranscript', actionId: 'transcript.unfollow', routeToSessionOwnerDaemon: true },
  { method: RPC_METHODS.TRANSCRIPT_SEARCH, authority: 'readTranscript', routeToSessionOwnerDaemon: true },
  { method: RPC_METHODS.TRANSCRIPT_IMPORT, authority: 'submitAgentInput', routeToSessionOwnerDaemon: true },
  { method: CURRENT_SESSION_PRESENTATION_BIND_RPC_METHOD, authority: 'sessionOwner', routeToSessionOwnerDaemon: true, serverMintedContext: 'session.presentation.origin' },
  { method: CURRENT_SESSION_PRESENTATION_ACK_RPC_METHOD, authority: 'sessionOwner', routeToSessionOwnerDaemon: true, serverMintedContext: 'session.presentation.origin' },
  { method: CURRENT_SESSION_PRESENTATION_UNBIND_RPC_METHOD, authority: 'sessionOwner', routeToSessionOwnerDaemon: true, serverMintedContext: 'session.presentation.origin' },
  { method: 'session.permission_mode.set', authority: 'submitAgentInput', routeToSessionOwnerDaemon: true },
  { method: RPC_METHODS.SESSION_PERMISSION_RESPOND, authority: 'approveRuntimePermissions', actionId: 'session.permission.respond', routeToSessionOwnerDaemon: true, serverMintedContext: 'session.permission.respond' },
  { method: 'permission', authority: 'approveRuntimePermissions', actionId: 'session.permission.respond', routeToSessionOwnerDaemon: true, serverMintedContext: 'session.permission.respond' },
  { method: 'session.permission.remote.grants.list', authority: 'submitAgentInput', routeToSessionOwnerDaemon: true },
  { method: 'session.permission.remote.grants.revoke', authority: 'submitAgentInput', routeToSessionOwnerDaemon: true },
  { method: 'session.user_action.answer', authority: 'submitAgentInput', actionId: 'session.user_action.answer', routeToSessionOwnerDaemon: true },
  { method: 'abort', authority: 'submitAgentInput', actionId: 'session.message.send', routeToSessionOwnerDaemon: true },
] as const satisfies readonly SocketRpcSessionWriteClassificationV1[];

export const API_TOKEN_SOCKET_EVENT_ACTIONS = Object.freeze({ message: 'session.message.send' } as const);

const SOCKET_RPC_SESSION_WRITE_AUTHORIZATION: ReadonlyMap<string, SocketRpcSessionWriteClassificationV1> = new Map(
  ([
    ...SESSION_RPC_AUTHORIZATION_ROWS,
    ...ADDITIONAL_SESSION_RPC_AUTHORIZATION_ROWS,
    { method: RPC_METHODS.STOP_SESSION, authority: 'sessionOwner', routeToSessionOwnerDaemon: false },
    { method: RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART, authority: 'submitAgentInput', routeToSessionOwnerDaemon: false },
    { method: RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART_V2, authority: 'submitAgentInput', routeToSessionOwnerDaemon: false },
    { method: RPC_METHODS.SESSION_AGENT_TRANSITION, authority: 'submitAgentInput', routeToSessionOwnerDaemon: false },
  ] as const satisfies readonly SocketRpcSessionWriteClassificationV1[])
    .map((row) => [row.method, Object.freeze(row)] as const),
);

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

/**
 * The exact authority and daemon target for a Session-owned write RPC, or null
 * when the method is not an admitted Session write.
 */
export function resolveSocketRpcSessionWriteAuthorization(
  method: string,
): SocketRpcSessionWriteClassificationV1 | null {
  const normalized = resolveUnscopedSocketRpcMethod(String(method ?? '').trim());
  const rule = SOCKET_RPC_SESSION_WRITE_AUTHORIZATION.get(normalized) ?? null;
  return rule?.authority === 'readTranscript' ? null : rule;
}

export function resolveSocketRpcSessionWriteAuthorizationMethod(method: string): string | null {
  return resolveSocketRpcSessionWriteAuthorization(method)?.method ?? null;
}

/** The single closed Session RPC method-authorization map used by registration and dispatch. */
export function resolveSocketRpcSessionAuthorization(
  method: string,
): SocketRpcSessionWriteClassificationV1 | null {
  const normalized = resolveUnscopedSocketRpcMethod(String(method ?? '').trim());
  return SOCKET_RPC_SESSION_WRITE_AUTHORIZATION.get(normalized) ?? null;
}

/** Namespaces whose Session-scoped registration is closed by the map above. */
export function isSocketRpcSessionAuthorizationNamespace(method: string): boolean {
  const normalized = resolveUnscopedSocketRpcMethod(String(method ?? '').trim());
  return normalized.startsWith('session.')
    || normalized.startsWith('execution.run.')
    || normalized.startsWith('managedServer.endpoint.')
    || normalized.startsWith('transcript.');
}

/**
 * This includes the retained `permission` wire alias only so the server can
 * stamp the exact same account actor at the authenticated boundary. The daemon
 * still requires that stamp and does not grant actor authority to raw/local
 * callers.
 */
export function resolveSocketRpcSessionPermissionDecisionAuthorizationMethod(method: string): string | null {
  const rule = resolveSocketRpcSessionAuthorization(method);
  return rule?.serverMintedContext === 'session.permission.respond' ? rule.method : null;
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

export function isSocketRpcCurrentSessionPresentationOriginAuthorizationContext(
  value: unknown,
): value is SocketRpcCurrentSessionPresentationOriginAuthorizationContext {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as {
    kind?: unknown;
    sessionId?: unknown;
    accountId?: unknown;
    connectionId?: unknown;
  };
  const keys = Object.keys(candidate).sort();
  if (
    keys.length !== 4
    || keys[0] !== 'accountId'
    || keys[1] !== 'connectionId'
    || keys[2] !== 'kind'
    || keys[3] !== 'sessionId'
    || candidate.kind !== SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.CURRENT_SESSION_PRESENTATION_ORIGIN
  ) return false;
  return [candidate.sessionId, candidate.accountId, candidate.connectionId].every((field) => (
    typeof field === 'string'
    && field.trim().length > 0
    && field.length <= SOCKET_RPC_AUTHORIZATION_SESSION_ID_MAX_LENGTH
  ));
}

export function parseSocketRpcAuthorizationContext(value: unknown): SocketRpcSessionAuthorizationContext | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as { kind?: unknown; sessionId?: unknown; actor?: unknown };
  if (candidate.kind === SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.SESSION_ACTION) {
    const parsed = SocketRpcSessionActionAuthorizationContextSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  }
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
