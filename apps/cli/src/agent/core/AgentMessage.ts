/**
 * AgentMessage - Universal message types for agent communication
 *
 * This module defines the message types that flow between:
 * - Agent backends (Gemini, Codex, Claude, etc.)
 * - Happier CLI
 * - Mobile app (via Happy server)
 *
 * These types are backend-agnostic and work with any agent that
 * implements the AgentBackend interface.
 *
 * @module AgentMessage
 */

/** Unique identifier for an agent session */
export type SessionId = string;

/** Unique identifier for a tool call */
export type ToolCallId = string;

/**
 * Agent status values
 */
export type AgentStatus = 'starting' | 'running' | 'idle' | 'stopped' | 'error';

/**
 * Model output message - text chunks from the agent
 */
export interface ModelOutputMessage {
  type: 'model-output';
  /** Incremental text delta (streaming) */
  textDelta?: string;
  /** Authoritative cumulative text snapshot. */
  fullText?: string;
  /** Whether fullText covers the whole turn (default) or only the current assistant segment. */
  fullTextScope?: 'turn' | 'segment';
}

/**
 * Status message - agent lifecycle state
 */
export interface StatusMessage {
  type: 'status';
  status: AgentStatus;
  /** Additional details (e.g., error message) */
  detail?: string;
}

/**
 * Tool call message - agent is calling a tool
 */
export interface ToolCallMessage {
  type: 'tool-call';
  toolName: string;
  args: Record<string, unknown>;
  callId: ToolCallId;
}

/**
 * Tool result message - result from a tool call
 */
export interface ToolResultMessage {
  type: 'tool-result';
  toolName: string;
  result: unknown;
  callId: ToolCallId;
  isError?: boolean;
  meta?: Record<string, unknown>;
}

export type SessionMediaSourceOrigin = {
  source: 'provider-generated' | 'tool-output' | 'acp-content' | 'mcp-content' | 'local-file';
  agentId?: string;
  toolCallId?: string;
  generationId?: string;
  providerEventId?: string;
  providerFileId?: string;
  contentIndex?: number;
};

export type SessionMediaSource =
  | {
      kind: 'base64';
      data: string;
      mimeType: string;
      suggestedName?: string;
      uri?: string;
      origin: SessionMediaSourceOrigin;
      dedupeKey?: string;
      provenance?: Record<string, unknown>;
    }
  | {
      kind: 'local-file';
      path: string;
      mimeType?: string;
      suggestedName?: string;
      description?: string;
      referenceImagePaths?: readonly string[];
      origin: SessionMediaSourceOrigin;
      dedupeKey?: string;
      provenance?: Record<string, unknown>;
    }
  | {
      kind: 'local-uri';
      uri: string;
      mimeType?: string;
      suggestedName?: string;
      origin: SessionMediaSourceOrigin;
      dedupeKey?: string;
      provenance?: Record<string, unknown>;
    };

export type SessionMediaDiagnostic = {
  code: 'unsupported_audio' | 'unsupported_mime' | 'http_uri_unavailable' | 'malformed_media_block';
  contentIndex?: number;
  message: string;
};

export interface SessionMediaMessage {
  type: 'session-media';
  source: string;
  media: SessionMediaSource[];
  diagnostics?: SessionMediaDiagnostic[];
}

/**
 * Permission request message - agent needs user approval
 */
export interface PermissionRequestMessage {
  type: 'permission-request';
  id: string;
  reason: string;
  payload: unknown;
}

/**
 * Permission response message - user's decision
 */
export interface PermissionResponseMessage {
  type: 'permission-response';
  id: string;
  approved: boolean;
}

/**
 * File system edit message - agent modified a file
 */
export interface FsEditMessage {
  type: 'fs-edit';
  description: string;
  diff?: string;
  path?: string;
}

/**
 * Terminal output message - output from terminal commands
 */
export interface TerminalOutputMessage {
  type: 'terminal-output';
  data: string;
}

/**
 * Generic event message - extensible for agent-specific events
 */
export interface EventMessage {
  type: 'event';
  name: string;
  payload: unknown;
}

/**
 * Token count message - usage information
 */
export interface TokenCountMessage {
  type: 'token-count';
  [key: string]: unknown;
}

/**
 * Exec approval request message (Codex-style)
 */
export interface ExecApprovalRequestMessage {
  type: 'exec-approval-request';
  call_id: string;
  [key: string]: unknown;
}

/**
 * Patch apply begin message (Codex-style)
 */
export interface PatchApplyBeginMessage {
  type: 'patch-apply-begin';
  call_id: string;
  auto_approved?: boolean;
  changes: Record<string, unknown>;
}

/**
 * Patch apply end message (Codex-style)
 */
export interface PatchApplyEndMessage {
  type: 'patch-apply-end';
  call_id: string;
  stdout?: string;
  stderr?: string;
  success: boolean;
}

/**
 * Union type of all agent messages.
 *
 * These messages are emitted by agent backends and forwarded
 * to the Happy server and mobile app.
 */
export type AgentMessage =
  | ModelOutputMessage
  | StatusMessage
  | ToolCallMessage
  | ToolResultMessage
  | SessionMediaMessage
  | PermissionRequestMessage
  | PermissionResponseMessage
  | FsEditMessage
  | TerminalOutputMessage
  | EventMessage
  | TokenCountMessage
  | ExecApprovalRequestMessage
  | PatchApplyBeginMessage
  | PatchApplyEndMessage;

/**
 * Handler function type for agent messages
 */
export type AgentMessageHandler = (msg: AgentMessage) => void;

/**
 * Type guard for model output messages
 */
export function isModelOutputMessage(msg: AgentMessage): msg is ModelOutputMessage {
  return msg.type === 'model-output';
}

/**
 * Type guard for status messages
 */
export function isStatusMessage(msg: AgentMessage): msg is StatusMessage {
  return msg.type === 'status';
}

/**
 * Type guard for tool call messages
 */
export function isToolCallMessage(msg: AgentMessage): msg is ToolCallMessage {
  return msg.type === 'tool-call';
}

/**
 * Type guard for tool result messages
 */
export function isToolResultMessage(msg: AgentMessage): msg is ToolResultMessage {
  return msg.type === 'tool-result';
}

export function isSessionMediaMessage(msg: AgentMessage): msg is SessionMediaMessage {
  return msg.type === 'session-media';
}

/**
 * Type guard for permission request messages
 */
export function isPermissionRequestMessage(msg: AgentMessage): msg is PermissionRequestMessage {
  return msg.type === 'permission-request';
}

/**
 * Extract text content from a model output message
 */
export function getMessageText(msg: ModelOutputMessage): string {
  return msg.textDelta ?? msg.fullText ?? '';
}
