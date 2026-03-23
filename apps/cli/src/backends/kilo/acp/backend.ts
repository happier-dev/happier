/**
 * Kilo ACP Backend - Kilo CLI agent via ACP.
 *
 * Kilo CLI must be installed and available in PATH.
 * ACP mode: `kilo acp`
 */

import { AcpBackend, type AcpBackendOptions, type AcpPermissionHandler } from '@/agent/acp/AcpBackend';
import type { AgentBackend, AgentFactoryOptions, McpServerConfig } from '@/agent/core';
import { kiloTransport } from '@/backends/kilo/acp/transport';
import type { PermissionMode } from '@/api/types';
import { buildOpenCodeFamilyPermissionEnv } from '@/backends/openCodeFamily/permission/openCodeFamilyPermissionEnv';
import { requireProviderCliLaunchSpec } from '@/runtime/managedTools/requireProviderCliLaunchSpec';

export interface KiloBackendOptions extends AgentFactoryOptions {
  mcpServers?: Record<string, McpServerConfig>;
  permissionHandler?: AcpPermissionHandler;
  permissionMode?: PermissionMode;
}

export function createKiloBackend(options: KiloBackendOptions): AgentBackend {
  const launch = requireProviderCliLaunchSpec('kilo', { processEnv: { ...process.env, ...options.env } });
  const backendOptions: AcpBackendOptions = {
    agentName: 'kilo',
    cwd: options.cwd,
    command: launch.command,
    args: [...launch.args, 'acp'],
    env: {
      ...options.env,
      ...buildOpenCodeFamilyPermissionEnv(options.permissionMode),
      // Keep output clean; ACP must own stdout.
      NODE_ENV: 'production',
      DEBUG: '',
    },
    mcpServers: options.mcpServers,
    permissionHandler: options.permissionHandler,
    transportHandler: kiloTransport,
  };

  return new AcpBackend(backendOptions);
}
