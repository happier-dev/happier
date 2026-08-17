import { describe, expect, it } from 'vitest'

import { ApiMessageSchema } from './apiTypes'

describe('ApiMessageSchema', () => {
  it('accepts encrypted message envelopes', () => {
    const parsed = ApiMessageSchema.safeParse({
      id: 'm1',
      seq: 1,
      localId: null,
      content: { t: 'encrypted', c: 'aGVsbG8=' },
      createdAt: 1,
    })
    expect(parsed.success).toBe(true)
  })

  it('accepts plaintext message envelopes', () => {
    const parsed = ApiMessageSchema.safeParse({
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

    const parsed = ApiMessageSchema.safeParse({
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

    expect(ApiMessageSchema.safeParse({
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
    const parsed = ApiMessageSchema.safeParse({
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
