import { describe, expect, it, vi } from 'vitest'

vi.mock('@/configuration', () => ({
  configuration: { serverUrl: 'http://example.test' },
}))

vi.mock('@/ui/logger', () => ({
  logger: { debug: vi.fn() },
}))

vi.mock('../client/loopbackUrl', () => ({
  resolveLoopbackHttpUrl: (url: string) => url,
}))

import axios from 'axios'

import { fetchLatestUserPermissionIntentFromEncryptedTranscript } from './transcriptQueries'

describe('transcriptQueries (plaintext envelopes)', () => {
  it('resolves permission intent from plaintext transcript messages', async () => {
    vi.spyOn(axios, 'get').mockResolvedValueOnce({
      data: {
        messages: [
          {
            createdAt: 123,
            content: {
              t: 'plain',
              v: {
                role: 'user',
                content: { type: 'text', text: 'hello' },
                meta: { permissionMode: 'yolo' },
              },
            },
          },
        ],
      },
    } as any)

    const res = await fetchLatestUserPermissionIntentFromEncryptedTranscript({
      token: 't',
      sessionId: 's1',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'dataKey',
    })

    expect(res).toEqual({ intent: 'yolo', updatedAt: 123 })
  })
})
