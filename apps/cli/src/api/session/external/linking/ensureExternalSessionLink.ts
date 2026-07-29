import os from 'node:os';

import {
  getAgentResumeConfig,
  isAgentId,
} from '@happier-dev/agents';
import {
  applySessionStateUpdatesToMetadata,
  applyDisplayTitleSessionMetadata,
  applyRuntimeDescriptorSessionMetadata,
  buildProviderSessionIdSessionMetadata,
  clearSessionStateFieldFromMetadata,
  type SessionStateMetadataUpdateV1,
} from '@happier-dev/agents/session/state/metadataWriters';
import {
  SESSION_METADATA_LAYOUT_VERSION_V1,
  SessionSharedMetadataV1Schema,
  projectSessionOwnerCompatibilityViewV1,
  buildLinkedExternalSessionMetadataV1,
  readExternalHistoryImportV1FromMetadata,
  readLinkedExternalSessionV1FromMetadata,
  normalizeLinkedExternalSessionMetadataV1,
  normalizeCodexBackendMode,
  type CodexBackendMode,
  type ExternalSessionsAgentId,
  type ExternalSessionsSource,
  type LinkedExternalSessionQualifiedIdentityV1,
  type PluginAgentExternalSessionLinkData,
  type RuntimeDescriptorV1,
  type SessionOwnerMetadataV1,
  type SessionSharedMetadataV1,
} from '@happier-dev/protocol';

import type { Credentials } from '@/persistence';
import {
  fetchSessionById,
  fetchSessionsPage,
  getOrCreateSessionByTag,
  lookupSessionsByTags,
  type RawSessionListRow,
  type SessionLookupByTagsHttpResult,
} from '@/session/transport/http/sessionsHttp';
import {
  tryDecryptSessionMetadata,
  tryDecryptSessionOwnerMetadata,
  tryDecryptSessionOwnerMetadataView,
} from '@/session/transport/encryption/sessionEncryptionContext';
import { readSessionMetadataLayoutVersion } from '@/session/metadata/sessionMetadataLayout';
import { updateSessionMetadataWithRetry } from '@/session/metadata/updateSessionMetadataWithRetry';
import {
  ExternalSessionProviderFailureError,
  isExternalSessionProviderFailureError,
  type ExternalSessionExecutionSurface,
} from '@/session/external/providerOps';
import { resolveExternalSessionLinkIdentityFromSurface } from '@/session/external/resolveExternalSessionLinkIdentity';
import { deepEqual } from '@/utils/deterministicJson';
import {
  hasConnectedServiceBindings,
  readConnectedServiceRuntimeSnapshot,
  type ConnectedServiceRuntimeSnapshot,
} from '@/daemon/connectedServices/connectedServiceRuntimeSnapshot';
import {
  resolveConnectedServiceRuntimeSnapshotForExternalSession,
} from '@/daemon/connectedServices/externalSessionRuntimeSnapshotRecovery';
import {
  resolveLinkedExternalSessionQualifiedIdentity,
  type CurrentExternalSessionAgentIdentity,
} from './qualifiedLinkIdentity';
import {
  resolveExternalSessionTagLookupCandidates,
  type ExternalSessionTagLookupCandidate,
} from './externalSessionTagLookupCandidates';
import { uniqueSnapshotKey } from './connectedServiceRuntimeSnapshotKey';
import { metadataProvesHostedExternalSessionIdentity } from './hostedExternalSessionIdentity';

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

function resolveExternalRemoteSessionId(metadata: Readonly<Record<string, unknown>>): string | null {
  const externalSession = readLinkedExternalSessionV1FromMetadata(metadata);
  return normalizeNullableString(externalSession?.remoteSessionId);
}

function isMeaningfulSessionTitle(value: unknown, metadata?: Readonly<Record<string, unknown>>): boolean {
  const normalized = normalizeNullableString(value);
  if (!normalized) return false;
  if (normalized.toLowerCase() === 'unknown') return false;
  const remoteSessionId = metadata ? resolveExternalRemoteSessionId(metadata) : null;
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
  qualifiedIdentity: LinkedExternalSessionQualifiedIdentityV1;
  codexBackendMode?: CodexBackendMode | null;
  runtimeDescriptor?: RuntimeDescriptorV1 | null;
  sessionStateUpdates?: readonly SessionStateMetadataUpdateV1[];
  vendorMetadata?: Record<string, unknown>;
  externalSessionMetadata?: Record<string, unknown>;
  connectedServiceRuntimeSnapshot?: ConnectedServiceRuntimeSnapshot;
  titleHint?: string | null;
  directoryHint?: string | null;
  nowMs: number;
}>): Record<string, unknown> | null {
  const currentLink = readLinkedExternalSessionV1FromMetadata(params.currentMetadata);
  if (
    currentLink?.qualifiedIdentity
    && !deepEqual(currentLink.qualifiedIdentity, params.qualifiedIdentity)
  ) {
    throw new ExternalSessionProviderFailureError({
      code: 'agent_unavailable',
      message: 'external_session_qualified_agent_unavailable',
      operation: 'externalSession.writeQualifiedIdentity',
    });
  }
  const titleHint = normalizeNullableString(params.titleHint);
  const directoryHint = normalizeNullableString(params.directoryHint);

  let didChange = false;
  let nextMetadata: Record<string, unknown> = { ...params.currentMetadata };

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
    qualifiedIdentity: params.qualifiedIdentity,
    codexBackendMode: params.codexBackendMode,
    runtimeDescriptor: params.runtimeDescriptor,
    sessionStateUpdates: params.sessionStateUpdates,
    vendorMetadata: params.vendorMetadata,
    externalSessionMetadata: params.externalSessionMetadata,
    connectedServiceRuntimeSnapshot: params.connectedServiceRuntimeSnapshot,
    directoryHint: currentPath ?? directoryHint,
    nowMs: params.nowMs,
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
    const currentExternalSessionWithoutGeneration = {
      ...currentExternalSession,
    };
    const canonicalExternalSessionWithoutGeneration = {
      ...canonicalExternalSession,
    };
    delete currentExternalSessionWithoutGeneration.linkedAtMs;
    delete canonicalExternalSessionWithoutGeneration.linkedAtMs;
    const nextExternalSessionWithoutGeneration = {
      ...currentExternalSessionWithoutGeneration,
      ...canonicalExternalSessionWithoutGeneration,
    };
    const linkIdentityChanged = !deepEqual(
      currentExternalSessionWithoutGeneration,
      nextExternalSessionWithoutGeneration,
    );
    const currentLinkGeneration =
      typeof currentExternalSession.linkedAtMs === 'number'
      && Number.isSafeInteger(currentExternalSession.linkedAtMs)
      && currentExternalSession.linkedAtMs >= 0
        ? currentExternalSession.linkedAtMs
        : null;
    const nextLinkGeneration = linkIdentityChanged && currentLinkGeneration !== null
      ? Math.max(params.nowMs, currentLinkGeneration + 1)
      : currentLinkGeneration ?? params.nowMs;
    const nextExternalSession = {
      ...currentExternalSession,
      ...canonicalExternalSession,
      linkedAtMs: nextLinkGeneration,
    };
    if (!deepEqual(currentExternalSession, nextExternalSession)) {
      nextMetadata.externalSessionV1 = nextExternalSession;
      didChange = true;
    }
    if (
      linkIdentityChanged
      || currentLinkGeneration !== nextLinkGeneration
    ) {
      nextMetadata = clearSessionStateFieldFromMetadata(
        nextMetadata,
        'runtime.externalAgent',
      );
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

  const compatibilityNormalized = normalizeLinkedExternalSessionMetadataV1(nextMetadata) ?? nextMetadata;
  if (!deepEqual(nextMetadata, compatibilityNormalized)) {
    didChange = true;
  }
  return didChange ? compatibilityNormalized : null;
}

async function refreshExistingExternalSessionMetadataIfNeeded(params: Readonly<{
  credentials: Credentials;
  sessionId: string;
  tag: string;
  machineId: string;
  agentId: ExternalSessionsAgentId;
  remoteSessionId: string;
  source: ExternalSessionsSource;
  qualifiedIdentity: LinkedExternalSessionQualifiedIdentityV1;
  codexBackendMode?: CodexBackendMode | null;
  runtimeDescriptor?: RuntimeDescriptorV1 | null;
  sessionStateUpdates?: readonly SessionStateMetadataUpdateV1[];
  vendorMetadata?: Record<string, unknown>;
  externalSessionMetadata?: Record<string, unknown>;
  connectedServiceRuntimeSnapshot?: ConnectedServiceRuntimeSnapshot;
  titleHint?: string | null;
  directoryHint?: string | null;
  shouldCommit?: () => boolean;
  nowMs: number;
}>): Promise<void> {
  const hasDisplayRefresh = Boolean(normalizeNullableString(params.titleHint) || normalizeNullableString(params.directoryHint));
  const hasIdentityRefresh = Boolean(
    params.qualifiedIdentity
    || params.codexBackendMode
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
    qualifiedIdentity: params.qualifiedIdentity,
    codexBackendMode: params.codexBackendMode,
    runtimeDescriptor: params.runtimeDescriptor,
    sessionStateUpdates: params.sessionStateUpdates,
    vendorMetadata: params.vendorMetadata,
    externalSessionMetadata: params.externalSessionMetadata,
    connectedServiceRuntimeSnapshot: params.connectedServiceRuntimeSnapshot,
    titleHint: params.titleHint,
    directoryHint: params.directoryHint,
    nowMs: params.nowMs,
  });
  if (!nextMetadata) return;
  assertExternalSessionLinkCommitPrecondition(params.shouldCommit);

  await updateSessionMetadataWithRetry({
    token: params.credentials.token,
    credentials: params.credentials,
    sessionId: params.sessionId,
    rawSession,
    updater: (currentMetadata) => {
      assertExternalSessionLinkCommitPrecondition(params.shouldCommit);
      return resolveRefreshedExternalSessionMetadata({
        currentMetadata,
        tag: params.tag,
        machineId: params.machineId,
        agentId: params.agentId,
        remoteSessionId: params.remoteSessionId,
        source: params.source,
        qualifiedIdentity: params.qualifiedIdentity,
        codexBackendMode: params.codexBackendMode,
        runtimeDescriptor: params.runtimeDescriptor,
        sessionStateUpdates: params.sessionStateUpdates,
        vendorMetadata: params.vendorMetadata,
        externalSessionMetadata: params.externalSessionMetadata,
        connectedServiceRuntimeSnapshot: params.connectedServiceRuntimeSnapshot,
        titleHint: params.titleHint,
        directoryHint: params.directoryHint,
        nowMs: params.nowMs,
      }) ?? currentMetadata;
    },
  }).catch((error: unknown) => {
    if (isExternalSessionProviderFailureError(error)) throw error;
    return undefined;
  });
}

function assertExternalSessionLinkCommitPrecondition(
  shouldCommit: (() => boolean) | undefined,
): void {
  if (!shouldCommit || shouldCommit()) return;
  throw new ExternalSessionProviderFailureError({
    code: 'cancelled',
    message: 'external_session_link_commit_precondition_failed',
    operation: 'externalSession.linkEnsureCommit',
  });
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
  metadataMatches?: (
    metadata: Readonly<Record<string, unknown>>,
    row: RawSessionListRow,
  ) => boolean;
  metadataIdentityMatches?: (
    metadata: Readonly<Record<string, unknown>>,
    row: RawSessionListRow,
  ) => boolean;
}>): Promise<Readonly<{
  sessionId: string;
  persistedTag: string;
  metadata: Readonly<Record<string, unknown>>;
  currentStorageState: RawSessionListRow['currentStorageState'];
  currentStorageStateWasOmitted: boolean;
}> | null> {
  const maxPages = resolveMaxScanPages();

  const scan = async (archivedOnly: boolean): Promise<Readonly<{
    sessionId: string;
    persistedTag: string;
    metadata: Readonly<Record<string, unknown>>;
    currentStorageState: RawSessionListRow['currentStorageState'];
    currentStorageStateWasOmitted: boolean;
  }> | null> => {
    let cursor: string | undefined;
    for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
      const page = await fetchSessionsPage({ token: params.credentials.token, cursor, limit: 200, archivedOnly });
      for (const row of page.sessions) {
        const meta = tryDecryptSessionOwnerMetadataView({
          credentials: params.credentials,
          rawSession: row,
        });
        const rowTagRaw = meta?.['tag'];
        const rowTag = typeof rowTagRaw === 'string' ? rowTagRaw.trim() : '';
        if (meta !== null && (
          (rowTag && rowTag === params.tag && (!params.metadataMatches || params.metadataMatches(meta, row)))
          || params.metadataIdentityMatches?.(meta, row) === true
        )) {
          return {
            sessionId: row.id,
            persistedTag: rowTag || params.tag,
            metadata: meta,
            currentStorageState: row.currentStorageState,
            currentStorageStateWasOmitted: !Object.prototype.hasOwnProperty.call(row, 'currentStorageState'),
          };
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

export type ExternalSessionIndexedTagLookupProof = Extract<
  SessionLookupByTagsHttpResult,
  Readonly<{ state: 'available' }>
>;

export type ExistingExternalSessionLookup = Readonly<{
  sessionId: string;
  rawSession: RawSessionListRow;
  persistedTag: string;
  metadata: Readonly<Record<string, unknown>>;
  sharedMetadata?: SessionSharedMetadataV1;
  ownerMetadata?: SessionOwnerMetadataV1;
  currentStorageState: RawSessionListRow['currentStorageState'];
  currentStorageStateWasOmitted: boolean;
  kind: 'external_link' | 'history_import' | 'hosted_resume';
}>;

export type IndexedExternalSessionLookupResult =
  | Readonly<{
      state: 'available';
      proof: ExternalSessionIndexedTagLookupProof;
      existing: ExistingExternalSessionLookup | null;
    }>
  | Readonly<{ state: 'conflict' | 'unavailable' }>;

function metadataProvesExternalHistoryImportIdentity(
  metadata: Readonly<Record<string, unknown>>,
  expected: Readonly<{
    machineId: string;
    agentId: ExternalSessionsAgentId;
    remoteSessionId: string;
    source: ExternalSessionsSource;
    resolveSourceKey(source: ExternalSessionsSource): string | null;
  }>,
): boolean {
  const imported = readExternalHistoryImportV1FromMetadata(metadata);
  return metadata.machineId === expected.machineId
    && imported?.agentId === expected.agentId
    && imported.remoteSessionId === expected.remoteSessionId
    && expected.resolveSourceKey(imported.source) === expected.resolveSourceKey(expected.source);
}

function metadataProvesCodexGroup(metadata: Readonly<Record<string, unknown>>, expectedGroupId: string): boolean {
  const linkedSession = readLinkedExternalSessionV1FromMetadata(metadata);
  return linkedSession?.agentId === 'codex'
    && linkedSession.source.kind === 'codexHome'
    && linkedSession.source.home === 'connectedService'
    && normalizeNullableString(linkedSession.source.connectedServiceGroupId) === expectedGroupId;
}

function metadataProvesExternalSessionIdentity(
  metadata: Readonly<Record<string, unknown>>,
  expected: Readonly<{
    machineId: string;
    agentId: ExternalSessionsAgentId;
    remoteSessionId: string;
    source: ExternalSessionsSource;
    resolveSourceKey(source: ExternalSessionsSource): string | null;
  }>,
): boolean {
  const linkedSession = readLinkedExternalSessionV1FromMetadata(metadata);
  return linkedSession?.machineId === expected.machineId
    && linkedSession.agentId === expected.agentId
    && linkedSession.remoteSessionId === expected.remoteSessionId
    && expected.resolveSourceKey(linkedSession.source) === expected.resolveSourceKey(expected.source);
}

function metadataProvesCodexExternalSessionGroupIdentity(
  metadata: Readonly<Record<string, unknown>>,
  expected: Readonly<{ machineId: string; remoteSessionId: string; groupId: string }>,
): boolean {
  const linkedSession = readLinkedExternalSessionV1FromMetadata(metadata);
  return linkedSession?.agentId === 'codex'
    && linkedSession.machineId === expected.machineId
    && linkedSession.remoteSessionId === expected.remoteSessionId
    && linkedSession.source.kind === 'codexHome'
    && linkedSession.source.home === 'connectedService'
    && normalizeNullableString(linkedSession.source.connectedServiceGroupId) === expected.groupId;
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && left.every((value) => right.includes(value));
}

export async function resolveExternalSessionIndexedTagLookup(params: Readonly<{
  credentials: Credentials;
  machineId: string;
  agentId: ExternalSessionsAgentId;
  remoteSessionId: string;
  source: ExternalSessionsSource;
  tagCandidates: readonly [
    ExternalSessionTagLookupCandidate,
    ...ExternalSessionTagLookupCandidate[],
  ];
  resolveSourceKey(source: ExternalSessionsSource): string | null;
  proof?: ExternalSessionIndexedTagLookupProof;
  signal?: AbortSignal;
  deadlineAtMs?: number;
}>): Promise<IndexedExternalSessionLookupResult> {
  const requestedTags = params.tagCandidates.map((candidate) => candidate.tag);
  const lookup = params.proof ?? await lookupSessionsByTags({
    token: params.credentials.token,
    tags: requestedTags,
    ...(params.signal ? { signal: params.signal } : {}),
    ...(params.deadlineAtMs !== undefined
      ? { deadlineAtMs: params.deadlineAtMs }
      : {}),
  });
  if (lookup.state === 'unavailable') return { state: 'unavailable' };
  if (!sameStringSet(lookup.tags, requestedTags)) {
    return { state: 'conflict' };
  }
  if (lookup.sessions.length === 0) {
    return {
      state: 'available',
      proof: lookup,
      existing: null,
    };
  }
  // Every requested tag is account-unique. More than one returned row means
  // that supported tag identities disagree about the canonical Happier
  // owner, so neither an arbitrary winner nor creation is safe.
  if (lookup.sessions.length !== 1) return { state: 'conflict' };

  const row = lookup.sessions[0]!;
  const sharedOrLegacyMetadata = tryDecryptSessionMetadata({
    credentials: params.credentials,
    rawSession: row,
  });
  const metadataLayoutVersion = readSessionMetadataLayoutVersion(
    row.metadataLayoutVersion,
  );
  const sharedMetadata = metadataLayoutVersion === SESSION_METADATA_LAYOUT_VERSION_V1
    ? SessionSharedMetadataV1Schema.safeParse(sharedOrLegacyMetadata)
    : null;
  const ownerMetadata = metadataLayoutVersion === SESSION_METADATA_LAYOUT_VERSION_V1
    ? tryDecryptSessionOwnerMetadata({
      credentials: params.credentials,
      rawSession: row,
    })
    : null;
  if (
    metadataLayoutVersion === SESSION_METADATA_LAYOUT_VERSION_V1
    && (!sharedMetadata?.success || !ownerMetadata)
  ) {
    return { state: 'conflict' };
  }
  const metadata = sharedMetadata?.success && ownerMetadata
    ? projectSessionOwnerCompatibilityViewV1({
      sharedMetadata: sharedMetadata.data,
      ownerMetadata,
    })
    : sharedOrLegacyMetadata;
  const storedTag = typeof metadata?.tag === 'string'
    ? metadata.tag.trim()
    : '';
  const candidate = storedTag
    ? params.tagCandidates.find((value) => value.tag === storedTag)
    : params.tagCandidates.find((value) => (
      value.kind === 'codex-connected-service-predecessor'
        ? metadataProvesCodexExternalSessionGroupIdentity(metadata ?? {}, {
            machineId: params.machineId,
            remoteSessionId: params.remoteSessionId,
            groupId: value.expectedConnectedServiceGroupId,
          })
        : metadataProvesExternalSessionIdentity(metadata ?? {}, {
            machineId: params.machineId,
            agentId: params.agentId,
            remoteSessionId: params.remoteSessionId,
            source: value.expectedSource,
            resolveSourceKey: params.resolveSourceKey,
          })
    ));
  const persistedTag = storedTag || candidate?.tag || '';
  if (!metadata || !persistedTag || !candidate) {
    return { state: 'conflict' };
  }

  let kind: ExistingExternalSessionLookup['kind'] | null = null;
  if (metadataProvesExternalHistoryImportIdentity(metadata, {
    machineId: params.machineId,
    agentId: params.agentId,
    remoteSessionId: params.remoteSessionId,
    source: candidate.expectedSource,
    resolveSourceKey: params.resolveSourceKey,
  })) {
    kind = 'history_import';
  } else if (
    !readLinkedExternalSessionV1FromMetadata(metadata)
    && !readExternalHistoryImportV1FromMetadata(metadata)
    && metadataProvesHostedExternalSessionIdentity({
      metadata,
      currentStorageState: row.currentStorageState,
      currentStorageStateWasOmitted:
        !Object.prototype.hasOwnProperty.call(row, 'currentStorageState'),
      expected: {
      machineId: params.machineId,
      agentId: params.agentId,
      remoteSessionId: params.remoteSessionId,
      },
    })
  ) {
    kind = 'hosted_resume';
  } else if (
    candidate.kind === 'codex-connected-service-predecessor'
      ? metadataProvesCodexExternalSessionGroupIdentity(metadata, {
          machineId: params.machineId,
          remoteSessionId: params.remoteSessionId,
          groupId: candidate.expectedConnectedServiceGroupId,
        })
      : metadataProvesExternalSessionIdentity(metadata, {
          machineId: params.machineId,
          agentId: params.agentId,
          remoteSessionId: params.remoteSessionId,
          source: candidate.expectedSource,
          resolveSourceKey: params.resolveSourceKey,
        })
  ) {
    kind = 'external_link';
  }
  if (!kind) return { state: 'conflict' };

  return {
    state: 'available',
    proof: lookup,
    existing: {
      sessionId: row.id,
      rawSession: row,
      persistedTag,
      metadata,
      ...(sharedMetadata?.success ? { sharedMetadata: sharedMetadata.data } : {}),
      ...(ownerMetadata ? { ownerMetadata } : {}),
      currentStorageState: row.currentStorageState,
      currentStorageStateWasOmitted:
        !Object.prototype.hasOwnProperty.call(row, 'currentStorageState'),
      kind,
    },
  };
}

function buildExternalSessionMetadata(params: Readonly<{
  tag: string;
  machineId: string;
  agentId: ExternalSessionsAgentId;
  remoteSessionId: string;
  source: ExternalSessionsSource;
  qualifiedIdentity: LinkedExternalSessionQualifiedIdentityV1;
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
  const resume = isAgentId(params.agentId) ? getAgentResumeConfig(params.agentId) : null;
  const vendorResumeIdField = resume && 'vendorResumeIdField' in resume ? resume.vendorResumeIdField ?? null : null;
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
  const externalSessionV1 = {
    v: 1 as const,
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
    qualifiedIdentity: params.qualifiedIdentity,
  };
  const baseWithoutLink: Record<string, unknown> = {
    tag: params.tag,
    path: directoryHint,
    host: os.hostname(),
    machineId: params.machineId,
    flavor: params.agentId,
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
  const base = buildLinkedExternalSessionMetadataV1(baseWithoutLink, externalSessionV1);
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
  linkData?: PluginAgentExternalSessionLinkData;
  codexBackendMode?: unknown;
  runtimeDescriptor?: RuntimeDescriptorV1 | null;
  titleHint?: string | null;
  directoryHint?: string | null;
  expectedSourceKey?: string;
  shouldCommit?: () => boolean;
  indexedTagLookupProof?: ExternalSessionIndexedTagLookupProof;
  requireIndexedTagLookup?: boolean;
  signal?: AbortSignal;
  deadlineAtMs?: number;
  nowMs?: () => number;
}>, deps: Readonly<{
  resolveExternalSessionProviderOps: (
    agentId: ExternalSessionsAgentId,
  ) => Promise<ExternalSessionExecutionSurface | null>;
  resolveCurrentAgent: (
    agentId: ExternalSessionsAgentId,
  ) => Promise<CurrentExternalSessionAgentIdentity | null>;
  resolveSourceKeyOwner: (
    agentId: ExternalSessionsAgentId,
    source: ExternalSessionsSource,
  ) => Promise<Readonly<{
    sourceKey: string;
    resolveSourceKey(candidate: ExternalSessionsSource): string | null;
    resolvePersistedSourceKeys(candidate: ExternalSessionsSource): readonly [string, ...string[]] | null;
  }> | null>;
}>): Promise<{ sessionId: string; created: boolean; tag: string }> {
  const nowMs = params.nowMs ?? (() => Date.now());
  const externalSessionProviderOps = await deps.resolveExternalSessionProviderOps(params.agentId);
  const linkIdentity = await resolveExternalSessionLinkIdentityFromSurface(
    {
      agentId: params.agentId,
      remoteSessionId: params.remoteSessionId,
      source: params.source,
      runtimeDescriptor: params.runtimeDescriptor,
      metadata: params.linkData || params.runtimeDescriptor || params.codexBackendMode
        ? {
            linkData: {
              ...(params.linkData ?? {}),
              ...(params.runtimeDescriptor
                ? { runtimeDescriptorV1: params.runtimeDescriptor }
                : {}),
              ...(params.codexBackendMode
                ? { codexBackendMode: params.codexBackendMode }
                : {}),
            },
          }
        : undefined,
    },
    externalSessionProviderOps,
  );
  const remoteSessionId = linkIdentity.remoteSessionId;
  const source = linkIdentity.source;
  const codexBackendMode =
    normalizeCodexBackendMode(linkIdentity.vendorMetadata?.codexBackendMode)
    ?? normalizeCodexBackendMode(params.codexBackendMode);
  const runtimeDescriptor = linkIdentity.runtimeDescriptor ?? params.runtimeDescriptor ?? null;
  const qualifiedIdentityResolution = await resolveLinkedExternalSessionQualifiedIdentity({
    v: 1,
    agentId: params.agentId,
    machineId: params.machineId,
    remoteSessionId,
    source,
  }, {
    resolveCurrentAgent: deps.resolveCurrentAgent,
  });
  if (!qualifiedIdentityResolution.ok) {
    throw new ExternalSessionProviderFailureError({
      code: qualifiedIdentityResolution.errorCode,
      message: qualifiedIdentityResolution.error,
      operation: 'externalSession.resolveQualifiedIdentity',
    });
  }
  const qualifiedIdentity = qualifiedIdentityResolution.link.qualifiedIdentity!;
  const sourceKeyOwner = await deps.resolveSourceKeyOwner(params.agentId, source);
  const releasedSourceKeys = sourceKeyOwner?.resolvePersistedSourceKeys(params.source) ?? null;
  if (
    !sourceKeyOwner
    || !releasedSourceKeys
    || (
      params.expectedSourceKey !== undefined
      && sourceKeyOwner.sourceKey !== params.expectedSourceKey
    )
  ) {
    throw new ExternalSessionProviderFailureError({
      code: 'source_invalid',
      message: 'External-session source is not declared by the current Agent',
      operation: 'externalSession.resolveSourceKey',
    });
  }

  const lookupTags = resolveExternalSessionTagLookupCandidates({
    machineId: params.machineId,
    agentId: params.agentId,
    remoteSessionId,
    source,
    releasedPersistedSource: params.source,
    sourceKey: sourceKeyOwner.sourceKey,
    releasedSourceKeys,
  });
  const tag = lookupTags[0].tag;
  const connectedServiceRuntimeSnapshot = await resolveConnectedServiceRuntimeSnapshotForExternalSession({
    agentId: params.agentId,
    remoteSessionId,
    directoryHint: params.directoryHint,
  });
  const indexedLookup = await resolveExternalSessionIndexedTagLookup({
    credentials: params.credentials,
    machineId: params.machineId,
    agentId: params.agentId,
    remoteSessionId,
    source,
    tagCandidates: lookupTags,
    resolveSourceKey: sourceKeyOwner.resolveSourceKey,
    ...(params.indexedTagLookupProof
      ? { proof: params.indexedTagLookupProof }
      : {}),
    ...(params.signal ? { signal: params.signal } : {}),
    ...(params.deadlineAtMs !== undefined
      ? { deadlineAtMs: params.deadlineAtMs }
      : {}),
  });
  if (indexedLookup.state === 'conflict') {
    throw new ExternalSessionProviderFailureError({
      code: 'conflict',
      message: 'external_session_tag_lookup_conflict',
      operation: 'externalSession.lookupByTags',
    });
  }
  if (
    indexedLookup.state === 'unavailable'
    && params.requireIndexedTagLookup === true
  ) {
    throw new ExternalSessionProviderFailureError({
      code: 'agent_unavailable',
      message: 'external_session_tag_lookup_unavailable',
      operation: 'externalSession.lookupByTags',
    });
  }
  const indexedExistingSession =
    indexedLookup.state === 'available' ? indexedLookup.existing : null;
  const indexedLookupProvedNoServerTagMatch =
    indexedLookup.state === 'available'
    && indexedExistingSession === null;
  const indexedAbsenceNeedsCodexGroupRecovery =
    indexedLookupProvedNoServerTagMatch
    && lookupTags.some(
      (lookup) => lookup.kind === 'codex-connected-service-predecessor',
    );
  const indexedAbsenceNeedsLegacyMetadataRecovery =
    indexedLookupProvedNoServerTagMatch
    && params.requireIndexedTagLookup !== true
    && !indexedAbsenceNeedsCodexGroupRecovery;
  if (
    indexedAbsenceNeedsCodexGroupRecovery
    && params.requireIndexedTagLookup === true
  ) {
    throw new ExternalSessionProviderFailureError({
      code: 'conflict',
      message: 'external_session_codex_member_history_unavailable',
      operation: 'externalSession.lookupByTags',
    });
  }

  const shouldScanLegacyMetadata =
    indexedLookup.state === 'unavailable'
    || indexedAbsenceNeedsLegacyMetadataRecovery;
  let existingSession = shouldScanLegacyMetadata
    ? await findExistingSessionIdByTag({
        credentials: params.credentials,
        tag,
        ...(indexedAbsenceNeedsLegacyMetadataRecovery
          ? {
              metadataMatches: (metadata: Readonly<Record<string, unknown>>) =>
                metadataProvesExternalSessionIdentity(metadata, {
                  machineId: params.machineId,
                  agentId: params.agentId,
                  remoteSessionId,
                  source,
                  resolveSourceKey: sourceKeyOwner.resolveSourceKey,
                }),
            }
          : {}),
        metadataIdentityMatches: (metadata, row) => (
          metadataProvesExternalHistoryImportIdentity(metadata, {
            machineId: params.machineId,
            agentId: params.agentId,
            remoteSessionId,
            source,
            resolveSourceKey: sourceKeyOwner.resolveSourceKey,
          })
          || metadataProvesHostedExternalSessionIdentity({
            metadata,
            currentStorageState: row.currentStorageState,
            currentStorageStateWasOmitted:
              !Object.prototype.hasOwnProperty.call(row, 'currentStorageState'),
            expected: {
              machineId: params.machineId,
              agentId: params.agentId,
              remoteSessionId,
            },
          })
        ),
      })
    : indexedExistingSession;
  if (shouldScanLegacyMetadata) {
    for (const legacyLookup of lookupTags.slice(1)) {
      if (legacyLookup.kind === 'codex-connected-service-predecessor') continue;
      if (existingSession) break;
      existingSession = await findExistingSessionIdByTag({
        credentials: params.credentials,
        tag: legacyLookup.tag,
        metadataMatches: (metadata) => metadataProvesExternalSessionIdentity(metadata, {
          machineId: params.machineId,
          agentId: params.agentId,
          remoteSessionId,
          source: legacyLookup.expectedSource,
          resolveSourceKey: sourceKeyOwner.resolveSourceKey,
        }),
      });
    }
  }
  if (
    (
      shouldScanLegacyMetadata
      || indexedAbsenceNeedsCodexGroupRecovery
    )
    && !existingSession
    && params.agentId === 'codex'
    && source.kind === 'codexHome'
  ) {
    const predecessor = lookupTags.find(
      (lookup) => lookup.kind === 'codex-connected-service-predecessor',
    );
    if (predecessor) {
      existingSession = await findExistingSessionIdByTag({
        credentials: params.credentials,
        tag: predecessor.tag,
        metadataMatches: (metadata) => metadataProvesCodexGroup(
          metadata,
          predecessor.expectedConnectedServiceGroupId,
        ),
        metadataIdentityMatches: (metadata) => metadataProvesCodexExternalSessionGroupIdentity(metadata, {
          machineId: params.machineId,
          remoteSessionId,
          groupId: predecessor.expectedConnectedServiceGroupId,
        }),
      });
    }
  }

  if (
    existingSession
    && lookupTags.some((lookup) => metadataProvesExternalHistoryImportIdentity(
      existingSession.metadata,
      {
        machineId: params.machineId,
        agentId: params.agentId,
        remoteSessionId,
        source: lookup.expectedSource,
        resolveSourceKey: sourceKeyOwner.resolveSourceKey,
      },
    ))
  ) {
    // A persisted takeover deliberately replaces the live-link owner with this
    // tombstone. Reopening must preserve that conversion and route to the
    // existing session without refreshing link metadata or storage state.
    return { sessionId: existingSession.sessionId, created: false, tag };
  }

  if (
    existingSession
    && metadataProvesHostedExternalSessionIdentity({
      metadata: existingSession.metadata,
      currentStorageState: existingSession.currentStorageState,
      currentStorageStateWasOmitted:
        existingSession.currentStorageStateWasOmitted,
      expected: {
        machineId: params.machineId,
        agentId: params.agentId,
        remoteSessionId,
      },
    })
  ) {
    // Hosted sessions already own both the Happier session and native Agent
    // transcript. Linking must reuse that owner without changing storage or
    // writing a second external-session identity over it.
    return { sessionId: existingSession.sessionId, created: false, tag };
  }

  const metadata = buildExternalSessionMetadata({
    tag,
    machineId: params.machineId,
    agentId: params.agentId,
    remoteSessionId,
    source,
    qualifiedIdentity,
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

  if (existingSession) {
    await refreshExistingExternalSessionMetadataIfNeeded({
      credentials: params.credentials,
      sessionId: existingSession.sessionId,
      tag,
      machineId: params.machineId,
      agentId: params.agentId,
      remoteSessionId,
      source,
      qualifiedIdentity,
      codexBackendMode,
      runtimeDescriptor,
      sessionStateUpdates: linkIdentity.sessionStateUpdates,
      vendorMetadata: linkIdentity.vendorMetadata,
      externalSessionMetadata: linkIdentity.externalSessionMetadata,
      connectedServiceRuntimeSnapshot,
      titleHint: params.titleHint,
      directoryHint: params.directoryHint,
      ...(params.shouldCommit
        ? { shouldCommit: params.shouldCommit }
        : {}),
      nowMs: nowMs(),
    });
    if (indexedLookupProvedNoServerTagMatch) {
      // The bounded fallback found a legacy row whose identity tag exists only
      // inside encrypted metadata. Calling the tag-indexed create-or-load route
      // would create a second row because the server already proved that no
      // row has this clear tag.
      assertExternalSessionLinkCommitPrecondition(params.shouldCommit);
      return { sessionId: existingSession.sessionId, created: false, tag };
    }
    await getOrCreateSessionByTag({
      credentials: params.credentials,
      tag: existingSession.persistedTag,
      metadata,
      agentState: null,
      currentStorageState: 'machine_only',
      ...(params.shouldCommit
        ? { shouldCommit: params.shouldCommit }
        : {}),
    });
    return { sessionId: existingSession.sessionId, created: false, tag };
  }

  const { session, created } = await getOrCreateSessionByTag({
    credentials: params.credentials,
    tag,
    metadata,
    agentState: null,
    currentStorageState: 'machine_only',
    ...(params.shouldCommit
      ? { shouldCommit: params.shouldCommit }
      : {}),
  });

  return { sessionId: session.id, created: created !== false, tag };
}
