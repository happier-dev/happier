import { sync } from '@/sync/sync';
import type { Metadata } from '@/sync/domains/state/storageTypes';
import { publishDisplayTitleMetadataMutation } from '@/sync/state/displayTitlePublish';
import { normalizeNonEmptyString } from './shared';

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
      await publishDisplayTitleMetadataMutation({
        sessionId,
        title: `Session ${tag}`,
        updateSessionMetadataWithRetry: (targetSessionId, updater) =>
          sync.patchSessionMetadataWithRetry(targetSessionId, updater),
        resolveTitle: (metadata: Metadata) =>
          typeof metadata?.summary?.text === 'string' ? metadata.summary.text : `Session ${tag}`,
      });
    } catch {
      // best-effort
    }
  }

  if (initialMessage) {
    try {
      await sync.refreshSessions();
      await sync.sendMessage(sessionId, initialMessage, undefined, undefined, {
        bypassPendingQueueReason: 'spawn_post_process',
      });
    } catch {
      // best-effort
    }
  }
}
