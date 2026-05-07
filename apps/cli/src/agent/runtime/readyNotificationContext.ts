function normalizeNotificationText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > 0 ? normalized : null;
}

export function getSessionNotificationTitle(getMetadataSnapshot?: (() => unknown) | null): string | null {
  if (!getMetadataSnapshot) return null;
  const metadata = getMetadataSnapshot();
  const summaryText = normalizeNotificationText((metadata as { summary?: { text?: unknown } } | null)?.summary?.text);
  return summaryText;
}
