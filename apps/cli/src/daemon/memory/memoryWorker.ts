import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';

import { INSTALLABLE_KEYS } from '@happier-dev/protocol/installables/codexAcp';
import type { SessionSummaryShardV1 } from '@happier-dev/protocol';

import type { StoredCredentials } from '@/persistence';
import { DEFAULT_MEMORY_SETTINGS, readMemorySettingsFromDisk, type MemorySettingsV1 } from '@/settings/memorySettings';
import { configuration } from '@/configuration';
import { subscribeOptionalRuntimeInstallSuccess } from '@/packagedRuntime/installables/optionalRuntimes';
import {
  subscribeActiveAccountSettingsSnapshot,
} from '@/settings/accountSettings/activeAccountSettingsSnapshot';

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
import { startSingleFlightIntervalLoop, type SingleFlightIntervalLoopHandle } from '@/daemon/lifecycle/singleFlightIntervalLoop';
import {
  collectRetainedSessionInventoryVisibility,
  fetchSessionInventoryPage,
} from '@/daemon/sessions/sessionInventoryVisibility';
import { syncMemoryHintsForSessionsOnce } from './syncMemoryHintsForSessionsOnce';
import { runMemoryHintsExecutionRun } from './hints/runMemoryHintsExecutionRun';
import { commitMemorySystemRecords } from '@/session/systemRecords/memory/commitMemorySystemRecords';
import { fetchMemorySummaryShardSystemRecords } from '@/session/systemRecords/memory/fetchMemorySystemRecords';
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
import { isLegacyUnclassifiedTranscriptRow } from './transcript/legacyUnclassifiedTranscriptRows';
import { AccountEncryptionMaterialUnavailableError } from '@/api/client/encryptionKey';
import { ensureProtectedLocalStateDirectory } from '@/utils/fs/protectedLocalState';
import {
  memoryIndexPolicyKey,
  resolveMemoryCoverageCreatedAtCutoffMs,
  resolveMemoryIndexPolicy,
} from './transcript/coveragePolicy';

export type MemoryWorkerHandle = Readonly<{
  stop: () => void | Promise<void>;
  reloadSettings: (signal?: AbortSignal) => Promise<void>;
  ensureUpToDate: (sessionId?: string, signal?: AbortSignal) => Promise<void>;
  /**
   * The memory-owner removal operation for Sessions that were deleted, whose
   * access was revoked, or that are no longer eligible. It clears the derived
   * indexes and every worker-local candidate/observed/backfill/crypto fact.
   * It rejects when the purge fails so a caller consuming a durable change
   * fact never acknowledges its cursor before the removal succeeded.
   */
  removeSessions: (sessionIds: readonly string[]) => Promise<void>;
  /** Re-checks the finite retained set after the Account changes cursor is lost. */
  reconcileRetainedSessionAccess: () => Promise<void>;
  /**
   * Every Session identity the derived index still retains. Consumers of a
   * durable access reset reconcile exactly this finite set against current
   * Account access, including while memory is disabled and the long-lived DB
   * handles are closed.
   */
  listIndexedSessionIds: () => readonly string[];
  /** Live archive-state transition from the incumbent Session update seam. */
  applySessionArchivedState: (
    change: Readonly<{ sessionId: string; archived: boolean }>,
  ) => Promise<void>;
  getSettings: () => MemorySettingsV1;
  getEmbeddingsDiagnostics: () => OperationalMemoryEmbeddingsDiagnostics;
  resolveEmbeddingsProvider?: (signal?: AbortSignal) => Promise<EmbeddingsProviderResolution | null>;
  getWorkerStatus: () => Readonly<{
    state: 'disabled' | 'idle' | 'inventorying' | 'indexing' | 'waiting' | 'backoff' | 'error';
    lastTickAtMs: number | null;
    lastInventoryAtMs: number | null;
    currentSessionId: string | null;
    currentPhase: string | null;
  }>;
  getTier1DbPath: () => string | null;
  getDeepDbPath: () => string | null;
  getTier1DbPhysicalPath?: () => string;
  getDeepDbPhysicalPath?: () => string;
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

export async function startMemoryWorker(params: Readonly<{
  credentials: StoredCredentials;
  machineId: string;
  env?: NodeJS.ProcessEnv;
  deps?: Readonly<{
    fetchDecryptedTranscriptPageAfterSeq: (args: Readonly<{ sessionId: string; afterSeq: number; limit: number; signal?: AbortSignal }>) => Promise<DecryptedTranscriptRow[]>;
    fetchCommittedSummaryShards?: (sessionId: string, signal?: AbortSignal) => Promise<SessionSummaryShardV1[]>;
  }>;
}>): Promise<MemoryWorkerHandle> {
  let stopped = false;
  const paths = resolveMemoryIndexPaths();
  let settings: MemorySettingsV1 = DEFAULT_MEMORY_SETTINGS;
  let effectiveSettings: MemorySettingsV1 = DEFAULT_MEMORY_SETTINGS;
  let tier1: SummaryShardIndexDbHandle | null = null;
  let deep: DeepIndexDbHandle | null = null;
  let inventoryLoop: SingleFlightIntervalLoopHandle | null = null;
  let inventoryLoopIntervalMs: number | null = null;
  let workLoop: SingleFlightIntervalLoopHandle | null = null;
  let workLoopIntervalMs: number | null = null;
  let candidateSessionIds: string[] = [];
  let candidateCursor = 0;
  const candidateAllowInitialBackfillSessionIds = new Set<string>();
  let inventoryState: MemoryInventoryState = INITIAL_MEMORY_INVENTORY_STATE;
  let inventoryBackfillPolicy: MemorySettingsV1['backfillPolicy'] = 'new_only';
  let inventoryIncludeArchivedSessions = DEFAULT_MEMORY_SETTINGS.includeArchivedSessions;
  /**
   * True while archived eligibility is desired off but the exclusion has not
   * been completed, so archived rows can still be searchable here.
   */
  let archivedExclusionPending = false;
  const inventorySeenSessionIds = new Set<string>();
  const candidateObservedSeqBySessionId = new Map<string, number>();
  const sessionCryptoContextCache = new Map<string, SessionStoredContentCryptoContext>();
  const settingsSecretsReadKeys = deriveSettingsSecretsReadKeysForCredentials(params.credentials);
  const embeddingsProviderCache = createEmbeddingsProviderCache();
  let embeddingsResolutionEpoch: Readonly<{
    settings: MemorySettingsV1;
    promise: Promise<EmbeddingsProviderResolution | null>;
  }> | null = null;
  let unsubscribeOptionalRuntimeInstallSuccess = () => {};
  let unsubscribeAccountSettingsSnapshot = () => {};
  let embeddingsDiagnostics: OperationalMemoryEmbeddingsDiagnostics =
    buildUnavailableMemoryEmbeddingsDiagnostics(DEFAULT_MEMORY_SETTINGS.embeddings);
  let workerStatus: ReturnType<MemoryWorkerHandle['getWorkerStatus']> = {
    state: 'idle',
    lastTickAtMs: null,
    lastInventoryAtMs: null,
    currentSessionId: null,
    currentPhase: null,
  };
  const activeIndexOperations = new Set<Readonly<{
    sessionIds: ReadonlySet<string>;
    controller: AbortController;
    promise: Promise<void>;
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

    const raw = await fetchSessionById({ token: params.credentials.token, sessionId, signal });
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
    return resolution;
  };

  const refreshEmbeddingsDiagnostics = (
    signal?: AbortSignal,
  ): Promise<EmbeddingsProviderResolution | null> => {
    const requestedSettings = settings;
    // A loaded memory-settings object is one provider-resolution epoch. Periodic
    // indexing reuses its settled failure; explicit use/reload and owner events
    // below are the deliberate retry boundaries.
    if (embeddingsResolutionEpoch?.settings !== requestedSettings) {
      embeddingsResolutionEpoch = {
        settings: requestedSettings,
        promise: resolveEmbeddingsDiagnosticsForSettings(requestedSettings),
      };
    }
    return awaitEmbeddingsResolutionEpoch(embeddingsResolutionEpoch.promise, signal);
  };

  const retryEmbeddingsAfterExternalStateChange = (failureMessage: string): void => {
    if (stopped) return;
    embeddingsResolutionEpoch = null;
    void refreshEmbeddingsDiagnostics().catch((error: unknown) => {
      if (stopped) return;
      logger.warn(failureMessage, {
        message: error instanceof Error ? error.message : String(error),
      });
    });
  };

  unsubscribeAccountSettingsSnapshot = subscribeActiveAccountSettingsSnapshot((previous, next) => {
    if (!settings.enabled) return;
    if (resolveOperationalMemoryEmbeddingsSettings(settings.embeddings)?.providerKind !== 'local_transformers') return;
    // Saved-secret catalog and Connected Services projection publications reuse
    // the incumbent settings object. Only the actual settings/source cut forms
    // a provider retry boundary.
    if (previous?.source === next?.source && previous?.settings === next?.settings) return;
    retryEmbeddingsAfterExternalStateChange('[memoryWorker] Embeddings initialization after account-settings refresh failed');
  });

  unsubscribeOptionalRuntimeInstallSuccess = subscribeOptionalRuntimeInstallSuccess((key) => {
    if (key !== INSTALLABLE_KEYS.LOCAL_EMBEDDINGS || stopped) return;
    if (!settings.enabled) return;
    if (resolveOperationalMemoryEmbeddingsSettings(settings.embeddings)?.providerKind !== 'local_transformers') return;
    retryEmbeddingsAfterExternalStateChange('[memoryWorker] Embeddings initialization after runtime installation failed');
  });

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
          const legacy = await fetchEncryptedTranscriptMessagesPage({
            token: params.credentials.token,
            sessionId: args.sessionId,
            afterSeq: args.afterSeq,
            limit: args.limit,
            scope: 'main',
            ...(args.signal ? { signal: args.signal } : {}),
          });
          args.signal?.throwIfAborted();

          return decryptTranscriptRows({
            // The whole crypto context, not just the key: memory ingests only rows
            // the Session's established mode can authenticate.
            crypto: cryptoContext,
            rows: [
              ...roleFiltered.messages,
              ...legacy.messages.filter(isLegacyUnclassifiedTranscriptRow),
            ],
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
    const inventoryLoopToStop = inventoryLoop;
    inventoryLoop = null;
    inventoryLoopIntervalMs = null;
    const workLoopToStop = workLoop;
    workLoop = null;
    workLoopIntervalMs = null;
    candidateSessionIds = [];
    candidateCursor = 0;
    candidateAllowInitialBackfillSessionIds.clear();
    candidateObservedSeqBySessionId.clear();
    inventoryState = INITIAL_MEMORY_INVENTORY_STATE;
    inventoryBackfillPolicy = 'new_only';
    inventoryIncludeArchivedSessions = DEFAULT_MEMORY_SETTINGS.includeArchivedSessions;
    inventorySeenSessionIds.clear();
    await Promise.all([
      inventoryLoopToStop?.stop(),
      workLoopToStop?.stop(),
    ]);
  };

  const stop = (): Promise<void> => {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      stopped = true;
      await stopLoop();
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
      unsubscribeOptionalRuntimeInstallSuccess();
      unsubscribeAccountSettingsSnapshot();
    })();
    return stopPromise;
  };

  const fetchMemoryInventoryPage = async (args: Readonly<{
    scope: MemoryInventoryScope;
    cursor?: string;
    limit: number;
    signal?: AbortSignal;
  }>): Promise<MemoryInventoryPage> => {
    return await fetchSessionInventoryPage({
      token: params.credentials.token,
      ...(args.cursor === undefined ? {} : { cursor: args.cursor }),
      scope: args.scope,
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

  /**
   * The one eligibility/inventory pass every policy and `ensureUpToDate` use.
   * `apply` replaces the candidate set for the snapshot policy and extends it
   * while paging, so no branch can inventory a scope the settings exclude.
   */
  const refreshInventory = async (options?: Readonly<{ apply?: boolean; signal?: AbortSignal }>): Promise<MemoryInventoryRefresh> => {
    const refresh = await refreshMemoryInventoryOnce({
      backfillPolicy: settings.backfillPolicy,
      includeArchivedSessions: settings.includeArchivedSessions,
      enabledAtMs: settings.enabledAtMs ?? 0,
      pageLimit: settings.worker.sessionListPageLimit,
      nowMs: Date.now(),
      state: inventoryState,
      seenSessionIds: inventorySeenSessionIds,
      fetchSessionsPage: fetchMemoryInventoryPage,
      ...(options?.signal ? { signal: options.signal } : {}),
    });
    options?.signal?.throwIfAborted();

    if (options?.apply === false) return refresh;

    if (refresh.mode === 'snapshot') {
      candidateAllowInitialBackfillSessionIds.clear();
      candidateObservedSeqBySessionId.clear();
      inventorySeenSessionIds.clear();
      candidateSessionIds = [...refresh.sessionIds];
      candidateCursor = 0;
      for (const [sessionId, seq] of refresh.observedSeqBySessionId) {
        candidateObservedSeqBySessionId.set(sessionId, seq);
      }
      for (const sessionId of refresh.allowInitialBackfillSessionIds) {
        candidateAllowInitialBackfillSessionIds.add(sessionId);
      }
    } else {
      candidateAllowInitialBackfillSessionIds.clear();
      for (const sessionId of refresh.sessionIds) {
        inventorySeenSessionIds.add(sessionId);
        candidateObservedSeqBySessionId.set(sessionId, refresh.observedSeqBySessionId.get(sessionId) ?? 0);
        candidateSessionIds.push(sessionId);
      }
    }

    inventoryState = refresh.state;
    inventoryBackfillPolicy = settings.backfillPolicy;
    inventoryIncludeArchivedSessions = settings.includeArchivedSessions;
    return refresh;
  };

  const forgetWorkerSessionState = (sessionIds: readonly string[]): void => {
    const doomed = new Set(sessionIds);
    if (doomed.size === 0) return;
    candidateSessionIds = candidateSessionIds.filter((id) => !doomed.has(id));
    candidateCursor = candidateSessionIds.length === 0
      ? 0
      : candidateCursor % candidateSessionIds.length;
    for (const sessionId of doomed) {
      candidateAllowInitialBackfillSessionIds.delete(sessionId);
      candidateObservedSeqBySessionId.delete(sessionId);
      inventorySeenSessionIds.delete(sessionId);
      sessionCryptoContextCache.delete(sessionId);
    }
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
    const loopToResume = workLoop;
    loopToResume?.pause();
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
      if (!stopped && settings.enabled && workLoop === loopToResume) loopToResume?.resume();
    }
  };

  const listIndexedSessionIds = (): readonly string[] => {
    return withRetainedIndexHandles((handles) => {
      const retained = new Set<string>();
      for (const sessionId of handles.tier1?.listIndexedSessionIds() ?? []) retained.add(sessionId);
      for (const sessionId of handles.deep?.listIndexedSessionIds() ?? []) retained.add(sessionId);
      return [...retained];
    });
  };

  const reconcileRetainedSessionAccess = async (): Promise<void> => {
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
      }),
    });
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

    let cursor: string | undefined;
    for (;;) {
      signal?.throwIfAborted();
      const result = await fetchMemoryInventoryPage({
        scope: 'archived',
        ...(cursor === undefined ? {} : { cursor }),
        limit: settings.worker.sessionListPageLimit,
        ...(signal ? { signal } : {}),
      });
      signal?.throwIfAborted();
      const doomed = result.sessions
        .map((session) => (typeof (session as { id?: unknown }).id === 'string'
          ? String((session as { id?: unknown }).id).trim()
          : ''))
        .filter((sessionId) => sessionId.length > 0 && indexed.has(sessionId));
      if (doomed.length > 0) {
        await removeSessions(doomed);
        for (const sessionId of doomed) indexed.delete(sessionId);
      }
      if (indexed.size === 0) return;
      if (!result.hasNext || !result.nextCursor) return;
      if (result.nextCursor === cursor) {
        // A listing that cannot advance leaves the retained set undecided.
        throw new Error('memory_archived_reconciliation_cursor_stalled');
      }
      cursor = result.nextCursor;
    }
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
      signal?: AbortSignal;
    }>,
  ): Promise<void> => {
    if (stopped) return;
    if (!settings.enabled) return;
    if (!tier1) return;
    if (sessionIds.length === 0) return;

    await syncMemoryHintsForSessionsOnce({
      sessionIds,
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
      fetchCommittedSummaryShards,
      runSummarizer: async (prompt, sessionId, signal) => {
        return await runMemoryHintsExecutionRun({
          cwd: configuration.activeServerDir,
          sessionId,
          backendId: settings.hints.summarizerBackendId,
          modelId: settings.hints.summarizerModelId,
          permissionMode: settings.hints.summarizerPermissionMode,
          prompt,
          credentials: params.credentials,
          ...(signal ? { signal } : {}),
        });
      },
      commitArtifacts: async ({ sessionId, shardPayload, synopsisPayload }, signal) => {
        const cryptoContext = await resolveSessionCryptoContext(sessionId, signal);
        if (!cryptoContext) return;
        await commitMemorySystemRecords({
          credentials: params.credentials,
          sessionId,
          mode: cryptoContext.mode,
          ...(cryptoContext.ctx ? { ctx: cryptoContext.ctx } : {}),
          shard: { sessionId, payload: shardPayload },
          synopsis: synopsisPayload ? { sessionId, payload: synopsisPayload } : null,
          ...(signal ? { signal } : {}),
        });
      },
      ...(options?.signal ? { signal: options.signal } : {}),
    });
  };

  const fetchCommittedSummaryShards = async (sessionId: string, signal?: AbortSignal): Promise<SessionSummaryShardV1[]> => {
    signal?.throwIfAborted();
    if (deps.fetchCommittedSummaryShards) {
      return await deps.fetchCommittedSummaryShards(sessionId, signal);
    }
    try {
      const cryptoContext = await resolveSessionCryptoContext(sessionId, signal);
      if (!cryptoContext) return [];
      const shards = await fetchMemorySummaryShardSystemRecords({
        token: params.credentials.token,
        sessionId,
        mode: cryptoContext.mode,
        ...(cryptoContext.ctx ? { ctx: cryptoContext.ctx } : {}),
        ...(signal ? { signal } : {}),
      });
      signal?.throwIfAborted();
      return shards;
    } catch (error) {
      if (!(error instanceof AccountEncryptionMaterialUnavailableError)) {
        logMemoryWorkerServerEndpointFailure('summary system records', error);
      }
      throw error;
    }
  };

  const ingestCommittedSummaryShards = async (sessionId: string, signal?: AbortSignal): Promise<void> => {
    if (!tier1) return;
    const nowMs = Date.now();
    const memoryPolicy = resolveDeepIndexPolicy(settings);
    const policyKey = memoryIndexPolicyKey(memoryPolicy);
    for (const shard of await fetchCommittedSummaryShards(sessionId, signal)) {
      signal?.throwIfAborted();
      if (!shard.memoryPolicy || memoryIndexPolicyKey(shard.memoryPolicy) !== policyKey) continue;
      tier1.insertSummaryShard({
        sessionId,
        seqFrom: shard.seqFrom,
        seqTo: shard.seqTo,
        createdAtFromMs: shard.createdAtFromMs,
        createdAtToMs: shard.createdAtToMs,
        summary: shard.summary,
        keywords: shard.keywords ?? [],
        entities: shard.entities ?? [],
        decisions: shard.decisions ?? [],
        policyKey,
      });
      tier1.markHintRunSuccess({ sessionId, seqTo: shard.seqTo, nowMs });
    }
  };

  const syncDeepForSessions = async (sessionIds: readonly string[], signal?: AbortSignal, forceSnapshot = false): Promise<void> => {
    if (stopped) return;
    if (!settings.enabled) return;
    if (settings.indexMode !== 'deep') return;
    if (!tier1) return;
    if (!deep) return;
    if (sessionIds.length === 0) return;

    const embeddings = resolveOperationalMemoryEmbeddingsSettings(settings.embeddings);
    const embeddingsResolution = await refreshEmbeddingsDiagnostics(signal);

    await syncDeepIndexForSessionsOnce({
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
      ...(embeddingsResolution?.provider ? { embedDocuments: embeddingsResolution.provider.embedDocuments } : {}),
      ...(signal ? { signal } : {}),
    });
  };

  const syncEligibleSessions = async (input: Readonly<{
    sessionIds: readonly string[];
    observedSeqBySessionId: ReadonlyMap<string, number>;
    allowInitialBackfillSessionIds: readonly string[];
    forcePolicySnapshot?: boolean;
    signal?: AbortSignal;
  }>): Promise<void> => {
    input.signal?.throwIfAborted();
    if (!tier1 || input.sessionIds.length === 0) return;
    const allowInitialBackfill = new Set(input.allowInitialBackfillSessionIds);
    const historicalContentBlocked = new Set<string>();
    const admittedSessionIds: string[] = [];

    const nowMs = Date.now();
    for (const sessionId of input.sessionIds) {
      if (settings.backfillPolicy === 'new_only' && !allowInitialBackfill.has(sessionId)) {
        const observedSeq = input.observedSeqBySessionId.get(sessionId);
        if (typeof observedSeq !== 'number' || !Number.isFinite(observedSeq)) continue;
        const seeded = tier1.trySeedSessionCursorsIfMissing({
          sessionId,
          nowMs,
          lastHintedSeq: Math.max(0, Math.trunc(observedSeq)),
          lastDeepIndexedSeq: Math.max(0, Math.trunc(observedSeq)),
        });
        if (seeded) historicalContentBlocked.add(sessionId);
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

    await syncHintsForSessions(admittedSessionIds, {
      allowInitialBackfillWhenUninitializedSessionIds: input.allowInitialBackfillSessionIds,
      initialCursorSeqBySessionId: input.observedSeqBySessionId,
      ...(input.signal ? { signal: input.signal } : {}),
    });

    // Hints mode ingests committed summaries itself. Deep mode retains that
    // useful tier-1 projection, but only after the same eligibility decision
    // has established whether historical content is allowed.
    if (settings.indexMode === 'deep') {
      for (const sessionId of admittedSessionIds) {
        if (!historicalContentBlocked.has(sessionId)) {
          await ingestCommittedSummaryShards(sessionId, input.signal);
        }
      }
    }
    await syncDeepForSessions(admittedSessionIds, input.signal, input.forcePolicySnapshot === true);
  };

  const runTrackedSyncEligibleSessions = (input: Readonly<{
    sessionIds: readonly string[];
    observedSeqBySessionId: ReadonlyMap<string, number>;
    allowInitialBackfillSessionIds: readonly string[];
    forcePolicySnapshot?: boolean;
    signal?: AbortSignal;
  }>): Promise<void> => {
    const sessionIds = input.sessionIds.filter((sessionId) => !removingSessionIds.has(sessionId));
    if (sessionIds.length === 0) return Promise.resolve();
    const included = new Set(sessionIds);
    const controller = new AbortController();
    const signal = input.signal
      ? AbortSignal.any([input.signal, controller.signal])
      : controller.signal;
    const operation: {
      sessionIds: ReadonlySet<string>;
      controller: AbortController;
      promise: Promise<void>;
    } = {
      sessionIds: included,
      controller,
      promise: Promise.resolve(),
    };
    operation.promise = syncEligibleSessions({
      ...input,
      sessionIds,
      signal,
      allowInitialBackfillSessionIds: input.allowInitialBackfillSessionIds.filter((id) => included.has(id)),
      ...(input.forcePolicySnapshot === true ? { forcePolicySnapshot: true } : {}),
    }).catch((error) => {
      // Session removal owns this child cancellation. It is a successful
      // supersession, not a worker failure; lifecycle/transport cancellation
      // from the parent signal remains observable to its caller.
      if (controller.signal.aborted && input.signal?.aborted !== true) return;
      throw error;
    }).finally(() => {
      activeIndexOperations.delete(operation);
    });
    activeIndexOperations.add(operation);
    return operation.promise;
  };

  const applySettings = async (next: MemorySettingsV1, signal?: AbortSignal): Promise<void> => {
    signal?.throwIfAborted();
    const previousSettings = settings;
    const tier1PolicyChanged = memoryIndexPolicyKey(resolveTier1IndexPolicy(previousSettings))
      !== memoryIndexPolicyKey(resolveTier1IndexPolicy(next));
    const deepPolicyChanged = memoryIndexPolicyKey(resolveDeepIndexPolicy(previousSettings))
      !== memoryIndexPolicyKey(resolveDeepIndexPolicy(next));
    const policyChanged = tier1PolicyChanged || deepPolicyChanged;
    if (policyChanged) {
      for (const operation of activeIndexOperations) operation.controller.abort();
      await Promise.allSettled([...activeIndexOperations].map((operation) => operation.promise));
      signal?.throwIfAborted();
    }
    if (JSON.stringify(settings.embeddings) !== JSON.stringify(next.embeddings)) {
      embeddingsProviderCache.clear();
    }
    settings = next;
    if (stopped) return;

    if (!settings.enabled) {
      embeddingsProviderCache.clear();
      embeddingsDiagnostics = buildUnavailableMemoryEmbeddingsDiagnostics(settings.embeddings);
      // Nothing is searchable while memory is disabled, so no exclusion is
      // outstanding.
      archivedExclusionPending = false;
      await stopLoop();
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
      if (settings.deleteOnDisable) {
        try {
          await rm(paths.memoryDir, { recursive: true, force: true });
        } catch (error) {
          workerStatus = {
            ...workerStatus,
            state: 'error',
            currentSessionId: null,
            currentPhase: null,
          };
          throw error;
        }
      }
      workerStatus = {
        ...workerStatus,
        state: 'disabled',
        currentSessionId: null,
        currentPhase: null,
      };
      effectiveSettings = settings;
      return;
    }

    embeddingsDiagnostics = buildUnavailableMemoryEmbeddingsDiagnostics(settings.embeddings);
    workerStatus = { ...workerStatus, state: 'idle' };

    await ensureProtectedLocalStateDirectory(paths.memoryDir, { authority: 'owned' });
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
      tier1 = openSummaryShardIndexDb({ dbPath: paths.tier1DbPath });
      tier1.init();
    }

    if (deepPolicyChanged && !deep && existsSync(paths.deepDbPath)) {
      deep = openDeepIndexDb({ dbPath: paths.deepDbPath });
      deep.init();
    }

    if (settings.indexMode === 'deep') {
      if (!deep) {
        deep = openDeepIndexDb({ dbPath: paths.deepDbPath });
        deep.init();
      }
    } else if (deep && !deepPolicyChanged) {
      try {
        deep.close();
      } catch {
        // best-effort
      }
      deep = null;
    }

    // Provider resolution shares initialization through the worker-owned cache.
    // Daemon RPC registration and settings responses must not wait for downloads.
    void refreshEmbeddingsDiagnostics().catch((error: unknown) => {
      if (stopped || settings !== next) return;
      const message = error instanceof Error ? error.message : String(error);
      embeddingsDiagnostics = { ...embeddingsDiagnostics, runtimeState: 'error', usingFallback: true, lastError: message };
      logger.warn('[memoryWorker] Embeddings initialization failed; using keyword-search fallback', { message });
    });
    await applyArchivedEligibility(signal);

    if (policyChanged && tier1) {
      const retainedSessionIds = [...new Set([
        ...(tier1PolicyChanged || deepPolicyChanged ? tier1.listIndexedSessionIds() : []),
        ...(deepPolicyChanged ? (deep?.listIndexedSessionIds() ?? []) : []),
      ])];
      if (retainedSessionIds.length > 0) {
        try {
          for (const sessionId of retainedSessionIds) {
            // Policy transitions fail closed: remove every old-policy byte and
            // progress cursor before any fallible reconstruction work.
            if (tier1PolicyChanged) tier1.deleteSessionIndexData({ sessionId });
            else if (deepPolicyChanged) tier1.rewindSessionCursor({ sessionId, lane: 'deep', seq: 0 });
            if (deepPolicyChanged) deep?.deleteSessionIndexData({ sessionId });
          }
          if (tier1PolicyChanged || (settings.indexMode === 'deep' && deepPolicyChanged)) {
            await syncEligibleSessions({
              sessionIds: retainedSessionIds,
              observedSeqBySessionId: new Map(),
              allowInitialBackfillSessionIds: retainedSessionIds,
              forcePolicySnapshot: true,
              ...(signal ? { signal } : {}),
            });
          }
        } catch (error) {
          for (const sessionId of retainedSessionIds) {
            if (tier1PolicyChanged) tier1.deleteSessionIndexData({ sessionId });
            if (deepPolicyChanged) deep?.deleteSessionIndexData({ sessionId });
          }
          effectiveSettings = settings;
          workerStatus = { ...workerStatus, state: 'error', currentSessionId: null, currentPhase: null };
          throw error;
        }
      }
    }
    if (settings.indexMode !== 'deep' && deep) {
      try {
        deep.close();
      } catch {
        // best-effort
      }
      deep = null;
    }
    effectiveSettings = settings;

    // Background indexing runs only in daemon mode.
    if (configuration.isDaemonProcess) {
      const inventoryIntervalMs = Math.max(5_000, Math.trunc(settings.worker.inventoryRefreshIntervalMs));
      if (!inventoryLoop || inventoryLoopIntervalMs !== inventoryIntervalMs) {
        await inventoryLoop?.stop();
        inventoryLoopIntervalMs = inventoryIntervalMs;
        inventoryLoop = startSingleFlightIntervalLoop({
          intervalMs: inventoryIntervalMs,
          task: async (signal) => {
            if (stopped) return;
            if (!settings.enabled) return;
            signal.throwIfAborted();
            const reportsInventory = workerStatus.state !== 'indexing';
            if (reportsInventory) {
              workerStatus = { ...workerStatus, state: 'inventorying', lastInventoryAtMs: Date.now(), currentPhase: 'inventory' };
            }
            if (archivedExclusionPending) await applyArchivedEligibility(signal);
            await refreshInventory({ signal });
            signal.throwIfAborted();
            if (reportsInventory && workerStatus.currentPhase === 'inventory') {
              workerStatus = { ...workerStatus, state: 'idle', currentPhase: null };
            }
          },
          onError: (error) => {
            if (workerStatus.currentPhase === 'inventory') {
              workerStatus = { ...workerStatus, state: 'error', currentSessionId: null, currentPhase: null };
            }
            logger.debug('[memoryWorker] Inventory refresh failed (best-effort)', {
              message: error instanceof Error ? error.message : String(error),
            });
          },
        });
        inventoryLoop.trigger();
      }

      const tickIntervalMs = Math.max(500, Math.trunc(settings.worker.tickIntervalMs));
      if (!workLoop || workLoopIntervalMs !== tickIntervalMs) {
        await workLoop?.stop();
        workLoopIntervalMs = tickIntervalMs;
        workLoop = startSingleFlightIntervalLoop({
          intervalMs: tickIntervalMs,
          task: async (signal) => {
            if (stopped) return;
            if (!settings.enabled) return;
            if (!tier1) return;
            signal.throwIfAborted();
            if (candidateSessionIds.length > 0) {
              workerStatus = { ...workerStatus, state: 'indexing', lastTickAtMs: Date.now(), currentPhase: 'tick' };

              const maxSessions = Math.max(1, Math.trunc(settings.worker.maxSessionsPerTick));
              const sessionIds: string[] = [];
              const allowInitialBackfillWhenUninitializedSessionIds: string[] = [];
              for (let i = 0; i < maxSessions; i += 1) {
                if (candidateSessionIds.length === 0) break;
                const idx = candidateCursor % candidateSessionIds.length;
                const id = candidateSessionIds[idx];
                candidateCursor = (candidateCursor + 1) % candidateSessionIds.length;
                if (!id) continue;
                sessionIds.push(id);
                if (candidateAllowInitialBackfillSessionIds.has(id)) {
                  allowInitialBackfillWhenUninitializedSessionIds.push(id);
                }
              }

              if (sessionIds.length > 0) {
                workerStatus = { ...workerStatus, currentSessionId: sessionIds[0] ?? null };
                const observedSeqBySessionId = new Map<string, number>();
                for (const sessionId of sessionIds) {
                  const observedSeq = candidateObservedSeqBySessionId.get(sessionId);
                  if (observedSeq !== undefined) observedSeqBySessionId.set(sessionId, observedSeq);
                }
                await runTrackedSyncEligibleSessions({
                  sessionIds,
                  observedSeqBySessionId,
                  allowInitialBackfillSessionIds: allowInitialBackfillWhenUninitializedSessionIds,
                  signal,
                });
              }
            }

            if (tier1) {
              workerStatus = { ...workerStatus, state: 'indexing', currentSessionId: null, currentPhase: 'budget' };
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
            }
            workerStatus = { ...workerStatus, state: 'idle', currentSessionId: null, currentPhase: null };
          },
          onError: (error) => {
            workerStatus = { ...workerStatus, state: 'error', currentSessionId: null, currentPhase: null };
            logger.debug('[memoryWorker] Tick failed (best-effort)', {
              message: error instanceof Error ? error.message : String(error),
            });
          },
        });
        workLoop.trigger();
      }
    }
  };

  const reloadSettings = async (signal?: AbortSignal): Promise<void> => {
    signal?.throwIfAborted();
    if (stopped) return;
    const next = await readMemorySettingsFromDisk();
    signal?.throwIfAborted();
    await applySettings(next, signal);
  };

  const ensureUpToDate = async (_sessionId?: string, signal?: AbortSignal): Promise<void> => {
    signal?.throwIfAborted();
    if (stopped) return;
    await reloadSettings(signal);
    signal?.throwIfAborted();
    if (!settings.enabled) return;
    if (!tier1) return;
    if (!_sessionId) {
      // Same eligibility/inventory owner as the background loop, so an
      // explicit refresh can never inventory a scope the settings exclude.
      const refresh = await refreshInventory({ apply: false, ...(signal ? { signal } : {}) });
      if (refresh.sessionIds.length === 0) return;
      await runTrackedSyncEligibleSessions({
        sessionIds: refresh.sessionIds,
        observedSeqBySessionId: refresh.observedSeqBySessionId,
        allowInitialBackfillSessionIds: refresh.allowInitialBackfillSessionIds,
        ...(signal ? { signal } : {}),
      });
      return;
    }

    const session = await fetchSessionById({
      token: params.credentials.token,
      sessionId: _sessionId,
      ...(signal ? { signal } : {}),
    });
    const eligibility = session
      ? resolveMemoryInventorySessionEligibility({
          session,
          backfillPolicy: settings.backfillPolicy,
          includeArchivedSessions: settings.includeArchivedSessions,
          enabledAtMs: settings.enabledAtMs ?? 0,
          nowMs: Date.now(),
        })
      : null;
    if (!eligibility) {
      await removeSessions([_sessionId]);
      return;
    }

    await runTrackedSyncEligibleSessions({
      sessionIds: [eligibility.sessionId],
      observedSeqBySessionId: new Map([[eligibility.sessionId, eligibility.observedSeq]]),
      allowInitialBackfillSessionIds: eligibility.allowInitialBackfill
        ? [eligibility.sessionId]
        : [],
      ...(signal ? { signal } : {}),
    });
  };

  await reloadSettings();

  return {
    stop,
    reloadSettings,
    ensureUpToDate,
    removeSessions,
    reconcileRetainedSessionAccess,
    applySessionArchivedState,
    listIndexedSessionIds,
    // The archived eligibility this daemon actually applies: an exclusion that
    // has not completed still leaves archived rows searchable here.
    getSettings: () => (
      archivedExclusionPending
        ? { ...effectiveSettings, includeArchivedSessions: true }
        : effectiveSettings
    ),
    getEmbeddingsDiagnostics: () => embeddingsDiagnostics,
    resolveEmbeddingsProvider: refreshEmbeddingsDiagnostics,
    getWorkerStatus: () => workerStatus,
    getTier1DbPath: () => (tier1 ? paths.tier1DbPath : null),
    getDeepDbPath: () => (deep ? paths.deepDbPath : null),
    getTier1DbPhysicalPath: () => paths.tier1DbPath,
    getDeepDbPhysicalPath: () => paths.deepDbPath,
  };
}
