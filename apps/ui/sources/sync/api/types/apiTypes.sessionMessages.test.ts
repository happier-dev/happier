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
      content: { t: 'plain', v: { kind: 'user-text', text: 'hello' } },
      createdAt: 1,
    })
    expect(parsed.success).toBe(true)
  })
})

