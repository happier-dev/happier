import type { Metadata } from '@/api/types';

export function maybeUpdateCodexSessionIdMetadata(params: {
  getCodexThreadId: () => string | null;
  updateHappySessionMetadata: (updater: (metadata: Metadata) => Metadata) => Promise<void> | void;
  lastPublished: { value: string | null };
}): void {
  const raw = params.getCodexThreadId();
  const next = typeof raw === 'string' ? raw.trim() : '';
  if (!next) return;

  if (params.lastPublished.value === next) return;
  const prev = params.lastPublished.value;
  params.lastPublished.value = next;

  try {
    const res = params.updateHappySessionMetadata((metadata) => ({
      ...metadata,
      // Happy metadata field name. Value is Codex threadId (Codex uses "threadId" as the stable resume id).
      codexSessionId: next,
    }));
    void Promise.resolve(res).catch(() => {
      // Revert optimistic publish so future calls can retry.
      if (params.lastPublished.value === next) {
        params.lastPublished.value = prev;
      }
    });
  } catch {
    // Revert optimistic publish so future calls can retry.
    if (params.lastPublished.value === next) {
      params.lastPublished.value = prev;
    }
  }
}

export function publishCodexSessionIdMetadata(params: {
  session: Readonly<{ updateMetadata: (updater: (metadata: Metadata) => Metadata) => Promise<void> | void }>;
  getCodexThreadId: () => string | null;
  lastPublished: { value: string | null };
}): void {
  maybeUpdateCodexSessionIdMetadata({
    getCodexThreadId: params.getCodexThreadId,
    updateHappySessionMetadata: (updater) => params.session.updateMetadata(updater),
    lastPublished: params.lastPublished,
  });
}
