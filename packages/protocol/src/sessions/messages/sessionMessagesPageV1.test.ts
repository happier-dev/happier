import { expect, it } from 'vitest';
import { buildSessionMessagesPath, SessionMessagesPageV1Schema } from './sessionMessagesPageV1.js';

it('encodes an exact message selector on the existing scoped path without paging operands', () => {
  const input = { sessionId: 'session/1', scope: 'sidechain' as const, sidechainId: 'child',
    roles: ['agent'] as const, messageId: 'message/3', limit: 20 };
  const url = new URL(buildSessionMessagesPath(input), 'https://home.test');
  expect(url.pathname).toBe('/v1/sessions/session%2F1/messages');
  expect(Object.fromEntries(url.searchParams)).toEqual({ scope: 'sidechain', sidechainId: 'child',
    roles: 'agent', messageId: 'message/3' });
  const external = { ...input, projection: 'externalShareableV1' as const };
  expect(() => buildSessionMessagesPath(external)).toThrow();
});

it('rejects invalid row identities and cursors at the shared wire owner', () => {
  const row = { id: 'm1', seq: 1, content: { t: 'plain', v: {} }, createdAt: 1 };
  expect(SessionMessagesPageV1Schema.safeParse({ messages: [{ ...row, seq: 1.5 }] }).success).toBe(false);
  expect(SessionMessagesPageV1Schema.safeParse({ messages: [{ ...row, id: '' }] }).success).toBe(false);
  expect(SessionMessagesPageV1Schema.safeParse({ messages: [row], nextAfterSeq: -1 }).success).toBe(false);
  expect(SessionMessagesPageV1Schema.safeParse({ messages: [{ ...row, createdAt: Infinity }] }).success).toBe(false);
});

it('only requests detached output on the exact-message selector', () => {
  const input = { sessionId: 's1', scope: 'all', includeToolOutput: true } as const;
  expect(() => buildSessionMessagesPath(input)).toThrow();
  const exact = new URL(buildSessionMessagesPath({ ...input, messageId: 'm1' }), 'https://home.test');
  expect(exact.searchParams.get('messageId')).toBe('m1');
  expect(exact.searchParams.get('includeToolOutput')).toBe('true');
});
