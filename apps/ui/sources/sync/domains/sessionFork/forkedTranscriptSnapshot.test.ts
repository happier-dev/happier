import { afterEach, describe, expect, it, vi } from 'vitest';

import type { StorageState } from '@/sync/store/types';
import type { Message } from "@happier-dev/session-core/messages";
import { getForkedTranscriptSnapshotCached } from './forkedTranscriptSnapshot';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { SessionMessages } from '@/sync/store/domains/messages';
import { createReducer } from "@happier-dev/session-core/reducer";

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

function visualToolMessage(id: string, seq: number): Message {
  return { kind: 'tool-call', id, seq, localId: null, createdAt: seq * 10, children: [],
    tool: { id: 'visual-provider-call', name: 'session_board_item_upsert', state: 'completed', input: {},
      createdAt: seq * 10, startedAt: seq * 10, completedAt: seq * 10, description: null } };
}

function createState(partial: Partial<Pick<StorageState, 'sessions' | 'sessionMessages' | 'sessionMessagesHistoryStartLoaded'>>): Pick<StorageState, 'sessions' | 'sessionMessages' | 'sessionMessagesHistoryStartLoaded'> {
  return {
    sessions: partial.sessions ?? {},
    sessionMessages: partial.sessionMessages ?? {},
    sessionMessagesHistoryStartLoaded: partial.sessionMessagesHistoryStartLoaded ?? {},
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
  it('makes imported visuals reachable to a child-only reader without owner lineage or parent messages', () => {
    const imported = { ...userMessage('imported', 20, 'visual'), meta: { forkVisualOriginV1: {
      v: 1 as const, serverId: 'home', sessionId: 'parent', sourceMessageId: 'original', sourceSeq: 3,
    } } };
    const state = createState({ sessions: { child: sessionRow('child', { path: '', host: '', forkVisualsV1: { v: 1, copies: [] } }) },
      sessionMessages: { child: sessionMessagesRow({ idsOldestFirst: ['imported'], messagesById: { imported }, messagesVersion: 1, isLoaded: true }) } });
    const snapshot = getForkedTranscriptSnapshotCached(state, 'child')!;
    expect(snapshot.combinedMessageIdsOldestFirst).toEqual(['imported']);
    expect(snapshot.messageOriginById.imported).toEqual({ sessionId: 'child', isReadOnlyContext: true });
    expect(snapshot.visualSessionId).toBe('child');
  });
  it('prefers the independent imported visual over its cached ancestor row', () => {
    const original = visualToolMessage('original-block', 3);
    const imported = { ...visualToolMessage('imported-block', 20), meta: { forkVisualOriginV1: {
      v: 1 as const, serverId: 'home', sessionId: 'parent', sourceMessageId: 'original-result-raw', sourceSeq: 3,
    } } };
    const state = createState({ sessions: {
      parent: { ...sessionRow('parent', { path: '/tmp', host: 'h' }), serverId: 'home' },
      child: { ...sessionRow('child', { path: '/tmp', host: 'h', forkV1: { v: 1, parentSessionId: 'parent',
      parentCutoffSeqInclusive: 4, createdAtMs: 1, strategy: 'replay' } }), serverId: 'home' },
    }, sessionMessagesHistoryStartLoaded: { child: true }, sessionMessages: {
      parent: sessionMessagesRow({ idsOldestFirst: ['original-block', 'after-visual'], messagesById: {
        'original-block': { ...original, realID: 'original-raw' }, 'after-visual': userMessage('after-visual', 4, 'after visual'),
      }, messagesVersion: 1, isLoaded: true }),
      child: sessionMessagesRow({ idsOldestFirst: ['imported-block'], messagesById: { 'imported-block': imported }, messagesVersion: 1, isLoaded: true }),
    } });
    const snapshot = getForkedTranscriptSnapshotCached(state, 'child')!;
    expect(snapshot.combinedMessageIdsOldestFirst).toEqual(['imported-block', 'after-visual']);
    expect(snapshot.messageOriginById['imported-block']).toEqual({ sessionId: 'child', isReadOnlyContext: true });
  });
  it('projects settled child copies and refreshes the snapshot when copy outcomes arrive', () => {
    const state = createState({ sessions: {
      parent: sessionRow('parent', { path: '/tmp', host: 'h' }),
      child: sessionRow('child', { path: '/tmp', host: 'h', forkV1: { v: 1, parentSessionId: 'parent',
        parentCutoffSeqInclusive: 1, createdAtMs: 1, strategy: 'replay' } }),
    }, sessionMessages: {
      child: sessionMessagesRow({ idsOldestFirst: [], messagesById: {}, messagesVersion: 0, isLoaded: true }),
    } });
    const before = getForkedTranscriptSnapshotCached(state, 'child')!;
    const copies = [{ originServerId: 'home', originSessionId: 'parent', originItemId: 'chart', status: 'copied' as const, itemId: 'child-chart' }];
    state.sessions.child = { ...state.sessions.child!, metadata: { ...state.sessions.child!.metadata!,
      forkVisualsV1: { v: 1, copies } } };
    const after = getForkedTranscriptSnapshotCached(state, 'child')!;
    expect(after).not.toBe(before);
    expect(after).toMatchObject({ visualSessionId: 'child', visualCopies: copies });
    expect(getForkedTranscriptSnapshotCached(state, 'child')).toBe(after);
  });
  it('does not collapse imported references from distinct Homes with the same native tool identity', () => {
    const imported = (id: string, serverId: string) => ({ ...visualToolMessage(id, 20), meta: { forkVisualOriginV1: {
      v: 1 as const, serverId, sessionId: 'parent', sourceMessageId: 'same-result-id', sourceSeq: 3,
    } } });
    const state = createState({ sessions: {
      parent: { ...sessionRow('parent', { path: '', host: '' }), serverId: 'home-one' },
      child: { ...sessionRow('child', { path: '', host: '', forkV1: { v: 1, parentSessionId: 'parent',
        parentCutoffSeqInclusive: 4, createdAtMs: 1, strategy: 'replay' } }), serverId: 'home-one' },
    }, sessionMessagesHistoryStartLoaded: { child: true }, sessionMessages: {
      parent: sessionMessagesRow({ idsOldestFirst: ['original'], messagesById: { original: visualToolMessage('original', 3) }, messagesVersion: 1, isLoaded: true }),
      child: sessionMessagesRow({ idsOldestFirst: ['same-home', 'other-home'], messagesById: {
        'same-home': imported('same-home', 'home-one'), 'other-home': imported('other-home', 'home-two'),
      }, messagesVersion: 1, isLoaded: true }),
    } });
    expect(getForkedTranscriptSnapshotCached(state, 'child')?.combinedMessageIdsOldestFirst).toEqual(['same-home', 'other-home']);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('reveals cached ancestor segments only as closer history starts are reached, without stealing child-native ids', () => {
    const state = {
      ...createState({
        sessions: {
          root: sessionRow('root', { path: '/tmp', host: 'h' }),
          parent: sessionRow('parent', {
            path: '/tmp', host: 'h',
            forkV1: { v: 1, parentSessionId: 'root', parentCutoffSeqInclusive: 5, createdAtMs: 1, strategy: 'provider_native' },
          }),
          child: sessionRow('child', {
            path: '/tmp', host: 'h',
            forkV1: { v: 1, parentSessionId: 'parent', parentCutoffSeqInclusive: 50, createdAtMs: 2, strategy: 'provider_native' },
          }),
        },
        sessionMessages: {
          root: sessionMessagesRow({ idsOldestFirst: ['root-row'], messagesById: { 'root-row': userMessage('root-row', 5, 'root') }, messagesVersion: 1, isLoaded: true }),
          parent: sessionMessagesRow({ idsOldestFirst: ['shared-id'], messagesById: { 'shared-id': userMessage('shared-id', 50, 'parent version') }, messagesVersion: 1, isLoaded: true }),
          child: sessionMessagesRow({ idsOldestFirst: ['shared-id', 'child-tail'], messagesById: {
            'shared-id': userMessage('shared-id', 100, 'child version'),
            'child-tail': userMessage('child-tail', 101, 'child tail'),
          }, messagesVersion: 1, isLoaded: true }),
        },
      }),
      sessionMessagesHistoryStartLoaded: {} as Record<string, true>,
    };
    const childWindow = getForkedTranscriptSnapshotCached(state, 'child')!;
    expect(childWindow.combinedMessageIdsOldestFirst).toEqual(['shared-id', 'child-tail']);
    expect(childWindow.combinedMessagesById['shared-id']).toMatchObject({ seq: 100, text: 'child version' });
    expect(childWindow.segments.map((segment) => segment.sessionId)).toEqual(['root', 'parent', 'child']);
    expect(childWindow.segments[0]!.messageIdsOldestFirst).toEqual([]);

    state.sessionMessagesHistoryStartLoaded = { child: true };
    const parentWindow = getForkedTranscriptSnapshotCached(state, 'child')!;
    expect(parentWindow).not.toBe(childWindow);
    expect(parentWindow.combinedMessageIdsOldestFirst).toEqual(['shared-id', 'child-tail']);
    expect(parentWindow.combinedMessagesById['shared-id']).toMatchObject({ seq: 50, text: 'parent version' });
    expect(parentWindow.messageOriginById['shared-id']).toEqual({ sessionId: 'parent', isReadOnlyContext: true });
    expect(parentWindow.segments[0]!.messageIdsOldestFirst).toEqual([]);

    state.sessionMessagesHistoryStartLoaded = { child: true, parent: true };
    const rootWindow = getForkedTranscriptSnapshotCached(state, 'child')!;
    expect(rootWindow.combinedMessageIdsOldestFirst).toEqual(['root-row', 'shared-id', 'child-tail']);
    expect(state.sessionMessages.parent!.messageIdsOldestFirst).toEqual(['shared-id']);
    expect(state.sessionMessages.child!.messageIdsOldestFirst).toEqual(['shared-id', 'child-tail']);
  });

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
      sessionMessagesHistoryStartLoaded: { child: true },
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
      sessionMessagesHistoryStartLoaded: { child: true, parent: true },
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

  it('dedupes overlapping message ids across visible segments by preferring the ancestor segment', () => {
    const parentMessagesById: Record<string, Message> = {
      shared: userMessage('shared', 1, 'shared-parent'),
      p2: userMessage('p2', 2, 'two'),
    };
    const childMessagesById: Record<string, Message> = {
      shared: userMessage('shared', 1, 'shared-child'),
      c2: userMessage('c2', 2, 'child-two'),
    };

    const state = createState({
      sessions: {
        parent: { ...sessionRow('parent', { path: '/tmp', host: 'h' }), seq: 2 },
        child: {
          ...sessionRow('child', {
            path: '/tmp',
            host: 'h',
            forkV1: {
              v: 1,
              parentSessionId: 'parent',
              parentCutoffSeqInclusive: 2,
              createdAtMs: 1,
              strategy: 'provider_native',
            },
          } as any),
          seq: 2,
        },
      },
      sessionMessages: {
        parent: sessionMessagesRow({ idsOldestFirst: ['shared', 'p2'], messagesById: parentMessagesById, messagesVersion: 1, isLoaded: true }),
        child: sessionMessagesRow({ idsOldestFirst: ['shared', 'c2'], messagesById: childMessagesById, messagesVersion: 1, isLoaded: true }),
      },
      sessionMessagesHistoryStartLoaded: { child: true },
    });

    const snapshot = getForkedTranscriptSnapshotCached(state, 'child');
    expect(snapshot).not.toBeNull();
    expect(snapshot!.combinedMessageIdsOldestFirst).toEqual(['shared', 'p2', 'c2']);
    expect(snapshot!.messageOriginById['shared']).toEqual({ sessionId: 'parent', isReadOnlyContext: true });
    expect(snapshot!.combinedMessagesById['shared']?.kind).toBe('user-text');
    expect((snapshot!.combinedMessagesById['shared'] as any).text).toBe('shared-parent');
  });

  it('evicts the oldest cached snapshot when many child sessions are resolved', () => {
    const sessions: Record<string, Session> = {
      root: sessionRow('root', { path: '/tmp', host: 'h' }),
    };
    const sessionMessages: Record<string, SessionMessages> = {
      root: sessionMessagesRow({ idsOldestFirst: [], messagesById: {}, messagesVersion: 1, isLoaded: true }),
    };

    for (let index = 0; index < 65; index += 1) {
      const childSessionId = `child_${index}`;
      sessions[childSessionId] = {
        ...sessionRow(childSessionId, {
          path: '/tmp',
          host: 'h',
          forkV1: {
            v: 1,
            parentSessionId: 'root',
            parentCutoffSeqInclusive: 0,
            createdAtMs: index + 1,
            strategy: 'replay',
          },
        } as any),
        seq: 1,
      };
      sessionMessages[childSessionId] = sessionMessagesRow({
        idsOldestFirst: [childSessionId],
        messagesById: {
          [childSessionId]: userMessage(childSessionId, 1, childSessionId),
        },
        messagesVersion: 1,
        isLoaded: true,
      });
    }

    const state = createState({ sessions, sessionMessages });
    const firstSnapshot = getForkedTranscriptSnapshotCached(state, 'child_0');
    expect(firstSnapshot).not.toBeNull();

    for (let index = 1; index < 65; index += 1) {
      expect(getForkedTranscriptSnapshotCached(state, `child_${index}`)).not.toBeNull();
    }

    const evictedSnapshot = getForkedTranscriptSnapshotCached(state, 'child_0');
    expect(evictedSnapshot).not.toBeNull();
    expect(evictedSnapshot).not.toBe(firstSnapshot);
  });

  it('honors the configured forked snapshot cache working set', async () => {
    vi.resetModules();
    vi.stubEnv('EXPO_PUBLIC_HAPPIER_SYNC_TUNING_JSON', JSON.stringify({
      transcriptForkedSnapshotCacheMaxSessions: 4,
    }));
    const {
      getForkedTranscriptSnapshotCached: getConfiguredForkedTranscriptSnapshotCached,
    } = await import('./forkedTranscriptSnapshot');

    const sessions: Record<string, Session> = {
      root: sessionRow('root', { path: '/tmp', host: 'h' }),
    };
    const sessionMessages: Record<string, SessionMessages> = {
      root: sessionMessagesRow({ idsOldestFirst: [], messagesById: {}, messagesVersion: 1, isLoaded: true }),
    };

    for (let index = 0; index < 6; index += 1) {
      const childSessionId = `configured_child_${index}`;
      sessions[childSessionId] = {
        ...sessionRow(childSessionId, {
          path: '/tmp',
          host: 'h',
          forkV1: {
            v: 1,
            parentSessionId: 'root',
            parentCutoffSeqInclusive: 0,
            createdAtMs: index + 1,
            strategy: 'replay',
          },
        } as any),
        seq: 1,
      };
      sessionMessages[childSessionId] = sessionMessagesRow({
        idsOldestFirst: [childSessionId],
        messagesById: {
          [childSessionId]: userMessage(childSessionId, 1, childSessionId),
        },
        messagesVersion: 1,
        isLoaded: true,
      });
    }

    const state = createState({ sessions, sessionMessages });
    const firstSnapshot = getConfiguredForkedTranscriptSnapshotCached(state, 'configured_child_0');
    expect(firstSnapshot).not.toBeNull();

    for (let index = 1; index < 6; index += 1) {
      expect(getConfiguredForkedTranscriptSnapshotCached(state, `configured_child_${index}`)).not.toBeNull();
    }

    const evictedSnapshot = getConfiguredForkedTranscriptSnapshotCached(state, 'configured_child_0');
    expect(evictedSnapshot).not.toBeNull();
    expect(evictedSnapshot).not.toBe(firstSnapshot);
  });
});
