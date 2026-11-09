import type { CatalogAgentId } from '@/agent/catalog/ids';
import type { AgentRuntimeKind } from '@happier-dev/agents';

import type { SessionId } from './AgentMessage';

/** MCP server configuration for tools */
export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

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
  transport: AgentRuntimeKind;

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
