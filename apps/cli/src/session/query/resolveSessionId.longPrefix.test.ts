import {
  SessionOwnerMetadataV1Schema,
  sealSessionOwnerMetadataV1,
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
      ownerMetadata: sealSessionOwnerMetadataV1({
        material: { type: 'legacy', secret },
        ownerMetadata: SessionOwnerMetadataV1Schema.parse({
          v: 1,
          nativeSession: { tag },
        }),
        randomBytes: (length) => new Uint8Array(length).fill(7),
      }),
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
      ownerMetadata: sealSessionOwnerMetadataV1({
        material: { type: 'legacy', secret },
        ownerMetadata: SessionOwnerMetadataV1Schema.parse({
          v: 1,
          nativeSession: { tag },
        }),
        randomBytes: (length) => new Uint8Array(length).fill(8),
      }),
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
});
