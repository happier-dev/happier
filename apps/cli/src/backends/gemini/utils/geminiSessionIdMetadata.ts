import type { Metadata } from '@/api/types';

export function maybeUpdateGeminiSessionIdMetadata(params: {
  getGeminiSessionId: () => string | null;
  updateHappySessionMetadata: (updater: (metadata: Metadata) => Metadata) => Promise<void> | void;
  lastPublished: { value: string | null };
}): void {
  const raw = params.getGeminiSessionId();
  const next = typeof raw === 'string' ? raw.trim() : '';
  if (!next) return;

  if (params.lastPublished.value === next) return;
  const prev = params.lastPublished.value;
  params.lastPublished.value = next;

  try {
    const res = params.updateHappySessionMetadata((metadata) => ({
      ...metadata,
      // Happy metadata field name. Value is Gemini ACP sessionId (Gemini uses sessionId as the stable resume id).
      geminiSessionId: next,
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
