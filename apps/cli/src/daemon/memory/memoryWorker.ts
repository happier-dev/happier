import { existsSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentExternalSessionsTranscriptPage } from '@happier-dev/plugin-sdk/sessions/external';
import type { MemoryExternalTranscriptSourceV1, MemorySearchQueryV1 } from '@happier-dev/protocol/memory/memorySearch';
import type { MemoryIndexSourceStatusV1, MemoryWorkerStatusV1 } from '@happier-dev/protocol/memory/memoryStatus';
import { INSTALLABLE_KEYS } from '@happier-dev/protocol/installables/keys';

import { configuration } from '@/configuration';
import type { StoredCredentials } from '@/persistence';
import type { DecryptedTranscriptRow } from '@/session/replay/decryptTranscriptRows';
import { DEFAULT_MEMORY_SETTINGS, readMemorySettingsFromDisk, type MemorySettingsV1 } from '@/settings/memorySettings';
import { subscribeOptionalRuntimeInstallSuccess } from '@/packagedRuntime/installables/optionalRuntimes';
import { startSingleFlightIntervalLoop, type SingleFlightIntervalLoopHandle } from '@/daemon/lifecycle/singleFlightIntervalLoop';
import { resolveSessionEncryptionContextFromCredentials, resolveSessionStoredContentEncryptionMode } from '@/session/transport/encryption/sessionEncryptionContext';
import { fetchSessionById } from '@/session/transport/http/sessionsHttp';
import { SESSION_DETAIL_RUNTIME_SNAPSHOT_PROJECTION } from '@happier-dev/protocol/sessions/control/contract';
import { fetchEncryptedTranscriptMessagesPage } from '@/session/replay/fetchEncryptedTranscriptMessages';
import { AccountEncryptionMaterialUnavailableError } from '@/api/client/encryptionKey';
import { readRequesterAccountEncryptionCurrentness, waitForObservation } from '@/api/client/accountEncryptionCurrentnessObservation';
import { collectRetainedSessionInventoryVisibility, fetchSessionInventoryPage } from '@/daemon/sessions/sessionInventoryVisibility';
import { commitMemorySystemRecords } from '@/session/systemRecords/memory/commitMemorySystemRecords';
import { readCliProjectPromptStackContext } from '@/agent/prompting/coding/sessionProjectPromptStack';
import { ensureProtectedLocalStateDirectory } from '@/utils/fs/protectedLocalState';
import { logger } from '@/ui/logger';
import { timeWebLatencyPhase } from '@/daemon/externalActions/webLatencyTrace';
import { writeJsonAtomic } from '@/utils/fs/writeJsonAtomic';

import { resolveMemoryIndexPaths } from './memoryIndexPaths';
import { openSummaryShardIndexReader, type SummaryShardIndexReader } from './summaryShardIndexDb';
import { openDeepIndexReader, type DeepIndexReader } from './deepIndex/deepIndexDb';
import { createMemoryExternalTranscriptObservation, type MemoryExternalObservation } from './externalTranscriptObservation';
import { isExternalMemoryStorageId } from './externalTranscriptIndex';
import { buildUnavailableMemoryEmbeddingsDiagnostics, type OperationalMemoryEmbeddingsDiagnostics } from './resolveOperationalMemoryEmbeddingsSettings';
import { syncMemoryDocuments, type MemoryDocumentSearchScope } from './syncMemoryDocuments';
import { runMemoryHintsExecutionRun } from './hints/runMemoryHintsExecutionRun';
import type { ConnectMemoryIndexer, MemoryIndexerConnection, MemoryIndexerHost, MemoryIndexerSnapshot, MemorySessionInventoryObservation } from './memoryIndexerBoundary';
import { applyMemoryIndexerPublication } from './memoryIndexerBoundary';
import { isMemorySessionOnMachine, resolveMemoryInventorySessionEligibility } from './inventory/refreshMemoryInventory';

export type MemoryWorkerHandle = Readonly<{
  /** Joins the incumbent settings admission, including initial process policy. */
  waitForReady: (signal?: AbortSignal) => Promise<void>;
  stop: () => void | Promise<void>;
  reloadSettings: (signal?: AbortSignal) => Promise<void>;
  /** Clears derived indexes and progress without changing saved settings or the model-cache policy. */
  clearIndex: (signal?: AbortSignal) => Promise<void>;
  ensureUpToDate: (sessionId?: string, signal?: AbortSignal) => Promise<void>;
  /** Exact authorized changes arrive through the incumbent Account carrier. */
  /** `memoryInputsChanged: false` is the change feed's proof that no eligibility input moved. */
  noteSessionChanged?: (change: Readonly<{ sessionId: string; memoryInputsChanged?: false;
    /** Facts the consumed Account change row carries (see `SessionChangeNotification.pushed`). */
    pushed?: Readonly<{ transcriptSeq?: number; localityUnchanged?: true }> }>) => Promise<void>;
  /** Transcript revisions arrive through the incumbent durable Account change stream. */
  noteSessionTranscriptRevised?: (change: Readonly<{ sessionId: string; seq: number; messageId?: string }>) => Promise<void>;
  attachExternalObservation?: (observation: MemoryExternalObservation) => () => void;
  readExternalTranscriptPage?: (request: Readonly<{ source: MemoryExternalTranscriptSourceV1; cursor?: string }>, signal?: AbortSignal) => Promise<AgentExternalSessionsTranscriptPage | null>;
  /** Fresh attachment admission; omitted by legacy/unsupported worker implementations. */
  resolveDocumentSearchScope?: (scope: MemorySearchQueryV1['scope'], signal?: AbortSignal) => Promise<MemoryDocumentSearchScope>;
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
  embedQuery?: (text: string, signal?: AbortSignal) => Promise<Float32Array | null>;
  getWorkerStatus: () => MemoryWorkerStatusV1;
  getTier1DbPath: () => string | null;
  getIndexSources?: () => readonly MemoryIndexSourceStatusV1[];
  getDeepDbPath: () => string | null;
  getTier1DbPhysicalPath?: () => string;
  getDeepDbPhysicalPath?: () => string;
}>;


/** Daemon policy, wake sources and read projection. Index writes belong to the connection. */
export async function prepareMemoryWorker(params: Readonly<{
  credentials: StoredCredentials;
  machineId: string;
  env?: NodeJS.ProcessEnv;
  deps?: Readonly<{
    fetchDecryptedTranscriptPageAfterSeq?: (args: Readonly<{ sessionId: string; afterSeq: number; limit: number; signal?: AbortSignal }>) => Promise<DecryptedTranscriptRow[]>;
    connectIndexer?: ConnectMemoryIndexer;
  }>;
}>): Promise<MemoryWorkerHandle> {
  const paths = resolveMemoryIndexPaths();
  let stopped = false;
  let desired = DEFAULT_MEMORY_SETTINGS;
  let snapshot: MemoryIndexerSnapshot = {
    // This private projection is not readable by product RPCs until admission.
    settings: DEFAULT_MEMORY_SETTINGS, embeddings: buildUnavailableMemoryEmbeddingsDiagnostics(DEFAULT_MEMORY_SETTINGS.embeddings),
    worker: { state: 'indexing', lastTickAtMs: null, lastInventoryAtMs: null, currentSessionId: null, currentPhase: null },
    indexesQualified: false, candidateSessionIds: [], observedSeqBySessionId: [], editedSessionIds: [], externalSources: [],
  };
  let connection: MemoryIndexerConnection | null = null;
  let connecting: Promise<MemoryIndexerConnection> | null = null;
  let connectionLifetime = new AbortController();
  let retirement: Promise<void> = Promise.resolve();
  let workLoop: SingleFlightIntervalLoopHandle | null = null;
  let loopPolicy: string | null = null;
  let policyWorkRequested = false;
  let settingsApplied = false;
  let settingsOperation: Promise<void> = Promise.resolve();
  type Withdrawal = Readonly<{ kind: 'remove'; sessionIds: readonly string[] }>
    | Readonly<{ kind: 'archive'; sessionId: string }>
    | Readonly<{ kind: 'reset' }>;
  // The failed authoritative fact stays unsatisfied until its actual replay
  // succeeds. An unrelated no-op or settings reload cannot erase a revoke.
  let failedWithdrawal: Withdrawal | undefined;
  let clearPromise: Promise<void> | null = null;
  let stopPromise: Promise<void> | null = null;
  let externalNeedsRefresh = true;
  let retireForPluginChange = false;
  const observedSessionIds = new Set<string>();
  // Retained rows predate this worker's volatile admissions. Read their identities
  // once at startup; subsequent writers are represented by the indexer projection.
  const startupRetainedSessionIds = new Set<string>();
  // Retained Sessions whose transcript revision may not have reached the index. The Account
  // cursor advances once a revision is received, so a revision still unapplied at a stop survives
  // only here. On first sight only these Sessions revalidate; the others are current up to the
  // cursor, and later revisions arrive through the feed. Without this record (first start of a
  // retained index) every retained Session is in it.
  const unappliedRevisionsPath = join(paths.memoryDir, 'unapplied-revisions.json');
  const unappliedRevisionSessionIds = new Set<string>();
  let unappliedRevisionsWrite: Promise<void> = Promise.resolve();
  const persistUnappliedRevisions = () => {
    const sessionIds = [...unappliedRevisionSessionIds].sort();
    const write = unappliedRevisionsWrite.catch(() => {}).then(() => writeJsonAtomic(unappliedRevisionsPath, { v: 1, sessionIds }));
    unappliedRevisionsWrite = write;
    return write;
  };
  // Exact requests are owned here before their first await or child publication.
  const activeSessionRequests = new Set<{ sessionId: string; removed: boolean }>();
  const pendingRevisions = new Map<string, Readonly<{
    sessionId: string; seq: number; messageId?: string; revised?: boolean;
    eligibility?: MemorySessionInventoryObservation['eligibility'];
    cryptoInputs?: MemorySessionInventoryObservation['cryptoInputs'];
  }>>();
  const observation = createMemoryExternalTranscriptObservation({ credentials: params.credentials,
    onChange: (refresh, cause) => {
      externalNeedsRefresh ||= refresh;
      if (cause === 'registry') {
        retireForPluginChange = true;
        void reloadSettings().catch(markFailure);
      }
      workLoop?.trigger();
    } });
  const markFailure = (_error: unknown) => {
    observedSessionIds.clear();
    snapshot = { ...snapshot, worker: { ...snapshot.worker, state: 'error', currentSessionId: null, currentPhase: null, idleGraceUntilMs: null } };
  };
  const host: MemoryIndexerHost = {
    publish: next => {
      const priorDeadline = snapshot.nextWorkAtMs;
      snapshot = applyMemoryIndexerPublication(snapshot, next);
      for (const id of next.removedSessionIds ?? []) startupRetainedSessionIds.delete(id);
      if (snapshot.nextWorkAtMs !== priorDeadline) workLoop?.trigger();
    },
    failed: markFailure,
    settled: () => {
      if (snapshot.worker.state === 'error') return;
      // A drained child has applied every revision of the Sessions it observed and holds no edit for.
      let applied = false;
      for (const id of unappliedRevisionSessionIds) {
        if (!observedSessionIds.has(id) || pendingRevisions.has(id) || snapshot.editedSessionIds.includes(id)) continue;
        unappliedRevisionSessionIds.delete(id);
        applied = true;
      }
      if (applied) void persistUnappliedRevisions().catch(error => {
        // The larger record on disk only revalidates those Sessions again.
        logger.warn('[memoryWorker] Applied revision record could not be written', error);
      });
      snapshot = { ...snapshot, worker: { ...snapshot.worker, state: desired.enabled ? 'idle' : 'disabled',
        currentSessionId: null, currentPhase: null, idleGraceUntilMs: null, activeOperations: [] },
        embeddings: snapshot.embeddings.runtimeState === 'ready' || snapshot.embeddings.runtimeState === 'downloading'
          ? { ...snapshot.embeddings, runtimeState: 'idle' } : snapshot.embeddings };
    },
    observeSessions: async ids => {
      const unseen = ids.filter(id => !observedSessionIds.has(id));
      for (const id of unseen) observedSessionIds.add(id);
      return unseen.filter(id => unappliedRevisionSessionIds.has(id));
    },
    readExternalSources: async (refresh, signal) => {
      if (refresh || externalNeedsRefresh) {
        externalNeedsRefresh = false;
        try { await observation.refresh(desired, signal); }
        catch (error) { externalNeedsRefresh = true; throw error; }
      }
      return observation.takeSnapshot();
    },
    runHint: (request, signal) => runMemoryHintsExecutionRun({ ...request,
      cwd: configuration.activeServerDir, credentials: params.credentials, signal }),
    commitHint: async (request, signal) => {
      signal?.throwIfAborted();
      const raw = await fetchSessionById({ reason: 'memory-change', projection: SESSION_DETAIL_RUNTIME_SNAPSHOT_PROJECTION, token: params.credentials.token, sessionId: request.sessionId, signal });
      signal?.throwIfAborted();
      if (!raw) return;
      const mode = resolveSessionStoredContentEncryptionMode(raw);
      const ctx = mode === 'plain' ? null : resolveSessionEncryptionContextFromCredentials(params.credentials, raw);
      if (mode !== 'plain' && !ctx) throw new AccountEncryptionMaterialUnavailableError();
      await commitMemorySystemRecords({ credentials: params.credentials, sessionId: request.sessionId, mode,
        ...(ctx ? { ctx } : {}), shard: { sessionId: request.sessionId, payload: request.shardPayload },
        synopsis: request.synopsisPayload ? { sessionId: request.sessionId, payload: request.synopsisPayload } : null, signal });
    },
  };
  const getIndexer = async (): Promise<MemoryIndexerConnection> => {
    await retirement;
    if (stopped) throw new Error('memory_worker_stopped');
    if (connection) return connection;
    if (connecting) return connecting;
    connectionLifetime = new AbortController();
    const pending = (async () => {
      const next = params.deps?.connectIndexer
        ? await params.deps.connectIndexer(host)
        : await connectProcessIndexer();
      if (stopped) { await next.retire(); throw new Error('memory_worker_stopped'); }
      connection = next;
      // The production service applies current policy in its private bootstrap;
      // only the source-test connection needs initialization at this boundary.
      try {
        if (params.deps?.connectIndexer) await next.applySettings(desired, connectionLifetime.signal);
      }
      catch (error) { connection = null; await next.retire(); throw error; }
      return next;
    })();
    connecting = pending;
    try { return await pending; }
    catch (error) { if (!connectionLifetime.signal.aborted) markFailure(error); throw error; }
    finally { if (connecting === pending) connecting = null; }
  };
  const connectProcessIndexer = async (): Promise<MemoryIndexerConnection> => {
    const { connectProcessMemoryIndexer } = await import('./processMemoryIndexer');
    const selected = desired.conversationSearch.indexExternal;
    const lease = selected.enabled && selected.agents.length
      ? await (await import('@/plugins/runtime/reload/runtimeLease')).acquireAuthoritativePluginRuntimeRegistryLease()
      : null;
    try {
      const registry = lease?.registry;
      const pluginIds = registry ? [...new Set(registry.contributes.agents
        .filter(agent => selected.agents.includes(agent.id)).flatMap(agent => agent.identity ? [agent.identity.pluginId] : []))] : [];
      if (pluginIds.length && (!registry?.readAdmittedBackgroundServicePlugins || !registry.prepareBackgroundServiceProcessAgentServices)) {
        throw new Error('memory_indexer_admitted_readers_unavailable');
      }
      const indexer = await connectProcessMemoryIndexer({ credentials: params.credentials, machineId: params.machineId,
        host, readSettings: () => desired,
        readIndexesQualified: () => snapshot.indexesQualified
          && snapshot.settings.includeArchivedSessions === desired.includeArchivedSessions,
        plugins: registry?.readAdmittedBackgroundServicePlugins?.(pluginIds),
        ...(registry?.prepareBackgroundServiceProcessAgentServices ? { pluginHost: {
          prepareAgentInvocationServices: request => registry.prepareBackgroundServiceProcessAgentServices!(request),
        } } : {}),
      });
      return { ...indexer, retire: async () => { try { await indexer.retire(); } finally { await lease?.release(); } } };
    } catch (error) { await lease?.release(); throw error; }
  };
  const call = async <T>(run: (indexer: MemoryIndexerConnection, signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> => {
    signal?.throwIfAborted();
    const indexer = await getIndexer();
    const operationSignal = signal ? AbortSignal.any([signal, connectionLifetime.signal]) : connectionLifetime.signal;
    operationSignal.throwIfAborted();
    try { return await run(indexer, operationSignal); }
    catch (error) { if (!operationSignal.aborted) markFailure(error); throw error; }
  };
  const callWithRevisions = (run?: (indexer: MemoryIndexerConnection, signal: AbortSignal) => Promise<void>, signal?: AbortSignal) => (
    call(async (indexer, operationSignal) => {
      const revisions = new Map(pendingRevisions);
      const observations = [...revisions.values()].flatMap(change => change.eligibility !== undefined
        ? [{ sessionId: change.sessionId, eligibility: change.eligibility, cryptoInputs: change.cryptoInputs }] : []);
      await Promise.all([
        ...[...revisions.values()].filter(change => change.revised).map(({ sessionId, seq, messageId }) =>
          indexer.revise({ sessionId, seq, ...(messageId ? { messageId } : {}) }, operationSignal)),
        ...(observations.length ? [indexer.inventory(operationSignal, observations)] : []),
        ...(run ? [run(indexer, operationSignal)] : []),
      ]);
      for (const change of revisions.values()) {
        if (pendingRevisions.get(change.sessionId) === change && !snapshot.editedSessionIds.includes(change.sessionId)) pendingRevisions.delete(change.sessionId);
      }
      return revisions;
    }, signal)
  );
  const stopLoops = async () => {
    const priorWork = workLoop;
    workLoop = null; loopPolicy = null;
    await priorWork?.stop();
  };
  const retireIndexer = async () => {
    // A retired child cannot deliver another status publication. Retirement
    // owns withdrawal of its volatile grace, just as failure does above.
    snapshot = { ...snapshot, worker: { ...snapshot.worker, idleGraceUntilMs: null,
      currentPhase: snapshot.worker.currentPhase === 'idle_grace' ? null : snapshot.worker.currentPhase } };
    connectionLifetime.abort();
    observedSessionIds.clear();
    const prior = connection;
    const priorConnecting = connecting;
    connection = null;
    retirement = (async () => {
      await stopLoops();
      const indexer = prior ?? await priorConnecting?.catch(() => null);
      // A pending factory can publish its connection after retirement began.
      // It belongs to this drain, never to the next settings occurrence.
      if (connection === indexer) connection = null;
      await indexer?.retire();
    })();
    await retirement;
  };
  const hasArchivedChange = async (signal?: AbortSignal): Promise<boolean> => {
    if (desired.includeArchivedSessions) return false;
    try {
      const archived = await collectRetainedSessionInventoryVisibility({
        retainedSessionIds: withReaders(retainedIds), scopes: ['archived'], signal,
        fetchInventoryPage: args => fetchSessionInventoryPage({ token: params.credentials.token,
          limit: desired.worker.sessionListPageLimit, ...args }),
      });
      signal?.throwIfAborted();
      if (archived.size > 0) return true;
      snapshot = { ...snapshot, settings: { ...snapshot.settings, includeArchivedSessions: false } };
    } catch (error) {
      signal?.throwIfAborted();
      // Retained rows may still be archived. Preserve the existing truthful
      // effective-policy projection until observation/purge succeeds.
      snapshot = { ...snapshot, settings: { ...snapshot.settings, includeArchivedSessions: true } };
      logger.debug('[memoryWorker] Archived observation incomplete', { message: error instanceof Error ? error.message : String(error) });
    }
    return false;
  };
  const startLoops = async () => {
    if (!configuration.isDaemonProcess || !desired.enabled || stopped) return;
    const policy = JSON.stringify(desired.worker);
    if (loopPolicy === policy && workLoop) return;
    await stopLoops();
    loopPolicy = policy;
    workLoop = startSingleFlightIntervalLoop({
      intervalMs: desired.worker.tickIntervalMs,
      task: async signal => {
        const deadlineDue = snapshot.nextWorkAtMs != null && snapshot.nextWorkAtMs <= Date.now();
        const needsTick = policyWorkRequested || externalNeedsRefresh || observation.hasPendingChanges() || deadlineDue
          || [...pendingRevisions.values()].some(change => change.revised && change.eligibility === undefined);
        if (needsTick || pendingRevisions.size > 0) {
          policyWorkRequested = false;
          try { await callWithRevisions(needsTick ? (indexer, signal) => indexer.tick(signal) : undefined, signal); }
          catch (error) {
            if (!signal.aborted) {
              markFailure(error);
              logger.debug('[memoryWorker] Tick failed', { message: error instanceof Error ? error.message : String(error) });
            }
            // Failure is visible; a later real change/explicit refresh retries.
            return { nextAutomaticRunAfterMs: null };
          }
        }
        return { nextAutomaticRunAfterMs: snapshot.nextWorkAtMs == null ? null : snapshot.nextWorkAtMs - Date.now() };
      },
      onError: error => { markFailure(error); logger.debug('[memoryWorker] Tick failed', { message: error instanceof Error ? error.message : String(error) }); },
    });
    // Policy admission already inventories in its first child tick. Starting
    // a concurrent observation here would re-admit that same initial frontier.
    workLoop.trigger();
  };
  const coversWithdrawal = (retry: Withdrawal, failed: Withdrawal): boolean => {
    if (retry.kind === 'remove' && failed.kind === 'remove') {
      const requested = new Set(retry.sessionIds);
      return failed.sessionIds.every(id => requested.has(id));
    }
    if (retry.kind === 'archive' && failed.kind === 'archive') return retry.sessionId === failed.sessionId;
    return retry.kind === 'reset' && failed.kind === 'reset';
  };
  const serializeSettings = (run: () => Promise<void>, recovery?: true | Withdrawal) => {
    const next = settingsOperation.catch(error => {
      if (failedWithdrawal) {
        if (!recovery || recovery === true || !coversWithdrawal(recovery, failedWithdrawal)) throw error;
      } else if (recovery !== true) throw error;
    }).then(async () => {
      try {
        await run();
        if (recovery && recovery !== true && failedWithdrawal && coversWithdrawal(recovery, failedWithdrawal)) {
          failedWithdrawal = undefined;
        }
      } catch (error) {
        // Only this operation's own started failure supplies an unsatisfied
        // withdrawal, never a rejected preceding policy admission.
        if (recovery && recovery !== true) failedWithdrawal = recovery;
        throw error;
      }
    });
    settingsOperation = next;
    return next;
  };
  const waitForReady = async (signal?: AbortSignal): Promise<void> => {
    let incumbent: Promise<void>;
    do {
      incumbent = settingsOperation;
      if (signal) await waitForObservation(incumbent, signal);
      else await incumbent;
    } while (incumbent !== settingsOperation);
    if (stopped) throw new Error('memory_worker_stopped');
  };
  const applySettings = async (next: MemorySettingsV1, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    const changed = JSON.stringify(next) !== JSON.stringify(desired);
    if (settingsApplied && !changed && !retireForPluginChange) {
      if (next.enabled && await hasArchivedChange(signal)) {
        await callWithRevisions((indexer, signal) => indexer.inventory(signal), signal);
      }
      await startLoops();
      return;
    }
    settingsApplied = false;
    policyWorkRequested = next.enabled;
    if (changed || retireForPluginChange) {
      // Prior-policy rows are not qualified for the replacement occurrence,
      // including when its process fails before publishing its first facts.
      snapshot = { ...snapshot, indexesQualified: false };
      discardPendingEligibility();
      await retireIndexer();
      const registryChanged = retireForPluginChange;
      retireForPluginChange = false;
      await observation.configure(next, desired, registryChanged);
    }
    desired = next;
    externalNeedsRefresh ||= changed;
    if (!next.enabled) {
      await retireIndexer();
      await observation.refresh(next, signal ?? new AbortController().signal);
      if (next.deleteOnDisable) {
        await rm(paths.memoryDir, { recursive: true, force: true });
        startupRetainedSessionIds.clear();
      }
      snapshot = { ...snapshot, settings: next, indexesQualified: false,
        embeddings: buildUnavailableMemoryEmbeddingsDiagnostics(next.embeddings),
        worker: { ...snapshot.worker, state: 'disabled', currentSessionId: null, currentPhase: null, idleGraceUntilMs: null, activeOperations: [] } };
      settingsApplied = true;
      return;
    }
    await ensureProtectedLocalStateDirectory(paths.memoryDir, { authority: 'owned' });
    const existing = connection;
    const indexer = await getIndexer();
    if (existing || !params.deps?.connectIndexer) await timeWebLatencyPhase('memory.startup.policy',
      () => indexer.applySettings(next, signal ? AbortSignal.any([signal, connectionLifetime.signal]) : connectionLifetime.signal));
    await startLoops();
    settingsApplied = true;
  };
  const reloadSettings = (signal?: AbortSignal) => serializeSettings(async () => {
    if (stopped) return;
    signal?.throwIfAborted();
    try { await applySettings(await readMemorySettingsFromDisk(), signal); }
    catch (error) { settingsApplied = false; throw error; }
  }, true);
  const withReaders = <T>(read: (tier1: SummaryShardIndexReader | null, deep: DeepIndexReader | null) => T): T => {
    let tier1: SummaryShardIndexReader | null = null;
    let deep: DeepIndexReader | null = null;
    try {
      if (existsSync(paths.tier1DbPath)) tier1 = openSummaryShardIndexReader({ dbPath: paths.tier1DbPath });
      if (existsSync(paths.deepDbPath)) deep = openDeepIndexReader({ dbPath: paths.deepDbPath });
      return read(tier1, deep);
    } finally { deep?.close(); tier1?.close(); }
  };
  const retainedIds = (tier1: SummaryShardIndexReader | null, deep: DeepIndexReader | null) => {
    const ids = new Set(tier1?.listIndexedSessionIds().filter(id => !isExternalMemoryStorageId(id)) ?? []);
    const externalIds = new Set(deep?.listExternalSourceStates().map(state => state.sessionId) ?? []);
    for (const id of deep?.listIndexedSessionIds() ?? []) if (!externalIds.has(id)) ids.add(id);
    return [...ids];
  };
  /**
   * The last Session read that admitted each Session, with its eligibility under this settings basis.
   * Only the transcript seq and owner-metadata locality can move an admitted Session's Memory inputs
   * (archive, removal and access have their own carriers; a later `updatedAt` only widens selection),
   * so a change row that pushes the seq and proves locality unchanged needs no Session read.
   */
  const pushedAdmissions = new Map<string, Readonly<{ basis: MemorySettingsV1;
    eligibility: NonNullable<ReturnType<typeof resolveMemoryInventorySessionEligibility>> }>>();
  const hasAdmittedSessionWork = (sessionId: string) => observedSessionIds.has(sessionId) || pendingRevisions.has(sessionId)
    || [...activeSessionRequests].some(request => request.sessionId === sessionId)
    || snapshot.candidateSessionIds.includes(sessionId) || snapshot.editedSessionIds.includes(sessionId)
    || snapshot.worker.currentSessionId === sessionId
    || snapshot.worker.activeOperations?.some(operation => operation.sessionIds.includes(sessionId))
    || snapshot.observedSeqBySessionId.some(([id]) => id === sessionId);
  const hasSessionWork = (sessionId: string) => hasAdmittedSessionWork(sessionId)
    || withReaders((tier1, deep) => tier1?.hasSessionIndexData(sessionId) === true || deep?.hasSessionIndexData(sessionId) === true);
  function discardPendingEligibility() {
    pushedAdmissions.clear();
    for (const [id, change] of pendingRevisions) {
      if (change.revised) {
        const { eligibility: _eligibility, cryptoInputs: _cryptoInputs, ...revision } = change;
        pendingRevisions.set(id, revision);
      } else pendingRevisions.delete(id);
    }
  }
  const forgetPendingSessionObservations = (sessionIds: readonly string[]) => {
    for (const id of sessionIds) { observedSessionIds.delete(id); pendingRevisions.delete(id); pushedAdmissions.delete(id); }
    for (const request of activeSessionRequests) if (sessionIds.includes(request.sessionId)) request.removed = true;
  };
  const resolveDocumentSearchScope = async (scope: MemorySearchQueryV1['scope'], signal?: AbortSignal): Promise<MemoryDocumentSearchScope> => {
    await waitForReady(signal);
    signal?.throwIfAborted();
    if (stopped || !desired.enabled || !snapshot.indexesQualified) return { state: 'unavailable', eligibleDocuments: [] };
    const basis = desired;
    return await syncMemoryDocuments({ credentials: params.credentials, machineId: params.machineId, scope,
      includeArchivedSessions: basis.includeArchivedSessions, signal,
      readProjectContext: (projectRef, signal) => readCliProjectPromptStackContext({ credentials: params.credentials, projectRef, signal }),
      writeIndex: (update, signal) => call((indexer, signal) => indexer.indexDocuments(update, signal), signal),
      assertCurrent: () => { if (stopped || desired !== basis) throw new Error('memory_document_scope_changed'); } });
  };
  const unsubscribeInstall = subscribeOptionalRuntimeInstallSuccess(key => {
    if (key !== INSTALLABLE_KEYS.LOCAL_EMBEDDINGS || !desired.enabled || !connection) return;
    void call((indexer, signal) => indexer.retryEmbeddings(signal)).catch(markFailure);
  });
  const initialization = serializeSettings(async () => {
    if (stopped) return;
    const initialSettings = await timeWebLatencyPhase('memory.startup.settingsRead', readMemorySettingsFromDisk);
    if (stopped) return;
    for (const id of withReaders(retainedIds)) startupRetainedSessionIds.add(id);
    const record = await readFile(unappliedRevisionsPath, 'utf8').then(text => JSON.parse(text) as unknown, () => null);
    const recorded = record && typeof record === 'object' && 'v' in record && record.v === 1 && 'sessionIds' in record
      && Array.isArray(record.sessionIds) && record.sessionIds.every(id => typeof id === 'string') ? record.sessionIds as string[] : null;
    for (const id of recorded ?? startupRetainedSessionIds) unappliedRevisionSessionIds.add(id);
    snapshot = { ...snapshot, settings: initialSettings,
      embeddings: buildUnavailableMemoryEmbeddingsDiagnostics(initialSettings.embeddings),
      worker: { ...snapshot.worker, state: initialSettings.enabled ? 'indexing' : 'disabled' } };
    await applySettings(initialSettings);
  });
  void initialization.catch(error => {
    if (stopped) return;
    markFailure(error);
    logger.warn('[memoryWorker] Initial policy admission failed; awaiting explicit settings recovery');
  });
  return {
    waitForReady,
    reloadSettings,
    stop: () => {
      if (stopPromise) return stopPromise;
      stopped = true;
      connectionLifetime.abort();
      unsubscribeInstall();
      stopPromise = (async () => {
        // Join failed/cancelled admission too; it must not skip physical cleanup.
        await Promise.allSettled([settingsOperation]);
        try { await retireIndexer(); }
        finally { await Promise.allSettled([unappliedRevisionsWrite]); await observation.dispose(); }
      })();
      return stopPromise;
    },
    clearIndex: async signal => {
      await waitForReady(signal);
      signal?.throwIfAborted();
      if (stopped) return Promise.reject(new Error('memory_worker_stopped'));
      if (clearPromise) return clearPromise;
      clearPromise = serializeSettings(async () => {
        const prior = desired;
        await retireIndexer();
        try {
          signal?.throwIfAborted();
          for (const path of [paths.tier1DbPath, paths.deepDbPath]) {
            for (const suffix of ['', '-wal', '-shm']) await rm(path + suffix, { force: true });
          }
          snapshot = { ...snapshot, indexesQualified: false, candidateSessionIds: [], observedSeqBySessionId: [], editedSessionIds: [], externalSources: [] };
          observedSessionIds.clear();
          pendingRevisions.clear();
          startupRetainedSessionIds.clear();
        } finally { externalNeedsRefresh = true; settingsApplied = false; await applySettings(prior); }
      }).finally(() => { clearPromise = null; });
      return clearPromise;
    },
    ensureUpToDate: async (sessionId, signal) => {
      signal?.throwIfAborted();
      if (stopped) return;
      const request = sessionId ? { sessionId, removed: false } : undefined;
      if (request) activeSessionRequests.add(request);
      try {
        await reloadSettings(signal);
        if (!desired.enabled || request?.removed) return;
        const admittedRevisions = await callWithRevisions((indexer, signal) => indexer.refresh(sessionId, signal), signal);
        if (request?.removed) return;
        // A real revision can arrive while a source read is in flight. Keep
        // that newer fact until its own command and scheduler turn settle.
        if ([...pendingRevisions].some(([id, change]) => admittedRevisions.get(id) !== change)) await callWithRevisions(async () => {}, signal);
        await resolveDocumentSearchScope(sessionId ? { type: 'session', sessionId } : { type: 'global' }, signal);
      } catch (error) {
        // First observation can precede a cancelled retained-snapshot read.
        // The next child must still validate that snapshot's same-seq edits.
        if (signal?.aborted) {
          if (sessionId) observedSessionIds.delete(sessionId);
          else observedSessionIds.clear();
        }
        throw error;
      } finally { if (request) activeSessionRequests.delete(request); }
    },
    noteSessionChanged: async change => {
      // Activity, presence, ready, pending-queue, Turn-status and Agent-state writes cannot move
      // eligibility or observedSeq; transcript, archive and removal facts arrive through their own
      // carriers. Unknown or missing proofs read.
      if (change.memoryInputsChanged === false) return;
      await waitForReady();
      if (stopped || !desired.enabled) return;
      const held = pushedAdmissions.get(change.sessionId);
      const pushedSeq = change.pushed?.transcriptSeq;
      if (held && held.basis === desired && pushedSeq !== undefined
        && change.pushed?.localityUnchanged === true && hasAdmittedSessionWork(change.sessionId)) {
        const pending = pendingRevisions.get(change.sessionId);
        const observed = pending?.eligibility?.observedSeq ?? snapshot.observedSeqBySessionId.find(([id]) => id === change.sessionId)?.[1];
        if (observed !== undefined && pushedSeq <= observed) return;
        const eligibility = { ...held.eligibility, observedSeq: pushedSeq };
        pushedAdmissions.set(change.sessionId, { ...held, eligibility });
        pendingRevisions.set(change.sessionId, { ...pending, sessionId: change.sessionId,
          seq: Math.max(pending?.seq ?? 0, pushedSeq), eligibility });
        workLoop?.trigger();
        return;
      }
      const request = { sessionId: change.sessionId, removed: false };
      activeSessionRequests.add(request);
      try {
        const basis = desired;
        const signal = connectionLifetime.signal;
        // Only this request owns the admission; removal can withdraw it during IO.
        const [session, currentness] = await Promise.all([
          fetchSessionById({ reason: 'memory-change', projection: SESSION_DETAIL_RUNTIME_SNAPSHOT_PROJECTION, token: params.credentials.token, sessionId: change.sessionId, signal }),
          readRequesterAccountEncryptionCurrentness({ token: params.credentials.token, signal }),
        ]);
        signal.throwIfAborted();
        if (stopped || desired !== basis || request.removed) return;
        const eligibility = session && isMemorySessionOnMachine({ ...params, session, accountEncryptionMode: currentness.mode })
          ? resolveMemoryInventorySessionEligibility({ session, backfillPolicy: basis.backfillPolicy,
            includeArchivedSessions: basis.includeArchivedSessions, enabledAtMs: basis.enabledAtMs ?? 0, nowMs: Date.now() }) : null;
        if (!session || !eligibility) {
          // This ineligible read cannot write; only other admitted work needs removal.
          pushedAdmissions.delete(change.sessionId);
          activeSessionRequests.delete(request);
          if (!hasSessionWork(change.sessionId)) return;
          forgetPendingSessionObservations([change.sessionId]);
          const loop = workLoop; loop?.pause();
          // Removal stays in the Account cursor's custody window.
          try {
            await call((indexer, signal) => indexer.inventory(signal, [{ sessionId: change.sessionId, eligibility: null }]));
            startupRetainedSessionIds.delete(change.sessionId);
          }
          finally { if (!stopped && desired.enabled && workLoop === loop) loop?.resume(); }
          return;
        }
        const pending = pendingRevisions.get(change.sessionId);
        const observed = pending?.eligibility?.observedSeq ?? snapshot.observedSeqBySessionId.find(([id]) => id === change.sessionId)?.[1];
        const admit = () => { pushedAdmissions.set(change.sessionId, { basis, eligibility }); };
        if (observed === eligibility.observedSeq) { admit(); return; }
        // A never-admitted Session wakes the indexer child only once it holds a row the child
        // indexes: user/agent rows (`memoryIndexer` reads roles user/agent plus legacy unclassified
        // rows, which only released clients wrote and the inventory pass admits). A new Session's
        // creation, metadata and event rows have nothing to index; its first user row wakes it.
        const known = observedSessionIds.has(change.sessionId) || snapshot.candidateSessionIds.includes(change.sessionId)
          || startupRetainedSessionIds.has(change.sessionId) || withReaders((tier1, deep) =>
            tier1?.hasSessionIndexData(change.sessionId) === true || deep?.hasSessionIndexData(change.sessionId) === true);
        if (observed === undefined && !known) {
          if (eligibility.observedSeq === 0) return;
          const indexable = await fetchEncryptedTranscriptMessagesPage({ token: params.credentials.token, sessionId: change.sessionId,
            afterSeq: 0, limit: 1, roles: ['user', 'agent'], scope: 'main', signal });
          signal.throwIfAborted();
          if (stopped || desired !== basis || request.removed || indexable.messages.length === 0) return;
        }
        pendingRevisions.set(change.sessionId, { ...pending, sessionId: change.sessionId,
          seq: Math.max(pending?.seq ?? 0, eligibility.observedSeq), eligibility,
          cryptoInputs: { encryptionMode: session.encryptionMode, dataEncryptionKey: session.dataEncryptionKey,
            effectiveAccess: session.effectiveAccess, share: session.share,
            metadataLayoutVersion: session.metadataLayoutVersion, metadata: session.metadata },
        });
        admit();
        // Do not hold the change carrier behind transcript/index IO.
        workLoop?.trigger();
      } finally { activeSessionRequests.delete(request); }
    },
    noteSessionTranscriptRevised: async change => {
      await waitForReady();
      if (stopped) return;
      // Append hints are cursor-blocking and must never open SQLite readers.
      // A never-admitted Session reads current content on its first normal admission.
      if (!startupRetainedSessionIds.has(change.sessionId) && !hasAdmittedSessionWork(change.sessionId)) return;
      // Durable before the Account cursor can advance past this revision.
      if (!unappliedRevisionSessionIds.has(change.sessionId)) {
        unappliedRevisionSessionIds.add(change.sessionId);
        await persistUnappliedRevisions();
      }
      pendingRevisions.set(change.sessionId, { ...pendingRevisions.get(change.sessionId), ...change, revised: true });
      // Receipt must not hold the Account change stream behind transcript IO.
      // The incumbent single-flight work pump carries this fact to the child.
      workLoop?.trigger();
    },
    attachExternalObservation: next => {
      const detach = observation.attach(next);
      return detach;
    },
    readExternalTranscriptPage: async (request, signal) => {
      await waitForReady(signal);
      return await call((indexer, signal) => indexer.readExternalPage(request, signal), signal);
    },
    embedQuery: async (text, signal) => {
      await waitForReady(signal);
      const vector = await call((indexer, signal) => indexer.embedQuery(text, signal), signal);
      return vector ? Float32Array.from(vector) : null;
    },
    resolveDocumentSearchScope,
    removeSessions: ids => {
      const requested = [...new Set(ids.map(id => id.trim()).filter(Boolean))];
      const admitted = new Set(requested.filter(id => hasAdmittedSessionWork(id)
        || failedWithdrawal?.kind === 'remove' && failedWithdrawal.sessionIds.includes(id)));
      const withdrawal: { kind: 'remove'; sessionIds: readonly string[] } = { kind: 'remove', sessionIds: requested };
      // Withdraw already-admitted writes immediately. Queue the physical purge
      // before returning, so pending readers cannot overtake a pre-ready revoke.
      forgetPendingSessionObservations(requested);
      const loop = workLoop; loop?.pause();
      return serializeSettings(async () => {
        // Keep the selection made before withdrawing pending observations,
        // and include any writer facts published while initial admission ran.
        const selected = requested.filter(id => admitted.has(id) || hasSessionWork(id));
        if (!selected.length) return;
        withdrawal.sessionIds = selected;
        forgetPendingSessionObservations(selected);
        await call((indexer, signal) => indexer.removeSessions(selected, signal));
        for (const id of selected) startupRetainedSessionIds.delete(id);
      }, withdrawal).finally(() => { if (!stopped && desired.enabled && workLoop === loop) loop?.resume(); });
    },
    reconcileRetainedSessionAccess: () => serializeSettings(async () => {
      // Cursor loss also loses revisions: every retained Session revalidates on first sight.
      for (const id of withReaders(retainedIds)) unappliedRevisionSessionIds.add(id);
      await persistUnappliedRevisions();
      // Drain already-admitted work before requalifying after cursor loss.
      snapshot = { ...snapshot, indexesQualified: false };
      discardPendingEligibility();
      await retireIndexer();
      // Cursor loss also discards append/new-Session facts. Reconcile retained
      // access in custody, then let the existing pump catch up current content.
      policyWorkRequested = desired.enabled;
      try { await call((indexer, signal) => indexer.reconcileAccess(signal)); }
      finally { await startLoops(); }
    }, { kind: 'reset' }),
    applySessionArchivedState: change => {
      const loop = workLoop;
      if (settingsApplied && change.archived && !desired.includeArchivedSessions) {
        forgetPendingSessionObservations([change.sessionId]);
        loop?.pause();
      }
      return serializeSettings(async () => {
        if (stopped || !change.archived || desired.includeArchivedSessions
          || !hasSessionWork(change.sessionId) && !(failedWithdrawal?.kind === 'archive' && failedWithdrawal.sessionId === change.sessionId)) return;
        // A queued authorization predates this exclusion; it cannot be sent
        // after the child has purged the archived Session.
        forgetPendingSessionObservations([change.sessionId]);
        loop?.pause();
        await call((indexer, signal) => indexer.archive(change, signal));
        startupRetainedSessionIds.delete(change.sessionId);
      }, change.archived ? { kind: 'archive', sessionId: change.sessionId } : undefined)
        .finally(() => { if (!stopped && desired.enabled && workLoop === loop) loop?.resume(); });
    },
    listIndexedSessionIds: () => snapshot.indexesQualified ? withReaders(retainedIds) : [],
    getSettings: () => snapshot.settings,
    getEmbeddingsDiagnostics: () => snapshot.embeddings,
    getWorkerStatus: () => {
      if (!snapshot.indexesQualified) return snapshot.worker;
      const observed = new Map(snapshot.observedSeqBySessionId);
      for (const change of pendingRevisions.values()) observed.set(change.sessionId,
        Math.max(observed.get(change.sessionId) ?? 0, change.seq));
      return withReaders((tier1, deep) => ({ ...snapshot.worker,
        sessionProgress: [...new Set([...snapshot.candidateSessionIds, ...snapshot.observedSeqBySessionId.map(([id]) => id), ...retainedIds(tier1, deep)])].map(sessionId => {
          const cursors = tier1?.getSessionCursors({ sessionId, nowMs: Date.now() });
          return { sessionId, observedSeq: observed.get(sessionId) ?? null,
            checkedSeq: desired.indexMode === 'deep' ? cursors?.lastObservedSeq ?? 0 : null,
            indexedSeq: desired.indexMode === 'deep' ? cursors?.lastDeepIndexedSeq ?? 0 : cursors?.lastHintedSeq ?? 0 };
        }) }));
    },
    getIndexSources: () => {
      const project = (tier1: SummaryShardIndexReader | null, deep: DeepIndexReader | null) => {
      const sessionIds = [...new Set([...snapshot.candidateSessionIds, ...snapshot.observedSeqBySessionId.map(([id]) => id), ...retainedIds(tier1, deep)])];
      const sessions: MemoryIndexSourceStatusV1[] = sessionIds.map(sessionId => {
        const source = { type: 'happier_session' as const, sessionId };
        if (!desired.enabled || (desired.indexMode === 'hints' && !desired.hints.enabled)) return { source, state: 'disabled' };
        const status = tier1?.getMemorySessionIndexStatus(sessionId);
        const pending = pendingRevisions.has(sessionId) || snapshot.editedSessionIds.includes(sessionId) || snapshot.worker.activeOperations?.some(operation => operation.kind === 'transcript' && operation.sessionIds.includes(sessionId));
        const errorCode = status === 'failed' ? tier1?.getMemorySessionIndexErrorCode(sessionId) : null;
        return { source, state: snapshot.worker.state === 'error' || status === 'failed' ? 'error'
          : !snapshot.indexesQualified || pending ? 'indexing' : status === 'indexed' || status === 'empty' ? 'ready' : 'indexing',
          ...(errorCode ? { errorCode } : {}) };
      });
      return [...sessions, ...snapshot.externalSources.map(row => !desired.enabled || !desired.conversationSearch.indexExternal.enabled
        ? { ...row, state: 'disabled' as const } : snapshot.worker.state === 'error' ? { ...row, state: 'error' as const } : row)];
      };
      return snapshot.indexesQualified ? withReaders(project) : project(null, null);
    },
    getTier1DbPath: () => !stopped && desired.enabled && snapshot.indexesQualified && existsSync(paths.tier1DbPath) ? paths.tier1DbPath : null,
    getDeepDbPath: () => !stopped && desired.enabled && snapshot.indexesQualified && existsSync(paths.deepDbPath) ? paths.deepDbPath : null,
    getTier1DbPhysicalPath: () => paths.tier1DbPath,
    getDeepDbPhysicalPath: () => paths.deepDbPath,
  };
}

/** Ready-owner convenience; daemon composition only needs the prepared handle. */
export async function startMemoryWorker(params: Parameters<typeof prepareMemoryWorker>[0]): Promise<MemoryWorkerHandle> {
  const worker = await prepareMemoryWorker(params);
  try { await worker.waitForReady(); return worker; }
  catch (error) { await worker.stop(); throw error; }
}
