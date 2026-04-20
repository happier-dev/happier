import { type AgentId, getBuiltInAcpConfig } from '@happier-dev/agents';

import type { AcpBackend } from '@/agent/acp/AcpBackend';
import type { AcpPermissionHandler } from '@/agent/acp/permissions/acpPermissionHandler';
import { createAcpBackend } from '@/agent/acp/createAcpBackend';
import type { AgentFactoryOptions, McpServerConfig } from '@/agent/core';
import { requireProviderCliLaunchSpec } from '@/runtime/managedTools/requireProviderCliLaunchSpec';
import { resolveAcpCatalogTransportHandler } from '../transport/resolveAcpCatalogTransportHandler';

export type BuiltInAcpBackendOptions = AgentFactoryOptions & Readonly<{
  mcpServers?: Record<string, McpServerConfig>;
  permissionHandler?: AcpPermissionHandler;
}>;

export function createBuiltInBackend(
  agentId: AgentId,
  options: BuiltInAcpBackendOptions,
): AcpBackend {
  const config = getBuiltInAcpConfig(agentId);
  if (!config) {
    throw new Error(`Agent '${agentId}' is not a built-in generic ACP agent`);
  }
  const launch = requireProviderCliLaunchSpec(agentId, { processEnv: { ...process.env, ...options.env } });

  return createAcpBackend({
    agentName: agentId,
    cwd: options.cwd,
    command: launch.command,
    args: [...launch.args, ...config.launcher.args],
    env: {
      ...options.env,
      NODE_ENV: 'production',
      DEBUG: '',
    },
    mcpServers: options.mcpServers,
    permissionHandler: options.permissionHandler,
    transportHandler: resolveAcpCatalogTransportHandler(config.transportProfile),
  });
}
