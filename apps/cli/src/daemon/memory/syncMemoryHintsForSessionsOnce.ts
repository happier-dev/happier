import type { SessionSummaryShardV1, SessionSynopsisV1 } from '@happier-dev/protocol';

import type { DecryptedTranscriptRow } from '@/session/replay/decryptTranscriptRows';

import type { SummaryShardIndexDbHandle } from './summaryShardIndexDb';
import { ingestSummaryShardsFromDecryptedTranscriptRows } from './ingestSummaryShardsFromDecryptedTranscriptRows';
import { generateMemoryHintsShard } from './hints/generateMemoryHintsShard';

export type SyncMemoryHintsSettings = Readonly<{
  enabled: boolean;
  indexMode: 'hints' | 'deep';
  backfillPolicy: 'new_only' | 'last_30_days' | 'all_history';
  hints: Readonly<{
    updateMode: 'onIdle' | 'continuous';
    idleDelayMs: number;
    windowSizeMessages: number;
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
  tier1: SummaryShardIndexDbHandle;
  settings: SyncMemoryHintsSettings;
  now: () => number;
  fetchRecentDecryptedRows: (sessionId: string) => Promise<DecryptedTranscriptRow[]>;
  runSummarizer: (prompt: string, sessionId: string) => Promise<string>;
  commitArtifacts: (args: Readonly<{
    sessionId: string;
    shardPayload: SessionSummaryShardV1;
    synopsisPayload: SessionSynopsisV1 | null;
  }>) => Promise<void>;
}>): Promise<void> {
  if (!params.settings.enabled) return;

  const nowMs = params.now();

  for (const rawSessionId of params.sessionIds) {
    const sessionId = String(rawSessionId ?? '').trim();
    if (!sessionId) continue;

    const rows = await params.fetchRecentDecryptedRows(sessionId);
    if (rows.length === 0) continue;

    ingestSummaryShardsFromDecryptedTranscriptRows({ sessionId, rows, tier1: params.tier1 });

    const latestSeq = rows.length > 0 ? rows[rows.length - 1]!.seq : 0;
    if (params.settings.backfillPolicy === 'new_only') {
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

    const indexableTextCount = eligibleRows.filter((row) => {
      const content = row.content;
      if (!content || typeof content !== 'object' || Array.isArray(content)) return false;
      const type = (content as Record<string, unknown>).type;
      if (type !== 'text') return false;
      const text = (content as Record<string, unknown>).text;
      return typeof text === 'string' && text.trim().length > 0;
    }).length;
    if (indexableTextCount < params.settings.hints.windowSizeMessages) continue;

    const lastCreatedAtMs = eligibleRows[eligibleRows.length - 1]!.createdAtMs;
    const idleDelayMs = Math.max(0, Math.trunc(params.settings.hints.idleDelayMs));
    if (params.settings.hints.updateMode === 'onIdle' && nowMs - lastCreatedAtMs < idleDelayMs) continue;

    const permitAcquired = params.tier1.tryAcquireHintRunPermit({
      sessionId,
      nowMs,
      maxRunsPerHour: params.settings.hints.maxRunsPerHour,
    });
    if (!permitAcquired) continue;

    let generated: Awaited<ReturnType<typeof generateMemoryHintsShard>> | null = null;
    try {
      generated = await generateMemoryHintsShard({
        sessionId,
        rows: eligibleRows,
        previousSynopsis: null,
        budgets: {
          windowSizeMessages: params.settings.hints.windowSizeMessages,
          maxShardChars: params.settings.hints.maxShardChars,
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

    try {
      await params.commitArtifacts({
        sessionId,
        shardPayload: generated.shard.payload,
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
      seqFrom: generated.shard.payload.seqFrom,
      seqTo: generated.shard.payload.seqTo,
      createdAtFromMs: generated.shard.payload.createdAtFromMs,
      createdAtToMs: generated.shard.payload.createdAtToMs,
      summary: generated.shard.payload.summary,
      keywords: generated.shard.payload.keywords ?? [],
      entities: generated.shard.payload.entities ?? [],
      decisions: generated.shard.payload.decisions ?? [],
    });
    params.tier1.markHintRunSuccess({ sessionId, seqTo: generated.shard.payload.seqTo, nowMs });
    params.tier1.enforceMaxShardsPerSession({ sessionId, maxShardsPerSession: params.settings.hints.maxShardsPerSession });
  }
}
