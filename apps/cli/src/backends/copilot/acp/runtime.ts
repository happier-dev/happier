import type { McpServerConfig } from '@/agent';
import type { AcpPermissionHandler } from '@/agent/acp/AcpBackend';
import { createCatalogProviderAcpRuntime } from '@/agent/acp/runtime/createCatalogProviderAcpRuntime';
import type { SessionProviderInputConsumer } from '@/agent/runtime/sessionInput/types';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { PermissionMode } from '@/api/types';
import type { MessageBuffer } from '@/ui/ink/messageBuffer';


export function createCopilotAcpRuntime(params: {
  directory: string;
  machineId: string;
  session: ApiSessionClient;
  messageBuffer: MessageBuffer;
  mcpServers: Record<string, McpServerConfig>;
  permissionHandler: AcpPermissionHandler;
  onThinkingChange: (thinking: boolean) => void;
  memoryRecallGuidanceEnabled?: boolean;
  getPermissionMode?: () => PermissionMode | null | undefined;
  processEnv?: NodeJS.ProcessEnv;
  pendingQueueDrainMaxPopPerWake?: number;
  providerInputConsumer: SessionProviderInputConsumer<unknown, unknown>;
}) {
  return createCatalogProviderAcpRuntime({
    provider: 'copilot',
    loggerLabel: 'CopilotACP',
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
    processEnv: params.processEnv,
    pendingQueueDrainMaxPopPerWake: params.pendingQueueDrainMaxPopPerWake,
    providerInputConsumer: params.providerInputConsumer,
  });
}
