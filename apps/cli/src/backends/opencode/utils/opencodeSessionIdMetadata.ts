import type { Metadata } from '@/api/types';

export async function maybeUpdateOpenCodeSessionIdMetadata(params: {
  getOpenCodeSessionId: () => string | null;
  updateHappySessionMetadata: (updater: (metadata: Metadata) => Metadata) => Promise<void> | void;
  lastPublished: { value: string | null };
}): Promise<void> {
  const raw = params.getOpenCodeSessionId();
  const next = typeof raw === 'string' ? raw.trim() : '';
  if (!next) return;

  if (params.lastPublished.value === next) return;

  await params.updateHappySessionMetadata((metadata) => ({
    ...metadata,
    // Happy metadata field name. Value is OpenCode ACP sessionId (OpenCode uses sessionId as the stable resume id).
    opencodeSessionId: next,
  }));

  params.lastPublished.value = next;
}
