import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/configuration', () => ({
  configuration: { serverUrl: 'http://example.test', apiServerUrl: 'http://example.test' },
}))

vi.mock('@/ui/logger', () => ({
  logger: { debug: vi.fn() },
}))

import axios, { AxiosError, AxiosHeaders, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios'
import { encodeBase64, encrypt } from '@/api/encryption'

import { HttpStatusError, isAuthenticationError } from '@/api/client/httpStatusError'
import { logger } from '@/ui/logger'
import { buildAcpAgentMessageEnvelope } from './acpMessageEnvelope'
import { SessionMessageV1Schema } from '@happier-dev/protocol/sessions/messages/sessionMessagesPageV1'
import {
  fetchCommittedTranscriptLocalIdBaseline,
  fetchEarliestCommittedUserMessageLocalId,
  fetchLatestUserPermissionIntentFromEncryptedTranscript,
  fetchRecentTranscriptTextItemsForAcpImportFromServer,
  hasCommittedUserMessageAfterMs,
} from './transcriptQueries'

const queryParams = {
  token: 't',
  sessionId: 's1',
  encryptionKey: new Uint8Array(32),
  encryptionVariant: 'dataKey' as const,
  encryptionMode: 'e2ee' as const,
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.mocked(logger.debug).mockReset()
})

describe('transcriptQueries (plaintext envelopes)', () => {
  it.each(['plain', 'e2ee'] as const)('reads one earliest user identity from a %s Session without paging its history', async encryptionMode => {
    const payload = { role: 'user', content: { type: 'text', text: 'first prompt' } };
    const row = SessionMessageV1Schema.parse({ id: 'first', seq: 2, createdAt: 1, localId: 'first-prompt',
      sidechainId: null, messageRole: 'user',
      content: encryptionMode === 'plain' ? { t: 'plain', v: payload }
        : { t: 'encrypted', c: encodeBase64(encrypt(queryParams.encryptionKey, queryParams.encryptionVariant, payload)) },
    });
    const get = vi.spyOn(axios, 'get').mockImplementation(async url => {
      const query = new URL(String(url)).searchParams;
      expect(Object.fromEntries(query)).toMatchObject({ scope: 'main', role: 'user', afterSeq: '0', limit: '1' });
      return { status: 200, data: { messages: [row], hasMore: true, nextAfterSeq: 2, nextBeforeSeq: null } } as AxiosResponse;
    });
    await expect(fetchEarliestCommittedUserMessageLocalId(encryptionMode === 'plain'
      ? { token: 't', sessionId: 's1', encryptionMode } : queryParams)).resolves.toBe('first-prompt');
    expect(get).toHaveBeenCalledTimes(1);
  });

  it.each(['plain', 'e2ee'] as const)('retains consumed source facts from every transcript scope in a cold %s identity baseline', async encryptionMode => {
    const marker = buildAcpAgentMessageEnvelope({ provider: 'claude',
      body: { type: 'output', data: { type: 'progress', marker: 'source_fact_consumed', reason: 'host_prompt_echo' } },
      meta: { happier: { kind: 'source_fact_consumed.v1' } },
    })
    const rows = [null, 'child-run'].map((sidechainId, index) => SessionMessageV1Schema.parse({
      id: `marker-${index}`, seq: index + 1, localId: `native-user-${index}`, sidechainId, messageRole: 'unknown', createdAt: 100,
      content: encryptionMode === 'plain' ? { t: 'plain', v: marker }
        : { t: 'encrypted', c: encodeBase64(encrypt(queryParams.encryptionKey, queryParams.encryptionVariant, marker)) },
    }))
    // Home HTTP is the boundary. Honor its role/scope filters so an incomplete
    // reader request cannot accidentally receive the very markers it excluded.
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      const query = new URL(String(url)).searchParams
      const roles = query.get('roles')?.split(',')
      return { status: 200, data: { messages: rows.filter(row =>
        (!roles || roles.includes(row.messageRole!)) && (query.get('scope') === 'all' || row.sidechainId === null)),
        hasMore: false, nextBeforeSeq: null, nextAfterSeq: null,
      } } as AxiosResponse
    })
    const result = await fetchCommittedTranscriptLocalIdBaseline(encryptionMode === 'plain'
      ? { token: 't', sessionId: 's1', encryptionMode } : queryParams)
    expect(result).toEqual({ complete: true, localIds: new Set(['native-user-0', 'native-user-1']) })
  })

  it.each(['legacy', 'dataKey'] as const)('preserves authenticated %s text and permission intent', async (encryptionVariant) => {
    const payload = { role: 'user', content: { type: 'text', text: 'authenticated request' }, meta: { permissionMode: 'yolo' } }
    vi.spyOn(axios, 'get').mockResolvedValue({
      status: 200,
      data: { messages: [{ createdAt: 123, content: { t: 'encrypted', c: encodeBase64(encrypt(queryParams.encryptionKey, encryptionVariant, payload)) } }] },
    } as AxiosResponse)
    await expect(fetchRecentTranscriptTextItemsForAcpImportFromServer({ ...queryParams, encryptionVariant })).resolves.toEqual([
      { role: 'user', text: 'authenticated request' },
    ])
    await expect(fetchLatestUserPermissionIntentFromEncryptedTranscript({ ...queryParams, encryptionVariant })).resolves.toEqual({ intent: 'yolo', updatedAt: 123 })
  })

  it.each([
    { encryptionMode: 'e2ee' as const, content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'do not disclose' }, meta: { permissionMode: 'yolo' } } } },
    { encryptionMode: 'plain' as const, content: { t: 'encrypted', c: 'unavailable' } },
    { encryptionMode: 'e2ee' as const, content: { t: 'encrypted', c: 'unavailable' } },
  ])('rejects unreadable $encryptionMode content instead of empty import or default permission intent', async ({ encryptionMode, content }) => {
    vi.spyOn(axios, 'get').mockResolvedValue({
      status: 200,
      data: { messages: [{ createdAt: 123, content }] },
    } as AxiosResponse)
    const params = encryptionMode === 'plain'
      ? { token: 't', sessionId: 's1', encryptionMode }
      : queryParams
    await expect(fetchRecentTranscriptTextItemsForAcpImportFromServer(params)).rejects.toMatchObject({
      code: 'session_transcript_stored_content_unavailable',
    })
    await expect(fetchLatestUserPermissionIntentFromEncryptedTranscript(params)).rejects.toMatchObject({
      code: 'session_transcript_stored_content_unavailable',
    })
  })

  it('resolves permission intent from plaintext transcript messages on a plaintext session', async () => {
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
      encryptionMode: 'plain',
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

    await expect(fetchLatestUserPermissionIntentFromEncryptedTranscript({ token: 't', sessionId: 's1', encryptionMode: 'plain' })).resolves.toBeNull()
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

    await expect(fetchRecentTranscriptTextItemsForAcpImportFromServer({ token: 't', sessionId: 's1', encryptionMode: 'plain' })).resolves.toEqual([
      { role: 'agent', text: 'codex reply' },
    ])
  })

  it('excludes Voice and malformed provenance from ACP import while preserving legacy and explicit Agent text', async () => {
    vi.spyOn(axios, 'get').mockResolvedValueOnce({
      data: {
        messages: [
          {
            createdAt: 400,
            content: {
              t: 'plain',
              v: {
                role: 'agent',
                content: { type: 'text', text: 'malformed provenance reply' },
                meta: {
                  happier: {
                    kind: 'conversation_turn.v1',
                    payload: { v: 1 },
                    conversationTurnOriginV1: {
                      v: 1,
                      channel: 'realtime_conversation',
                      modality: 'text',
                    },
                  },
                },
              },
            },
          },
          {
            createdAt: 300,
            content: {
              t: 'plain',
              v: {
                role: 'user',
                content: { type: 'text', text: 'spoken question' },
                meta: {
                  happier: {
                    kind: 'conversation_turn.v1',
                    payload: { v: 1 },
                    conversationTurnOriginV1: {
                      v: 1,
                      channel: 'realtime_conversation',
                      modality: 'voice',
                    },
                  },
                },
              },
            },
          },
          {
            createdAt: 200,
            content: {
              t: 'plain',
              v: {
                role: 'agent',
                content: { type: 'text', text: 'explicit Agent reply' },
                meta: {
                  happier: {
                    kind: 'conversation_turn.v1',
                    payload: { v: 1 },
                    conversationTurnOriginV1: {
                      v: 1,
                      channel: 'agent_thread',
                      modality: 'text',
                    },
                  },
                },
              },
            },
          },
          {
            createdAt: 100,
            content: {
              t: 'plain',
              v: {
                role: 'user',
                content: { type: 'text', text: 'legacy coding request' },
              },
            },
          },
        ],
      },
    } as AxiosResponse)

    await expect(fetchRecentTranscriptTextItemsForAcpImportFromServer({ token: 't', sessionId: 's1', encryptionMode: 'plain' })).resolves.toEqual([
      { role: 'user', text: 'legacy coding request' },
      { role: 'agent', text: 'explicit Agent reply' },
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
          { createdAt: 101, content: { t: 'encrypted', c: 'c101' } },
          { createdAt: 99, content: { t: 'encrypted', c: 'c99' } },
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
          { createdAt: 100, content: { t: 'encrypted', c: 'c100' } },
          { createdAt: 99, content: { t: 'encrypted', c: 'c99' } },
        ],
      },
    } as any)

    await expect(hasCommittedUserMessageAfterMs({
      token: 't',
      sessionId: 's1',
      failureAtMs: 100,
    })).resolves.toBe(false)
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
    })).rejects.toBe(error)

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

  it('does not convert malformed authoritative transcript content into empty semantic results', async () => {
    vi.spyOn(axios, 'get').mockResolvedValue({
      status: 200,
      data: {
        messages: [
          {
            createdAt: 100,
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'valid' } } },
          },
          { createdAt: 101, content: { t: 'future', value: 'unreadable' } },
        ],
      },
    } as any)

    await expect(fetchRecentTranscriptTextItemsForAcpImportFromServer(queryParams)).rejects.toMatchObject({
      code: 'session_transcript_stored_content_unavailable',
    })
    await expect(fetchLatestUserPermissionIntentFromEncryptedTranscript(queryParams)).rejects.toMatchObject({
      code: 'session_transcript_stored_content_unavailable',
    })
  })
})
