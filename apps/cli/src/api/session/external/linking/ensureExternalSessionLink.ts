import { createHash } from 'node:crypto';
import os from 'node:os';

import {
  getAgentResumeConfig,
} from '@happier-dev/agents';
import {
  applySessionStateUpdatesToMetadata,
  applyDisplayTitleSessionMetadata,
  applyRuntimeDescriptorSessionMetadata,
  buildProviderSessionIdSessionMetadata,
  type SessionStateMetadataUpdateV1,
} from '@happier-dev/agents/session/state/metadataWriters';
import {
  resolveExternalSessionsSourceKey,
  normalizeCodexBackendMode,
  type CodexBackendMode,
  type ExternalSessionsAgentId,
  type ExternalSessionsSource,
  type RuntimeDescriptorV1,
} from '@happier-dev/protocol';

import type { Credentials } from '@/persistence';
import { fetchSessionById, fetchSessionsPage, getOrCreateSessionByTag } from '@/session/transport/http/sessionsHttp';
import { tryDecryptSessionMetadata } from '@/session/transport/encryption/sessionEncryptionContext';
import { updateSessionMetadataWithRetry } from '@/session/metadata/updateSessionMetadataWithRetry';
import { resolveExternalSessionLinkIdentity } from '@/agent/runtime/bridges/session/externalSessionSourceCanonicalization';
import { deepEqual } from '@/utils/deterministicJson';
import {
  hasConnectedServiceBindings,
  readConnectedServiceRuntimeSnapshot,
  type ConnectedServiceRuntimeSnapshot,
} from '@/daemon/connectedServices/connectedServiceRuntimeSnapshot';
import {
  resolveConnectedServiceRuntimeSnapshotForExternalSession,
} from '@/daemon/connectedServices/externalSessionRuntimeSnapshotRecovery';

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
  const externalSession = asMetadataRecord(metadata.externalSessionV1);
  return normalizeNullableString(externalSession?.remoteSessionId);
}

function uniqueSnapshotKey(snapshot: ConnectedServiceRuntimeSnapshot): string {
  return JSON.stringify({
    connectedServices: snapshot.connectedServices,
    connectedServicesUpdatedAt: snapshot.connectedServicesUpdatedAt,
    connectedServiceMaterializationIdentityV1: snapshot.connectedServiceMaterializationIdentityV1,
  });
}

function isMeaningfulSessionTitle(value: unknown, metadata?: Readonly<Record<string, unknown>>): boolean {
  const normalized = normalizeNullableString(value);
  if (!normalized) return false;
  if (normalized.toLowerCase() === 'unknown') return false;
  const remoteSessionId = metadata ? resolveDirectRemoteSessionId(metadata) : null;
  if (remoteSessionId && normalized === remoteSessionId) return false;
  return true;
}

function hasOwnRecordValues(value: Record<string, unknown> | null | undefined): boolean {
  return Boolean(value && Object.keys(value).length > 0);
}

function assignIfDifferent(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): boolean {
  if (deepEqual(target[key], value)) return false;
  target[key] = value;
  return true;
}

const EXISTING_LINK_TOP_LEVEL_CANONICAL_SKIP_KEYS = new Set([
  'tag',
  'path',
  'host',
  'machineId',
  'flavor',
  'externalSessionV1',
  'summary',
  'name',
]);

function resolveRefreshedExternalSessionMetadata(params: Readonly<{
  currentMetadata: Readonly<Record<string, unknown>>;
  tag: string;
  machineId: string;
  agentId: ExternalSessionsAgentId;
  remoteSessionId: string;
  source: ExternalSessionsSource;
  codexBackendMode?: CodexBackendMode | null;
  runtimeDescriptor?: RuntimeDescriptorV1 | null;
  sessionStateUpdates?: readonly SessionStateMetadataUpdateV1[];
  vendorMetadata?: Record<string, unknown>;
  externalSessionMetadata?: Record<string, unknown>;
  connectedServiceRuntimeSnapshot?: ConnectedServiceRuntimeSnapshot;
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
    Object.assign(
      nextMetadata,
      applyDisplayTitleSessionMetadata(nextMetadata, {
        title: titleHint,
        staleBehavior: 'bump-if-value-changed',
      }),
    );
    didChange = true;
  }

  const currentPath = normalizeNullableString(params.currentMetadata.path);
  if (directoryHint && !currentPath) {
    nextMetadata.path = directoryHint;
    didChange = true;
  }

  const canonicalMetadata = buildExternalSessionMetadata({
    tag: params.tag,
    machineId: params.machineId,
    agentId: params.agentId,
    remoteSessionId: params.remoteSessionId,
    source: params.source,
    codexBackendMode: params.codexBackendMode,
    runtimeDescriptor: params.runtimeDescriptor,
    sessionStateUpdates: params.sessionStateUpdates,
    vendorMetadata: params.vendorMetadata,
    externalSessionMetadata: params.externalSessionMetadata,
    connectedServiceRuntimeSnapshot: params.connectedServiceRuntimeSnapshot,
    directoryHint: currentPath ?? directoryHint,
    nowMs: Date.now(),
  });

  for (const [key, value] of Object.entries(canonicalMetadata)) {
    if (EXISTING_LINK_TOP_LEVEL_CANONICAL_SKIP_KEYS.has(key)) continue;
    if (assignIfDifferent(nextMetadata, key, value)) {
      didChange = true;
    }
  }

  const currentExternalSession = asMetadataRecord(params.currentMetadata.externalSessionV1) ?? {};
  const canonicalExternalSession = asMetadataRecord(canonicalMetadata.externalSessionV1);
  if (canonicalExternalSession) {
    const nextExternalSession = {
      ...currentExternalSession,
      ...canonicalExternalSession,
      linkedAtMs: currentExternalSession.linkedAtMs ?? canonicalExternalSession.linkedAtMs,
    };
    if (!deepEqual(currentExternalSession, nextExternalSession)) {
      nextMetadata.externalSessionV1 = nextExternalSession;
      didChange = true;
    }
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

async function refreshExistingExternalSessionMetadataIfNeeded(params: Readonly<{
  credentials: Credentials;
  sessionId: string;
  tag: string;
  machineId: string;
  agentId: ExternalSessionsAgentId;
  remoteSessionId: string;
  source: ExternalSessionsSource;
  codexBackendMode?: CodexBackendMode | null;
  runtimeDescriptor?: RuntimeDescriptorV1 | null;
  sessionStateUpdates?: readonly SessionStateMetadataUpdateV1[];
  vendorMetadata?: Record<string, unknown>;
  externalSessionMetadata?: Record<string, unknown>;
  connectedServiceRuntimeSnapshot?: ConnectedServiceRuntimeSnapshot;
  titleHint?: string | null;
  directoryHint?: string | null;
}>): Promise<void> {
  const hasDisplayRefresh = Boolean(normalizeNullableString(params.titleHint) || normalizeNullableString(params.directoryHint));
  const hasIdentityRefresh = Boolean(
    params.codexBackendMode
    || params.runtimeDescriptor
    || params.sessionStateUpdates?.length
    || hasOwnRecordValues(params.vendorMetadata)
    || hasOwnRecordValues(params.externalSessionMetadata)
    || hasConnectedServiceBindings(params.connectedServiceRuntimeSnapshot ?? {}),
  );
  if (!hasDisplayRefresh && !hasIdentityRefresh) {
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

  const nextMetadata = resolveRefreshedExternalSessionMetadata({
    currentMetadata: initialMetadataRecord,
    tag: params.tag,
    machineId: params.machineId,
    agentId: params.agentId,
    remoteSessionId: params.remoteSessionId,
    source: params.source,
    codexBackendMode: params.codexBackendMode,
    runtimeDescriptor: params.runtimeDescriptor,
    sessionStateUpdates: params.sessionStateUpdates,
    vendorMetadata: params.vendorMetadata,
    externalSessionMetadata: params.externalSessionMetadata,
    connectedServiceRuntimeSnapshot: params.connectedServiceRuntimeSnapshot,
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
      resolveRefreshedExternalSessionMetadata({
        currentMetadata,
        tag: params.tag,
        machineId: params.machineId,
        agentId: params.agentId,
        remoteSessionId: params.remoteSessionId,
        source: params.source,
        codexBackendMode: params.codexBackendMode,
        runtimeDescriptor: params.runtimeDescriptor,
        sessionStateUpdates: params.sessionStateUpdates,
        vendorMetadata: params.vendorMetadata,
        externalSessionMetadata: params.externalSessionMetadata,
        connectedServiceRuntimeSnapshot: params.connectedServiceRuntimeSnapshot,
        titleHint: params.titleHint,
        directoryHint: params.directoryHint,
      }) ?? currentMetadata,
  }).catch(() => undefined);
}

function computeExternalSessionTag(params: Readonly<{
  machineId: string;
  agentId: ExternalSessionsAgentId;
  remoteSessionId: string;
  source: ExternalSessionsSource;
}>): string {
  const sourceKey = resolveExternalSessionsSourceKey(params.source);
  const fingerprint = `${params.machineId}|${params.agentId}|${params.remoteSessionId}|${sourceKey}`;
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

function buildExternalSessionMetadata(params: Readonly<{
  tag: string;
  machineId: string;
  agentId: ExternalSessionsAgentId;
  remoteSessionId: string;
  source: ExternalSessionsSource;
  codexBackendMode?: CodexBackendMode | null;
  runtimeDescriptor?: RuntimeDescriptorV1 | null;
  sessionStateUpdates?: readonly SessionStateMetadataUpdateV1[];
  vendorMetadata?: Record<string, unknown>;
  externalSessionMetadata?: Record<string, unknown>;
  connectedServiceRuntimeSnapshot?: ConnectedServiceRuntimeSnapshot;
  titleHint?: string | null;
  directoryHint?: string | null;
  nowMs: number;
}>): Record<string, unknown> {
  const titleHint = normalizeNullableString(params.titleHint);
  const directoryHint = normalizeNullableString(params.directoryHint) ?? '';
  const resume = getAgentResumeConfig(params.agentId);
  const vendorResumeIdField = 'vendorResumeIdField' in resume ? resume.vendorResumeIdField ?? null : null;
  const sessionStateRuntimeDescriptor = params.sessionStateUpdates?.find((update) =>
    update.fieldId === 'identity.runtimeDescriptor'
  )?.value as RuntimeDescriptorV1 | null | undefined;
  const runtimeDescriptor = sessionStateRuntimeDescriptor ?? params.runtimeDescriptor ?? null;
  const externalSessionMetadata = applyRuntimeDescriptorSessionMetadata(
    params.externalSessionMetadata ?? {},
    null,
  );
  const vendorMetadata = applyRuntimeDescriptorSessionMetadata(
    params.vendorMetadata ?? {},
    null,
  );
  const base: Record<string, unknown> = {
    tag: params.tag,
    path: directoryHint,
    host: os.hostname(),
    machineId: params.machineId,
    flavor: params.agentId,
    externalSessionV1: {
      v: 1,
      agentId: params.agentId,
      machineId: params.machineId,
      remoteSessionId: params.remoteSessionId,
      source: params.source,
      linkedAtMs: params.nowMs,
      ...(params.codexBackendMode ? { codexBackendMode: params.codexBackendMode } : {}),
      ...applyRuntimeDescriptorSessionMetadata(
        externalSessionMetadata as Record<string, unknown>,
        runtimeDescriptor,
      ),
    },
    ...(vendorResumeIdField
      ? buildProviderSessionIdSessionMetadata({
        metadataKey: vendorResumeIdField,
        value: params.remoteSessionId,
      })
      : {}),
    ...applyRuntimeDescriptorSessionMetadata(
      vendorMetadata as Record<string, unknown>,
      runtimeDescriptor,
    ),
    ...(hasConnectedServiceBindings(params.connectedServiceRuntimeSnapshot ?? {})
      ? {
        connectedServices: params.connectedServiceRuntimeSnapshot?.connectedServices,
        ...(params.connectedServiceRuntimeSnapshot?.connectedServicesUpdatedAt !== undefined
          ? { connectedServicesUpdatedAt: params.connectedServiceRuntimeSnapshot.connectedServicesUpdatedAt }
          : {}),
        ...(params.connectedServiceRuntimeSnapshot?.connectedServiceMaterializationIdentityV1
          ? {
            connectedServiceMaterializationIdentityV1:
              params.connectedServiceRuntimeSnapshot.connectedServiceMaterializationIdentityV1,
          }
          : {}),
      }
      : {}),
  };
  const metadataWithSessionState = params.sessionStateUpdates?.length
    ? applySessionStateUpdatesToMetadata(base, params.sessionStateUpdates)
    : base;
  if (titleHint) {
    return applyDisplayTitleSessionMetadata(metadataWithSessionState, {
      title: titleHint,
      staleBehavior: 'bump-if-value-changed',
    });
  }

  return metadataWithSessionState;
}

export async function ensureExternalSessionLink(params: Readonly<{
  credentials: Credentials;
  machineId: string;
  agentId: ExternalSessionsAgentId;
  remoteSessionId: string;
  source: ExternalSessionsSource;
  codexBackendMode?: unknown;
  runtimeDescriptor?: RuntimeDescriptorV1 | null;
  titleHint?: string | null;
  directoryHint?: string | null;
  nowMs?: () => number;
}>): Promise<{ sessionId: string; created: boolean; tag: string }> {
  const nowMs = params.nowMs ?? (() => Date.now());
  const linkIdentity = await resolveExternalSessionLinkIdentity({
    agentId: params.agentId,
    remoteSessionId: params.remoteSessionId,
    source: params.source,
    runtimeDescriptor: params.runtimeDescriptor,
    metadata: params.codexBackendMode ? { codexBackendMode: params.codexBackendMode } : undefined,
  });
  const remoteSessionId = linkIdentity.remoteSessionId;
  const source = linkIdentity.source;
  const codexBackendMode =
    normalizeCodexBackendMode(linkIdentity.vendorMetadata?.codexBackendMode)
    ?? normalizeCodexBackendMode(params.codexBackendMode);
  const runtimeDescriptor = linkIdentity.runtimeDescriptor ?? params.runtimeDescriptor ?? null;

  const tag = computeExternalSessionTag({
    machineId: params.machineId,
    agentId: params.agentId,
    remoteSessionId,
    source,
  });
  const connectedServiceRuntimeSnapshot = await resolveConnectedServiceRuntimeSnapshotForExternalSession({
    agentId: params.agentId,
    remoteSessionId,
    directoryHint: params.directoryHint,
  });
  const existingSessionId = await findExistingSessionIdByTag({ credentials: params.credentials, tag });
  if (existingSessionId) {
    await refreshExistingExternalSessionMetadataIfNeeded({
      credentials: params.credentials,
      sessionId: existingSessionId,
      tag,
      machineId: params.machineId,
      agentId: params.agentId,
      remoteSessionId,
      source,
      codexBackendMode,
      runtimeDescriptor,
      sessionStateUpdates: linkIdentity.sessionStateUpdates,
      vendorMetadata: linkIdentity.vendorMetadata,
      externalSessionMetadata: linkIdentity.externalSessionMetadata,
      connectedServiceRuntimeSnapshot,
      titleHint: params.titleHint,
      directoryHint: params.directoryHint,
    });
    return { sessionId: existingSessionId, created: false, tag };
  }

  const metadata = buildExternalSessionMetadata({
    tag,
    machineId: params.machineId,
    agentId: params.agentId,
    remoteSessionId,
    source,
    codexBackendMode,
    runtimeDescriptor,
    sessionStateUpdates: linkIdentity.sessionStateUpdates,
    vendorMetadata: linkIdentity.vendorMetadata,
    externalSessionMetadata: linkIdentity.externalSessionMetadata,
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
