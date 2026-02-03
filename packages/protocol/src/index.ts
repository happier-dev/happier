export const HAPPY_PROTOCOL_PACKAGE = '@happier-dev/protocol';

export { SPAWN_SESSION_ERROR_CODES, type SpawnSessionErrorCode, type SpawnSessionResult } from './spawnSession.js';
export {
  RPC_ERROR_CODES,
  RPC_ERROR_MESSAGES,
  RPC_METHODS,
  isRpcMethodNotFoundResult,
  type RpcErrorCode,
  type RpcMethod,
} from './rpc.js';
export { CHECKLIST_IDS, resumeChecklistId, type ChecklistId } from './checklists.js';
export { SOCKET_RPC_EVENTS, type SocketRpcEvent } from './socketRpc.js';
export {
  ChangeEntrySchema,
  ChangeKindSchema,
  ChangesResponseSchema,
  CursorGoneErrorSchema,
  type ChangeEntry,
  type ChangeKind,
  type ChangesResponse,
  type CursorGoneError,
} from './changes.js';
export {
  type CapabilitiesDescribeResponse,
  type CapabilitiesDetectRequest,
  type CapabilitiesDetectResponse,
  type CapabilitiesInvokeRequest,
  type CapabilitiesInvokeResponse,
  type CapabilityDescriptor,
  type CapabilityDetectRequest,
  type CapabilityDetectResult,
  type CapabilityId,
  type CapabilityKind,
} from './capabilities.js';

export {
  EphemeralUpdateSchema,
  MessageAckResponseSchema,
  SessionBroadcastBodySchema,
  SessionBroadcastContainerSchema,
  UpdateBodySchema,
  UpdateContainerSchema,
  UpdateMetadataAckResponseSchema,
  UpdateStateAckResponseSchema,
  type EphemeralUpdate,
  type MessageAckResponse,
  type SessionBroadcastBody,
  type SessionBroadcastContainer,
  type UpdateBody,
  type UpdateContainer,
  type UpdateMetadataAckResponse,
  type UpdateStateAckResponse,
} from './updates.js';

// Tool normalization (V2)
export * from './tools/v2/index.js';
