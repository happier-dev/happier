import { isAsyncSubAgentLaunchToolResult } from '@happier-dev/protocol/tools/v2';

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
  const isRuntimeTerminalResult =
    meta?.source === 'runtime' &&
    meta.runtimeEventKind === 'tool-result';
  // A second provisional completion: the generic sub-agent tool answers an ASYNCHRONOUS launch
  // within milliseconds with an acknowledgement, then delivers the agent's real result — rewritten
  // from its `<task-notification>` — against the same tool-use id hours later. That rewrite arrives
  // on the transcript channel, so `isRuntimeTerminalResult` never sees it; without this the second
  // result was dropped and the card stayed frozen on "Async agent launched successfully" forever.
  // A replay of the acknowledgement itself is not new evidence, so the incoming result must be a
  // different kind of answer for the exception to apply.
  const supersedesAsyncAgentLaunch =
    message.tool.state === 'completed' &&
    isAsyncSubAgentLaunchToolResult(message.tool.result) &&
    !isAsyncSubAgentLaunchToolResult(toolResult.content);

  if (
    message.tool.state !== 'running' &&
    !isApprovedPlaceholder &&
    !isRuntimeTerminalResult &&
    !supersedesAsyncAgentLaunch
  ) {
    return;
  }

  if (isApprovedPlaceholder) {
    message.tool.state = 'running';
    message.tool.completedAt = null;
    message.tool.result = undefined;
  }

  if (supersedesAsyncAgentLaunch) {
    // The acknowledgement is not partial output to merge with — it is a different answer to a
    // different question, so the agent's real result replaces it outright.
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
