import { describe, expect, it } from 'vitest';

import type { StorageState } from '@/sync/store/types';
import type { Message } from '@/sync/domains/messages/messageTypes';
import { getForkedTranscriptSnapshotCached } from './forkedTranscriptSnapshot';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { SessionMessages } from '@/sync/store/domains/messages';
import { createReducer } from '@/sync/reducer/reducer';

function userMessage(id: string, seq: number, text: string): Message {
  return {
    kind: 'user-text',
    id,
    seq,
    localId: null,
    createdAt: seq * 10,
    text,
  };
}

function createState(partial: Partial<Pick<StorageState, 'sessions' | 'sessionMessages'>>): Pick<StorageState, 'sessions' | 'sessionMessages'> {
  return {
    sessions: partial.sessions ?? {},
    sessionMessages: partial.sessionMessages ?? {},
  };
}

function sessionRow(id: string, metadata: Session['metadata']): Session {
  return {
    id,
    seq: 0,
    createdAt: 0,
    updatedAt: 0,
    active: false,
    activeAt: 0,
    metadata,
    metadataVersion: 0,
    agentState: null,
    agentStateVersion: 0,
    thinking: false,
    thinkingAt: 0,
    presence: 0,
  };
}

function sessionMessagesRow(params: Readonly<{
  idsOldestFirst: string[];
  messagesById: Record<string, Message>;
  messagesVersion: number;
  isLoaded: boolean;
}>): SessionMessages {
  const reducerState = createReducer();
  return {
    messageIdsOldestFirst: params.idsOldestFirst,
    messagesById: params.messagesById,
    messagesMap: params.messagesById,
    reducerState,
    latestThinkingMessageId: null,
    latestThinkingMessageActivityAtMs: null,
    messagesVersion: params.messagesVersion,
    isLoaded: params.isLoaded,
  };
}

describe('getForkedTranscriptSnapshotCached', () => {
  it('returns null when the session has no fork metadata', () => {
    const state = createState({
      sessions: {
        child: sessionRow('child', { path: '/tmp', host: 'h' }),
      },
      sessionMessages: {
        child: sessionMessagesRow({ idsOldestFirst: [], messagesById: {}, messagesVersion: 0, isLoaded: true }),
      },
    });

    expect(getForkedTranscriptSnapshotCached(state, 'child')).toBeNull();
  });

  it('builds a root-to-child transcript with ancestor cutoffs applied', () => {
    const parentMessagesById: Record<string, Message> = {
      p1: userMessage('p1', 1, 'one'),
      p2: userMessage('p2', 2, 'two'),
      p3: userMessage('p3', 3, 'three'),
    };
    const childMessagesById: Record<string, Message> = {
      c1: userMessage('c1', 1, 'child'),
    };

    const state = createState({
      sessions: {
        parent: { ...sessionRow('parent', { path: '/tmp', host: 'h' }), seq: 3 },
        child: {
          ...sessionRow('child', {
            path: '/tmp',
            host: 'h',
            forkV1: {
              v: 1,
              parentSessionId: 'parent',
              parentCutoffSeqInclusive: 2,
              createdAtMs: 1,
              strategy: 'replay',
            },
          } as any),
          seq: 1,
        },
      },
      sessionMessages: {
        parent: sessionMessagesRow({ idsOldestFirst: ['p1', 'p2', 'p3'], messagesById: parentMessagesById, messagesVersion: 1, isLoaded: true }),
        child: sessionMessagesRow({ idsOldestFirst: ['c1'], messagesById: childMessagesById, messagesVersion: 1, isLoaded: true }),
      },
    });

    const snapshot = getForkedTranscriptSnapshotCached(state, 'child');
    expect(snapshot).not.toBeNull();
    expect(snapshot!.segments.map((s) => ({ id: s.sessionId, cutoff: s.cutoffSeqInclusive, readOnly: s.isReadOnlyContext }))).toEqual([
      { id: 'parent', cutoff: 2, readOnly: true },
      { id: 'child', cutoff: null, readOnly: false },
    ]);
    expect(snapshot!.combinedMessageIdsOldestFirst).toEqual(['p1', 'p2', 'c1']);
    expect(snapshot!.combinedMessagesById['p3']).toBeUndefined();
    expect(snapshot!.messageOriginById['p2']).toEqual({ sessionId: 'parent', isReadOnlyContext: true });
    expect(snapshot!.messageOriginById['c1']).toEqual({ sessionId: 'child', isReadOnlyContext: false });
  });

  it('returns stable object references when inputs are unchanged', () => {
    const msg = userMessage('m1', 1, 'hi');
    const state = createState({
      sessions: {
        parent: { ...sessionRow('parent', { path: '/tmp', host: 'h' }), seq: 1 },
        child: sessionRow('child', {
          path: '/tmp',
          host: 'h',
          forkV1: { v: 1, parentSessionId: 'parent', parentCutoffSeqInclusive: 1, createdAtMs: 0, strategy: 'replay' },
        } as any),
      },
      sessionMessages: {
        parent: sessionMessagesRow({ idsOldestFirst: ['m1'], messagesById: { m1: msg }, messagesVersion: 1, isLoaded: true }),
        child: sessionMessagesRow({ idsOldestFirst: [], messagesById: {}, messagesVersion: 0, isLoaded: true }),
      },
    });

    const a = getForkedTranscriptSnapshotCached(state, 'child');
    const b = getForkedTranscriptSnapshotCached(state, 'child');
    expect(a).toBe(b);
  });

  it('walks multi-level fork chains (root -> parent -> child)', () => {
    const rootMessagesById: Record<string, Message> = {
      r1: userMessage('r1', 1, 'one'),
      r2: userMessage('r2', 2, 'two'),
      r3: userMessage('r3', 3, 'three'),
      r4: userMessage('r4', 4, 'four'),
    };
    const parentMessagesById: Record<string, Message> = {
      p1: userMessage('p1', 1, 'parent-one'),
      p2: userMessage('p2', 2, 'parent-two'),
    };
    const childMessagesById: Record<string, Message> = {
      c1: userMessage('c1', 1, 'child-one'),
    };

    const state = createState({
      sessions: {
        root: { ...sessionRow('root', { path: '/tmp', host: 'h' }), seq: 4 },
        parent: {
          ...sessionRow('parent', {
            path: '/tmp',
            host: 'h',
            forkV1: { v: 1, parentSessionId: 'root', parentCutoffSeqInclusive: 3, createdAtMs: 1, strategy: 'replay' },
          } as any),
          seq: 2,
        },
        child: {
          ...sessionRow('child', {
            path: '/tmp',
            host: 'h',
            forkV1: { v: 1, parentSessionId: 'parent', parentCutoffSeqInclusive: 1, createdAtMs: 2, strategy: 'replay' },
          } as any),
          seq: 1,
        },
      },
      sessionMessages: {
        root: sessionMessagesRow({ idsOldestFirst: ['r1', 'r2', 'r3', 'r4'], messagesById: rootMessagesById, messagesVersion: 1, isLoaded: true }),
        parent: sessionMessagesRow({ idsOldestFirst: ['p1', 'p2'], messagesById: parentMessagesById, messagesVersion: 1, isLoaded: true }),
        child: sessionMessagesRow({ idsOldestFirst: ['c1'], messagesById: childMessagesById, messagesVersion: 1, isLoaded: true }),
      },
    });

    const snapshot = getForkedTranscriptSnapshotCached(state, 'child');
    expect(snapshot).not.toBeNull();
    expect(snapshot!.segments.map((s) => ({ id: s.sessionId, cutoff: s.cutoffSeqInclusive, readOnly: s.isReadOnlyContext }))).toEqual([
      { id: 'root', cutoff: 3, readOnly: true },
      { id: 'parent', cutoff: 1, readOnly: true },
      { id: 'child', cutoff: null, readOnly: false },
    ]);

    // Root: r1..r3, Parent: p1 only, then child.
    expect(snapshot!.combinedMessageIdsOldestFirst).toEqual(['r1', 'r2', 'r3', 'p1', 'c1']);
    expect(snapshot!.messageOriginById['r2']).toEqual({ sessionId: 'root', isReadOnlyContext: true });
    expect(snapshot!.messageOriginById['p1']).toEqual({ sessionId: 'parent', isReadOnlyContext: true });
    expect(snapshot!.messageOriginById['c1']).toEqual({ sessionId: 'child', isReadOnlyContext: false });
  });
});
