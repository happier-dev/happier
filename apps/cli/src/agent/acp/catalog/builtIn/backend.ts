import { type AgentId, getBuiltInAcpConfig } from '@happier-dev/agents';

import type { AcpBackend } from '@/agent/acp/AcpBackend';
import type { AcpPermissionHandler } from '@/agent/acp/permissions/acpPermissionHandler';
import type { AgentFactoryOptions } from '@/agent/catalog/factoryOptions';
import type { McpServerConfig } from '@/agent/core/AgentTypes';
import { createSynchronousAcpBackendFromDefinition, normalizeBuiltInAcpDefinition } from '@/agent/acp/runtime/definition';

export type BuiltInAcpBackendOptions = AgentFactoryOptions & Readonly<{
  mcpServers?: Record<string, McpServerConfig>;
  permissionHandler?: AcpPermissionHandler;
  permissionMode?: string;
}>;

export function createBuiltInBackend(
  agentId: AgentId,
  options: BuiltInAcpBackendOptions,
): AcpBackend {
  if (!getBuiltInAcpConfig(agentId)) {
    throw new Error(`Agent '${agentId}' is not a built-in generic ACP agent`);
  }
  return createSynchronousAcpBackendFromDefinition({
    definition: normalizeBuiltInAcpDefinition(agentId),
    cwd: options.cwd,
    env: options.env,
    permissionMode: options.permissionMode,
    mcpServers: options.mcpServers,
    permissionHandler: options.permissionHandler,
  });
}
