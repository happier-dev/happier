/**
 * Agent Module - Universal agent backend abstraction
 *
 * This module provides the core abstraction layer for different AI agents
 * (Claude, Codex, Gemini, OpenCode, etc.) that can be controlled through
 * the Happier CLI and app.
 */

// Core types, interfaces, and registry - re-export from core/
export type {
  AgentMessage,
  AgentMessageHandler,
  AgentBackendConfig,
  AcpAgentConfig,
  McpServerConfig,
  AgentTransport,
  AgentId,
  SessionId,
  ToolCallId,
  StartSessionResult,
} from './core';
export type { AgentFactoryOptions } from './catalog/factoryOptions';

// ACP backend (low-level)
export * from './acp';

// ACP compatibility runtime creation is definition-driven through the configured runtime core.
