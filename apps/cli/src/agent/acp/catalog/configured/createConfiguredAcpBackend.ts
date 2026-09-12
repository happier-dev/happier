import { createAcpBackend } from '@/agent/acp/createAcpBackend';
import type { AcpBackend, AcpPermissionHandler } from '@/agent/acp/AcpBackend';
import type { AgentFactoryOptions, McpServerConfig } from '@/agent/core';

import type { ResolvedConfiguredAcpBackend } from './resolveConfiguredAcpBackendFromAccountSettings';
import { resolveAcpCatalogTransportHandler } from '../transport/resolveAcpCatalogTransportHandler';

export type ConfiguredAcpBackendOptions = AgentFactoryOptions & Readonly<{
  backend: ResolvedConfiguredAcpBackend;
  launchEnv: Readonly<Record<string, string>>;
  mcpServers?: Record<string, McpServerConfig>;
  permissionHandler?: AcpPermissionHandler;
}>;

export function createConfiguredAcpBackend(options: ConfiguredAcpBackendOptions): AcpBackend {
  return createAcpBackend({
    agentName: options.backend.backendId,
    cwd: options.cwd,
    command: options.backend.command,
    args: [...options.backend.args],
    env: {
      ...options.launchEnv,
      NODE_ENV: 'production',
      DEBUG: '',
    },
    mcpServers: options.mcpServers,
    permissionHandler: options.permissionHandler,
    transportHandler: resolveAcpCatalogTransportHandler(options.backend.transportProfile),
    declaredSessionLoadSupport: options.backend.capabilities.supportsLoadSession,
  });
}
