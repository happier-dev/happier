import { randomUUID } from 'node:crypto';

import type { AgentMessage } from '@/agent/core/AgentBackend';
import { emitCanonicalTurnDiffTool } from '@/agent/runtime/emitCanonicalTurnDiffTool';
import { ClaudeTurnChangeTracker } from '../utils/ClaudeTurnChangeTracker';

export function emitClaudeSdkTurnDiff(params: Readonly<{
  emit: (message: AgentMessage) => void;
  turnChangeSet: NonNullable<ReturnType<ClaudeTurnChangeTracker['completeTurn']>>;
}>): void {
  emitCanonicalTurnDiffTool({
    turnChangeSet: params.turnChangeSet,
    protocol: 'claude',
    rawToolName: 'ClaudeTurnDiff',
    sendToolCall: ({ toolName, input, callId }) => {
      const resolvedCallId = callId ?? randomUUID();
      const args = input && typeof input === 'object' && !Array.isArray(input)
        ? (input as Record<string, unknown>)
        : {};
      params.emit({ type: 'tool-call', toolName, callId: resolvedCallId, args });
      return resolvedCallId;
    },
    sendToolResult: ({ callId, output }) => {
      params.emit({ type: 'tool-result', toolName: 'Diff', callId, result: output });
    },
  });
}
