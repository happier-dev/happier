import type { DirectTranscriptRawMessageV1 } from '@happier-dev/protocol';

function parseMaybeTimestampMs(value: unknown): number {
  if (typeof value === 'string' && value.trim()) {
    const ms = Date.parse(value);
    if (Number.isFinite(ms) && ms >= 0) return Math.trunc(ms);
    return 0;
  }
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    const num = Math.trunc(value);
    return num < 1_000_000_000_000 ? num * 1000 : num;
  }
  return 0;
}

function extractTextFromParts(parts: unknown): string {
  if (!Array.isArray(parts)) return '';
  const chunks: string[] = [];
  for (const part of parts) {
    if (!part || typeof part !== 'object' || Array.isArray(part)) continue;
    const rec: any = part;
    if (rec.type !== 'text') continue;
    const text = typeof rec.text === 'string' ? rec.text : '';
    if (!text) continue;
    chunks.push(text);
  }
  return chunks.join('');
}

export function mapOpenCodeMessageToDirectItem(message: unknown, index: number): DirectTranscriptRawMessageV1 | null {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return null;
  const m: any = message;
  const idRaw = typeof m.id === 'string' ? m.id.trim() : '';
  const stableId = idRaw || `opencode:${Math.max(0, Math.trunc(index))}`;
  const createdAtMs =
    parseMaybeTimestampMs(m.createdAtMs) ||
    parseMaybeTimestampMs(m.createdAt) ||
    parseMaybeTimestampMs(m.created_at) ||
    0;

  const role = typeof m.role === 'string' ? m.role.trim().toLowerCase() : '';
  const text = typeof m.content === 'string' ? m.content : extractTextFromParts(m.parts);

  if (role === 'user') {
    return {
      id: stableId,
      localId: stableId,
      createdAtMs,
      raw: {
        role: 'user',
        content: { type: 'text', text },
      },
    };
  }

  return {
    id: stableId,
    localId: stableId,
    createdAtMs,
    raw: {
      role: 'agent',
      content: { type: 'acp', provider: 'opencode', data: { type: 'message', message: text } },
    },
  };
}

