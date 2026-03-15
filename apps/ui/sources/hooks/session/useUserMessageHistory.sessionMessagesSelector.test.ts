import { describe, expect, it } from 'vitest';

import type { Message } from '@/sync/domains/messages/messageTypes';

import { collectUserTextMessagesBySessionIdFromSessionMessagesState } from './useUserMessageHistory';

function user(id: string, createdAt: number, text: string): Message {
  return { kind: 'user-text', id, localId: null, createdAt, text };
}

function agent(id: string, createdAt: number, text: string): Message {
  return { kind: 'agent-text', id, localId: null, createdAt, text };
}

describe('collectUserTextMessagesBySessionIdFromSessionMessagesState', () => {
  it('returns per-session user-text messages from ids+byId', () => {
    const out = collectUserTextMessagesBySessionIdFromSessionMessagesState({
      s1: {
        messageIdsOldestFirst: ['u1', 'a1', 'u2'],
        messagesById: {
          u1: user('u1', 1, 'hi'),
          a1: agent('a1', 2, 'ok'),
          u2: user('u2', 3, 'bye'),
        },
      },
      s2: {
        messageIdsOldestFirst: ['a2', 'u3'],
        messagesById: {
          a2: agent('a2', 1, 'x'),
          u3: user('u3', 2, 'yo'),
        },
      },
    } as any);

    expect(out.s1?.map((m) => m.id)).toEqual(['u1', 'u2']);
    expect(out.s2?.map((m) => m.id)).toEqual(['u3']);
  });

  it('falls back to messagesMap when messagesById is missing', () => {
    const out = collectUserTextMessagesBySessionIdFromSessionMessagesState({
      s1: {
        messageIdsOldestFirst: ['u1'],
        messagesMap: {
          u1: user('u1', 1, 'hi'),
        },
      },
    } as any);

    expect(out.s1?.map((m) => m.id)).toEqual(['u1']);
  });
});
