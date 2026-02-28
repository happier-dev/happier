import type { Metadata } from '@/api/types';

export async function maybeUpdateOpenCodeSessionIdMetadata(params: {
  getOpenCodeSessionId: () => string | null;
  backendMode?: 'server' | 'acp' | null;
  updateHappySessionMetadata: (updater: (metadata: Metadata) => Metadata) => Promise<void> | void;
  lastPublished: { sessionId: string | null; backendMode: 'server' | 'acp' | null };
}): Promise<void> {
  const raw = params.getOpenCodeSessionId();
  const next = typeof raw === 'string' ? raw.trim() : '';
  if (!next) return;

  const rawBackendMode = typeof params.backendMode === 'string' ? params.backendMode.trim() : '';
  const backendMode = rawBackendMode === 'server' || rawBackendMode === 'acp' ? rawBackendMode : null;

  if (params.lastPublished.sessionId === next && params.lastPublished.backendMode === backendMode) return;

  await params.updateHappySessionMetadata((metadata) => ({
    ...metadata,
    // Happy metadata field name. Value is OpenCode sessionId (OpenCode uses sessionId as the stable resume id).
    opencodeSessionId: next,
    ...(backendMode ? { opencodeBackendMode: backendMode } : {}),
  }));

  params.lastPublished.sessionId = next;
  params.lastPublished.backendMode = backendMode;
}
