import type { ACPMessageData, ACPProvider } from '../sessionMessageTypes';

type ExtractedAssistantTextSnapshot = Readonly<{
  text: string;
  provider: string | null;
  sidechainId: string | null;
}>;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readTextBlocks(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return null;
  const parts: string[] = [];
  for (const item of value) {
    const record = asRecord(item);
    if (record?.type === 'text' && typeof record.text === 'string') {
      parts.push(record.text);
    }
  }
  return parts.length > 0 ? parts.join('\n\n') : null;
}

export function extractAssistantTextSnapshotFromAcpMessage(
  provider: ACPProvider,
  body: ACPMessageData,
): ExtractedAssistantTextSnapshot | null {
  if (body.type !== 'message' || typeof body.message !== 'string') return null;
  return {
    text: body.message,
    provider,
    sidechainId: readNonEmptyString(body.sidechainId),
  };
}

export function extractAssistantTextSnapshotFromSessionContent(content: unknown): ExtractedAssistantTextSnapshot | null {
  const record = asRecord(content);
  if (record?.role !== 'agent') return null;
  const body = asRecord(record.content);
  if (!body) return null;

  if (body.type === 'text' && typeof body.text === 'string') {
    return {
      text: body.text,
      provider: null,
      sidechainId: readNonEmptyString(record.sidechainId),
    };
  }

  if (body.type === 'acp') {
    const data = asRecord(body.data);
    if (data?.type !== 'message' || typeof data.message !== 'string') return null;
    return {
      text: data.message,
      provider: readNonEmptyString(body.provider),
      sidechainId: readNonEmptyString(data.sidechainId),
    };
  }

  if (body.type === 'codex') {
    const data = asRecord(body.data);
    if ((data?.type !== 'message' && data?.type !== 'agent_message') || typeof data.message !== 'string') {
      return null;
    }
    return {
      text: data.message,
      provider: 'codex',
      sidechainId: readNonEmptyString(data.sidechainId),
    };
  }

  if (body.type === 'output') {
    const data = asRecord(body.data);
    if (data?.type !== 'assistant') return null;
    if (readNonEmptyString(data.parent_tool_use_id)) return null;
    const message = asRecord(data.message);
    const text = readTextBlocks(message?.content);
    if (text === null) return null;
    return {
      text,
      provider: 'claude',
      sidechainId: readNonEmptyString(data.sidechainId),
    };
  }

  return null;
}
