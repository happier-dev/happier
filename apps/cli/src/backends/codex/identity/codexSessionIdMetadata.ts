import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import type { Metadata } from '@/api/types';
import { createSessionRuntimeIdentityMetadataUpdater } from '@/agent/runtime/identity/metadata/updater';
import { publishSessionRuntimeDescriptor } from '@/agent/runtime/identity/publication/runtimeDescriptor';
import { inferCodexExternalSessionsSourceFromHome } from '@/backends/codex/externalSessions/homeEntries';
import {
  buildCodexAgentRuntimeDescriptor,
  type CodexBackendMode,
} from '@happier-dev/agents';
import { applyRuntimeDescriptorSessionMetadata } from '@happier-dev/agents/session/state/metadataWriters';
import {
  normalizeCodexBackendMode,
  type ExternalSessionsSource,
} from '@happier-dev/protocol';

function resolveCodexDirectSource(params: Readonly<{
  codexHome?: string | null;
  activeServerDir?: string | null;
}>): ExternalSessionsSource {
  return inferCodexExternalSessionsSourceFromHome({
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

function buildExternalSessionMetadata(
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
    delete nextMetadata.externalSessionV1;
    return nextMetadata;
  }

  const machineId = typeof metadata.machineId === 'string' ? metadata.machineId.trim() : '';
  if (!machineId) {
    const nextMetadata = { ...metadata } as Metadata;
    delete nextMetadata.externalSessionV1;
    return nextMetadata;
  }

  const runtimeDescriptor = params.backendMode
    ? buildCodexAgentRuntimeDescriptor({
        backendMode: params.backendMode,
        vendorSessionId: sessionId,
        ...resolveCodexRuntimeSourceAffinity(params),
      })
    : null;

  type ExternalSessionMetadata = NonNullable<Metadata['externalSessionV1']>;
  const previousExternalSession = metadata.externalSessionV1 && typeof metadata.externalSessionV1 === 'object'
    ? metadata.externalSessionV1
    : undefined;
  const externalSessionBase: ExternalSessionMetadata = {
    ...(previousExternalSession ?? {}),
    v: 1,
    providerId: 'codex',
    machineId,
    remoteSessionId: sessionId,
    source: resolveCodexDirectSource(params),
    linkedAtMs: Date.now(),
  };

  const externalSessionV1: ExternalSessionMetadata = runtimeDescriptor
    ? applyRuntimeDescriptorSessionMetadata(
        externalSessionBase,
        runtimeDescriptor,
      )
    : externalSessionBase;

  return {
    ...metadata,
    externalSessionV1,
  };
}

type CodexSessionIdentityPublicationState = {
  value: string | null;
  fingerprint?: string | null;
  runtimeDescriptorSessionId?: string | null;
};

const publishCodexProviderSessionId = createSessionRuntimeIdentityMetadataUpdater('codexSessionId');

export function maybeUpdateCodexSessionIdMetadata(params: {
  getCodexThreadId: () => string | null;
  sessionId?: string | null;
  backendMode?: CodexBackendMode | null;
  transcriptStorage?: 'persisted' | 'direct' | null;
  codexHome?: string | null;
  activeServerDir?: string | null;
  updateHappySessionMetadata: (updater: (metadata: Metadata) => Metadata) => Promise<void> | void;
  lastPublished: CodexSessionIdentityPublicationState;
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
  const canonicalRuntimeDescriptor = backendMode
    ? buildCodexAgentRuntimeDescriptor({
        backendMode,
        vendorSessionId: next,
        ...resolveCodexRuntimeSourceAffinity(params),
      })
    : null;

  publishCodexProviderSessionId({
    sessionId: params.sessionId,
    getSessionId: () => next,
    updateHappySessionMetadata: (updater) => params.updateHappySessionMetadata((metadata) => {
      const nextMetadata = updater(metadata);
      if (!backendMode) {
        const withoutBackendMode = { ...nextMetadata } as Metadata;
        delete withoutBackendMode.codexBackendMode;
        return withoutBackendMode;
      }
      return {
        ...nextMetadata,
        codexBackendMode: backendMode,
      };
    }),
    lastPublished: params.lastPublished,
  });

  void publishSessionRuntimeDescriptor({
    sessionId: next,
    fingerprint: publishFingerprint,
    publicationState: {
      getSessionId: () => params.lastPublished.runtimeDescriptorSessionId ?? null,
      getFingerprint: () => params.lastPublished.fingerprint ?? null,
      setSessionId: (sessionId) => {
        params.lastPublished.runtimeDescriptorSessionId = sessionId ?? undefined;
      },
      setFingerprint: (fingerprint) => {
        params.lastPublished.fingerprint = fingerprint ?? undefined;
      },
    },
    updateHappySessionMetadata: params.updateHappySessionMetadata,
    runtimeDescriptor: canonicalRuntimeDescriptor,
    buildMetadata: (metadata) => {
      let nextMetadata = { ...metadata } as Metadata;

      if (!backendMode) {
        delete nextMetadata.codexBackendMode;
      }

      return buildExternalSessionMetadata({
        ...nextMetadata,
        ...(backendMode ? { codexBackendMode: backendMode } : {}),
      }, next, { ...params, backendMode });
    },
  });
}

export function publishCodexSessionIdMetadata(params: {
  session: Readonly<{
    sessionId?: string | null;
    updateMetadata: (updater: (metadata: Metadata) => Metadata) => Promise<void> | void;
  }>;
  getCodexThreadId: () => string | null;
  backendMode?: CodexBackendMode | null;
  transcriptStorage?: 'persisted' | 'direct' | null;
  codexHome?: string | null;
  activeServerDir?: string | null;
  lastPublished: CodexSessionIdentityPublicationState;
}): void {
  maybeUpdateCodexSessionIdMetadata({
    sessionId: params.session.sessionId,
    getCodexThreadId: params.getCodexThreadId,
    backendMode: params.backendMode,
    transcriptStorage: params.transcriptStorage,
    codexHome: params.codexHome,
    activeServerDir: params.activeServerDir,
    updateHappySessionMetadata: (updater) => params.session.updateMetadata(updater),
    lastPublished: params.lastPublished,
  });
}
