import type { ForkedTranscriptSnapshot } from '@/sync/domains/sessionFork/forkedTranscriptSnapshot';

export type ForkedTranscriptLoadOlderRequest =
  | { kind: 'loadOlder'; sessionId: string }
  | { kind: 'loadOlderFromCursor'; sessionId: string; beforeSeq: number };

function normalizeSeq(seq: unknown): number | null {
  if (typeof seq !== 'number' || !Number.isFinite(seq)) return null;
  return Math.max(0, Math.trunc(seq));
}

function deriveBeforeSeqFromLoadedSegmentMessages(
  fork: ForkedTranscriptSnapshot,
  messageIdsOldestFirst: readonly string[],
): number | null {
  let oldestSeq: number | null = null;
  for (const messageId of messageIdsOldestFirst) {
    const message = fork.combinedMessagesById[messageId];
    const seq = normalizeSeq(message?.seq);
    if (seq == null || seq <= 0) continue;
    oldestSeq = oldestSeq == null ? seq : Math.min(oldestSeq, seq);
  }

  return oldestSeq == null || oldestSeq <= 1 ? null : oldestSeq - 1;
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

    if (seg.isReadOnlyContext !== true) {
      if (hasMoreOlder === false) continue;

      const cursor = normalizeSeq(params.getBeforeSeqCursor(seg.sessionId));
      if (cursor === null || cursor <= 0) {
        const derivedBeforeSeq = deriveBeforeSeqFromLoadedSegmentMessages(params.fork, seg.messageIdsOldestFirst);
        if (derivedBeforeSeq !== null) {
          return { kind: 'loadOlderFromCursor', sessionId: seg.sessionId, beforeSeq: derivedBeforeSeq };
        }
        // If the child segment hasn't initialized its pagination cursor yet (common for brand new fork
        // sessions with 0 committed messages), `loadOlderMessages(child)` will return `not_ready` and
        // paging can get stuck on the child segment forever. Skip upward so ancestor paging can proceed.
        continue;
      }
      return { kind: 'loadOlder', sessionId: seg.sessionId };
    }

    const cutoff = normalizeSeq(seg.cutoffSeqInclusive) ?? 0;
    const desiredStartBeforeSeq = cutoff + 1;
    const cursor = normalizeSeq(params.getBeforeSeqCursor(seg.sessionId));
    const hasInitializedAncestorPage = cursor !== null && cursor > 0;
    const hasLoadedAncestorMessages = seg.messageIdsOldestFirst.length > 0;
    const olderSegmentHasMore = segments
      .slice(0, i)
      .some((olderSegment) => params.getHasMoreOlder(olderSegment.sessionId) === true);
    if (
      hasMoreOlder === false
      && (
        cutoff <= 0
        || hasInitializedAncestorPage
        || hasLoadedAncestorMessages
        || olderSegmentHasMore
      )
    ) {
      continue;
    }

    if (cursor === null || cursor <= 0 || cursor > desiredStartBeforeSeq) {
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
