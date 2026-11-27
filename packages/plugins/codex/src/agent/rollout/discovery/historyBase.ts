import { readExactCodexProviderSessionId } from '../../../protocol/runtimeDescriptorV1.js';
import type { CodexSessionMetaPayload } from './indexData.js';

export type CodexPaginatedHistoryBase = Readonly<{
  rolloutId: string;
  endByteOffset: number;
  endOrdinalExclusive: number;
}>;

/** Codex 0.159.2 HistoryPosition identifies an immutable rollout prefix, not the logical fork parent. */
export function readCodexPaginatedHistoryBase(metadata: CodexSessionMetaPayload | null): CodexPaginatedHistoryBase | null {
  if (metadata?.history_mode !== 'paginated' || metadata.history_base == null) return null;
  const raw = metadata.history_base;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid Codex history base');
  const base = raw as Record<string, unknown>;
  const rolloutId = readExactCodexProviderSessionId(base.thread_id);
  const endByteOffset = base.end_byte_offset;
  const endOrdinalExclusive = base.end_ordinal_exclusive;
  if (!rolloutId || typeof endByteOffset !== 'number' || !Number.isSafeInteger(endByteOffset) || endByteOffset <= 0
    || typeof endOrdinalExclusive !== 'number' || !Number.isSafeInteger(endOrdinalExclusive) || endOrdinalExclusive < 0) {
    throw new Error('Invalid Codex history base');
  }
  return { rolloutId, endByteOffset, endOrdinalExclusive };
}

export function isCodexRolloutHistorySelfContained(metadata: CodexSessionMetaPayload): boolean {
  if (metadata.history_mode !== 'paginated') {
    return (metadata.history_mode === undefined || metadata.history_mode === 'legacy') && metadata.history_base == null;
  }
  try {
    return readCodexPaginatedHistoryBase(metadata) === null;
  } catch {
    return false;
  }
}
