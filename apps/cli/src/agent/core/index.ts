/**
 * Core Agent Types and Interfaces
 *
 * Re-exports all core agent abstractions.
 *
 * @module core
 */

// ============================================================================
// AgentBackend - Core interface and types
// ============================================================================

export type {
  SessionId,
  ToolCallId,
  AgentMessage,
  AgentMessageHandler,
  AgentBackend,
  AgentBackendConfig,
  AcpAgentConfig,
  McpServerConfig,
  AgentTransport,
  AgentId,
  StartSessionResult,
  AgentSessionOpenOptions,
} from './AgentBackend';

export type { AgentPromptPayload } from './AgentPromptPayload';
export { normalizeAgentPromptPayload, sendAgentPromptPayload, sendAgentSteerPromptPayload } from './AgentPromptPayload';

// ============================================================================
// AgentFactory - Factory types (catalog-driven)
// ============================================================================

export type { AgentFactory, AgentFactoryOptions } from './AgentFactory';

// ============================================================================
// AgentMessage - Detailed message types with type guards
// ============================================================================

export type {
  AgentStatus,
  ModelOutputMessage,
  StatusMessage,
  ToolCallMessage,
  ToolResultMessage,
  SessionMediaMessage,
  SessionMediaSource,
  SessionMediaSourceOrigin,
  SessionMediaDiagnostic,
  PermissionRequestMessage,
  PermissionResponseMessage,
  FsEditMessage,
  TerminalOutputMessage,
  EventMessage,
  TokenCountMessage,
  ExecApprovalRequestMessage,
  PatchApplyBeginMessage,
  PatchApplyEndMessage,
} from './AgentMessage';

export {
  isModelOutputMessage,
  isStatusMessage,
  isToolCallMessage,
  isToolResultMessage,
  isSessionMediaMessage,
  isPermissionRequestMessage,
  getMessageText,
} from './AgentMessage';
