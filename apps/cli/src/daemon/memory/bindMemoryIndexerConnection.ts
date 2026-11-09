import type { MemoryIndexerEngine } from './memoryIndexer';
import type { MemoryIndexerConnection } from './memoryIndexerBoundary';

/** One operation and writer-drain contract for both placement bindings. */
export function bindMemoryIndexerConnection(engine: MemoryIndexerEngine, options: Readonly<{
  beforeRetire?(): Promise<void>;
  beforeOperation?(): void;
  afterOperation?(signal: AbortSignal): Promise<void>;
}> = {}): MemoryIndexerConnection {
  let retired = false;
  let retirement: Promise<void> | null = null;
  const operations = new Set<Readonly<{ controller: AbortController; settled: Promise<unknown> }>>();
  const invoke = <T>(run: (signal: AbortSignal) => Promise<T>, callerSignal?: AbortSignal): Promise<T> => {
    if (retired) return Promise.reject(new Error('memory_indexer_retired'));
    callerSignal?.throwIfAborted();
    options.beforeOperation?.();
    const controller = new AbortController();
    const signal = callerSignal ? AbortSignal.any([callerSignal, controller.signal]) : controller.signal;
    let completed = false;
    const settled = Promise.resolve().then(async () => {
      signal.throwIfAborted();
      const running = run(signal);
      const result = await running;
      signal.throwIfAborted();
      completed = true;
      return result;
    }).finally(async () => {
      try {
        // Keep the drain tracked for retirement. Nested receipts may mark new
        // work, but only the final active command owns the settlement drain.
        if (completed && operations.size === 1) {
          signal.throwIfAborted();
          await options.afterOperation?.(signal);
        }
      } finally { operations.delete(operation); }
    });
    const operation = { controller, settled };
    operations.add(operation);
    return settled;
  };
  return {
    applySettings: (settings, signal) => invoke(signal => engine.applySettings(settings, signal), signal),
    inventory: (signal, observations) => invoke(signal => engine.inventory(signal, observations), signal),
    tick: signal => invoke(signal => engine.tick(signal), signal),
    refresh: (sessionId, signal) => invoke(signal => engine.ensureUpToDate(sessionId, signal), signal),
    revise: (change, signal) => invoke(async () => { await engine.noteSessionTranscriptRevised(change); }, signal),
    removeSessions: (ids, signal) => invoke(async () => { await engine.removeSessions(ids); }, signal),
    reconcileAccess: signal => invoke(async () => { await engine.reconcileRetainedSessionAccess(); }, signal),
    archive: (change, signal) => invoke(signal => engine.applySessionArchivedState(change), signal),
    readExternalPage: (request, signal) => invoke(signal => engine.readExternalTranscriptPage(request, signal), signal),
    embedQuery: (text, signal) => invoke(async signal => {
      const resolution = await engine.resolveEmbeddingsProvider(signal);
      if (!resolution?.provider) return null;
      return [...await resolution.provider.embedQuery(text, signal)];
    }, signal),
    indexDocuments: (update, signal) => invoke(signal => engine.indexDocuments(update, signal), signal),
    retryEmbeddings: signal => invoke(signal => engine.retryEmbeddings(signal), signal),
    retire: () => {
      if (retirement) return retirement;
      retired = true;
      for (const operation of operations) operation.controller.abort();
      retirement = (async () => {
        await Promise.allSettled([...operations].map(operation => operation.settled));
        await options.beforeRetire?.();
        await engine.stop();
      })();
      return retirement;
    },
  };
}
