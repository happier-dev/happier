import { SessionSummaryShardV1Schema } from '@happier-dev/protocol/messages/structured/sessionSummaryShardV1';
import { SessionSynopsisV1Schema } from '@happier-dev/protocol/messages/structured/sessionSynopsisV1';
import type { SessionSummaryShardV1, SessionSynopsisV1 } from '@happier-dev/protocol';

import { parseTrailingJsonObject } from '@/agent/executionRuns/profiles/shared/parseTrailingJsonObject';

export type ParseMemoryHintsOutputResult =
  | Readonly<{ ok: true; shard: SessionSummaryShardV1; synopsis: SessionSynopsisV1 | null }>
  | Readonly<{ ok: false; errorCode: 'invalid_model_output' | 'schema_validation_failed'; error: string }>;

export function parseMemoryHintsOutput(params: Readonly<{ rawText: string }>): ParseMemoryHintsOutputResult {
  const parsedJson = parseTrailingJsonObject(String(params.rawText ?? ''));
  if (!parsedJson || typeof parsedJson !== 'object' || Array.isArray(parsedJson)) {
    return { ok: false, errorCode: 'invalid_model_output', error: 'No JSON object found in model output.' };
  }

  const record = parsedJson as Record<string, unknown>;

  const shardParsed = SessionSummaryShardV1Schema.safeParse(record.shard);
  if (!shardParsed.success) {
    return { ok: false, errorCode: 'schema_validation_failed', error: shardParsed.error.message };
  }

  let synopsis: SessionSynopsisV1 | null = null;
  const synopsisRaw = record.synopsis;
  if (synopsisRaw !== undefined && synopsisRaw !== null) {
    const synopsisParsed = SessionSynopsisV1Schema.safeParse(synopsisRaw);
    if (!synopsisParsed.success) {
      return { ok: false, errorCode: 'schema_validation_failed', error: synopsisParsed.error.message };
    }
    synopsis = synopsisParsed.data;
  }

  return { ok: true, shard: shardParsed.data, synopsis };
}
