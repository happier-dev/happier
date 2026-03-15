import type { AgentMessage } from '@/agent/core';
import type { MessageBuffer } from '@/ui/ink/messageBuffer';
import type { AcpRuntimeSessionClient } from '@/agent/acp/sessionClient';

type AgentKey = Parameters<AcpRuntimeSessionClient['sendAgentMessage']>[0];
type AgentPayload = Parameters<AcpRuntimeSessionClient['sendAgentMessage']>[1];
type SessionWithKeepAlive = Pick<AcpRuntimeSessionClient, 'keepAlive' | 'sendAgentMessage'>;
type SessionWithSendOnly = Pick<AcpRuntimeSessionClient, 'sendAgentMessage'>;
type MessageBufferForModelOutput = Pick<MessageBuffer, 'removeLastMessage' | 'addMessage' | 'updateLastMessage'>;

export function handleAcpModelOutputDelta(params: {
  delta: string;
  messageBuffer: MessageBufferForModelOutput;
  getIsResponseInProgress: () => boolean;
  setIsResponseInProgress: (value: boolean) => void;
  appendToAccumulatedResponse: (delta: string) => void;
}): void {
  const delta = params.delta ?? '';
  if (!delta) return;

  if (!params.getIsResponseInProgress()) {
    params.messageBuffer.removeLastMessage('system');
    params.messageBuffer.addMessage(delta, 'assistant');
    params.setIsResponseInProgress(true);
  } else {
    params.messageBuffer.updateLastMessage(delta, 'assistant');
  }

  params.appendToAccumulatedResponse(delta);
}

export function handleAcpStatusRunning(params: {
  session: SessionWithKeepAlive;
  agent: AgentKey;
  getTaskStartedSent: () => boolean;
  setTaskStartedSent: (value: boolean) => void;
  makeId: () => string;
}): void {
  if (!params.getTaskStartedSent()) {
    const payload: AgentPayload = { type: 'task_started', id: params.makeId() };
    params.session.sendAgentMessage(params.agent, payload);
    params.setTaskStartedSent(true);
  }
}

export function forwardAcpPermissionRequest(params: {
  msg: AgentMessage;
  session: SessionWithSendOnly;
  agent: AgentKey;
}): void {
  if (params.msg.type !== 'permission-request') return;
  const payload = (params.msg as any).payload || {};
  const normalizedPayload = normalizePermissionRequestOptionsForAcp(payload);

  const message: AgentPayload = {
    type: 'permission-request',
    permissionId: (params.msg as any).id,
    toolName: payload.toolName || (params.msg as any).reason || 'unknown',
    description: (params.msg as any).reason || payload.toolName || '',
    options: normalizedPayload,
  };

  params.session.sendAgentMessage(params.agent, message);
}

export function normalizePermissionRequestOptionsForAcp(payload: unknown): unknown {
  const asRecord = (value: unknown): Record<string, unknown> | null => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
  };

  const extractFilepath = (value: unknown): string | null => {
    const rec = asRecord(value);
    if (!rec) return null;
    const candidates = [rec.filepath, rec.filePath, rec.path];
    for (const cand of candidates) {
      if (typeof cand === 'string' && cand.trim().length > 0) return cand.trim();
    }
    return null;
  };

  const extractFilepathFromToolCall = (toolCall: unknown): string | null => {
    const rec = asRecord(toolCall);
    if (!rec) return null;

    const rawInput = rec.rawInput;
    const fromRaw = extractFilepath(rawInput);
    if (fromRaw) return fromRaw;

    const locations = Array.isArray(rec.locations) ? rec.locations : null;
    if (locations) {
      for (const loc of locations) {
        const locRec = asRecord(loc);
        const path = locRec && typeof locRec.path === 'string' ? locRec.path.trim() : '';
        if (path) return path;
      }
    }

    const content = Array.isArray(rec.content) ? rec.content : null;
    if (content) {
      for (const entry of content) {
        const entryRec = asRecord(entry);
        const path = entryRec && typeof entryRec.path === 'string' ? entryRec.path.trim() : '';
        if (path) return path;
      }
    }

    const files = Array.isArray((rawInput as any)?.files) ? (rawInput as any).files : null;
    if (files) {
      for (const file of files) {
        const fileRec = asRecord(file);
        const path = fileRec ? extractFilepath(fileRec) : null;
        if (path) return path;
      }
    }

    return null;
  };

  const buildSafeInputFromToolCall = (toolCall: unknown): Record<string, unknown> | null => {
    const filepath = extractFilepathFromToolCall(toolCall);
    if (!filepath) return null;
    return { filepath };
  };

  const backfillInputFromToolCall = (container: unknown): unknown => {
    if (!container || typeof container !== 'object') return container;
    if (Array.isArray(container)) return container;

    const record = container as Record<string, unknown>;
    const toolCall = record.toolCall;
    if (!toolCall || typeof toolCall !== 'object' || Array.isArray(toolCall)) return container;

    const safeInput = buildSafeInputFromToolCall(toolCall);
    if (!safeInput) return container;

    return { ...record, input: safeInput };
  };

  const topLevel = backfillInputFromToolCall(payload);
  if (!topLevel || typeof topLevel !== 'object' || Array.isArray(topLevel)) return topLevel;

  const record = topLevel as Record<string, unknown>;
  const maybeOptions = record.options;
  const nextOptions = backfillInputFromToolCall(maybeOptions);
  if (nextOptions === maybeOptions) return topLevel;
  return { ...record, options: nextOptions };
}
