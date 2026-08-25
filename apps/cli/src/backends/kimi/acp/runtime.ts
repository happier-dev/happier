import type { McpServerConfig } from '@/agent';
import type { AcpPermissionHandler } from '@/agent/acp/AcpBackend';
import { createCatalogProviderAcpRuntime } from '@/agent/acp/runtime/createCatalogProviderAcpRuntime';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { MessageBuffer } from '@/ui/ink/messageBuffer';
import type { KimiBackendOptions } from '@/backends/kimi/acp/backend';

import type { PermissionMode } from '@/api/types';
import type { KimiAcpPythonSelector } from '@happier-dev/agents';
import type { SessionProviderInputConsumer } from '@/agent/runtime/sessionInput/types';

export function createKimiAcpRuntime(params: {
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
  kimiAcpPythonSelector?: KimiAcpPythonSelector;
  pendingQueueDrainMaxPopPerWake?: number;
  providerInputConsumer: SessionProviderInputConsumer<unknown, unknown>;
}) {
  return createCatalogProviderAcpRuntime<KimiBackendOptions>({
    provider: 'kimi',
    loggerLabel: 'KimiACP',
    directory: params.directory,
    session: params.session,
    messageBuffer: params.messageBuffer,
    mcpServers: params.mcpServers,
    permissionHandler: params.permissionHandler,
    sessionIdentity: { kind: 'manifest-metadata' },
    backendOptions: params.kimiAcpPythonSelector ? { kimiAcpPythonSelector: params.kimiAcpPythonSelector } : undefined,
    processEnv: params.processEnv,
    onThinkingChange: params.onThinkingChange,
    memoryRecallGuidance: {
      enabled: params.memoryRecallGuidanceEnabled === true,
      machineId: params.machineId,
    },
    getPermissionMode: params.getPermissionMode,
    pendingQueueDrainMaxPopPerWake: params.pendingQueueDrainMaxPopPerWake,
    providerInputConsumer: params.providerInputConsumer,
    resolvePermissionMode: ({ getPermissionMode, session }) =>
      getPermissionMode?.() ?? session.getMetadataSnapshot?.()?.permissionMode,
  });
}
