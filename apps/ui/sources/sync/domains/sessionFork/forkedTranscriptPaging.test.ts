import { describe, expect, it } from 'vitest';
import type { Message } from '@/sync/domains/messages/messageTypes';
import type { ForkedTranscriptSnapshot } from '@/sync/domains/sessionFork/forkedTranscriptSnapshot';
import {
  computeForkedTranscriptHasMoreOlder,
  resolveNextForkedTranscriptLoadOlderRequest,
} from '@/sync/domains/sessionFork/forkedTranscriptPaging';

function buildForkSnapshot(params: Readonly<{
  segments: Array<{
    sessionId: string;
    isReadOnlyContext: boolean;
    cutoffSeqInclusive: number | null;
    messageIdsOldestFirst?: readonly string[];
  }>;
  combinedMessagesById?: Readonly<Record<string, Message>>;
}>): ForkedTranscriptSnapshot {
  const combinedMessageIdsOldestFirst = params.segments.flatMap((s) => [...(s.messageIdsOldestFirst ?? [])]);
  return {
    segments: params.segments.map((s) => ({
      ...s,
      messageIdsOldestFirst: s.messageIdsOldestFirst ?? [],
    })),
    combinedMessageIdsOldestFirst,
    combinedMessagesById: params.combinedMessagesById ?? {},
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
      getHasMoreOlder: () => true,
      getBeforeSeqCursor: (id) => (id === 'child' ? 123 : undefined),
    });

    expect(req).toEqual({ kind: 'loadOlder', sessionId: 'child' });
  });

  it('derives a child cursor from loaded child messages when the pagination cursor is missing', () => {
    const childOldest: Message = {
      kind: 'user-text',
      id: 'child-oldest',
      seq: 41,
      localId: null,
      createdAt: 1,
      text: 'older child message',
    };
    const childNewest: Message = {
      kind: 'agent-text',
      id: 'child-newest',
      seq: 50,
      localId: null,
      createdAt: 2,
      text: 'newer child message',
    };
    const fork = buildForkSnapshot({
      segments: [
        { sessionId: 'parent', isReadOnlyContext: true, cutoffSeqInclusive: 3 },
        {
          sessionId: 'child',
          isReadOnlyContext: false,
          cutoffSeqInclusive: null,
          messageIdsOldestFirst: ['child-oldest', 'child-newest'],
        },
      ],
      combinedMessagesById: {
        [childOldest.id]: childOldest,
        [childNewest.id]: childNewest,
      },
    });

    const req = resolveNextForkedTranscriptLoadOlderRequest({
      fork,
      getHasMoreOlder: () => true,
      getBeforeSeqCursor: () => undefined,
    });

    expect(req).toEqual({ kind: 'loadOlderFromCursor', sessionId: 'child', beforeSeq: 40 });
  });

  it('skips paging the child session when it has no messages or beforeSeq cursor (avoids not_ready loops)', () => {
    const fork = buildForkSnapshot({
      segments: [
        { sessionId: 'parent', isReadOnlyContext: true, cutoffSeqInclusive: 3 },
        { sessionId: 'child', isReadOnlyContext: false, cutoffSeqInclusive: null },
      ],
    });

    const req = resolveNextForkedTranscriptLoadOlderRequest({
      fork,
      getHasMoreOlder: () => true,
      getBeforeSeqCursor: () => undefined,
    });

    expect(req).toEqual({ kind: 'loadOlderFromCursor', sessionId: 'parent', beforeSeq: 4 });
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

  it('recovers an uninitialized ancestor context page when its has-more flag was poisoned false', () => {
    const fork = buildForkSnapshot({
      segments: [
        { sessionId: 'parent', isReadOnlyContext: true, cutoffSeqInclusive: 3 },
        { sessionId: 'child', isReadOnlyContext: false, cutoffSeqInclusive: null },
      ],
    });

    const req = resolveNextForkedTranscriptLoadOlderRequest({
      fork,
      getHasMoreOlder: () => false,
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
