/**
 * AgentBackend - Universal interface for AI agent backends
 * 
 * This module defines the core abstraction for different agent backends
 * (Claude, Codex, Gemini, OpenCode, etc.) that can be controlled through
 * the Happier CLI and app.
 * 
 * The AgentBackend interface provides a unified way to:
 * - Start and manage agent sessions
 * - Send prompts and receive responses
 * - Handle tool calls and permissions
 * - Stream model output and events
 */

import type { AgentId as CatalogAgentId } from '@happier-dev/agents';
import type { AgentMessageHandler, SessionId } from './AgentMessage';
import type { AgentPromptPayload } from './AgentPromptPayload';

export type { AgentMessage, AgentMessageHandler, SessionId, ToolCallId } from './AgentMessage';

/** MCP server configuration for tools */
export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/** Transport type for agent communication */
export type AgentTransport = 'native-claude' | 'mcp-codex' | 'acp';

/** Agent identifier */
export type AgentId = CatalogAgentId;

/**
 * Configuration for creating an agent backend
 */
export interface AgentBackendConfig {
  /** Working directory for the agent */
  cwd: string;
  
  /** Name of the agent */
  agentName: AgentId;
  
  /** Transport protocol to use */
  transport: AgentTransport;
  
  /** Environment variables to pass to the agent */
  env?: Record<string, string>;
  
  /** MCP servers to make available to the agent */
  mcpServers?: Record<string, McpServerConfig>;
}

/**
 * Configuration specific to ACP-based agents
 */
export interface AcpAgentConfig extends AgentBackendConfig {
  transport: 'acp';
  
  /** Command to spawn the ACP agent */
  command: string;
  
  /** Arguments for the agent command */
  args?: string[];
}

/**
 * Result of starting a session
 */
export interface StartSessionResult {
  sessionId: SessionId;
}

export type AgentSessionOpenOptions = Readonly<{
  /** Cancellation owned by the enclosing runner/session-open lifecycle. */
  signal?: AbortSignal;
}>;

export type AgentTurnLivenessProbeResult = Readonly<{
  active: boolean;
  reason?: string;
  lastActivityAtMs?: number | null;
  diagnostics?: Readonly<Record<string, unknown>>;
}>;

/**
 * Universal interface for agent backends.
 * 
 * All agent implementations (Claude, Codex, Gemini, etc.) should implement
 * this interface to be usable through the Happier CLI and app.
 */
export interface AgentBackend {
  /**
   * Start a new agent session.
   * 
   * @param initialPrompt - Optional initial prompt to send to the agent
   * @returns Promise resolving to session information
   */
  startSession(initialPrompt?: string, options?: AgentSessionOpenOptions): Promise<StartSessionResult>;

  /**
   * Load an existing agent session (vendor-level resume).
   *
   * Not all agents support this. ACP agents may advertise this capability
   * via the protocol (e.g. Codex ACP).
   *
   * When unsupported, callers should fall back to starting a new session.
   */
  loadSession?(sessionId: SessionId, options?: AgentSessionOpenOptions): Promise<StartSessionResult>;

  /**
   * Load an existing agent session and capture the replayed history.
   *
   * ACP agents that implement session/load may replay the full conversation via session/update.
   * This hook allows Happier CLI to capture that replay and import it into the Happier transcript.
   */
  loadSessionWithReplayCapture?(sessionId: SessionId): Promise<StartSessionResult & { replay: unknown[] }>;
  
  /**
   * Send a prompt to an existing session.
   * 
   * @param sessionId - The session to send the prompt to
   * @param prompt - The user's prompt text
   */
  sendPrompt(sessionId: SessionId, prompt: string): Promise<void>;

  /**
   * Send a structured prompt payload to an existing session.
   *
   * Providers without structured input support can omit this method; shared callers
   * must fall back to sendPrompt(payload.text).
   */
  sendPromptPayload?(sessionId: SessionId, payload: AgentPromptPayload): Promise<void>;

  /**
   * Trigger provider-native context compaction when supported.
   *
   * Backends that expose a native control command should implement this instead of relying
   * on `/compact` being delivered as ordinary prompt text.
   */
  compactContext?(sessionId: SessionId, command: string): Promise<void>;

  /**
   * Send additional user input into an already in-flight turn, when supported.
   *
   * This is the "steer" capability: it should not start a new turn and should not
   * abort the currently running turn.
   *
   * When unsupported, callers should fall back to queueing the message for the next turn.
   */
  sendSteerPrompt?(sessionId: SessionId, prompt: string): Promise<void>;

  /**
   * Send structured steering input into an already in-flight turn, when supported.
   */
  sendSteerPromptPayload?(sessionId: SessionId, payload: AgentPromptPayload): Promise<void>;
  
  /**
   * Cancel the current operation in a session.
   * 
   * @param sessionId - The session to cancel
   */
  cancel(sessionId: SessionId): Promise<void>;
  
  /**
   * Register a handler for agent messages.
   * 
   * @param handler - Function to call when messages are received
   */
  onMessage(handler: AgentMessageHandler): void;
  
  /**
   * Remove a previously registered message handler.
   * 
   * @param handler - The handler to remove
   */
  offMessage?(handler: AgentMessageHandler): void;
  
  /**
   * Respond to a permission request.
   *
   * **Implementation Note for ACP backends:**
   * For ACP-based agents (Gemini, Codex via ACP), permission handling is done
   * synchronously within the `requestPermission` RPC handler via `AcpPermissionHandler`.
   * This method only emits an internal `permission-response` event for UI/logging purposes.
   * The actual ACP response is already sent by the time this method is called.
   *
   * For non-ACP backends, this method should actually send the permission response
   * to the agent.
   *
   * @param requestId - The ID of the permission request
   * @param approved - Whether the permission was granted
   */
  respondToPermission?(requestId: string, approved: boolean): Promise<void>;
  
  /**
   * Wait for the current response to complete.
   * Call this after sendPrompt to wait for all chunks to be received.
   * 
   * @param timeoutMs - Optional stall budget in milliseconds. When unset/null, there is no timeout by default.
   */
  waitForResponseComplete?(timeoutMs?: number | null): Promise<void>;

  /**
   * Probe whether the provider still has meaningful work for the current turn.
   *
   * Execution-run watchdogs call this before treating a bounded timeout as terminal.
   * Backends should return active=true when the provider/session/control plane shows
   * an active turn, active tools, pending user requests, or other legitimate work.
   */
  probeTurnLiveness?(sessionId: SessionId): Promise<AgentTurnLivenessProbeResult>;
  
  /**
   * Clean up resources and close the backend.
   */
  dispose(): Promise<void>;
}
