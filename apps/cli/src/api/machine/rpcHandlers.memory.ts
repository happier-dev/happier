import { z } from 'zod';

import {
  MemorySearchQueryV1Schema,
  type MemorySearchResultV1,
  MemoryStatusV1Schema,
  MemoryWindowV1Schema,
  type MemoryWindowV1,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { searchTier1Memory, searchTier2Memory } from '@/daemon/memory/searchMemory';
import { getMemoryWindow } from '@/daemon/memory/getMemoryWindow';
import { openDeepIndexDb } from '@/daemon/memory/deepIndex/deepIndexDb';
import { openSummaryShardIndexDb } from '@/daemon/memory/summaryShardIndexDb';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

import { resolveMemoryIndexPaths } from '@/daemon/memory/memoryIndexPaths';
import { resolveOperationalMemoryEmbeddingsSettings } from '@/daemon/memory/resolveOperationalMemoryEmbeddingsSettings';
import { deriveSettingsSecretsReadKeysForCredentials } from '@/settings/secrets/settingsSecretsKey';

import type { RpcHandlerManager } from '../rpc/RpcHandlerManager';
import type { MemoryWorkerHandle } from '@/daemon/memory/memoryWorker';

const EnsureUpToDateParamsSchema = z
  .object({
    sessionId: z.string().min(1).optional(),
  })
  .passthrough();

const GetWindowParamsSchema = z
  .object({
    v: z.literal(1).optional(),
    sessionId: z.string().min(1),
    seqFrom: z.number().int().min(0),
    seqTo: z.number().int().min(0),
  })
  .passthrough()
  .superRefine((value, ctx) => {
    if (value.seqFrom > value.seqTo) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'seqFrom must be <= seqTo', path: ['seqFrom'] });
    }
  });

function disabledResult(): MemorySearchResultV1 {
  return { v: 1, ok: false, errorCode: 'memory_disabled', error: 'memory_disabled' };
}

export function registerMachineMemoryRpcHandlers(params: Readonly<{
  rpcHandlerManager: RpcHandlerManager;
  memoryWorker: MemoryWorkerHandle;
}>): void {
  const { rpcHandlerManager, memoryWorker } = params;

  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_MEMORY_STATUS, async () => {
    const settings = memoryWorker.getSettings();
    const embeddingsDiagnostics = memoryWorker.getEmbeddingsDiagnostics();
    const tier1DbPath = memoryWorker.getTier1DbPath();
    const deepDbPath = memoryWorker.getDeepDbPath();
    const hintsIndexReady = typeof tier1DbPath === 'string' && tier1DbPath.trim().length > 0;
    const deepIndexReady = typeof deepDbPath === 'string' && deepDbPath.trim().length > 0;
    const tier1Stats = (() => {
      if (!tier1DbPath) return null;
      try {
        const db = openSummaryShardIndexDb({ dbPath: tier1DbPath });
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
        const db = openDeepIndexDb({ dbPath: deepDbPath });
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

    const readBytes = async (path: string | null): Promise<number | null> => {
      if (!path) return null;
      try {
        const s = await stat(path);
        return typeof s.size === 'number' && Number.isFinite(s.size) ? Math.max(0, Math.trunc(s.size)) : null;
      } catch {
        return null;
      }
    };

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

    return MemoryStatusV1Schema.parse({
      v: 1,
      enabled: settings.enabled,
      indexMode: settings.indexMode,
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
      tier1DbBytes: await readBytes(tier1DbPath),
      deepDbBytes: await readBytes(deepDbPath),
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

  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_MEMORY_SETTINGS_GET, async () => {
    const { readMemorySettingsFromDisk } = await import('@/settings/memorySettings');
    return await readMemorySettingsFromDisk();
  });

  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_MEMORY_SETTINGS_SET, async (raw: unknown) => {
    const { writeMemorySettingsToDisk } = await import('@/settings/memorySettings');
    const next = await writeMemorySettingsToDisk(raw);
    await memoryWorker.reloadSettings();
    return next;
  });

  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_MEMORY_ENSURE_UP_TO_DATE, async (raw: unknown) => {
    const parsed = EnsureUpToDateParamsSchema.safeParse(raw ?? {});
    if (!parsed.success) {
      return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
    }
    await memoryWorker.ensureUpToDate(parsed.data.sessionId);
    return { ok: true };
  });

  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_MEMORY_SEARCH, async (raw: unknown): Promise<MemorySearchResultV1> => {
    const parsed = MemorySearchQueryV1Schema.safeParse(raw);
    if (!parsed.success) {
      return { v: 1, ok: false, errorCode: 'memory_invalid_query', error: 'memory_invalid_query' };
    }

    const settings = memoryWorker.getSettings();
    if (!settings.enabled) return disabledResult();

    const mode = parsed.data.mode;
    const preferDeep = mode === 'deep' || (mode === 'auto' && settings.indexMode === 'deep');

    if (preferDeep) {
      const deepPath = memoryWorker.getDeepDbPath();
      if (!deepPath) return { v: 1, ok: false, errorCode: 'memory_index_missing', error: 'memory_index_missing' };
      const embeddings = resolveOperationalMemoryEmbeddingsSettings(settings.embeddings);
      const embeddingsProviderSettings = resolveOperationalMemoryEmbeddingsSettings(settings.embeddings);
      const embedQuery = await (async () => {
        if (!embeddings?.enabled || !embeddingsProviderSettings?.enabled) return undefined;
        const paths = resolveMemoryIndexPaths();
        const cacheDir = join(paths.modelsDir, 'transformers');
        try {
          mkdirSync(cacheDir, { recursive: true });
        } catch {
          // best-effort
        }
        const { readCredentials } = await import('@/persistence');
        const credentials = await readCredentials();
        const { resolveEmbeddingsProvider } = await import('@/daemon/memory/deepIndex/embeddings/resolveEmbeddingsProvider');
        const provider = await resolveEmbeddingsProvider({
          settings: embeddingsProviderSettings,
          cacheDir,
          settingsSecretsReadKeys: credentials ? deriveSettingsSecretsReadKeysForCredentials(credentials) : [],
        });
        return provider.provider?.embedQuery;
      })();
      return await searchTier2Memory({
        dbPath: deepPath,
        query: parsed.data,
        previewChars: settings.deep.previewChars,
        candidateLimit: settings.deep.candidateLimit,
        ...(embeddings ? { embeddings } : {}),
        ...(embedQuery ? { embedQuery } : {}),
      });
    }

    const tier1Path = memoryWorker.getTier1DbPath();
    if (!tier1Path) return { v: 1, ok: false, errorCode: 'memory_index_missing', error: 'memory_index_missing' };
    return searchTier1Memory({ dbPath: tier1Path, query: parsed.data });
  });

  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_MEMORY_GET_WINDOW, async (raw: unknown): Promise<MemoryWindowV1> => {
    const parsed = GetWindowParamsSchema.safeParse(raw);
    if (!parsed.success) {
      return MemoryWindowV1Schema.parse({ v: 1, snippets: [], citations: [] });
    }
    const settings = memoryWorker.getSettings();
    if (!settings.enabled) {
      return MemoryWindowV1Schema.parse({ v: 1, snippets: [], citations: [] });
    }

    const { readCredentials } = await import('@/persistence');
    const credentials = await readCredentials();
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
    });
    return MemoryWindowV1Schema.parse(window);
  });
}
