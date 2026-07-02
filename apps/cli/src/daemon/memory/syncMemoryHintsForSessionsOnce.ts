import type { SessionSummaryShardV1, SessionSynopsisV1 } from '@happier-dev/protocol';

import type { DecryptedTranscriptRow } from '@/session/replay/decryptTranscriptRows';

import type { SummaryShardIndexDbHandle } from './summaryShardIndexDb';
import { buildMemorySummaryShardWindows } from './hints/buildMemorySummaryShardWindows';
import { buildMemoryShardSearchKeywords } from './hints/buildMemoryShardSearchKeywords';
import { generateMemoryHintsShard } from './hints/generateMemoryHintsShard';
import {
  extractMemoryIndexableTranscriptItemFromDecryptedRow,
} from './transcript/extractIndexableItem';
import type { MemoryContentPolicy } from './transcript/contentPolicy';

export type MemoryCoveragePolicy =
  | Readonly<{ type: 'full' }>
  | Readonly<{ type: 'latest_messages'; maxSemanticMessagesPerSession: number }>
  | Readonly<{ type: 'latest_days'; days: number }>
  | Readonly<{ type: 'since_enabled' }>;

export type SyncMemoryHintsSettings = Readonly<{
  enabled: boolean;
  indexMode: 'hints' | 'deep';
  backfillPolicy: 'new_only' | 'last_30_days' | 'all_history';
  coveragePolicy?: MemoryCoveragePolicy;
  contentPolicy?: MemoryContentPolicy;
  hints: Readonly<{
    updateMode: 'onIdle' | 'continuous';
    idleDelayMs: number;
    windowSizeMessages: number;
    targetShardMessages?: number;
    minShardMessages?: number;
    targetShardChars?: number;
    maxShardChars: number;
    maxSummaryChars: number;
    maxKeywords: number;
    maxEntities: number;
    maxDecisions: number;
    maxRunsPerHour: number;
    maxShardsPerSession: number;
    failureBackoffBaseMs: number;
    failureBackoffMaxMs: number;
  }>;
}>;

export async function syncMemoryHintsForSessionsOnce(params: Readonly<{
  sessionIds: readonly string[];
  allowInitialBackfillWhenUninitializedSessionIds?: readonly string[];
  initialCursorSeqBySessionId?: ReadonlyMap<string, number>;
  tier1: SummaryShardIndexDbHandle;
  settings: SyncMemoryHintsSettings;
  now: () => number;
  fetchRecentDecryptedRows: (sessionId: string) => Promise<DecryptedTranscriptRow[]>;
  fetchCommittedSummaryShards?: (sessionId: string) => Promise<SessionSummaryShardV1[]>;
  runSummarizer: (prompt: string, sessionId: string) => Promise<string>;
  commitArtifacts: (args: Readonly<{
    sessionId: string;
    shardPayload: SessionSummaryShardV1;
    synopsisPayload: SessionSynopsisV1 | null;
  }>) => Promise<void>;
}>): Promise<void> {
  if (!params.settings.enabled) return;
  if (params.settings.indexMode !== 'hints') return;

  const nowMs = params.now();
  const run = {
    sessionsConsidered: 0,
    sessionsProcessed: 0,
    sessionsIndexed: 0,
    rawRowsFetched: 0,
    semanticRowsFound: 0,
    lightShardsCreated: 0,
  };
  const allowInitialBackfillWhenUninitialized = new Set(
    (params.allowInitialBackfillWhenUninitializedSessionIds ?? [])
      .map((sessionId) => String(sessionId ?? '').trim())
      .filter((sessionId) => sessionId.length > 0),
  );

  for (const rawSessionId of params.sessionIds) {
    const sessionId = String(rawSessionId ?? '').trim();
    if (!sessionId) continue;
    run.sessionsConsidered += 1;

    if (params.settings.backfillPolicy === 'new_only' && !allowInitialBackfillWhenUninitialized.has(sessionId)) {
      const initialCursorSeq = params.initialCursorSeqBySessionId?.get(sessionId);
      if (typeof initialCursorSeq === 'number' && Number.isFinite(initialCursorSeq) && initialCursorSeq >= 0) {
        const seeded = params.tier1.trySeedSessionCursorsIfMissing({
          sessionId,
          nowMs,
          lastHintedSeq: Math.floor(initialCursorSeq),
          lastDeepIndexedSeq: Math.floor(initialCursorSeq),
        });
        if (seeded) continue;
      }
    }

    const committedSummaryShards = params.fetchCommittedSummaryShards
      ? await params.fetchCommittedSummaryShards(sessionId)
      : [];
    for (const shard of committedSummaryShards) {
      params.tier1.insertSummaryShard({
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
      params.tier1.markHintRunSuccess({ sessionId, seqTo: shard.seqTo, nowMs });
    }

    const rows = await params.fetchRecentDecryptedRows(sessionId);
    run.rawRowsFetched += rows.length;
    if (rows.length === 0) continue;
    run.sessionsProcessed += 1;

    const latestSeq = rows.length > 0 ? rows[rows.length - 1]!.seq : 0;
    if (params.settings.backfillPolicy === 'new_only' && !allowInitialBackfillWhenUninitialized.has(sessionId)) {
      const seeded = params.tier1.trySeedSessionCursorsIfMissing({
        sessionId,
        nowMs: nowMs,
        lastHintedSeq: latestSeq,
        lastDeepIndexedSeq: latestSeq,
      });
      if (seeded) continue;
    }

    const lastHintedSeq = params.tier1.getSessionCursors({ sessionId, nowMs }).lastHintedSeq;
    const eligibleRows = rows.filter((row) => row.seq > lastHintedSeq);
    if (eligibleRows.length === 0) continue;

    const indexableItems = eligibleRows
      .map((row, index) => extractMemoryIndexableTranscriptItemFromDecryptedRow({
        sessionId,
        row,
        index,
        contentPolicy: params.settings.contentPolicy,
      }))
      .filter((item): item is NonNullable<typeof item> => item !== null);
    run.semanticRowsFound += indexableItems.length;
    if (indexableItems.length === 0) continue;

    const lastCreatedAtMs = eligibleRows[eligibleRows.length - 1]!.createdAtMs;
    const idleDelayMs = Math.max(0, Math.trunc(params.settings.hints.idleDelayMs));
    if (params.settings.hints.updateMode === 'onIdle' && nowMs - lastCreatedAtMs < idleDelayMs) continue;

    const permitAcquired = params.tier1.tryAcquireHintRunPermit({
      sessionId,
      nowMs,
      maxRunsPerHour: params.settings.hints.maxRunsPerHour,
    });
    if (!permitAcquired) continue;

    const targetShardMessages = Math.max(1, Math.trunc(
      params.settings.hints.targetShardMessages ?? params.settings.hints.windowSizeMessages,
    ));
    const minShardMessages = Math.max(1, Math.trunc(
      params.settings.hints.minShardMessages ?? 1,
    ));
    const targetShardChars = Math.max(1, Math.trunc(
      params.settings.hints.targetShardChars ?? params.settings.hints.maxShardChars,
    ));
    const maxShardChars = Math.max(1, Math.trunc(
      params.settings.hints.maxShardChars ?? targetShardChars,
    ));

    const windows = buildMemorySummaryShardWindows({
      items: indexableItems,
      targetShardMessages,
      minShardMessages,
      targetShardChars,
      maxShardChars,
    });
    let indexedLightRows = 0;
    let lightShardCount = 0;
    let lastIndexedSeq = 0;

    for (const window of windows) {
      let generated: Awaited<ReturnType<typeof generateMemoryHintsShard>> | null = null;
      try {
        generated = await generateMemoryHintsShard({
          sessionId,
          items: window.items,
          previousSynopsis: null,
          budgets: {
            windowSizeMessages: targetShardMessages,
            maxShardChars,
          },
          hintSettings: {
            maxSummaryChars: params.settings.hints.maxSummaryChars,
            maxKeywords: params.settings.hints.maxKeywords,
            maxEntities: params.settings.hints.maxEntities,
            maxDecisions: params.settings.hints.maxDecisions,
          },
          run: async (prompt) => await params.runSummarizer(prompt, sessionId),
        });
      } catch {
        generated = null;
      }

      if (!generated || !generated.ok) {
        const code = generated ? generated.errorCode : 'invalid_model_output';
        if (code === 'invalid_model_output' || code === 'schema_validation_failed') {
          params.tier1.markHintRunFailure({
            sessionId,
            nowMs,
            backoffBaseMs: params.settings.hints.failureBackoffBaseMs,
            backoffMaxMs: params.settings.hints.failureBackoffMaxMs,
          });
        }
        continue;
      }

      const searchableShardPayload = {
        ...generated.shard.payload,
        keywords: buildMemoryShardSearchKeywords({
          modelKeywords: generated.shard.payload.keywords ?? [],
          items: window.items,
        }),
      };

      try {
        await params.commitArtifacts({
          sessionId,
          shardPayload: searchableShardPayload,
          synopsisPayload: generated.synopsis?.payload ?? null,
        });
      } catch {
        params.tier1.markHintRunFailure({
          sessionId,
          nowMs,
          backoffBaseMs: params.settings.hints.failureBackoffBaseMs,
          backoffMaxMs: params.settings.hints.failureBackoffMaxMs,
        });
        continue;
      }

      params.tier1.insertSummaryShard({
        sessionId,
        seqFrom: searchableShardPayload.seqFrom,
        seqTo: searchableShardPayload.seqTo,
        createdAtFromMs: searchableShardPayload.createdAtFromMs,
        createdAtToMs: searchableShardPayload.createdAtToMs,
        summary: searchableShardPayload.summary,
        keywords: searchableShardPayload.keywords ?? [],
        entities: searchableShardPayload.entities ?? [],
        decisions: searchableShardPayload.decisions ?? [],
      });
      params.tier1.markHintRunSuccess({ sessionId, seqTo: searchableShardPayload.seqTo, nowMs });
      params.tier1.enforceMaxShardsPerSession({ sessionId, maxShardsPerSession: params.settings.hints.maxShardsPerSession });
      indexedLightRows += window.items.length;
      lightShardCount += 1;
      lastIndexedSeq = Math.max(lastIndexedSeq, searchableShardPayload.seqTo);
      run.lightShardsCreated += 1;
    }

    if (lightShardCount > 0) {
      run.sessionsIndexed += 1;
      params.tier1.recordMemorySessionIndexState?.({
        sessionId,
        selectedByBackfillPolicy: params.settings.backfillPolicy,
        coveragePolicyJson: JSON.stringify(params.settings.coveragePolicy ?? { type: 'full' }),
        status: 'indexed',
        lastSuccessAtMs: nowMs,
        lastAttemptAtMs: nowMs,
        lastCompletedAtMs: nowMs,
        lastObservedSeq: latestSeq,
        lastScannedSeq: latestSeq,
        lastSemanticSeq: indexableItems[indexableItems.length - 1]!.seq,
        lastHintedSeq: lastIndexedSeq,
        rawRowsFetched: rows.length,
        semanticRowsFound: indexableItems.length,
        semanticRowsIndexedLight: indexedLightRows,
        lightShardCount,
        updatedAtMs: nowMs,
      });
    }
  }

  params.tier1.recordMemoryWorkerRun?.({
    runId: `hints-${nowMs}`,
    startedAtMs: nowMs,
    finishedAtMs: nowMs,
    trigger: 'sync_hints',
    indexMode: 'hints',
    sessionsConsidered: run.sessionsConsidered,
    sessionsProcessed: run.sessionsProcessed,
    sessionsIndexed: run.sessionsIndexed,
    rawRowsFetched: run.rawRowsFetched,
    semanticRowsFound: run.semanticRowsFound,
    lightShardsCreated: run.lightShardsCreated,
  });
}
