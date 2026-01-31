/**
 * Kimi ACP Backend - Kimi CLI agent via ACP.
 *
 * Kimi CLI must be installed and available in PATH.
 * ACP mode: `kimi acp`
 */

import { AcpBackend, type AcpBackendOptions, type AcpPermissionHandler } from '@/agent/acp/AcpBackend';
import type { AgentBackend, AgentFactoryOptions, McpServerConfig } from '@/agent/core';
import { kimiTransport } from '@/backends/kimi/acp/transport';

export interface KimiBackendOptions extends AgentFactoryOptions {
  mcpServers?: Record<string, McpServerConfig>;
  permissionHandler?: AcpPermissionHandler;
}

export function createKimiBackend(options: KimiBackendOptions): AgentBackend {
  const backendOptions: AcpBackendOptions = {
    agentName: 'kimi',
    cwd: options.cwd,
    command: 'kimi',
    args: ['acp'],
    env: {
      ...options.env,
      // Keep output clean; ACP must own stdout.
      NODE_ENV: 'production',
      DEBUG: '',
    },
    mcpServers: options.mcpServers,
    permissionHandler: options.permissionHandler,
    transportHandler: kimiTransport,
  };

  return new AcpBackend(backendOptions);
}

