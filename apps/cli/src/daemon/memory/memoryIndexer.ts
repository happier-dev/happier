import { existsSync } from 'node:fs';

import type { MemoryExternalTranscriptSourceV1 } from '@happier-dev/protocol/memory/memorySearch';
import type { MemoryWorkerStatusV1 } from '@happier-dev/protocol/memory/memoryStatus';
import type { AgentExternalSessionsTranscriptPage } from '@happier-dev/plugin-sdk/sessions/external';
import { readRequesterAccountEncryptionCurrentness } from '@/api/client/accountEncryptionCurrentnessObservation';

import type { StoredCredentials } from '@/persistence';
import { DEFAULT_MEMORY_SETTINGS, type MemorySettingsV1 } from '@/settings/memorySettings';
import { configuration } from '@/configuration';

import { resolveMemoryIndexPaths } from './memoryIndexPaths';
import { openSummaryShardIndexDb, type SummaryShardIndexDbHandle } from './summaryShardIndexDb';
import { openDeepIndexDb, type DeepIndexDbHandle } from './deepIndex/deepIndexDb';
import type { DecryptedTranscriptRow } from '@/session/replay/decryptTranscriptRows';
import { fetchSessionById } from '@/session/transport/http/sessionsHttp';
import {
  resolveSessionEncryptionContextFromCredentials,
  resolveSessionStoredContentEncryptionMode,
  type SessionStoredContentCryptoContext,
} from '@/session/transport/encryption/sessionEncryptionContext';
import { decryptTranscriptRows } from '@/session/replay/decryptTranscriptRows';
import { fetchEncryptedTranscriptMessagesPage } from '@/session/replay/fetchEncryptedTranscriptMessages';
import { logger } from '@/ui/logger';
import { timeWebLatencyPhase } from '@/daemon/externalActions/webLatencyTrace';
import {
  collectRetainedSessionInventoryVisibility,
  fetchSessionInventoryPage,
} from '@/daemon/sessions/sessionInventoryVisibility';
import { fetchSessionsPage } from '@/session/transport/http/sessionsHttp';
import { syncMemoryHintsForSessionsOnce } from './syncMemoryHintsForSessionsOnce';
import { logServerEndpointFailure } from '@/api/client/serverEndpointFailureLog';
import { syncDeepIndexForSessionsOnce } from './deepIndex/syncDeepIndexForSessionsOnce';
import { createEmbeddingsProviderCache, resolveEmbeddingsProvider } from './deepIndex/embeddings/resolveEmbeddingsProvider';
import { ensurePrivateInferenceDirectory, resolveInferenceCacheDir } from '@/daemon/inference/inferencePaths';
import {
  buildUnavailableMemoryEmbeddingsDiagnostics,
  resolveOperationalMemoryEmbeddingsSettings,
  type OperationalMemoryEmbeddingsDiagnostics,
} from './resolveOperationalMemoryEmbeddingsSettings';
import {
  INITIAL_MEMORY_INVENTORY_STATE,
  refreshMemoryInventoryOnce,
  resolveMemoryInventorySessionEligibility,
  createMemorySessionLocalityReader,
  type MemoryInventoryRefresh,
  type MemoryInventoryPage,
  type MemoryInventoryScope,
  type MemoryInventoryState,
} from './inventory/refreshMemoryInventory';
import { removeMemorySessionIndexes } from './removeMemorySessionIndexes';
import { enforceMemoryDiskBudgets } from './enforceMemoryDiskBudgets';
import { deriveSettingsSecretsReadKeysForCredentials } from '@/settings/secrets/settingsSecretsKey';
import type { EmbeddingsProviderResolution } from './deepIndex/embeddings/embeddingsProviderTypes';
import { fetchMemorySemanticTranscriptPage } from './transcript/fetchSemanticPage';
import { AccountEncryptionMaterialUnavailableError } from '@/api/client/encryptionKey';
import { ensureProtectedLocalStateDirectory } from '@/utils/fs/protectedLocalState';
import {
  memoryIndexPolicyKey,
  resolveMemoryCoverageCreatedAtCutoffMs,
  resolveMemoryIndexPolicy,
} from './transcript/coveragePolicy';
import { createMemoryExternalTranscriptReader } from './externalTranscriptSources';
import type { MemoryExternalSourceReader } from './externalTranscriptIndex';
import { isExternalMemoryStorageId, resolveExternalMemoryIndexPolicy, syncExternalMemoryTranscriptsBatch } from './externalTranscriptIndex';
import { runMemoryWorkerSourcesTick } from './runMemoryWorkerSourcesTick';
import type { MemoryIndexerHost, MemoryDocumentIndexUpdate, MemoryIndexerPublication, MemorySessionInventoryObservation } from './memoryIndexerBoundary';

export type MemoryIndexerEngine = Readonly<{
  stop(): Promise<void>;
  applySettings(settings: MemorySettingsV1, signal?: AbortSignal): Promise<void>;
  inventory(signal: AbortSignal, observations?: readonly MemorySessionInventoryObservation[]): Promise<void>;
  tick(signal: AbortSignal): Promise<void>;
  runUntilSettled(signal: AbortSignal): Promise<void>;
  awaitModelInitialization(): Promise<void>;
  indexDocuments(update: MemoryDocumentIndexUpdate, signal?: AbortSignal): Promise<void>;
  retryEmbeddings(signal?: AbortSignal): Promise<void>;
  resolveEmbeddingsProvider(signal?: AbortSignal): Promise<EmbeddingsProviderResolution | null>;
  ensureUpToDate(sessionId?: string, signal?: AbortSignal): Promise<void>;
  noteSessionTranscriptRevised(change: Readonly<{ sessionId: string; seq: number; messageId?: string }>): Promise<void>;
  readExternalTranscriptPage(request: Readonly<{ source: MemoryExternalTranscriptSourceV1; cursor?: string }>, signal?: AbortSignal): Promise<AgentExternalSessionsTranscriptPage | null>;
  removeSessions(sessionIds: readonly string[]): Promise<void>;
  reconcileRetainedSessionAccess(signal?: AbortSignal): Promise<void>;
  applySessionArchivedState(change: Readonly<{ sessionId: string; archived: boolean }>): Promise<void>;
}>;

function logMemoryWorkerServerEndpointFailure(operation: string, error: unknown): void {
  logServerEndpointFailure({
    logger,
    operation: `memory worker ${operation}`,
    error,
  });
}

async function awaitEmbeddingsResolutionEpoch(
  promise: Promise<EmbeddingsProviderResolution | null>,
  signal?: AbortSignal,
): Promise<EmbeddingsProviderResolution | null> {
  if (!signal) return await promise;
  signal.throwIfAborted();
  return await new Promise<EmbeddingsProviderResolution | null>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  });
}

export async function createMemoryIndexer(params: Readonly<{
  host: MemoryIndexerHost;
  resolveExternalReader(agentId: string): Promise<MemoryExternalSourceReader['reader'] | null>;
  credentials: StoredCredentials;
  machineId: string;
  indexesQualified?: boolean;
  env?: NodeJS.ProcessEnv;
  deps?: Readonly<{
    fetchDecryptedTranscriptPageAfterSeq: (args: Readonly<{ sessionId: string; afterSeq: number; limit: number; signal?: AbortSignal }>) => Promise<DecryptedTranscriptRow[]>;
  }>;
}>): Promise<MemoryIndexerEngine> {
  let stopped = false;
  const paths = resolveMemoryIndexPaths();
  let settings: MemorySettingsV1 = DEFAULT_MEMORY_SETTINGS;
  let effectiveSettings: MemorySettingsV1 = DEFAULT_MEMORY_SETTINGS;
  let tier1: SummaryShardIndexDbHandle | null = null;
  let deep: DeepIndexDbHandle | null = null;
  let indexesQualified = false;
  let initialIndexesQualified = params.indexesQualified === true;
  let publicationAdmitted = false;
  let inventoryPublicationPending = false;
  let externalPublicationPending = false;
  let qualificationPublicationPending = false;
  let deadlinePublicationPending = false;
  const sessionPublicationUpdates = new Map<string, NonNullable<MemoryIndexerPublication['sessionUpdates']>[number]>();
  const removedPublicationSessionIds = new Set<string>();
  const updateSessionPublication = (sessionId: string, update: Omit<NonNullable<MemoryIndexerPublication['sessionUpdates']>[number], 'sessionId'>) => {
    removedPublicationSessionIds.delete(sessionId);
    sessionPublicationUpdates.set(sessionId, { ...sessionPublicationUpdates.get(sessionId), sessionId, ...update });
  };
  let candidateSessionIds: string[] = [];
  let candidateCursor = 0;
  const candidateAllowInitialBackfillSessionIds = new Set<string>();
  let inventoryState: MemoryInventoryState = INITIAL_MEMORY_INVENTORY_STATE;
  let inventoryAdmitted = false;
  let schedulerAdmitted = false;
  const hintWorkAtBySessionId = new Map<string, number>();
  const attemptedSessionFrontiers = new Map<string, number>();
  let inventoryBackfillPolicy: MemorySettingsV1['backfillPolicy'] = 'new_only';
  let inventoryIncludeArchivedSessions = DEFAULT_MEMORY_SETTINGS.includeArchivedSessions;
  /**
   * True while archived eligibility is desired off but the exclusion has not
   * been completed, so archived rows can still be searchable here.
   */
  let archivedExclusionPending = false;
  const inventorySeenSessionIds = new Set<string>();
  const candidateObservedSeqBySessionId = new Map<string, number>();
  const editedSessionIds = new Set<string>();
  const externalSources = createMemoryExternalTranscriptReader({ resolveReader: params.resolveExternalReader,
    onChange: refreshSources => { externalSourcesNeedRefresh ||= refreshSources; } });
  let externalSourcesNeedRefresh = true;
  let externalSyncPromise: Promise<void> | null = null;
  const sessionCryptoContextCache = new Map<string, SessionStoredContentCryptoContext>();
  const sessionLocality = createMemorySessionLocalityReader(params);
  const settingsSecretsReadKeys = deriveSettingsSecretsReadKeysForCredentials(params.credentials);
  const embeddingsProviderCache = createEmbeddingsProviderCache();
  let embeddingsResolutionEpoch: Readonly<{
    settings: MemorySettingsV1;
    promise: Promise<EmbeddingsProviderResolution | null>;
  }> | null = null;
  let embeddingsDiagnostics: OperationalMemoryEmbeddingsDiagnostics =
    buildUnavailableMemoryEmbeddingsDiagnostics(DEFAULT_MEMORY_SETTINGS.embeddings);
  let workerStatus: MemoryWorkerStatusV1 = {
    state: 'idle',
    lastTickAtMs: null,
    lastInventoryAtMs: null,
    currentSessionId: null,
    currentPhase: null,
  };
  const activeIndexOperations = new Set<Readonly<{
    kind: 'transcript' | 'documents';
    sessionIds: ReadonlySet<string>;
    controller: AbortController;
    promise: Promise<unknown>;
  }>>();
  const removingSessionIds = new Set<string>();
  let stopPromise: Promise<void> | null = null;
  const resolveSessionCryptoContext = async (
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<SessionStoredContentCryptoContext | null> => {
    signal?.throwIfAborted();
    const cached = sessionCryptoContextCache.get(sessionId);
    if (cached) return cached;

    const raw = await fetchSessionById({ reason: 'memory-change', token: params.credentials.token, sessionId, signal });
    signal?.throwIfAborted();
    if (!raw) return null;

    const mode = resolveSessionStoredContentEncryptionMode(raw);
    if (mode === 'plain') {
      const resolved = { mode, ctx: null } as const;
      sessionCryptoContextCache.set(sessionId, resolved);
      return resolved;
    }

    const ctx = resolveSessionEncryptionContextFromCredentials(params.credentials, raw);
    if (!ctx) {
      throw new AccountEncryptionMaterialUnavailableError();
    }
    const resolved = { mode, ctx } as const;
    sessionCryptoContextCache.set(sessionId, resolved);
    return resolved;
  };

  const resolveEmbeddingsDiagnosticsForSettings = async (
    requestedSettings: MemorySettingsV1,
  ): Promise<EmbeddingsProviderResolution | null> => {
    const embeddings = resolveOperationalMemoryEmbeddingsSettings(requestedSettings.embeddings);
    if (!embeddings?.enabled || !embeddings.providerConfig || !embeddings.providerKind || !embeddings.modelId) {
      embeddingsDiagnostics = buildUnavailableMemoryEmbeddingsDiagnostics(requestedSettings.embeddings);
      publishSnapshot();
      return null;
    }

    if (embeddings.providerKind === 'local_transformers') {
      embeddingsDiagnostics = {
        mode: embeddings.mode,
        presetId: embeddings.presetId,
        providerKind: embeddings.providerKind,
        modelId: embeddings.modelId,
        runtimeState: 'downloading',
        usingFallback: true,
        lastError: null,
      };
      publishSnapshot();
    }

    const cacheDir = resolveInferenceCacheDir({
      modelsRootDir: paths.modelsDir,
      runtimeId: 'transformers',
    });
    ensurePrivateInferenceDirectory(cacheDir);

    const resolution = await resolveEmbeddingsProvider({
      settings: embeddings,
      cacheDir,
      settingsSecretsReadKeys,
      cache: embeddingsProviderCache,
    });
    if (stopped) return null;
    if (settings !== requestedSettings) {
      // Model initialization can finish writing after disable removed its cache.
      // Reuse disabled-settings cleanup without restoring obsolete diagnostics.
      if (!settings.enabled && settings.deleteOnDisable) await applySettings(settings);
      return null;
    }
    embeddingsDiagnostics = {
      mode: resolution.mode,
      presetId: resolution.presetId,
      providerKind: resolution.providerKind,
      modelId: resolution.modelId,
      runtimeState: resolution.runtimeState,
      usingFallback: resolution.usingFallback,
      lastError: resolution.lastError,
    };
    publishSnapshot();
    return resolution;
  };

  const refreshEmbeddingsDiagnostics = (
    signal?: AbortSignal,
  ): Promise<EmbeddingsProviderResolution | null> => {
    const requestedSettings = settings;
    // A loaded memory-settings object is one provider-resolution epoch. Periodic
    // indexing reuses its settled failure; explicit refresh and owner events
    // below are the deliberate retry boundaries.
    if (embeddingsResolutionEpoch?.settings !== requestedSettings) {
      embeddingsResolutionEpoch = {
        settings: requestedSettings,
        promise: resolveEmbeddingsDiagnosticsForSettings(requestedSettings),
      };
    }
    return awaitEmbeddingsResolutionEpoch(embeddingsResolutionEpoch.promise, signal);
  };

  const deps: NonNullable<typeof params.deps> =
    params.deps ??
    ({
      fetchDecryptedTranscriptPageAfterSeq: async (
        args: Readonly<{ sessionId: string; afterSeq: number; limit: number; signal?: AbortSignal }>,
      ): Promise<DecryptedTranscriptRow[]> => {
        try {
          args.signal?.throwIfAborted();
          const cryptoContext = await resolveSessionCryptoContext(args.sessionId, args.signal);
          if (!cryptoContext) return [];

          const roleFiltered = await fetchEncryptedTranscriptMessagesPage({
            token: params.credentials.token,
            sessionId: args.sessionId,
            afterSeq: args.afterSeq,
            limit: args.limit,
            roles: ['user', 'agent'],
            scope: 'main',
            ...(args.signal ? { signal: args.signal } : {}),
          });
          args.signal?.throwIfAborted();

          return decryptTranscriptRows({
            // The whole crypto context, not just the key: memory ingests only rows
            // the Session's established mode can authenticate.
            crypto: cryptoContext,
            // Home includes legacy unclassified (null-role) rows in a `user` role filter.
            rows: roleFiltered.messages,
          });
        } catch (error) {
          if (!(error instanceof AccountEncryptionMaterialUnavailableError)) {
            logMemoryWorkerServerEndpointFailure('transcript page', error);
          }
          throw error;
        }
      },
    } as const);

  const stopLoop = async (): Promise<void> => {
    candidateSessionIds = [];
    candidateCursor = 0;
    candidateAllowInitialBackfillSessionIds.clear();
    candidateObservedSeqBySessionId.clear();
    inventoryState = INITIAL_MEMORY_INVENTORY_STATE;
    inventoryBackfillPolicy = 'new_only';
    inventoryIncludeArchivedSessions = DEFAULT_MEMORY_SETTINGS.includeArchivedSessions;
    inventorySeenSessionIds.clear();
    sessionLocality.clear();
  };

  const stop = (): Promise<void> => {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      stopped = true;
      await stopLoop();
      await externalSources.dispose();
      for (const operation of activeIndexOperations) operation.controller.abort();
      await Promise.allSettled([...activeIndexOperations].map((operation) => operation.promise));
      try {
        tier1?.close();
      } catch {
        // best-effort
      }
      tier1 = null;
      try {
        deep?.close();
      } catch {
        // best-effort
      }
      deep = null;
      embeddingsProviderCache.clear();
      embeddingsResolutionEpoch = null;
    })();
    return stopPromise;
  };

  const fetchMemoryInventoryPage = async (args: Readonly<{
    scope: MemoryInventoryScope;
    cursor?: string;
    limit: number;
    signal?: AbortSignal;
  }>): Promise<MemoryInventoryPage> => {
    // Eligibility reads owner-private Machine locality, so it explicitly needs full documents.
    return await fetchSessionsPage({
      token: params.credentials.token,
      ...(args.cursor === undefined ? {} : { cursor: args.cursor }),
      ...(args.scope === 'archived' ? { archivedOnly: true } : { activeOnly: false }),
      limit: args.limit,
      ...(args.signal ? { signal: args.signal } : {}),
    });
  };

  const resolveTier1IndexPolicy = (value: MemorySettingsV1) => resolveMemoryIndexPolicy(value);
  const resolveDeepIndexPolicy = (value: MemorySettingsV1) => resolveMemoryIndexPolicy({
    ...value,
    contentPolicy: value.deep.includeToolOutput
      ? { ...value.contentPolicy, includeToolOutputs: true }
      : value.contentPolicy,
  });

  const observeSessions = async (sessionIds: readonly string[], signal?: AbortSignal): Promise<void> => {
    const newlyObserved = await params.host.observeSessions(sessionIds);
    signal?.throwIfAborted();
    // Revalidate retained content on first observation after startup. Subsequent
    // edits come from the durable transcript-change feed, not Session updatedAt
    // (which also changes for metadata without any transcript change).
    for (const sessionId of newlyObserved) {
      const cursors = tier1?.getSessionCursors({ sessionId, nowMs: Date.now(), readOnly: true });
      if ((cursors?.lastHintedSeq ?? 0) > 0 || (cursors?.lastDeepIndexedSeq ?? 0) > 0) {
        editedSessionIds.add(sessionId);
        updateSessionPublication(sessionId, { edited: true });
      }
    }
  };

  /**
   * The one eligibility/inventory pass every policy and `ensureUpToDate` use.
   * `apply` replaces the candidate set for the snapshot policy and extends it
   * while paging, so no branch can inventory a scope the settings exclude.
   */
  const refreshInventory = async (options?: Readonly<{ apply?: boolean; signal?: AbortSignal }>): Promise<MemoryInventoryRefresh> => {
    const accountEncryptionMode = (await readRequesterAccountEncryptionCurrentness({ token: params.credentials.token, signal: options?.signal })).mode;
    const excludedScopeSessionIds = new Set<string>();
    const refresh = await refreshMemoryInventoryOnce({
      backfillPolicy: settings.backfillPolicy,
      includeArchivedSessions: settings.includeArchivedSessions,
      enabledAtMs: settings.enabledAtMs ?? 0,
      pageLimit: settings.worker.sessionListPageLimit,
      nowMs: Date.now(),
      state: inventoryState,
      seenSessionIds: inventorySeenSessionIds,
      fetchSessionsPage: fetchMemoryInventoryPage,
      isSessionEligible: session => {
        const eligible = sessionLocality.isOnMachine(session, accountEncryptionMode);
        if (!eligible && typeof session.id === 'string') excludedScopeSessionIds.add(session.id);
        return eligible;
      },
      ...(options?.signal ? { signal: options.signal } : {}),
    });
    options?.signal?.throwIfAborted();
    if (excludedScopeSessionIds.size) {
      // An unrelated Account Session has no memory state to remove. Repeated
      // removal would also discard its unchanged negative locality decision.
      const retained = new Set(listIndexedSessionIds());
      await removeSessions([...excludedScopeSessionIds].filter(id => retained.has(id)
        || inventorySeenSessionIds.has(id) || candidateObservedSeqBySessionId.has(id)));
    }
    await observeSessions([...refresh.observedSeqBySessionId.keys()]);

    if (options?.apply === false) return refresh;

    if (refresh.mode === 'snapshot') {
      // Preserve the next selected identity across refreshed snapshots. Resetting
      // to zero can starve the suffix (including native slots) indefinitely
      // when explicit inventory refreshes arrive before a traversal completes.
      const nextSessionId = candidateSessionIds[candidateCursor];
      const externalOffset = candidateCursor >= candidateSessionIds.length
        ? candidateCursor - candidateSessionIds.length : null;
      candidateAllowInitialBackfillSessionIds.clear();
      candidateObservedSeqBySessionId.clear();
      inventorySeenSessionIds.clear();
      candidateSessionIds = [...refresh.sessionIds];
      candidateCursor = externalOffset !== null ? candidateSessionIds.length + externalOffset
        : Math.max(0, nextSessionId ? candidateSessionIds.indexOf(nextSessionId) : 0);
      for (const [sessionId, seq] of refresh.observedSeqBySessionId) {
        candidateObservedSeqBySessionId.set(sessionId, seq);
      }
      for (const sessionId of refresh.allowInitialBackfillSessionIds) {
        candidateAllowInitialBackfillSessionIds.add(sessionId);
      }
    } else {
      candidateAllowInitialBackfillSessionIds.clear();
      for (const [sessionId, seq] of refresh.observedSeqBySessionId) {
        candidateObservedSeqBySessionId.set(sessionId, seq);
      }
      for (const sessionId of refresh.sessionIds) {
        inventorySeenSessionIds.add(sessionId);
        candidateSessionIds.push(sessionId);
      }
    }

    inventoryState = refresh.state;
    inventoryAdmitted = true;
    inventoryBackfillPolicy = settings.backfillPolicy;
    inventoryIncludeArchivedSessions = settings.includeArchivedSessions;
    inventoryPublicationPending = true;
    deadlinePublicationPending = true;
    publishSnapshot();
    return refresh;
  };

  const forgetWorkerSessionState = (sessionIds: readonly string[]): void => {
    const doomed = new Set(sessionIds);
    if (doomed.size === 0) return;
    sessionLocality.forget(sessionIds);
    candidateSessionIds = candidateSessionIds.filter((id) => !doomed.has(id));
    candidateCursor = candidateSessionIds.length === 0
      ? 0
      : candidateCursor % candidateSessionIds.length;
    for (const sessionId of doomed) {
      candidateAllowInitialBackfillSessionIds.delete(sessionId);
      candidateObservedSeqBySessionId.delete(sessionId);
      inventorySeenSessionIds.delete(sessionId);
      sessionCryptoContextCache.delete(sessionId);
      editedSessionIds.delete(sessionId);
      sessionPublicationUpdates.delete(sessionId);
      removedPublicationSessionIds.add(sessionId);
    }
    deadlinePublicationPending = true;
  };

  const withRetainedIndexHandles = <T>(
    use: (handles: Readonly<{
      tier1: SummaryShardIndexDbHandle | null;
      deep: DeepIndexDbHandle | null;
    }>) => T,
  ): T => {
    let retainedTier1: SummaryShardIndexDbHandle | null = tier1;
    let retainedDeep: DeepIndexDbHandle | null = deep;
    let closeTier1 = false;
    let closeDeep = false;
    try {
      if (!retainedTier1 && existsSync(paths.tier1DbPath)) {
        retainedTier1 = openSummaryShardIndexDb({ dbPath: paths.tier1DbPath });
        closeTier1 = true;
      }
      if (!retainedDeep && existsSync(paths.deepDbPath)) {
        retainedDeep = openDeepIndexDb({ dbPath: paths.deepDbPath });
        closeDeep = true;
      }
      return use({ tier1: retainedTier1, deep: retainedDeep });
    } finally {
      if (closeDeep) retainedDeep?.close();
      if (closeTier1) retainedTier1?.close();
    }
  };

  const removeSessions = async (sessionIds: readonly string[]): Promise<void> => {
    const normalized = [...new Set(sessionIds.map((id) => id.trim()).filter((id) => id.length > 0))];
    if (normalized.length === 0) return;
    const doomed = new Set(normalized);
    for (const sessionId of doomed) removingSessionIds.add(sessionId);
    forgetWorkerSessionState(normalized);
    try {
      const conflicting = [...activeIndexOperations]
        .filter((operation) => [...operation.sessionIds].some((sessionId) => doomed.has(sessionId)));
      for (const operation of conflicting) operation.controller.abort();
      await Promise.allSettled(conflicting.map((operation) => operation.promise));
      const removed = withRetainedIndexHandles((handles) => (
        removeMemorySessionIndexes({ ...handles, sessionIds: normalized })
      ));
      forgetWorkerSessionState(removed);
    } finally {
      for (const sessionId of doomed) removingSessionIds.delete(sessionId);
      publishSnapshot();
    }
  };

  const listIndexedSessionIds = (): readonly string[] => {
    return withRetainedIndexHandles((handles) => {
      const retained = new Set<string>();
      for (const sessionId of handles.tier1?.listIndexedSessionIds() ?? []) if (!isExternalMemoryStorageId(sessionId)) retained.add(sessionId);
      const external = new Set(handles.deep?.listExternalSourceStates().map(state => state.sessionId) ?? []);
      for (const sessionId of handles.deep?.listIndexedSessionIds() ?? []) if (!external.has(sessionId)) retained.add(sessionId);
      return [...retained];
    });
  };

  const reconcileRetainedSessionAccess = async (signal?: AbortSignal): Promise<void> => {
    const retained = new Set(listIndexedSessionIds());
    if (retained.size === 0) return;
    // Archived sessions are only eligible when the setting is enabled.  The
    // retained-access reconciliation is also the recovery path for archive
    // transitions missed while the worker was offline, so querying archived
    // inventory while the policy is disabled would incorrectly preserve stale
    // derived content.
    const scopes = settings.includeArchivedSessions
      ? (['active', 'archived'] as const)
      : (['active'] as const);
    const visible = await collectRetainedSessionInventoryVisibility({
      retainedSessionIds: [...retained],
      scopes,
      fetchInventoryPage: async (args) => await fetchMemoryInventoryPage({
        ...args,
        limit: settings.worker.sessionListPageLimit,
        ...(signal ? { signal } : {}),
      }).then(async page => {
        const accountEncryptionMode = (await readRequesterAccountEncryptionCurrentness({ token: params.credentials.token, signal })).mode;
        return { ...page, sessions: page.sessions.filter(session => sessionLocality.isOnMachine(session, accountEncryptionMode)) };
      }),
    });
    signal?.throwIfAborted();
    await removeSessions([...retained].filter((sessionId) => !visible.has(sessionId)));
  };

  const applySessionArchivedState = async (
    change: Readonly<{ sessionId: string; archived: boolean }>,
  ): Promise<void> => {
    if (!change.archived) return;
    if (settings.includeArchivedSessions) return;
    try {
      await removeSessions([change.sessionId]);
    } catch (error) {
      archivedExclusionPending = true;
      publishSnapshot();
      throw error;
    }
  };

  /**
   * Catch-up for archive transitions missed while the daemon was down or while
   * archived eligibility was on. It reads the archived listing only when the
   * derived index still retains Sessions that could be affected, and it covers
   * that finite retained set completely: paging stops when nothing retained can
   * still be archived or when the listing is exhausted. It rejects when the
   * exclusion could not be completed, so the caller never advertises an
   * eligibility this daemon is not applying.
   */
  const reconcileArchivedExclusion = async (signal?: AbortSignal): Promise<void> => {
    if (!tier1) return;
    if (settings.includeArchivedSessions) return;
    const indexed = new Set(listIndexedSessionIds());
    if (indexed.size === 0) return;

    const archived = await collectRetainedSessionInventoryVisibility({
      retainedSessionIds: [...indexed], scopes: ['archived'], signal,
      fetchInventoryPage: args => fetchSessionInventoryPage({ ...args, token: params.credentials.token,
        limit: settings.worker.sessionListPageLimit }),
    });
    signal?.throwIfAborted();
    await removeSessions([...archived]);
  };

  /**
   * Applies the desired archived eligibility. Turning it off is only applied
   * once the complete exclusion succeeded; until then this daemon still serves
   * archived rows and keeps reporting archived-inclusive eligibility, and the
   * next settings application retries.
   */
  const applyArchivedEligibility = async (signal?: AbortSignal): Promise<void> => {
    if (settings.includeArchivedSessions) {
      archivedExclusionPending = false;
      return;
    }
    archivedExclusionPending = true;
    try {
      await reconcileArchivedExclusion(signal);
      archivedExclusionPending = false;
    } catch (error) {
      signal?.throwIfAborted();
      logger.debug('[memoryWorker] Archived exclusion reconciliation incomplete; retrying on the next settings application', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const fetchRecentDecryptedRows = async (sessionId: string, signal?: AbortSignal): Promise<DecryptedTranscriptRow[]> => {
    const cryptoContext = await resolveSessionCryptoContext(sessionId, signal);
    if (!cryptoContext) return [];
    const rawPageLimit = Math.max(1, Math.trunc(configuration.memoryMaxTranscriptWindowMessages));
    const rows: DecryptedTranscriptRow[] = [];
    let beforeSeq: number | undefined;
    const seenCursors = new Set<number>();
    const coverageCutoffMs = resolveMemoryCoverageCreatedAtCutoffMs({
      policy: settings.coveragePolicy,
      nowMs: Date.now(),
      enabledAtMs: settings.enabledAtMs,
    });
    const effectiveCutoffMs = settings.backfillPolicy === 'new_only'
      ? Math.max(coverageCutoffMs ?? 0, settings.enabledAtMs)
      : coverageCutoffMs;
    for (;;) {
      const page = await fetchMemorySemanticTranscriptPage({
        token: params.credentials.token,
        sessionId,
        contentContext: cryptoContext,
        limit: rawPageLimit,
        rawPageLimit,
        maxRawRowsToScan: rawPageLimit * 4,
        direction: 'before',
        ...(typeof beforeSeq === 'number' ? { beforeSeq } : {}),
        contentPolicy: settings.contentPolicy,
        ...(signal ? { signal } : {}),
      }).catch((error: unknown) => {
        signal?.throwIfAborted();
        logMemoryWorkerServerEndpointFailure('selected transcript rows', error);
        throw error;
      });
      for (const item of page.items) {
        rows.push({
          seq: item.seq,
          createdAtMs: item.createdAtMs,
          role: item.role === 'user' ? 'user' : 'agent',
          content: { type: 'text', text: item.text },
          meta: null,
        });
      }
      if (
        settings.coveragePolicy.type === 'latest_messages'
        && rows.length >= settings.coveragePolicy.maxSemanticMessagesPerSession
      ) break;
      if (effectiveCutoffMs !== null && page.items.some((item) => item.createdAtMs < effectiveCutoffMs)) break;
      if (!page.hasMore || !page.nextCursor) break;
      const nextBeforeSeq = Number.parseInt(page.nextCursor, 10);
      if (!Number.isFinite(nextBeforeSeq) || seenCursors.has(nextBeforeSeq)) break;
      seenCursors.add(nextBeforeSeq);
      beforeSeq = nextBeforeSeq;
    }
    return rows.sort((a, b) => a.seq - b.seq);
  };

  const syncHintsForSessions = async (
    sessionIds: readonly string[],
    options?: Readonly<{
      allowInitialBackfillWhenUninitializedSessionIds?: readonly string[];
      initialCursorSeqBySessionId?: ReadonlyMap<string, number>;
      forceSnapshotSessionIds?: readonly string[];
      signal?: AbortSignal;
    }>,
  ): Promise<void> => {
    if (stopped) return;
    if (!settings.enabled) return;
    if (!tier1) return;
    if (sessionIds.length === 0) return;

    for (const sessionId of sessionIds) hintWorkAtBySessionId.delete(sessionId);

    await syncMemoryHintsForSessionsOnce({
      sessionIds,
      forceSnapshotSessionIds: options?.forceSnapshotSessionIds,
      ...(options?.allowInitialBackfillWhenUninitializedSessionIds
        ? { allowInitialBackfillWhenUninitializedSessionIds: options.allowInitialBackfillWhenUninitializedSessionIds }
        : {}),
      initialCursorSeqBySessionId:
        options?.initialCursorSeqBySessionId ?? candidateObservedSeqBySessionId,
      tier1,
      settings: {
        enabled: settings.enabled,
        enabledAtMs: settings.enabledAtMs,
        indexMode: settings.indexMode,
        backfillPolicy: settings.backfillPolicy,
        hints: {
          enabled: settings.hints.enabled,
          updateMode: settings.hints.updateMode,
          idleDelayMs: settings.hints.idleDelayMs,
          windowSizeMessages: settings.hints.windowSizeMessages,
          maxShardChars: settings.hints.maxShardChars,
          maxSummaryChars: settings.hints.maxSummaryChars,
          maxKeywords: settings.hints.maxKeywords,
          maxEntities: settings.hints.maxEntities,
          maxDecisions: settings.hints.maxDecisions,
          maxRunsPerHour: settings.hints.maxRunsPerHour,
          maxShardsPerSession: settings.hints.maxShardsPerSession,
          failureBackoffBaseMs: settings.hints.failureBackoffBaseMs,
          failureBackoffMaxMs: settings.hints.failureBackoffMaxMs,
        },
        coveragePolicy: settings.coveragePolicy,
        contentPolicy: settings.contentPolicy,
      },
      now: () => Date.now(),
      fetchRecentDecryptedRows,
      onDeferred: atMs => {
        for (const sessionId of sessionIds) hintWorkAtBySessionId.set(sessionId,
          Math.min(hintWorkAtBySessionId.get(sessionId) ?? atMs, atMs));
      },
      runSummarizer: (prompt, sessionId, signal) => params.host.runHint({
        prompt, sessionId, backendId: settings.hints.summarizerBackendId,
        modelId: settings.hints.summarizerModelId, permissionMode: settings.hints.summarizerPermissionMode,
      }, signal),
      commitArtifacts: (request, signal) => params.host.commitHint(request, signal),
      ...(options?.signal ? { signal: options.signal } : {}),
    });
  };

  const syncDeepForSessions = async (sessionIds: readonly string[], signal?: AbortSignal, forceSnapshot = false,
    observedSnapshotSeqBySessionId?: ReadonlyMap<string, number>): Promise<ReadonlySet<string>> => {
    if (stopped || !settings.enabled || settings.indexMode !== 'deep' || !tier1 || !deep || sessionIds.length === 0) return new Set();

    const embeddings = resolveOperationalMemoryEmbeddingsSettings(settings.embeddings);
    const embeddingsResolution = await refreshEmbeddingsDiagnostics(signal);

    return await syncDeepIndexForSessionsOnce({
      sessionIds,
      tier1,
      deep,
      settings: {
        enabled: settings.enabled,
        enabledAtMs: settings.enabledAtMs,
        indexMode: 'deep',
        backfillPolicy: settings.backfillPolicy,
        deep: {
          maxChunkChars: settings.deep.maxChunkChars,
        maxChunkMessages: settings.deep.maxChunkMessages,
          minChunkMessages: settings.deep.minChunkMessages,
          includeAssistantAcpMessage: settings.deep.includeAssistantAcpMessage,
          failureBackoffBaseMs: settings.deep.failureBackoffBaseMs,
          failureBackoffMaxMs: settings.deep.failureBackoffMaxMs,
        },
        coveragePolicy: settings.coveragePolicy,
        contentPolicy: settings.deep.includeToolOutput
          ? { ...settings.contentPolicy, includeToolOutputs: true }
          : settings.contentPolicy,
        forceSnapshot,
        ...(embeddings ? { embeddings } : {}),
      },
      now: () => Date.now(),
      fetchDecryptedTranscriptPageAfterSeq: deps.fetchDecryptedTranscriptPageAfterSeq,
      fetchRecentDecryptedRows,
      observedSnapshotSeqBySessionId,
      ...(embeddingsResolution?.provider ? { embedDocuments: embeddingsResolution.provider.embedDocuments } : {}),
      ...(signal ? { signal } : {}),
    });
  };

  const syncEligibleSessions = async (input: Readonly<{
    sessionIds: readonly string[];
    indexingSessionIds: Set<string>;
    observedSeqBySessionId: ReadonlyMap<string, number>;
    allowInitialBackfillSessionIds: readonly string[];
    forcePolicySnapshot?: boolean;
    signal?: AbortSignal;
  }>): Promise<void> => {
    input.signal?.throwIfAborted();
    if (!tier1 || input.sessionIds.length === 0) return;
    const allowInitialBackfill = new Set(input.allowInitialBackfillSessionIds);
    const admittedSessionIds: string[] = [];

    const nowMs = Date.now();
    for (const sessionId of input.sessionIds) {
      if (settings.backfillPolicy === 'new_only' && !allowInitialBackfill.has(sessionId)) {
        const observedSeq = input.observedSeqBySessionId.get(sessionId);
        if (typeof observedSeq !== 'number' || !Number.isFinite(observedSeq)) continue;
        tier1.trySeedSessionCursorsIfMissing({
          sessionId,
          nowMs,
          lastHintedSeq: Math.max(0, Math.trunc(observedSeq)),
          lastDeepIndexedSeq: Math.max(0, Math.trunc(observedSeq)),
        });
      } else {
        // Establish the tier-1 retained identity before any deep chunk write.
        // Zero keeps historical backfill eligible while closing the deep-only
        // ordering window for newly admitted Sessions.
        tier1.trySeedSessionCursorsIfMissing({
          sessionId,
          nowMs,
          lastHintedSeq: 0,
          lastDeepIndexedSeq: 0,
        });
      }
      admittedSessionIds.push(sessionId);
    }

    if (admittedSessionIds.length === 0) return;
    for (const sessionId of admittedSessionIds) {
      const observed = input.observedSeqBySessionId.get(sessionId);
      if (observed !== undefined && candidateObservedSeqBySessionId.get(sessionId) !== observed) {
        candidateObservedSeqBySessionId.set(sessionId, observed);
        updateSessionPublication(sessionId, { observedSeq: observed });
      }
      // Considering a completed unchanged snapshot is a settled turn too.
      // Fresh children must not wait forever for intentionally skipped IO.
      attemptedSessionFrontiers.set(sessionId, tier1.getSessionCursors({ sessionId, nowMs }).lastDeepIndexedSeq);
    }

    const edited = admittedSessionIds.filter(sessionId => editedSessionIds.has(sessionId));
    const unchanged = admittedSessionIds.filter(sessionId => {
      if (editedSessionIds.has(sessionId)) return false;
      const observed = input.observedSeqBySessionId.get(sessionId);
      const status = tier1!.getMemorySessionIndexStatus(sessionId);
      // A completed full snapshot whose source has not advanced needs no body
      // IO. Revisions still use the dirty set; moving windows still prune.
      if (input.forcePolicySnapshot === true || settings.coveragePolicy.type !== 'full'
        || observed === undefined || (status !== 'indexed' && status !== 'empty')) return true;
      const cursors = tier1!.getSessionCursors({ sessionId, nowMs });
      return Math.max(cursors.lastDeepIndexedSeq, cursors.lastObservedSeq) < observed;
    });
    if (edited.length) {
      // The same admitted revision invalidates the inactive projection too;
      // switching modes must not revive bytes from before that revision.
      withRetainedIndexHandles(handles => {
        for (const sessionId of edited) {
          if (settings.indexMode === 'hints') {
            handles.deep?.deleteSessionIndexData({ sessionId });
            handles.tier1?.rewindSessionCursor({ sessionId, lane: 'deep', seq: 0 });
          } else {
            handles.tier1?.pruneSessionArtifacts({ sessionId,
              policyKey: `${memoryIndexPolicyKey(resolveTier1IndexPolicy(settings))}:edited` });
            handles.tier1?.rewindSessionCursor({ sessionId, lane: 'hints', seq: 0 });
          }
        }
      });
    }
    const selected = new Set(settings.indexMode === 'deep' ? [...unchanged, ...edited] : admittedSessionIds);
    // Admission alone is not transcript work. Remove checked snapshots before
    // yielding, and retire each completed Session before reading the next one.
    // A slow sibling must not reopen already established coverage.
    for (const sessionId of input.indexingSessionIds) {
      if (!selected.has(sessionId)) input.indexingSessionIds.delete(sessionId);
    }
    for (const sessionId of selected) {
      const isEdited = edited.includes(sessionId);
      // Consume only the revision this read owns. A later revision stays queued.
      if (isEdited) {
        editedSessionIds.delete(sessionId);
        updateSessionPublication(sessionId, { edited: false });
      }
      publishSnapshot();
      try {
        await syncHintsForSessions([sessionId], {
          forceSnapshotSessionIds: isEdited ? [sessionId] : [],
          allowInitialBackfillWhenUninitializedSessionIds: input.allowInitialBackfillSessionIds,
          initialCursorSeqBySessionId: input.observedSeqBySessionId,
          ...(input.signal ? { signal: input.signal } : {}),
        });
        const completed = await syncDeepForSessions([sessionId], input.signal,
          isEdited || input.forcePolicySnapshot === true, input.observedSeqBySessionId);
        if (isEdited && (settings.indexMode === 'deep' ? !completed.has(sessionId)
          : tier1.getSessionCursors({ sessionId, nowMs: Date.now() }).lastHintedSeq === 0)) editedSessionIds.add(sessionId);
      } catch (error) {
        if (isEdited) editedSessionIds.add(sessionId);
        throw error;
      } finally {
        if (isEdited && editedSessionIds.has(sessionId)) updateSessionPublication(sessionId, { edited: true });
        deadlinePublicationPending = true;
        input.indexingSessionIds.delete(sessionId);
        publishSnapshot();
      }
    }
  };

  const runTrackedSessionOperation = (input: Readonly<{
    sessionIds: readonly string[];
    signal?: AbortSignal;
  }>, run: (sessionIds: Set<string>, signal: AbortSignal) => Promise<void>): Promise<void> => {
    const sessionIds = input.sessionIds.filter((sessionId) => !removingSessionIds.has(sessionId));
    if (sessionIds.length === 0) return Promise.resolve();
    const included = new Set(sessionIds);
    const controller = new AbortController();
    const signal = input.signal
      ? AbortSignal.any([input.signal, controller.signal])
      : controller.signal;
    const operation: {
      kind: 'transcript';
      sessionIds: ReadonlySet<string>;
      controller: AbortController;
      promise: Promise<void>;
    } = {
      kind: 'transcript',
      sessionIds: included,
      controller,
      promise: Promise.resolve(),
    };
    operation.promise = Promise.resolve().then(() => {
      signal.throwIfAborted();
      return run(included, signal);
    }).catch((error) => {
      // Session removal owns this child cancellation. It is a successful
      // supersession, not a worker failure; lifecycle/transport cancellation
      // from the parent signal remains observable to its caller.
      if (controller.signal.aborted && input.signal?.aborted !== true) return;
      throw error;
    }).finally(() => {
      activeIndexOperations.delete(operation);
      publishSnapshot();
    });
    activeIndexOperations.add(operation);
    publishSnapshot();
    return operation.promise;
  };

  const runTrackedSyncEligibleSessions = (input: Readonly<{
    sessionIds: readonly string[];
    observedSeqBySessionId: ReadonlyMap<string, number>;
    allowInitialBackfillSessionIds: readonly string[];
    forcePolicySnapshot?: boolean;
    signal?: AbortSignal;
  }>): Promise<void> => runTrackedSessionOperation(input, (included, signal) => syncEligibleSessions({
    ...input, sessionIds: [...included], indexingSessionIds: included, signal,
    allowInitialBackfillSessionIds: input.allowInitialBackfillSessionIds.filter(id => included.has(id)),
  }));

  const applySettings = async (next: MemorySettingsV1, signal?: AbortSignal): Promise<void> => {
    signal?.throwIfAborted();
    const inheritedIndexesQualified = initialIndexesQualified;
    initialIndexesQualified = false;
    const previousSettings = settings;
    let tier1PolicyChanged = memoryIndexPolicyKey(resolveTier1IndexPolicy(previousSettings))
      !== memoryIndexPolicyKey(resolveTier1IndexPolicy(next));
    let deepPolicyChanged = memoryIndexPolicyKey(resolveDeepIndexPolicy(previousSettings))
      !== memoryIndexPolicyKey(resolveDeepIndexPolicy(next));
    let externalPolicyChanged = JSON.stringify(previousSettings.conversationSearch.indexExternal)
      !== JSON.stringify(next.conversationSearch.indexExternal);
    if (tier1PolicyChanged || deepPolicyChanged || externalPolicyChanged) {
      for (const operation of activeIndexOperations) operation.controller.abort();
      await Promise.allSettled([...activeIndexOperations].map((operation) => operation.promise));
      signal?.throwIfAborted();
    }
    if (JSON.stringify(settings.embeddings) !== JSON.stringify(next.embeddings)) {
      embeddingsProviderCache.clear();
    }
    settings = next;
    if (externalPolicyChanged) externalSourcesNeedRefresh = true;
    if (stopped) return;

    if (!settings.enabled) {
      indexesQualified = false;
      embeddingsProviderCache.clear();
      embeddingsDiagnostics = buildUnavailableMemoryEmbeddingsDiagnostics(settings.embeddings);
      // Nothing is searchable while memory is disabled, so no exclusion is
      // outstanding.
      archivedExclusionPending = false;
      await stopLoop();
      await externalSources.refresh(await params.host.readExternalSources(true, signal ?? new AbortController().signal), settings, signal ?? new AbortController().signal);
      for (const operation of activeIndexOperations) operation.controller.abort();
      await Promise.allSettled([...activeIndexOperations].map((operation) => operation.promise));
      if (tier1) {
        try {
          tier1.close();
        } catch {
          // best-effort
        }
        tier1 = null;
      }
      if (deep) {
        try {
          deep.close();
        } catch {
          // best-effort
        }
        deep = null;
      }
      workerStatus = {
        ...workerStatus,
        state: 'disabled',
        currentSessionId: null,
        currentPhase: null,
      };
      effectiveSettings = settings;
      publicationAdmitted = true;
      inventoryPublicationPending = true;
      externalPublicationPending = true;
      qualificationPublicationPending = true;
      publishSnapshot();
      return;
    }

    embeddingsDiagnostics = buildUnavailableMemoryEmbeddingsDiagnostics(settings.embeddings);
    workerStatus = { ...workerStatus, state: 'idle' };
    publishSnapshot();

    await timeWebLatencyPhase('memory.startup.indexDirectory',
      () => ensureProtectedLocalStateDirectory(paths.memoryDir, { authority: 'owned' }));
    ensurePrivateInferenceDirectory(paths.modelsDir);

    if (
      inventoryBackfillPolicy !== settings.backfillPolicy
      || inventoryIncludeArchivedSessions !== settings.includeArchivedSessions
    ) {
      inventoryBackfillPolicy = settings.backfillPolicy;
      inventoryIncludeArchivedSessions = settings.includeArchivedSessions;
      inventoryState = INITIAL_MEMORY_INVENTORY_STATE;
      inventorySeenSessionIds.clear();
      candidateSessionIds = [];
      candidateCursor = 0;
      candidateAllowInitialBackfillSessionIds.clear();
      candidateObservedSeqBySessionId.clear();
    }

    if (!tier1) {
      indexesQualified = false;
      tier1 = openSummaryShardIndexDb({ dbPath: paths.tier1DbPath });
      tier1.init();
    }

    // Attached documents share this index even when Session transcripts use hints.
    if (!deep) {
      indexesQualified = false;
      deep = openDeepIndexDb({ dbPath: paths.deepDbPath });
      deep.init();
    }
    if (!settings.conversationSearch.indexExternal.enabled
      || settings.conversationSearch.indexExternal.agents.length === 0) {
      // This is source release only. Discovery/backfill remains on the loop,
      // but opting out must drain observation demands before it completes.
      await externalSources.refresh(await params.host.readExternalSources(true, signal ?? new AbortController().signal), settings, signal ?? new AbortController().signal);
    }
    const policyKeys = {
      tier1: memoryIndexPolicyKey(resolveTier1IndexPolicy(settings)),
      deep: memoryIndexPolicyKey(resolveDeepIndexPolicy(settings)),
      external: JSON.stringify(settings.conversationSearch.indexExternal),
    };
    const retainedPolicyKeys = tier1.getIndexPolicyKeys();
    // A settled same-policy child inherits the daemon's current access decision,
    // not authority to qualify a reset or a differently scoped retained index.
    const inheritsQualification = inheritedIndexesQualified && retainedPolicyKeys !== null
      && retainedPolicyKeys.tier1 === policyKeys.tier1
      && retainedPolicyKeys.deep === policyKeys.deep
      && retainedPolicyKeys.external === policyKeys.external;
    // Row provenance preserves matching older indexes. Only cursor-only
    // progress lacks a previous policy; rewind it once when adopting the index.
    tier1PolicyChanged = retainedPolicyKeys !== null && retainedPolicyKeys.tier1 !== policyKeys.tier1;
    deepPolicyChanged = retainedPolicyKeys !== null && retainedPolicyKeys.deep !== policyKeys.deep;
    externalPolicyChanged = retainedPolicyKeys !== null && retainedPolicyKeys.external !== policyKeys.external;
    if (!retainedPolicyKeys) {
      const externalPolicy = resolveExternalMemoryIndexPolicy(settings).key;
      const externalIds = new Set<string>();
      for (const retained of deep.listExternalSourceStates()) {
        externalIds.add(retained.sessionId);
        if (!settings.conversationSearch.indexExternal.enabled
          || !settings.conversationSearch.indexExternal.agents.includes(retained.source.agentId)
          || deep.hasSessionArtifactsOutsidePolicy({ sessionId: retained.sessionId, policyKey: externalPolicy })) {
          deep.deleteSessionIndexData({ sessionId: retained.sessionId });
        }
      }
      const deepSessionIds = new Set(deep.listIndexedSessionIds());
      for (const sessionId of new Set([...tier1.listIndexedSessionIds(), ...deepSessionIds])) {
        if (externalIds.has(sessionId)) continue;
        const hintsPruned = tier1.pruneSessionArtifacts({ sessionId, policyKey: policyKeys.tier1 });
        const deepPruned = deep.pruneSessionArtifacts({ sessionId, policyKey: policyKeys.deep });
        // With no rows, progress cannot prove that newly admitted historical
        // content was searched. Matching rows themselves remain in place.
        if (hintsPruned || tier1.getLatestShardSeqTo({ sessionId }) === 0) {
          tier1.rewindSessionCursor({ sessionId, lane: 'hints', seq: 0 });
        }
        if (deepPruned || !deepSessionIds.has(sessionId)) {
          tier1.rewindSessionCursor({ sessionId, lane: 'deep', seq: 0 });
        }
      }
    }
    if (previousSettings.indexMode !== settings.indexMode) indexesQualified = false;
    if ((externalPolicyChanged || tier1PolicyChanged || deepPolicyChanged) && deep) {
      for (const retained of deep.listExternalSourceStates()) deep.deleteSessionIndexData({ sessionId: retained.sessionId });
      externalSourcesNeedRefresh = true;
      externalPublicationPending = true;
    }
    if (tier1PolicyChanged || deepPolicyChanged) {
      const retainedSessionIds = [...new Set([
        ...tier1.listIndexedSessionIds(),
        ...(deepPolicyChanged ? deep.listIndexedSessionIds() : []),
      ])];
      for (const sessionId of retainedSessionIds) {
        // Invalidate before any fallible source IO. Rebuild through the existing
        // inventory/work loop (or explicit ensureUpToDate), never settings RPCs.
        if (tier1PolicyChanged) tier1.deleteSessionIndexData({ sessionId });
        else tier1.rewindSessionCursor({ sessionId, lane: 'deep', seq: 0 });
        if (deepPolicyChanged) deep.deleteSessionIndexData({ sessionId });
        tier1.trySeedSessionCursorsIfMissing({ sessionId, nowMs: Date.now(), lastHintedSeq: 0, lastDeepIndexedSeq: 0 });
      }
    }
    if (!retainedPolicyKeys || tier1PolicyChanged || deepPolicyChanged || externalPolicyChanged) {
      tier1.setIndexPolicyKeys(policyKeys);
    }
    if (inheritsQualification) indexesQualified = true;
    if (!indexesQualified) {
      try {
        // Existing rows must be requalified before the daemon exposes its
        // opened index, including after an offline handoff or an older cache.
        await timeWebLatencyPhase('memory.startup.retainedAccess', () => reconcileRetainedSessionAccess(signal));
        indexesQualified = true;
      } catch (error) {
        signal?.throwIfAborted();
        // Keep the worker/RPCs alive, but do not expose unqualified content.
        // A later explicit reconciliation/inventory demand retries this owner.
        workerStatus = { ...workerStatus, state: 'error' };
        publicationAdmitted = true;
        qualificationPublicationPending = true;
        publishSnapshot();
        logger.debug('[memoryWorker] Retained access qualification failed; awaiting reconciliation demand', {
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Provider resolution shares initialization through the worker-owned cache.
    // Daemon RPC registration and settings responses must not wait for downloads.
    void refreshEmbeddingsDiagnostics().catch((error: unknown) => {
      if (stopped || settings !== next) return;
      const message = error instanceof Error ? error.message : String(error);
      embeddingsDiagnostics = { ...embeddingsDiagnostics, runtimeState: 'error', usingFallback: true, lastError: message };
      logger.warn('[memoryWorker] Embeddings initialization failed; using keyword-search fallback', { message });
      publishSnapshot();
    });
    if (!inheritsQualification) await timeWebLatencyPhase('memory.startup.archiveExclusion', () => applyArchivedEligibility(signal));

    effectiveSettings = settings;
    publicationAdmitted = true;
    qualificationPublicationPending = true;
    publishSnapshot();

  };

  const applySessionObservations = async (
    observations: readonly MemorySessionInventoryObservation[],
    signal?: AbortSignal,
    indexingSessionIds?: Set<string>,
  ): Promise<void> => {
    const observedSeqBySessionId = new Map<string, number>();
    const allowInitialBackfillSessionIds: string[] = [];
    const excludedSessionIds: string[] = [];
    // Admission precedes the first await: another admitted command may tick in
    // this same child, but must not mistake an addressed source for cold inventory.
    for (const { sessionId, eligibility } of observations) {
      if (!eligibility) {
        excludedSessionIds.push(sessionId);
        continue;
      }
      if (removingSessionIds.has(sessionId)) continue;
      if (!candidateSessionIds.includes(sessionId)) {
        candidateSessionIds.push(sessionId);
        updateSessionPublication(sessionId, { candidate: true });
      }
      candidateObservedSeqBySessionId.set(sessionId, eligibility.observedSeq);
      updateSessionPublication(sessionId, { observedSeq: eligibility.observedSeq });
      attemptedSessionFrontiers.delete(sessionId);
      observedSeqBySessionId.set(sessionId, eligibility.observedSeq);
      if (eligibility.allowInitialBackfill) {
        candidateAllowInitialBackfillSessionIds.add(sessionId);
        allowInitialBackfillSessionIds.push(sessionId);
      } else {
        candidateAllowInitialBackfillSessionIds.delete(sessionId);
      }
    }
    if (observedSeqBySessionId.size === 0) {
      await removeSessions(excludedSessionIds);
      return;
    }
    const sync = async (included: Set<string>, operationSignal: AbortSignal) => {
      await removeSessions(excludedSessionIds);
      operationSignal.throwIfAborted();
      // An addressed admission cannot qualify unrelated retained rows after a
      // failed bootstrap reconciliation. Keep that existing owner fail closed.
      if (!indexesQualified) return;
      const sessionIds = [...observedSeqBySessionId.keys()].filter(id => included.has(id));
      await observeSessions(sessionIds, operationSignal);
      operationSignal.throwIfAborted();
      await syncEligibleSessions({ sessionIds, indexingSessionIds: included, observedSeqBySessionId,
        allowInitialBackfillSessionIds, signal: operationSignal });
    };
    if (indexingSessionIds) await sync(indexingSessionIds, signal ?? new AbortController().signal);
    else await runTrackedSessionOperation({ sessionIds: [...observedSeqBySessionId.keys()], signal }, sync);
  };

  const inventory = async (signal: AbortSignal, observations?: readonly MemorySessionInventoryObservation[]): Promise<void> => {
    schedulerAdmitted = true;
    if (stopped) return;
    if (!settings.enabled) return;
    signal.throwIfAborted();
    if (observations !== undefined) {
      await applySessionObservations(observations, signal);
      return;
    }
    attemptedSessionFrontiers.clear();
    if (!indexesQualified) {
      await reconcileRetainedSessionAccess(signal);
      indexesQualified = true;
      qualificationPublicationPending = true;
    }
    externalSourcesNeedRefresh = true;
    externalSources.invalidate();
    const reportsInventory = workerStatus.state !== 'indexing';
    if (reportsInventory) {
      workerStatus = { ...workerStatus, state: 'inventorying', lastInventoryAtMs: Date.now(), currentPhase: 'inventory' };
    publishSnapshot();
    }
    await applyArchivedEligibility(signal);
    await refreshInventory({ signal });
    // Document search/status and explicit refresh already admit current
    // attachments on demand. Transcript inventory must not prepare every
    // Session's prompts again when no document consumer is waiting.
    signal.throwIfAborted();
    if (reportsInventory && workerStatus.currentPhase === 'inventory') {
      workerStatus = { ...workerStatus, state: 'idle', currentPhase: null };
    publishSnapshot();
    }
  };

  const tick = async (signal: AbortSignal, initializeInventory = true): Promise<void> => {
    schedulerAdmitted = true;
    if (stopped) return;
    if (!settings.enabled) return;
    if (!tier1) return;
    if (!indexesQualified) return;
    signal.throwIfAborted();
    // A deadline can start a new process, whose in-memory inventory is empty.
    // Explicit refresh already admits its addressed Session without a full scan.
    // Only an actual tick demand admits cold full inventory. An addressed
    // command's settlement may still have native work after its last Session
    // was removed; that continuation is not a whole-Account inventory demand.
    if (initializeInventory && !inventoryAdmitted && candidateSessionIds.length === 0) await inventory(signal);
    if (candidateSessionIds.length > 0 || settings.conversationSearch.indexExternal.enabled) {
      workerStatus = { ...workerStatus, state: 'indexing', lastTickAtMs: Date.now(), currentPhase: 'tick' };
    publishSnapshot();
    }
    const maxSessions = Math.max(1, Math.trunc(settings.worker.maxSessionsPerTick));
    await runMemoryWorkerSourcesTick({ sessionIds: candidateSessionIds,
      externalSourceCount: externalSources.getReadySourceCount(), cursor: candidateCursor, maxSessions,
      signal, advanceCursor: next => { candidateCursor = next; },
      prepareExternalSources: async () => {
        // Native readiness consumes no transcript allowance and a
        // failure must not suppress selected Happier source work.
        await syncExternalSources(signal, 0);
        return externalSources.getReadySourceCount();
      },
      syncExternalSources: maxSources => syncExternalSources(signal, maxSources),
      syncSessions: async sessionIds => {
        workerStatus = { ...workerStatus, currentSessionId: sessionIds[0] ?? null };
    publishSnapshot();
        const observedSeqBySessionId = new Map<string, number>();
        for (const sessionId of sessionIds) {
          const observedSeq = candidateObservedSeqBySessionId.get(sessionId);
          if (observedSeq !== undefined) observedSeqBySessionId.set(sessionId, observedSeq);
        }
        await runTrackedSyncEligibleSessions({
          sessionIds,
          observedSeqBySessionId,
          allowInitialBackfillSessionIds: sessionIds.filter(id => candidateAllowInitialBackfillSessionIds.has(id)),
          signal,
        });
      },
      finishTick: async () => {
        if (!tier1) return;
        workerStatus = { ...workerStatus, state: 'indexing', currentSessionId: null, currentPhase: 'budget' };
    publishSnapshot();
        const mbToBytes = (mb: number): number => Math.max(0, Math.trunc(mb)) * 1024 * 1024;
        await enforceMemoryDiskBudgets({
          tier1,
          deep,
          tier1DbPath: paths.tier1DbPath,
          deepDbPath: paths.deepDbPath,
          budgets: {
            tier1Bytes: mbToBytes(settings.budgets.maxDiskMbLight),
            deepBytes: mbToBytes(settings.budgets.maxDiskMbDeep),
          },
        });
        signal.throwIfAborted();
      },
    });
    workerStatus = { ...workerStatus, state: 'idle', currentSessionId: null, currentPhase: null };
    publishSnapshot();
  };

  const syncExternalSourcesOnce = async (signal: AbortSignal, maxSources: number): Promise<void> => {
    await externalSources.refresh(await params.host.readExternalSources(externalSourcesNeedRefresh, signal), settings, signal);
    externalSourcesNeedRefresh = false;
    if (!settings.enabled || !settings.conversationSearch.indexExternal.enabled || !deep || !tier1) return;
    const inventory = await externalSources.inventory(signal);
    if (inventory) {
      externalPublicationPending = true;
      deadlinePublicationPending = true;
      for (const retained of deep.listExternalSourceStates()) {
        const key = JSON.stringify([retained.source.agentId, retained.source.sourceKey]);
        if (!inventory.configuredSourceKeys.has(key)
          || (inventory.completeSources.has(key) && !inventory.current.has(retained.sessionId))) deep.deleteSessionIndexData({ sessionId: retained.sessionId });
      }
    }
    if (maxSources === 0) return;
    const embeddings = resolveOperationalMemoryEmbeddingsSettings(settings.embeddings);
    const resolution = embeddings?.enabled ? await refreshEmbeddingsDiagnostics(signal) : null;
    await syncExternalMemoryTranscriptsBatch({ candidates: externalSources.take(maxSources), db: deep, tier1, settings, nowMs: Date.now(), signal,
        onSourceResult: (source, state, failure) => {
          externalSources.noteSyncResult(source, state, failure);
          externalPublicationPending = true;
          deadlinePublicationPending = true;
        },
        ...(resolution?.provider ? { embedDocuments: resolution.provider.embedDocuments } : {}),
        ...(embeddings?.enabled && embeddings.providerKind && embeddings.modelId
          ? { embeddings: { providerKind: embeddings.providerKind, modelId: embeddings.modelId } } : {}) });
  };

  const syncExternalSources = async (signal: AbortSignal, maxSources = Math.max(1, Math.trunc(settings.worker.maxSessionsPerTick))): Promise<void> => {
    if (stopped || !settings.enabled || !deep) return;
    if (externalSyncPromise) return await externalSyncPromise;
    const controller = new AbortController();
    const operationSignal = AbortSignal.any([signal, controller.signal]);
    const promise = Promise.resolve().then(() => {
      operationSignal.throwIfAborted();
      return syncExternalSourcesOnce(operationSignal, maxSources);
    });
    const operation = { kind: 'transcript' as const, sessionIds: new Set<string>(), controller, promise };
    activeIndexOperations.add(operation);
    externalSyncPromise = promise;
    publishSnapshot();
    try { await promise; }
    finally {
      activeIndexOperations.delete(operation);
      externalSyncPromise = null;
      publishSnapshot();
    }
  };

  const ensureUpToDate = async (_sessionId?: string, signal?: AbortSignal): Promise<void> => {
    schedulerAdmitted = true;
    signal?.throwIfAborted();
    if (stopped) return;
    if (!settings.enabled) return;
    if (!tier1) return;
    if (_sessionId) {
      let excluded = false;
      // Removal must own the complete exact operation, including authorized
      // reads and observer transport, not just its eventual transcript writes.
      await runTrackedSessionOperation({ sessionIds: [_sessionId], signal }, async (included, operationSignal) => {
        embeddingsResolutionEpoch = null;
        await refreshEmbeddingsDiagnostics(operationSignal);
        operationSignal.throwIfAborted();
        const session = await fetchSessionById({ reason: 'memory-change', token: params.credentials.token, sessionId: _sessionId, signal: operationSignal });
        const accountEncryptionMode = (await readRequesterAccountEncryptionCurrentness({ token: params.credentials.token, signal: operationSignal })).mode;
        operationSignal.throwIfAborted();
        const eligibility = session && sessionLocality.isOnMachine(session, accountEncryptionMode)
          ? resolveMemoryInventorySessionEligibility({ session, backfillPolicy: settings.backfillPolicy,
            includeArchivedSessions: settings.includeArchivedSessions, enabledAtMs: settings.enabledAtMs ?? 0, nowMs: Date.now() })
          : null;
        if (!eligibility) { excluded = true; return; }
        await applySessionObservations([{ sessionId: _sessionId, eligibility }], operationSignal, included);
      });
      // Do not make an operation join its own removal. An ineligible read owns
      // no writes, and purging starts only after this operation drains.
      if (excluded) await removeSessions([_sessionId]);
      return;
    }
    // Explicit refresh is a deliberate retry boundary, unlike a background
    // scheduler turn or an unchanged settings read.
    embeddingsResolutionEpoch = null;
    await refreshEmbeddingsDiagnostics(signal);
    externalSources.retryIncompleteInventory();
    await syncExternalSources(signal ?? new AbortController().signal);
    // Same eligibility/inventory owner as the background loop, so an
    // explicit refresh can never inventory a scope the settings exclude.
    const refresh = await refreshInventory({ ...(signal ? { signal } : {}) });
    if (refresh.sessionIds.length === 0) return;
    await runTrackedSyncEligibleSessions({
      sessionIds: refresh.sessionIds,
      observedSeqBySessionId: refresh.observedSeqBySessionId,
      allowInitialBackfillSessionIds: refresh.allowInitialBackfillSessionIds,
      ...(signal ? { signal } : {}),
    });
  };

  const handle: MemoryIndexerEngine = {
    stop,
    applySettings,
    inventory,
    tick,
    awaitModelInitialization: async () => { await embeddingsResolutionEpoch?.promise.catch(() => {}); },
    runUntilSettled: async signal => {
      if (!schedulerAdmitted) return;
      while (!stopped && settings.enabled && tier1 && indexesQualified) {
        signal.throwIfAborted();
        for (const sessionId of [...editedSessionIds]) {
          const observedSeq = candidateObservedSeqBySessionId.get(sessionId);
          // A transcript revision changes no eligibility input (seq, owner locality, archive,
          // access): the admission already supplied for this Session stays current, and its own
          // carriers (worker re-read without the locality proof, removal, archive) replace it.
          // Only a Session without a held admission re-reads its source.
          if (candidateSessionIds.includes(sessionId) && observedSeq !== undefined) {
            await runTrackedSessionOperation({ sessionIds: [sessionId], signal }, async (included, operationSignal) => {
              await applySessionObservations([{ sessionId, eligibility: { sessionId, observedSeq,
                allowInitialBackfill: candidateAllowInitialBackfillSessionIds.has(sessionId) } }], operationSignal, included);
            });
            continue;
          }
          await ensureUpToDate(sessionId, signal);
        }
        if (inventoryAdmitted && settings.backfillPolicy !== 'new_only'
          && (inventoryState.active.hasNext || (settings.includeArchivedSessions && inventoryState.archived.hasNext))) {
          await refreshInventory({ signal });
        }
        const pending = [...new Set([...candidateSessionIds, ...candidateObservedSeqBySessionId.keys()])].some(sessionId => {
          const cursors = tier1!.getSessionCursors({ sessionId, nowMs: Date.now(), readOnly: true });
          const hintAtMs = hintWorkAtBySessionId.get(sessionId);
          if (hintAtMs !== undefined && hintAtMs <= Date.now()) return true;
          if (cursors.nextDeepEligibleAtMs > Date.now()) return false;
          const attempted = attemptedSessionFrontiers.get(sessionId);
          if (attempted === undefined) return true;
          if (settings.indexMode !== 'deep') return false;
          const observed = candidateObservedSeqBySessionId.get(sessionId) ?? 0;
          return cursors.lastDeepIndexedSeq !== attempted
            && Math.max(cursors.lastDeepIndexedSeq, cursors.lastObservedSeq) < observed;
        });
        const moreInventory = inventoryAdmitted && settings.backfillPolicy !== 'new_only'
          && (inventoryState.active.hasNext || (settings.includeArchivedSessions && inventoryState.archived.hasNext));
        if (!pending && !externalSources.hasPendingWork() && !moreInventory) break;
        await tick(signal, false);
      }
    },
    indexDocuments: async (update, signal) => {
      signal?.throwIfAborted();
      if (stopped || !settings.enabled || !deep) throw new Error('memory_document_scope_changed');
      for (const document of update.documents) deep.replaceDocumentIndexData(document);
      if (update.prune) deep.pruneDocumentIndexData({ eligibleDocuments: update.documents });
    },
    retryEmbeddings: async signal => { embeddingsResolutionEpoch = null; await refreshEmbeddingsDiagnostics(signal); },
    ensureUpToDate,
    noteSessionTranscriptRevised: async ({ sessionId }) => {
      if (stopped) return;
      // Inventory/access admission remains the scope authority. Unindexed
      // Sessions read their current source when first admitted normally.
      if (!candidateSessionIds.includes(sessionId) && !listIndexedSessionIds().includes(sessionId)) return;
      editedSessionIds.add(sessionId);
      updateSessionPublication(sessionId, { edited: true });
      schedulerAdmitted = true;
      publishSnapshot();
    },
    readExternalTranscriptPage: async (request, signal) => {
      const operationSignal = signal ?? new AbortController().signal;
      await externalSources.refresh(await params.host.readExternalSources(externalSourcesNeedRefresh, operationSignal), settings, operationSignal);
      externalSourcesNeedRefresh = false;
      return await externalSources.readPage(request, settings, operationSignal);
    },
    removeSessions,
    reconcileRetainedSessionAccess,
    applySessionArchivedState,
    resolveEmbeddingsProvider: refreshEmbeddingsDiagnostics,
  };
  const publishSnapshot = () => {
    // A new process has no admitted inventory. Its bootstrap status must not
    // replace the daemon's retained, qualified facts for the same policy.
    if (!publicationAdmitted) return;
    const includeInventory = inventoryPublicationPending;
    const includeExternal = externalPublicationPending;
    const includeQualification = qualificationPublicationPending;
    const includeDeadline = deadlinePublicationPending && schedulerAdmitted;
    const updates = [...sessionPublicationUpdates.values()];
    const removed = [...removedPublicationSessionIds];
    inventoryPublicationPending = false;
    externalPublicationPending = false;
    qualificationPublicationPending = false;
    deadlinePublicationPending = false;
    sessionPublicationUpdates.clear();
    removedPublicationSessionIds.clear();
    params.host.publish({
    settings: archivedExclusionPending ? { ...effectiveSettings, includeArchivedSessions: true } : effectiveSettings,
    embeddings: embeddingsDiagnostics,
    worker: { ...workerStatus, activeOperations: [...activeIndexOperations]
      .map(operation => ({ kind: operation.kind, sessionIds: [...operation.sessionIds] })) },
    ...(includeQualification ? { indexesQualified } : {}),
    ...(includeInventory ? { candidateSessionIds: [...candidateSessionIds], observedSeqBySessionId: [...candidateObservedSeqBySessionId],
      editedSessionIds: [...editedSessionIds] } : updates.length ? { sessionUpdates: updates } : {}),
    ...(removed.length ? { removedSessionIds: removed } : {}),
    ...(includeExternal ? { externalSources: externalSources.getIndexSources(indexesQualified ? deep : null) } : {}),
    ...(includeDeadline ? { nextWorkAtMs: (() => {
      let next: number | null = null;
      for (const atMs of hintWorkAtBySessionId.values()) if (atMs > Date.now()) next = Math.min(next ?? atMs, atMs);
      // Retained failures outside this run's inventory/policy are not work.
      // In particular, disabling native opt-in must retire its retry deadlines.
      for (const ids of [candidateSessionIds, externalSources.sourceIds()]) {
        for (const sessionId of ids) {
          const atMs = tier1?.getSessionCursors({ sessionId, nowMs: Date.now(), readOnly: true }).nextDeepEligibleAtMs ?? 0;
          if (atMs > Date.now()) next = Math.min(next ?? atMs, atMs);
        }
      }
      return next;
    })() } : {}),
    });
  };
  return handle;
}

