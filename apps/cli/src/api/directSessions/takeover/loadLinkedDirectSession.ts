import {
  type AgentRuntimeDescriptorV1,
  type DirectSessionsProviderId,
  type DirectSessionsSource,
} from '@happier-dev/protocol';
import {
  readOpenCodeSessionRuntimeHandleFromMetadata,
  readSessionMetadataRuntimeDescriptor,
  resolvePersistedCodexRuntimeIdentity,
  type CodexBackendMode,
} from '@happier-dev/agents';

import type { Credentials } from '@/persistence';
import { fetchSessionById, type RawSessionRecord } from '@/sessionControl/sessionsHttp';
import { tryDecryptSessionMetadata } from '@/sessionControl/sessionEncryptionContext';

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeCodexBackendMode(value: unknown): CodexBackendMode | null {
  return value === 'mcp' || value === 'acp' || value === 'appServer' ? value : null;
}

function isDirectSessionsProviderId(value: unknown): value is DirectSessionsProviderId {
  return value === 'codex' || value === 'claude' || value === 'opencode';
}

function parseDirectSessionsSource(value: unknown): DirectSessionsSource | null {
  if (!isObjectRecord(value) || typeof value.kind !== 'string') return null;

  switch (value.kind) {
    case 'codexHome': {
      if (value.home !== 'user' && value.home !== 'connectedService') return null;
      if (typeof value.connectedServiceId !== 'undefined' && typeof value.connectedServiceId !== 'string') return null;
      if (typeof value.connectedServiceProfileId !== 'undefined' && typeof value.connectedServiceProfileId !== 'string') return null;
      if (typeof value.homePath !== 'undefined' && typeof value.homePath !== 'string') return null;
      return {
        kind: 'codexHome',
        home: value.home,
        ...(typeof value.connectedServiceId === 'string' ? { connectedServiceId: value.connectedServiceId } : {}),
        ...(typeof value.connectedServiceProfileId === 'string' ? { connectedServiceProfileId: value.connectedServiceProfileId } : {}),
        ...(typeof value.homePath === 'string' ? { homePath: value.homePath } : {}),
      };
    }
    case 'claudeConfig': {
      if (typeof value.configDir !== 'undefined' && typeof value.configDir !== 'string') return null;
      if (typeof value.projectId !== 'undefined' && typeof value.projectId !== 'string') return null;
      return {
        kind: 'claudeConfig',
        ...(typeof value.configDir === 'string' ? { configDir: value.configDir } : {}),
        ...(typeof value.projectId === 'string' ? { projectId: value.projectId } : {}),
      };
    }
    case 'opencodeServer': {
      if (typeof value.baseUrl !== 'undefined' && typeof value.baseUrl !== 'string') return null;
      if (typeof value.directory !== 'undefined' && typeof value.directory !== 'string') return null;
      return {
        kind: 'opencodeServer',
        ...(typeof value.baseUrl === 'string' ? { baseUrl: value.baseUrl } : {}),
        ...(typeof value.directory === 'string' ? { directory: value.directory } : {}),
      };
    }
    default:
      return null;
  }
}

type ParsedDirectSessionMetadata = Readonly<{
  path?: string;
  directSessionV1: Readonly<{
    v: 1;
    providerId: DirectSessionsProviderId;
    machineId: string;
    remoteSessionId: string;
    source: DirectSessionsSource;
    linkedAtMs: number;
    codexBackendMode?: CodexBackendMode;
    agentRuntimeDescriptorV1?: AgentRuntimeDescriptorV1;
  }>;
  codexBackendMode?: CodexBackendMode;
}>;

function parseDirectSessionMetadata(metadata: unknown): ParsedDirectSessionMetadata | null {
  if (!isObjectRecord(metadata)) return null;
  const directSession = isObjectRecord(metadata.directSessionV1) ? metadata.directSessionV1 : null;
  if (!directSession) return null;
  if (directSession.v !== 1) return null;
  if (!isDirectSessionsProviderId(directSession.providerId)) return null;
  if (typeof directSession.machineId !== 'string' || directSession.machineId.trim().length === 0) return null;
  if (typeof directSession.remoteSessionId !== 'string' || directSession.remoteSessionId.trim().length === 0) return null;
  const source = parseDirectSessionsSource(directSession.source);
  if (!source) return null;
  if (typeof directSession.linkedAtMs !== 'number' || !Number.isFinite(directSession.linkedAtMs) || directSession.linkedAtMs < 0) return null;

  const agentRuntimeDescriptorV1 = isObjectRecord(directSession.agentRuntimeDescriptorV1)
    ? (directSession.agentRuntimeDescriptorV1 as AgentRuntimeDescriptorV1)
    : undefined;

  return {
    ...(typeof metadata.path === 'string' ? { path: metadata.path } : {}),
    directSessionV1: {
      v: 1,
      providerId: directSession.providerId,
      machineId: directSession.machineId,
      remoteSessionId: directSession.remoteSessionId,
      source,
      linkedAtMs: directSession.linkedAtMs,
      ...(normalizeCodexBackendMode(directSession.codexBackendMode) ? { codexBackendMode: normalizeCodexBackendMode(directSession.codexBackendMode) ?? undefined } : {}),
      ...(agentRuntimeDescriptorV1 ? { agentRuntimeDescriptorV1 } : {}),
    },
    ...(normalizeCodexBackendMode(metadata.codexBackendMode) ? { codexBackendMode: normalizeCodexBackendMode(metadata.codexBackendMode) ?? undefined } : {}),
  };
}

export type LoadedLinkedDirectSession = Readonly<{
  rawSession: RawSessionRecord;
  metadata: Record<string, unknown>;
  sessionPath: string | null;
  providerId: DirectSessionsProviderId;
  machineId: string;
  remoteSessionId: string;
  source: DirectSessionsSource;
  codexBackendMode: CodexBackendMode | null;
}>;

type CanonicalCodexRuntimeDescriptor = Readonly<{
  providerId: 'codex';
  vendorSessionId: string | null;
  home: 'user' | 'connectedService' | null;
  connectedServiceId: string | null;
  connectedServiceProfileId: string | null;
  homePath: string | null;
  backendMode?: CodexBackendMode | null;
}>; 

type CanonicalOpenCodeRuntimeDescriptor = Readonly<{
  vendorSessionId: string | null;
  serverBaseUrl: string | null;
}> | null;

function readNestedDirectSessionRuntimeDescriptor(metadata: Record<string, unknown>) {
  const directSession = typeof metadata.directSessionV1 === 'object' && metadata.directSessionV1 && !Array.isArray(metadata.directSessionV1)
    ? metadata.directSessionV1 as Record<string, unknown>
    : null;
  return {
    codex: readSessionMetadataRuntimeDescriptor({ agentRuntimeDescriptorV1: directSession?.agentRuntimeDescriptorV1 }, 'codex'),
    opencode: readOpenCodeSessionRuntimeHandleFromMetadata({ agentRuntimeDescriptorV1: directSession?.agentRuntimeDescriptorV1 }),
  };
}

function resolveCanonicalDirectSource(params: Readonly<{
  providerId: DirectSessionsProviderId;
  source: DirectSessionsSource;
  codexRuntimeDescriptor: CanonicalCodexRuntimeDescriptor | null;
  openCodeRuntimeDescriptor: CanonicalOpenCodeRuntimeDescriptor;
}>): DirectSessionsSource {
  if (params.providerId === 'codex' && params.source.kind === 'codexHome') {
    const runtime = params.codexRuntimeDescriptor;
    if (!runtime) return params.source;
    return {
      kind: 'codexHome',
      home: runtime.home === 'connectedService' ? 'connectedService' : 'user',
      ...(runtime.connectedServiceId ? { connectedServiceId: runtime.connectedServiceId } : {}),
      ...(runtime.connectedServiceProfileId ? { connectedServiceProfileId: runtime.connectedServiceProfileId } : {}),
      ...(runtime.homePath ? { homePath: runtime.homePath } : {}),
    };
  }

  if (params.providerId === 'opencode' && params.source.kind === 'opencodeServer') {
    const runtime = params.openCodeRuntimeDescriptor;
    if (!runtime) return params.source;
    return {
      kind: 'opencodeServer',
      ...(runtime.serverBaseUrl ? { baseUrl: runtime.serverBaseUrl } : {}),
      ...(typeof params.source.directory === 'string' ? { directory: params.source.directory } : {}),
    };
  }

  return params.source;
}

export async function loadLinkedDirectSession(params: Readonly<{
  credentials: Credentials;
  sessionId: string;
  machineId?: string;
}>): Promise<
  | Readonly<{ ok: true; session: LoadedLinkedDirectSession }>
  | Readonly<{ ok: false; errorCode: 'invalid_request' | 'provider_unavailable'; error: string }>
> {
  const rawSession = await fetchSessionById({ token: params.credentials.token, sessionId: params.sessionId }).catch(() => null);
  if (!rawSession) {
    return { ok: false, errorCode: 'invalid_request', error: 'session_not_found' };
  }

  const metadata = tryDecryptSessionMetadata({ credentials: params.credentials, rawSession });
  if (!metadata) {
    return { ok: false, errorCode: 'provider_unavailable', error: 'session_metadata_unavailable' };
  }

  const parsed = parseDirectSessionMetadata(metadata);
  if (!parsed) {
    return { ok: false, errorCode: 'invalid_request', error: 'session_is_not_direct' };
  }

  const direct = parsed.directSessionV1;
  if (typeof params.machineId === 'string' && params.machineId.trim().length > 0 && direct.machineId !== params.machineId) {
    return { ok: false, errorCode: 'invalid_request', error: 'machine_mismatch' };
  }

  const sessionPath = typeof parsed.path === 'string' && parsed.path.trim().length > 0 ? parsed.path.trim() : null;
  const nestedRuntimeDescriptor = readNestedDirectSessionRuntimeDescriptor(parsed);
  const codexRuntimeDescriptor = (nestedRuntimeDescriptor.codex ?? readSessionMetadataRuntimeDescriptor(parsed, 'codex')) as CanonicalCodexRuntimeDescriptor | null;
  const openCodeRuntimeDescriptor = (nestedRuntimeDescriptor.opencode ?? readOpenCodeSessionRuntimeHandleFromMetadata(parsed)) as CanonicalOpenCodeRuntimeDescriptor;
  const remoteSessionId = direct.providerId === 'codex'
    ? (codexRuntimeDescriptor?.vendorSessionId ?? direct.remoteSessionId)
    : direct.providerId === 'opencode'
      ? (openCodeRuntimeDescriptor?.vendorSessionId ?? direct.remoteSessionId)
      : direct.remoteSessionId;
  const persistedCodexBackendMode = codexRuntimeDescriptor?.backendMode ?? resolvePersistedCodexRuntimeIdentity(parsed)?.backendMode ?? null;
  return {
    ok: true,
    session: {
      rawSession,
      metadata,
      sessionPath,
      providerId: direct.providerId,
      machineId: direct.machineId,
      remoteSessionId,
      source: resolveCanonicalDirectSource({
        providerId: direct.providerId,
        source: direct.source,
        codexRuntimeDescriptor,
        openCodeRuntimeDescriptor,
      }),
      codexBackendMode:
        persistedCodexBackendMode
        ?? (direct.codexBackendMode === 'mcp' || direct.codexBackendMode === 'acp' || direct.codexBackendMode === 'appServer'
          ? direct.codexBackendMode
          : null),
    },
  };
}
