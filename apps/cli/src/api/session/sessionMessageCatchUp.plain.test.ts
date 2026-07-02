import { describe, expect, it, vi } from 'vitest';

vi.mock('@/configuration', () => ({
  configuration: { serverUrl: 'http://example.test', apiServerUrl: 'http://example.test' },
}));

vi.mock('../client/loopbackUrl', () => ({
  resolveLoopbackHttpUrl: (url: string) => url,
}));

import axios, { AxiosHeaders, type AxiosResponse } from 'axios';

import { HttpStatusError } from '@/api/client/httpStatusError';

import { catchUpSessionMessagesAfterSeq } from './sessionMessageCatchUp';

describe('sessionMessageCatchUp (plaintext envelopes)', () => {
  it('emits new-message updates for plaintext transcript messages', async () => {
    const getSpy = vi.spyOn(axios, 'get').mockResolvedValueOnce({
      data: {
        messages: [
          {
            id: 'm1',
            seq: 12,
            localId: 'l1',
            createdAt: 123,
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'hello' } } },
          },
        ],
      },
    } as any);

    const updates: any[] = [];
    await catchUpSessionMessagesAfterSeq({
      token: 't',
      sessionId: 's1',
      afterSeq: 10,
      onUpdate: (u) => updates.push(u),
    });

    expect(getSpy).toHaveBeenCalledTimes(1);
    expect(updates).toHaveLength(1);
    expect(updates[0]?.body?.t).toBe('new-message');
    expect(updates[0]?.body?.message?.content?.t).toBe('plain');
    expect(updates[0]?.body?.message?.localId).toBe('l1');
    expect(updates[0]?.body?.message?.sidechainId).toBeNull();
    expect(updates[0]?.body?.message?.createdAt).toBe(123);
    expect(updates[0]?.body?.message?.updatedAt).toBe(123);
  });

  it('preserves missing transcript timestamps as unavailable in catch-up updates', async () => {
    vi.spyOn(axios, 'get').mockResolvedValueOnce({
      data: {
        messages: [
          {
            id: 'm1',
            seq: 12,
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'hello' } } },
          },
        ],
      },
    } as any);

    const updates: any[] = [];
    await catchUpSessionMessagesAfterSeq({
      token: 't',
      sessionId: 's1',
      afterSeq: 10,
      onUpdate: (u) => updates.push(u),
    });

    expect(updates).toHaveLength(1);
    expect(updates[0]?.createdAt).toBeNull();
    expect(updates[0]?.body?.message?.createdAt).toBeNull();
    expect(updates[0]?.body?.message?.updatedAt).toBeNull();
  });

  it('ignores transcript messages with malformed seq values', async () => {
    vi.spyOn(axios, 'get').mockResolvedValueOnce({
      data: {
        messages: [
          {
            id: 'm1',
            seq: '12',
            createdAt: 123,
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'hello' } } },
          },
        ],
      },
    } as any);

    const updates: any[] = [];
    await catchUpSessionMessagesAfterSeq({
      token: 't',
      sessionId: 's1',
      afterSeq: 10,
      onUpdate: (u) => updates.push(u),
    });

    expect(updates).toHaveLength(0);
  });

  it('throws terminal auth responses instead of treating them as empty catch-up', async () => {
    const authResponse: AxiosResponse = {
      status: 401,
      statusText: 'Unauthorized',
      headers: {},
      config: { headers: new AxiosHeaders() },
      data: { messages: [] },
    };
    vi.spyOn(axios, 'get').mockResolvedValueOnce(authResponse);

    await expect(
      catchUpSessionMessagesAfterSeq({
        token: 'expired',
        sessionId: 's1',
        afterSeq: 10,
        onUpdate: vi.fn(),
      }),
    ).rejects.toMatchObject({
      name: 'HttpStatusError',
      code: 'not_authenticated',
      response: { status: 401 },
    } satisfies Partial<HttpStatusError & { code: string }>);
  });
});
