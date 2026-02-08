import type { McpServerConfig } from '@/agent';
import type { AgentBackend } from '@/agent/core';
import type { AcpPermissionHandler } from '@/agent/acp/AcpBackend';
import { createAcpRuntime } from '@/agent/acp/runtime/createAcpRuntime';
import type { ApiSessionClient } from '@/api/apiSession';
import type { MessageBuffer } from '@/ui/ink/messageBuffer';
import { logger } from '@/ui/logger';

import { createCodexAcpBackend, type CodexAcpBackendOptions, type CodexAcpBackendResult } from '@/backends/codex/acp/backend';
import { maybeUpdateCodexSessionIdMetadata } from '@/backends/codex/utils/codexSessionIdMetadata';
import type { PermissionMode } from '@/api/types';
import { buildCodexAcpEnvOverrides } from '@/backends/codex/acp/env';

export function createCodexAcpRuntime(params: {
  directory: string;
  session: ApiSessionClient;
  messageBuffer: MessageBuffer;
  mcpServers: Record<string, McpServerConfig>;
  permissionHandler: AcpPermissionHandler;
  permissionMode: PermissionMode;
  getPermissionMode?: () => PermissionMode | null | undefined;
  onThinkingChange: (thinking: boolean) => void;
}) {
  const lastCodexAcpThreadIdPublished: { value: string | null } = { value: null };

  return createAcpRuntime({
    provider: 'codex',
    directory: params.directory,
    session: params.session,
    messageBuffer: params.messageBuffer,
    mcpServers: params.mcpServers,
    permissionHandler: params.permissionHandler,
    onThinkingChange: params.onThinkingChange,
    ensureBackend: async () => {
      const permissionModeRaw = params.getPermissionMode?.() ?? params.permissionMode;
      const permissionMode = typeof permissionModeRaw === 'string' ? permissionModeRaw : undefined;
      const created = createCodexAcpBackend({
        cwd: params.directory,
        env: buildCodexAcpEnvOverrides(),
        mcpServers: params.mcpServers,
        permissionHandler: params.permissionHandler,
        permissionMode,
      });
      logger.debug(`[CodexACP] Backend created (command=${created.spawn.command})`);
      return created.backend as unknown as AgentBackend;
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
