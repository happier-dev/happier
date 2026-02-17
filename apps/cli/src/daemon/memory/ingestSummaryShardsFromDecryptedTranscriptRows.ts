import { SessionSummaryShardV1Schema } from '@happier-dev/protocol';

import type { DecryptedTranscriptRow } from '@/session/replay/decryptTranscriptRows';

import type { SummaryShardIndexDbHandle } from './summaryShardIndexDb';

function readHappierMetaKind(meta: unknown): { kind: string; payload: unknown } | null {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null;
  const happier = (meta as Record<string, unknown>).happier;
  if (!happier || typeof happier !== 'object' || Array.isArray(happier)) return null;
  const kind = (happier as Record<string, unknown>).kind;
  const payload = (happier as Record<string, unknown>).payload;
  if (typeof kind !== 'string' || kind.trim().length === 0) return null;
  return { kind, payload };
}

export function ingestSummaryShardsFromDecryptedTranscriptRows(params: Readonly<{
  sessionId: string;
  rows: ReadonlyArray<DecryptedTranscriptRow>;
  tier1: SummaryShardIndexDbHandle;
}>): number {
  let inserted = 0;
  for (const row of params.rows) {
    const meta = readHappierMetaKind(row.meta);
    if (!meta) continue;
    if (meta.kind !== 'session_summary_shard.v1') continue;
    const parsed = SessionSummaryShardV1Schema.safeParse(meta.payload);
    if (!parsed.success) continue;
    params.tier1.insertSummaryShard({
      sessionId: params.sessionId,
      seqFrom: parsed.data.seqFrom,
      seqTo: parsed.data.seqTo,
      createdAtFromMs: parsed.data.createdAtFromMs,
      createdAtToMs: parsed.data.createdAtToMs,
      summary: parsed.data.summary,
      keywords: parsed.data.keywords ?? [],
      entities: parsed.data.entities ?? [],
      decisions: parsed.data.decisions ?? [],
    });
    params.tier1.markHintRunSuccess({ sessionId: params.sessionId, seqTo: parsed.data.seqTo, nowMs: row.createdAtMs });
    inserted += 1;
  }
  return inserted;
}
