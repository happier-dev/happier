import { chmodSync, mkdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';

import type { SessionSummaryShardV1 } from '@happier-dev/protocol';

import type { StoredCredentials } from '@/persistence';
import { DEFAULT_MEMORY_SETTINGS, readMemorySettingsFromDisk, type MemorySettingsV1 } from '@/settings/memorySettings';
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
import { startSingleFlightIntervalLoop, type SingleFlightIntervalLoopHandle } from '@/daemon/lifecycle/singleFlightIntervalLoop';
import { fetchSessionsPage } from '@/session/transport/http/sessionsHttp';
import { syncMemoryHintsForSessionsOnce } from './syncMemoryHintsForSessionsOnce';
import { runMemoryHintsExecutionRun } from './hints/runMemoryHintsExecutionRun';
import { commitMemorySystemRecords } from '@/session/systemRecords/memory/commitMemorySystemRecords';
import { fetchMemorySummaryShardSystemRecords } from '@/session/systemRecords/memory/fetchMemorySystemRecords';
import { logServerEndpointFailure } from '@/api/client/serverEndpointFailureLog';
import { chunkTranscriptRows } from './deepIndex/chunkTranscriptRows';
import { syncDeepIndexForSessionsOnce } from './deepIndex/syncDeepIndexForSessionsOnce';
import { resolveEmbeddingsProvider } from './deepIndex/embeddings/resolveEmbeddingsProvider';
import { ensurePrivateInferenceDirectory, resolveInferenceCacheDir } from '@/daemon/inference/inferencePaths';
import {
  buildUnavailableMemoryEmbeddingsDiagnostics,
  resolveOperationalMemoryEmbeddingsSettings,
  type OperationalMemoryEmbeddingsDiagnostics,
} from './resolveOperationalMemoryEmbeddingsSettings';
import { selectSessionsForBackfill } from './inventory/selectSessionsForBackfill';
import { enforceMemoryDiskBudgets } from './enforceMemoryDiskBudgets';
import { deriveSettingsSecretsReadKeysForCredentials } from '@/settings/secrets/settingsSecretsKey';
import type { EmbeddingsProviderResolution } from './deepIndex/embeddings/embeddingsProviderTypes';
import { fetchMemorySemanticTranscriptPage } from './transcript/fetchSemanticPage';
import {
  extractMemoryIndexableTranscriptItemFromDecryptedRow,
} from './transcript/extractIndexableItem';
import { isLegacyUnclassifiedTranscriptRow } from './transcript/legacyUnclassifiedTranscriptRows';
import { AccountEncryptionMaterialUnavailableError } from '@/api/client/encryptionKey';

export type MemoryWorkerHandle = Readonly<{
  stop: () => void;
  reloadSettings: () => Promise<void>;
  ensureUpToDate: (sessionId?: string) => Promise<void>;
  getSettings: () => MemorySettingsV1;
  getEmbeddingsDiagnostics: () => OperationalMemoryEmbeddingsDiagnostics;
  getWorkerStatus: () => Readonly<{
    state: 'disabled' | 'idle' | 'inventorying' | 'indexing' | 'waiting' | 'backoff' | 'error';
    lastTickAtMs: number | null;
    lastInventoryAtMs: number | null;
    currentSessionId: string | null;
    currentPhase: string | null;
  }>;
  getTier1DbPath: () => string | null;
  getDeepDbPath: () => string | null;
}>;

function bestEffortChmod700(dir: string): void {
  if (process.platform === 'win32') return;
  try {
    chmodSync(dir, 0o700);
  } catch {
    // best-effort
  }
}

function readSessionCreatedAtMs(raw: unknown): number {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 0;
  const createdAt = (raw as Record<string, unknown>).createdAt;
  const n = typeof createdAt === 'number' ? createdAt : Number(createdAt);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.trunc(n);
}

function logMemoryWorkerServerEndpointFailure(operation: string, error: unknown): void {
  logServerEndpointFailure({
    logger,
    operation: `memory worker ${operation}`,
    error,
  });
}

export async function startMemoryWorker(params: Readonly<{
  credentials: StoredCredentials;
  machineId: string;
  env?: NodeJS.ProcessEnv;
  deps?: Readonly<{
    fetchDecryptedTranscriptPageAfterSeq: (args: Readonly<{ sessionId: string; afterSeq: number; limit: number }>) => Promise<DecryptedTranscriptRow[]>;
    fetchCommittedSummaryShards?: (sessionId: string) => Promise<SessionSummaryShardV1[]>;
  }>;
}>): Promise<MemoryWorkerHandle> {
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
  const candidateAllowInitialBackfillSessionIds = new Set<string>();
  let inventoryCursor: string | null = null;
  let inventoryHasNext = true;
  let inventoryBackfillPolicy: MemorySettingsV1['backfillPolicy'] = 'new_only';
  const inventorySeenSessionIds = new Set<string>();
  const candidateObservedSeqBySessionId = new Map<string, number>();
  const sessionCryptoContextCache = new Map<string, SessionStoredContentCryptoContext>();
  const settingsSecretsReadKeys = deriveSettingsSecretsReadKeysForCredentials(params.credentials);
  let embeddingsDiagnostics: OperationalMemoryEmbeddingsDiagnostics =
    buildUnavailableMemoryEmbeddingsDiagnostics(DEFAULT_MEMORY_SETTINGS.embeddings);
  let workerStatus: ReturnType<MemoryWorkerHandle['getWorkerStatus']> = {
    state: 'idle',
    lastTickAtMs: null,
    lastInventoryAtMs: null,
    currentSessionId: null,
    currentPhase: null,
  };

  const resolveSessionCryptoContext = async (
    sessionId: string,
  ): Promise<SessionStoredContentCryptoContext | null> => {
    const cached = sessionCryptoContextCache.get(sessionId);
    if (cached) return cached;

    const raw = await fetchSessionById({ token: params.credentials.token, sessionId });
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

  const refreshEmbeddingsDiagnostics = async (): Promise<EmbeddingsProviderResolution | null> => {
    const embeddings = resolveOperationalMemoryEmbeddingsSettings(settings.embeddings);
    if (!embeddings?.enabled || !embeddings.providerConfig || !embeddings.providerKind || !embeddings.modelId) {
      embeddingsDiagnostics = buildUnavailableMemoryEmbeddingsDiagnostics(settings.embeddings);
      return null;
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
    });
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

  const deps =
    params.deps ??
    ({
      fetchDecryptedTranscriptPageAfterSeq: async (
        args: Readonly<{ sessionId: string; afterSeq: number; limit: number }>,
      ): Promise<DecryptedTranscriptRow[]> => {
        try {
          const cryptoContext = await resolveSessionCryptoContext(args.sessionId);
          if (!cryptoContext) return [];

          const roleFiltered = await fetchEncryptedTranscriptMessagesPage({
            token: params.credentials.token,
            sessionId: args.sessionId,
            afterSeq: args.afterSeq,
            limit: args.limit,
            roles: ['user', 'agent'],
            scope: 'main',
          });
          const legacy = await fetchEncryptedTranscriptMessagesPage({
            token: params.credentials.token,
            sessionId: args.sessionId,
            afterSeq: args.afterSeq,
            limit: args.limit,
            scope: 'main',
          });

          return decryptTranscriptRows({
            ctx: cryptoContext.ctx,
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

  const stopLoop = (): void => {
    inventoryLoop?.stop();
    inventoryLoop = null;
    inventoryLoopIntervalMs = null;
    workLoop?.stop();
    workLoop = null;
    workLoopIntervalMs = null;
    candidateSessionIds = [];
    candidateCursor = 0;
    candidateAllowInitialBackfillSessionIds.clear();
    candidateObservedSeqBySessionId.clear();
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

  const syncHintsForSessions = async (
    sessionIds: readonly string[],
    options?: Readonly<{ allowInitialBackfillWhenUninitializedSessionIds?: readonly string[] }>,
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
      initialCursorSeqBySessionId: candidateObservedSeqBySessionId,
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
        coveragePolicy: settings.coveragePolicy,
        contentPolicy: settings.contentPolicy,
      },
      now: () => Date.now(),
      fetchRecentDecryptedRows: async (sessionId) => {
        try {
          const cryptoContext = await resolveSessionCryptoContext(sessionId);
          if (!cryptoContext) return [];
          const rawPageLimit = Math.max(1, Math.trunc(configuration.memoryMaxTranscriptWindowMessages));
          const rows: DecryptedTranscriptRow[] = [];
          let beforeSeq: number | undefined;
          const maxPages = settings.coveragePolicy?.type === 'latest_messages' ? 1 : 100;
          for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
            const page = await fetchMemorySemanticTranscriptPage({
              token: params.credentials.token,
              sessionId,
              ctx: cryptoContext.ctx,
              limit: rawPageLimit,
              rawPageLimit,
              maxRawRowsToScan: rawPageLimit * 4,
              direction: 'before',
              ...(typeof beforeSeq === 'number' ? { beforeSeq } : {}),
              contentPolicy: settings.contentPolicy,
            });
            if (page.items.length > 0) {
              for (const item of page.items) {
                rows.push({
                  seq: item.seq,
                  createdAtMs: item.createdAtMs,
                  role: item.role === 'user' ? 'user' : 'agent',
                  content: { type: 'text', text: item.text },
                  meta: null,
                });
              }
            }
            if (!page.hasMore || !page.nextCursor) break;
            beforeSeq = Number.parseInt(page.nextCursor, 10);
            if (!Number.isFinite(beforeSeq)) break;
          }
          return rows.sort((a, b) => a.seq - b.seq);
        } catch (error) {
          if (!(error instanceof AccountEncryptionMaterialUnavailableError)) {
            logMemoryWorkerServerEndpointFailure('selected transcript rows', error);
          }
          throw error;
        }
      },
      fetchCommittedSummaryShards,
      runSummarizer: async (prompt, sessionId) => {
        return await runMemoryHintsExecutionRun({
          cwd: configuration.activeServerDir,
          sessionId,
          backendId: settings.hints.summarizerBackendId,
          modelId: settings.hints.summarizerModelId,
          permissionMode: settings.hints.summarizerPermissionMode,
          prompt,
          credentials: params.credentials,
        });
      },
      commitArtifacts: async ({ sessionId, shardPayload, synopsisPayload }) => {
        const cryptoContext = await resolveSessionCryptoContext(sessionId);
        if (!cryptoContext) return;
        await commitMemorySystemRecords({
          credentials: params.credentials,
          sessionId,
          mode: cryptoContext.mode,
          ...(cryptoContext.ctx ? { ctx: cryptoContext.ctx } : {}),
          shard: { sessionId, payload: shardPayload },
          synopsis: synopsisPayload ? { sessionId, payload: synopsisPayload } : null,
        });
      },
    });
  };

  const fetchCommittedSummaryShards = async (sessionId: string): Promise<SessionSummaryShardV1[]> => {
    if (deps.fetchCommittedSummaryShards) {
      return await deps.fetchCommittedSummaryShards(sessionId);
    }
    try {
      const cryptoContext = await resolveSessionCryptoContext(sessionId);
      if (!cryptoContext) return [];
      return await fetchMemorySummaryShardSystemRecords({
        token: params.credentials.token,
        sessionId,
        mode: cryptoContext.mode,
        ...(cryptoContext.ctx ? { ctx: cryptoContext.ctx } : {}),
      });
    } catch (error) {
      if (!(error instanceof AccountEncryptionMaterialUnavailableError)) {
        logMemoryWorkerServerEndpointFailure('summary system records', error);
      }
      throw error;
    }
  };

  const ingestCommittedSummaryShards = async (sessionId: string): Promise<void> => {
    if (!tier1) return;
    const nowMs = Date.now();
    for (const shard of await fetchCommittedSummaryShards(sessionId)) {
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
      });
      tier1.markHintRunSuccess({ sessionId, seqTo: shard.seqTo, nowMs });
    }
  };

  const syncDeepForSessions = async (sessionIds: readonly string[]): Promise<void> => {
    if (stopped) return;
    if (!settings.enabled) return;
    if (settings.indexMode !== 'deep') return;
    if (!tier1) return;
    if (!deep) return;
    if (sessionIds.length === 0) return;

    const embeddings = resolveOperationalMemoryEmbeddingsSettings(settings.embeddings);
    const embeddingsResolution = await refreshEmbeddingsDiagnostics();

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
        coveragePolicy: settings.coveragePolicy,
        contentPolicy: settings.contentPolicy,
        ...(embeddings ? { embeddings } : {}),
      },
      now: () => Date.now(),
      fetchDecryptedTranscriptPageAfterSeq: deps.fetchDecryptedTranscriptPageAfterSeq,
      ...(embeddingsResolution?.provider ? { embedDocuments: embeddingsResolution.provider.embedDocuments } : {}),
    });
  };

  const applySettings = async (next: MemorySettingsV1): Promise<void> => {
    settings = next;
    if (stopped) return;

    if (!settings.enabled) {
      embeddingsDiagnostics = buildUnavailableMemoryEmbeddingsDiagnostics(settings.embeddings);
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

    embeddingsDiagnostics = buildUnavailableMemoryEmbeddingsDiagnostics(settings.embeddings);
    workerStatus = { ...workerStatus, state: 'idle' };

    mkdirSync(paths.memoryDir, { recursive: true });
    bestEffortChmod700(paths.memoryDir);
    ensurePrivateInferenceDirectory(paths.modelsDir);

    if (inventoryBackfillPolicy !== settings.backfillPolicy) {
      inventoryBackfillPolicy = settings.backfillPolicy;
      inventoryCursor = null;
      inventoryHasNext = true;
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

    await refreshEmbeddingsDiagnostics();

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
            workerStatus = { ...workerStatus, state: 'inventorying', lastInventoryAtMs: Date.now(), currentPhase: 'inventory' };
            if (settings.backfillPolicy === 'new_only') {
              const page = await fetchSessionsPage({
                token: params.credentials.token,
                activeOnly: false,
                limit: settings.worker.sessionListPageLimit,
              });
              const enabledAtMs = Math.max(0, Math.trunc(settings.enabledAtMs ?? 0));
              candidateAllowInitialBackfillSessionIds.clear();
              candidateObservedSeqBySessionId.clear();
              candidateSessionIds = page.sessions
                .map((session) => {
                  const id = typeof session.id === 'string' ? String(session.id).trim() : '';
                  if (!id) return null;
                  const seq = typeof session.seq === 'number' && Number.isFinite(session.seq)
                    ? Math.max(0, Math.trunc(session.seq))
                    : 0;
                  candidateObservedSeqBySessionId.set(id, seq);
                  if (enabledAtMs > 0 && readSessionCreatedAtMs(session) >= enabledAtMs) {
                    candidateAllowInitialBackfillSessionIds.add(id);
                  }
                  return id;
                })
                .filter((id): id is string => Boolean(id));
              candidateCursor = 0;
              inventoryCursor = null;
              inventoryHasNext = true;
              inventorySeenSessionIds.clear();
              inventoryBackfillPolicy = settings.backfillPolicy;
              return;
            }

            candidateAllowInitialBackfillSessionIds.clear();
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
              const row = page.sessions.find((session) => session.id === id);
              const seq = typeof row?.seq === 'number' && Number.isFinite(row.seq)
                ? Math.max(0, Math.trunc(row.seq))
                : 0;
              candidateObservedSeqBySessionId.set(id, seq);
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

            if (sessionIds.length === 0) return;
            workerStatus = { ...workerStatus, currentSessionId: sessionIds[0] ?? null };
            await syncHintsForSessions(sessionIds, { allowInitialBackfillWhenUninitializedSessionIds });
            await syncDeepForSessions(sessionIds);
            workerStatus = { ...workerStatus, state: 'idle', currentSessionId: null, currentPhase: null };

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
    if (!tier1) return;
    if (!_sessionId) {
      const page = await fetchSessionsPage({
        token: params.credentials.token,
        activeOnly: false,
        limit: settings.worker.sessionListPageLimit,
      });
      const sessionIds = page.sessions
        .map((session) => typeof session.id === 'string' ? session.id.trim() : '')
        .filter((sessionId) => sessionId.length > 0);
      if (sessionIds.length === 0) return;
      await syncHintsForSessions(sessionIds);
      await syncDeepForSessions(sessionIds);
      return;
    }

    await ingestCommittedSummaryShards(_sessionId);

    const rows = await deps.fetchDecryptedTranscriptPageAfterSeq({
      sessionId: _sessionId,
      afterSeq: 0,
      limit: 500,
    });

    if (settings.indexMode === 'deep' && deep) {
      const indexable = rows
        .map((row, index) => extractMemoryIndexableTranscriptItemFromDecryptedRow({
          sessionId: _sessionId,
          row,
          index,
          contentPolicy: settings.contentPolicy,
        }))
        .filter((item): item is NonNullable<typeof item> => item !== null)
        .map((item) => ({
          seq: item.seq,
          createdAtMs: item.createdAtMs,
          text: item.text,
          role: item.role === 'user' ? 'user' as const : 'agent' as const,
        }));
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
      const allowInitialBackfillWhenUninitializedSessionIds: string[] = [];
      if (settings.backfillPolicy === 'new_only' && settings.enabledAtMs > 0) {
        const raw = await fetchSessionById({ token: params.credentials.token, sessionId: _sessionId });
        if (raw && readSessionCreatedAtMs(raw) >= settings.enabledAtMs) {
          allowInitialBackfillWhenUninitializedSessionIds.push(_sessionId);
        }
      }
      await syncHintsForSessions([_sessionId], { allowInitialBackfillWhenUninitializedSessionIds });
    }
  };

  await reloadSettings();

  return {
    stop,
    reloadSettings,
    ensureUpToDate,
    getSettings: () => settings,
    getEmbeddingsDiagnostics: () => embeddingsDiagnostics,
    getWorkerStatus: () => workerStatus,
    getTier1DbPath: () => (tier1 ? paths.tier1DbPath : null),
    getDeepDbPath: () => (deep ? paths.deepDbPath : null),
  };
}
