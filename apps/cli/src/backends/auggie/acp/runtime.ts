import type { McpServerConfig } from '@/agent';
import type { AcpPermissionHandler } from '@/agent/acp/AcpBackend';
import { createCatalogProviderAcpRuntime } from '@/agent/acp/runtime/createCatalogProviderAcpRuntime';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { PermissionMode } from '@/api/types';
import type { MessageBuffer } from '@/ui/ink/messageBuffer';

import type { AuggieBackendOptions } from '@/backends/auggie/acp/backend';
import { maybeUpdateAuggieSessionIdMetadata } from '@/backends/auggie/utils/auggieSessionIdMetadata';

export function createAuggieAcpRuntime(params: {
  directory: string;
  session: ApiSessionClient;
  messageBuffer: MessageBuffer;
  mcpServers: Record<string, McpServerConfig>;
  permissionHandler: AcpPermissionHandler;
  onThinkingChange: (thinking: boolean) => void;
  allowIndexing: boolean;
  getPermissionMode?: () => PermissionMode | null | undefined;
}) {
  const lastPublishedAuggieSessionId = { value: null as string | null };

  return createCatalogProviderAcpRuntime<AuggieBackendOptions>({
    provider: 'auggie',
    loggerLabel: 'AuggieACP',
    directory: params.directory,
    session: params.session,
    messageBuffer: params.messageBuffer,
    mcpServers: params.mcpServers,
    permissionHandler: params.permissionHandler,
    onThinkingChange: params.onThinkingChange,
    getPermissionMode: params.getPermissionMode,
    backendOptions: {
      allowIndexing: params.allowIndexing,
    },
    onSessionIdChange: (nextSessionId) => {
      maybeUpdateAuggieSessionIdMetadata({
        getAuggieSessionId: () => nextSessionId,
        updateHappySessionMetadata: (updater) => params.session.updateMetadata(updater),
        lastPublished: lastPublishedAuggieSessionId,
      });
    },
  });
}
