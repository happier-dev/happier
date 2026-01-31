import type { McpServerConfig } from '@/agent';
import type { AgentBackend } from '@/agent/core';
import { createCatalogAcpBackend } from '@/agent/acp';
import type { AcpPermissionHandler } from '@/agent/acp/AcpBackend';
import { createAcpRuntime } from '@/agent/acp/runtime/createAcpRuntime';
import type { ApiSessionClient } from '@/api/apiSession';
import type { MessageBuffer } from '@/ui/ink/messageBuffer';
import { logger } from '@/ui/logger';

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
}) {
  const lastPublishedAuggieSessionId = { value: null as string | null };
  let backend: AgentBackend | null = null;

  return createAcpRuntime({
    provider: 'auggie',
    directory: params.directory,
    session: params.session,
    messageBuffer: params.messageBuffer,
    mcpServers: params.mcpServers,
    permissionHandler: params.permissionHandler,
    onThinkingChange: params.onThinkingChange,
    ensureBackend: async () => {
      if (backend) return backend;
      const created = await createCatalogAcpBackend<AuggieBackendOptions>('auggie', {
        cwd: params.directory,
        mcpServers: params.mcpServers,
        permissionHandler: params.permissionHandler,
        allowIndexing: params.allowIndexing,
      });
      backend = created.backend;
      logger.debug('[AuggieACP] Backend created');
      return backend;
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

