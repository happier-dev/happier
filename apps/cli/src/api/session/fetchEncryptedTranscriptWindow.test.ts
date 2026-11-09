import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';

const mockGet = vi.fn();

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
    vi.spyOn(axios, 'get').mockImplementation(mockGet);
    vi.stubEnv('HAPPIER_LOCAL_SERVER_URL', 'http://localhost:1234');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('preserves sidechain selection and request-scoped authorization for page fetch', async () => {
    mockGet.mockResolvedValue({
      status: 200,
      data: { messages: [{ id: 'm5', seq: 5, createdAt: 1, content: { t: 'encrypted', c: 'c' } }], hasMore: false },
    });

    let authorizedPath: string | undefined;
    const rows = await fetchEncryptedTranscriptPageAfterSeq({
      token: 't',
      sessionId: 'sess_1',
      afterSeq: 4,
      limit: 3,
      sidechainId: 'thread_1',
      resolveAuthorizationHeaders: request => {
        authorizedPath = request.path;
        return { 'X-External-Action': 'scoped' };
      },
    });

    expect(rows).toHaveLength(1);
    expect(mockGet).toHaveBeenCalledTimes(1);
    const [url] = mockGet.mock.calls[0]!;
    const requestUrl = new URL(String(url));
    expect(`${requestUrl.origin}${requestUrl.pathname}`).toBe('http://127.0.0.1:1234/v1/sessions/sess_1/messages');
    expect(Object.fromEntries(requestUrl.searchParams)).toEqual({ scope: 'sidechain', afterSeq: '4', limit: '3', sidechainId: 'thread_1' });
    expect(authorizedPath).toBe(`${requestUrl.pathname}${requestUrl.search}`);
    expect(mockGet.mock.calls[0]![1].headers).toMatchObject({ 'X-External-Action': 'scoped' });
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
      data: { messages: [{ id: 'm9', seq: 9, createdAt: 2, content: { t: 'encrypted', c: 'c2' } }], hasMore: false },
    });

    const rows = await fetchEncryptedTranscriptPageLatest({
      token: 't',
      sessionId: 'sess_1',
      limit: 2,
    });

    expect(rows).toHaveLength(1);
    const [url] = mockGet.mock.calls.at(-1)!;
    expect(Object.fromEntries(new URL(String(url)).searchParams)).toEqual({ scope: 'main', limit: '2' });
  });

  it('applies sanitized caller timeouts to page fetches', async () => {
    vi.useFakeTimers();
    mockGet.mockResolvedValue({
      status: 200,
      data: { messages: [], hasMore: false },
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
      data: { messages: [], hasMore: false },
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
            id: 'm1',
            seq: 1,
            createdAt: 2,
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'hello' } } },
          },
        ],
        hasMore: false,
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
          { id: 'm5', seq: 5, createdAt: 1, content: { t: 'encrypted', c: 'c5' } },
          { id: 'm6', seq: 6, createdAt: 2, content: { t: 'future', value: 'unreadable' } },
          { id: 'm7', seq: 7, createdAt: 3, content: { t: 'encrypted', c: 'c7' } },
        ],
        hasMore: false,
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
      data: { messages: [{ id: 'm5', seq: 5, createdAt: 1, content: { t: 'encrypted', c: 'c' } }], hasMore: false },
    });

    const result = await fetchEncryptedTranscriptRange({
      token: 't',
      sessionId: 'sess_1',
      seqFrom: 5,
      seqTo: 7,
    });

    expect(result.ok).toBe(true);
    expect(mockGet).toHaveBeenCalledTimes(1);
    const [url] = mockGet.mock.calls[0]!;
    expect(Object.fromEntries(new URL(String(url)).searchParams)).toEqual({ scope: 'main', afterSeq: '4', limit: '3' });
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
