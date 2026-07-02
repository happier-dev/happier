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

import axios, { AxiosError, AxiosHeaders, type InternalAxiosRequestConfig } from 'axios'

import { HttpStatusError, isAuthenticationError } from '@/api/client/httpStatusError'
import { logger } from '@/ui/logger'
import {
  detectCommittedProviderActivityAfterLatestUserPrompt,
  fetchLatestCommittedUserTextAtOrBeforeMs,
  fetchLatestUserPermissionIntentFromEncryptedTranscript,
  fetchRecentTranscriptTextItemsForAcpImportFromServer,
  hasCommittedUserMessageAfterMs,
} from './transcriptQueries'

const queryParams = {
  token: 't',
  sessionId: 's1',
  encryptionKey: new Uint8Array(32),
  encryptionVariant: 'dataKey' as const,
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.mocked(logger.debug).mockReset()
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

  it('detects committed user messages after a recovery failure timestamp', async () => {
    const getSpy = vi.spyOn(axios, 'get').mockResolvedValueOnce({
      data: {
        messages: [
          { createdAt: 101 },
          { createdAt: 99 },
        ],
      },
    } as any)

    await expect(hasCommittedUserMessageAfterMs({
      token: 't',
      sessionId: 's1',
      failureAtMs: 100,
    })).resolves.toBe(true)

    expect(getSpy.mock.calls[0]?.[1]?.params).toEqual({
      limit: 25,
      role: 'user',
    })
  })

  it('does not treat older user messages as continuation suppression evidence', async () => {
    vi.spyOn(axios, 'get').mockResolvedValueOnce({
      data: {
        messages: [
          { createdAt: 100 },
          { createdAt: 99 },
        ],
      },
    } as any)

    await expect(hasCommittedUserMessageAfterMs({
      token: 't',
      sessionId: 's1',
      failureAtMs: 100,
    })).resolves.toBe(false)
  })

  it('fetches the latest committed user text at or before a recovery failure timestamp', async () => {
    const getSpy = vi.spyOn(axios, 'get').mockResolvedValueOnce({
      data: {
        messages: [
          {
            localId: 'after-failure',
            createdAt: 150,
            content: {
              t: 'plain',
              v: {
                role: 'user',
                content: { type: 'text', text: 'too late' },
              },
            },
          },
          {
            localId: 'original-local-id',
            createdAt: 100,
            content: {
              t: 'plain',
              v: {
                role: 'user',
                content: { type: 'text', text: 'retry this prompt' },
                meta: { permissionMode: 'safe-yolo', model: 'claude-sonnet' },
              },
            },
          },
          {
            localId: 'older-local-id',
            createdAt: 90,
            content: {
              t: 'plain',
              v: {
                role: 'user',
                content: { type: 'text', text: 'older prompt' },
              },
            },
          },
        ],
      },
    } as any)

    await expect(fetchLatestCommittedUserTextAtOrBeforeMs({
      ...queryParams,
      failureAtMs: 125,
    })).resolves.toEqual({
      text: 'retry this prompt',
      localId: 'original-local-id',
      createdAt: 100,
      permissionMode: 'safe-yolo',
      model: 'claude-sonnet',
    })

    expect(getSpy.mock.calls[0]?.[1]?.params).toEqual({
      limit: 100,
      roles: 'user,agent',
    })
  })

  it('detects committed provider activity after the latest committed user prompt', async () => {
    vi.spyOn(axios, 'get').mockResolvedValueOnce({
      data: {
        messages: [
          {
            createdAt: 130,
            content: {
              t: 'plain',
              v: {
                role: 'agent',
                content: { type: 'text', text: 'provider resumed' },
              },
            },
          },
          {
            createdAt: 100,
            content: {
              t: 'plain',
              v: {
                role: 'user',
                content: { type: 'text', text: 'latest prompt' },
              },
            },
          },
          {
            createdAt: 80,
            content: {
              t: 'plain',
              v: {
                role: 'agent',
                content: { type: 'text', text: 'older reply' },
              },
            },
          },
        ],
      },
    } as any)

    await expect(detectCommittedProviderActivityAfterLatestUserPrompt({
      ...queryParams,
      failureAtMs: 110,
    })).resolves.toEqual({
      status: 'activity_found',
      userPromptAtMs: 100,
      providerActivityAtMs: 130,
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

  it('redacts continuation transcript fetch diagnostics', async () => {
    const error = new AxiosError(
      'Request failed with Authorization: Bearer MESSAGE_SECRET',
      'ERR_BAD_RESPONSE',
      {
        method: 'get',
        url: 'http://example.test/v1/sessions/s1/messages?token=QUERY_SECRET',
        headers: new AxiosHeaders({ Authorization: 'Bearer HEADER_SECRET' }),
        data: { access_token: 'BODY_SECRET' },
      } satisfies InternalAxiosRequestConfig,
    )
    vi.spyOn(axios, 'get').mockRejectedValueOnce(error)

    await expect(hasCommittedUserMessageAfterMs({
      token: 't',
      sessionId: 's1',
      failureAtMs: 100,
    })).resolves.toBe(false)

    const diagnostic = JSON.stringify(vi.mocked(logger.debug).mock.calls.at(-1)?.[1])
    expect(diagnostic).toContain('http://example.test/v1/sessions/s1/messages')
    expect(diagnostic).not.toContain('MESSAGE_SECRET')
    expect(diagnostic).not.toContain('QUERY_SECRET')
    expect(diagnostic).not.toContain('HEADER_SECRET')
    expect(diagnostic).not.toContain('BODY_SECRET')
  })

  it('keeps non-auth permission intent fetch failures null', async () => {
    vi.spyOn(axios, 'get').mockRejectedValueOnce(new Error('temporary server failure'))

    await expect(fetchLatestUserPermissionIntentFromEncryptedTranscript(queryParams)).resolves.toBeNull()
  })
})
