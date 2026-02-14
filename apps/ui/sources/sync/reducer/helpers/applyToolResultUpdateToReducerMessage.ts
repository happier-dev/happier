import type { MessageMeta } from '../../domains/messages/messageMetaTypes';
import type { ReducerMessage } from '../reducer';
import {
  coerceStreamingToolResultChunk,
  mergeExistingStdStreamsIntoFinalResultIfMissing,
  mergeStreamingChunkIntoResult,
} from './streamingToolResult';
import type { ToolResultUpdate } from './toolResultUpdateTypes';

export function applyToolResultUpdateToReducerMessage(params: Readonly<{
  message: ReducerMessage;
  messageId: string;
  toolResult: ToolResultUpdate;
  resultCreatedAt: number;
  meta?: MessageMeta;
  changed: Set<string>;
}>): void {
  const { message, messageId, toolResult, resultCreatedAt, meta, changed } = params;

  if (!message.tool) return;

  if (meta) {
    message.meta = {
      ...(message.meta ?? {}),
      ...meta,
    };
  }

  const isApprovedPlaceholder =
    message.tool.state === 'completed' &&
    message.tool.result === 'Approved' &&
    message.tool.permission?.status === 'approved';

  if (message.tool.state !== 'running' && !isApprovedPlaceholder) {
    return;
  }

  if (isApprovedPlaceholder) {
    message.tool.state = 'running';
    message.tool.completedAt = null;
    message.tool.result = undefined;
  }

  const streamChunk = coerceStreamingToolResultChunk(toolResult.content);
  if (streamChunk) {
    message.tool.result = mergeStreamingChunkIntoResult(message.tool.result, streamChunk);
    changed.add(messageId);
    return;
  }

  message.tool.state = toolResult.is_error ? 'error' : 'completed';
  message.tool.result = mergeExistingStdStreamsIntoFinalResultIfMissing(
    message.tool.result,
    toolResult.content
  );
  message.tool.completedAt = resultCreatedAt;

  if (toolResult.permissions) {
    if (message.tool.permission) {
      const existingDecision = message.tool.permission.decision;
      message.tool.permission = {
        ...message.tool.permission,
        id: toolResult.tool_use_id,
        status: toolResult.permissions.result === 'approved' ? 'approved' : 'denied',
        date: toolResult.permissions.date,
        mode: toolResult.permissions.mode,
        allowedTools: toolResult.permissions.allowedTools,
        decision: toolResult.permissions.decision || existingDecision,
      };
    } else {
      message.tool.permission = {
        id: toolResult.tool_use_id,
        status: toolResult.permissions.result === 'approved' ? 'approved' : 'denied',
        date: toolResult.permissions.date,
        mode: toolResult.permissions.mode,
        allowedTools: toolResult.permissions.allowedTools,
        decision: toolResult.permissions.decision,
      };
    }
  }

  changed.add(messageId);
}

