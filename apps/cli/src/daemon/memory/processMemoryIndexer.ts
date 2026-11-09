import { randomUUID } from 'node:crypto';

import { encodeStoredCredentials, type StoredCredentials } from '@/persistence';
import type { BackgroundServiceProcessPluginHost } from '@/plugins/runtime/lifecycle/contributions/backgroundServiceProcessBootstrap';
import type { AdmittedBackgroundServicePlugin } from '@/plugins/runtime/lifecycle/contributions/backgroundServiceProcessSource';
import { createBackgroundServiceProcessExecution } from '@/plugins/runtime/lifecycle/contributions/backgroundServiceProcessExecution';
import { createBackgroundServiceRunnerHost } from '@/plugins/runtime/lifecycle/contributions/backgroundServices';
import type { MemorySettingsV1 } from '@/settings/memorySettings';
import { logger } from '@/ui/logger';

import type { MemoryIndexerConnection, MemoryIndexerHost } from './memoryIndexerBoundary';
import type { MemoryIndexerProcessServices } from './memoryIndexerServiceEntry';

type PendingOperation = Readonly<{
  invoke(connection: MemoryIndexerConnection): Promise<void>;
  reject(error: unknown): void;
}>;

/** Adapter only: the shared background-service lifecycle owns every process occurrence. */
export async function connectProcessMemoryIndexer(params: Readonly<{
  credentials: StoredCredentials;
  machineId: string;
  host: MemoryIndexerHost;
  readSettings(): MemorySettingsV1;
  readIndexesQualified?(): boolean;
  plugins?: readonly AdmittedBackgroundServicePlugin[];
  pluginHost?: BackgroundServiceProcessPluginHost;
  spawnChannel?: Parameters<typeof createBackgroundServiceProcessExecution>[0]['spawnChannel'];
}>): Promise<MemoryIndexerConnection> {
  const serviceId = 'memory-indexer';
  const occurrenceId = randomUUID();
  const lifetime = new AbortController();
  const queued = new Set<PendingOperation>();
  type Admission = { handle: ReturnType<typeof lifecycle.demand>; settled: boolean; requests: Set<PendingOperation> };
  let serving: { connection: MemoryIndexerConnection; pending: Set<Promise<void>>; needsDrain: boolean; admission: Admission | undefined } | undefined;
  const { settled: onSettled, ...childHost } = params.host;
  let retired = false;
  // One admitted service run serves its requests through the existing bridge.
  // Release admission synchronously when serve closes so a later arrival joins
  // the lifecycle's follow-up batch rather than an already-closing bridge.
  let admission: Admission | undefined;
  let retirement: Promise<void> | undefined;
  const lifecycle = createBackgroundServiceRunnerHost({ registrations: [],
    createContext: () => { throw new Error('memory_indexer_plugin_context_unavailable'); },
    onDiagnostic: event => { if (event.code === 'background_service_failed') params.host.failed(event.error); },
  });
  const forwardQueued = () => {
    const active = serving;
    if (!active || active.admission !== admission || lifetime.signal.aborted) return;
    for (const operation of queued) {
      queued.delete(operation);
      active.needsDrain = true;
      const pending = operation.invoke(active.connection).finally(() => { active.pending.delete(pending); });
      active.pending.add(pending);
    }
  };

  const memory: MemoryIndexerProcessServices = {
    getBootstrap: async () => ({ credentials: encodeStoredCredentials(params.credentials),
      machineId: params.machineId, settings: params.readSettings(),
      indexesQualified: params.readIndexesQualified?.() === true }),
    host: childHost,
    serve: async (connection, settle) => {
      const active = { connection, pending: new Set<Promise<void>>(), needsDrain: true, admission };
      serving = active;
      try {
        forwardQueued();
        do {
          while (active.pending.size > 0) await Promise.all([...active.pending]);
          active.needsDrain = false;
          await settle();
        } while (active.pending.size > 0 || active.needsDrain);
      } finally {
        if (serving === active) {
          serving = undefined;
          if (admission === active.admission) admission = undefined;
        }
      }
    },
  };
  lifecycle.register({ owner: { kind: 'host', serviceId }, occurrenceId, localId: 'indexer',
    activation: 'demand', placement: 'process',
    runner: async () => { throw new Error('memory_indexer_process_execution_required'); },
    createExecution: () => createBackgroundServiceProcessExecution({ serviceId,
      bootstrap: { entry: 'host', entryId: 'memory-indexer', payload: null, plugins: params.plugins ?? [] },
      services: { memory, ...(params.pluginHost ? { __backgroundServiceProcessPlugins: params.pluginHost } : {}) },
      ...(params.spawnChannel ? { spawnChannel: params.spawnChannel } : {}),
    }),
  });
  lifecycle.start();

  const invoke = async <T>(origin: keyof Omit<MemoryIndexerConnection, 'retire'>,
    run: (connection: MemoryIndexerConnection, signal: AbortSignal) => Promise<T>, callerSignal?: AbortSignal): Promise<T> => {
    if (retired) throw new Error('memory_indexer_retired');
    const signal = callerSignal ? AbortSignal.any([callerSignal, lifetime.signal]) : lifetime.signal;
    signal.throwIfAborted();
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const result = new Promise<T>((accept, refuse) => { resolve = accept; reject = refuse; });
    const operation: PendingOperation = {
      invoke: async connection => {
        try { signal.throwIfAborted(); resolve(await run(connection, signal)); }
        catch (error) { reject(error); }
      }, reject,
    };
    queued.add(operation);
    let demand: ReturnType<typeof lifecycle.demand>;
    let batch: Admission;
    const startsRun = !admission;
    try {
      admission ??= { handle: lifecycle.demand({ serviceId, occurrenceId, localId: 'indexer', reason: origin }),
        settled: false, requests: new Set() };
      batch = admission;
      demand = batch.handle;
    }
    catch (error) { queued.delete(operation); throw error; }
    logger.infoFile('[memoryWorker] Indexer demand', { origin, phase: 'admitted', startsRun });
    if (startsRun) {
      const current = demand;
      void current.settlement.then(() => {
        batch.settled = true;
        logger.infoFile('[memoryWorker] Indexer demand', { origin, phase: 'settled' });
        if (!retired && batch.requests.size === 0 && queued.size === 0) onSettled?.();
      }, error => {
        if (admission === batch) admission = undefined;
        for (const request of batch.requests) request.reject(error);
        logger.infoFile('[memoryWorker] Indexer demand', { origin,
          phase: error instanceof Error && error.name === 'AbortError' ? 'cancelled' : 'failed' });
        // The shared lifecycle diagnoses actual run failure; cancellation is
        // not a second failure, and cannot reject a newer admission's callers.
      });
    }
    batch.requests.add(operation);
    forwardQueued();
    const abort = () => {
      queued.delete(operation);
      reject(signal.reason);
      batch.requests.delete(operation);
      if (batch.requests.size === 0) {
        if (admission === batch) admission = undefined;
        demand.cancel();
      }
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    try {
      // Writer work resolves through the child connection. Its service run can
      // remain open for the child's grace without holding the caller's result.
      // A bootstrap/crash failure must still reject operations with no reply.
      return params.readSettings().enabled
        ? await result
        : (await Promise.all([result, demand.settlement]))[0];
    } catch (error) {
      queued.delete(operation);
      if (!signal.aborted) params.host.failed(error);
      throw error;
    } finally {
      signal.removeEventListener('abort', abort);
      batch.requests.delete(operation);
      if (batch.settled && batch.requests.size === 0 && queued.size === 0 && !retired && !signal.aborted) onSettled?.();
    }
  };
  return {
    applySettings: (settings, signal) => invoke('applySettings', (connection, signal) => connection.applySettings(settings, signal), signal),
    inventory: (signal, observations) => invoke('inventory', (connection, signal) => connection.inventory(signal, observations), signal),
    tick: signal => invoke('tick', (connection, signal) => connection.tick(signal), signal),
    refresh: (sessionId, signal) => invoke('refresh', (connection, signal) => connection.refresh(sessionId, signal), signal),
    revise: (change, signal) => invoke('revise', (connection, signal) => connection.revise(change, signal), signal),
    removeSessions: (ids, signal) => invoke('removeSessions', (connection, signal) => connection.removeSessions(ids, signal), signal),
    reconcileAccess: signal => invoke('reconcileAccess', (connection, signal) => connection.reconcileAccess(signal), signal),
    archive: (change, signal) => invoke('archive', (connection, signal) => connection.archive(change, signal), signal),
    readExternalPage: (request, signal) => invoke('readExternalPage', (connection, signal) => connection.readExternalPage(request, signal), signal),
    embedQuery: (text, signal) => invoke('embedQuery', (connection, signal) => connection.embedQuery(text, signal), signal),
    indexDocuments: (update, signal) => invoke('indexDocuments', (connection, signal) => connection.indexDocuments(update, signal), signal),
    retryEmbeddings: signal => invoke('retryEmbeddings', (connection, signal) => connection.retryEmbeddings(signal), signal),
    retire: () => {
      retirement ??= (async () => {
        retired = true;
        lifetime.abort();
        for (const operation of queued) operation.reject(lifetime.signal.reason);
        queued.clear();
        await lifecycle.dispose();
      })();
      return retirement;
    },
  };
}
