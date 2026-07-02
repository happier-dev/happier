import type { ExternalSessionTranscriptRawMessageV1 } from '@happier-dev/protocol';

import {
  classifyOpenCodeMessageForProjection,
  extractOpenCodeProjectedText,
} from '../../../runtime/server/transcript/projection/index.js';

export function measureOpenCodeExternalTranscriptItemBytes(item: ExternalSessionTranscriptRawMessageV1): number {
  return Buffer.byteLength(JSON.stringify(item), 'utf8');
}

export function mapOpenCodeMessageToExternalSessionItem(
  message: unknown,
  index: number,
): ExternalSessionTranscriptRawMessageV1 | null {
  const fallbackId = `opencode:${Math.max(0, Math.trunc(index))}`;
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return {
      id: fallbackId,
      localId: fallbackId,
      createdAtMs: 0,
      raw: {
        role: 'agent',
        content: {
          type: 'output',
          data: {
            type: 'opaque',
            reason: 'invalid_message',
            original: message,
          },
        },
      },
    };
  }

  const record = message as Record<string, unknown>;
  const projection = classifyOpenCodeMessageForProjection(record);
  if (projection.kind !== 'user_transcript' && projection.kind !== 'assistant_transcript') {
    return null;
  }

  const stableId = projection.messageId || fallbackId;
  const contentText = typeof record.content === 'string' ? record.content.trim() : '';
  const text = contentText || extractOpenCodeProjectedText(
    Array.isArray(record.parts) ? record.parts : [],
    { context: 'direct_transcript' },
  );
  if (!text) return null;

  if (projection.kind === 'user_transcript') {
    return {
      id: stableId,
      localId: stableId,
      createdAtMs: projection.createdAtMs,
      raw: {
        role: 'user',
        content: { type: 'text', text },
      },
    };
  }

  return {
    id: stableId,
    localId: stableId,
    createdAtMs: projection.createdAtMs,
    raw: {
      role: 'agent',
      content: {
        type: 'acp',
        provider: 'opencode',
        data: { type: 'message', message: text },
      },
    },
  };
}
