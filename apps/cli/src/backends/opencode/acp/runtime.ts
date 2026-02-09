import type { McpServerConfig } from '@/agent';
import type { AcpPermissionHandler } from '@/agent/acp/AcpBackend';
import { createCatalogProviderAcpRuntime } from '@/agent/acp/runtime/createCatalogProviderAcpRuntime';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { PermissionMode } from '@/api/types';
import type { MessageBuffer } from '@/ui/ink/messageBuffer';
import { OpenCodeTurnDiffAccumulator } from '../utils/turnDiffAccumulator';

export function createOpenCodeAcpRuntime(params: {
  directory: string;
  session: ApiSessionClient;
  messageBuffer: MessageBuffer;
  mcpServers: Record<string, McpServerConfig>;
  permissionHandler: AcpPermissionHandler;
  onThinkingChange: (thinking: boolean) => void;
  /**
   * Return the latest permission mode intent so the next backend spawn can apply it.
   * Used for provider-enforced permission/sandbox policies that are configured at process start.
   */
  getPermissionMode?: () => PermissionMode | null | undefined;
}) {
  const turnDiffAccumulator = new OpenCodeTurnDiffAccumulator();

  return createCatalogProviderAcpRuntime({
    provider: 'opencode',
    loggerLabel: 'OpenCodeACP',
    directory: params.directory,
    session: params.session,
    messageBuffer: params.messageBuffer,
    mcpServers: params.mcpServers,
    permissionHandler: params.permissionHandler,
    onThinkingChange: params.onThinkingChange,
    getPermissionMode: params.getPermissionMode,
    hooks: {
      onBeginTurn: () => {
        turnDiffAccumulator.beginTurn();
      },
      onToolResult: ({ toolName, result }) => {
        // OpenCode emits file diffs on Edit tool results via output.metadata.filediff (before/after).
        // We coalesce per-file changes into a single before/after pair for the turn.
        turnDiffAccumulator.observeToolResult(toolName, result);
      },
      onBeforeFlushTurn: ({ sendToolCall, sendToolResult }) => {
        const diff = turnDiffAccumulator.flushTurn();
        if (!diff.files || diff.files.length === 0) return;
        const callId = sendToolCall({ toolName: 'Diff', input: diff });
        sendToolResult({ callId, output: { status: 'completed' } });
      },
    },
  });
}
