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
import {
  applyMemoryCoveragePolicy,
  memoryIndexPolicyKey,
  resolveMemoryCoverageCreatedAtCutoffMs,
  resolveMemoryIndexPolicy,
} from './transcript/coveragePolicy';

export type MemoryCoveragePolicy =
  | Readonly<{ type: 'full' }>
  | Readonly<{ type: 'latest_messages'; maxSemanticMessagesPerSession: number }>
  | Readonly<{ type: 'latest_days'; days: number }>
  | Readonly<{ type: 'since_enabled' }>;

export type SyncMemoryHintsSettings = Readonly<{
  enabled: boolean;
  indexMode: 'hints' | 'deep';
  backfillPolicy: 'new_only' | 'last_30_days' | 'all_history';
  enabledAtMs?: number;
  coveragePolicy?: MemoryCoveragePolicy;
  contentPolicy?: MemoryContentPolicy;
  hints: Readonly<{
    enabled: boolean;
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
  forceSnapshotSessionIds?: readonly string[];
  tier1: SummaryShardIndexDbHandle;
  settings: SyncMemoryHintsSettings;
  now: () => number;
  fetchRecentDecryptedRows: (sessionId: string, signal?: AbortSignal) => Promise<DecryptedTranscriptRow[]>;
  runSummarizer: (prompt: string, sessionId: string, signal?: AbortSignal) => Promise<string>;
  commitArtifacts: (args: Readonly<{
    sessionId: string;
    shardPayload: SessionSummaryShardV1;
    synopsisPayload: SessionSynopsisV1 | null;
  }>, signal?: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
}>): Promise<void> {
  if (!params.settings.enabled) return;
  if (params.settings.indexMode !== 'hints') return;

  const nowMs = params.now();
  const memoryPolicy = resolveMemoryIndexPolicy(params.settings);
  const policyKey = memoryIndexPolicyKey(memoryPolicy);
  const forceSnapshots = new Set(params.forceSnapshotSessionIds ?? []);
  if (!params.settings.hints.enabled) {
    // A disabled inference setting cannot authorize stale edited summaries.
    // Rebuild remains pending without reading source content or running a model.
    for (const rawSessionId of params.sessionIds) {
      params.signal?.throwIfAborted();
      const sessionId = String(rawSessionId ?? '').trim();
      if (!sessionId || !forceSnapshots.has(sessionId)) continue;
      params.tier1.pruneSessionArtifacts({ sessionId, policyKey: `${policyKey}:edited` });
      params.tier1.rewindSessionCursor({ sessionId, lane: 'hints', seq: 0 });
    }
    return;
  }
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
    params.signal?.throwIfAborted();
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

    const forceSnapshot = forceSnapshots.has(sessionId);
    const rows = await params.fetchRecentDecryptedRows(sessionId, params.signal);
    params.signal?.throwIfAborted();
    if (forceSnapshot) {
      // Read the current source first; same-sequence edits invalidate committed
      // source-derived summaries even when their policy provenance still matches.
      params.tier1.pruneSessionArtifacts({ sessionId, policyKey: `${policyKey}:edited` });
      params.tier1.rewindSessionCursor({ sessionId, lane: 'hints', seq: 0 });
    }
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

    const extractedItems = rows
      .map((row, index) => extractMemoryIndexableTranscriptItemFromDecryptedRow({
        sessionId,
        row,
        index,
        contentPolicy: params.settings.contentPolicy,
      }))
      .filter((item): item is NonNullable<typeof item> => item !== null);
    const indexableItems = applyMemoryCoveragePolicy({
      items: extractedItems,
      policy: params.settings.coveragePolicy,
      nowMs,
      enabledAtMs: params.settings.enabledAtMs ?? 0,
      backfillPolicy: params.settings.backfillPolicy,
    });
    if (forceSnapshot && indexableItems.length === 0) {
      params.tier1.markHintRunSuccess({ sessionId, seqTo: latestSeq, nowMs });
    }
    const coverageCutoffMs = resolveMemoryCoverageCreatedAtCutoffMs({
      policy: params.settings.coveragePolicy,
      nowMs,
      enabledAtMs: params.settings.enabledAtMs ?? 0,
    });
    const pruned = params.tier1.pruneSessionArtifacts({
      sessionId,
      policyKey,
      ...(params.settings.coveragePolicy?.type === 'latest_messages' && indexableItems.length > 0
        ? { minSeq: indexableItems[0]!.seq }
        : {}),
      ...(coverageCutoffMs !== null ? { createdAtCutoffMs: coverageCutoffMs } : {}),
    });
    if (pruned) {
      params.tier1.rewindSessionCursor({
        sessionId,
        lane: 'hints',
        seq: Math.max(0, (indexableItems[0]?.seq ?? 1) - 1),
      });
    }
    const lastHintedSeq = params.tier1.getSessionCursors({ sessionId, nowMs }).lastHintedSeq;
    const newIndexableItems = indexableItems.filter((item) => item.seq > lastHintedSeq);
    run.semanticRowsFound += indexableItems.length;
    if (newIndexableItems.length === 0) continue;

    const lastCreatedAtMs = newIndexableItems[newIndexableItems.length - 1]!.createdAtMs;
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
      items: newIndexableItems,
      targetShardMessages,
      minShardMessages,
      targetShardChars,
      maxShardChars,
    });
    let indexedLightRows = 0;
    let lightShardCount = 0;
    let lastIndexedSeq = 0;

    for (const window of windows) {
      params.signal?.throwIfAborted();
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
          run: async (prompt) => await params.runSummarizer(prompt, sessionId, params.signal),
        });
      } catch {
        params.signal?.throwIfAborted();
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
        memoryPolicy,
        keywords: buildMemoryShardSearchKeywords({
          modelKeywords: generated.shard.payload.keywords ?? [],
          items: window.items,
        }),
      };

      try {
        params.signal?.throwIfAborted();
        await params.commitArtifacts({
          sessionId,
          shardPayload: searchableShardPayload,
          synopsisPayload: generated.synopsis?.payload ?? null,
        }, params.signal);
      } catch {
        params.signal?.throwIfAborted();
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
        policyKey,
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
