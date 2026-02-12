import { afterEach, describe, expect, it, vi } from 'vitest';

import { searchBugReportSimilarIssues } from './bugReports.js';

type MockResponseInput = {
  ok: boolean;
  status: number;
  json?: unknown;
  text?: string;
};

function mockResponse(input: MockResponseInput): Response {
  return {
    ok: input.ok,
    status: input.status,
    json: async () => input.json,
    text: async () => input.text ?? '',
  } as unknown as Response;
}

describe('searchBugReportSimilarIssues', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fails fast when provider URL is invalid', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(searchBugReportSimilarIssues({
      providerUrl: 'not-a-valid-url',
      owner: 'happier-dev',
      repo: 'happier',
      query: 'daemon hang',
    })).rejects.toThrow(/invalid bug report provider url/i);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('calls /v1/issues/similar and returns parsed issues', async () => {
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (!url.includes('/v1/issues/similar')) {
        return mockResponse({ ok: false, status: 404, text: 'not-found' });
      }
      return mockResponse({
        ok: true,
        status: 200,
        json: {
          issues: [
            {
              owner: 'happier-dev',
              repo: 'happier',
              number: 42,
              url: 'https://github.com/happier-dev/happier/issues/42',
              title: 'Daemon hangs after resume',
              state: 'open',
              updatedAt: '2026-02-12T00:00:00.000Z',
            },
          ],
        },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await searchBugReportSimilarIssues({
      providerUrl: 'https://reports.happier.dev',
      owner: 'happier-dev',
      repo: 'happier',
      query: 'daemon hang',
      limit: 10,
      state: 'all',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const calledUrl = String(fetchMock.mock.calls[0]?.[0] ?? '');
    expect(calledUrl).toContain('https://reports.happier.dev/v1/issues/similar?');
    expect(calledUrl).not.toContain('owner=');
    expect(calledUrl).not.toContain('repo=');
    expect(calledUrl).toContain('q=');
    expect(result.issues[0].number).toBe(42);
  });
});
