import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import type { Metadata } from '@/api/types';
import { publishSessionRuntimeDescriptor } from '@/agent/runtime/identity/publication/runtimeDescriptor';
import { inferCodexDirectSessionsSourceFromHome } from '@/backends/codex/directSessions/homeEntries';
import { buildCodexAgentRuntimeDescriptor, type CodexBackendMode } from '@happier-dev/agents';
import {
  normalizeCodexBackendMode,
  readRuntimeDescriptorV1FromMetadata,
  type DirectSessionsSource,
  writeRuntimeDescriptorV1ToMetadata,
} from '@happier-dev/protocol';

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
      ...(runtimeDescriptor ? { runtimeDescriptorV1: runtimeDescriptor } : {}),
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
  const backendMode = normalizeCodexBackendMode(params.backendMode);
  if (!next) return;

  const directSource = resolveCodexDirectSource(params);
  const publishFingerprint = JSON.stringify({
    backendMode,
    transcriptStorage: params.transcriptStorage ?? null,
    source: directSource,
  });

  void publishSessionRuntimeDescriptor({
    sessionId: next,
    fingerprint: publishFingerprint,
    publicationState: {
      getSessionId: () => params.lastPublished.value,
      getFingerprint: () => params.lastPublished.fingerprint ?? null,
      setSessionId: (sessionId) => {
        params.lastPublished.value = sessionId;
      },
      setFingerprint: (fingerprint) => {
        params.lastPublished.fingerprint = fingerprint ?? undefined;
      },
    },
    updateHappySessionMetadata: params.updateHappySessionMetadata,
    buildMetadata: (metadata) => {
      let nextMetadata = { ...metadata } as Metadata;
      const runtimeDescriptor = readRuntimeDescriptorV1FromMetadata(nextMetadata);

      if (!backendMode) {
        delete nextMetadata.codexBackendMode;
        if (runtimeDescriptor?.providerId === 'codex') {
          nextMetadata = writeRuntimeDescriptorV1ToMetadata(nextMetadata as Record<string, unknown>, null) as Metadata;
        }
      }

      const canonicalRuntimeDescriptor = backendMode
        ? buildCodexAgentRuntimeDescriptor({
            backendMode,
            vendorSessionId: next,
            ...resolveCodexRuntimeSourceAffinity(params),
          })
        : null;

      return buildDirectSessionMetadata({
        ...(writeRuntimeDescriptorV1ToMetadata({
          ...nextMetadata,
          codexSessionId: next,
          ...(backendMode ? { codexBackendMode: backendMode } : {}),
        }, canonicalRuntimeDescriptor) as Metadata),
        codexSessionId: next,
      }, next, { ...params, backendMode });
    },
  });
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
