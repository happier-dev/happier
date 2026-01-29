import type { McpServerConfig } from '@/agent';
import type { AgentBackend } from '@/agent/core';
import { createCatalogAcpBackend } from '@/agent/acp';
import type { AcpPermissionHandler } from '@/agent/acp/AcpBackend';
import { createAcpRuntime } from '@/agent/acp/runtime/createAcpRuntime';
import type { ApiSessionClient } from '@/api/apiSession';
import type { MessageBuffer } from '@/ui/ink/messageBuffer';
import { logger } from '@/ui/logger';

import type { CodexAcpBackendOptions, CodexAcpBackendResult } from '@/backends/codex/acp/backend';
import { maybeUpdateCodexSessionIdMetadata } from '@/backends/codex/utils/codexSessionIdMetadata';

export function createCodexAcpRuntime(params: {
  directory: string;
  session: ApiSessionClient;
  messageBuffer: MessageBuffer;
  mcpServers: Record<string, McpServerConfig>;
  permissionHandler: AcpPermissionHandler;
  onThinkingChange: (thinking: boolean) => void;
}) {
  const lastCodexAcpThreadIdPublished: { value: string | null } = { value: null };
  let backend: AgentBackend | null = null;

  return createAcpRuntime({
    provider: 'codex',
    directory: params.directory,
    session: params.session,
    messageBuffer: params.messageBuffer,
    mcpServers: params.mcpServers,
    permissionHandler: params.permissionHandler,
    onThinkingChange: params.onThinkingChange,
    ensureBackend: async () => {
      if (backend) return backend;
      const created = await createCatalogAcpBackend<CodexAcpBackendOptions, CodexAcpBackendResult>('codex', {
        cwd: params.directory,
        mcpServers: params.mcpServers,
        permissionHandler: params.permissionHandler,
      });
      backend = created.backend;
      logger.debug(`[CodexACP] Backend created (command=${created.command})`);
      return backend;
    },
    onSessionIdChange: (nextSessionId) => {
      maybeUpdateCodexSessionIdMetadata({
        getCodexThreadId: () => nextSessionId,
        updateHappySessionMetadata: (updater) => params.session.updateMetadata(updater),
        lastPublished: lastCodexAcpThreadIdPublished,
      });
    },
  });
}

