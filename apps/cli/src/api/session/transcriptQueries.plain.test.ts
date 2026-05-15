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

  it('ignores permission intent metadata on non-text plaintext user rows', async () => {
    vi.spyOn(axios, 'get').mockResolvedValueOnce({
      data: {
        messages: [
          {
            createdAt: 123,
            content: {
              t: 'plain',
              v: {
                role: 'user',
                content: { type: 'tool-result', text: 'not a user command' },
                meta: { permissionMode: 'yolo' },
              },
            },
          },
        ],
      },
    } as any)

    await expect(fetchLatestUserPermissionIntentFromEncryptedTranscript(queryParams)).resolves.toBeNull()
  })

  it('prefilters ACP import transcript text to user and agent rows on the server', async () => {
    const getSpy = vi.spyOn(axios, 'get').mockResolvedValueOnce({
      data: { messages: [] },
    } as any)

    await fetchRecentTranscriptTextItemsForAcpImportFromServer(queryParams)

    expect(getSpy.mock.calls[0]?.[1]?.params).toEqual({
      limit: 150,
      roles: 'user,agent',
    })
  })

  it('uses canonical semantic extraction for Codex assistant text during ACP import', async () => {
    vi.spyOn(axios, 'get').mockResolvedValueOnce({
      data: {
        messages: [
          {
            createdAt: 100,
            content: {
              t: 'plain',
              v: {
                role: 'agent',
                content: { type: 'codex', data: { type: 'message', message: 'codex reply' } },
              },
            },
          },
        ],
      },
    } as any)

    await expect(fetchRecentTranscriptTextItemsForAcpImportFromServer(queryParams)).resolves.toEqual([
      { role: 'agent', text: 'codex reply' },
    ])
  })

  it('prefilters permission intent scans to user rows on the server', async () => {
    const getSpy = vi.spyOn(axios, 'get').mockResolvedValueOnce({
      data: { messages: [] },
    } as any)

    await fetchLatestUserPermissionIntentFromEncryptedTranscript(queryParams)

    expect(getSpy.mock.calls[0]?.[1]?.params).toEqual({
      limit: 200,
      role: 'user',
    })
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
