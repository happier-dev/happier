import type { Metadata } from '@/api/types';
import { normalizeOpenCodeServerBaseUrl, normalizeOpenCodeServerBaseUrlExplicit } from '@happier-dev/agents';

export async function maybeUpdateOpenCodeSessionIdMetadata(params: {
  getOpenCodeSessionId: () => string | null;
  backendMode?: 'server' | 'acp' | null;
  serverBaseUrl?: string | null;
  serverBaseUrlExplicit?: boolean | string | null;
  transcriptStorage?: 'persisted' | 'direct' | null;
  updateHappySessionMetadata: (updater: (metadata: Metadata) => Metadata) => Promise<void> | void;
  lastPublished: {
    sessionId: string | null;
    backendMode: 'server' | 'acp' | null;
    serverBaseUrl: string | null;
    serverBaseUrlExplicit: boolean;
  };
}): Promise<void> {
  const raw = params.getOpenCodeSessionId();
  const next = typeof raw === 'string' ? raw.trim() : '';
  if (!next) return;

  const backendMode = params.backendMode === 'acp' ? 'acp' : params.backendMode === 'server' ? 'server' : null;
  const serverBaseUrlExplicit = normalizeOpenCodeServerBaseUrlExplicit(params.serverBaseUrlExplicit);
  const serverBaseUrl = serverBaseUrlExplicit ? normalizeOpenCodeServerBaseUrl(params.serverBaseUrl) : null;
  if (
    params.lastPublished.sessionId === next &&
    params.lastPublished.backendMode === backendMode &&
    params.lastPublished.serverBaseUrl === serverBaseUrl &&
    params.lastPublished.serverBaseUrlExplicit === serverBaseUrlExplicit
  ) return;

  await params.updateHappySessionMetadata((metadata) => {
    const nextMetadata = { ...metadata } as Metadata & {
      opencodeServerBaseUrl?: string;
      opencodeServerBaseUrlExplicit?: true;
    };
    if (!serverBaseUrl) {
      delete nextMetadata.opencodeServerBaseUrl;
      delete nextMetadata.opencodeServerBaseUrlExplicit;
    }
    const updatedMetadata: Metadata = {
      ...nextMetadata,
      // Happy metadata field name. Value is OpenCode ACP sessionId (OpenCode uses sessionId as the stable resume id).
      opencodeSessionId: next,
      ...(backendMode ? { opencodeBackendMode: backendMode } : {}),
      ...(serverBaseUrl ? {
        opencodeServerBaseUrl: serverBaseUrl,
        opencodeServerBaseUrlExplicit: true,
      } : {}),
    };

    if (params.transcriptStorage === 'direct' && backendMode === 'server') {
      const machineId = typeof metadata.machineId === 'string' ? metadata.machineId.trim() : '';
      const directory = typeof metadata.path === 'string' ? metadata.path.trim() : '';
      if (machineId) {
        updatedMetadata.directSessionV1 = {
          v: 1,
          providerId: 'opencode',
          machineId,
          remoteSessionId: next,
          source: {
            kind: 'opencodeServer',
            ...(serverBaseUrl ? { baseUrl: serverBaseUrl } : {}),
            ...(directory ? { directory } : {}),
          },
          linkedAtMs: Date.now(),
        };
      }
    }

    return updatedMetadata;
  });

  params.lastPublished.sessionId = next;
  params.lastPublished.backendMode = backendMode;
  params.lastPublished.serverBaseUrl = serverBaseUrl;
  params.lastPublished.serverBaseUrlExplicit = serverBaseUrlExplicit;
}
