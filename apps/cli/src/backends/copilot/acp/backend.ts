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
import { normalizePermissionModeToIntent } from '@/agent/runtime/permission/permissionModeCanonical';

export interface CopilotBackendOptions extends AgentFactoryOptions {
  mcpServers?: Record<string, McpServerConfig>;
  permissionHandler?: AcpPermissionHandler;
  permissionMode?: PermissionMode;
}

/**
 * Map Happier permission modes to Copilot CLI flags.
 *
 * Copilot CLI uses `--yolo` / `--allow-all-tools` rather than the
 * `OPENCODE_PERMISSION` env var used by OpenCode-family agents.
 */
function buildCopilotPermissionArgs(permissionMode: PermissionMode | null | undefined): string[] {
  const intent = normalizePermissionModeToIntent(permissionMode ?? 'default') ?? 'default';
  if (intent === 'yolo' || intent === 'bypassPermissions') {
    return ['--yolo'];
  }
  return [];
}

export function createCopilotBackend(options: CopilotBackendOptions): AgentBackend {
  const backendOptions: AcpBackendOptions = {
    agentName: 'copilot',
    cwd: options.cwd,
    command: resolveCliPathOverride({ agentId: 'copilot' }) ?? 'copilot',
    args: ['--acp', ...buildCopilotPermissionArgs(options.permissionMode)],
    env: {
      NODE_ENV: 'production',
      DEBUG: '',
      ...options.env,
    },
    mcpServers: options.mcpServers,
    permissionHandler: options.permissionHandler,
    transportHandler: copilotTransport,
  };

  return new AcpBackend(backendOptions);
}
