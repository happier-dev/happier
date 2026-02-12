import { z } from 'zod'
import { UsageSchema } from '@/api/usage'
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc'
import { SentFromSchema } from '@happier-dev/protocol'

export {
  EphemeralUpdateSchema,
  MessageAckResponseSchema,
  UpdateMetadataAckResponseSchema,
  UpdateStateAckResponseSchema,
} from '@happier-dev/protocol/updates'

import {
  SessionBroadcastContainerSchema,
  UpdateBodySchema as ProtocolUpdateBodySchema,
  UpdateContainerSchema as ProtocolUpdateContainerSchema,
} from '@happier-dev/protocol/updates'
import type {
  EphemeralUpdate,
  MessageAckResponse,
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
 * - safe-yolo → default
 * - read-only → default
 */
const CODEX_GEMINI_NON_DEFAULT_PERMISSION_MODES = ['read-only', 'safe-yolo', 'yolo'] as const
export const CODEX_GEMINI_PERMISSION_MODES = ['default', ...CODEX_GEMINI_NON_DEFAULT_PERMISSION_MODES] as const

const CLAUDE_ONLY_PERMISSION_MODES = ['acceptEdits', 'bypassPermissions', 'plan'] as const

// Keep stable ordering for readability/help text:
// default, claude-only, then codex/gemini-only.
export const PERMISSION_MODES = [
  'default',
  ...CLAUDE_ONLY_PERMISSION_MODES,
  ...CODEX_GEMINI_NON_DEFAULT_PERMISSION_MODES,
] as const

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
 * Base message content structure for encrypted messages
 */
export const SessionMessageContentSchema = z.object({
  c: z.string(), // Base64 encoded encrypted content
  t: z.literal('encrypted')
})

export type SessionMessageContent = z.infer<typeof SessionMessageContentSchema>

/**
 * Update events
 */
export const UpdateBodySchema = ProtocolUpdateBodySchema
export type UpdateBody = ProtocolUpdateBody

export const UpdateSchema = ProtocolUpdateContainerSchema
export type Update = ProtocolUpdateContainer

export type UpdateMachineBody = Extract<Update['body'], { t: 'update-machine' }>

export const SessionBroadcastSchema = SessionBroadcastContainerSchema
export type SessionBroadcast = SessionBroadcastContainer

/**
 * Socket events from server to client
 */
export interface ServerToClientEvents {
  update: (data: Update) => void
  session: (data: SessionBroadcast) => void
  [SOCKET_RPC_EVENTS.REQUEST]: (data: { method: string, params: string }, callback: (response: string) => void) => void
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
  message: (
    data: { sid: string, message: any, localId?: string | null },
    cb?: (answer: MessageAckResponse) => void
  ) => void
  'session-alive': (data: {
    sid: string;
    time: number;
    thinking: boolean;
    mode?: 'local' | 'remote';
  }) => void
  'session-end': (data: { sid: string, time: number }) => void,
  'update-metadata': (data: { sid: string, expectedVersion: number, metadata: string }, cb: (answer: UpdateMetadataAckResponse) => void) => void,
  'update-state': (data: { sid: string, expectedVersion: number, agentState: string | null }, cb: (answer: UpdateStateAckResponse) => void) => void,
  'ping': (callback: () => void) => void
  [SOCKET_RPC_EVENTS.REGISTER]: (data: { method: string }) => void
  [SOCKET_RPC_EVENTS.UNREGISTER]: (data: { method: string }) => void
  [SOCKET_RPC_EVENTS.CALL]: (data: { method: string, params: string }, callback: (response: {
    ok: boolean
    result?: string
    error?: string
  }) => void) => void
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
export type Session = {
  id: string,
  seq: number,
  encryptionKey: Uint8Array;
  encryptionVariant: 'legacy' | 'dataKey';
  metadata: Metadata,
  metadataVersion: number,
  agentState: AgentState | null,
  agentStateVersion: number,
}

/**
 * Machine metadata - static information (rarely changes)
 */
export const MachineMetadataSchema = z.object({
  host: z.string(),
  platform: z.string(),
  happyCliVersion: z.string(),
  homeDir: z.string(),
  happyHomeDir: z.string(),
  happyLibDir: z.string()
})

export type MachineMetadata = z.infer<typeof MachineMetadataSchema>

/**
 * Daemon state - dynamic runtime information (frequently updated)
 */
export const DaemonStateSchema = z.object({
  status: z.union([
    z.enum(['running', 'shutting-down']),
    z.string() // Forward compatibility
  ]),
  pid: z.number().optional(),
  httpPort: z.number().optional(),
  startedAt: z.number().optional(),
  shutdownRequestedAt: z.number().optional(),
  shutdownSource:
    z.union([
      z.enum(['mobile-app', 'cli', 'os-signal', 'unknown']),
      z.string() // Forward compatibility
    ]).optional()
})

export type DaemonState = z.infer<typeof DaemonStateSchema>

export type Machine = {
  id: string,
  encryptionKey: Uint8Array;
  encryptionVariant: 'legacy' | 'dataKey';
  metadata: MachineMetadata | null,
  metadataVersion: number,
  daemonState: DaemonState | null,
  daemonStateVersion: number,
}

/**
 * Session message from API
 */
export const SessionMessageSchema = z.object({
  content: SessionMessageContentSchema,
  createdAt: z.number(),
  id: z.string(),
  seq: z.number(),
  updatedAt: z.number()
})

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
  permissionMode: z.enum(PERMISSION_MODES).optional(), // Permission mode for this message
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
  session: z.object({
    id: z.string(),
    tag: z.string(),
    seq: z.number(),
    createdAt: z.number(),
    updatedAt: z.number(),
    metadata: z.string(),
    metadataVersion: z.number(),
    agentState: z.string().nullable(),
    agentStateVersion: z.number()
  })
})

export type CreateSessionResponse = z.infer<typeof CreateSessionResponseSchema>

export const UserMessageSchema = z.object({
  role: z.literal('user'),
  content: z.object({
    type: z.literal('text'),
    text: z.string()
  }),
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
})

export type UserMessage = z.infer<typeof UserMessageSchema>

export const AgentMessageSchema = z.object({
  role: z.literal('agent'),
  content: z.object({
    type: z.literal('output'),
    data: z.any()
  }),
  meta: MessageMetaSchema.optional()
})

export type AgentMessage = z.infer<typeof AgentMessageSchema>

export const MessageContentSchema = z.union([UserMessageSchema, AgentMessageSchema])

export type MessageContent = z.infer<typeof MessageContentSchema>

export type Metadata = {
  path: string,
  host: string,
  version?: string,
  name?: string,
  os?: string,
  /**
   * Terminal/attach metadata for this Happy session (non-secret).
   * Used by the UI (Session Details) and CLI attach flows.
   */
  terminal?: {
    mode: 'plain' | 'tmux',
    requested?: 'plain' | 'tmux',
    fallbackReason?: string,
    tmux?: {
      target: string,
      tmpDir?: string | null,
    },
  },
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
  claudeSessionId?: string, // Claude Code session ID
  claudeTranscriptPath?: string | null, // Claude Code transcript path (hooks)
  claudeLastCheckpointId?: string | null, // Claude SDK file checkpoint UUID (remote)
  codexSessionId?: string, // Codex session/conversation ID (uuid)
  geminiSessionId?: string, // Gemini ACP session ID (opaque)
  opencodeSessionId?: string, // OpenCode ACP session ID (opaque)
  auggieSessionId?: string, // Auggie ACP session ID (opaque)
  qwenSessionId?: string, // Qwen Code ACP session ID (opaque)
  kimiSessionId?: string, // Kimi ACP session ID (opaque)
  kiloSessionId?: string, // Kilo ACP session ID (opaque)
  piSessionId?: string, // Pi RPC session ID (opaque)
  auggieAllowIndexing?: boolean, // Auggie indexing enablement (spawn-time)
  tools?: string[],
  slashCommands?: string[],
  slashCommandDetails?: Array<{
    command: string,
    description?: string
  }>,
  acpHistoryImportV1?: {
    v: 1,
    provider: 'gemini' | 'codex' | 'opencode' | string,
    remoteSessionId: string,
    importedAt: number,
    lastImportedFingerprint?: string
  },
  /**
   * ACP session modes (if supported by the provider's ACP agent).
   *
   * Used to expose provider-native "plan/code" style runtime modes to the UI.
   */
  acpSessionModesV1?: {
    v: 1,
    provider: string,
    updatedAt: number,
    currentModeId: string,
    availableModes: Array<{
      id: string,
      name: string,
      description?: string,
    }>,
  },
  /**
   * ACP session models (if supported by the provider's ACP agent).
   *
   * Used to expose provider-native model selection to the UI.
   *
   * NOTE: This is an UNSTABLE ACP feature and may be unsupported by some agents.
   */
  acpSessionModelsV1?: {
    v: 1,
    provider: string,
    updatedAt: number,
    currentModelId: string,
    availableModels: Array<{
      id: string,
      name: string,
      description?: string,
    }>,
  },
  /**
   * ACP session configuration options (if supported by the provider's ACP agent).
   *
   * Used to expose provider-native runtime configuration controls to the UI.
   */
  acpConfigOptionsV1?: {
    v: 1,
    provider: string,
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
    }>,
  },
  /**
   * Desired ACP session mode override selected by the user (UI/CLI).
   *
   * Distinct from `acpSessionModesV1` (which mirrors agent-reported current state).
   */
  acpSessionModeOverrideV1?: {
    v: 1,
    updatedAt: number,
    modeId: string,
  },
  /**
   * Desired ACP configuration option overrides selected by the user (UI/CLI).
   *
   * This is a best-effort mechanism to keep ACP "configOptions" selections consistent across devices.
   */
  acpConfigOptionOverridesV1?: {
    v: 1,
    updatedAt: number,
    overrides: {
      [configId: string]: {
        updatedAt: number,
        value: string | number | boolean | null,
      },
    },
  },
  homeDir: string,
  happyHomeDir: string,
  happyLibDir: string,
  happyToolsDir: string,
  startedFromDaemon?: boolean,
  hostPid?: number,
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
  /** Timestamp (ms) for permissionMode, used for "latest wins" arbitration across devices. */
  permissionModeUpdatedAt?: number,
  /**
   * Desired model override selected by the user (UI/CLI), if supported by the agent.
   *
   * This is session-scoped and should be applied by runners in a capability-driven way
   * (some agents support live model switching; others may require a new session).
   */
  modelOverrideV1?: {
    v: 1,
    updatedAt: number,
    modelId: string,
  },
};

export type AgentState = {
  controlledByUser?: boolean | null | undefined
  capabilities?: {
    askUserQuestionAnswersInPermission?: boolean | null | undefined
    inFlightSteer?: boolean | null | undefined
  } | null | undefined
  requests?: {
    [id: string]: {
      tool: string,
      arguments: any,
      createdAt: number
    }
  }
  completedRequests?: {
    [id: string]: {
      tool: string,
      arguments: any,
      createdAt: number,
      completedAt: number,
      status: 'canceled' | 'denied' | 'approved',
      reason?: string,
      mode?: PermissionMode,
      decision?: 'approved' | 'approved_for_session' | 'approved_execpolicy_amendment' | 'denied' | 'abort',
      allowedTools?: string[]
      allowTools?: string[] // legacy alias
    }
  }
}
