import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGet = vi.fn();

vi.mock('axios', () => ({
  default: {
    get: (...args: any[]) => mockGet(...args),
  },
}));

vi.mock('@/configuration', () => ({
  configuration: {
    serverUrl: 'http://localhost:1234',
    memoryMaxTranscriptWindowMessages: 250,
  },
}));

import { fetchEncryptedTranscriptPageAfterSeq, fetchEncryptedTranscriptPageLatest, fetchEncryptedTranscriptRange } from './fetchEncryptedTranscriptWindow';

describe('fetchEncryptedTranscriptWindow', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  it('builds afterSeq/limit params for page fetch', async () => {
    mockGet.mockResolvedValue({
      status: 200,
      data: { messages: [{ seq: 5, createdAt: 1, content: { t: 'encrypted', c: 'c' } }] },
    });

    const rows = await fetchEncryptedTranscriptPageAfterSeq({
      token: 't',
      sessionId: 'sess_1',
      afterSeq: 4,
      limit: 3,
    });

    expect(rows).toHaveLength(1);
    expect(mockGet).toHaveBeenCalledTimes(1);
    const [url, opts] = mockGet.mock.calls[0]!;
    expect(url).toBe('http://127.0.0.1:1234/v1/sessions/sess_1/messages');
    expect(opts.params).toEqual({ afterSeq: 4, limit: 3 });
  });

  it('rejects oversized windows with window_too_large', async () => {
    const result = await fetchEncryptedTranscriptRange({
      token: 't',
      sessionId: 'sess_1',
      seqFrom: 1,
      seqTo: 999,
    });
    expect(result.ok).toBe(false);
    expect((result as any).errorCode).toBe('window_too_large');
  });

  it('fetches latest messages with limit only (descending as returned by API)', async () => {
    mockGet.mockResolvedValue({
      status: 200,
      data: { messages: [{ seq: 9, createdAt: 2, content: { t: 'encrypted', c: 'c2' } }] },
    });

    const rows = await fetchEncryptedTranscriptPageLatest({
      token: 't',
      sessionId: 'sess_1',
      limit: 2,
    });

    expect(rows).toHaveLength(1);
    const [_url, opts] = mockGet.mock.calls.at(-1)!;
    expect(opts.params).toEqual({ limit: 2 });
  });

  it('parses plaintext transcript rows (no filtering)', async () => {
    mockGet.mockResolvedValue({
      status: 200,
      data: {
        messages: [
          {
            seq: 1,
            createdAt: 2,
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'hello' } } },
          },
        ],
      },
    });

    const rows = await fetchEncryptedTranscriptPageLatest({
      token: 't',
      sessionId: 'sess_plain',
      limit: 10,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]!.content.t).toBe('plain');
  });

  it('computes afterSeq and limit for a bounded range fetch', async () => {
    mockGet.mockResolvedValue({
      status: 200,
      data: { messages: [{ seq: 5, createdAt: 1, content: { t: 'encrypted', c: 'c' } }] },
    });

    const result = await fetchEncryptedTranscriptRange({
      token: 't',
      sessionId: 'sess_1',
      seqFrom: 5,
      seqTo: 7,
    });

    expect(result.ok).toBe(true);
    expect(mockGet).toHaveBeenCalledTimes(1);
    const [_url, opts] = mockGet.mock.calls[0]!;
    expect(opts.params).toEqual({ afterSeq: 4, limit: 3 });
  });
});
