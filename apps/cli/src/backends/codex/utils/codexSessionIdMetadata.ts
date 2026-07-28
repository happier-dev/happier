import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import type { Metadata } from '@/api/types';
import { buildCodexAgentRuntimeDescriptor, type CodexBackendMode } from '@happier-dev/agents';
import { normalizeCodexBackendMode, type DirectSessionsSource } from '@happier-dev/protocol';
import { findConnectedServiceChildSelection } from '@/daemon/connectedServices/connectedServiceChildEnvironment';
import { inferCodexDirectSessionsSourceFromHome } from '../directSessions/resolveCodexHomeEntriesForDirectSessionsSource';
import { resolveConfiguredCodexHome } from './resolveConfiguredCodexHome';

function normalizeOptionalString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function resolveCodexHome(params: Readonly<{
  codexHome?: string | null;
  processEnv?: NodeJS.ProcessEnv;
}>): string {
  return typeof params.codexHome === 'string' && params.codexHome.trim().length > 0
    ? resolve(params.codexHome.trim())
    : resolveConfiguredCodexHome(params.processEnv ?? process.env);
}

function resolveCodexDirectSourceFromSelectionEnv(params: Readonly<{
  codexHome: string;
  processEnv?: NodeJS.ProcessEnv;
}>): DirectSessionsSource | null {
  const selection = findConnectedServiceChildSelection(params.processEnv ?? {}, 'openai-codex');
  if (!selection) return null;
  if (selection.kind === 'group') {
    return {
      kind: 'codexHome',
      home: 'connectedService',
      connectedServiceId: selection.serviceId,
      connectedServiceGroupId: selection.groupId,
      homePath: params.codexHome,
    };
  }
  return {
    kind: 'codexHome',
    home: 'connectedService',
    connectedServiceId: selection.serviceId,
    connectedServiceProfileId: selection.profileId,
    homePath: params.codexHome,
  };
}

function resolveCodexDirectSource(params: Readonly<{
  codexHome?: string | null;
  activeServerDir?: string | null;
  processEnv?: NodeJS.ProcessEnv;
}>): DirectSessionsSource {
  const codexHome = resolveCodexHome(params);
  return resolveCodexDirectSourceFromSelectionEnv({
    codexHome,
    processEnv: params.processEnv,
  }) ?? inferCodexDirectSessionsSourceFromHome({
    codexHome,
    activeServerDir: params.activeServerDir,
  });
}

function resolveCodexRuntimeSourceAffinity(params: Readonly<{
  codexHome?: string | null;
  activeServerDir?: string | null;
  processEnv?: NodeJS.ProcessEnv;
}>): Readonly<{
  home: 'user' | 'connectedService';
  connectedServiceId?: string;
  connectedServiceProfileId?: string;
  connectedServiceGroupId?: string;
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
      connectedServiceGroupId:
        'connectedServiceGroupId' in source && typeof source.connectedServiceGroupId === 'string'
          ? source.connectedServiceGroupId
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
    processEnv?: NodeJS.ProcessEnv;
    linkedAtMs?: number;
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
      linkedAtMs: params.linkedAtMs ?? Date.now(),
      ...(runtimeDescriptor ? { agentRuntimeDescriptorV1: runtimeDescriptor } : {}),
    },
  };
}

type UpdateCodexSessionIdMetadataParams = {
  getCodexThreadId: () => string | null;
  backendMode?: CodexBackendMode | null;
  transcriptStorage?: 'persisted' | 'direct' | null;
  codexHome?: string | null;
  activeServerDir?: string | null;
  processEnv?: NodeJS.ProcessEnv;
  updateHappySessionMetadata: (updater: (metadata: Metadata) => Metadata) => Promise<void> | void;
  getMetadataSnapshot?: () => Metadata | null;
  operation?: 'create' | 'resume';
  lastPublished: { value: string | null; fingerprint?: string | null };
};

function buildUpdatedCodexSessionMetadata(
  metadata: Metadata,
  sessionId: string,
  params: Omit<UpdateCodexSessionIdMetadataParams, 'getCodexThreadId' | 'updateHappySessionMetadata' | 'getMetadataSnapshot' | 'operation' | 'lastPublished'>,
  linkedAtMs?: number,
): Metadata {
  const backendMode = normalizeCodexBackendMode(params.backendMode);
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
    codexSessionId: sessionId,
    ...(backendMode ? { codexBackendMode: backendMode } : {}),
    ...(backendMode
      ? {
        agentRuntimeDescriptorV1: buildCodexAgentRuntimeDescriptor({
          backendMode,
          vendorSessionId: sessionId,
          ...resolveCodexRuntimeSourceAffinity(params),
        }),
      }
      : {}),
  }, sessionId, { ...params, backendMode, linkedAtMs });
}

function readStableDirectSessionLinkedAtMs(metadata: Metadata): number | undefined {
  const directSession = metadata.directSessionV1;
  if (!directSession || typeof directSession !== 'object' || Array.isArray(directSession)) return undefined;
  const linkedAtMs = (directSession as { linkedAtMs?: unknown }).linkedAtMs;
  return typeof linkedAtMs === 'number' && Number.isFinite(linkedAtMs) && linkedAtMs > 0
    ? linkedAtMs
    : undefined;
}

function codexOwnedMetadataSlice(metadata: Metadata): Readonly<{
  codexSessionId: unknown;
  codexBackendMode: unknown;
  agentRuntimeDescriptorV1: unknown;
  directSessionV1: unknown;
}> {
  return {
    codexSessionId: normalizeOptionalString(metadata.codexSessionId),
    codexBackendMode: metadata.codexBackendMode,
    agentRuntimeDescriptorV1: metadata.agentRuntimeDescriptorV1,
    directSessionV1: metadata.directSessionV1,
  };
}

function isPersistedCodexPublicationEquivalent(
  metadata: Metadata,
  sessionId: string,
  params: Omit<UpdateCodexSessionIdMetadataParams, 'getCodexThreadId' | 'updateHappySessionMetadata' | 'getMetadataSnapshot' | 'operation' | 'lastPublished'>,
): boolean {
  if (normalizeOptionalString(metadata.codexSessionId) !== sessionId) return false;
  const linkedAtMs = readStableDirectSessionLinkedAtMs(metadata);
  const expected = buildUpdatedCodexSessionMetadata(metadata, sessionId, params, linkedAtMs ?? 0);
  if (expected.directSessionV1 && linkedAtMs === undefined) return false;
  return isDeepStrictEqual(codexOwnedMetadataSlice(metadata), codexOwnedMetadataSlice(expected));
}

async function updateCodexSessionIdMetadata(params: UpdateCodexSessionIdMetadataParams): Promise<void> {
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

  if (params.lastPublished.value === next && (params.lastPublished.fingerprint ?? null) === publishFingerprint) return;
  if (params.operation === 'resume' && params.getMetadataSnapshot) {
    let metadataSnapshot: Metadata | null = null;
    try {
      metadataSnapshot = params.getMetadataSnapshot();
    } catch {
      // A snapshot read cannot prove durability. Fall through to the acknowledged write.
    }
    if (metadataSnapshot && isPersistedCodexPublicationEquivalent(metadataSnapshot, next, params)) {
      params.lastPublished.value = next;
      params.lastPublished.fingerprint = publishFingerprint;
      return;
    }
  }
  const prev = params.lastPublished.value;
  const prevFingerprint = params.lastPublished.fingerprint ?? null;
  params.lastPublished.value = next;
  params.lastPublished.fingerprint = publishFingerprint;

  try {
    await params.updateHappySessionMetadata((metadata) => {
      return buildUpdatedCodexSessionMetadata(metadata, next, params);
    });
  } catch (error) {
    // Revert optimistic publish so future calls can retry.
    if (params.lastPublished.value === next) {
      params.lastPublished.value = prev;
      params.lastPublished.fingerprint = prevFingerprint;
    }
    throw error;
  }
}

export function maybeUpdateCodexSessionIdMetadata(params: UpdateCodexSessionIdMetadataParams): void {
  void updateCodexSessionIdMetadata(params).catch(() => undefined);
}

export async function publishCodexSessionIdMetadata(params: {
  session: Readonly<{
    updateMetadata: (updater: (metadata: Metadata) => Metadata) => Promise<void> | void;
    getMetadataSnapshot?: () => Metadata | null;
  }>;
  operation?: 'create' | 'resume';
  getCodexThreadId: () => string | null;
  backendMode?: CodexBackendMode | null;
  transcriptStorage?: 'persisted' | 'direct' | null;
  codexHome?: string | null;
  activeServerDir?: string | null;
  processEnv?: NodeJS.ProcessEnv;
  lastPublished: { value: string | null; fingerprint?: string | null };
}): Promise<void> {
  await updateCodexSessionIdMetadata({
    getCodexThreadId: params.getCodexThreadId,
    backendMode: params.backendMode,
    transcriptStorage: params.transcriptStorage,
    codexHome: params.codexHome,
    activeServerDir: params.activeServerDir,
    processEnv: params.processEnv,
    operation: params.operation,
    getMetadataSnapshot: params.session.getMetadataSnapshot
      ? () => params.session.getMetadataSnapshot?.() ?? null
      : undefined,
    updateHappySessionMetadata: (updater) => params.session.updateMetadata(updater),
    lastPublished: params.lastPublished,
  });
}
