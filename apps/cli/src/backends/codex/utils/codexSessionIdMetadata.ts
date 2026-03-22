import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import type { Metadata } from '@/api/types';
import { buildCodexAgentRuntimeDescriptor, type CodexBackendMode } from '@happier-dev/agents';
import type { DirectSessionsSource } from '@happier-dev/protocol';
import { inferCodexDirectSessionsSourceFromHome } from '../directSessions/resolveCodexHomeEntriesForDirectSessionsSource';

function resolveCodexDirectSource(params: Readonly<{
  codexHome?: string | null;
  activeServerDir?: string | null;
}>): DirectSessionsSource {
  return inferCodexDirectSessionsSourceFromHome({
    codexHome: typeof params.codexHome === 'string' && params.codexHome.trim().length > 0
      ? resolve(params.codexHome.trim())
      : resolve(join(homedir(), '.codex')),
    activeServerDir: params.activeServerDir,
  });
}

function resolveCodexRuntimeSourceAffinity(params: Readonly<{
  codexHome?: string | null;
  activeServerDir?: string | null;
}>): Readonly<{
  home: 'user' | 'connectedService';
  connectedServiceId?: string;
  connectedServiceProfileId?: string;
  homePath?: string;
}> {
  const source = resolveCodexDirectSource(params);
  return source.home === 'connectedService'
    ? {
      home: 'connectedService',
      connectedServiceId:
        'connectedServiceId' in source && typeof source.connectedServiceId === 'string'
          ? source.connectedServiceId
          : undefined,
      connectedServiceProfileId:
        'connectedServiceProfileId' in source && typeof source.connectedServiceProfileId === 'string'
          ? source.connectedServiceProfileId
          : undefined,
      homePath:
        'homePath' in source && typeof source.homePath === 'string'
          ? source.homePath
          : undefined,
    }
    : {
      home: 'user',
      homePath:
        'homePath' in source && typeof source.homePath === 'string'
          ? source.homePath
          : undefined,
    };
}

function buildDirectSessionMetadata(
  metadata: Metadata,
  sessionId: string,
  params: Readonly<{
    transcriptStorage?: 'persisted' | 'direct' | null;
    backendMode?: CodexBackendMode | null;
    codexHome?: string | null;
    activeServerDir?: string | null;
  }>,
): Metadata {
  if (params.transcriptStorage !== 'direct') {
    const nextMetadata = { ...metadata } as Metadata;
    delete nextMetadata.directSessionV1;
    return nextMetadata;
  }

  const machineId = typeof metadata.machineId === 'string' ? metadata.machineId.trim() : '';
  if (!machineId) {
    const nextMetadata = { ...metadata } as Metadata;
    delete nextMetadata.directSessionV1;
    return nextMetadata;
  }

  const runtimeDescriptor = params.backendMode
    ? buildCodexAgentRuntimeDescriptor({
      backendMode: params.backendMode,
      vendorSessionId: sessionId,
      ...resolveCodexRuntimeSourceAffinity(params),
    })
    : null;

  return {
    ...metadata,
    directSessionV1: {
      v: 1,
      providerId: 'codex',
      machineId,
      remoteSessionId: sessionId,
      source: resolveCodexDirectSource(params),
      linkedAtMs: Date.now(),
      ...(runtimeDescriptor ? { agentRuntimeDescriptorV1: runtimeDescriptor } : {}),
    },
  };
}

export function maybeUpdateCodexSessionIdMetadata(params: {
  getCodexThreadId: () => string | null;
  backendMode?: CodexBackendMode | null;
  transcriptStorage?: 'persisted' | 'direct' | null;
  codexHome?: string | null;
  activeServerDir?: string | null;
  updateHappySessionMetadata: (updater: (metadata: Metadata) => Metadata) => Promise<void> | void;
  lastPublished: { value: string | null; fingerprint?: string | null };
}): void {
  const raw = params.getCodexThreadId();
  const next = typeof raw === 'string' ? raw.trim() : '';
  const backendMode = params.backendMode === 'mcp' || params.backendMode === 'acp' || params.backendMode === 'appServer'
    ? params.backendMode
    : null;
  if (!next) return;

  const directSource = resolveCodexDirectSource(params);
  const publishFingerprint = JSON.stringify({
    backendMode,
    transcriptStorage: params.transcriptStorage ?? null,
    source: directSource,
  });

  if (params.lastPublished.value === next && (params.lastPublished.fingerprint ?? null) === publishFingerprint) return;
  const prev = params.lastPublished.value;
  const prevFingerprint = params.lastPublished.fingerprint ?? null;
  params.lastPublished.value = next;
  params.lastPublished.fingerprint = publishFingerprint;

  try {
    const res = params.updateHappySessionMetadata((metadata) => {
      const nextMetadata = { ...metadata } as Metadata;
      const runtimeDescriptor = nextMetadata.agentRuntimeDescriptorV1 as { providerId?: string } | undefined;

      if (!backendMode) {
        delete nextMetadata.codexBackendMode;
        if (runtimeDescriptor?.providerId === 'codex') {
          delete nextMetadata.agentRuntimeDescriptorV1;
        }
      }

      return buildDirectSessionMetadata({
        ...nextMetadata,
        // Happy metadata field name. Value is Codex threadId (Codex uses "threadId" as the stable resume id).
        codexSessionId: next,
        ...(backendMode ? { codexBackendMode: backendMode } : {}),
        ...(backendMode
          ? {
            agentRuntimeDescriptorV1: buildCodexAgentRuntimeDescriptor({
              backendMode,
              vendorSessionId: next,
              ...resolveCodexRuntimeSourceAffinity(params),
            }),
          }
          : {}),
      }, next, { ...params, backendMode });
    });
    void Promise.resolve(res).catch(() => {
      // Revert optimistic publish so future calls can retry.
      if (params.lastPublished.value === next) {
        params.lastPublished.value = prev;
        params.lastPublished.fingerprint = prevFingerprint;
      }
    });
  } catch {
    // Revert optimistic publish so future calls can retry.
    if (params.lastPublished.value === next) {
      params.lastPublished.value = prev;
      params.lastPublished.fingerprint = prevFingerprint;
    }
  }
}

export function publishCodexSessionIdMetadata(params: {
  session: Readonly<{ updateMetadata: (updater: (metadata: Metadata) => Metadata) => Promise<void> | void }>;
  getCodexThreadId: () => string | null;
  backendMode?: CodexBackendMode | null;
  transcriptStorage?: 'persisted' | 'direct' | null;
  codexHome?: string | null;
  activeServerDir?: string | null;
  lastPublished: { value: string | null; fingerprint?: string | null };
}): void {
  maybeUpdateCodexSessionIdMetadata({
    getCodexThreadId: params.getCodexThreadId,
    backendMode: params.backendMode,
    transcriptStorage: params.transcriptStorage,
    codexHome: params.codexHome,
    activeServerDir: params.activeServerDir,
    updateHappySessionMetadata: (updater) => params.session.updateMetadata(updater),
    lastPublished: params.lastPublished,
  });
}
