import type { RPC_METHODS } from './methods.js';
import type { WorkspaceAddressV2 } from '../workspaces/workspaceRefV1.js';

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

/** A workspace caller addresses its root; incumbent callers may stat an unscoped path. */
export type WorkspaceStatFileRequestV1 = Readonly<{
  path: string;
  rootPath?: string;
  includeContentHash?: boolean;
}>;

/** Older stat handlers require a top-level path, so a managed request fails closed there. */
export type WorkspaceStatFileRequestV2 = Readonly<{
  workspace: Extract<WorkspaceAddressV2, { kind: 'managed' }>;
  file: Omit<WorkspaceStatFileRequestV1, 'rootPath'>;
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
  MACHINE_ACCESS_LOSS_SERVER_ORIGIN,
  LOCAL_SERVICES_PREVIEW_ADMISSION_SERVER_ORIGIN,
  SOCKET_RPC_SERVER_ORIGIN_MACHINE_READ_METHODS,
  SocketRpcMachineReadServerOriginAuthorizationContextV1Schema,
  type SocketRpcMachineReadServerOriginAuthorizationContextV1,
  isSocketRpcMachineReadServerOriginAuthorizationContext,
  type SocketRpcLocalServicesPreviewAdmissionServerOriginAuthorizationContext,
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
  isSocketRpcLocalServicesPreviewAdmissionServerOriginAuthorizationContext,
  isSocketRpcCurrentSessionPresentationOriginAuthorizationContext,
  parseSocketRpcAuthorizationContext,
} from './socket.js';
