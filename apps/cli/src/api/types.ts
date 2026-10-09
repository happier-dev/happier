import { z } from 'zod'
import { UsageSchema } from './usage'
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import type { SocketRpcRequestPayload as ProtocolSocketRpcRequestPayload } from '@happier-dev/protocol/socketRpc'
import { ACCEPTED_PENDING_SETTLEMENT_EVENT_V1 } from '@happier-dev/protocol/sessions/pending/acceptedPendingSettlementV1';
import { StoredMachinePublishedMetadataV1Schema, MachinePublishedDaemonStateV1Schema, MachinePublishedTransferListenerV1Schema, MachinePublishedTransferRuntimeV1Schema } from '@happier-dev/protocol/machines/machinePublishedContentV1';
import { CallerInputConstraintsV1Schema } from '@happier-dev/protocol/auth/callerInputConstraintsV1';
import { SESSION_PENDING_ADMISSION_SETTLEMENT_EVENT_V1 } from '@happier-dev/protocol/sessions/messages/sessionPendingAdmissionSettlementV1';
import { SESSION_PENDING_EXECUTION_RUN_MATERIALIZE_NEXT_EVENT_V2, SESSION_PENDING_EXECUTION_RUN_ACCEPTED_EVENT_V2, SESSION_PENDING_EXECUTION_RUN_BLOCK_EVENT_V2 } from '@happier-dev/protocol/sessions/messages/sessionPendingExecutionRunMachineAdmissionV2';
import { SentFromSchema } from '@happier-dev/protocol/sentFrom';
import type {
  AcceptedPendingSettlementRequestV1,
  AcceptedPendingSettlementResponseV1,
  AgentModelOptionOverrideRule,
  ContentPublicKeyFingerprint,
  ExecutionRunPublicState,
  MachineReplacementReason,
  MachineOperationProtocolCapabilitiesV1,
  PrimaryTurnStatusV1,
  SessionOwnerMetadataEnvelopeV1,
  SessionOwnerMetadataV1,
  SessionPendingAdmissionSettlementRequestV1,
  SessionPendingAdmissionSettlementResponseV1,
  SessionWorkspaceLocationV1,
  SessionDirectoryV1,
  SessionRuntimeActivitySnapshotAck,
  SessionRuntimeActivitySnapshotRequest,
  SessionTurnMutationV1,
  SessionOrganizationPlacementV1,
} from '@happier-dev/protocol'
import { ContentPublicKeyFingerprintSchema } from '@happier-dev/protocol/machines/identity/contentPublicKeyFingerprint';
import { MachineInstallationProofV1Schema, MachineInstallationPublicKeySchema } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { MachineReplacementReasonSchema } from '@happier-dev/protocol/machines/identity/machineReplacement';
import { SessionOrganizationPlacementV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import type {
  AcpConfigOptionOverridesV1,
  AcpSessionModeOverrideV1,
  ConnectedServiceBindingsV2,
  ExternalSessionsSource,
  ModelOverrideV1,
  SessionAppliedModelV1,
  SessionActiveModelSelectionV1,
  SessionModelSelectionIntentV1,
  RuntimeDescriptorMetadataCarrier,
  SessionRollbackRangesV1,
  SessionTerminalMetadata,
  SessionRunnerRuntimeStateV1,
  SessionUsageLimitRecoveryV1,
} from '@happier-dev/protocol'
import { SESSION_PERMISSION_MODES, createSessionPermissionModeSchema } from '@happier-dev/protocol/sessions/metadata/permission-modes';
import { SESSION_RUNNER_RUNTIME_METADATA_KEY } from '@happier-dev/protocol/sessions/control/sessionRunnerRuntimeV1';
import type { SessionIdentityAdditions } from '@happier-dev/protocol/sessions/identity/sessionBotV1';
import { SessionStoredMessageContentSchema } from '@happier-dev/protocol/sessions/messages/sessionStoredMessageContent';
import type { SessionStoredMessageContent } from '@happier-dev/protocol';
export { EphemeralUpdateSchema, MessageAckResponseSchema, SessionEndAckResponseSchema, UpdateMetadataAckResponseSchema, UpdateStateAckResponseSchema } from '@happier-dev/protocol/updates';

import { SessionBroadcastContainerSchema, UpdateBodySchema as ProtocolUpdateBodySchema, UpdateContainerSchema as ProtocolUpdateContainerSchema } from '@happier-dev/protocol/updates';
import type {
  EphemeralUpdate,
  MessageAckResponse,
  SessionEndAckResponse,
  SessionBroadcastContainer,
  UpdateBody as ProtocolUpdateBody,
  UpdateContainer as ProtocolUpdateContainer,
  UpdateMetadataAckResponse,
  UpdateStateAckResponse,
} from '@happier-dev/protocol/updates'

/**
 * Permission mode values - includes both Claude and Codex modes
 * Must match MessageMetaSchema.permissionMode enum values
 *
 * Claude modes: default, acceptEdits, bypassPermissions, plan
 * Codex modes: read-only, safe-yolo, yolo
 *
 * When calling Claude SDK, Codex modes are mapped at the SDK boundary:
 * - yolo → bypassPermissions
 * - safe-yolo → acceptEdits
 * - read-only → dontAsk
 */
export const PERMISSION_MODES = SESSION_PERMISSION_MODES

const CODEX_GEMINI_NON_DEFAULT_PERMISSION_MODES = ['read-only', 'safe-yolo', 'yolo'] as const
export const CODEX_GEMINI_PERMISSION_MODES = ['default', ...CODEX_GEMINI_NON_DEFAULT_PERMISSION_MODES] as const

export type PermissionMode = (typeof PERMISSION_MODES)[number]

export function isPermissionMode(value: string): value is PermissionMode {
  return PERMISSION_MODES.includes(value as PermissionMode)
}

export type CodexGeminiPermissionMode = (typeof CODEX_GEMINI_PERMISSION_MODES)[number]

export function isCodexGeminiPermissionMode(value: PermissionMode): value is CodexGeminiPermissionMode {
  return (CODEX_GEMINI_PERMISSION_MODES as readonly string[]).includes(value)
}

// Codex supports the Codex/Gemini subset, plus bypassPermissions as an alias for yolo/full access.
export const CODEX_PERMISSION_MODES = [
  'default',
  'read-only',
  'safe-yolo',
  'yolo',
  'bypassPermissions',
] as const

export type CodexPermissionMode = (typeof CODEX_PERMISSION_MODES)[number]

export function isCodexPermissionMode(value: PermissionMode): value is CodexPermissionMode {
  return (CODEX_PERMISSION_MODES as readonly string[]).includes(value)
}

/**
 * Usage data type from Claude
 */
export type Usage = z.infer<typeof UsageSchema>

/**
 * Session message content envelopes
 */
export const SessionMessageContentSchema = SessionStoredMessageContentSchema
export type SessionMessageContent = SessionStoredMessageContent

/**
 * Update events
 */
export const UpdateBodySchema: z.ZodType<ProtocolUpdateBody> =
  ProtocolUpdateBodySchema
export type UpdateBody = ProtocolUpdateBody

export const UpdateSchema: z.ZodType<ProtocolUpdateContainer> =
  ProtocolUpdateContainerSchema
export type Update = ProtocolUpdateContainer

export type UpdateMachineBody = Extract<Update['body'], { t: 'update-machine' }>

export const SessionBroadcastSchema = SessionBroadcastContainerSchema
export type SessionBroadcast = SessionBroadcastContainer

export type SocketRpcRequestPayload = ProtocolSocketRpcRequestPayload

export type SocketRpcCallPayload = SocketRpcRequestPayload

export interface SocketRpcCallResponse {
  ok: boolean
  result?: unknown
  error?: string
  errorCode?: string
}

/**
 * Socket events from server to client
 */
export interface ServerToClientEvents {
  update: (data: Update) => void
  session: (data: SessionBroadcast) => void
  'server:restarting': (data: { retryAfterMs?: number }) => void
  [SOCKET_RPC_EVENTS.REQUEST]: (data: SocketRpcRequestPayload, callback: (response: unknown) => void) => void
  [SOCKET_RPC_EVENTS.REGISTERED]: (data: { method: string }) => void
  [SOCKET_RPC_EVENTS.UNREGISTERED]: (data: { method: string }) => void
  [SOCKET_RPC_EVENTS.ERROR]: (data: { type: string, error: string }) => void
  ephemeral: (data: EphemeralUpdate) => void
  auth: (data: { success: boolean, user: string }) => void
  error: (data: { message: string }) => void
}


/**
 * Socket events from client to server
 */
export interface ClientToServerEvents {
  'machine-update-metadata': (
    data: import('@happier-dev/protocol/machines/metadataUpdate').MachineUpdateMetadataRequest,
    cb?: (answer: import('@happier-dev/protocol/machines/metadataUpdate').MachineUpdateMetadataResponse) => void,
  ) => void;
  [SESSION_PENDING_EXECUTION_RUN_MATERIALIZE_NEXT_EVENT_V2]: (
    data: import('@happier-dev/protocol').SessionPendingExecutionRunMaterializeNextRequestV2,
    cb?: (answer: import('@happier-dev/protocol').SessionPendingExecutionRunMaterializeNextResponseV2) => void,
  ) => void
  [SESSION_PENDING_EXECUTION_RUN_ACCEPTED_EVENT_V2]: (
    data: import('@happier-dev/protocol').SessionPendingExecutionRunAcceptedRequestV2,
    cb?: (answer: import('@happier-dev/protocol').SessionPendingExecutionRunAcceptedResponseV2) => void,
  ) => void
  [SESSION_PENDING_EXECUTION_RUN_BLOCK_EVENT_V2]: (
    data: import('@happier-dev/protocol').SessionPendingExecutionRunBlockRequestV2,
    cb?: (answer: import('@happier-dev/protocol').SessionPendingExecutionRunBlockResponseV2) => void,
  ) => void
  [SESSION_PENDING_ADMISSION_SETTLEMENT_EVENT_V1]: (
    data: SessionPendingAdmissionSettlementRequestV1,
    cb?: (answer: SessionPendingAdmissionSettlementResponseV1) => void
  ) => void
  [ACCEPTED_PENDING_SETTLEMENT_EVENT_V1]: (
    data: AcceptedPendingSettlementRequestV1,
    cb?: (answer: AcceptedPendingSettlementResponseV1) => void
  ) => void
  message: (
    data: { sid: string, message: string | SessionMessageContent, localId?: string | null, sidechainId?: string | null, messageRole?: 'user' | 'agent' | 'event' | 'unknown', echoToSender?: boolean },
    cb?: (answer: MessageAckResponse) => void
  ) => void
  'session-alive': (data: {
    sid: string;
    time: number;
    thinking: boolean;
    mode?: 'local' | 'remote';
    latestTurnStatus?: PrimaryTurnStatusV1;
    latestTurnStatusObservedAt?: number;
  }) => void
  'session-end': (data: { sid: string, time: number }, cb?: (answer: SessionEndAckResponse) => void) => void,
  'pending-materialize-next': (data: { sid: string; pendingVersion?: number; deliveryState?: 'provider'; deliveryTiming?: 'after_runtime_idle'; expectedRuntimeActivityRevision?: number }, cb?: (answer: {
    ok: boolean;
    didMaterialize?: boolean;
    didWrite?: boolean;
    pendingCount?: number;
    pendingBlockedCount?: number;
    pendingVersion?: number;
    deliveryState?: { mode?: string; unresolved?: boolean };
    message?: {
      id?: string | null;
      seq?: number | null;
      localId?: string;
      messageRole?: 'user' | 'agent' | 'event' | 'unknown' | null;
      content?: SessionMessageContent;
      deliveryState?: { mode?: string; unresolved?: boolean };
      createdAt?: number;
      updatedAt?: number;
    };
    error?: string;
    retryAfterMs?: number;
  }) => void) => void,
  'session-turn-mutation': (
    data: SessionTurnMutationV1,
    cb?: (answer: { ok?: boolean; result?: string; status?: string; error?: string; errorCode?: string; code?: string; message?: string }) => void
  ) => void,
  'session-runtime-activity-snapshot': (
    data: SessionRuntimeActivitySnapshotRequest,
    cb?: (answer: SessionRuntimeActivitySnapshotAck) => void
  ) => void,
  'execution-run-updated': (data: {
    sid: string;
    run: ExecutionRunPublicState;
  }) => void
  'transcript-stream-segment': (data: {
    sid: string;
    message: {
      localId: string;
      sidechainId?: string | null;
      messageRole?: 'user' | 'agent' | 'event' | 'unknown';
      /** Live-stream tick this full snapshot corresponds to (delta-chaining checkpoint anchor). */
      tick?: number;
      content: string | SessionMessageContent;
      createdAt: number;
      updatedAt: number;
    };
  }) => void
  'transcript-stream-segment-delta': (data: {
    sid: string;
    message: {
      localId: string;
      sidechainId?: string | null;
      messageRole?: 'user' | 'agent' | 'event' | 'unknown';
      /** Per-segment live emission sequence (1-based, includes snapshot emissions). */
      tick: number;
      /** Accumulated text length (UTF-16 code units) BEFORE applying this delta. */
      baseLength: number;
      content: string | SessionMessageContent;
      createdAt: number;
      updatedAt: number;
    };
  }) => void
  'update-metadata': (data: { sid: string, expectedVersion: number, metadata: string }, cb: (answer: UpdateMetadataAckResponse) => void) => void,
  'update-state': (data: {
    sid: string,
    expectedVersion: number,
    agentState: string | null,
    activitySummaryV1?: {
      pendingPermissionRequestCount: number,
      pendingUserActionRequestCount: number,
      pendingRequestNewestCreatedAt: number | null,
      ownerActivityDelivery?: 'rich_sender' | 'home_required',
      newUserActionRequiredOccurrences?: ReadonlyArray<{
        requestId: string,
        sourceTurnId: string,
        requestKind: 'permission' | 'user_action',
        occurredAt: number,
      }>,
    },
  }, cb: (answer: UpdateStateAckResponse) => void) => void,
  'update-read-cursor': (data: {
    sid: string,
    lastViewedSessionSeq?: number,
    operation?: 'mark-read' | 'mark-unread',
  }, cb: (answer: {
    result: 'success' | 'forbidden' | 'error',
    lastViewedSessionSeq?: number,
    didChange?: boolean,
    readState?: 'read' | 'unread' | 'empty',
  }) => void) => void,
  'ping': (callback: (response: unknown) => void) => void
  [SOCKET_RPC_EVENTS.REGISTER]: (data: { method: string }) => void
  [SOCKET_RPC_EVENTS.UNREGISTER]: (data: { method: string }) => void
  [SOCKET_RPC_EVENTS.CALL]: (data: SocketRpcCallPayload, callback: (response: SocketRpcCallResponse) => void) => void
  'usage-report': (data: {
    key: string
    sessionId: string
    tokens: {
      total: number
      [key: string]: number
    }
    cost: {
      total: number
      [key: string]: number
    }
  }) => void
}

/**
 * Session information
 */
type SessionSharedFields = Readonly<{
  id: string;
  reportsTo?: import('@happier-dev/protocol').SessionReportsToV1;
  origin?: import('@happier-dev/protocol').SessionAwarenessOriginV1;
  workDepth?: number;
  seq: number;
  initialTranscriptAfterSeq?: number;
  metadata: Metadata;
  metadataLayoutVersion?: number;
  ownerMetadata?: import('@happier-dev/protocol').SessionOwnerMetadataV1 | null;
  ownerMetadataEnvelope?: SessionOwnerMetadataEnvelopeV1 | null;
  metadataVersion: number;
  agentState: AgentState | null;
  agentStateVersion: number;
  pendingCount?: number;
  pendingBlockedCount?: number;
  pendingVersion?: number;
  pendingExecutionRunIds?: readonly string[];
  latestTurnStatus?: PrimaryTurnStatusV1 | null;
  latestTurnStatusObservedAt?: number | null;
  runtimeActivityState?: 'active' | 'idle' | 'unknown';
  runtimeActivityActiveCount?: number;
  runtimeActivityObservedAt?: number | null;
  runtimeActivityRevision?: number;
}>;

export type Session =
  | (SessionSharedFields & Readonly<{ encryptionMode: 'plain' }>)
  | (SessionSharedFields & Readonly<{ encryptionMode: 'e2ee'; encryptionKey: Uint8Array; encryptionVariant: 'legacy' | 'dataKey' }>);

/**
 * Exact response facts from the current `POST /v1/sessions` create-or-load
 * transaction. They are attached only to the immediate create result and are
 * intentionally not persisted as ordinary Session state.
 */
export type SessionCreationOutcome = Readonly<{
  disposition: 'created' | 'rejoined';
  organizationPlacement: SessionOrganizationPlacementV1;
}>;

export type SessionCreateOrLoadResult = Session & Readonly<{
  sessionCreationOutcome?: SessionCreationOutcome;
}>;

/**
 * Machine metadata - static information (rarely changes)
 */
export const MachineMetadataSchema = StoredMachinePublishedMetadataV1Schema;

export type MachineMetadata = z.infer<typeof MachineMetadataSchema>

export const MachineRegistrationIdentitySchema = z.object({
  installationId: z.string().trim().min(1),
  installationPublicKey: MachineInstallationPublicKeySchema,
  installationProof: MachineInstallationProofV1Schema,
  replacesMachineId: z.string().trim().min(1).optional(),
  replacementReason: MachineReplacementReasonSchema.optional(),
  contentPublicKeyFingerprint: ContentPublicKeyFingerprintSchema.optional(),
  replacementCandidateAccountId: z.string().trim().min(1).optional(),
})

export type MachineRegistrationIdentity = Readonly<
  Omit<z.infer<typeof MachineRegistrationIdentitySchema>, 'replacementReason' | 'contentPublicKeyFingerprint'>
  & {
    replacementReason?: MachineReplacementReason
    contentPublicKeyFingerprint?: ContentPublicKeyFingerprint
  }
>

/**
 * Daemon transfer runtime capability state - dynamic listener and direct-transfer metadata
 * published by the daemon into machine state.
 */
export const DaemonTransferListenerStateSchema = MachinePublishedTransferListenerV1Schema;

export type DaemonTransferListenerState = z.infer<typeof DaemonTransferListenerStateSchema>

export const DaemonTransferRuntimeStateSchema = MachinePublishedTransferRuntimeV1Schema;

export type DaemonTransferRuntimeState = z.infer<typeof DaemonTransferRuntimeStateSchema>

/**
 * Daemon state - dynamic runtime information (frequently updated)
 */
export const DaemonStateSchema = MachinePublishedDaemonStateV1Schema;

export type DaemonState = z.infer<typeof DaemonStateSchema>

type MachineCommon = {
  id: string,
  installationId?: string | null,
  active?: boolean,
  revokedAt?: number | null,
  replacedByMachineId?: string | null,
  dataEncryptionKey?: string | null,
  keyBasis?: import('@happier-dev/protocol/machines/machineContentKeyTransitionV1').MachineKeyBasisV1,
  access?: import('@happier-dev/protocol/machines/machineAccessV1').AccessibleMachineAccessV1,
  metadata: MachineMetadata | null,
  metadataVersion: number,
  daemonState: DaemonState | null,
  daemonStateVersion: number,
  /**
   * Complete content-free projection from the exact authenticated Machine.
   * Missing/malformed/revoked/replaced snapshots are represented as null.
   */
  operationProtocolCapabilities?: MachineOperationProtocolCapabilitiesV1 | null,
  operationProtocolCapabilitiesRevision?: number | null,
}

export type Machine = MachineCommon & (
  | Readonly<{
      encryptionMode: 'plain';
      encryptionKey?: never;
      encryptionVariant?: never;
    }>
  | Readonly<{
      encryptionMode?: 'e2ee';
      encryptionKey: Uint8Array;
      encryptionVariant: 'legacy' | 'dataKey';
    }>
)

/**
 * Session message from API
 */
export const SessionMessageSchema = z.object({
  content: SessionMessageContentSchema,
  createdAt: z.number(),
  id: z.string(),
  localId: z.string().nullable(),
  seq: z.number(),
  sidechainId: z.string().nullable(),
  updatedAt: z.number()
}).passthrough()

export type SessionMessage = z.infer<typeof SessionMessageSchema>

/**
 * Message metadata schema
 */
export const MessageMetaSchema = z.object({
  sentFrom: SentFromSchema.optional(), // Source identifier
  /**
   * High-level origin of the message. This is used to prevent reliability features
   * (ACK, retries, local mirroring) from accidentally turning self-sent CLI writes
   * into inbound "user prompt" events.
   *
   * Forward-compatible: unknown strings are allowed.
   */
  source: z.union([z.enum(['cli', 'ui']), z.string()]).optional(),
  permissionMode: createSessionPermissionModeSchema(z).optional(), // Permission mode for this message
  model: z.string().nullable().optional(), // Model name for this message (null = reset)
  fallbackModel: z.string().nullable().optional(), // Fallback model for this message (null = reset)
  customSystemPrompt: z.string().nullable().optional(), // Custom system prompt for this message (null = reset)
  appendSystemPrompt: z.string().nullable().optional(), // Append to system prompt for this message (null = reset)
  allowedTools: z.array(z.string()).nullable().optional(), // Allowed tools for this message (null = reset)
  disallowedTools: z.array(z.string()).nullable().optional() // Disallowed tools for this message (null = reset)
}).passthrough()

export type MessageMeta = z.infer<typeof MessageMetaSchema>

/**
 * API response types
 */
export const CreateSessionResponseSchema = z.object({
  created: z.boolean().optional(),
  organizationPlacement: SessionOrganizationPlacementV1Schema.optional(),
  session: z.object({
    id: z.string(),
    tag: z.string(),
    seq: z.number(),
    createdAt: z.number(),
    updatedAt: z.number(),
    metadata: z.string(),
    metadataVersion: z.number(),
    agentState: z.string().nullable(),
    agentStateVersion: z.number(),
    dataEncryptionKey: z.string().nullable().optional(),
  }).passthrough(),
})

export type CreateSessionResponse = z.infer<typeof CreateSessionResponseSchema>

export const UserMessageSchema = z.object({
  callerInputConstraints: CallerInputConstraintsV1Schema.optional(),
  role: z.literal('user'),
  content: z.object({
    type: z.literal('text'),
    text: z.string()
  }).passthrough(),
  /**
   * Server-created timestamp for this message (ms since epoch).
   *
   * This is *not* part of the encrypted message body; it is attached by the transport layer
   * so consumers (CLI backends) can make timestamped precedence decisions (e.g. permissions).
   */
  createdAt: z.number().optional(),
  localId: z.string().nullish().optional(),
  localKey: z.string().optional(), // Mobile messages include this
  meta: MessageMetaSchema.optional()
}).passthrough()

export type UserMessage = z.infer<typeof UserMessageSchema>

export const AgentMessageSchema = z.object({
  role: z.literal('agent'),
  content: z.object({
    type: z.literal('output'),
    data: z.any()
  }).passthrough(),
  meta: MessageMetaSchema.optional()
}).passthrough()

export type AgentMessage = z.infer<typeof AgentMessageSchema>

export const MessageContentSchema = z.union([UserMessageSchema, AgentMessageSchema])

export type MessageContent = z.infer<typeof MessageContentSchema>

export type ExternalSessionMetadataV1 = Readonly<Partial<RuntimeDescriptorMetadataCarrier>> & {
  v: 1,
  agentId: string,
  machineId: string,
  remoteSessionId: string,
  source: ExternalSessionsSource,
  linkedAtMs: number,
  lastKnownActivityAtMs?: number,
  followPolicyV1?: {
    v: 1,
    policy: 'attached_only' | 'background_follow',
    updatedAtMs: number,
  },
  externalSessionAttentionV1?: {
    v: 1,
    observedProgressToken?: string,
    viewedProgressToken?: string,
    observedAtMs?: number,
    viewedAtMs?: number,
  },
};

export type ExternalHistoryImportMetadataV1 = {
  v: 1,
  agentId: string,
  remoteSessionId: string,
  importedAtMs: number,
  source: ExternalSessionsSource,
};

export type SessionHandoffMetadataV1 = {
  v: 1,
  sourceMachineId: string,
  targetMachineId: string,
  agentId: string,
  sessionStorageBefore: 'direct' | 'persisted',
  sessionStorageAfter: 'direct' | 'persisted',
  transportStrategy: 'direct_peer' | 'server_routed_stream',
  completedAtMs: number,
  sourceWorkspaceRootPath?: string,
  targetWorkspaceRootPath?: string,
};

/**
 * Producer-declared override rule carried on a boolean model/config option: while that option
 * is effectively on, `optionIds` are not user-controllable and (when `forcedValue` is present)
 * actually run at that value.
 *
 * This is the protocol type itself, not a hand-kept mirror: the rule is authored by an agent
 * plugin and must reach persisted metadata byte-identical, so every threading point on that
 * path shares one shape.
 */
export type SessionOptionOverrideRuleV1 = AgentModelOptionOverrideRule;

export type Metadata = Readonly<Partial<RuntimeDescriptorMetadataCarrier>> & Readonly<SessionIdentityAdditions> & {
  path: string,
  host: string,
  version?: string,
  name?: string,
  os?: string,
  /**
   * Terminal/attach metadata for this Happy session (non-secret).
   * Used by the UI (Session Details) and CLI attach flows.
   */
  terminal?: SessionTerminalMetadata,
  /**
   * Session-scoped profile identity (non-secret).
   * Used for display/debugging across devices; runtime behavior is still driven by env vars at spawn.
   * Null indicates "no profile".
   */
  profileId?: string | null,
  summary?: {
    text: string,
    updatedAt: number
  },
  machineId?: string,
  sessionWorkspaceLocationV1?: SessionWorkspaceLocationV1,
  /** Presentation/routing marker; managed filesystem ownership remains daemon-owned. */
  sessionDirectoryV1?: SessionDirectoryV1,
  /** Immutable create-or-rejoin recipe supplied only by the Session creation owner. */
  sessionCreationCorrespondenceV1?: import('@happier-dev/protocol').SessionCreationCorrespondenceV1,
  /** Informational creation origin; never execution authority. */
  placementOrigin?: import('@happier-dev/protocol').MachinePoolSelectionOriginV1,
  /** Durable connected-service generation reconciliation state; parsed fail-closed by its owner. */
  connectedServicePendingAuthGroupGenerationsV1?: unknown,
  locallyConsumedUserMessageSeqsV1?: number[],
  claudeSessionId?: string, // Claude Code session ID
  claudeTranscriptPath?: string | null, // Claude Code transcript path (hooks)
  claudeLastCheckpointId?: string | null, // Claude SDK file checkpoint UUID (remote)
  claudeLastAssistantUuid?: string | null, // Legacy Claude SDK assistant message UUID metadata (not used for normal resume)
  codexSessionId?: string, // Codex session/conversation ID (uuid)
  geminiSessionId?: string, // Gemini ACP session ID (opaque)
  grokSessionId?: string, // Grok ACP session ID (opaque)
  opencodeSessionId?: string, // OpenCode ACP session ID (opaque)
  opencodeBackendMode?: 'server' | 'acp',
  opencodeServerBaseUrl?: string,
  opencodeServerBaseUrlExplicit?: true,
  externalSessionV1?: ExternalSessionMetadataV1,
  externalHistoryImportV1?: ExternalHistoryImportMetadataV1,
  handoffV1?: SessionHandoffMetadataV1,
  auggieSessionId?: string, // Auggie ACP session ID (opaque)
  qwenSessionId?: string, // Qwen Code ACP session ID (opaque)
  kimiSessionId?: string, // Kimi ACP session ID (opaque)
  kiloSessionId?: string, // Kilo ACP session ID (opaque)
  kiroSessionId?: string, // Kiro ACP session ID (opaque)
  devinSessionId?: string, // Devin ACP session ID (opaque)
  ohMyPiSessionId?: string, // oh-my-pi ACP session ID (opaque)
  piSessionId?: string, // Pi RPC session ID (opaque)
  copilotSessionId?: string, // Copilot ACP session ID (opaque)
  auggieAllowIndexing?: boolean, // Auggie indexing enablement (spawn-time)
  tools?: string[],
  slashCommands?: string[],
  slashCommandDetails?: Array<{
    command: string,
    description?: string
  }>,
  acpHistoryImportV1?: {
    v: 1,
    agentId: 'gemini' | 'codex' | 'opencode' | string,
    remoteSessionId: string,
    importedAt: number,
    lastImportedFingerprint?: string
  },
  acpTransportV1?: {
    v: 1,
    agentId: string
  },
  /**
   * ACP session modes (if supported by the provider's ACP agent).
   *
   * Used to expose provider-native "plan/code" style runtime modes to the UI.
   */
  acpSessionModesV1?: {
    v: 1,
    agentId: string,
    updatedAt: number,
    currentModeId: string,
    availableModes: Array<{
      id: string,
      name: string,
      description?: string,
    }>,
  },
  sessionModesV1?: {
    v: 1,
    agentId: string,
    updatedAt: number,
    currentModeId: string,
    availableModes: Array<{
      id: string,
      name: string,
      description?: string,
    }>,
  },
  sessionModesV2?: import('@happier-dev/protocol').SessionOwnerModeCatalogV2,
  sessionUsageLimitRecoveryV1?: SessionUsageLimitRecoveryV1,
  [SESSION_RUNNER_RUNTIME_METADATA_KEY]?: SessionRunnerRuntimeStateV1,
  /**
   * ACP session models (if supported by the provider's ACP agent).
   *
   * Used to expose provider-native model selection to the UI.
   *
   * NOTE: This is an UNSTABLE ACP feature and may be unsupported by some agents.
   */
  acpSessionModelsV1?: {
    v: 1,
    agentId: string,
    updatedAt: number,
    currentModelId: string,
    availableModels: Array<{
      id: string,
      name: string,
      description?: string,
      contextWindowTokens?: number,
      extendedContextModelId?: string,
      modelOptions?: Array<{
        id: string,
        name: string,
        description?: string,
        type: string,
        currentValue: string | number | boolean | null,
        options?: Array<{
          value: string | number | boolean | null,
          name: string,
          description?: string,
        }>,
        overridesWhenOn?: SessionOptionOverrideRuleV1,
      }>,
    }>,
  },
  sessionModelsV1?: {
    v: 1,
    agentId: string,
    updatedAt: number,
    currentModelId: string,
    activeSelectionV1?: SessionActiveModelSelectionV1,
    availableModels: Array<{
      id: string,
      name: string,
      description?: string,
      contextWindowTokens?: number,
      extendedContextModelId?: string,
      modelOptions?: Array<{
        id: string,
        name: string,
        description?: string,
        type: string,
        currentValue: string | number | boolean | null,
        options?: Array<{
          value: string | number | boolean | null,
          name: string,
          description?: string,
        }>,
        overridesWhenOn?: SessionOptionOverrideRuleV1,
      }>,
    }>,
  },
  /**
   * ACP session configuration options (if supported by the provider's ACP agent).
   *
   * Used to expose provider-native runtime configuration controls to the UI.
   */
  acpConfigOptionsV1?: {
    v: 1,
    agentId: string,
    updatedAt: number,
    configOptions: Array<{
      id: string,
      name: string,
      description?: string,
      type: string,
      currentValue: string | number | boolean | null,
      options?: Array<{
        value: string | number | boolean | null,
        name: string,
        description?: string,
      }>,
      overridesWhenOn?: SessionOptionOverrideRuleV1,
    }>,
  },
  sessionConfigOptionsV1?: {
    v: 1,
    agentId: string,
    updatedAt: number,
    configOptions: Array<{
      id: string,
      name: string,
      description?: string,
      type: string,
      currentValue: string | number | boolean | null,
      options?: Array<{
        value: string | number | boolean | null,
        name: string,
        description?: string,
      }>,
      overridesWhenOn?: SessionOptionOverrideRuleV1,
    }>,
  },
  /**
   * Desired ACP session mode override selected by the user (UI/CLI).
   *
   * Distinct from `acpSessionModesV1` (which mirrors agent-reported current state).
   */
  acpSessionModeOverrideV1?: AcpSessionModeOverrideV1,
  sessionModeOverrideV1?: AcpSessionModeOverrideV1,
  /**
   * Desired ACP configuration option overrides selected by the user (UI/CLI).
   *
   * This is a best-effort mechanism to keep ACP "configOptions" selections consistent across devices.
   */
  acpConfigOptionOverridesV1?: AcpConfigOptionOverridesV1,
  sessionConfigOptionOverridesV1?: AcpConfigOptionOverridesV1,
  homeDir: string,
  happyHomeDir: string,
  happyLibDir: string,
  happyToolsDir: string,
  startedFromDaemon?: boolean,
  hostPid?: number,
  sessionLogPath?: string,
  startedBy?: 'daemon' | 'terminal',
  // Lifecycle state management
  lifecycleState?: 'running' | 'archiveRequested' | 'archived' | string,
  lifecycleStateSince?: number,
  archivedBy?: string,
  archiveReason?: string,
  flavor?: string,
  /**
   * Current permission mode for the session, published by the CLI so the app can seed UI state
   * even when there are no user messages carrying meta.permissionMode yet (e.g. local-only start).
   */
  permissionMode?: PermissionMode,
  approvalReviewerEnabled?: boolean,
  /** Owner-only work metadata; role content never projects into shared metadata. */
  work?: SessionOwnerMetadataV1['work'],
  /** Timestamp (ms) for permissionMode, used for "latest wins" arbitration across devices. */
  permissionModeUpdatedAt?: number,
  sessionRollbackRangesV1?: SessionRollbackRangesV1,
  /**
   * Session-scoped connected-service auth binding selected for this agent.
   *
   * Non-secret; spawn paths use this to rematerialize the correct account/group across
   * forks, resumes, and runtime-auth recovery.
   */
  connectedServices?: ConnectedServiceBindingsV2,
  connectedServicesUpdatedAt?: number,
  /**
   * Desired model override selected by the user (UI/CLI), if supported by the agent.
   *
   * This is session-scoped and should be applied by runners in a capability-driven way
   * (some agents support live model switching; others may require a new session).
   */
  modelOverrideV1?: ModelOverrideV1,
  modelSelectionIntentV1?: SessionModelSelectionIntentV1,
  sessionAppliedModelV1?: SessionAppliedModelV1,
};

/**
 * Reason class for "cannot steer the in-flight turn right now" (Seam A):
 * - `backend_unsupported`: the runtime/backend never supports in-flight steering.
 * - `unsafe_window`: steering is supported but the current window cannot accept a steer
 *   (Codex steer-context mismatch, Claude screen veto / composer-not-ready, ACP between turns).
 * - `turn_settling`: the turn is ending / in a stale-recovery window (canonical turn inactive).
 * - `user_terminal_draft`: steering is starved by a draft sitting in the terminal composer —
 *   published after the bounded starvation escalation (X1).
 */
export type InFlightSteerUnavailableReason = 'backend_unsupported' | 'unsafe_window' | 'turn_settling' | 'user_terminal_draft';

export type AgentState = {
  controlledByUser?: boolean | null | undefined
  localControl?: {
    attached?: boolean | null | undefined
    topology?: 'exclusive' | 'shared' | null | undefined
    remoteWritable?: boolean | null | undefined
    canAttach?: boolean | null | undefined
    canDetach?: boolean | null | undefined
  } | null | undefined
  capabilities?: {
    askUserQuestionAnswersInPermission?: boolean | null | undefined
    inFlightSteer?: boolean | null | undefined
    inFlightSteerSupported?: boolean | null | undefined
    inFlightSteerAvailable?: boolean | null | undefined
    /**
     * Why in-flight steering is currently unavailable (Seam A). Present only when
     * `inFlightSteerAvailable === false`; absence means an older CLI (back-compat by optionality).
     */
    inFlightSteerUnavailableReason?: InFlightSteerUnavailableReason | null | undefined
    /** Timestamp (ms) of the last steerability evaluation — staleness guard for the UI. */
    inFlightSteerStateAt?: number | null | undefined
    /** Whether the provider terminal currently contains an unsent user draft. */
    terminalComposerDraftPresent?: boolean | null | undefined
    /** Whether this runtime can clear its provider terminal composer on explicit user request. */
    terminalComposerClearSupported?: boolean | null | undefined
    /** Session-scoped goal operations currently registered by the attached runner. */
    sessionGoalSetSupported?: boolean | null | undefined
    sessionGoalClearSupported?: boolean | null | undefined
    pendingInputInterruptAndRunLocalId?: string | null | undefined
    pendingInputInterruptAndRunStateAt?: number | null | undefined
    /** Whether permission-intent updates can be applied to the active provider turn. */
    inFlightConfigApplySupported?: boolean | null | undefined
    localPermissionBridgeInLocalMode?: boolean | null | undefined
  } | null | undefined
      requests?: {
        [id: string]: {
          tool: string,
        /**
         * Categorizes pending agent requests for UI/notifications.
         *
         * - `permission`: classic tool approval prompts (Bash/Edit/etc)
         * - `user_action`: structured user input prompts (AskUserQuestion/ExitPlanMode/etc)
         */
          kind?: 'permission' | 'user_action' | string,
          arguments: any,
          createdAt: number
          /** Exact host-stamped parent turn that owns this request. */
          turnId?: string
          /**
           * Optional provider-provided permission suggestions for this request.
           * (e.g. Claude Agent SDK `permission_suggestions`).
           */
          permissionSuggestions?: unknown
          /**
           * Optional response forwarding target for host-owned permission routers.
           * The store treats the kind as provider-neutral routing metadata.
           */
          responseTarget?: { kind: string, [key: string]: unknown }
          /** Optional subagent/run reference carried for later permission routers. */
          subagentRef?: unknown
          /** Optional sidechain identifier carried for later permission routers. */
          sidechainId?: string
          /** Optional request source identifier for host-side correlation. */
          source?: string
          /**
           * Timestamp (ms) when a push notification was sent for this permission request.
           * Used to avoid duplicate notifications across restarts/resumes.
           */
          pushNotifiedAt?: number
          /**
           * Private, outstanding-only first-answer-wins permission claim.
           * The request store validates and clears this before terminal state
           * is projected; callers must treat it as opaque.
           */
          permissionResponseClaimV1?: unknown
        }
      }
      completedRequests?: {
        [id: string]: {
        tool: string,
        kind?: 'permission' | 'user_action' | string,
        arguments: any,
        createdAt: number,
        completedAt: number,
        status: 'canceled' | 'denied' | 'approved',
      reason?: string,
      mode?: PermissionMode,
        decision?: 'approved' | 'approved_for_session' | 'approved_execpolicy_amendment' | 'denied' | 'abort',
        allowedTools?: string[]
        allowTools?: string[] // legacy alias
        updatedPermissions?: unknown
        responseTarget?: { kind: string, [key: string]: unknown }
        subagentRef?: unknown
        sidechainId?: string
        source?: string
        permissionSuggestions?: unknown
        /**
         * Bounded host-stamped present-user settlement identity. The permission
         * request owner validates this opaque field before permitting a retry
         * to rejoin a completed request.
         */
        permissionDecisionActorV1?: unknown
        /** Strict request-only reviewer decision, retained after the outstanding claim clears. */
        permissionDecisionClaimV1?: import('@happier-dev/protocol').SessionPermissionApprovalReviewerClaimV1
        /** Non-authorizing pointer to the remote settlement row, when present. */
        remoteMediationSettlementId?: string
      }
    }
  }
