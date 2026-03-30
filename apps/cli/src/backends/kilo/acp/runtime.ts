import type { McpServerConfig } from '@/agent';
import type { AcpPermissionHandler } from '@/agent/acp/AcpBackend';
import { createCatalogProviderAcpRuntime } from '@/agent/acp/runtime/createCatalogProviderAcpRuntime';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { PermissionMode } from '@/api/types';
import type { MessageBuffer } from '@/ui/ink/messageBuffer';

import { maybeUpdateKiloSessionIdMetadata } from '@/backends/kilo/utils/kiloSessionIdMetadata';

export function createKiloAcpRuntime(params: {
  directory: string;
  machineId: string;
  session: ApiSessionClient;
  messageBuffer: MessageBuffer;
  mcpServers: Record<string, McpServerConfig>;
  permissionHandler: AcpPermissionHandler;
  onThinkingChange: (thinking: boolean) => void;
  memoryRecallGuidanceEnabled?: boolean;
  getPermissionMode?: () => PermissionMode | null | undefined;
}) {
  const lastPublishedKiloSessionId = { value: null as string | null };

  return createCatalogProviderAcpRuntime({
    provider: 'kilo',
    loggerLabel: 'KiloACP',
    directory: params.directory,
    session: params.session,
    messageBuffer: params.messageBuffer,
    mcpServers: params.mcpServers,
    permissionHandler: params.permissionHandler,
    onThinkingChange: params.onThinkingChange,
    memoryRecallGuidance: {
      enabled: params.memoryRecallGuidanceEnabled === true,
      machineId: params.machineId,
    },
    getPermissionMode: params.getPermissionMode,
    onSessionIdChange: (nextSessionId) => {
      maybeUpdateKiloSessionIdMetadata({
        getKiloSessionId: () => nextSessionId,
        updateHappySessionMetadata: (updater) => params.session.updateMetadata(updater),
        lastPublished: lastPublishedKiloSessionId,
      });
    },
  });
}
