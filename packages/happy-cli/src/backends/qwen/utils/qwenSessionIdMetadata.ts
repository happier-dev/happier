import type { Metadata } from '@/api/types';

export function maybeUpdateQwenSessionIdMetadata(params: {
  getQwenSessionId: () => string | null;
  updateHappySessionMetadata: (updater: (metadata: Metadata) => Metadata) => void;
  lastPublished: { value: string | null };
}): void {
  const raw = params.getQwenSessionId();
  const next = typeof raw === 'string' ? raw.trim() : '';
  if (!next) return;

  if (params.lastPublished.value === next) return;
  params.lastPublished.value = next;

  params.updateHappySessionMetadata((metadata) => ({
    ...metadata,
    qwenSessionId: next,
  }));
}

