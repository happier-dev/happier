import { SessionMessageV1Schema } from '@happier-dev/protocol/sessions/messages/sessionMessagesPageV1';
import { describe, expect, it } from 'vitest'



describe('SessionMessageV1Schema', () => {
  it('preserves evaluated actor objects and explicit null while accepting older omissions', () => {
    const row = { id: 'm1', seq: 1, createdAt: 1, content: { t: 'plain', v: {} } };
    const actor = { v: 1, accountId: 'alice', profile: null };
    expect(SessionMessageV1Schema.parse({ ...row, accountActor: actor })).toHaveProperty('accountActor', actor);
    expect(SessionMessageV1Schema.parse({ ...row, accountActor: null })).toHaveProperty('accountActor', null);
    expect(SessionMessageV1Schema.parse(row)).not.toHaveProperty('accountActor');
    expect(SessionMessageV1Schema.safeParse({ ...row, accountActor: { ...actor, role: 'owner' } }).success).toBe(false);
  });

  it('accepts encrypted message envelopes', () => {
    const parsed = SessionMessageV1Schema.safeParse({
      id: 'm1',
      seq: 1,
      localId: null,
      content: { t: 'encrypted', c: 'aGVsbG8=' },
      createdAt: 1,
    })
    expect(parsed.success).toBe(true)
  })

  it('accepts plaintext message envelopes', () => {
    const parsed = SessionMessageV1Schema.safeParse({
      id: 'm1',
      seq: 1,
      localId: null,
      messageRole: 'user',
      content: { t: 'plain', v: { kind: 'user-text', text: 'hello' } },
      createdAt: 1,
    })
    expect(parsed.success).toBe(true)
  })

  it('accepts only a canonical opaque message action reference', () => {
    const reference = {
      v: 1,
      sessionId: 'session-1',
      messageId: 'm1',
      observedRevision: 'revision-4',
    } as const

    const parsed = SessionMessageV1Schema.safeParse({
      id: 'm1',
      seq: 1,
      localId: null,
      content: { t: 'encrypted', c: 'aGVsbG8=' },
      createdAt: 1,
      messageActionReference: reference,
    })
    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    expect(parsed.data.messageActionReference).toEqual(reference)

    expect(SessionMessageV1Schema.safeParse({
      id: 'm1',
      seq: 1,
      localId: null,
      content: { t: 'encrypted', c: 'aGVsbG8=' },
      createdAt: 1,
      messageActionReference: {
        v: 1,
        sessionId: 'session-1',
        messageId: 'm1',
        localId: 'optimistic-local-id',
      },
    }).success).toBe(false)
  })

  it('rejects unsupported message role metadata', () => {
    const parsed = SessionMessageV1Schema.safeParse({
      id: 'm1',
      seq: 1,
      localId: null,
      messageRole: 'operator',
      content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'hello' } } },
      createdAt: 1,
    })

    expect(parsed.success).toBe(false)
  })
})
