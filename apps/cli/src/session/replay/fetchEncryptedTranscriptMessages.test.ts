import { describe, expect, it, vi } from 'vitest';

import axios from 'axios';
import { EXTERNAL_SHAREABLE_TRANSCRIPT_MAX_SERIALIZED_BYTES_V1 } from '@happier-dev/protocol';
import { HttpStatusError } from '@/api/client/httpStatusError';

vi.mock('@/configuration', () => ({
  configuration: {
    apiServerUrl: 'http://example.invalid',
  },
}));

vi.mock('@/api/client/loopbackUrl', () => ({
  resolveLoopbackHttpUrl: (url: string) => url,
}));

describe('fetchEncryptedTranscriptMessages', () => {
  it('passes beforeSeq through to the server query params when provided', async () => {
    const getSpy = vi.spyOn(axios, 'get').mockResolvedValueOnce({
      status: 200,
      data: { messages: [] },
    } as any);

    const { fetchEncryptedTranscriptMessages } = await import('./fetchEncryptedTranscriptMessages');

    await fetchEncryptedTranscriptMessages({
      token: 't',
      sessionId: 'sess_1',
      limit: 10,
      beforeSeq: 123,
    });

    const call = (getSpy as any).mock.calls[0];
    expect(call?.[1]?.params).toEqual({ limit: 10, beforeSeq: 123 });
  });

  it('passes scope and role filters through to the server query params', async () => {
    const getSpy = vi.spyOn(axios, 'get').mockResolvedValueOnce({
      status: 200,
      data: { messages: [] },
    } as any);

    const { fetchEncryptedTranscriptMessagesPage } = await import('./fetchEncryptedTranscriptMessages');

    await fetchEncryptedTranscriptMessagesPage({
      token: 't',
      sessionId: 'sess_1',
      limit: 10,
      scope: 'sidechain',
      sidechainId: 'side-1',
      roles: ['user', 'agent'],
    });

    const call = (getSpy as any).mock.calls[0];
    expect(call?.[1]?.params).toEqual({
      limit: 10,
      scope: 'sidechain',
      sidechainId: 'side-1',
      roles: 'user,agent',
    });
  });

  it('exposes paging metadata via fetchEncryptedTranscriptMessagesPage', async () => {
    vi.spyOn(axios, 'get').mockResolvedValueOnce({
      status: 200,
      data: {
        messages: [{ seq: 1, content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'ok' } } } }],
        hasMore: true,
        nextBeforeSeq: 1,
        nextAfterSeq: null,
      },
    } as any);

    const { fetchEncryptedTranscriptMessagesPage } = await import('./fetchEncryptedTranscriptMessages');

    const res = await fetchEncryptedTranscriptMessagesPage({
      token: 't',
      sessionId: 'sess_1',
      limit: 10,
      afterSeq: 5,
    });

    expect(res).toEqual({
      messages: [{ seq: 1, content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'ok' } } } }],
      hasMore: true,
      nextBeforeSeq: 1,
      nextAfterSeq: null,
    });
  });

  it('requests and strictly parses external-shareable publication metadata', async () => {
    const getSpy = vi.spyOn(axios, 'get').mockResolvedValueOnce({
      status: 200,
      data: {
        messages: [{
          seq: 1,
          content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'ok' } } },
          externalShareableActor: 'machine',
        }],
        hasMore: true,
        nextBeforeSeq: null,
        nextAfterSeq: null,
        publicationBlocked: true,
      },
    } as any);

    const { fetchEncryptedTranscriptMessagesPage } = await import('./fetchEncryptedTranscriptMessages');
    const result = await fetchEncryptedTranscriptMessagesPage({
      token: 't', sessionId: 'sess_1', limit: 100, afterSeq: 0,
      projection: 'externalShareableV1',
    });

    expect((getSpy as any).mock.calls[0]?.[1]?.params).toMatchObject({
      projection: 'externalShareableV1',
    });
    expect(result).toMatchObject({
      publicationBlocked: true,
      messages: [{ externalShareableActor: 'machine' }],
    });
  });

  it('rejects an external-shareable response whose rows and witness exceed the one 2 MiB wire budget', async () => {
    vi.spyOn(axios, 'get').mockResolvedValueOnce({
      status: 200,
      data: {
        messages: [{
          seq: 1,
          content: {
            t: 'plain',
            v: {
              role: 'user',
              content: { type: 'text', text: 'x'.repeat(EXTERNAL_SHAREABLE_TRANSCRIPT_MAX_SERIALIZED_BYTES_V1) },
            },
          },
          externalShareableActor: 'machine',
        }],
        hasMore: false,
        nextBeforeSeq: null,
        nextAfterSeq: null,
        publicationBlocked: false,
        externalShareableSnapshot: { turns: [] },
      },
    } as any);

    const { fetchEncryptedTranscriptMessagesPage } = await import('./fetchEncryptedTranscriptMessages');

    await expect(fetchEncryptedTranscriptMessagesPage({
      token: 't',
      sessionId: 'sess_1',
      limit: 100,
      afterSeq: 0,
      projection: 'externalShareableV1',
    })).rejects.toMatchObject({
      name: 'HttpStatusError',
      code: 'session_transcript_stored_content_unavailable',
    });
  });

  it('passes an active cancellation signal to the axios transcript-read boundary', async () => {
    const cancellation = new AbortController();
    const getSpy = vi.spyOn(axios, 'get').mockResolvedValueOnce({
      status: 200,
      data: { messages: [], hasMore: false, nextBeforeSeq: null, nextAfterSeq: null },
    } as any);

    const { fetchEncryptedTranscriptMessagesPage } = await import('./fetchEncryptedTranscriptMessages');
    await fetchEncryptedTranscriptMessagesPage({
      token: 't',
      sessionId: 'sess_1',
      limit: 10,
      signal: cancellation.signal,
    });

    expect((getSpy as any).mock.calls[0]?.[1]?.signal).toBe(cancellation.signal);
  });

  it('rejects a whole authoritative page when one row has malformed stored content', async () => {
    vi.spyOn(axios, 'get').mockResolvedValueOnce({
      status: 200,
      data: {
        messages: [
          { seq: 11, content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'before' } } } },
          { seq: 12, content: { t: 'encrypted' } },
          { seq: 13, content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'after' } } } },
        ],
        hasMore: true,
        nextBeforeSeq: 11,
        nextAfterSeq: 13,
      },
    } as any);

    const { fetchEncryptedTranscriptMessagesPage } = await import('./fetchEncryptedTranscriptMessages');

    await expect(fetchEncryptedTranscriptMessagesPage({
      token: 't',
      sessionId: 'sess_1',
      limit: 10,
      afterSeq: 10,
    })).rejects.toMatchObject({
      name: 'HttpStatusError',
      code: 'session_transcript_stored_content_unavailable',
      response: { status: 503 },
    });
  });

  it('keeps an irreparable external row as an opaque cursor witness instead of failing the whole page', async () => {
    vi.spyOn(axios, 'get').mockResolvedValueOnce({
      status: 200,
      data: {
        messages: [
          { seq: 11, content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'before' } } } },
          {
            seq: 12,
            content: { t: 'encrypted' },
            inputAdmissionReceipt: { v: 1, issuer: 'authenticatedMachine' },
          },
          { seq: 13, content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'after' } } } },
        ],
        hasMore: false,
        nextBeforeSeq: null,
        nextAfterSeq: null,
        publicationBlocked: false,
        externalShareableSnapshot: { turns: [] },
      },
    } as any);

    const { fetchEncryptedTranscriptMessagesPage } = await import('./fetchEncryptedTranscriptMessages');
    const page = await fetchEncryptedTranscriptMessagesPage({
      token: 't',
      sessionId: 'sess_1',
      limit: 10,
      afterSeq: 10,
      projection: 'externalShareableV1',
    });

    expect(page.messages.map((row) => row.seq)).toEqual([11, 12, 13]);
    expect(JSON.stringify(page)).not.toContain('inputAdmissionReceipt');
  });

  it('throws a stable auth status error for terminal auth failures', async () => {
    vi.spyOn(axios, 'get').mockResolvedValueOnce({
      status: 401,
      data: {},
    } as any);

    const { fetchEncryptedTranscriptMessagesPage } = await import('./fetchEncryptedTranscriptMessages');

    await expect(
      fetchEncryptedTranscriptMessagesPage({
        token: 't',
        sessionId: 'sess_1',
        limit: 10,
      }),
    ).rejects.toMatchObject({
      name: 'HttpStatusError',
      response: { status: 401 },
    } satisfies Partial<HttpStatusError>);
  });
});
