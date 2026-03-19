import type { Metadata } from '@/api/types';
import {
  buildOpenCodeAgentRuntimeDescriptor,
  normalizeOpenCodeServerBaseUrl,
  normalizeOpenCodeServerBaseUrlExplicit,
} from '@happier-dev/agents';

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
  const directStorageEnabled = params.transcriptStorage === 'direct' && backendMode === 'server';
  if (
    params.lastPublished.sessionId === next &&
    params.lastPublished.backendMode === backendMode &&
    params.lastPublished.serverBaseUrl === serverBaseUrl &&
    params.lastPublished.serverBaseUrlExplicit === serverBaseUrlExplicit &&
    (params.lastPublished as any).directStorageEnabled === directStorageEnabled
  ) return;

  await params.updateHappySessionMetadata((metadata) => {
    const nextMetadata = { ...metadata } as Metadata & {
      opencodeServerBaseUrl?: string;
      opencodeServerBaseUrlExplicit?: true;
    };
    const runtimeDescriptor = nextMetadata.agentRuntimeDescriptorV1 as { providerId?: string } | undefined;
    if (!backendMode) {
      delete nextMetadata.opencodeBackendMode;
      if (runtimeDescriptor?.providerId === 'opencode') {
        delete nextMetadata.agentRuntimeDescriptorV1;
      }
    }
    if (!serverBaseUrl) {
      delete nextMetadata.opencodeServerBaseUrl;
      delete nextMetadata.opencodeServerBaseUrlExplicit;
    }
    const updatedMetadata: Metadata = {
      ...nextMetadata,
      ...(backendMode ? {
        agentRuntimeDescriptorV1: buildOpenCodeAgentRuntimeDescriptor({
          backendMode,
          vendorSessionId: next,
          ...(serverBaseUrl ? { serverBaseUrl } : {}),
          ...(serverBaseUrlExplicit ? { serverBaseUrlExplicit: true } : {}),
        }),
      } : {}),
      // Happy metadata field name. Value is OpenCode ACP sessionId (OpenCode uses sessionId as the stable resume id).
      opencodeSessionId: next,
      ...(backendMode ? { opencodeBackendMode: backendMode } : {}),
      ...(serverBaseUrl ? {
        opencodeServerBaseUrl: serverBaseUrl,
        opencodeServerBaseUrlExplicit: true,
      } : {}),
    };

    if (directStorageEnabled) {
      const machineId = typeof metadata.machineId === 'string' ? metadata.machineId.trim() : '';
      const directory = typeof metadata.path === 'string' ? metadata.path.trim() : '';
      const runtimeDescriptor = buildOpenCodeAgentRuntimeDescriptor({
        backendMode: 'server',
        vendorSessionId: next,
        ...(serverBaseUrl ? { serverBaseUrl } : {}),
        ...(serverBaseUrlExplicit ? { serverBaseUrlExplicit: true } : {}),
      });
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
          agentRuntimeDescriptorV1: runtimeDescriptor,
        };
      }
    } else {
      delete (updatedMetadata as any).directSessionV1;
    }

    return updatedMetadata;
  });

  params.lastPublished.sessionId = next;
  params.lastPublished.backendMode = backendMode;
  params.lastPublished.serverBaseUrl = serverBaseUrl;
  params.lastPublished.serverBaseUrlExplicit = serverBaseUrlExplicit;
  (params.lastPublished as any).directStorageEnabled = directStorageEnabled;
}
