import { describe, expect, it, vi } from 'vitest';

import axios from 'axios';

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
});
