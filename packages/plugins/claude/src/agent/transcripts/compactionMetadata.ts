function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Claude transcript and SDK spellings describe the same measured native counts. */
export function readClaudeCompactionMetadata(row: unknown): Readonly<{
  tokenCountBefore?: number;
  tokenCountAfter?: number;
  tokenCountSource?: 'providerReported';
}> {
  if (!isRecord(row)) return {};
  const metadata = row.compactMetadata ?? row.compact_metadata;
  if (!isRecord(metadata)) return {};
  const before = metadata.preTokens ?? metadata.pre_tokens;
  const after = metadata.postTokens ?? metadata.post_tokens;
  const tokenCountBefore = typeof before === 'number' && Number.isSafeInteger(before) && before >= 0 ? before : undefined;
  const tokenCountAfter = typeof after === 'number' && Number.isSafeInteger(after) && after >= 0 ? after : undefined;
  return {
    ...(tokenCountBefore === undefined ? {} : { tokenCountBefore }),
    ...(tokenCountAfter === undefined ? {} : { tokenCountAfter }),
    ...(tokenCountBefore === undefined && tokenCountAfter === undefined ? {} : { tokenCountSource: 'providerReported' }),
  };
}
