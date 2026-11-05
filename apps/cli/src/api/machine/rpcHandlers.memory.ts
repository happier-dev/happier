import { z } from 'zod/mini';

import { MemorySearchQueryV1Schema, MemorySearchScopeSchema, resolveMemorySearchCorporaV1 } from '@happier-dev/protocol/memory/memorySearch';
import type { MemorySearchResultV1, MemoryWindowV1 } from '@happier-dev/protocol';
import { MemoryStatusV1Schema, type MemoryDocumentStatusV1 } from '@happier-dev/protocol/memory/memoryStatus';
import { MemorySettingsV1Schema } from '@happier-dev/protocol/memory/memorySettings';
import { MemoryWindowRequestV1Schema, MemoryWindowV1Schema } from '@happier-dev/protocol/memory/memoryWindow';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';

import { searchTier1Memory, searchTier2Memory } from '@/daemon/memory/searchMemory';
import { getMemoryWindow } from '@/daemon/memory/getMemoryWindow';
import { openDeepIndexReader } from '@/daemon/memory/deepIndex/deepIndexDb';
import { openSummaryShardIndexReader } from '@/daemon/memory/summaryShardIndexDb';
import { resolveOperationalMemoryEmbeddingsSettings } from '@/daemon/memory/resolveOperationalMemoryEmbeddingsSettings';

import type { RpcHandlerManager } from '../rpc/RpcHandlerManager';
import type { MemoryWorkerHandle } from '@/daemon/memory/memoryWorker';
import { getSqliteFootprintBytes } from '@/daemon/memory/sqliteFootprint';
import { logger } from '@/ui/logger';

const EnsureUpToDateParamsSchema = z.looseObject({
    sessionId: z.optional(z.string().check(z.minLength(1))),
  });

function disabledResult(): MemorySearchResultV1 {
  return { v: 1, ok: false, errorCode: 'memory_disabled', error: 'memory_disabled' };
}

export function registerMachineMemoryRpcHandlers(params: Readonly<{
  rpcHandlerManager: RpcHandlerManager;
  memoryWorker: MemoryWorkerHandle;
}>): void {
  const { rpcHandlerManager, memoryWorker } = params;

  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_MEMORY_STATUS, async (raw: unknown, context) => {
    await memoryWorker.waitForReady(context?.signal);
    const settings = memoryWorker.getSettings();
    const embeddingsDiagnostics = memoryWorker.getEmbeddingsDiagnostics();
    const tier1DbPath = memoryWorker.getTier1DbPath();
    const deepDbPath = memoryWorker.getDeepDbPath();
    const tier1DbPhysicalPath = memoryWorker.getTier1DbPhysicalPath?.() ?? tier1DbPath;
    const deepDbPhysicalPath = memoryWorker.getDeepDbPhysicalPath?.() ?? deepDbPath;
    const hintsIndexReady = typeof tier1DbPath === 'string' && tier1DbPath.trim().length > 0;
    const deepIndexReady = typeof deepDbPath === 'string' && deepDbPath.trim().length > 0;
    const tier1Stats = (() => {
      if (!tier1DbPath) return null;
      try {
        const db = openSummaryShardIndexReader({ dbPath: tier1DbPath });
        try {
          return {
            stats: db.getSummaryIndexStats(),
            queue: db.getMemoryIndexQueueTelemetry(),
          };
        } finally {
          db.close();
        }
      } catch {
        return null;
      }
    })();
    const deepStats = (() => {
      if (!deepDbPath) return null;
      try {
        const db = openDeepIndexReader({ dbPath: deepDbPath });
        try {
          return db.getDeepIndexStats();
        } finally {
          db.close();
        }
      } catch {
        return null;
      }
    })();
    const hintsIndexHasContent = (tier1Stats?.stats.lightShardCount ?? 0) > 0;
    const deepIndexHasContent = (deepStats?.deepChunkCount ?? 0) > 0;
    const activeIndexSearchable = settings.indexMode === 'deep' ? deepIndexHasContent : hintsIndexHasContent;
    const workerStatus = memoryWorker.getWorkerStatus();
    // Ordinary status probes stay cheap. Scoped probes reuse fresh document admission,
    // not a saved preparation or a second index owned by the status consumer.
    const requestedScope = raw && typeof raw === 'object' && 'scope' in raw ? raw.scope : undefined;
    const parsedScope = MemorySearchScopeSchema.safeParse(requestedScope);
    let documents: MemoryDocumentStatusV1 | undefined;
    let assertDocumentsCurrent: (() => void) | undefined;
    if (requestedScope !== undefined) {
      documents = { state: 'unavailable' };
      if (parsedScope.success && settings.enabled && deepDbPath && memoryWorker.resolveDocumentSearchScope) {
        try {
          const admitted = await memoryWorker.resolveDocumentSearchScope(parsedScope.data, context?.signal);
          if (admitted.state !== 'ready') documents = { state: admitted.state === 'partial' ? 'unavailable' : admitted.state };
          else if (admitted.eligibleMemoryDocuments) {
            admitted.assertCurrent();
            const db = openDeepIndexReader({ dbPath: deepDbPath });
            try {
              const counts = db.getDocumentFactCounts({ eligibleDocuments: admitted.eligibleMemoryDocuments });
              documents = { state: 'ready', facts: counts.map(document => {
                const preparation = admitted.preparation?.find(prepared => prepared.ref.serverId === document.ref.serverId
                  && prepared.ref.artifactId === document.ref.artifactId
                  && prepared.revision.headerVersion === document.revision.headerVersion
                  && prepared.revision.bodyVersion === document.revision.bodyVersion);
                return { ...document, ref: { kind: 'doc' as const, ...document.ref },
                  ...(preparation ? { loadedFactCount: preparation.loadedFactIds.length } : {}) };
              }) };
              // Missing admitted revisions are pending, never an invented zero.
              if (counts.length !== admitted.eligibleMemoryDocuments.length) documents = { state: 'pending' };
              assertDocumentsCurrent = admitted.assertCurrent;
            } finally { db.close(); }
          }
        } catch {
          context?.signal?.throwIfAborted();
          documents = { state: 'unavailable' };
        }
      }
    }

    const readBytes = async (path: string | null): Promise<number | null> => (
      path ? await getSqliteFootprintBytes(path) : null
    );

    const indexContent = tier1Stats || deepStats
      ? {
          lightShardCount: tier1Stats?.stats.lightShardCount ?? 0,
          lightTermCount: tier1Stats?.stats.lightTermCount ?? 0,
          deepChunkCount: deepStats?.deepChunkCount ?? 0,
          deepEmbeddingCount: deepStats?.deepEmbeddingCount ?? 0,
          searchableSessionCount:
            settings.indexMode === 'deep'
              ? (deepStats?.searchableSessionCount ?? 0)
              : (tier1Stats?.stats.searchableSessionCount ?? 0),
          lastIndexedAtMs: tier1Stats?.stats.lastIndexedAtMs ?? null,
          latestIndexedMessageAtMs:
            settings.indexMode === 'deep'
              ? (deepStats?.latestIndexedMessageAtMs ?? null)
              : (tier1Stats?.stats.latestIndexedMessageAtMs ?? null),
        }
      : null;

    const tier1DbBytes = await readBytes(tier1DbPhysicalPath);
    const deepDbBytes = await readBytes(deepDbPhysicalPath);
    try { assertDocumentsCurrent?.(); }
    catch { documents = { state: 'pending' }; }
    context?.signal?.throwIfAborted();
    return MemoryStatusV1Schema.parse({
      v: 1,
      enabled: settings.enabled,
      indexMode: settings.indexMode,
      // Presence proves this daemon implements the archived-eligibility
      // setting; the value is the eligibility it actually applies. Older
      // daemons omit it and must not be presented as applying the setting.
      includeArchivedSessionsEffective: settings.includeArchivedSessions === true,
      ...(memoryWorker.resolveDocumentSearchScope ? { documentSearchSupported: true } : {}),
      ...(memoryWorker.resolveDocumentSearchScope ? { projectSearchSupported: true } : {}),
      ...(documents ? { documents } : {}),
      ...(memoryWorker.getIndexSources ? { sources: [...memoryWorker.getIndexSources()] } : {}),
      hintsIndexReady,
      hintsIndexHasContent,
      deepIndexReady,
      deepIndexHasContent,
      activeIndexReady: settings.indexMode === 'deep' ? deepIndexReady : hintsIndexReady,
      activeIndexSearchable,
      embeddingsEnabled: resolveOperationalMemoryEmbeddingsSettings(settings.embeddings)?.enabled === true,
      embeddingsMode: embeddingsDiagnostics.mode,
      embeddingsPresetId: embeddingsDiagnostics.presetId,
      embeddingsProviderKind: embeddingsDiagnostics.providerKind,
      embeddingsModelId: embeddingsDiagnostics.modelId,
      embeddingsRuntimeState: embeddingsDiagnostics.runtimeState,
      embeddingsUsingFallback: embeddingsDiagnostics.usingFallback,
      tier1DbPath,
      deepDbPath,
      tier1DbBytes,
      deepDbBytes,
      indexContent,
      worker: workerStatus ?? null,
      queue: tier1Stats?.queue
        ? {
            selectedSessionCount: tier1Stats.queue.selectedSessionCount,
            queuedSessionCount: tier1Stats.queue.queuedSessionCount,
            indexingSessionCount: tier1Stats.queue.indexingSessionCount,
            indexedSessionCount: tier1Stats.queue.indexedSessionCount,
            emptySessionCount: tier1Stats.queue.emptySessionCount,
            failedSessionCount: tier1Stats.queue.failedSessionCount,
            waitingSessionCount: tier1Stats.queue.waitingSessionCount,
            oldestQueuedAtMs: tier1Stats.queue.oldestQueuedAtMs,
          }
        : null,
      lastRun: tier1Stats?.queue.lastRun
        ? {
            startedAtMs: tier1Stats.queue.lastRun.startedAtMs,
            finishedAtMs: tier1Stats.queue.lastRun.finishedAtMs,
            sessionsConsidered: tier1Stats.queue.lastRun.sessionsConsidered,
            sessionsProcessed: tier1Stats.queue.lastRun.sessionsProcessed,
            rawRowsFetched: tier1Stats.queue.lastRun.rawRowsFetched,
            semanticRowsFound: tier1Stats.queue.lastRun.semanticRowsFound,
            lightShardsCreated: tier1Stats.queue.lastRun.lightShardsCreated,
            deepChunksCreated: tier1Stats.queue.lastRun.deepChunksCreated,
            failures: tier1Stats.queue.lastRun.sessionsFailed,
            skipReasons: tier1Stats.queue.lastRun.skipReasons,
          }
        : null,
    });
  });

  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_MEMORY_SETTINGS_GET, async (_raw: unknown, context) => {
    await memoryWorker.waitForReady(context?.signal);
    const { readMemorySettingsFromDisk } = await import('@/settings/memorySettings');
    return await readMemorySettingsFromDisk();
  });

  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_MEMORY_SETTINGS_SET, async (raw: unknown) => {
    const parsed = MemorySettingsV1Schema.safeParse(raw);
    if (!parsed.success) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
    const { writeMemorySettingsToDisk } = await import('@/settings/memorySettings');
    const next = await writeMemorySettingsToDisk(parsed.data);
    // Persistence acknowledges the user's change. Native discovery, index
    // reconciliation and draining stay serialized by the worker's lifecycle.
    void memoryWorker.reloadSettings().catch((error: unknown) => {
      logger.warn('[memoryWorker] Saved settings reconciliation failed', {
        message: error instanceof Error ? error.message : String(error),
      });
    });
    return next;
  });

  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_MEMORY_CLEAR_INDEX, async (raw: unknown, context) => {
    if (!z.strictObject({}).safeParse(raw ?? {}).success) {
      return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
    }
    await memoryWorker.clearIndex(context?.signal);
    return { ok: true };
  });

  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_MEMORY_ENSURE_UP_TO_DATE, async (raw: unknown, context) => {
    const parsed = EnsureUpToDateParamsSchema.safeParse(raw ?? {});
    if (!parsed.success) {
      return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
    }
    await memoryWorker.ensureUpToDate(parsed.data.sessionId, context?.signal);
    return { ok: true };
  });

  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_MEMORY_SEARCH, async (raw: unknown, context): Promise<MemorySearchResultV1> => {
    const parsed = MemorySearchQueryV1Schema.safeParse(raw);
    if (!parsed.success) {
      return { v: 1, ok: false, errorCode: 'memory_invalid_query', error: 'memory_invalid_query' };
    }

    await memoryWorker.waitForReady(context?.signal);
    const settings = memoryWorker.getSettings();
    if (!settings.enabled) return disabledResult();
    if (parsed.data.scope.type === 'project' && !memoryWorker.resolveDocumentSearchScope) {
      return { v: 1, ok: false, errorCode: 'memory_project_scope_unsupported', error: 'memory_project_scope_unsupported' };
    }

    const mode = parsed.data.mode;
    const corpora = resolveMemorySearchCorporaV1(parsed.data);
    const externalRequested = corpora.includes('external_transcripts');
    const externalEnabled = settings.conversationSearch.indexExternal.enabled;
    const query = externalRequested && !externalEnabled && parsed.data.scope.type !== 'project'
      ? { ...parsed.data, corpora: parsed.data.corpora?.filter(corpus => corpus !== 'external_transcripts') }
      : parsed.data;
    const deepSessions = mode === 'deep' || (mode === 'auto' && settings.indexMode === 'deep');
    const preferDeep = deepSessions || corpora.includes('documents')
      || (externalRequested && externalEnabled);

    if (preferDeep) {
      const deepPath = memoryWorker.getDeepDbPath();
      if (!deepPath) return { v: 1, ok: false, errorCode: 'memory_index_missing', error: 'memory_index_missing' };
      const embeddings = resolveOperationalMemoryEmbeddingsSettings(settings.embeddings);
      const embedQuery = embeddings?.enabled && memoryWorker.embedQuery
        ? async (text: string, signal?: AbortSignal) => await memoryWorker.embedQuery!(text, signal) ?? new Float32Array()
        : undefined;
      return await searchTier2Memory({
        dbPath: deepPath,
        query,
        externalAgentIds: settings.conversationSearch.indexExternal.agents,
        ...(!deepSessions && memoryWorker.getTier1DbPath()
          ? { sessionSummaryDbPath: memoryWorker.getTier1DbPath()! } : {}),
        previewChars: settings.deep.previewChars,
        candidateLimit: settings.deep.candidateLimit,
        ...(embeddings ? { embeddings } : {}),
        ...(embedQuery ? { embedQuery } : {}),
        ...(context?.signal ? { signal: context.signal } : {}),
        ...(memoryWorker.resolveDocumentSearchScope ? { resolveDocuments: memoryWorker.resolveDocumentSearchScope } : {}),
      });
    }

    const tier1Path = memoryWorker.getTier1DbPath();
    if (!tier1Path) return { v: 1, ok: false, errorCode: 'memory_index_missing', error: 'memory_index_missing' };
    const projectScope = query.scope.type === 'project' && memoryWorker.resolveDocumentSearchScope
      ? await memoryWorker.resolveDocumentSearchScope(query.scope, context?.signal) : undefined;
    return searchTier1Memory({ dbPath: tier1Path, query, ...(projectScope ? { projectScope } : {}) });
  });

  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_MEMORY_GET_WINDOW, async (raw: unknown, context): Promise<MemoryWindowV1> => {
    const parsed = MemoryWindowRequestV1Schema.safeParse(raw);
    if (!parsed.success) {
      return MemoryWindowV1Schema.parse({ v: 1, snippets: [], citations: [] });
    }
    await memoryWorker.waitForReady(context?.signal);
    const settings = memoryWorker.getSettings();
    if (!settings.enabled) {
      return MemoryWindowV1Schema.parse({ v: 1, snippets: [], citations: [] });
    }

    if (parsed.data.source !== undefined) {
      const external = settings.conversationSearch.indexExternal;
      if (!external.enabled || !external.agents.includes(parsed.data.source.agentId) || !memoryWorker.readExternalTranscriptPage) {
        return MemoryWindowV1Schema.parse({ v: 1, snippets: [], citations: [], externalSnippets: [] });
      }
      const deepDbPath = memoryWorker.getDeepDbPath();
      const db = deepDbPath ? openDeepIndexReader({ dbPath: deepDbPath }) : undefined;
      try {
        return MemoryWindowV1Schema.parse(await getMemoryWindow({
          source: parsed.data.source, sourceItemId: parsed.data.sourceItemId,
          ...(parsed.data.cursor ? { cursor: parsed.data.cursor } : {}),
          paddingMessages: settings.hints.paddingMessagesOnVerify,
          contentPolicy: { ...settings.contentPolicy, includeToolOutputs: external.includeToolOutput },
          db,
          fetchExternalTranscriptPage: memoryWorker.readExternalTranscriptPage,
          ...(context?.signal ? { signal: context.signal } : {}),
        }));
      } finally { db?.close(); }
    }

    const { readStoredCredentials } = await import('@/persistence');
    const credentials = await readStoredCredentials();
    if (!credentials) {
      return MemoryWindowV1Schema.parse({
        v: 1,
        snippets: [],
        citations: [{ sessionId: parsed.data.sessionId, seqFrom: parsed.data.seqFrom, seqTo: parsed.data.seqTo }],
      });
    }

    const window = await getMemoryWindow({
      credentials,
      sessionId: parsed.data.sessionId,
      seqFrom: parsed.data.seqFrom,
      seqTo: parsed.data.seqTo,
      paddingMessages: memoryWorker.getSettings().hints.paddingMessagesOnVerify,
      contentPolicy: settings.contentPolicy,
      ...(context?.signal ? { signal: context.signal } : {}),
    });
    return MemoryWindowV1Schema.parse(window);
  });
}
