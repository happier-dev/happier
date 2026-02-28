import type { ForkedTranscriptSnapshot } from '@/sync/domains/sessionFork/forkedTranscriptSnapshot';

export type ForkedTranscriptLoadOlderRequest =
  | { kind: 'loadOlder'; sessionId: string }
  | { kind: 'loadOlderFromCursor'; sessionId: string; beforeSeq: number };

function normalizeSeq(seq: unknown): number | null {
  if (typeof seq !== 'number' || !Number.isFinite(seq)) return null;
  return Math.max(0, Math.trunc(seq));
}

export function resolveNextForkedTranscriptLoadOlderRequest(params: Readonly<{
  fork: ForkedTranscriptSnapshot;
  getHasMoreOlder: (sessionId: string) => boolean | undefined;
  getBeforeSeqCursor: (sessionId: string) => number | undefined;
}>): ForkedTranscriptLoadOlderRequest | null {
  const segments = params.fork.segments;
  if (!Array.isArray(segments) || segments.length === 0) return null;

  // Prefer paging the child session until it is exhausted, then walk upward.
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    const seg = segments[i]!;
    const hasMoreOlder = params.getHasMoreOlder(seg.sessionId);
    if (hasMoreOlder === false) continue;

    if (seg.isReadOnlyContext !== true) {
      return { kind: 'loadOlder', sessionId: seg.sessionId };
    }

    const cutoff = normalizeSeq(seg.cutoffSeqInclusive) ?? 0;
    const desiredStartBeforeSeq = cutoff + 1;
    const cursor = params.getBeforeSeqCursor(seg.sessionId);
    if (typeof cursor !== 'number' || !Number.isFinite(cursor) || cursor <= 0 || cursor > desiredStartBeforeSeq) {
      return { kind: 'loadOlderFromCursor', sessionId: seg.sessionId, beforeSeq: desiredStartBeforeSeq };
    }
    return { kind: 'loadOlder', sessionId: seg.sessionId };
  }

  return null;
}

export function computeForkedTranscriptHasMoreOlder(params: Readonly<{
  fork: ForkedTranscriptSnapshot;
  getHasMoreOlder: (sessionId: string) => boolean | undefined;
}>): boolean {
  const segments = params.fork.segments;
  for (const seg of segments) {
    const hasMoreOlder = params.getHasMoreOlder(seg.sessionId);
    if (hasMoreOlder !== false) return true;
  }
  return false;
}

