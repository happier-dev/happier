import { classifyClaudeNativeTranscriptRow, createClaudeCompactBoundaryEventId } from '../../../transcripts/nativeSemanticProjection.js';
import type { readClaudeCompactionMetadata } from '../../../transcripts/compactionMetadata.js';

type Compaction = Readonly<{
  compactionId: string;
  phase: 'completed';
  trigger: 'manual' | 'automatic' | 'idle' | 'unknown';
  emittedAtMs: number;
} & ReturnType<typeof readClaudeCompactionMetadata>>;

/** Assemble native boundary/summary/notice output on the ordered transcript seam. */
export function createClaudeUnifiedCompactionProjection() {
  let sessionId: string | null = null;
  let pending: Readonly<{ kind: 'boundary' | 'notice'; event: Compaction }> | null = null;
  return {
    observe(row: unknown, providerSessionId: string, observedAtMs: number): readonly Compaction[] {
      if (sessionId !== providerSessionId) { sessionId = providerSessionId; pending = null; }
      const classification = classifyClaudeNativeTranscriptRow(row);
      if (classification.sidechain || !classification.row) return [];
      const { lifecycle } = classification;
      if (lifecycle.kind === 'idle_compaction_notice') {
        if (pending?.kind === 'boundary') {
          const event = { ...pending.event, trigger: 'idle' as const };
          pending = null;
          return [event];
        }
        const compactionId = createClaudeCompactBoundaryEventId({ providerSessionId,
          nativeBoundaryId: typeof classification.row.uuid === 'string' ? classification.row.uuid : null, observedAtMs });
        if (!compactionId) return [];
        const event = { compactionId, phase: 'completed' as const, trigger: 'idle' as const, emittedAtMs: observedAtMs };
        pending = { kind: 'notice', event };
        return [event];
      }
      if (lifecycle.kind === 'compact_boundary') {
        const compactionId = createClaudeCompactBoundaryEventId({ providerSessionId,
          nativeBoundaryId: classification.nativeBoundary?.id ?? null, observedAtMs });
        if (!compactionId) return [];
        const raw = classification.row as Readonly<Record<string, unknown>>;
        const metadata = raw.compactMetadata ?? raw.compact_metadata;
        const nativeTrigger = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
          ? (metadata as Readonly<Record<string, unknown>>).trigger : undefined;
        const event: Compaction = { compactionId, phase: 'completed', emittedAtMs: observedAtMs,
          trigger: nativeTrigger === 'manual' ? 'manual' : nativeTrigger === 'auto' ? 'automatic' : 'unknown',
          ...(lifecycle.tokenCountBefore === undefined ? {} : { tokenCountBefore: lifecycle.tokenCountBefore }),
          ...(lifecycle.tokenCountAfter === undefined ? {} : { tokenCountAfter: lifecycle.tokenCountAfter }),
          ...(lifecycle.tokenCountSource === undefined ? {} : { tokenCountSource: lifecycle.tokenCountSource }) };
        if (pending?.kind === 'notice' && event.trigger !== 'manual') {
          const measured = { ...event, compactionId: pending.event.compactionId, trigger: 'idle' as const };
          pending = null;
          return [measured];
        }
        const previous = pending?.kind === 'boundary' ? [pending.event] : [];
        pending = event.trigger === 'automatic' ? { kind: 'boundary', event } : null;
        return event.trigger === 'automatic' ? previous : [...previous, event];
      }
      // Compaction's synthetic summary belongs to this same native operation;
      // the next ordinary model/user record closes an ordinary automatic result.
      if (classification.content.kind !== 'compact_summary'
        && (classification.row.type === 'user' || classification.row.type === 'assistant')) {
        const events = pending?.kind === 'boundary' ? [pending.event] : [];
        pending = null;
        return events;
      }
      return [];
    },
  };
}
