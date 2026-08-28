import type { AcpBackend } from '@/agent/acp/AcpBackend';
import type { AcpPermissionHandler } from '@/agent/acp/permissions/acpPermissionHandler';
import type { AgentFactoryOptions } from '@/agent/catalog/factoryOptions';
import type { McpServerConfig } from '@/agent/core/AgentTypes';
import {
  createAcpBackendFromDefinition,
  normalizeConfiguredAcpDefinition,
} from '@/agent/acp/runtime/definition';

import type { ResolvedConfiguredAcpBackend } from './resolveBackend';

export type ConfiguredAcpBackendOptions = AgentFactoryOptions & Readonly<{
  backend: ResolvedConfiguredAcpBackend;
  launchEnv: Readonly<Record<string, string>>;
  mcpServers?: Record<string, McpServerConfig>;
  permissionHandler?: AcpPermissionHandler;
  permissionMode?: string;
}>;

export async function createConfiguredAcpBackend(
  options: ConfiguredAcpBackendOptions,
): Promise<AcpBackend> {
  const definition = normalizeConfiguredAcpDefinition({
    backend: options.backend,
    launchEnv: options.launchEnv,
  });

  return await createAcpBackendFromDefinition({
    definition,
    cwd: options.cwd,
    env: {
      ...(options.env ?? {}),
      ...options.launchEnv,
    },
    permissionMode: options.permissionMode,
    mcpServers: options.mcpServers,
    permissionHandler: options.permissionHandler,
  });
}
