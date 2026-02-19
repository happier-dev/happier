import type { McpServerConfig } from '@/agent';
import type { AcpPermissionHandler } from '@/agent/acp/AcpBackend';
import { createCatalogProviderAcpRuntime } from '@/agent/acp/runtime/createCatalogProviderAcpRuntime';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { PermissionMode } from '@/api/types';
import type { MessageBuffer } from '@/ui/ink/messageBuffer';

import { maybeUpdateCopilotSessionIdMetadata } from '@/backends/copilot/utils/copilotSessionIdMetadata';

export function createCopilotAcpRuntime(params: {
  directory: string;
  session: ApiSessionClient;
  messageBuffer: MessageBuffer;
  mcpServers: Record<string, McpServerConfig>;
  permissionHandler: AcpPermissionHandler;
  onThinkingChange: (thinking: boolean) => void;
  getPermissionMode?: () => PermissionMode | null | undefined;
}) {
  const lastPublishedCopilotSessionId = { value: null as string | null };

  return createCatalogProviderAcpRuntime({
    provider: 'copilot',
    loggerLabel: 'CopilotACP',
    directory: params.directory,
    session: params.session,
    messageBuffer: params.messageBuffer,
    mcpServers: params.mcpServers,
    permissionHandler: params.permissionHandler,
    onThinkingChange: params.onThinkingChange,
    getPermissionMode: params.getPermissionMode,
    onSessionIdChange: (nextSessionId) => {
      maybeUpdateCopilotSessionIdMetadata({
        getCopilotSessionId: () => nextSessionId,
        updateHappySessionMetadata: (updater) => params.session.updateMetadata(updater),
        lastPublished: lastPublishedCopilotSessionId,
      });
    },
  });
}
