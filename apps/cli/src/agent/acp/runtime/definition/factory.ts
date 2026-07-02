import type { AcpPermissionHandler } from '@/agent/acp/AcpBackend';
import type { AgentFactoryOptions, McpServerConfig } from '@/agent/core';
import type {
  CatalogAcpBackendCreateResult,
  CatalogAcpBackendFactory,
} from '@/backends/types';

import type { AcpRuntimeDefinitionBridgeV1 } from './_types';

type AcpRuntimeFactoryOptions = AgentFactoryOptions & Readonly<{
  mcpServers?: Record<string, McpServerConfig>;
  permissionHandler?: AcpPermissionHandler;
  permissionMode?: string;
}>;

export function createAcpBackendFactoryFromRuntimeDefinitionBridge(
  bridge: AcpRuntimeDefinitionBridgeV1,
): CatalogAcpBackendFactory {
  return async (opts: AgentFactoryOptions): Promise<CatalogAcpBackendCreateResult> => {
    const { createAcpBackendFromDefinition } = await import('./backend');
    const runtimeOptions = opts as AcpRuntimeFactoryOptions;
    const definition = bridge.createDefinition({
      cwd: runtimeOptions.cwd,
      ...(runtimeOptions.env ? { env: runtimeOptions.env } : {}),
    });
    return {
      backend: await createAcpBackendFromDefinition({
        definition,
        cwd: runtimeOptions.cwd,
        ...(runtimeOptions.env ? { env: runtimeOptions.env } : {}),
        ...(runtimeOptions.mcpServers ? { mcpServers: runtimeOptions.mcpServers } : {}),
        ...(runtimeOptions.permissionHandler ? { permissionHandler: runtimeOptions.permissionHandler } : {}),
        ...(runtimeOptions.permissionMode ? { permissionMode: runtimeOptions.permissionMode } : {}),
        exec: bridge.exec,
      }),
    };
  };
}
