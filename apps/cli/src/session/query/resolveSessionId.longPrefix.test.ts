import { describe, expect, it, vi } from 'vitest';

import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';

const { mockAxiosGet } = vi.hoisted(() => ({
  mockAxiosGet: vi.fn(),
}));

vi.mock('axios', async () => {
  return {
    default: {
      get: mockAxiosGet,
      post: vi.fn(),
    },
  };
});

describe('resolveSessionIdOrPrefix', () => {
  it('returns a missing full session id before the outer tool budget expires', async () => {
    const { reloadConfiguration } = await import('@/configuration');
    const originalServerUrl = process.env.HAPPIER_SERVER_URL;
    const originalWebappUrl = process.env.HAPPIER_WEBAPP_URL;

    process.env.HAPPIER_SERVER_URL = 'http://example.test';
    process.env.HAPPIER_WEBAPP_URL = 'http://example.test';
    reloadConfiguration();

    mockAxiosGet.mockClear();
    mockAxiosGet.mockImplementation(async (urlRaw: string) => {
      const url = String(urlRaw);
      if (url.includes('/v2/sessions/c000000000000000000000000')) {
        return { status: 404, data: {}, headers: {} };
      }
      return {
        status: 200,
        data: { sessions: [], nextCursor: null, hasNext: false },
        headers: {},
      };
    });

    let budgetTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const { resolveSessionIdOrPrefix } = await import('./resolveSessionId');
      const res = await Promise.race([
        resolveSessionIdOrPrefix({
          credentials: {
            token: 'token_test',
            encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
          },
          idOrPrefix: 'c000000000000000000000000',
        }),
        new Promise<'outer_budget_exceeded'>((resolve) => {
          budgetTimer = setTimeout(() => resolve('outer_budget_exceeded'), 250);
        }),
      ]);

      expect(res).toEqual({ ok: false, code: 'session_not_found' });
      expect(mockAxiosGet).toHaveBeenCalledTimes(3);
    } finally {
      if (budgetTimer) clearTimeout(budgetTimer);
      if (originalServerUrl === undefined) delete process.env.HAPPIER_SERVER_URL;
      else process.env.HAPPIER_SERVER_URL = originalServerUrl;
      if (originalWebappUrl === undefined) delete process.env.HAPPIER_WEBAPP_URL;
      else process.env.HAPPIER_WEBAPP_URL = originalWebappUrl;
      reloadConfiguration();
    }
  });

  it('reports a lookup timeout instead of not-found when a full-id fallback scan cannot complete', async () => {
    vi.useFakeTimers();
    const { reloadConfiguration } = await import('@/configuration');
    const originalServerUrl = process.env.HAPPIER_SERVER_URL;
    const originalWebappUrl = process.env.HAPPIER_WEBAPP_URL;

    process.env.HAPPIER_SERVER_URL = 'http://example.test';
    process.env.HAPPIER_WEBAPP_URL = 'http://example.test';
    reloadConfiguration();

    mockAxiosGet.mockClear();
    mockAxiosGet.mockImplementation(async (urlRaw: string, config?: { signal?: AbortSignal }) => {
      const url = String(urlRaw);
      if (url.includes('/v2/sessions/c000000000000000000000000')) {
        return { status: 404, data: {}, headers: {} };
      }
      return await new Promise((_resolve, reject) => {
        config?.signal?.addEventListener('abort', () => reject(new Error('request aborted')), { once: true });
      });
    });

    try {
      const { resolveSessionIdOrPrefix } = await import('./resolveSessionId');
      const resultPromise = resolveSessionIdOrPrefix({
        credentials: {
          token: 'token_test',
          encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
        },
        idOrPrefix: 'c000000000000000000000000',
      });

      await vi.advanceTimersByTimeAsync(25_000);

      await expect(resultPromise).resolves.toEqual({ ok: false, code: 'session_lookup_timeout' });
      expect(mockAxiosGet).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
      if (originalServerUrl === undefined) delete process.env.HAPPIER_SERVER_URL;
      else process.env.HAPPIER_SERVER_URL = originalServerUrl;
      if (originalWebappUrl === undefined) delete process.env.HAPPIER_WEBAPP_URL;
      else process.env.HAPPIER_WEBAPP_URL = originalWebappUrl;
      reloadConfiguration();
    }
  });

  it('preserves exact tag resolution when the tag is shaped like a full session id', async () => {
    const { reloadConfiguration } = await import('@/configuration');
    const originalServerUrl = process.env.HAPPIER_SERVER_URL;
    const originalWebappUrl = process.env.HAPPIER_WEBAPP_URL;
    const cuidShapedTag = 'c000000000000000000000000';

    process.env.HAPPIER_SERVER_URL = 'http://example.test';
    process.env.HAPPIER_WEBAPP_URL = 'http://example.test';
    reloadConfiguration();

    mockAxiosGet.mockImplementation(async (urlRaw: string) => {
      const url = String(urlRaw);
      if (url.includes(`/v2/sessions/${cuidShapedTag}`)) {
        return { status: 404, data: {}, headers: {} };
      }
      if (url.includes('/v2/sessions/archived')) {
        return {
          status: 200,
          data: { sessions: [], nextCursor: null, hasNext: false },
          headers: {},
        };
      }
      if (url.includes('/v2/sessions')) {
        return {
          status: 200,
          data: {
            sessions: [createSessionRecordFixture({
              id: 'session-with-cuid-shaped-tag',
              encryptionMode: 'plain',
              metadata: JSON.stringify({ tag: cuidShapedTag }),
            })],
            nextCursor: null,
            hasNext: false,
          },
          headers: {},
        };
      }
      throw new Error(`unexpected url: ${url}`);
    });

    try {
      const { resolveSessionIdOrPrefix } = await import('./resolveSessionId');
      const res = await resolveSessionIdOrPrefix({
        credentials: {
          token: 'token_test',
          encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
        },
        idOrPrefix: cuidShapedTag,
      });

      expect(res).toMatchObject({
        ok: true,
        sessionId: 'session-with-cuid-shaped-tag',
        rawSession: { id: 'session-with-cuid-shaped-tag' },
      });
    } finally {
      if (originalServerUrl === undefined) delete process.env.HAPPIER_SERVER_URL;
      else process.env.HAPPIER_SERVER_URL = originalServerUrl;
      if (originalWebappUrl === undefined) delete process.env.HAPPIER_WEBAPP_URL;
      else process.env.HAPPIER_WEBAPP_URL = originalWebappUrl;
      reloadConfiguration();
    }
  });

  it('falls back to prefix paging when a long id-or-prefix is not an exact session id', async () => {
    const { reloadConfiguration } = await import('@/configuration');
    const originalServerUrl = process.env.HAPPIER_SERVER_URL;
    const originalWebappUrl = process.env.HAPPIER_WEBAPP_URL;

    process.env.HAPPIER_SERVER_URL = 'http://example.test';
    process.env.HAPPIER_WEBAPP_URL = 'http://example.test';
    reloadConfiguration();

    mockAxiosGet.mockImplementation(async (urlRaw: string) => {
      const url = String(urlRaw);
      if (url.includes('/v2/sessions/sess_integration')) {
        return { status: 404, data: {}, headers: {} };
      }
      if (url.includes('/v2/sessions/archived')) {
        return {
          status: 200,
          data: {
            sessions: [],
            nextCursor: null,
            hasNext: false,
          },
          headers: {},
        };
      }
      if (url.includes('/v2/sessions')) {
        return {
          status: 200,
          data: {
            sessions: [createSessionRecordFixture({ id: 'sess_integration_run_start_123' })],
            nextCursor: null,
            hasNext: false,
          },
          headers: {},
        };
      }
      throw new Error(`unexpected url: ${url}`);
    });

    try {
      const { resolveSessionIdOrPrefix } = await import('./resolveSessionId');
      const res = await resolveSessionIdOrPrefix({
        credentials: {
          token: 'token_test',
          encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
        },
        idOrPrefix: 'sess_integration',
      });

      expect(res).toMatchObject({
        ok: true,
        sessionId: 'sess_integration_run_start_123',
        rawSession: { id: 'sess_integration_run_start_123' },
      });
    } finally {
      if (originalServerUrl === undefined) delete process.env.HAPPIER_SERVER_URL;
      else process.env.HAPPIER_SERVER_URL = originalServerUrl;
      if (originalWebappUrl === undefined) delete process.env.HAPPIER_WEBAPP_URL;
      else process.env.HAPPIER_WEBAPP_URL = originalWebappUrl;
      reloadConfiguration();
    }
  });

  it('includes archived sessions when resolving by prefix', async () => {
    const { reloadConfiguration } = await import('@/configuration');
    const originalServerUrl = process.env.HAPPIER_SERVER_URL;
    const originalWebappUrl = process.env.HAPPIER_WEBAPP_URL;

    process.env.HAPPIER_SERVER_URL = 'http://example.test';
    process.env.HAPPIER_WEBAPP_URL = 'http://example.test';
    reloadConfiguration();

    mockAxiosGet.mockImplementation(async (urlRaw: string) => {
      const url = String(urlRaw);
      if (url.includes('/v2/sessions/sess_integration')) {
        return { status: 404, data: {}, headers: {} };
      }
      if (url.includes('/v2/sessions/archived')) {
        return {
          status: 200,
          data: {
            sessions: [createSessionRecordFixture({ id: 'sess_integration_archived_123' })],
            nextCursor: null,
            hasNext: false,
          },
          headers: {},
        };
      }
      if (url.includes('/v2/sessions')) {
        return {
          status: 200,
          data: {
            sessions: [],
            nextCursor: null,
            hasNext: false,
          },
          headers: {},
        };
      }
      throw new Error(`unexpected url: ${url}`);
    });

    try {
      const { resolveSessionIdOrPrefix } = await import('./resolveSessionId');
      const res = await resolveSessionIdOrPrefix({
        credentials: {
          token: 'token_test',
          encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
        },
        idOrPrefix: 'sess_integration',
      });

      expect(res).toMatchObject({
        ok: true,
        sessionId: 'sess_integration_archived_123',
        rawSession: { id: 'sess_integration_archived_123' },
      });
    } finally {
      if (originalServerUrl === undefined) delete process.env.HAPPIER_SERVER_URL;
      else process.env.HAPPIER_SERVER_URL = originalServerUrl;
      if (originalWebappUrl === undefined) delete process.env.HAPPIER_WEBAPP_URL;
      else process.env.HAPPIER_WEBAPP_URL = originalWebappUrl;
      reloadConfiguration();
    }
  });

  it('does not treat duplicate matches across active + archived scans as ambiguous', async () => {
    const { reloadConfiguration } = await import('@/configuration');
    const originalServerUrl = process.env.HAPPIER_SERVER_URL;
    const originalWebappUrl = process.env.HAPPIER_WEBAPP_URL;

    process.env.HAPPIER_SERVER_URL = 'http://example.test';
    process.env.HAPPIER_WEBAPP_URL = 'http://example.test';
    reloadConfiguration();

    mockAxiosGet.mockImplementation(async (urlRaw: string) => {
      const url = String(urlRaw);
      if (url.includes('/v2/sessions/sess_dup')) {
        return { status: 404, data: {}, headers: {} };
      }
      if (url.includes('/v2/sessions/archived')) {
        return {
          status: 200,
          data: {
            sessions: [createSessionRecordFixture({ id: 'sess_dup_123' })],
            nextCursor: null,
            hasNext: false,
          },
          headers: {},
        };
      }
      if (url.includes('/v2/sessions')) {
        return {
          status: 200,
          data: {
            sessions: [createSessionRecordFixture({ id: 'sess_dup_123' })],
            nextCursor: null,
            hasNext: false,
          },
          headers: {},
        };
      }
      throw new Error(`unexpected url: ${url}`);
    });

    try {
      const { resolveSessionIdOrPrefix } = await import('./resolveSessionId');
      const res = await resolveSessionIdOrPrefix({
        credentials: {
          token: 'token_test',
          encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
        },
        idOrPrefix: 'sess_dup',
      });

      expect(res).toMatchObject({
        ok: true,
        sessionId: 'sess_dup_123',
        rawSession: { id: 'sess_dup_123' },
      });
    } finally {
      if (originalServerUrl === undefined) delete process.env.HAPPIER_SERVER_URL;
      else process.env.HAPPIER_SERVER_URL = originalServerUrl;
      if (originalWebappUrl === undefined) delete process.env.HAPPIER_WEBAPP_URL;
      else process.env.HAPPIER_WEBAPP_URL = originalWebappUrl;
      reloadConfiguration();
    }
  });
});
