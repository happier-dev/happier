import { createAcpBackend } from '@/agent/acp/createAcpBackend';
import type { AcpBackend, AcpPermissionHandler } from '@/agent/acp/AcpBackend';
import { HAPPIER_SESSION_ID_ENV_KEY, withCurrentHappierSessionId } from '@/agent/runtime/session/currentSessionIdEnv';
import type { AgentFactoryOptions, McpServerConfig } from '@/agent/core';

import type { ResolvedConfiguredAcpBackend } from './resolveConfiguredAcpBackendFromAccountSettings';
import { resolveAcpCatalogTransportHandler } from '../transport/resolveAcpCatalogTransportHandler';

export type ConfiguredAcpBackendOptions = AgentFactoryOptions & Readonly<{
  backend: ResolvedConfiguredAcpBackend;
  launchEnv: Readonly<Record<string, string>>;
  happierSessionId?: string;
  mcpServers?: Record<string, McpServerConfig>;
  permissionHandler?: AcpPermissionHandler;
}>;

export function createConfiguredAcpBackend(options: ConfiguredAcpBackendOptions): AcpBackend {
  const env = { ...options.env, ...options.launchEnv, NODE_ENV: 'production', DEBUG: '' };
  return createAcpBackend({
    agentName: options.backend.backendId,
    cwd: options.cwd,
    command: options.backend.command,
    args: [...options.backend.args],
    env: options.happierSessionId !== undefined
      ? withCurrentHappierSessionId(env, options.happierSessionId)
      : env,
    // The process adapter merges ambient env again; clear caller identity before explicit overrides.
    unsetEnv: options.happierSessionId !== undefined ? [HAPPIER_SESSION_ID_ENV_KEY] : undefined,
    mcpServers: options.mcpServers,
    permissionHandler: options.permissionHandler,
    transportHandler: resolveAcpCatalogTransportHandler(options.backend.transportProfile),
    declaredSessionLoadSupport: options.backend.capabilities.supportsLoadSession,
  });
}
