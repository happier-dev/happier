import { createCatalogAcpBackend } from '@/agent/acp';
import type { McpServerConfig, AgentBackend } from '@/agent';
import type { PermissionMode } from '@/api/types';
import type { ProviderEnforcedPermissionHandler } from '@/agent/permissions/ProviderEnforcedPermissionHandler';

import type { GeminiBackendOptions, GeminiBackendResult } from '@/backends/gemini/acp/backend';

export async function createGeminiBackendInstance(params: {
  cwd: string;
  mcpServers: Record<string, McpServerConfig>;
  permissionHandler: ProviderEnforcedPermissionHandler;
  cloudToken?: string;
  currentUserEmail?: string;
  permissionMode: PermissionMode;
  model: string | null | undefined;
  onBackendCreated?: (backend: AgentBackend) => void;
}): Promise<GeminiBackendResult> {
  const backendResult = (await createCatalogAcpBackend<GeminiBackendOptions, GeminiBackendResult>('gemini', {
    cwd: params.cwd,
    mcpServers: params.mcpServers,
    permissionHandler: params.permissionHandler,
    cloudToken: params.cloudToken,
    currentUserEmail: params.currentUserEmail,
    permissionMode: params.permissionMode,
    // If undefined, backend resolves from local config/env/default.
    // If null, backend skips local config and resolves from env/default.
    model: params.model,
  })) as GeminiBackendResult;

  params.onBackendCreated?.(backendResult.backend);
  return backendResult;
}
