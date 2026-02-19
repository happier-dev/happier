/**
 * Copilot ACP Backend - GitHub Copilot CLI agent via ACP.
 *
 * Copilot CLI must be installed and available in PATH.
 * ACP mode: `copilot --acp`
 */

import { AcpBackend, type AcpBackendOptions, type AcpPermissionHandler } from '@/agent/acp/AcpBackend';
import { resolveCliPathOverride } from '@/agent/acp/resolveCliPathOverride';
import type { AgentBackend, AgentFactoryOptions, McpServerConfig } from '@/agent/core';
import { copilotTransport } from '@/backends/copilot/acp/transport';
import type { PermissionMode } from '@/api/types';
import { buildOpenCodeFamilyPermissionEnv } from '@/backends/opencode/utils/opencodeFamilyPermissionEnv';

export interface CopilotBackendOptions extends AgentFactoryOptions {
  mcpServers?: Record<string, McpServerConfig>;
  permissionHandler?: AcpPermissionHandler;
  permissionMode?: PermissionMode;
}

export function createCopilotBackend(options: CopilotBackendOptions): AgentBackend {
  const backendOptions: AcpBackendOptions = {
    agentName: 'copilot',
    cwd: options.cwd,
    command: resolveCliPathOverride({ agentId: 'copilot' }) ?? 'copilot',
    args: ['--acp'],
    env: {
      ...options.env,
      ...buildOpenCodeFamilyPermissionEnv(options.permissionMode),
      NODE_ENV: 'production',
      DEBUG: '',
    },
    mcpServers: options.mcpServers,
    permissionHandler: options.permissionHandler,
    transportHandler: copilotTransport,
  };

  return new AcpBackend(backendOptions);
}
