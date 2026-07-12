import type { McpServerConfig } from '@/agent';
import type { AcpPermissionHandler } from '@/agent/acp/AcpBackend';
import { createCatalogProviderAcpRuntime } from '@/agent/acp/runtime/createCatalogProviderAcpRuntime';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { PermissionMode } from '@/api/types';
import type { MessageBuffer } from '@/ui/ink/messageBuffer';

import type { AuggieBackendOptions } from '@/backends/auggie/acp/backend';

export function createAuggieAcpRuntime(params: {
  directory: string;
  machineId: string;
  session: ApiSessionClient;
  messageBuffer: MessageBuffer;
  mcpServers: Record<string, McpServerConfig>;
  permissionHandler: AcpPermissionHandler;
  onThinkingChange: (thinking: boolean) => void;
  memoryRecallGuidanceEnabled?: boolean;
  allowIndexing: boolean;
  getPermissionMode?: () => PermissionMode | null | undefined;
  pendingQueueDrainMaxPopPerWake?: number;
}) {
  return createCatalogProviderAcpRuntime<AuggieBackendOptions>({
    provider: 'auggie',
    loggerLabel: 'AuggieACP',
    directory: params.directory,
    session: params.session,
    messageBuffer: params.messageBuffer,
    mcpServers: params.mcpServers,
    permissionHandler: params.permissionHandler,
    sessionIdentity: { kind: 'manifest-metadata' },
    onThinkingChange: params.onThinkingChange,
    memoryRecallGuidance: {
      enabled: params.memoryRecallGuidanceEnabled === true,
      machineId: params.machineId,
    },
    getPermissionMode: params.getPermissionMode,
    pendingQueueDrainMaxPopPerWake: params.pendingQueueDrainMaxPopPerWake,
    backendOptions: {
      allowIndexing: params.allowIndexing,
    },
  });
}
