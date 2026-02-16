import { chmodSync, mkdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import type { Credentials } from '@/persistence';
import { DEFAULT_MEMORY_SETTINGS, readMemorySettingsFromDisk, type MemorySettingsV1 } from '@/settings/memorySettings';
import { configuration } from '@/configuration';

import { resolveMemoryIndexPaths } from './memoryIndexPaths';
import { openSummaryShardIndexDb, type SummaryShardIndexDbHandle } from './summaryShardIndexDb';
import { openDeepIndexDb, type DeepIndexDbHandle } from './deepIndex/deepIndexDb';
import type { DecryptedTranscriptRow } from '@/session/replay/decryptTranscriptRows';
import { ingestSummaryShardsFromDecryptedTranscriptRows } from './ingestSummaryShardsFromDecryptedTranscriptRows';
import { fetchSessionById } from '@/sessionControl/sessionsHttp';
import { resolveSessionEncryptionContextFromCredentials, type SessionEncryptionContext } from '@/sessionControl/sessionEncryptionContext';
import { fetchEncryptedTranscriptPageAfterSeq, fetchEncryptedTranscriptPageLatest } from '@/api/session/fetchEncryptedTranscriptWindow';
import { decryptTranscriptRows } from '@/session/replay/decryptTranscriptRows';
import { logger } from '@/ui/logger';
import { startSingleFlightIntervalLoop, type SingleFlightIntervalLoopHandle } from '@/daemon/lifecycle/singleFlightIntervalLoop';
import { fetchSessionsPage } from '@/sessionControl/sessionsHttp';
import { syncMemoryHintsForSessionsOnce } from './syncMemoryHintsForSessionsOnce';
import { runMemoryHintsExecutionRun } from './hints/runMemoryHintsExecutionRun';
import { commitMemoryHintArtifacts } from './hints/commitMemoryHintArtifacts';
import { chunkTranscriptRows } from './deepIndex/chunkTranscriptRows';
import { syncDeepIndexForSessionsOnce } from './deepIndex/syncDeepIndexForSessionsOnce';
import { resolveEmbeddingsProvider } from './deepIndex/embeddings/resolveEmbeddingsProvider';
import { selectSessionsForBackfill } from './inventory/selectSessionsForBackfill';
import { enforceMemoryDiskBudgets } from './enforceMemoryDiskBudgets';

export type MemoryWorkerHandle = Readonly<{
  stop: () => void;
  reloadSettings: () => Promise<void>;
  ensureUpToDate: (sessionId?: string) => Promise<void>;
  getSettings: () => MemorySettingsV1;
  getTier1DbPath: () => string | null;
  getDeepDbPath: () => string | null;
}>;

function isMemoryArtifactMeta(meta: unknown): boolean {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return false;
  const happier = (meta as Record<string, unknown>).happier;
  if (!happier || typeof happier !== 'object' || Array.isArray(happier)) return false;
  const kind = (happier as Record<string, unknown>).kind;
  return kind === 'session_summary_shard.v1' || kind === 'session_synopsis.v1';
}

function extractTextFromContent(role: 'user' | 'agent', content: unknown, opts: Readonly<{ includeAssistantAcpMessage: boolean }>): string | null {
  if (!content || typeof content !== 'object' || Array.isArray(content)) return null;
  const type = (content as Record<string, unknown>).type;
  if (type === 'text') {
    const text = (content as Record<string, unknown>).text;
    return typeof text === 'string' ? text : null;
  }
  if (opts.includeAssistantAcpMessage && role === 'agent' && type === 'acp') {
    const data = (content as Record<string, unknown>).data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    const t = (data as Record<string, unknown>).type;
    if (t === 'message' || t === 'reasoning') {
      const message = (data as Record<string, unknown>).message;
      return typeof message === 'string' ? message : null;
    }
  }
  return null;
}

function bestEffortChmod700(dir: string): void {
  if (process.platform === 'win32') return;
  try {
    chmodSync(dir, 0o700);
  } catch {
    // best-effort
  }
}

export function startMemoryWorker(params: Readonly<{
  credentials: Credentials;
  machineId: string;
  env?: NodeJS.ProcessEnv;
  deps?: Readonly<{
    fetchDecryptedTranscriptPageAfterSeq: (args: Readonly<{ sessionId: string; afterSeq: number; limit: number }>) => Promise<DecryptedTranscriptRow[]>;
  }>;
}>): MemoryWorkerHandle {
  let stopped = false;
  const paths = resolveMemoryIndexPaths();
  let settings: MemorySettingsV1 = DEFAULT_MEMORY_SETTINGS;
  let tier1: SummaryShardIndexDbHandle | null = null;
  let deep: DeepIndexDbHandle | null = null;
  let inventoryLoop: SingleFlightIntervalLoopHandle | null = null;
  let inventoryLoopIntervalMs: number | null = null;
  let workLoop: SingleFlightIntervalLoopHandle | null = null;
  let workLoopIntervalMs: number | null = null;
  let candidateSessionIds: string[] = [];
  let candidateCursor = 0;
  let inventoryCursor: string | null = null;
  let inventoryHasNext = true;
  let inventoryBackfillPolicy: MemorySettingsV1['backfillPolicy'] = 'new_only';
  const inventorySeenSessionIds = new Set<string>();
  const sessionCtxCache = new Map<string, SessionEncryptionContext>();

  const deps =
    params.deps ??
    ({
      fetchDecryptedTranscriptPageAfterSeq: async (
        args: Readonly<{ sessionId: string; afterSeq: number; limit: number }>,
      ): Promise<DecryptedTranscriptRow[]> => {
        try {
          let ctx = sessionCtxCache.get(args.sessionId);
          if (!ctx) {
            const raw = await fetchSessionById({ token: params.credentials.token, sessionId: args.sessionId });
            if (!raw) return [];
            ctx = resolveSessionEncryptionContextFromCredentials(params.credentials, raw);
            sessionCtxCache.set(args.sessionId, ctx);
          }

          const encrypted = await fetchEncryptedTranscriptPageAfterSeq({
            token: params.credentials.token,
            sessionId: args.sessionId,
            afterSeq: args.afterSeq,
            limit: args.limit,
          });

          return decryptTranscriptRows({ ctx, rows: encrypted });
        } catch (error) {
          logger.debug('[memoryWorker] Failed to fetch/decrypt transcript page (best-effort)', {
            message: error instanceof Error ? error.message : String(error),
          });
          return [];
        }
      },
    } as const);

  const stopLoop = (): void => {
    inventoryLoop?.stop();
    inventoryLoop = null;
    inventoryLoopIntervalMs = null;
    workLoop?.stop();
    workLoop = null;
    workLoopIntervalMs = null;
    candidateSessionIds = [];
    candidateCursor = 0;
    inventoryCursor = null;
    inventoryHasNext = true;
    inventoryBackfillPolicy = 'new_only';
    inventorySeenSessionIds.clear();
  };

  const stop = () => {
    if (stopped) return;
    stopped = true;
    stopLoop();
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
  };

  const syncHintsForSessions = async (sessionIds: readonly string[]): Promise<void> => {
    if (stopped) return;
    if (!settings.enabled) return;
    if (!tier1) return;
    if (sessionIds.length === 0) return;

    await syncMemoryHintsForSessionsOnce({
      sessionIds,
      tier1,
      settings: {
        enabled: settings.enabled,
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
      },
      now: () => Date.now(),
      fetchRecentDecryptedRows: async (sessionId) => {
        let ctx = sessionCtxCache.get(sessionId);
        if (!ctx) {
          const raw = await fetchSessionById({ token: params.credentials.token, sessionId });
          if (!raw) return [];
          ctx = resolveSessionEncryptionContextFromCredentials(params.credentials, raw);
          sessionCtxCache.set(sessionId, ctx);
        }
        const encrypted = await fetchEncryptedTranscriptPageLatest({
          token: params.credentials.token,
          sessionId,
          limit: configuration.memoryMaxTranscriptWindowMessages,
        });
        const decrypted = decryptTranscriptRows({ ctx, rows: encrypted });
        // Latest API returns newest first; normalize to chronological.
        return decrypted.slice().sort((a, b) => a.seq - b.seq);
      },
      runSummarizer: async (prompt, sessionId) => {
        return await runMemoryHintsExecutionRun({
          cwd: configuration.activeServerDir,
          sessionId,
          backendId: settings.hints.summarizerBackendId,
          modelId: settings.hints.summarizerModelId,
          permissionMode: settings.hints.summarizerPermissionMode,
          prompt,
        });
      },
      commitArtifacts: async ({ sessionId, shardPayload, synopsisPayload }) => {
        let ctx = sessionCtxCache.get(sessionId);
        if (!ctx) {
          const raw = await fetchSessionById({ token: params.credentials.token, sessionId });
          if (!raw) return;
          ctx = resolveSessionEncryptionContextFromCredentials(params.credentials, raw);
          sessionCtxCache.set(sessionId, ctx);
        }
        await commitMemoryHintArtifacts({
          credentials: params.credentials,
          sessionId,
          ctx,
          shard: { sessionId, payload: shardPayload },
          synopsis: synopsisPayload ? { sessionId, payload: synopsisPayload } : null,
        });
      },
    });
  };

  const syncDeepForSessions = async (sessionIds: readonly string[]): Promise<void> => {
    if (stopped) return;
    if (!settings.enabled) return;
    if (settings.indexMode !== 'deep') return;
    if (!tier1) return;
    if (!deep) return;
    if (sessionIds.length === 0) return;

    const embeddingsProvider = await (async () => {
      if (!settings.embeddings.enabled) return null;
      const cacheDir = join(paths.modelsDir, 'transformers');
      try {
        mkdirSync(cacheDir, { recursive: true });
        bestEffortChmod700(cacheDir);
      } catch {
        // best-effort
      }
      return await resolveEmbeddingsProvider({ settings: settings.embeddings, cacheDir });
    })();

    await syncDeepIndexForSessionsOnce({
      sessionIds,
      tier1,
      deep,
      settings: {
        enabled: settings.enabled,
        indexMode: 'deep',
        deep: {
          maxChunkChars: settings.deep.maxChunkChars,
          maxChunkMessages: settings.deep.maxChunkMessages,
          minChunkMessages: settings.deep.minChunkMessages,
          includeAssistantAcpMessage: settings.deep.includeAssistantAcpMessage,
          failureBackoffBaseMs: settings.deep.failureBackoffBaseMs,
          failureBackoffMaxMs: settings.deep.failureBackoffMaxMs,
        },
        ...(settings.embeddings.enabled
          ? { embeddings: { enabled: true, provider: settings.embeddings.provider, modelId: settings.embeddings.modelId } }
          : {}),
      },
      now: () => Date.now(),
      fetchDecryptedTranscriptPageAfterSeq: deps.fetchDecryptedTranscriptPageAfterSeq,
      ...(embeddingsProvider ? { embedDocuments: embeddingsProvider.embedDocuments } : {}),
    });
  };

  const applySettings = async (next: MemorySettingsV1): Promise<void> => {
    settings = next;
    if (stopped) return;

    if (!settings.enabled) {
      stopLoop();
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
        await rm(paths.memoryDir, { recursive: true, force: true }).catch(() => {});
      }
      return;
    }

    mkdirSync(paths.memoryDir, { recursive: true });
    bestEffortChmod700(paths.memoryDir);
    mkdirSync(paths.modelsDir, { recursive: true });
    bestEffortChmod700(paths.modelsDir);

    if (inventoryBackfillPolicy !== settings.backfillPolicy) {
      inventoryBackfillPolicy = settings.backfillPolicy;
      inventoryCursor = null;
      inventoryHasNext = true;
      inventorySeenSessionIds.clear();
      candidateSessionIds = [];
      candidateCursor = 0;
    }

    if (!tier1) {
      tier1 = openSummaryShardIndexDb({ dbPath: paths.tier1DbPath });
      tier1.init();
    }

    if (settings.indexMode === 'deep') {
      if (!deep) {
        deep = openDeepIndexDb({ dbPath: paths.deepDbPath });
        deep.init();
      }
    } else if (deep) {
      try {
        deep.close();
      } catch {
        // best-effort
      }
      deep = null;
    }

    // Background indexing runs only in daemon mode.
    if (configuration.isDaemonProcess) {
      const inventoryIntervalMs = Math.max(5_000, Math.trunc(settings.worker.inventoryRefreshIntervalMs));
      if (!inventoryLoop || inventoryLoopIntervalMs !== inventoryIntervalMs) {
        inventoryLoop?.stop();
        inventoryLoopIntervalMs = inventoryIntervalMs;
        inventoryLoop = startSingleFlightIntervalLoop({
          intervalMs: inventoryIntervalMs,
          task: async () => {
            if (stopped) return;
            if (!settings.enabled) return;
            if (settings.backfillPolicy === 'new_only') {
              const page = await fetchSessionsPage({
                token: params.credentials.token,
                activeOnly: true,
                limit: settings.worker.sessionListPageLimit,
              });
              candidateSessionIds = page.sessions
                .map((s) => (typeof s.id === 'string' ? String(s.id) : ''))
                .filter((id) => id.trim().length > 0);
              candidateCursor = 0;
              inventoryCursor = null;
              inventoryHasNext = true;
              inventorySeenSessionIds.clear();
              inventoryBackfillPolicy = settings.backfillPolicy;
              return;
            }

            const cursor = inventoryHasNext ? inventoryCursor ?? undefined : undefined;
            const page = await fetchSessionsPage({
              token: params.credentials.token,
              cursor,
              activeOnly: false,
              limit: settings.worker.sessionListPageLimit,
            });

            const selected = selectSessionsForBackfill({
              sessions: page.sessions,
              backfillPolicy: settings.backfillPolicy,
              nowMs: Date.now(),
            });

            for (const id of selected.sessionIds) {
              if (inventorySeenSessionIds.has(id)) continue;
              inventorySeenSessionIds.add(id);
              candidateSessionIds.push(id);
            }

            if (inventoryHasNext) {
              if (selected.shouldStopPaging) {
                inventoryCursor = null;
                inventoryHasNext = false;
              } else {
                inventoryCursor = page.nextCursor;
                inventoryHasNext = Boolean(page.hasNext);
              }
            } else {
              inventoryCursor = null;
            }
          },
          onError: (error) => {
            logger.debug('[memoryWorker] Inventory refresh failed (best-effort)', {
              message: error instanceof Error ? error.message : String(error),
            });
          },
        });
        inventoryLoop.trigger();
      }

      const tickIntervalMs = Math.max(500, Math.trunc(settings.worker.tickIntervalMs));
      if (!workLoop || workLoopIntervalMs !== tickIntervalMs) {
        workLoop?.stop();
        workLoopIntervalMs = tickIntervalMs;
        workLoop = startSingleFlightIntervalLoop({
          intervalMs: tickIntervalMs,
          task: async () => {
            if (stopped) return;
            if (!settings.enabled) return;
            if (!tier1) return;
            if (candidateSessionIds.length === 0) return;

            const maxSessions = Math.max(1, Math.trunc(settings.worker.maxSessionsPerTick));
            const sessionIds: string[] = [];
            for (let i = 0; i < maxSessions; i += 1) {
              if (candidateSessionIds.length === 0) break;
              const idx = candidateCursor % candidateSessionIds.length;
              const id = candidateSessionIds[idx];
              candidateCursor = (candidateCursor + 1) % candidateSessionIds.length;
              if (!id) continue;
              sessionIds.push(id);
            }

            if (sessionIds.length === 0) return;
            await syncHintsForSessions(sessionIds);
            await syncDeepForSessions(sessionIds);

            if (tier1) {
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
            }
          },
          onError: (error) => {
            logger.debug('[memoryWorker] Tick failed (best-effort)', {
              message: error instanceof Error ? error.message : String(error),
            });
          },
        });
        workLoop.trigger();
      }
    }
  };

  const reloadSettings = async (): Promise<void> => {
    if (stopped) return;
    const next = await readMemorySettingsFromDisk();
    await applySettings(next);
  };

  const ensureUpToDate = async (_sessionId?: string): Promise<void> => {
    if (stopped) return;
    await reloadSettings();
    if (!settings.enabled) return;
    if (!_sessionId) return;
    if (!tier1) return;

    // Phase 3+: ingest any already-written summary shard artifacts from transcript history.
    // This is a building block for lazy/local index rebuilds without re-running the summarizer.
    const rows = await deps.fetchDecryptedTranscriptPageAfterSeq({
      sessionId: _sessionId,
      afterSeq: 0,
      limit: 500,
    });
    ingestSummaryShardsFromDecryptedTranscriptRows({ sessionId: _sessionId, rows, tier1 });

    if (settings.indexMode === 'deep' && deep) {
      const indexable: Array<{ seq: number; createdAtMs: number; text: string; role: 'user' | 'agent' }> = [];
      for (const row of rows) {
        if (isMemoryArtifactMeta(row.meta)) continue;
        const text = extractTextFromContent(row.role, row.content, { includeAssistantAcpMessage: settings.deep.includeAssistantAcpMessage });
        if (!text || text.trim().length === 0) continue;
        indexable.push({ seq: row.seq, createdAtMs: row.createdAtMs, text: text.trim(), role: row.role });
      }
      for (const chunk of chunkTranscriptRows({
        rows: indexable,
        settings: {
          maxChunkChars: settings.deep.maxChunkChars,
          maxChunkMessages: settings.deep.maxChunkMessages,
          minChunkMessages: settings.deep.minChunkMessages,
        },
      })) {
        deep.insertChunk({
          sessionId: _sessionId,
          seqFrom: chunk.seqFrom,
          seqTo: chunk.seqTo,
          createdAtFromMs: chunk.createdAtFromMs,
          createdAtToMs: chunk.createdAtToMs,
          text: chunk.text,
        });
      }
      const lastSeq = rows.length > 0 ? rows[rows.length - 1]!.seq : 0;
      tier1.markDeepIndexSuccess({ sessionId: _sessionId, seqTo: lastSeq, nowMs: Date.now() });
    }

    if (configuration.isDaemonProcess) {
      await syncHintsForSessions([_sessionId]);
    }
  };

  return {
    stop,
    reloadSettings,
    ensureUpToDate,
    getSettings: () => settings,
    getTier1DbPath: () => (tier1 ? paths.tier1DbPath : null),
    getDeepDbPath: () => (deep ? paths.deepDbPath : null),
  };
}
