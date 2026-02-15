import { describe, expect, it } from 'vitest';

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
    expect(nav.moveUp('draft')).toBe('a');
    expect(nav.moveUp('draft')).toBe('a');

    expect(nav.moveDown()).toBe('b');
    expect(nav.moveDown()).toBe('draft');
    expect(nav.moveDown()).toBe(null);
  });
});

