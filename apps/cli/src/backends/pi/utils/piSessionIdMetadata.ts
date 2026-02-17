import type { Metadata } from '@/api/types';

export function maybeUpdatePiSessionIdMetadata(params: {
  getPiSessionId: () => string | null;
  updateHappySessionMetadata: (updater: (metadata: Metadata) => Metadata) => Promise<void> | void;
  lastPublished: { value: string | null };
}): void {
  const raw = params.getPiSessionId();
  const next = typeof raw === 'string' ? raw.trim() : '';
  if (!next) return;
  if (params.lastPublished.value === next) return;
  const prev = params.lastPublished.value;
  params.lastPublished.value = next;

  try {
    const res = params.updateHappySessionMetadata((metadata) => ({
      ...metadata,
      piSessionId: next,
    }));
    void Promise.resolve(res).catch(() => {
      if (params.lastPublished.value === next) {
        params.lastPublished.value = prev;
      }
    });
  } catch {
    if (params.lastPublished.value === next) {
      params.lastPublished.value = prev;
    }
  }
}
