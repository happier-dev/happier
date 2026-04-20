import type { MessageBuffer } from '@/ui/ink/messageBuffer';

function normalizeNotificationText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > 0 ? normalized : null;
}

export function getLatestAssistantMessagePreview(messageBuffer: Pick<MessageBuffer, 'getMessages'>): string | null {
  const messages = messageBuffer.getMessages();
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.type !== 'assistant') continue;
    const normalized = normalizeNotificationText(message.content);
    if (normalized) return normalized;
  }
  return null;
}

export function getSessionNotificationTitle(getMetadataSnapshot?: (() => unknown) | null): string | null {
  if (!getMetadataSnapshot) return null;
  const metadata = getMetadataSnapshot();
  const summaryText = normalizeNotificationText((metadata as { summary?: { text?: unknown } } | null)?.summary?.text);
  return summaryText;
}
