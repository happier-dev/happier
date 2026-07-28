/**
 * ACP Backend Factory Helper
 *
 * Provides a simplified factory function for creating ACP-based agent backends.
 * Use this when you need to create a generic ACP backend without agent-specific
 * configuration (timeouts, filtering, etc.).
 *
 * For agent-specific backends, use the agent ACP backends in:
 * - createGeminiBackend() - Gemini CLI with GeminiTransport
 * - createCodexBackend() - Codex CLI with CodexTransport
 * - createClaudeBackend() - Claude CLI with ClaudeTransport
 *
 * @module createAcpBackend
 */

import {
  AcpBackend,
  type AcpBackendOptions,
  type AcpExtensionHandlers,
  type AcpPermissionHandler,
  type AcpSessionModelAdapter,
} from './AcpBackend';
import type { AcpAuthentication } from './AcpAuthentication';
import type { AgentBackend, McpServerConfig } from '../core';
import { DefaultTransport, type TransportHandler } from '../transport';

/**
 * Simplified options for creating an ACP backend
 */
export interface CreateAcpBackendOptions {
  /** Agent name for identification */
  agentName: string;

  /** Working directory for the agent */
  cwd: string;

  /** Command to spawn the ACP agent */
  command: string;

  /** Arguments for the agent command */
  args?: string[];

  /** Environment variables to pass to the agent */
  env?: Record<string, string>;

  /** Inherited process environment variables to remove before provider env overrides are applied */
  unsetEnv?: readonly string[];

  /** MCP servers to make available to the agent */
  mcpServers?: Record<string, McpServerConfig>;

  /** Optional permission handler for tool approval */
  permissionHandler?: AcpPermissionHandler;

  /** Optional transport handler for agent-specific behavior */
  transportHandler?: TransportHandler;

  /** Optional authentication selected only after a successful ACP initialize response. */
  authentication?: AcpAuthentication;

  /** Optional ACP initialize _meta payload for provider-specific extension negotiation. */
  initializeMeta?: Record<string, unknown>;

  /** Optional ACP clientCapabilities._meta payload for provider-specific extension negotiation. */
  initializeClientCapabilitiesMeta?: Record<string, unknown>;

  /** Provider-owned handlers for non-standard ACP extension requests/notifications. */
  extensionHandlers?: AcpExtensionHandlers;

  /** Provider-owned projection/application for model metadata not standardized by ACP. */
  sessionModelAdapter?: AcpSessionModelAdapter;
}

/**
 * Create a generic ACP backend.
 *
 * This is a low-level factory for creating ACP backends. For most use cases,
 * prefer the agent-specific factories that include proper transport handlers:
 *
 * ```typescript
 * // Prefer this:
 * import { createGeminiBackend } from '@/backends/gemini/acp/backend';
 * const backend = createGeminiBackend({ cwd: '/path/to/project' });
 *
 * // Over this:
 * import { createAcpBackend } from '@/agent/acp';
 * const backend = createAcpBackend({
 *   agentName: 'gemini',
 *   cwd: '/path/to/project',
 *   command: 'gemini',
 *   args: ['--acp'],
 * });
 * ```
 *
 * @param options - Configuration options
 * @returns AgentBackend instance
 */
export function createAcpBackend(options: CreateAcpBackendOptions): AgentBackend {
  const backendOptions: AcpBackendOptions = {
    agentName: options.agentName,
    cwd: options.cwd,
    command: options.command,
    args: options.args,
    env: options.env,
    unsetEnv: options.unsetEnv,
    mcpServers: options.mcpServers,
    permissionHandler: options.permissionHandler,
    transportHandler: options.transportHandler ?? new DefaultTransport(options.agentName),
    authentication: options.authentication,
    initializeMeta: options.initializeMeta,
    initializeClientCapabilitiesMeta: options.initializeClientCapabilitiesMeta,
    extensionHandlers: options.extensionHandlers,
    sessionModelAdapter: options.sessionModelAdapter,
  };

  return new AcpBackend(backendOptions);
}
