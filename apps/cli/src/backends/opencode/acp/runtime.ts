import { randomUUID } from 'node:crypto';
import type { McpServerConfig } from '@/agent';
import type { AcpPermissionHandler } from '@/agent/acp/AcpBackend';
import { createCatalogProviderAcpRuntime } from '@/agent/acp/runtime/createCatalogProviderAcpRuntime';
import { emitCanonicalTurnDiffTool } from '@/agent/runtime/emitCanonicalTurnDiffTool';
import { TurnChangeSetCollector } from '@/agent/tools/diff/turnChangeSetCollector';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { PermissionMode } from '@/api/types';
import type { MessageBuffer } from '@/ui/ink/messageBuffer';
import { extractOpenCodeFileDiff } from '../utils/extractOpenCodeFileDiff';

export function createOpenCodeAcpRuntime(params: {
  directory: string;
  machineId: string;
  session: ApiSessionClient;
  messageBuffer: MessageBuffer;
  mcpServers: Record<string, McpServerConfig>;
  permissionHandler: AcpPermissionHandler;
  onThinkingChange: (thinking: boolean) => void;
  memoryRecallGuidanceEnabled?: boolean;
  /**
   * Return the latest permission mode intent so the next backend spawn can apply it.
   * Used for provider-enforced permission/sandbox policies that are configured at process start.
   */
  getPermissionMode?: () => PermissionMode | null | undefined;
}) {
  const turnChangeCollector = new TurnChangeSetCollector({
    provider: 'opencode',
  });
  let turnStartSeqInclusive = 0;

  return createCatalogProviderAcpRuntime({
    provider: 'opencode',
    loggerLabel: 'OpenCodeACP',
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
    hooks: {
      onBeginTurn: () => {
        turnStartSeqInclusive = params.session.getLastObservedMessageSeq?.() ?? 0;
        turnChangeCollector.beginTurn();
      },
      onToolResult: ({ toolName, result }) => {
        const fileDiff = extractOpenCodeFileDiff(result);
        if (!fileDiff) return;
        turnChangeCollector.observeTextDiff({
          filePath: fileDiff.filePath,
          oldText: fileDiff.oldText,
          newText: fileDiff.newText,
          source: 'provider_tool',
          confidence: 'exact',
        });
      },
      onBeforeFlushTurn: ({ sendToolCall, sendToolResult }) => {
        const endSeqInclusive = params.session.getLastObservedMessageSeq?.() ?? turnStartSeqInclusive;
        const turnChangeSet = turnChangeCollector.flushTurn({
          sessionId: params.session.sessionId,
          turnId: `opencode-acp-turn-${randomUUID()}`,
          seqRange: {
            startSeqInclusive: turnStartSeqInclusive,
            endSeqInclusive: Math.max(turnStartSeqInclusive, endSeqInclusive),
          },
          status: 'completed',
        });
        if (!turnChangeSet) return;
        emitCanonicalTurnDiffTool({
          turnChangeSet,
          protocol: 'acp',
          rawToolName: 'OpenCodeDiff',
          sendToolCall,
          sendToolResult,
        });
      },
    },
  });
}
