import { resolveSessionIdPrefixScanMaxPages } from '@/session/query/sessionIdPrefixScanBudget';
import { SESSION_METADATA_LAYOUT_VERSION_V1, StoredSessionSharedMetadataV1Schema, projectSessionOwnerCompatibilityViewV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { resolveExternalHistoryImportV1FromMetadata, readNonAuthoritativeLinkedExternalSessionV1FromMetadata, resolveLinkedExternalSessionMetadataV1 } from '@happier-dev/protocol/sessions/external/linked-metadata';
import type { ExternalSessionsAgentId, ExternalSessionsSource, PluginAgentExternalSessionLinkData, RuntimeDescriptorV1, SessionOwnerMetadataV1, SessionSharedMetadataV1, AccountEncryptionCurrentnessResponse } from '@happier-dev/protocol';
import { fetchAccountEncryptionCurrentness } from '@/api/client/connectedServiceCredentialApi';

import type { StoredCredentials } from '@/persistence';
import {
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
import {
  ExternalSessionProviderFailureError,
  type ExternalSessionExecutionSurface,
} from '@/session/external/providerOps';
import { resolveExternalSessionLinkIdentityFromSurface } from '@/session/external/resolveExternalSessionLinkIdentity';
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
import {
  resolveHostedExternalSessionIdentityProof,
} from './hostedExternalSessionIdentity';

import { buildExternalSessionMetadata, refreshExistingExternalSessionMetadataIfNeeded, normalizeNullableString, assertExternalSessionLinkCommitPrecondition } from './linkedMetadata';
import { publishLinkedSessionProject } from './projectPublication';
export { buildExternalSessionMetadata } from './linkedMetadata';


function createExistingSessionTagLookup(params: Readonly<{
  credentials: StoredCredentials;
  accountEncryptionMode: AccountEncryptionCurrentnessResponse['mode'];
  signal?: AbortSignal;
}>) {
  // Released-tag recovery examines the same Account inventory in priority
  // order. Reuse each page and owner view only within this link operation;
  // the selected live link is still re-read and identity-checked before refresh.
  const pages = new Map<string, ReturnType<typeof fetchSessionsPage>>();
  const metadataByRow = new WeakMap<RawSessionListRow, ReturnType<typeof tryDecryptSessionOwnerMetadataView>>();
  return async (lookup: Readonly<{
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
  }> | null> => {
    const maxPages = resolveSessionIdPrefixScanMaxPages();
    const scan = async (archivedOnly: boolean): Promise<Readonly<{
      sessionId: string;
      persistedTag: string;
      metadata: Readonly<Record<string, unknown>>;
      currentStorageState: RawSessionListRow['currentStorageState'];
      currentStorageStateWasOmitted: boolean;
    }> | null> => {
      let cursor: string | undefined;
      for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
        if (params.signal?.aborted) {
          throw new ExternalSessionProviderFailureError({
            code: 'cancelled', message: 'external_session_link_cancelled', operation: 'externalSession.lookupByTags',
          });
        }
        const key = JSON.stringify([archivedOnly, cursor ?? null]);
        let pending = pages.get(key);
        if (!pending) {
          pending = fetchSessionsPage({
            token: params.credentials.token,
            cursor,
            limit: 200,
            archivedOnly,
            ...(params.signal ? { signal: params.signal } : {}),
          });
          pages.set(key, pending);
        }
        const page = await pending;
        for (const row of page.sessions) {
          if (!metadataByRow.has(row)) metadataByRow.set(row, tryDecryptSessionOwnerMetadataView({
            credentials: params.credentials,
            rawSession: row,
            accountEncryptionMode: params.accountEncryptionMode,
          }));
          const meta = metadataByRow.get(row) ?? null;
          const rowTagRaw = meta?.['tag'];
          const rowTag = typeof rowTagRaw === 'string' ? rowTagRaw.trim() : '';
          if (meta !== null && rowTag === lookup.tag) {
            const linked = resolveLinkedExternalSessionMetadataV1(meta, 'stored');
            if (!linked.ok && linked.error !== 'linked_session_not_found') {
              throw new ExternalSessionProviderFailureError({
                code: 'conflict',
                message: linked.error,
                operation: 'externalSession.lookupByTags',
              });
            }
          }
          if (meta !== null && (
            (rowTag && rowTag === lookup.tag && (!lookup.metadataMatches || lookup.metadataMatches(meta, row)))
            || lookup.metadataIdentityMatches?.(meta, row) === true
          )) {
            return {
              sessionId: row.id,
              persistedTag: rowTag || lookup.tag,
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
  };
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
  const resolution = resolveExternalHistoryImportV1FromMetadata(metadata, 'stored');
  if (resolution.state === 'invalid') {
    throw new ExternalSessionProviderFailureError({
      code: 'conflict',
      message: resolution.error,
      operation: 'externalSession.lookupByTags',
    });
  }
  if (resolution.state === 'absent') return false;
  const imported = resolution.historyImport;
  return metadata.machineId === expected.machineId
    && imported.agentId === expected.agentId
    && imported.remoteSessionId === expected.remoteSessionId
    && expected.resolveSourceKey(imported.source) === expected.resolveSourceKey(expected.source);
}

function metadataProvesConnectedServiceGroup(metadata: Readonly<Record<string, unknown>>, expectedGroupId: string): boolean {
  const linkedSession = readNonAuthoritativeLinkedExternalSessionV1FromMetadata(metadata);
  return linkedSession?.source.kind === 'codexHome'
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
  const linkedSession = readNonAuthoritativeLinkedExternalSessionV1FromMetadata(metadata);
  return linkedSession?.machineId === expected.machineId
    && linkedSession.agentId === expected.agentId
    && linkedSession.remoteSessionId === expected.remoteSessionId
    && expected.resolveSourceKey(linkedSession.source) === expected.resolveSourceKey(expected.source);
}

function metadataProvesExternalSessionGroupIdentity(
  metadata: Readonly<Record<string, unknown>>,
  expected: Readonly<{ machineId: string; remoteSessionId: string; groupId: string }>,
): boolean {
  const linkedSession = readNonAuthoritativeLinkedExternalSessionV1FromMetadata(metadata);
  return linkedSession?.machineId === expected.machineId
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
  credentials: StoredCredentials;
  accountEncryptionMode: AccountEncryptionCurrentnessResponse['mode'];
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
    ? StoredSessionSharedMetadataV1Schema.safeParse(sharedOrLegacyMetadata)
    : null;
  const ownerMetadata = metadataLayoutVersion === SESSION_METADATA_LAYOUT_VERSION_V1
    ? tryDecryptSessionOwnerMetadata({
      credentials: params.credentials,
      rawSession: row,
      accountEncryptionMode: params.accountEncryptionMode,
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
  const linkedMetadataResolution = resolveLinkedExternalSessionMetadataV1(
    metadata,
    'stored',
  );
  if (
    !linkedMetadataResolution.ok
    && linkedMetadataResolution.error !== 'linked_session_not_found'
  ) {
    return { state: 'conflict' };
  }
  const storedTag = typeof metadata?.tag === 'string'
    ? metadata.tag.trim()
    : '';
  const candidate = storedTag
    ? params.tagCandidates.find((value) => value.tag === storedTag)
    : params.tagCandidates.find((value) => (
      value.kind === 'connected-service-group-predecessor'
        ? metadataProvesExternalSessionGroupIdentity(metadata ?? {}, {
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

  const hostedIdentityProof = resolveHostedExternalSessionIdentityProof({
    metadata,
    currentStorageState: row.currentStorageState,
    currentStorageStateWasOmitted:
      !Object.prototype.hasOwnProperty.call(row, 'currentStorageState'),
    expected: {
      machineId: params.machineId,
      agentId: params.agentId,
      remoteSessionId: params.remoteSessionId,
    },
  });
  if (hostedIdentityProof.state === 'conflict') {
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
    hostedIdentityProof.state === 'matched'
  ) {
    kind = 'hosted_resume';
  } else if (
    candidate.kind === 'connected-service-group-predecessor'
      ? metadataProvesExternalSessionGroupIdentity(metadata, {
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

export async function ensureExternalSessionLink(params: Readonly<{
  credentials: StoredCredentials;
  machineId: string;
  agentId: ExternalSessionsAgentId;
  remoteSessionId: string;
  source: ExternalSessionsSource;
  linkData?: PluginAgentExternalSessionLinkData;
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
  const [externalSessionProviderOps, accountEncryptionCurrentness] = await Promise.all([
    deps.resolveExternalSessionProviderOps(params.agentId),
    fetchAccountEncryptionCurrentness({
      credentials: params.credentials, token: params.credentials.token,
      ...(params.signal ? { signal: params.signal } : {}),
    }),
  ]);
  const linkIdentity = await resolveExternalSessionLinkIdentityFromSurface(
    {
      agentId: params.agentId,
      remoteSessionId: params.remoteSessionId,
      source: params.source,
      runtimeDescriptor: params.runtimeDescriptor,
      metadata: params.linkData || params.runtimeDescriptor
        ? {
            linkData: {
              ...(params.linkData ?? {}),
              ...(params.runtimeDescriptor
                ? { runtimeDescriptorV1: params.runtimeDescriptor }
                : {}),
            },
          }
        : undefined,
    },
    externalSessionProviderOps,
  );
  const remoteSessionId = linkIdentity.remoteSessionId;
  const source = linkIdentity.source;
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
  });
  const indexedLookup = await resolveExternalSessionIndexedTagLookup({
    credentials: params.credentials,
    accountEncryptionMode: accountEncryptionCurrentness.mode,
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
  if (indexedLookup.state === 'unavailable') {
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
      (lookup) => lookup.kind === 'connected-service-group-predecessor',
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

  // A current indexed absence cannot represent historical metadata-only identities.
  // Recover those retained rows, but never substitute a scan for a missing operation.
  const shouldScanLegacyMetadata = indexedAbsenceNeedsLegacyMetadataRecovery;
  const findExistingSessionIdByTag = createExistingSessionTagLookup({
    credentials: params.credentials,
    accountEncryptionMode: accountEncryptionCurrentness.mode,
    ...(params.signal ? { signal: params.signal } : {}),
  });
  let existingSession = shouldScanLegacyMetadata
    ? await findExistingSessionIdByTag({
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
        metadataIdentityMatches: (metadata, row) => {
          if (metadataProvesExternalHistoryImportIdentity(metadata, {
            machineId: params.machineId,
            agentId: params.agentId,
            remoteSessionId,
            source,
            resolveSourceKey: sourceKeyOwner.resolveSourceKey,
          })) {
            return true;
          }
          const hostedIdentityProof = resolveHostedExternalSessionIdentityProof({
            metadata,
            currentStorageState: row.currentStorageState,
            currentStorageStateWasOmitted:
              !Object.prototype.hasOwnProperty.call(row, 'currentStorageState'),
            expected: {
              machineId: params.machineId,
              agentId: params.agentId,
              remoteSessionId,
            },
          });
          if (hostedIdentityProof.state === 'conflict') {
            throw new ExternalSessionProviderFailureError({
              code: 'conflict',
              message: hostedIdentityProof.error,
              operation: 'externalSession.lookupByTags',
            });
          }
          return hostedIdentityProof.state === 'matched';
        },
      })
    : indexedExistingSession;
  if (shouldScanLegacyMetadata) {
    for (const legacyLookup of lookupTags.slice(1)) {
      if (legacyLookup.kind === 'connected-service-group-predecessor') continue;
      if (existingSession) break;
      existingSession = await findExistingSessionIdByTag({
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
    && source.kind === 'codexHome'
  ) {
    const predecessor = lookupTags.find(
      (lookup) => lookup.kind === 'connected-service-group-predecessor',
    );
    if (predecessor) {
      existingSession = await findExistingSessionIdByTag({
        tag: predecessor.tag,
        metadataMatches: (metadata) => metadataProvesConnectedServiceGroup(
          metadata,
          predecessor.expectedConnectedServiceGroupId,
        ),
        metadataIdentityMatches: (metadata) => metadataProvesExternalSessionGroupIdentity(metadata, {
          machineId: params.machineId,
          remoteSessionId,
          groupId: predecessor.expectedConnectedServiceGroupId,
        }) || metadataProvesExternalHistoryImportIdentity(metadata, {
          machineId: params.machineId,
          agentId: params.agentId,
          remoteSessionId,
          source,
          resolveSourceKey: sourceKeyOwner.resolveSourceKey,
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

  if (existingSession) {
    const hostedIdentityProof = resolveHostedExternalSessionIdentityProof({
      metadata: existingSession.metadata,
      currentStorageState: existingSession.currentStorageState,
      currentStorageStateWasOmitted:
        existingSession.currentStorageStateWasOmitted,
      expected: {
        machineId: params.machineId,
        agentId: params.agentId,
        remoteSessionId,
      },
    });
    if (hostedIdentityProof.state === 'conflict') {
      throw new ExternalSessionProviderFailureError({
        code: 'conflict',
        message: hostedIdentityProof.error,
        operation: 'externalSession.lookupByTags',
      });
    }
    if (hostedIdentityProof.state === 'matched') {
      // Hosted sessions already own both the Happier session and native Agent
      // transcript. Linking must reuse that owner without changing storage or
      // writing a second external-session identity over it.
      return { sessionId: existingSession.sessionId, created: false, tag };
    }
  }

  const metadata = buildExternalSessionMetadata({
    tag,
    machineId: params.machineId,
    agentId: params.agentId,
    remoteSessionId,
    source,
    qualifiedIdentity,
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
    const expectedCurrentLinkResolution =
      resolveLinkedExternalSessionMetadataV1(existingSession.metadata, 'stored');
    if (!expectedCurrentLinkResolution.ok) {
      throw new ExternalSessionProviderFailureError({
        code: 'conflict',
        message: expectedCurrentLinkResolution.error,
        operation: 'externalSession.refreshExisting',
      });
    }
    await refreshExistingExternalSessionMetadataIfNeeded({
      credentials: params.credentials,
      signal: params.signal,
      accountEncryptionCurrentness,
      sessionId: existingSession.sessionId,
      tag,
      machineId: params.machineId,
      agentId: params.agentId,
      remoteSessionId,
      source,
      qualifiedIdentity,
      runtimeDescriptor,
      sessionStateUpdates: linkIdentity.sessionStateUpdates,
      vendorMetadata: linkIdentity.vendorMetadata,
      externalSessionMetadata: linkIdentity.externalSessionMetadata,
      connectedServiceRuntimeSnapshot,
      titleHint: params.titleHint,
      directoryHint: params.directoryHint,
      resolveSourceKey: sourceKeyOwner.resolveSourceKey,
      expectedCurrentLink: expectedCurrentLinkResolution.linkedSession,
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
      accountEncryptionCurrentness,
      tag: existingSession.persistedTag,
      metadata,
      agentState: null,
      currentStorageState: 'machine_only',
      ...(params.signal ? { signal: params.signal } : {}),
      ...(params.shouldCommit
        ? { shouldCommit: params.shouldCommit }
        : {}),
    });
    return { sessionId: existingSession.sessionId, created: false, tag };
  }

  const { session, created, creationConfirmed } = await getOrCreateSessionByTag({
    credentials: params.credentials,
    accountEncryptionCurrentness,
    tag,
    metadata,
    agentState: null,
    currentStorageState: 'machine_only',
    ...(params.signal ? { signal: params.signal } : {}),
    ...(params.shouldCommit
      ? { shouldCommit: params.shouldCommit }
      : {}),
  });

  if (creationConfirmed) await publishLinkedSessionProject({
    credentials: params.credentials, accountEncryptionCurrentness, rawSession: session, metadata,
    signal: params.signal, assertCurrent: () => assertExternalSessionLinkCommitPrecondition(params.shouldCommit),
  });
  return { sessionId: session.id, created: created !== false, tag };
}
