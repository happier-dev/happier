import type { McpServerConfig } from '@/agent';
import type { AcpPermissionHandler } from '@/agent/acp/AcpBackend';
import { createCatalogProviderAcpRuntime } from '@/agent/acp/runtime/createCatalogProviderAcpRuntime';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { MessageBuffer } from '@/ui/ink/messageBuffer';

import { maybeUpdateKimiSessionIdMetadata } from '@/backends/kimi/utils/kimiSessionIdMetadata';
import type { PermissionMode } from '@/api/types';

export function createKimiAcpRuntime(params: {
  directory: string;
  session: ApiSessionClient;
  messageBuffer: MessageBuffer;
  mcpServers: Record<string, McpServerConfig>;
  permissionHandler: AcpPermissionHandler;
  onThinkingChange: (thinking: boolean) => void;
  getPermissionMode?: () => PermissionMode | null | undefined;
}) {
  const lastPublishedKimiSessionId = { value: null as string | null };

  return createCatalogProviderAcpRuntime({
    provider: 'kimi',
    loggerLabel: 'KimiACP',
    directory: params.directory,
    session: params.session,
    messageBuffer: params.messageBuffer,
    mcpServers: params.mcpServers,
    permissionHandler: params.permissionHandler,
    onThinkingChange: params.onThinkingChange,
    getPermissionMode: params.getPermissionMode,
    resolvePermissionMode: ({ getPermissionMode, session }) =>
      getPermissionMode?.() ?? session.getMetadataSnapshot?.()?.permissionMode,
    onSessionIdChange: (nextSessionId) => {
      maybeUpdateKimiSessionIdMetadata({
        getKimiSessionId: () => nextSessionId,
        updateHappySessionMetadata: (updater) => params.session.updateMetadata(updater),
        lastPublished: lastPublishedKimiSessionId,
      });
    },
  });
}
