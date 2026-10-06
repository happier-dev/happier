import type { RPC_METHODS } from './methods.js';

export {
  DaemonPluginSettingsWatchRequestSchema,
  DaemonPluginSettingsWatchResponseSchema,
  type DaemonPluginSettingsWatchRequest,
  type DaemonPluginSettingsWatchResponse,
} from '../daemon/contributionRegistryProjection.js';

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

export {
  RPC_ERROR_CODES,
  RPC_ERROR_MESSAGES,
  isRpcMethodNotFoundResult,
  type RpcErrorCode,
} from './errors.js';

export {
  SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS,
  type SocketRpcAuthorizationContextKind,
  type SocketRpcSessionWriteAuthorizationContext,
  type SocketRpcSessionPermissionRespondAuthorizationContext,
  type SocketRpcAutomationReplyHandoffServerOriginAuthorizationContext,
  type SocketRpcSessionServerStartServerOriginAuthorizationContext,
  type SocketRpcActionApiServerOriginAuthorizationContext,
  type SocketRpcCurrentSessionPresentationOriginAuthorizationContext,
  ACTION_API_SERVER_ORIGIN,
  type SocketRpcSessionAuthorizationContext,
  type SocketRpcAuthorizationContext,
  type SocketRpcSessionWriteAuthorityV1,
  type SocketRpcSessionWriteClassificationV1,
  API_TOKEN_SOCKET_EVENT_ACTIONS,
  resolveSocketRpcSessionWriteAuthorization,
  resolveSocketRpcSessionWriteAuthorizationMethod,
  resolveSocketRpcSessionAuthorization,
  isSocketRpcSessionAuthorizationNamespace,
  resolveSocketRpcSessionPermissionDecisionAuthorizationMethod,
  resolveSocketRpcProviderStartingMethod,
  isSocketRpcAutomationReplyHandoffServerOriginAuthorizationContext,
  isSocketRpcSessionServerStartServerOriginAuthorizationContext,
  isSocketRpcActionApiServerOriginAuthorizationContext,
  isSocketRpcCurrentSessionPresentationOriginAuthorizationContext,
  parseSocketRpcAuthorizationContext,
} from './socket.js';
