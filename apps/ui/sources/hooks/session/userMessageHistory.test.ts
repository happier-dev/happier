import { describe, expect, it, vi } from 'vitest';

import type { Message } from '@/sync/domains/messages/messageTypes';

import {
  collectUserMessageHistoryEntries,
  createUserMessageHistoryNavigator,
} from './userMessageHistory';

function user(id: string, createdAt: number, text: string): Message {
  return { kind: 'user-text', id, localId: null, createdAt, text };
}

function agent(id: string, createdAt: number, text: string): Message {
  return { kind: 'agent-text', id, localId: null, createdAt, text };
}

describe('collectUserMessageHistoryEntries', () => {
  it('collects recent user messages for a single session (most recent first)', () => {
    const entries = collectUserMessageHistoryEntries({
      scope: 'perSession',
      sessionId: 's1',
      messagesBySessionId: {
        s1: [user('u1', 1, 'hi'), agent('a1', 2, 'ok'), user('u2', 3, 'bye')],
      },
      maxEntries: 50,
    });

    expect(entries).toEqual(['bye', 'hi']);
  });

  it('collects user messages globally across sessions sorted by recency', () => {
    const entries = collectUserMessageHistoryEntries({
      scope: 'global',
      sessionId: 's1',
      messagesBySessionId: {
        s1: [user('u1', 1, 'hi'), user('u2', 4, 'bye')],
        s2: [user('u3', 3, 'yo')],
      },
      maxEntries: 50,
    });

    expect(entries).toEqual(['bye', 'yo', 'hi']);
  });

  it('dedupes user messages and drops empty/whitespace-only values', () => {
    const entries = collectUserMessageHistoryEntries({
      scope: 'global',
      sessionId: 's1',
      messagesBySessionId: {
        s1: [user('u1', 1, 'hi'), user('u2', 2, 'hi'), user('u3', 3, '   ')],
        s2: [user('u4', 4, 'hi'), user('u5', 5, 'yo')],
      },
      maxEntries: 50,
    });

    expect(entries).toEqual(['yo', 'hi']);
  });
});

describe('createUserMessageHistoryNavigator', () => {
  it('cycles upward through entries and returns draft when cycling down past the newest entry', () => {
    const nav = createUserMessageHistoryNavigator(['b', 'a']);

    expect(nav.moveUp('draft')).toBe('b');
    expect(nav.moveUp('b')).toBe('a');
    expect(nav.moveUp('a')).toBe('a');

    expect(nav.moveDown('a')).toBe('b');
    expect(nav.moveDown('b')).toBe('draft');
    expect(nav.moveDown('draft')).toBe(null);
  });

  it('reads dynamic entries without replacing navigator state', () => {
    let entries = ['c', 'b'];
    const visited: Array<{ index: number; entriesLength: number }> = [];
    const nav = createUserMessageHistoryNavigator(() => entries, {
      onMoveUp: (state) => visited.push(state),
    });

    expect(nav.moveUp('draft')).toBe('c');
    entries = ['c', 'b', 'a'];
    expect(nav.moveUp('c')).toBe('b');
    expect(nav.moveUp('b')).toBe('a');
    expect(visited).toEqual([
      { index: 0, entriesLength: 2 },
      { index: 1, entriesLength: 3 },
      { index: 2, entriesLength: 3 },
    ]);
  });

  it('requests warmup when moving up with no loaded entries', () => {
    const onWarmup = vi.fn();
    const nav = createUserMessageHistoryNavigator([], { onWarmup });

    expect(nav.moveUp('draft')).toBe(null);
    expect(nav.hasRetainedSession()).toBe(false);
    expect(onWarmup).toHaveBeenCalledTimes(1);
  });

  it('preserves the original draft while editing a recalled history entry', () => {
    const nav = createUserMessageHistoryNavigator(['second', 'first']);

    expect(nav.moveUp('new draft')).toBe('second');

    expect(nav.moveUp('second edited')).toBe('first');
    expect(nav.moveDown('first')).toBe('second edited');
    expect(nav.moveDown('second edited')).toBe('new draft');
  });

  it('preserves separate edits for multiple recalled history entries', () => {
    const nav = createUserMessageHistoryNavigator(['third', 'second', 'first']);

    expect(nav.moveUp('draft')).toBe('third');
    expect(nav.moveUp('third edited')).toBe('second');
    expect(nav.moveUp('second edited')).toBe('first');

    expect(nav.moveDown('first')).toBe('second edited');
    expect(nav.moveDown('second edited again')).toBe('third edited');
    expect(nav.moveUp('third edited again')).toBe('second edited again');
    expect(nav.moveDown('second edited again')).toBe('third edited again');
    expect(nav.moveDown('third edited again')).toBe('draft');
  });

  it('pauses browsing without discarding the editable history session', () => {
    const nav = createUserMessageHistoryNavigator(['second', 'first']);

    expect(nav.moveUp('draft')).toBe('second');
    nav.pause('second edited');

    expect(nav.isBrowsing()).toBe(false);
    expect(nav.hasRetainedSession()).toBe(true);
    expect(nav.moveDown('second edited')).toBe('draft');
  });

  it('returns null for idle ArrowDown without a retained history session', () => {
    const nav = createUserMessageHistoryNavigator(['second', 'first']);

    expect(nav.moveDown('draft')).toBe(null);
    expect(nav.hasRetainedSession()).toBe(false);
  });

  it('reset clears retained history edits and the original draft', () => {
    const nav = createUserMessageHistoryNavigator(['second', 'first']);

    expect(nav.moveUp('old draft')).toBe('second');
    expect(nav.moveUp('second edited')).toBe('first');
    nav.reset();

    expect(nav.hasRetainedSession()).toBe(false);
    expect(nav.moveUp('fresh draft')).toBe('second');
    expect(nav.moveDown('second')).toBe('fresh draft');
  });

  it('reports whether history browsing is active', () => {
    const nav = createUserMessageHistoryNavigator(['second', 'first']);

    expect(nav.isBrowsing()).toBe(false);
    expect(nav.moveUp('draft')).toBe('second');
    expect(nav.isBrowsing()).toBe(true);
    expect(nav.moveDown('second')).toBe('draft');
    expect(nav.isBrowsing()).toBe(false);
  });

  it('handles entries source growth while retaining the current editable slot', () => {
    let entries = ['second', 'first'];
    const nav = createUserMessageHistoryNavigator(() => entries);

    expect(nav.moveUp('draft')).toBe('second');
    entries = ['second', 'first', 'zeroth'];

    expect(nav.moveUp('second edited')).toBe('first');
    expect(nav.moveUp('first edited')).toBe('zeroth');
    expect(nav.moveDown('zeroth')).toBe('first edited');
    expect(nav.moveDown('first edited')).toBe('second edited');
    expect(nav.moveDown('second edited')).toBe('draft');
  });
});
