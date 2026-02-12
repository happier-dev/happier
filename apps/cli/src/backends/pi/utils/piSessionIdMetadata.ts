import type { Metadata } from '@/api/types';

export function maybeUpdatePiSessionIdMetadata(params: {
  getPiSessionId: () => string | null;
  updateHappySessionMetadata: (updater: (metadata: Metadata) => Metadata) => void;
  lastPublished: { value: string | null };
}): void {
  const raw = params.getPiSessionId();
  const next = typeof raw === 'string' ? raw.trim() : '';
  if (!next) return;
  if (params.lastPublished.value === next) return;
  params.lastPublished.value = next;

  params.updateHappySessionMetadata((metadata) => ({
    ...metadata,
    piSessionId: next,
  }));
}
