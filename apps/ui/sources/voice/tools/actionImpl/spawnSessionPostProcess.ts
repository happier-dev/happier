import { sync } from '@/sync/sync';

function normalizeNonEmptyString(value: unknown): string | null {
  const text = typeof value === 'string' ? value.trim() : '';
  return text.length > 0 ? text : null;
}

export async function postprocessSpawnedSession(params: Readonly<{
  sessionId: string | null;
  tag?: string | null;
  initialMessage?: string | null;
}>): Promise<void> {
  const sessionId = normalizeNonEmptyString(params.sessionId);
  if (!sessionId) return;
  const tag = normalizeNonEmptyString(params.tag);
  const initialMessage = normalizeNonEmptyString(params.initialMessage);

  if (tag) {
    try {
      await sync.refreshSessions();
      await sync.patchSessionMetadataWithRetry(sessionId, (metadata: any) => ({
        ...metadata,
        summary: { text: metadata?.summary?.text ?? `Session ${tag}`, updatedAt: Date.now() },
      }));
    } catch {
      // best-effort
    }
  }

  if (initialMessage) {
    try {
      await sync.refreshSessions();
      await sync.sendMessage(sessionId, initialMessage);
    } catch {
      // best-effort
    }
  }
}

