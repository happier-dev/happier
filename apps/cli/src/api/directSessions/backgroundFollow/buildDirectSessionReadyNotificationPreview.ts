import type { DirectTranscriptRawMessageV1 } from '@happier-dev/protocol';

function normalizePreviewText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > 0 ? normalized : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readClaudeMessagePreview(message: unknown): string | null {
  const typedMessage = asRecord(message);
  if (!typedMessage) return null;

  const content = typedMessage.content;
  if (typeof content === 'string') {
    return normalizePreviewText(content);
  }
  if (!Array.isArray(content)) {
    return null;
  }

  const fragments: string[] = [];
  for (const block of content) {
    const typedBlock = asRecord(block);
    if (!typedBlock || typedBlock.type !== 'text') continue;
    const text = normalizePreviewText(typedBlock.text);
    if (text) {
      fragments.push(text);
    }
  }

  return normalizePreviewText(fragments.join(' '));
}

function readClaudeOutputPreview(data: unknown): string | null {
  const typedData = asRecord(data);
  if (!typedData) return null;
  return readClaudeMessagePreview(typedData.message);
}

function readCodexOutputPreview(data: unknown): string | null {
  const typedData = asRecord(data);
  if (!typedData) return null;
  if (typedData.type === 'message') {
    return normalizePreviewText(typedData.message);
  }
  return null;
}

function readDirectTranscriptItemPreview(item: DirectTranscriptRawMessageV1): string | null {
  const raw = asRecord(item.raw);
  if (!raw) return null;

  const role = typeof raw.role === 'string'
    ? raw.role.trim()
    : typeof raw.type === 'string'
      ? raw.type.trim()
      : '';
  if (role === 'user') return null;

  const rawMessagePreview = readClaudeMessagePreview(raw.message);
  if (rawMessagePreview) return rawMessagePreview;

  const typedContent = asRecord(raw.content);
  if (!typedContent) return null;

  if (typedContent.type === 'text') {
    return normalizePreviewText(typedContent.text);
  }
  if (typedContent.type === 'codex') {
    return readCodexOutputPreview(typedContent.data);
  }
  if (typedContent.type === 'output') {
    return readClaudeOutputPreview(typedContent.data);
  }
  return null;
}

export function buildDirectSessionReadyNotificationPreview(
  items: ReadonlyArray<DirectTranscriptRawMessageV1>,
): string | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (!item) continue;
    const preview = readDirectTranscriptItemPreview(item);
    if (preview) {
      return preview;
    }
  }
  return null;
}
