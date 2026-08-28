/**
 * ACP Backend Factory Helper
 *
 * Provides a simplified factory function for creating ACP-based agent backends.
 * Use this when you need to create a generic ACP backend without agent-specific
 * configuration (timeouts, filtering, etc.).
 *
 * For agent-specific backends, use catalog/plugin-owned ACP backend definitions
 * that include their provider-specific transport handlers.
 *
 * @module createAcpBackend
 */

import { AcpBackend, type AcpBackendOptions } from './AcpBackend';
import type { AcpPermissionHandler } from './permissions/acpPermissionHandler';
import type { McpServerConfig } from '../core';
import { DefaultTransport, type TransportHandler } from '../transport';
import type {
  AcpExtensionContextFactory,
  AcpExtensionRegistration,
} from './connection/types';

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

  /** Environment variable names removed from the inherited child environment. */
  unsetEnv?: readonly string[];

  transformAgentChildLaunchEnvironment?:
    AcpBackendOptions['transformAgentChildLaunchEnvironment'];

  /** MCP servers to make available to the agent */
  mcpServers?: Record<string, McpServerConfig>;

  /** Optional permission handler for tool approval */
  permissionHandler?: AcpPermissionHandler;

  /** Optional per-backend ACP fs capability override */
  fsEnabled?: boolean;

  /** Optional transport handler for agent-specific behavior */
  transportHandler?: TransportHandler;

  /** Optional ACP auth method to invoke after initialize. */
  authMethodId?: string;

  /** Optional ACP authenticate metadata forwarded as `_meta`. */
  authMeta?: Record<string, unknown>;

  /** Selects authentication from the final bounded initialize response. */
  authSelector?: AcpBackendOptions['authSelector'];

  /** Whether the ACP agent should advertise its parameterized model picker. */
  parameterizedModelPicker?: boolean;

  /** Declarative ACP config-option id used instead of legacy session/set_model. */
  modelConfigOptionId?: string;

  projectModel?: AcpBackendOptions['projectModel'];

  prepareSessionModels?: AcpBackendOptions['prepareSessionModels'];

  projectSetModelResponse?: AcpBackendOptions['projectSetModelResponse'];

  projectSetModelResponseAwaitable?: AcpBackendOptions['projectSetModelResponseAwaitable'];

  prepareToolUpdate?: AcpBackendOptions['prepareToolUpdate'];

  transformPromptRequest?: AcpBackendOptions['transformPromptRequest'];

  extensions?: ReadonlyArray<AcpExtensionRegistration>;
  createExtensionContext?: AcpExtensionContextFactory;
  onProcessExit?: AcpBackendOptions['onProcessExit'];
  onPublishedTerminalToolResult?: AcpBackendOptions['onPublishedTerminalToolResult'];
}

/**
 * Create a generic ACP backend.
 *
 * This is a low-level factory for creating ACP backends. For most use cases,
 * prefer the agent-specific factories that include proper transport handlers:
 *
 * ```typescript
 * import { createAcpBackend } from '@/agent/acp';
 * const backend = createAcpBackend({
 *   agentName: 'gemini',
 *   cwd: '/path/to/project',
 *   command: 'gemini',
 *   args: ['--experimental-acp'],
 * });
 * ```
 *
 * @param options - Configuration options
 * @returns AcpBackend instance
 */
export function createAcpBackend(options: CreateAcpBackendOptions): AcpBackend {
  const backendOptions: AcpBackendOptions = {
    agentName: options.agentName,
    cwd: options.cwd,
    command: options.command,
    args: options.args,
    env: options.env,
    ...(options.unsetEnv ? { unsetEnv: options.unsetEnv } : {}),
    ...(options.transformAgentChildLaunchEnvironment
      ? {
          transformAgentChildLaunchEnvironment:
            options.transformAgentChildLaunchEnvironment,
        }
      : {}),
    mcpServers: options.mcpServers,
    permissionHandler: options.permissionHandler,
    ...(typeof options.fsEnabled === 'boolean' ? { fsEnabled: options.fsEnabled } : {}),
    transportHandler: options.transportHandler ?? new DefaultTransport(options.agentName),
    ...(options.authMethodId ? { authMethodId: options.authMethodId } : {}),
    ...(options.authMeta ? { authMeta: options.authMeta } : {}),
    ...(options.authSelector ? { authSelector: options.authSelector } : {}),
    ...(typeof options.parameterizedModelPicker === 'boolean'
      ? { parameterizedModelPicker: options.parameterizedModelPicker }
      : {}),
    ...(options.modelConfigOptionId
      ? { modelConfigOptionId: options.modelConfigOptionId }
      : {}),
    ...(options.projectModel ? { projectModel: options.projectModel } : {}),
    ...(options.prepareSessionModels
      ? { prepareSessionModels: options.prepareSessionModels }
      : {}),
    ...(options.projectSetModelResponse
      ? { projectSetModelResponse: options.projectSetModelResponse }
      : {}),
    ...(options.projectSetModelResponseAwaitable
      ? { projectSetModelResponseAwaitable: options.projectSetModelResponseAwaitable }
      : {}),
    ...(options.prepareToolUpdate ? { prepareToolUpdate: options.prepareToolUpdate } : {}),
    ...(options.transformPromptRequest
      ? { transformPromptRequest: options.transformPromptRequest }
      : {}),
    ...(options.extensions ? { extensions: options.extensions } : {}),
    ...(options.createExtensionContext
      ? { createExtensionContext: options.createExtensionContext }
      : {}),
    ...(options.onProcessExit ? { onProcessExit: options.onProcessExit } : {}),
    ...(options.onPublishedTerminalToolResult
      ? { onPublishedTerminalToolResult: options.onPublishedTerminalToolResult }
      : {}),
  };

  return new AcpBackend(backendOptions);
}
