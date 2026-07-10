import type { SessionStateSyncEngine } from '@happier-dev/agents';
import { waitForSessionMetadataRetryBackoff } from '@/agent/runtime/session/metadataWaitRetryBackoff';

type MetadataObservableSession = Readonly<{
  sessionId: string;
  getMetadataSnapshot: () => unknown;
  waitForMetadataUpdate?: (abortSignal?: AbortSignal) => Promise<boolean>;
}>;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readDisplayTitle(metadata: unknown): { title: string; updatedAt: number | null } | null {
  const record = asRecord(metadata);
  const summary = asRecord(record?.summary);
  const title = typeof summary?.text === 'string' ? summary.text.trim() : '';
  if (!title) return null;
  const updatedAt = typeof summary?.updatedAt === 'number' && Number.isFinite(summary.updatedAt)
    ? summary.updatedAt
    : null;
  return { title, updatedAt };
}

function buildDisplayTitleMirrorKey(displayTitle: { title: string; updatedAt: number | null }): string {
  return JSON.stringify([displayTitle.title, displayTitle.updatedAt]);
}

export type CanonicalSessionStateMetadataObserver = Readonly<{
  mirrorCurrentDisplayTitle(reason: 'user-mutation' | 'reconciliation'): Promise<void>;
  dispose(): void;
}>;

export function observeCanonicalSessionStateMetadata(params: Readonly<{
  session: MetadataObservableSession;
  sessionState: Pick<SessionStateSyncEngine, 'applyHappierField'>;
}>): CanonicalSessionStateMetadataObserver {
  const abortController = new AbortController();
  let disposed = false;
  let lastMirroredDisplayTitleKey: string | null = null;

  const mirrorCurrentDisplayTitle = async (reason: 'user-mutation' | 'reconciliation'): Promise<void> => {
    if (disposed) return;
    const displayTitle = readDisplayTitle(params.session.getMetadataSnapshot());
    if (!displayTitle) return;
    const mirrorKey = buildDisplayTitleMirrorKey(displayTitle);
    if (mirrorKey === lastMirroredDisplayTitleKey) return;
    lastMirroredDisplayTitleKey = mirrorKey;
    await params.sessionState.applyHappierField({
      ctx: { sessionId: params.session.sessionId },
      fieldId: 'display.title',
      value: displayTitle.title,
      reason,
    });
  };

  const waitForMetadataUpdate = params.session.waitForMetadataUpdate;
  if (typeof waitForMetadataUpdate === 'function') {
    void (async () => {
      while (!disposed) {
        const hasUpdate = await waitForMetadataUpdate(abortController.signal).catch(() => false);
        if (!hasUpdate) {
          if (!disposed) {
            await waitForSessionMetadataRetryBackoff({ abortSignal: abortController.signal });
          }
          continue;
        }
        if (disposed) return;
        await mirrorCurrentDisplayTitle('user-mutation');
      }
    })();
  }

  return {
    mirrorCurrentDisplayTitle,
    dispose: () => {
      disposed = true;
      abortController.abort();
    },
  };
}
