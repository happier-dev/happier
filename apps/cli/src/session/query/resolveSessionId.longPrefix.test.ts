import {
  createPlainSessionOwnerMetadataEnvelopeV1,
  SessionOwnerMetadataV1Schema,
} from '@happier-dev/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';

const { mockAxiosGet, mockAxiosPost } = vi.hoisted(() => ({
  mockAxiosGet: vi.fn(),
  mockAxiosPost: vi.fn(),
}));

vi.mock('axios', async () => {
  return {
    default: {
      get: mockAxiosGet,
      post: mockAxiosPost,
    },
  };
});

describe('resolveSessionIdOrPrefix', () => {
  beforeEach(() => {
    mockAxiosGet.mockReset();
    mockAxiosPost.mockReset();
    mockAxiosPost.mockResolvedValue({
      status: 404,
      data: {
        statusCode: 404,
        error: 'Not Found',
        message: 'Route POST:/v2/sessions/lookup-by-tags not found',
      },
      headers: {},
    });
  });

  it('returns a missing full session id before the outer tool budget expires', async () => {
    const { reloadConfiguration } = await import('@/configuration');
    const originalServerUrl = process.env.HAPPIER_SERVER_URL;
    const originalWebappUrl = process.env.HAPPIER_WEBAPP_URL;

    process.env.HAPPIER_SERVER_URL = 'http://example.test';
    process.env.HAPPIER_WEBAPP_URL = 'http://example.test';
    reloadConfiguration();

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
      expect(mockAxiosPost).toHaveBeenCalledOnce();
    } finally {
      if (budgetTimer) clearTimeout(budgetTimer);
      if (originalServerUrl === undefined) delete process.env.HAPPIER_SERVER_URL;
      else process.env.HAPPIER_SERVER_URL = originalServerUrl;
      if (originalWebappUrl === undefined) delete process.env.HAPPIER_WEBAPP_URL;
      else process.env.HAPPIER_WEBAPP_URL = originalWebappUrl;
      reloadConfiguration();
    }
  });

  it('reports a lookup timeout instead of not-found when a full-id fallback lookup cannot complete', async () => {
    vi.useFakeTimers();
    const { reloadConfiguration } = await import('@/configuration');
    const originalServerUrl = process.env.HAPPIER_SERVER_URL;
    const originalWebappUrl = process.env.HAPPIER_WEBAPP_URL;

    process.env.HAPPIER_SERVER_URL = 'http://example.test';
    process.env.HAPPIER_WEBAPP_URL = 'http://example.test';
    reloadConfiguration();

    mockAxiosGet.mockImplementation(async (urlRaw: string) => {
      const url = String(urlRaw);
      if (url.includes('/v2/sessions/c000000000000000000000000')) {
        return { status: 404, data: {}, headers: {} };
      }
      throw new Error(`unexpected url: ${url}`);
    });
    mockAxiosPost.mockImplementation(async (_url: string, _body: unknown, config?: { signal?: AbortSignal }) => {
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
      expect(mockAxiosGet).toHaveBeenCalledOnce();
      expect(mockAxiosPost).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
      if (originalServerUrl === undefined) delete process.env.HAPPIER_SERVER_URL;
      else process.env.HAPPIER_SERVER_URL = originalServerUrl;
      if (originalWebappUrl === undefined) delete process.env.HAPPIER_WEBAPP_URL;
      else process.env.HAPPIER_WEBAPP_URL = originalWebappUrl;
      reloadConfiguration();
    }
  });

  it('preserves indexed exact tag resolution when the tag is shaped like a full session id', async () => {
    const { reloadConfiguration } = await import('@/configuration');
    const originalServerUrl = process.env.HAPPIER_SERVER_URL;
    const originalWebappUrl = process.env.HAPPIER_WEBAPP_URL;
    const cuidShapedTag = 'c000000000000000000000000';
    const indexedSession = createSessionRecordFixture({ id: 'session-with-cuid-shaped-tag' });

    process.env.HAPPIER_SERVER_URL = 'http://example.test';
    process.env.HAPPIER_WEBAPP_URL = 'http://example.test';
    reloadConfiguration();

    mockAxiosGet.mockResolvedValue({ status: 404, data: {}, headers: {} });
    mockAxiosPost.mockResolvedValue({
      status: 200,
      data: { sessions: [indexedSession] },
      headers: {},
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

      expect(res).toMatchObject({ ok: true, sessionId: 'session-with-cuid-shaped-tag' });
      expect(mockAxiosGet).toHaveBeenCalledOnce();
      expect(mockAxiosPost).toHaveBeenCalledOnce();
    } finally {
      if (originalServerUrl === undefined) delete process.env.HAPPIER_SERVER_URL;
      else process.env.HAPPIER_SERVER_URL = originalServerUrl;
      if (originalWebappUrl === undefined) delete process.env.HAPPIER_WEBAPP_URL;
      else process.env.HAPPIER_WEBAPP_URL = originalWebappUrl;
      reloadConfiguration();
    }
  });

  it('prefers the indexed exact layout-v1 tag over an id prefix match', async () => {
    const { reloadConfiguration } = await import('@/configuration');
    const originalServerUrl = process.env.HAPPIER_SERVER_URL;
    const originalWebappUrl = process.env.HAPPIER_WEBAPP_URL;
    const secret = new Uint8Array(32).fill(1);
    const tag = 'layout-tag';
    const indexedSession = createSessionRecordFixture({
      id: 'session-indexed-layout-tag',
      encryptionMode: 'plain',
      metadataLayoutVersion: 1,
      metadata: JSON.stringify({ v: 1 }),
      ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1(
        SessionOwnerMetadataV1Schema.parse({
          v: 1,
          nativeSession: { tag },
        }),
      ),
    });

    process.env.HAPPIER_SERVER_URL = 'http://example.test';
    process.env.HAPPIER_WEBAPP_URL = 'http://example.test';
    reloadConfiguration();

    mockAxiosPost.mockResolvedValue({
      status: 200,
      data: { sessions: [indexedSession] },
      headers: {},
    });
    mockAxiosGet.mockResolvedValue({
      status: 200,
      data: {
        sessions: [
          createSessionRecordFixture({ id: 'layout-tag-prefix-session' }),
        ],
        nextCursor: null,
        hasNext: false,
      },
      headers: {},
    });

    try {
      const { resolveSessionIdOrPrefix } = await import('./resolveSessionId');
      const res = await resolveSessionIdOrPrefix({
        credentials: {
          token: 'token_test',
          encryption: { type: 'legacy', secret },
        },
        idOrPrefix: tag,
      });

      expect(res).toMatchObject({
        ok: true,
        sessionId: 'session-indexed-layout-tag',
      });
      expect(mockAxiosPost).toHaveBeenCalledWith(
        'http://example.test/v2/sessions/lookup-by-tags',
        { tags: [tag] },
        expect.any(Object),
      );
      expect(mockAxiosGet).not.toHaveBeenCalled();
    } finally {
      if (originalServerUrl === undefined) delete process.env.HAPPIER_SERVER_URL;
      else process.env.HAPPIER_SERVER_URL = originalServerUrl;
      if (originalWebappUrl === undefined) delete process.env.HAPPIER_WEBAPP_URL;
      else process.env.HAPPIER_WEBAPP_URL = originalWebappUrl;
      reloadConfiguration();
    }
  });

  it('uses the authenticated owner view for exact layout-v1 tags when the indexed route is unavailable', async () => {
    const { reloadConfiguration } = await import('@/configuration');
    const originalServerUrl = process.env.HAPPIER_SERVER_URL;
    const originalWebappUrl = process.env.HAPPIER_WEBAPP_URL;
    const secret = new Uint8Array(32).fill(1);
    const tag = 'legacy-layout-tag';
    const fallbackSession = createSessionRecordFixture({
      id: 'session-from-layout-v1-owner',
      encryptionMode: 'plain',
      metadataLayoutVersion: 1,
      metadata: JSON.stringify({ v: 1 }),
      ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1(
        SessionOwnerMetadataV1Schema.parse({
          v: 1,
          nativeSession: { tag },
        }),
      ),
    });

    process.env.HAPPIER_SERVER_URL = 'http://example.test';
    process.env.HAPPIER_WEBAPP_URL = 'http://example.test';
    reloadConfiguration();

    mockAxiosGet.mockImplementation(async (urlRaw: string) => {
      const url = String(urlRaw);
      if (url.includes(`/v2/sessions/${tag}`)) {
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
            sessions: [fallbackSession],
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
          encryption: { type: 'legacy', secret },
        },
        idOrPrefix: tag,
      });

      expect(res).toEqual({
        ok: true,
        sessionId: 'session-from-layout-v1-owner',
      });
      expect(mockAxiosPost).toHaveBeenCalledOnce();
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

      expect(res).toEqual({ ok: true, sessionId: 'sess_integration_run_start_123' });
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

      expect(res).toEqual({ ok: true, sessionId: 'sess_integration_archived_123' });
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

      expect(res).toEqual({ ok: true, sessionId: 'sess_dup_123' });
    } finally {
      if (originalServerUrl === undefined) delete process.env.HAPPIER_SERVER_URL;
      else process.env.HAPPIER_SERVER_URL = originalServerUrl;
      if (originalWebappUrl === undefined) delete process.env.HAPPIER_WEBAPP_URL;
      else process.env.HAPPIER_WEBAPP_URL = originalWebappUrl;
      reloadConfiguration();
    }
  });

  it('threads cancellation through indexed tag lookup and prefix paging', async () => {
    const { reloadConfiguration } = await import('@/configuration');
    const originalServerUrl = process.env.HAPPIER_SERVER_URL;
    const originalWebappUrl = process.env.HAPPIER_WEBAPP_URL;
    const cancellation = new AbortController();

    process.env.HAPPIER_SERVER_URL = 'http://example.test';
    process.env.HAPPIER_WEBAPP_URL = 'http://example.test';
    reloadConfiguration();

    mockAxiosGet
      .mockResolvedValueOnce({
        status: 200,
        data: {
          sessions: [createSessionRecordFixture({ id: 'cancelx-session' })],
          nextCursor: null,
          hasNext: false,
        },
        headers: {},
      })
      .mockResolvedValueOnce({
        status: 200,
        data: {
          sessions: [],
          nextCursor: null,
          hasNext: false,
        },
        headers: {},
      });

    try {
      const { resolveSessionIdOrPrefix } = await import('./resolveSessionId');
      const res = await resolveSessionIdOrPrefix({
        credentials: {
          token: 'token_test',
          encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
        },
        idOrPrefix: 'cancelx',
        signal: cancellation.signal,
      });

      expect(res).toEqual({ ok: true, sessionId: 'cancelx-session' });
      expect(mockAxiosPost).toHaveBeenCalledWith(
        'http://example.test/v2/sessions/lookup-by-tags',
        { tags: ['cancelx'] },
        expect.objectContaining({ signal: cancellation.signal }),
      );
      expect(mockAxiosGet).toHaveBeenCalledWith(
        'http://example.test/v2/sessions',
        expect.objectContaining({ signal: cancellation.signal }),
      );
      expect(mockAxiosGet).toHaveBeenCalledWith(
        'http://example.test/v2/sessions/archived',
        expect.objectContaining({ signal: cancellation.signal }),
      );
    } finally {
      if (originalServerUrl === undefined) delete process.env.HAPPIER_SERVER_URL;
      else process.env.HAPPIER_SERVER_URL = originalServerUrl;
      if (originalWebappUrl === undefined) delete process.env.HAPPIER_WEBAPP_URL;
      else process.env.HAPPIER_WEBAPP_URL = originalWebappUrl;
      reloadConfiguration();
    }
  });
});
