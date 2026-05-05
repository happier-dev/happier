import type { AcpBackend } from '@/agent/acp/AcpBackend';
import type { AcpPermissionHandler } from '@/agent/acp/permissions/acpPermissionHandler';
import type { AgentFactoryOptions, McpServerConfig } from '@/agent/core';
import {
  createAcpBackendFromDefinition,
  normalizeConfiguredAcpDefinition,
  type AcpRuntimeDefinitionV1,
} from '@/agent/acp/runtime/definition';

import type { ResolvedConfiguredAcpBackend } from './resolveBackend';

export type ConfiguredAcpBackendOptions = AgentFactoryOptions & Readonly<{
  backend?: ResolvedConfiguredAcpBackend;
  definition?: AcpRuntimeDefinitionV1;
  launchEnv: Readonly<Record<string, string>>;
  mcpServers?: Record<string, McpServerConfig>;
  permissionHandler?: AcpPermissionHandler;
  permissionMode?: string;
}>;

export function createConfiguredAcpBackend(
  options: ConfiguredAcpBackendOptions,
): AcpBackend {
  const definition = options.definition ?? (
    options.backend
      ? normalizeConfiguredAcpDefinition({
          backend: options.backend,
          launchEnv: options.launchEnv,
        })
      : null
  );
  if (!definition) {
    throw new Error('Configured ACP backends require either a normalized definition or backend metadata');
  }

  return createAcpBackendFromDefinition({
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
