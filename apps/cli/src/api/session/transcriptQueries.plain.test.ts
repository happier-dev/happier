import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/configuration', () => ({
  configuration: { serverUrl: 'http://example.test', apiServerUrl: 'http://example.test' },
}))

vi.mock('@/ui/logger', () => ({
  logger: { debug: vi.fn() },
}))

vi.mock('../client/loopbackUrl', () => ({
  resolveLoopbackHttpUrl: (url: string) => url,
}))

import axios from 'axios'

import { HttpStatusError, isAuthenticationError } from '@/api/client/httpStatusError'
import {
  fetchLatestUserPermissionIntentFromEncryptedTranscript,
  fetchRecentTranscriptTextItemsForAcpImportFromServer,
} from './transcriptQueries'

const queryParams = {
  token: 't',
  sessionId: 's1',
  encryptionKey: new Uint8Array(32),
  encryptionVariant: 'dataKey' as const,
}

afterEach(() => {
  vi.restoreAllMocks()
})

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
      ...queryParams,
    })

    expect(res).toEqual({ intent: 'yolo', updatedAt: 123 })
  })

  it.each([401, 403] as const)('rethrows auth failures while fetching ACP import transcript text (%s)', async (status) => {
    const authError = new HttpStatusError(status, 'Authentication failed')
    vi.spyOn(axios, 'get').mockRejectedValueOnce(authError)

    await expect(fetchRecentTranscriptTextItemsForAcpImportFromServer(queryParams)).rejects.toBe(authError)
    expect(isAuthenticationError(authError)).toBe(true)
  })

  it.each([401, 403] as const)('rethrows auth failures while fetching permission intent (%s)', async (status) => {
    const authError = new HttpStatusError(status, 'Authentication failed')
    vi.spyOn(axios, 'get').mockRejectedValueOnce(authError)

    await expect(fetchLatestUserPermissionIntentFromEncryptedTranscript(queryParams)).rejects.toBe(authError)
    expect(isAuthenticationError(authError)).toBe(true)
  })

  it('keeps non-auth ACP import fetch failures empty', async () => {
    vi.spyOn(axios, 'get').mockRejectedValueOnce(new Error('temporary server failure'))

    await expect(fetchRecentTranscriptTextItemsForAcpImportFromServer(queryParams)).resolves.toEqual([])
  })

  it('keeps non-auth permission intent fetch failures null', async () => {
    vi.spyOn(axios, 'get').mockRejectedValueOnce(new Error('temporary server failure'))

    await expect(fetchLatestUserPermissionIntentFromEncryptedTranscript(queryParams)).resolves.toBeNull()
  })
})
