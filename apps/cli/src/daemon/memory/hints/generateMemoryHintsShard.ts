import { redactBugReportSensitiveText, SessionSummaryShardV1Schema, SessionSynopsisV1Schema, type SessionSummaryShardV1, type SessionSynopsisV1 } from '@happier-dev/protocol';

import type { DecryptedTranscriptRow } from '@/session/replay/decryptTranscriptRows';

import { buildMemoryHintsPrompt } from './buildMemoryHintsPrompt';
import { parseMemoryHintsOutput } from './parseMemoryHintsOutput';

export type GeneratedMemoryHintShard = Readonly<{
  sessionId: string;
  payload: SessionSummaryShardV1;
}>;

export type GeneratedMemoryHintSynopsis = Readonly<{
  sessionId: string;
  payload: SessionSynopsisV1;
}>;

export type GenerateMemoryHintsShardResult =
  | Readonly<{ ok: true; shard: GeneratedMemoryHintShard; synopsis: GeneratedMemoryHintSynopsis | null }>
  | Readonly<{ ok: false; errorCode: 'no_indexable_messages' | 'invalid_model_output' | 'schema_validation_failed'; error: string }>;

function isMemoryArtifactMeta(meta: unknown): boolean {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return false;
  const happier = (meta as Record<string, unknown>).happier;
  if (!happier || typeof happier !== 'object' || Array.isArray(happier)) return false;
  const kind = (happier as Record<string, unknown>).kind;
  return kind === 'session_summary_shard.v1' || kind === 'session_synopsis.v1';
}

function extractIndexableText(row: DecryptedTranscriptRow): string | null {
  if (!row.content || typeof row.content !== 'object' || Array.isArray(row.content)) return null;
  const type = (row.content as Record<string, unknown>).type;
  if (type === 'text') {
    const text = (row.content as Record<string, unknown>).text;
    return typeof text === 'string' ? text : null;
  }
  if (row.role === 'agent' && type === 'acp') {
    const data = (row.content as Record<string, unknown>).data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    const t = (data as Record<string, unknown>).type;
    if (t === 'message' || t === 'reasoning') {
      const message = (data as Record<string, unknown>).message;
      return typeof message === 'string' ? message : null;
    }
  }
  return null;
}

function trimToMaxChars(text: string, maxChars: number): string {
  const normalized = String(text ?? '');
  if (normalized.length <= maxChars) return normalized;
  return normalized.slice(0, Math.max(0, maxChars));
}

export async function generateMemoryHintsShard(params: Readonly<{
  sessionId: string;
  rows: ReadonlyArray<DecryptedTranscriptRow>;
  previousSynopsis: string | null;
  budgets: Readonly<{ windowSizeMessages: number; maxShardChars: number }>;
  hintSettings: Readonly<{ maxSummaryChars: number; maxKeywords: number; maxEntities: number; maxDecisions: number }>;
  run: (prompt: string) => Promise<string>;
}>): Promise<GenerateMemoryHintsShardResult> {
  const sessionId = String(params.sessionId ?? '').trim();
  const indexable: Array<{ seq: number; createdAtMs: number; role: 'user' | 'assistant'; text: string }> = [];

  for (const row of params.rows) {
    if (isMemoryArtifactMeta(row.meta)) continue;
    const text = extractIndexableText(row);
    if (!text || text.trim().length === 0) continue;
    indexable.push({
      seq: row.seq,
      createdAtMs: row.createdAtMs,
      role: row.role === 'user' ? 'user' : 'assistant',
      text: redactBugReportSensitiveText(text).trim(),
    });
  }

  if (indexable.length === 0) {
    return { ok: false, errorCode: 'no_indexable_messages', error: 'No indexable transcript messages.' };
  }

  const windowSize = Math.max(1, Math.trunc(params.budgets.windowSizeMessages));
  const rawWindow = indexable.slice(Math.max(0, indexable.length - windowSize));

  const maxShardChars = Math.max(1, Math.trunc(params.budgets.maxShardChars));
  let remainingChars = maxShardChars;
  const selectedReversed: Array<{ seq: number; createdAtMs: number; role: 'user' | 'assistant'; text: string }> = [];
  for (let i = rawWindow.length - 1; i >= 0; i -= 1) {
    if (remainingChars <= 0) break;
    const msg = rawWindow[i]!;
    const text = String(msg.text ?? '');
    if (text.length <= remainingChars) {
      selectedReversed.push(msg);
      remainingChars -= text.length;
      continue;
    }

    selectedReversed.push({
      ...msg,
      text: text.slice(Math.max(0, text.length - remainingChars)),
    });
    remainingChars = 0;
    break;
  }

  const selected = selectedReversed.reverse();
  if (selected.length === 0) {
    const last = rawWindow[rawWindow.length - 1]!;
    selected.push({ ...last, text: String(last.text ?? '').slice(Math.max(0, String(last.text ?? '').length - maxShardChars)) });
  }

  const seqFrom = selected[0]!.seq;
  const seqTo = selected[selected.length - 1]!.seq;
  const createdAtFromMs = selected[0]!.createdAtMs;
  const createdAtToMs = selected[selected.length - 1]!.createdAtMs;

  const prompt = buildMemoryHintsPrompt({
    sessionId,
    seqFrom,
    seqTo,
    previousSynopsis: params.previousSynopsis,
    messages: selected.map((m) => ({ seq: m.seq, role: m.role, text: m.text })),
    budgets: params.hintSettings,
  });

  const raw = await params.run(prompt);
  const parsed = parseMemoryHintsOutput({ rawText: raw });
  if (!parsed.ok) {
    return { ok: false, errorCode: parsed.errorCode, error: parsed.error };
  }

  const normalizedShard = SessionSummaryShardV1Schema.parse({
    ...parsed.shard,
    seqFrom,
    seqTo,
    createdAtFromMs,
    createdAtToMs,
    summary: trimToMaxChars(parsed.shard.summary, params.hintSettings.maxSummaryChars),
  });

  const normalizedSynopsis = parsed.synopsis
    ? SessionSynopsisV1Schema.parse({
        ...parsed.synopsis,
        seqTo,
      })
    : null;

  return {
    ok: true,
    shard: { sessionId, payload: normalizedShard },
    synopsis: normalizedSynopsis ? { sessionId, payload: normalizedSynopsis } : null,
  };
}
