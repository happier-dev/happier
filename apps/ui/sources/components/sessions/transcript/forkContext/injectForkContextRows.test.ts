import { describe, expect, it } from 'vitest';

import type { ChatListItem } from '@/components/sessions/chatListItems';
import type { ForkedTranscriptSnapshot } from '@/sync/domains/sessionFork/forkedTranscriptSnapshot';
import { injectForkContextRows } from './injectForkContextRows';

describe('injectForkContextRows', () => {
  it('inserts fork dividers between segments and marks ancestor messages read-only', () => {
    const base: ChatListItem[] = [
      { kind: 'message', id: 'msg:p1', messageId: 'p1', createdAt: 1, seq: 1 },
      { kind: 'message', id: 'msg:p2', messageId: 'p2', createdAt: 2, seq: 2 },
      { kind: 'message', id: 'msg:c1', messageId: 'c1', createdAt: 3, seq: 1 },
      { kind: 'pending-queue', id: 'pending-queue', pendingMessages: [{ id: 'p1', localId: 'x', createdAt: 9, updatedAt: 9, text: 'pending', rawRecord: {} }], discardedMessages: [] },
    ];

    const fork: ForkedTranscriptSnapshot = {
      segments: [
        { sessionId: 'parent', isReadOnlyContext: true, cutoffSeqInclusive: 2, messageIdsOldestFirst: ['p1', 'p2'] },
        { sessionId: 'child', isReadOnlyContext: false, cutoffSeqInclusive: null, messageIdsOldestFirst: ['c1'] },
      ],
      combinedMessageIdsOldestFirst: ['p1', 'p2', 'c1'],
      combinedMessagesById: {} as any,
      messageOriginById: {
        p1: { sessionId: 'parent', isReadOnlyContext: true },
        p2: { sessionId: 'parent', isReadOnlyContext: true },
        c1: { sessionId: 'child', isReadOnlyContext: false },
      },
      isLoaded: true,
    };

    const result = injectForkContextRows({ baseItems: base, fork });
    expect(result.map((i) => i.kind)).toEqual(['message', 'message', 'fork-divider', 'message', 'pending-queue']);
    const divider = result[2] as Extract<ChatListItem, { kind: 'fork-divider' }>;
    expect(divider).toMatchObject({
      kind: 'fork-divider',
      parentSessionId: 'parent',
      childSessionId: 'child',
      parentCutoffSeqInclusive: 2,
    });
    const p1 = result[0] as Extract<ChatListItem, { kind: 'message' }>;
    expect(p1.originSessionId).toBe('parent');
    expect(p1.isReadOnlyContext).toBe(true);
  });

  it('inserts a fork divider even when the child segment is empty', () => {
    const base: ChatListItem[] = [
      { kind: 'message', id: 'msg:p1', messageId: 'p1', createdAt: 1, seq: 1 },
      { kind: 'message', id: 'msg:p2', messageId: 'p2', createdAt: 2, seq: 2 },
    ];

    const fork: ForkedTranscriptSnapshot = {
      segments: [
        { sessionId: 'parent', isReadOnlyContext: true, cutoffSeqInclusive: 2, messageIdsOldestFirst: ['p1', 'p2'] },
        { sessionId: 'child', isReadOnlyContext: false, cutoffSeqInclusive: null, messageIdsOldestFirst: [] },
      ],
      combinedMessageIdsOldestFirst: ['p1', 'p2'],
      combinedMessagesById: {} as any,
      messageOriginById: {
        p1: { sessionId: 'parent', isReadOnlyContext: true },
        p2: { sessionId: 'parent', isReadOnlyContext: true },
      },
      isLoaded: true,
    };

    const result = injectForkContextRows({ baseItems: base, fork });
    expect(result.map((i) => i.kind)).toEqual(['message', 'message', 'fork-divider']);
    const divider = result[2] as Extract<ChatListItem, { kind: 'fork-divider' }>;
    expect(divider).toMatchObject({
      kind: 'fork-divider',
      parentSessionId: 'parent',
      childSessionId: 'child',
      parentCutoffSeqInclusive: 2,
    });
  });

  it('uses boundary-stable ids for multi-level fork chains', () => {
    const base: ChatListItem[] = [
      { kind: 'message', id: 'msg:a1', messageId: 'a1', createdAt: 1, seq: 1 },
      { kind: 'message', id: 'msg:a2', messageId: 'a2', createdAt: 2, seq: 2 },
      { kind: 'message', id: 'msg:b1', messageId: 'b1', createdAt: 3, seq: 1 },
    ];

    const fork: ForkedTranscriptSnapshot = {
      segments: [
        { sessionId: 'A', isReadOnlyContext: true, cutoffSeqInclusive: 2, messageIdsOldestFirst: ['a1', 'a2'] },
        { sessionId: 'B', isReadOnlyContext: true, cutoffSeqInclusive: 1, messageIdsOldestFirst: ['b1'] },
        { sessionId: 'C', isReadOnlyContext: false, cutoffSeqInclusive: null, messageIdsOldestFirst: [] },
      ],
      combinedMessageIdsOldestFirst: ['a1', 'a2', 'b1'],
      combinedMessagesById: {} as any,
      messageOriginById: {
        a1: { sessionId: 'A', isReadOnlyContext: true },
        a2: { sessionId: 'A', isReadOnlyContext: true },
        b1: { sessionId: 'B', isReadOnlyContext: true },
      },
      isLoaded: true,
    };

    const result = injectForkContextRows({ baseItems: base, fork });
    expect(result.map((i) => i.kind)).toEqual(['message', 'message', 'fork-divider', 'message', 'fork-divider']);
    const first = result[2] as Extract<ChatListItem, { kind: 'fork-divider' }>;
    const second = result[4] as Extract<ChatListItem, { kind: 'fork-divider' }>;
    expect(first).toMatchObject({ parentSessionId: 'A', childSessionId: 'B', id: 'fork-divider:A:B' });
    expect(second).toMatchObject({ parentSessionId: 'B', childSessionId: 'C', id: 'fork-divider:B:C' });
  });
});
