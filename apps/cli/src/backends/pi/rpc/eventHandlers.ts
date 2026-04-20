import type { AgentMessage, AgentMessageHandler } from '@/agent/core';
import { logger } from '@/ui/logger';
import { redactBugReportSensitiveText } from '@happier-dev/protocol';

import { mapPiRpcEventToAgentMessages } from './eventMapping';
import { asNonEmptyString, asRecord, type PendingRpcRequest } from './rpcSupport';
import type { PiRpcResponse } from './types';

export type PiRpcEventHandlerContext = Readonly<{
  disposed: boolean;
  messageHandlers: ReadonlySet<AgentMessageHandler>;
  pendingRequests: Map<string, PendingRpcRequest>;
  openPromptRequestIds: Set<string>;
  resolvePendingTurn: () => void;
  rejectPendingTurn: (error: Error) => void;
  publishUsageStatsBestEffort: () => Promise<void>;
}>;

export function emitPiRpcMessage(
  messageHandlers: ReadonlySet<AgentMessageHandler>,
  message: AgentMessage,
): void {
  const safeMessage: AgentMessage =
    message.type === 'terminal-output'
      ? ({ ...message, data: redactBugReportSensitiveText(String(message.data ?? '')) } as AgentMessage)
      : message;

  for (const handler of messageHandlers) {
    try {
      handler(safeMessage);
    } catch (error) {
      logger.debug('[pi] Message handler failed (non-fatal)', error);
    }
  }
}

export function handlePiRpcResponse(
  context: PiRpcEventHandlerContext,
  emitMessage: (message: AgentMessage) => void,
  response: PiRpcResponse,
): void {
  const id = asNonEmptyString(response.id);
  if (!id) return;
  const pending = context.pendingRequests.get(id);
  if (!pending) {
    if (response.command === 'prompt' && !response.success && context.openPromptRequestIds.has(id)) {
      context.openPromptRequestIds.delete(id);
      const detail = asNonEmptyString(response.error) ?? 'Pi prompt failed';
      context.rejectPendingTurn(new Error(detail));
      emitMessage({ type: 'status', status: 'error', detail });
    }
    return;
  }

  clearTimeout(pending.timeout);
  context.pendingRequests.delete(id);

  if (!response.success) {
    context.openPromptRequestIds.delete(id);
    pending.reject(new Error(asNonEmptyString(response.error) ?? `Pi RPC command failed: ${response.command}`));
    return;
  }
  if (pending.commandType === 'prompt') {
    context.openPromptRequestIds.add(id);
  }
  pending.resolve(response);
}

export function handlePiRpcEvent(
  context: PiRpcEventHandlerContext,
  emitMessage: (message: AgentMessage) => void,
  event: Record<string, unknown>,
): void {
  for (const msg of mapPiRpcEventToAgentMessages(event)) {
    emitMessage(msg);
  }

  if (event.type === 'turn_end' || event.type === 'agent_end') {
    context.resolvePendingTurn();
    void context.publishUsageStatsBestEffort();
  }

  if (event.type === 'message_update') {
    const assistant = asRecord(event.assistantMessageEvent);
    const assistantType = asNonEmptyString(assistant?.type);
    if (assistantType === 'thinking_start') {
      emitMessage({ type: 'event', name: 'thinking_update', payload: { thinking: true } });
    } else if (assistantType === 'thinking_end' || assistantType === 'text_start' || assistantType === 'text_delta') {
      emitMessage({ type: 'event', name: 'thinking_update', payload: { thinking: false } });
    }
  }
}

export function handlePiRpcStdoutLine(
  context: PiRpcEventHandlerContext,
  emitMessage: (message: AgentMessage) => void,
  line: string,
): void {
  const trimmed = line.trim();
  if (!trimmed) return;

  const parsed = (() => {
    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      emitMessage({ type: 'terminal-output', data: line });
      return null;
    }
  })();
  if (!parsed) return;

  const record = asRecord(parsed);
  if (!record) return;

  if (record.type === 'response') {
    handlePiRpcResponse(context, emitMessage, record as PiRpcResponse);
    return;
  }

  handlePiRpcEvent(context, emitMessage, record);
}

export function handlePiRpcStderrLine(
  disposed: boolean,
  emitMessage: (message: AgentMessage) => void,
  line: string,
): void {
  const trimmed = line.trim();
  if (!trimmed) return;
  emitMessage({ type: 'terminal-output', data: trimmed });

  if (disposed) return;

  const normalized = trimmed.toLowerCase();
  if (normalized.includes('api key') || normalized.includes('unauthorized') || normalized.includes('authentication')) {
    emitMessage({
      type: 'status',
      status: 'error',
      detail: 'Pi authentication error. Check your API credentials for the configured provider.',
    });
  }
}
