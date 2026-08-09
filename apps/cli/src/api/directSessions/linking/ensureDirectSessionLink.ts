import { createHash } from 'node:crypto';
import os from 'node:os';

import {
  buildCodexAgentRuntimeDescriptor,
  buildOpenCodeAgentRuntimeDescriptor,
  normalizeCodexBackendMode,
  type CodexBackendMode,
} from '@happier-dev/agents';
import {
  readCanonicalAgentRuntimeDescriptorV1ForProvider,
  type AgentRuntimeDescriptorV1,
  type DirectSessionsProviderId,
  type DirectSessionsSource,
} from '@happier-dev/protocol';

import type { Credentials } from '@/persistence';
import { fetchSessionById, fetchSessionsPage, getOrCreateSessionByTag } from '@/session/transport/http/sessionsHttp';
import { tryDecryptSessionMetadata } from '@/session/transport/encryption/sessionEncryptionContext';
import { updateSessionMetadataWithRetry } from '@/session/metadata/updateSessionMetadataWithRetry';
import {
  hasConnectedServiceBindings,
  mergeConnectedServiceRuntimeSnapshots,
  readConnectedServiceRuntimeSnapshot,
  type ConnectedServiceRuntimeSnapshot,
} from '@/daemon/connectedServices/connectedServiceRuntimeSnapshot';
import { listSessionMarkers, type DaemonSessionMarker } from '@/daemon/sessionRegistry';
import { normalizePathForComparison } from '@/utils/path/normalizePathForComparison';

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

function resolveMetadataRemoteSessionId(
  metadata: Readonly<Record<string, unknown>> | null,
  providerId: DirectSessionsProviderId,
): string | null {
  if (!metadata) return null;

  const directSession = asMetadataRecord(metadata.directSessionV1);
  if (directSession?.providerId === providerId) {
    const directRemoteSessionId = normalizeNullableString(directSession.remoteSessionId);
    if (directRemoteSessionId) return directRemoteSessionId;
  }

  switch (providerId) {
    case 'codex': {
      const codexSessionId = normalizeNullableString(metadata.codexSessionId);
      if (codexSessionId) return codexSessionId;
      break;
    }
    case 'claude': {
      const claudeSessionId = normalizeNullableString(metadata.claudeSessionId);
      if (claudeSessionId) return claudeSessionId;
      break;
    }
    case 'opencode': {
      const openCodeSessionId = normalizeNullableString(metadata.opencodeSessionId);
      if (openCodeSessionId) return openCodeSessionId;
      break;
    }
    case 'pi': {
      const piSessionId = normalizeNullableString(metadata.piSessionId);
      if (piSessionId) return piSessionId;
      break;
    }
  }

  const runtimeDescriptor = asMetadataRecord(metadata.agentRuntimeDescriptorV1);
  if (runtimeDescriptor?.providerId !== providerId) return null;
  const provider = asMetadataRecord(runtimeDescriptor.provider);
  return normalizeNullableString(provider?.vendorSessionId);
}

function resolveMarkerProviderId(marker: DaemonSessionMarker): DirectSessionsProviderId | null {
  const metadata = asMetadataRecord(marker.metadata);
  const metadataFlavor = normalizeNullableString(metadata?.flavor);
  if (metadataFlavor === 'claude' || metadataFlavor === 'codex' || metadataFlavor === 'opencode' || metadataFlavor === 'pi') {
    return metadataFlavor;
  }
  if (marker.flavor === 'claude' || marker.flavor === 'codex' || marker.flavor === 'opencode' || marker.flavor === 'pi') {
    return marker.flavor;
  }
  const respawn = asMetadataRecord(marker.respawn);
  const backendTarget = asMetadataRecord(respawn?.backendTarget);
  const agentId = normalizeNullableString(backendTarget?.agentId);
  return agentId === 'claude' || agentId === 'codex' || agentId === 'opencode' || agentId === 'pi' ? agentId : null;
}

function resolveMarkerRemoteSessionId(marker: DaemonSessionMarker, providerId: DirectSessionsProviderId): string | null {
  const respawn = asMetadataRecord(marker.respawn);
  return normalizeNullableString(respawn?.resume)
    ?? resolveMetadataRemoteSessionId(asMetadataRecord(marker.metadata), providerId);
}

function markerMatchesRemoteSession(
  marker: DaemonSessionMarker,
  providerId: DirectSessionsProviderId,
  remoteSessionId: string,
): boolean {
  if (resolveMarkerProviderId(marker) !== providerId) return false;
  return resolveMarkerRemoteSessionId(marker, providerId) === remoteSessionId;
}

function resolveMarkerDirectoryKeys(marker: DaemonSessionMarker): ReadonlySet<string> {
  const metadata = asMetadataRecord(marker.metadata);
  const respawn = asMetadataRecord(marker.respawn);
  return new Set(
    [
      normalizePathForComparison(marker.cwd),
      normalizePathForComparison(metadata?.path),
      normalizePathForComparison(respawn?.directory),
    ].filter((value): value is string => Boolean(value)),
  );
}

function resolveMarkerConnectedServiceRuntimeSnapshot(marker: DaemonSessionMarker): ConnectedServiceRuntimeSnapshot {
  return mergeConnectedServiceRuntimeSnapshots(
    readConnectedServiceRuntimeSnapshot(marker.respawn),
    readConnectedServiceRuntimeSnapshot(marker.metadata),
  );
}

function uniqueSnapshotKey(snapshot: ConnectedServiceRuntimeSnapshot): string {
  return JSON.stringify({
    connectedServices: snapshot.connectedServices,
    connectedServicesUpdatedAt: snapshot.connectedServicesUpdatedAt,
    connectedServiceMaterializationIdentityV1: snapshot.connectedServiceMaterializationIdentityV1,
  });
}

async function resolveConnectedServiceRuntimeSnapshotForDirectLink(params: Readonly<{
  providerId: DirectSessionsProviderId;
  remoteSessionId: string;
  directoryHint?: string | null;
}>): Promise<ConnectedServiceRuntimeSnapshot> {
  const markers = await listSessionMarkers().catch(() => [] as DaemonSessionMarker[]);
  const markersWithSnapshots = markers
    .map((marker) => ({
      marker,
      snapshot: resolveMarkerConnectedServiceRuntimeSnapshot(marker),
    }))
    .filter((entry) => hasConnectedServiceBindings(entry.snapshot));

  const exactRemoteMatch = markersWithSnapshots
    .filter((entry) => markerMatchesRemoteSession(entry.marker, params.providerId, params.remoteSessionId))
    .sort((left, right) => right.marker.updatedAt - left.marker.updatedAt)[0];
  if (exactRemoteMatch) return exactRemoteMatch.snapshot;

  const directoryKey = normalizePathForComparison(params.directoryHint);
  if (!directoryKey) return {};

  const contextualMatches = markersWithSnapshots
    .filter((entry) => resolveMarkerProviderId(entry.marker) === params.providerId)
    .filter((entry) => resolveMarkerDirectoryKeys(entry.marker).has(directoryKey))
    .sort((left, right) => right.marker.updatedAt - left.marker.updatedAt);

  const uniqueSnapshots = new Map<string, ConnectedServiceRuntimeSnapshot>();
  for (const match of contextualMatches) {
    uniqueSnapshots.set(uniqueSnapshotKey(match.snapshot), match.snapshot);
  }
  return uniqueSnapshots.size === 1 ? [...uniqueSnapshots.values()][0] ?? {} : {};
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
  directSessionIdentity?: Readonly<{
    tag: string;
    machineId: string;
    providerId: DirectSessionsProviderId;
    remoteSessionId: string;
    source: DirectSessionsSource;
    codexBackendMode?: CodexBackendMode | null;
    runtimeDescriptor?: AgentRuntimeDescriptorV1 | null;
  }>;
  titleHint?: string | null;
  directoryHint?: string | null;
  connectedServiceRuntimeSnapshot?: ConnectedServiceRuntimeSnapshot;
}>): Record<string, unknown> | null {
  const titleHint = normalizeNullableString(params.titleHint);
  const directoryHint = normalizeNullableString(params.directoryHint);

  let didChange = false;
  const nextMetadata: Record<string, unknown> = { ...params.currentMetadata };

  const identity = params.directSessionIdentity;
  if (identity) {
    const currentDirectSession = asMetadataRecord(params.currentMetadata.directSessionV1) ?? {};
    const nextDirectSession = {
      ...currentDirectSession,
      v: 1,
      providerId: identity.providerId,
      machineId: identity.machineId,
      remoteSessionId: identity.remoteSessionId,
      source: identity.source,
      ...(identity.providerId === 'codex' && identity.codexBackendMode
        ? { codexBackendMode: identity.codexBackendMode }
        : {}),
      ...(identity.runtimeDescriptor ? { agentRuntimeDescriptorV1: identity.runtimeDescriptor } : {}),
    };
    if (params.currentMetadata.tag !== identity.tag) {
      nextMetadata.tag = identity.tag;
      didChange = true;
    }
    if (JSON.stringify(currentDirectSession) !== JSON.stringify(nextDirectSession)) {
      nextMetadata.directSessionV1 = nextDirectSession;
      didChange = true;
    }
    if (identity.providerId === 'codex') {
      if (params.currentMetadata.codexSessionId !== identity.remoteSessionId) {
        nextMetadata.codexSessionId = identity.remoteSessionId;
        didChange = true;
      }
      if (identity.codexBackendMode && params.currentMetadata.codexBackendMode !== identity.codexBackendMode) {
        nextMetadata.codexBackendMode = identity.codexBackendMode;
        didChange = true;
      }
      if (identity.runtimeDescriptor && JSON.stringify(params.currentMetadata.agentRuntimeDescriptorV1) !== JSON.stringify(identity.runtimeDescriptor)) {
        nextMetadata.agentRuntimeDescriptorV1 = identity.runtimeDescriptor;
        didChange = true;
      }
    }
  }

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

  const snapshot = params.connectedServiceRuntimeSnapshot;
  if (snapshot && hasConnectedServiceBindings(snapshot)) {
    const currentSnapshot = readConnectedServiceRuntimeSnapshot(params.currentMetadata);
    const currentUpdatedAt = currentSnapshot.connectedServicesUpdatedAt;
    const nextUpdatedAt = snapshot.connectedServicesUpdatedAt;
    const isOlderThanCurrent =
      currentSnapshot.connectedServices
      && currentUpdatedAt !== undefined
      && nextUpdatedAt !== undefined
      && nextUpdatedAt < currentUpdatedAt;
    if (!isOlderThanCurrent && uniqueSnapshotKey(currentSnapshot) !== uniqueSnapshotKey(snapshot)) {
      nextMetadata.connectedServices = snapshot.connectedServices;
      if (nextUpdatedAt !== undefined) {
        nextMetadata.connectedServicesUpdatedAt = nextUpdatedAt;
      }
      if (snapshot.connectedServiceMaterializationIdentityV1) {
        nextMetadata.connectedServiceMaterializationIdentityV1 = snapshot.connectedServiceMaterializationIdentityV1;
      }
      didChange = true;
    }
  }

  return didChange ? nextMetadata : null;
}

async function refreshExistingDirectSessionMetadataIfNeeded(params: Readonly<{
  credentials: Credentials;
  sessionId: string;
  directSessionIdentity?: Readonly<{
    tag: string;
    machineId: string;
    providerId: DirectSessionsProviderId;
    remoteSessionId: string;
    source: DirectSessionsSource;
    codexBackendMode?: CodexBackendMode | null;
    runtimeDescriptor?: AgentRuntimeDescriptorV1 | null;
  }>;
  titleHint?: string | null;
  directoryHint?: string | null;
  connectedServiceRuntimeSnapshot?: ConnectedServiceRuntimeSnapshot;
}>): Promise<void> {
  if (
    !params.directSessionIdentity
    && !normalizeNullableString(params.titleHint)
    && !normalizeNullableString(params.directoryHint)
    && !hasConnectedServiceBindings(params.connectedServiceRuntimeSnapshot ?? {})
  ) {
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
    directSessionIdentity: params.directSessionIdentity,
    titleHint: params.titleHint,
    directoryHint: params.directoryHint,
    connectedServiceRuntimeSnapshot: params.connectedServiceRuntimeSnapshot,
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
        directSessionIdentity: params.directSessionIdentity,
        titleHint: params.titleHint,
        directoryHint: params.directoryHint,
        connectedServiceRuntimeSnapshot: params.connectedServiceRuntimeSnapshot,
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
      const connectedServiceGroupId = home === 'connectedService' ? normalizeNullableString(source.connectedServiceGroupId) ?? '' : '';
      const homePath = normalizeNullableString(source.homePath) ?? '';
      const connectedServiceScope = connectedServiceGroupId
        ? `group:${connectedServiceGroupId}`
        : connectedServiceProfileId;
      return `codexHome:${home}:${connectedServiceId}:${connectedServiceScope}:${homePath}`;
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
    case 'pi': {
      if (source.kind !== 'piAgentDir') return 'piAgentDir:invalid';
      const agentDir = normalizeNullableString(source.agentDir) ?? '';
      return `piAgentDir:${agentDir}`;
    }
    default:
      return 'unknown';
  }
}

function resolveRemotePredecessorSourceKey(providerId: DirectSessionsProviderId, source: DirectSessionsSource): string | null {
  if (providerId !== 'codex' || source.kind !== 'codexHome' || source.home !== 'connectedService') return null;
  const connectedServiceGroupId = normalizeNullableString(source.connectedServiceGroupId);
  if (!connectedServiceGroupId) return null;
  const connectedServiceId = normalizeNullableString(source.connectedServiceId) ?? '';
  const connectedServiceProfileId = normalizeNullableString(source.connectedServiceProfileId) ?? '';
  const homePath = normalizeNullableString(source.homePath) ?? '';
  return `codexHome:connectedService:${connectedServiceId}:${connectedServiceProfileId}:${homePath}`;
}

function resolveCodexRuntimeSourceAffinity(source: DirectSessionsSource): Readonly<{
  home: 'user' | 'connectedService';
  connectedServiceId?: string;
  connectedServiceProfileId?: string;
  connectedServiceGroupId?: string;
  homePath?: string;
}> {
  if (source.kind !== 'codexHome' || source.home !== 'connectedService') {
    return {
      home: 'user',
      ...(typeof (source as any).homePath === 'string' && (source as any).homePath.trim().length > 0
        ? { homePath: (source as any).homePath.trim() }
        : {}),
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
    ...(typeof source.connectedServiceGroupId === 'string' && source.connectedServiceGroupId.trim().length > 0
      ? { connectedServiceGroupId: source.connectedServiceGroupId.trim() }
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
      ...(canonicalRuntimeDescriptor.connectedServiceGroupId ? { connectedServiceGroupId: canonicalRuntimeDescriptor.connectedServiceGroupId } : {}),
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
    runtimeDescriptor: buildCodexAgentRuntimeDescriptor({
      backendMode: codexBackendMode,
      vendorSessionId: remoteSessionId,
      home: canonicalRuntimeDescriptor?.home ?? sourceAffinity.home,
      connectedServiceId: canonicalRuntimeDescriptor?.connectedServiceId ?? sourceAffinity.connectedServiceId,
      connectedServiceProfileId:
        canonicalRuntimeDescriptor?.connectedServiceProfileId ?? sourceAffinity.connectedServiceProfileId,
      connectedServiceGroupId:
        canonicalRuntimeDescriptor?.connectedServiceGroupId ?? sourceAffinity.connectedServiceGroupId,
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
    runtimeDescriptor: buildOpenCodeAgentRuntimeDescriptor({
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

function computeRemotePredecessorDirectSessionTag(params: Readonly<{
  machineId: string;
  providerId: DirectSessionsProviderId;
  remoteSessionId: string;
  source: DirectSessionsSource;
}>): string | null {
  const sourceKey = resolveRemotePredecessorSourceKey(params.providerId, params.source);
  if (!sourceKey) return null;
  return `direct:v1:${sha256Hex(`${params.machineId}|${params.providerId}|${params.remoteSessionId}|${sourceKey}`)}`;
}

function resolveMaxScanPages(): number {
  const maxPagesRaw = (process.env.HAPPIER_SESSION_ID_PREFIX_SCAN_MAX_PAGES ?? '').trim();
  const maxPagesParsed = maxPagesRaw ? Number.parseInt(maxPagesRaw, 10) : NaN;
  const maxPages = Number.isFinite(maxPagesParsed) && maxPagesParsed > 0 ? Math.min(50, maxPagesParsed) : 10;
  return Math.max(1, maxPages);
}

async function findExistingSessionIdByTag(params: Readonly<{
  credentials: Credentials;
  tag: string;
  metadataMatches?: (metadata: Readonly<Record<string, unknown>>) => boolean;
  metadataIdentityMatches?: (metadata: Readonly<Record<string, unknown>>) => boolean;
}>): Promise<string | null> {
  const maxPages = resolveMaxScanPages();

  const scan = async (archivedOnly: boolean): Promise<string | null> => {
    let cursor: string | undefined;
    for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
      const page = await fetchSessionsPage({ token: params.credentials.token, cursor, limit: 200, archivedOnly });
      for (const row of page.sessions) {
        const meta = tryDecryptSessionMetadata({ credentials: params.credentials, rawSession: row });
        const rowTagRaw = meta?.['tag'];
        const rowTag = typeof rowTagRaw === 'string' ? rowTagRaw.trim() : '';
        if (meta !== null && (
          (rowTag && rowTag === params.tag && (!params.metadataMatches || params.metadataMatches(meta)))
          || params.metadataIdentityMatches?.(meta) === true
        )) {
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

function metadataProvesCodexGroup(metadata: Readonly<Record<string, unknown>>, expectedGroupId: string): boolean {
  const directSession = asMetadataRecord(metadata.directSessionV1);
  const directSource = asMetadataRecord(directSession?.source);
  const directGroupId = normalizeNullableString(directSource?.connectedServiceGroupId);
  if (directGroupId === expectedGroupId) return true;

  const topRuntimeDescriptor = readCanonicalAgentRuntimeDescriptorV1ForProvider(metadata.agentRuntimeDescriptorV1, 'codex');
  if (topRuntimeDescriptor?.connectedServiceGroupId === expectedGroupId) return true;
  const nestedRuntimeDescriptor = readCanonicalAgentRuntimeDescriptorV1ForProvider(
    directSession?.agentRuntimeDescriptorV1,
    'codex',
  );
  return nestedRuntimeDescriptor?.connectedServiceGroupId === expectedGroupId;
}

function metadataProvesCodexDirectSessionGroupIdentity(
  metadata: Readonly<Record<string, unknown>>,
  expected: Readonly<{ machineId: string; remoteSessionId: string; groupId: string }>,
): boolean {
  const directSession = asMetadataRecord(metadata.directSessionV1);
  return directSession?.v === 1
    && normalizeNullableString(directSession.providerId) === 'codex'
    && normalizeNullableString(directSession.machineId) === expected.machineId
    && normalizeNullableString(directSession.remoteSessionId) === expected.remoteSessionId
    && metadataProvesCodexGroup(metadata, expected.groupId);
}

function buildDirectSessionMetadata(params: Readonly<{
  tag: string;
  machineId: string;
  providerId: DirectSessionsProviderId;
  remoteSessionId: string;
  source: DirectSessionsSource;
  codexBackendMode?: CodexBackendMode | null;
  runtimeDescriptor?: AgentRuntimeDescriptorV1 | null;
  connectedServiceRuntimeSnapshot?: ConnectedServiceRuntimeSnapshot;
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
  const snapshot = params.connectedServiceRuntimeSnapshot;
  if (snapshot && hasConnectedServiceBindings(snapshot)) {
    base.connectedServices = snapshot.connectedServices;
    if (snapshot.connectedServicesUpdatedAt !== undefined) {
      base.connectedServicesUpdatedAt = snapshot.connectedServicesUpdatedAt;
    }
    if (snapshot.connectedServiceMaterializationIdentityV1) {
      base.connectedServiceMaterializationIdentityV1 = snapshot.connectedServiceMaterializationIdentityV1;
    }
  }
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
    case 'pi':
      base.piSessionId = params.remoteSessionId;
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
  const connectedServiceRuntimeSnapshot = await resolveConnectedServiceRuntimeSnapshotForDirectLink({
    providerId: params.providerId,
    remoteSessionId,
    directoryHint: params.directoryHint,
  });

  const tag = computeDirectSessionTag({
    machineId: params.machineId,
    providerId: params.providerId,
    remoteSessionId,
    source,
  });
  let existingSessionId = await findExistingSessionIdByTag({ credentials: params.credentials, tag });
  if (!existingSessionId && params.providerId === 'codex' && source.kind === 'codexHome') {
    const expectedGroupId = normalizeNullableString(source.connectedServiceGroupId);
    const predecessorTag = computeRemotePredecessorDirectSessionTag({
      machineId: params.machineId,
      providerId: params.providerId,
      remoteSessionId,
      source,
    });
    if (expectedGroupId && predecessorTag && predecessorTag !== tag) {
      existingSessionId = await findExistingSessionIdByTag({
        credentials: params.credentials,
        tag: predecessorTag,
        metadataMatches: (metadata) => metadataProvesCodexGroup(metadata, expectedGroupId),
        metadataIdentityMatches: (metadata) => metadataProvesCodexDirectSessionGroupIdentity(metadata, {
          machineId: params.machineId,
          remoteSessionId,
          groupId: expectedGroupId,
        }),
      });
    }
  }
  if (existingSessionId) {
    await refreshExistingDirectSessionMetadataIfNeeded({
      credentials: params.credentials,
      sessionId: existingSessionId,
      directSessionIdentity: {
        tag,
        machineId: params.machineId,
        providerId: params.providerId,
        remoteSessionId,
        source,
        codexBackendMode,
        runtimeDescriptor,
      },
      titleHint: params.titleHint,
      directoryHint: params.directoryHint,
      connectedServiceRuntimeSnapshot,
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
    connectedServiceRuntimeSnapshot,
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
