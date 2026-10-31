import { afterEach, describe, expect, it, vi } from 'vitest';

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
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('uses the canonical endpoint selected by loaded configuration', async () => {
    const getSpy = vi.spyOn(axios, 'get').mockResolvedValueOnce({
      status: 200,
      data: { messages: [], hasMore: false },
    } as any);

    const { fetchEncryptedTranscriptMessages } = await import('./fetchEncryptedTranscriptMessages');

    await fetchEncryptedTranscriptMessages({
      token: 't',
      sessionId: 'sess_1',
      limit: 10,
    });

    expect(getSpy.mock.calls[0]?.[0]).toBe('http://example.invalid/v1/sessions/sess_1/messages');
  });

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
    expect(call?.[1]?.params).toEqual({ limit: 10, beforeSeq: 123 });
  });

  it('exposes paging metadata via fetchEncryptedTranscriptMessagesPage', async () => {
    vi.spyOn(axios, 'get').mockResolvedValueOnce({
      status: 200,
      data: {
        messages: [{ seq: 6, localId: 'claude-jsonl:main:assistant:a1' }],
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
      messages: [{ seq: 6, localId: 'claude-jsonl:main:assistant:a1' }],
      hasMore: true,
      nextBeforeSeq: null,
      nextAfterSeq: 6,
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

  it.each([
    {},
    { messages: 'not-a-page', hasMore: false },
    { messages: [null], hasMore: false },
    { messages: [] },
    { messages: [], hasMore: true, nextBeforeSeq: 1 },
    { messages: [{ seq: 1 }], hasMore: true, nextBeforeSeq: null },
  ])('rejects malformed successful responses rather than claiming complete history: %j', async (data) => {
    vi.spyOn(axios, 'get').mockResolvedValueOnce({ status: 200, data });
    const { fetchEncryptedTranscriptMessagesPage } = await import('./fetchEncryptedTranscriptMessages');
    await expect(fetchEncryptedTranscriptMessagesPage({ token: 't', sessionId: 'sess_1', limit: 10 })).rejects.toThrow();
  });

  it('rejects a continuation that cannot advance the requested cursor', async () => {
    vi.spyOn(axios, 'get').mockResolvedValueOnce({
      status: 200,
      data: { messages: [{ seq: 3 }], hasMore: true, nextAfterSeq: 3, nextBeforeSeq: null },
    });
    const { fetchEncryptedTranscriptMessagesPage } = await import('./fetchEncryptedTranscriptMessages');
    await expect(fetchEncryptedTranscriptMessagesPage({ token: 't', sessionId: 'sess_1', limit: 10, afterSeq: 3 })).rejects.toThrow();
  });
  it.each(['before', 'after'] as const)('rejects a %s continuation that skips past the returned boundary', async (direction) => {
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
