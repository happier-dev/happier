/**
 * Core Agent Types and Interfaces
 *
 * Re-exports all core agent abstractions.
 *
 * @module core
 */

// ============================================================================
// Agent configuration types
// ============================================================================

export type {
  AcpAgentConfig,
  AgentBackendConfig,
  AgentId,
  AgentTransport,
  McpServerConfig,
  StartSessionResult,
} from './AgentTypes';

// ============================================================================
// AgentMessage - Detailed message types with type guards
// ============================================================================

export type {
  SessionId,
  ToolCallId,
  AgentMessage,
  AgentMessageHandler,
  AgentStatus,
  ModelOutputMessage,
  StatusMessage,
  ToolCallMessage,
  ToolResultMessage,
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
  isPermissionRequestMessage,
  getMessageText,
} from './AgentMessage';
