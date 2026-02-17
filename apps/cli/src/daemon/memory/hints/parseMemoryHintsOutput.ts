import { z } from 'zod';

import { SessionSummaryShardV1Schema, SessionSynopsisV1Schema, type SessionSummaryShardV1, type SessionSynopsisV1 } from '@happier-dev/protocol';

import { parseTrailingJsonObject } from '@/agent/executionRuns/profiles/shared/parseTrailingJsonObject';

export type ParseMemoryHintsOutputResult =
  | Readonly<{ ok: true; shard: SessionSummaryShardV1; synopsis: SessionSynopsisV1 | null }>
  | Readonly<{ ok: false; errorCode: 'invalid_model_output' | 'schema_validation_failed'; error: string }>;

const ModelOutputSchema = z
  .object({
    shard: SessionSummaryShardV1Schema,
    synopsis: z.union([SessionSynopsisV1Schema, z.null()]).optional(),
  })
  .passthrough();

export function parseMemoryHintsOutput(params: Readonly<{ rawText: string }>): ParseMemoryHintsOutputResult {
  const parsedJson = parseTrailingJsonObject(String(params.rawText ?? ''));
  if (!parsedJson) {
    return { ok: false, errorCode: 'invalid_model_output', error: 'No JSON object found in model output.' };
  }

  const parsed = ModelOutputSchema.safeParse(parsedJson);
  if (!parsed.success) {
    return { ok: false, errorCode: 'schema_validation_failed', error: parsed.error.message };
  }

  const synopsis = parsed.data.synopsis === undefined ? null : parsed.data.synopsis;
  return { ok: true, shard: parsed.data.shard, synopsis };
}
