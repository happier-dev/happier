import { decodeTranscriptBody } from '@/session/services/transcript/transcriptBodyDecoder';

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

export function extractAssistantTextSnapshotFromAcpMessage(
  provider: ACPProvider,
  body: ACPMessageData,
): ExtractedAssistantTextSnapshot | null {
  const decoded = decodeTranscriptBody({
    role: 'agent',
    content: {
      type: 'acp',
      provider,
      data: body,
    },
  });
  if (decoded?.semanticRole !== 'assistant' || !decoded.text) return null;
  return {
    text: decoded.text,
    provider: decoded.provider ?? provider,
    sidechainId: decoded.sidechainId ?? null,
  };
}

export function extractAssistantTextSnapshotFromSessionContent(content: unknown): ExtractedAssistantTextSnapshot | null {
  const record = asRecord(content);
  if (record?.role !== 'agent') return null;
  if (!asRecord(record.content)) return null;
  const decoded = decodeTranscriptBody(content);
  if (decoded?.semanticRole !== 'assistant' || !decoded.text) return null;
  return {
    text: decoded.text,
    provider: decoded.provider ?? null,
    sidechainId: decoded.sidechainId ?? readNonEmptyString(record.sidechainId),
  };
}
