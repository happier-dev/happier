import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockGet = vi.fn();

vi.mock('axios', () => ({
  default: {
    get: (...args: any[]) => mockGet(...args),
  },
}));

vi.mock('@/configuration', () => ({
  configuration: {
    serverUrl: 'http://localhost:1234',
    apiServerUrl: 'http://localhost:1234',
    memoryMaxTranscriptWindowMessages: 250,
  },
}));

import { HttpStatusError } from '@/api/client/httpStatusError';
import { fetchEncryptedTranscriptPageAfterSeq, fetchEncryptedTranscriptPageLatest, fetchEncryptedTranscriptRange } from './fetchEncryptedTranscriptWindow';

describe('fetchEncryptedTranscriptWindow', () => {
  beforeEach(() => {
    mockGet.mockReset();
    vi.stubEnv('HAPPIER_LOCAL_SERVER_URL', 'http://localhost:1234');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
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

  it('applies sanitized caller timeouts to page fetches', async () => {
    mockGet.mockResolvedValue({
      status: 200,
      data: { messages: [] },
    });

    await fetchEncryptedTranscriptPageLatest({
      token: 't',
      sessionId: 'sess_1',
      limit: 2,
      timeoutMs: 250.9,
    });

    await fetchEncryptedTranscriptPageAfterSeq({
      token: 't',
      sessionId: 'sess_1',
      afterSeq: 4,
      limit: 3,
      timeoutMs: 0.5,
    });

    expect(mockGet.mock.calls[0]![1].timeout).toBe(250);
    expect(mockGet.mock.calls[1]![1].timeout).toBe(1);
  });

  it('uses the safe default timeout when caller timeout is absent or unsafe', async () => {
    mockGet.mockResolvedValue({
      status: 200,
      data: { messages: [] },
    });

    await fetchEncryptedTranscriptPageLatest({
      token: 't',
      sessionId: 'sess_1',
      limit: 2,
    });

    await fetchEncryptedTranscriptPageAfterSeq({
      token: 't',
      sessionId: 'sess_1',
      afterSeq: 4,
      limit: 3,
      timeoutMs: Number.POSITIVE_INFINITY,
    });

    expect(mockGet.mock.calls[0]![1].timeout).toBe(10_000);
    expect(mockGet.mock.calls[1]![1].timeout).toBe(10_000);
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

  it('rejects the complete window when a malformed row is followed by a valid row', async () => {
    mockGet.mockResolvedValue({
      status: 200,
      data: {
        messages: [
          { seq: 5, createdAt: 1, content: { t: 'encrypted', c: 'c5' } },
          { seq: 6, createdAt: 2, content: { t: 'future', value: 'unreadable' } },
          { seq: 7, createdAt: 3, content: { t: 'encrypted', c: 'c7' } },
        ],
      },
    });

    await expect(fetchEncryptedTranscriptRange({
      token: 't',
      sessionId: 'sess_1',
      seqFrom: 5,
      seqTo: 7,
    })).rejects.toMatchObject({
      name: 'HttpStatusError',
      code: 'session_transcript_stored_content_unavailable',
      response: { status: 503 },
    });
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

  it('throws a typed auth error when transcript fetch returns 401', async () => {
    mockGet.mockResolvedValue({
      status: 401,
      data: { error: 'Unauthorized' },
    });

    await expect(
      fetchEncryptedTranscriptPageAfterSeq({
        token: 't',
        sessionId: 'sess_1',
        afterSeq: 4,
        limit: 3,
      }),
    ).rejects.toBeInstanceOf(HttpStatusError);
  });
});
