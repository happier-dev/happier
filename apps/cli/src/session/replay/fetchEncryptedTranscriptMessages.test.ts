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
      data: { messages: [], hasMore: false },
    } as any);

    const { fetchEncryptedTranscriptMessages } = await import('./fetchEncryptedTranscriptMessages');

    await fetchEncryptedTranscriptMessages({
      token: 't',
      sessionId: 'sess_1',
      limit: 10,
      beforeSeq: 123,
    });

    const call = (getSpy as any).mock.calls[0];
    expect(Object.fromEntries(new URL(String(call?.[0])).searchParams)).toMatchObject({ limit: '10', beforeSeq: '123' });
  });

  it('passes scope and role filters through to the server query params', async () => {
    const getSpy = vi.spyOn(axios, 'get').mockResolvedValueOnce({
      status: 200,
      data: { messages: [], hasMore: false },
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
    expect(Object.fromEntries(new URL(String(call?.[0])).searchParams)).toMatchObject({
      limit: '10',
      scope: 'sidechain',
      sidechainId: 'side-1',
      roles: 'user,agent',
    });
  });

  it('exposes paging metadata via fetchEncryptedTranscriptMessagesPage', async () => {
    vi.spyOn(axios, 'get').mockResolvedValueOnce({
      status: 200,
      data: {
        messages: [{ id: 'm1', seq: 6, createdAt: 1, content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'ok' } } } }],
        hasMore: true,
        nextBeforeSeq: null,
        nextAfterSeq: 6,
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
      messages: [{ id: 'm1', seq: 6, createdAt: 1, content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'ok' } } } }],
      hasMore: true,
      nextBeforeSeq: null,
      nextAfterSeq: 6,
    });
  });

  it('requests and strictly parses external-shareable publication metadata', async () => {
    const getSpy = vi.spyOn(axios, 'get').mockResolvedValueOnce({
      status: 200,
      data: {
        messages: [{
          seq: 1,
          id: 'm1', createdAt: 1,
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

    expect(Object.fromEntries(new URL(String(getSpy.mock.calls[0]?.[0])).searchParams)).toMatchObject({
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
          id: 'm1', createdAt: 1,
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

  it('preserves cancellation through completion of the transcript response', async () => {
    const cancellation = new AbortController();
    const reason = new Error('read superseded');
    vi.spyOn(axios, 'get').mockImplementationOnce(async (_url, config) => {
      expect(config?.signal?.aborted).toBe(false);
      cancellation.abort(reason);
      expect(config?.signal?.aborted).toBe(true);
      return {
        status: 200,
        data: { messages: [], hasMore: false, nextBeforeSeq: null, nextAfterSeq: null },
      };
    });

    const { fetchEncryptedTranscriptMessagesPage } = await import('./fetchEncryptedTranscriptMessages');
    await expect(fetchEncryptedTranscriptMessagesPage({
      token: 't',
      sessionId: 'sess_1',
      limit: 10,
      signal: cancellation.signal,
    })).rejects.toBe(reason);
  });

  it('uses the caller absolute deadline beyond the standalone request default', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(0);
    const get = vi.spyOn(axios, 'get').mockResolvedValueOnce({
      status: 200,
      data: { messages: [], hasMore: false, nextBeforeSeq: null, nextAfterSeq: null },
    });
    const { fetchEncryptedTranscriptMessagesPage } = await import('./fetchEncryptedTranscriptMessages');
    await fetchEncryptedTranscriptMessagesPage({ token: 't', sessionId: 'sess_1', limit: 10, deadlineAtMs: 30_000 });
    expect(get.mock.calls[0]?.[1]?.timeout).toBe(30_000);
  });

  it('rejects a whole authoritative page when one row has malformed stored content', async () => {
    vi.spyOn(axios, 'get').mockResolvedValueOnce({
      status: 200,
      data: {
        messages: [
          { id: 'm11', seq: 11, createdAt: 1, content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'before' } } } },
          { id: 'm12', seq: 12, createdAt: 1, content: { t: 'encrypted' } },
          { id: 'm13', seq: 13, createdAt: 1, content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'after' } } } },
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
          { id: 'm11', seq: 11, createdAt: 1, content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'before' } } } },
          {
            seq: 12,
            id: 'm12', createdAt: 1,
            content: { t: 'encrypted' },
            inputAdmissionReceipt: { v: 1, issuer: 'authenticatedMachine' },
          },
          { id: 'm13', seq: 13, createdAt: 1, content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'after' } } } },
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

  it.each([
    { messages: [] },
    { messages: [], hasMore: true, nextBeforeSeq: 1 },
  ])('rejects unproven ordinary page completeness: %j', async (data) => {
    vi.spyOn(axios, 'get').mockResolvedValueOnce({ status: 200, data });
    const { fetchEncryptedTranscriptMessagesPage } = await import('./fetchEncryptedTranscriptMessages');
    await expect(fetchEncryptedTranscriptMessagesPage({ token: 't', sessionId: 'sess_1', limit: 10 })).rejects.toMatchObject({
      code: 'session_transcript_stored_content_unavailable',
    });
  });

  it('rejects an ordinary continuation that cannot advance the requested cursor', async () => {
    vi.spyOn(axios, 'get').mockResolvedValueOnce({ status: 200, data: {
      messages: [{ id: 'm3', seq: 3, createdAt: 1, content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'ok' } } } }],
      hasMore: true, nextAfterSeq: 3, nextBeforeSeq: null,
    } });
    const { fetchEncryptedTranscriptMessagesPage } = await import('./fetchEncryptedTranscriptMessages');
    await expect(fetchEncryptedTranscriptMessagesPage({ token: 't', sessionId: 'sess_1', limit: 10, afterSeq: 3 })).rejects.toMatchObject({
      code: 'session_transcript_stored_content_unavailable',
    });
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
  });  it.each(['before', 'after'] as const)('rejects a %s continuation that skips past the returned boundary', async (direction) => {
    const messages = (direction === 'before' ? [8, 3] : [3, 8]).map(seq => ({ id: `m-${seq}`, seq, localId: null, createdAt: seq, updatedAt: seq, content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'prompt' } } } }));
    vi.spyOn(axios, 'get').mockResolvedValueOnce({ status: 200, data: { messages, hasMore: true, nextBeforeSeq: direction === 'before' ? 1 : null, nextAfterSeq: direction === 'after' ? 10 : null } });
    const { fetchEncryptedTranscriptMessagesPage } = await import('./fetchEncryptedTranscriptMessages');
    await expect(fetchEncryptedTranscriptMessagesPage({ token: 't', sessionId: 'sess_1', limit: 2, ...(direction === 'before' ? { beforeSeq: 10 } : { afterSeq: 0 }) })).rejects.toThrow();
  });
  it.each(['before', 'after'] as const)('preserves valid sequence gaps in a %s page', async (direction) => {
    const messages = (direction === 'before' ? [8, 3] : [3, 8]).map(seq => ({ id: `m-${seq}`, seq, localId: null, createdAt: seq, updatedAt: seq, content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'prompt' } } } }));
    vi.spyOn(axios, 'get').mockResolvedValueOnce({ status: 200, data: { messages, hasMore: true, nextBeforeSeq: direction === 'before' ? 3 : null, nextAfterSeq: direction === 'after' ? 8 : null } });
    const { fetchEncryptedTranscriptMessagesPage } = await import('./fetchEncryptedTranscriptMessages');
    await expect(fetchEncryptedTranscriptMessagesPage({ token: 't', sessionId: 'sess_1', limit: 2, ...(direction === 'before' ? { beforeSeq: 10 } : { afterSeq: 0 }) })).resolves.toMatchObject({ messages, hasMore: true });
  });

});
