import { describe, expect, it, vi } from 'vitest';

import axios from 'axios';
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

  it('exposes paging metadata via fetchEncryptedTranscriptMessagesPage', async () => {
    vi.spyOn(axios, 'get').mockResolvedValueOnce({
      status: 200,
      data: { messages: [{ seq: 1 }], hasMore: true, nextBeforeSeq: 1, nextAfterSeq: null },
    } as any);

    const { fetchEncryptedTranscriptMessagesPage } = await import('./fetchEncryptedTranscriptMessages');

    const res = await fetchEncryptedTranscriptMessagesPage({
      token: 't',
      sessionId: 'sess_1',
      limit: 10,
      afterSeq: 5,
    });

    expect(res).toEqual({
      messages: [{ seq: 1 }],
      hasMore: true,
      nextBeforeSeq: 1,
      nextAfterSeq: null,
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
  });
});
