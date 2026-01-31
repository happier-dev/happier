import type { McpServerConfig } from '@/agent';
import type { AgentBackend } from '@/agent/core';
import { createCatalogAcpBackend } from '@/agent/acp';
import type { AcpPermissionHandler } from '@/agent/acp/AcpBackend';
import { createAcpRuntime } from '@/agent/acp/runtime/createAcpRuntime';
import type { ApiSessionClient } from '@/api/apiSession';
import type { MessageBuffer } from '@/ui/ink/messageBuffer';
import { logger } from '@/ui/logger';

export function createOpenCodeAcpRuntime(params: {
  directory: string;
  session: ApiSessionClient;
  messageBuffer: MessageBuffer;
  mcpServers: Record<string, McpServerConfig>;
  permissionHandler: AcpPermissionHandler;
  onThinkingChange: (thinking: boolean) => void;
}) {
  let backend: AgentBackend | null = null;

  return createAcpRuntime({
    provider: 'opencode',
    directory: params.directory,
    session: params.session,
    messageBuffer: params.messageBuffer,
    mcpServers: params.mcpServers,
    permissionHandler: params.permissionHandler,
    onThinkingChange: params.onThinkingChange,
    ensureBackend: async () => {
      if (backend) return backend;
      const created = await createCatalogAcpBackend('opencode', {
        cwd: params.directory,
        mcpServers: params.mcpServers,
        permissionHandler: params.permissionHandler,
      });
      backend = created.backend;
      logger.debug('[OpenCodeACP] Backend created');
      return backend;
    },
  });
}

