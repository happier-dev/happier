import { normalizeCodexVendorResumeId } from '../utils/codexSessionFiles';
import type { CodexSessionMetaPayload } from './rolloutDiscovery';

type CodexRolloutHistoryLineage =
  | Readonly<{ kind: 'unverified' | 'legacy' | 'self-contained' | 'invalid-base' }>
  | Readonly<{ kind: 'inherited'; baseRolloutId: string; endByteOffset: number }>;

/** Codex 0.159.2 HistoryPosition identifies an immutable rollout prefix, independent of the logical fork parent. */
export function readCodexRolloutHistoryLineage(metadata: CodexSessionMetaPayload | null): CodexRolloutHistoryLineage {
  if (!metadata) return { kind: 'unverified' };
  if (metadata.history_mode !== 'paginated') {
    const legacy = (metadata.history_mode === undefined || metadata.history_mode === 'legacy') && metadata.history_base == null;
    return { kind: legacy ? 'legacy' : 'unverified' };
  }
  const base = metadata.history_base;
  if (base == null) return { kind: 'self-contained' };
  if (typeof base !== 'object' || Array.isArray(base)) return { kind: 'invalid-base' };

  const position = base as Record<string, unknown>;
  const baseRolloutId = normalizeCodexVendorResumeId(position.thread_id);
  const endByteOffset = position.end_byte_offset;
  const endOrdinal = position.end_ordinal_exclusive;
  if (!baseRolloutId || typeof endByteOffset !== 'number' || !Number.isSafeInteger(endByteOffset) || endByteOffset <= 0
    || typeof endOrdinal !== 'number' || !Number.isSafeInteger(endOrdinal) || endOrdinal < 0) {
    return { kind: 'invalid-base' };
  }
  return { kind: 'inherited', baseRolloutId, endByteOffset };
}
