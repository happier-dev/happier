import { describe, expect, it } from 'vitest'

import { SessionMessageContentSchema } from './types'

describe('SessionMessageContentSchema', () => {
  it('accepts encrypted envelopes', () => {
    const parsed = SessionMessageContentSchema.safeParse({ t: 'encrypted', c: 'aGVsbG8=' })
    expect(parsed.success).toBe(true)
  })

  it('accepts plaintext envelopes', () => {
    const parsed = SessionMessageContentSchema.safeParse({ t: 'plain', v: { kind: 'user-text', text: 'hello' } })
    expect(parsed.success).toBe(true)
  })
})

