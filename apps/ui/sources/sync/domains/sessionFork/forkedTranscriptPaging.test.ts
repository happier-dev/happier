import { describe, expect, it } from 'vitest';
import type { ForkedTranscriptSnapshot } from '@/sync/domains/sessionFork/forkedTranscriptSnapshot';
import {
  computeForkedTranscriptHasMoreOlder,
  resolveNextForkedTranscriptLoadOlderRequest,
} from '@/sync/domains/sessionFork/forkedTranscriptPaging';

function buildForkSnapshot(params: Readonly<{
  segments: Array<{ sessionId: string; isReadOnlyContext: boolean; cutoffSeqInclusive: number | null }>;
}>): ForkedTranscriptSnapshot {
  return {
    segments: params.segments.map((s) => ({
      ...s,
      messageIdsOldestFirst: [],
    })),
    combinedMessageIdsOldestFirst: [],
    combinedMessagesById: {},
    messageOriginById: {},
    isLoaded: true,
  };
}

describe('forkedTranscriptPaging', () => {
  it('pages the child session first when it has more older', () => {
    const fork = buildForkSnapshot({
      segments: [
        { sessionId: 'parent', isReadOnlyContext: true, cutoffSeqInclusive: 9 },
        { sessionId: 'child', isReadOnlyContext: false, cutoffSeqInclusive: null },
      ],
    });

    const req = resolveNextForkedTranscriptLoadOlderRequest({
      fork,
      getHasMoreOlder: (id) => (id === 'child' ? true : true),
      getBeforeSeqCursor: () => undefined,
    });

    expect(req).toEqual({ kind: 'loadOlder', sessionId: 'child' });
  });

  it('starts ancestor paging from cutoff+1 when ancestor cursor is missing', () => {
    const fork = buildForkSnapshot({
      segments: [
        { sessionId: 'parent', isReadOnlyContext: true, cutoffSeqInclusive: 3 },
        { sessionId: 'child', isReadOnlyContext: false, cutoffSeqInclusive: null },
      ],
    });

    const req = resolveNextForkedTranscriptLoadOlderRequest({
      fork,
      getHasMoreOlder: (id) => (id === 'child' ? false : true),
      getBeforeSeqCursor: () => undefined,
    });

    expect(req).toEqual({ kind: 'loadOlderFromCursor', sessionId: 'parent', beforeSeq: 4 });
  });

  it('uses normal loadOlder for an ancestor when its cursor is already <= cutoff+1', () => {
    const fork = buildForkSnapshot({
      segments: [
        { sessionId: 'parent', isReadOnlyContext: true, cutoffSeqInclusive: 50 },
        { sessionId: 'child', isReadOnlyContext: false, cutoffSeqInclusive: null },
      ],
    });

    const req = resolveNextForkedTranscriptLoadOlderRequest({
      fork,
      getHasMoreOlder: (id) => (id === 'child' ? false : true),
      getBeforeSeqCursor: () => 10,
    });

    expect(req).toEqual({ kind: 'loadOlder', sessionId: 'parent' });
  });

  it('walks up the chain when closer segments are exhausted', () => {
    const fork = buildForkSnapshot({
      segments: [
        { sessionId: 'root', isReadOnlyContext: true, cutoffSeqInclusive: 5 },
        { sessionId: 'parent', isReadOnlyContext: true, cutoffSeqInclusive: 8 },
        { sessionId: 'child', isReadOnlyContext: false, cutoffSeqInclusive: null },
      ],
    });

    const hasMore: Record<string, boolean> = { child: false, parent: false, root: true };
    const req = resolveNextForkedTranscriptLoadOlderRequest({
      fork,
      getHasMoreOlder: (id) => hasMore[id],
      getBeforeSeqCursor: () => undefined,
    });

    expect(req).toEqual({ kind: 'loadOlderFromCursor', sessionId: 'root', beforeSeq: 6 });
  });

  it('computes overall hasMore across segments', () => {
    const fork = buildForkSnapshot({
      segments: [
        { sessionId: 'parent', isReadOnlyContext: true, cutoffSeqInclusive: 2 },
        { sessionId: 'child', isReadOnlyContext: false, cutoffSeqInclusive: null },
      ],
    });

    expect(computeForkedTranscriptHasMoreOlder({
      fork,
      getHasMoreOlder: () => false,
    })).toBe(false);

    expect(computeForkedTranscriptHasMoreOlder({
      fork,
      getHasMoreOlder: (id) => (id === 'child' ? false : undefined),
    })).toBe(true);
  });
});

