import { isClaudeAsyncAgentLaunchToolResult } from '@happier-dev/protocol';

import type { MessageMeta } from '../../domains/messages/messageMetaTypes';
import type { ReducerMessage } from '../reducer';
import {
  coerceStreamingToolResultChunk,
  mergeExistingStdStreamsIntoFinalResultIfMissing,
  mergeStreamingChunkIntoResult,
} from './streamingToolResult';
import type { ToolResultUpdate } from './toolResultUpdateTypes';

const REQUEST_INTERRUPTED_REASON = 'Request interrupted';

function readObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isLegacyRequestInterruptedPlaceholder(message: ReducerMessage): boolean {
  const tool = message.tool;
  if (!tool) return false;
  if (tool.state !== 'error') return false;

  const resultError = readObject(tool.result)?.error;
  return resultError === REQUEST_INTERRUPTED_REASON || tool.permission?.reason === REQUEST_INTERRUPTED_REASON;
}

function clearSyntheticInterruptionPermission(message: ReducerMessage): void {
  const permission = message.tool?.permission;
  if (!permission) return;
  if (permission.reason !== REQUEST_INTERRUPTED_REASON) return;

  permission.status = 'approved';
  delete permission.reason;
  if (permission.decision === 'abort') {
    delete permission.decision;
  }
}

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
  const isUnavailablePlaceholder = message.tool.state === 'unavailable';
  const isLegacyRequestInterrupted = isLegacyRequestInterruptedPlaceholder(message);
  // A fourth provisional completion: Claude answers an ASYNCHRONOUS agent launch within
  // milliseconds with an acknowledgement, then delivers the agent's real result — rewritten from
  // its `<task-notification>` — against the same tool-use id hours later. Without this the second
  // result was dropped and the card stayed frozen on "Async agent launched successfully" forever.
  // A replay of the acknowledgement itself is not new evidence, so the incoming result must be a
  // different kind of answer for the exception to apply.
  const supersedesAsyncAgentLaunch =
    message.tool.state === 'completed' &&
    isClaudeAsyncAgentLaunchToolResult(message.tool.result) &&
    !isClaudeAsyncAgentLaunchToolResult(toolResult.content);

  if (
    message.tool.state !== 'running' &&
    !isApprovedPlaceholder &&
    !isUnavailablePlaceholder &&
    !isLegacyRequestInterrupted &&
    !supersedesAsyncAgentLaunch
  ) {
    return;
  }

  if (supersedesAsyncAgentLaunch) {
    // The acknowledgement is not partial output to merge with — it is a different answer to a
    // different question, so the agent's real result replaces it outright.
    message.tool.result = undefined;
  }

  if (isApprovedPlaceholder || isUnavailablePlaceholder || isLegacyRequestInterrupted) {
    message.tool.state = 'running';
    message.tool.completedAt = null;
    if (isApprovedPlaceholder || isLegacyRequestInterrupted) {
      message.tool.result = undefined;
    }
    if (isLegacyRequestInterrupted) {
      clearSyntheticInterruptionPermission(message);
    }
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
