import type { McpServerConfig } from '@/agent';
import type { AgentBackend } from '@/agent/core';
import { createCatalogAcpBackend } from '@/agent/acp';
import type { AcpPermissionHandler } from '@/agent/acp/AcpBackend';
import { createAcpRuntime } from '@/agent/acp/runtime/createAcpRuntime';
import type { ApiSessionClient } from '@/api/apiSession';
import type { PermissionMode } from '@/api/types';
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
  getPermissionMode?: () => PermissionMode | null | undefined;
}) {
  const lastPublishedAuggieSessionId = { value: null as string | null };

  return createAcpRuntime({
    provider: 'auggie',
    directory: params.directory,
    session: params.session,
    messageBuffer: params.messageBuffer,
    mcpServers: params.mcpServers,
    permissionHandler: params.permissionHandler,
    onThinkingChange: params.onThinkingChange,
    ensureBackend: async () => {
      const permissionModeRaw = params.getPermissionMode?.();
      const permissionMode = typeof permissionModeRaw === 'string' ? permissionModeRaw : undefined;
      const created = await createCatalogAcpBackend<AuggieBackendOptions>('auggie', {
        cwd: params.directory,
        mcpServers: params.mcpServers,
        permissionHandler: params.permissionHandler,
        allowIndexing: params.allowIndexing,
        permissionMode,
      });
      logger.debug('[AuggieACP] Backend created');
      return created.backend as unknown as AgentBackend;
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
