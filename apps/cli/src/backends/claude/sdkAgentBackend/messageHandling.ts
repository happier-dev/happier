import type { AgentMessage } from '@/agent/core/AgentBackend';
import { extractAcpMediaContentBlocks } from '@/agent/acp/media/extractAcpMediaContentBlocks';
import type { SDKAssistantMessage, SDKMessage, SDKResultMessage, SDKSystemMessage } from '@/backends/claude/sdk/types';
import { isClaudeExplicitDiffToolInput } from '../utils/isClaudeExplicitDiffToolInput';
import type { ClaudeSdkLifecycleState, ClaudeSdkRuntimeState } from './runtimeState';
import { emitClaudeSdkTurnDiff } from './turnDiff';

export function handleClaudeSdkMessage(params: Readonly<{
  emit: (message: AgentMessage) => void;
  emitTokenCountTelemetry: (result: SDKResultMessage) => void;
  lifecycle: ClaudeSdkLifecycleState;
  noteVendorSessionId: (sessionIdRaw: unknown) => void;
  runtime: ClaudeSdkRuntimeState;
  sdkMessage: SDKMessage;
}>): void {
  const msg = params.sdkMessage;
  if (!msg || typeof msg !== 'object') return;
  const type = msg.type;
  if (type === 'system') {
    handleSystemMessage({
      emit: params.emit,
      lifecycle: params.lifecycle,
      noteVendorSessionId: params.noteVendorSessionId,
      runtime: params.runtime,
      systemMessage: msg as SDKSystemMessage,
    });
    return;
  }

  if (type === 'user') {
    handleUserMessage({
      emit: params.emit,
      runtime: params.runtime,
      userMessage: msg as SDKMessage & { message?: { content?: unknown } },
    });
    return;
  }

  if (type === 'assistant') {
    handleAssistantMessage({
      assistantMessage: msg as SDKAssistantMessage,
      emit: params.emit,
      runtime: params.runtime,
    });
    return;
  }

  if (type === 'result') {
    handleResultMessage({
      emit: params.emit,
      emitTokenCountTelemetry: params.emitTokenCountTelemetry,
      lifecycle: params.lifecycle,
      noteVendorSessionId: params.noteVendorSessionId,
      resultMessage: msg as SDKResultMessage,
      runtime: params.runtime,
    });
  }
}

function handleSystemMessage(params: Readonly<{
  emit: (message: AgentMessage) => void;
  lifecycle: ClaudeSdkLifecycleState;
  noteVendorSessionId: (sessionIdRaw: unknown) => void;
  runtime: ClaudeSdkRuntimeState;
  systemMessage: SDKSystemMessage;
}>): void {
  if (params.systemMessage.subtype !== 'init') return;
  const previousVendorSessionId = params.lifecycle.vendorSessionId;
  params.noteVendorSessionId(params.systemMessage.session_id);
  params.emit({ type: 'status', status: 'running' });
  const pending = params.runtime.pendingTurn;
  const nextSessionId = typeof params.systemMessage.session_id === 'string' ? params.systemMessage.session_id.trim() : '';
  const isSessionBoundary = Boolean(
    pending &&
    previousVendorSessionId &&
    nextSessionId &&
    previousVendorSessionId !== nextSessionId,
  );
  if (!isSessionBoundary || !pending) return;

  const turnChangeSet = params.runtime.turnChangeTracker.completeTurn({
    sessionId: params.lifecycle.vendorSessionId ?? params.lifecycle.localSessionId,
    status: 'completed',
  });
  if (turnChangeSet) {
    emitClaudeSdkTurnDiff({
      emit: params.emit,
      turnChangeSet,
    });
  }
  params.runtime.toolNameByCallId.clear();
  params.runtime.suppressedExplicitDiffCallIds.clear();
  params.runtime.pendingTurn = null;
  params.runtime.pendingTurnCompletion = null;
  params.runtime.settledTurnOrdinal = params.runtime.currentTurnOrdinal;
  pending.resolve();
  params.emit({ type: 'status', status: 'idle' });
}

function handleUserMessage(params: Readonly<{
  emit: (message: AgentMessage) => void;
  runtime: ClaudeSdkRuntimeState;
  userMessage: SDKMessage & { message?: { content?: unknown } };
}>): void {
  const content = params.userMessage?.message?.content;
  if (!Array.isArray(content)) return;
  const providerEventId = typeof params.userMessage.uuid === 'string' ? params.userMessage.uuid : undefined;
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if ((block as { type?: unknown }).type !== 'tool_result') continue;
    const callId = typeof (block as { tool_use_id?: unknown }).tool_use_id === 'string'
      ? String((block as { tool_use_id?: unknown }).tool_use_id)
      : '';
    if (!callId) continue;
    params.runtime.turnChangeTracker.observeToolResult({
      callId,
      isError: (block as { is_error?: unknown }).is_error === true,
    });
    if (params.runtime.suppressedExplicitDiffCallIds.has(callId)) {
      continue;
    }
    const toolName = params.runtime.toolNameByCallId.get(callId) ?? 'unknown';
    params.emit({
      type: 'tool-result',
      toolName,
      callId,
      result: (block as { content?: unknown }).content,
    });
    const mediaResult = extractAcpMediaContentBlocks((block as { content?: unknown }).content, {
      originSource: 'tool-output',
      toolCallId: callId,
      ...(providerEventId ? { providerEventId } : {}),
    });
    if (mediaResult.media.length > 0) {
      params.emit({
        type: 'event',
        name: 'session_media',
        payload: {
          localId: `claude-media-${callId}`,
          role: 'output',
          category: 'tool-artifact',
          media: mediaResult.media,
        },
      });
    }
  }
}

function handleAssistantMessage(params: Readonly<{
  assistantMessage: SDKAssistantMessage;
  emit: (message: AgentMessage) => void;
  runtime: ClaudeSdkRuntimeState;
}>): void {
  const assistantContent = params.assistantMessage?.message?.content;
  if (Array.isArray(assistantContent)) {
    for (const block of assistantContent) {
      if (!block || typeof block !== 'object') continue;
      if ((block as { type?: unknown }).type !== 'tool_use') continue;
      const callId = typeof (block as { id?: unknown }).id === 'string' ? String((block as { id?: unknown }).id) : '';
      const toolName = typeof (block as { name?: unknown }).name === 'string'
        ? String((block as { name?: unknown }).name)
        : '';
      if (!callId || !toolName) continue;
      params.runtime.toolNameByCallId.set(callId, toolName);
      const rawInput = (block as { input?: unknown }).input;
      const args = rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput)
        ? (rawInput as Record<string, unknown>)
        : {};
      params.runtime.turnChangeTracker.observeToolCall({
        callId,
        toolName,
        args,
        parentToolUseId: params.assistantMessage.parent_tool_use_id,
      });
      if (isClaudeExplicitDiffToolInput(toolName, args)) {
        params.runtime.suppressedExplicitDiffCallIds.add(callId);
        continue;
      }
      params.emit({ type: 'tool-call', toolName, callId, args });
    }
  }

  const text = extractAssistantText(params.assistantMessage);
  const providerEventId = typeof params.assistantMessage.uuid === 'string'
    ? params.assistantMessage.uuid
    : undefined;
  const mediaResult = extractAcpMediaContentBlocks(assistantContent, {
    originSource: 'provider-generated',
    ...(providerEventId ? { providerEventId } : {}),
  });
  if (mediaResult.media.length > 0) {
    params.emit({
      type: 'event',
      name: 'session_media',
      payload: {
        localId: `claude-media-${providerEventId ?? 'assistant'}`,
        role: 'output',
        category: 'generated',
        media: mediaResult.media,
      },
    });
  }
  if (!text) return;
  const pending = params.runtime.pendingTurn;
  if (pending) {
    pending.buffer.push(text);
    params.emit({ type: 'model-output', fullText: pending.buffer.join('\n').trim() });
    return;
  }
  params.emit({ type: 'model-output', fullText: text });
}

function handleResultMessage(params: Readonly<{
  emit: (message: AgentMessage) => void;
  emitTokenCountTelemetry: (result: SDKResultMessage) => void;
  lifecycle: ClaudeSdkLifecycleState;
  noteVendorSessionId: (sessionIdRaw: unknown) => void;
  resultMessage: SDKResultMessage;
  runtime: ClaudeSdkRuntimeState;
}>): void {
  if (params.resultMessage.num_turns <= params.runtime.settledTurnOrdinal) {
    if (params.runtime.ignoreNextNonSuccessResult) {
      params.runtime.ignoreNextNonSuccessResult = false;
    }
    return;
  }

  params.noteVendorSessionId(params.resultMessage.session_id);
  params.emitTokenCountTelemetry(params.resultMessage);

  if (params.resultMessage.subtype === 'success') {
    const turnChangeSet = params.runtime.turnChangeTracker.completeTurn({
      sessionId: params.lifecycle.vendorSessionId ?? params.lifecycle.localSessionId,
      status: 'completed',
    });
    if (turnChangeSet) {
      emitClaudeSdkTurnDiff({
        emit: params.emit,
        turnChangeSet,
      });
    }
    params.runtime.toolNameByCallId.clear();
    params.runtime.suppressedExplicitDiffCallIds.clear();
    const pending = params.runtime.pendingTurn;
    if (pending) {
      params.runtime.pendingTurn = null;
      params.runtime.pendingTurnCompletion = null;
      pending.resolve();
    }
    params.runtime.settledTurnOrdinal = params.resultMessage.num_turns;
    params.emit({ type: 'status', status: 'idle' });
    return;
  }

  if (params.runtime.ignoreNextNonSuccessResult) {
    params.runtime.ignoreNextNonSuccessResult = false;
  }
  const pending = params.runtime.pendingTurn;
  if (pending) {
    params.runtime.pendingTurn = null;
    params.runtime.pendingTurnCompletion = null;
    params.runtime.turnChangeTracker.resetTurn();
    params.runtime.suppressedExplicitDiffCallIds.clear();
    pending.reject(new Error(`Claude SDK error: ${params.resultMessage.subtype}`));
  }
  params.runtime.settledTurnOrdinal = params.resultMessage.num_turns;
  params.emit({ type: 'status', status: 'error', detail: String(params.resultMessage.subtype) });
}

function extractAssistantText(msg: SDKAssistantMessage): string {
  const parts = Array.isArray(msg?.message?.content) ? msg.message.content : [];
  const texts: string[] = [];
  for (const part of parts) {
    if (!part || typeof part !== 'object') continue;
    const record = part as { type?: unknown; text?: unknown };
    if (record.type !== 'text') continue;
    const text = record.text;
    if (typeof text === 'string' && text.trim().length > 0) {
      texts.push(text);
    }
  }
  return texts.join('\n').trim();
}
