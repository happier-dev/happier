import { createHash } from 'node:crypto';
import os from 'node:os';

import { type CodexBackendMode } from '@happier-dev/agents';
import {
  readCanonicalAgentRuntimeDescriptorV1ForProvider,
  type AgentRuntimeDescriptorV1,
  type DirectSessionsProviderId,
  type DirectSessionsSource,
} from '@happier-dev/protocol';

import type { Credentials } from '@/persistence';
import { fetchSessionById, fetchSessionsPage, getOrCreateSessionByTag } from '@/sessionControl/sessionsHttp';
import { tryDecryptSessionMetadata } from '@/sessionControl/sessionEncryptionContext';
import { updateSessionMetadataWithRetry } from '@/sessionControl/updateSessionMetadataWithRetry';

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function normalizeNullableString(value: unknown): string | null {
  if (value === null) return null;
  const s = String(value ?? '').trim();
  return s.length > 0 ? s : null;
}

function asMetadataRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function resolveSessionSummaryTitle(metadata: Readonly<Record<string, unknown>>): string | null {
  const summary = asMetadataRecord(metadata.summary);
  return normalizeNullableString(summary?.text);
}

function resolveDirectRemoteSessionId(metadata: Readonly<Record<string, unknown>>): string | null {
  const directSession = asMetadataRecord(metadata.directSessionV1);
  return normalizeNullableString(directSession?.remoteSessionId);
}

function isMeaningfulSessionTitle(value: unknown, metadata?: Readonly<Record<string, unknown>>): boolean {
  const normalized = normalizeNullableString(value);
  if (!normalized) return false;
  if (normalized.toLowerCase() === 'unknown') return false;
  const remoteSessionId = metadata ? resolveDirectRemoteSessionId(metadata) : null;
  if (remoteSessionId && normalized === remoteSessionId) return false;
  return true;
}

function resolveRefreshedDirectSessionMetadata(params: Readonly<{
  currentMetadata: Readonly<Record<string, unknown>>;
  titleHint?: string | null;
  directoryHint?: string | null;
}>): Record<string, unknown> | null {
  const titleHint = normalizeNullableString(params.titleHint);
  const directoryHint = normalizeNullableString(params.directoryHint);

  let didChange = false;
  const nextMetadata: Record<string, unknown> = { ...params.currentMetadata };

  const currentTitle =
    (isMeaningfulSessionTitle(resolveSessionSummaryTitle(params.currentMetadata), params.currentMetadata)
      ? resolveSessionSummaryTitle(params.currentMetadata)
      : null) ??
    (isMeaningfulSessionTitle(params.currentMetadata.name, params.currentMetadata) ? normalizeNullableString(params.currentMetadata.name) : null);

  if (titleHint && !currentTitle) {
    nextMetadata.name = titleHint;
    didChange = true;
  }

  const currentPath = normalizeNullableString(params.currentMetadata.path);
  if (directoryHint && !currentPath) {
    nextMetadata.path = directoryHint;
    didChange = true;
  }

  return didChange ? nextMetadata : null;
}

async function refreshExistingDirectSessionMetadataIfNeeded(params: Readonly<{
  credentials: Credentials;
  sessionId: string;
  titleHint?: string | null;
  directoryHint?: string | null;
}>): Promise<void> {
  if (!normalizeNullableString(params.titleHint) && !normalizeNullableString(params.directoryHint)) {
    return;
  }

  const rawSession = await fetchSessionById({
    token: params.credentials.token,
    sessionId: params.sessionId,
  }).catch(() => null);
  if (!rawSession) return;

  const initialMetadata = tryDecryptSessionMetadata({
    credentials: params.credentials,
    rawSession,
  });
  const initialMetadataRecord = asMetadataRecord(initialMetadata);
  if (!initialMetadataRecord) return;

  const nextMetadata = resolveRefreshedDirectSessionMetadata({
    currentMetadata: initialMetadataRecord,
    titleHint: params.titleHint,
    directoryHint: params.directoryHint,
  });
  if (!nextMetadata) return;

  await updateSessionMetadataWithRetry({
    token: params.credentials.token,
    credentials: params.credentials,
    sessionId: params.sessionId,
    rawSession,
    updater: (currentMetadata) =>
      resolveRefreshedDirectSessionMetadata({
        currentMetadata,
        titleHint: params.titleHint,
        directoryHint: params.directoryHint,
      }) ?? currentMetadata,
  }).catch(() => undefined);
}

function resolveSourceKey(providerId: DirectSessionsProviderId, source: DirectSessionsSource): string {
  switch (providerId) {
    case 'codex': {
      if (source.kind !== 'codexHome') return 'codexHome:invalid';
      const home = source.home === 'connectedService' ? 'connectedService' : 'user';
      const connectedServiceId = home === 'connectedService' ? normalizeNullableString(source.connectedServiceId) ?? '' : '';
      const connectedServiceProfileId = home === 'connectedService' ? normalizeNullableString(source.connectedServiceProfileId) ?? '' : '';
      const homePath = normalizeNullableString(source.homePath) ?? '';
      return `codexHome:${home}:${connectedServiceId}:${connectedServiceProfileId}:${homePath}`;
    }
    case 'claude': {
      if (source.kind !== 'claudeConfig') return 'claudeConfig:invalid';
      const configDir = normalizeNullableString(source.configDir) ?? '';
      const projectId = normalizeNullableString(source.projectId) ?? '';
      return `claudeConfig:${configDir}:${projectId}`;
    }
    case 'opencode': {
      if (source.kind !== 'opencodeServer') return 'opencodeServer:invalid';
      const baseUrl = normalizeNullableString(source.baseUrl) ?? '';
      const directory = normalizeNullableString(source.directory) ?? '';
      return `opencodeServer:${baseUrl}:${directory}`;
    }
    default:
      return 'unknown';
  }
}

function normalizeCodexBackendMode(value: unknown): CodexBackendMode | null {
  return value === 'mcp' || value === 'acp' || value === 'appServer' ? value : null;
}

function createCodexAgentRuntimeDescriptorV1(params: Readonly<{
  backendMode: CodexBackendMode;
  vendorSessionId: string;
  home: 'user' | 'connectedService';
  connectedServiceId?: string;
  connectedServiceProfileId?: string;
  homePath?: string;
}>): AgentRuntimeDescriptorV1 {
  return {
    v: 1,
    providerId: 'codex',
    provider: {
      backendMode: params.backendMode,
      vendorSessionId: params.vendorSessionId,
      home: params.home,
      ...(typeof params.connectedServiceId === 'string' && params.connectedServiceId.trim().length > 0
        ? { connectedServiceId: params.connectedServiceId.trim() }
        : {}),
      ...(typeof params.connectedServiceProfileId === 'string' && params.connectedServiceProfileId.trim().length > 0
        ? { connectedServiceProfileId: params.connectedServiceProfileId.trim() }
        : {}),
      ...(typeof params.homePath === 'string' && params.homePath.trim().length > 0
        ? { homePath: params.homePath.trim() }
        : {}),
    },
  };
}

function createOpenCodeAgentRuntimeDescriptorV1(params: Readonly<{
  backendMode: 'server' | 'acp';
  vendorSessionId: string;
  serverBaseUrl?: string;
  serverBaseUrlExplicit?: boolean;
}>): AgentRuntimeDescriptorV1 {
  return {
    v: 1,
    providerId: 'opencode',
    provider: {
      backendMode: params.backendMode,
      vendorSessionId: params.vendorSessionId,
      ...(typeof params.serverBaseUrl === 'string' && params.serverBaseUrl.trim().length > 0
        ? { serverBaseUrl: params.serverBaseUrl.trim() }
        : {}),
      ...(params.serverBaseUrlExplicit === true ? { serverBaseUrlExplicit: true } : {}),
    },
  };
}

function resolveCodexRuntimeSourceAffinity(source: DirectSessionsSource): Readonly<{
  home: 'user' | 'connectedService';
  connectedServiceId?: string;
  connectedServiceProfileId?: string;
  homePath?: string;
}> {
  if (source.kind !== 'codexHome' || source.home !== 'connectedService') {
    const homePath = source.kind === 'codexHome' && typeof source.homePath === 'string' && source.homePath.trim().length > 0
      ? source.homePath.trim()
      : undefined;
    return {
      home: 'user',
      ...(homePath ? { homePath } : {}),
    };
  }

  return {
    home: 'connectedService',
    ...(typeof source.connectedServiceId === 'string' && source.connectedServiceId.trim().length > 0
      ? { connectedServiceId: source.connectedServiceId.trim() }
      : {}),
    ...(typeof source.connectedServiceProfileId === 'string' && source.connectedServiceProfileId.trim().length > 0
      ? { connectedServiceProfileId: source.connectedServiceProfileId.trim() }
      : {}),
    ...(typeof source.homePath === 'string' && source.homePath.trim().length > 0
      ? { homePath: source.homePath.trim() }
      : {}),
  };
}

function resolveCodexDirectSessionLinkIdentity(params: Readonly<{
  remoteSessionId: string;
  source: DirectSessionsSource;
  codexBackendMode?: CodexBackendMode | null;
  runtimeDescriptor?: AgentRuntimeDescriptorV1 | null;
}>): Readonly<{
  remoteSessionId: string;
  codexBackendMode: CodexBackendMode | null;
  runtimeDescriptor: AgentRuntimeDescriptorV1 | null;
  source: DirectSessionsSource;
}> {
  const canonicalRuntimeDescriptor = readCanonicalAgentRuntimeDescriptorV1ForProvider(params.runtimeDescriptor, 'codex');
  const runtimeVendorSessionId = canonicalRuntimeDescriptor?.vendorSessionId ?? '';
  const remoteSessionId = runtimeVendorSessionId || params.remoteSessionId;
  const codexBackendMode = normalizeCodexBackendMode(canonicalRuntimeDescriptor?.backendMode)
    ?? normalizeCodexBackendMode(params.codexBackendMode)
    ?? null;

  if (!codexBackendMode) {
    return {
      remoteSessionId,
      codexBackendMode: null,
      runtimeDescriptor: params.runtimeDescriptor ?? null,
      source: params.source,
    };
  }

  const sourceAffinity = resolveCodexRuntimeSourceAffinity(params.source);
  const source: DirectSessionsSource = canonicalRuntimeDescriptor?.home === 'connectedService'
    ? {
      kind: 'codexHome',
      home: 'connectedService',
      ...(canonicalRuntimeDescriptor.connectedServiceId ? { connectedServiceId: canonicalRuntimeDescriptor.connectedServiceId } : {}),
      ...(canonicalRuntimeDescriptor.connectedServiceProfileId ? { connectedServiceProfileId: canonicalRuntimeDescriptor.connectedServiceProfileId } : {}),
      ...(canonicalRuntimeDescriptor.homePath ? { homePath: canonicalRuntimeDescriptor.homePath } : {}),
    }
    : canonicalRuntimeDescriptor?.home === 'user'
      ? {
        kind: 'codexHome',
        home: 'user',
        ...(canonicalRuntimeDescriptor.homePath ? { homePath: canonicalRuntimeDescriptor.homePath } : {}),
      }
      : params.source;

  return {
    remoteSessionId,
    codexBackendMode,
    source,
    runtimeDescriptor: createCodexAgentRuntimeDescriptorV1({
      backendMode: codexBackendMode,
      vendorSessionId: remoteSessionId,
      home: canonicalRuntimeDescriptor?.home ?? sourceAffinity.home,
      connectedServiceId: canonicalRuntimeDescriptor?.connectedServiceId ?? sourceAffinity.connectedServiceId,
      connectedServiceProfileId:
        canonicalRuntimeDescriptor?.connectedServiceProfileId ?? sourceAffinity.connectedServiceProfileId,
      homePath: canonicalRuntimeDescriptor?.homePath ?? sourceAffinity.homePath,
    }),
  };
}

function resolveOpenCodeDirectSessionLinkIdentity(params: Readonly<{
  remoteSessionId: string;
  source: DirectSessionsSource;
  runtimeDescriptor?: AgentRuntimeDescriptorV1 | null;
}>): Readonly<{
  remoteSessionId: string;
  runtimeDescriptor: AgentRuntimeDescriptorV1 | null;
}> {
  const canonicalRuntimeDescriptor = readCanonicalAgentRuntimeDescriptorV1ForProvider(params.runtimeDescriptor, 'opencode');
  const runtimeVendorSessionId = canonicalRuntimeDescriptor?.vendorSessionId ?? '';
  const remoteSessionId = runtimeVendorSessionId || params.remoteSessionId;

  // Direct sessions for OpenCode are currently backed by OpenCode server transport only.
  // Keep the linked runtime descriptor consistent with the direct-session source, even if a stale
  // descriptor claims ACP mode (for example from handoff bundles).
  const backendMode =
    params.source.kind === 'opencodeServer'
      ? 'server'
      : canonicalRuntimeDescriptor?.backendMode === 'acp' || canonicalRuntimeDescriptor?.backendMode === 'server'
        ? canonicalRuntimeDescriptor.backendMode
        : null;
  if (!backendMode) {
    return { remoteSessionId, runtimeDescriptor: params.runtimeDescriptor ?? null };
  }

  const serverBaseUrl = canonicalRuntimeDescriptor?.serverBaseUrl
    ?? (params.source.kind === 'opencodeServer' && typeof params.source.baseUrl === 'string' && params.source.baseUrl.trim().length > 0
      ? params.source.baseUrl.trim()
      : undefined);

  return {
    remoteSessionId,
    runtimeDescriptor: createOpenCodeAgentRuntimeDescriptorV1({
      backendMode,
      vendorSessionId: remoteSessionId,
      ...(serverBaseUrl ? { serverBaseUrl } : {}),
      ...((canonicalRuntimeDescriptor?.serverBaseUrlExplicit ?? Boolean(serverBaseUrl)) ? { serverBaseUrlExplicit: true } : {}),
    }),
  };
}

function computeDirectSessionTag(params: Readonly<{
  machineId: string;
  providerId: DirectSessionsProviderId;
  remoteSessionId: string;
  source: DirectSessionsSource;
}>): string {
  const sourceKey = resolveSourceKey(params.providerId, params.source);
  const fingerprint = `${params.machineId}|${params.providerId}|${params.remoteSessionId}|${sourceKey}`;
  return `direct:v1:${sha256Hex(fingerprint)}`;
}

function resolveMaxScanPages(): number {
  const maxPagesRaw = (process.env.HAPPIER_SESSION_ID_PREFIX_SCAN_MAX_PAGES ?? '').trim();
  const maxPagesParsed = maxPagesRaw ? Number.parseInt(maxPagesRaw, 10) : NaN;
  const maxPages = Number.isFinite(maxPagesParsed) && maxPagesParsed > 0 ? Math.min(50, maxPagesParsed) : 10;
  return Math.max(1, maxPages);
}

async function findExistingSessionIdByTag(params: Readonly<{ credentials: Credentials; tag: string }>): Promise<string | null> {
  const maxPages = resolveMaxScanPages();

  const scan = async (archivedOnly: boolean): Promise<string | null> => {
    let cursor: string | undefined;
    for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
      const page = await fetchSessionsPage({ token: params.credentials.token, cursor, limit: 200, archivedOnly });
      for (const row of page.sessions) {
        const meta = tryDecryptSessionMetadata({ credentials: params.credentials, rawSession: row });
        const rowTagRaw = meta?.['tag'];
        const rowTag = typeof rowTagRaw === 'string' ? rowTagRaw.trim() : '';
        if (rowTag && rowTag === params.tag) {
          return row.id;
        }
      }
      if (!page.hasNext || !page.nextCursor) break;
      cursor = page.nextCursor;
    }
    return null;
  };

  const activeHit = await scan(false);
  if (activeHit) return activeHit;
  return await scan(true);
}

function buildDirectSessionMetadata(params: Readonly<{
  tag: string;
  machineId: string;
  providerId: DirectSessionsProviderId;
  remoteSessionId: string;
  source: DirectSessionsSource;
  codexBackendMode?: CodexBackendMode | null;
  runtimeDescriptor?: AgentRuntimeDescriptorV1 | null;
  titleHint?: string | null;
  directoryHint?: string | null;
  nowMs: number;
}>): Record<string, unknown> {
  const titleHint = normalizeNullableString(params.titleHint);
  const directoryHint = normalizeNullableString(params.directoryHint) ?? '';
  const base: Record<string, unknown> = {
    tag: params.tag,
    path: directoryHint,
    host: os.hostname(),
    machineId: params.machineId,
    flavor: params.providerId,
    directSessionV1: {
      v: 1,
      providerId: params.providerId,
      machineId: params.machineId,
      remoteSessionId: params.remoteSessionId,
      source: params.source,
      linkedAtMs: params.nowMs,
      ...(params.providerId === 'codex' && params.codexBackendMode ? { codexBackendMode: params.codexBackendMode } : {}),
      ...(params.runtimeDescriptor ? { agentRuntimeDescriptorV1: params.runtimeDescriptor } : {}),
    },
  };
  if (titleHint) {
    base.name = titleHint;
  }

  switch (params.providerId) {
    case 'codex':
      base.codexSessionId = params.remoteSessionId;
      if (params.codexBackendMode) {
        base.codexBackendMode = params.codexBackendMode;
      }
      if (params.runtimeDescriptor) {
        base.agentRuntimeDescriptorV1 = params.runtimeDescriptor;
      }
      break;
    case 'claude':
      base.claudeSessionId = params.remoteSessionId;
      break;
    case 'opencode':
      base.opencodeSessionId = params.remoteSessionId;
      if (params.runtimeDescriptor?.providerId === 'opencode') {
        const backendMode = params.runtimeDescriptor.provider.backendMode;
        if (backendMode === 'server' || backendMode === 'acp') {
          base.opencodeBackendMode = backendMode;
        }
        if (typeof params.runtimeDescriptor.provider.serverBaseUrl === 'string' && params.runtimeDescriptor.provider.serverBaseUrl.trim()) {
          base.opencodeServerBaseUrl = params.runtimeDescriptor.provider.serverBaseUrl.trim();
          if (params.runtimeDescriptor.provider.serverBaseUrlExplicit === true) {
            base.opencodeServerBaseUrlExplicit = true;
          }
        }
        base.agentRuntimeDescriptorV1 = params.runtimeDescriptor;
      } else {
        base.opencodeBackendMode = 'server';
      }
      break;
  }

  return base;
}

export async function ensureDirectSessionLink(params: Readonly<{
  credentials: Credentials;
  machineId: string;
  providerId: DirectSessionsProviderId;
  remoteSessionId: string;
  source: DirectSessionsSource;
  codexBackendMode?: CodexBackendMode | null;
  runtimeDescriptor?: AgentRuntimeDescriptorV1 | null;
  titleHint?: string | null;
  directoryHint?: string | null;
  nowMs?: () => number;
}>): Promise<{ sessionId: string; created: boolean; tag: string }> {
  const nowMs = params.nowMs ?? (() => Date.now());

  const codexIdentity = params.providerId === 'codex'
    ? resolveCodexDirectSessionLinkIdentity({
      remoteSessionId: params.remoteSessionId,
      source: params.source,
      codexBackendMode: params.codexBackendMode,
      runtimeDescriptor: params.runtimeDescriptor,
    })
    : null;
  const openCodeIdentity = params.providerId === 'opencode'
    ? resolveOpenCodeDirectSessionLinkIdentity({
      remoteSessionId: params.remoteSessionId,
      source: params.source,
      runtimeDescriptor: params.runtimeDescriptor,
    })
    : null;
  const remoteSessionId = codexIdentity?.remoteSessionId ?? openCodeIdentity?.remoteSessionId ?? params.remoteSessionId;
  const source = codexIdentity?.source ?? params.source;
  const codexBackendMode = codexIdentity?.codexBackendMode ?? params.codexBackendMode ?? null;
  const runtimeDescriptor = codexIdentity?.runtimeDescriptor ?? openCodeIdentity?.runtimeDescriptor ?? params.runtimeDescriptor ?? null;

  const tag = computeDirectSessionTag({
    machineId: params.machineId,
    providerId: params.providerId,
    remoteSessionId,
    source,
  });
  const existingSessionId = await findExistingSessionIdByTag({ credentials: params.credentials, tag });
  if (existingSessionId) {
    await refreshExistingDirectSessionMetadataIfNeeded({
      credentials: params.credentials,
      sessionId: existingSessionId,
      titleHint: params.titleHint,
      directoryHint: params.directoryHint,
    });
    return { sessionId: existingSessionId, created: false, tag };
  }

  const metadata = buildDirectSessionMetadata({
    tag,
    machineId: params.machineId,
    providerId: params.providerId,
    remoteSessionId,
    source,
    codexBackendMode,
    runtimeDescriptor,
    titleHint: params.titleHint,
    directoryHint: params.directoryHint,
    nowMs: nowMs(),
  });

  const { session } = await getOrCreateSessionByTag({
    credentials: params.credentials,
    tag,
    metadata,
    agentState: null,
  });

  return { sessionId: session.id, created: true, tag };
}
